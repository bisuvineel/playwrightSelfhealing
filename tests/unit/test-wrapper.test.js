/**
 * Unit tests for the integration surface — decoration, retry, and the CI gate.
 *
 * This is the largest file in the package and the one every consumer touches first, and
 * coverage put it at 61% of lines and **31% of functions** — the worst in the codebase.
 * What was untested is not incidental either: whether a failing action actually retries
 * with the healed selector, whether a chained or refined locator stays healable, and
 * whether the `fail-on-heal` gate is armed. A suite that quietly stopped healing looks
 * identical to one that never needed to, which is precisely why these need pinning.
 *
 * No browser and no credential. The page is a stub, because what is under test is the
 * decoration and the retry — Playwright's own behaviour is not this package's to verify,
 * and a real browser would obscure which method got called with what.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

const {
  applyHealing,
  attachHealing,
  assertNoHeals,
  describeHealGate,
  computeHealDeadline,
  setHealingEngine,
  resetHealingEngine,
  HEAL_ANNOTATIONS,
} = require('../../dist/core/TestWrapper');

/** Silences the wrapper, which logs on every heal and every rejection. */
function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** Awaitable variant of {@link quiet}. */
async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** Every action the wrapper is expected to heal. */
const HEALED_ACTIONS = [
  'click', 'dblclick', 'fill', 'check', 'uncheck', 'hover', 'selectOption', 'press',
  'pressSequentially', 'type', 'tap', 'focus', 'clear', 'selectText', 'setInputFiles',
  'scrollIntoViewIfNeeded',
];

/**
 * A page stub whose locators fail every action until a nominated selector is used.
 *
 * Models the only situation healing exists for: the selector in the test is stale, and
 * a different one works.
 *
 * @param {object} [options] - `working` is the selector whose actions succeed.
 * @returns {object} The stub page, with a `performed` log of `selector.action` strings.
 */
function pageStub({ working = null } = {}) {
  const performed = [];
  // Every action invoked, including those that failed — so a test can show an action was
  // never tried at all, which `performed` alone cannot.
  const attempted = [];

  /**
   * Actions live on a **prototype**, as a real Playwright `Locator`'s do.
   *
   * This is not cosmetic. To keep Playwright's own error labels intact, `wrapAction`
   * calls the original by deleting its override for the duration of the call —
   * `delete target[action]` — which reveals the prototype method underneath. A stub
   * with actions as *own* properties has nothing underneath, so the delete destroys
   * the method, every call throws `TypeError`, and the wrapper dutifully heals a
   * failure the stub invented. Four of these tests passed for that wrong reason
   * before the prototype was introduced.
   */
  const locatorProto = {};
  for (const action of HEALED_ACTIONS) {
    locatorProto[action] = async function () {
      attempted.push(`${this.__expression}.${action}`);
      if (working !== null && this.__expression !== working) {
        throw new Error(`locator.${action}: Timeout 800ms exceeded.`);
      }
      performed.push(`${this.__expression}.${action}`);
      return undefined;
    };
  }

  /**
   * Builds a locator for one selector expression.
   *
   * @param {string} expression - The expression this locator represents.
   * @returns {object} The locator stub.
   */
  function makeLocator(expression) {
    const locator = Object.create(locatorProto);
    locator.__expression = expression;

    // The builder surface a chained locator exposes, so chaining can be checked.
    locator.locator = (selector) => makeLocator(`${expression}.locator('${selector}')`);
    for (const method of ['getByRole', 'getByLabel', 'getByText', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText']) {
      locator[method] = (value) => makeLocator(`${expression}.${method}('${value}')`);
    }
    locator.first = () => makeLocator(`${expression}.first()`);
    locator.last = () => makeLocator(`${expression}.last()`);
    locator.nth = (index) => makeLocator(`${expression}.nth(${index})`);
    locator.filter = () => makeLocator(`${expression}.filter(...)`);
    locator.describe = (text) => makeLocator(`${expression}.describe('${text}')`);
    locator.frameLocator = (selector) => makeFrame(`${expression}.frameLocator('${selector}')`);

    return locator;
  }

  /**
   * Builds a frame-locator stub.
   *
   * @param {string} prefix - The expression this frame represents.
   * @returns {object} The frame-locator stub.
   */
  function makeFrame(prefix) {
    const frame = {
      locator: (selector) => makeLocator(`${prefix}.locator('${selector}')`),
      frameLocator: (selector) => makeFrame(`${prefix}.frameLocator('${selector}')`),
    };
    for (const method of ['getByRole', 'getByLabel', 'getByText', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText']) {
      frame[method] = (value) => makeLocator(`${prefix}.${method}('${value}')`);
    }
    return frame;
  }

  const page = {
    performed,
    attempted,
    url: () => 'https://app.test/checkout',
    locator: (selector) => makeLocator(`locator('${selector}')`),
    frameLocator: (selector) => makeFrame(`frameLocator('${selector}')`),
  };

  for (const method of ['getByRole', 'getByLabel', 'getByText', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText']) {
    page[method] = (value) => makeLocator(`${method}('${value}')`);
  }

  return page;
}

/**
 * An engine stub that heals to a fixed selector.
 *
 * @param {object} [options] - `healed` is what it returns; `null` means it cannot help.
 * @returns {object} The engine, with an `asked` log of what it was asked to heal.
 */
function engineStub({ healed = null } = {}) {
  return {
    asked: [],
    async attemptHealDetailed(page, originalSelector, action, description, _error, options) {
      this.asked.push({ originalSelector, action, description, options });
      return {
        originalSelector,
        action,
        pageUrl: 'https://app.test/checkout',
        file: 'a.spec.ts',
        line: 1,
        healed,
        attempts: [],
        tokens: { input: 10, output: 2 },
        ...(healed === null ? { error: 'no working selector' } : {}),
      };
    },
    async attemptHeal(page, originalSelector, action, description) {
      const outcome = await this.attemptHealDetailed(page, originalSelector, action, description);
      return outcome.healed;
    },
  };
}

/** A minimal `testInfo`, which the wrapper uses only for annotations. */
function testInfoStub() {
  return { annotations: [], title: 'a test', titlePath: ['f.spec.ts', 'a test'] };
}

afterEach(() => {
  quiet(() => resetHealingEngine());
  // Drain the gate so one test's heals cannot arm the next one's assertion.
  quiet(() => assertNoHeals(false));
});

describe('applyHealing — decorating a page', () => {
  it('heals a failing action and retries it with the new selector', async () => {
    // The whole contract in one test: the action fails, the engine is asked, and the
    // retry happens against what it returned.
    const page = pageStub({ working: "getByTestId('checkout')" });
    const engine = engineStub({ healed: "getByTestId('checkout')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await quietly(() => decorated.locator('#checkout-button').click());

    assert.equal(engine.asked.length, 1);
    assert.equal(engine.asked[0].originalSelector, '#checkout-button');
    assert.equal(engine.asked[0].action, 'click');
    assert.deepEqual(page.performed, ["getByTestId('checkout').click"]);
  });

  it('re-throws the original Playwright error when it cannot heal', async () => {
    // A failing test must read exactly as it would without this package installed —
    // same message, same `locator.click:` label.
    const page = pageStub({ working: 'nothing works' });
    const engine = engineStub({ healed: null });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));

    await assert.rejects(
      () => quietly(() => decorated.locator('#gone').click()),
      /locator\.click: Timeout 800ms exceeded\./
    );
  });

  it('does not ask the engine when the action succeeds', async () => {
    const page = pageStub();
    const engine = engineStub({ healed: "getByTestId('x')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await decorated.locator('#fine').click();

    assert.equal(engine.asked.length, 0, 'healing is a recovery path, not a wrapper tax');
    assert.deepEqual(page.performed, ["locator('#fine').click"]);
  });

  it('wraps every action it claims to heal', async () => {
    // A gap here is silent: the action just fails as though healing were off.
    for (const action of HEALED_ACTIONS) {
      const page = pageStub({ working: "getByTestId('ok')" });
      const engine = engineStub({ healed: "getByTestId('ok')" });
      const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));

      await quietly(() => decorated.locator('#stale')[action]('value'));

      assert.equal(engine.asked.length, 1, `${action} was not wrapped`);
      assert.equal(engine.asked[0].action, action);
    }
  });

  it('decorates every getBy* helper, not just locator()', async () => {
    for (const method of ['getByRole', 'getByLabel', 'getByText', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText']) {
      const page = pageStub({ working: "getByTestId('ok')" });
      const engine = engineStub({ healed: "getByTestId('ok')" });
      const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));

      await quietly(() => decorated[method]('Submit').click());

      assert.equal(engine.asked.length, 1, `${method} produced an undecorated locator`);
      assert.match(engine.asked[0].originalSelector, new RegExp(`^${method}\\(`));
    }
  });

  it('leaves a chained locator unhealed, and reports the failure unchanged', async () => {
    // A documented limitation, pinned so it stays deliberate: decoration covers the
    // page's builders and a locator's `describe()`/`first()`/`last()`/`nth()`, but not
    // `locator.locator(...)` or `locator.getByRole(...)`. See README § Limitations, and
    // DESIGN-chained-locators.md for the heal-by-prefix design that would close it.
    //
    // What matters is that the failure is *clean*: no heal is attempted and the original
    // Playwright error reaches the test verbatim, so it reads as it would with the
    // package uninstalled rather than as a healer malfunction.
    const page = pageStub({ working: 'nothing works' });
    const engine = engineStub({ healed: "getByTestId('ok')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));

    await assert.rejects(
      () => quietly(() => decorated.locator('#row').getByRole('button').click()),
      /locator\.click: Timeout 800ms exceeded\./
    );
    assert.equal(engine.asked.length, 0, 'a chained locator is not decorated, so nothing heals');
  });

  it('does not re-heal its own replacement', async () => {
    // The retry used to resolve the healed selector through the *decorated* page, so the
    // replacement arrived with wrapped actions and a retry that also failed healed
    // again. Measured: 201 heals for one failing action, and unbounded with the
    // documented HEALER_MAX_HEALS=0 — a single stale selector could consume a worker's
    // whole budget in provider calls.
    const page = pageStub({ working: 'nothing works' });
    const engine = engineStub({ healed: "getByTestId('also-broken')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));

    await assert.rejects(
      () => quietly(() => decorated.locator('#stale').click()),
      /locator\.click: Timeout 800ms exceeded\./,
      'a healed selector that also fails must surface the original error'
    );
    assert.equal(engine.asked.length, 1, 'exactly one heal per failing action');
  });

  it('keeps a positionally refined locator healable', async () => {
    const page = pageStub({ working: "getByTestId('ok')" });
    const engine = engineStub({ healed: "getByTestId('ok')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await quietly(() => decorated.locator('#row').nth(2).click());

    assert.equal(engine.asked.length, 1, '.nth() lost its decoration');
    assert.match(engine.asked[0].originalSelector, /\.nth\(2\)$/);
  });

  it('heals inside a frame', async () => {
    // Without decorating frameLocator, nothing inside an iframe heals at all.
    const page = pageStub({ working: "getByTestId('ok')" });
    const engine = engineStub({ healed: "getByTestId('ok')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await quietly(() => decorated.frameLocator('#pay').locator('#card').click());

    assert.equal(engine.asked.length, 1, 'a frame-scoped locator lost its decoration');
    assert.match(engine.asked[0].originalSelector, /^frameLocator\('#pay'\)\./);
  });

  it('carries a describe() through to the engine as the element description', async () => {
    // The description is the strongest signal the model gets, so losing it here would
    // quietly degrade every heal on a well-written suite.
    const page = pageStub({ working: "getByTestId('ok')" });
    const engine = engineStub({ healed: "getByTestId('ok')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await quietly(() => decorated.locator('#btn').describe('the order button').click());

    assert.equal(engine.asked[0].description, 'the order button');
  });

  it('annotates the report when there is no engine at all', () => {
    const info = testInfoStub();
    quiet(() => applyHealing(pageStub(), info, null));

    const annotation = info.annotations.find((a) => a.type === HEAL_ANNOTATIONS.unavailable);
    assert.ok(annotation, 'an unavailable healer must be visible in the report');
  });

  it('leaves the page usable when there is no engine', async () => {
    const page = pageStub();
    const decorated = quiet(() => applyHealing(page, testInfoStub(), null));

    await decorated.locator('#fine').click();
    assert.deepEqual(page.performed, ["locator('#fine').click"]);
  });
});

/**
 * An engine stub that already knows a heal for one selector, as a worker does after its
 * first heal of a stale page-object locator.
 *
 * @param {object} options - `known` is the selector it has healed; `healed` what to; set
 * `declines` to model a reuse that steps aside (the original resolves, a blocked route…).
 * @returns {object} The engine, with `reused` and `asked` logs.
 */
function knowingEngineStub({ known, healed, declines = false }) {
  const engine = engineStub({ healed });
  engine.reused = [];
  engine.hasKnownHeal = (selector) => selector === known;
  engine.reuseKnownHeal = async (page, originalSelector, action) => {
    engine.reused.push({ originalSelector, action });
    if (declines) return null;
    return {
      originalSelector,
      action,
      pageUrl: 'https://app.test/checkout',
      file: 'a.spec.ts',
      line: 1,
      healed,
      attempts: [],
      tokens: { input: 0, output: 0 },
    };
  };
  return engine;
}

describe('a known heal is used without waiting out the stale action', () => {
  it('acts on the known replacement without trying the stale original first', async () => {
    // The cache used to save the provider call and nothing else: the original still ran to
    // its full actionTimeout on every use before healing began.
    const page = pageStub({ working: "getByTestId('checkout')" });
    const engine = knowingEngineStub({ known: '#checkout-button', healed: "getByTestId('checkout')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await quietly(() => decorated.locator('#checkout-button').click());

    assert.deepEqual(page.attempted, ["getByTestId('checkout').click"], 'the stale original was waited on');
    assert.equal(engine.asked.length, 0, 'no full heal was needed');
    assert.equal(engine.reused.length, 1);
  });

  it('falls back to the normal path when the reuse steps aside', async () => {
    const page = pageStub({ working: "getByTestId('checkout')" });
    const engine = knowingEngineStub({
      known: '#checkout-button',
      healed: "getByTestId('checkout')",
      declines: true,
    });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await quietly(() => decorated.locator('#checkout-button').click());

    assert.deepEqual(page.attempted, [
      "locator('#checkout-button').click",
      "getByTestId('checkout').click",
    ]);
    assert.equal(engine.asked.length, 1, 'the original failed, so the normal heal ran');
  });

  it('does not consult the reuse for a selector it has never healed', async () => {
    const page = pageStub();
    const engine = knowingEngineStub({ known: '#something-else', healed: "getByTestId('x')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await decorated.locator('#fine').click();

    assert.equal(engine.reused.length, 0, 'a passing action must not pay for a probe');
    assert.deepEqual(page.performed, ["locator('#fine').click"]);
  });

  it('works with an engine that predates the reuse methods', async () => {
    // setHealingEngine() accepts any engine, including one built against an older release.
    const page = pageStub({ working: "getByTestId('ok')" });
    const engine = engineStub({ healed: "getByTestId('ok')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await quietly(() => decorated.locator('#stale').click());

    assert.deepEqual(page.performed, ["getByTestId('ok').click"]);
  });
});

describe('a heal is bounded by the test timeout', () => {
  it('is the start plus the timeout, less a margin for the retried action', () => {
    assert.equal(computeHealDeadline(30_000, 1_000_000), 1_000_000 + 30_000 - 2_000);
  });

  it('has no limit when the test has no timeout, or its start is unknown', () => {
    assert.equal(computeHealDeadline(0, 1_000_000), undefined);
    assert.equal(computeHealDeadline(30_000, undefined), undefined);
  });

  it('passes no deadline outside a running test', async () => {
    const page = pageStub({ working: "getByTestId('ok')" });
    const engine = engineStub({ healed: "getByTestId('ok')" });

    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await quietly(() => decorated.locator('#stale').click());

    assert.deepEqual(engine.asked[0].options, {});
  });
});

describe('an unbounded actionTimeout is called out', () => {
  /** Runs `fn` and returns what it wrote to console.warn. */
  function warningsFrom(fn) {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const warnings = [];
    console.log = console.error = () => {};
    console.warn = (line) => warnings.push(String(line));
    try {
      fn();
    } finally {
      Object.assign(console, saved);
    }
    return warnings.filter((line) => line.includes('actionTimeout'));
  }

  /** A testInfo whose project configures the given actionTimeout. */
  function infoWith(actionTimeout) {
    return { ...testInfoStub(), project: { use: actionTimeout === undefined ? {} : { actionTimeout } } };
  }

  it('warns when the project leaves it at the default of 0', () => {
    // With no action timeout a stale selector waits for the whole test timeout, so healing
    // never runs — and nothing else would say so.
    const warnings = warningsFrom(() => applyHealing(pageStub(), infoWith(0), engineStub()));
    assert.equal(warnings.length, 1);
  });

  it('warns when it is not set at all', () => {
    const warnings = warningsFrom(() => applyHealing(pageStub(), infoWith(undefined), engineStub()));
    assert.equal(warnings.length, 1);
  });

  it('warns once per worker, not once per test', () => {
    const warnings = warningsFrom(() => {
      applyHealing(pageStub(), infoWith(0), engineStub());
      applyHealing(pageStub(), infoWith(0), engineStub());
    });
    assert.equal(warnings.length, 1);
  });

  it('stays quiet when it is set', () => {
    const warnings = warningsFrom(() => applyHealing(pageStub(), infoWith(5_000), engineStub()));
    assert.equal(warnings.length, 0);
  });

  it('stays quiet when healing is off', () => {
    const warnings = warningsFrom(() => applyHealing(pageStub(), infoWith(0), null));
    assert.equal(warnings.length, 0);
  });
});

describe('attachHealing — the custom-fixture path', () => {
  it('decorates a page built outside the shipped fixtures', async () => {
    const page = pageStub({ working: "getByTestId('ok')" });
    const engine = engineStub({ healed: "getByTestId('ok')" });

    const decorated = quiet(() => attachHealing(page, engine));
    await quietly(() => decorated.locator('#stale').click());

    assert.equal(engine.asked.length, 1);
  });

  it('returns the same page object, mutated in place', () => {
    const page = pageStub();
    assert.equal(quiet(() => attachHealing(page, engineStub())), page);
  });

  it('does not throw when called with no engine and no test running', () => {
    // Documented as safe to call from a global setup file, where there is no testInfo.
    assert.doesNotThrow(() => quiet(() => attachHealing(pageStub(), null)));
  });
});

describe('setHealingEngine — swapping the engine', () => {
  it('makes the supplied engine the one the default path uses', async () => {
    const engine = engineStub({ healed: "getByTestId('ok')" });
    quiet(() => setHealingEngine(engine, 'a test'));

    const page = pageStub({ working: "getByTestId('ok')" });
    const decorated = quiet(() => applyHealing(page, testInfoStub()));
    await quietly(() => decorated.locator('#stale').click());

    assert.equal(engine.asked.length, 1, 'the custom engine was not consulted');
  });

  it('disables healing when set to null, without breaking the page', async () => {
    quiet(() => setHealingEngine(null, 'off for this test'));

    const page = pageStub();
    const decorated = quiet(() => applyHealing(page, testInfoStub()));
    await decorated.locator('#fine').click();

    assert.deepEqual(page.performed, ["locator('#fine').click"]);
  });
});

describe('assertNoHeals — the CI gate', () => {
  /**
   * Runs one heal so the gate has something to report.
   *
   * @returns {Promise<void>} Resolves once the heal is recorded.
   */
  async function healOnce() {
    const page = pageStub({ working: "getByTestId('ok')" });
    const engine = engineStub({ healed: "getByTestId('ok')" });
    const decorated = quiet(() => applyHealing(page, testInfoStub(), engine));
    await quietly(() => decorated.locator('#stale').click());
  }

  beforeEach(() => {
    quiet(() => assertNoHeals(false));
  });

  it('passes when nothing healed, armed or not', () => {
    assert.doesNotThrow(() => quiet(() => assertNoHeals(true)));
    assert.doesNotThrow(() => quiet(() => assertNoHeals(false)));
  });

  it('collects nothing outside a Playwright test, so global setup cannot arm it', async () => {
    // `publishOutcome` returns early without a `testInfo`, which is what makes
    // `attachHealing` safe to call from a global setup file. The consequence is that
    // the armed-gate path cannot be reached from a Node test at all — it needs a real
    // `testInfo`. Covered instead by `tests/heal-gate.spec.ts`, which runs under
    // Playwright; asserted here so the reason is recorded rather than looking like an
    // oversight.
    await healOnce();
    assert.doesNotThrow(() => quiet(() => assertNoHeals(true)));
  });

  it('stays silent when disarmed, which is the default while writing tests', async () => {
    await healOnce();
    assert.doesNotThrow(() => quiet(() => assertNoHeals(false)));
  });

  it('does not throw when the gate setting is unreadable', () => {
    // An unarmed safety gate must be loud but must never take the suite down — failing
    // every test over one malformed environment value would break the rule that healing
    // cannot do that.
    const saved = process.env.HEALER_FAIL_ON_HEAL;
    process.env.HEALER_FAIL_ON_HEAL = 'not-a-boolean';
    try {
      assert.doesNotThrow(() => quiet(() => assertNoHeals()));
    } finally {
      if (saved === undefined) delete process.env.HEALER_FAIL_ON_HEAL;
      else process.env.HEALER_FAIL_ON_HEAL = saved;
    }
  });

  it('drains between calls, so one test\'s heals cannot fail the next', async () => {
    await healOnce();
    quiet(() => assertNoHeals(false));

    // Nothing healed since, so an armed gate must now pass.
    assert.doesNotThrow(() => quiet(() => assertNoHeals(true)));
  });
});

describe('describeHealGate — the message a developer reads', () => {
  it('names the selector to fix and where it is written', () => {
    const message = describeHealGate([
      {
        originalSelector: '#checkout-button',
        action: 'click',
        pageUrl: 'https://app.test/cart',
        file: 'tests/checkout.spec.ts',
        line: 12,
        source: { file: 'pages/CartPage.ts', line: 37 },
        healed: "getByTestId('checkout')",
        attempts: [],
        tokens: { input: 1, output: 1 },
      },
    ]);

    assert.match(message, /#checkout-button/);
    assert.match(message, /getByTestId\('checkout'\)/);
    // The page object is where the selector lives — sending someone to the spec instead
    // sends them to a file that does not contain it.
    assert.match(message, /CartPage\.ts:37/);
  });

  it('returns a string for an empty list rather than throwing', () => {
    assert.equal(typeof describeHealGate([]), 'string');
  });
});
