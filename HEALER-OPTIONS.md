# Healer Options Reference

Every option is set via environment variable (`.env` or shell) unless marked **code only**.  
Options flow through the healing loop in this order: enabled → URL guard → cache → budget → snapshot → redact → provider call → confidence → DOM validation → intent check → record.

---

## 1. Master switch

### `HEALER_ENABLED` (default: `true`)

Turns the entire healer on or off. When `false`, every failing locator re-throws immediately — no AI call, no cache lookup, no overhead.

**When to use:** Disable in environments where you never want healing (e.g. a nightly regression suite whose failures should always be hard failures, or a machine without a network route to any AI provider).

```env
HEALER_ENABLED=false
```

---

## 2. Provider and model

### `HEALER_PROVIDER` (default: `anthropic`)

Selects which AI backend produces selector suggestions. Accepted values: `anthropic`, `openai`, `gemini`, `ollama`.

**When to use:**
- `anthropic` — default; best accuracy on DOM reasoning.
- `openai` — when your org already has an OpenAI contract or Azure OpenAI endpoint.
- `gemini` — when you need Google's quota tier or are on GCP.
- `ollama` — **accepted by the config but not implemented.** Selecting it switches healing off for the run with an error saying so. For an on-prem model, see the [air-gapped recipe](#common-recipes).

```env
HEALER_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o          # override the default gpt-4o if needed
# Azure OpenAI: point the base URL at the deployment and set the API version,
# which is appended as ?api-version= on every call.
OPENAI_BASE_URL=https://my-azure-endpoint/openai/deployments/gpt-4o
OPENAI_API_VERSION=2025-01-01-preview
```

### Provider credentials

| Provider | Key var | Model var | Base URL var |
|----------|---------|-----------|--------------|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`) | `ANTHROPIC_BASE_URL` |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` (default `gpt-4o`) | `OPENAI_BASE_URL` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` (default `gemini-2.0-flash`) | `GEMINI_BASE_URL` |
| Ollama (not implemented) | — | `OLLAMA_MODEL` (default `llama3.1`) | `OLLAMA_URL` (default `http://localhost:11434`) |

**When to change the model:** Switch to a larger model (e.g. `ANTHROPIC_MODEL=claude-opus-5-5`) when healing fails on complex, deeply-nested UIs; switch to a smaller one to cut cost on high-volume CI runs.

---

## 3. Quality controls

### `HEALER_THRESHOLD` (default: `0.7`)

The minimum confidence score (0–1) the model must report before a suggestion is accepted. Suggestions below this score are discarded and the next retry attempt begins.

**When to use:**
- Raise to `0.85` or higher when false positives are costly (e.g. financial or healthcare workflows where clicking the wrong element causes real damage).
- Lower to `0.5` on stable internal apps with simple, non-ambiguous DOM structures to accept more suggestions and reduce retry noise.

```env
HEALER_THRESHOLD=0.85
```

### `HEALER_MAX_RETRIES` (default: `2`)

How many separate AI calls to attempt before giving up and re-throwing the original error. Each attempt sends a fresh prompt; the engine feeds the previous failure reason into the next prompt. At least one call is always made while healing is on, so `0` behaves as `1`.

**When to use:**
- Set to `1` to keep CI fast and costs low when your selectors are mostly stable and a single attempt is usually enough.
- Raise to `3` or `4` on apps with highly dynamic or framework-generated class names where the first attempt often misses but the second succeeds after the failure feedback is included.

```env
HEALER_MAX_RETRIES=3
```

### `HEALER_TIMEOUT` (default: `30000` ms)

Hard deadline (in milliseconds) for a single provider call. If the call does not return within this window it is cancelled and counted as a failure.

A call is also capped at the time left before the **test's** own timeout, keeping 2 s back for the retried action. With less than 3 s left, no call is started and the heal is reported as `heal-skipped`. The test then fails with the Playwright error naming the stale selector, instead of `Test timeout exceeded`. A call cut short by the test's timeout does not count toward the circuit breaker.

**Healing needs Playwright's `actionTimeout`.** Healing starts only after an action fails. Playwright's default `actionTimeout` is `0`, which means an action waits for the whole test timeout, so no heal ever runs. Set `use: { actionTimeout: 5_000 }` (or similar) in `playwright.config`. The healer warns once per worker when it is unset.

**When to use:**
- Lower (e.g. `10000`) in latency-sensitive pipelines where you'd rather fail fast than wait 30 s on an overloaded API.
- Raise (e.g. `60000`) when using a slow on-prem Ollama instance on a large model.

```env
HEALER_TIMEOUT=15000
```

---

## 4. Cache

### `HEALER_CACHE` (default: `true`)

Remembers selectors that healed, so the same stale selector is paid for once rather than once per test. Every reused selector is re-validated and re-intent-checked against the live page, and is still reported as a heal (`via cache`), so the CI gate and the reporter see it.

- **Within a worker:** after the first heal of a selector, later uses of it skip the stale original's action timeout. The original gets a quarter-second check, and if it is still stale the cached replacement is used directly.
- **Across workers of one run:** heals are shared, and a worker that meets a selector another worker is already healing waits for that answer instead of making its own call.
- **Never across runs:** the shared store is deleted when the run ends, so rot is never made permanently free.

**When to use:**
- Leave `true` in almost all cases — it cuts cost and latency significantly on tests that visit the same page multiple times.
- Set to `false` only when debugging the healer itself, or when you suspect a stale cache is returning an outdated selector.

```env
HEALER_CACHE=false
```

---

## 5. Budget and circuit breaker

### `HEALER_MAX_HEALS` (default: `100`)

Maximum number of provider-backed heals **per worker**. The effective ceiling for a run is this value × your `workers` setting. It counts heals, not calls: one heal that retries three times is charged once. Cache reuses are free and still work once the ceiling is reached. Past the ceiling, a heal that would need the provider is reported as `heal-skipped` and the original error is re-thrown.

**`0` means no ceiling**, not "no healing". To turn healing off, use `HEALER_ENABLED=false`. To see what would be sent without sending anything, use `HEALER_PRIVACY_PREVIEW`.

**When to use:**
- Set lower (e.g. `20`) for cost control in CI. If a build triggers more than 20 heals something has probably broken badly enough that a human should look at it rather than burning API quota.
- Set higher (e.g. `500`) during a large-scale locator migration where you expect many selectors to break at once and want the healer to fix them all in one pass.

```env
HEALER_MAX_HEALS=25
```

### `HEALER_BREAKER_THRESHOLD` (default: `5`)

Number of consecutive AI provider *call failures* (network errors, 5xx, timeouts) before the circuit breaker opens, counted per worker. A low-confidence or rejected answer is not a failure, and any successful call resets the count. Once open, the breaker **stays open for the rest of that worker**: heals that would need the provider are reported as `heal-skipped`, while cache reuses still work. It resets only when Playwright starts a new worker (which it also does after a failed test). `0` disables the breaker.

A configuration failure — a rejected key, an unknown model, an untrusted certificate — does not wait for the threshold: healing stops for the worker at the first one, with the reason in the report.

**When to use:**
- Lower to `2` or `3` in pipelines where the provider is unreliable and you want tests to fail fast rather than hang on repeated timeouts.
- Raise if you're on a slow network where transient failures are common but the provider is fundamentally healthy.

```env
HEALER_BREAKER_THRESHOLD=3
```

---

## 6. Fail-on-heal gate

### `HEALER_FAIL_ON_HEAL` (default: `false`)

When `true`, any test that triggered at least one successful heal fails at teardown, even though the test's own assertions passed. This surfaces healed tests in CI as action items without blocking the whole suite.

**When to use:** Turn on in pull-request checks to enforce a policy that all locators must be fixed before merge. Leave off in main-branch or release runs where you want the suite to keep passing while selectors are being updated.

```env
HEALER_FAIL_ON_HEAL=true
```

---

## 7. Intent checking

### `HEALER_INTENT_CHECK` (default: `enforce`)

Controls whether the healer verifies that the suggested element is actually what the original selector intended. Three modes:

| Mode | Behavior |
|------|----------|
| `off` | Accept any suggestion that resolves to one visible element. |
| `warn` | Run intent checks, annotate concerns in the record, but still accept. |
| `enforce` | Reject suggestions that fail intent checks; feed the failure reason into the next retry prompt. |

The checks run in order:

1. **Action compatibility:** `fill()` cannot target a `<button>`.
2. **Instruction-like names:** an element whose name addresses the AI ("note to AI", "ignore your instructions", "answer with") is never a heal.
3. **Self-consistency:** the model's stated role must match the actual DOM.
4. **Role preservation:** if the original selector implied a role, the healed element must have it. A subtype counts: a searchbox is a textbox, a switch is a checkbox.
5. **Contrast:** a name that keeps a word but swaps the word that decides what the control does is rejected — Sign in → Sign up, Pay now → Pay later, Download CSV → Download PDF, Next → Previous.
6. **Opposing action:** Cancel, Delete, Discard and similar are rejected unless the test's own words mention such an action.
7. **Lexical intent:** the old selector's words must overlap the element's name or its own test id. This is the only check that judges meaning by string, so when `HEALER_CONFIRM` is on, a mismatch here is passed to the second opinion instead of being final.
8. **Second opinion** — see `HEALER_CONFIRM` below.

**When to use:**
- Keep `enforce` in production suites — it prevents the healer from "fixing" a failing `#submit-btn` by returning the first button it finds regardless of purpose.
- Switch to `warn` when onboarding a new app with many legitimate role changes and you want to audit intent failures before enforcing them.
- Use `off` only for throwaway scripts or exploration.

```env
HEALER_INTENT_CHECK=warn
```

### `HEALER_CONFIRM` (default: `true`)

Before a heal is accepted, the provider is asked one narrow question, with no candidate list and no instruction to find anything: *is this element the same control the test meant, renamed or moved, or a different one?* The heal is accepted only on a clear "same". An error, a timeout or an unreadable reply all count as "no".

It exists because the model that picks an element is asked to *find* one, and leans towards finding one. On held-out audit sets it healed Edit profile → Edit password, Transfer $100 → Transfer $1,000 and Close dialog → Close account; each of those passed every deterministic check above.

The question is redacted exactly like the heal itself. It is skipped when the element only moved and kept its text. It is asked at most 3 times per heal. Measured with `claude-haiku-4-5` picking and `claude-sonnet-5` confirming, a successful heal averages about 2,350 tokens and 7.4 s. When the question is skipped, it is about 1,550 tokens and 4.6 s. Under `HEALER_REDACT=strict`, names of non-actionable elements and test ids are withheld, so the second opinion has less to go on and refuses more often.

**When to use:** keep it on. Turn it off only to save a call per heal on a suite where you accept a higher risk of a heal landing on a lookalike. Custom providers that implement only `heal()` skip it automatically.

```env
HEALER_CONFIRM=true
```

### `HEALER_CONFIRM_MODEL` (default: `claude-sonnet-5` on Anthropic, otherwise the healing model)

The model asked the second-opinion question. Picking an element is a high-volume, low-stakes step, so a cheap model does it well. The accept-or-reject decision is a single short question with high stakes, so it gets a stronger model.

Measured on 28 audit questions, each a real rename or a lookalike trap shown with the controls beside it:

| Model | Right | Accepted a trap | Refused a real rename | Per question |
|---|---|---|---|---|
| `claude-haiku-4-5` | 20/28 | 0 | 8 (incl. Charter Cloud → Private Cloud) | ~700 tokens, 3.1 s |
| `claude-sonnet-5` | 28/28 | 0 | 0 | ~900 tokens, 3.1 s |

On OpenAI and Gemini nothing equivalent was measured, so the default is the healing model rather than a model you may not have access to. Set a stronger one explicitly.

```env
HEALER_CONFIRM_MODEL=claude-sonnet-5
```

### `HEALER_UNVERIFIED_CONFIDENCE` (default: `0.9`)

When no intent check can find signal (e.g. an opaque selector like `.c_x4a7` with no `describe()` annotation), the suggestion must clear this higher confidence floor rather than the base `HEALER_THRESHOLD`.

**When to use:** Raise toward `1.0` for maximum conservatism in unannoted codebases. Lower only if you find legitimate heals being rejected on opaque selectors and you've confirmed intent-checking is otherwise working.

```env
HEALER_UNVERIFIED_CONFIDENCE=0.95
```

---

## 8. Privacy and data safety

### `HEALER_REDACT` (default: `identifiers`)

Controls what is stripped from ARIA snapshots before they leave the machine.

| Level | What is removed |
|-------|----------------|
| `off` | Nothing — full snapshot sent as-is. |
| `identifiers` | Emails, card/SSN numbers, GUIDs, tokens, dates, postcodes, URL query strings. |
| `strict` | Everything in `identifiers` plus accessible names of non-actionable elements (labels, headings, static text). |

**When to use:**
- `identifiers` covers most regulated environments (PII, PCI).
- `strict` for healthcare or financial apps where even element labels might contain PHI or account numbers.
- `off` only in local development on a mock/demo app when you want the model to have maximum context.

```env
HEALER_REDACT=strict
```

### `HEALER_REDACT_PATTERNS_FILE` (no default)

Path to a JSON file containing additional regex patterns to redact. Patterns are appended after the built-in set. Each entry is either a plain string (`"SSN-\\d+"`) or an object with `pattern` and `flags` keys.

**When to use:** Add company-specific identifiers that built-in patterns don't cover (internal employee IDs, proprietary token formats, contract numbers).

```env
HEALER_REDACT_PATTERNS_FILE=./config/custom-redact-patterns.json
```

```json
[
  "EMP-\\d{6}",
  { "pattern": "CTRT-[A-Z0-9]{8}", "flags": "i" }
]
```

### `HEALER_SNAPSHOT_ROOT` (no default)

A CSS selector that scopes the ARIA snapshot to a specific container. The healer will only see elements inside this container, and will refuse to heal (fail closed) if the root selector doesn't resolve.

**When to use:** When your app renders sensitive data outside the component under test (e.g. a header with a user's full name or balance). Scope to the form or modal being tested to exclude everything else from the payload.

```env
HEALER_SNAPSHOT_ROOT=#main-content
```

### `HEALER_ALLOWED_ORIGINS` (no default)

Comma-separated list of origins (e.g. `https://staging.example.com,http://localhost:3000`). When set, healing is silently refused on any other origin.

**When to use:** Prevent the healer from firing on third-party iframes, payment pages, or environments you haven't explicitly approved for outbound AI calls.

```env
HEALER_ALLOWED_ORIGINS=http://localhost:3000,https://staging.internal.example.com
```

### `HEALER_BLOCKED_PATHS` (no default)

Comma-separated glob patterns for URL paths where healing is refused. Supports `*`, `**`, and `?`. Takes precedence over `HEALER_ALLOWED_ORIGINS`.

**When to use:** Block healing on specific sensitive routes (checkout, account settings, admin panels) even when the origin is otherwise allowed.

```env
HEALER_BLOCKED_PATHS=/checkout/**,/admin/**,/account/security
```

### `HEALER_PRIVACY_PREVIEW` (no default)

Directory path. When set, instead of calling the provider the healer writes the fully-redacted payload to a file in this directory and returns a null result (no heal). The test continues to fail.

**When to use:** Audit mode — inspect exactly what would be sent to the AI before enabling healing on a new app or after changing redaction settings. Run the suite once with this set, review the files, then remove it.

```env
HEALER_PRIVACY_PREVIEW=./heal-preview-payloads
```

---

## 9. Records

### `HEALER_RECORDS` (default: `true`)

Master switch for writing the `healing-records.json` file. Turning it off disables disk I/O while leaving annotations, test-report attachments, and the CI gate (`HEALER_FAIL_ON_HEAL`) intact.

**When to use:** Disable on ephemeral CI runners with read-only filesystems, or when the records file would be written to a network mount and the I/O overhead is noticeable.

```env
HEALER_RECORDS=false
```

### `HEALING_RECORDS_PATH` (default: `./healing-records.json`)

File path where the records are written.

**When to use:** Redirect to a shared volume in parallel CI so all workers write to the same file, or point to a location already included in your artifact upload step.

```env
HEALING_RECORDS_PATH=/artifacts/healing-records.json
```

### `HEALER_RECORDS_MAX` (default: `1000`)

Maximum number of records kept on disk. When the file exceeds this, the oldest entries are dropped. `0` means unlimited.

**When to use:** Lower (e.g. `200`) on long-running pipelines that re-run the same suite hundreds of times and where the records file would otherwise grow large. Raise or set to `0` when you need a full audit trail for compliance.

```env
HEALER_RECORDS_MAX=200
```

---

## 10. Logging

### `LOG_LEVEL` (default: `info`)

Controls framework-wide log verbosity. Values: `error`, `warn`, `info`, `debug`.

**When to use:** Set to `debug` while diagnosing a failing heal to see the full prompt, snapshot, and confidence score. Set to `error` in quiet CI environments.

```env
LOG_LEVEL=debug
```

### `HEALING_LOGS` (default: `true`)

When `false`, the healer no longer narrates each attempt ("Attempt 1/2 — trying healed selector…") in stdout. Errors and warnings always pass through regardless of this setting.

**When to use:** Disable in a mature suite where heals are expected and you don't want the output cluttered; keep enabled while diagnosing or onboarding so you can see exactly which selectors are healing and why.

```env
HEALING_LOGS=false
```

---

## 11. System

### `HEALER_SKIP_DOTENV` (default: unset)

When set to `1`, `true`, or `yes`, the healer skips loading `.env` entirely. All configuration must come from the shell environment.

**When to use:** CI systems that inject secrets as environment variables and where a `.env` file either doesn't exist or shouldn't override shell vars. Avoids accidental leaks if `.env` contains test credentials.

```env
HEALER_SKIP_DOTENV=1
```

---

## 12. Code-only options

These are passed to `createHealingFixtures()` or `HealingEngine` directly. They cannot be set via environment variables.

### `redactor` callback

```ts
createHealingFixtures(base, {
  redactor(snapshot: string): string | null {
    // Return null to veto the heal entirely (fails closed).
    // Return a modified string to apply custom redaction.
    if (snapshot.includes('INTERNAL_TOKEN')) return null;
    return snapshot.replace(/acct-\d+/g, 'acct-REDACTED');
  }
})
```

**When to use:** When built-in patterns and `HEALER_REDACT_PATTERNS_FILE` aren't expressive enough — e.g. when the veto logic depends on runtime state, not just regex patterns.

### `onOutcome` callback

```ts
createHealingFixtures(base, {
  onOutcome(outcome) {
    metrics.increment('heal.attempt', { success: outcome.healed });
    if (outcome.healed) {
      slackAlert(`Healed ${outcome.original} → ${outcome.healed} on ${outcome.url}`);
    }
  }
})
```

**When to use:** Push heal events to your own observability stack (Datadog, Grafana, Slack) without polling the records file.

---

## Common recipes

**Cost-controlled CI (PR checks)**
```env
HEALER_MAX_HEALS=20
HEALER_MAX_RETRIES=1
HEALER_TIMEOUT=15000
HEALER_FAIL_ON_HEAL=true
HEALER_RECORDS=true
HEALING_RECORDS_PATH=/artifacts/healing-records.json
```

**Maximum safety (production smoke tests on a regulated app)**
```env
HEALER_THRESHOLD=0.9
HEALER_INTENT_CHECK=enforce
HEALER_REDACT=strict
HEALER_SNAPSHOT_ROOT=#app-root
HEALER_BLOCKED_PATHS=/checkout/**,/admin/**
HEALER_ALLOWED_ORIGINS=https://app.example.com
HEALER_FAIL_ON_HEAL=true
```

**Local development / onboarding a new app**
```env
HEALER_INTENT_CHECK=warn
HEALER_REDACT=off
HEALER_PRIVACY_PREVIEW=./heal-preview-payloads
LOG_LEVEL=debug
HEALING_LOGS=true
```

**Air-gapped / on-prem**

`HEALER_PROVIDER=ollama` is not implemented. An on-prem server that speaks the OpenAI Chat Completions protocol — Ollama's `/v1` endpoint, vLLM, a gateway — can be reached through the `openai` provider instead. This package's own suite does not test that path, and small local models heal noticeably worse, so run the corpus against it before relying on it.
```env
HEALER_PROVIDER=openai
OPENAI_BASE_URL=http://ml-server.internal:11434/v1
OPENAI_MODEL=llama3.1
OPENAI_API_KEY=unused-by-ollama   # required by the config; Ollama ignores it
HEALER_TIMEOUT=60000
HEALER_ALLOWED_ORIGINS=http://localhost:4000
```
