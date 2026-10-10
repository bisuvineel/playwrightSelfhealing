# Speaker Notes — Self-Healing Playwright
*For the presenter only. Share LEADERSHIP-BRIEFING.md with the room.*

---

## OPENING — Hook the room first (2 min)

> "Before I show you what we built, I want to ask a question.
> The last time your team shipped a UI redesign — how long before someone said
> 'the tests are all red'? And how long did it take to get them green again?"

Let the room answer. You'll get numbers — half a day, two days, a sprint. Accept whatever they say. Then:

> "That time — every single hour of it — was not spent finding bugs.
> It was spent updating test selectors. The application worked perfectly.
> The tests just couldn't find the buttons anymore.
> What we built makes that problem essentially free."

**Why this opening works:** You anchor the problem in their lived experience before you explain the solution. They are already sold on the problem. Everything after this is just the answer.

---

## THE PROBLEM — Name the tax (2 min)

> "When a UI is redesigned, automated tests use CSS selectors to find elements —
> buttons, fields, links. A redesign changes the DOM. The selectors go stale.
> Tests fail — not because the app is broken, but because the test can't find the button.
>
> A single redesign can break dozens of selectors across hundreds of tests.
> Engineers stop feature work. They hunt down each broken selector one by one,
> figure out what it should be now, fix it, repeat. This takes hours — sometimes days.
> Every release cycle. Every redesign."

Then say this slowly and clearly:

> "This is a pure maintenance tax. It does not catch bugs. It does not improve quality.
> It just costs time — every time the UI changes."

**Pause here.** Let that land. The word "tax" is intentional — it frames the problem as something we are paying unnecessarily, not something inherent to software.

---

## THE SOLUTION — What we built (3 min)

> "We built an AI-powered layer that sits on top of our existing Playwright tests.
> You don't rewrite your tests. You change one line of code — one import —
> and the framework takes over."

Walk through the five steps:

> "When a test action fails because a selector is stale, the framework intercepts it.
> It captures the accessibility structure of the live page — think of it as a text
> description of what's on screen: button names, field labels, roles.
> It sends that to an AI model and asks: what element did this test intend to use?
> The AI suggests a replacement selector.
> The framework runs four validation checks on that suggestion before it trusts it.
> If it passes, the action retries — transparently, mid-test — and the suite keeps running.
> If it fails, the original Playwright error is thrown. Nothing is hidden."

Then say:

> "In our demo run — 7 deliberately stale selectors across 4 tests — all 7 healed.
> The whole thing cost $0.008 in AI tokens.
> That is less than a penny. A single engineer-hour of selector debugging costs
> orders of magnitude more."

---

## HOW IT KNOWS — The technical question (2 min)

Someone will ask how it actually knows a click failed. Answer it before they ask:

> "Playwright gives every test a `page` object. Our framework replaces the action methods
> on that object — click, fill, hover, and 13 others — with wrapped versions.
> Each one runs inside a try/catch. The moment Playwright throws —
> timeout, element not found, not visible — the catch block fires the healer.
>
> The original error is saved immediately. If the healer can't fix it,
> that original error is what the test sees. There is no way for the healer
> to change a failed test into a passing one unless the selector was genuinely the problem."

**Key message to land:** The framework intercepts at the lowest level — the action itself — not at some outer layer. It knows *exactly* which action on *exactly* which selector failed.

---

## WHAT WE SEND TO AI — Address this proactively (2 min)

Leadership will wonder: what data leaves our environment? Answer it directly:

> "The AI receives three things: the failing selector, the action that failed,
> and the page's accessibility tree.
>
> The accessibility tree is structured text — roles, names, states.
> It looks like: 'button: Place Order, textbox: Email address, link: Cancel.'
> No raw HTML. No pixel data. No screenshots by default.
>
> And before that text leaves the machine, the framework strips emails,
> card numbers, SSNs, GUIDs, IBANs, IP addresses, dates of birth — all of it.
> By default. Without configuration. You have to actively turn it off to send that data."

Then if they ask about sensitive environments:

> "You can run it with a local Ollama model — the data never leaves your network at all.
> You can restrict it to specific URLs with an allowlist.
> You can write a compliance preview — it shows you the exact payload that *would* be sent
> without ever making a provider call. Your compliance team can audit it."

---

## THE SAFETY QUESTION — This is the most important part (3 min)

Someone will ask: "What if it heals the wrong element? What if it masks a real regression?"

This is the question you most need to nail. Take your time:

> "This was our biggest design concern, and it shaped everything.
>
> First: healing does not change the test result. It changes *why* the test fails.
> If the application is broken, the test still fails — the healer doesn't touch that.
> If the selector is stale, the test heals and passes. Those are two different problems.
> The framework treats them differently."

Then on wrong-element healing:

> "Before the framework trusts any AI suggestion, it runs four checks.
>
> First: action compatibility. If the test is doing a fill() — typing into a field —
> and the AI suggests a button, that's rejected immediately. You can't type into a button.
> Zero false positives on this check. It's a fact, not a judgement.
>
> Second: self-consistency. The AI doesn't just give us a selector — it tells us
> what it thinks it selected: 'a button named Place Order.'
> We then check that against the live DOM. If the selector resolves to something else,
> the AI contradicted itself. Rejected.
>
> Third: role preservation. If the original selector was targeting a button,
> the healed element must also be a button. A redesign that genuinely changed
> a button to a link — that surfaces as a red test, not a silent green.
>
> Fourth: lexical intent. The ID `#place-order-btn` is *about* placing an order.
> If the AI suggests an element whose name shares nothing with that vocabulary —
> say, it picks 'Cancel' — that's rejected too.
>
> And each rejected suggestion, with its reason, gets fed back into the next AI prompt.
> So attempt two is smarter than attempt one."

Finish with the CI gate:

> "And for CI specifically: you can turn on a flag that marks any test that needed healing
> as a build failure — even though the test ran successfully.
> So the release is not blocked. But the stale selectors can't be ignored either.
> One CI run gives you the complete list: file, line number, old selector, new selector.
> Schedule the fixes. Ship the release."

---

## THE NUMBERS — Real data, not projections (2 min)

> "These numbers come from real accumulated data — not a simulation, not a projection.
>
> 154 heals recorded. 119 successful. 77.3% success rate.
> The 22.7% that don't heal fail gracefully — original error thrown, nothing hidden.
>
> Average AI confidence score: 0.74 out of 1.
>
> Cost per heal: $0.00115.
> At 1,000 heals in a large suite, that's $1.15 in AI costs.
> Against an engineer's loaded hourly rate, the crossover point is roughly
> two minutes of debugging time. We are well past that on any real suite."

If they push on the success rate:

> "77% is honest — we haven't inflated it. The 23% that fail are cases where
> the page changed so fundamentally that even a human reading the snapshot
> might struggle to know what element was intended.
> In those cases, the original test error is exactly what you want."

---

## SCOPE — Be precise (1 min)

> "One thing to be clear about: this is scoped to Playwright only.
> TypeScript and JavaScript. That's the boundary.
>
> Cypress, Selenium, WebdriverIO — not in scope. Python or Java Playwright — not in scope.
> If your team is on Playwright with TypeScript or JavaScript,
> adoption is one import line and you're done."

---

## CLOSING — What you're asking for (1 min)

> "We built this in 8 days. It has 392 unit tests.
> It has real heal data accumulated across development and testing.
> It has enterprise-grade privacy controls that were a design requirement, not an afterthought.
>
> I'm not asking for a commitment today.
> I'm asking for one sprint — one team — to run it against their real Playwright suite.
> We measure heals triggered, cost, time saved, and we report back with our own numbers.
>
> If it works there the way it works in the demo, we have an answer
> to a problem that has been costing us time on every single release cycle."

---

## ANTICIPATED QUESTIONS

**"What if the AI picks the wrong element and the test passes when it shouldn't?"**
> "The four intent checks exist precisely for this. The demo's Cancel button is unique,
> visible, and clickable — but the lexical check catches it because Cancel shares no words
> with `#place-order-btn`. It's rejected. Only element 'Place Order' passes all four checks."

**"What AI provider does this use?"**
> "The default is Claude Haiku — Anthropic's fast, low-cost tier. OpenAI GPT-4o and
> Google Gemini are also supported. For environments where data cannot leave the network,
> Ollama runs a local model — nothing goes to any cloud provider."

**"What does it cost if we run it at scale across all our suites?"**
> "At our 77% cache-reuse rate on repeat runs, the per-heal cost drops further.
> Run the numbers: take the selector count your teams currently debug manually,
> multiply by $0.00115, compare to the engineering hours. The math is not close."

**"Who maintains this after the pilot?"**
> "The 392-unit test suite means any engineer can make changes with confidence.
> The natural owner after a successful pilot is whoever owns test infrastructure.
> The framework has no runtime dependencies beyond dotenv — maintenance burden is low."

**"What happens if the AI provider is down?"**
> "The circuit breaker fires after 5 consecutive provider failures and the healer
> switches off for that worker. Tests continue running as plain Playwright.
> Nothing in the suite breaks because the healer is unavailable."

**"Is 77% success rate good enough?"**
> "For a first line of defense — yes. The alternative is 0% automatic healing.
> The 23% that don't heal are handled exactly as they were before: engineer fixes the selector.
> The 77% that do heal are time the team gets back. That's the comparison."

---

*Total presentation time: ~15–18 minutes with Q&A. Keep the CI gate and four intent checks as your two non-negotiable technical points — they answer the two concerns leadership will always have.*
