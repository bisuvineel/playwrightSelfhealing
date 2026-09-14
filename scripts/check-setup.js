/**
 * Pre-flight check before spending API credit.
 *
 * By default this makes **no API call**. It reports where `.env` was found, what the
 * resolved configuration is, whether the key looks structurally valid, and what a run
 * would cost — so a misconfiguration surfaces for free rather than halfway through a
 * demo.
 *
 *   node scripts/check-setup.js           report only, zero cost
 *   node scripts/check-setup.js --call    plus one ~15-token call to prove the key works
 *
 * The `--call` form costs a fraction of a cent and is worth it once, before the first
 * real run.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WANTS_CALL = process.argv.includes('--call');

/**
 * Pricing, loaded from data rather than hardcoded here.
 *
 * These figures drift, and the estimate below is the number people use to decide whether
 * to run a suite — so a silently stale price is worse than none. `pricing.json` carries a
 * `lastVerified` date, printed beside every estimate and warned about once it is old
 * enough to be worth re-checking.
 */
function loadPricing() {
  const file = path.join(__dirname, 'pricing.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(`  (could not read ${file}: ${error.message} — cost estimates unavailable)`);
    return null;
  }
}

const PRICING = loadPricing();
const PRICES = PRICING?.models ?? {};
const PER_HEAL = PRICING?.perHealTokens ?? { input: 700, output: 90 };

/** Whole days since an ISO date, or null when it cannot be read. */
function daysSince(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

function line(label, value) {
  console.log(`  ${String(label).padEnd(22)} ${value}`);
}

/** Masks a credential so it can be shown safely. */
function mask(value) {
  if (!value) return '(not set)';
  if (value.length < 12) return '(set, but suspiciously short)';
  return `${value.slice(0, 7)}…${value.slice(-4)}  (${value.length} chars)`;
}

function main() {
  console.log('\nself-healing-playwright — setup check\n');

  // 1. Where is .env, and did it load?
  const envPath = path.join(ROOT, '.env');
  const envExists = fs.existsSync(envPath);

  console.log('.env');
  line('expected at', envPath);
  line('found', envExists ? 'yes' : 'NO — copy .env.example to .env');
  if (!envExists) {
    line('note', 'without it, only real process.env variables are used');
  }

  const { getConfig, ConfigError } = require(path.join(ROOT, 'dist', 'config.js'));

  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.log(`\n✘ configuration is invalid:\n  ${error.message}\n`);
    if (error instanceof ConfigError || error?.name === 'ConfigError') process.exitCode = 1;
    return;
  }

  // 2. What did it resolve to?
  console.log('\nhealing');
  line('enabled', config.healing.enabled);
  line('provider', config.healing.provider);
  line('threshold', config.healing.threshold);
  line('maxRetries', `${config.healing.maxRetries}  (worst case ${config.healing.maxRetries} calls per failed action)`);
  line('timeout', `${config.healing.timeout}ms per call`);
  line('cache', config.healing.cache);

  // The settings that decide what leaves the machine and whether a wrong heal is caught.
  // This is the free pre-flight people are told to run, so it has to show the controls
  // that matter — not just the ones that existed when it was written. Every line below
  // was invisible here until 0.4.2, including three whose defaults are safety decisions.
  console.log('\nsafety');
  line('redact', `${config.privacy.redact}${config.privacy.redact === 'off' ? '  ← page content is sent in full' : ''}`);
  line('snapshot root', config.privacy.snapshotRoot ?? 'body  (whole page)');
  line(
    'routes',
    config.privacy.allowedOrigins?.length || config.privacy.blockedPaths?.length
      ? `${config.privacy.allowedOrigins?.length ?? 0} allowed origin(s), ${config.privacy.blockedPaths?.length ?? 0} blocked path(s)`
      : 'every page  (no route policy set)'
  );
  line(
    'intent check',
    `${config.intent.mode}${config.intent.mode === 'off' ? '  ← a wrong element can pass' : ''}` +
      `  (unverified heals need confidence >= ${config.intent.unverifiedConfidence})`
  );
  line(
    'CI gate',
    config.healing.failOnHeal
      ? 'HEALER_FAIL_ON_HEAL is set — a heal fails the test'
      : 'off  (for CI set HEALER_FAIL_ON_HEAL=true in the CI environment, not in .env —' +
        ' dotenv does not expand ${VAR})'
  );
  if (config.privacy.previewDir) {
    line('preview', `${config.privacy.previewDir}  ← no provider is called, no heal can succeed`);
  }

  console.log('\nceilings  (per worker — multiply by your `workers` setting)');
  line(
    'max heals',
    config.healing.maxHeals > 0 ? `${config.healing.maxHeals} provider-backed heal(s)` : 'no ceiling'
  );
  line(
    'breaker',
    config.healing.breakerThreshold > 0
      ? `after ${config.healing.breakerThreshold} consecutive provider failure(s)`
      : 'disabled'
  );

  const provider = config.healing.provider;
  const section = provider === 'anthropic' ? config.anthropic : config[provider];
  const model = section?.model ?? '(unknown)';

  console.log(`\n${provider}`);
  line('model', model);
  line('api key', mask(section?.apiKey));

  if (provider === 'anthropic' && section?.apiKey && !section.apiKey.startsWith('sk-ant-')) {
    line('warning', 'key does not start with "sk-ant-" — is it the right one?');
  }

  // 3. What will it cost?
  const price = PRICES[model];
  console.log('\nestimated cost');
  if (!price) {
    line('per heal', `unknown — no price on file for "${model}"`);
    line('add one', 'scripts/pricing.json');
  } else {
    const perHeal =
      (PER_HEAL.input / 1e6) * price.input + (PER_HEAL.output / 1e6) * price.output;
    const currency = PRICING?.currency ?? 'USD';

    line('per heal', `$${perHeal.toFixed(5)}  (~${PER_HEAL.input} in / ${PER_HEAL.output} out tokens)`);
    line('demo suite (7 calls)', `$${(perHeal * 7).toFixed(4)}`);
    line('$10 buys roughly', `${Math.floor(10 / perHeal).toLocaleString()} heals`);

    // Always shown, so a reader can judge how much to trust the numbers above. These
    // figures are the ones people use to decide whether to run a suite, and a silently
    // stale price is worse than none.
    const age = daysSince(PRICING?.lastVerified);
    const stale = PRICING?.staleAfterDays ?? 120;

    line(
      'prices verified',
      age === null
        ? `${PRICING?.lastVerified ?? 'unknown'} (${currency})`
        : `${PRICING.lastVerified} — ${age} day${age === 1 ? '' : 's'} ago (${currency})`
    );

    if (age !== null && age > stale) {
      line('', `⚠ over ${stale} days old — re-check the provider's pricing page`);
      line('', '  and update scripts/pricing.json');
    }
  }

  // 4. Is the build current? The live spec imports from src, but scripts use dist.
  console.log('\nbuild');
  const distIndex = path.join(ROOT, 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) {
    line('dist', 'MISSING — run npm run build');
  } else {
    const newestSource = fs
      .readdirSync(path.join(ROOT, 'src'), { recursive: true })
      .filter((name) => String(name).endsWith('.ts'))
      .map((name) => fs.statSync(path.join(ROOT, 'src', String(name))).mtimeMs)
      .reduce((max, time) => Math.max(max, time), 0);

    const stale = newestSource > fs.statSync(distIndex).mtimeMs;
    line('dist', stale ? 'STALE — run npm run build' : 'up to date');
  }

  // 5. Network path. Node's fetch ignores HTTP_PROXY, so a proxied network fails in
  //    confusing ways — a 401 from a proxy looks exactly like a rejected API key.
  console.log('\nnetwork');
  const proxies = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  const set = proxies.filter((name) => process.env[name]);
  if (set.length === 0) {
    line('proxy env', 'none set — direct connection assumed');
  } else {
    for (const name of set) line(name, process.env[name]);
    line('warning', "Node's fetch ignores these; requests go direct and may be blocked");
  }
  line('endpoint', `${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1'}/messages`);

  // 6. Optionally prove the credential works.
  if (!WANTS_CALL) {
    console.log('\nNo API call was made. Add --call to verify the key with one ~15-token request.\n');
    return;
  }

  console.log('\nlive check (one minimal request)');
  probe(config, model).then((outcome) => {
    line('http status', outcome.status ?? '(no response)');
    line('verdict', outcome.verdict);
    if (outcome.body) line('response', outcome.body);
    if (!outcome.ok) process.exitCode = 1;
    console.log('');
  });
}

/**
 * Makes one minimal request and reports the raw result.
 *
 * Deliberately bypasses the provider's friendly error mapping: when someone is
 * debugging a credential, the HTTP status and the first line of the body are worth more
 * than an interpretation of them.
 *
 * @param config - Resolved framework configuration.
 * @param model - Model to call.
 * @returns Status, a verdict, and a short body preview.
 */
async function probe(config, model) {
  const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');

  let response;
  try {
    response = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      signal: AbortSignal.timeout(config.healing.timeout),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      verdict:
        error.name === 'TimeoutError'
          ? `✘ timed out after ${config.healing.timeout}ms — network or proxy is blocking the request`
          : `✘ could not connect: ${error.message}`,
    };
  }

  const text = await response.text();
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 160);

  if (response.ok) {
    return { ok: true, status: response.status, verdict: '✔ the key and model work', body: preview };
  }

  let isAnthropic = false;
  try {
    const parsed = JSON.parse(text);
    isAnthropic = parsed?.type === 'error' || typeof parsed?.error?.type === 'string';
  } catch {
    isAnthropic = false;
  }

  const verdict = !isAnthropic
    ? '✘ this response did not come from the Anthropic API — a proxy or gateway answered'
    : response.status === 401
      ? '✘ Anthropic rejected the key (401) — check for truncation; a real key is ~100+ chars'
      : response.status === 404
        ? `✘ model "${model}" not found for this key`
        : `✘ HTTP ${response.status} from Anthropic`;

  return { ok: false, status: response.status, verdict, body: preview };
}

main();
