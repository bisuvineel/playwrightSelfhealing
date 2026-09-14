/**
 * Extracts a textual description of a page for the AI to reason about.
 *
 * This is the evidence a healing prompt is built on: if the target element is not
 * described here, no model can find it. Two strategies, in order of preference:
 *
 * 1. **Playwright's accessibility snapshot** ({@link getAriaSnapshot}) — the role
 *    and accessible-name tree, which is exactly what the prompts ask the model to
 *    match on (`getByRole`, `getByLabel`). It is produced by the browser, costs one
 *    call, and omits layout noise entirely.
 * 2. **A DOM scan** ({@link getDomSnapshot}) — a fallback for when the snapshot API
 *    is unavailable or throws mid-navigation. It reads the attributes that make good
 *    selectors (`id`, `role`, `aria-label`, `name`, `type`, `data-testid`) plus the
 *    element's visible text.
 *
 * @module utils/DOMSnapshot
 */

import type { Page } from '@playwright/test';

import { createLogger } from '../utils/logger';

const log = createLogger('heal:snapshot');

/**
 * Elements worth describing.
 *
 * Document order is a poor filter — the first 100 nodes of a real page are `html`,
 * `head`, `meta`, `script`, and layout `div`s, while the button that broke sits at
 * index 400. Selecting by *kind* keeps the scan cheap and, more importantly, keeps
 * the elements a test might actually target.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[role]',
  '[aria-label]',
  '[aria-labelledby]',
  '[data-testid]',
  '[data-test-id]',
  '[contenteditable="true"]',
  'h1, h2, h3, h4, h5, h6',
].join(', ');

/** Attributes captured per element, in the order they are rendered. */
const CAPTURED_ATTRIBUTES = [
  'id',
  'role',
  'aria-label',
  'name',
  'type',
  'placeholder',
  'data-testid',
  'href',
] as const;

/**
 * Default cap on described elements.
 *
 * Generous enough for a real application page (a dense form plus navigation runs
 * 60-120 interactive elements) while bounding the serialisation cost and the token
 * bill. Hitting the cap is logged, never silent.
 */
const DEFAULT_ELEMENT_LIMIT = 150;

/** Characters of text kept per element. Enough to identify it, not to quote it. */
const TEXT_LIMIT = 50;

/** Default character ceiling used by {@link truncateSnapshot}. */
const DEFAULT_MAX_CHARS = 2_000;

/** Size past which a snapshot is worth warning about. */
const LARGE_SNAPSHOT_CHARS = 40_000;

/** Options for the DOM scan. */
export interface DomSnapshotOptions {
  /** Maximum number of elements to describe. Defaults to 150. */
  limit?: number;
  /** How long to wait for the page to be queryable, in milliseconds. */
  timeoutMs?: number;
  /**
   * CSS selector for the subtree to describe. Defaults to the whole document.
   *
   * Honoured by **both** capture strategies. That matters: this is a privacy control
   * as well as a cost one, so a scoped capture must never silently widen to the full
   * page because the preferred strategy failed. When the selector does not resolve,
   * the scan returns nothing rather than falling back to the document.
   */
  root?: string;
  /**
   * Frame selectors to descend through before capturing, outermost first.
   *
   * A page-level accessibility snapshot shows an `<iframe>` as a bare leaf — the content
   * inside it is not there at all. So healing a locator inside a frame needs the frame's
   * own snapshot, or the model is asked to find an element it cannot see.
   */
  frames?: string[];
}

/**
 * Options for {@link getAriaSnapshot}.
 *
 * Identical to {@link DomSnapshotOptions} — `root` applies to the accessibility
 * snapshot and to the DOM-scan fallback alike.
 */
export interface AriaSnapshotOptions extends DomSnapshotOptions {}

/**
 * Captures the page's accessibility tree as text, falling back to a DOM scan.
 *
 * The returned text is what the healing prompt embeds verbatim, so it is never
 * silently shortened here — a snapshot cut off before the target element produces a
 * confidently wrong selector, which is worse than an expensive call. Callers that
 * need a hard ceiling can apply {@link truncateSnapshot} explicitly.
 *
 * @param page - Page to describe.
 * @param options - Optional root selector, timeout, and element limit for the fallback.
 * @returns The snapshot text, or an empty string if the page could not be read.
 */
export async function getAriaSnapshot(page: Page, options: AriaSnapshotOptions = {}): Promise<string> {
  const root = options.root ?? 'body';
  const frames = options.frames ?? [];

  try {
    // Descend into any frames first. Playwright resolves these natively, so this works
    // across origins where a `page.evaluate` reaching into `contentDocument` would not.
    let scope: Pick<Page, 'locator'> = page;
    for (const frame of frames) {
      scope = (scope as Page).frameLocator(frame) as unknown as Pick<Page, 'locator'>;
    }

    const snapshot = await scope
      .locator(root)
      .first()
      .ariaSnapshot(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {});

    if (snapshot && snapshot.trim()) {
      if (snapshot.length > LARGE_SNAPSHOT_CHARS) {
        log.warn(
          `Accessibility snapshot is ${snapshot.length} characters. Sending it in full, but ` +
            'consider passing a narrower `root` to cut token cost.'
        );
      }
      return snapshot;
    }

    log.debug('ariaSnapshot() returned nothing — falling back to a DOM scan.');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.debug(`ariaSnapshot() failed (${detail}) — falling back to a DOM scan.`);
  }

  // The DOM scan runs `page.evaluate` in the main frame, so it cannot see inside an
  // iframe — and falling back to it here would hand the model the *parent page's*
  // content while asking about an element in the frame. That produces a confidently
  // wrong suggestion, and on a payment or identity frame it would also transmit the
  // wrong document. Same failure shape as a snapshot root that does not resolve: a
  // narrowed capture must never widen when the preferred strategy fails.
  if (frames.length > 0) {
    log.error(
      `Could not capture the content of frame "${frames.join(' > ')}". Returning an empty ` +
        'snapshot rather than the parent page, which is not what was asked about.'
    );
    return '';
  }

  return getDomSnapshot(page, options);
}

/**
 * Describes the page by scanning the DOM for elements a test might target.
 *
 * One line per element: the tag, the attributes that make usable selectors, and up
 * to 50 characters of its own visible text. Container text is read from direct child
 * text nodes only, so a wrapper `div` does not repeat the text of everything inside it.
 *
 * `options.root` scopes the scan. **A configured root is never exceeded**: if it does
 * not resolve, this returns an empty string rather than describing the whole document.
 * The alternative would make a scoped capture widen to the full page precisely when
 * something had gone wrong — and this strategy reads `element.value`, so "the whole
 * page" here means every value the user has typed.
 *
 * @param page - Page to describe.
 * @param options - Root selector, element limit and timeout.
 * @returns One line per element, or an empty string if the page could not be read or
 * the configured root did not resolve.
 */
export async function getDomSnapshot(page: Page, options: DomSnapshotOptions = {}): Promise<string> {
  const limit = options.limit ?? DEFAULT_ELEMENT_LIMIT;
  const root = options.root;

  try {
    const result = await page.evaluate(
      ({ selector, attributes, elementLimit, textLimit, rootSelector }) => {
        // A root that does not resolve is reported, never substituted. Falling back to
        // `document` would turn a narrowing option into a widening one.
        const container = rootSelector ? document.querySelector(rootSelector) : document;
        if (!container) return { lines: [], total: 0, rootResolved: false };

        const candidates = Array.from(container.querySelectorAll(selector));
        const lines: string[] = [];

        for (const el of candidates.slice(0, elementLimit)) {
          const tag = el.tagName.toLowerCase();

          const rendered: string[] = [];
          for (const attribute of attributes) {
            const value = el.getAttribute(attribute);
            if (value) rendered.push(`${attribute}="${value}"`);
          }

          // Leaf elements (button, a, label) carry their own text. For containers,
          // read only direct text nodes so the line describes this element rather
          // than every descendant's contents.
          const ownText = el.children.length === 0
            ? el.textContent ?? ''
            : Array.from(el.childNodes)
                .filter((node) => node.nodeType === 3)
                .map((node) => node.textContent ?? '')
                .join(' ');

          // `value` is a property, not an attribute, so it needs a separate read.
          const value = (el as HTMLInputElement).value;
          const text = (ownText || value || '').replace(/\s+/g, ' ').trim().slice(0, textLimit);

          const open = rendered.length ? `<${tag} ${rendered.join(' ')}>` : `<${tag}>`;
          lines.push(text ? `${open} ${text}` : open);
        }

        return { lines, total: candidates.length, rootResolved: true };
      },
      {
        selector: INTERACTIVE_SELECTOR,
        attributes: CAPTURED_ATTRIBUTES as unknown as string[],
        elementLimit: limit,
        textLimit: TEXT_LIMIT,
        rootSelector: root ?? null,
      }
    );

    if (!result.rootResolved) {
      log.error(
        `Snapshot root "${root}" did not resolve, so nothing was captured. The scan does ` +
          'not fall back to the whole document, because that would widen a capture that ' +
          'was deliberately narrowed.'
      );
      return '';
    }

    if (result.total > limit) {
      // Never silent: a caller seeing a partial page should know it is partial.
      log.warn(
        `Page has ${result.total} candidate elements; describing the first ${limit}. ` +
          'Raise `limit` if the target element is missing from the snapshot.'
      );
    }

    log.debug(`DOM scan described ${result.lines.length} element(s).`);
    return result.lines.join('\n');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error(`Could not read the page (${detail}) — returning an empty snapshot.`);
    return '';
  }
}

/**
 * Caps a snapshot at a character budget.
 *
 * Cuts on a line boundary so the last entry is not a half-written element, and
 * appends a marker so the model (and anyone reading a log) knows content is missing.
 * Truncation is logged, because a snapshot that no longer contains the target
 * element is the likeliest cause of a confidently wrong suggestion.
 *
 * @param snapshot - Snapshot text.
 * @param maxChars - Character budget. Defaults to 2000.
 * @returns The snapshot, shortened only if it exceeded the budget.
 */
export function truncateSnapshot(snapshot: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  if (snapshot.length <= maxChars) {
    return snapshot;
  }

  const marker = '\n... (truncated)';
  const budget = Math.max(0, maxChars - marker.length);
  const head = snapshot.slice(0, budget);

  // Prefer the last complete line, unless that would discard most of the budget.
  const lastNewline = head.lastIndexOf('\n');
  const body = lastNewline > budget * 0.5 ? head.slice(0, lastNewline) : head;

  log.warn(
    `Snapshot truncated from ${snapshot.length} to ${body.length} characters — ` +
      'the target element may have been cut off.'
  );

  return body + marker;
}
