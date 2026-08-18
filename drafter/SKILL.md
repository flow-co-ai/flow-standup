# Flow Operations — daily draft pass

Ported from the Cowork scheduled task `operations-dashboard-update` (2026-08-18).
Runs unattended on a GitHub Actions runner. There is no laptop, no home directory,
and no memory of prior runs — everything needed is in this file, in the repo, or on
the `state` branch.

## What this run does

Two jobs, kept separate:

- **JOB A — drafting.** Does anything said in a meeting deserve to become a NEW
  Monday task that doesn't exist yet? Output goes to the draft queue for Naz to
  approve on Daily Ops.
- **JOB B — health check.** Of the work ALREADY on the four boards, what's about to
  slip or is already stuck? Output goes in the run summary only.

## HARD RULE — read this before anything else

**Never call a Monday write or mutation tool. Not one, not ever, no exceptions.**

No `create_item`, `create_items`, `create_subitem`, `create_update`,
`change_item_column_values`, `change_item_position`, no reassignment, no status
changes, no `all_monday_api` mutation, no GraphQL mutation.

Monday access is read-only: `get_board_items_page`, `get_board_info`,
`get_type_details`, `all_monday_api` queries.

Everything this run produces lands in the draft queue as a proposal. Naz reviews
and fires it from the dashboard. This is the whole reason the job is allowed to
run unattended.

> Note for anyone porting further: the laptop version of this skill carried one
> narrow exception (JOB D / A9, marking an item Done on clear evidence). It is
> **removed here** and its removal is deliberate — Naz's instruction, 2026-08-18:
> "dont write directly to monday. write to the draft queue still for me to
> approve." A completion signal now becomes an `update_only` draft like anything
> else.

## Boards

Ads `18405754310` · Web + SEO `18099807701` · CRM `18418241405` (subitems on
`18418241406`) · Video `18100257069`.

Full routing criteria, group IDs, the §7 update format, the priority rubric, the
`done = ___` filter, and the never-tag-clients rule all live in
**`rules/drafting-rules.md`**, checked out alongside this file. Read it in full
before drafting anything and report its version stamp in the run summary.

---

## JOB A

### A0 — preflight

Call `drafter.state.preflight()`. It proves the token can both read and write
`checks/draft-queue.json` by doing a no-op round trip.

If it raises, **stop the entire run.** Do not proceed to A1. Do not touch the
state file. Report the exact failure as the only line that matters. A run that
cannot push must leave state exactly as it found it so the next run re-processes
the same window cleanly.

This exists because `GH_TOKEN` silently 401'd for five days in August 2026 and two
full runs of drafting work were lost.

### A1 — rules

Read `rules/drafting-rules.md` from the checkout. Note its
`<!-- rules-version: -->` stamp and report it every run, without exception, so
drift becomes visible instead of silent.

`item-chat.js` reads the same file at cold start. That's the point — one file, two
consumers, no hand-maintained second copy. There have been two separate incidents
of drifting copies; don't create a third.

### A2 — finalize clarified cards

Read `checks/draft-queue.json`. For every card with `awaitingFinalize === true`,
Naz has replied in the card's chat. Resolve into exactly one of:

- **already handled** — run the A5 audit to confirm, then `status: 'ignored'`,
  payload stays null, clear the clarification fields.
- **here's the missing fact, now draft it** — produce a real payload to the same
  standard as A6, `status: 'ready'`, clear the clarification fields. For an
  `unmapped-client` card this is where Naz confirms it's a real client and says
  where it belongs; clear `potentialClient` too once he has.
- **still not enough** — leave `awaitingFinalize` true and keep the clarification
  so Naz can see his note is still there.

This runs even when A3–A8 find nothing new.

### A3 — pull transcripts

`fireflies_get_transcripts`, `fromDate` = `state.lastCheckedISO` minus one day,
format `toon`, limit 15–20, paginate with `skip`. No organizer or participant
filter.

Keep only transcripts where the id is not already in `state.processedIds` **and**
`meeting_info.summary_status == "processed"`.

### A4 — WhatsApp

**Out of scope for now.** The laptop version scanned `~/Claude/inbox/whatsapp/`
for `.zip` and `.txt` exports. That folder does not exist on a runner, and the
Business API webhook store isn't built yet.

Until it is, say so explicitly in the run summary — *"WhatsApp not scanned — no
ingestion source configured"* — rather than reporting zero exports as though the
folder were empty. A silent zero reads as "nothing new" and hides real content.
When the webhook store lands, this step reads from it and the per-chat
high-water-mark logic returns.

### A5 — relevance, routing, audit

For each transcript, oldest first:

**Relevance.** No connection to a Flow client, internal ops, or a real prospect →
skip silently. Permanent exclusions, never drafted or flagged as prospects:
Ziad Khateeb / Rillation Revenue / Mohammad Khateeb (Sohib's outside advisor), and
Rajpal Manoj (out of scope). Note that "Tom Sugar" is **not** an exclusion — he's
the real SugarCRM rep on Steel Round Bars, and content referencing him routes
normally.

**The `done = ___` filter.** Per `drafting-rules.md`. Fails it → Notes/FYI in the
summary, not a card.

**Ignored-card check.** Read the queue's `ignored` items as negative signal. A
candidate matching the shape of something Naz has ignored more than once for the
same reason goes to Notes/FYI. One ignore is not a pattern.

**Routing.** Per `drafting-rules.md` §8, against the current roster in
`config.json`. Superficial resemblance is never a match — same industry, a similar
name, a shared generic word. Route to an existing client only when the content
unambiguously names that client. Otherwise set `potentialClient` to your best guess
at the prospect name and leave `group` genuinely null.

`group` is a real board group name or it is null. Never `"n/a"`, never `""`, never
any other placeholder — seven live cards carried the literal string `"n/a"` in July
and rendered as a phantom client on Daily Ops. `validate.py` normalizes these to
null as a backstop, but if you find yourself about to write one, the real problem
is that the existing-client-vs-prospect call hasn't resolved yet. Go back.

**Prospect dismiss check.** If a matching `potentialClient` already exists in the
queue with `dismissed: true`, skip it entirely — unless this specific meeting
carries a genuine conversion signal (a signed agreement, confirmed scope or
pricing). "Still in the pipeline" is not a conversion signal.

**Mandatory board audit — never skipped, never deferred.** For every candidate,
`get_board_items_page` on the relevant groups across **all four boards** with
`includeSubItems: true`. Subitems are exactly where duplicates and already-finished
work hide. Outcomes:

- already fully covered → `status: 'exists'`, no payload, don't flag for review
- belongs under an existing parent → `create_subitem` with the real `parentItemId`
- better as a note on an existing item → `update_only` with the real `existingItemId`
- nothing matching anywhere → `create_item`

Skip the audit only for `potentialClient` cards — there's no roster group to audit
against, which is why they're flagged rather than drafted.

### A6 — emit the payload

**This is the step that changed most in the port. Read it carefully.**

The laptop version wrote each draft to a markdown file with a fenced ```json block,
then a later pass re-parsed that file to recover the payload. That round trip
failed on four cards in a single run on 2026-08-18 — three different malformed
shapes — and had accumulated ~900 words of prose trying to prevent exactly that.

**There is no intermediate file now.** Emit the payload as a structured object and
hand it to `validate.py`. You are not writing JSON into a document for something
else to parse back out.

Shape by mode — no other fields, ever:

```
create_item     {mode, boardId, groupId, itemName, updateBody, blocked, needsNaz}
create_subitem  {mode, boardId, parentItemId, itemName, updateBody, blocked, needsNaz}
update_only     {mode, existingItemId, itemName, updateBody, blocked, needsNaz}
```

Monday ids are strings even though they're numerically valued. `updateBody` is the
full §7-format HTML inline. **Never** include `columnValues` — assignment is
computed server-side at send time by `lib/monday.js`, and a hand-authored one
shipped eleven updates that notified nobody. **Never** include `board` or `group`
as display strings; those are for humans, and they're carried on the card, not the
payload.

Leave the payload null only for: `multi-item` (genuinely 2+ separate Monday items),
`content-conflict` (a fact only Naz can resolve), or `unmapped-client`. Routing or
mode uncertainty is **not** a valid null reason — the A5 audit resolves it.

`sourceLabel` format: `"Meeting with {Client}, {M/D}"` for a single-client meeting,
`"Meeting: {short title}, {M/D}"` for internal or multi-client. Plain language only
— never "backfill sweep" or raw transcript jargon in anything Naz reads.

Then call `validate.py`'s `build_card()`. If a payload fails validation it becomes
a `parse-error` card at `status: 'confirm'` with the failure written into its note.
That's working as designed — a bad payload surfaces loudly instead of shipping.
Collect every parse-error this run into a list at the top of the summary.

### A7 — push

Merge into `checks/draft-queue.json` via `validate.merge_queue()`, which enforces:
terminal cards are never downgraded, ignored cards keep `ignoreReason`/`ignoredAt`
whole, `createdAt` is stamped once and never touched again, `awaitingFinalize`
cards are left alone, and nothing is ever deleted here.

`write_json()` confirms the commit sha landed. A non-2xx or a missing sha means
this step **failed** and A8 must not run.

### A8 — state, only after a confirmed push

Only if A7 confirmed: add processed Fireflies ids to `state.processedIds`, set
`lastCheckedISO` to now, save.

If A7 was skipped or failed: change **nothing**. Say plainly in the summary that
state was left untouched and the same window will be re-processed next run.

This ordering is not cosmetic. It used to run before the push, which caused runs
#24 and #25 to mark eight days of transcripts processed while their drafting work
was never written anywhere.

### A9 — weekly archive

Once per ISO week, after A8. Skip if A7 failed.

If `state.lastArchivedWeek` is the current week, skip. Otherwise split the queue
with `split_for_archive()`, append the terminal cards **verbatim, whole-object,
every field intact** to `checks/archive/<YYYY-Www>.json`, dedupe by id, and PUT
the queue back with the remainder. This step relocates cards; it never re-authors
them. Update `lastArchivedWeek` either way so it doesn't re-check every run.

---

## JOB B — health check

Across all four boards, `get_board_items_page` with columns, and flag:

- items and subitems with a timeline ending in the next 3 days
- anything currently **Stuck**
- anything whose last activity is more than 5 business days old and not Done

Group by client, skip clients with nothing to flag. This goes in the run summary
only — never pushed to the queue or the page.

---

## Run summary

If A0's preflight failed, that is the only thing worth saying. Say it, say state
was left untouched, stop.

Otherwise, tight and scannable, no preamble:

1. Any parse-error cards from A6, first.
2. `drafting-rules.md` version used — one line, every run, no exceptions.
3. **JOB A** — meetings processed, drafts produced, clarified cards finalized and
   their outcomes. WhatsApp: state explicitly that no ingestion source is
   configured. One line if nothing new.
4. **JOB B** — what needs attention today, by client. One sentence if nothing.
5. Archive count, if A9 ran.
6. Whether the push succeeded and whether state was committed or left untouched.
