/**
 * What each provider sends and records — caching, repeatability, served model — and how
 * a configuration failure is classified and acted on.
 *
 * Every test goes through a provider's real `heal()` against a local HTTP server, so the
 * request body asserted on is the one that would be sent. No credential, no network.
 *
 * The facts these pin were checked against the reference and, where it mattered, the
 * live API:
 *
 * - Anthropic caches a prefix only above a model-dependent minimum — **4,096 tokens on
 *   Claude Haiku 4.5**, 1,024 on Sonnet 4.6 and Opus 4.8, 512 on Opus 5. A shorter prefix
 *   is silently not cached. Its `input_tokens` counts only the uncached share.
 * - Sampling parameters are removed on Opus 4.7+, Opus 5, Sonnet 5 and Fable; sending one
 *   is a 400.
 * - `claude-haiku-4-5` is served as `claude-haiku-4-5-20251001` (live API).
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it, before, after } = require('node:test');

const { AnthropicProvider } = require('../../dist/providers/AnthropicProvider');
const { OpenAIProvider } = require('../../dist/providers/OpenAIProvider');
const { GeminiProvider } = require('../../dist/providers/GeminiProvider');
const { ProviderConfigurationError } = require('../../dist/providers/httpJson');
const { PromptBuilder } = require('../../dist/utils/PromptBuilder');
const { HealingEngine } = require('../../dist/core/HealingEngine');
const { HealBudget } = require('../../dist/core/HealBudget');
const { SelectorCache } = require('../../dist/core/SelectorCache');

/** The next reply, or a function of the request count. */
let reply = { status: 200, body: '{}', headers: {} };
/** Every request the server received, body parsed. */
let received = [];
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined });
      const answer = typeof reply === 'function' ? reply(received.length) : reply;
      res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
      res.end(answer.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Sets the next reply and clears the request log. */
function expectReply(next) {
  received = [];
  reply = next;
}

/** Silences provider and engine logging. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** The error a heal throws, or null. */
async function healError(provider) {
  try {
    await quiet(() => provider.heal(pageRequest()));
  } catch (error) {
    return error;
  }
  return null;
}

const opts = () => ({ baseUrl: base, timeoutMs: 5_000, maxRetries: 0 });
const anthropic = (model = 'claude-haiku-4-5') => new AnthropicProvider('sk-ant-test', model, opts());
const openai = (model = 'gpt-4o') => new OpenAIProvider('sk-test', model, opts());
const gemini = (model = 'gemini-2.0-flash') => new GeminiProvider('key-test', model, opts());

/** A request with a real page, so the split into page and question is meaningful. */
const pageRequest = () => ({
  originalSelector: '#place-order-btn',
  originalAction: 'click',
  ariaSnapshot: '- main:\n  - button "Place order"\n  - button "Cancel"',
  pageUrl: 'https://app.test/checkout',
  testFile: 'a.spec.ts',
  testLine: 1,
  candidates: [
    {
      id: 1,
      role: 'button',
      name: 'Place order',
      context: [],
      selector: "getByRole('button', { name: 'Place order', exact: true })",
    },
  ],
});

const ANSWER = '{"candidateId": 1, "confidence": 0.9, "reasoning": "r"}';

/** A successful Anthropic reply with the given usage and served model. */
const anthropicReply = (usage = {}, model = 'claude-haiku-4-5-20251001') => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    model,
    content: [{ type: 'text', text: ANSWER }],
    usage: { input_tokens: 100, output_tokens: 20, ...usage },
    stop_reason: 'end_turn',
  }),
});

describe('Anthropic — cacheable, repeatable, and says what served it', () => {
  it('places a cache breakpoint after the system prompt and after the page', async () => {
    expectReply(anthropicReply());
    await quiet(() => anthropic().heal(pageRequest()));

    const body = received[0].body;
    assert.ok(Array.isArray(body.system), 'the system prompt is sent as a block');
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });

    const content = body.messages[0].content;
    assert.equal(content.length, 2, 'the user turn is split into page and question');
    assert.deepEqual(content[0].cache_control, { type: 'ephemeral' }, 'breakpoint after the page');
    assert.equal(content[1].cache_control, undefined, 'the failure-specific part is not cached');

    // The split is exactly the prompt, not a rewording of it.
    assert.equal(content[0].text + content[1].text, PromptBuilder.buildUserPrompt(pageRequest()));
    assert.ok(content[0].text.includes('- button "Place order"'));
    assert.ok(!content[0].text.includes('Original selector:'), 'nothing per-failure in the page part');
  });

  it('counts cached input in the total, and reports the cached share', async () => {
    // `input_tokens` is only the uncached share once caching engages; recording it alone
    // would make a cached heal look cheaper than it was.
    expectReply(anthropicReply({ input_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 }));
    const result = await quiet(() => anthropic().heal(pageRequest()));

    assert.equal(result.tokenUsage.input, 1650);
    assert.equal(result.tokenUsage.cached, 1500);
  });

  it('counts a cache write as input, and reports no cached share for it', async () => {
    expectReply(anthropicReply({ cache_creation_input_tokens: 1300, cache_read_input_tokens: 0 }));
    const result = await quiet(() => anthropic().heal(pageRequest()));

    assert.equal(result.tokenUsage.input, 1400);
    assert.equal(result.tokenUsage.cached, undefined);
  });

  it('pins temperature on a model that accepts it', async () => {
    expectReply(anthropicReply());
    await quiet(() => anthropic().heal(pageRequest()));
    assert.equal(received[0].body.temperature, 0);
  });

  const noSampling = [
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5-1',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-some-future-model',
  ];

  for (const model of noSampling) {
    it(`does not send temperature to ${model}`, async () => {
      // Removed on Opus 4.7+, Opus 5, Sonnet 5 and Fable, where it is a 400. The 4.6
      // models are sent `effort`, a combination this package has not verified. An unknown
      // model gets none either: omitting it costs repeatability, sending it wrongly would
      // break every heal.
      expectReply(anthropicReply({}, model));
      await quiet(() => anthropic(model).heal(pageRequest()));
      assert.equal('temperature' in received[0].body, false, `${model} must not be sent temperature`);
    });
  }

  it('records the model that served the request, not the alias that was asked for', async () => {
    expectReply(anthropicReply({}, 'claude-haiku-4-5-20251001'));
    const result = await quiet(() => anthropic().heal(pageRequest()));
    assert.equal(result.provider, 'anthropic:claude-haiku-4-5-20251001');
  });

  it('recommends pinning the served snapshot, once', async () => {
    const warnings = [];
    const saved = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      // A distinct alias, so the once-per-process memory from earlier tests does not apply.
      expectReply(anthropicReply({}, 'claude-sonnet-4-5-20250929'));
      await anthropic('claude-sonnet-4-5').heal(pageRequest());
      expectReply(anthropicReply({}, 'claude-sonnet-4-5-20250929'));
      await anthropic('claude-sonnet-4-5').heal(pageRequest());
    } finally {
      console.warn = saved;
    }

    const pins = warnings.filter((line) => line.includes('is an alias'));
    assert.equal(pins.length, 1, 'said once, not on every heal');
    assert.match(pins[0], /claude-sonnet-4-5-20250929/);
  });

  it('does not recommend anything when the configured model is what was served', async () => {
    const warnings = [];
    const saved = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      expectReply(anthropicReply({}, 'claude-opus-5'));
      await anthropic('claude-opus-5').heal(pageRequest());
    } finally {
      console.warn = saved;
    }
    assert.equal(warnings.filter((line) => line.includes('is an alias')).length, 0);
  });
});

describe('OpenAI', () => {
  const openaiReply = (usage = {}, model = 'gpt-4o-2024-08-06') => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      model,
      choices: [{ message: { content: ANSWER }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1700, completion_tokens: 20, ...usage },
    }),
  });

  it('pins temperature on gpt-4o, and records the cached share and served model', async () => {
    expectReply(openaiReply({ prompt_tokens_details: { cached_tokens: 1280 } }));
    const result = await quiet(() => openai().heal(pageRequest()));

    assert.equal(received[0].body.temperature, 0);
    assert.equal(result.tokenUsage.input, 1700, 'prompt_tokens already includes cached tokens');
    assert.equal(result.tokenUsage.cached, 1280);
    assert.equal(result.provider, 'openai:gpt-4o-2024-08-06');
  });

  for (const model of ['o3', 'o4-mini', 'gpt-5', 'gpt-5-mini']) {
    it(`does not send temperature to the reasoning model ${model}`, async () => {
      expectReply(openaiReply({}, model));
      await quiet(() => openai(model).heal(pageRequest()));
      assert.equal('temperature' in received[0].body, false);
    });
  }

  it('does not recommend pinning an Azure deployment, whose version is pinned server-side', async () => {
    const warnings = [];
    const saved = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      expectReply(openaiReply({}, 'gpt-4o-2024-11-20'));
      const azure = new OpenAIProvider('sk-test', 'gpt-4o', { ...opts(), apiVersion: '2025-01-01-preview' });
      await azure.heal(pageRequest());
    } finally {
      console.warn = saved;
    }
    assert.equal(warnings.filter((line) => line.includes('is an alias')).length, 0);
  });
});

describe('Gemini', () => {
  const geminiReply = (usage = {}, modelVersion = 'gemini-2.0-flash-001') => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      modelVersion,
      candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1700, candidatesTokenCount: 20, ...usage },
    }),
  });

  it('pins temperature on a 2.x model, and records the cached share and version', async () => {
    expectReply(geminiReply({ cachedContentTokenCount: 1024 }));
    const result = await quiet(() => gemini().heal(pageRequest()));

    assert.equal(received[0].body.generationConfig.temperature, 0);
    assert.equal(result.tokenUsage.cached, 1024);
    assert.equal(result.provider, 'gemini:gemini-2.0-flash-001');
  });

  it('leaves a later model family at its default temperature', async () => {
    expectReply(geminiReply({}, 'gemini-3-pro'));
    await quiet(() => gemini('gemini-3-pro').heal(pageRequest()));
    assert.equal('temperature' in received[0].body.generationConfig, false);
  });
});

describe('a configuration failure is classified as one', () => {
  const cases = [
    ['anthropic', anthropic, 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', true],
    ['anthropic', anthropic, 403, '{"type":"error","error":{"type":"permission_error","message":"no access"}}', true],
    ['anthropic', anthropic, 404, '{"type":"error","error":{"type":"not_found_error","message":"model: x"}}', true],
    ['anthropic', anthropic, 500, '{"type":"error","error":{"type":"api_error","message":"boom"}}', false],
    ['anthropic', anthropic, 429, '{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}', false],
    ['openai', openai, 429, '{"error":{"code":"insufficient_quota","message":"You exceeded your quota"}}', true],
    ['openai', openai, 429, '{"error":{"code":"rate_limit_exceeded","message":"slow down"}}', false],
    ['gemini', gemini, 400, '{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}}', true],
  ];

  for (const [name, build, status, body, fatal] of cases) {
    const label = /insufficient_quota/.test(body) ? ' (out of credit)' : /API_KEY_INVALID/.test(body) ? ' (bad key)' : '';
    it(`${name} ${status}${label} is ${fatal ? 'a configuration failure' : 'transient'}`, async () => {
      expectReply({ status, body, headers: {} });
      const error = await healError(build());
      assert.ok(error, 'the heal should have failed');
      assert.equal(error instanceof ProviderConfigurationError, fatal, error.message);
    });
  }
});

describe('the engine stops healing on a configuration failure', () => {
  /** A page on which nothing resolves, so every heal reaches the provider. */
  function pageStub() {
    const locator = {
      first: () => locator,
      waitFor: async () => {},
      count: async () => 0,
      isVisible: async () => false,
      ariaSnapshot: async () => '- button "Place order"',
    };
    const page = { url: () => 'https://app.test/home' };
    for (const method of ['locator', 'getByRole', 'getByLabel', 'getByText', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText']) {
      page[method] = () => locator;
    }
    page.frameLocator = () => page;
    return page;
  }

  /** An engine on the real AnthropicProvider, against the local server. */
  function engineWith(breakerThreshold) {
    const budget = new HealBudget({ maxHeals: 0, breakerThreshold });
    const engine = new HealingEngine(
      {
        enabled: true,
        maxRetries: 2,
        timeout: 5_000,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        confidenceThreshold: 0.7,
        privacy: { redact: 'identifiers' },
        intent: { mode: 'off', unverifiedConfidence: 0.9 },
        cache: false,
      },
      anthropic(),
      { recorder: { recordHeal() {} }, cache: new SelectorCache(false), budget }
    );
    return { engine, budget };
  }

  it('makes one call for the whole worker, then skips every heal with the reason', async () => {
    // Measured before: two doomed calls per stale selector per test, and a per-worker
    // breaker that never tripped across four workers.
    let calls = 0;
    reply = () => {
      calls += 1;
      return {
        status: 401,
        headers: {},
        body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      };
    };

    const { engine, budget } = engineWith(5);

    const first = await quiet(() => engine.attemptHealDetailed(pageStub(), '#a', 'click'));
    assert.equal(first.healed, null);
    assert.match(first.error, /rejected the credential/);

    for (const selector of ['#b', '#c', '#d']) {
      const later = await quiet(() => engine.attemptHealDetailed(pageStub(), selector, 'click'));
      assert.equal(later.skipped, true, 'later heals are skipped, not attempted');
      assert.match(later.error, /healing is off for the rest of this worker/);
      assert.match(later.error, /ANTHROPIC_API_KEY/, 'and the reason still names the fix');
    }

    assert.equal(calls, 1, 'one call, not two per selector');
    assert.ok(budget.disabled);
  });

  it('still stops when the circuit breaker has been switched off', async () => {
    // HEALER_BREAKER_THRESHOLD=0 tolerates a flaky provider. A missing model is not flaky.
    let calls = 0;
    reply = () => {
      calls += 1;
      return { status: 404, headers: {}, body: '{"type":"error","error":{"type":"not_found_error","message":"model"}}' };
    };

    const { engine } = engineWith(0);
    for (const selector of ['#a', '#b', '#c']) {
      await quiet(() => engine.attemptHealDetailed(pageStub(), selector, 'click'));
    }
    assert.equal(calls, 1);
  });

  it('keeps retrying a transient failure, as before', async () => {
    let calls = 0;
    reply = () => {
      calls += 1;
      return { status: 500, headers: {}, body: '{"type":"error","error":{"type":"api_error","message":"boom"}}' };
    };

    const { engine, budget } = engineWith(0);
    await quiet(() => engine.attemptHealDetailed(pageStub(), '#a', 'click'));

    assert.equal(calls, 2, 'maxRetries: 2 means two attempts at one heal');
    assert.equal(budget.disabled, null, 'a 500 must not switch healing off');
  });
});
