/**
 * Decides what may leave the process, and strips what must not.
 *
 * Healing works by describing the page to a third-party model. That description is
 * whatever is on screen — so on a page holding patient identifiers, prescriber names,
 * contract values or pricing, an unfiltered heal is an uncontrolled disclosure. This
 * module is the one place that decides what is transmitted.
 *
 * **This module inverts the package's usual failure rule.** Everywhere else, a broken
 * healer degrades to plain Playwright: `attemptHeal` never throws, the recorder
 * swallows I/O errors, a bad config just turns healing off. A privacy control cannot
 * work that way — "degrade gracefully" would mean transmitting the raw page. So:
 *
 * > **Healing fails open. The privacy gate fails closed.**
 *
 * A policy that cannot be evaluated, a URL that will not parse, a custom redactor
 * that throws — all mean *do not transmit*. The heal is skipped and the reason is
 * annotated. The test still runs, exactly as it would with no API key configured, so
 * the suite is never taken down by this; it just stops healing where it must not heal.
 *
 * ## Four controls, weakest last
 *
 * 1. **Route policy** ({@link PrivacyGuard.checkUrl}) — an allowlist of origins and a
 *    blocklist of path globs. This is the only control that reliably handles names and
 *    free text, because it does not try to recognise them: it refuses to look at the
 *    page at all.
 * 2. **Snapshot scoping** (`snapshotRoot`, applied by the caller) — capture one form
 *    rather than the whole page. Cuts disclosure and token cost together.
 * 3. **Structural redaction** (`redact: 'strict'`) — see {@link PrivacyGuard.scrubSnapshot}.
 * 4. **Pattern redaction** (`redact: 'identifiers'`) — regexes over the outbound text.
 *
 * ## What pattern redaction cannot do
 *
 * No regex matches "John Smith". The built-in patterns below find *structured*
 * identifiers — emails, card- and SSN-shaped digit runs, GUIDs, tokens, long account
 * numbers — and nothing else. They do not find names, addresses, free-text notes, or
 * diagnoses. A redactor that claimed otherwise would be worse than none at all,
 * because it would manufacture confidence. For unstructured personal data the
 * controls that work are (1) and (2) above.
 *
 * @module core/PrivacyGuard
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  ElementCandidate,
  HealingRequest,
  PrivacyPolicy,
  RedactionField,
  RedactLevel,
} from '../types';
import { createLogger, type Logger } from '../utils/logger';
import { relativeToProject } from '../utils/paths';

/**
 * Raised when the policy forbids transmitting this request.
 *
 * Thrown rather than returned so it cannot be ignored by a caller that forgets to
 * check a boolean. {@link HealingEngine} catches it and abandons the heal.
 */
export class PrivacyBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyBlockedError';
  }
}

/**
 * Replacement text for redacted content.
 *
 * Deliberately shaped so it cannot be mistaken for data, and so it survives later
 * passes: it contains no digits or `@`, so a second pattern cannot match inside a
 * placeholder the first pass wrote. The kind is kept (`‹email›` rather than a bare
 * `‹redacted›`) because it makes a preview file readable and the redaction tunable,
 * while disclosing only the *shape* of what was removed.
 */
function placeholder(kind: string): string {
  return `‹${kind}›`;
}

/** Generic placeholder, used for structural collapse and custom patterns. */
const REDACTED = placeholder('redacted');

/**
 * Replaces every quoted run in a string with a placeholder, both quote styles.
 *
 * The shared mechanism behind `strict` redaction of anything that is *framework prose
 * quoting page content* — a Playwright error, a rejection reason, a selector. The
 * diagnosis survives (`strict mode violation`, `resolves to a`) because that is what a
 * model and a reader actually reason about; the quoted payload does not.
 *
 * Two unbalanced apostrophes in one string — `the suggestion's name doesn't match` — are
 * read as a quoted run and collapsed. That is deliberate: at `strict` the failure worth
 * avoiding is text surviving, not text being lost, and the alternative is a JavaScript
 * tokeniser for a string that is already only ever displayed. Unchanged behaviour, kept
 * from the outbound scrubber this was extracted from.
 *
 * @param value - Text that may quote page content.
 * @returns The text with quoted runs collapsed.
 */
function collapseQuoted(value: string): string {
  return value
    .replace(/"(?:[^"\\]|\\.)*"/g, `"${REDACTED}"`)
    .replace(/'(?:[^'\\]|\\.)*'/g, `'${REDACTED}'`);
}

/**
 * Built-in patterns for structured identifiers, most specific first.
 *
 * Order matters: a token or JWT must be matched before the generic long-digit rule
 * gets a chance to chew part of it. Every pattern is anchored on word boundaries or a
 * fixed shape — none use nested quantifiers, so none can backtrack catastrophically
 * on a large snapshot.
 *
 * Deliberately *not* included: a general phone-number pattern. Every formulation
 * loose enough to catch real phone numbers also eats prices, quantities, dates and
 * order numbers, which destroys the healing signal for a marginal gain. Add one via
 * `HEALER_REDACT_PATTERNS_FILE` if your pages need it.
 */
const BUILT_IN_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // JSON Web Tokens — three base64url segments. Before any digit rule.
  { kind: 'token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  // `Authorization: Bearer x`, `api_key=x`, `token: x`.
  { kind: 'token', pattern: /\b(?:bearer|api[_-]?key|access[_-]?token|token|secret)\b\s*[:=]\s*\S+/gi },
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { kind: 'guid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  // US SSN shape. Before the generic digit-run rule, which would only catch part.
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Payment-card shape: four groups, optionally separated. Tight enough not to span
  // unrelated numbers, unlike the usual `(?:\d[ -]?){13,19}`.
  { kind: 'card', pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g },
  { kind: 'iban', pattern: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g },
  { kind: 'ip', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  // ISO dates and common day/month/year forms — dates of birth and service dates.
  { kind: 'date', pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
  { kind: 'date', pattern: /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g },
  // UK postcodes. Distinctive enough not to collide with product codes.
  { kind: 'postcode', pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g },
  // Catch-all for medical record numbers, account numbers, NHS numbers. Nine digits
  // is above anything the UI legitimately shows (prices, quantities, years, ports).
  { kind: 'id', pattern: /\b\d{9,}\b/g },
];

/**
 * ARIA roles whose accessible name is kept under `redact: 'strict'`.
 *
 * The rule this list encodes: **keep the names of things you can act on; collapse the
 * names of things you can only read.** The healer only ever heals actions — the
 * sixteen methods in `HEALED_ACTIONS` — so an actionable element's name *is* the
 * healing signal, and in practice it is static interface chrome ("Submit", "Email
 * address"). Data lives in the roles that are not here: `cell`, `row`, `text`,
 * `paragraph`, `heading`, `listitem`, `img`.
 *
 * Unlike a regex, this catches names, addresses and free text — because it does not
 * try to recognise them, it just refuses to send anything it was not told to keep. A
 * role missing from this list is collapsed, so forgetting one loses a little healing
 * accuracy rather than leaking.
 *
 * **Residual risk, stated plainly:** an actionable element labelled with data still
 * transmits that label. A button reading `"Edit Smith, John"` is kept, because a
 * healer that could not see button labels could not heal buttons. Layer the route
 * allowlist over pages where that is unacceptable.
 */
const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/**
 * One line of a Playwright accessibility snapshot.
 *
 * Matches `- role "accessible name" [attr=value]: trailing content`, where everything
 * after the role is optional, plus the `- /url: …` form newer Playwright emits under a
 * link. Indentation is preserved so the tree shape survives redaction.
 */
const SNAPSHOT_LINE =
  /^(\s*-\s+)(\/?[A-Za-z][A-Za-z0-9_-]*)(\s+"((?:[^"\\]|\\.)*)")?(\s*\[[^\]]*\])?(\s*:\s*(.*))?$/;

/** Attribute values in the DOM-scan fallback that carry data rather than intent. */
const DATA_ATTRIBUTES = /\b(href|value|title|alt)="([^"]*)"/gi;

/**
 * Enforces the transmission policy for one healing engine.
 *
 * Holds no page or provider reference and imports nothing from Playwright, so it is
 * unit-testable without a browser or a credential — which is the point: a privacy
 * control that cannot be tested cheaply will not be tested.
 */
export class PrivacyGuard {
  private readonly policy: PrivacyPolicy;
  private readonly patterns: ReadonlyArray<{ kind: string; pattern: RegExp }>;
  private readonly log: Logger;
  private previewCount = 0;

  /**
   * @param policy - Resolved policy. Defaults to `identifiers` redaction with no
   * route restrictions, matching the package default.
   */
  constructor(policy: PrivacyPolicy = { redact: 'identifiers' }) {
    this.policy = policy;
    this.log = createLogger('heal:privacy');

    // `off` disables the *built-in* rules — this package's own policy — but not what
    // the caller explicitly asked for. Custom patterns and the redactor callback are
    // instructions, not defaults, and are honoured at every level; a configured rule
    // that silently stopped applying is the failure mode to avoid here. That also makes
    // `redact: 'off'` plus a patterns file a coherent setting: "apply only my rules."
    //
    // Custom patterns run after the built-ins so a caller's pattern is not pre-chewed
    // by a broader shipped one.
    this.patterns = [
      ...(policy.redact === 'off' ? [] : BUILT_IN_PATTERNS),
      ...(policy.customPatterns ?? []).map((pattern) => ({ kind: 'redacted', pattern })),
    ];

    if (policy.redact === 'off' && (policy.customPatterns?.length || policy.redactor)) {
      this.log.info(
        'HEALER_REDACT=off disables the built-in redaction; your custom patterns and ' +
          'redactor still apply.'
      );
    }
  }

  /** The redaction level in force. */
  get level(): RedactLevel {
    return this.policy.redact;
  }

  /** CSS selector the snapshot should be scoped to, if the policy sets one. */
  get snapshotRoot(): string | undefined {
    return this.policy.snapshotRoot;
  }

  /**
   * Whether this run only writes previews and never contacts a provider.
   *
   * See {@link writePreview}.
   */
  get previewOnly(): boolean {
    return Boolean(this.policy.previewDir);
  }

  /** True when any route restriction is configured. */
  private get hasRoutePolicy(): boolean {
    return Boolean(this.policy.allowedOrigins?.length || this.policy.blockedPaths?.length);
  }

  /**
   * Decides whether healing may run against a page at all.
   *
   * Precedence: a blocked path wins over an allowed origin, so a cleared application
   * can still carve out the routes that hold records. When `allowedOrigins` is set it
   * acts as an allowlist — anything not listed is refused, which is what makes it
   * safe against routes nobody thought to enumerate.
   *
   * **Fails closed.** A URL that will not parse is refused whenever a policy is in
   * force, because an unparseable URL is precisely the case where we cannot tell
   * whether the page is cleared. With no policy configured, every URL is allowed and
   * this is a no-op.
   *
   * @param pageUrl - URL of the page the failing action was running against.
   * @returns Whether healing may proceed, and why not when it may not.
   */
  checkUrl(pageUrl: string): { allowed: boolean; reason?: string } {
    if (!this.hasRoutePolicy) return { allowed: true };

    let url: URL;
    try {
      url = new URL(pageUrl);
    } catch {
      return {
        allowed: false,
        reason:
          `healing is restricted by policy and the page URL could not be parsed ` +
          `(${pageUrl ? JSON.stringify(pageUrl) : 'empty'}), so it cannot be shown to be cleared`,
      };
    }

    for (const glob of this.policy.blockedPaths ?? []) {
      if (this.matchesGlob(url.pathname, glob)) {
        return {
          allowed: false,
          reason: `page path "${url.pathname}" matches the blocked path "${glob}" (HEALER_BLOCKED_PATHS)`,
        };
      }
    }

    const allowed = this.policy.allowedOrigins ?? [];
    if (allowed.length > 0 && !allowed.some((entry) => this.matchesOrigin(url, entry))) {
      return {
        allowed: false,
        reason: `origin "${url.origin}" is not in HEALER_ALLOWED_ORIGINS`,
      };
    }

    return { allowed: true };
  }

  /**
   * Builds the copy of a request that is safe to transmit.
   *
   * Every field is listed explicitly rather than spread from the input. That is
   * deliberate and load-bearing: adding a field to {@link HealingRequest} later is
   * then a **compile error here** instead of a silent new disclosure channel, and an
   * optional field nobody wires up is simply not sent. `screenshot` is dropped
   * unconditionally for the same reason — the engine never populates it, and a field
   * that would ship pixels off the machine should not travel by accident.
   *
   * The returned request is what goes to the provider. The unredacted original stays
   * in the local {@link HealRecord}, so `healing-records.json` and the report
   * attachment still show you the real selector you need to fix.
   *
   * @param request - The request as assembled from the live page.
   * @returns A redacted copy, safe to hand to a provider.
   * @throws {PrivacyBlockedError} If a custom redactor vetoed or threw. Fails closed.
   */
  sanitizeRequest(request: HealingRequest): HealingRequest {
    const pageUrl = request.pageUrl;

    const outbound: HealingRequest = {
      originalSelector: this.scrub(request.originalSelector, 'selector', pageUrl),
      originalAction: request.originalAction,
      ariaSnapshot: this.scrubSnapshot(request.ariaSnapshot, pageUrl),
      pageUrl: this.scrubUrl(pageUrl),
      // The engine reads this off a stack trace, so it arrives absolute:
      // `D:\Users\<account>\OneDrive - <organisation>\…\checkout.spec.ts`. That sends the
      // account and organisation names to a third party on every heal, for no benefit —
      // the model reasons about the page, not the filesystem, and `tests/checkout.spec.ts`
      // identifies the test just as well. Normalised at every level, `off` included: it is
      // the better value regardless of policy, not a redaction that can be switched off.
      testFile: this.scrub(relativeToProject(request.testFile), 'testFile', pageUrl),
      testLine: request.testLine,
      // The description is written by the test author in source, not rendered by the
      // application, so it is never structurally collapsed — only pattern-scrubbed in
      // case someone interpolated a real identifier into it.
      ...(request.description !== undefined
        ? { description: this.scrub(request.description, 'description', pageUrl) }
        : {}),
      ...(request.error !== undefined
        ? { error: this.scrubErrorMessage(request.error, pageUrl) }
        : {}),
      ...(request.candidates !== undefined
        ? { candidates: this.scrubCandidates(request.candidates, pageUrl) }
        : {}),
      // Literals lifted from the test's own selector, which is source rather than page
      // content — scrubbed like the selector itself, and for the same reason.
      ...(request.missingText !== undefined
        ? { missingText: request.missingText.map((text) => this.scrub(text, 'selector', pageUrl)) }
        : {}),
      // screenshot: intentionally never propagated. See the note above.
    };

    return outbound;
  }

  /**
   * Redacts the candidate list, and drops the locators from it.
   *
   * Two jobs. The **locator never travels**: the model answers with an id, so the
   * expression is of no use to it, and keeping the id-to-selector map local is what
   * lets a heal still work when the names in the list have been collapsed.
   *
   * The **names follow the snapshot's rule exactly** — kept for actionable roles,
   * collapsed otherwise, via the same {@link ACTIONABLE_ROLES} test
   * {@link collapseSnapshotLine} applies. That equality is the point rather than a
   * convenience: candidates are derived from the snapshot, so any name this list kept
   * while the snapshot collapsed it would be a disclosure channel opened by a feature
   * that never mentioned privacy. A `cell "Smith, John"` is redacted in both or
   * neither.
   *
   * @param candidates - Candidates as found on the live page.
   * @param pageUrl - Page URL, passed to a custom redactor as context.
   * @returns The list as it may be transmitted.
   * @throws {PrivacyBlockedError} If a custom redactor vetoed or threw.
   */
  private scrubCandidates(
    candidates: ElementCandidate[],
    pageUrl: string
  ): ElementCandidate[] {
    const strict = this.policy.redact === 'strict';

    /**
     * Applies the snapshot's keep-or-collapse rule to one role/name pair.
     *
     * Pattern redaction only. A custom redactor is deliberately *not* called here —
     * see the single pass below.
     *
     * @param role - The element's role.
     * @param name - Its accessible name.
     * @param byText - True when the candidate is addressed by its text rather than its
     * role. Page content whatever the role, so the actionable-role exemption — which
     * exists for accessible names, interface chrome like "Submit" — must not apply.
     * @returns The name, pattern-redacted and collapsed where the policy says so.
     */
    const scrubName = (role: string, name: string, byText = false): string => {
      if (strict && (byText || !ACTIONABLE_ROLES.has(role.toLowerCase()))) return REDACTED;
      // Newlines would break the one-line-per-name framing the custom pass relies on.
      // Accessible names are whitespace-normalised, so this is belt and braces.
      return this.applyPatterns(name).replace(/[\r\n]+/g, ' ');
    };

    const scrubbed = candidates.map((candidate) => {
      // `CandidateFinder` no longer builds a text handle for a value-bearing role, which
      // is how a typed-in patient name once reached this method. This check is the
      // second line: a future handle kind cannot reopen the hole silently.
      const byText = candidate.selector?.includes('getByText(') ?? false;

      return {
        id: candidate.id,
        role: candidate.role,
        name: scrubName(candidate.role, candidate.name, byText),
        context: candidate.context.map((entry: string) => {
          const match = /^(\S+)\s+"([\s\S]*)"$/.exec(entry);
          if (!match?.[1]) return this.applyPatterns(entry).replace(/[\r\n]+/g, ' ');
          return `${match[1]} "${scrubName(match[1], match[2] ?? '')}"`;
        }),
        // A test id had never been transmitted before nameless candidates existed, so
        // it gets the treatment a name gets, and one step more: under `strict` it is
        // withheld outright rather than collapsed, since the element is still pickable
        // by id and the locator it maps to stays here.
        ...(candidate.testId !== undefined && !strict
          ? { testId: this.applyPatterns(candidate.testId).replace(/[\r\n]+/g, ' ') }
          : {}),
        // selector: deliberately absent. See the note above.
      };
    });

    return this.applyCustomToCandidates(scrubbed, pageUrl);
  }

  /**
   * Shows a custom redactor every candidate name, in **one** call.
   *
   * Calling it per name was correct and unaffordable: a 120-candidate page invoked the
   * redactor 364 times for a single heal, against about five before candidates existed.
   * A redactor is caller-supplied code — it may log, rate-limit, or ask a classifier —
   * so a seventyfold amplification is a behavioural change to a published extension
   * point, not just wasted cycles. The names are therefore framed as one newline-
   * delimited block, handed over once, and split back.
   *
   * Fails **closed** on a redactor that changes the line count. The alternative is
   * guessing which name became which, and a privacy control may not guess: a
   * mis-mapped name is a disclosure with a plausible-looking label on it. A redactor
   * that wants to drop content should collapse the text on a line, not remove the line.
   *
   * @param candidates - Candidates already pattern-redacted and collapsed by policy.
   * @param pageUrl - Page URL, passed to the redactor as context.
   * @returns The candidates, with the redactor's edits applied.
   * @throws {PrivacyBlockedError} If the redactor vetoed, threw, or reframed the block.
   */
  private applyCustomToCandidates(
    candidates: ElementCandidate[],
    pageUrl: string
  ): ElementCandidate[] {
    if (!this.policy.redactor || candidates.length === 0) return candidates;

    // Every name in document order: the candidate's own, its test id if it has one, then
    // each ancestry entry's. The test id travels, so the redactor must see it.
    const names: string[] = [];
    for (const candidate of candidates) {
      names.push(candidate.name);
      if (candidate.testId !== undefined) names.push(candidate.testId);
      for (const entry of candidate.context) {
        names.push(/^(\S+)\s+"([\s\S]*)"$/.exec(entry)?.[2] ?? entry);
      }
    }

    const returned = this.applyCustom(names.join('\n'), 'snapshot', pageUrl).split('\n');

    if (returned.length !== names.length) {
      throw new PrivacyBlockedError(
        `the configured redactor returned ${returned.length} line(s) for ${names.length} ` +
          'candidate name(s), so they could no longer be matched up — nothing was ' +
          'transmitted. Collapse the text on a line rather than adding or removing lines'
      );
    }

    let next = 0;
    return candidates.map((candidate) => ({
      ...candidate,
      name: returned[next++] ?? candidate.name,
      ...(candidate.testId !== undefined ? { testId: returned[next++] ?? '' } : {}),
      context: candidate.context.map((entry) => {
        const match = /^(\S+)\s+"([\s\S]*)"$/.exec(entry);
        const value = returned[next++] ?? '';
        return match?.[1] ? `${match[1]} "${value}"` : value;
      }),
    }));
  }

  /**
   * Redacts an accessibility snapshot.
   *
   * Under `identifiers`, patterns are applied to the text and nothing else changes.
   *
   * Under `strict`, the snapshot is walked line by line and the *structure* is used
   * instead of trying to recognise sensitive values:
   *
   * ```
   *   - cell "Smith, John"              →  - cell "‹redacted›"
   *   - paragraph: Seen 2026-03-11      →  - paragraph: ‹redacted›
   *   - textbox "Email address": a@b.c  →  - textbox "Email address": ‹redacted›
   *   - button "Place order"            →  - button "Place order"
   * ```
   *
   * Roles, nesting and attributes survive, so the model can still navigate the tree
   * and name an element; the payload does not. Note that a *value* is collapsed even
   * on an actionable role — a textbox's label is interface chrome, but its value is
   * whatever the user typed.
   *
   * The DOM-scan fallback format (`<input id="x"> typed text`) is handled too. That
   * path matters more than it looks: it captures `element.value`, so a half-filled
   * form there is raw user input rather than rendered page text.
   *
   * @param snapshot - Raw snapshot text.
   * @param pageUrl - Page URL, passed to a custom redactor as context.
   * @returns The snapshot, redacted to the configured level.
   * @throws {PrivacyBlockedError} If a custom redactor vetoed or threw.
   */
  scrubSnapshot(snapshot: string, pageUrl: string): string {
    if (!snapshot) return this.applyCustom(snapshot, 'snapshot', pageUrl);

    // Structural collapse is `strict` only. Pattern redaction below covers `off` too,
    // where the pattern set is empty unless the caller supplied their own.
    if (this.policy.redact !== 'strict') {
      return this.applyCustom(this.applyPatterns(snapshot), 'snapshot', pageUrl);
    }

    let unparsed = 0;

    const lines = snapshot.split('\n').map((line) => {
      if (line.trim().startsWith('<')) return this.collapseDomScanLine(line);

      const match = SNAPSHOT_LINE.exec(line);
      if (!match) {
        // Best effort, in the safe direction: an unrecognised line keeps its shape
        // but loses any quoted content, because a quoted string is where a name sits.
        if (line.includes('"')) unparsed++;
        return this.applyPatterns(line.replace(/"(?:[^"\\]|\\.)*"/g, `"${REDACTED}"`));
      }

      return this.collapseSnapshotLine(match);
    });

    if (unparsed > 0) {
      this.log.debug(
        `${unparsed} snapshot line(s) did not match the expected shape; their quoted ` +
          'content was redacted wholesale.'
      );
    }

    return this.applyCustom(lines.join('\n'), 'snapshot', pageUrl);
  }

  /**
   * Rebuilds one parsed snapshot line with data-bearing parts collapsed.
   *
   * @param match - Result of {@link SNAPSHOT_LINE} against the line.
   * @returns The rewritten line.
   */
  private collapseSnapshotLine(match: RegExpExecArray): string {
    const [, prefix = '', role = '', quoted, name, attributes, colon, rest] = match;

    const keepName = ACTIONABLE_ROLES.has(role.toLowerCase());

    let out = `${prefix}${role}`;

    if (quoted !== undefined) {
      out += keepName ? ` "${this.applyPatterns(name ?? '')}"` : ` "${REDACTED}"`;
    }

    // `[level=1]`, `[checked]`, `[disabled]` — structural, and the model uses them.
    if (attributes !== undefined) out += this.applyPatterns(attributes);

    if (colon !== undefined) {
      const value = (rest ?? '').trim();
      // A bare `- main:` opens a container and has no value to redact.
      out += value ? `: ${REDACTED}` : ':';
    }

    return out;
  }

  /**
   * Collapses one line of the DOM-scan fallback format.
   *
   * The selector-bearing attributes (`id`, `role`, `name`, `type`, `placeholder`,
   * `data-testid`) are what healing needs and are kept. `href`, `value`, `title` and
   * `alt` are collapsed, as is the trailing visible text.
   *
   * @param line - One line of {@link getDomSnapshot} output.
   * @returns The rewritten line.
   */
  private collapseDomScanLine(line: string): string {
    const close = line.indexOf('>');
    if (close === -1) return this.applyPatterns(line);

    const tag = line.slice(0, close + 1).replace(DATA_ATTRIBUTES, `$1="${REDACTED}"`);
    const trailing = line.slice(close + 1).trim();

    return trailing ? `${this.applyPatterns(tag)} ${REDACTED}` : this.applyPatterns(tag);
  }

  /**
   * Redacts a page URL.
   *
   * Query strings and fragments are dropped entirely from `identifiers` upwards —
   * they routinely carry identifiers and tokens, and contribute almost nothing to
   * healing, which reasons about the page snapshot rather than the address. Path
   * segments keep their shape but are pattern-scrubbed, so `/patients/884213701`
   * becomes `/patients/‹id›` and still tells the model roughly where it is.
   *
   * @param pageUrl - The real URL.
   * @returns A URL safe to transmit.
   */
  private scrubUrl(pageUrl: string): string {
    if (!pageUrl) return this.applyCustom(pageUrl, 'url', pageUrl);

    // Dropping the query string is part of `identifiers`. At `off` the address is left
    // structurally intact and only the caller's own patterns apply to it.
    if (this.policy.redact === 'off') {
      return this.applyCustom(this.applyPatterns(pageUrl), 'url', pageUrl);
    }

    let reduced: string;
    try {
      const url = new URL(pageUrl);
      // An opaque origin serialises as the string "null": `about:blank` became
      // "nullblank" in every prompt. The scheme is what identifies such a page.
      const origin = url.origin === 'null' ? url.protocol : url.origin;
      const trimmed = `${origin}${this.applyPatterns(url.pathname)}`;
      reduced = url.search || url.hash ? `${trimmed} (query omitted)` : trimmed;
    } catch {
      // Not a URL we can decompose — scrub it as plain text rather than pass it on.
      reduced = this.applyPatterns(pageUrl);
    }

    // The custom redactor sees the URL too, so a caller can rewrite or veto on it.
    // The *unredacted* URL is what reaches the callback as context, since a per-route
    // decision needs the real address rather than the one we are about to send.
    return this.applyCustom(reduced, 'url', pageUrl);
  }

  /**
   * Redacts a Playwright error message.
   *
   * Error messages are a disclosure channel in their own right, and an easy one to
   * overlook because they look like framework output rather than page content. A
   * strict-mode violation reads:
   *
   * ```
   * locator.click: strict mode violation: resolved to 2 elements:
   *   "Smith, John 1970-03-11" and "Smith, Jane 1968-07-02"
   * ```
   *
   * — which is the table, quoted. So under `strict` every quoted run is collapsed,
   * leaving the diagnosis (`strict mode violation`, `Timeout 5000ms exceeded`) intact
   * because that is what the model actually reasons about. Both quote styles are
   * collapsed: a `getByText('Smith, John')` in the message is single-quoted.
   *
   * The failing selector is not lost by this — it travels separately as
   * `originalSelector`.
   *
   * @param message - The original Playwright error message.
   * @param pageUrl - Page URL, passed to a custom redactor as context.
   * @returns The message, redacted to the configured level.
   * @throws {PrivacyBlockedError} If a custom redactor vetoed or threw.
   */
  private scrubErrorMessage(message: string, pageUrl: string): string {
    let out = this.applyPatterns(message);

    if (this.policy.redact === 'strict') out = collapseQuoted(out);

    return this.applyCustom(out, 'error', pageUrl);
  }

  /**
   * Applies pattern redaction and then any custom redactor to a short field.
   *
   * @param value - Text to redact.
   * @param field - Which field this is, passed to a custom redactor as context.
   * @param pageUrl - Page URL, passed to a custom redactor as context.
   * @returns The redacted text.
   * @throws {PrivacyBlockedError} If a custom redactor vetoed or threw.
   */
  private scrub(value: string, field: RedactionField, pageUrl: string): string {
    // No level check needed: `patterns` is empty at `off` unless the caller supplied
    // rules of their own, and `applyPatterns` is a no-op on an empty set.
    return this.applyCustom(this.applyPatterns(value), field, pageUrl);
  }

  /**
   * Runs every configured pattern over a string.
   *
   * Each pattern is used with a fresh `lastIndex` — a `/g` regex reused across calls
   * keeps its position and would skip matches on the next string.
   *
   * @param value - Text to redact.
   * @returns The text with matches replaced by placeholders.
   */
  private applyPatterns(value: string): string {
    if (!value || this.patterns.length === 0) return value;

    let out = value;
    for (const { kind, pattern } of this.patterns) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, placeholder(kind));
    }
    return out;
  }

  /**
   * Hands text to a caller-supplied redactor, if one is configured.
   *
   * The callback may return `null` to veto transmission outright — the intended shape
   * for "my classifier says this page has PHI on it, do not send anything." A veto and
   * a thrown error are treated identically, and both block the heal: a redactor that
   * crashes is not evidence that the text is safe.
   *
   * @param value - Text already pattern-redacted.
   * @param field - Which field this is.
   * @param pageUrl - Page URL, for the callback's own policy decisions.
   * @returns The callback's result.
   * @throws {PrivacyBlockedError} If the callback vetoed, threw, or returned a non-string.
   */
  private applyCustom(value: string, field: RedactionField, pageUrl: string): string {
    const redactor = this.policy.redactor;
    if (!redactor) return value;

    let result: string | null;
    try {
      result = redactor(value, { field, pageUrl });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PrivacyBlockedError(
        `the configured redactor threw while processing "${field}" (${detail}) — ` +
          'nothing was transmitted'
      );
    }

    if (result === null) {
      throw new PrivacyBlockedError(`the configured redactor vetoed transmission of "${field}"`);
    }

    if (typeof result !== 'string') {
      throw new PrivacyBlockedError(
        `the configured redactor returned ${typeof result} for "${field}"; a string or null ` +
          'is required, so nothing was transmitted'
      );
    }

    return result;
  }

  /**
   * Redacts a selector that came *back* from the model, for display.
   *
   * Redaction governs what goes **to** a provider; this governs what comes back. The
   * model answers with a selector, and it may have chosen page text as the identifier —
   * `getByText('Smith, John')`. That string then reaches a log line, a report annotation,
   * the failure message of the CI gate, and the run summary. CI logs and uploaded report
   * artefacts are usually readable by far more people than the machine that produced
   * them, so a name arriving there is a real disclosure even though nothing was sent.
   *
   * Displayed selectors get the **same level** as outbound ones, so a single setting
   * describes the whole surface:
   *
   * - `off` — unchanged.
   * - `identifiers` — patterns applied, which is almost always a no-op on a selector:
   *   `getByTestId('checkout')` has nothing to find.
   * - `strict` — quoted content collapsed as well, because at that level names and free
   *   text are what you are protecting and a selector is one of the places they land.
   *
   * `healing-records.json` is **never** redacted. It is local and gitignored, and it is
   * where you go for the exact rewrite — which is what makes redacting the exported
   * copies affordable.
   *
   * @param selector - A selector the model produced.
   * @returns The selector as it is safe to display.
   */
  redactSelector(selector: string): string {
    return this.redactMessage(selector);
  }

  /**
   * Redacts framework prose that quotes page content, for display.
   *
   * The sibling of {@link redactSelector}, and mechanically identical to it — a rejection
   * reason and a selector are both *our* words wrapped around *their* data:
   *
   * ```
   * the suggestion was described as "Place order" but resolves to "Smith, John"
   *   → the suggestion was described as "‹redacted›" but resolves to "‹redacted›"
   * ```
   *
   * It exists because redacting selectors alone was not enough. A heal that fails on the
   * intent check puts the element's accessible name into its reason, and that reason
   * reaches the `heal-failed` annotation, the report attachment, and the run summary in CI
   * stdout — the same surfaces, carrying the same kind of data, with none of the
   * protection. The diagnosis survives the collapse, which is what keeps the message
   * useful.
   *
   * @param message - Text that may quote page content.
   * @returns The message as it is safe to display.
   */
  redactMessage(message: string): string {
    if (!message || this.policy.redact === 'off') return message;

    const patterned = this.applyPatterns(message);
    return this.policy.redact === 'strict' ? collapseQuoted(patterned) : patterned;
  }

  /**
   * Redacts an element's accessible name, for display.
   *
   * Unlike a message, a name is page content *end to end* — there is no framework prose
   * around it to preserve, and no quotes to collapse. So at `strict` the whole value goes,
   * rather than being run through a quote-collapse that would find nothing to do.
   *
   * This replaces an earlier trick of wrapping the name in quotes to borrow
   * {@link redactSelector}'s collapse, which mangled any name containing an apostrophe —
   * `O'Brien` being the obvious one.
   *
   * @param name - Accessible name read from the live element.
   * @returns The name as it is safe to display.
   */
  redactName(name: string): string {
    if (!name || this.policy.redact === 'off') return name;

    return this.policy.redact === 'strict' ? REDACTED : this.applyPatterns(name);
  }

  /**
   * Writes the exact payload that *would* be sent, and sends nothing.
   *
   * A privacy control nobody can inspect is a promise, not a control. With
   * `HEALER_PRIVACY_PREVIEW=<dir>` set, every heal renders the real system and user
   * prompts — the same {@link PromptBuilder} output the provider would receive — into
   * a file and stops. No API call, no credential needed, no cost.
   *
   * Two uses: proving to whoever has to sign this off exactly what leaves the
   * machine, and tuning `HEALER_REDACT` against your own pages before spending
   * anything. Note that no heal can succeed in this mode, so a suite run under it
   * fails wherever it would have failed unhealed — that is the point, not a bug.
   *
   * Never throws: a preview is a diagnostic, and failing to write one must not change
   * what the healer does. It is already established by then that nothing is sent.
   *
   * @param payload - What would have gone to the provider.
   * @returns The file written, or `null` if it could not be.
   */
  writePreview(payload: {
    request: HealingRequest;
    systemPrompt: string;
    userPrompt: string;
    provider: string;
    model: string;
  }): string | null {
    const directory = this.policy.previewDir;
    if (!directory) return null;

    try {
      fs.mkdirSync(directory, { recursive: true });

      const slug =
        payload.request.originalSelector.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'selector';
      const sequence = String(++this.previewCount).padStart(3, '0');
      const file = path.join(
        directory,
        `${sequence}-${process.pid}-${payload.request.originalAction}-${slug}.txt`
      );

      fs.writeFileSync(file, this.renderPreview(payload), 'utf8');
      this.log.info(`Preview written to ${file} — nothing was transmitted.`);
      return file;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.error(`Could not write the privacy preview: ${detail}`);
      return null;
    }
  }

  /**
   * Renders a preview file.
   *
   * The prompts are reproduced verbatim and last, with a header describing the policy
   * that produced them, so the file can be read top-to-bottom as "these settings
   * produced these bytes".
   *
   * @param payload - What would have gone to the provider.
   * @returns The file contents.
   */
  private renderPreview(payload: {
    request: HealingRequest;
    systemPrompt: string;
    userPrompt: string;
    provider: string;
    model: string;
  }): string {
    return [
      'self-healing-playwright — privacy preview',
      '',
      'NOTHING WAS TRANSMITTED. This file is the exact payload that would have been',
      'sent had HEALER_PRIVACY_PREVIEW been unset. Everything below the rule is',
      'verbatim prompt text.',
      '',
      `  written        ${new Date().toISOString()}`,
      `  would go to    ${payload.provider} (${payload.model})`,
      `  policy         ${this.describe()}`,
      `  page           ${payload.request.pageUrl}`,
      `  action         ${payload.request.originalAction} on ${payload.request.originalSelector}`,
      `  test           ${payload.request.testFile}:${payload.request.testLine}`,
      '',
      '='.repeat(78),
      '--- system prompt ---',
      '',
      payload.systemPrompt,
      '',
      '--- user prompt ---',
      '',
      payload.userPrompt,
      '',
    ].join('\n');
  }

  /**
   * One-line description of the policy, for logs, previews and the run summary.
   *
   * @returns Something like `redact=strict, origins=1 allowed, paths=2 blocked`.
   */
  describe(): string {
    const parts = [`redact=${this.policy.redact}`];

    if (this.policy.customPatterns?.length) {
      parts.push(`+${this.policy.customPatterns.length} custom pattern(s)`);
    }
    if (this.policy.redactor) parts.push('custom redactor');
    if (this.policy.snapshotRoot) parts.push(`root=${this.policy.snapshotRoot}`);

    const origins = this.policy.allowedOrigins?.length ?? 0;
    const paths = this.policy.blockedPaths?.length ?? 0;
    parts.push(origins > 0 ? `${origins} allowed origin(s)` : 'all origins');
    if (paths > 0) parts.push(`${paths} blocked path(s)`);

    if (this.previewOnly) parts.push('PREVIEW ONLY — nothing is transmitted');

    return parts.join(', ');
  }

  /**
   * Matches a URL path against a glob.
   *
   * Supports `?` (one character), `*` (within a segment) and `**` (across segments).
   * A trailing `/**` also matches the bare prefix, so `/patients/**` covers
   * `/patients` as well as `/patients/8841/edit` — the alternative surprises everyone
   * exactly once, on the route they most wanted blocked.
   *
   * @param pathname - Path from the page URL.
   * @param glob - Pattern from `HEALER_BLOCKED_PATHS`.
   * @returns True when the path is covered.
   */
  private matchesGlob(pathname: string, glob: string): boolean {
    const trimmed = glob.trim();
    if (!trimmed) return false;

    const suffixOptional = trimmed.endsWith('/**');
    const body = suffixOptional ? trimmed.slice(0, -3) : trimmed;

    let expression = '';
    for (let i = 0; i < body.length; i++) {
      const char = body[i];
      // Bounded by body.length, so this cannot miss — stated for the compiler.
      if (char === undefined) continue;

      if (char === '*') {
        if (body[i + 1] === '*') {
          expression += '.*';
          i++;
        } else {
          expression += '[^/]*';
        }
      } else if (char === '?') {
        expression += '[^/]';
      } else {
        expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }

    if (suffixOptional) expression += '(?:/.*)?';

    try {
      return new RegExp(`^${expression}$`, 'i').test(pathname);
    } catch {
      // An unusable glob must not silently stop blocking.
      this.log.warn(`Could not interpret the blocked path "${glob}"; treating it as a match.`);
      return true;
    }
  }

  /**
   * Matches a URL against an allowlist entry.
   *
   * An entry containing `://` is compared as a full origin (scheme, host and port).
   * Otherwise it is a host pattern, optionally led by `*.` to include subdomains.
   *
   * @param url - Parsed page URL.
   * @param entry - One entry from `HEALER_ALLOWED_ORIGINS`.
   * @returns True when the URL is covered.
   */
  private matchesOrigin(url: URL, entry: string): boolean {
    const wanted = entry.trim().toLowerCase().replace(/\/+$/, '');
    if (!wanted) return false;

    if (wanted.includes('://')) return url.origin.toLowerCase() === wanted;

    const hostname = url.hostname.toLowerCase();
    if (wanted.startsWith('*.')) {
      const domain = wanted.slice(2);
      return hostname === domain || hostname.endsWith(`.${domain}`);
    }

    return hostname === wanted || url.host.toLowerCase() === wanted;
  }
}
