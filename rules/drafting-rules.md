<!-- rules-version: 2026-09-02 -->
## Two different "status" concepts -- don't confuse them
1. **Dashboard status** (a card's workflow state in the queue: ready / confirm
   / done / ignored / sent). A freshly drafted item starts as "ready" (a real
   payload exists, not yet sent to Monday) -- "sent" only happens once the
   real Send action has actually fired an API call to Monday.
2. **Monday board status column** (Start/Stuck on the actual item once it
   exists there). This is set automatically from blocked/needsNaz -- see
   below -- nobody sets it directly.

## Priority (every item has this -- always set it when drafting or editing)
Integer 1-5, 1 = most urgent. Use this rubric:
- 1 = blocker or long external lead time (nothing else can proceed until this
  moves, or it depends on a slow third party)
- 2 = time-sensitive (real deadline or client waiting, but not fully blocking)
- 3 = normal (default, no particular urgency)
- 4 = low (nice to get to, no pressure)
- 5 = FYI only (informational, no real action needed)
Include your best priority judgment every time -- don't leave it stale after
a change that shifts urgency (e.g. resolving a blocker's dependency should
probably also drop its priority number).

## Boards (Team Workspace, id 10979040)
- Ads: 18405754310 -- Meta/Google/LSA/landing pages/graphics/review campaigns. Media buying only.
- Web + SEO (aka "Dev+SEO"): 18099807701 -- website build, automations, GBP, texting policy, reporting. NOT CRM/GHL work.
- CRM: 18418241405 (subitems live on linked board 18418241406) -- all GHL/CRM builds, automations, integrations (Kommo/Como, Clio, HCP, NextGen, Sugar). Owned by Ahmed Memon + Ali Shaheer.
- Video: 18100257069 -- reopened 2026-07-21 (previously "DO NOT USE," that's stale, ignore any older copy of this rule you find). Genuine standalone video production/content (shoots, edits, YouTube uploads) goes here, default assignee Sohib alone. Campaign creative that serves a specific live ad still folds into that Ads item instead, same as before.

## IMPORTANT: a subitem's parent lives on ONE board -- board and parentItemId must never disagree
A subitem (parentItemId set) belongs to whatever board its PARENT item is actually on. If you are changing an existing item/subitem's board (not drafting fresh), and it currently has a parentItemId, moving it to a different board almost always means it can no longer be that same parent's subitem -- the old parent lives on the old board, not the new one. When a board change is requested on something that's a subitem: either (a) find/create the equivalent parent workstream on the NEW board and re-point parentItemId there, or (b) if there's no sensible parent on the new board, convert it to a plain top-level item instead (clear parentItemId) and say so explicitly, or (c) ask Naz which he wants rather than silently leaving a stale parentItemId that now points at an item on a board this one no longer lives on. Never leave board and parentItemId pointing at two different boards at once -- that's a broken state, not a valid one.

## Client group IDs (Ads / Web+SEO / CRM / Video)
Full audit 2026-07-22 -- every client below now has a real, live-confirmed group on all 4 boards. No more "verify before writing" guesses; these were checked directly against each board's live group list.
- Maadi Law: group_mm51vdbk / group_mm51tkzh / group_mm5112vv / group_mm5064vm
- MedStation: group_mm516qss / group_mm51nc9h / group_mm512p9w / group_mm5gq0cw
- Quality HVAC: group_mm23tg6s / group_mm231wbb / group_mm231wbb / group_mm2660b4 (CRM and Web+SEO share an id -- confirmed coincidental, not a bug)
- Full Smile: group_mkxdznat / group_mkxdmhbz / group_mkxdmhbz / group_mkxd24va (CRM and Web+SEO share an id -- confirmed coincidental)
- Justice Consumer Law: group_mkqxyga2 / group_mkqxyga2 / group_mm5gdrn3 / group_mkqxyga2
- Liferun: group_mkwj8zze / group_mkwj9a1c / group_mkwj9a1c / group_mkwj5qjb (CRM and Web+SEO share an id -- confirmed coincidental)
- Billy Doe Meats: group_mm2dt8f / group_mm2dqm7n / group_mm5gt78e / group_mm2ddrwm
- Steel Round Bars: group_mm5gmpwf / group_mkqxskcn / group_mkqxskcn / group_mkqxskcn (Ads group recreated 2026-07-22, its old one had vanished from the live board)
- Flow Company (internal): group_mkwjedjg / group_mkwjem1v / group_mm5g4pdh / group_mkwj30hd
- Healing Helps: (no Ads group live) / group_mm0qsym9 / no CRM group yet / group_mm0qsmx7
- Remedies: (no Ads group live) / (no Web+SEO group live) / no CRM group yet / group_mkwj2zbm
If the client or its group id isn't listed here or you're unsure it's current, look it up on Monday rather than guessing -- group IDs can change, and this table has gone stale before (missed two board additions in a row -- always cross-check lib/monday.js's CLIENT_GROUPS, the real source of truth, if anything here looks off).

## MANDATORY board audit before drafting anything new (§19)
Before drafting a new item, subitem, or update, you MUST query the client's
group across ALL 4 ACTIVE BOARDS (Ads + Web+SEO + CRM + Video), WITH
includeSubItems: true -- subitems are exactly where duplicates and
already-completed work hide. Never guess an existingItemId or parentItemId,
and never scope the audit to just "the board this looks like it belongs on"
-- the same workstream can already exist on a different board than the one
you'd guess. One good batched lookup is usually enough; don't loop forever,
but don't skip any of the 4 boards either.

## Pending-queue audit (§19b)
§19 audits Monday. It never audits the draft queue it writes INTO -- so when
the same work gets discussed on two separate calls and the first card was
never fired, §19 comes back clean (the work genuinely isn't on Monday yet)
and a second card gets drafted for the same thing. Live example:
`medstation-reactivation-whatsapp-gate` (8/24) and
`medstation-reactivation-cohort-window` (8/26) both ended up targeting
Monday item 12484780177 because neither audit ever saw the other card.

Runs immediately AFTER §19 and BEFORE any card is written for this
candidate. Audit-first, draft-second still holds -- this is a second audit
surface, not a replacement for §19.

**Read.** `checks/draft-queue.json` (the `state` branch -- same source
`queue.js` reads). Consider only cards in a NON-TERMINAL status: `ready`,
`confirm`, `blocked`, `exists`. Explicitly exclude `sent`, `done`, `ignored`
-- ignored cards are already consumed separately as past decisions via
`ignoreReason` (§29); don't double-count them here.

**Match, strongest axis first:**
1. **Same target item.** This candidate's `existingItemId` equals an
   existing card's `payload.existingItemId`. Definite match, no similarity
   check needed.
2. **Same parent + overlapping subject.** Same `payload.parentItemName` AND
   the subjects overlap, per the shared text-similarity matcher
   (`SIMILARITY_DUP_THRESHOLD`, same 0.6 bar §19's own Monday-side re-audit
   uses).
3. **Same client, similar work.** Same `group` AND high title/`updateBody`
   similarity. Lowest confidence -- flag rather than auto-merge (add a note
   pointing at the existing card's id; don't fold the two together on this
   axis alone).

**Action on a 1 or 2 match -- MERGE, do not create a second card.** Fold the
new material into the existing card:
- **Keep** the existing card's `id` and `createdAt`. Never reset
  `createdAt` -- the age badge has to keep counting from the FIRST call, or
  merging quietly hides staleness and defeats the whole point of the 3-day
  badge.
- **Rewrite** `updateBody` to carry both calls' content as one coherent
  update. Do not concatenate the two -- write it the way a person would if
  they sat through both calls.
- **Append** the new source onto `sourceLabel`, e.g. `"Meeting: GHL Go Live
  Checkin, 8/24 + Meeting: Flow ops review, 8/26"`.
- **Set** `updatedAt` to now.
- Do **not** create a second card for this candidate.

**Conflict case -- merge, but don't decide.** If the two sources DISAGREE
rather than merely overlap, never silently pick one -- that buries a
decision that isn't the drafter's to make. Merge into one card, then:
- `status: "confirm"`
- `nullReason: "content-conflict"`, payload left null -- one of the three
  valid reasons to leave payload null per SKILL.md A6, already the mechanism
  used for any fact only Naz can resolve
- state BOTH positions explicitly in the body, each with its date and
  source, and name the decision Naz actually needs to make.

Live example this would have caught: an 8/25 update set the reactivation
trigger at last-visit >45 days; the 8/26 review described the cohort as 3+
months inactive. Those select materially different patient populations. The
correct output is one `confirm` card naming both positions, not two `ready`
cards quietly disagreeing with each other on Monday.

## Single-item bias (fewer items, not more)
Prefer folding new information into an EXISTING item over creating a new one:
1. If a parent item already exists for this workstream, draft a subitem
   against it rather than a new top-level item.
2. If this is just new information/confirmation about work already tracked,
   post an update onto the existing item instead (create nothing new).
3. Only create a new top-level item when this is a genuinely new workstream
   with no existing parent on the board.
Less is more -- one sequenced workflow is one item with steps in the update,
not several items.

**Counter-rule: same team + same timeline is NOT sufficient grounds to
merge.** Merging also requires a shared workflow or a real dependency
between the pieces -- one being a prerequisite for the other, or both being
steps in one deliverable. Explicitly do NOT merge when the pieces are
different kinds of work (e.g. a listing/profile correction vs. a net-new
build), or when one piece is substantially larger than the others (a
multi-week build should not ride along inside a one-line fix). When
candidates fail this test, draft them as separate items rather than
numbered steps in one.

## Prerequisite check before drafting
Before drafting or editing a task, ask whether it silently assumes
infrastructure/a tool/an integration exists for THIS client that hasn't
actually been confirmed -- a GHL account, HCP, a specific CRM, a pixel/
tracking setup, an ad account, etc. Check flow/GHL Automations -- Flow
Company.md (or equivalent per-client setup context) and the client's own
existing board presence -- an empty/new group is itself a signal nothing's
been built yet -- before assuming a prerequisite is actually there. If it's
missing or unconfirmed: don't draft the dependent task as if it's
standalone-ready. Fold both into ONE item as explicit sequenced steps (same
single-item bias as above) -- prerequisite first, dependent task second,
with a line making the dependency and sequencing explicit (e.g. "don't start
step 2 before step 1 is done"). If it's genuinely unclear whether the
prerequisite exists, flag it for Naz rather than guessing either way.

## Update format (§7) -- updateBody MUST follow this exactly
1. Open with "<p>Salam,</p>" -- nothing else, no @-tag at the start.
2. Body as "<ul><li>...</li></ul>" bullets. Knowledgeable (don't dumb it down),
   organized, one clear thought per bullet, more than enough detail -- assume
   the reader has NOT seen the source meeting. A single generic sentence
   ("client wants the lead form fixed") is NEVER an acceptable updateBody, no
   matter how small the item looks. Always write MULTIPLE bullets covering,
   at minimum:
   - **Context**: what happened and why this is being drafted, in enough
     detail that someone who never saw the source meeting/message understands
     the situation, not just the headline.
   - **The actual deliverable(s) or step(s)**, specific enough that the
     assignee can start executing without a follow-up question.
   - **Dependencies/constraints**: what this is waiting on, what it depends
     on, what NOT to touch or change. If there are genuinely none, say so
     explicitly ("No dependencies -- can start immediately") rather than
     dropping the point.
   - **Done/success criterion**: what "finished" looks like for this item --
     the same "done = ___" test used to decide whether something is a real
     task at all.
   If the source content is genuinely thin, that's a sign to ask a follow-up
   question (or look it up on Monday for more context) rather than drafting a
   thin one-line update. This is a HARD gate, not just this instruction:
   drafting and the real send both run a code-level check (at least 2
   distinct lines with real detail, not just enough bullets to game the
   count) and will reject a too-thin updateBody with an error instead of
   saving/sending it -- if that happens, don't just resubmit the same
   content, actually add the missing context/goal.
3. Tag people at the very bottom only, one line, exact HTML:
   <p><a class="mention" data-mention-id="USERID" data-mention-type="User">@Full Display Name</a> ...</p>
4. NEVER use em dashes (--) or en dashes. Avoid hyphens outside canonical terms.
5. itemName: 2-3 words max, lead with the noun or action verb. No articles.
6. Bold (<strong>) action verbs, deadlines, and constraints.
7. HTML only, no markdown.

## Assignment is automatic and server-enforced -- nobody sets columnValues by hand
Status and people columns are always derived server-side from boardId +
blocked + needsNaz, using fixed default assignees per board:
- Ads board: Khurram Jamil + Ads Team
- Web+SEO board: Muhammad Hashir Faiz + Zayan Faiz
- CRM board: Ahmed Memon + Ali Shaheer
You cannot hand-pick a single person off that pair, or tag anyone outside it --
if asked for someone not on the fixed list for that board, say so rather than
inventing a workaround. Do NOT tag Naz or Sohib by default on ANY board. Only
treat needsNaz as true as a deliberate judgment call when the task is
genuinely complex or high-stakes enough to need Naz directly involved -- never
as a default, and never just because someone asked a question in chat. Status
defaults to Start. Only treat blocked as true if this is genuinely blocked on
a client or 3rd party (sets status to Stuck instead, on the Monday board
status column -- not the dashboard status). Drafting a subitem also needs
boardId (not used in the mutation itself, but required so the right default
assignees can be applied).

Mirror the SAME people in your updateBody's closing mention-chip line (§7),
using their real Monday user IDs:
- Ads Team: 102221061 (tag as "@Ads Team"), Khurram Jamil: 102221064
- Muhammad Hashir Faiz: 69741994, Zayan Faiz: 101662542
- Ahmed Memon: 108080159, Ali Shaheer: 108080161
- Sohib Boundaoui: 69662034, Nacer Amrouch (Naz): 70062990 (only if needsNaz)
Clients are NEVER Monday users and never get @-tagged -- mention them by plain
text name in the body. If a client needs to be chased, assign/tag Naz instead
(and set needsNaz: true).

## Defaults when unstated
Leave timeline blank unless a real deadline is named.

## Routing: transcript -> board (§8)

Decide the board from these signals. When two could apply, the more specific rule wins.

- **Ads** (`18405754310`) — Meta, Google Ads, LSA, ad graphics and creatives,
  dayparting and scheduling, ad audits. **Media buying only.**
- **Web + SEO** (`18099807701`) — website builds, landing pages, GBP management,
  10DLC and texting policy, reporting dashboards. Anything that requires building
  a webhook, configuring a backend system, or touching a website lives here.
- **CRM** (`18418241405`, subitems on `18418241406`) — GHL/CRM builds specifically:
  Kommo/Como, Clio, HCP, NextGen integrations, pipelines, automations, lead
  notifications, lead-form-to-CRM integrations. GHL/CRM/integration work routes
  here, never to Web + SEO.
- **Video** (`18100257069`) — genuinely standalone video production and content:
  shoots, multi-language edits, YouTube uploads, organic video content. Default
  assignee is Sohib alone — never Ads Team/Khurram, Hashir/Zayan, or Ahmed/Ali.

**Ads still wins when it's campaign creative.** A static graphic or an ad-cut that
serves a specific live Meta/Google ad folds into that Ads item. It does not become
a separate Video item.

**Web + dev always goes to Web + SEO, even when it's tied to a campaign.** A Meta
lead form -> HCP integration is dev work: the campaign is the reason, the build is
the task. Ads is for paid media only.

Default landing-page tagging: Naz + Hashir + Zayan.

## The `done = ___` filter (§13) — load-bearing

**Before drafting any item, write "done = ___" in one line. If you can't, it is not
a Monday item.**

- Real task: "done = HCP push notifications fire on every new lead within 60
  seconds." Definable end state, can be marked Done.
- Not a task: "Google + LSAs are our primary revenue channel." That's a posture.
  There is no done.
- Not a task: "Tone should be punchy but professional." Creative direction, no
  deliverable.

Anything failing this filter goes to the Notes/FYI section of the run summary, or
gets folded into a related task's update as a constraint. It is never drafted as
its own card. A task that fails this sits in Start forever and adds accountability
surface area without accountability content.

## Client people are never @-tagged (§6)

Clients are not Monday users. When a transcript says "Nate to action" or "Aiman to
confirm," the task is **assigned to Naz** as follow-up owner — he handles client
comms directly. Name the client in plain text in the update body so the team knows
where the dependency sits, but never as a mention chip.

Known client people (not Monday users): Nader "Nate" Zeidan and Aiman Zayed
(Quality HVAC), Lily (Full Smile front desk), Marwan R. Daher (Justice Consumer
Law), Dr. Adham Badwan and Dr. Jamal Sahloul (Full Smile), Mateus Lima
(MedStation), Sharif Maadi (Maadi Law).

This list is illustrative, not exhaustive — the rule is about the category. Anyone
on the client side of an engagement is handled the same way.

## Parent status is Ongoing when subitems exist (§22c)

A parent item with one or more subitems gets status **Ongoing**
(`color_mkwb1trm`, label "Ongoing", id 9). The parent is a workstream container,
not a discrete deliverable — it never completes, its subitems do.

Apply when creating a parent that will have subitems (Ongoing at creation, not
Start), when auditing a parent that has subitems in any other status, and when
adding the first subitem to a previously childless parent.

Exception: a parent set to **Stuck** because the whole workstream is genuinely
blocked stays Stuck. Stuck overrides Ongoing.

Subitems keep whatever discrete status fits their state. This rule is parent-only.

## Ignored cards are negative signal (§29)

Before drafting, read the current queue's ignored items and treat them as
instruction, not noise. If a candidate matches the shape of something Naz has
ignored **more than once** with the same or a similar reason — fuzzy match on
title and content, not exact text — do not draft it. Route it to Notes/FYI, the
same disposition as failing the `done = ___` filter, and record which past ignores
it matched.

A single one-off ignore is not a pattern. Only a repeat changes the disposition.

This applies to task-drafting judgment only — not to `potentialClient` prospect
cards, and not to the health check.
