# Self-Healing Playwright: Leadership Briefing

**Project:** `self-healing-playwright`
**Author:** Vineel Bisu
**Version:** 0.4.4 — released August 2026
**Status:** Production-ready, enterprise controls in place

---

## The Problem

Every time our UI is redesigned, automated test suites break — not because the application is broken, but because the CSS selectors that tests use to find buttons, fields, and links go stale. A single redesign can invalidate dozens of selectors across hundreds of tests, grinding CI green to red and pulling engineers off feature work to manually hunt and fix each one.

This is a pure maintenance tax. It does not catch bugs. It costs time and morale on every release cycle.

---

## The Solution

`self-healing-playwright` is an AI-powered layer that sits on top of our existing Playwright test suite. When a test action fails because a selector has gone stale, the framework:

1. Captures an accessibility snapshot of the live page
2. Asks an AI model to suggest a replacement selector
3. Validates and intent-checks the suggestion against the real DOM
4. Retries the action with the new selector — transparently, mid-test
5. Records every heal for later review and permanent source-code fixes

**No test code changes are required.** Teams swap one import line and the framework takes over.

---

## Key Results (Measured)

| Metric | Value |
|---|---|
| Total heals recorded (to date) | 154 |
| Successful heals | 119 (77.3% success rate) |
| Average AI confidence score | 0.74 / 1.0 |
| Cost per heal | ~$0.00115 |
| Full demo run cost (7 selectors) | ~$0.008 |
| Cache savings on repeated runs | ~46% fewer AI calls |
| Unit tests in suite | 392 (no browser, no API key required) |

These numbers come from real accumulated data in the project's `healing-records.json` file, not projections.

---

## How It Works — One Paragraph

The framework decorates Playwright's page object so that all 16 action methods (`click`, `fill`, `hover`, etc.) are wrapped. When an action throws a locator error, a `HealingEngine` captures the page's ARIA accessibility tree, sends it to a configured AI provider (Claude, OpenAI, Gemini, or a local Ollama model), and runs the suggestion through a four-layer safety check before trusting it. If healing succeeds, the action retries silently. If healing fails, the original Playwright error is re-thrown unchanged — the framework never silently passes a test it should not.

---

## Safety and Privacy Controls

This was designed for enterprise environments where test suites run against environments containing real or realistic data.

| Control | What it does |
|---|---|
| **Redaction** | Strips emails, card numbers, SSNs, GUIDs, dates, IPs, IBANs, postcodes, and URL query strings from every snapshot before it leaves the machine (default). A "strict" mode additionally collapses all free-text accessible names. |
| **Origin allowlist** | Glob-pattern rules can restrict which URLs the healer is even permitted to read. |
| **Privacy preview** | Writes the exact payload that *would* be sent, without making any provider call — for compliance audits. No API key required. |
| **Custom redactor callback** | A code hook that can veto a heal entirely if it detects content that should not leave the environment. |
| **Fail-closed gate** | A misconfiguration blocks the heal outright rather than sending unredacted data. Everything else in the framework degrades gracefully; the privacy gate does not. |

---

## CI Gate: Healing Without Hiding Problems

The CI gate (`HEALER_FAIL_ON_HEAL=true`) addresses a natural concern: *won't healing just mask real regressions?*

When the gate is on, a test that needed healing is **marked as failing** at teardown — even though it ran successfully. The error message includes the complete rewrite list: file, line number, old selector, new selector, confidence score, and element role/name. The suite stays green for the application logic while surfacing every stale selector in a single CI run, rather than one per run.

This means healing solves the emergency ("don't block the release") while keeping a permanent record of the technical debt that needs to be cleaned up.

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

## Integration: What Adoption Looks Like

For a team already using Playwright, adoption is a single import change:

```ts
// Before
import { test, expect } from '@playwright/test';

// After
import { test, expect } from 'self-healing-playwright';
```

For teams that want more control, three integration patterns are supported:
- **Spread** into an existing `test.extend()` for projects with a custom base fixture
- **Wrap** an existing test object with `withHealing(test)`
- **Attach** directly to a `page` instance inside an existing fixture

Full step-by-step instructions are in `INTEGRATION.md`.

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

---

*For technical details: see `ARCHITECTURE.md`, `README.md`, and `INTEGRATION.md` in the project repository.*
