
# Flow Ops — Ops Health & Client Risk Scoring: Draft Spec

Draft for Naz review. Covers the two pieces explicitly called out as not-yet-written (fear-signal rubric,
flag→action table), plus a Layer 1 scoring formula so the two systems are consistent. Grounded in the
actual `latest.json` schema (live-fetched from flowco-ops.netlify.app) and real Fireflies transcripts
across the current roster — not hypothetical examples. Assumptions are flagged explicitly; adjust and
send back.

---

## 0. What I checked before writing this

- Pulled the live `latest.json` off flowco-ops.netlify.app. Confirmed shape: `by_client[]` with
  `health` (`on_track` / `needs_attention`), `stats` (`tasks, todo, working, review, stuck, done,
  monday_msgs, wa_msgs, meetings`), `work_by_department[].stalled_items[]` (`days_stalled`, `source`,
  `text`, `monday_item_id`), plus top-level `comms_flags[]` and `blockers[]` as plain-text strings.
- Pulled `app.js`, `addon.js`, `ops-widget.js` (all statically served) to see what's already built.
  Found Netlify Functions already wired: `item-chat`, `queue`, `send-to-monday`, `save-checks`,
  `standup-overrides`, `refresh-standup`, and — this wasn't in the spec — **`ops-chat`**, a global
  floating "Ask Flow Ops" widget already live on both `/` and `/daily`. It's a generic Q&A/action bot,
  not task-scoped like `item-chat`. **This is likely the better home for the "why is this red"
  score-explainer than a third bot** — extend its system prompt/context rather than building fresh.
  Flagging for your call.
- Pulled 10+ real Fireflies transcripts across Summit Bags, Full Smile Dental, Ridge Road Dentistry,
  Billydoe Meats, Citrus Smiles, Rillation Revenue. Used real lines from these as rubric examples below.
- Could **not** get `generate.py` or the Netlify function source — those aren't served over HTTP (only
  compiled/static assets are). Need the actual repo (folder connect or GitHub) to write the real code.
  That's a separate ask, tracked outside this doc.

---

## 1. Layer 1 — Operational Health Score

### 1.1 Sub-dimensions and data sources

| Sub-dimension | Data available today | Gap |
|---|---|---|
| Task stalling (incl. Pending Review) | `stats.review`, `stalled_items[].days_stalled` per department | none — fully covered |
| Communication quality | Monday comment text (pulled by generate.py, not yet classified) | needs the Claude classification pass |
| Meeting cadence/attendance | `stats.meetings` count | **no per-client expected cadence exists yet** — see 1.5 |
| Team load/capacity | department-level task counts only | **no per-assignee workload data** — see 1.5 |

### 1.2 Task stalling → red/yellow/green

Per client, per department, using `stats.review` and `stalled_items[].days_stalled`:

- 🟢 **Green** — no stalled item >5 days, `review` count ≤2
- 🟡 **Yellow** — 1–2 items stalled 5–10 days, OR `review` count 3–4
- 🔴 **Red** — any item stalled >10 days, OR `review` count ≥5, OR any single item >20 days (auto-red
  regardless of everything else — this is the "early warning before it hits a client" case)

*Example from live data:* Quality HVAC has items stalled 37d/50d — that's an automatic red today, and it
already shows up in `comms_flags`. Vous Physique (43d/90d, "no client contact") is the same pattern —
stalling long enough that it's now also a Layer 2 signal (see 2.1, Going Quiet).

### 1.3 Communication quality → red/yellow/green

Claude classifies each Monday update comment as low/medium/high substance — "is it 'done' or does it
actually say what happened and what's next." Per person per week:

- 🟢 **Green** — ≥70% of the week's updates rate medium/high
- 🟡 **Yellow** — 40–70% rate medium/high
- 🔴 **Red** — <40% rate medium/high, OR the same person posts "low" two weeks running (this is the
  actual early-warning case the spec calls out — a single bad week is noise, a repeat is a pattern)

**Classification prompt sketch** (for generate.py to send per comment, batched):
> Classify this Monday.com status update as `low`, `medium`, or `high` substance. High = specific
> outcome + concrete next step. Medium = vague outcome OR next step but not both. Low = "done", "on
> it", "all good", or any update with no verifiable content. Ignore length — a two-word update can be
> high if it's specific ("Meta pixel fixed, live now") and a paragraph can be low if it's filler.
> Return: {label, one_line_reason}.

### 1.4 Meeting cadence and 1.5 Team load — the actual gaps

These are the ~20% of Layer 1 that isn't just "add a formula on top of existing data":

- **Meeting cadence** needs an *expected* cadence per client to compare `stats.meetings` against. That
  doesn't exist anywhere yet (not in Monday, not in latest.json). Simplest fix: a small config
  (`client_cadence.json`, e.g. `{"Full Smile Dental": "biweekly", "Billy Doe Meats": "monthly"}`)
  maintained by hand initially, or inferred from the client's own historical meeting frequency
  (rolling 90-day average) so it's self-updating. **Your call on which.**
- **Team load** needs task counts grouped by *assignee*, not just by client/department. Monday has this
  data (People column) but generate.py isn't pulling it that way today. Needs one new Monday query —
  small addition, not a new system.

Recommend shipping cadence + comms quality + stalling first (fully data-backed today), landing team
load as a fast-follow once the assignee-grouped pull exists.

### 1.5 Composite score

Weighted average, 0–100 (Red=20, Yellow=60, Green=100 per sub-dimension, before weighting):

| Sub-dimension | Weight |
|---|---|
| Task stalling | 35% |
| Comms quality | 30% |
| Meeting cadence | 20% |
| Team load | 15% |

First-draft weights — task stalling and comms quality weighted highest because they're the two the spec
explicitly frames as "catch decline before it hits a client." Adjust once we have a few weeks of real
scored history to sanity-check against what actually preceded past client escalations.

---

## 2. Layer 2 — Fear-Signal Rubric

Seven categories. Each includes real phrasing pulled from your Fireflies transcripts, not invented
examples, so you can sanity-check the classifier against language your team actually hears.

### 2.1 Going Quiet — weight: **High (3)**
Behavioral, not just linguistic — cross-references Layer 1 data. A client who was active and drops off.
- Signal: no meeting, WhatsApp, or Monday activity for 14+ days *after* a previously-established cadence.
- Real example (already surfacing in `comms_flags` today): *"Vous Physique: Meta Ads and automations
  stalled 43d and 90d with no client contact."*
- Why highest weight: silence after an established rhythm is one of the most reliable pre-cancellation
  signals — more reliable than anything said on a call, because it requires no interpretation.

### 2.2 Competitive Shopping / Vendor Comparison — weight: **Critical (4)**
Explicit evaluation of alternatives.
- Phrases: "looking at other agencies," "getting quotes," "considering [competitor]," "past agencies
  failed to deliver."
- Real example, Ridge Road Dentistry: *"Continue searching for an agency that provides both
  comprehensive marketing and call center lead qualification services... Consider moving forward with
  Implant Machine agency after receiving feedback."* — a client actively naming and evaluating a named
  competitor mid-engagement. This is the single clearest signal in the current roster.
- Any hit here should force red regardless of anything else scoring green.

### 2.3 Escalation to More Stakeholders — weight: **High (3)**
A new decision-maker enters the conversation who wasn't previously involved.
- Phrases: "discuss with my father/board/partner," "need sign-off from," "loop in [new name]."
- Real example, Billydoe Meats: *"Discuss marketing investment results and future budget with father and
  internal stakeholders by Monday"* — the day-to-day contact (Haney) needing to justify spend upward is
  exactly the pattern to catch before the escalation conversation happens without you in the room.
- Action implication: this is a "get in front of it" flag — offer to help build the internal case rather
  than waiting to hear the outcome.

### 2.4 ROI / Performance Doubt — weight: **High (3)**
Concern tied to *actioned* budget change, not just discussion.
- Phrases: "not seeing results," "ROI declines," spend cuts framed as a response to underperformance.
- Real example, internal ops call referencing Bolido Meats: *"Bolido Meats campaign faced ROI declines
  due to budget adjustments."* Full Smile: *"budget cuts from $55 to $45 to better align spending with
  lead intake capacity."*
- Distinguish from 2.5: this fires when spend is *actually being reduced*, not just mentioned.

### 2.5 Budget / Financial Hedging — weight: **Medium (2)**
Budget mentioned negatively but no action taken yet — the precursor to 2.4.
- Phrases: "financial constraints," "tightening spending," "need to check on budget."
- Real example, Full Smile Dental: *"Financial constraints require careful budget management... focus on
  maximizing high-intent leads from Google while tightening spending on Meta ads."*

### 2.6 Hedging / Uncertainty Language — weight: **Medium (2)**
General non-committal language independent of budget.
- Phrases: "not sure if," "we'll see," "let's revisit that," "depends on."
- Lower weight on its own — very common in normal conversation — but compounds with other categories.

### 2.7 Vendor-Framing / Relationship Demotion — weight: **Medium (2)**
Client treats the relationship as transactional/commodity rather than a partnership. Often shows up as
*your team* pushing back against it, which is itself the signal worth catching.
- Real example, Citrus Smiles: Sohib explicitly steers the conversation away from "typical vendor"
  framing toward "trust built over a decade" — the fact that this needed saying is the tell.
- Most useful on newer accounts (<6 months) where the relationship hasn't calcified either way yet.

### 2.8 Scoring mechanics

Per transcript, Claude outputs: `{sentiment: 1-5, categories_hit: [...], evidence_quotes: [...]}`.

**Call-over-call trend:** compare current sentiment to the prior 1–2 calls for that client.
- 🟢 Green — stable or improving, 0–1 medium-weight hits, no High/Critical hits
- 🟡 Yellow — flat-to-declining sentiment, OR 2+ medium hits, OR exactly one High hit
- 🔴 Red — any Critical hit, OR 2+ High hits, OR sentiment drop ≥2 points two calls running, OR Going
  Quiet ≥14 days post-established-cadence

**Composite Client Risk Score** = f(latest sentiment level, sentiment trend/delta, weighted sum of
category hits across the last 2 calls, cross-reference against that client's Layer 1 `comms_flags`/
`blockers`). Same red/yellow/green + 0–100 composite treatment as Layer 1 for visual consistency on the
card.

**Comms-style cheat sheet** (per client, not a score): formal vs. casual tone, decision-maker
personality, generated once from the client's transcript history and refreshed periodically (e.g.
monthly) rather than recomputed every call — this doesn't need to react to a single conversation.

---

## 3. Flag → Suggested Action Lookup Table

| Flag | Trigger | Suggested action |
|---|---|---|
| Pending Review bottleneck | `review` ≥5, or any item >10d in review | Reassign or escalate: pull the oldest N tasks out of review, assign an explicit reviewer with a 48h SLA |
| Long-stalled task (any dept) | any item >20d stalled | Escalate in next standup — decide kill or keep, don't let it age further |
| Comms quality red | <40% medium/high this week, or same person "low" 2 weeks running | 1:1 on update expectations; share one "high" example from the team as a model |
| Meeting cadence red | meetings this period below client's established cadence | Book a check-in this week; if client unresponsive, escalate to account owner as a risk, not just a scheduling gap |
| Team load red | assignee over capacity threshold | Rebalance — move tasks to a teammate with headroom, or explicitly deprioritize lower-tier client work |
| Going Quiet | 14+ days silence after active cadence | Reach out same day — don't wait for the next scheduled touchpoint |
| Competitive shopping detected | any mention of evaluating alternative agencies | Immediate save conversation — address the underlying complaint the transcript reveals before they finish evaluating |
| Escalation to new stakeholder | new decision-maker named in transcript | Prep a stakeholder-specific ROI brief before the next call; ask to be looped into that conversation directly |
| ROI/performance doubt (spend cut) | budget reduced citing performance | Send a performance recap within 48h addressing the exact metric questioned |
| Budget hedging (no action yet) | negative budget language, no cut yet | Proactively surface a cost-efficiency win before they raise it again |
| Vendor-framing detected | transactional/commodity language from client | Reinforce partnership framing at the next touchpoint — lead with proactive insight, not deliverable status |

This table is meant to live as structured data (JSON/YAML) that both Layer 1 and Layer 2 scoring
functions look up by flag ID, not hardcoded per-client — so adding a new flag type later is a data
change, not a code change.

---

## 4. Storage

`scores-history.json` as a flat file, appended (not overwritten) on each `generate.py` run — same
pattern as `latest.json`, just accumulating instead of replacing. One row per client per run:
`{date, client, composite_health, sub_scores: {...}, composite_risk, risk_sub_scores: {...}}`. Good
enough for line-chart trends at current data volume (dozen clients, weekly cadence); revisit if run
frequency or roster size grows an order of magnitude.

---

## 5. Open items before this becomes code

1. **Repo access** — need the actual `generate.py` / Netlify function source to build against; not
   fetchable over HTTP. Separate from this doc.
2. **Confirm cadence config approach** (manual per-client config vs. rolling self-inferred average) —
   section 1.4.
3. **Confirm team-load data pull** — needs a new Monday query grouped by assignee; who owns the capacity
   thresholds (per-person task limits)?
4. **Weights and thresholds above are first-draft** — meant to be directionally right, not final. Best
   tuned after 2–3 weeks of real scored history against clients you already know the true status of.
5. **Score-explainer bot** — recommend extending the existing `ops-chat` widget (already live,
   general-purpose) with score/flag context, rather than building a fourth chat surface. Confirm.
