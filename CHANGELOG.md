# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [semantic versioning](https://semver.org/):

- **patch** — bug fixes, prompt tuning, better error messages
- **minor** — new providers, new report surfaces, new integration helpers
- **major** — changes to the fixture API or to healing defaults that alter behaviour

## [0.4.4] — 2026-08-27

A scenario-driven pass: what a team actually meets in CI, on a second browser, in a test that
opens a popup. It found the most serious defect in either audit document — **the package's
own documented CI setting switched the package off.**

### Fixed — `HEALER_FAIL_ON_HEAL=${CI}` never worked

`.env.example` recommended it under "Recommended for CI". `dotenv` does **not** expand
`${VAR}` — that is `dotenv-expand`, a separate package — so the value was the literal
string `${CI}`, `getConfig()` threw, and **healing was off for the entire run**. Reported
only as `heal-unavailable`, which reads like a missing credential.

`check:setup` printed the same broken form as its recommendation, so the free pre-flight
tool taught it too.

`.env` is for your machine. The variable belongs in the CI environment, and
`.env.example`, README and `check:setup` now say so with GitHub Actions, GitLab and shell
forms.

### Fixed — the CI gate no longer disarms in silence

A malformed `HEALER_FAIL_ON_HEAL` made `assertNoHeals` return without a word, on the
reasoning that the value is "reported elsewhere". It is — as *"healing is unavailable"*, a
sentence about something else. Nothing said the gate was off.

It now says so once per worker at `error` level, naming the variable and how many heals will
not fail the run. Still does not throw: healing must never take a suite down.

### Fixed — a popup no longer hides heals from the CI gate

`healsThisTest` was reset on every page **decoration**, on the assumption of one decoration
per test. Any test that opens a second page — a popup, a tab, an OAuth window, a print
preview — threw away every heal from the first: **the gate reported 1 of 2**, silently, and
only in the tests where a journey is most complex.

Now reset when the *test* changes, keyed on `testId#retry`, so a retry still starts clean and
a second page continues the same collection.

### Documented — `retries` multiplies a gated run

The gate fails a healed test, so `retries: 2` re-runs it twice on cold workers: **three times
the provider spend** for a run designed to fail. Use `retries: 0` alongside the gate, or
accept it knowingly.

### Verified

- **Firefox: 38/38.** The whole option suite passes on Firefox as well as Chromium, so
  capture, redaction, healing and reporting are genuinely browser-independent — and 0.4.3's
  `BROWSER` fix works end to end.
- Timeout guidance in `INTEGRATION.md` was already correct and complete.

Tests: **392 unit**, **40 in the options tour** (+2 gate scenarios).

## [0.4.3] — 2026-08-26

Seven findings, all from following two questions rather than sweeping the code: *demonstrate
every `.env.example` option*, and *what is `healing-records.json` for*. Three are defects in
0.4.1 and 0.4.2. One is a regression 0.4.2 introduced.

### Fixed — the records file no longer surprises a consumer

`healing-records.json` is written to **your project root** and is the one copy of a healed
selector kept **unredacted** — which is the stated reason every exported surface *is*
redacted. That argument holds only while the file stays local, and nothing made it so: npm
strips `.gitignore` from a tarball, so nothing arrived to tell your repository about it,
while README claimed the file "is local and gitignored". True of this repo, not of yours.

- **A warning on first write**, once per worker, naming the directory and all three
  remedies. Silent when the path was chosen deliberately or `.gitignore` already covers it.
- **`HEALER_RECORDS=false`** switches the file off entirely. Heals are still annotated,
  attached, CI-gated and summarised — only the unredacted rewrite is lost.
- **`HEALER_RECORDS_MAX` now defaults to 1,000, not 10,000.** The file is re-read and
  rewritten inside every heal, so the cap is a permanent per-heal cost: **124ms at 10,000
  against 15ms at 1,000**, measured. 1,000 is still far more history than anyone reads.
- `HEALING_RECORDS_PATH` and `HEALER_RECORDS` are now in README, `.env.example` and
  INTEGRATION's pre-flight checklist. The path setting had appeared in no user-facing
  document at all.
- **The first write to a new directory took 3,181ms**, because the lock was taken before the
  directory holding it existed — all 80 retries failing, then a spurious "could not
  acquire the record lock". Now 5ms. Latent since locking was written, and reachable only
  via the setting this release recommends.

`HealingOptions` gained `records` and `recordsMax` alongside `recordsPath`, which previously
had no programmatic equivalents.

### Fixed — a 0.4.2 regression relabelled every Playwright error

```
Error: locator.call: Timeout 5000ms exceeded.     ← was, and is again, locator.click
```

Enabling `noUncheckedIndexedAccess` hit the one line in this codebase that must not be
refactored, and the fix invoked the method with `.call()` — which `ARCHITECTURE.md`'s
measured table lists as producing exactly that label, and which the surrounding comment
names as a failure mode. Now written `methods[action]!(...args)`: the `!` is erased at
compile time, so a plain property call is what runs.

No test caught this, because none asserts on an error *label*. It surfaced from reading a
`HEALER_PRIVACY_PREVIEW` file for an unrelated reason — the payload embeds the Playwright
error verbatim, which makes preview mode an accidental regression test for it.

### Fixed — `BROWSER`, `HEADLESS` and `SHOW_BROWSER` did nothing

All three were parsed, range-checked, typed, documented and printed — and read by no
consumer. `playwright.config.ts` hardcoded `headless: false` and `chromium`, so
`BROWSER=firefox` was inert and `HEADLESS=true` was inert while `.env.example` shipped that
very value.

**The demo's default changes:** it now honours `HEALED=true` and runs headless.
`SHOW_BROWSER=true` is the documented way to watch it.

### Fixed — `attachHealing()` never reported an unavailable healer

It is the documented path for frameworks that build their own `page`, and its docstring said
*"Reporting still works."* True of four annotation types and false of the fifth:
`heal-unavailable` is the only one published from construction rather than from a wrapped
action, so that path silently lost it — a suite that had stopped healing looked exactly
like one that never needed to.

### Added — a working demonstration of every setting

`tests/env-options.spec.ts`: **38 tests, no API key, no network.** One local server plays
both the page under test *and* the Anthropic API, so it keeps every request body — which
means the privacy settings are asserted against **what actually left the process**, not
against a function in isolation. Serving over HTTP is also what makes
`HEALER_ALLOWED_ORIGINS` and `HEALER_BLOCKED_PATHS` testable at all; `setContent` gives you
`about:blank`.

Writing it is what found the two fixes above.

Tests: **379 → 392 unit**, plus 38 in the new spec.

## [0.4.2] — 2026-08-26

A third review, aimed at the surfaces the first two walked past: the entry point, the build
settings, and the pre-flight script. Three of the eight findings are defects in the 0.4.1
work itself.

### Fixed — `HEALING_LOGS` now does what it says

It was parsed, typed, exported and documented — and read by nobody, so setting it had no
effect. 0.4.1 made that worse by adding a `validateConfig()` line keyed on it.

`HEALING_LOGS=false` now silences the healer's per-heal narration without touching
`LOG_LEVEL`. **Warnings and errors always get through, and records are never affected** —
a logging switch able to hide a blocked heal or an audit trail would make problems
invisible rather than quiet.

### Fixed — two compiler flags the code already claimed to satisfy

Three providers cited `exactOptionalPropertyTypes` as the reason for the
`...(x !== undefined ? { x } : {})` idiom used throughout this codebase. The flag was off.
It is on now, along with `noUncheckedIndexedAccess` — five internal fixes between them.
The distinction matters: `IntentVerifier` reads a missing `expectedRole` as "the model did
not say", and `PrivacyGuard.sanitizeRequest` rebuilds fields conditionally so a new field is
a compile error rather than a new disclosure channel.

### Fixed — `check:setup` shows the settings that matter

The free pre-flight reported `enabled`, `provider`, `threshold`, `maxRetries` and `timeout`.
It did not report `HEALER_REDACT`, the route policy, `HEALER_INTENT_CHECK`,
`HEALER_FAIL_ON_HEAL`, `HEALER_CACHE` or either ceiling — including two settings whose
permissive value is a real hazard. It now has `safety` and `ceilings` sections.

### Fixed — smaller things

- **`HealOptions` is exported.** It was added to the public `AiProvider.heal` signature in
  0.4.1 and left unreachable, so a custom provider could not type the parameter it is asked
  to accept. `RequestCancelledError` and `NonJsonResponseError` are exported too.
- **`delay()` honours an already-aborted signal.** `addEventListener('abort')` does not fire
  on a signal that has already fired, so a chain cancelled mid-attempt sat out the full
  backoff — the exact delay the 0.4.1 cancellation work exists to remove.
- **The transmitted-data table no longer says "never the absolute path".** A file outside the
  working directory keeps its absolute form by design; the residual case is now named, with
  the `redactor` snippet that withholds the field outright.

## [0.4.1] — 2026-08-25

A second internal review of 0.4.0, and every finding it produced. **Nothing here changes a
default, an API or a behaviour anyone configured** — it closes gaps in work already shipped,
which is why it is a patch rather than a minor.

Three of the fourteen mattered enough to be worth this release on their own: a parser that
silently resolved a *different element* than the expression it was given, page text reaching
CI logs and uploaded report artefacts unredacted, and a spend ceiling that enforced half the
number it advertised.

Four of the fixes uncovered a second defect while being written, and two made a documented
claim true that had not been. Those are called out in place below.

### Fixed — a chain the parser cannot express is now refused, not truncated

`SelectorValidator` read the first `getBy*(` call in an expression and **silently discarded
the rest**. A model that answered
`getByRole('row').filter({ hasText: 'Smith' }).getByRole('button')` got a locator for the
**row** — and on a page with one row that validates, so the healer acted on the wrong
element while the record, the report and the CI gate all displayed the full chain.

- The uninterpretable suffix is now named and the suggestion rejected, with the reason fed
  into the next prompt — which is where a model learns to answer with one call.
- The same rule applies to **options**. Only `name`, `exact` and `level` are forwarded, and
  every option that was dropped — `pressed`, `checked`, `disabled`, `expanded`, `selected`,
  `includeHidden`, and `locator()`'s entirely — *narrows* the match, so dropping one
  resolved a broader set than the expression described.
- Bare CSS and XPath are left alone. Playwright's parser is the authority on those.

**A second defect surfaced with it:** only the *last* trailing `.first()`/`.nth(n)` was
peeled, so `getByRole('row').nth(2).first()` dropped the `.nth(2)` and resolved to the
**first** row. `TestWrapper` generates that shape itself whenever a refined locator is
refined again.

### Fixed — redaction now covers the page text beside the selector

0.4.0 redacted healed selectors on every export surface. Two other channels on those same
surfaces carried page text and were missed: the intent check's **rejection reason** and the
**accessible name** of the element a suggestion landed on.

```
described as "Place order" but resolves to "Smith, John 1970-03-11"
```

That reached the `heal-failed` annotation, the report attachment, the CI gate's failure
message and the run summary in CI stdout — unredacted, at every level including `strict`.

- **`PrivacyGuard.redactMessage()`** — patterns, plus quoted-run collapse at `strict`,
  keeping the diagnosis. `redactSelector()` delegates to it; they were always one operation.
- **`PrivacyGuard.redactName()`** — a name is page content end to end, with no prose around
  it to preserve, so at `strict` the whole value goes. This also fixes names containing an
  apostrophe, which the previous approach mangled.
- Applied to all five annotation types, the attachment's `reason`, and every page-derived
  field inside `attempts[]` — including the model's prose `reasoning`.

**Providers no longer print a selector above `debug`.** They sit below the guard by design
and cannot redact, so they report confidence and token cost at `info` and leave the selector
to the engine. The engine's own rejection lines and the cache's reuse line are redacted too.

### Fixed — `HEALER_MAX_HEALS` now counts what it says it counts

The ceiling was charged once per **attempt** while being named, configured, documented and
reported in **heals**, so `HEALER_MAX_HEALS=100` with the default `maxRetries` meant 50.
It is now charged once per heal. The breaker still counts attempts, which is what its own
documentation always promised — and it is now re-checked *between* attempts, so one that
opens partway through a heal abandons the rest instead of spending more timeouts on a
provider already known to be down.

### Fixed — the outbound prompt no longer carries an absolute path

`Test location:` was read off a stack trace and sent whole, so every heal transmitted the
account and organisation names from the machine that ran the suite. It is now
project-relative — at every level, `off` included, because that is normalisation rather
than redaction. `RedactionField` gains `testFile` so a caller can withhold it outright.

### Fixed — one deadline now governs the whole provider call

`HEALER_TIMEOUT` bounded the engine's wait, not the provider's work. Losing that race only
abandoned a promise: against a hung endpoint the retry chain carried on unobserved, holding
sockets and asking questions nobody would read the answer to. Measured against a server that
never replies — **3 requests over 2,467ms before, 1 request over 364ms after**.

`AiProvider.heal()` gains an optional second parameter carrying an `AbortSignal`. Optional
on purpose: a custom provider written before it existed still satisfies the contract.

### Fixed — smaller things

- **Recorded selectors match your source.** `getByRole('button', { pressed: true })` was
  reported as `getByRole('button')`, so the CI gate told you to edit a line that said
  something else. Every option is now rendered; `has`/`hasNot` take a Locator and show as
  `…` rather than vanishing.
- **The reporter reads `result.annotations`**, the per-result channel, rather than
  `TestCase.annotations` — which Playwright documents as "of the *last* test run".
- **`SelectorCache` is bounded** at 500 selectors, least-recently-used first, and reports
  what it evicted. A bounded cache that never says so looks like one with room for
  everything.
- **`HEALER_RECORDS_MAX` warns** when it cannot use a value instead of silently defaulting,
  and `validateConfig()` prints the effective cap. It was the one setting a typo could pass
  through unnoticed.
- **`prune(max)` no longer becomes the new cap.** The cap is a parameter of the write now,
  which is also what makes a one-off trim survive the merge against what is on disk.
- **The cache summary says "miss(es)"**, not "provider call(s)" — a miss reaches a provider
  only if the ceiling allows it, the breaker is closed and the privacy gate passed.

Tests: **324 → 379**, including a new `tests/unit/heal-loop.test.js` that drives the real
engine rather than one collaborator, because the ceiling/breaker/retry behaviour only exists
in the relationship between them.

## [0.4.0] — 2026-08-24

Closes every remaining item in the internal audit. 0.3.0 made the healer safe to point at
a real application; this makes it safe to leave running — bounded in cost, verifiable in
CI, and honest about what it did.

The headline additions are a **CI gate** that fails a build when a selector heals and
hands over the exact edits, a **per-worker cache** that stops the same rot being paid for
once per test, **iframe support**, and **spend ceilings with a circuit breaker**. Behind
those: 324 unit tests needing no browser or credential, a run summary that reads
structured data instead of parsing its own prose, and a LICENSE the package has declared
since its first release without carrying.

Nothing here changes a default that 0.3.0 did not already change, so upgrading from 0.3.0
is additive.

### Added — ceilings, so a bad day cannot cost an hour

Two controls, both per worker, both on by default.

- **`HEALER_MAX_HEALS`** (default 100) bounds heals that reach the provider. Checked
  *after* the cache, which is what makes it usable: an exhausted worker keeps reusing what
  it already learned rather than stopping dead. Refusals are reported as a new
  **`heal-skipped`** annotation, kept separate from `heal-blocked` because the responses
  differ — raise a ceiling, versus review a privacy policy.
- **`HEALER_BREAKER_THRESHOLD`** (default 5) stops a worker calling a provider that keeps
  failing. With the provider unreachable, every failing action previously waited
  `HEALER_TIMEOUT` × `HEALER_MAX_RETRIES` before giving up — with the defaults, a
  five-minute suite became an hour and every test failed anyway.

**A low-confidence answer is not a provider failure.** The provider is working fine, and a
breaker that tripped on an unsure model would disable healing for entirely the wrong
reason. Only a failed call counts, and any success clears the count.

Both are per **worker**, because Playwright workers are separate processes — so the
effective run total is `× workers`. That multiplication is documented rather than buried; a
cap that silently means four times what it says is worse than no cap.

### Added — a licence, and pricing that admits its age

- **`LICENSE`** — the MIT text the package has always claimed, `Copyright (c) 2026 Vineel
  Bisu`, now shipped in the tarball. `package.json` gains a matching `author`.
- **`scripts/pricing.json`** — per-million-token prices moved out of the script, with a
  `lastVerified` date printed beside **every** cost estimate, and a warning once it is over
  120 days old. These are the numbers people use to decide whether to run a suite, so a
  silently stale figure is worse than none.

### Added — `describe()` is measured now

The description is the strongest signal the model gets, and it is optional — so heals
without one were both likelier to be wrong and impossible to find afterwards.

- **`HealRecord.described`** records whether the locator had one.
- The run summary reports the split, read from the attachment.
- The first undescribed heal in a worker logs a reminder. Once, not per heal.

### Changed — selectors coming back are redacted too

Redaction governed what goes *to* a provider. A selector coming *back* can carry page text
— `getByText('Smith, John')` — into a log line, a report annotation, the CI gate's failure
message and the run summary, and CI logs and uploaded report artefacts are usually readable
by more people than the machine that produced them.

Displayed selectors now get the **same level** as outbound ones, so one setting describes
the whole surface. At `identifiers` it is almost always a no-op; at `strict`, quoted content
is collapsed. The report attachment is included, because it travels with the HTML report.

**`healing-records.json` stays unredacted** — local, gitignored, and the place you go for
the exact rewrite. That is what makes redacting the exported copies affordable rather than
a loss of function.

### Fixed — the records file no longer gets slower as it grows

It was read, merged and rewritten on **every** heal, so a long-lived file made each heal
progressively slower — quadratic in the file length, not linear.

- **`HEALER_RECORDS_MAX`** (default 10,000) keeps the most recent records, which bounds
  every write. `prune(max)` trims an existing file. The oldest go first: the recent
  rewrites are the ones anyone acts on.
- **The write lock is jittered.** Flat 25ms backoff meant four workers that collided once
  went on colliding in lockstep, which is the shape that actually loses records under
  contention. Randomising each wait breaks the convoy; the retry budget also went from 40
  attempts to 80, but the jitter is the part that matters.

Queuing writes and flushing at exit was considered and rejected: it inverts the trade this
module deliberately made, since a worker killed mid-run would lose everything buffered.

### Changed — the run summary reads structured data, not prose

`HealingReporter` used to reconstruct token totals by regexing
`(\d+) in / (\d+) out tokens` out of the annotation text, which coupled every number in
the summary to a sentence written elsewhere. Rewording that sentence would have zeroed the
totals with no error anywhere.

It now reads two channels: annotation **types**, which are stable constants and carry the
counts, and the **`healing-*.json` attachments**, which are JSON and carry anything
arithmetic is done to.

- **`reused: N`** in the summary — how many heals replayed a cached selector and cost
  nothing. Impossible before, because `via cache` was prose.
- **A heal with no attachment says "token totals unavailable"** rather than reporting a
  confident zero.
- **The summary notes retried attempts.** A retry re-runs the test, so it heals again and
  spends again — counting both is correct, but more heals than tests reads as a bug
  without the note.
- `publishOutcome` now **awaits** the attachment. It was fire-and-forget, which happened to
  work; the totals depend on it landing, so a race was no longer acceptable.
- The attachment gains a `cached` flag, so a CI script does not have to infer it from the
  last attempt's provider.

### Added — a test suite CI can actually run

`npm run test:ci` builds, type-checks the package and the demo, and runs **288 unit
tests**. No browser, no credential, no network, no new dependency — Node's built-in
runner over `dist/`. Before this, the only automated coverage was a demo suite that
needed an API key, so CI had nothing to run.

Covered: redaction and route policy, the intent checks, the selector cache, the CI gate's
message, frame expressions, response parsing, prompt/parser agreement, provider error
mapping, records-file concurrency, config validation, and the run summary.

Three earn more than their count suggests:

- **The prompt and the parser are now pinned to each other.** `PromptBuilder` tells the
  model which JSON keys to emit and `parseResponse` reads exactly those; the test feeds the
  prompt's own worked example through the real parser. A rename on either side used to
  break every heal silently, with the model answering in good faith.
- **Records-file concurrency is re-measured, not asserted from memory.** Four real child
  processes write 15 records each and all 60 must survive. The lock is `open(..., 'wx')`,
  atomic across processes and meaningless within one, so nothing less than real children
  would test it.
- **Provider errors go through `heal()` against a local HTTP server**, covering request
  shaping, retries and error translation together — including the distinction that matters
  on a corporate network: a 401 with Anthropic's JSON error shape is a bad key, a 401 with
  an HTML sign-in page is a proxy, and confusing the two sends people to rotate a
  credential that is fine.

### Added — the report tour is back

`tests/report-example.spec.ts` returns, modernised for the states added since it was
deleted. A scripted provider, so **no key and no network**: a clean heal, a rejected first
guess, a cache reuse, an intent rejection, a below-threshold answer, a provider failure,
and a route excluded by policy. `npm run test:report` needs a browser but no credential.

Unlike the original, the engine is installed in `beforeAll` and undone in `afterAll`.
Module scope would have hijacked the real demo suite whenever a worker ran both files —
verified in both orders.

### Changed

- The demo quick-start now runs `npx playwright test tests/checkout.spec.ts` rather than
  `npm test`, which also runs the report tour and would make the advertised output wrong.

### Added — locators inside iframes heal

Everything inside an iframe was previously beyond the healer's reach, which covers most
payment widgets, embedded reports and SSO flows. `page.frameLocator()` is now wrapped, and
so are the builders on what it returns, including nested frames.

```
frameLocator('#payment-frame').locator('#card-number')
  →  frameLocator('#payment-frame').getByLabel('Card number')
```

The rewrite comes back fully qualified, so it pastes straight into a page object.

**Wrapping `frameLocator()` was only a third of the work.** A page-level accessibility
snapshot shows an `<iframe>` as a bare leaf — the content inside is not there at all — so
the wrapping alone would have produced healing that failed every time at full cost. Two
more parts were needed: the snapshot is now scoped to the frame, and the model's answer is
re-qualified with the frame path before validation, because a model shown a frame's
contents answers in the frame's terms.

- **A frame that does not resolve stops the heal.** Capture returns nothing rather than
  falling back to the parent document, since describing the wrong page produces a
  confidently wrong selector — and no provider call is made, because there would be
  nothing to reason about.
- The demo covers it: `pages/PaymentFramePage.ts` drives two stale selectors inside an
  iframe, so `npm test` catches a regression. The suite is now 4 tests and 13 heals across
  7 distinct selectors (7 provider calls with the cache).

### ⚠️ New disclosure surface

**Healing a locator inside an iframe transmits that iframe's content.** Before this
release, iframe content was never sent, because it never appeared in a snapshot — so if you
audited this package previously, this is the one thing that changed about what leaves the
machine. Iframes are disproportionately payment and identity widgets; redaction applies as
normal, and `HEALER_BLOCKED_PATHS` on the parent route excludes a page and its frames
together.

### Added — the same selector is only healed once

A stale selector normally lives in a page object shared by many tests, so without a cache
the same rot is paid for once per test that touches it. Measured on this repo's demo,
which heals seven distinct selectors across four tests:

| | provider calls | tokens |
|---|---:|---:|
| `HEALER_CACHE=false` | 13 | 9,100 in / 1,170 out |
| `HEALER_CACHE=true` (default) | **7** | **4,900 in / 630 out** |

- **`core/SelectorCache.ts`** — per-worker, in-memory, probed after the privacy gate and
  *before* the snapshot, since capturing the page is itself a browser round trip.
- **Nothing cached is trusted.** Every candidate is re-validated and re-intent-checked
  exactly as a fresh suggestion is, with a 250ms probe validator rather than the default
  1s — up to three candidates are probed before the provider is contacted, so the miss
  path has to stay cheap. A reuse that is wrong for the current page is rejected and a
  normal heal follows.
- **Keyed on the selector alone**, not `(selector, action)`: a field healed for `fill` is
  the same element when later `clear`ed. Instead of a finer key the cache keeps up to
  three candidates per selector and lets validation pick, so a selector meaning different
  things on two pages has both answers cached rather than thrashing between them.
- **`HEALER_CACHE`** (default on) turns it off. It changes cost, not outcomes.
- A reuse is still a heal everywhere it matters — annotated `via cache`, recorded with
  `provider: 'cache'` and zero tokens, listed by the reporter as a rewrite worth
  committing, and it still trips `HEALER_FAIL_ON_HEAL`. The cache makes rot cheaper to
  live with, never invisible.

**No `selector-map.json`**, deliberately. Persisting heals across runs would turn a
recurring cost into a one-off and also into a maintenance trap: page objects rot
indefinitely while a committed JSON file papers over them. That fights the reporter and
the CI gate, which both exist to push the fix into the source.

Two measured interactions: the cache is per worker, so a small suite across many workers
shares less; and
`HEALER_FAIL_ON_HEAL` largely defeats it, because Playwright discards a worker after a
failed test. The second is fine — the gated run exists to hand over the edits once.

### Added — a CI gate

Healing's default behaviour is the one you want locally and the one you do not want in
CI. A heal means the test no longer matches the application: if that is a redesign you
want the rewrite, but if someone deleted a button and the model found a plausible
substitute, a green suite hides the regression.

- **`HEALER_FAIL_ON_HEAL`** (default off) fails a test that only passed because a
  selector was healed. Healing still runs, so the test exercises the whole journey and
  **one run reports every stale selector** rather than stopping at the first. The failure
  message is the list of edits: file, line, selector out, selector in, plus the
  confidence and the element the healer actually landed on.
- **`assertNoHeals()`** is exported for the `attachHealing()` integration path, where the
  caller owns fixture teardown. A no-op unless the flag is set, so it is safe to leave in
  permanently. The fixtures this package ships already call it.
- `HealOutcome.source` and the attachment's `definedAt` record **where the selector is
  written** — normally the page object — as distinct from the test that exercised it.

**No "fail only on unverified heals" mode**, deliberately. It sounds like a safer middle
ground and is not one: the regression this gate catches is by definition a plausible
substitute, so it is exactly the kind of heal the intent checks approve.

### Fixed

- **The gate's first version pointed at the wrong file.** `getCallerLocation()` prefers a
  `.spec.ts` frame, which correctly answers *which test healed* but not *where do I edit
  the selector* — so a rewrite for a selector defined in `pages/CartPage.ts` was reported
  against `tests/checkout.spec.ts`, a file that does not contain it. Both frames were
  already computed by the same stack walk; `CallerLocation.source` now carries the page
  object and the message leads with it. Found by running the feature, not by reading it.

## [0.3.0] — 2026-08-23

Closes the two issues that decided whether this could be pointed at a real application:
**page content was sent to the provider unfiltered**, and **a confidently wrong heal
produced a false-green test**. Healing records now also keep the model's reasoning, which
was previously parsed and discarded.

### ⚠️ Changed defaults — read this before upgrading

Two controls now ship switched on. Both were chosen over shipping them off, because a
consumer who installs this and never reads the docs should not be transmitting a page in
full, nor trusting an unverified heal.

| Setting | Default | Restore old behaviour |
|---|---|---|
| `HEALER_REDACT` | `identifiers` | `HEALER_REDACT=off` |
| `HEALER_INTENT_CHECK` | `enforce` | `HEALER_INTENT_CHECK=off` |

**Intent checking can turn a passing test red.** That is the point — the heals it refuses
were landing on the wrong element — but if you need to adopt it gradually, use
`HEALER_INTENT_CHECK=warn`, which runs every check and records the concern while still
healing. Measured against this repo's demo, all ten heals (five with `describe()`, five
without) are still accepted.

### Added — is the healed element the right one?

`SelectorValidator` proves a suggestion resolves to one visible element. That is also
true of the *wrong* element: this repo's checkout page has `button "Place order"` and
`button "Cancel"`, both unique, visible and clickable. A heal onto Cancel passed every
gate, the click succeeded, and a test with loose assertions went green having tested
nothing.

- **`core/IntentVerifier.ts`** — four checks after validation, ordered most-objective
  first: **action compatibility** (you cannot `fill()` a button — a DOM fact, so it never
  rejects a correct heal), **self-consistency** (the model now reports the role and name
  it believes it selected; a selector resolving to something else is discarded),
  **role preservation**, and **lexical intent** built from the selector text and
  `describe()`.
- **`HEALER_INTENT_CHECK=off|warn|enforce`** and **`HEALER_UNVERIFIED_CONFIDENCE`**
  (default 0.9), the latter applying only when no check has any signal — an opaque
  selector with no `describe()`. Adding `describe()` is the better fix.
- Every rejection is fed into the next attempt, so this is a signal as well as a gate.
- The prompt now asks the model to match *intent* rather than anything clickable nearby,
  to respect the action's role constraint, and to report `expectedRole`/`expectedName`.
  Both response fields are optional, so a model that ignores them still heals.

### Added — an audit trail for heals

- **`HealRecord.reasoning`** — every provider already parsed the model's justification and
  then dropped it, so the token spend bought an explanation nobody could read.
- **`HealRecord.intent`** — which checks had evidence, and what the element turned out to
  be. A heal listing only `confidence-floor` is one nothing could corroborate, and the
  annotation now says so.

### Added — what may leave the machine

`HEALER_REDACT=identifiers` strips emails, card- and SSN-shaped numbers, GUIDs, tokens,
long account numbers, dates, postcodes, IPs and IBANs from everything sent to a provider,
and drops URL query strings.

**What this may change for you.** Healing quality is unaffected on the pages we measured
— every accessible name a locator resolves through survives, including field labels and
button text. But if a locator heals via *page content that happens to look like an
identifier* (an order number, a date), the model will now see a placeholder instead.
Check with the preview mode below before deciding.

- **`core/PrivacyGuard.ts`** — the single egress choke point, enforced inside
  `HealingEngine` where the request is assembled. **Unlike the rest of this package it
  fails closed:** a policy it cannot evaluate, a URL that will not parse, or a redactor
  that throws abandons the heal and re-throws your original Playwright error.
- **`HEALER_REDACT=off|identifiers|strict`.** `strict` additionally collapses the
  accessible name of every element you cannot act on, and the value of every element you
  can — which catches names, addresses and free text that no regex can, because it does
  not try to recognise them. Button and field labels are kept, so healing still works.
- **`HEALER_ALLOWED_ORIGINS` and `HEALER_BLOCKED_PATHS`.** When origins are set they act
  as an allowlist and healing is refused everywhere else; blocked path globs take
  precedence. A refused heal never reads the page.
- **`HEALER_SNAPSHOT_ROOT`** — scope the snapshot to one container. `AriaSnapshotOptions`
  already supported this but the engine never passed it, so there was no way to capture
  less. Cuts disclosure and token cost together. **A configured root is never exceeded:**
  both capture strategies honour it, and a root that does not resolve blocks the heal
  rather than falling back to the whole page.
- **`HEALER_PRIVACY_PREVIEW=<dir>`** — writes the exact payload each heal *would* send to
  a file and contacts no provider. **Needs no API key**, deliberately: requiring a
  credential to find out what gets transmitted would put the audit trail behind the
  approval it exists to inform. No heal can succeed while it is set.
- **`HEALER_REDACT_PATTERNS_FILE`** for extra regexes, and a `redactor` callback on
  `HealingOptions` that can veto a heal by returning `null` — the hook for a local
  classifier or a corporate DLP library. Both are treated as instructions rather than
  defaults, so they apply at **every** level including `off`; `off` disables only the
  built-in rules.
- **`heal-blocked` annotation** and a blocked count in the run summary, so healing
  stopped by policy never looks like healing that was never needed.
- The run summary now names what was transmitted and under which policy, in one line.
- **`npm run test:unit`** — 76 tests over the redaction, route and intent rules using
  Node's built-in runner. No browser, no API key, no new dependency, no cost. They assert
  a corpus of values never appears in a payload, and two of them caught real defects
  during development: `strict` transmitting names through the Playwright error message,
  and a suggestion able to certify itself against the intent check.
- `README.md` gains a **What is transmitted** section — what is sent, what never is, and
  how to restrict it. `INTEGRATION.md` gains a pre-flight checklist for pointing this at
  a real application.

### Fixed

- **`HEALER_SNAPSHOT_ROOT` could widen a capture instead of narrowing it.** Introduced and
  fixed within this release, but worth recording because the failure inverted the control:
  `getDomSnapshot` ignored `root`, so a root that did not resolve — a typo, *or simply a
  container absent from the page being healed* — fell back to scanning the whole document
  including `element.value`. Both capture strategies now honour `root`, neither
  substitutes the document, and the engine blocks the heal when a configured root is
  missing. It also cost a 30-second stall per heal, now a 1-second check.
- **Four disclosure channels beyond the page snapshot**, none of them obvious:
  the Playwright `error.message` (strict-mode violations quote matched element text); the
  DOM-scan fallback (`getDomSnapshot` captures `element.value`, so a half-filled form was
  *typed user input*); the page URL's query string and path; and the `screenshot` field,
  now dropped unconditionally — it was never populated, but it would have shipped pixels
  the moment anyone wired it up.
- Three docstrings claimed the report attachment contains the model's `reasoning`. It did
  not — `HealRecord` had no field for it, so every provider parsed it and dropped it. Both
  the docs and the omission are fixed; see the audit-trail section above.

### Added — packaging and the demo suite

- `ARCHITECTURE.md` — how the wrapping, healing, validation, reporting and record-keeping
  actually work, plus a risk register of the Playwright behaviours this package depends
  on. Ships with the package.
- The demo suite now lives in this package: `app/` (static application), `pages/` (page
  objects written against the app's old selectors), `fixtures.ts` and `tests/`. `npm test`
  runs it. None of it is packed — `files` covers `dist`, `src` and the docs only.
- `npm run typecheck:demo` type-checks the demo via `tsconfig.demo.json`, since the demo
  is deliberately outside the build.

### Removed — the demo's scripted provider and the live specs

- The separate `sample_pom_framework` project, folded into this package.
- The scripted demo provider (`support/demo-healer.ts`) and its wiring in `fixtures.ts`.
  **The demo now requires a real provider key**; without one it runs unhealed and fails
  on the first stale selector. `npm run check:setup` reports which of those you are in
  and makes no API call. `HEALER_PRIVACY_PREVIEW` covers the case the scripted provider
  used to serve — exercising the full pipeline without a credential — and does it against
  the real prompts rather than a simulation.
- `tests/report-example.spec.ts` and `tests/live-healing.spec.ts`, and with them the
  `test:live` script and `scripts/run-live.js`. **This removes the only regression
  coverage of the reporting failure paths** (below-threshold suggestions, provider
  errors, healing unavailable) **and the only checks against a real provider.** The demo
  suite exercises the successful path end to end but asserts nothing about the failure
  paths or the model's judgement.

### Known gaps

- Selectors coming *back* from the model are still logged and annotated unredacted, so
  `getByText('Smith, John')` can reach CI output. Redaction governs what goes *to* the
  provider, not what comes back.
- `identifiers` cannot catch names or free text. That is a property of regex matching, not
  an implementation shortfall — use `strict` or the route allowlist for unstructured
  personal data. Documented rather than papered over.

## [0.2.1] — 2026-08-21

### Changed

- **Default Anthropic model is now `claude-haiku-4-5`** (was `claude-opus-5`). Healing is
  a high-volume, narrowly scoped task — read a page snapshot, name one element — so the
  cheapest capable model is the right default. At roughly 700 input and 90 output tokens
  per heal this is about **$0.00115 per heal**, against $0.0055 on Opus. Override with
  `ANTHROPIC_MODEL`.

### Added

- `npm run check:setup` — reports where `.env` was found, the resolved configuration, the
  key's shape (masked), estimated cost per heal, and whether `dist` is stale. Makes **no
  API call**.
- `npm run check:key` — the same report plus one ~15-token request to prove the
  credential works before a real run.
- `.env.example` for the sample framework, with the per-run cost of using a real model.

### Fixed

- `tests/report-example.spec.ts` could fail intermittently under parallel workers: two
  describe blocks mutate process-wide engine state, and their order is not guaranteed.
  Each block now installs the engine it needs rather than inheriting it.

## [0.2.0] — 2026-08-20

First distributable release: installable as a tarball and composable into an existing
Playwright framework.

### Added

- **Composable integration API** so healing can be added to any existing framework
  without rewriting its fixtures:
  - `healingFixtures` — spread into your own `test.extend()`
  - `withHealing(test)` — wrap an existing test object; layers on top of a custom
    `page` fixture instead of overwriting it
  - `attachHealing(page)` — call inside your own `page` fixture
  - `createHealingFixtures(options)` / `createHealingEngine(options)` — configure in
    code instead of `.env`
- **OpenAI provider** (Chat Completions, `OPENAI_BASE_URL` for Azure and compatible
  gateways) and **Gemini provider** (Generative Language API).
- **Report integration**: `healed` / `heal-failed` / `heal-unavailable` annotations, a
  `healing-*.json` attachment per healed action carrying every attempt, a labelled step
  in the trace, and a `self-healing-playwright/reporter` run-level summary that lists
  the `#old → new` selector rewrites worth committing.
- `HealingEngine.attemptHealDetailed()` returning the full `HealOutcome`, and an
  `onOutcome` engine option.
- `INTEGRATION.md`, `README.md`, `CHANGELOG.md`; `npm run package` and
  `npm run verify:package`.

### Changed

- **Removed the `@anthropic-ai/sdk` dependency** (6.6 MB, 1384 files, 2 transitive
  packages). `AnthropicProvider` now calls the Messages API through the same HTTP
  helper as the other providers, leaving `dotenv` as the only runtime dependency so the
  tarball installs without registry access to anything else.
  *Consequence:* credentials must come from `ANTHROPIC_API_KEY` or be passed in; the
  SDK's `ant auth login` profile resolution is no longer available.
- `@playwright/test` is now a **peer dependency** (`>=1.53 <2`) rather than a direct
  dependency, so a consumer's own Playwright copy is used. Two copies would mean two
  different `test` objects and fixtures that silently don't apply.
- `typescript` moved to `devDependencies`; added `engines: node >=18`.
- `.env` is loaded **lazily** on first config access instead of at import time —
  importing the package no longer mutates a consumer's `process.env`.
  `HEALER_SKIP_DOTENV=1` opts out entirely.
- `package.json` gained `exports` (including the `./reporter` subpath) and `files`.

### Fixed

- Healing outcomes are now published from the wrapper rather than wired through the
  engine constructor, so an engine supplied via `setHealingEngine()` reports to the
  Playwright report identically to a built-in one.
- Attempt records are passed through the call rather than held on the engine, so
  concurrent heals on one engine can no longer mix up their outcomes.
- `locator.describe()` chains through to Playwright's native method instead of
  replacing it, preserving trace-viewer and report labelling.
- Wrapped actions preserve Playwright's own error labels (`locator.click: Timeout …`);
  `bind`/`apply`/`call` indirection had been corrupting them.

## [0.1.0] — 2026-08-19

Initial internal version: config, types, `AiProvider` base class, Anthropic provider
(SDK-based), healing engine, selector validator, DOM snapshot, healing recorder, prompt
builder, and a `test` fixture with healing.
