/**
 * Unit tests for the prompts.
 *
 * The prompt and the parser are coupled: `PromptBuilder` tells the model which JSON keys
 * to produce, and `AiProvider.parseResponse` reads exactly those keys. ARCHITECTURE.md
 * calls that coupling load-bearing, and nothing enforced it — a rename on one side would
 * have broken every heal silently, with the model answering in good faith and the parser
 * finding nothing.
 *
 * The first test closes that: it feeds the prompt's own worked example through the real
 * parser. If either side drifts, it fails.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { PromptBuilder } = require('../../dist/utils/PromptBuilder');
const { AiProvider } = require('../../dist/core/AiProvider');

/** Exposes the protected parser, the same way a custom provider would. */
class Probe extends AiProvider {
  async heal() {
    throw new Error('not used');
  }
  async validateConfig() {
    return true;
  }
  parse(text) {
    return this.parseResponse(text);
  }
}

/** Silences the logger, which warns on the deliberately-degenerate inputs below. */
function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * Extracts the prompt's worked JSON example.
 *
 * Anchored on the instruction that introduces it rather than on the last `{`, which lands
 * inside `{ name: 'Submit' }` within the selector string. `parseResponse` then finds the
 * object itself, which is what it is built to do.
 *
 * @param {string} prompt - A rendered prompt.
 * @returns {string} Everything from the response instruction onward.
 */
function workedExample(prompt) {
  const marker = 'Respond ONLY in JSON format:';
  const at = prompt.indexOf(marker);
  assert.notEqual(at, -1, 'the prompt no longer introduces its JSON example');
  return prompt.slice(at + marker.length);
}

/** A representative healing request. */
function request(overrides = {}) {
  return {
    originalSelector: '#place-order-btn',
    originalAction: 'click',
    ariaSnapshot: '- button "Place order"\n- button "Cancel"',
    pageUrl: 'https://shop.test/checkout',
    testFile: 'tests/checkout.spec.ts',
    testLine: 42,
    description: 'the button that submits the order',
    error: 'locator.click: Timeout 5000ms exceeded',
    ...overrides,
  };
}

describe('the prompt and the parser must agree', () => {
  it('the worked example in the prompt parses cleanly through the real parser', () => {
    // The load-bearing coupling. Whatever the example shows is what models copy, so if
    // the example and the parser disagree, every heal fails while looking well-formed.
    const example = workedExample(PromptBuilder.buildUserPrompt(request()));
    const parsed = quiet(() => new Probe('k', 'm').parse(example));

    assert.ok(parsed.suggestedSelector, 'the example produced no selector');
    assert.equal(typeof parsed.confidence, 'number');
    assert.ok(parsed.confidence > 0, 'the example must not parse to confidence 0');
    assert.ok(parsed.reasoning);
    assert.equal(parsed.expectedRole, 'button');
    assert.equal(parsed.expectedName, 'Submit');
  });

  it('the vision prompt asks for the same shape', () => {
    const example = workedExample(PromptBuilder.buildVisionPrompt(request(), 'aGVsbG8='));
    const parsed = quiet(() => new Probe('k', 'm').parse(example));

    assert.ok(parsed.suggestedSelector);
    assert.equal(parsed.expectedRole, 'button');
  });

  it('the system prompt names every key the parser reads', () => {
    const system = PromptBuilder.buildSystemPrompt();
    for (const key of ['suggestedSelector', 'confidence', 'reasoning', 'expectedRole', 'expectedName']) {
      // expectedRole/expectedName are named in the guidance rather than a JSON block, so
      // a plain substring check is the right assertion for all five.
      assert.ok(
        system.includes(key) || PromptBuilder.buildUserPrompt(request()).includes(key),
        `neither prompt mentions ${key}`
      );
    }
  });
});

describe('the system prompt keeps its load-bearing instructions', () => {
  const system = PromptBuilder.buildSystemPrompt();

  it('demands JSON only', () => {
    assert.match(system, /respond ONLY with valid JSON/i);
    assert.match(system, /no code fences/i);
  });

  it('demands exactly one match', () => {
    // Ambiguity is rejected by the validator, so asking for it wastes a call.
    assert.match(system, /EXACTLY ONE element/);
  });

  it('warns that name matching is substring by default', () => {
    // Measured Playwright behaviour: { name: 'Submit' } also matches "Submit report".
    assert.match(system, /substring/i);
    assert.match(system, /exact: true/);
  });

  it('constrains the element to one the action can act on', () => {
    // Mirrors the intent verifier's action-compatibility check.
    assert.match(system, /must support the action/i);
  });

  it('tells the model intent matters more than something clickable nearby', () => {
    assert.match(system, /INTENT/);
    assert.match(system, /Cancel/);
  });

  it('explains the frame case', () => {
    assert.match(system, /frameLocator/);
  });

  it('is byte-stable across calls, so it can form a cacheable prefix', () => {
    assert.equal(PromptBuilder.buildSystemPrompt(), system);
  });
});

describe('the user prompt carries the failure context', () => {
  it('includes everything the model needs to identify the element', () => {
    const prompt = PromptBuilder.buildUserPrompt(request());

    assert.match(prompt, /#place-order-btn/);
    assert.match(prompt, /Action: click/);
    assert.match(prompt, /the button that submits the order/);
    assert.match(prompt, /https:\/\/shop\.test\/checkout/);
    assert.match(prompt, /tests\/checkout\.spec\.ts:42/);
    assert.match(prompt, /Timeout 5000ms exceeded/);
    assert.match(prompt, /- button "Place order"/);
  });

  it('fills in the optional fields rather than leaving a dangling line', () => {
    const prompt = PromptBuilder.buildUserPrompt(
      request({ description: undefined, error: undefined })
    );

    assert.match(prompt, /Element description: No description provided/);
    assert.match(prompt, /Error: Element not found/);
  });

  it('puts the snapshot last, so the text before it stays cacheable', () => {
    const prompt = PromptBuilder.buildUserPrompt(request());
    assert.ok(prompt.indexOf('Page URL:') < prompt.indexOf('- button "Place order"'));
  });
});

describe('the user prompt handles awkward snapshots', () => {
  it('says so explicitly when the page could not be read', () => {
    // Silence would let the model invent an element. It is told to return confidence 0.
    const prompt = quiet(() => PromptBuilder.buildUserPrompt(request({ ariaSnapshot: '' })));

    assert.match(prompt, /could not be captured/);
    assert.match(prompt, /confidence 0/);
  });

  it('switches the delimiter when the snapshot contains a code fence', () => {
    // A triple backtick in page content would close the fence early and turn the rest of
    // the prompt into prose.
    const prompt = PromptBuilder.buildUserPrompt(
      request({ ariaSnapshot: '- text: here is ``` a fence' })
    );

    assert.match(prompt, /--- SNAPSHOT ---/);
    assert.ok(!prompt.includes('```\n- text: here is'));
  });

  it('never truncates the snapshot', () => {
    // A snapshot cut off before the target element produces a confidently wrong
    // selector, which is worse than an expensive call.
    const big = Array.from({ length: 2000 }, (_, i) => `- button "b${i}"`).join('\n');
    const prompt = quiet(() => PromptBuilder.buildUserPrompt(request({ ariaSnapshot: big })));

    assert.ok(prompt.includes('- button "b1999"'), 'the last element was dropped');
  });
});

describe('the vision prompt', () => {
  it('warns when no image was supplied', () => {
    // Otherwise the model is told to look at an image that never arrives.
    let warned = false;
    const saved = console.warn;
    console.warn = (line) => {
      if (String(line).includes('no image data')) warned = true;
    };
    try {
      PromptBuilder.buildVisionPrompt(request(), '');
    } finally {
      console.warn = saved;
    }
    assert.ok(warned);
  });

  it('warns when handed a data URL instead of bare base64', () => {
    let warned = false;
    const saved = console.warn;
    console.warn = (line) => {
      if (String(line).includes('data URL')) warned = true;
    };
    try {
      PromptBuilder.buildVisionPrompt(request(), 'data:image/png;base64,aGk=');
    } finally {
      console.warn = saved;
    }
    assert.ok(warned);
  });

  it('includes the snapshot as well as referring to the image', () => {
    // Pixels show which element is meant; only the snapshot carries roles and names.
    const prompt = PromptBuilder.buildVisionPrompt(request(), 'aGk=');
    assert.match(prompt, /screenshot/);
    assert.match(prompt, /- button "Place order"/);
  });

  it('does not embed the base64 payload in the text', () => {
    // It would be treated as characters — expensive, and invisible to the model.
    const image = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';
    assert.ok(!PromptBuilder.buildVisionPrompt(request(), image).includes(image));
  });
});
