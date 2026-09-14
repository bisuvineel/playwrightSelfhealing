/**
 * Unit tests for frame-scoped selector expressions.
 *
 * Everything inside an iframe used to be beyond the healer's reach. Making it reachable
 * needed three things, and two of them are pure string work that can be tested without a
 * browser: splitting a `frameLocator(...)` prefix off an expression, and putting one back
 * on. The third — scoping the page snapshot to the frame — needs a real page and is
 * covered by a live probe.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { SelectorValidator } = require('../../dist/core/SelectorValidator');

const validator = new SelectorValidator();

describe('splitFrameChain — reading the frame path', () => {
  it('splits a single frame off the expression', () => {
    assert.deepEqual(validator.splitFrameChain("frameLocator('#pay').getByRole('button')"), {
      frames: ['#pay'],
      remainder: "getByRole('button')",
    });
  });

  it('accumulates nested frames outermost first', () => {
    // A payment form inside a consent frame. The resolver walks these in order.
    assert.deepEqual(
      validator.splitFrameChain("frameLocator('#outer').frameLocator('#inner').getByLabel('Card')"),
      { frames: ['#outer', '#inner'], remainder: "getByLabel('Card')" }
    );
  });

  it('leaves a page-level expression alone', () => {
    assert.deepEqual(validator.splitFrameChain("getByRole('button', { name: 'Pay' })"), {
      frames: [],
      remainder: "getByRole('button', { name: 'Pay' })",
    });
    assert.deepEqual(validator.splitFrameChain('#checkout-button'), {
      frames: [],
      remainder: '#checkout-button',
    });
  });

  it('handles the explicit locator() form as the leaf', () => {
    // Frame-scoped expressions always use it: `frameLocator('#f').#card` would be
    // ambiguous to parse back.
    assert.deepEqual(validator.splitFrameChain("frameLocator('#pay').locator('#card-number')"), {
      frames: ['#pay'],
      remainder: "locator('#card-number')",
    });
  });

  it('reads a frame selector containing an escaped quote', () => {
    const { frames } = validator.splitFrameChain(
      String.raw`frameLocator('[title=\'Secure payment\']').locator('#card')`
    );
    assert.deepEqual(frames, ["[title='Secure payment']"]);
  });

  it('reads a frame selector containing brackets and commas', () => {
    const { frames, remainder } = validator.splitFrameChain(
      "frameLocator('iframe[name=\"pay\"], #fallback').getByTestId('card')"
    );
    assert.deepEqual(frames, ['iframe[name="pay"], #fallback']);
    assert.equal(remainder, "getByTestId('card')");
  });

  it('stops rather than looping on a malformed prefix', () => {
    // An unbalanced call must not spin or swallow the rest of the expression.
    const result = validator.splitFrameChain("frameLocator('#pay'.getByRole('button')");
    assert.deepEqual(result.frames, []);
    assert.match(result.remainder, /^frameLocator\(/);
  });
});

describe('qualifyWithFrames — putting the frame path back', () => {
  it('is a no-op when there are no frames', () => {
    assert.equal(validator.qualifyWithFrames("getByRole('button')", []), "getByRole('button')");
  });

  it('prefixes a bare getBy* answer', () => {
    // The model saw only the frame's snapshot, so it answers in the frame's terms. Left
    // alone this would resolve against the parent document and match nothing.
    assert.equal(
      validator.qualifyWithFrames("getByLabel('Card number')", ['#pay']),
      "frameLocator('#pay').getByLabel('Card number')"
    );
  });

  it('wraps bare CSS in the explicit call form', () => {
    assert.equal(
      validator.qualifyWithFrames('#card-number-v3', ['#pay']),
      "frameLocator('#pay').locator('#card-number-v3')"
    );
  });

  it('keeps an existing locator() call as-is', () => {
    assert.equal(
      validator.qualifyWithFrames("locator('#card')", ['#pay']),
      "frameLocator('#pay').locator('#card')"
    );
  });

  it('does not double the prefix when the model named the frame itself', () => {
    assert.equal(
      validator.qualifyWithFrames("frameLocator('#pay').getByLabel('Card')", ['#pay']),
      "frameLocator('#pay').getByLabel('Card')"
    );
  });

  it('strips the await/page. wrappers models add', () => {
    assert.equal(
      validator.qualifyWithFrames("await page.getByLabel('Card')", ['#pay']),
      "frameLocator('#pay').getByLabel('Card')"
    );
  });

  it('nests in the order given', () => {
    assert.equal(
      validator.qualifyWithFrames("getByLabel('Card')", ['#outer', '#inner']),
      "frameLocator('#outer').frameLocator('#inner').getByLabel('Card')"
    );
  });

  it('round-trips a frame selector containing a quote', () => {
    // The qualified expression has to be re-readable, or the validator cannot resolve
    // what the engine just recorded.
    const frame = "[title='Secure payment']";
    const qualified = validator.qualifyWithFrames('#card', [frame]);
    assert.deepEqual(validator.splitFrameChain(qualified).frames, [frame]);
  });
});

describe('isValidSyntax — frame expressions are JavaScript, not CSS', () => {
  it('accepts a frame-scoped expression', () => {
    assert.equal(validator.isValidSyntax("frameLocator('#pay').getByLabel('Card')"), true);
    assert.equal(validator.isValidSyntax("frameLocator('#pay').locator('#card')"), true);
  });

  it('accepts the explicit locator() form at page level', () => {
    assert.equal(validator.isValidSyntax("locator('#card')"), true);
  });

  it('still rejects an unbalanced expression', () => {
    assert.equal(validator.isValidSyntax("frameLocator('#pay').getByLabel('Card'"), false);
  });
});
