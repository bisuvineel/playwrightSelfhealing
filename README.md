# self-healing-playwright

AI-powered self-healing locators for Playwright. When a selector stops matching, the
failing action is paused, an accessibility snapshot of the page is sent to an AI model,
the suggested replacement is validated against the live DOM, and the action is retried.
If healing doesn't work, your original Playwright error is re-thrown unchanged.

- Works with **any** existing Playwright framework — healing is a fixture you compose
  into your own `test` object. See [INTEGRATION.md](INTEGRATION.md).
- **Zero runtime dependencies** beyond `dotenv`. All three providers (Claude, OpenAI,
  Gemini) call their REST APIs directly, so the package installs cleanly from a tarball
  on locked-down machines.
- Full audit trail: annotations and attachments in the Playwright HTML report, a
  run-level summary reporter, and an append-only `healing-records.json`.

## Try the demo

This repository ships a working page-object suite whose selectors are deliberately out of
date, so you can watch healing happen. **It calls a real provider, so it needs a real
key** — there is no simulated mode:

```bash
npm install
npx playwright install              # if you don't already have browsers

cp .env.example .env                # then add ANTHROPIC_API_KEY=sk-ant-...
npm run check:setup                 # confirms config and cost — makes NO API call
npm run check:key                   # one ~15-token call, proves the credential works

npx playwright test tests/checkout.spec.ts
```

```
  4 passed

  Self-healing summary
  ────────────────────────────────────────────
  healed: 13    failed: 0    blocked: 0

  Suggested source updates:
    #checkout-button                                       ->  getByTestId('checkout')
    #email-input                                           ->  getByLabel('Email address')
    #promo-field                                           ->  getByLabel('Promotion code')
    #accept-terms                                          ->  getByRole('checkbox')
    #place-order-btn                                       ->  getByRole('button', { name: 'Place order' })
    frameLocator('#payment-frame').locator('#card-number') ->  frameLocator('#payment-frame').getByLabel('Card number')
    frameLocator('#payment-frame').locator('#card-cvc')    ->  frameLocator('#payment-frame').getByLabel('Security code')
```

Thirteen heals across **seven** distinct selectors — the same page objects are driven by
several tests. The cache means only seven provider calls are made, so a full run costs
about **$0.008** with the default model.

Without a key the suite runs unhealed and fails on the first stale selector — the same as
`HEALER_ENABLED=false`. `check:setup` is free and tells you which of those you are in.

`npm test` runs this **and** the report tour in `tests/report-example.spec.ts`, which needs
no key and demonstrates the failure paths — see
[What is tested](#what-is-tested-and-what-ci-can-run).

`app/` is the **redesigned** version of a shop: seven ids were renamed and the page objects
in `pages/` were never updated. The last two live **inside an iframe**, which is the case
healing could not reach before 0.4.0.

| Page object still uses | The app now has |
|---|---|
| `#checkout-button` | `data-testid="checkout"` |
| `#email-input` | `#customer-email-v3` |
| `#promo-field` | `#promotion-code-v3` |
| `#accept-terms` | `#terms-v3` |
| `#place-order-btn` | `#submit-order-v3` |
| `#card-number` *(in `#payment-frame`)* | `#card-number-v3` |
| `#card-cvc` *(in `#payment-frame`)* | `#card-cvc-v3` |

To see the same suite without the healer:

```bash
HEALER_ENABLED=false npx playwright test tests/checkout.spec.ts
```

To see exactly what a heal would send to the provider, without a key and without
spending anything:

```bash
HEALER_PRIVACY_PREVIEW=./privacy-preview npx playwright test tests/checkout.spec.ts
```

Behind a TLS-inspecting proxy you will need `NODE_EXTRA_CA_CERTS` set before any of the
above will reach the provider — see [Configure](#configure).

## Install

Consumers install the packed tarball — no registry access needed:

```bash
npm install ./self-healing-playwright-<version>.tgz
```

Playwright is a **peer** dependency — this package uses the copy already in your
project, which is what keeps fixtures working:

```
"@playwright/test": ">=1.53 <2"     Node >=18
```

## Configure

Create `.env` (see [.env.example](.env.example) for every variable):

```
HEALER_ENABLED=true
HEALER_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

If configuration is invalid, healing switches itself **off** and says why in the
report — your tests still run, unhealed, rather than failing on the framework.

Check the setup before spending anything — this makes **no API call**:

```bash
npm run check:setup     # .env location, resolved config, key shape, cost per heal
npm run check:key       # one ~15-token request, proves the credential works
```

With `claude-haiku-4-5` (the default) a heal costs about **$0.00115**.

### The same selector is only healed once

A stale selector normally lives in a page object shared by many tests, so without a cache
the same rot is paid for once per test that touches it. Selectors that heal are remembered
for the rest of the worker's life and re-validated rather than re-requested. Measured on
this repo's demo, which heals seven distinct selectors across four tests:

| | provider calls | tokens |
|---|---:|---:|
| `HEALER_CACHE=false` | 13 | 9,100 in / 1,170 out |
| `HEALER_CACHE=true` (default) | **7** | **4,900 in / 630 out** |

Both runs still report `healed: 13`. The cache makes rot cheaper to live with, never
invisible — every reuse is annotated, recorded, listed by the reporter as a rewrite worth
committing, and still trips the CI gate.

A reused selector is re-validated and re-intent-checked against the live page, so a
reuse that is wrong there is rejected and a normal heal follows. Two things worth knowing:

- **The cache is per worker.** A small suite spread across many workers shares less; a
  large suite where each worker runs many tests shares more.
- **`HEALER_FAIL_ON_HEAL` largely defeats it**, because Playwright discards a worker
  after a failed test and the next one starts cold. That is fine: the gated run is the
  one that hands you the edits, and once the source is fixed there are no heals to pay
  for at all.

### Ceilings, so a bad day cannot cost an hour

Two controls, both per worker and both on by default:

```bash
HEALER_MAX_HEALS=100           # provider-backed heals per worker; 0 = no ceiling
HEALER_BREAKER_THRESHOLD=5     # consecutive provider failures before giving up
```

**The ceiling** stops a badly rotted suite spending unbounded wall clock. Once reached,
further heals are skipped and annotated `heal-skipped` — and because it is checked *after*
the cache, an exhausted worker keeps reusing what it already learned rather than stopping
outright. Workers are separate processes, so the run total is this **times your `workers`
setting**; that is a real multiplication, not a footnote.

**The breaker** matters more. With the provider unreachable, every failing action used to
wait `HEALER_TIMEOUT × HEALER_MAX_RETRIES` before giving up — with the defaults, a
five-minute suite becomes an hour and every test fails anyway. Five consecutive failed
*calls* and this worker stops asking, mid-heal if that is where the fifth one lands. A
low-confidence answer is not a failure: the provider is working fine, and a breaker that
tripped on an unsure model would disable healing for the wrong reason.

Both are per worker, so the same worker-recycling caveat above applies to the breaker: in a
**total** outage every test fails, every failure starts the next worker cold, and the count
never accumulates. It helps most in the case it was written for — a suite where most tests
pass and a few heal — and least when nothing works at all. A fresh worker still caps itself
at `HEALER_BREAKER_THRESHOLD` attempts, so the waste is bounded either way.

Behind a TLS-inspecting proxy, Node rejects the re-signed certificate
(`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`) because it ignores the OS trust store. Export the
corporate root CA and point Node at it:

```powershell
$env:NODE_EXTRA_CA_CERTS = "$HOME\corporate-root-ca.pem"
```

## What is transmitted

Healing works by describing the page to a third-party model, so **whatever is on
screen is what gets sent**. Read this before pointing the healer at an application
holding real data.

### Sent to the provider, on every heal

| What | Redacted by default? |
|---|---|
| The page's accessibility snapshot — every role and accessible name | yes, `identifiers` |
| The Playwright error message, which quotes matched element text | yes, `identifiers` |
| The page URL | yes — query string and fragment dropped |
| The failing selector and its `describe()` text | yes, `identifiers` |
| The test file path and line number | reduced to project-relative — see below |

### The test location is reduced, not removed

`Test location:` is read off a stack trace, so it arrives absolute. It is sent
project-relative — `tests/checkout.spec.ts:42` — which is equally useful to the model and
does not carry the account or organisation name from the machine that ran the suite.

**One case keeps the absolute path:** a test file outside the directory you invoked
Playwright from. Making it relative there would produce a run of `..` segments that
discloses the same layout while being harder to read, so the original is kept. If your
layout does that and the path matters to you, a redactor can withhold the field outright:

```ts
createHealingFixtures({
  redactor: (value, { field }) => (field === 'testFile' ? '‹withheld›' : value),
});
```

### Iframes are a new surface as of 0.4.0

Healing a locator built through `frameLocator()` sends **that iframe's content**, not the
parent page's. Before 0.4.0 iframe content was never transmitted, because it never appeared
in a page snapshot at all — so if you audited this package before, this is the one thing
that changed about what leaves the machine.

That matters because iframes are disproportionately payment and identity widgets. The
usual controls all apply — card-shaped numbers are redacted at `identifiers`, and `strict`
collapses everything you cannot act on — and `HEALER_BLOCKED_PATHS` on the **parent**
route excludes the page and its frames together:

```bash
HEALER_BLOCKED_PATHS=/checkout/payment/**
```

### What comes back is redacted too

Redaction governs what goes *to* a provider. Three things coming *back* carry page text,
and all three end up in a log line, a report annotation, the report attachment, the CI
gate's failure message and the run summary. CI logs and uploaded report artefacts are
usually readable by more people than the machine that produced them.

| Coming back | Example |
|---|---|
| The **selector** the model chose | `getByText('Smith, John')` |
| The **accessible name** of the element it landed on, read from the live page | `Smith, John 1970-03-11` |
| The **reason** a suggestion was rejected, which quotes both | `described as "Place order" but resolves to "Smith, John"` |

All three get the **same level** as outbound text, so one setting describes the whole
surface. At `identifiers` this is almost always a no-op on a selector, and strips
structured identifiers out of a name. At `strict`, quoted content is collapsed — a rewrite
reads `getByText('‹redacted›')` and a rejection reads `resolves to "‹redacted›"`, keeping
the diagnosis, which is the part worth reading.

**Providers never print a selector above `debug`.** A provider sits below the guard and has
no way to redact, so it reports the confidence and the token cost at `info` and leaves the
selector to the engine one layer up, which can. Raising `LOG_LEVEL=debug` opts back into
unredacted diagnostics on your own machine.

**`healing-records.json` is never redacted** — and **you** have to keep it out of source
control. It is where you go for the exact rewrite, which is what makes redacting every
exported copy affordable; that trade only holds while the file stays local.

It is written to **your project root** by default and holds page content. npm strips
`.gitignore` from a tarball, so nothing arrives to tell your repository about it — the
package warns once on first write if it is not covered. Either add it:

```
healing-records.json
```

or move it out of the repository, or turn it off if you do not need the unredacted copy:

```bash
HEALING_RECORDS_PATH=../healer-artifacts/healing-records.json
HEALER_RECORDS=false
```

It accumulates across runs and across workers — it is not replaced per run — up to
`HEALER_RECORDS_MAX` (default 1,000, oldest dropped first).

### Never sent

- **Screenshots.** The healer does not capture them, and the guard drops the field
  unconditionally. Sending images requires a deliberate code change, not a setting.
- **The parent page, when a frame was asked about.** If a frame selector does not resolve,
  capture returns nothing rather than falling back to the surrounding document — the heal
  fails instead of describing the wrong thing.
- **Anything on a page the route policy excludes** — the snapshot is not even captured.
- **`healing-records.json` and the HTML report.** These stay on your machine, and they
  hold the *unredacted* selectors, so you still see the real values you need to fix.

### Choosing a level

```
HEALER_REDACT=identifiers     # the default
```

| Level | Removes | Keeps |
|---|---|---|
| `off` | nothing built-in | everything |
| `identifiers` | emails, card- and SSN-shaped numbers, GUIDs, tokens, long account numbers, dates, postcodes, IPs, IBANs, URL query strings | names, addresses, free text |
| `strict` | the above, plus the accessible name of everything you cannot act on and the value of everything you can | roles, tree shape, and the names of actionable elements |

`off` disables the **built-in** rules only. Custom patterns and a `redactor` callback are
instructions rather than defaults, so they still apply at every level — `off` plus a
patterns file means "apply only my rules", which is a supported setting.

**`identifiers` cannot catch names.** No regex matches "John Smith". It finds
*structured* identifiers and nothing else. For unstructured personal data the controls
that work are `strict` and the route policy below.

`strict` keeps healing working because it draws the line at *actionability*: a
`button "Place order"` is interface chrome and is kept, while a `cell "Smith, John"` is
data and is collapsed. Its residual risk is an actionable element labelled with data —
a button reading `"Edit Smith, John"` is still transmitted, because a healer that could
not read button labels could not heal buttons.

### Restricting where healing runs at all

This is the strongest control here, because it does not try to *recognise* sensitive
data — it refuses to look at the page.

```bash
# When set, an allowlist: healing is refused on every other origin.
HEALER_ALLOWED_ORIGINS=https://staging.example.com,*.test.internal

# Takes precedence over the allowlist, so a cleared app can still exclude routes.
HEALER_BLOCKED_PATHS=/patients/**,/claims/**
```

A refused heal reports itself as a `heal-blocked` annotation and in the run summary, so
healing that has quietly stopped never looks like healing that was never needed.

### Sending less in the first place

```bash
HEALER_SNAPSHOT_ROOT=#checkout-form
```

Scopes the snapshot to one container instead of the whole page. The cheapest control
available — it cuts disclosure and the token bill together.

**A configured root is never exceeded.** If the selector does not resolve on a page, the
heal is blocked rather than falling back to capturing the whole page — so one root
across a suite is safe, but it will stop healing on pages that lack the container. If
your pages do not share a container, set it per project rather than globally, or leave
it unset and rely on `HEALER_REDACT`.

### Verify it yourself

Do not take the above on trust:

```bash
HEALER_PRIVACY_PREVIEW=./privacy-preview npx playwright test tests/checkout.spec.ts
```

Every heal writes the **exact payload it would have sent** to a file and calls no
provider. It needs no API key and costs nothing. No heal can succeed while this is set —
that is the point: it is for reading what would leave, not for healing.

The redaction rules are unit-tested against a corpus of values that must never appear in
a payload (`npm run test:unit`, no browser or key required).

### Custom redaction

Regexes beyond the built-in set go in a file, because writing them into an environment
variable is miserable:

```bash
HEALER_REDACT_PATTERNS_FILE=./redact-patterns.json    # ["\\bMRN\\d{6}\\b"]
```

Patterns are applied after the built-ins, so yours is not pre-chewed by a broader shipped
rule. A `g` flag is added if you omit it — without it only the first occurrence would be
replaced, which is almost never what was meant. A malformed file is a hard configuration
error, not a warning: believing your patterns apply while nothing is redacted is the one
failure mode this must not have.

For anything a regex cannot express — a local classifier, a corporate DLP library —
supply a callback. Returning `null` **vetoes** the heal:

```ts
createHealingFixtures({
  redact: 'strict',
  redactor: (text, { field, pageUrl }) =>
    looksSensitive(pageUrl) ? null : scrub(text),
});
```

### One deliberate inversion

Everywhere else, this package fails **open**: a broken healer degrades to plain
Playwright rather than failing your suite. The privacy gate fails **closed**. A policy
that cannot be evaluated, a URL that will not parse, a redactor that throws or vetoes —
all mean *do not transmit*. The heal is abandoned, your original Playwright error is
re-thrown, and the test behaves exactly as it would with no API key configured.

### If you have an internal gateway

Routing to an endpoint inside your own trust boundary is a stronger control than any
redaction, and it is already supported:

```bash
ANTHROPIC_BASE_URL=https://ai-gateway.internal/v1    # or OPENAI_BASE_URL, GEMINI_BASE_URL
```

Worth pursuing if your organisation has one, or is considering one.

## Use

New suite:

```ts
import { test, expect } from 'self-healing-playwright';

test('checkout', async ({ page }) => {
  await page.goto('/cart');
  await page.locator('#submit-btn').describe('the order submit button').click();
  await expect(page.getByText('Order placed')).toBeVisible();
});
```

Existing framework — spread the fixture into your own `extend`:

```ts
export const test = base.extend<HealingFixtures & MyFixtures>({
  ...healingFixtures,
  api: async ({}, use) => { await use(new ApiClient()); },
});
```

`describe()` is optional but the single highest-value hint the AI gets: it distinguishes
the button you meant from the four others that also say "Submit".

Every heal records whether the locator had one, the run summary reports the split, and the
first undescribed heal in a worker logs a reminder — because heals without a description
are the likeliest to land on the wrong element, and previously you could not tell which
ones those were.

## Reporting

Add the reporter for a run-level summary:

```ts
reporter: [['list'], ['html'], ['self-healing-playwright/reporter']]
```

```
  Self-healing summary
  ────────────────────────────────────────────
  sent to: anthropic · redact=identifiers, all origins · intent=enforce

  healed: 4    failed: 2    blocked: 0    reused: 2    tokens: 5900 in / 210 out

  Suggested source updates:
    #submit-order  →  getByTestId('place-order')
    #promo         →  getByTestId('promo')
```

`reused` is heals that replayed a cached selector and cost nothing. Every number there is
read from the `healing-*.json` attachments rather than parsed out of the lines above it, so
rewording a message cannot quietly zero your token totals.

Per test, with no setup: a `healed` / `heal-failed` / `heal-unavailable` annotation, a
`healing-*.json` attachment with every attempt (confidence, reasoning, rejection
reason, tokens), and a labelled step in the trace.

## How a heal is decided

1. The action fails; the healer captures the page's accessibility tree.
2. The provider is asked for one replacement selector, with confidence, reasoning, and
   the role and accessible name it believes it selected.
3. A suggestion below `HEALER_THRESHOLD` (default 0.7) is refused.
4. The suggestion must resolve to **exactly one visible element** — Playwright's strict
   mode would throw on an ambiguous locator, so accepting one just moves the failure.
5. It must also be the **right** element — see below.
6. Rejected suggestions are fed back into the next attempt, so a retry doesn't repeat
   the same answer.
7. Every attempt, successful or not, is recorded with its reasoning and verdict.

## Running in CI

Healing's default behaviour is the one you want locally and the one you do not want in
CI. A heal means the test no longer matches the application. If that is a redesign you
want the rewrite — but if someone deleted a button and the model found a plausible
substitute, a green suite hides the regression.

Set it **in your CI environment**, not in `.env`:

```yaml
# GitHub Actions
env:
  HEALER_FAIL_ON_HEAL: true
```

```bash
# or any shell
HEALER_FAIL_ON_HEAL=true npx playwright test
```

> `.env` is for your machine. Writing `HEALER_FAIL_ON_HEAL=${CI}` there does **not** work —
> dotenv does not expand `${VAR}`, so the value becomes the literal string `${CI}`, which is
> not a boolean and switches healing off. The gate now says so out loud if it cannot read
> the setting, rather than disarming quietly.

**Turn Playwright's `retries` down for gated runs.** The gate makes a healed test fail, so
`retries: 2` re-runs it — and each attempt heals again from a cold worker, paying the
provider three times for a run that is *designed* to fail. `retries: 0` alongside the gate,
or accept a 3× bill.

Healing still runs, so the test exercises the whole journey and **one run reports every
stale selector** rather than stopping at the first. Then the test fails with the edits:

```
Error: HEALER_FAIL_ON_HEAL is set and 5 selector(s) needed healing, so this
test fails deliberately. Healing still ran, so the list below is complete rather
than stopping at the first one.

Apply these edits and re-run:

  pages/CartPage.ts:37  (click)  (exercised by tests/checkout.spec.ts:22)
    - #checkout-button
    + getByTestId('checkout')
      confidence 0.95 · button "Checkout" · verified by self-consistency+lexical

  pages/CheckoutPage.ts:44  (fill)  (exercised by tests/checkout.spec.ts:25)
    - #email-input
    + getByLabel('Email address')
      confidence 0.95 · textbox "Email address" · verified by action+self-consistency+lexical
  …

If a replacement above looks wrong, that is the regression this mode exists to
surface: healing found a plausible substitute for something that changed.
```

The location is where the selector is **used** — normally the page object that owns it,
not the spec that drove it, since the spec does not contain the string you need to
change. The exact definition line is not tracked; the file is, and the selector is in it.

If you integrate via `attachHealing()` and own your `page` fixture, call the gate
yourself after `use()` — the shipped fixtures already do:

```ts
import { attachHealing, assertNoHeals } from 'self-healing-playwright';

page: async ({ browser }, use) => {
  const page = await (await browser.newContext()).newPage();
  await use(attachHealing(page));
  assertNoHeals();                 // no-op unless HEALER_FAIL_ON_HEAL is set
}
```

**There is deliberately no "fail only on unverified heals" mode.** It sounds like a safer
middle ground and is not one: the regression this gate exists to catch is *by definition*
a plausible substitute, so it is exactly the kind of heal the intent checks approve.
Gating on verification quality would let the case through while feeling rigorous.

## Iframes

Locators built through `page.frameLocator()` heal like any other, including nested frames.
Nothing to configure:

```ts
await page
  .frameLocator('#payment-frame')
  .locator('#card-number')
  .describe('the card number field in the payment frame')
  .fill('4111111111111111');
```

The suggested rewrite comes back **fully qualified**, so it pastes straight into a page
object:

```
frameLocator('#payment-frame').locator('#card-number')
  →  frameLocator('#payment-frame').getByLabel('Card number')
```

Two things make this work, and both are worth knowing because they explain the failure
modes:

- **The snapshot is scoped to the frame.** A page-level accessibility snapshot shows an
  `<iframe>` as a bare leaf — the content inside is not there at all. Healing a frame
  locator captures *that frame's* tree instead, or the model would be asked to find an
  element it cannot see.
- **A frame that does not resolve stops the heal.** Capture never falls back to the
  parent document, because describing the wrong page produces a confidently wrong
  selector. You get a clear failure naming the frame selector, and no provider call is
  made — there would be nothing to reason about.

`page.locator('#a').locator('#b')` and `.filter()` still return undecorated locators; that
is a separate gap.

## Is it the right element?

Steps 3 and 4 above can both pass on completely the wrong element. On this repo's
checkout page, `button "Cancel"` is unique, visible and clickable — so a heal of
`#place-order-btn` to Cancel is accepted, the click succeeds, and a test whose
assertions are loose **goes green while exercising the wrong path**. That is worse than
a red test: nobody finds it without reading every healing record.

Four checks close that gap, in decreasing order of objectivity:

| Check | What it does |
|---|---|
| **Action compatibility** | You cannot `fill()` a button or `check()` a link. The action constrains the element's role, and this is a fact about the DOM rather than a judgement — so it can reject a wrong heal without ever rejecting a right one. |
| **Self-consistency** | The model reports the role and name it believes it selected. If its selector resolves to something else, the suggestion is discarded. Also false-positive-free: it measures the model against reality, not against a guess. |
| **Role preservation** | When the original selector implies a role — `getByRole('button', …)`, `button#submit`, `getByPlaceholder(…)` — the healed element must have it. |
| **Lexical intent** | Identifiers carry meaning: `#place-order-btn` is *about* placing an order. If the intent vocabulary and the element's accessible name share nothing, that is evidence of a wrong pick. |

When *nothing* can be verified — an opaque selector like `#btn-1` with no `describe()` —
confidence must reach `HEALER_UNVERIFIED_CONFIDENCE` (default 0.9) instead. Adding
`describe()` is the better fix.

Every rejection is fed into the next attempt, so this is a signal as well as a gate:
"you chose Cancel, whose name shares nothing with the intended element" is exactly the
correction that makes a retry land.

```
HEALER_INTENT_CHECK=enforce      # default
HEALER_INTENT_CHECK=warn         # run the checks, annotate concerns, heal anyway
HEALER_INTENT_CHECK=off          # pre-0.3.0 behaviour
```

Use `warn` to adopt this on an existing suite: every concern is logged, annotated and
recorded, but nothing changes about which heals succeed.

What was checked is recorded per attempt, so an accepted heal can be audited afterwards:

```json
"intent": {
  "mode": "enforce", "verified": true,
  "checks": ["action", "lexical"],
  "role": "textbox", "name": "Email address"
}
```

A heal whose only entry is `confidence-floor` is one nothing could corroborate — those
are the ones worth reviewing.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Compile `src` → `dist` |
| `npm test` | Run the demo suite and the report tour |
| `npm run test:ci` | **What CI should run** — build, type-check, 288 unit tests. No browser, no key, no cost |
| `npm run test:unit` | The unit tests alone |
| `npm run test:report` | The report tour — a browser, but still no key |
| `npm run check:setup` | Report config, key shape and cost per heal — **no API call** |
| `npm run check:key` | The same, plus one ~15-token request to prove the key works |
| `npm run typecheck:demo` | Type-check the demo fixtures, page objects and specs |
| `npm run package` | Build and produce the installable tarball |
| `npm run verify:package` | Install the tarball into a temp project and smoke-test it |

### What is tested, and what CI can run

| Layer | Command | Needs a browser? | Needs a key? |
|---|---|---|---|
| 288 unit tests | `npm run test:ci` | no | no |
| Report tour — every annotation state | `npm run test:report` | yes | no |
| Demo suite — healing end to end | `npx playwright test tests/checkout.spec.ts` | yes | **yes** |

**`npm run test:ci` is the gate to wire into CI.** It builds, type-checks the package and
the demo, and runs the unit tests: redaction and route policy, intent checks, the selector
cache, the CI gate's message, frame expressions, response parsing, prompt/parser
agreement, provider error mapping against a local HTTP server, records-file concurrency
across four real processes, config validation, and the run summary. Nothing there touches
a browser or a credential. With browsers available, add `npm run test:report`.

`tests/report-example.spec.ts` is a guided tour of the report, driven by a scripted
provider — so it covers the paths the demo cannot: a rejected first suggestion, a
below-threshold answer, a provider failure, a wrong-element rejection, a cache reuse, and
a route excluded by policy. Run it and open the HTML report to see each state.

`tests/checkout.spec.ts` drives the static app in `app/` through page objects written
against selectors the app no longer has, so it demonstrates healing for real — including
two selectors inside an iframe. That one needs a credential.

## How it works

[ARCHITECTURE.md](ARCHITECTURE.md) documents the internals: how the `page` fixture
decorates locators, why each wrapped action deletes its own override, the heal sequence,
the validation rules, all four reporting surfaces, the records file's locking, and a risk
register of Playwright behaviours it depends on.

## Releasing a new version

You never list files at pack time — the `files` array in `package.json` decides what
ships, and it is already correct. The whole release is five commands.

```bash
# 1. record what changed
#    edit CHANGELOG.md — add a section for the new version

# 2. bump the version (also creates the git commit and the vX.Y.Z tag)
npm version patch        # or minor / major

# 3. build and pack — `prepack` cleans and compiles first
npm run package          # → self-healing-playwright-<version>.tgz

# 4. prove the artefact works before anyone else installs it
npm run verify:package   # installs it into throwaway CJS + ESM projects

# 5. confirm the demo still heals against the new build
npm test
```

Then hand over `self-healing-playwright-<version>.tgz`. Recipients need no registry
access for it:

```bash
npm install ./self-healing-playwright-<version>.tgz
```

### What goes into the tarball

| Included | Why |
|---|---|
| `dist/` | the compiled package — what consumers actually run |
| `src/` | so the shipped sourcemaps resolve to readable TypeScript in stack traces |
| `package.json` | always included by npm; declares the `exports` map and peer dependency |
| `README.md`, `INTEGRATION.md`, `ARCHITECTURE.md`, `CHANGELOG.md` | how to use it, how to attach it, how it works, what changed |
| `.env.example` | the full list of configuration variables |

Deliberately **not** included: `AUDIT.md`, `tests/`, `playwright.config.ts`, `scripts/`,
`tsconfig.json`, `package-lock.json`, `node_modules/`, and any `.env`. These are
development-only — `AUDIT.md` is the internal engineering backlog, so consumer-facing
caveats belong in [Limitations](#limitations) rather than behind a link to a file that
does not ship. Shipping a lockfile would also fight the consumer's own resolution.

Because `src/` ships, **nothing under `src/` may reference `AUDIT.md`** — a comment or a
console warning pointing at it would be a dead pointer in a consumer's `node_modules`.

Adding a file to the package means adding it to `files` — nothing else. Check before
releasing with:

```bash
npm pack --dry-run
```

### Version numbers

Follow the policy in [CHANGELOG.md](CHANGELOG.md): patch for fixes and prompt tuning,
minor for new providers or report surfaces, major for changes to the fixture API or to
healing defaults. Consumers pin with `file:` paths today, so a major bump is a
conversation rather than a silent upgrade — but keep the discipline for when this moves
to a registry.

## Providers

| `HEALER_PROVIDER` | Status | Notes |
|---|---|---|
| `anthropic` | implemented | Messages API. `ANTHROPIC_BASE_URL` for gateways |
| `openai` | implemented | Chat Completions. `OPENAI_BASE_URL` for Azure/compatible servers |
| `gemini` | implemented | Generative Language API |
| `ollama` | not implemented | Use `openai` with `OPENAI_BASE_URL` if your server speaks that protocol |

Add your own by extending `AiProvider` (prompts, JSON parsing, and selector
sanitising are inherited) and installing it with `setHealingEngine`.

## Limitations

**Read this before using the healer against a real application.**

- **Healing can mask a real regression** unless you gate it. If a developer removes a
  button, the healer may find a plausible substitute and the suite stays green. Set
  `HEALER_FAIL_ON_HEAL=true` in CI — see [Running in CI](#running-in-ci) — which heals,
  reports every stale selector, and *still* fails the build.
- **Page content is sent to a third party.** Redacted by default, and restrictable — see
  [What is transmitted](#what-is-transmitted) — but a heal is still a network call
  carrying a description of the page.
- **The intent checks are not infallible.** They catch a healed element that shares no
  vocabulary with the intent; they cannot catch one that shares plenty, such as two
  buttons both named "Save". See
  [Is it the right element?](#is-it-the-right-element).
- **Two buttons named the same thing** cannot be told apart by the intent checks. Use
  `HEALER_FAIL_ON_HEAL` in CI so a human sees every heal.

- Assertions are never healed — only actions.
- Chained locators (`page.locator('#a').locator('#b')`) and `.filter()` don't heal.
- Healing costs tokens and wall-clock time per failure; it is not a substitute for
  stable test ids. The cache removes the repeat cost within a worker, not the first
  cost, and nothing persists across runs — deliberately, so rot cannot be papered over
  indefinitely.
- Model suggestions are validated, intent-checked, and still not infallible. The checks
  above catch a wrong element that shares no vocabulary with the intent; they cannot
  catch a wrong element that shares plenty — two buttons both named "Save", say. Review
  `healing-records.json` and commit the selector updates you agree with.

## Licence

MIT
