/**
 * Checks whether a selector suggested by an AI actually works on the live page.
 *
 * Nothing here throws. A bad suggestion is the expected case, not an exception:
 * the engine needs a boolean (or a reason) so it can retry or give up, and a throw
 * from the validator would mask the original Playwright failure.
 *
 * Two jobs beyond "does it match":
 *
 * 1. **Translation.** The prompts ask the model to prefer user-facing locators, so
 *    it answers with source expressions such as `getByRole('button', { name: 'OK' })`
 *    — a string `page.locator()` cannot accept. {@link SelectorValidator.resolve}
 *    maps those onto the matching `page.getBy*()` call.
 * 2. **Uniqueness.** A selector matching several elements is not a working
 *    selector: Playwright's strict mode throws when an action targets more than one
 *    element, so accepting it would just move the failure. It is rejected with a
 *    reason the engine feeds into the next prompt.
 *
 * @module core/SelectorValidator
 */

import type { FrameLocator, Locator, Page } from '@playwright/test';

import { createLogger, type Logger } from '../utils/logger';

/**
 * Anything a locator can be built against.
 *
 * `Page` and `FrameLocator` expose the same builder surface — `locator()`, the seven
 * `getBy*` helpers, and `frameLocator()` — which is what lets one resolver walk an
 * arbitrarily nested frame path and then resolve the leaf expression against whatever it
 * lands on, without caring which of the two it started from.
 */
type LocatorRoot = Pick<
  Page,
  | 'locator'
  | 'getByRole'
  | 'getByLabel'
  | 'getByText'
  | 'getByPlaceholder'
  | 'getByTestId'
  | 'getByTitle'
  | 'getByAltText'
> & { frameLocator(selector: string): FrameLocator };

/** A selector expression split into the frames it descends through and the rest. */
export interface FrameChain {
  /** Frame selectors, outermost first. Empty when the expression is not frame-scoped. */
  frames: string[];
  /** The expression with the `frameLocator(...)` prefix removed. */
  remainder: string;
}

/** Outcome of a validation attempt, including why it failed. */
export interface ValidationResult {
  /** True when the selector resolved to exactly one visible element. */
  valid: boolean;
  /** How many elements matched. `-1` when the selector could not be resolved. */
  matches: number;
  /** Human-readable reason, suitable for a healing record or a retry prompt. */
  reason?: string;
}

/** The `page.getBy*` helpers this validator understands. */
type GetByMethod =
  | 'getByRole'
  | 'getByLabel'
  | 'getByText'
  | 'getByPlaceholder'
  | 'getByTestId'
  | 'getByTitle'
  | 'getByAltText';

const GET_BY_METHODS: readonly GetByMethod[] = [
  'getByRole',
  'getByLabel',
  'getByText',
  'getByPlaceholder',
  'getByTestId',
  'getByTitle',
  'getByAltText',
];

/** Options a `getBy*` expression may carry that we forward to Playwright. */
interface GetByOptions {
  /** Accessible name. Playwright accepts a string or a regex, and so do we. */
  name?: string | RegExp;
  exact?: boolean;
  level?: number;
}

/** A trailing positional refinement, e.g. `.first()` or `.nth(2)`. */
interface Refinement {
  kind: 'first' | 'last' | 'nth';
  index?: number;
}

/**
 * Time allowed for a suggested element to appear.
 *
 * One second: the page is already loaded and rendered by the time an action fails,
 * so a correct selector resolves immediately. A longer budget would multiply across
 * retries and turn a failed heal into a visible stall.
 */
const DEFAULT_TIMEOUT_MS = 1_000;

/**
 * Renders text as a single-quoted JavaScript string literal.
 *
 * @param value - Raw text.
 * @returns The literal, with inner quotes escaped.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, String.raw`\'`)}'`;
}

/** Prefixes that mark a selector as belonging to a non-CSS Playwright engine. */
const NON_CSS_PREFIXES = ['//', '..', 'xpath=', 'text=', 'id=', 'data-testid=', 'css='];

/**
 * Validates AI-suggested selectors against a live page.
 */
export class SelectorValidator {
  private log: Logger;

  /**
   * @param timeoutMs - How long to wait for a suggested element, in milliseconds.
   * Defaults to {@link DEFAULT_TIMEOUT_MS}.
   */
  constructor(private timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.log = createLogger('heal:validator');
  }

  /**
   * Checks whether a suggested selector resolves to exactly one visible element.
   *
   * @param selector - Selector or locator expression from the AI.
   * @param page - Page the failing action was running against.
   * @returns True when the selector is usable. Never throws.
   */
  async validate(selector: string, page: Page): Promise<boolean> {
    const result = await this.validateDetailed(selector, page);
    return result.valid;
  }

  /**
   * Tries several selectors in order and returns the first that works.
   *
   * Useful when a provider offers alternatives, or when falling back through a
   * list of hand-written candidates before paying for an AI call.
   *
   * @param selectors - Candidates to try, best first.
   * @param page - Page to validate against.
   * @returns The first working selector, or `null` if none worked.
   */
  async validateMultiple(selectors: string[], page: Page): Promise<string | null> {
    for (const selector of selectors) {
      if (await this.validate(selector, page)) {
        this.log.debug(`"${selector}" is the first candidate that works.`);
        return selector;
      }
    }

    this.log.debug(`None of the ${selectors.length} candidate selector(s) worked.`);
    return null;
  }

  /**
   * Like {@link validate}, but reports the match count and the failure reason so
   * the engine can record it and feed it back into a retry.
   *
   * @param selector - Selector or locator expression from the AI.
   * @param page - Page the failing action was running against.
   * @returns The validation outcome. Never throws.
   */
  async validateDetailed(selector: string, page: Page): Promise<ValidationResult> {
    if (!selector || selector.trim() === '') {
      return { valid: false, matches: -1, reason: 'selector was empty' };
    }

    if (!this.isValidSyntax(selector)) {
      return { valid: false, matches: -1, reason: 'selector is not syntactically valid' };
    }

    // Checked before resolving, not after: `resolve` would otherwise build a locator from
    // the leading call and silently ignore the rest, which is a different element.
    const unsupported = this.unsupportedSuffix(selector);
    if (unsupported) {
      return {
        valid: false,
        matches: -1,
        reason:
          `the expression continues with "${unsupported}", which cannot be resolved from ` +
          'text — answer with a single getByRole/getByLabel/... or locator() call, ' +
          'optionally refined by .first(), .last() or .nth(n)',
      };
    }

    // Same rule, one level in: an option that narrows the match and is not forwarded
    // would resolve something broader than the expression describes.
    const unhonoured = this.unhonouredOptions(selector);
    if (unhonoured.length > 0) {
      return {
        valid: false,
        matches: -1,
        reason:
          `${unhonoured.map((key) => `"${key}"`).join(', ')} cannot be applied from a text ` +
          'expression — only name, exact and level are supported, so disambiguate with the ' +
          'accessible name instead',
      };
    }

    let locator: Locator;
    try {
      const resolved = this.resolve(selector, page);
      if (!resolved) {
        return { valid: false, matches: -1, reason: 'selector expression could not be parsed' };
      }
      locator = resolved;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { valid: false, matches: -1, reason: `selector was rejected by Playwright: ${detail}` };
    }

    try {
      // Wait for attachment rather than counting straight away — a correct
      // selector can still be a beat behind a re-render.
      await locator.first().waitFor({ state: 'attached', timeout: this.timeoutMs });
    } catch {
      // Ignored: the count below reports the miss more precisely than this throw.
    }

    let matches: number;
    try {
      matches = await locator.count();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { valid: false, matches: -1, reason: `could not evaluate selector: ${detail}` };
    }

    if (matches === 0) {
      this.log.debug(`"${selector}" matched no elements.`);
      return { valid: false, matches, reason: 'matched no elements' };
    }

    if (matches > 1) {
      // Strict mode would throw when the action runs, so reject it here and let
      // the engine ask for something more specific.
      this.log.debug(`"${selector}" matched ${matches} elements.`);
      return {
        valid: false,
        matches,
        reason: `matched ${matches} elements — must match exactly one`,
      };
    }

    // Present in the DOM but invisible: an action would time out waiting for it,
    // so this is reported separately from a plain miss — it usually means the right
    // kind of element was found in the wrong place (a hidden template or modal).
    try {
      const visible = await locator.isVisible({ timeout: this.timeoutMs });
      if (!visible) {
        this.log.debug(`"${selector}" matched a hidden element.`);
        return { valid: false, matches, reason: 'matched an element that is not visible' };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { valid: false, matches, reason: `visibility check failed: ${detail}` };
    }

    this.log.debug(`"${selector}" resolved to a single visible element.`);
    return { valid: true, matches };
  }

  /**
   * Cheap synchronous check for obviously malformed selectors.
   *
   * Runs in Node, where there is no `document` to parse CSS with — a
   * `document.querySelector()` probe would throw `ReferenceError` and report every
   * selector as invalid. When a DOM *is* present (jsdom, or a browser bundle) its
   * real parser is used; otherwise the structural checks below catch the mistakes
   * models actually make: unbalanced quotes, brackets, or a dangling combinator.
   *
   * This is a pre-filter, not an authority — {@link validateDetailed} is what
   * decides whether a selector works. A syntactically fine selector that matches
   * nothing still fails there.
   *
   * @param selector - Selector to inspect.
   * @returns False only when the selector cannot possibly parse.
   */
  isValidSyntax(selector: string): boolean {
    if (!selector || selector.trim() === '') return false;

    const trimmed = selector.trim();

    // Call expressions are JavaScript, not CSS: balance is what matters. This covers
    // `getBy*`, the explicit `locator(...)` form, and any `frameLocator(...)` prefix.
    const isCall =
      GET_BY_METHODS.some((method) => trimmed.startsWith(`${method}(`)) ||
      trimmed.startsWith('locator(') ||
      trimmed.startsWith('frameLocator(');
    if (isCall || /^(?:await\s+|(?:this\.)?page\.)/.test(trimmed)) {
      return this.isBalanced(trimmed);
    }

    // Non-CSS engines (XPath, text=, id=) have their own grammars; only check that
    // quotes and brackets are balanced.
    if (NON_CSS_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      return this.isBalanced(trimmed);
    }

    if (!this.isBalanced(trimmed)) return false;

    // A trailing or leading combinator is never valid CSS.
    if (/[>+~,]\s*$/.test(trimmed) || /^\s*[>+~,]/.test(trimmed)) return false;

    // Use the real parser when one happens to exist (jsdom, browser bundle).
    if (typeof document !== 'undefined') {
      try {
        document.createDocumentFragment().querySelector(trimmed);
        return true;
      } catch {
        return false;
      }
    }

    return true;
  }

  /**
   * Checks that quotes, parentheses, and brackets are balanced.
   *
   * @param value - Text to inspect.
   * @returns True when nothing is left open.
   */
  private isBalanced(value: string): boolean {
    const stack: string[] = [];
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    let inQuote: string | null = null;
    let escaped = false;

    for (const char of value) {
      if (inQuote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === inQuote) inQuote = null;
        continue;
      }

      if (char === '"' || char === "'" || char === '`') inQuote = char;
      else if (char === '(' || char === '[' || char === '{') stack.push(char);
      else if (char === ')' || char === ']' || char === '}') {
        if (stack.pop() !== pairs[char]) return false;
      }
    }

    return inQuote === null && stack.length === 0;
  }

  /**
   * Translates a selector string into a Playwright {@link Locator}.
   *
   * Accepts three shapes:
   * - `getBy*` source expressions, optionally prefixed with `await `/`page.` and
   *   optionally suffixed with `.first()`, `.last()`, or `.nth(n)`.
   * - XPath (`//button`), which `page.locator()` handles natively.
   * - Anything else, passed straight to `page.locator()` (CSS, `text=`, `#id`).
   *
   * @param selector - Raw selector from the AI.
   * @param page - Page to build the locator against.
   * @returns The locator, or `null` if the expression was malformed or carries a
   * suffix this validator cannot interpret. See {@link unsupportedSuffix}.
   */
  resolve(selector: string, page: Page): Locator | null {
    // Strip the wrappers models habitually add: `await `, `page.`, `this.page.`.
    let expression = selector.trim().replace(/^await\s+/, '');
    expression = expression.replace(/^(?:this\.)?page\./, '');

    // Descend into any frames the expression names before resolving the leaf. Without
    // this, an expression for an element inside an iframe would be resolved against the
    // parent document and match nothing.
    const chain = this.splitFrameChain(expression);
    let root: LocatorRoot = page as LocatorRoot;
    for (const frame of chain.frames) {
      root = root.frameLocator(frame) as unknown as LocatorRoot;
    }
    expression = chain.remainder;

    const stripped = this.stripRefinements(expression);
    expression = stripped.remainder;

    const method = GET_BY_METHODS.find((candidate) => expression.startsWith(`${candidate}(`));

    // Refuse rather than resolve the leading call and drop the rest. Silently ignoring a
    // trailing `.filter(...)` or `.locator('..')` yields a locator for a *different*
    // element than the expression describes, which is the one failure this class exists
    // to prevent.
    const call = method ?? (expression.startsWith('locator(') ? 'locator' : null);
    if (call) {
      const trailing = this.trailingAfterCall(expression, call);
      if (trailing !== null) {
        this.log.debug(
          `Cannot resolve "${expression}": the trailing "${trailing}" is not something a ` +
            'text expression can express. Only .first(), .last() and .nth(n) may follow a call.'
        );
        return null;
      }
    }

    let locator: Locator;
    if (method) {
      const built = this.buildGetByLocator(method, expression, root);
      if (!built) return null;
      locator = built;
    } else if (expression.startsWith('locator(')) {
      // The explicit call form. Frame-scoped expressions always use it, because a bare
      // CSS string after a `frameLocator(...)` prefix would be ambiguous — and models
      // write `locator('#x')` for page-level selectors regardless.
      const inner = this.extractCallArguments(expression, 'locator');
      const argument = inner === null ? undefined : this.splitTopLevel(inner)[0];
      const value = argument === undefined ? null : this.parseStringLiteral(argument);
      if (value === null) {
        this.log.debug(`Could not read the argument of "${expression}".`);
        return null;
      }
      locator = root.locator(value);
    } else {
      // locator() understands CSS, XPath, and Playwright's text= engines.
      locator = root.locator(expression);
    }

    // Applied outermost-last, so `.nth(2).first()` means what it says.
    for (const refinement of stripped.refinements) {
      locator = this.applyRefinement(locator, refinement);
    }

    return locator;
  }

  /**
   * The part of an expression this validator cannot interpret, if any.
   *
   * A model asked for one locator sometimes answers with a chain:
   * `getByRole('row').filter({ hasText: 'Smith' }).getByRole('button')`. The parser reads
   * the first call and, before this existed, threw the rest away — so on a page with one
   * row the expression validated and the healer acted on **the row instead of the button
   * inside it**, while the record, the report and the CI gate all displayed the full
   * chain. A selector that resolves to something other than what it says is exactly the
   * failure this class exists to prevent, so it is refused instead.
   *
   * Refusing is the right answer rather than a missing feature: `.filter({ has: … })`
   * takes a *locator*, so it cannot round-trip through a text expression at all. The
   * reason is fed into the next prompt like any other rejection, which is where a model
   * learns to answer with one call.
   *
   * Bare CSS and XPath return `null` — they have their own grammars, and Playwright's
   * parser is the authority on those, not this one.
   *
   * @param selector - A selector expression, as written by a model or a page object.
   * @returns The uninterpretable trailing text, or `null` when there is none.
   */
  unsupportedSuffix(selector: string): string | null {
    let expression = selector.trim().replace(/^await\s+/, '').replace(/^(?:this\.)?page\./, '');
    expression = this.splitFrameChain(expression).remainder;
    expression = this.stripRefinements(expression).remainder;

    const method = GET_BY_METHODS.find((candidate) => expression.startsWith(`${candidate}(`));
    const call = method ?? (expression.startsWith('locator(') ? 'locator' : null);
    if (!call) return null;

    return this.trailingAfterCall(expression, call);
  }

  /**
   * Options an expression sets that this validator does not forward to Playwright.
   *
   * The sibling of {@link unsupportedSuffix}, closing the same hole one level in. Every
   * option here *narrows* what a locator matches — `getByRole('button', { pressed: true })`
   * is a strictly smaller set than `getByRole('button')` — so quietly dropping one resolves
   * something broader than the expression describes. That is the same failure as a
   * truncated chain: a selector that means one thing and resolves as another.
   *
   * `locator()`'s second argument is included wholesale, since `has` and `hasText` are not
   * forwarded at all.
   *
   * Only `name`, `exact` and `level` are honoured, which is what the prompt asks for and
   * what a healed selector needs. Anything else is refused and the reason feeds the retry.
   *
   * @param selector - A selector expression.
   * @returns The offending option names, or an empty array when there are none.
   */
  unhonouredOptions(selector: string): string[] {
    let expression = selector.trim().replace(/^await\s+/, '').replace(/^(?:this\.)?page\./, '');
    expression = this.splitFrameChain(expression).remainder;
    expression = this.stripRefinements(expression).remainder;

    const method = GET_BY_METHODS.find((candidate) => expression.startsWith(`${candidate}(`));
    const call = method ?? (expression.startsWith('locator(') ? 'locator' : null);
    if (!call) return [];

    const inner = this.extractCallArguments(expression, call);
    if (inner === null) return [];

    const args = this.splitTopLevel(inner);

    // `locator('x', { hasText: … })` — the whole options object is ignored, so name it
    // rather than picking through keys we would not honour anyway.
    if (call === 'locator') return args.length > 1 ? ['options'] : [];

    const source = args[1];
    if (source === undefined) return [];

    // Blank the literals first. An accessible name is free text and may contain anything —
    // `{ name: 'Total, b: c' }` would otherwise read `b` as an option key and reject a
    // perfectly good suggestion. Quotes before regexes, so a `/` inside a string is gone
    // by the time regex literals are matched.
    const stripped = source
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/\/(?:\\.|[^/\\])+\/[gimsuy]*/g, '//');

    const honoured = new Set(['name', 'exact', 'level']);
    const keys = [...stripped.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g)]
      .map((match) => match[1])
      .filter((key): key is string => key !== undefined);

    return [...new Set(keys.filter((key) => !honoured.has(key)))];
  }

  /**
   * Whatever follows a complete `call(...)` at the start of an expression.
   *
   * @param expression - Expression beginning with `call(`.
   * @param call - The method name it begins with.
   * @returns The trailing text, or `null` when the call is the whole expression.
   * Unbalanced parentheses also yield `null` — that is reported separately, as a parse
   * failure rather than an unsupported suffix.
   */
  private trailingAfterCall(expression: string, call: string): string | null {
    const inner = this.extractCallArguments(expression, call);
    if (inner === null) return null;

    const rest = expression.slice(call.length + inner.length + 2).trim();
    return rest === '' ? null : rest;
  }

  /**
   * Splits a leading `frameLocator(...)` chain off an expression.
   *
   * `frameLocator('#pay').getByRole('button')` becomes
   * `{ frames: ['#pay'], remainder: "getByRole('button')" }`, and nesting accumulates.
   * Exposed because the engine needs the same information for a different reason: it
   * scopes the page snapshot to the frame, since a page-level snapshot shows an iframe
   * as a bare leaf and tells the model nothing about what is inside it.
   *
   * @param expression - A selector expression, already stripped of `await`/`page.`.
   * @returns The frames it descends through and what is left.
   */
  splitFrameChain(expression: string): FrameChain {
    const frames: string[] = [];
    let rest = expression.trim();

    while (rest.startsWith('frameLocator(')) {
      const inner = this.extractCallArguments(rest, 'frameLocator');
      if (inner === null) break;

      const argument = this.splitTopLevel(inner)[0];
      const value = argument === undefined ? null : this.parseStringLiteral(argument);
      if (value === null) break;

      frames.push(value);

      // Step past `frameLocator(` + the arguments + `)`, then the chaining dot.
      rest = rest.slice('frameLocator'.length + inner.length + 2).replace(/^\s*\.\s*/, '');
    }

    return { frames, remainder: rest };
  }

  /**
   * Puts a frame path back onto a selector that was written in the frame's terms.
   *
   * A frame-scoped heal shows the model the frame's own snapshot, so its answer is about
   * elements inside the frame — `getByRole('button', { name: 'Pay' })`, with no mention
   * of the frame. Taken literally that resolves against the parent document and matches
   * nothing, or worse matches something else. This makes the expression explicit, so the
   * validator, the intent check, the healing record and the suggested rewrite all agree
   * on one form that can be pasted into a page object.
   *
   * A model that named the frames itself is left alone rather than having ours doubled on.
   *
   * @param selector - The suggestion, as the model wrote it.
   * @param frames - Frame selectors from the failing expression, outermost first.
   * @returns A fully-qualified expression.
   */
  qualifyWithFrames(selector: string, frames: string[]): string {
    if (frames.length === 0) return selector;

    const suggestion = selector
      .trim()
      .replace(/^await\s+/, '')
      .replace(/^(?:this\.)?page\./, '');

    if (suggestion === '') return selector;
    if (suggestion.startsWith('frameLocator(')) return suggestion;

    // Bare CSS is wrapped in the explicit call form: `frameLocator('#f').#card` would be
    // ambiguous to parse back, whereas `frameLocator('#f').locator('#card')` is not.
    const isCall = /^getBy[A-Z]/.test(suggestion) || suggestion.startsWith('locator(');
    const leaf = isCall ? suggestion : `locator(${quoteLiteral(suggestion)})`;
    const prefix = frames.map((frame) => `frameLocator(${quoteLiteral(frame)})`).join('.');

    return `${prefix}.${leaf}`;
  }

  /**
   * Builds a `page.getBy*()` locator from its source expression.
   *
   * @param method - Which `getBy*` helper the expression names.
   * @param expression - The full expression, e.g. `getByRole('button', { name: 'OK' })`.
   * @param root - Page or frame to build against.
   * @returns The locator, or `null` when the arguments could not be read.
   */
  private buildGetByLocator(method: GetByMethod, expression: string, root: LocatorRoot): Locator | null {
    const inner = this.extractCallArguments(expression, method);
    if (inner === null) {
      this.log.debug(`Unbalanced parentheses in "${expression}".`);
      return null;
    }

    const args = this.splitTopLevel(inner);
    const first = args[0] === undefined ? undefined : this.parseStringLiteral(args[0]);
    if (first === null || first === undefined) {
      this.log.debug(`Could not read the first argument of "${expression}".`);
      return null;
    }

    const options = args[1] ? this.parseOptions(args[1]) : {};

    switch (method) {
      case 'getByRole':
        // The role union is wide and open-ended; the cast avoids duplicating
        // Playwright's role list here. An invalid role simply matches nothing,
        // which validateDetailed reports as a miss.
        return root.getByRole(first as Parameters<Page['getByRole']>[0], {
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.exact !== undefined ? { exact: options.exact } : {}),
          ...(options.level !== undefined ? { level: options.level } : {}),
        });
      case 'getByTestId':
        return root.getByTestId(first);
      case 'getByLabel':
      case 'getByText':
      case 'getByPlaceholder':
      case 'getByTitle':
      case 'getByAltText':
        return root[method](first, options.exact !== undefined ? { exact: options.exact } : {});
    }
  }

  /**
   * Returns the argument list inside `method(...)`, respecting nesting.
   *
   * @param expression - Full call expression.
   * @param method - Method name the expression starts with. Any name, not only a
   * `getBy*` one — `locator(` and `frameLocator(` go through here too.
   * @returns The text between the outer parentheses, or `null` if unbalanced.
   */
  private extractCallArguments(expression: string, method: string): string | null {
    const start = method.length; // index of '('
    let depth = 0;
    let inQuote: string | null = null;
    let escaped = false;

    for (let i = start; i < expression.length; i++) {
      const char = expression[i];

      if (inQuote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === inQuote) inQuote = null;
        continue;
      }

      if (char === '"' || char === "'" || char === '`') inQuote = char;
      else if (char === '(') depth++;
      else if (char === ')') {
        depth--;
        if (depth === 0) return expression.slice(start + 1, i);
      }
    }

    return null;
  }

  /**
   * Splits an argument list on top-level commas, ignoring commas inside quotes,
   * braces, brackets, or nested calls.
   *
   * @param args - Text between the call's parentheses.
   * @returns One trimmed string per argument.
   */
  private splitTopLevel(args: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    let inQuote: string | null = null;
    let escaped = false;

    for (const char of args) {
      if (inQuote) {
        current += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === inQuote) inQuote = null;
        continue;
      }

      if (char === '"' || char === "'" || char === '`') {
        inQuote = char;
        current += char;
      } else if (char === '(' || char === '{' || char === '[') {
        depth++;
        current += char;
      } else if (char === ')' || char === '}' || char === ']') {
        depth--;
        current += char;
      } else if (char === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  /**
   * Reads a quoted string literal, unescaping the quote character.
   *
   * @param literal - Source text of the argument.
   * @returns The string value, or `null` if it was not a quoted literal.
   */
  private parseStringLiteral(literal: string): string | null {
    const trimmed = literal.trim();
    if (trimmed.length < 2) return null;

    const quote = trimmed[0];
    if (quote !== '"' && quote !== "'" && quote !== '`') return null;
    if (trimmed[trimmed.length - 1] !== quote) return null;

    return trimmed.slice(1, -1).replace(/\\(["'`\\])/g, '$1');
  }

  /**
   * Extracts the `name`, `exact`, and `level` options from an options object
   * literal. Regex is sufficient here — these values are always primitives, and
   * anything unrecognised is ignored rather than guessed at.
   *
   * @param source - Source text of the options argument.
   * @returns The options we know how to forward.
   */
  private parseOptions(source: string): GetByOptions {
    const options: GetByOptions = {};

    const name = /\bname\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(source);
    if (name?.[2] !== undefined) {
      options.name = name[2].replace(/\\(["'`\\])/g, '$1');
    } else {
      // Models also write `{ name: /Submit/i }`. Dropping the regex would leave a
      // bare `getByRole('button')` that matches every button on the page, so it is
      // reconstructed instead.
      const pattern = /\bname\s*:\s*\/((?:\\.|[^/\\])+)\/([gimsuy]*)/.exec(source);
      if (pattern?.[1] !== undefined) {
        try {
          options.name = new RegExp(pattern[1], pattern[2] ?? '');
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.log.debug(`Ignoring an invalid regex name /${pattern[1]}/: ${detail}`);
        }
      }
    }

    const exact = /\bexact\s*:\s*(true|false)/.exec(source);
    if (exact?.[1] !== undefined) options.exact = exact[1] === 'true';

    const level = /\blevel\s*:\s*(\d+)/.exec(source);
    if (level?.[1] !== undefined) options.level = Number(level[1]);

    return options;
  }

  /**
   * Removes every trailing positional refinement, not just the last one.
   *
   * `getByRole('row').nth(2).first()` is legal Playwright, and `TestWrapper` produces it
   * whenever a refined locator is refined again — so peeling one and calling the rest
   * unsupported would reject expressions this package generates itself.
   *
   * @param expression - Expression to inspect.
   * @returns The refinements in application order, and what is left.
   */
  private stripRefinements(expression: string): { refinements: Refinement[]; remainder: string } {
    const refinements: Refinement[] = [];
    let remainder = expression;

    for (;;) {
      const found = this.extractRefinement(remainder);
      if (!found) break;
      // Peeled right-to-left, so unshift restores source order.
      refinements.unshift(found.value);
      remainder = found.remainder;
    }

    return { refinements, remainder };
  }

  /**
   * Detects and removes a trailing `.first()`, `.last()`, or `.nth(n)`.
   *
   * @param expression - Expression to inspect.
   * @returns The refinement plus the expression without it, or `null` if absent.
   */
  private extractRefinement(
    expression: string
  ): { value: Refinement; remainder: string } | null {
    const match = /\.(first|last|nth)\(\s*(\d+)?\s*\)\s*$/.exec(expression);
    if (!match) return null;

    const kind = match[1] as Refinement['kind'];
    const remainder = expression.slice(0, match.index).trim();

    return {
      value: kind === 'nth' ? { kind, index: Number(match[2] ?? 0) } : { kind },
      remainder,
    };
  }

  /**
   * Applies a positional refinement to a locator.
   *
   * @param locator - Locator to refine.
   * @param refinement - Which refinement to apply.
   * @returns The refined locator.
   */
  private applyRefinement(locator: Locator, refinement: Refinement): Locator {
    if (refinement.kind === 'first') return locator.first();
    if (refinement.kind === 'last') return locator.last();
    return locator.nth(refinement.index ?? 0);
  }
}
