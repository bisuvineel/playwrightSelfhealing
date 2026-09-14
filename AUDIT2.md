# Audit 2 — findings from the post-0.4.0 review

> **Internal document. Deliberately not shipped in the package** — like `AUDIT.md`, it is
> absent from `files` in `package.json` on purpose. The same two consequences apply:
>
> - **Nothing under `src/` may reference this file.** `src/` ships, so a comment or
>   console warning pointing at `AUDIT2.md` is a dead pointer inside a consumer's
>   `node_modules`. State the concern itself instead.
> - **Consumer-facing caveats live in README's Limitations section**, not behind a link
>   to here. When a finding is a risk someone installing the tarball should know about,
>   the finding is only half-done until that section says so in its own words.

Findings from a second internal review on **2026-08-25**, against commit `cdd25d6`
(`v0.4.0`). `AUDIT.md` covers the first round and is fully resolved; this file continues
its numbering at **20** so that "finding 5" keeps meaning what it has always meant.

Every finding below was reproduced before it was written down — none are read-only
suspicions. At the time of writing, the 324 unit tests passed and `tsc --noEmit` was clean
against all of them, so each one was behaviour the suite did not cover.

**All fourteen are fixed in 0.4.1.** The suite went
from 324 tests to **379**; three of the fixes turned out wider than proposed and four
uncovered a second defect while being written, each recorded in its own entry.

## Scope of this review

Read in full: all 9,280 lines under `src/`, `README.md`, `ARCHITECTURE.md`,
`INTEGRATION.md`, `.env.example`, `package.json` and the packaging scripts. Probed live:
`strict` redaction against real `ariaSnapshot()` output, the selector parser against
chained suggestions, the spend ceiling against a simulated retry loop, the outbound prompt
under `strict`, and both engine-construction paths under preview mode.

**Already documented, so not findings.** Chained locators (`page.locator('#a').locator('#b')`),
`.filter()`, assertions and page-level shortcuts (`page.click('#x')`) are listed in
[README § Limitations](README.md#limitations) and in `ARCHITECTURE.md`. They are real
constraints, they are disclosed, and they are out of scope here.

**Verified sound, worth recording.** `strict` redaction was probed against tables,
`role=note`, `<pre>`, multi-line labels, embedded quotes and a textarea value — Playwright
normalises every node to one line, so there is no block-scalar escape hatch, and only
actionable names survived. URL scrubbing, unconditional screenshot suppression, and
frame-scoped capture refusing to widen all behave as documented. Every fail-closed path
holds: unparseable URL, uninterpretable glob, vetoing redactor, throwing redactor,
non-string redactor return, unresolvable snapshot root. The record lock protocol —
`wx` creation, jittered backoff, stale-lock reclaim, merge-before-write, write-then-rename,
temp cleanup on failure — is correct, and the 0.4.0 cap genuinely makes each write
constant-cost rather than merely smaller.

## Legend

Identical to `AUDIT.md`.

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
| 20 | Redaction covers selectors but not the page text beside them | High | `Fixed` (0.4.1) |
| 21 | The selector parser silently discards what it cannot parse | High | `Fixed` (0.4.1) |
| 22 | Providers log the model's raw selector at `info` | High | `Fixed` (0.4.1) |
| 23 | `HEALER_MAX_HEALS` is enforced in a different unit than it is documented in | Medium | `Fixed` (0.4.1) |
| 24 | The absolute test path is transmitted, at every redaction level | Medium | `Fixed` (0.4.1) |
| 25 | Preview mode is unreachable through the programmatic API without a credential | Medium | `Fixed` (0.4.1) |
| 26 | The engine's timeout does not cancel the provider's retry chain | Medium | `Fixed` (0.4.1) |
| 27 | `describeGetByCall` drops options the validator does not model | Low | `Fixed` (0.4.1) |
| 28 | The reporter reads `test.annotations` rather than `result.annotations` | Low | `Fixed` (0.4.1) |
| 29 | `SelectorCache` is unbounded in key count | Low | `Fixed` (0.4.1) |
| 30 | `HEALER_RECORDS_MAX` is neither validated nor reported | Low | `Fixed` (0.4.1) |
| 31 | `SelectorCache.describe()` mislabels misses as provider calls | Low | `Fixed` (0.4.1) |
| 32 | `prune(max)` mutates the retention cap as a side effect | Low | `Fixed` (0.4.1) |
| 33 | `fill` accepts `combobox`, but Playwright refuses a `<select>` | Low | `Fixed` (0.4.1) |
| 34 | The breaker rarely accumulates, because failing tests recycle workers | Low | `Accepted` |
| 35 | `HEALING_LOGS` is documented, typed and validated - and does nothing | Medium | `Fixed` (0.4.2) |
| 36 | `exactOptionalPropertyTypes` is cited in three files but switched off | Medium | `Fixed` (0.4.2) |
| 37 | `check:setup` reports a 0.2.x view of the configuration | Medium | `Fixed` (0.4.2) |
| 38 | `HealOptions` and two error classes are unreachable from the entry point | Medium | `Fixed` (0.4.2) |
| 39 | `delay()` ignores an already-aborted signal | Low | `Fixed` (0.4.2) |
| 40 | The entry point names a package that does not exist | Low | `Fixed` (0.4.2) |
| 41 | Two files call OpenAI and Gemini unimplemented while shipping both | Low | `Fixed` (0.4.2) |
| 42 | README overclaims "never the absolute path" | Low | `Fixed` (0.4.2) |
| 43 | `BROWSER`, `HEADLESS` and `SHOW_BROWSER` are consumed by nothing | Medium | `Fixed` (0.4.3) |
| 44 | `attachHealing()` never publishes `heal-unavailable` | Medium | `Fixed` (0.4.3) |
| 45 | The 0.4.2 strictness fix relabelled every Playwright error | Medium | `Fixed` (0.4.3) |
| 46 | The records file lands in a consumer's repo, unredacted, unmentioned | High | `Fixed` (0.4.3) |
| 49 | The first write to a new directory burns the whole lock budget | Medium | `Fixed` (0.4.3) |
| 50 | The documented CI setting disables the package | **Critical** | `Fixed` (0.4.4) |
| 51 | The CI gate disarms silently when it cannot read its setting | High | `Fixed` (0.4.4) |
| 52 | A second page in one test discards the gate's earlier heals | High | `Fixed` (0.4.4) |
| 53 | Playwright `retries` multiplies the cost of a gated run | Low | `Fixed` (0.4.4) |
| 47 | The retention default costs 117ms per heal | Medium | `Fixed` (0.4.3) |
| 48 | Records cannot be switched off, and `0` means unlimited | Medium | `Fixed` (0.4.3) |

Finding 34 was observed while verifying the others and is recorded rather than fixed.

**Findings 35-42 come from a third review, on 2026-08-26, against `v0.4.1`.** Three are
defects in the 0.4.1 work itself; the rest are older gaps the first two reviews walked past
because they were looking at *behaviour* rather than at the entry point, the build settings
and the pre-flight script.

**Findings 43-48 come from a fourth pass on 2026-08-26**, prompted by two questions rather
than a sweep: *"demo every `.env.example` option"* surfaced 43 and 44, and *"what is
`healing-records.json` for"* surfaced 46, 47 and 48. Finding 45 is a regression the 0.4.2
work introduced, caught by reading a preview file. 46 was the highest-severity finding
recorded here; 49 was found while fixing it.

**Findings 50-53 come from a fifth pass on 2026-08-27**, run against *scenarios* rather than
against code: what a team meets in CI, in a monorepo, on a second browser, in a test that
opens a popup. Finding 50 is the most serious defect recorded in either audit document -
the package's own documented production setting switches the package off. **Every finding
is now resolved.**

Ordered by severity, not by number. 20, 21 and 22 were the three to fix before pointing
this at a production suite; 21 was the only one that could change which element a test acts
on.

---

## 20. Redaction covers selectors but not the page text beside them — `Fixed` (0.4.1)

**Severity: High.** Finding 18 (0.4.0) redacted healed selectors on every export surface.
Two other channels on those *same* surfaces carry page text and were missed: the intent
check's **rejection reason** and the **observed accessible name**.

Reproduced directly against `IntentVerifier`:

```
reason  : the suggestion was described as "Place order" but resolves to "Smith, John 1970-03-11"
summary : {"mode":"enforce","verified":false,"checks":["self-consistency"],
           "role":"cell","name":"Smith, John 1970-03-11", …}
```

Both strings are built from `observed.name`, which is whatever the browser computed as the
element's accessible name — `core/IntentVerifier.ts:336-338` and `:436-438`. They then
travel:

| Surface | Redacted? |
|---|---|
| `heal-failed` annotation — `core/TestWrapper.ts:604` | **no** |
| attachment `reason` — `core/TestWrapper.ts:633` | **no** |
| attachment `attempts[].error` and `.intent.name` — `core/TestWrapper.ts:641-644` | **no** |
| the reporter's "Not healed:" block, i.e. CI stdout | **no** |
| `healed` annotation's `intent.name` — `core/TestWrapper.ts:585` | yes |

That last row is what makes this a bug rather than a judgement call. The success path
already calls `forDisplay` on the accessible name, so the channel was recognised and
handled; the failure path and the attachment's `attempts` spread were simply missed. The
attachment is the surface finding 18 explicitly cited as the reason to redact at all,
because it travels with the HTML report — which is exactly the artefact CI uploads.

**Fixed, and wider than proposed.** The plan was to reuse `redactSelector` for these
fields. Writing it showed that a *name* is not the same kind of value as a selector: a
selector is framework prose wrapped around page data, so collapsing quoted runs is right,
but a name is page data end to end with nothing around it to preserve — a quote-collapse
would find nothing to do and pass `Smith, John` straight through. So the guard gained two
methods rather than one:

- **`redactMessage()`** — patterns, plus quoted-run collapse at `strict`. The diagnosis
  survives (`described as "‹redacted›" but resolves to "‹redacted›"`), which is what makes the
  message still worth reading. `redactSelector()` now delegates to it, since the two were
  always the same operation.
- **`redactName()`** — patterns, and at `strict` the whole value goes.

Applied to the `heal-failed`, `heal-blocked`, `heal-skipped` and `healed` annotations, the
attachment's `reason`, and every page-derived field inside `attempts[]` — `error`, the
model's prose `reasoning`, and `intent.name`/`intent.reason`. Also to the CI gate's failure
message, which quotes the element and is the single most widely-read line this package
produces.

**Two things fell out of it.** The blocked-heal annotation quotes the page path that matched
a glob — `/patients/884213701` — which is exactly the kind of route someone blocks in the
first place; it is now redacted too. And the old `forDisplay(\`'${name}'\`).slice(1, -1)`
trick, which wrapped a name in quotes to borrow the selector path, mangled any name
containing an apostrophe; `redactName` replaces it.

`healing-records.json` stays unredacted, for the reason it always has.

**Verified:** 9 new unit tests across all three levels, including the apostrophe case, the
blocked-path identifier, and an assertion that `redactSelector` and `redactMessage` agree.

**Effort:** ~1 hour, as estimated.

---

## 21. The selector parser silently discards what it cannot parse — `Fixed` (0.4.1)

**Severity: High.** `SelectorValidator.resolve` (`core/SelectorValidator.ts:345`) finds the
first `getBy*(` and hands the balanced argument list to `extractCallArguments`. Anything
after the closing parenthesis is dropped without a word: `extractRefinement` recognises
only a **trailing** `.first()`, `.last()` or `.nth(n)`, and `isValidSyntax` passes the whole
expression because the brackets balance.

Measured against a stub root:

```
getByRole('row').filter({ hasText: 'Smith' }).getByRole('button')  →  getByRole('row')
getByRole('button', { name: 'Pay' }).filter({ visible: true })     →  getByRole('button', {name:'Pay'})
getByText('x').locator('..')                                       →  getByText('x')
getByRole('listitem').nth(2).getByRole('link')                     →  getByRole('listitem')
```

The first line is the dangerous one. On a page with exactly one row it validates, and the
healer clicks **the row instead of the button inside it** — while the healing record, the
report attachment and the CI gate's `+` line all show the full chained expression, which
means something different from what was actually resolved.

The intent check catches this **only** when the model supplied `expectedRole` — optional by
design, `core/AiProvider.ts:247` — and the mode is not `off`. The second line is worse in a
quieter way: the suggestion is accepted, and the rewrite you are told to paste into a page
object is one this very validator would resolve differently.

This is the one finding that contradicts the codebase's own stated principle. "No silent
caps", "never silent", "a caller seeing a partial page should know it is partial" appear
throughout — and the record cap, the element limit and the snapshot truncation all log what
they dropped. The parser does not.

**Fixed as proposed.** `SelectorValidator.unsupportedSuffix()` names the uninterpretable
trailing text; `resolve()` returns `null` rather than a locator for the leading call, and
`validateDetailed()` reports the suffix as the rejection reason — which feeds the next
prompt like any other rejection, and is exactly where a model learns to answer with one
call. Refusing is right rather than supporting the chain: `.filter({ has: … })` takes a
*locator*, so it cannot round-trip through a text expression at all.

Bare CSS and XPath are left alone. They have their own grammars and Playwright's parser is
the authority on them, so `div > .row:has(> button)` is not this class's business.

**A second bug surfaced while fixing it.** `extractRefinement` peeled only the *last*
positional refinement, so `getByRole('row').nth(2).first()` dropped the `.nth(2)` on the
same silent path and resolved to the **first** row rather than the third. That shape is not
hypothetical — `TestWrapper` generates it whenever a refined locator is refined again.
`stripRefinements()` now peels the whole run and `resolve()` applies them in source order.

**Verified:** 10 new unit tests. All four chain shapes above are refused and name their
suffix; every supported shape still resolves; the repeated-refinement case asserts the
call order is `nth(2)` then `first`.

**Effort:** ~2 hours, as estimated.

---

## 22. Providers log the model's raw selector at `info` — `Fixed` (0.4.1)

**Severity: High.** All three providers print the suggestion verbatim:

```
[heal:anthropic] Suggested "getByText('Smith, John')" (confidence 0.95) …
```

`providers/AnthropicProvider.ts:186`, `providers/GeminiProvider.ts:185`,
`providers/OpenAIProvider.ts:165`. `info` is the default level, so this reaches CI stdout at
every redaction level, `strict` included.

The engine's own accepted-heal line *is* redacted (`core/HealingEngine.ts:655`), which is
finding 18 working as intended. But its two **rejection** lines are not —
`core/HealingEngine.ts:603` and `:622` — and a rejected suggestion is precisely the one
likeliest to have grabbed page text, because grabbing page text is often why it was
rejected.

Providers sit below the guard on purpose and should not be given one; that layering is
correct and worth keeping.

**Fixed as proposed**, and the rule it implies is now written down rather than left to
be inferred per call site:

> **Nothing model-derived reaches `info` or above unredacted. `debug` is opt-in and
> unredacted by design.**

- All three providers report confidence and token cost at `info` and moved the selector to
  `debug`. They sit below the guard deliberately — a transport should not hold a policy —
  so removing the value is the fix, not handing them a guard.
- The engine's two rejection lines now redact **both** halves: the suggestion and the
  reason, since the intent reason quotes the element the model landed on.
- `SelectorCache.noteHit` logs a reused selector at `info`. It is redacted at the call site
  rather than by teaching a bookkeeping class about privacy.
- `SelectorValidator`'s five expression-quoting `warn`s dropped to `debug`. The engine
  already reports every rejection at `warn` with the guard applied, so these were a second,
  unprotected copy of the same news.

**Verified:** 3 new unit tests driving a real heal against a stub server and asserting that
no `info` line contains the answer, while confidence and token cost still do.

**Effort:** ~30 minutes, as estimated.

---

## 23. `HEALER_MAX_HEALS` is enforced in a different unit than it is documented in — `Fixed` (0.4.1)

**Severity: Medium.** `check()` runs once per heal (`core/HealingEngine.ts:426`). `spend()`
runs once per **attempt**, inside the retry loop (`core/HealingEngine.ts:547`). Measured
against `HealBudget` directly:

```
maxHeals=4, maxRetries=2  →  2 heals allowed
```

Everything that describes the setting says heals: `core/HealBudget.ts:42` ("Heals that may
reach the provider"), `config.ts:80`, `.env.example:28`, README, ARCHITECTURE, and the
refusal message the user actually reads ("used its ceiling of 4 provider-backed heal(s)").
`HealBudgetStats.spent` is commented "Heals that reached the provider" and counts calls.

So the default ceiling is **50 heals, not 100**. The effect is benign — a lower ceiling
than advertised is the safe direction — but the sibling field's docstring says "Counted in
**attempts**, not heals" as an explicit contrast, which means one of the two is wrong on
its own terms rather than merely imprecise.

**Fixed by moving the counter, not the documentation.** The contrast in the sibling
docstring makes the docs the intended truth, and rewriting six of them to say "calls" would
also have left the setting harder to reason about — nobody budgets in retries. `spend()`
now fires once per heal that reaches a provider; the breaker still counts attempts, which
is what its own docstring already promised.

**A second behaviour surfaced while testing it.** `budget.check()` runs once per heal, so a
breaker that opened on attempt two did **not** stop attempt three — the loop carried on
calling a provider already known to be down. With `HEALER_MAX_RETRIES=10` and a threshold
of 5, a single failing action still spent five more timeouts after the breaker tripped,
which is precisely the cost the breaker exists to prevent, and it made
`ARCHITECTURE.md`'s "caught in roughly `threshold ÷ HEALER_MAX_RETRIES` failing actions"
untrue. The breaker is now re-checked between attempts. That heal reports `heal-failed`
with the connection error rather than `heal-skipped`, because it genuinely did reach the
provider; the *next* heal is the skipped one.

**Verified:** a new `tests/unit/heal-loop.test.js` — the first test that drives the real
engine rather than one collaborator, since this behaviour only exists in the relationship
between them. Six tests: one heal with three retries charges one heal and makes three
calls; `maxHeals=2` admits two heals rather than one; a refusal names `HEALER_MAX_HEALS`
and makes no call; the breaker trips mid-heal and abandons the rest; the next heal is
refused without calling out; and a merely-rejected suggestion never trips it.

**Effort:** ~1 hour, as estimated.

---

## 24. The absolute test path is transmitted, at every redaction level — `Fixed` (0.4.1)

**Severity: Medium.** Rendered from a live heal at `HEALER_REDACT=strict`:

```
Page URL: https://app.example.com/checkout (query omitted)
Test location: D:\Users\<account>\OneDrive - <organisation>\Documents\…\spec.js:26
```

The query string was correctly stripped one line above, which shows the guard working. This
field simply is not routed through it: `sanitizeRequest` passes `testFile` and `testLine`
through by explicit choice (`core/PrivacyGuard.ts:312-313`), and `PromptBuilder` renders
them (`utils/PromptBuilder.ts:91`).

README's "What is transmitted" table does disclose this — *"The test file path and line
number | no"*. What that row does not convey is that it is the **absolute** path, carrying
the account name and the organisation name, on every heal. Nobody reading "test file path"
predicts `D:\Users\…\OneDrive - Norstella\…`.

The package already knows how to do better: `relativeToProject()` (`core/TestWrapper.ts:513`)
is used for every display surface precisely because an absolute Windows path is unwieldy.

**Fixed as proposed.** `relativeToProject()` moved out of `TestWrapper` into
`utils/paths.ts` — it now has three callers with the same need, and duplicating it into the
guard would have been the third copy of one rule. `sanitizeRequest` applies it, so the
prompt carries `tests/checkout.spec.ts:42`. A path outside the project keeps its original
form rather than growing `..` segments, and the engine's `'unknown'` fallback passes
through.

**Applied at every level, `off` included.** This is normalisation, not redaction: `off`
means "do not apply your built-in rules to my page content", and it would be strange for it
to mean "and also send my home directory". The relative form is simply the better value,
which is why it does not depend on a policy.

**`RedactionField` gained `testFile`.** A repository layout is disclosure of a different
kind from page content, and some organisations treat it as such — so a caller can now write
a rule that strips it outright, rather than having it arrive under a field name that
belongs to something else.

**Verified:** 6 new unit tests — relative inside the project, unchanged outside it, forward
slashes on every platform, identical at all three levels, `'unknown'` preserved, and a
redactor able to withhold the field. The existing "is offered every field" test caught the
new field name, which is exactly what it was written to do.

**Effort:** ~45 minutes, as estimated.

---

## 25. Preview mode is unreachable through the programmatic API without a credential — `Fixed` (0.4.1)

**Severity: Medium.** Reproduced:

```
programmatic previewDir, no key  →  NULL  (preview impossible)
env previewDir, no key           →  built (preview works)
```

`createProvider` carries the deliberate keyless-preview allowance
(`core/TestWrapper.ts:378`). `createHealingEngine` (`core/TestWrapper.ts:1304`) calls
`getConfig()` first, and `getConfig` only skips the credential assertion when `previewDir`
came from the **environment** (`config.ts:586`) — an `options.previewDir` has not been read
at that point. So `createHealingFixtures({ previewDir: './p' })` fails for exactly the
reason the environment path was built to avoid, stated in `ARCHITECTURE.md:380`: requiring a
key to find out what would be transmitted puts the audit trail behind the very approval it
exists to support.

**Fixed as proposed**, in two halves that had drifted apart:

- **`getConfig(context)`** now takes a `ConfigContext` carrying a caller-supplied
  `previewDir`, and treats it exactly as it treats `HEALER_PRIVACY_PREVIEW`. The reason to
  skip the credential check is that no provider call will be made, and that is equally true
  whichever source set the directory — which source it was is not a difference that should
  change the answer.
- **`credentialFor()`** was extracted from `createProvider`, where the keyless allowance had
  been living alone, and is now used by both construction paths.

**Verified:** 7 new tests. `getConfig({ previewDir })` no longer demands a credential while
`getConfig({})` still does; `createHealingEngine({ provider, previewDir })` builds a
preview-only engine with no key for **all three** providers — `openai` and `gemini` were the
worse cases, since `buildProvider` threw for them outright — and a real credential still
wins over the stand-in.

**Effort:** ~45 minutes, as estimated.

---

## 26. The engine's timeout does not cancel the provider's retry chain — `Fixed` (0.4.1)

**Severity: Medium.** `buildProvider` passes `config.healing.timeout` as the provider's
per-request timeout (`core/TestWrapper.ts:380`), and the engine races `heal()` against *the
same* value (`core/HealingEngine.ts:549`). `postJson` then retries twice on top of that
(`providers/httpJson.ts:129`).

Against a hung endpoint the outer race always wins first, so the inner retry can never
complete in the case it exists for — and the two abandoned attempts keep running
unobserved, up to the full timeout each, per heal. The backoff timer is `unref`'d but the
`fetch` itself is not, so the sockets stay open.

Fast failures are unaffected: a refused connection retries in ~1.5s and finishes well inside
the outer budget. It is specifically the hang that leaks.

**Fixed as proposed.** `withTimeout` became `withDeadline`, which hands the work an
`AbortSignal` and **aborts as well as rejects** when the deadline passes — losing a
`Promise.race` only abandons a promise, which was the whole problem. The signal travels as
`HealOptions.signal` on `AiProvider.heal`, through all three providers, into `postJson`.

There it does three things: forwards onto the in-flight request's controller, cuts a
backoff short (the longest a cancelled call would otherwise sit before noticing), and is
checked at the top of each attempt so a chain cancelled mid-backoff never starts the next
request. A cancelled chain throws `RequestCancelledError` rather than a timeout — telling
someone their request ran out of time when something upstream stopped caring sends them to
tune the wrong setting.

**Measured against a server that never replies:**

```
no signal        requests: 3   elapsed: 2467ms  -> ... timed out after 200ms
cancelled@350    requests: 1   elapsed:  364ms  -> ... was cancelled
```

**`HealOptions` is optional on the contract.** `heal(request)` is still assignable to
`heal(request, options?)`, so a custom provider — the documented extension seam for a
model this package does not ship — keeps compiling and is no worse off than before.

**Verified:** 5 new unit tests against a hanging local server: the full chain runs when
nothing cancels it, no further request is made once the signal aborts, an already-aborted
signal makes no request at all, cancellation is reported as cancellation rather than as a
timeout, and a provider called without a signal behaves exactly as it did.

**Effort:** ~2 hours, as estimated.

---

## 27. `describeGetByCall` drops options the validator does not model — `Fixed` (0.4.1)

**Severity: Low.** `core/TestWrapper.ts:699` renders only `name`, `exact` and `level`;
`core/TestWrapper.ts:997` renders `page.locator(selector, options)` as the bare selector
string. So `getByRole('button', { pressed: true })` is recorded as `getByRole('button')`,
and `locator('.row', { hasText: 'Smith' })` as `.row`.

Nothing resolves incorrectly — the *real* locator is the one Playwright built, and the
expression is only used as text. But the text is what the healing record, the report and the
CI gate's `-` line show as "the selector that failed", and it is not the code in the user's
source. Someone following the gate's instructions would search for a string that is not
there.

**Fixed, and wider than proposed.** The plan was to *mark* the dropped options. Writing it
showed marking was the wrong answer: nearly every option Playwright accepts is a primitive
or a regex, so it can simply be **rendered**. `getByRole('button', { pressed: true })` now
reports itself as exactly that. `name`, `exact` and `level` are emitted first, so the
overwhelmingly common output is byte-identical to before and no existing record changes
shape.

Only `has` and `hasNot` genuinely cannot be written back — they take a *Locator* — and those
render as `…`, which is honest about there being something there rather than pretending
there was not. `page.locator(selector, options)` gains the same treatment, switching to the
explicit `locator('.row', { hasText: 'Smith' })` form only when there are options to show.

**The same silent-truncation shape existed on the resolve side**, which is finding 21's
principle one level in. `SelectorValidator` forwards only `name`, `exact` and `level`, and
every option it drops — `pressed`, `checked`, `disabled`, `expanded`, `selected`,
`includeHidden`, and `locator()`'s options entirely — *narrows* the match. Dropping one
resolved a broader set than the expression described: the identical failure to a truncated
chain. `unhonouredOptions()` now names them and the suggestion is refused, with the reason
feeding the retry. Quoted literals are blanked before keys are matched, so a name like
`{ name: 'Total, b: c' }` is not misread as an option called `b`.

**Verified:** 4 new unit tests, plus a direct check that every previously-dropped option now
appears in the recorded expression.

---

## 28. The reporter reads `test.annotations` rather than `result.annotations` — `Fixed` (0.4.1)

**Severity: Low.** `reporters/HealingReporter.ts:95` iterates `test.annotations`, which
Playwright's own types define as *"`testResult.annotations` of the last test run"*.
`result.annotations` is the exact per-result channel and is already in the callback
signature.

The counts are correct today, and this was confirmed by forcing real retries during the
0.4.0 work — but only because `onTestEnd` fires before the next attempt begins, so "the last
run" happens to be the result being handed over. That is an ordering assumption about the
runner, not a guarantee from the API. The reporter already reads `result.attachments`
correctly, so the two channels are inconsistent with each other.

**Fixed as proposed.** `annotationsOf(test, result)` prefers `result.annotations` and falls
back to `test.annotations` for the older end of the supported peer range, where `TestResult`
has none — reading nothing there would silently zero every count, which is the failure this
reporter was rewritten in 0.4.0 to stop having.

The counts were already correct, as measured during the 0.4.0 work. What was wrong was
*why*: they depended on `onTestEnd` firing before the next attempt began, so that "the last
run" happened to be the result being handed over. That is the runner's business, not this
reporter's — and the attachments beside it were already read per result, so the two channels
disagreed about which question they were answering.

---

## 29. `SelectorCache` is unbounded in key count — `Fixed` (0.4.1)

**Severity: Low.** `core/SelectorCache.ts:97` caps candidates at three *per selector* but
places no limit on the number of distinct selectors remembered. A long-lived worker
accumulates one entry per selector it has ever healed.

The practical ceiling is the number of rotted selectors in a suite, so this is small in
every realistic case. It is recorded because the records file was bounded in 0.4.0 for
precisely this reason, and leaving its sibling unbounded is an inconsistency rather than a
considered exception.

**Fixed as proposed**, with the eviction made least-recently-**used** rather than
oldest-first: `candidates()` re-inserts the key it reads, so a selector a suite keeps
touching survives a burst of one-off ones. The cap is 500 distinct selectors, which no
ordinary suite reaches — it is a backstop against a pathological one, not a tuning knob.

**Evictions are counted and reported.** A bounded cache that never says it dropped anything
looks exactly like one that had room for everything, which is the "no silent caps" rule this
package applies to the records file, the element limit and snapshot truncation.

**Verified:** 3 new unit tests — the cap holds and the oldest goes, a selector that was read
survives a later flood, and `describe()` names the number evicted.

---

## 30. `HEALER_RECORDS_MAX` is neither validated nor reported — `Fixed` (0.4.1)

**Severity: Low.** `utils/HealingRecorder.ts:36` reads it straight from `process.env` and
falls back to 10,000 on anything unusable. It is the only healer variable that `config.ts`
does not validate and `validateConfig()` does not print, so `HEALER_RECORDS_MAX=1O000`
(letter O) silently becomes the default.

The read-it-directly rationale is sound and matches `isHealingEnabled()`: the recorder must
keep working when the rest of the configuration is invalid. The *silence* is the part that
does not match the rest of the package, where a malformed value is a hard `ConfigError` with
the variable named.

**Fixed as proposed.** The recorder still reads it straight from the environment — it has
to keep working when the rest of the configuration is invalid, the same reasoning as
`isHealingEnabled()` — but it now **warns**, naming the variable and the value it could not
use. That is an argument for not *throwing*, never one for saying nothing.

`validateConfig()` also prints the effective cap beside the other spend controls, and says
so outright when the value was ignored. A validation summary that silently omits a setting
is how a typo survives.

**Verified:** 1 new unit test asserting the warning names both `HEALER_RECORDS_MAX` and the
offending value.

---

## 31. `SelectorCache.describe()` mislabels misses as provider calls — `Fixed` (0.4.1)

**Severity: Low.** `core/SelectorCache.ts:198` renders `misses` as "provider call(s)". A
miss is followed by a provider call only when the budget allows it, the breaker is closed
and the privacy gate passed. On a run where the ceiling was reached, this line overstates
what was spent.

**Fixed as proposed.** `describe()` now reads `5 miss(es)` rather than `5 provider call(s)`.
A miss reaches the provider only if the spend ceiling allows it, the breaker is closed and
the privacy gate passed — and the reporter's `skipped` and `blocked` counts already explain
the difference. The existing test that pinned the old wording was updated with the reason
recorded beside it.

---

## 32. `prune(max)` mutates the retention cap as a side effect — `Fixed` (0.4.1)

**Severity: Low.** `utils/HealingRecorder.ts:140` assigns `this.maxRecords = max`, so
`prune(100)` permanently changes the cap for the recorder's lifetime. The docstring frames
the method as trimming an existing file — "for example before archiving one" — which does
not suggest a lasting configuration change.

**Fixed, and the reassignment turned out to be load-bearing.** Simply removing
`this.maxRecords = max` broke `prune()` outright, and a test caught it: `persistToFile`
merges against what is on disk before writing, so with the cap unchanged the merge restored
every record the trim had just dropped. The assignment was not a stray side effect — it was
how the trim survived the merge, via a mechanism nothing named.

So the cap is now a **parameter of the write**: `persistToFile(cap)` defaults to the
recorder's own retention cap, and `prune(max)` passes its own. The trim works, and calling
it no longer reconfigures every write that follows.

**Verified:** 1 new unit test that prunes to 3 and then records more, asserting the original
cap of 20 is still in force.

---

## 33. `fill` accepts `combobox`, but Playwright refuses a `<select>` — `Fixed` (0.4.1)

**Severity: Low.** `core/IntentVerifier.ts:87` lists `combobox` among the roles `fill()` may
target. A `<select>` also has role `combobox`, and `fill()` throws on it — "Element is not
an `<input>`, `<textarea>` or `[contenteditable]`".

This is a false *negative* in the check the module calls its strongest, so it lets a bad
heal through rather than rejecting a good one. It is also not cleanly fixable: an
`<input role="combobox">` on an autocomplete is genuinely fillable, and the role alone
cannot distinguish the two.

**Accepted in effect, recorded as proposed** — the behaviour is unchanged and the reason is
now a comment where the list is defined, so the next reader does not mistake it for an
oversight.

It cannot be cleanly fixed. An `<input role="combobox">` on an autocomplete is genuinely
fillable and a `<select>` with the same computed role is not, and the role alone does not
separate them. It is also a false *negative*, which is the right direction for this check to
fail in: refusing a correct heal is worse than letting Playwright report the real error on
the retry. The action-compatibility gate remains sound for `check`, `uncheck`,
`selectOption` and the textbox family.

---

## What the fixes turned up

Nothing here blocked the 0.4.0 release or invalidated it, but four of the fourteen exposed a
second defect once the fix was written — which is the part worth keeping:

- **21** — `extractRefinement` peeled only the *last* positional refinement, so
  `getByRole('row').nth(2).first()` silently dropped the `.nth(2)` and resolved to the
  **first** row. Same silent-truncation path, a shape `TestWrapper` generates itself.
- **23** — the breaker was checked once per heal, so one that opened on attempt two did not
  stop attempt three. With `HEALER_MAX_RETRIES=10` a single failing action still spent five
  more timeouts on a provider already known to be down.
- **27** — the option-dropping was not only a display problem. `SelectorValidator` forwards
  three options and drops the rest, and every dropped one *narrows* the match — so a
  suggestion resolved a broader set than it described. Finding 21's principle, one level in.
- **32** — `prune()`'s cap reassignment was load-bearing, not a stray side effect: removing
  it broke the trim, because `persistToFile` merges against disk and the merge restored
  everything the trim had dropped. Caught by a test, and the fix is better than either the
  original or the first attempt.

Two of the fixes also made a documented claim true that had not been. `ARCHITECTURE.md`
said an outage was caught in roughly `threshold ÷ HEALER_MAX_RETRIES` failing actions
(finding 23), and the README's transmitted-data table said "the test file path" where what
travelled was an absolute path carrying an account and organisation name (finding 24).

---

## 34. The breaker rarely accumulates, because failing tests recycle workers — `Accepted`

**Severity: Low.** Observed while verifying the other findings, on a run where the provider
was unreachable. Four tests, two attempts each — eight consecutive provider failures against
a `HEALER_BREAKER_THRESHOLD` of 5 — and **the breaker never opened**. Every test reported
`heal-failed` with the connection error; none reported `heal-skipped`.

The cause is not a defect in `HealBudget`. Playwright discards a worker after a failed test,
and a heal that cannot reach the provider fails the test — so each test ran in a fresh
process with a fresh count. The breaker is per worker because workers are separate
processes, which means its consecutive-failure count is reset by exactly the condition it
exists to detect.

It still earns its keep in the case it was written for: a suite where *most* tests pass and
a handful heal. There the worker survives, the count accumulates, and the breaker stops the
run waiting `HEALER_TIMEOUT × HEALER_MAX_RETRIES` on every remaining failure. The 0.4.0
release verified exactly that — the breaker latched after 2 failures and tests 3 and 4 made
zero calls. What this finding adds is that the total-outage case, where every test fails, is
the one where it helps least.

**Accepted rather than fixed**, for the same reason the ceiling is per worker: a cross-worker
count needs the records file's lock-file dance on every heal, to coordinate a number that
only has to be approximately right. Two things make the residual cost small — the engine now
re-checks the breaker *between* attempts (finding 23), so a fresh worker still caps itself at
`threshold` attempts rather than `maxRetries` per action; and the wall-clock cost of a total
outage is bounded by Playwright's own test timeout regardless.

**`SelectorCache` has the identical interaction, and it is already documented** — README
notes that `HEALER_FAIL_ON_HEAL` largely defeats the cache because a failed test starts the
next worker cold. This is that same mechanism reaching a second per-worker structure, so it
belongs in the same paragraph rather than as a surprise.

---

## 35. `HEALING_LOGS` is documented, typed and validated - and does nothing - `Fixed` (0.4.2)

**Severity: Medium.** Grepping `healingLogs` outside `config.ts` returned **nothing**. The
variable was parsed by `parseBoolean`, surfaced on the exported `LoggingConfig` type,
documented in `.env.example` as "Whether individual healing attempts are logged and
recorded", and read by nobody. `HEALING_LOGS=false` had no effect whatsoever.

Worse, the 0.4.1 work made it *actively misleading*: finding 30 added a
`[config] Records - enabled/disabled` line to `validateConfig()` keyed on this value, so the
package began asserting a state it did not implement.

**Fixed by making it work, not by deleting it.** Deleting is a breaking change to an
exported type, for a feature people may believe they are already using - and the feature is
worth having. A suite that heals fifty times produces fifty narration lines, and turning
`LOG_LEVEL` down to silence them silences everything else in the run too. Those are
different questions: *how verbose* versus *do I want this subsystem talking at all*.

`HEALING_LOGS=false` now suppresses `info` and `debug` from the `heal:*` loggers only.
**Warnings and errors always get through**, and the docstring's claim about "recorded" was
corrected rather than implemented. A blocked heal, a tripped breaker and a missing
`describe()` are findings; records are an audit trail. A logging switch able to hide either
would be a way to make problems invisible rather than quiet.

---

## 36. `exactOptionalPropertyTypes` is cited in three files but switched off - `Fixed` (0.4.2)

**Severity: Medium.** Three providers carry the comment "Spread-in rather than assigned:
`exactOptionalPropertyTypes` rejects an explicit `undefined` on an optional field" - and the
flag was not in `tsconfig.json`. The `...(x !== undefined ? { x } : {})` idiom is used
throughout this codebase and the stated reason for it was unenforced.

The distinction it protects is load-bearing rather than stylistic. `IntentVerifier` treats a
missing `expectedRole` as "the model did not say", and `PrivacyGuard.sanitizeRequest`
rebuilds every field conditionally precisely so a new field is a compile error rather than a
new disclosure channel. An explicit `undefined` compiled fine and could take a different
branch.

**Fixed by enabling it, and `noUncheckedIndexedAccess` alongside.** Both cost less than
expected: three call sites and two index reads, all internal, plus `workers: ... : undefined`
in the demo's own `playwright.config.ts`. The code was already written to satisfy both - the
flags turn a habit into a rule.

---

## 37. `check:setup` reports a 0.2.x view of the configuration - `Fixed` (0.4.2)

**Severity: Medium.** The README positions `npm run check:setup` as *the* pre-flight, and it
is the free one people actually run before spending anything. It printed `enabled`,
`provider`, `threshold`, `maxRetries` and `timeout`, then stopped.

Invisible in it: **`HEALER_REDACT`**, the route policy, the snapshot root, preview mode,
**`HEALER_INTENT_CHECK`**, `HEALER_FAIL_ON_HEAL`, `HEALER_CACHE`, `HEALER_MAX_HEALS` and
`HEALER_BREAKER_THRESHOLD`. Three of those are the safety-critical defaults that 0.3.0 and
0.4.0 were built around, and two have a permissive setting that is a genuine hazard -
`redact=off` transmits page content in full, `intent=off` lets a wrong element pass.
`validateConfig()` reports all of it, but only if wired into global setup, so the two
"tell me my configuration" surfaces disagreed about what configuration *is*.

**Fixed** with `safety` and `ceilings` sections, and an inline arrow on the two settings
whose permissive value carries real risk. Extending the script people already run beats
telling them to call a second one.

---

## 38. `HealOptions` and two error classes are unreachable from the entry point - `Fixed` (0.4.2)

**Severity: Medium.** `HealOptions` was added in 0.4.1 to the **public** signature of
`AiProvider.heal` - the documented extension seam for a provider this package does not ship
- and was never exported from `index.ts`. A consumer writing
`class MyProvider extends AiProvider` in TypeScript had no way to type the second parameter
of a method they are being asked to implement.

`RequestCancelledError` (0.4.1) and `NonJsonResponseError` (pre-existing) had the same
problem. `httpJson` is exported as a helper for exactly that use case, and both errors are
things a provider author would want to `instanceof`.

**Fixed** by exporting all three, verified by loading the built entry point and checking each
resolves to a constructor.

---

## 39. `delay()` ignores an already-aborted signal - `Fixed` (0.4.2)

**Severity: Low.** A defect in the 0.4.1 cancellation work.
`signal.addEventListener('abort', ...)` does **not** fire on a signal that has already
aborted - confirmed directly. So a chain cancelled *during* an attempt sat out the whole
backoff (500ms, then 1000ms) before the loop-top check noticed, which is exactly the delay
the signal exists to remove.

**Fixed** with an early return before the listener is attached. The end-to-end measurement in
finding 26 did not catch it because the abort there landed mid-request rather than
mid-backoff - a reminder that one passing measurement is not coverage of the path.

---

## 40. The entry point names a package that does not exist - `Fixed` (0.4.2)

**Severity: Low.** `src/index.ts`'s `@packageDocumentation` block - the first thing anyone
reads, and the one that flows into generated API docs - told people to
`import { test, expect } from ''`. A leftover from a rename, and `src/`
ships, so it was in the tarball.

---

## 41. Two files call OpenAI and Gemini unimplemented while shipping both - `Fixed` (0.4.2)

**Severity: Low.** `src/index.ts` said "OpenAI, Gemini, and Ollama are configurable but not
yet implemented" - eighty lines above exporting `OpenAIProvider` and `GeminiProvider`, both
fully implemented, both exercised by the provider test suites, and both listed in README's
own feature line ("All three providers call their REST APIs directly").
`TestWrapper.setHealingEngine`'s docstring repeated the claim.

Only Ollama genuinely has no implementation. Both now say so, and point at `OPENAI_BASE_URL`
as the way to reach one.

---

## 42. README overclaims "never the absolute path" - `Fixed` (0.4.2)

**Severity: Low.** Wording introduced by finding 24, in the **transmitted-data table** -
the worst place in this package to overclaim, because it is what someone reads before
deciding whether healing may run near their application.

`relativeToProject()` deliberately keeps the original path for a file outside the working
directory, since `../../..` segments disclose the same layout while being harder to read.
That behaviour is sound and documented on the helper - but "never" promised something the
code does not do, for instance in a monorepo running Playwright from a package
subdirectory.

**Fixed** by softening the table to "reduced to project-relative - see below" and adding a
short section naming the residual case, with the `redactor` snippet that withholds the field
outright.

---

## 43. `BROWSER`, `HEADLESS` and `SHOW_BROWSER` are consumed by nothing - `Fixed` (0.4.3)

**Severity: Medium.** All three were parsed by `parseBoolean`/`parseEnum`, range-checked,
surfaced on the exported `Config.playwright` type, documented in `.env.example`, printed by
`validateConfig()` - and read by no consumer. `playwright.config.ts` hardcoded
`headless: false` and `projects: [{ name: 'chromium' }]`.

So `BROWSER=firefox` did nothing, and `HEADLESS=true` did nothing while `.env.example`
shipped exactly that value. The demo always ran headed, contradicting its own template.

Identical in kind to finding 35 (`HEALING_LOGS`), which suggests the pattern rather than the
instance is the problem: a setting is added to `config.ts`, typed, documented, and then
nobody wires the consumer. **The fourth occurrence of this shape** - 35 here, 30 and 11 in
the first audit.

**Fixed** by reading the three in `playwright.config.ts`. Read directly rather than through
`getConfig()`, deliberately: `getConfig()` throws when healing is enabled without a
credential, and a Playwright config that cannot *load* without an API key would break
`HEALER_ENABLED=false` runs - the one path that has to work with no setup at all.

**A behaviour change, and worth stating:** the demo now honours `HEALED=true` and runs
headless. `SHOW_BROWSER=true` is the documented way to watch it. Verified with
`BROWSER=firefox`, which now produces a firefox project.

---

## 44. `attachHealing()` never publishes `heal-unavailable` - `Fixed` (0.4.3)

**Severity: Medium.** `applyHealing` pushes the `heal-unavailable` annotation when the engine
could not be built; `attachHealing` did not. It is the documented path for "frameworks that
build their own `page`" - a custom context, stored auth state, a page-object base class - and
its own docstring said:

> Reporting still works, because it is published from the wrapped actions rather than from
> construction.

That is true of `healed`, `heal-failed`, `heal-blocked` and `heal-skipped`, and false of the
fifth. `heal-unavailable` is the *only* outcome published from construction, so it was
exactly the one that path lost. A consumer integrating this way saw a suite that had silently
stopped healing as one that never needed to - which is the failure mode the annotation was
added to prevent.

**Fixed** by annotating in `attachHealing` too, resolving `TestInfo` the way `publishOutcome`
does so it stays safe to call from a global setup file where there is no test. Caught by the
first test written for finding 37's spec.

---

## 45. The 0.4.2 strictness fix relabelled every Playwright error - `Fixed` (0.4.3)

**Severity: Medium.** A regression introduced by finding 36. Enabling
`noUncheckedIndexedAccess` produced an error at the one line in this codebase that must not
be refactored, and the fix hoisted the method into a variable and invoked it with `.call()`:

```
Error: locator.call: Timeout 5000ms exceeded.     <- was: locator.click
```

Design principle 2 is *"the original Playwright error is re-thrown unchanged - same message,
same `locator.click:` label"*. `ARCHITECTURE.md` carries a measured table of invocation forms
whose fourth row is literally **`computed method name + .call()` -> `locator.call:`**, and the
surrounding comment names `.call()` as a failure mode. The fix walked into the documented
trap.

**Fixed** by writing `methods[action]!(...args)`. The `!` is erased at compile time, so the
emitted JavaScript is a plain property call and the label is preserved - verified in the
emitted `dist/` output and end to end.

**Worth recording as a process observation:** 379 unit tests did not catch this, because none
asserts on an error *label*. It surfaced from reading a `HEALER_PRIVACY_PREVIEW` file for an
unrelated reason - the payload embeds the Playwright error verbatim, which makes the preview
an accidental regression test for something nothing else checks.

---

## 46. The records file lands in a consumer's repo, unredacted, unmentioned - `Fixed` (0.4.3)

**Severity: High.** The highest-severity finding in this document and the only one still
open.

`healing-records.json` defaults to `path.resolve('healing-records.json')`, which is the
**consumer's** working directory. After one heal their project root gains the file - plus a
transient `.lock` beside it - holding unredacted page text, real selectors and the model's
reasoning.

README states:

> **`healing-records.json` is never redacted.** It is local and **gitignored**, and it is
> where you go for the exact rewrite.

That describes *this* repository and is presented as a property of the file. In a consumer's
project it is local and emphatically **not** gitignored: their `.gitignore` has never heard
of it, npm strips `.gitignore` from tarballs, and ours is not in `files` anyway.

This is not cosmetic, because the claim is **load-bearing**. The entire justification for
redacting the annotations, the attachment, the CI gate message and the run summary is *"the
unredacted copy stays local."* If the file is committed, that premise fails and page content
enters git history permanently.

Two things make it worse:

- **`HEALING_RECORDS_PATH` was in no user-facing document** - not in `.env.example`, not in
  README, not in INTEGRATION. The one setting that moves the file somewhere safe existed only
  in a docstring. (Fixed in passing by finding 48's `.env.example` rewrite; the rest stands.)
- **`INTEGRATION.md` has a "Before you point this at a real application" section** that never
  mentions the file.

Meanwhile the reporter ends every run with `Full per-attempt detail: healing-records.json`,
pointing at it without a word about source control.

**Fixed as proposed, and the file was deliberately not moved** - it is meant to be found,
and hiding it in a cache directory would defeat its only purpose.

`HealingRecorder` now warns **once per worker** on first write, naming the directory and all
three remedies. It is **silent in the two cases where the reader has clearly thought about
it**: when the path was chosen (by the caller or by `HEALING_RECORDS_PATH`), and when
`.gitignore` already covers the file. That restraint is the point - a warning that keeps
firing after you have fixed it is one people learn to skip, which is how the next real one
gets missed. This package makes the same argument for the `describe()` reminder.

The claim was corrected in both places that made it. README's "It is local and gitignored"
became "**you** have to keep it out of source control", with the three settings that do it;
ARCHITECTURE now states plainly that nothing enforces locality in a consumer's project.
`HEALING_RECORDS_PATH` and `HEALER_RECORDS` are documented in README, `.env.example`, and at
the top of INTEGRATION's "Before you point this at a real application" checklist - which is
where someone deciding whether to run this near real data will actually look.

**Verified:** 4 new unit tests - warns when uncovered, silent when `.gitignore` covers it,
silent when the caller chose the path, and never twice.

**Effort:** ~30 minutes, as estimated.

---

## 49. The first write to a new directory burns the whole lock budget - `Fixed` (0.4.3)

**Severity: Medium.** Found while verifying finding 46's warning, in the configuration that
finding recommends.

`persistToFile` took the write lock **before** creating the target directory - and the lock
file lives *in* that directory. So the first write to a path that does not exist yet spent
all 80 retries failing to create a lock in a directory that could not hold one, gave up,
warned `Could not acquire the record lock; writing without it`, and only then created the
directory and wrote:

```
directory already exists     12 ms for the first write
directory does NOT exist   3181 ms for the first write
```

A 3.2-second stall inside the first heal, plus a spurious warning about a lock nothing was
contending for. Latent since the locking protocol was written, and invisible until finding 46
made `HEALING_RECORDS_PATH=../healer-artifacts/records.json` the recommended setting - at
which point the recommendation itself would have caused it.

**Fixed** by creating the directory first. Now 5ms.

**Verified:** a unit test writes into a two-level-deep missing directory and asserts the
first write completes in under a second, which fails loudly if the ordering is ever reversed.

---

## 47. The retention default costs 117ms per heal - `Fixed` (0.4.3)

**Severity: Medium.** Finding 10 (0.4.0) bounded the records file, fixing unbounded growth.
It did not ask whether the bound was the right size. Measured:

| records | file size | recording cost per heal |
|--------:|----------:|------------------------:|
|     100 |   0.08 MB |                  5.3 ms |
|   1,000 |   0.75 MB |                 14.1 ms |
|   5,000 |   3.75 MB |                105.6 ms |
|  10,000 |   7.50 MB |                116.7 ms |

The file is read, merged, deduplicated and rewritten on every heal, **synchronously, inside
the heal**. At the shipped default of 10,000 that is 117ms of blocking work per heal, or
about six seconds across a fifty-heal suite - spent maintaining history nobody reads.

**Fixed** by lowering the default to **1,000**: an eighth of the cost, and still far more
history than anyone looks at (this repo's entire demo produces about a dozen records per
run). The measured table is now in the constant's docstring, so the next person to raise it
can see what they are buying.

**Verified:** a unit test asserts the default is 1,000 rather than 10,000, so it cannot drift
back up unnoticed.

---

## 48. Records cannot be switched off, and `0` means unlimited - `Fixed` (0.4.3)

**Severity: Medium.** There was no way to stop the file being written. `HEALING_RECORDS_PATH`
moves it; nothing disables it.

Worse, the one value a user would *try* means the opposite of what they intend:
`HEALER_RECORDS_MAX=0` is documented as "keeps everything" - unlimited. Someone reaching for
an off switch would find the setting that removes the cap entirely.

**Fixed** with `HEALER_RECORDS=false`, a separate setting. Overloading `0` was the obvious
shortcut and was rejected: `0` already means unlimited, it is documented that way, and
reinterpreting it would silently stop recording for anyone who had set it deliberately. Two
settings that each mean one thing beat one that means two.

The switch is gated at `persistToFile` - the single place that touches the disk - so no file
and no lock file appear, while the in-memory list and `getStatistics()` still work for
anything reading them inside the worker. Loading is skipped too: parsing a multi-megabyte
file to populate history that will never be written back is pure cost.

`HealingOptions` gained `records` and `recordsMax` alongside `recordsPath`, which previously
had no programmatic equivalents - so all three are now settable from code as well as from the
environment.

**Verified:** 8 new unit tests and 4 end-to-end tests in `tests/env-options.spec.ts`,
including that `HEALER_RECORDS_MAX=0` still means unlimited, that a heal is still annotated,
attached and gated when records are off, and that a per-instance override lets a reporting
script read a file the environment has switched off.

---

## 50. The documented CI setting disables the package - `Fixed` (0.4.4)

**Severity: Critical.** The one production setting this package tells everyone to use.

`.env.example` carried, under the heading *"Recommended for CI"*:

```
#   HEALER_FAIL_ON_HEAL=${CI}
```

`dotenv` does **not** expand `${VAR}` - that is `dotenv-expand`, a separate package this one
does not depend on. So the value is the literal five characters `${CI}`:

```
getConfig() THREW: HEALER_FAIL_ON_HEAL must be one of 1, true, yes, on, 0, false, no, off (got "${CI}").
isFailOnHeal() THREW: (the same)
```

`getConfig()` throwing means `initializeHealingEngine()` catches, caches `null`, and healing
is **off for the entire run**. Following the documented recommendation for the flagship CI
feature turns the whole package into a no-op, reported only as `heal-unavailable` - a message
about a missing credential, which is where anyone would then go looking.

The same string was printed by `check:setup` as its recommendation, so the free pre-flight
tool actively taught the broken form. README's copy sat in a `bash` fence where `${CI}` does
expand and is correct, but the comment beside it - *"so it is on there and off locally"* -
describes a persistent setting, i.e. `.env`.

**Fixed** by saying where the setting belongs. `.env` is for a developer's machine; CI
should set the variable in the CI environment, and `.env.example`, README and `check:setup`
now show GitHub Actions, GitLab and shell forms and state plainly that dotenv does not
expand `${VAR}`.

**How four audits missed it:** every earlier pass read the code and asked whether it was
correct. None copied `.env.example` to `.env` and ran it. The defect is not in any source
file - it is in the one file whose entire purpose is to be copied.

---

## 51. The CI gate disarms silently when it cannot read its setting - `Fixed` (0.4.4)

**Severity: High.** The second half of finding 50, and independently reachable.

`assertNoHeals` caught a malformed `HEALER_FAIL_ON_HEAL` and returned, on the recorded
reasoning that *"a malformed value is reported by `getConfig()` elsewhere; it must not turn
into a mysterious failure here."* Measured:

```
assertNoHeals with a malformed value:
  threw   : false
  said    : (nothing at all)
```

`getConfig()` does report it - as **"healing is unavailable"**, a sentence about something
else. Nothing anywhere said the CI gate had disarmed. A safety control that switches itself
off in silence is the wrong failure mode, and it is the opposite of the rule this package
applies to the privacy gate, which fails *closed*.

**Fixed** by saying so: once per worker, at `error` level, naming the variable, the value and
the number of heals that will not fail the run. Deliberately still does **not** throw -
failing a whole suite over one bad value would break the rule that healing can never take a
suite down - but it is now impossible to miss. `error` level also means it survives
`LOG_LEVEL=error` and is unaffected by `HEALING_LOGS=false`.

---

## 52. A second page in one test discards the gate's earlier heals - `Fixed` (0.4.4)

**Severity: High.** `healsThisTest` was reset on every **decoration**, with the comment *"One
decoration per test, so this is the reset point."* That assumption is false for any test that
touches more than one page: a popup, a second tab, an OAuth window, a print preview, a
downloaded-file viewer.

The second `attachHealing` threw away every heal from the first page. Measured with two
distinct stale selectors across two pages:

```
CI gate reported 1 of 2 heals
```

Silent, and only in tests that span pages - so a suite would under-report exactly where a
journey is most complex. Some heals escaped the gate entirely.

**Fixed** by resetting when the **test** changes rather than when a page is decorated,
keyed on `testId#retry`. A retry is a different attempt and correctly starts clean; a
second page continues the same collection.

`TestInfo` object identity was rejected as the key for the reason the original comment gave -
two references diverging would silently reset - and a string key cannot fail that way.

**Verified:** three cases - two heals on one page, one heal on each of two pages, and no
leakage into the following test. Note the gate still reports **one edit per distinct
rewrite**: healing the same selector on both pages is correctly one line, which is what made
the first attempt at this test read as a failure when it was not.

---

## 53. Playwright `retries` multiplies the cost of a gated run - `Fixed` (0.4.4)

**Severity: Low**, documentation.

`HEALER_FAIL_ON_HEAL` makes a healed test **fail**. With `retries: 2` - the shape most CI
configurations use - Playwright re-runs it twice more. Each attempt starts on a fresh worker
with a cold cache, so it heals again and pays again: **three times the provider spend for a
run that is designed to fail.**

Both halves were documented separately and the interaction was not. README already noted that
the gate largely defeats the cache, for exactly this reason, without drawing the conclusion
about cost.

**Fixed** in README's CI section: use `retries: 0` alongside the gate, or accept the
multiplication knowingly.

---

## Verified sound in this pass

- **Cross-browser.** The full option suite passes on **Firefox** (38/38) as well as Chromium,
  so `ariaSnapshot` capture, redaction, healing and the report surfaces are genuinely
  browser-independent rather than asserted to be. This also validates finding 43's fix end to
  end, since `BROWSER=firefox` had no effect before it.
- **Timeouts.** `INTEGRATION.md` already carries the arithmetic
  (`actionTimeout + HEALER_MAX_RETRIES x HEALER_TIMEOUT`), names the 79-second worst case
  against a 30-second default test timeout, and gives both remedies. Documentation was ahead
  of this audit.
- **Concurrent heals in one test.** `collected` is per-call and the budget, breaker and cache
  are per-worker, so two actions healing at once neither interleave records nor double-count.
