/**
 * Turns an accessibility snapshot into a numbered list of elements the model can
 * choose between, each with a locator this package wrote rather than the model.
 *
 * ## Why this exists
 *
 * Healing used to ask one model call to do two unlike jobs: work out *which* element
 * the test meant, and *author* a Playwright locator for it. The first is semantic and
 * ambiguous, which is what models are good at. The second is mechanical and rule-bound
 * — and the rules are invisible in a snapshot.
 *
 * A real record shows the split exactly. Healing `//li/a/span[text()='Charter Cloud']`
 * against a renamed menu, the model reasoned that "Charter Cloud" was now "Private
 * Cloud" — correct, unaided — and then answered
 * `getByRole('listitem', { name: 'Private Cloud' })`. An `li` has no accessible name,
 * so the name filter excluded it and the expression matched nothing. The right element,
 * lost to a rule about ARIA name computation that no snapshot states.
 *
 * So the authoring job moves here, where it is deterministic, and the model is left
 * with the job it is actually good at: picking an id off a list.
 *
 * ## The rule that makes it sound
 *
 * **A name printed beside a role in the snapshot is that element's computed accessible
 * name.** It does not matter whether it came from contents, an `aria-label`, or a
 * `<label>` — the browser computed it, and `getByRole(role, { name })` will find it
 * again. That is why `navigation "Account"` is a legitimate candidate while
 * `listitem` is not: the snapshot prints a name for the first and none for the second.
 * Candidates are therefore built *only* from nodes the snapshot shows holding a name,
 * which is precisely the class of locator that cannot fail to resolve. The model's old
 * mistake — inventing a name for a node shown without one — is unrepresentable.
 *
 * ## Cost
 *
 * Nothing here touches the page. Uniqueness is decided by counting role/name pairs in
 * the snapshot, which *is* the accessibility tree, so no `count()` round-trips are
 * spent enumerating. The one candidate the model picks is still validated against the
 * live page by `SelectorValidator`, exactly as a free-form suggestion would be.
 *
 * @module core/CandidateFinder
 */

import type { ElementCandidate } from '../types';
import { STOPWORDS } from './IntentVerifier';
import { createLogger, type Logger } from '../utils/logger';

/**
 * Default cap on candidates offered.
 *
 * A dense application page runs 60-120 named nodes, so this fits a real page whole
 * while bounding the prompt. Over the cap, the lowest-scoring candidates are dropped
 * rather than the tail of the document — see {@link CandidateFinder.find}.
 */
const DEFAULT_LIMIT = 120;

/**
 * Snapshot roles that are never worth offering as a candidate.
 *
 * `text` is a pseudo-role Playwright prints for bare text nodes; it is not a role and
 * `getByRole('text', …)` resolves nothing. The rest are named containers so broad that
 * picking one would heal an action onto a wrapper — a click on `main` is not a click on
 * anything a test meant.
 */
const SKIPPED_ROLES: ReadonlySet<string> = new Set([
  'text', 'paragraph', 'generic', 'none', 'presentation', 'document', 'iframe',
]);

/** Roles that can plausibly satisfy each action, used only for ranking. */
const ACTION_AFFINITY: Readonly<Record<string, ReadonlySet<string>>> = {
  click: new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'checkbox', 'radio', 'switch', 'treeitem']),
  fill: new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']),
  type: new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']),
  clear: new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']),
  pressSequentially: new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']),
  check: new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']),
  uncheck: new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']),
  selectOption: new Set(['combobox', 'listbox']),
};

/**
 * Roles whose inline text is prose, not a control.
 *
 * Text candidates exist for elements a test clicks that carry no accessible name — a
 * `<li>` or `<div>` with a click handler. A paragraph's or heading's text is neither,
 * and offering every sentence on a content-heavy page would crowd out the candidates
 * that matter. Headings stay reachable by name, which they do have.
 */
const PROSE_ROLES: ReadonlySet<string> = new Set([
  'paragraph', 'heading', 'blockquote', 'code', 'emphasis', 'strong', 'caption',
  'definition', 'term', 'note', 'log', 'status', 'alert',
]);

/**
 * Roles whose inline snapshot text is a **value**, not text content.
 *
 * `- textbox "Patient name": Smith, John` prints what the user typed. That is not text
 * content and `getByText` cannot find it — an input's value is not in the DOM's text —
 * so offering it produced a candidate that resolved to nothing, breaking the one
 * guarantee this module makes. It was also a disclosure: a value is collapsed by
 * `PrivacyGuard` at `strict` precisely because it is user data, and routing it through
 * a candidate's `name` carried it out under the *label* rule instead, which keeps names
 * for actionable roles. A patient name typed into a form left the machine at the
 * strongest redaction level while the snapshot beside it read `‹redacted›`.
 *
 * Both failures have the same cure: a value-bearing control is never a text candidate.
 * It is always addressable by its own role and label anyway, which is the durable
 * locator and the one the first pass already offers.
 */
const VALUE_ROLES: ReadonlySet<string> = new Set([
  'textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox', 'option',
  'progressbar', 'meter', 'checkbox', 'radio', 'switch',
]);

/**
 * Longest inline text offered as a candidate.
 *
 * A locator built from a whole sentence is brittle — one copy edit breaks it — and long
 * enough to be a paragraph rather than a label. Eighty characters comfortably fits a
 * menu entry, a table cell, or a tab.
 */
const MAX_TEXT_LENGTH = 80;

/**
 * Selector grammar that reads like vocabulary but is not.
 *
 * `IntentVerifier.STOPWORDS` covers framework and role nouns; these are the *function*
 * names of XPath and Playwright's engines, which appear in a selector and never in an
 * accessible name. Without them `//li/a/span[text()='Charter Cloud']` scored a
 * candidate named "Span text element" on the word `text`, ranking a scrap of the
 * selector's own syntax against the element the test wanted.
 *
 * Kept local rather than added to the shared list: `IntentVerifier` uses that list to
 * decide whether to *reject* a heal, and a word dropped there is evidence discarded.
 * Here it only decides display order under the cap.
 */
const SELECTOR_SYNTAX: ReadonlySet<string> = new Set([
  'text', 'contains', 'starts', 'ends', 'normalize', 'space', 'string', 'translate',
  'substring', 'ancestor', 'descendant', 'following', 'preceding', 'sibling', 'child',
  'self', 'href', 'src', 'alt', 'title', 'value', 'placeholder', 'aria', 'attribute',
  'has', 'not', 'and', 'nth', 'eq', 'gt', 'lt',
]);

/** Shortest inline text worth a candidate, so stray punctuation is not offered. */
const MIN_TEXT_LENGTH = 2;

/** One parsed snapshot line, with the ancestry it was nested under. */
interface SnapshotNode {
  role: string;
  name?: string;
  /**
   * Inline text the snapshot printed as the node's value — the `X` in `- listitem: X`.
   *
   * Distinct from {@link name}: a name is the computed accessible name and makes the
   * element addressable by role, while this is text content that leaves the element
   * with *no* accessible name at all. It is the only handle such an element has.
   */
  text?: string;
  /** Indentation depth, used only to rebuild the tree. */
  depth: number;
  /** Named ancestors, outermost first. */
  ancestors: { role: string; name: string }[];
  /** Role of the immediately enclosing node, named or not. */
  parentRole?: string;
  /** True when the line carried a `[disabled]` attribute. */
  disabled: boolean;
  /**
   * Heading level, from a `[level=N]` attribute.
   *
   * Parsed because it disambiguates where nothing else can: two headings named
   * "Overview" at `h1` and `h2` share a role and a name, no named ancestor separates
   * them, and both were therefore dropped — leaving a page's own section titles
   * unreachable by id. `getByRole('heading', { name, level })` tells them apart, and
   * `SelectorValidator` already forwards `level`.
   */
  level?: number;
  /** Document order, so ties break stably. */
  order: number;
}

/** Options for {@link CandidateFinder.find}. */
export interface FindOptions {
  /** Maximum candidates to return. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: number;
  /**
   * The failing action. Used only to rank candidates that could perform it above
   * those that could not, so the cap drops the least useful first.
   */
  action?: string;
  /**
   * Text describing what the test was after — typically the original selector and the
   * author's description. Candidates whose name shares vocabulary with it rank higher.
   */
  intent?: string;
  /**
   * CSS selector the snapshot was scoped to, when it was scoped at all.
   *
   * **Required for correctness whenever `snapshotRoot` is configured**, not an
   * optimisation. Uniqueness here is decided by counting role/name pairs in the
   * snapshot, so a snapshot scoped to one container counts them within that container
   * — while an unscoped `getByRole(...)` resolves against the whole document. On a page
   * with a form and a sidebar that both hold a "Save" button, every candidate drawn
   * from the form alone then matched two elements and was rejected, so the privacy
   * setting this package recommends turned healing off.
   *
   * Given a scope, each expression is rooted at it, which makes the universe the
   * selector resolves in the same one the tally was computed in.
   */
  scope?: string;
}

/**
 * Builds the candidate list for one heal.
 */
export class CandidateFinder {
  private log: Logger;

  constructor(log?: Logger) {
    this.log = log ?? createLogger('heal:candidates');
  }

  /**
   * Enumerates the named elements of a snapshot as pickable candidates.
   *
   * @param snapshot - Accessibility snapshot text, as captured by `getAriaSnapshot`.
   * @param options - Cap, and the signals used to rank against the cap.
   * @returns Candidates in document order, ids assigned 1..n. Empty when the snapshot
   * holds nothing nameable, which is the caller's signal to ask for a free-form answer.
   */
  find(snapshot: string, options: FindOptions = {}): ElementCandidate[] {
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) return [];

    const parsed = this.parse(snapshot);

    const nodes = parsed.filter(
      (node) => node.name !== undefined && node.name !== '' && !SKIPPED_ROLES.has(node.role)
    );

    // How many nodes share each role/name pair. The snapshot *is* the accessibility
    // tree, so this is the same number `getByRole(role, { name, exact: true })` would
    // report — computed here without a browser round-trip.
    const tally = new Map<string, SnapshotNode[]>();
    for (const node of nodes) {
      const key = `${node.role}\u0000${node.name}`;
      const group = tally.get(key);
      if (group) group.push(node);
      else tally.set(key, [node]);
    }

    // Accessible names already offered, so the text pass does not duplicate them, and
    // how often each piece of inline text occurs, which is what decides whether
    // `getByText` can address it uniquely.
    const named = new Set(nodes.map((node) => node.name as string));
    const textTally = new Map<string, number>();
    for (const node of parsed) {
      if (node.text === undefined) continue;
      textTally.set(node.text, (textTally.get(node.text) ?? 0) + 1);
    }
    const seenText = new Set<string>();

    const scored: { node: SnapshotNode; candidate: ElementCandidate; score: number }[] = [];
    const intentTokens = tokenise(options.intent ?? '');
    const affinity = ACTION_AFFINITY[options.action ?? ''] ?? new Set<string>();

    for (const node of nodes) {
      if (node.disabled) continue; // An action on it would time out; not a heal.

      // The options of a native `<select>` are in the accessibility tree but not
      // rendered until it opens, so an action on one waits for a visibility that never
      // comes. Playwright serialises such a select as `combobox` with `option` children,
      // which is how they are told apart from a custom listbox whose options are real
      // elements. The select itself is still offered, and `selectOption` targets that.
      if (node.role === 'option' && node.parentRole === 'combobox') continue;

      const name = node.name as string;
      const group = tally.get(`${node.role}\u0000${name}`) as SnapshotNode[];
      const selector = this.selectorFor(node, group, options.scope);

      // Dropped rather than offered ambiguously: a candidate list whose entries do not
      // resolve uniquely would reintroduce the guessing this module exists to remove.
      if (selector === null) continue;

      scored.push({
        node,
        candidate: {
          id: 0, // assigned below, once the final set and order are known
          role: node.role,
          name,
          context: node.ancestors.map((a) => `${a.role} "${a.name}"`),
          selector,
        },
        score: score(name, intentTokens, affinity.has(node.role)),
      });
    }

    // A second pass for elements that have text but no accessible name.
    //
    // This is the gap the first pass cannot cover, and it is not a rare one. A menu
    // built as `<li><span>Charter Cloud</span></li>` with a click handler has no
    // accessible name anywhere — `listitem` takes none from its contents and the span
    // has no role — so the element a test clicks every day is unaddressable by role.
    // From a healing record, that page produced no candidate at all, the model fell
    // back to `getByText('Charter Cloud', { exact: true })` — which was correct — and
    // the heal was then lost for unrelated reasons.
    //
    // `getByText` with `exact: true` collapses an ancestor chain to a single element, so
    // `<li><span>X</span></li>` resolves to one node rather than two. Verified against a
    // browser, including three levels of wrapper divs.
    for (const node of parsed) {
      if (node.disabled || node.text === undefined) continue;

      // The text must belong to a node with a real role.
      //
      // A bare `- text: …` entry is not reliably one element: Playwright coalesces
      // adjacent text into a single entry, so a form serialised as
      //
      //   - checkbox "Accept terms"
      //   - text: Accept terms Country
      //   - combobox "Country"
      //
      // offers text that no element has — `getByText('Accept terms Country', { exact:
      // true })` matches nothing. Other `- text:` entries *are* a single element (a
      // `<div>` with a click handler, a span under wrapper divs), and the snapshot gives
      // no way to tell the two apart. Since the prompt tells the model every candidate
      // resolves to exactly one element, the unverifiable class is excluded rather than
      // offered with a caveat; those elements still heal through the free-form path.
      if (SKIPPED_ROLES.has(node.role) || PROSE_ROLES.has(node.role)) continue;

      // And it must be text content rather than a value the user typed. See VALUE_ROLES.
      if (VALUE_ROLES.has(node.role)) continue;

      if (node.text.length > MAX_TEXT_LENGTH || node.text.length < MIN_TEXT_LENGTH) continue;

      // Already reachable by role, which is the more durable locator of the two. Two
      // candidates for one element would only spend prompt space and invite the weaker
      // pick.
      if (named.has(node.text)) continue;

      // Ambiguous text has no unique expression and no ancestor trick to fall back on —
      // `getByText` takes no role to scope by — so it is dropped rather than guessed at.
      if ((textTally.get(node.text) ?? 0) !== 1) {
        this.log.debug(`Dropping the text "${node.text}": it appears more than once.`);
        continue;
      }

      if (seenText.has(node.text)) continue;
      seenText.add(node.text);

      const root = options.scope ? `locator(${quote(options.scope)}).` : '';

      scored.push({
        node,
        candidate: {
          id: 0,
          role: node.role,
          name: node.text,
          context: node.ancestors.map((a) => `${a.role} "${a.name}"`),
          selector: `${root}getByText(${quote(node.text)}, { exact: true })`,
        },
        // Ranked below an equally-relevant named candidate: text is the weaker handle,
        // so when the cap has to choose it should keep the role-based one.
        score: score(node.text, intentTokens, affinity.has(node.role)) - 1,
      });
    }

    if (scored.length === 0) {
      this.log.debug('Snapshot holds nothing addressable; no candidates to offer.');
      return [];
    }

    // Over the cap, drop the least relevant — never the tail of the document. A nav
    // bar at the top of the page must not survive only because it was serialised first.
    let kept = scored;
    if (scored.length > limit) {
      kept = [...scored]
        .sort((a, b) => b.score - a.score || a.node.order - b.node.order)
        .slice(0, limit)
        .sort((a, b) => a.node.order - b.node.order);
      this.log.debug(
        `Snapshot yielded ${scored.length} candidates; offering the ${limit} most relevant.`
      );
    }

    return kept.map((entry, index) => ({ ...entry.candidate, id: index + 1 }));
  }

  /**
   * Writes the locator for one node, scoping it only as far as uniqueness requires.
   *
   * `exact: true` is always set. A name matches as a substring by default, so a plain
   * name filter on "Cloud" would also match "Private Cloud" — the uniqueness this
   * module claims has to be the uniqueness Playwright will actually see.
   *
   * @param node - The node to address.
   * @param group - Every node sharing its role and name, itself included.
   * @param scope - CSS selector the snapshot was scoped to, if any. See
   * {@link FindOptions.scope} — without it, a scoped snapshot yields expressions that
   * resolve against a wider universe than the one uniqueness was decided in.
   * @returns The expression, or `null` when no ancestor makes it unique.
   */
  private selectorFor(
    node: SnapshotNode,
    group: SnapshotNode[],
    scope?: string
  ): string | null {
    const root = scope ? `locator(${quote(scope)}).` : '';
    const leaf = `getByRole('${node.role}', { name: ${quote(node.name as string)}, exact: true })`;

    if (group.length === 1) return `${root}${leaf}`;

    // A heading's level separates it from a namesake without reaching for an ancestor,
    // and survives the page being re-sectioned, so it is tried first.
    if (node.level !== undefined) {
      const sharingLevel = group.filter((other) => other.level === node.level);
      if (sharingLevel.length === 1) {
        return (
          `${root}getByRole('${node.role}', { name: ${quote(node.name as string)}, ` +
          `exact: true, level: ${node.level} })`
        );
      }
    }

    // Ambiguous. Walk outwards from the nearest named ancestor and stop at the first
    // one that separates this node from its namesakes — the shortest expression that
    // is still unique, rather than the whole path.
    for (let i = node.ancestors.length - 1; i >= 0; i--) {
      const anchor = node.ancestors[i];
      if (!anchor) continue;

      const sharing = group.filter((other) =>
        other.ancestors.some((a) => a.role === anchor.role && a.name === anchor.name)
      );

      if (sharing.length === 1) {
        return `${root}getByRole('${anchor.role}', { name: ${quote(anchor.name)} }).${leaf}`;
      }
    }

    this.log.debug(
      `Dropping "${node.role}" named "${node.name}": ${group.length} share it and no ` +
        'ancestor tells them apart.'
    );
    return null;
  }

  /**
   * Parses snapshot text into nodes carrying their named ancestry.
   *
   * Playwright's format is indentation-scoped YAML-ish: `- role "Name" [attr=value]:`,
   * with `/url:` and bare `- text:` lines interleaved. Only the shape this module needs
   * is read; anything unrecognised is skipped rather than guessed at.
   *
   * @param snapshot - Snapshot text.
   * @returns Parsed nodes in document order.
   */
  private parse(snapshot: string): SnapshotNode[] {
    const nodes: SnapshotNode[] = [];
    const stack: { depth: number; role: string; name?: string }[] = [];
    let order = 0;

    for (const line of (snapshot ?? '').split('\n')) {
      const outer = /^(\s*)-\s+(.*)$/.exec(line);
      if (!outer) continue;

      const depth = (outer[1] ?? '').length;

      // `- role`, optionally ` "Name"`, optionally ` [attrs]`, optionally `: inline text`.
      const match =
        /^([a-zA-Z][a-zA-Z0-9-]*)(?:\s+"((?:[^"\\]|\\.)*)")?\s*(\[[^\]]*\])?\s*(?::\s*(.*))?$/.exec(
          unwrapYamlScalar(outer[2] ?? '')
        );
      // A `/url:` line is a property of its parent, not a node: it does not start with a
      // role, so it never matches here.
      if (!match?.[1]) continue;

      const role = match[1];
      const name = match[2] === undefined ? undefined : unquote(match[2]);
      const attrs = match[3] ?? '';
      const text = readInlineText(match[4]);

      while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth) {
        stack.pop();
      }

      const ancestors = stack
        .filter((entry): entry is { depth: number; role: string; name: string } => entry.name !== undefined && entry.name !== '')
        .map((entry) => ({ role: entry.role, name: entry.name }));

      const parent = stack[stack.length - 1];

      nodes.push({
        role,
        ...(name !== undefined ? { name } : {}),
        ...(text !== undefined ? { text } : {}),
        depth,
        ancestors,
        ...(parent !== undefined ? { parentRole: parent.role } : {}),
        disabled: /\bdisabled\b/.test(attrs),
        ...(readLevel(attrs) !== undefined ? { level: readLevel(attrs) as number } : {}),
        order: order++,
      });

      stack.push({ depth, role, ...(name !== undefined ? { name } : {}) });
    }

    return nodes;
  }
}

/**
 * Renders a name as a single-quoted JavaScript string literal.
 *
 * @param value - The accessible name.
 * @returns The literal, with backslashes and inner quotes escaped.
 */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Reverses the escaping Playwright applies to names inside a snapshot.
 *
 * @param value - The raw text between the quotes.
 * @returns The name as computed by the browser.
 */
function unquote(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/**
 * Reads a `[level=N]` attribute, if the line carried one.
 *
 * @param attrs - The bracketed attribute text, or an empty string.
 * @returns The level, or `undefined` when absent or unparseable.
 */
function readLevel(attrs: string): number | undefined {
  const match = /\blevel\s*=\s*(\d+)/.exec(attrs);
  if (!match?.[1]) return undefined;

  const level = Number(match[1]);
  return Number.isInteger(level) && level > 0 ? level : undefined;
}

/**
 * Reads the inline text a snapshot printed after a node's colon.
 *
 * `- listitem: Charter Cloud` carries its text this way, and so does a bare
 * `- text: Charter Cloud`. A container that merely opens — `- main:` — has nothing
 * after the colon and yields `undefined`. The value is quoted when it holds a YAML
 * indicator, so quotes are stripped when present.
 *
 * @param value - Everything after the colon, or `undefined` when there was no colon.
 * @returns The text, or `undefined` when there is none.
 */
function readInlineText(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return undefined;

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unquote(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed;
}

/**
 * Unwraps a snapshot entry that YAML required to be quoted.
 *
 * The snapshot is YAML, so an entry holding an indicator character is emitted as a
 * single-quoted scalar and the whole `role "name" [attrs]` moves inside the quotes:
 *
 * ```
 *   - button "Save"            →  plain
 *   - 'button "Total: 42"'     →  quoted, because of the ": "
 *   - 'button "hash #tag"'     →  quoted, because of the " #"
 *   - 'button "brace {x}"'     →  quoted, because of the brace
 * ```
 *
 * Missing this was a silent coverage hole rather than a parse error: the entry simply
 * did not match, so any element whose accessible name contained `: `, ` #` or a brace
 * was never offered as a candidate — and "Total: 42", "Status: Active" are ordinary
 * interface text. A container's trailing colon sits *outside* the closing quote, which
 * is why the closing quote is found from the right.
 *
 * @param body - Everything after the `- ` on one line.
 * @returns The entry, unwrapped and un-escaped if it was quoted.
 */
function unwrapYamlScalar(body: string): string {
  if (!body.startsWith("'")) return body;

  const close = body.lastIndexOf("'");
  if (close <= 0) return body;

  // YAML escapes a single quote inside a single-quoted scalar by doubling it.
  return body.slice(1, close).replace(/''/g, "'");
}

/**
 * Splits text into lowercase word tokens of three characters or more.
 *
 * Words that describe selector syntax or a kind of element rather than *which*
 * element carry no signal, so they are dropped — `//li/a/span[text()='Charter Cloud']`
 * must not rank a candidate named "Span text element" above the menu item. The list is
 * `IntentVerifier`'s, shared rather than re-invented.
 *
 * @param text - Any text.
 * @returns The tokens, deduplicated.
 */
function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (token) => token.length >= 3 && !STOPWORDS.has(token) && !SELECTOR_SYNTAX.has(token)
      )
  );
}

/**
 * Ranks a candidate for survival against the cap.
 *
 * Deliberately crude: this decides only what to *show* when a page has more named
 * elements than fit, never what to pick. Choosing is the model's job, and a scoring
 * function confident enough to choose would be a worse version of it.
 *
 * @param name - The candidate's accessible name.
 * @param intent - Tokens from the original selector and description.
 * @param actionable - Whether the role can perform the failing action.
 * @returns A score; higher survives.
 */
function score(name: string, intent: Set<string>, actionable: boolean): number {
  let value = actionable ? 2 : 0;

  for (const token of tokenise(name)) {
    if (intent.has(token)) {
      value += 4;
      continue;
    }
    // Prefix matching, so `promo` finds `promotion` — the same allowance
    // `IntentVerifier` makes, and for the same reason.
    for (const wanted of intent) {
      const shorter = token.length < wanted.length ? token : wanted;
      const longer = token.length < wanted.length ? wanted : token;
      if (shorter.length >= 4 && longer.startsWith(shorter)) {
        value += 2;
        break;
      }
    }
  }

  return value;
}
