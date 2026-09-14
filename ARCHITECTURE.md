# Architecture

How this package works internally, for whoever maintains it next.

[INTEGRATION.md](INTEGRATION.md) covers how to attach it to a framework; [README.md](README.md)
covers configuration. This document covers the machinery.

## Design principles

Four rules shape most of the decisions below.

1. **Healing must never be able to fail a suite.** A misconfigured or broken healer
   degrades to plain Playwright. `attemptHeal` never throws; the fixture falls back to an
   undecorated page; the recorder swallows I/O errors.
   **One exception, deliberate:** the privacy gate fails *closed*. See
   [Privacy](#privacy-what-may-leave-the-process).
2. **When healing fails, the original Playwright error is re-thrown unchanged** — same
   message, same `locator.click:` label, same stack. A failing test must read exactly as
   it would without this package installed.
3. **A suggestion is not trusted until it resolves on the live DOM *and* looks like the
   element the test meant.** The model proposes; the validator decides whether it works,
   and `IntentVerifier` decides whether it is the right one. Resolving to a single
   visible element is not the same as being correct — see
   [Intent verification](#intent-verification).
4. **Every attempt is recorded, successful or not.** A rejected suggestion and its reason
   are the data you need to tune the threshold — as is an accepted one's reasoning and
   the list of checks that actually had evidence.

## Module map

| File | Lines | Responsibility |
|---|---:|---|
| `core/TestWrapper.ts` | 1063 | Engine lifecycle, page/locator decoration, report publishing, the integration API |
| `core/HealingEngine.ts` | 803 | Orchestrates one heal: gate → snapshot → redact → ask → validate → verify → record |
| `core/PrivacyGuard.ts` | 783 | Route policy, redaction, preview writer — the only egress choke point |
| `config.ts` | 668 | Environment → validated typed config |
| `core/IntentVerifier.ts` | 558 | Decides whether a healed element is the one the test meant |
| `core/SelectorCache.ts` | 200 | Per-worker memory of selectors that healed, so rot is paid for once |
| `core/HealBudget.ts` | 200 | Per-worker spend ceiling and provider circuit breaker |
| `core/SelectorValidator.ts` | 537 | Parses selector expressions into locators; decides if a suggestion works |
| `utils/HealingRecorder.ts` | 407 | `healing-records.json` — lock, merge, atomic rename |
| `core/AiProvider.ts` | 399 | Base class: prompt delegation, JSON extraction, selector sanitising, logging |
| `types.ts` | 361 | Shared type definitions, no runtime code |
| `providers/AnthropicProvider.ts` | 348 | Claude, via the Messages API |
| `providers/GeminiProvider.ts` | 306 | Gemini, via the Generative Language API |
| `providers/OpenAIProvider.ts` | 283 | OpenAI, via Chat Completions |
| `utils/DOMSnapshot.ts` | 273 | Page capture: native aria snapshot, DOM-scan fallback |
| `reporters/HealingReporter.ts` | 207 | Run-level summary |
| `utils/PromptBuilder.ts` | 204 | The prompts, in one place, shared by all providers |
| `providers/httpJson.ts` | 201 | Shared HTTP: retries, `retry-after`, timeouts, error-body extraction |
| `utils/logger.ts` | 70 | Level-filtered, prefixed logging |

`index.ts` re-exports the public API and nothing else is part of it. Two of these modules
are gates rather than machinery: `PrivacyGuard` decides what may leave the process, and
`IntentVerifier` decides whether a heal may be trusted. Both default to the strict
setting.

## Engine lifecycle

The engine is built **once per worker process**, not per test — construction reads config,
creates an HTTP client, and loads the records file.

```
initializeHealingEngine()
  cached?              → return it (null means "healing is off for this process")
  getConfig()          → throws on bad config
  healing disabled?    → cache null, remember why
  toHealConfig()       → flatten env config to HealConfig
  buildProvider()      → anthropic | openai | gemini  (ollama throws: not implemented)
  new HealingEngine()  → cache and return
  anything threw?      → log it, cache null, remember why  ← never propagates
```

`unavailableReason` is what the `heal-unavailable` annotation reports, so a suite that
quietly stopped healing explains itself in the report rather than only in stdout.

`setHealingEngine(engine, reason?)` bypasses all of this — that is how a custom provider
is installed, and how tests inject a stub. Because it bypasses config, **it also bypasses
`HEALER_ENABLED`**; a caller that wants to honour that flag must check
`isHealingEnabled()` itself.

## Wrapping

`base.extend()`'s `page` override is the only hook. Everything else follows from it.

```
healingFixtures.page
  → applyHealing(page, testInfo)
      engine?  → decoratePage(page, engine)
      no engine → push 'heal-unavailable' annotation, hand back an untouched page
```

### Page level — 9 methods replaced

`page.locator()`, the seven `getBy*` helpers — `getByRole`, `getByLabel`, `getByText`,
`getByPlaceholder`, `getByTestId`, `getByTitle`, `getByAltText` — and `page.frameLocator()`,
which returns a decorated frame whose own builders are wrapped the same way. See
[Frames](#frames).

Each calls the real Playwright method, then passes the result through `decorateLocator`.
The `getBy*` family gets one extra step: `describeGetByCall()` serialises the call back
into source text, because the healer records and validates selectors as strings and
`SelectorValidator` parses exactly that form.

```
page.getByRole('button', { name: 'Submit' })
  → expression: "getByRole('button', { name: 'Submit' })"
```

### Locator level — four changes

**Metadata.** `_healerExpression` (the selector text) and `_healerDescription` are stashed
on the locator object.

**`describe()` chains through.** This is a *native* Playwright API (1.53+) that labels the
locator in traces and reports. We call it, decorate the locator it returns, and attach the
description for the healer — so both behaviours survive. An earlier version replaced it
outright and silently lost the trace labelling.

**16 action methods replaced**, each with the same try/catch shape:

```
click  dblclick  fill  check  uncheck  hover  selectOption  press
pressSequentially  type  tap  focus  clear  selectText  setInputFiles
scrollIntoViewIfNeeded
```

Methods absent from the installed Playwright are skipped rather than crashing.

**`first()` / `last()` / `nth(n)` re-decorated**, appending the refinement to the
expression (`#btn.first()` — a form the validator can parse back) and carrying the
description across. Without this, refinement returns a bare locator and healing silently
stops applying.

### Why each action deletes its own override

```js
delete target[action];              // remove our override
locator[action](...args);           // plain property call
finally: target[action] = wrapped;  // restore, synchronously
```

Playwright composes messages like `locator.click: Timeout 5000ms exceeded` from **the name
of the function that called it**. Measured against a real browser:

| Invocation form | Resulting label |
|---|---|
| untouched Playwright | `locator.click:` |
| `.bind()` + spread | `locator.boundClick:` |
| `.apply()` (name patched) | `locator.apply:` |
| computed method name + `.call()` | `locator.call:` |
| **delete override → property call → restore** | `locator.click:` ✓ |

Only the last form preserves it. The restore happens synchronously — before the returned
promise is awaited — so there is no window in which the locator is unwrapped, even when
several actions run concurrently on the same locator object.

## The heal

```
1. action throws
2. base.step('heal click() on "#x"')            ← visible in report and trace
3. engine.attemptHealDetailed(page, selector, action, description, error)
4.   tryCache()                                 ← reuse a selector healed earlier; no network
     getAriaSnapshot(page)                      ← once per heal, not per attempt
5.   for attempt in 1..HEALER_MAX_RETRIES:
        buildSystemPrompt() + buildUserPrompt(request)
        provider.heal(request)                  ← bounded by withTimeout()
        confidence < threshold  → record, add to feedback, continue
        validateDetailed(suggestion)         ← does it resolve to one usable element?
          invalid              → record reason, add to feedback, continue
        verifyIntent(suggestion)             ← is it the RIGHT element?
          mismatch             → record reason, add to feedback, continue
          verified             → record success, return outcome
6. publishOutcome(outcome)                      ← annotations + attachment
7. healed?    resolve(healed) → retry the SAME method with the SAME args
   not healed? throw the original error, untouched
```

`attemptHeal()` returns `string | null` for callers who just want a selector;
`attemptHealDetailed()` returns the full `HealOutcome` and is what the wrapper uses,
because a report needs the attempts, confidences, reasons and token counts.

Reporting is published **by the wrapper**, not wired through the engine constructor. An
earlier version passed an `onOutcome` callback at construction, which meant an engine
supplied via `setHealingEngine()` reported nothing.

### Retry feedback

Rejected suggestions are folded into the next prompt's `error` field:

```
Timeout 5000ms exceeded  Do not suggest these again — they were already rejected:
getByRole('button', { name: 'Cancel' }) (matched 2 elements — must match exactly one).
```

`HealingRequest` has no field for prior attempts, and `error` is the one the prompt already
presents as failure context. Without this, a retry returns the same answer.

### Validation rules

`SelectorValidator.validateDetailed()` accepts a suggestion only if **all** hold:

1. `isValidSyntax()` passes — a cheap synchronous pre-filter. It works in Node, where
   there is no `document`; a `document.querySelector()` probe would throw
   `ReferenceError` and mark every selector invalid.
2. The expression resolves to a locator. `getBy*` source expressions are parsed and mapped
   onto the corresponding `page.getBy*()` call, including `name` (string **or** regex),
   `exact`, and `level`, plus trailing `.first()`/`.last()`/`.nth(n)`.
3. `count() === 1`. More than one match is rejected — Playwright's strict mode would throw
   when the action ran, so accepting an ambiguous locator only relocates the failure.
4. The element is visible. Attached-but-hidden usually means the right *kind* of element in
   the wrong place — a template or a closed modal — and an action on it would time out.

Every failure carries a reason string, which becomes both the record's `error` and the
retry feedback.

## Intent verification

`SelectorValidator` answers *does this resolve to one usable element?* `IntentVerifier`
answers *is it the element the test meant?* Both can pass on the wrong element: this
repo's checkout page has `button "Place order"` and `button "Cancel"`, and the second is
just as unique, visible and clickable as the first.

Four checks, ordered so the most objective runs first and short-circuits:

| Check | Signal | False-positive risk |
|---|---|---|
| `action` | `fill` needs a textbox, `check` needs a checkbox, `selectOption` needs a select. Derived from what Playwright itself refuses. | None — it is a DOM fact |
| `self-consistency` | The model's reported `expectedRole`/`expectedName` versus the live element | None — the model versus itself |
| `role` | A role implied by the original selector | Low; a genuine redesign can change a role |
| `lexical` | Intent vocabulary from the selector text and `describe()`, versus the element's accessible name | Real, hence the design notes below |

Role and name are read with `locator.ariaSnapshot()`, which returns
`- button "Place order"` — the browser's *computed* role and accessible name, the same
values `getByRole()` matches on, in one public-API call. Reading the `role` attribute
would see only explicit roles and miss every implicit one, which is most of them.

### Two things measurement changed

Both were wrong in the first cut and were caught by running the checks against the demo's
real heals. Worth not rediscovering:

**Prefix matching, not exact.** The demo heals `#promo-field` to
`getByLabel('Promotion code')` — correct, but `promo` ≠ `promotion`, so exact token
matching rejected a good heal. Tokens now match when one is a prefix of the other and
the shorter is ≥ 4 characters, which also covers `submit`/`submits` and `term`/`terms`.
The 4-character floor is what stops `can` matching `cancel`.

**Confirming and rejecting need different thresholds.** A single shared word is enough
to *confirm* — `#checkout-button` against a button named "Checkout" is not coincidence —
but a single *missing* word is not enough to *refuse*, because a one-word intent may just
be an unhelpful identifier. A symmetric threshold suppressed the check on
`#checkout-button` entirely and pushed a fully corroborated heal onto the confidence
floor.

### Evidence comes from the element

The lexical check compares intent against the element's accessible name, falling back to
the suggested selector's text **only** when the element has no name at all. Pooling both
let a suggestion certify itself: a heal to `getByTestId('place-order-legacy')` resolving
to the Cancel button passed, because the *selector* mentioned the order even though the
element did not.

### When nothing can be checked

An opaque selector with no `describe()` leaves every check without signal. Rather than
accept blindly, the confidence floor (`HEALER_UNVERIFIED_CONFIDENCE`, default 0.9)
applies. `IntentSummary.checks` records which checks had evidence, so a heal listing only
`confidence-floor` is visibly the weakest kind.

### Failure direction

Unlike the privacy gate this does not need to fail closed on infrastructure errors, but
it does anyway: an element that cannot be inspected is one we cannot vouch for, so
`verifyIntent()` treats its own errors as rejections. The cost of being wrong is a red
test, which is the outcome this whole module exists to prefer.

## Privacy: what may leave the process

`core/PrivacyGuard.ts` is the only component that decides what is transmitted.

### Why it inverts design principle 1

Everywhere else, a failure degrades to plain Playwright. A privacy control cannot work
that way — "degrade gracefully" would mean transmitting the raw page. So the gate fails
**closed**: an unevaluable policy, an unparseable URL, or a redactor that throws all
abandon the heal. The suite is not taken down by this; the test behaves as it would with
no API key, which is a path that already exists and is already tested.

### Where the gate sits, and why there

Inside `HealingEngine`, at the point the `HealingRequest` is assembled — not in the
fixture layer. `setHealingEngine()` bypasses configuration entirely, so a gate above the
engine would be bypassable by the package's own documented extension point. Every engine
has a guard; one built without an explicit policy gets `{ redact: 'identifiers' }`, not
"send everything".

```
healLoop
  1.  enabled?                      → no: skip
  1b. guard.checkUrl(page.url())    → blocked: return, page never read   ← fails closed
  2a. snapshotRoot resolves?        → no: blocked, nothing captured      ← fails closed
  2.  getAriaSnapshot(page, {root}) → snapshotRoot scopes the capture
  3.  build request                 (real content — stays local)
  3b. guard.sanitizeRequest(...)    → outbound copy                      ← fails closed
  3c. previewOnly?                  → write payload, transmit nothing
  4.  provider.heal(outbound)       ← only `outbound` ever leaves
```

### Why the root is checked before capture

`getAriaSnapshot` falls back to `getDomSnapshot` when the accessibility snapshot throws.
Both now honour `root`, and neither substitutes the document when it fails to resolve —
because the first cut of this shipped with exactly that bug, and it inverted the control:
a mistyped root, *or simply a root absent from the page being healed*, produced a
full-page DOM scan including `element.value`. A narrowing option must not widen on
failure.

So the engine confirms the root up front and blocks if it is missing, and both capture
strategies refuse to exceed it. The check uses a 1 s budget rather than
`HEALER_TIMEOUT`: the page has already had an action time out against it, so a container
that is present has long since rendered — and the wrong budget here meant a 30-second
stall per heal on every page lacking the container.

`request` and `outbound` are separate objects on purpose. The record, the annotation and
the report attachment are built from `request`, so `healing-records.json` still shows the
real selector you need to fix; only `outbound` reaches a provider.

`sanitizeRequest` **reconstructs** the request field by field rather than spreading it.
That is load-bearing: adding a field to `HealingRequest` later is a compile error here
instead of a silent new disclosure channel, and an optional field nobody wires up is
simply not sent. `screenshot` is dropped unconditionally for the same reason.

### The five channels

The obvious one is the snapshot. The other four are why this is a module rather than a
`replace()` call:

| Channel | Why it leaks |
|---|---|
| `ariaSnapshot` | Every accessible name on the page. |
| `error.message` | Playwright quotes matched element text in strict-mode violations — page content wearing a framework hat. Under `strict`, quoted runs are collapsed and the diagnosis (`Timeout 5000ms exceeded`) is kept. |
| DOM-scan fallback | `getDomSnapshot` captures `element.value`, so a half-filled form is *typed user input*, not rendered text. Worse per byte than the aria snapshot, and it triggers exactly when things are going wrong. Handled by a second branch in `scrubSnapshot`, keyed on the `<tag …>` line shape. |
| `pageUrl` | Identifiers in paths and query strings. Query and fragment are dropped from `identifiers` up. |
| Logs and annotations | The *healed* selector comes back from the model and is logged and annotated, so `getByText('Smith, John')` reaches CI output. **Still open:** redaction governs what goes *to* the model, not what comes back. |

### Structural redaction

Pattern matching cannot find names. The snapshot's own structure can:

> **Keep the accessible names of things you can act on. Collapse the names of things you
> can only read.**

The healer only heals actions, so an actionable element's name *is* the signal, and in
practice it is static interface chrome. Data lives in `cell`, `row`, `text`, `paragraph`,
`heading`, `listitem`. `ACTIONABLE_ROLES` is the allowlist; a role missing from it is
collapsed, so forgetting one costs a little accuracy rather than leaking.

A *value* is collapsed even on an actionable role — a textbox's label is chrome, its
value is whatever the user typed.

Measured on the demo's checkout page:

```
off          - textbox "Email address": patient.zero@hospital.example.com
identifiers  - textbox "Email address": ‹email›
strict       - textbox "Email address": ‹redacted›
```

All three keep `textbox "Email address"`, which is what `getByLabel('Email address')`
resolves through — so the demo's five stale selectors still heal at every level. That is
the test for any change here: does the healing signal survive?

### Preview mode

`HEALER_PRIVACY_PREVIEW=<dir>` renders the real `PromptBuilder` output to a file and
calls nothing. Two properties worth preserving:

- **It needs no API key.** `getConfig()` skips the credential assertion when a preview
  directory is set, and `credentialFor()` substitutes a placeholder. Requiring a
  credential to discover what gets transmitted would put the audit trail behind the very
  approval it exists to inform.
- **From either source.** `createHealingEngine({ previewDir })` is the programmatic form of
  the same setting and gets the same allowance — it passes the directory into `getConfig`,
  which is otherwise blind to options. Two ways to configure one thing that behave
  differently is a trap, and this one hid the feature behind the approval it exists to
  replace.
- **No heal can succeed in it.** A suite run under preview fails wherever it would have
  failed unhealed. That is the contract, not a bug.

## Frames

Everything inside an iframe was unreachable until 0.4.0 — payment widgets, embedded
reports, most SSO flows. Fixing it needed three things, and the obvious one was the least
of them.

**Measured first, because it determined the whole design.** A page-level snapshot shows an
iframe as a leaf:

```
- heading "Payment" [level=1]
- iframe                      ← that is all. No content.
- button "Cancel order"
```

So wrapping `frameLocator()` on its own would have produced healing that always failed, at
full cost: the model would be asked to name an element in a tree that does not contain it.

### The three parts

| Part | Where |
|---|---|
| Wrap `page.frameLocator()` and decorate what it returns | `decorateFrameLocator` in `core/TestWrapper.ts` |
| Parse and resolve frame-scoped expressions | `splitFrameChain` / `resolve` in `core/SelectorValidator.ts` |
| Capture the **frame's** tree, not the page's | `frames` option in `utils/DOMSnapshot.ts` |

`FrameLocator` exposes the same builder surface as `Page` — `locator()`, the seven
`getBy*` helpers, and a nested `frameLocator()` — which is what lets one `LocatorRoot`
type serve both, and one resolver walk an arbitrary frame path before resolving the leaf.

### The expression carries the frame path

```
page.frameLocator('#pay').locator('#card-number')
  → "frameLocator('#pay').locator('#card-number')"
```

Real Playwright source, so a suggested rewrite is directly pasteable — and no new metadata
was needed anywhere, because the engine reads the frame path back out of the failing
expression to know which frame to snapshot.

`locator()` is rendered as the **explicit call form** inside a frame:
`frameLocator('#pay').#card` would be ambiguous to parse, whereas
`frameLocator('#pay').locator('#card')` is not. The resolver accepts that form at page
level too, since models write it regardless.

### The answer is qualified, not trusted to be

The model is shown the frame's snapshot, so it answers in the frame's terms —
`getByLabel('Card number')`, with no mention of the frame. Taken literally that resolves
against the *parent* document. `SelectorValidator.qualifyWithFrames()` puts the prefix
back before validation, so the validator, the intent check, the cache, the record and the
suggested rewrite all agree on one fully-qualified expression. A model that names the
frames itself is left alone rather than having ours doubled on.

Relying on the prompt to make the model echo the prefix would have been the fragile
version of this.

### Failure direction

Two places deliberately refuse to widen, both the same lesson the snapshot-root bug taught:

- `getDomSnapshot` runs `page.evaluate` in the main frame and cannot see into an iframe, so
  when frames are requested and the aria snapshot fails, capture returns **empty** rather
  than falling back to it. Handing the model the parent page while asking about the frame
  would produce a confidently wrong selector — and on a payment frame, transmit the wrong
  document.
- The engine then treats an empty frame snapshot as a stop, not a prompt: there is nothing
  to reason about, so no provider call is made.

### What comes back

Redaction governs what goes **to** a provider. Three methods govern what comes back, because
three different things carry page text out of a heal:

| Method | Guards | At `strict` |
|---|---|---|
| `redactSelector()` | the selector the model chose | quoted runs collapsed |
| `redactMessage()` | rejection reasons, which quote the element | quoted runs collapsed, diagnosis kept |
| `redactName()` | the accessible name read from the live element | collapsed wholesale |

The first two are the same operation — a selector and a reason are both *our* words wrapped
around *their* data, so `redactSelector` delegates. A name is different in kind: it is page
content end to end, with no framework prose to preserve and no quotes to collapse, so it
goes as a unit. An earlier version wrapped a name in quotes to borrow the selector path,
which mangled `O'Brien`.

All three reach a log line, a report annotation, the report attachment, the CI gate's
failure message and the run summary. CI logs and uploaded report artefacts are usually
readable by more people than the machine that produced them.

**Providers log no selector above `debug`.** `AiProvider` subclasses sit below the guard —
deliberately, since a transport should not hold a policy — so they have no way to redact.
They report confidence and token cost at `info` and leave the selector to `HealingEngine`,
which has the guard. `SelectorValidator` follows the same rule: its expression-quoting
diagnostics are `debug`, and the engine reports the rejection at `warn`, redacted.

`healing-records.json` is never redacted — the place you go for the exact rewrite, which is
precisely what makes redacting the exported copies affordable. That argument depends on the
file staying local, and **nothing enforces that in a consumer's project**: it defaults to
their working directory and npm strips `.gitignore` from a tarball, so `HealingRecorder`
warns once on first write unless the path was chosen deliberately or `.gitignore` already
covers it. The report attachment *is* redacted — every page-derived field, not only the
selector — because it travels with the HTML report.

### What this changed about disclosure

Iframe content was previously never transmitted, because it never appeared in a snapshot.
It is now, for frame-scoped heals only. Iframes are disproportionately payment and identity
widgets, so this is called out in README's "What is transmitted" — redaction applies as
normal, and `HEALER_BLOCKED_PATHS` on the parent route excludes a page and its frames
together.

## Page capture

`getAriaSnapshot()` prefers Playwright's native `locator('body').ariaSnapshot()`: it is the
role-and-accessible-name tree the prompts are written around, produced by the browser in
one call. Verified byte-identical across chromium, firefox and webkit.

The DOM-scan fallback (`getDomSnapshot()`) runs when the snapshot API throws — a closed
page, a mid-navigation call. It selects by *kind* (interactive and labelled elements), not
document order: on a real page the first 100 nodes in document order are `<head>` metadata
and layout wrappers, and the button you need is at index 400.

Snapshots are never silently truncated. A snapshot cut off before the target element
produces a confidently wrong selector, which is worse than an expensive call. Large
snapshots log a warning; `truncateSnapshot()` is exported for callers who want a hard cap.

## Reporting

Four surfaces, all populated from one `HealOutcome`.

### Annotations

| Type | Meaning |
|---|---|
| `healed` | selector repaired, action succeeded |
| `heal-failed` | healing ran, produced nothing usable |
| `heal-unavailable` | healing could not run (no key, bad config, disabled) |
| `heal-blocked` | the privacy policy refused to transmit — nothing left the machine |

`heal-blocked` is separate from `heal-failed` because the two call for different
responses: one is a policy decision to review, the other a model failure to tune.

They appear beside the test title in the HTML report and are machine-readable in
`test-results.json`, so CI can query them without parsing prose.

Paths are made project-relative — an absolute Windows path is often longer than the
message attached to it.

### Attachment

One `healing-<action>-<selector>.json` per healed action:

```json
{
  "action", "originalSelector", "description", "healedSelector",
  "outcome",           // "healed" | "not healed"
  "reason",            // why it failed, or null
  "pageUrl", "location", "tokens",
  "attempts": [{ "timestamp", "file", "line", "originalSelector", "reasoning", "intent",
                 "suggestedSelector", "confidence", "provider",
                 "tokens", "success", "error" }]
}
```

`attempts` is the valuable part: it preserves rejected suggestions *and* why they were
rejected.

### Trace step

Each heal runs inside `base.step('heal click() on "#x"')` with `box: true`, so the time is
attributed in the timeline instead of looking like a stall inside a failing action.

### Run summary

`self-healing-playwright/reporter` is a reporter rather than an `afterAll` because under
parallel workers no single test process sees every heal — only the main process does.

**It reads two channels, and the split matters.** Annotation *types* are stable constants,
so they carry the counts and the human-readable lines. The `healing-*.json` *attachments*
are JSON, so they carry everything that gets arithmetic done to it: token totals, the
deduplicated `#old → new` rewrites, and how many heals were cache reuses.

An earlier version regexed `(\d+) in / (\d+) out tokens` out of the annotation prose. That
coupled the reporter to a sentence written in `publishOutcome`, so rewording it would have
zeroed the totals with no error anywhere — and it made cache reuses uncountable, because
`via cache` was prose too. `publishOutcome` now **awaits** the attachment for the same
reason: the numbers depend on it landing, so fire-and-forget was a race.

Two behaviours worth knowing:

- **A heal with no attachment says so** — "token totals unavailable" — rather than
  reporting a confident zero, which is exactly the failure the old version had.
- **Retries inflate the totals, correctly.** A retried attempt re-runs the test, so it
  heals again and spends again. The summary notes how many attempts were retries, because
  otherwise more heals than tests reads as a bug.

## The records file

`healing-records.json` is a report object: `timestamp`, `totalHeals`, `successfulHeals`,
`failedHeals`, `successRate`, `totalTokensUsed`, `tokenBreakdown`, `averageConfidence`, and
every record.

Two settings bound it. `HEALER_RECORDS_MAX` (default 1,000) keeps only the most recent
records, because the file is read, merged and rewritten on **every** heal — so an unbounded
file makes each heal progressively slower, quadratically rather than linearly. `prune(max)`
is exposed for trimming an existing file. The oldest are dropped, which is the right end to
lose: the recent rewrites are the ones anyone acts on.

Concurrency is the interesting part. Playwright runs workers in parallel, and a naive
load-then-overwrite cycle loses records — two workers that both start with an empty file
each write only their own, and the last writer wins. Measured: with two workers, half the
records disappeared. So every write:

1. takes a lock via exclusive file creation (`open(..., 'wx')`, atomic across processes),
   clearing a lock older than 10s as abandoned. The retry wait is **jittered** — flat
   25ms backoff meant four workers that collided once went on colliding in lockstep, which
   is the shape that actually loses records under contention;
2. re-reads the file and merges by record identity;
3. writes a temp file and `rename`s it into place, so a reader sees the old report or the
   new one, never a partial write.

Verified with four concurrent processes writing 15 records each: 60/60 survived, no stray
lock or temp file. The reader also accepts a bare array and JSON-Lines, so files from
earlier versions still load.

## Ceilings

`core/HealBudget.ts` holds two controls, both per worker.

**The spend ceiling** (`HEALER_MAX_HEALS`, default 100) bounds provider-backed heals.
Checked **after** the cache, which is the detail that makes it usable: an exhausted worker
carries on reusing what it already learned rather than stopping dead. A refusal is
reported as `heal-skipped`, distinct from `heal-blocked` because the causes call for
different responses — raise a ceiling, versus review a privacy policy.

Charged **once per heal**, not once per attempt. One heal may make up to
`HEALER_MAX_RETRIES` calls as each rejection feeds the next prompt, and billing each of
them would make a ceiling of 100 mean 50 — a number that is named, configured, documented
and reported in heals has to be counted in heals. This is the one place the two controls
deliberately differ, and the contrast is the point.

Workers are separate processes, so a true per-*run* budget would need the same lock-file
dance as the records file, coordinating a counter on every heal for a number that only has
to be approximately right. The ceiling is therefore per worker and the effective total is
`HEALER_MAX_HEALS × workers`. Documented rather than hidden: a cap that silently means four
times what it says is worse than no cap.

**The circuit breaker** (`HEALER_BREAKER_THRESHOLD`, default 5) is the one that earns its
keep. With the provider unreachable, every failing action waits
`HEALER_TIMEOUT × HEALER_MAX_RETRIES` before giving up — with the defaults, a five-minute
suite becomes an hour and every test fails anyway. Five consecutive failed calls and the
worker stops asking.

Counted in **attempts**, not heals, so an outage is caught in roughly
`threshold ÷ HEALER_MAX_RETRIES` failing actions instead of waiting for whole heals to
exhaust their retries. The breaker is also re-checked between attempts *within* a heal, so
one that opens on attempt two abandons attempt three rather than spending another timeout
on a provider already known to be down. That heal is reported as `heal-failed` with the
connection error, which is the honest reason; the *next* one is the `heal-skipped`.

What counts as a failure is the part worth getting right: a failed *call* — network,
credential, timeout. **A low-confidence answer is not a failure.** The provider is working
fine, and a breaker that tripped on an unsure model would disable healing for entirely the
wrong reason. Any successful call clears the consecutive count.

It latches rather than half-opening. A test run lasts minutes; probing a dead provider
again mid-run buys a slow retry and no information, and the breaker resets when the worker
does.

## The selector cache

A stale selector lives in a page object shared by many tests, so the same rot is
otherwise paid for once per test. Measured on the demo — five distinct selectors, three
tests — the cache takes the run from **11 provider calls to 5**, and tokens from
7,700/990 to 3,500/450.

`core/SelectorCache.ts` is per-worker and in-memory. It sits in the heal loop after the
privacy gate and **before the snapshot**, because capturing the page is itself a browser
round trip:

```
1b. privacy gate
1c. tryCache()                    ← no snapshot, no network
      for each candidate:
        probeValidator.validate   ← 250ms timeout, not the validator's 1s
        verifyIntent
        pass → record as provider 'cache', return
2.  getAriaSnapshot
…
6.  accept → cache.remember()     ← only after validation AND intent passed
```

After the privacy gate rather than before it, so a blocked page stays blocked — which
costs nothing, since a blocked page can never have populated the cache in the first place.

### Nothing cached is trusted

Every candidate is re-validated and re-intent-checked exactly as a fresh suggestion is.
That is what lets the key stay crude: it does not need to be right, only cheap and
usually right, and a wrong hit costs one DOM probe instead of a network call.

The probe uses a **250ms** validator rather than the default 1s. Up to three candidates
are probed before the provider is contacted, so the miss path has to stay cheap for the
cache to be worth having; the page has already had an action time out against it, so
anything present is present.

### Why the key is the selector alone

Not `(selector, action)` — a field healed for `fill` is the same element when later
`clear`ed, and splitting would halve the hit rate for nothing. Where an action genuinely
implies a different element, the intent check's action-compatibility gate rejects the hit.

Not `(selector, url)` either. Instead the cache keeps **up to three candidates per
selector**, most-recent-success first. A selector meaning different things on two pages
then has both answers cached and validation picks; a single entry keyed too loosely would
thrash between them, and every thrash is a full provider call.

### Two extensions left out on purpose

- **A committed `selector-map.json`.** It would turn a recurring cost into a one-off and
  also into a maintenance trap: page objects rot indefinitely while a JSON file papers
  over them. That fights the reporter and `HEALER_FAIL_ON_HEAL`, which both exist to push
  the fix into the source. Making rot free removes the incentive to fix it.
- **Cross-worker sharing.** It needs a lock file and a run-scoped lifecycle to avoid
  becoming the stale map above, and saves the first heal per *worker* rather than per
  *test* — small gain, real complexity.

### Measured interactions

| Setting | Effect on the cache |
|---|---|
| Parallel workers | Per-worker, so a small suite across many workers shares less. The demo at default parallelism made 9 calls rather than 5. |
| `HEALER_FAIL_ON_HEAL` | Largely defeats it — **Playwright discards a worker after a failed test**, so each gated failure starts cold. Verified by counting module loads: 2 with the gate off, 4 with it on. Acceptable: the gated run is the one that hands over the edits. |

A reuse is still a heal everywhere it matters — annotation, records file, reporter rewrite
list, CI gate — marked `via cache` with `provider: 'cache'` and zero tokens. The reporter
cannot yet *count* reuses separately, because it reads annotations as prose; the token
totals show the saving instead.

## The CI gate

`HEALER_FAIL_ON_HEAL` fails a test that only passed because a selector was healed.

**It runs in fixture teardown, not at the heal site.** Failing immediately would report
one stale selector per run, so finding five would take five runs — and the list of
rewrites is the entire value of the mode. Instead, heals accumulate in a module-level
array during the test, and `assertNoHeals()` throws once after `use()` returns.

Measured against Playwright before relying on it:

| Case | Result |
|---|---|
| body passes, teardown throws | test **fails** with the gate's message |
| body fails, teardown throws | **both** errors reported, body failure first |

The second row is why this is safe: the gate cannot mask a genuine failure.

The collection is a plain module-level array rather than a map keyed by `TestInfo`.
Playwright runs one test at a time per worker and does not start the next test's fixtures
until this one's teardown finishes, so there is never more than one collector. Keying by
object identity would add a way for the gate to silently never fire if the two `TestInfo`
references diverged — a bad failure mode for a safety feature. It is reset in
`applyHealing`/`attachHealing` and drained by `assertNoHeals`, so neither an unusual
integration path nor a test that dies early leaks heals into the next test.

### Two locations, because there are two questions

The gate exposed a flaw in `getCallerLocation()`. It prefers a `.spec.ts` frame, which
correctly answers *which test healed* — but the gate needs *where do I edit the selector*,
and the selector lives in the page object. Reporting the spec sends developers to a file
that does not contain the string.

Both frames were already computed by the same stack walk, so `CallerLocation` now carries
`source` — the first non-framework frame — whenever it differs from the reported file.
`HealOutcome.source` and the attachment's `definedAt` expose it, and the gate leads with
it:

```
pages/CartPage.ts:37  (click)  (exercised by tests/checkout.spec.ts:22)
```

The line is where the locator is *used*, not where it was constructed. Capturing the
construction site would mean a stack walk inside `decorateLocator` for every locator a
suite creates, which is real overhead for a marginal gain — the file is right, and the
selector string is in it.

### No graduated mode

Deliberately absent: "fail only on heals the intent checks could not corroborate." It
sounds like a safer middle ground and is not one. The regression this gate exists to catch
is *by definition* a plausible substitute for something that changed, so it is exactly the
kind of heal those checks approve. Gating on verification quality would let the case
through while feeling rigorous.

## Caller attribution

`getCallerLocation()` walks `new Error().stack`, skips framework frames (`src/core`,
`src/providers`, `src/utils`, `dist/…`, `node_modules`, `node:` internals) and prefers a
`.spec.ts`/`.test.ts` frame, falling back to the first non-framework frame — which is
usually a page object.

File and line come from a **single** stack read. Reading them from two separate stacks can
pair one frame's file with another frame's line.

## Prompts and providers

`PromptBuilder` holds the prompts so that every provider asks the same question in the same
output format — otherwise a confidence score would mean different things depending on which
model produced it.

The response contract is load-bearing: `AiProvider.parseResponse()` extracts a JSON object
with exactly `suggestedSelector`, `confidence`, `reasoning`. It never throws; a malformed
answer is a normal outcome. It finds the JSON with a brace-balancing scanner that tracks
string literals, so braces inside `reasoning` do not terminate the object early, and it
survives models that wrap JSON in prose or code fences. Confidence is coerced from numeric
strings, clamped to 0–1, and **defaults to 0** when unusable, so a garbled response can
never clear the threshold.

The worked example in the prompt uses a quoted string name (`{ name: 'Submit' }`) rather
than a regex, because models copy the example and a string round-trips exactly through the
validator. The validator accepts regex names anyway, since models emit them regardless.

All three providers call REST APIs through `httpJson` — no SDKs, so the package has one
runtime dependency (`dotenv`) and installs from a tarball without registry access to
anything else. `httpJson` supplies what an SDK would: retry on 408/409/429/5xx with
exponential backoff, `retry-after` honoured, `AbortController` timeouts, vendor error-body
extraction, and a distinct `NonJsonResponseError` for a 2xx that isn't JSON (a proxy
error page answered, which is not a network failure).

**Two deadlines, and the outer one has authority.** `timeoutMs` bounds one attempt;
`HealOptions.signal` — passed by `HealingEngine.withDeadline` and forwarded to `postJson` —
bounds the chain. Losing a `Promise.race` only abandons a promise, so before the signal
existed an engine that gave up after `HEALER_TIMEOUT` left a hung request *plus its two
retries* running unobserved, holding sockets for up to another minute and asking questions
nobody would read the answer to. Measured against a server that never replies: 3 requests
over 2,467ms without the signal, 1 request over 364ms with it. The signal also cuts a
backoff short, since that is the longest a cancelled call would otherwise sit before
noticing, and a cancelled chain reports `RequestCancelledError` rather than a timeout —
telling someone their request ran out of time when something upstream stopped caring sends
them to tune the wrong setting.

`HealOptions` is **optional** on the `AiProvider` contract. A custom provider written
before it existed, or one with no use for it, still satisfies the interface and is no worse
off than it was.

Provider-specific handling worth knowing:

- **Anthropic** — `x-api-key` + `anthropic-version` headers; system prompt is a top-level
  field. Thinking-capable models get `output_config: { effort: 'low' }` and a raised
  `max_tokens`, because thinking tokens are drawn from the same budget and a 500-token
  ceiling can be consumed entirely by reasoning. A 401/403 whose body is *not* Anthropic's
  JSON error shape is reported as an interception (proxy/gateway) rather than a bad key.
- **OpenAI** — `max_completion_tokens` (reasoning models reject `max_tokens`);
  `response_format: json_object`; reasoning models get a raised ceiling.
- **Gemini** — system prompt in `systemInstruction`; model in the URL path; key in the
  `x-goog-api-key` header rather than the query string so it cannot leak into logs. A
  blocked prompt returns HTTP 200 with no candidates, handled distinctly. `thoughtsTokenCount`
  is added to output tokens, since it is billed as output.

## Configuration

`config.ts` turns environment variables into a validated typed object. Notable choices:

- `.env` is loaded **lazily**, on first config access. Doing it at import time meant that
  merely importing the package mutated a consumer's `process.env`. `HEALER_SKIP_DOTENV=1`
  opts out entirely.
- Only the *selected* provider's credentials are required, and only when healing is
  enabled — so one `.env` can hold several providers' keys, and a suite can run unhealed
  with no key at all.
- `SHOW_BROWSER=true` forces `headless: false`; the two flags otherwise contradict.
- Every parse error names the variable, the allowed values, and what was received.

## Extension points

| To do this | Use |
|---|---|
| Add a provider | Extend `AiProvider`, implement `heal()` and `validateConfig()`; install with `setHealingEngine()` |
| Configure in code | `createHealingFixtures(options)` / `createHealingEngine(options)` |
| Own the `page` fixture | `attachHealing(page)` inside your fixture, or `withHealing(test)` |
| Change the prompts | `PromptBuilder` — or override `buildSystemPrompt()` in a provider |
| Plug in your own scrubber | `HealingOptions.redactor` — return `null` to veto a heal |
| Restrict where healing runs | `HealingOptions.allowedOrigins` / `blockedPaths`, or the `HEALER_*` equivalents |
| Build a custom report | `HealingRecorder` + the `HEAL_ANNOTATIONS` types |
| Observe every outcome | `HealingEngineOptions.onOutcome` |

## Not wrapped, deliberately

- **Assertions.** `expect(locator).toBeVisible()` never heals. A healer that "fixes" a
  failing assertion hides a bug.
- **Chained locators** — `page.locator('#a').locator('#b')` and `.filter()` return
  undecorated locators. (`frameLocator()` *is* wrapped — see [Frames](#frames).)
- **Page-level shortcuts** — `page.click('#x')`.
- **Anything after a failed heal.** The original error propagates untouched.

## Risk register

Things a future Playwright release could break, in rough order of likelihood.

| Risk | Impact | Mitigation |
|---|---|---|
| Playwright stops deriving error labels from the caller's function name | Labels read `locator.wrapped:` — cosmetic only | The delete/restore trick is documented at the call site with the measurements above |
| A new action method is added | It simply does not heal; still works normally | Add it to `HEALED_ACTIONS` |
| `ariaSnapshot()` output format changes | Prompts still work — it is free text | None needed |
| Playwright 2.0 | Peer range `<2` refuses the install | Deliberate; requires a release to widen |
| Below Playwright 1.53 | `ERESOLVE` on install | `describe()` and `ariaSnapshot()` both have runtime fallbacks, so the floor could be lowered to 1.49 if needed |

## Verified behaviours

Findings from testing that are worth not rediscovering:

- Aria snapshots are byte-identical across chromium, firefox and webkit.
- Playwright's `getByRole` name matching is **substring by default**, so
  `{ name: 'Submit' }` also matches "Submit report". The prompt tells the model to add
  `{ exact: true }` when one name is a prefix of another.
- `locator.describe()` does **not** appear in error messages — only in traces and reports.
- Node's `fetch` ignores `HTTP_PROXY`. On a TLS-inspecting network (e.g. Zscaler) requests
  fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` until `NODE_EXTRA_CA_CERTS` points at the
  corporate root CA. `npm run check:setup` reports proxy variables for this reason.
