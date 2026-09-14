# Audit — known gaps

> **Internal document. Deliberately not shipped in the package** — it is absent from
> `files` in `package.json` on purpose. Two consequences worth keeping:
>
> - **Nothing under `src/` may reference this file.** `src/` ships, so a comment or
>   console warning pointing at `AUDIT.md` is a dead pointer inside a consumer's
>   `node_modules`. State the concern itself instead.
> - **Consumer-facing caveats live in README's Limitations section**, not behind a link
>   to here. When a finding is a risk someone installing the tarball should know about,
>   the finding is only half-done until that section says so in its own words.

Findings from an internal review on **2026-08-22**, against commit `4bc6ce7`
(`v0.2.1` plus unreleased changes), plus findings added while fixing them.

Read this before pointing the healer at a production suite — though as of 0.4.0,
**nothing here is open**. Three findings remain `Accepted`: understood,
deliberately not fixed, reasoning recorded.

**Every finding is now resolved** — 1, 2, 7 and 19 in 0.3.0; 3, 4, 5, 6, 8, 9, 10, 11,
12, 13, 14 and 18 in 0.4.0; 15, 16 and 17 `Accepted` with reasoning.
What page content is transmitted and how to restrict it is documented in
[README § What is transmitted](README.md#what-is-transmitted); how a healed element is
checked against intent is in
[README § Is it the right element?](README.md#is-it-the-right-element).

## Legend

| Severity | Meaning |
|---|---|
| **Critical** | Can cause silent incorrect results, or blocks production use outright |
| **High** | Real cost, safety or maintainability problem; fix before wider rollout |
| **Medium** | Limits usefulness or will cause confusion; fix when convenient |
| **Low** | Cosmetic, or accepted with reasoning |

| Status | Meaning |
|---|---|
| `Open` | Agreed gap, not started |
| `Accepted` | Understood and deliberately not being fixed; reasoning recorded |
| `Fixed` | Resolved — move the entry to CHANGELOG.md and note the version |

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Page content is sent to a third party unfiltered | Critical | `Fixed` (0.3.0) |
| 2 | A confidently wrong heal produces a false-green test | Critical | `Fixed` (0.3.0) |
| 3 | Healing can mask real regressions; no CI gate | Critical | `Fixed` (0.4.0) |
| 4 | No spend cap and no circuit breaker | High | `Fixed` (0.4.0) |
| 5 | The same selector is healed repeatedly | High | `Fixed` (0.4.0) |
| 6 | No automated test coverage | High | `Fixed` (0.4.0) |
| 7 | README contradicts the code (scripted fallback) | High | `Fixed` (0.3.0) |
| 8 | `frameLocator()` is not wrapped | Medium | `Fixed` (0.4.0) |
| 9 | The reporter parses data out of prose | Medium | `Fixed` (0.4.0) |
| 10 | `healing-records.json` grows without bound | Medium | `Fixed` (0.4.0) |
| 11 | Hardcoded token prices drift | Medium | `Fixed` (0.4.0) |
| 12 | No LICENSE file despite declaring MIT | Medium | `Fixed` (0.4.0) |
| 13 | `describe()` is load-bearing but optional and unmeasured | Medium | `Fixed` (0.4.0) |
| 18 | Healed selectors reach logs and annotations unredacted | Medium | `Fixed` (0.4.0) |
| 19 | The model's reasoning is parsed and discarded | Medium | `Fixed` (0.3.0) |
| 14 | Record lock gives up after ~1s | Low | `Fixed` (0.4.0) |
| 15 | No prompt caching | Low | `Accepted` |
| 16 | CommonJS-only build | Low | `Accepted` |
| 17 | Error labels rely on Playwright internals | Low | `Accepted` |

Findings 18 and 19 were discovered while fixing finding 1 and keep the numbering they
were assigned; the table is ordered by severity, not by number.

---

## Critical

### 1. Page content is sent to a third party unfiltered — `Fixed` in 0.3.0

Every heal sent the page's accessibility snapshot to the configured provider. That
snapshot contains whatever is on screen: patient identifiers, prescriber names, contract
values, pricing. There was no redaction, no per-page opt-out, and no allowlist of routes
cleared for healing.

**Evidence was:** `src/utils/PromptBuilder.ts:89` embedded `request.ariaSnapshot`
verbatim into the prompt. Nothing between `getAriaSnapshot()` and the provider call
inspected it.

**Investigating it turned up four more channels than this finding recorded:**

| Channel | Why it leaked |
|---|---|
| `error.message` | Playwright quotes matched element text in strict-mode violations. Page content wearing a framework hat. |
| DOM-scan fallback | `getDomSnapshot` captures `element.value` — *typed user input*, not rendered text. Worse per byte than the snapshot, and it triggers exactly when things are going wrong. |
| `pageUrl` | Identifiers in paths and query strings. |
| Logs and annotations | The healed selector comes back from the model, so `getByText('Smith, John')` reaches CI output. **Still open — see finding 18.** |

**Fixed by** a new `core/PrivacyGuard.ts`, enforced inside `HealingEngine` at the single
point the request is assembled — not in the fixture layer, because `setHealingEngine()`
bypasses that:

- **Route policy.** `HEALER_ALLOWED_ORIGINS` (an allowlist once set) and
  `HEALER_BLOCKED_PATHS` (globs, taking precedence). A refused heal reports itself as a
  new `heal-blocked` annotation and in the run summary. The page is never read.
- **Redaction,** `HEALER_REDACT=off|identifiers|strict`, **defaulting to
  `identifiers`** — a behaviour change, taken deliberately. `strict` additionally
  collapses the accessible name of every non-actionable role, which catches names and
  free text that no regex can.
- **Snapshot scoping,** `HEALER_SNAPSHOT_ROOT`. `AriaSnapshotOptions.root` already
  existed but the engine never passed it, so there was no way to capture less.
- **Custom rules.** `HEALER_REDACT_PATTERNS_FILE`, and a `redactor` callback that can
  veto a heal by returning `null`.
- **Preview mode,** `HEALER_PRIVACY_PREVIEW=<dir>` — writes the exact payload that would
  have been sent and calls nothing. Works with **no API key**, deliberately: requiring a
  credential to discover what gets transmitted would put the audit trail behind the
  approval it exists to inform.
- **Fails closed.** The one place in this package that does. An unevaluable policy, an
  unparseable URL, or a redactor that throws abandons the heal.
- **`screenshot` is dropped unconditionally.** It was never populated, but the field
  existed and would have shipped pixels the moment someone wired it up.

**Verified:** 43 unit tests (`npm run test:unit`, no browser or key) assert a corpus of
values never appears in a payload — one of which caught a real leak in the first
implementation, where `strict` still transmitted names through the error message. Live
runs against the demo confirmed the route gate blocks before capture, and that the
demo's five stale selectors still heal at every redaction level.

**Effort:** ~1.5 days, against the ~1 day estimated here — the extra went on the channels
listed above and on preview mode.

**Not covered:** finding 18 below.

### 2. A confidently wrong heal produces a false-green test — `Fixed` in 0.3.0

Validation checked uniqueness and visibility, not intent. Any suggestion resolving to
exactly one visible element was accepted. If the model picked "Cancel" instead of
"Submit" and the test's assertions were loose, the test passed while exercising the wrong
path.

**Evidence was:** `src/core/SelectorValidator.ts:175-197` — the gates were
`matches === 0`, `matches > 1`, and `isVisible()`. Nothing compared the healed element's
role or accessible name against the original intent.

**It was reachable in this repo's own demo.** The checkout page has `button "Place order"`
and `button "Cancel"`; the second is unique, visible and clickable, so every gate passed.
Demo test 3 asserts the confirmation is *hidden* after placing an order without accepting
terms — which is also true after clicking Cancel. Proved end to end against a real browser
with a stub provider:

```
HEALER_INTENT_CHECK=off      healed to getByRole('button', { name: 'Cancel' })
                             >> ACCEPTED. Test clicks Cancel and passes. FALSE GREEN.
HEALER_INTENT_CHECK=enforce  >> REFUSED: the suggestion's name ("Cancel") shares no
                                wording with the intended element (order, place, submit)
```

**Fixed by** a new `core/IntentVerifier.ts`, running after validation inside the heal
loop. Four checks, decreasing in objectivity:

- **Action compatibility.** You cannot `fill()` a button or `check()` a link. The action
  constrains the role, and this is a DOM fact rather than a judgement — so it rejects
  wrong heals without ever rejecting right ones. **This finding did not mention it, and
  it is the strongest check here.**
- **Self-consistency.** The prompt now asks for `expectedRole` and `expectedName`; if the
  selector the model wrote resolves to something else, the suggestion is discarded. Also
  false-positive-free, because it measures the model against reality rather than against
  our guess at intent.
- **Role preservation,** as proposed — extended to tag-qualified CSS (`button#submit`)
  and `getByPlaceholder`, which can only match an editable field.
- **Lexical intent,** as proposed, but built from the *selector text as well as*
  `describe()`. Identifiers carry meaning: `#place-order-btn` is about placing an order,
  which is why healing works at all. Rejecting purely on a description mismatch would
  have been too brittle — descriptions are free prose and may share no words with a
  label.
- **Confidence floor,** as proposed: `HEALER_UNVERIFIED_CONFIDENCE` (default 0.9) when no
  check has any signal.

Configurable via `HEALER_INTENT_CHECK=off|warn|enforce`, defaulting to **`enforce`**.
`warn` runs every check and records the concern while still healing, for adopting this on
an existing suite.

**Two design errors that measurement caught,** both recorded in ARCHITECTURE.md:

1. Exact token matching rejected a *correct* heal — the demo's `#promo-field` →
   `getByLabel('Promotion code')`, because `promo` ≠ `promotion`. Now prefix-matched with
   a four-character floor, which still keeps `can` from matching `cancel`.
2. Confirming and rejecting needed different thresholds. A single shared word is enough
   to confirm (`#checkout-button` against a button named "Checkout"), but not enough to
   refuse. A symmetric threshold pushed a fully corroborated heal onto the confidence
   floor.

**Verified:** 33 unit tests including a false-green regression case, plus a live run
confirming all ten demo heals — five with `describe()`, five without — are still accepted,
none falling through to the confidence floor.

**Effort:** ~1 day, as estimated, including the prompt change.

**Residual risk, documented rather than hidden:** these checks catch a wrong element that
shares no vocabulary with the intent. They cannot catch a wrong element that shares
plenty — two buttons both named "Save". Finding 3 (`HEALER_FAIL_ON_HEAL`) is the control
for that, since it puts a human in the loop on every heal.

### 3. Healing can mask real regressions; no CI gate — `Fixed` (0.4.0)

If a developer removed a button, healing might find a plausible substitute and the suite
went green — so the regression shipped. There was no mode where a heal reported itself and
still failed the build.

**Evidence was:** no `failOnHeal` / `HEALER_FAIL_ON_HEAL` anywhere in `src/`. A healed
test passed with an annotation only.

**Fixed as proposed:** `HEALER_FAIL_ON_HEAL=true`, default off, recommended for CI in
INTEGRATION.md. Two design choices worth recording:

- **The gate runs in fixture teardown, not at the heal site.** Failing immediately would
  report one stale selector per run, so finding five would take five runs — and the list
  of rewrites is the entire value of the mode. Heals accumulate during the test and the
  gate throws once at the end. Verified against Playwright: a teardown throw fails an
  otherwise-passing test, and when the body already failed **both** errors are reported,
  so the gate cannot mask a genuine failure.
- **No graduated "fail only on unverified heals" mode.** It sounds like a safer middle
  ground and is not one: the regression this gate catches is *by definition* a plausible
  substitute, so it is exactly the kind of heal finding 2's checks approve. Gating on
  verification quality would let the case through while feeling rigorous.

**It exposed a flaw in `getCallerLocation()`.** That function prefers a `.spec.ts` frame,
which correctly answers *which test healed* — but the gate needs *where do I edit the
selector*, and the selector lives in the page object. The first version of the message
pointed at `tests/checkout.spec.ts` for a selector defined in `pages/CartPage.ts`, which
would have made the feature actively misleading. Both frames were already computed by the
same stack walk, so `CallerLocation.source` now carries the page-object frame and the
message leads with it. Caught by running it, not by reading it.

**Verified:** the demo's five stale selectors in one test produce one failure listing all
five, each against the correct page-object file, each with the intent checks that
approved it. 91 unit tests, 11 of them on the message — because the message *is* the
feature.

**Effort:** ~half a day, as estimated.

**Residual:** the reported line is where the locator is *used*, not where it was
constructed. Capturing the construction site would mean a stack walk inside
`decorateLocator` for every locator a suite creates — real overhead for a marginal gain,
since the file is right and the selector string is in it.

---

## High

### 4. No spend cap and no circuit breaker — `Fixed` (0.4.0)

A suite with 400 rotted selectors made 400-800 provider calls with no ceiling. If the
provider was down, every failing action still waited `HEALER_TIMEOUT` x
`HEALER_MAX_RETRIES` before giving up, so an outage turned a 5-minute suite into an hour.

**Fixed by** `core/HealBudget.ts`, both controls per worker, both on by default.

- **`HEALER_MAX_HEALS`** (default 100) bounds provider-backed heals. Checked **after** the
  cache, which is what makes it usable: an exhausted worker carries on reusing what it
  already learned rather than stopping dead. Reported as a new `heal-skipped` annotation,
  kept distinct from `heal-blocked` because the responses differ - raise a ceiling versus
  review a privacy policy.
- **`HEALER_BREAKER_THRESHOLD`** (default 5) stops a worker calling a provider that keeps
  failing. Counted in *attempts*, so an outage is caught in roughly
  `threshold / HEALER_MAX_RETRIES` failing actions rather than after whole heals exhaust
  their retries.

**The distinction that took the most care:** a low-confidence answer is **not** a provider
failure. The provider is working fine, and a breaker that tripped on an unsure model would
disable healing for entirely the wrong reason. Only a failed *call* counts, and any
success clears the consecutive count.

**Named honestly rather than as proposed.** The finding suggested
`HEALER_MAX_HEALS_PER_RUN`. Workers are separate processes, so a true per-run budget needs
the records file's lock-file dance to coordinate a counter on every heal - for a number
that only has to be approximately right. It is per worker, the effective total is
`x workers`, and that multiplication is documented rather than buried.

The breaker latches rather than half-opening: a run lasts minutes, so probing a dead
provider again buys a slow retry and no information.

**Verified:** 18 unit tests, including that the breaker reports before the budget - when
the provider is down, saying so beats reporting a ceiling that was never the problem.

**Effort:** ~half a day, as estimated.


### 5. The same selector is healed repeatedly — `Fixed` (0.4.0)

Nothing remembered a heal. In the demo suite `#checkout-button` was healed once per test —
three times per run — and again on every future run until someone edited the page object.
On a real suite this repetition is the dominant cost.

**Evidence was:** no cache in `HealingEngine` or `TestWrapper`; `getAriaSnapshot` was
de-duplicated per heal but nothing was de-duplicated across heals.

**Fixed by** `core/SelectorCache.ts`, in-memory and per-worker, probed after the privacy
gate and *before* the snapshot — capturing the page is itself a browser round trip.
Measured on the demo:

| | provider calls | tokens |
|---|---:|---:|
| `HEALER_CACHE=false` | 13 | 9,100 in / 1,170 out |
| `HEALER_CACHE=true` (default) | **7** | **4,900 in / 630 out** |

Both runs still report `healed: 13`, so the rot is cheaper to live with but not hidden.

**Two departures from the proposal, both deliberate:**

- **Keyed on the selector alone, not `(selector, action)`.** A field healed for `fill` is
  the same element when later `clear`ed, so splitting would halve the hit rate for
  nothing; where an action really does imply a different element, the intent check's
  action-compatibility gate rejects the hit. Instead of a finer key the cache keeps **up
  to three candidates per selector** and lets validation pick, so a selector meaning
  different things on two pages has both answers cached rather than thrashing between
  them — and every thrash would be a full provider call.
- **No `selector-map.json`.** It would turn a recurring cost into a one-off and also into
  a maintenance trap: page objects rot indefinitely while a committed JSON file papers
  over them. That fights the reporter and finding 3's gate, which both exist to push the
  fix into the source. Making rot free removes the incentive to fix it. Recorded as a
  decision, not an omission.

**Nothing cached is trusted.** Every candidate is re-validated and re-intent-checked
exactly as a fresh suggestion is, with a 250ms probe validator rather than the default 1s,
because up to three probes run before the provider is contacted and the miss path has to
stay cheap. A reuse is recorded with `provider: 'cache'`, zero tokens, and still counts as
a heal in the annotation, the records file, the reporter's rewrite list, and the CI gate.

**Measured interactions worth knowing:**

- The cache is per worker, so a small suite spread across many workers shares less.
- `HEALER_FAIL_ON_HEAL` largely defeats it, because **Playwright discards a worker after
  a failed test**. Verified by counting module loads: 2 with the gate off, 4 with it on.
  Acceptable, since the gated run is the one that hands over the edits.

**Effort:** ~half a day, as estimated for the in-run cache.

**Follow-on:** the reporter cannot count reuses separately because it reads annotations as
prose — one more thing finding 9 would unlock. The token totals show the saving instead.

### 6. No automated test coverage — `Fixed` (0.4.0)

`tests/report-example.spec.ts` and `tests/live-healing.spec.ts` were deleted on
2026-08-22. Nothing tested prompt parsing, provider error mapping, validator rules,
recorder concurrency, or any reporting path. The demo suite covered the happy path only,
and since finding 7 it could not run at all without a key — so CI had nothing to run.

**Fixed by 288 unit tests** needing no browser, no credential and no network, plus the
restored report tour. `npm run test:ci` is the gate: build, type-check both projects, run
the unit tests.

| Area | Tests | Why it earns its place |
|---|---:|---|
| `PrivacyGuard` | 34 | A corpus of values that must never appear in a payload |
| `SelectorValidator` | 35 | Argument parsing, refinements, and the rejection rules |
| `IntentVerifier` | 29 | Every check, plus the false-green regression case |
| `AiProvider.parseResponse` | 27 | The response contract, incl. confidence defaulting to 0 |
| `config` | 27 | The strict defaults, and every parse error message |
| `HealingRecorder` | 23 | Legacy formats, merging, **and four real processes** |
| `provider` errors | 20 | Real HTTP over a local server: 401/403/404/429, retries |
| `PromptBuilder` | 20 | Including that the prompt and parser still agree |
| `frameLocator` expressions | 18 | Escaped quotes, nesting, qualification |
| `HealingReporter` | 15 | Counting, dedup, and the prose-parsing weakness |
| fail-on-heal message | 15 | The message *is* the feature |
| `SelectorCache` | 12 | Eviction, promotion, and the disabled path |

**Three of these are worth more than their count suggests:**

- **The prompt/parser agreement test** feeds the prompt's own worked example through the
  real parser. That coupling is called load-bearing in ARCHITECTURE.md and was enforced by
  nothing — a rename on either side would have broken every heal while the model answered
  in perfectly good faith.
- **The recorder concurrency test** spawns four real processes writing 15 records each and
  asserts 60 survive. ARCHITECTURE.md claimed exactly that, measured once by hand and never
  again; `open(..., 'wx')` is atomic across processes and meaningless within one, so this
  could only ever be tested with real children.
- **Provider errors go through `heal()` against a local HTTP server**, not by reaching into
  the private `describeError`. That covers request shaping, the retry policy and the error
  translation together — and pins the distinction that matters on a corporate network: a
  401 carrying Anthropic's JSON error shape is a bad key, a 401 carrying an HTML sign-in
  page is a proxy, and calling the second one a bad key sends people to rotate a
  credential that is fine.

**The report tour is restored** as `tests/report-example.spec.ts`, modernised for the
states added since it was deleted. Scripted provider, so no key and no network: a clean
heal, a rejected first guess, a cache reuse, an intent rejection, a below-threshold answer,
a provider failure, and a route excluded by policy. It is installed in `beforeAll` and
undone in `afterAll` — the original set the engine at module scope, which would hijack the
real demo suite whenever a worker ran both files. Verified in both file orders.

**Two of the new tests found bugs in the tests rather than the code**, which is worth
recording as a caution: an assertion that `Infinity` in JSON becomes confidence 0 (it is
not valid JSON, so the parse fails earlier — `1e999` is the real case), and a cache
assertion that inherited a cache entry from an earlier test, because the cache is per
worker by design.

**Effort:** ~1 day, as estimated.

**Still uncovered, deliberately:** `TestWrapper`'s locator decoration and the engine's
orchestration are exercised end to end by the report tour and the demo rather than by
unit tests — they are mostly Playwright integration, where a stub would assert that the
mock was called rather than that healing works. No CI workflow file is shipped either;
guessing the provider would be noise to delete.

### 7. README contradicts the code — `Fixed` in 0.3.0

`README.md:59-62` stated that without a provider key the demo falls back to a scripted
provider in `support/demo-healer.ts`. That file had been deleted and its call removed from
`fixtures.ts`, so `npm test` failed without a key and a newcomer following the quick-start
got three red tests.

**Resolved by the second option, not the first.** The scripted provider's removal was
deliberate, so it was not restored. The quick-start now states plainly that the demo calls
a real provider and needs a real key, and leads with the `check:setup` / `check:key` flow —
`check:setup` costs nothing and says which situation you are in. `NODE_EXTRA_CA_CERTS` is
now called out in the demo section rather than left as a footnote further down.

`HEALER_PRIVACY_PREVIEW` (added for finding 1) turns out to cover what the scripted
provider was for — exercising the snapshot, redaction, prompt assembly and reporting
without a credential — and does it against the *real* prompts rather than a simulation.
So the capability came back without the maintenance cost of a second fake provider.

**Also cleared in the same pass:** every reference to `AUDIT.md` from a shipping file.
`AUDIT.md` is deliberately excluded from `files`, so the README link in Limitations, two
`console.warn` strings in `src/config.ts`, a comment in `src/reporters/`, and several
`finding N` pointers in `CHANGELOG.md` and `ARCHITECTURE.md` were all dangling for anyone
installing the tarball. README's Limitations section now states the caveats in its own
words — see the note at the top of this file.

**Effort:** ~1 hour, as estimated.

---

## Medium

### 8. `frameLocator()` is not wrapped — `Fixed` (0.4.0)

Anything inside an iframe never healed: payment widgets, embedded reports, most SSO flows.

**Evidence was:** no reference to `frameLocator` or `contentFrame` in `src/`.

**The proposed fix was only a third of the job.** Wrapping `frameLocator()` and composing
the expression is necessary but not sufficient, and measuring first is what showed why — a
page-level accessibility snapshot does not cross into a frame:

```
- heading "Payment" [level=1]
- iframe                      ← that is all. No content.
- button "Cancel order"
```

So the wrapping alone would have produced healing that failed every time at full cost: the
model asked to name an element in a tree that does not contain it. Three parts were needed:

| Part | Where |
|---|---|
| Wrap `page.frameLocator()`, decorate its builders, compose the expression | `decorateFrameLocator` in `core/TestWrapper.ts` |
| Parse and resolve frame-scoped expressions, including nesting | `splitFrameChain` / `resolve` in `core/SelectorValidator.ts` |
| **Capture the frame's tree instead of the page's** | `frames` option in `utils/DOMSnapshot.ts` |

`FrameLocator` turned out to expose the same builder surface as `Page` — `locator()`, the
seven `getBy*` helpers, and a nested `frameLocator()` — so one `LocatorRoot` type serves
both and one resolver walks an arbitrary frame path.

**The expression carries the frame path**, so no new metadata was needed anywhere: the
engine reads it back out of the failing selector to know which frame to snapshot, and the
suggested rewrite is real Playwright source that pastes straight into a page object.

**The answer is qualified rather than trusted to be.** Shown a frame's snapshot, a model
answers in the frame's terms — `getByLabel('Card number')`, no mention of the frame — which
taken literally resolves against the parent document. `qualifyWithFrames()` puts the prefix
back before validation, so the validator, intent check, cache, record and rewrite all agree.
Relying on the prompt to make the model echo the prefix would have been the fragile version.

**Two refusals to widen**, both the lesson the snapshot-root bug taught: capture returns
empty rather than falling back to the parent document when a frame will not resolve, and the
engine then stops rather than paying for a call with nothing to describe.

**Verified:** 18 unit tests on the expression handling, including escaped quotes and
selectors containing commas and brackets; a live probe confirming the snapshot is the
frame's content and not the parent's, and that a bad frame selector transmits nothing. The
demo now covers it — `pages/PaymentFramePage.ts` drives two stale selectors inside an
iframe, so `npm test` would catch a regression.

**New disclosure to be aware of:** iframe content was previously never transmitted, because
it never appeared in a snapshot. It is now, for frame-scoped heals. Iframes are
disproportionately payment and identity widgets, so this is called out in README's "What is
transmitted"; redaction applies as normal and `HEALER_BLOCKED_PATHS` on the parent route
excludes a page and its frames together.

**Effort:** ~1 day.

### 9. The reporter parses data out of prose — `Fixed` (0.4.0)

`HealingReporter` reconstructed token counts by regexing the annotation description.
Rewording an annotation would silently zero the totals.

**Evidence was:** `addTokens(detail)` regexed `(\d+) in / (\d+) out tokens` out of the
human-readable string, and `collectRewrites` regexed the `"#old" → "new"` arrow out of it.

**Fixed by the first of the two proposed options** — reading the `healing-*.json`
attachment. The second (a machine-readable annotation beside the prose one) was rejected
after looking at it: annotations render next to the test title in the HTML report, so a
JSON blob there would be user-visible clutter, and the attachment already carried every
field needed.

The reporter now reads **two channels**: annotation *types*, which are stable constants and
carry the counts, and the attachments, which are JSON and carry anything arithmetic is done
to. Verified against a probe reporter first — Playwright hands attachments to a reporter as
a `Buffer` body, with `path` read as a fallback.

**Two things came out of it that the finding did not ask for:**

- **Cache reuses are now countable.** `via cache` was prose, so finding 5 shipped without
  the reporter being able to say how many heals cost nothing. The summary now shows
  `reused: N`.
- **`publishOutcome` awaits the attachment.** It was `void info.attach(...)` — fire and
  forget. That happened to work, but the totals now depend on it landing, so a race was no
  longer acceptable.

A heal that arrives with no attachment now prints "token totals unavailable" rather than a
confident zero, which is precisely the failure mode this finding was about.

**One thing investigated and deliberately not changed.** `onTestEnd` fires once per
*result*, so a retried test contributes its heals twice — which looked like double
counting and is not: the retried attempt re-runs the test, so it really does heal again and
really does spend the tokens again. Counting both is accurate. The summary now says how
many attempts were retries, because more heals than tests otherwise reads as a bug.

**Verified:** 23 reporter tests. The one that used to pin the weakness — asserting that a
reworded annotation zeroes the totals — is inverted and now proves the totals survive it.

### 10. `healing-records.json` grows without bound — `Fixed` (0.4.0)

No rotation and no pruning. Worse, the file was read, merged and rewritten on **every**
heal, so a long-lived file made each heal progressively slower - quadratic in the file
length, not linear.

**Fixed as proposed**, taking the cap rather than the roll-per-run option: a rolling file
plus a `latest` pointer adds a second thing to reason about, and nobody reads records
older than the last few runs anyway.

- **`HEALER_RECORDS_MAX`** (default 10,000) keeps the most recent records. That bounds
  every write, which is what fixes the slowdown - a bounded file cannot get slower.
- **`prune(max)`** trims an existing file and reports what it dropped.
- The oldest go first, which is the right end to lose: the recent rewrites are the ones
  anyone acts on.

Read straight from the environment rather than through `config.ts`, so the recorder keeps
working when the rest of the configuration is invalid - the same reasoning as
`isHealingEnabled()`.


### 11. Hardcoded token prices drift — `Fixed` (0.4.0)

`scripts/check-setup.js` embedded per-million-token prices. When pricing changed the cost
estimates quietly became wrong, and they are the numbers people use to decide whether to
run a suite.

**Fixed as proposed.** Prices now live in `scripts/pricing.json` with a `lastVerified`
date, and `check:setup` prints that date beside **every** estimate - not only when it is
stale, because a reader should be able to judge how much to trust a figure without knowing
there is a threshold. Past `staleAfterDays` (120) it also says so outright and names the
file to update. An unknown model reports that plainly and points at the file rather than
guessing.


### 12. No LICENSE file despite declaring MIT — `Fixed` (0.4.0)

`package.json` declared `"license": "MIT"` but there was no LICENSE file, so the tarball
asserted a licence it did not carry.

**The blocking question is answered:** the copyright holder is **Vineel Bisu**. `LICENSE`
now holds the MIT text as `Copyright (c) 2026 Vineel Bisu`, is listed in `files` so it
ships, and `package.json` gains a matching `author` field.


### 13. `describe()` is load-bearing but optional and unmeasured — `Fixed` (0.4.0)

The description is the strongest signal the model receives, yet nothing warned when a
healed locator had none, and the records did not distinguish described from undescribed
heals. Heals without a description are more likely to pick the wrong element, and you
could not see which ones those were.

**Fixed as all three proposed parts:**

- **`HealRecord.described`** - recorded per heal, so the history can be filtered.
- **The reporter surfaces the split**, reading it from the attachment. Finding 9 is what
  made this clean: before it, the count would have had to be scraped out of prose.
- **A warning on the first undescribed heal** in a worker - once, not per heal, because
  the advice is identical every time and a suite with hundreds of bare selectors would
  teach people to skip it.


---

### 18. Healed selectors reach logs and annotations unredacted — `Fixed` (0.4.0)

Redaction governed what goes *to* the model; nothing governed what came back. A model
asked to heal a row action answers `getByText('Smith, John')`, and that string was logged,
annotated, and printed by the reporter as a suggested rewrite.

**Fixed as proposed**, via `PrivacyGuard.redactSelector()`. Displayed selectors get the
**same level** as outbound ones, so one setting describes the whole surface:

- `off` - unchanged.
- `identifiers` - patterns applied, almost always a no-op: `getByTestId('checkout')` has
  nothing to find. Verified by test, because mangling ordinary rewrites would make the
  control unusable.
- `strict` - quoted content collapsed, so a rewrite reads `getByText('<redacted>')`.

Applied to the log line, the annotation, the retry log, the CI gate's failure message, and
the **report attachment** - the last because it travels with the HTML report, which is
exactly the artefact that gets uploaded.

**`healing-records.json` stays unredacted.** It is local and gitignored, and it is where
you go for the exact rewrite. That is what makes redacting the exported copies affordable
rather than a loss of function, and it is now documented in both README and
ARCHITECTURE.


### 19. The model's reasoning is parsed and discarded — `Fixed` in 0.3.0

Found while fixing finding 1, fixed alongside finding 2 as planned. All three providers
parsed a `reasoning` field but `HealRecord` had no field for it and `recordFromResponse`
never passed it, so it was dropped. Three docstrings claimed otherwise; those are
corrected.

**Impact was:** the model's stated justification is the natural evidence for auditing a
questionable heal. Paying tokens to generate it and then throwing it away was the worst
of both.

**Fixed by** adding `reasoning` to `HealRecord`, alongside a new `intent` summary
recording which checks had evidence and what the element turned out to be:

```json
"reasoning": "Cancel is the only unique button I am sure about.",
"intent": { "mode": "enforce", "verified": false, "checks": ["self-consistency", "lexical"],
            "role": "button", "name": "Cancel", "reason": "…shares no wording…" }
```

Both appear in `healing-records.json` and in the per-test report attachment.

**Still true, and worth remembering:** `reasoning` is free-form model prose that may
quote page content, so it is subject to finding 18 if ever surfaced anywhere but locally.

## Low

### 14. Record lock gives up after ~1s — `Fixed` (0.4.0)

After 40 x 25ms the writer proceeded without the lock. Chosen deliberately, but under
heavy contention there was a small window where a concurrent write could be lost.

**Fixed by the first proposal, plus the thing that actually mattered.** The budget is
larger (80 attempts), but the real fix is **jitter**: flat 25ms backoff meant four workers
that collided once went on colliding in lockstep every 25ms, which is the shape that loses
records. Randomising each wait breaks the convoy, so the extra attempts are rarely needed.

The second proposal - queue writes and flush at exit - was rejected. It inverts the
deliberate trade this module already made: losing a record is worse than losing the lock,
and a worker killed mid-run would lose everything it had buffered.

Finding 10 helps here too: a capped file keeps every write short, which shrinks the
contention window rather than merely tolerating it better.


### 15. No prompt caching — `Accepted`

The system prompt is ~370 tokens, below Anthropic's 1024-token minimum cacheable prefix,
so caching cannot apply at the current prompt size. Revisit only if the prompt grows past
that threshold — and note that growing it *to* enable caching would cost more than it
saves.

### 16. CommonJS-only build — `Accepted`

Verified working from ESM consumers via `npm run verify:package` (named imports resolve
through Node's static analysis). A dual build would be cleaner but buys nothing today.

### 17. Error labels rely on Playwright internals — `Accepted`

Preserving `locator.click: Timeout …` depends on Playwright deriving the label from the
caller's function name — undocumented behaviour. Already in ARCHITECTURE.md's risk
register. If it breaks the label reads wrong; nothing functional is affected.

---

## Suggested order

- ~~**1**~~, ~~**2**~~, ~~**7**~~, ~~**19**~~ — done in 0.3.0. ~~**3**~~ — done in
  0.4.0. Every Critical is closed. Finding 3 also covers finding 2's residual risk:
  intent checking cannot tell two buttons named "Save" apart, but `HEALER_FAIL_ON_HEAL`
  puts a human in the loop on every heal.
- ~~**5**~~, ~~**8**~~ — done in 0.4.0. The demo's repeated heals cost 7 calls rather
  than 13, and locators inside iframes heal for the first time.
- ~~**9**~~ — done in 0.4.0. Cache reuses are countable and the token totals no
  longer depend on a sentence's wording.
Nothing is left. Findings 15, 16 and 17 remain `Accepted` — no prompt caching (the
prompt sits below the cacheable minimum, and growing it *to* enable caching would cost
more than it saves), CommonJS-only (verified working from ESM consumers), and error
labels depending on undocumented Playwright behaviour (cosmetic if it breaks, and
already in the risk register).

Findings 4, 8–14 and 18 are worth batching into a single hardening pass afterwards.
