# Self-Healing Playwright

**Author:** Vineel Bisu · **Version:** 0.4.4 · **Released:** August 2026

---

## The Problem

Every time a UI is redesigned, automated test suites break — not because the application is broken, but because the CSS selectors that tests use to find buttons, fields, and links go stale.

A single redesign can invalidate dozens of selectors across hundreds of tests. CI turns red. Engineers stop feature work to manually hunt down each broken selector, figure out what it should be, and update it. This can take hours to days per release cycle.

**This is a pure maintenance tax.** It does not catch bugs. It does not improve quality. It just costs time — every time the UI changes.

---

## What We Built

`self-healing-playwright` is an AI-powered layer that sits on top of existing Playwright test suites. When a test action fails because a selector has gone stale, the framework:

1. Captures an accessibility snapshot of the live page
2. Asks an AI model to suggest a replacement selector
3. Validates and intent-checks the suggestion against the real DOM
4. Retries the action with the new selector — transparently, mid-test
5. Records every heal with the old selector, new selector, confidence score, and element details — ready for permanent source-code fixes

**If healing fails**, the original Playwright error is re-thrown unchanged. The framework never silently passes a test it should not. Nothing is hidden.

### Key Results (Real Data)

| Metric | Value |
|---|---|
| Total heals recorded | 154 |
| Successful heals | 119 — **77.3% success rate** |
| Cost per heal | ~$0.00115 |
| Full run cost (7 stale selectors) | ~$0.008 |
| Repeat-run savings (selector cache) | ~46% fewer AI calls |
| Unit tests in the framework itself | 392 |

A stale selector that previously cost **15–30 minutes of engineer time** now costs **$0.00115** and zero human intervention.

### CI Gate — Healing Without Hiding Problems

When `HEALER_FAIL_ON_HEAL=true` is set, a test that needed healing is marked as failing at teardown — even though it ran successfully. The error message includes the complete rewrite list so the technical debt is surfaced, tracked, and cannot be ignored.

This means: the release is not blocked by stale selectors, and the stale selectors are not silently forgotten.

---

## Scope

> **This solution is scoped exclusively to Playwright test suites written in TypeScript or JavaScript.**

| In scope | Out of scope |
|---|---|
| Playwright + TypeScript | Cypress, WebdriverIO, Selenium, or any non-Playwright framework |
| Playwright + JavaScript | Python, Java, C#, or other language bindings |
| Node.js ≥ 18 environments | Browser automation outside of Playwright |
| Any AI provider: Claude, OpenAI, Gemini, or local Ollama | Non-Playwright test infrastructure |

**Adoption requires no test rewrites.** Teams change one import line:

```ts
// Before
import { test, expect } from '@playwright/test';

// After
import { test, expect } from 'self-healing-playwright';
```

All existing tests work as-is. The framework installs from a `.tgz` tarball with a single runtime dependency (`dotenv`) — no npm registry access required.

---

## How It Works — One Paragraph

The framework decorates Playwright's page object so that all 16 action methods (`click`, `fill`, `hover`, etc.) are wrapped. When an action throws a locator error, a `HealingEngine` captures the page's ARIA accessibility tree, sends it to a configured AI provider (Claude, OpenAI, Gemini, or a local Ollama model), and runs the suggestion through a four-layer safety check before trusting it. If healing succeeds, the action retries silently. If healing fails, the original Playwright error is re-thrown unchanged — the framework never silently passes a test it should not.

---

## Privacy and Safety

The framework was built with enterprise environments in mind.

- **Redaction by default** — emails, card numbers, SSNs, GUIDs, IPs, and similar identifiers are stripped from every page snapshot before any data leaves the machine.
- **Origin allowlist** — glob-pattern rules restrict which URLs the healer is permitted to read. Pages outside the list are never touched.
- **Privacy preview mode** — writes the exact payload that *would* be sent, without making any provider call. Compliance teams can audit it with no API key.
- **Local model option** — Ollama (self-hosted) can be configured as the AI provider. No data leaves the internal network.

---

## Cost Model

The default AI model is `claude-haiku-4-5` (Anthropic's fast, low-cost tier).

| Scenario | Estimated cost |
|---|---|
| Single stale selector healed | ~$0.00115 |
| 7 selectors across a demo suite | ~$0.008 |
| 100 heals in a large suite | ~$0.115 |
| 1,000 heals in a very large suite | ~$1.15 |

The selector cache cuts provider calls by ~46% on subsequent runs of the same suite. At these numbers, the AI cost is negligible against the engineering time saved by not manually tracking down and fixing selectors after each release.

---

## Reporting

Every healing run produces output on four surfaces:

1. **Playwright HTML report** — per-test annotations (`healed`, `heal-failed`, `heal-blocked`)
2. **JSON attachments** — per-heal detail: confidence, reasoning, intent check, token counts
3. **Trace timeline** — heal time attributed correctly in the Playwright trace viewer
4. **Run summary** — healed/failed/blocked counts, token totals, complete old→new selector rewrite list

---

## Roadmap

**v0.5.0 — Chained Locator Healing** *(design complete, awaiting approval)*

The one remaining coverage gap is chained locators like `page.locator('#table').locator('.row')`. When the outer locator is healthy but the inner is stale, the current version cannot heal it. The v0.5.0 design walks the chain, scopes the snapshot to the intact prefix, and heals only the broken suffix. This is expected to significantly improve accuracy on data tables and repeated-element patterns.


