/**
 * The second-opinion check, end to end through the engine, against a real browser page.
 *
 * The provider is scripted: `heal()` picks a candidate by a predicate, `complete()` returns
 * a fixed verdict and records the question. That isolates what the engine does with the
 * answer — which is what these tests are about — from what any real model would say,
 * which is what the held-out audit sets measure.
 *
 *   npm run test:live
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');

const { chromium } = require('@playwright/test');

const { HealingEngine } = require('../../dist/core/HealingEngine');
const { SelectorCache } = require('../../dist/core/SelectorCache');
const { HealBudget } = require('../../dist/core/HealBudget');
const { AiProvider } = require('../../dist/core/AiProvider');

/** Silences the engine. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

let browser;
let unavailable;

before(async () => {
  try {
    browser = await chromium.launch();
  } catch (error) {
    const message = error.message ?? String(error);
    if (!/Executable doesn't exist|playwright install|browserType\.launch/i.test(message)) throw error;
    unavailable = message.split('\n')[0];
  }
});

after(async () => {
  await browser?.close();
});

/** A provider that picks a candidate by name and answers the second opinion as scripted. */
class Scripted extends AiProvider {
  constructor(pickName, verdict) {
    super('k', 'm');
    this.pickName = pickName;
    this.verdict = verdict;
    this.questions = [];
  }
  async heal(request) {
    const candidate = (request.candidates ?? []).find((c) => c.name === this.pickName);
    if (!candidate) return { confidence: 0, reasoning: 'none', suggestedSelector: '', tokenUsage: { input: 100, output: 10 }, provider: 'scripted' };
    return { candidateId: candidate.id, confidence: 0.9, reasoning: 'picked', suggestedSelector: '', tokenUsage: { input: 100, output: 10 }, provider: 'scripted' };
  }
  async validateConfig() {
    return true;
  }
  async complete(system, user, options = {}) {
    this.questions.push(user);
    this.models = [...(this.models ?? []), options.model];
    if (this.verdict instanceof Error) throw this.verdict;
    return { text: this.verdict, tokenUsage: { input: 40, output: 5 }, provider: 'scripted' };
  }
}

/**
 * An engine with the real gates, a scripted provider, and nothing persisted.
 *
 * @param {AiProvider} ai - The provider.
 * @param {object} [overrides] - Config fields to replace.
 * @returns {HealingEngine} The engine.
 */
function engineWith(ai, overrides = {}) {
  return new HealingEngine(
    {
      enabled: true,
      maxRetries: 1,
      timeout: 5_000,
      provider: 'scripted',
      model: 'm',
      confidenceThreshold: 0.7,
      privacy: { redact: 'identifiers' },
      intent: { mode: 'enforce', unverifiedConfidence: 0.9 },
      cache: false,
      ...overrides,
    },
    ai,
    { recorder: { recordHeal() {} }, cache: new SelectorCache(false), budget: new HealBudget({ maxHeals: 0, breakerThreshold: 0 }) }
  );
}

/**
 * Loads HTML and heals one selector.
 *
 * @param {string} html - Page content.
 * @param {AiProvider} ai - The provider.
 * @param {string[]} args - Selector, action, description.
 * @param {object} [overrides] - Config fields to replace.
 * @returns {Promise<object>} The outcome.
 */
async function healOn(html, ai, args, overrides) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await quiet(() => engineWith(ai, overrides).attemptHealDetailed(page, ...args));
  } finally {
    await page.close();
  }
}

const PROFILE_PAGE = "<nav aria-label='Account'><a href='#/password'>Edit password</a><a href='#/billing'>Billing</a></nav>";
const PROFILE_HEAL = ["//a[text()='Edit profile']", 'click', 'edit the profile'];

describe('the engine and the second opinion', () => {
  it('rejects a heal the second opinion calls a different control, and records why', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const ai = new Scripted('Edit password', '{"same": false, "reason": "password is not the profile"}');
    const outcome = await healOn(PROFILE_PAGE, ai, PROFILE_HEAL);

    assert.equal(outcome.healed, null);
    assert.match(outcome.attempts[0].error, /second opinion judged it a different control: password is not the profile/);
    assert.equal(outcome.tokens.input, 140, 'the question is billed with the heal');
  });

  it('accepts a heal the second opinion confirms, and records that it asked', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const ai = new Scripted('Edit password', '{"same": true, "reason": "rename"}');
    const outcome = await healOn(PROFILE_PAGE, ai, PROFILE_HEAL);

    assert.equal(outcome.healed, "getByRole('link', { name: 'Edit password', exact: true })");
    assert.ok(outcome.attempts[0].intent.checks.includes('confirm'));
    assert.match(ai.questions[0], /Proposed replacement: link "Edit password" — in navigation "Account"/);
  });

  it('names the controls beside it, and asks the configured model', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    // Whether anything else there could have been the old control decides a rename:
    // Private Cloud beside Settings and Help, against Private Cloud beside Dedicated Cloud.
    const ai = new Scripted('Private Cloud', '{"same": true}');
    await healOn(
      "<nav aria-label='Main'><a href='#/p'>Private Cloud</a><a href='#/s'>Settings</a><a href='#/h'>Help</a></nav>",
      ai,
      ["//li/a/span[text()='Charter Cloud']", 'click'],
      { confirmModel: 'a-stronger-model' }
    );
    assert.match(ai.questions[0], /Other controls beside it: "Settings", "Help"/);
    assert.deepEqual(ai.models, ['a-stronger-model']);
  });

  it('claims nothing about neighbours of a heal it never enumerated', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    // A free-form heal: the model wrote the locator, so there is no candidate group.
    class Written extends Scripted {
      async heal() {
        return {
          suggestedSelector: "getByRole('link', { name: 'Edit password' })",
          expectedRole: 'link',
          expectedName: 'Edit password',
          confidence: 0.9,
          reasoning: 'written',
          tokenUsage: { input: 100, output: 10 },
          provider: 'scripted',
        };
      }
    }
    const ai = new Written('', '{"same": false}');
    await healOn(PROFILE_PAGE, ai, PROFILE_HEAL);
    assert.ok(!/Other controls beside it/.test(ai.questions[0]), ai.questions[0]);
  });

  it('does not ask about an element that only moved, keeping its text', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const ai = new Scripted('Contact us', '{"same": false}');
    const outcome = await healOn(
      "<header><a href='#/'>Home</a></header><footer><a href='#/contact'>Contact us</a></footer>",
      ai,
      ["//header//a[text()='Contact us']", 'click']
    );
    assert.equal(outcome.healed, "getByRole('link', { name: 'Contact us', exact: true })");
    assert.equal(ai.questions.length, 0, 'nothing to judge');
  });

  it('settles a synonym the wording check cannot see — Log in → Sign in', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const page = "<form aria-label='Account'><input aria-label='Username'><button>Sign in</button></form>";
    const args = ["//button[text()='Log in']", 'click', 'log the user in'];

    const confirmed = await healOn(page, new Scripted('Sign in', '{"same": true}'), args);
    assert.equal(confirmed.healed, "getByRole('button', { name: 'Sign in', exact: true })");
    assert.equal(confirmed.attempts[0].intent.verified, true);

    const refused = await healOn(page, new Scripted('Sign in', '{"same": false}'), args);
    assert.equal(refused.healed, null);
  });

  it('keeps the wording objection when no second opinion can be asked', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const page = "<form aria-label='Account'><button>Sign in</button></form>";
    const args = ["//button[text()='Log in']", 'click', 'log the user in'];

    // A provider without complete(): healing must behave exactly as before.
    class HealOnly extends Scripted {}
    HealOnly.prototype.complete = undefined;
    const healOnly = await healOn(page, new HealOnly('Sign in', ''), args);
    assert.equal(healOnly.healed, null);
    assert.match(healOnly.attempts[0].error, /shares no wording/);

    // And with the check switched off.
    const off = await healOn(page, new Scripted('Sign in', '{"same": true}'), args, { confirm: false });
    assert.equal(off.healed, null);
    assert.match(off.attempts[0].error, /shares no wording/);
  });

  it('fails closed when the second opinion errors or is unreadable', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    for (const verdict of [new Error('socket hang up'), 'Sure, looks the same to me.']) {
      const outcome = await healOn(PROFILE_PAGE, new Scripted('Edit password', verdict), PROFILE_HEAL);
      assert.equal(outcome.healed, null);
      assert.match(outcome.attempts[0].error, /no second opinion could be obtained/);
    }
  });

  it('asks a redacted question', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const ai = new Scripted('Edit password', '{"same": false}');
    await healOn(PROFILE_PAGE, ai, ["//a[text()='Edit profile']", 'click', 'edit the profile of sam@example.com']);
    assert.ok(!ai.questions[0].includes('sam@example.com'), ai.questions[0]);
  });

  it('asks at most three times per heal', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    // Every attempt proposes, every proposal is refused; the questions must stop at three.
    class Persistent extends Scripted {
      async heal(request) {
        const ids = (request.candidates ?? []).filter((c) => c.role === 'link').map((c) => c.id);
        return {
          candidateId: ids[0],
          alternatives: ids.slice(1).map((id) => ({ candidateId: id, confidence: 0.9, reasoning: 'alt' })),
          confidence: 0.9,
          reasoning: 'picked',
          suggestedSelector: '',
          tokenUsage: { input: 100, output: 10 },
          provider: 'scripted',
        };
      }
    }
    const ai = new Persistent('', '{"same": false}');
    const outcome = await healOn(
      "<nav aria-label='Account'><a href='#/a'>Edit password</a><a href='#/b'>Edit email</a><a href='#/c'>Edit phone</a><a href='#/d'>Edit address</a></nav>",
      ai,
      PROFILE_HEAL,
      { maxRetries: 2 }
    );
    assert.equal(outcome.healed, null);
    assert.equal(ai.questions.length, 3);
  });
});
