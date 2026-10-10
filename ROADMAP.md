# Roadmap — the four remaining items from the architecture review

> **Internal document, deliberately not shipped.** `files` in `package.json` is an explicit
> allowlist, so this stays out of the tarball, like `AUDIT.md` and
> `DESIGN-chained-locators.md`. Nothing under `src/` may reference it.

**Status: proposed. No code written for any item.**

## Where things stand

The architecture review's "Now" and "Next" rows are done and measured. Prompt caching,
fail-fast on configuration errors, pinned temperature and model, the shorter prompt when
candidates are listed, and cache sharing across workers with single-flight are all in the
CHANGELOG. So is the follow-up work those measurements led to: rename rules, intent-check
fixes, and icon buttons by test id. On the 25-case corpus against `claude-haiku-4-5`, the
healer scores **25/25 on three consecutive runs, with 0 wrong elements**.

What remains is structural. Every miss or coin flip in this session's measurements came
from one limitation: **the healer knows nothing about what an element looked like when it
last worked.** Item 1 removes that limitation, and items 2 and 3 are much cheaper to build
once it exists.

| # | Item | Effort | Depends on |
|---|---|---|---|
| 1 | Remember the element when it works; match against that first | ~1 week | — |
| 2 | Separate modes: heal locally, record-then-repair in CI | 1–2 weeks | benefits from 1 |
| 3 | Cheap model first, strong model only when unsure | 1–2 days | best after 1 |
| 4 | Selector registry for page objects | design decision, then ~1 week | — |

---

## 1. Remember the element when it works; match against that first

### The problem

When a selector fails, the healer has two inputs: the selector string and the page as it
is *now*. It has no record of the element as it was *before*. Everything below follows
from that:

- **Ambiguous renames cannot be decided.** "Charter Cloud" disappeared, and the menu now
  holds "Private Cloud" and "Dedicated Cloud". No model can tell which one it became from
  the current page alone, so the only safe answer is a refusal. A record saying "it was
  the first item in the top-right menu" decides it.
- **The model rebuilds information that could have been recorded.** Every heal pays a
  provider call, 3–7 s and some tokens to reconstruct an intent that was visible for free
  on every earlier passing run.
- **Results vary between runs.** Even at `temperature: 0`, the corpus varied by one case
  in 21 between runs. A deterministic match does not vary.

### The design

**On every successful action**, store a small local fingerprint of the element that was
acted on:

| Field | Example | Why |
|---|---|---|
| role | `link` | Survives restyling |
| accessible name | `Charter Cloud` | The main identity signal |
| test id, `id`, `name` | `nav-charter` | Often survives a rename |
| text | `Charter Cloud` | For elements named by content |
| landmark path | `banner > navigation "Main"` | Where it lives on the page |
| position among siblings | 1st of 3 in its list | **Decides ambiguous renames** |
| page route | `/home` | Scopes the fingerprint |

The key is the original selector plus the page route. The value is overwritten on each
success, so it always describes the latest working state.

**On failure**, before any provider call:

1. Score every candidate on the current page against the fingerprint: same role, same
   test id, same landmark, same position, name similarity.
2. **One clear winner** (score above a threshold, clear margin over the runner-up):
   heal with it deterministically. It goes through the same validation and intent gates
   as any heal, is recorded as provider `fingerprint`, and makes no network call.
3. **No clear winner:** call the model as today, **with the fingerprint in the prompt**
   ("this element was previously link "Charter Cloud", 1st of 3 in navigation "Main"").
   That turns a guess into a comparison.

### Where the fingerprints live

- **Local runs:** a small file in the project's cache directory, e.g.
  `.healer/fingerprints.json`, git-ignored.
- **CI:** restored from the CI cache between runs of the same branch. Fingerprints are
  written only by **passing** actions, so a run of stale selectors cannot poison them.

### Why this does not "make rot free"

The package's rule is that a heal must never hide a stale selector. That still holds. A
fingerprint is **evidence, not an answer**: a fingerprint heal is still a heal. It is
annotated, written to the records file and the reporter's rewrite list, and counted by
`HEALER_FAIL_ON_HEAL`. What changes is the cost and reliability of finding the answer,
not whether anyone is told about it.

### Privacy

Fingerprints hold accessible names, which are page content. They stay on the machine. When
one is included in a prompt (step 3), it goes through `PrivacyGuard` like any other name,
including the custom redactor, and is withheld under `strict`.

### Done when

- The corpus gains "before" states for each case. Most cases heal **with no provider
  call**, and the two-successor Charter Cloud case heals correctly from position.
- 0 wrong elements over three runs, as for every change so far.
- Fingerprinting adds under 5 ms to a passing action. It is one ARIA read of an element
  that was just resolved, so this is achievable, and it must be measured.

### Risks

- **Stale fingerprints after a deliberate redesign.** Mitigation: store a timestamp,
  expire fingerprints after N days, and never let one override a unique exact match by
  name.
- **Cost on passing actions.** Mitigation: fingerprint lazily (only the first success per
  selector per run), measured before it ships.

---

## 2. Separate modes: heal locally, record-then-repair in CI

### The problem

In CI, with `HEALER_FAIL_ON_HEAL=true` (the recommended setting), a heal cannot make the
build pass. Its only value there is the list of stale selectors. Producing that list
live costs, **per stale selector, per test**:

- the full action timeout, waiting for an element that will never appear (5 s by default);
- then a snapshot, a provider call (3–7 s measured) and validation.

So about 10–15 s of wall-clock per occurrence, spent inside the test run, to produce a
report.

### The design

| Mode | When | What happens |
|---|---|---|
| **heal** (today) | local development | Heal during the run so the developer keeps working |
| **record** (new) | CI | During the run, **only capture**: the failing selector, action, description, snapshot and fingerprint. No provider call. The test fails at once with a clear annotation |
| **repair** (new) | after the CI run, one command | Read everything recorded, **remove duplicates by selector**, heal each once, with no timeout pressure and optionally a stronger model, then write one change set: a patch file or a PR |

Selected by `HEALER_MODE=heal|record` with `repair` as a separate script
(`npx self-healing-playwright repair`). The default is unchanged.

### Why it is worth it

- **CI time:** the provider call leaves the test run entirely.
- **Cost:** deduplication is built in. A selector used by 40 tests is healed once, not up
  to 40 times, and not just once per run as today with the shared cache.
- **Quality:** repair has the page, the fingerprint, and all the occurrences of the same
  selector across pages. That is more evidence than any single live heal has.
- **Governance:** the output is a reviewable change set, which is what the reporter's
  rewrite list already approximates.

### Done when

- A CI run in `record` mode makes **zero** provider calls and adds under 1 s per stale
  selector.
- `repair` on the demo produces a correct patch for all 7 stale selectors with 7 calls.
- Pages that need live state (auth, dynamic data) are handled: repair replays the
  recorded snapshot, so it does not need the app running. Heals that need to validate
  against a live page are marked for confirmation on the next run.

### Risks

- **Validation needs a live page.** A recorded snapshot can be re-parsed, but uniqueness
  and visibility are live properties. Mitigation: repair proposes; the next CI run in
  `record` mode confirms (the selector either resolves or is recorded again).
- **Two code paths to maintain.** Mitigation: record and repair reuse the engine's steps;
  only where the provider call happens changes.

---

## 3. Cheap model first, strong model only when unsure

### The problem

One model handles every heal. Most heals are easy (a renamed button in a short list), and
a few need judgment.

### The design

1. Fingerprint match (item 1). No model.
2. The cheap model (the default, `claude-haiku-4-5`).
3. **Escalate to a stronger model** only when the cheap answer is below the confidence
   threshold, or rejected by a gate, *and* the page offered candidates, so there was
   something to decide. Configured with `HEALER_ESCALATION_MODEL`, off by default.

### Why after item 1

Item 1 removes most of the easy heals from the model path entirely. Measured after
that, escalation applies to the remaining hard cases. Measured before it, the numbers
would describe a traffic mix that is about to change.

### Done when

- On the corpus, escalation turns at least one refusal into a correct heal, or it is
  dropped. It is not worth shipping for zero gain.
- 0 wrong elements over three runs, **including every must-refuse case**. A stronger model
  must not make the healer more willing to guess.
- Cost per run reported both ways, with and without escalation.

### Risks

- **A stronger model can be more confident and more wrong.** Mitigation: the same gates
  apply, and the must-refuse cases are the acceptance test.

---

## 4. Selector registry for page objects

### The problem

Healing works by intercepting Playwright's `Page` and `Locator` methods. That needs no
adoption, which is its strength, and it is also the part most exposed to Playwright
upgrades: it depends on how Playwright lays out its prototypes. It also means coverage is
added one method at a time, which is why chained locators
(`page.locator('#a').locator('#b')`, `.filter()`) do not heal today. See
`DESIGN-chained-locators.md` for the in-place fix for that gap.

### The design

An optional registry that page objects declare their locators through:

```ts
const checkout = defineLocators(page, {
  placeOrder: { selector: '#place-order-btn', describe: 'the button that submits the order' },
  promoCode:  { selector: '#promo-field',     describe: 'the promo code field' },
});

await checkout.placeOrder.click();
```

- Each locator has a **stable name** (`checkout.placeOrder`), which becomes the key for
  fingerprints (item 1) and repairs (item 2) instead of a raw selector string.
- The description lives next to the selector, so every heal has intent evidence. Today
  that is optional and often missing.
- Repairs (item 2) edit **one line** in one file, not every test that repeats a selector.
- The interception path stays as the zero-adoption route. The registry is opt-in.

### Why now is the right time

The team is migrating from Selenium, and page objects are being written anyway. Adopting a
registry during that migration costs almost nothing extra. Retrofitting it later touches
every page object.

### Decision needed

This is a team convention as much as code, so it needs agreement before building:

- Adopt it for newly migrated page objects only, or across the board?
- Should the registry be the key for fingerprints from the start, which makes item 1
  simpler? The alternative keys them by selector string and migrates later.

### Done when

- The demo's page objects use the registry, with no change to test code.
- Chained and filtered locators declared in the registry heal. The registry resolves them
  itself, so it does not depend on per-method interception.
- A Playwright upgrade that breaks interception does not break registry-based healing.

---

## Suggested order

1. **Item 4, the decision only** (a short meeting). It decides how items 1 and 2 are
   keyed.
2. **Item 1.** It has the largest effect, and every later item gets cheaper once it exists.
3. **Item 2**, once CI heal latency matters, which is roughly when the suite exceeds a few
   hundred tests.
4. **Item 3**, measured after item 1, and shipped only if it earns its place.

Every item is held to the bar used throughout this work: measured on the real-model
corpus over three runs, **0 wrong elements**, no case worse, and full CI green twice.
