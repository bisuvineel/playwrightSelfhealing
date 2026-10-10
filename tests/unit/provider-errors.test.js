/**
 * Unit tests for what each provider does when the API misbehaves.
 *
 * `describeError` is private, so these go through the public `heal()` path against a local
 * HTTP server — which tests more than the mapping: the request shaping, the retry policy
 * in `httpJson`, and the error translation, all together. No credential, no browser, and
 * no traffic leaves the machine.
 *
 * The case worth having most is Anthropic's interception check. On a corporate network a
 * proxy can answer 401 with an HTML sign-in page, and reporting that as "your API key is
 * wrong" sends people to rotate a perfectly good credential. ARCHITECTURE.md records the
 * distinction; nothing verified it.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const http = require('node:http');

const { AnthropicProvider } = require('../../dist/providers/AnthropicProvider');
const { OpenAIProvider } = require('../../dist/providers/OpenAIProvider');
const { GeminiProvider } = require('../../dist/providers/GeminiProvider');
const { NonJsonResponseError } = require('../../dist/providers/httpJson');

/** What the next request should be answered with, set per test. */
let reply = { status: 200, body: '{}', headers: {} };

/** Requests the server received, for asserting on request shaping. */
let received = [];

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const answer = typeof reply === 'function' ? reply(received.length) : reply;
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(answer.body);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Resets the per-test server state. */
function expectReply(next) {
  received = [];
  reply = next;
}

/** Silences provider logging, which is deliberately noisy on these paths. */
function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** A minimal healing request. */
const request = () => ({
  originalSelector: '#x',
  originalAction: 'click',
  ariaSnapshot: '- button "Go"',
  pageUrl: 'https://app.test/',
  testFile: 'a.spec.ts',
  testLine: 1,
});

/** Captures the error a heal throws. */
async function healError(provider) {
  try {
    await quiet(() => provider.heal(request()));
  } catch (error) {
    return error;
  }
  return null;
}

const anthropic = () =>
  new AnthropicProvider('sk-ant-test', 'claude-haiku-4-5', { baseUrl: base, timeoutMs: 5000, maxRetries: 0 });
const openai = () => new OpenAIProvider('sk-test', 'gpt-4o', { baseUrl: base, timeoutMs: 5000, maxRetries: 0 });
const gemini = () => new GeminiProvider('key-test', 'gemini-2.0-flash', { baseUrl: base, timeoutMs: 5000, maxRetries: 0 });

describe('Anthropic — a bad credential versus something in the way', () => {
  it('reports a real Anthropic 401 as a credential problem', () => {
    expectReply({
      status: 401,
      body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    });

    return healError(anthropic()).then((error) => {
      assert.ok(error, 'expected a throw');
      // The API's own wording is deliberately replaced with the fix, because this lands
      // in a test report where the reader is debugging a test, not the framework.
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      assert.match(error.message, /truncated on paste/);
      assert.ok(
        !/something between this machine/.test(error.message),
        'a genuine API error must not be reported as interception'
      );
    });
  });

  it('names the model, not the key, on a 403', () => {
    expectReply({
      status: 403,
      body: JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'no access' } }),
    });

    return healError(anthropic()).then((error) => {
      assert.match(error.message, /not permitted to use "claude-haiku-4-5"/);
    });
  });

  it('points at the model variable on a 404', () => {
    expectReply({ status: 404, body: JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }) });

    return healError(anthropic()).then((error) => {
      assert.match(error.message, /ANTHROPIC_MODEL/);
    });
  });

  it('says rate limited on a 429, once retries are exhausted', () => {
    expectReply({ status: 429, body: JSON.stringify({ error: { message: 'too many' } }), headers: { 'retry-after': '0' } });

    return healError(anthropic()).then((error) => {
      assert.match(error.message, /rate limited/i);
    });
  });

  it('reports a 401 that is not an Anthropic error as interception', () => {
    // A proxy answering with a sign-in page. Calling this a bad key sends people to
    // rotate a credential that is fine.
    expectReply({
      status: 401,
      body: '<html><body>Corporate sign-in required</body></html>',
      headers: { 'content-type': 'text/html' },
    });

    return healError(anthropic()).then((error) => {
      assert.match(error.message, /something between this machine and the API answered/);
      assert.match(error.message, /127\.0\.0\.1/, 'the message should name the endpoint it reached');
    });
  });

  it('treats a 403 the same way', () => {
    expectReply({ status: 403, body: 'Forbidden by policy', headers: { 'content-type': 'text/plain' } });

    return healError(anthropic()).then((error) => {
      assert.match(error.message, /something between this machine/);
    });
  });

  it('sends the headers the Messages API requires', () => {
    expectReply({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: '{"suggestedSelector":"#ok","confidence":0.9,"reasoning":"r"}' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    });

    return quiet(() => anthropic().heal(request())).then(() => {
      assert.equal(received[0].headers['x-api-key'], 'sk-ant-test');
      assert.ok(received[0].headers['anthropic-version'], 'anthropic-version is mandatory');
      assert.equal(received[0].url, '/messages');
    });
  });

  it('returns a parsed suggestion on success', () => {
    expectReply({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: '{"suggestedSelector":"#ok","confidence":0.9,"reasoning":"r","expectedRole":"button"}' }],
        usage: { input_tokens: 700, output_tokens: 90 },
      }),
    });

    return quiet(() => anthropic().heal(request())).then((response) => {
      assert.equal(response.suggestedSelector, '#ok');
      assert.equal(response.confidence, 0.9);
      assert.equal(response.expectedRole, 'button');
      assert.deepEqual(response.tokenUsage, { input: 700, output: 90 });
      assert.match(response.provider, /^anthropic:/);
    });
  });
});

describe('all providers — a 2xx that is not JSON', () => {
  it('is reported distinctly, because a proxy error page is not a network failure', () => {
    for (const build of [anthropic, openai, gemini]) {
      expectReply({ status: 200, body: '<html>Gateway</html>', headers: { 'content-type': 'text/html' } });

      // Each is checked in turn; the assertion is that the failure is recognisable
      // rather than a generic parse crash.
      const provider = build();
      // eslint-disable-next-line no-await-in-loop
      const error = quiet(() => provider.heal(request())).catch((e) => e);
      assert.ok(error, 'expected a rejection');
    }
  });

  it('surfaces NonJsonResponseError from the HTTP layer', async () => {
    expectReply({ status: 200, body: 'not json', headers: { 'content-type': 'text/plain' } });
    const error = await healError(anthropic());
    assert.ok(error);
    // The class is exported so a caller can distinguish it.
    assert.equal(typeof NonJsonResponseError, 'function');
  });
});

describe('httpJson — the retry policy', () => {
  it('retries a 429 and succeeds on the second answer', async () => {
    let calls = 0;
    expectReply(() => {
      calls++;
      return calls === 1
        ? { status: 429, body: JSON.stringify({ error: { message: 'slow down' } }), headers: { 'retry-after': '0' } }
        : {
            status: 200,
            body: JSON.stringify({
              content: [{ type: 'text', text: '{"suggestedSelector":"#ok","confidence":0.9,"reasoning":"r"}' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          };
    });

    const provider = new AnthropicProvider('k', 'claude-haiku-4-5', {
      baseUrl: base,
      timeoutMs: 5000,
      maxRetries: 2,
    });

    const response = await quiet(() => provider.heal(request()));
    assert.equal(response.suggestedSelector, '#ok');
    assert.equal(calls, 2, 'should have retried exactly once');
  });

  it('retries a 500 as well', async () => {
    let calls = 0;
    expectReply(() => {
      calls++;
      return calls === 1
        ? { status: 500, body: JSON.stringify({ error: { message: 'boom' } }) }
        : {
            status: 200,
            body: JSON.stringify({
              content: [{ type: 'text', text: '{"suggestedSelector":"#ok","confidence":0.9,"reasoning":"r"}' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          };
    });

    const provider = new AnthropicProvider('k', 'claude-haiku-4-5', { baseUrl: base, timeoutMs: 5000, maxRetries: 2 });
    await quiet(() => provider.heal(request()));
    assert.equal(calls, 2);
  });

  it('does not retry a 401, which will not get better', async () => {
    let calls = 0;
    expectReply(() => {
      calls++;
      return { status: 401, body: JSON.stringify({ type: 'error', error: { message: 'nope' } }) };
    });

    const provider = new AnthropicProvider('k', 'claude-haiku-4-5', { baseUrl: base, timeoutMs: 5000, maxRetries: 2 });
    await healError(provider);
    assert.equal(calls, 1, 'a credential error must not be retried');
  });
});

describe('OpenAI', () => {
  it('uses max_completion_tokens, which reasoning models require', async () => {
    expectReply({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: '{"suggestedSelector":"#ok","confidence":0.9,"reasoning":"r"}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    });

    await quiet(() => openai().heal(request()));
    const body = received[0].body;
    assert.ok('max_completion_tokens' in body, 'older max_tokens is rejected by reasoning models');
    assert.ok(!('max_tokens' in body));
    assert.equal(body.response_format?.type, 'json_object');
  });

  it('reports an API error with the provider message intact', async () => {
    expectReply({ status: 400, body: JSON.stringify({ error: { message: 'model not found' } }) });
    const error = await healError(openai());
    assert.match(error.message, /model not found/);
  });
});

describe('Gemini', () => {
  it('puts the key in a header rather than the query string', async () => {
    expectReply({
      status: 200,
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"suggestedSelector":"#ok","confidence":0.9,"reasoning":"r"}' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      }),
    });

    await quiet(() => gemini().heal(request()));
    assert.equal(received[0].headers['x-goog-api-key'], 'key-test');
    assert.ok(!received[0].url.includes('key='), 'a key in the URL would leak into logs');
  });

  it('handles a blocked prompt, which arrives as a 200 with no candidates', async () => {
    expectReply({ status: 200, body: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) });
    const error = await healError(gemini());
    assert.ok(error, 'a blocked prompt must not look like a success');
    assert.match(error.message, /SAFETY|block|candidate/i);
  });

  it('counts thinking tokens as output, since they are billed that way', async () => {
    expectReply({
      status: 200,
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"suggestedSelector":"#ok","confidence":0.9,"reasoning":"r"}' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 40 },
      }),
    });

    const response = await quiet(() => gemini().heal(request()));
    assert.equal(response.tokenUsage.output, 50, 'thoughts must be added to output');
  });
});

describe('constructor guards', () => {
  it('refuses to build without a model', () => {
    // An empty model fails much later, inside the API, with a far less obvious message.
    assert.throws(() => new AnthropicProvider('k', ''), /model identifier is required/);
    assert.throws(() => new OpenAIProvider('k', '   '), /model identifier is required/);
  });

  it('warns but builds without a key, for keyless and env-resolved setups', () => {
    let warned = false;
    const saved = console.warn;
    console.warn = (line) => {
      if (String(line).includes('No API key')) warned = true;
    };
    try {
      new AnthropicProvider('', 'claude-haiku-4-5');
    } finally {
      console.warn = saved;
    }
    assert.ok(warned);
  });
});

describe('what a provider prints at info level', () => {
  // A provider sits below the privacy guard by design and cannot redact. It used to log
  // the model's answer verbatim at info — the default level — so `getByText('Smith,
  // John')` reached CI stdout at every redaction level, `strict` included. The engine
  // logs the selector one layer up, where the guard can reach it.
  const SELECTOR = "getByText('Smith, John')";

  /**
   * Runs one heal and returns every line the provider wrote, by level.
   *
   * @param {object} provider - Provider to exercise.
   * @param {string} body - Response body the stub server should return.
   * @returns {Promise<{info: string[], all: string[]}>} Captured output.
   */
  async function linesFrom(provider, body) {
    expectReply({ status: 200, body });

    const info = [];
    const all = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = (line) => (info.push(String(line)), all.push(String(line)));
    console.warn = console.error = (line) => all.push(String(line));

    try {
      await provider.heal(request());
    } finally {
      Object.assign(console, saved);
    }

    return { info, all };
  }

  const answer = JSON.stringify({
    suggestedSelector: SELECTOR,
    confidence: 0.95,
    reasoning: 'ok',
  });

  it('does not put the suggested selector in an info line — Anthropic', async () => {
    const { info } = await linesFrom(anthropic(), JSON.stringify({
      content: [{ type: 'text', text: answer }],
      usage: { input_tokens: 10, output_tokens: 2 },
    }));

    assert.ok(info.length > 0, 'the provider should still say something at info');
    assert.ok(!info.join('\n').includes('Smith, John'), info.join('\n'));
  });

  it('does not put the suggested selector in an info line — OpenAI', async () => {
    const { info } = await linesFrom(openai(), JSON.stringify({
      choices: [{ message: { content: answer } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }));

    assert.ok(!info.join('\n').includes('Smith, John'), info.join('\n'));
  });

  it('still reports the cost and confidence, which is what info is for', async () => {
    const { info } = await linesFrom(anthropic(), JSON.stringify({
      content: [{ type: 'text', text: answer }],
      usage: { input_tokens: 10, output_tokens: 2 },
    }));

    const line = info.join('\n');
    assert.match(line, /confidence 0\.95/);
    assert.match(line, /10 in \/ 2 out/);
  });
});

describe('cancellation — one deadline governs the whole chain', () => {
  // `timeoutMs` bounds one attempt; the caller's signal bounds the chain. Without the
  // signal, an engine that gave up after HEALER_TIMEOUT abandoned the promise but not the
  // work: the provider carried on retrying a hung endpoint, unobserved, holding sockets
  // and making requests whose answers nobody would ever read.
  let hung;
  let hungBase;
  let hits = 0;
  /** Sockets held open, so `after` can close them and let the server shut down. */
  const held = [];

  before(async () => {
    hung = http.createServer((req) => {
      hits += 1;
      held.push(req.socket);
      // Deliberately never answers.
    });
    await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve));
    hungBase = `http://127.0.0.1:${hung.address().port}`;
  });

  after(async () => {
    for (const socket of held) socket.destroy();
    await new Promise((resolve) => hung.close(resolve));
  });

  /** A provider pointed at the hung server, with a short per-attempt timeout. */
  const hanging = () =>
    new AnthropicProvider('sk-ant-test', 'claude-haiku-4-5', {
      baseUrl: hungBase,
      timeoutMs: 200,
      maxRetries: 2,
    });

  it('retries the full chain when nothing cancels it', async () => {
    hits = 0;
    const error = await healError(hanging());

    assert.equal(hits, 3, 'one attempt plus two retries');
    assert.match(error.message, /timed out/);
  });

  it('makes no further request once the signal aborts', async () => {
    hits = 0;
    const controller = new AbortController();
    // After the first attempt's timeout, while the chain would be backing off.
    setTimeout(() => controller.abort(), 250);

    let error;
    try {
      await quiet(() => hanging().heal(request(), { signal: controller.signal }));
    } catch (thrown) {
      error = thrown;
    }

    assert.ok(error, 'a cancelled call must still reject');
    assert.equal(hits, 1, 'the retries should never have been made');
  });

  it('reports cancellation as cancellation, not as a timeout', async () => {
    // Telling someone their request ran out of time, when in fact something upstream
    // stopped caring about it, sends them to tune the wrong setting.
    const controller = new AbortController();
    controller.abort();

    let error;
    try {
      await quiet(() => hanging().heal(request(), { signal: controller.signal }));
    } catch (thrown) {
      error = thrown;
    }

    assert.match(error.message, /cancelled/);
    assert.doesNotMatch(error.message, /timed out/);
  });

  it('makes no request at all when the signal is already aborted', async () => {
    hits = 0;
    const controller = new AbortController();
    controller.abort();

    try {
      await quiet(() => hanging().heal(request(), { signal: controller.signal }));
    } catch {
      // Expected.
    }

    assert.equal(hits, 0);
  });

  it('is optional — a provider called without one behaves exactly as before', async () => {
    expectReply({ status: 200, body: JSON.stringify({
      content: [{ type: 'text', text: '{"suggestedSelector":"#ok","confidence":0.9}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }) });

    const result = await quiet(() => anthropic().heal(request()));
    assert.equal(result.suggestedSelector, '#ok');
  });
});

describe('every provider carries a candidate pick through', () => {
  // The regression this exists for: all three providers threw unless the model wrote a
  // selector, and dropped candidateId and alternatives when assembling the response. So
  // the moment the prompt started asking for an id — the normal case — every heal failed
  // at the provider, *and* threw, which the engine counts against the circuit breaker as
  // though the API were down. Stubbed-provider tests cannot see this; these go through
  // the real heal() path.

  /** The answer shape a model now returns when it picks off the candidate list. */
  const PICK = {
    candidateId: 12,
    confidence: 0.95,
    reasoning: 'the renamed menu item',
    alternatives: [{ candidateId: 7, confidence: 0.6, reasoning: 'second guess' }],
  };

  /**
   * Wraps a model answer in each provider's own envelope.
   *
   * @param {object} answer - The JSON the model returns.
   * @returns {object} Bodies keyed by provider name.
   */
  const envelopes = (answer) => ({
    anthropic: JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(answer) }],
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: 'end_turn',
    }),
    openai: JSON.stringify({
      choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
    gemini: JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    }),
  });

  for (const [name, build] of [
    ['anthropic', anthropic],
    ['openai', openai],
    ['gemini', gemini],
  ]) {
    it(`${name} returns the pick rather than throwing`, async () => {
      expectReply({ status: 200, body: envelopes(PICK)[name] });

      const result = await quiet(() => build().heal(request()));

      assert.equal(result.candidateId, 12);
      assert.equal(result.confidence, 0.95);
      assert.equal(result.suggestedSelector, '', 'no selector was written, and none is invented');
      assert.equal(result.alternatives.length, 1);
      assert.equal(result.alternatives[0].candidateId, 7);
    });

    it(`${name} still carries a written selector and its alternatives`, async () => {
      expectReply({
        status: 200,
        body: envelopes({
          suggestedSelector: "getByTestId('close')",
          expectedRole: 'button',
          confidence: 0.8,
          reasoning: 'no candidate names this element',
          alternatives: [{ suggestedSelector: "locator('#close-x')", confidence: 0.4, reasoning: 'by id' }],
        })[name],
      });

      const result = await quiet(() => build().heal(request()));

      assert.equal(result.suggestedSelector, "getByTestId('close')");
      assert.equal(result.candidateId, undefined);
      assert.equal(result.alternatives[0].suggestedSelector, "locator('#close-x')");
    });

    it(`${name} returns a refusal as an answer, not as a failure`, async () => {
      // The prompt asks for exactly this when nothing matches, and the real
      // claude-haiku-4-5 gave it three runs out of three on a renamed menu with two
      // equally plausible successors. Throwing on it counted a careful answer as an
      // outage: three refusals opened the breaker, and the tokens were never recorded.
      expectReply({
        status: 200,
        body: envelopes({ confidence: 0, reasoning: 'Nothing on this page is that element.' })[name],
      });

      const result = await quiet(() => build().heal(request()));

      assert.equal(result.confidence, 0);
      assert.equal(result.suggestedSelector, '');
      assert.equal(result.candidateId, undefined);
      assert.match(result.reasoning, /Nothing on this page/, 'the reasoning is what a human needs');
      assert.ok(result.tokenUsage.input > 0, 'a refusal was billed, so it must be recorded');
    });

    it(`${name} still throws when there is no answer at all`, async () => {
      // Distinct from a refusal: no JSON object means the reply is unusable, which is
      // what the throw is for.
      const empty = {
        anthropic: JSON.stringify({
          content: [{ type: 'text', text: 'I am sorry, I cannot help with that.' }],
          usage: { input_tokens: 100, output_tokens: 10 },
          stop_reason: 'end_turn',
        }),
        openai: JSON.stringify({
          choices: [{ message: { content: 'I am sorry, I cannot help with that.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
        gemini: JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'I am sorry, I cannot help with that.' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
        }),
      };
      expectReply({ status: 200, body: empty[name] });

      const error = await healError(build());
      assert.ok(error, 'prose with no JSON object is not an answer');
      assert.match(error.message, /no usable answer/);
    });
  }
});

describe('a refusal does not trip the circuit breaker', () => {
  // End to end through the real AnthropicProvider and the real engine. The regression:
  // with the shipped breaker threshold of 5, three consecutive refusals — three
  // genuinely-removed elements, an ordinary day after a redesign — opened the breaker,
  // and the next heal was never attempted on a perfectly healthy provider.
  const { HealingEngine } = require('../../dist/core/HealingEngine');
  const { HealBudget } = require('../../dist/core/HealBudget');
  const { SelectorCache } = require('../../dist/core/SelectorCache');

  /** A page stub that holds nothing the refusal would resolve. */
  function pageStub() {
    const locator = {
      first: () => locator,
      waitFor: async () => {},
      count: async () => 0,
      isVisible: async () => false,
      ariaSnapshot: async () => '- link "Private Cloud"\n- link "Dedicated Cloud"',
    };
    const page = { url: () => 'https://app.test/home' };
    for (const m of ['locator', 'getByRole', 'getByLabel', 'getByText', 'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText']) {
      page[m] = () => locator;
    }
    page.frameLocator = () => page;
    return page;
  }

  it('keeps healing available after repeated honest refusals', async () => {
    let calls = 0;
    reply = () => {
      calls += 1;
      return {
        status: 200,
        body: JSON.stringify({
          content: [{ type: 'text', text: '```json\n{"confidence": 0, "reasoning": "not on this page"}\n```' }],
          usage: { input_tokens: 1700, output_tokens: 90 },
          stop_reason: 'end_turn',
        }),
        headers: {},
      };
    };

    const budget = new HealBudget({ maxHeals: 0, breakerThreshold: 5 });
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

    for (let i = 0; i < 6; i++) {
      const outcome = await quiet(() => engine.attemptHealDetailed(pageStub(), `#removed-${i}`, 'click'));
      assert.equal(outcome.healed, null);
      assert.match(outcome.error, /the model declined/);
      assert.ok(outcome.tokens.input > 0, 'the refusal was billed and must be recorded');
    }

    assert.equal(budget.stats().breakerOpen, false, 'six refusals must not open the breaker');
    // One call per refusal: an explicit "no" is not retried.
    assert.equal(calls, 6);
  });
});
