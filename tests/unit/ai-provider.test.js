/**
 * Unit tests for the provider response contract.
 *
 * `AiProvider.parseResponse` is the seam between "whatever the model said" and the rest
 * of the package, and ARCHITECTURE.md makes strong claims about it: that it never throws,
 * that it survives prose and code fences around the JSON, that braces inside `reasoning`
 * do not terminate the object early, and that an unusable confidence becomes **0** so a
 * garbled answer can never clear the threshold. Those claims were untested.
 *
 * `parseResponse` and `sanitizeSelector` are `protected`, so the tests reach them the way
 * a real caller would — by subclassing, which is the documented way to add a provider.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { AiProvider } = require('../../dist/core/AiProvider');

/**
 * Minimal concrete provider, exposing the protected parsing surface.
 *
 * Subclassing is the package's documented extension point, so this is the same door a
 * real custom provider comes through.
 */
class Probe extends AiProvider {
  async heal() {
    throw new Error('not used by these tests');
  }

  async validateConfig() {
    return true;
  }

  parse(text) {
    return this.parseResponse(text);
  }

  clean(selector) {
    return this.sanitizeSelector(selector);
  }
}

/**
 * Runs a function with the console silenced.
 *
 * The parser logs every rejection, which is correct behaviour and would otherwise bury
 * the test output — most of these cases are deliberately malformed.
 *
 * @param {Function} fn - Work to run.
 * @returns {*} Whatever `fn` returned.
 */
function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

const provider = new Probe('test-key', 'test-model');
const parse = (text) => quiet(() => provider.parse(text));
const clean = (selector) => quiet(() => provider.clean(selector));

/** A well-formed answer, as the prompt asks for it. */
const GOOD = JSON.stringify({
  suggestedSelector: "getByRole('button', { name: 'Submit' })",
  expectedRole: 'button',
  expectedName: 'Submit',
  confidence: 0.95,
  reasoning: 'The only button with that accessible name.',
});

describe('parseResponse — the happy path', () => {
  it('reads every field the prompt asks for', () => {
    assert.deepEqual(parse(GOOD), {
      suggestedSelector: "getByRole('button', { name: 'Submit' })",
      confidence: 0.95,
      reasoning: 'The only button with that accessible name.',
      expectedRole: 'button',
      expectedName: 'Submit',
    });
  });

  it('lower-cases the claimed role, since it is compared to a computed one', () => {
    assert.equal(parse(JSON.stringify({ ...JSON.parse(GOOD), expectedRole: 'BUTTON' })).expectedRole, 'button');
  });

  it('works without the self-consistency fields', () => {
    // A model that ignores the instruction, or a custom provider whose prompt never
    // asked, must still heal — it just loses one intent check.
    const result = parse(JSON.stringify({ suggestedSelector: '#x', confidence: 0.8, reasoning: 'y' }));
    assert.equal(result.suggestedSelector, '#x');
    assert.equal(result.expectedRole, undefined);
    assert.equal(result.expectedName, undefined);
  });
});

describe('parseResponse — finding the JSON', () => {
  it('survives prose before and after', () => {
    const text = `Sure! Here is my answer:\n\n${GOOD}\n\nHope that helps.`;
    assert.equal(parse(text).confidence, 0.95);
  });

  it('survives a code fence', () => {
    assert.equal(parse('```json\n' + GOOD + '\n```').confidence, 0.95);
  });

  it('does not stop at a brace inside the reasoning string', () => {
    // The reason for a brace-balancing scanner that tracks string literals rather than a
    // greedy regex. A `}` in prose used to truncate the object.
    const text = JSON.stringify({
      suggestedSelector: '#ok',
      confidence: 0.9,
      reasoning: 'The selector {#ok} is the one that matches } this element.',
    });
    const result = parse(text);
    assert.equal(result.suggestedSelector, '#ok');
    assert.match(result.reasoning, /\{#ok\}/);
  });

  it('does not stop at an escaped quote inside a string', () => {
    const text = '{"suggestedSelector":"[name=\\"email\\"]","confidence":0.9,"reasoning":"quoted \\" here"}';
    assert.equal(parse(text).suggestedSelector, '[name="email"]');
  });

  it('returns nothing usable for a truncated object', () => {
    const result = parse('{"suggestedSelector": "#x", "confidence": 0.9');
    assert.equal(result.suggestedSelector, undefined);
  });

  it('returns nothing usable when there is no JSON at all', () => {
    assert.deepEqual(parse('I could not find a suitable element.'), {});
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['', '   ', null, undefined, 42, '{', '}', '{}', '[]', '{"a":']) {
      assert.doesNotThrow(() => parse(input), `threw on ${JSON.stringify(input)}`);
    }
  });
});

describe('parseResponse — confidence can never be trusted upward', () => {
  it('coerces a numeric string', () => {
    assert.equal(parse('{"suggestedSelector":"#x","confidence":"0.85"}').confidence, 0.85);
  });

  it('clamps above 1 and below 0', () => {
    assert.equal(parse('{"suggestedSelector":"#x","confidence":5}').confidence, 1);
    assert.equal(parse('{"suggestedSelector":"#x","confidence":-2}').confidence, 0);
  });

  it('defaults to 0 when missing', () => {
    // The important direction: a garbled answer must never clear the threshold.
    assert.equal(parse('{"suggestedSelector":"#x"}').confidence, 0);
  });

  it('defaults to 0 for unusable values', () => {
    // `1e999` is legal JSON that parses to Infinity — the case the finite-check exists
    // for. Bare `Infinity` is not legal JSON and fails earlier, covered above.
    for (const value of ['"high"', 'null', 'true', '{}', '"NaN"', '1e999', '-1e999']) {
      const text = `{"suggestedSelector":"#x","confidence":${value}}`;
      assert.equal(parse(text).confidence, 0, `confidence ${value} should be 0`);
    }
  });
});

describe('parseResponse — the selector is the one field it cannot do without', () => {
  it('reports nothing when the selector is missing', () => {
    const result = parse('{"confidence":0.9,"reasoning":"forgot the selector"}');
    assert.equal(result.suggestedSelector, undefined);
    // Confidence is still parsed, so a caller sees 0 rather than undefined.
    assert.equal(result.confidence, 0.9);
  });

  it('rejects a non-string selector', () => {
    for (const value of ['42', 'null', '["#a","#b"]', '{"css":"#a"}']) {
      const result = parse(`{"suggestedSelector":${value},"confidence":0.9}`);
      assert.equal(result.suggestedSelector, undefined, `should reject ${value}`);
    }
  });

  it('rejects a selector that is empty after cleaning', () => {
    assert.equal(parse('{"suggestedSelector":"   ","confidence":0.9}').suggestedSelector, undefined);
  });

  it('substitutes a note when reasoning is missing', () => {
    assert.match(parse('{"suggestedSelector":"#x"}').reasoning, /No reasoning provided/);
  });
});

describe('sanitizeSelector — stripping what models decorate answers with', () => {
  it('leaves a clean selector alone', () => {
    assert.equal(clean("getByRole('button', { name: 'Submit' })"), "getByRole('button', { name: 'Submit' })");
  });

  it('unwraps a code fence', () => {
    assert.equal(clean('```css\n#submit\n```'), '#submit');
    assert.equal(clean('```\n#submit\n```'), '#submit');
  });

  it('drops a trailing semicolon', () => {
    assert.equal(clean("page.getByRole('button');"), "page.getByRole('button')");
  });

  it('collapses newlines and runs of spaces', () => {
    assert.equal(clean('getByRole(\n  "button"\n)'), 'getByRole( "button" )');
  });

  it('preserves internal single spaces, which are significant', () => {
    // A descendant combinator and an accessible name both depend on them.
    assert.equal(clean('.card .title'), '.card .title');
    assert.equal(clean("getByRole('button', { name: 'Place order' })"), "getByRole('button', { name: 'Place order' })");
  });

  it('unwraps outer quotes only when the inner ones are escaped', () => {
    assert.equal(clean('"[name=\\"email\\"]"'), '[name="email"]');
  });

  it('leaves a CSS attribute selector untouched', () => {
    // Starts with `[`, so the quote-unwrapping rule must not fire.
    assert.equal(clean('[name="email"]'), '[name="email"]');
  });

  it('does not unwrap when an inner quote is bare', () => {
    // The outer characters are part of the selector, not packaging.
    assert.equal(clean(`'[name='email']'`), `'[name='email']'`);
  });

  it('returns empty for input that is only packaging', () => {
    assert.equal(clean('```\n\n```'), '');
    assert.equal(clean('   '), '');
  });
});
