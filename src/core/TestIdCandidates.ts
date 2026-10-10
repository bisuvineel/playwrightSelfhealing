/**
 * Offers nameless interactive elements as candidates, by their test id.
 *
 * ## Why this exists
 *
 * `CandidateFinder` builds candidates from the accessibility snapshot, and only from
 * nodes the snapshot shows holding a name — that is what makes its locators sound. An
 * icon-only button has no name, so it is never offered, and an accessibility snapshot
 * never carries test ids, so the model cannot see the one handle the element does have:
 *
 * ```html
 * <button data-testid="close"><svg aria-hidden="true">…</svg></button>
 * ```
 * ```
 * - button                       ← all the model is shown
 * ```
 *
 * Measured on the corpus: healing `#close-x` onto that button, the model could only guess
 * `getByTestId('close')`, and across nine real-model runs it guessed well enough to pass
 * about half the time. Close, delete, overflow ⋮ and settings ⚙ icons are this shape
 * throughout real applications.
 *
 * So this reads the page once, finds the elements an accessibility snapshot cannot
 * describe but a test id can, and offers them in the same numbered list:
 *
 * ```
 *   6. button (no accessible name) — test id "close"
 * ```
 *
 * ## What is offered, and what is not
 *
 * An element is offered only when all of these hold: it carries a test id, it is
 * interactive, it is visible, it has **no accessible name**, and its test id is
 * **unique** within the capture scope. Named elements are left to `CandidateFinder`,
 * whose role-and-name locators are the better handle. A test id shared by several
 * elements is never offered: a locator matching three things is no locator.
 *
 * The locator is written here, as a CSS attribute selector — `[data-testid="close"]` —
 * rather than `getByTestId('close')`, because a project can change Playwright's
 * `testIdAttribute`, and `getByTestId` would then look at a different attribute from the
 * one this module read. Uniqueness is counted in the browser against that exact string.
 *
 * ## Privacy
 *
 * A test id is page content that was never transmitted before this module existed, so
 * `PrivacyGuard` treats it as a name: built-in patterns under `identifiers`, the custom
 * redactor if one is configured, and omitted altogether under `strict`. The locator, as
 * for every candidate, never leaves this machine — which is why a `strict` heal still
 * works: the model picks the id, and the id resolves locally to the real test id.
 *
 * A configured snapshot root bounds this read exactly as it bounds the snapshot. If the
 * root cannot be queried as CSS, nothing is read at all rather than the whole document.
 *
 * Never throws. A failure here costs the heal one kind of candidate, never the heal.
 *
 * @module core/TestIdCandidates
 */

import type { Page } from '@playwright/test';
import type { ElementCandidate } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('heal:testid');

/**
 * Attributes read as test ids, in precedence order: Playwright's default first, then the
 * names Cypress, Testing Library variants and QA conventions use.
 */
export const TEST_ID_ATTRIBUTES: readonly string[] = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
];

/**
 * Most test-id candidates offered per heal.
 *
 * A page rarely has more than a handful of nameless controls; one with dozens is a page
 * of icon rows, where a long list costs tokens and helps nobody choose.
 */
const MAX_TEST_ID_CANDIDATES = 20;

/** Longest test id offered. Longer values are generated, not written by a person. */
const MAX_TEST_ID_LENGTH = 100;

/** Bound on the page read, so a hung page costs a moment rather than the heal. */
const READ_TIMEOUT_MS = 2_000;

/** Options for {@link findTestIdCandidates}. */
export interface TestIdCandidateOptions {
  /** Id for the first candidate found, so the list continues the snapshot's numbering. */
  firstId: number;
  /** CSS selector the capture is scoped to, when it is scoped at all. */
  scope?: string;
  /** Override for {@link MAX_TEST_ID_CANDIDATES}. */
  limit?: number;
}

/** What the browser reports for one element. */
interface Found {
  role: string;
  testId: string;
  selector: string;
}

/**
 * Finds nameless, interactive, visible elements with a unique test id.
 *
 * @param page - Live page.
 * @param options - Numbering, scope and cap.
 * @returns Candidates, numbered from `options.firstId`. Empty on any failure.
 */
export async function findTestIdCandidates(
  page: Page,
  options: TestIdCandidateOptions
): Promise<ElementCandidate[]> {
  const limit = options.limit ?? MAX_TEST_ID_CANDIDATES;
  if (limit <= 0) return [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = page.evaluate(collect, {
      attributes: [...TEST_ID_ATTRIBUTES],
      scope: options.scope ?? null,
      max: limit,
      maxLength: MAX_TEST_ID_LENGTH,
    });
    const timeout = new Promise<Found[]>((resolve) => {
      timer = setTimeout(() => resolve([]), READ_TIMEOUT_MS);
    });

    const found = await Promise.race([read, timeout]);

    return found.map((entry, index) => ({
      id: options.firstId + index,
      role: entry.role,
      name: '',
      context: [],
      testId: entry.testId,
      selector: entry.selector,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.debug(`Could not read test ids from the page: ${detail}`);
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs in the browser. Self-contained: Playwright serialises it, so it may not reach
 * anything outside its own body.
 *
 * The accessible-name test is deliberately conservative — anything that *might* give the
 * element a name counts as one. Erring that way only means an element is left to
 * `CandidateFinder`, which offers it if it is named; erring the other way would offer a
 * named element twice, under two handles.
 *
 * @param args - Attributes, scope, cap and length bound.
 * @returns What was found, in document order per attribute.
 */
function collect(args: {
  attributes: string[];
  scope: string | null;
  max: number;
  maxLength: number;
}): Found[] {
  const { attributes, scope, max, maxLength } = args;

  let root: Element | null;
  try {
    root = scope ? document.querySelector(scope) : document.body;
  } catch {
    // Not CSS the browser understands. Reading the whole document instead would exceed
    // the scope the policy asked for, so nothing is read.
    return [];
  }
  if (!root) return [];

  const prefix = scope ? `${scope} ` : '';

  const interactiveRoles = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton',
    'treeitem',
  ]);

  const roleOf = (el: Element): string | null => {
    const explicit = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0] ?? '';
    if (explicit) return interactiveRoles.has(explicit) ? explicit : null;

    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') {
      const select = el as HTMLSelectElement;
      return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'hidden') return null;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return null;
  };

  const text = (value: string | null | undefined): boolean => (value ?? '').trim() !== '';

  const hasName = (el: Element): boolean => {
    if (text(el.getAttribute('aria-label')) || text(el.getAttribute('title'))) return true;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        if (text(document.getElementById(id)?.textContent)) return true;
      }
    }

    const labels = (el as HTMLInputElement).labels;
    if (labels) {
      for (const label of Array.from(labels)) if (text(label.textContent)) return true;
    }

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      // Submit and reset buttons are named by the browser's default label.
      if (type === 'submit' || type === 'reset') return true;
      if (type === 'button') return text(input.value);
      if (type === 'image') return text(input.getAttribute('alt'));
      return text(input.getAttribute('placeholder'));
    }
    if (tag === 'select' || tag === 'textarea') {
      return text(el.getAttribute('placeholder'));
    }

    if (text(el.textContent)) return true;

    for (const inner of Array.from(el.querySelectorAll('[alt], [aria-label], title'))) {
      if (text(inner.getAttribute('alt')) || text(inner.getAttribute('aria-label'))) return true;
      if (inner.tagName.toLowerCase() === 'title' && text(inner.textContent)) return true;
    }
    return false;
  };

  const visible = (el: Element): boolean => {
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const quoted = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  const found: Found[] = [];
  const seen = new Set<Element>();

  for (const attribute of attributes) {
    for (const el of Array.from(root.querySelectorAll(`[${attribute}]`))) {
      if (found.length >= max) return found;
      if (seen.has(el)) continue;
      seen.add(el);

      const testId = el.getAttribute(attribute) ?? '';
      if (!text(testId) || testId.length > maxLength || /[\u0000-\u001f\u007f]/.test(testId)) continue;

      const role = roleOf(el);
      if (role === null || !visible(el) || hasName(el)) continue;

      const selector = `${prefix}[${attribute}=${quoted(testId)}]`;
      let matches: number;
      try {
        matches = document.querySelectorAll(selector).length;
      } catch {
        continue;
      }
      if (matches !== 1) continue;

      found.push({ role, testId, selector });
    }
  }

  return found;
}
