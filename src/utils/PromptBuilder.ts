/**
 * Builds the prompts sent to every AI provider.
 *
 * Prompts live here, in one place, for two reasons. Providers must ask the *same*
 * question in the *same* output format — otherwise a healing record's confidence
 * means something different depending on which model answered. And the response
 * contract is load-bearing: `AiProvider.parseResponse` reads a fixed set of keys from
 * the JSON, so the instructions that produce those keys belong next to nothing else.
 *
 * `expectedRole` and `expectedName` exist so the model's claim can be measured against
 * the live DOM — see `core/IntentVerifier`. They are optional in the parser, so a model
 * that ignores the instruction still heals; it simply loses one of the checks.
 *
 * A note on the worked example in {@link PromptBuilder.buildUserPrompt}: it uses a
 * quoted string for the accessible name (`{ name: 'Submit' }`) rather than a regex.
 * Whatever the example shows is what models copy, and a string name round-trips
 * exactly through `SelectorValidator`, so the example is deliberately the form the
 * framework validates most reliably.
 *
 * @module utils/PromptBuilder
 */

import type { HealingRequest } from '../types';
import { createLogger } from './logger';

const log = createLogger('heal:prompt');

/** Snapshot size worth warning about — large snapshots are slow and costly. */
const LARGE_SNAPSHOT_CHARS = 40_000;

/** Fallback text for optional request fields, so no line is ever left dangling. */
const NO_DESCRIPTION = 'No description provided';
const NO_ERROR = 'Element not found';

/**
 * Static prompt factory. Nothing here holds state, so every method is `static`.
 */
export class PromptBuilder {
  /**
   * The system prompt: role, selector preferences, and the response contract.
   *
   * Kept byte-stable across calls. It is the first thing rendered in a request, so
   * a constant string forms a cacheable prefix on providers that support prompt
   * caching — interpolating anything dynamic here would invalidate that cache on
   * every heal.
   *
   * @returns The system prompt text.
   */
  static buildSystemPrompt(): string {
    return `You are an expert Playwright test automation engineer.

Your task: when a selector in an existing test fails to find an element, analyse the page structure and suggest a better selector for the element the test intended to use.

Guidelines:
1. Prefer semantic Playwright locators, most durable first: getByRole, getByLabel, getByPlaceholder, getByText, getByTestId.
2. If you must use CSS, target stable semantic attributes (for example [name="email"]). Make it specific but not brittle.
3. Never use index-based or structural selectors: nth-child, absolute XPath, deeply nested paths, or auto-generated class hashes. They break on the next UI change.
4. Use ARIA roles and accessible names — they describe intent and survive restyling.
5. Return a selector that matches EXACTLY ONE element. If several elements share a role, disambiguate with the accessible name. Note that a name matches as a substring by default, so getByRole('button', { name: 'Submit' }) also matches a button named "Submit report" — add { exact: true } when one name is a prefix of another.
6. The element must support the action. A fill goes to a textbox, a check goes to a checkbox or radio, a selectOption goes to a select. Never answer with an element that cannot perform the stated action.
7. Match the INTENT of the original selector, not merely something clickable nearby. If the original selector or description is about placing an order, do not answer with Cancel because it happens to be a unique button. A wrong element that works is worse than no answer.
8. Confidence must reflect how sure you are, from 0 to 1: above 0.9 only when both role and accessible name match the original intent, below 0.5 when inferring from weak evidence.
9. If no element on the page plausibly matches, return confidence 0 rather than guessing.
10. If the original selector begins with frameLocator(...), the page structure below is the content of that iframe, not the parent page. Answer with a selector for an element in that structure; keeping or omitting the frameLocator(...) prefix are both accepted.
11. Report expectedRole and expectedName: the ARIA role and accessible name of the element your selector targets. These are checked against the live page, so a selector that resolves to something other than what you describe here is discarded.
12. Be concise in your reasoning — one or two sentences.

IMPORTANT: respond ONLY with valid JSON. No prose before or after it, and no code fences.`;
  }

  /**
   * The user prompt: everything known about this specific failure.
   *
   * Field order matters. The stable instructions sit in the system prompt, the
   * short volatile facts come next, and the page snapshot goes last because it is
   * the largest and most variable part — keeping it at the end leaves the preceding
   * text cacheable.
   *
   * @param request - Context describing the failed action.
   * @returns The user prompt text.
   */
  static buildUserPrompt(request: HealingRequest): string {
    const snapshot = PromptBuilder.prepareSnapshot(request.ariaSnapshot);

    return `A test selector failed to find an element.

Original selector: ${request.originalSelector}
Action: ${request.originalAction}
Element description: ${request.description || NO_DESCRIPTION}
Page URL: ${request.pageUrl}
Test location: ${request.testFile}:${request.testLine}
Error: ${request.error || NO_ERROR}

Current page structure (ARIA/DOM snapshot):
${snapshot.fence}
${snapshot.text}
${snapshot.fence}

Find the element that should have been matched and provide a NEW Playwright locator.

Respond ONLY in JSON format:
{
  "suggestedSelector": "getByRole('button', { name: 'Submit' })",
  "expectedRole": "button",
  "expectedName": "Submit",
  "confidence": 0.95,
  "reasoning": "Clear, brief explanation of why this is the right element"
}`;
  }

  /**
   * The vision prompt, for providers that accept a screenshot.
   *
   * The image itself is **not** embedded in this text. Every vision-capable API
   * takes an image as its own content block alongside the text (see
   * `HealingRequest.screenshot`), and base64 inlined into a prompt string is simply
   * treated as characters — expensive, and invisible to the model as an image.
   * `imageBase64` is accepted here so this method can verify the caller actually
   * has an image before promising the model one.
   *
   * The accessibility snapshot is included as well as the screenshot: pixels show
   * which element is meant, but only the snapshot carries the roles, names, and test
   * ids that a selector is built from.
   *
   * @param request - Context describing the failed action.
   * @param imageBase64 - Base64 PNG the caller will attach as a separate block.
   * @returns The vision prompt text.
   */
  static buildVisionPrompt(request: HealingRequest, imageBase64: string): string {
    if (!imageBase64 || imageBase64.trim() === '') {
      // Not fatal — the text below still works — but the model will be told to
      // look at an image that never arrives, so this is worth flagging loudly.
      log.warn(
        'buildVisionPrompt() was given no image data. Attach a screenshot as a ' +
          'separate content block, or use buildUserPrompt() instead.'
      );
    } else if (imageBase64.startsWith('data:')) {
      log.warn(
        'Image data looks like a data URL. Most APIs expect the bare base64 payload — ' +
          'strip the "data:image/png;base64," prefix before attaching it.'
      );
    }

    const snapshot = PromptBuilder.prepareSnapshot(request.ariaSnapshot);

    return `A test selector failed to find an element on this page. A screenshot of the page is attached as a separate image.

Original selector: ${request.originalSelector}
Action: ${request.originalAction}
Element description: ${request.description || NO_DESCRIPTION}
Page URL: ${request.pageUrl}
Error: ${request.error || NO_ERROR}

Use the screenshot to identify WHICH element the test meant, then use the snapshot below to name it precisely — roles, accessible names, and test ids come from the snapshot, not from the image.

Current page structure (ARIA/DOM snapshot):
${snapshot.fence}
${snapshot.text}
${snapshot.fence}

Find the element and suggest a NEW Playwright locator that would locate it.

Respond ONLY in JSON format:
{
  "suggestedSelector": "getByRole('button', { name: 'Submit' })",
  "expectedRole": "button",
  "expectedName": "Submit",
  "confidence": 0.95,
  "reasoning": "Clear, brief explanation of why this is the right element"
}`;
  }

  /**
   * Prepares the snapshot for embedding and picks a delimiter that survives it.
   *
   * A snapshot containing a triple backtick would close the fence early and turn
   * the rest of the prompt into prose, so a different delimiter is chosen in that
   * case. An empty snapshot is called out explicitly — it means the page could not
   * be read, and the model needs to know that rather than infer it from silence.
   *
   * @param snapshot - Raw snapshot text.
   * @returns The text to embed and the fence to wrap it in.
   */
  private static prepareSnapshot(snapshot: string): { text: string; fence: string } {
    const text = (snapshot ?? '').trim();

    if (!text) {
      log.warn('Building a prompt with an empty page snapshot — healing is unlikely to succeed.');
      return {
        text: '(The page structure could not be captured. Say so in your reasoning and return confidence 0.)',
        fence: '```',
      };
    }

    if (text.length > LARGE_SNAPSHOT_CHARS) {
      log.warn(
        `Page snapshot is ${text.length} characters; this will be a costly request. ` +
          'Consider scoping the snapshot to a container element.'
      );
    }

    // Only switch delimiters when the default would break.
    return { text, fence: text.includes('```') ? '--- SNAPSHOT ---' : '```' };
  }
}
