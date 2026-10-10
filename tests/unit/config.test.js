/**
 * Unit tests for configuration parsing.
 *
 * `getConfig()` is the front door: every setting the package has arrives through it, and a
 * misread there is invisible until healing behaves oddly halfway through a suite. The
 * defaults matter most — three of them were chosen deliberately to be strict, and a silent
 * flip to permissive is exactly the regression nobody would notice.
 *
 * Every test runs with `HEALER_SKIP_DOTENV=1` and a cleared environment, so a developer's
 * own `.env` cannot change the result.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getConfig, ConfigError, isHealingEnabled, isFailOnHeal, getModel, getProviderType } =
  require('../../dist/config');

/** Variables these tests set, cleared between cases. */
const OWNED = [
  'HEALER_ENABLED', 'HEALER_PROVIDER', 'HEALER_THRESHOLD', 'HEALER_MAX_RETRIES',
  'HEALER_TIMEOUT', 'HEALER_CACHE', 'HEALER_FAIL_ON_HEAL', 'HEALER_REDACT',
  'HEALER_REDACT_PATTERNS_FILE', 'HEALER_ALLOWED_ORIGINS', 'HEALER_BLOCKED_PATHS',
  'HEALER_SNAPSHOT_ROOT', 'HEALER_PRIVACY_PREVIEW', 'HEALER_INTENT_CHECK',
  'HEALER_CANDIDATES', 'HEALER_MAX_SNAPSHOT_CHARS',
  'HEALER_UNVERIFIED_CONFIDENCE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'BROWSER', 'HEADLESS', 'SHOW_BROWSER', 'LOG_LEVEL',
];

let saved;
let dir;

beforeEach(() => {
  saved = {};
  for (const name of OWNED) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  // The module loads `.env` lazily and only once, but a developer's file must never
  // influence these assertions.
  process.env.HEALER_SKIP_DOTENV = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-config-'));
});

afterEach(() => {
  for (const name of OWNED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the strict defaults', () => {
  it('redacts, checks intent, and caches — but does not gate the build', () => {
    // The three that were chosen deliberately. A silent flip of any of the first two to
    // permissive is the regression that would go unnoticed longest.
    const config = getConfig();

    assert.equal(config.privacy.redact, 'identifiers', 'page content would be sent in full');
    assert.equal(config.intent.mode, 'enforce', 'wrong-element heals would be accepted');
    assert.equal(config.intent.unverifiedConfidence, 0.9);
    assert.equal(config.healing.cache, true);

    // Off by default on purpose: right for CI, wrong while writing tests.
    assert.equal(config.healing.failOnHeal, false);
  });

  it('leaves routes unrestricted so an upgrade does not stop healing', () => {
    const config = getConfig();
    assert.equal(config.privacy.allowedOrigins, undefined);
    assert.equal(config.privacy.blockedPaths, undefined);
    assert.equal(config.privacy.snapshotRoot, undefined);
    assert.equal(config.privacy.previewDir, undefined);
  });

  it('keeps the documented healing defaults', () => {
    const config = getConfig();
    assert.equal(config.healing.enabled, true);
    assert.equal(config.healing.provider, 'anthropic');
    assert.equal(config.healing.threshold, 0.7);
    assert.equal(config.healing.maxRetries, 2);
    assert.equal(config.healing.timeout, 30000);
    // The dated snapshot rather than the alias, so heal decisions do not change on an
    // unchanged commit when the alias moves.
    assert.equal(config.anthropic.model, 'claude-haiku-4-5-20251001');
  });
});

describe('booleans', () => {
  it('accepts the documented spellings in any casing', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      process.env.HEALER_FAIL_ON_HEAL = value;
      assert.equal(getConfig().healing.failOnHeal, true, value);
    }
    for (const value of ['false', 'FALSE', '0', 'no', 'off']) {
      process.env.HEALER_FAIL_ON_HEAL = value;
      assert.equal(getConfig().healing.failOnHeal, false, value);
    }
  });

  it('rejects anything else, naming the variable and the allowed values', () => {
    process.env.HEALER_ENABLED = 'perhaps';
    assert.throws(() => getConfig(), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /HEALER_ENABLED/);
      assert.match(error.message, /true/);
      assert.match(error.message, /perhaps/);
      return true;
    });
  });

  it('treats a blank value as unset rather than false', () => {
    process.env.HEALER_ENABLED = '   ';
    assert.equal(getConfig().healing.enabled, true);
  });
});

describe('numbers', () => {
  it('enforces the documented ranges', () => {
    const cases = [
      ['HEALER_THRESHOLD', '1.5'],
      ['HEALER_THRESHOLD', '-0.1'],
      ['HEALER_MAX_RETRIES', '11'],
      ['HEALER_TIMEOUT', '999'],
      ['HEALER_UNVERIFIED_CONFIDENCE', '2'],
    ];
    for (const [name, value] of cases) {
      process.env[name] = value;
      assert.throws(() => getConfig(), ConfigError, `${name}=${value} should be rejected`);
      delete process.env[name];
    }
  });

  it('rejects a non-number and says what it got', () => {
    process.env.HEALER_THRESHOLD = 'high';
    assert.throws(() => getConfig(), /HEALER_THRESHOLD must be a number \(got "high"\)/);
  });

  it('requires whole numbers where fractions make no sense', () => {
    process.env.HEALER_MAX_RETRIES = '1.5';
    assert.throws(() => getConfig(), /whole number/);
  });

  it('accepts the boundaries', () => {
    process.env.HEALER_THRESHOLD = '0';
    assert.equal(getConfig().healing.threshold, 0);
    process.env.HEALER_THRESHOLD = '1';
    assert.equal(getConfig().healing.threshold, 1);
  });
});

describe('enumerations', () => {
  it('accepts every documented level and mode', () => {
    for (const level of ['off', 'identifiers', 'strict']) {
      process.env.HEALER_REDACT = level;
      assert.equal(getConfig().privacy.redact, level);
    }
    for (const mode of ['off', 'warn', 'enforce']) {
      process.env.HEALER_INTENT_CHECK = mode;
      assert.equal(getConfig().intent.mode, mode);
    }
  });

  it('rejects an unknown value and lists the allowed ones', () => {
    process.env.HEALER_REDACT = 'paranoid';
    assert.throws(() => getConfig(), /HEALER_REDACT must be one of off, identifiers, strict/);
  });

  it('is case-insensitive', () => {
    process.env.HEALER_INTENT_CHECK = 'ENFORCE';
    assert.equal(getConfig().intent.mode, 'enforce');
  });
});

describe('lists', () => {
  it('splits on commas and trims', () => {
    process.env.HEALER_ALLOWED_ORIGINS = ' https://a.test , https://b.test ';
    assert.deepEqual(getConfig().privacy.allowedOrigins, ['https://a.test', 'https://b.test']);
  });

  it('drops empty entries rather than producing a blank rule', () => {
    // A blank origin would never match anything and would silently deny every page.
    process.env.HEALER_BLOCKED_PATHS = '/a/**,,/b/**,';
    assert.deepEqual(getConfig().privacy.blockedPaths, ['/a/**', '/b/**']);
  });
});

describe('credentials', () => {
  it('requires the selected provider to have one', () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.throws(() => getConfig(), (error) => {
      assert.match(error.message, /ANTHROPIC_API_KEY is not set/);
      assert.match(error.message, /switch HEALER_PROVIDER/, 'the message should name the alternative');
      return true;
    });
  });

  it('only checks the selected one, so one .env can hold several', () => {
    process.env.HEALER_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-openai';
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(getConfig().healing.provider, 'openai');
  });

  it('skips the check when healing is off, so a suite can run unhealed with no key', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.HEALER_ENABLED = 'false';
    assert.doesNotThrow(() => getConfig());
  });

  it('skips the check in preview mode, which makes no call', () => {
    // Requiring a credential to discover what gets transmitted would put the audit trail
    // behind the approval it exists to inform.
    delete process.env.ANTHROPIC_API_KEY;
    process.env.HEALER_PRIVACY_PREVIEW = './preview';
    assert.doesNotThrow(() => getConfig());
  });

  it('skips it for a caller-supplied preview directory too', () => {
    // `createHealingEngine({ previewDir })` is the programmatic form of the same setting,
    // and it was the one that failed: the environment variable is read here, an option is
    // not, so configuring preview mode in code demanded a key that would never be used.
    delete process.env.ANTHROPIC_API_KEY;
    assert.doesNotThrow(() => getConfig({ previewDir: './preview' }));
  });

  it('still demands a credential when no preview directory is in force', () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.throws(() => getConfig({}), ConfigError);
  });
});

describe('the redaction patterns file', () => {
  const write = (name, content) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, content);
    process.env.HEALER_REDACT_PATTERNS_FILE = target;
    return target;
  };

  it('compiles a plain array of regex strings', () => {
    write('p.json', JSON.stringify(['\\bMRN\\d{6}\\b']));
    const patterns = getConfig().privacy.customPatterns;
    assert.equal(patterns.length, 1);
    assert.ok(patterns[0] instanceof RegExp);
    assert.ok(patterns[0].global, 'a non-global pattern would only replace the first match');
  });

  it('compiles the object form and keeps the flags', () => {
    write('p.json', JSON.stringify([{ pattern: 'mrn\\d+', flags: 'i' }]));
    const [pattern] = getConfig().privacy.customPatterns;
    assert.ok(pattern.flags.includes('i'));
    assert.ok(pattern.flags.includes('g'), 'g must be forced on');
  });

  it('is a hard error when the file is missing', () => {
    // Silently ignoring it would mean believing patterns apply while nothing is redacted.
    process.env.HEALER_REDACT_PATTERNS_FILE = path.join(dir, 'absent.json');
    assert.throws(() => getConfig(), /could not be read/);
  });

  it('is a hard error on malformed content', () => {
    write('bad.json', 'not json');
    assert.throws(() => getConfig(), /not valid JSON/);

    write('obj.json', JSON.stringify({ pattern: 'x' }));
    assert.throws(() => getConfig(), /must hold a JSON array/);

    write('entry.json', JSON.stringify([42]));
    assert.throws(() => getConfig(), /expected a regex string/);

    write('regex.json', JSON.stringify(['[unclosed']));
    assert.throws(() => getConfig(), /invalid regex/);
  });

  it('is allowed alongside HEALER_REDACT=off, meaning "apply only my rules"', () => {
    write('p.json', JSON.stringify(['secret']));
    process.env.HEALER_REDACT = 'off';
    const config = getConfig();
    assert.equal(config.privacy.redact, 'off');
    assert.equal(config.privacy.customPatterns.length, 1);
  });
});

describe('browser flags', () => {
  it('lets a request to watch the browser win over headless', () => {
    process.env.HEADLESS = 'true';
    process.env.SHOW_BROWSER = 'true';
    assert.equal(getConfig().playwright.headless, false);
  });
});

describe('the cheap accessors', () => {
  it('read their variable directly, so they work when other settings are invalid', () => {
    process.env.HEALER_THRESHOLD = 'nonsense';

    assert.equal(isHealingEnabled(), true);
    assert.equal(isFailOnHeal(), false);
    assert.equal(getProviderType(), 'anthropic');
    assert.equal(getModel('anthropic'), 'claude-haiku-4-5-20251001');

    // The broken value still fails the full load, so it is not being ignored.
    assert.throws(() => getConfig(), ConfigError);
  });

  it('rejects an unknown provider by name', () => {
    assert.throws(() => getModel('claude'), /Unknown provider "claude"/);
  });
});

describe('preview mode through the programmatic API', () => {
  // Two ways to configure the same thing must behave the same way. `HEALER_PRIVACY_PREVIEW`
  // worked without a credential; `createHealingEngine({ previewDir })` did not, because the
  // credential check only ever saw the environment. The point of preview mode is to show
  // what would be transmitted *before* anyone has approved a key.
  const { createHealingEngine } = require('../../dist/core/TestWrapper');

  /** Silences the engine's "healing is unavailable" reporting. */
  function quiet(fn) {
    const s = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
      return fn();
    } finally {
      Object.assign(console, s);
    }
  }

  for (const provider of ['anthropic', 'openai', 'gemini']) {
    it(`builds an engine with no credential — ${provider}`, () => {
      delete process.env.ANTHROPIC_API_KEY;
      const engine = quiet(() => createHealingEngine({ provider, previewDir: './preview' }));

      assert.ok(engine, `${provider} should build in preview mode without a key`);
      assert.equal(engine.privacy.previewOnly, true);
    });
  }

  it('still refuses to build without a credential when not previewing', () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(quiet(() => createHealingEngine({ provider: 'anthropic' })), null);
  });

  it('prefers a real credential over the preview stand-in', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    const engine = quiet(() => createHealingEngine({ previewDir: './preview' }));

    assert.ok(engine);
    assert.equal(engine.privacy.previewOnly, true);
  });
});

describe('HEALER_CANDIDATES — the switch back to free-form authoring', () => {
  it('defaults to on, because it is what stops a correct answer becoming a bad locator', () => {
    assert.equal(getConfig().healing.candidates, true);
  });

  it('can be turned off without downgrading the package', () => {
    process.env.HEALER_CANDIDATES = 'false';
    assert.equal(getConfig().healing.candidates, false);
  });
});

describe('HEALER_MAX_SNAPSHOT_CHARS — the cost ceiling', () => {
  it('has a default, rather than leaving a data grid unbounded', () => {
    // Unbounded, a 2,000-row table sent about 83,000 input tokens per attempt, and a
    // larger one exceeded the model's context — which counts against the breaker.
    assert.equal(getConfig().healing.maxSnapshotChars, 40_000);
  });

  it('treats 0 as unlimited', () => {
    process.env.HEALER_MAX_SNAPSHOT_CHARS = '0';
    assert.equal(getConfig().healing.maxSnapshotChars, 0);
  });

  it('refuses a value that is not a number, naming the variable', () => {
    process.env.HEALER_MAX_SNAPSHOT_CHARS = 'lots';
    assert.throws(() => getConfig(), /HEALER_MAX_SNAPSHOT_CHARS/);
  });
});
