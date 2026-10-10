# Adding healing to an existing Playwright framework

Healing attaches to the `page` fixture. Everything else in your framework — your
fixtures, page objects, config, reporters — stays as it is.

Pick the pattern that matches how your framework builds `page`.

---

## 1. You don't customise `page` (most common)

Spread `healingFixtures` into your existing `extend` call.

```ts
// fixtures.ts
import { test as base } from '@playwright/test';
import { healingFixtures, type HealingFixtures } from 'self-healing-playwright';

type MyFixtures = {
  api: ApiClient;
  loginAs: (role: string) => Promise<void>;
};

export const test = base.extend<HealingFixtures & MyFixtures>({
  ...healingFixtures,

  api: async ({}, use) => {
    await use(new ApiClient());
  },
  loginAs: async ({ page }, use) => {
    await use(async (role) => { /* … */ });
  },
});

export { expect } from '@playwright/test';
```

Your specs don't change at all. They keep importing `test` from `./fixtures`.

---

## 2. You **do** customise `page`

Do not use `healingFixtures` here — two `page` definitions in one `extend` call means
one silently wins, with no error. Two options.

### 2a. Wrap your finished test object

```ts
// fixtures.ts
import { withHealing } from 'self-healing-playwright';

const test = base
  .extend<AuthFixtures>({ page: async ({ browser }, use) => { /* your page */ } })
  .extend<ApiFixtures>({ api: async ({}, use) => { /* … */ } });

export default withHealing(test);
```

`withHealing` extends *on top of* your test, so it receives whatever `page` your
fixture produced. Nothing is overwritten.

### 2b. Attach inside your own fixture

```ts
import { attachHealing } from 'self-healing-playwright';

export const test = base.extend({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: 'auth.json' });
    const page = await context.newPage();
    await use(attachHealing(page));
  },
});
```

Use this when you need healing applied at a specific point — for example after
navigation or after installing route handlers.

---

## 3. Your `test` comes from a shared internal package

You can't edit the `extend` chain, but you can wrap its export:

```ts
import { test as companyTest } from '@your-org/test-base';
import { withHealing } from 'self-healing-playwright';

export const test = withHealing(companyTest);
export { expect } from '@playwright/test';
```

---

## 4. Configure in code instead of `.env`

If your framework doesn't use dotenv, or you want per-project settings:

```ts
import { createHealingFixtures, type HealingFixtures } from 'self-healing-playwright';

export const test = base.extend<HealingFixtures>({
  ...createHealingFixtures({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: process.env.MY_OPENAI_KEY,
    threshold: 0.8,
    maxRetries: 1,
    timeout: 20_000,
    recordsPath: 'artifacts/healing-records.json',
  }),
});
```

Anything omitted falls back to the environment, so you can override a single value.

Importing this package does **not** read `.env` on its own — that happens on first
config access. Set `HEALER_SKIP_DOTENV=1` to prevent it entirely and manage env
yourself.

---

## CI

The package's own gate, which needs neither a browser nor a credential:

```bash
npm run test:ci        # build, type-check, 666 unit + 231 live tests. Chromium, no key
npm run test:unit      # the unit half alone: no browser, no key, no network
npm run test:report    # optional: the report tour. A browser, still no key
```

Wiring those into your pipeline is one file in whatever CI you use — no workflow is
shipped here, because guessing the provider would just be noise to delete.

For **your** suite, turn the heal gate on there and leave it off locally:

```yaml
env:
  HEALER_FAIL_ON_HEAL: true
```

A test that needed healing then fails, with the selector edits in its failure message.
Healing still runs first, so one CI run gives you the complete list of stale selectors
rather than one per run.

Why this matters: without it, healing turns a red build green, which is the opposite of
what a gate is for. A heal means the test no longer matches the application — worth an
edit if the application was redesigned, and worth a red build if it regressed. The healer
cannot tell those apart, so it fails and shows you.

If your framework owns the `page` fixture and you use `attachHealing()`, call
`assertNoHeals()` after `use()`; the fixtures this package ships already do. It is a
no-op when the flag is unset, so it is safe to leave in permanently.

The other settings worth pinning in CI:

```yaml
env:
  HEALER_FAIL_ON_HEAL: true       # a heal fails the build, with the edits
  HEALER_INTENT_CHECK: enforce    # default; refuse heals onto the wrong element
  HEALER_REDACT: strict           # if CI runs against data-bearing pages
  HEALER_MAX_RETRIES: 1           # halve the worst-case wall clock
```

Note that `HEALER_FAIL_ON_HEAL` largely defeats the selector cache, because Playwright
discards a worker after a failed test and the next one starts with an empty cache. That is
the right trade: the gated run exists to hand you the edits once, and after you apply them
there are no heals left to pay for.

---

## Adopting the intent checks on an existing suite

From 0.3.0 a healed element is checked against what the test appears to have meant, not
just against "does this resolve to one visible element". That second question can be
answered yes by completely the wrong element — a page with "Place order" and "Cancel" has
two unique, visible, clickable buttons — and the wrong one going green is harder to notice
than a heal that was refused.

`HEALER_INTENT_CHECK=enforce` is the default and can turn a currently-passing test red.
If that is a problem on day one:

```bash
HEALER_INTENT_CHECK=warn      # run every check, record and annotate, heal anyway
```

Then look at what it flags. Warnings appear on the `healed` annotation and in
`healing-records.json` under `intent`:

```json
"intent": { "mode": "warn", "verified": false, "checks": ["lexical"],
            "role": "button", "name": "Cancel",
            "reason": "…shares no wording with the intended element…" }
```

Anything reporting `"checks": ["confidence-floor"]` is a heal nothing could corroborate —
an opaque selector with no `describe()`. The fix is usually to add `describe()` rather
than to lower `HEALER_UNVERIFIED_CONFIDENCE`; the description is the strongest signal the
model gets, and it is what makes the check possible at all.

Switch to `enforce` once the warnings are either fixed or understood.

---

## Before you point this at a real application

**Deal with `healing-records.json` first.** It appears in your project root after the first
heal and holds **unredacted** page content — the selectors and text a heal saw. It is the
one copy that is deliberately not redacted, because it is where you read the real rewrite
when `HEALER_REDACT=strict` has collapsed it everywhere else. Pick one:

```bash
# keep it, out of the repository
HEALING_RECORDS_PATH=../healer-artifacts/healing-records.json

# or keep it in place and ignore it        →  echo healing-records.json >> .gitignore

# or do without it
HEALER_RECORDS=false
```

The package warns once on the first write if it is neither ignored nor relocated.

Healing describes the page to a third-party model, so whatever your application renders
is what gets sent. Redaction defaults to `identifiers`, which strips structured
identifiers but **cannot catch names or free text** — no regex can.

Work through this in order. It takes about ten minutes and the first two steps cost
nothing.

**1. Look at what would actually be sent.** No API key needed, no charge, no data
transmitted:

```bash
HEALER_PRIVACY_PREVIEW=./privacy-preview npx playwright test
```

Each heal writes the exact payload it would have sent to a file. Read a few. This is
also the artefact to hand whoever has to approve the tool — it is considerably more
persuasive than a paragraph of documentation. No heal succeeds while it is set, so run
it as a separate pass, not as your suite.

**2. Restrict where healing may run.** The strongest control available, because it does
not attempt to recognise sensitive data — it refuses to read the page:

```bash
HEALER_ALLOWED_ORIGINS=https://staging.yourapp.internal   # allowlist once set
HEALER_BLOCKED_PATHS=/patients/**,/claims/**              # wins over the allowlist
```

**3. Send less.** If your tests concentrate on one region of the page:

```bash
HEALER_SNAPSHOT_ROOT=#main-form
```

Cuts disclosure and the token bill together.

**4. Raise the level if the pages hold unstructured personal data.**

```bash
HEALER_REDACT=strict
```

This collapses the accessible name of everything you cannot act on. Healing keeps
working — button and field labels survive — but locators that heal via page *text* will
degrade. Re-run step 1 to see the difference on your own pages.

**5. Add your own rules if you have a house identifier format.**

```bash
HEALER_REDACT_PATTERNS_FILE=./redact-patterns.json    # ["\\bMRN\\d{6}\\b"]
```

Or, for anything a regex cannot express, a callback that can also veto:

```ts
createHealingFixtures({
  redact: 'strict',
  blockedPaths: ['/patients/**'],
  redactor: (text, { field, pageUrl }) => (isRestricted(pageUrl) ? null : scrub(text)),
});
```

Returning `null` abandons the heal and re-throws your original Playwright error.

**If your organisation has an internal AI gateway**, routing to it is a stronger control
than all of the above, and it already works — set `ANTHROPIC_BASE_URL`,
`OPENAI_BASE_URL` or `GEMINI_BASE_URL` to it.

A heal refused by policy appears as a `heal-blocked` annotation and in the run summary,
so healing that has quietly stopped never looks like healing that was never needed.

Full detail: the [What is transmitted](README.md#what-is-transmitted) section of the
README.

---

## Reporting

Per-test detail (annotations, `healing-*.json` attachments, a step in the trace) needs
no setup. For the run-level summary, add the reporter:

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ['list'],
    ['html'],
    ['self-healing-playwright/reporter'],
  ],
});
```

It prints healed/failed/blocked counts, token spend, the `#old → new` selector rewrites
worth committing back into your specs, and one line naming what was transmitted and
under which redaction policy.

---

## Timeouts

Healing runs **after** an action fails, so it needs an **`actionTimeout`**. Playwright's
default is `0`: an action waits for its element until the *test* times out, and a heal
never gets to run. Set one:

```ts
// playwright.config.ts
export default defineConfig({
  use: { actionTimeout: 5_000 },
});
```

The healer warns once per worker when it finds no `actionTimeout`. If you set timeouts
another way (`page.setDefaultTimeout()`, `context.setDefaultTimeout()`), you can ignore
the warning.

A heal spends the same test-timeout budget as the action it follows:

```
actionTimeout + (HEALER_MAX_RETRIES × HEALER_TIMEOUT) + overhead + the retried action
```

With the defaults (`HEALER_TIMEOUT=30000`, `HEALER_MAX_RETRIES=2`) that can reach roughly
79 seconds. Each provider call is therefore capped at the time left in the test, keeping
2 s back for the retried action. When less than 3 s is left, no call is started: the heal
is reported as `heal-skipped` and the test fails with the Playwright error naming the
stale selector, not with `Test timeout exceeded`. A test that heals often still needs
room, so raise `timeout` or lower `HEALER_TIMEOUT` / `HEALER_MAX_RETRIES`. This repo's
`playwright.config.ts` uses a flat `timeout: 120_000`, because one demo test heals five
selectors.

A stale selector pays its `actionTimeout` **once per worker**, not once per use. After
the first heal, later uses of the same selector check the original for 250 ms and, if it
is still stale, go straight to the healed replacement. The replacement is re-validated and
reported as a heal (`via cache`) exactly as before.

---

## What healing does and does not touch

| | |
|---|---|
| Heals | `click`, `dblclick`, `fill`, `check`, `uncheck`, `hover`, `selectOption`, `press`, `pressSequentially`, `type`, `tap`, `focus`, `clear`, `selectText`, `setInputFiles`, `scrollIntoViewIfNeeded` |
| Heals | `page.locator()` and the `page.getBy*()` family, plus `.first()` / `.last()` / `.nth()` |
| Does not heal | assertions (`expect`), chained locators (`page.locator('#a').locator('#b')`), `.filter()`, page-level shortcuts (`page.click('#x')`) |
| Never changes | what your test asserts. A heal repairs how an element is found, nothing else. |

If healing fails, the **original Playwright error** is re-thrown unchanged — including
its `locator.click: Timeout …` label — so a failing test reads exactly as it would
without this package installed.

---

## Requirements

- Playwright `>=1.53` (peer dependency; `locator.describe()` landed in 1.53,
  `ariaSnapshot()` in 1.49 — both have fallbacks, but 1.53 is the supported floor)
- Node `>=18` (global `fetch`)
- No SDK dependencies: all three providers call their REST APIs directly
