# Design — healing chained locators (0.5.0)

> **Internal document, deliberately not shipped** — `files` in `package.json` is an explicit
> allowlist, so this stays out of the tarball like `AUDIT.md` and `AUDIT2.md`. Nothing under
> `src/` may reference it.

**Status: proposed, awaiting approval. No code written.**

Closes the largest remaining coverage gap, listed today in
[README § Limitations](README.md#limitations) and `ARCHITECTURE.md`:

> Chained locators (`page.locator('#a').locator('#b')`) and `.filter()` don't heal.

---

## 1. Why this is tractable

`Locator` exposes the **same builder surface** as `Page` and `FrameLocator`:

```
locator, getByTestId, getByAltText, getByLabel, getByPlaceholder, getByText,
getByTitle, getByRole, frameLocator, filter, contentFrame, describe,
first, last, nth, and, or
```

`decorateFrameLocator` already decorates that surface for frames, and
`SelectorValidator.LocatorRoot` already abstracts "a thing you can build a locator against".
The decoration half of this feature is reuse, not new design.

## 2. Why it is worth doing properly

Measured against a two-row table with three "Edit" buttons on the page:

```
page snapshot:      294 chars,  3 buttons named "Edit"
prefix subtree:     109 chars,  1 button named "Edit"
```

Healing `getByRole('row', { name: 'Smith, John' }).locator('#edit-btn')` from the **page**
snapshot asks the model to pick between three identical buttons with nothing to separate
them. Scoped to the row that still resolves, there is exactly one, and the answer is
forced rather than guessed.

So prefix-scoping is not an optimisation bolted onto the feature — it is what makes chain
healing *more* accurate than flat healing rather than less. It also cuts tokens and
narrows disclosure, which on a data table is the part that matters most.

---

## 3. The walk

The core idea: **find the deepest prefix that still resolves, and heal only what follows.**

```
getByRole('row', { name: 'Smith' }).locator('#edit-btn').first()
└──────────── prefix ─────────────┘└─ broken ─┘└ refinement ┘
```

### Algorithm

1. Parse the expression into an ordered list of **links**. Each link is one of:
   - a **descent** — `locator(...)`, `getBy*(...)`, `frameLocator(...)`, `contentFrame()`
   - a **modifier** — `filter(...)`, `and(...)`, `or(...)`
   - a **refinement** — `first()`, `last()`, `nth(n)`
2. If any link cannot be understood, **refuse the whole expression** (see §4).
3. Walk left to right, applying links to a live locator and counting matches after each:
   - `count === 1` → this prefix is intact, continue
   - `count === 0` → **this link is the break.** Stop.
   - `count > 1` → also a break: Playwright's strict mode would throw here anyway.
4. The **last intact locator** becomes the snapshot root. The links from the break onward
   are the **remainder** to heal.
5. If the *first* link already fails, there is no intact prefix — fall back to the page
   root, which is exactly today's behaviour for a flat selector.

Match counting is bounded by the existing `CACHE_PROBE_TIMEOUT_MS` (250ms) budget and the
page is already rendered by the time healing runs, so a walk of three links costs well
under a second.

### What the model is asked

The prompt changes in two places, both small:

- the snapshot is `intactPrefix.ariaSnapshot()` rather than the page's
- the request says *"this selector is relative to the structure below"* and carries only the
  remainder as `originalSelector`

The answer is then qualified back onto the prefix — the generalisation of
`qualifyWithFrames`, which does precisely this for `frameLocator` today. `PromptBuilder`
gains one optional line; the response contract is unchanged.

---

## 4. The refusal boundary — the part that matters most

Finding 21 (0.4.1) closed a bug where the parser read the first call in a chain and
**silently discarded the rest**, resolving a different element than the expression named.
This feature reopens that code path, so the boundary has to be explicit:

> **The walker either understands every link, or it refuses the whole expression.**
> There is no partial understanding, and no link is ever skipped.

`unsupportedSuffix()` and `unhonouredOptions()` are *not* relaxed. They are re-pointed at
individual links: a link with an option the walker cannot apply refuses the whole chain,
with the reason naming that link — which then feeds the retry prompt like any other
rejection.

**Order of work is part of the safety argument: the refusal tests are written and passing
before the walker resolves anything.**

### Understood

| Link | Argument | Note |
|---|---|---|
| `locator('css')` | string | |
| `getBy*(...)` | string / regex + `name`, `exact`, `level` | as today |
| `filter({ hasText })`, `filter({ hasNotText })` | string / regex | |
| `first()`, `last()`, `nth(n)` | — | already supported |
| `frameLocator('css')`, `contentFrame()` | string / — | reuses frame handling |

### Recoverable, though it looked impossible

`filter({ has: <Locator> })`, `and(<Locator>)`, `or(<Locator>)` take a live object with no
source form — the case rendered as `…` in finding 27.

But a locator built through the **decorated** page carries its own `_healerExpression`. So
`filter({ has: page.getByRole('button') })` can be rendered as
`filter({ has: getByRole('button') })` and parsed back recursively. Only a locator built
outside the decorated page stays opaque, which is rare in practice.

### Refused

- Any link whose argument is an opaque Locator (built outside the decorated page)
- `filter({ visible: true })` and any future option the walker does not model
- Anything the existing checks already refuse

---

## 5. Changes by module

| Module | Change | Size |
|---|---|---|
| `core/TestWrapper.ts` | `decorateLocatorBuilders()`, mirroring `decorateFrameLocator`. Render `has`/`and`/`or` from `_healerExpression`. | ~150 lines |
| `core/SelectorValidator.ts` | `parseChain()` → links; `walkChain()` → intact prefix + remainder; `resolve()` applies a whole chain. Re-point the two refusal helpers per link. | ~250 lines |
| `core/HealingEngine.ts` | Walk before snapshotting; scope capture to the intact prefix; qualify the answer back. Mirrors the existing frame branch. | ~60 lines |
| `utils/DOMSnapshot.ts` | `getAriaSnapshot` accepts a `Locator` root, not only a CSS string. | ~30 lines |
| `core/IntentVerifier.ts` | **`impliedRole` must read the LAST link, not the first.** Today it returns `row` for `getByRole('row').getByRole('button')`, which would reject every correct chain heal. | ~20 lines |
| `utils/PromptBuilder.ts` | One optional line stating the snapshot is a subtree. | ~10 lines |

`SelectorCache` needs no change — the key is the full expression string, which already
distinguishes chains. Records, annotations, the attachment and the CI gate all carry the
qualified expression and need no change either.

---

## 6. Test plan

Written in this order, refusals first.

**Refusal (before any resolution works)**
- every shape in §4's *Refused* list is rejected, and the reason names the offending link
- a chain with an unmodelled option refuses the *whole* chain, never a prefix of it
- the finding-21 corpus still refuses when the walker is disabled

**Walk**
- intact prefix found at depth 0, 1 and 2
- `count === 0` and `count > 1` both identified as the break, at each depth
- first-link failure falls back to the page root
- refinements mid-chain (`.nth(2).getByRole(...)`) walk correctly

**Scoping**
- the snapshot is the prefix subtree, asserted by size and content
- the three-Edit-buttons case: the model is shown one, not three
- a frame in the middle of a chain still scopes to the frame

**Round trip**
- decorate → expression → parse → walk → resolve yields the same element as the original
  live locator, for every understood shape
- the qualified answer is pasteable source

**Intent**
- `impliedRole` reads the last link
- a chain heal that changes the leaf role is rejected

**Demo**
- new page object using a chained locator with a deliberately stale leaf, so the demo suite
  exercises this end to end

Estimate: **~25 new unit tests**, taking the suite from 379 to roughly 405.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| **Reintroducing finding 21** — a walker that half-understands a chain resolves the wrong element | Refuse-or-understand rule; refusal tests written and passing first |
| Walk cost on a deep chain | Bounded probes at 250ms; page already rendered; realistic depth is 2–3 |
| `impliedRole` regression rejecting every chain heal | Explicitly listed above; caught by an intent test on a chain |
| Scope creep into `.and()`/`.or()` semantics | Those are *modifiers*, not descents — they narrow the current set rather than descending. Walk treats them as such or refuses. |
| Demo has no chains today, so nothing exercises it in a real run | New page object is part of the work, not a follow-up |

---

## 8. Staging

Each stage is independently shippable and leaves the package correct.

1. **Refusal re-pointed per link** — no behaviour change, refusals get better messages
2. **Decoration** — chains produce faithful expressions in records and the CI gate, still
   refused at resolution. Already an improvement: the gate stops printing a bare prefix.
3. **Walk and resolution** — chains resolve; snapshot still page-level
4. **Prefix scoping** — the accuracy and cost win
5. **Demo, docs, README limitation removed**

Stopping after 2 is a coherent release. Stopping after 3 is coherent. That is deliberate:
if the walker proves harder than estimated, there is a good place to stop.

**Estimate: 2–3 days for all five stages.** Ships as **0.5.0** — new capability, not a fix.

---

## 9. What stays out of scope

- **Assertions still never heal.** `expect(locator).toBeVisible()` is untouched by this and
  remains a deliberate non-goal: a healer that "fixes" a failing assertion hides a bug.
- **Read methods** (`textContent()`, `getAttribute()`, `count()`) still never heal.
- **Locators built outside the decorated page** used as `has`/`and`/`or` arguments stay
  opaque, and refuse.
