/**
 * Decides whether a healed selector found the element the test actually meant.
 *
 * {@link SelectorValidator} answers a different question: *does this selector resolve
 * to one usable element?* Both gates can pass on completely the wrong element. On the
 * demo's checkout page, `button "Cancel"` is unique, visible, and clickable — so a heal
 * of `#place-order-btn` to Cancel is accepted, the click succeeds, and a test whose
 * assertions are loose goes **green while exercising the wrong path**. That is worse
 * than a red test: a suite that no longer tests what it claims is invisible without
 * reading every healing record.
 *
 * This module closes that gap. It compares the element the model chose against the
 * evidence of what the test intended, using four checks of decreasing objectivity:
 *
 * 1. **Action compatibility.** You cannot `fill()` a button or `check()` a link. The
 *    action being healed constrains the element's role, and this is a fact about the
 *    live DOM rather than a guess — so it can reject a wrong heal without ever
 *    rejecting a right one. The audit that prompted this module did not mention it, and
 *    it is the strongest check here.
 * 2. **Self-consistency.** The model reports the role and accessible name it believes
 *    it selected. If the selector it wrote resolves to something else, the model
 *    contradicted itself and the suggestion is discarded. Also near-zero false
 *    positives, because it is the model's own claim measured against reality.
 * 3. **Role preservation.** When the original selector implies a role — `getByRole
 *    ('button', …)`, or a tag-qualified CSS selector — the healed element must have it.
 * 4. **Lexical intent.** Identifiers and descriptions carry meaning: `#place-order-btn`
 *    is *about* placing an order. If the intent vocabulary and the healed element's
 *    accessible name share nothing at all, that is evidence of a wrong pick.
 *
 * ## Why lexical matching is prefix-based
 *
 * Exact token matching looked right and was wrong. The demo heals `#promo-field` to
 * `getByLabel('Promotion code')` — correct, but `promo` ≠ `promotion`, so exact
 * matching rejects a good heal. Tokens therefore match when one is a prefix of the
 * other and the shorter is at least four characters, which also covers `submit`/
 * `submits`, `accept`/`accepting` and `term`/`terms`. Verified against all five of the
 * demo's heals plus the Cancel counter-example.
 *
 * ## Every rejection feeds the retry
 *
 * A rejected suggestion and its reason are folded into the next prompt, exactly as
 * validation failures already are. "You chose Cancel, whose name shares nothing with
 * the intended element" is precisely the correction that makes attempt two land — so
 * this is not only a gate, it is a signal.
 *
 * @module core/IntentVerifier
 */

import type { Locator } from '@playwright/test';

import type { IntentMode, IntentPolicy, IntentSummary } from '../types';
import { createLogger, type Logger } from '../utils/logger';

/**
 * Time allowed to read the healed element's role and name.
 *
 * One second, for the same reason `SelectorValidator` uses one: the element has just
 * been confirmed present and visible, so this resolves immediately. A longer budget
 * would multiply across retries for no benefit.
 */
const OBSERVE_TIMEOUT_MS = 1_000;

/**
 * Minimum intent vocabulary before a lexical *mismatch* may reject a suggestion.
 *
 * Asymmetric on purpose. A single shared word is good enough to *confirm* a heal —
 * `#checkout-button` against a button named "Checkout" is not a coincidence. But a
 * single *missing* word is not enough to refuse one, because a one-word intent is as
 * likely to be an unhelpful identifier as a real signal. Confirming needs one token;
 * rejecting needs this many.
 */
const MIN_INTENT_TOKENS = 2;

/** Shortest token that may match as a prefix of a longer one. */
const MIN_PREFIX_LENGTH = 4;

/**
 * Roles each action can legitimately target.
 *
 * Only actions with a genuine constraint are listed — `click`, `hover`, `focus` and
 * friends work on nearly anything, and inventing a constraint for them would reject
 * correct heals. Derived from what Playwright itself refuses: `fill()` throws on
 * anything that is not an input, textarea or contenteditable; `check()` throws on
 * anything that is not a checkbox or radio; `selectOption()` requires a `<select>`.
 */
const ACTION_ROLES: Readonly<Record<string, ReadonlySet<string>>> = {
  // `combobox` is knowingly permissive on the fill family, and cannot be otherwise. An
  // `<input role="combobox">` on an autocomplete is genuinely fillable; a `<select>` has
  // the same computed role and `fill()` throws on it. The role alone does not separate
  // them, and this check may only reject what it is *sure* about — the cost of being wrong
  // here is refusing a correct heal, which is worse than letting Playwright report the
  // real error on the retry. So it errs toward the false negative.
  fill: new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']),
  clear: new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']),
  type: new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']),
  pressSequentially: new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']),
  check: new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']),
  uncheck: new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']),
  selectOption: new Set(['combobox', 'listbox']),
};

/** HTML tags whose implied role is unambiguous, for tag-qualified CSS selectors. */
const TAG_ROLES: Readonly<Record<string, string>> = {
  button: 'button',
  a: 'link',
  select: 'combobox',
  textarea: 'textbox',
};

/**
 * Words carrying no intent: selector-syntax noise, English function words, and role
 * nouns that describe *what kind* of element rather than *which* element.
 *
 * Role nouns are excluded deliberately. "the **button** that submits the order" says
 * nothing that distinguishes it from any other button, and leaving them in would let a
 * name like "Cancel button" match a lexicon built from an unrelated button.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Selector and framework syntax.
  'getbyrole', 'getbylabel', 'getbytext', 'getbyplaceholder', 'getbytestid',
  'getbytitle', 'getbyalttext', 'page', 'locator', 'await', 'this', 'first',
  'last', 'nth', 'name', 'exact', 'level', 'css', 'xpath', 'data', 'testid',
  'test', 'class', 'type', 'true', 'false', 'null',
  // Role nouns and generic element words.
  'button', 'btn', 'link', 'checkbox', 'radio', 'textbox', 'input', 'field',
  'label', 'icon', 'image', 'img', 'element', 'elem', 'node', 'div', 'span',
  'wrapper', 'container', 'control', 'ctrl', 'box',
  // English function words.
  'the', 'and', 'that', 'which', 'where', 'who', 'whose', 'with', 'for', 'from',
  'into', 'its', 'it', 'is', 'are', 'was', 'were', 'be', 'been', 'these',
  'those', 'their', 'there', 'then', 'when', 'our', 'you', 'your', 'they',
  'this', 'has', 'have', 'had', 'not', 'but', 'all', 'any', 'can', 'will',
]);

/** What the live DOM says the healed element is. */
interface Observation {
  role?: string;
  name?: string;
}

/** Everything known about what the test was trying to do. */
export interface IntentContext {
  /** The selector that failed. Its own text is evidence of intent. */
  originalSelector: string;
  /** Selector the model proposed. */
  suggestedSelector: string;
  /** Playwright action being healed. */
  action: string;
  /** Author-supplied `describe()` text, when present. */
  description?: string;
  /** Confidence the model reported. */
  confidence: number;
  /** Role the model claims it selected, when it said. */
  expectedRole?: string;
  /** Accessible name the model claims it selected, when it said. */
  expectedName?: string;
}

/** Outcome of verification. */
export interface IntentVerdict {
  /** Whether the suggestion may be used. Always true when the mode is `off` or `warn`. */
  ok: boolean;
  /** Why it was rejected, or — in `warn` mode — what would have rejected it. */
  reason?: string;
  /** Summary for the healing record and the report. */
  summary: IntentSummary;
}

/**
 * First line of an element's `ariaSnapshot()`: `- role "accessible name"`.
 *
 * Only the first line is read. A snapshot of a container element includes its whole
 * subtree, and the element itself is what we are asking about.
 */
const ELEMENT_LINE = /^\s*-\s+(\/?[A-Za-z][A-Za-z0-9_-]*)(?:\s+"((?:[^"\\]|\\.)*)")?/;

/**
 * Checks that a healed element is plausibly the one the test meant.
 */
export class IntentVerifier {
  private readonly policy: IntentPolicy;
  private readonly log: Logger;

  /**
   * @param policy - Mode and the confidence floor for unverifiable heals.
   */
  constructor(policy: IntentPolicy = { mode: 'enforce', unverifiedConfidence: 0.9 }) {
    this.policy = policy;
    this.log = createLogger('heal:intent');
  }

  /** The mode in force. */
  get mode(): IntentMode {
    return this.policy.mode;
  }

  /**
   * Verifies a healed element against the test's intent.
   *
   * Never throws. A failure to read the element is not treated as a pass: it means no
   * check had anything to work with, which routes to the confidence floor.
   *
   * @param locator - The resolved healed locator.
   * @param context - What the test was trying to do.
   * @returns The verdict. `ok` is always true in `off` and `warn` modes.
   */
  async verify(locator: Locator, context: IntentContext): Promise<IntentVerdict> {
    if (this.policy.mode === 'off') {
      return { ok: true, summary: { mode: 'off', verified: false, checks: [] } };
    }

    const observed = await this.observe(locator);
    const checks: string[] = [];

    const failure =
      this.checkActionCompatibility(observed, context, checks) ??
      this.checkSelfConsistency(observed, context, checks) ??
      this.checkRolePreservation(observed, context, checks) ??
      this.checkLexicalIntent(observed, context, checks) ??
      this.checkConfidenceFloor(context, checks);

    const summary: IntentSummary = {
      mode: this.policy.mode,
      verified: failure === undefined,
      checks,
      ...(observed.role !== undefined ? { role: observed.role } : {}),
      ...(observed.name !== undefined ? { name: observed.name } : {}),
      ...(failure !== undefined ? { reason: failure } : {}),
    };

    if (failure === undefined) return { ok: true, summary };

    // `warn` records and reports the concern but lets the heal through, for a suite
    // adopting this incrementally. `enforce` rejects, and the reason is fed into the
    // next prompt by the engine.
    if (this.policy.mode === 'warn') {
      this.log.warn(
        `Intent check would have rejected "${context.suggestedSelector}": ${failure}. ` +
          'Accepting because HEALER_INTENT_CHECK=warn.'
      );
      return { ok: true, reason: failure, summary };
    }

    return { ok: false, reason: failure, summary };
  }

  /**
   * Reads the healed element's computed role and accessible name.
   *
   * `ariaSnapshot()` on the element is the cleanest route: it is public API, one call,
   * and it returns the browser's own computed role and accessible name — the same
   * values `getByRole()` matches on. Reading `role` as an attribute would only see
   * explicit roles and miss every implicit one, which is most of them.
   *
   * @param locator - Element to inspect.
   * @returns What could be read. Empty when the element could not be described.
   */
  private async observe(locator: Locator): Promise<Observation> {
    try {
      const snapshot = await locator.first().ariaSnapshot({ timeout: OBSERVE_TIMEOUT_MS });
      const firstLine = (snapshot ?? '').split('\n')[0] ?? '';
      const match = ELEMENT_LINE.exec(firstLine);
      if (!match?.[1]) return {};

      return {
        role: match[1].toLowerCase(),
        ...(match[2] !== undefined ? { name: match[2].replace(/\\(["\\])/g, '$1') } : {}),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.debug(`Could not read the healed element's role or name: ${detail}`);
      return {};
    }
  }

  /**
   * Rejects an element that cannot perform the action being healed.
   *
   * The most reliable check available, because it is not a judgement: Playwright itself
   * throws when `fill()` targets a button. Catching it here turns a confusing
   * mid-retry failure into a rejection with a reason the model can act on.
   *
   * @param observed - What the DOM says.
   * @param context - The heal being attempted.
   * @param checks - Accumulates the names of checks that had signal.
   * @returns A rejection reason, or `undefined`.
   */
  private checkActionCompatibility(
    observed: Observation,
    context: IntentContext,
    checks: string[]
  ): string | undefined {
    const allowed = ACTION_ROLES[context.action];
    if (!allowed || observed.role === undefined) return undefined;

    checks.push('action');
    if (allowed.has(observed.role)) return undefined;

    return (
      `${context.action}() cannot act on a ${observed.role} — it needs one of ` +
      `${[...allowed].join(', ')}`
    );
  }

  /**
   * Rejects a suggestion that contradicts the model's own description of it.
   *
   * If the model reports choosing a button called "Place order" but the selector it
   * wrote resolves to a textbox, the selector is wrong regardless of whether the
   * reasoning was sound. Free of false positives by construction — it compares the
   * model against itself, not against our guess at intent.
   *
   * @param observed - What the DOM says.
   * @param context - The heal being attempted, including the model's claim.
   * @param checks - Accumulates the names of checks that had signal.
   * @returns A rejection reason, or `undefined`.
   */
  private checkSelfConsistency(
    observed: Observation,
    context: IntentContext,
    checks: string[]
  ): string | undefined {
    if (context.expectedRole !== undefined && observed.role !== undefined) {
      checks.push('self-consistency');
      const claimed = context.expectedRole.trim().toLowerCase();
      if (claimed && claimed !== observed.role) {
        return (
          `the suggestion was described as a ${claimed} but resolves to a ${observed.role}`
        );
      }
    }

    if (context.expectedName !== undefined && observed.name !== undefined) {
      if (!checks.includes('self-consistency')) checks.push('self-consistency');
      const claimed = tokenize(context.expectedName);
      const actual = tokenize(observed.name);

      // Compared by token rather than string equality: models paraphrase whitespace and
      // casing, and rejecting on that would be noise rather than safety.
      if (claimed.size > 0 && actual.size > 0 && overlap(claimed, actual).length === 0) {
        return (
          `the suggestion was described as "${context.expectedName}" but resolves to ` +
          `"${observed.name}"`
        );
      }
    }

    return undefined;
  }

  /**
   * Rejects a role change when the original selector named a role.
   *
   * `getByRole('button', …)` states the intent outright, and a heal to a link or a
   * textbox is not the same test. Rejecting is the safe default even though a genuine
   * redesign can legitimately change an element's role — that case surfaces as a red
   * test with the reason attached, which is the outcome you want over a silent green.
   *
   * @param observed - What the DOM says.
   * @param context - The heal being attempted.
   * @param checks - Accumulates the names of checks that had signal.
   * @returns A rejection reason, or `undefined`.
   */
  private checkRolePreservation(
    observed: Observation,
    context: IntentContext,
    checks: string[]
  ): string | undefined {
    const implied = impliedRole(context.originalSelector);
    if (!implied || observed.role === undefined) return undefined;

    checks.push('role');
    if (implied === observed.role) return undefined;

    return (
      `the original selector targets a ${implied} but the suggestion resolves to a ` +
      `${observed.role}`
    );
  }

  /**
   * Rejects an element whose name shares no vocabulary with the test's intent.
   *
   * The intent vocabulary is drawn from the failing selector and the `describe()` text.
   * Identifiers are written by people and carry meaning — `#place-order-btn` is about
   * placing an order — which is exactly why healing works at all.
   *
   * Only applied when the vocabulary has at least {@link MIN_INTENT_TOKENS} content
   * words. Below that there is no evidence, and a rejection would be a guess.
   *
   * @param observed - What the DOM says.
   * @param context - The heal being attempted.
   * @param checks - Accumulates the names of checks that had signal.
   * @returns A rejection reason, or `undefined`.
   */
  private checkLexicalIntent(
    observed: Observation,
    context: IntentContext,
    checks: string[]
  ): string | undefined {
    const intent = new Set([
      ...tokenize(context.originalSelector),
      ...tokenize(context.description ?? ''),
    ]);

    if (intent.size === 0) return undefined;

    // Evidence comes from the element, not from the model's own prose about it.
    //
    // An earlier version pooled the accessible name together with the suggested
    // selector's text. That let a suggestion certify itself: a heal to
    // `getByTestId('place-order-legacy')` resolving to the Cancel button would pass,
    // because the *selector* mentioned the order even though the element did not.
    //
    // So the observed name is used whenever it can be read, and the selector text only
    // as a fallback for elements with no accessible name at all — an icon button whose
    // test id is the only wording available.
    const candidate =
      observed.name !== undefined && observed.name.trim() !== ''
        ? tokenize(observed.name)
        : tokenize(context.suggestedSelector);

    if (candidate.size === 0) return undefined;

    // A match is evidence at any strength; a mismatch is only evidence in bulk.
    //
    // These were one threshold to begin with, and measurement showed that was wrong:
    // `#checkout-button` yields the single token `checkout`, which matches the element's
    // name "Checkout" exactly — yet a shared `MIN_INTENT_TOKENS` gate suppressed the
    // check entirely and pushed a perfectly corroborated heal onto the confidence
    // floor. So a positive match always counts as verification, while a rejection still
    // requires enough vocabulary to be more than a guess.
    if (overlap(intent, candidate).length > 0) {
      checks.push('lexical');
      return undefined;
    }

    if (intent.size < MIN_INTENT_TOKENS) return undefined;

    checks.push('lexical');
    return (
      `the suggestion's name ${observed.name ? `("${observed.name}") ` : ''}shares no ` +
      `wording with the intended element (${[...intent].sort().join(', ')})`
    );
  }

  /**
   * Requires higher confidence when nothing could be verified.
   *
   * An opaque selector with no `describe()` — `#btn-1`, `[data-cy="x7f3"]` — leaves
   * every check above with nothing to test. Those are the heals most likely to be
   * wrong and the ones least possible to check, so the bar rises instead.
   *
   * @param context - The heal being attempted.
   * @param checks - Names of checks that had signal. Empty means nothing was verified.
   * @returns A rejection reason, or `undefined`.
   */
  private checkConfidenceFloor(context: IntentContext, checks: string[]): string | undefined {
    if (checks.length > 0) return undefined;

    const floor = this.policy.unverifiedConfidence;
    checks.push('confidence-floor');

    if (context.confidence >= floor) return undefined;

    return (
      `nothing about this heal could be verified — the selector implies no role and ` +
      `carries no wording, and no description was supplied — so confidence ` +
      `${context.confidence} must be at least ${floor}. Add describe() to the locator, ` +
      `or lower HEALER_UNVERIFIED_CONFIDENCE`
    );
  }
}

/**
 * Splits text into comparable content tokens.
 *
 * Handles the three casings identifiers actually use — `place-order-btn`,
 * `place_order_btn`, `placeOrderBtn` — then drops noise, numbers, very short tokens,
 * and a trailing plural `s` so `terms` matches `term`.
 *
 * @param text - Selector text, description, or accessible name.
 * @returns The content tokens.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;

  const parts = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/);

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower.length < 3 || /^\d+$/.test(lower) || STOPWORDS.has(lower)) continue;

    // Crude singularisation only — enough for terms/term and codes/code, without the
    // false matches a real stemmer's aggressive rules would introduce.
    const stem =
      lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss') ? lower.slice(0, -1) : lower;

    if (!STOPWORDS.has(stem)) tokens.add(stem);
  }

  return tokens;
}

/**
 * Tokens shared between two sets, matching on prefix as well as equality.
 *
 * Prefix matching is what makes this usable in practice: `promo` and `promotion` are
 * the same intent, and exact matching rejected a correct heal in the demo suite. The
 * four-character floor stops `can` from matching `cancel`.
 *
 * @param a - First token set.
 * @param b - Second token set.
 * @returns The tokens from `a` that matched something in `b`.
 */
function overlap(a: Set<string>, b: Set<string>): string[] {
  const hits: string[] = [];

  for (const left of a) {
    for (const right of b) {
      const prefixMatch =
        (left.length >= MIN_PREFIX_LENGTH && right.startsWith(left)) ||
        (right.length >= MIN_PREFIX_LENGTH && left.startsWith(right));

      if (left === right || prefixMatch) {
        hits.push(left);
        break;
      }
    }
  }

  return hits;
}

/**
 * The role a selector expression commits to, if any.
 *
 * Three sources: an explicit `getByRole('button', …)`; `getByPlaceholder`, which only
 * ever matches an editable field; and a leading tag name in a CSS selector, for the
 * handful of tags whose role is unambiguous. `getByLabel`, `getByText` and
 * `getByTestId` imply nothing and are left alone.
 *
 * @param selector - The original selector expression.
 * @returns The implied role, or `null` when the selector commits to none.
 */
function impliedRole(selector: string): string | null {
  const trimmed = selector.trim().replace(/^await\s+/, '').replace(/^(?:this\.)?page\./, '');

  const byRole = /^getByRole\(\s*(['"`])([^'"`]+)\1/.exec(trimmed);
  if (byRole?.[2]) return byRole[2].trim().toLowerCase();

  // A placeholder only exists on an input or textarea.
  if (/^getByPlaceholder\(/.test(trimmed)) return 'textbox';

  // Any other getBy* helper matches across roles, so it commits to nothing.
  if (/^getBy[A-Z]/.test(trimmed)) return null;

  // A tag-qualified CSS selector: `button#submit`, `a.nav-link`, `select[name=x]`.
  const tag = /^([a-zA-Z][a-zA-Z0-9]*)(?=[#.\[:]|$)/.exec(trimmed);
  const role = tag?.[1] ? TAG_ROLES[tag[1].toLowerCase()] : undefined;

  return role ?? null;
}
