/**
 * Unit tests for the privacy guard.
 *
 * These run against `dist/`, with Node's built-in test runner — no browser, no API
 * key, no network, no extra dependency. That matters: a privacy control only stays
 * correct if checking it is cheap enough to run on every commit.
 *
 *   npm run test:unit
 *
 * The core of the file is a **leak corpus**: a page snapshot seeded with values that
 * must never reach a provider. Rather than asserting on the redacted output's exact
 * shape — which would break every time a pattern is tuned — the important tests assert
 * the property that actually matters: *none of these strings appear in the payload*.
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const path = require('node:path');

const { PrivacyGuard, PrivacyBlockedError } = require('../../dist/core/PrivacyGuard');

/**
 * Values that must never survive redaction.
 *
 * Split by whether pattern matching can be expected to catch them. Structured
 * identifiers have a shape a regex can find; the second group does not, which is the
 * whole reason `strict` exists.
 */
const STRUCTURED = [
  'patient.zero@hospital.example.com',
  '123-45-6789',
  '4111 1111 1111 1111',
  '884213701',
  '1970-03-11',
  '550e8400-e29b-41d4-a716-446655440000',
];

const UNSTRUCTURED = ['Smith, John', 'Dr Amara Okonkwo', '14 Beckford Lane'];

/** A realistic snapshot: interface chrome plus a table of records. */
const SNAPSHOT = [
  '- banner:',
  '  - heading "Patient record" [level=1]',
  '- main:',
  '  - table:',
  '    - row "Smith, John 1970-03-11 884213701":',
  '      - cell "Smith, John"',
  '      - cell "1970-03-11"',
  '      - cell "884213701"',
  '  - paragraph: Referred by Dr Amara Okonkwo of 14 Beckford Lane',
  '  - textbox "Email address": patient.zero@hospital.example.com',
  '  - text: SSN on file 123-45-6789, card 4111 1111 1111 1111',
  '  - link "550e8400-e29b-41d4-a716-446655440000"',
  '  - button "Place order"',
].join('\n');

/**
 * Builds a request whose every free-text field carries the leak corpus, so a channel
 * that is not redacted shows up as a failure rather than going unnoticed.
 *
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} A HealingRequest.
 */
function request(overrides = {}) {
  return {
    originalSelector: '#place-order-btn',
    originalAction: 'click',
    ariaSnapshot: SNAPSHOT,
    pageUrl: 'https://app.example.com/patients/884213701?mrn=884213701&token=abc123',
    testFile: 'tests/checkout.spec.ts',
    testLine: 42,
    description: 'the button that submits the order',
    // Playwright quotes matched element text in strict-mode violations, so an error
    // message is page content in disguise. It must be scrubbed like everything else.
    error:
      'locator.click: strict mode violation: resolved to 2 elements: ' +
      '"Smith, John 1970-03-11" and "patient.zero@hospital.example.com"',
    ...overrides,
  };
}

/**
 * Everything a request would transmit, flattened into one string.
 *
 * @param {object} outbound - A sanitized request.
 * @returns {string} Every transmitted field concatenated.
 */
function transmitted(outbound) {
  return JSON.stringify(outbound);
}

describe('PrivacyGuard — defaults', () => {
  it('defaults to identifiers rather than off', () => {
    // The single most important default in this module. If a guard built with no
    // arguments transmitted everything, every code path that forgets to pass a policy
    // would be a leak.
    assert.equal(new PrivacyGuard().level, 'identifiers');
  });

  it('allows every route when no route policy is set', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers' });
    assert.equal(guard.checkUrl('https://anything.example.com/any/path').allowed, true);
    // Backwards compatibility: an unparseable URL is fine when nothing is restricted.
    assert.equal(guard.checkUrl('').allowed, true);
  });
});

describe('PrivacyGuard — redact: off', () => {
  it('transmits the page unchanged', () => {
    const guard = new PrivacyGuard({ redact: 'off' });
    const outbound = guard.sanitizeRequest(request());
    assert.equal(outbound.ariaSnapshot, SNAPSHOT);
  });

  it('leaves the URL query string intact', () => {
    // Dropping the query is part of `identifiers`, not something `off` should do.
    const guard = new PrivacyGuard({ redact: 'off' });
    assert.match(guard.sanitizeRequest(request()).pageUrl, /token=abc123/);
  });

  it('still applies the caller\'s own patterns', () => {
    // `off` disables this package's built-in rules, not the caller's instructions. A
    // configured pattern that silently stopped applying is the failure to avoid.
    const guard = new PrivacyGuard({
      redact: 'off',
      customPatterns: [/\bMRN\d{4}\b/g],
    });

    const out = guard.sanitizeRequest(request({ ariaSnapshot: '- cell "MRN8841"' }));
    assert.ok(!out.ariaSnapshot.includes('MRN8841'));
    // But the built-ins are genuinely off.
    const untouched = guard.sanitizeRequest(request());
    assert.ok(untouched.ariaSnapshot.includes('patient.zero@hospital.example.com'));
  });

  it('still refuses to transmit a screenshot', () => {
    // `off` governs redaction, not the image channel. Pixels require a deliberate
    // change to the guard, not merely a permissive redaction level.
    const guard = new PrivacyGuard({ redact: 'off' });
    const outbound = guard.sanitizeRequest(request({ screenshot: Buffer.from('png') }));
    assert.equal(outbound.screenshot, undefined);
  });
});

describe('PrivacyGuard — redact: identifiers', () => {
  const guard = new PrivacyGuard({ redact: 'identifiers' });

  for (const secret of STRUCTURED) {
    it(`removes ${JSON.stringify(secret)} from every transmitted field`, () => {
      const payload = transmitted(guard.sanitizeRequest(request()));
      assert.ok(!payload.includes(secret), `"${secret}" survived redaction`);
    });
  }

  it('drops the URL query string, which is where tokens live', () => {
    const { pageUrl } = guard.sanitizeRequest(request());
    assert.ok(!pageUrl.includes('token=abc123'));
    assert.ok(!pageUrl.includes('mrn='));
    // The origin and path shape survive, because they orient the model at no real cost.
    assert.ok(pageUrl.startsWith('https://app.example.com/patients/'));
  });

  it('scrubs the Playwright error message', () => {
    const { error } = guard.sanitizeRequest(request());
    assert.ok(!error.includes('patient.zero@hospital.example.com'));
    assert.ok(!error.includes('1970-03-11'));
    // The diagnostic value of the message is preserved.
    assert.ok(error.includes('strict mode violation'));
  });

  it('keeps the healing signal — actionable names survive', () => {
    const { ariaSnapshot } = guard.sanitizeRequest(request());
    assert.ok(ariaSnapshot.includes('button "Place order"'));
    assert.ok(ariaSnapshot.includes('textbox "Email address"'));
  });

  it('does not pretend to catch names, and says so by failing here', () => {
    // Documents the known limit rather than hiding it: at this level a name goes out.
    // If this assertion ever flips, the docs claiming otherwise need updating too.
    const payload = transmitted(guard.sanitizeRequest(request()));
    assert.ok(payload.includes('Smith, John'), 'identifiers level is documented as not catching names');
  });

  it('leaves prices, quantities and years alone', () => {
    // Over-redaction is a real failure: scrub the interface and healing stops working,
    // and a control people switch off protects nothing.
    const guard2 = new PrivacyGuard({ redact: 'identifiers' });
    const out = guard2.sanitizeRequest(
      request({ ariaSnapshot: '- cell "£161.00"\n- cell "2"\n- heading "Orders 2026"' })
    );
    assert.ok(out.ariaSnapshot.includes('£161.00'));
    assert.ok(out.ariaSnapshot.includes('Orders 2026'));
  });
});

describe('PrivacyGuard — redact: strict', () => {
  const guard = new PrivacyGuard({ redact: 'strict' });

  for (const secret of [...STRUCTURED, ...UNSTRUCTURED]) {
    it(`removes ${JSON.stringify(secret)}, including free text`, () => {
      const payload = transmitted(guard.sanitizeRequest(request()));
      assert.ok(!payload.includes(secret), `"${secret}" survived strict redaction`);
    });
  }

  it('keeps roles, nesting and actionable names so healing still works', () => {
    const { ariaSnapshot } = guard.sanitizeRequest(request());

    assert.ok(ariaSnapshot.includes('button "Place order"'), 'button name is the healing signal');
    assert.ok(ariaSnapshot.includes('textbox "Email address"'), 'field label is the healing signal');
    assert.ok(ariaSnapshot.includes('- table:'), 'tree shape survives');
    assert.ok(ariaSnapshot.includes('[level=1]'), 'structural attributes survive');
    assert.ok(/^\s+- cell "‹redacted›"$/m.test(ariaSnapshot), 'data cells are collapsed');
  });

  it("collapses an actionable element's value but keeps its label", () => {
    // A textbox's label is interface chrome; its value is whatever the user typed.
    const { ariaSnapshot } = guard.sanitizeRequest(request());
    assert.ok(ariaSnapshot.includes('textbox "Email address": ‹redacted›'));
  });

  it('does not leave a bare container line looking like it had a value', () => {
    const { ariaSnapshot } = guard.sanitizeRequest(request());
    assert.ok(ariaSnapshot.includes('- main:'));
    assert.ok(!ariaSnapshot.includes('- main: ‹redacted›'));
  });

  it('redacts the DOM-scan fallback, including typed input values', () => {
    // The fallback captures element.value, so a half-filled form there is raw user
    // input rather than rendered page text — the more dangerous of the two formats.
    const scan = [
      '<input id="customer-email-v3" name="email" type="email"> patient.zero@hospital.example.com',
      '<a href="/patients/884213701/edit"> Smith, John',
      '<button id="submit-order-v3"> Place order',
    ].join('\n');

    const { ariaSnapshot } = guard.sanitizeRequest(request({ ariaSnapshot: scan }));

    assert.ok(!ariaSnapshot.includes('patient.zero@hospital.example.com'));
    assert.ok(!ariaSnapshot.includes('Smith, John'));
    assert.ok(!ariaSnapshot.includes('/patients/884213701/edit'));
    // Selector-bearing attributes are what healing needs, and they survive.
    assert.ok(ariaSnapshot.includes('id="customer-email-v3"'));
    assert.ok(ariaSnapshot.includes('name="email"'));
  });

  it('redacts quoted content on lines it cannot parse', () => {
    const odd = 'something entirely unexpected "Smith, John" trailing';
    const { ariaSnapshot } = guard.sanitizeRequest(request({ ariaSnapshot: odd }));
    assert.ok(!ariaSnapshot.includes('Smith, John'));
  });
});

describe('PrivacyGuard — the test location', () => {
  // The engine reads this off a stack trace, so it arrives absolute. Sending it whole put
  // the account name and the organisation name in the prompt on every heal —
  // `D:\Users\<account>\OneDrive - <organisation>\…` — which is real disclosure for no
  // benefit: the model reasons about the page, not the filesystem.
  const inside = path.join(process.cwd(), 'tests', 'checkout.spec.ts');

  it('sends a project-relative path, not the absolute one', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers' });
    const out = guard.sanitizeRequest(request({ testFile: inside }));

    assert.equal(out.testFile, 'tests/checkout.spec.ts');
    assert.ok(!out.testFile.includes(process.cwd()));
  });

  it('normalises at every level, off included — this is not redaction', () => {
    // `off` means "do not apply my built-in redaction rules". The relative path is simply
    // the better value to send, so it does not depend on a policy.
    for (const redact of ['off', 'identifiers', 'strict']) {
      const out = new PrivacyGuard({ redact }).sanitizeRequest(request({ testFile: inside }));
      assert.equal(out.testFile, 'tests/checkout.spec.ts', redact);
    }
  });

  it('uses forward slashes, so a location reads the same on Windows and in CI', () => {
    const out = new PrivacyGuard().sanitizeRequest(request({ testFile: inside }));
    assert.ok(!out.testFile.includes('\\'));
  });

  it('leaves a path outside the project alone rather than growing .. segments', () => {
    const outside = path.resolve(process.cwd(), '..', 'elsewhere', 'shared.spec.ts');
    const out = new PrivacyGuard().sanitizeRequest(request({ testFile: outside }));

    assert.equal(out.testFile, outside);
  });

  it("passes the engine's own fallbacks through untouched", () => {
    const out = new PrivacyGuard().sanitizeRequest(request({ testFile: 'unknown' }));
    assert.equal(out.testFile, 'unknown');
  });

  it('offers the redactor a testFile field, so a caller can strip it entirely', () => {
    const seen = [];
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      redactor: (value, context) => {
        seen.push(context.field);
        return context.field === 'testFile' ? '‹withheld›' : value;
      },
    });

    const out = guard.sanitizeRequest(request({ testFile: inside }));

    assert.ok(seen.includes('testFile'));
    assert.equal(out.testFile, '‹withheld›');
  });
});

describe('PrivacyGuard — route policy', () => {
  it('treats allowedOrigins as an allowlist', () => {
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      allowedOrigins: ['https://cleared.example.com'],
    });

    assert.equal(guard.checkUrl('https://cleared.example.com/cart').allowed, true);
    assert.equal(guard.checkUrl('https://other.example.com/cart').allowed, false);
    // Same host, different scheme is a different origin.
    assert.equal(guard.checkUrl('http://cleared.example.com/cart').allowed, false);
  });

  it('supports a bare host and a subdomain wildcard', () => {
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      allowedOrigins: ['*.internal.example.com'],
    });

    assert.equal(guard.checkUrl('https://app.internal.example.com/x').allowed, true);
    assert.equal(guard.checkUrl('https://internal.example.com/x').allowed, true);
    assert.equal(guard.checkUrl('https://internal.example.com.evil.test/x').allowed, false);
  });

  it('lets a blocked path override an allowed origin', () => {
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      allowedOrigins: ['https://app.example.com'],
      blockedPaths: ['/patients/**'],
    });

    assert.equal(guard.checkUrl('https://app.example.com/cart').allowed, true);
    assert.equal(guard.checkUrl('https://app.example.com/patients/8841/edit').allowed, false);
    // A trailing /** covers the bare prefix too — the route people most want blocked.
    assert.equal(guard.checkUrl('https://app.example.com/patients').allowed, false);
  });

  it('fails closed on a URL it cannot parse', () => {
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      allowedOrigins: ['https://app.example.com'],
    });

    // "I cannot tell whether this page is cleared" must mean "do not send it".
    assert.equal(guard.checkUrl('').allowed, false);
    assert.equal(guard.checkUrl('about:blank').allowed, false);
    assert.equal(guard.checkUrl('not a url at all').allowed, false);
  });

  it('matches a single-segment glob without crossing segments', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers', blockedPaths: ['/reports/*'] });

    assert.equal(guard.checkUrl('https://a.test/reports/summary').allowed, false);
    assert.equal(guard.checkUrl('https://a.test/reports/2026/summary').allowed, true);
  });
});

describe('PrivacyGuard — custom redactor', () => {
  it('applies the callback after pattern redaction', () => {
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      redactor: (text) => text.replace(/Smith, John/g, '‹name›'),
    });

    const payload = transmitted(guard.sanitizeRequest(request()));
    assert.ok(!payload.includes('Smith, John'));
  });

  it('blocks transmission when the callback vetoes', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers', redactor: () => null });

    assert.throws(() => guard.sanitizeRequest(request()), PrivacyBlockedError);
  });

  it('blocks transmission when the callback throws', () => {
    // A redactor that crashes is not evidence that the text is safe.
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      redactor: () => {
        throw new Error('classifier unavailable');
      },
    });

    assert.throws(() => guard.sanitizeRequest(request()), PrivacyBlockedError);
  });

  it('blocks transmission when the callback returns the wrong type', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers', redactor: () => 42 });

    assert.throws(() => guard.sanitizeRequest(request()), PrivacyBlockedError);
  });

  it('runs even at redact: off, so a callback is never silently skipped', () => {
    const guard = new PrivacyGuard({ redact: 'off', redactor: () => null });
    assert.throws(() => guard.sanitizeRequest(request()), PrivacyBlockedError);
  });

  it('is offered every field, including the URL', () => {
    // Every declared RedactionField must actually occur, or a caller writing a
    // field-specific rule would find it silently never fires.
    const seen = new Set();
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      redactor: (text, { field }) => {
        seen.add(field);
        return text;
      },
    });

    guard.sanitizeRequest(request());

    assert.deepEqual(
      [...seen].sort(),
      ['description', 'error', 'selector', 'snapshot', 'testFile', 'url']
    );
  });

  it('receives the real page URL as context, not the redacted one', () => {
    // A per-route decision needs the actual address; handing it the scrubbed version
    // would make `isRestricted(pageUrl)` unreliable exactly where it matters.
    let seenContext = null;
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      redactor: (text, context) => {
        seenContext = context;
        return text;
      },
    });

    guard.sanitizeRequest(request());
    assert.equal(seenContext.pageUrl, 'https://app.example.com/patients/884213701?mrn=884213701&token=abc123');
  });
});

describe('PrivacyGuard — custom patterns', () => {
  it('applies patterns from the policy', () => {
    const guard = new PrivacyGuard({
      redact: 'identifiers',
      customPatterns: [/\bMRN[0-9]{4}\b/g],
    });

    const out = guard.sanitizeRequest(request({ ariaSnapshot: '- cell "MRN8841"' }));
    assert.ok(!out.ariaSnapshot.includes('MRN8841'));
  });

  it('replaces every occurrence, not just the first', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers', customPatterns: [/secretword/g] });
    const out = guard.sanitizeRequest(
      request({ ariaSnapshot: '- text: secretword secretword secretword' })
    );
    assert.ok(!out.ariaSnapshot.includes('secretword'));
  });
});

describe('PrivacyGuard — reporting', () => {
  it('describes the policy in one line', () => {
    const guard = new PrivacyGuard({
      redact: 'strict',
      allowedOrigins: ['https://a.test'],
      blockedPaths: ['/x/**'],
      snapshotRoot: '#form',
    });

    const described = guard.describe();
    assert.match(described, /redact=strict/);
    assert.match(described, /1 allowed origin/);
    assert.match(described, /1 blocked path/);
    assert.match(described, /root=#form/);
  });

  it('announces preview mode, because no heal can succeed in it', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers', previewDir: './preview' });
    assert.equal(guard.previewOnly, true);
    assert.match(guard.describe(), /PREVIEW ONLY/);
  });
});

describe('PrivacyGuard — selectors coming back from the model', () => {
  it('is a no-op at redact: off', () => {
    const guard = new PrivacyGuard({ redact: 'off' });
    assert.equal(guard.redactSelector("getByText('Smith, John')"), "getByText('Smith, John')");
  });

  it('strips structured identifiers at identifiers level', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers' });
    assert.ok(!guard.redactSelector("getByText('a@b.example.com')").includes('a@b.example.com'));
  });

  it('leaves an ordinary selector untouched at identifiers level', () => {
    // Almost always a no-op: a selector rarely contains a structured identifier, so this
    // must not mangle the rewrite people are meant to paste back.
    const guard = new PrivacyGuard({ redact: 'identifiers' });
    for (const selector of ["getByTestId('checkout')", '#place-order-btn', "getByRole('button', { name: 'Place order' })"]) {
      assert.equal(guard.redactSelector(selector), selector);
    }
  });

  it('collapses quoted content at strict, because that is where a name sits', () => {
    const guard = new PrivacyGuard({ redact: 'strict' });
    const out = guard.redactSelector("getByText('Smith, John')");

    assert.ok(!out.includes('Smith, John'));
    // The shape survives, so the log line still says what kind of selector it was.
    assert.match(out, /^getByText\('/);
  });

  it('leaves a selector with no quoted part alone even at strict', () => {
    assert.equal(new PrivacyGuard({ redact: 'strict' }).redactSelector('#place-order-btn'), '#place-order-btn');
  });

  it('handles an empty selector', () => {
    assert.equal(new PrivacyGuard({ redact: 'strict' }).redactSelector(''), '');
  });
});

describe('redactMessage / redactName — the text beside the selector', () => {
  // Redacting selectors was only half the surface. A heal rejected on intent reports why,
  // and the why quotes the element the model landed on. That reason reaches the
  // heal-failed annotation, the report attachment and the run summary in CI stdout — the
  // same three places a healed selector reaches, with the same readership.
  const REASON =
    'the suggestion was described as "Place order" but resolves to "Smith, John 1970-03-11"';

  it('leaves both alone at off', () => {
    const guard = new PrivacyGuard({ redact: 'off' });
    assert.equal(guard.redactMessage(REASON), REASON);
    assert.equal(guard.redactName('Smith, John'), 'Smith, John');
  });

  it('strips structured identifiers at identifiers level', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers' });
    assert.ok(!guard.redactMessage(REASON).includes('1970-03-11'));
    assert.ok(!guard.redactName('Smith, John 1970-03-11').includes('1970-03-11'));
  });

  it('cannot catch a bare name at identifiers level, and says so by leaving it', () => {
    // Documented behaviour, asserted so nobody assumes more protection than exists.
    const guard = new PrivacyGuard({ redact: 'identifiers' });
    assert.equal(guard.redactName('Smith, John'), 'Smith, John');
  });

  it('collapses the quoted payload of a reason at strict, keeping the diagnosis', () => {
    const out = new PrivacyGuard({ redact: 'strict' }).redactMessage(REASON);

    assert.ok(!out.includes('Smith, John'));
    assert.ok(!out.includes('Place order'));
    // The diagnosis is what makes the message worth reading at all.
    assert.match(out, /described as .* but resolves to/);
  });

  it('collapses a name wholesale at strict — there is no prose around it to keep', () => {
    const guard = new PrivacyGuard({ redact: 'strict' });
    assert.ok(!guard.redactName('Smith, John').includes('Smith'));
    assert.ok(!guard.redactName('Place order').includes('Place'));
  });

  it('does not mangle a name containing an apostrophe', () => {
    // The earlier trick wrapped the name in quotes to borrow redactSelector's collapse,
    // which turned O'Brien into a half-redacted fragment.
    const guard = new PrivacyGuard({ redact: 'identifiers' });
    assert.equal(guard.redactName("O'Brien, Sean"), "O'Brien, Sean");
  });

  it('redacts an identifier out of a blocked-path reason', () => {
    const guard = new PrivacyGuard({ redact: 'identifiers' });
    const out = guard.redactMessage('page path "/patients/884213701" matches "/patients/**"');

    assert.ok(!out.includes('884213701'));
  });

  it('handles empty input', () => {
    const guard = new PrivacyGuard({ redact: 'strict' });
    assert.equal(guard.redactMessage(''), '');
    assert.equal(guard.redactName(''), '');
  });

  it('redactSelector and redactMessage agree, since a selector is prose quoting data', () => {
    for (const level of ['off', 'identifiers', 'strict']) {
      const guard = new PrivacyGuard({ redact: level });
      const selector = "getByText('Smith, John')";
      assert.equal(guard.redactSelector(selector), guard.redactMessage(selector), level);
    }
  });
});
