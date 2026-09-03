# Flow Operations — daily draft pass

Ported from the Cowork scheduled task `operations-dashboard-update` (2026-08-18).
Runs unattended on a GitHub Actions runner. There is no laptop, no home directory,
and no memory of prior runs — everything needed is in this file, in the repo, or on
the `state` branch.

## What this run does

Two jobs, kept separate:

- **JOB A — drafting.** Does anything said in a meeting or a WhatsApp chat deserve
  to become a NEW Monday task that doesn't exist yet? Output goes to the draft
  queue for Naz to approve on Daily Ops.
- **JOB B — health check.** Of the work ALREADY on the four boards, what's about to
  slip or is already stuck? Output goes in the run summary only.

## HARD RULE — read this before anything else

**Never call a Monday write or mutation tool. Not one, not ever, no exceptions.**

No `create_item`, `create_items`, `create_subitem`, `create_update`,
`change_item_column_values`, `change_item_position`, no reassignment, no status
changes, no `all_monday_api` mutation, no GraphQL mutation.

Monday access is read-only, through the repo's existing fetcher via Bash:
`python3 -c` calls into `fetch_monday.fetch_board(board_id, board_name, days_back,
clients_config)` or `fetch_monday.fetch_all_boards(config)`. They handle auth,
pagination, and subitems already. `fetch_monday.py` contains exactly one write
function, `set_monday_status_done()` — NEVER call it, import it, or reference it.

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

Fetch through the repo's existing fetcher via Bash:
`fetch_fireflies.fetch_transcripts(days_back=N)` where N covers from
`state.lastCheckedISO` minus one day to now (compute N, round up, minimum 2).
It handles auth and pagination. No organizer or participant filter.

Keep only transcripts where the id is not already in `state.processedIds` **and**
`meeting_info.summary_status == "processed"`.

### A4 — WhatsApp

Fetch through the repo's existing fetcher via Bash:
`fetch_whatsapp.fetch_whatsapp(days_back=N, config=<config.json's parsed
content>)`, same N as A3. It reads the Drive folder at `whatsapp_drive_folder_id`
in config.json via `GOOGLE_SERVICE_ACCOUNT_JSON` — already a repo secret;
`standup.yml`/`daily-pulse.yml` use the same one for generate.py — and merges
in `inbox/whatsapp/` if present (it never is on a runner; Drive is the real
source). Returns `{chat_name: [{"datetime", "sender", "text"}, ...]}`.

**This was silently broken from the 2026-08-18 port until 2026-09-02 — twice
over.** The Drive mechanism above already existed and generate.py already
used it successfully; the port's A4 never called it at all, AND
`draft-queue.yml` never had `GOOGLE_SERVICE_ACCOUNT_JSON` in its `env:`
block either. Fixing the wiring fixed this one instance, not the mechanism:
`fetch_whatsapp_drive` used to return `{}` on ANY failure, including a
missing folder id or a missing secret — a broken fetch and a genuinely
quiet week produced the exact same `{}`, which is what let the gap run 34
days unnoticed. It no longer does. A missing/broken folder id or secret,
or an outright auth/listing failure against Drive, now raises
`fetch_whatsapp.WhatsAppConfigError` — **let it propagate. Do not catch it
and continue.** Treat it exactly like A0's preflight failure: stop the
entire run, do not proceed to A5, report the exact error as the thing that
matters. A per-file problem (one corrupt zip, one undecodable export) is
NOT this — `fetch_whatsapp_drive` still only warns and skips that one file,
same as always, and the run continues normally with whatever else came
back. The three WhatsApp-sourced cards still in the queue from before the
port (7/13, 7/23, 7/30) were the only evidence this ever ran before today.

For each chat, keep only messages with `datetime` after
`state.whatsappHighWaterMark.get(chat_name)` (absent/null = every message in
the window is new — a chat appearing for the first time). Treat each chat's
surviving messages as one unit, same as a transcript, and feed it into A5
alongside the Fireflies transcripts, oldest first by earliest new message.

### A5 — relevance, routing, audit

For each transcript and each WhatsApp chat's new-message batch (A3 + A4 combined), oldest first:

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
unambiguously names that client.

**Not a signed client → prospect, not a card.** Daily Ops shows live clients
only; an unsigned prospect belongs on Standup's own `potential_clients` view
(`site/latest.json`), which `generate.py` already builds independently from the
same Fireflies transcripts this run reads. Don't set `potentialClient` and don't
draft a card for it — same disposition as a `done = ___` filter failure:
Notes/FYI in the run summary, nothing written to the queue. (Until 2026-09-02
this branch instead drafted an `unmapped-client` card, which is why four
dental-prospect discovery calls — Elgin Dental Implants, Dilan Talsida, Waise
Ebrahimi, Steve Esposito — sat as Daily Ops noise instead of showing up where
they already belonged, on Standup.)

`group` is the canonical client name from `drafting-rules.md`'s Client group IDs
table, or it is null. Never `"n/a"`, never `""`, never any other placeholder —
seven live cards carried the literal string `"n/a"` in July and rendered as a
phantom client on Daily Ops. Never the raw title you happened to read off
whichever board's group you audited, either — Quality HVAC's own group reads
"Quality HVAC by FIbid" on CRM/Web+SEO and "Quality HVAC" on Ads/Video, same
client, and copying the board's title verbatim split it into two Daily Ops
buckets (8 cards vs 3, live 2026-09-02). `validate.py`'s `build_card()` resolves
both cases (placeholder → null, raw title → canonical) as a backstop, but if
you find yourself about to write either, the real problem is upstream — go
back and resolve it there instead of relying on the backstop.

(Prospect dismissal is Standup's own concern now, not this run's — nothing
here reads or writes prospect state anymore. A converted prospect becomes
visible through the ordinary routing path above the moment content
unambiguously names them as a real client.)

**Mandatory board audit (§19) — never skipped, never deferred.** For every
candidate, check the relevant groups across **all four boards** using
`fetch_monday.fetch_board()` output (it already includes subitems). Subitems are
exactly where duplicates and already-finished work hide. Fetch each board once and
reuse the result across candidates — do not refetch per candidate. Outcomes:

- already fully covered → `status: 'exists'`, no payload, don't flag for review
- belongs under an existing parent → `create_subitem` with the real `parentItemId`
- better as a note on an existing item → `update_only` with the real `existingItemId`
- nothing matching anywhere → `create_item`

Skip the audit only for `potentialClient` cards — there's no roster group to audit
against, which is why they're flagged rather than drafted.

**Pending-queue audit (§19b) — runs immediately after §19, before A6.** §19 only
ever checks Monday. It never checks the queue it's about to write into, so two
calls about the same work can each pass a clean §19 audit and still produce two
cards — see `drafting-rules.md` §19b for the live example. For every candidate
that survived §19, read `checks/draft-queue.json` and call
`validate.find_pending_queue_match()` against every NON-TERMINAL card (`ready`,
`confirm`, `blocked`, `exists`; never `sent`/`done`/`ignored`). Full matching
rules, merge mechanics, and the conflict case are in `drafting-rules.md` §19b —
read it before drafting, same as §19. On a match:

- **axis 1/2 (same item, or same parent + overlapping subject)** — merge, don't
  create. Build the merged card with `validate.build_merged_card()`, passing the
  matched card as `existing` so `id`/`createdAt`/board/group carry over untouched
  and the new source gets appended onto `sourceLabel` instead of replacing it.
- **axis 3 (same client, similar work)** — lowest confidence, flag don't merge:
  draft normally but note the sibling card's id in the card's `note`.
- **the two sources disagree** — merge via `build_merged_card()` with
  `status='confirm'`, `null_reason='content-conflict'`, payload `None`, and a note
  stating both positions with their dates/sources.

A card produced this way still goes through A6/A7 exactly like a fresh one —
`build_merged_card()` calls `validate_payload()` internally, so a bad merged
payload still fails loud as a `parse-error` card rather than shipping.

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

Leave the payload null only for: `multi-item` (genuinely 2+ separate Monday items)
or `content-conflict` (a fact only Naz can resolve). Routing or mode uncertainty is
**not** a valid null reason — the A5 audit resolves it. `unmapped-client` is no
longer a valid reason to draft a card at all — see A5's Routing: an unsigned
prospect gets Notes/FYI in the summary, never a card, live or null-payload.

`sourceLabel` format: `"Meeting with {Client}, {M/D}"` for a single-client meeting,
`"Meeting: {short title}, {M/D}"` for internal or multi-client, `"WhatsApp: {Client
or chat name}, {M/D}"` for a WhatsApp-sourced card. Plain language only — never
"backfill sweep" or raw transcript/chat-export jargon in anything Naz reads.

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
`lastCheckedISO` to now, set `whatsappHighWaterMark[chat_name]` to the latest
`datetime` seen this run for every chat A4 returned anything for (leave chats
not seen this run untouched), save.

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

Across all four boards, using the same `fetch_monday.fetch_board()` results
(columns included), flag:

- items and subitems with a timeline ending in the next 3 days
- anything currently **Stuck**
- anything whose last activity is more than 5 business days old and not Done

Group by client, skip clients with nothing to flag. This goes in the run summary
only — never pushed to the queue or the page.

**Queue health, same idea.** Using the queue already read in A2, flag any
NON-TERMINAL card (`ready`/`confirm`/`blocked`/`exists`) whose `payload` is
`null` and whose `createdAt` is more than 3 days old (same threshold Daily
Ops's own age badge uses, `FO_STALE_DAYS` in `site/addon.js`) — it can never
be sent as-is, and nothing else points that out. Name the id, `nullReason`,
and age for each. This is exactly the gap that let four `parse-error` cards
from the 8/10-8/13 run sit unfireable for 14 days with nothing flagging
them: the fail-loud status worked, the surfacing didn't exist. This check is
what provides it now.

---

## Run summary

If A0's preflight failed, or A4 raised `WhatsAppConfigError`, that is the only
thing worth saying. Say it, say state was left untouched, stop. Both are the
same class of failure: the mechanism is broken, not just quiet, and burying
that inside a normal-looking summary is exactly how the 34-day WhatsApp gap
went unnoticed.

Otherwise, tight and scannable, no preamble:

1. Any parse-error cards from A6, first.
2. `drafting-rules.md` version used — one line, every run, no exceptions.
3. **JOB A** — meetings AND WhatsApp chats processed, drafts produced, clarified
   cards finalized and their outcomes. Any §19b merges or content-conflict cards,
   naming the card id(s) involved. If A4 genuinely found zero new WhatsApp
   messages, say so as an empty window, not a silent line item — a
   fetch/credential failure never reaches this point at all (see the stop
   condition above). One line if nothing new.
4. **JOB B** — what needs attention today, by client, plus any stuck queue
   cards (no payload, 3+ days old) named by id. One sentence if nothing.
5. Archive count, if A9 ran.
6. Whether the push succeeded and whether state was committed or left untouched.
