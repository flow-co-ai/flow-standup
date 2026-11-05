# Flow Ops (flow-standup)

The internal ops dashboard at **flowco-ops.netlify.app**. One page, `site/index.html`, answers three things per client: is the work moving (Monday), is the money working (ads and organic), and what is waiting on us (WhatsApp). Nothing on the page calls an API when you open it except the passcode-gated live Monday read, Ask and Tasks. Everything else is read from files written once a day.

## The daily pipeline

One workflow, `.github/workflows/daily-pulse.yml`, runs at 12:00 UTC (6 am Chicago in winter, 7 am in summer). Each step reads only what the steps above it wrote.

| # | Step | Script | Writes | Model calls |
|---|------|--------|--------|-------------|
| 1 | Playbooks from Drive | `sync_playbooks.py` | `playbooks/[slug].md` | none |
| 2 | Monday snapshot | `write_monday_snapshot.py` | `site/monday-items.json` | none |
| 3 | Ads, organic, GHL (28 days) | `pulse.js` + `fetch_windsor.js` + `fetch_ghl.js` | `pulse/[slug].json`, `history/[slug].json` | none |
| 4 | 186-day history (last 35 days re-pulled daily, full pull Sundays), Google listing discovery | `build_history.js` | `series/[slug].json` | none |
| 5 | Account facts from WhatsApp + Fireflies | `build_facts.py` | `facts/[slug].json` | yes |
| 6 | WhatsApp threads, "waiting on us" | `build_comms.py` | `comms/[slug].json` | none |
| 7 | Weekly rundown, Monday update archive, Done log (Mondays only) | `generate.py` | `site/latest.json`, `standups/`, `archive/` | yes |
| 8 | AI read of the numbers (every 3 days per client, or on a flag) | `apply_performance.js` | `pulse/[slug].json` → `performance` | yes |
| 9 | Weekly client report (Mondays) | `apply_reporter.js` | `reports/[slug].json` | yes |
| 10 | Ops page data | `build_ops.py` | `site/ops.json`, `site/hub.json` | none |
| 11 | Scope block | `build_contracts.py` | `site/contracts.json` | none |
| 12 | Commit and push | | | |

If the push can't land, the run fails red. A green check means today's data is on `main`.

Other workflows: `draft-queue.yml` (15:00 UTC, the Tasks drafter, writes to the `state` branch), `backfill.yml` (manual only).

Manual run options on Daily Pulse: **rundown** forces the weekly AI rundown, **full_history** re-pulls all 186 days.

## Where each part of the page comes from

| On the page | Source file | Written by |
|---|---|---|
| Client list, Monday rows, shipped | `site/monday-items.json`, `site/ops.json` | steps 2, 10 + Monday webhook |
| Paid and Organic numbers, every Google listing | `site/hub.json` | step 10 from `pulse/` and `series/` |
| Leads | Meta's result for the client (`meta_leads_field`: leads, calls or conversations) **plus Google Ads conversions**, including LSA | `fetch_windsor.js` |
| Google LSA | Google Ads campaigns of type LOCAL_SERVICES, shown as their own Paid row. Needs the client's LSA account linked to their Google Ads account | `fetch_windsor.js` |
| CRM tab | CRM board items with their latest update, plus GHL counts for GHL clients | step 10 |
| AI read | `pulse/[slug].json` → `performance`, shown if under 7 days old | step 8 |
| Account facts, "said in chats" | `facts/[slug].json` | step 5 |
| Waiting on us | `comms/[slug].json`, last 14 days | step 6 |
| Quiet this week | no Monday activity, WhatsApp thread, meeting or Done item in 7 days | step 10 |
| Scope / budget pace | `site/contracts.json` from `contracts/[slug].json` (edited by hand) | step 11 |
| Sources page, connector errors | `pulse/*.windsor.errors`, `series/*.errors`, `pulse/*.ghl.error` | steps 3, 4 |

## Connector errors

A connector that fails (expired access, revoked listing, bad token) is written to the pulse file with the message the platform returned. It shows on the Sources page under **Connector errors**, as a red cell in the source table, and as a next step on the client. It never shows as a zero.

## Clients

- `clients.json`: one entry per slug. `active: false` removes a client everywhere. Windsor account IDs, `gbp_labels` (listing names shown on the page), `meta_leads_field` and `meta_leads_label`, `ghl_location_id` (blank if the client isn't on GHL), `crm` (e.g. `"Zoho CRM"` for JCL).
- `config.json` → `clients`: name aliases used to match Monday groups, chats and meetings.
- `config.json` → `ops.ad_slugs`: the one Monday-name → slug map. Steel Round Bars is one Monday group over three slugs.
- `config.json` → `team` and `team_phones`: who counts as Flow in WhatsApp. Add a teammate's name exactly as it shows in the chat export (any script), or their number's digits if it shows unsaved.
- `config.json` → `model`: the one Claude model setting for every script and function. `ANTHROPIC_MODEL` (env) overrides it.

## Adding a client

1. Playbook in the Drive playbooks folder (`.md`, Google Doc or `.html`). It syncs to `playbooks/[slug].md`.
2. A group for the client on the Monday boards; items named the way the playbook names them.
3. `clients.json` entry, an alias list in `config.json` → `clients`, and the slugs in `config.json` → `ops.ad_slugs`.
4. `contracts/[slug].json` with term, budget, what we run and what we don't.
5. GHL clients: a sub-account Private Integration token (read: contacts, opportunities, calendars, calendar events) saved as the GitHub secret `GHL_TOKEN_[SLUG]` (e.g. `GHL_TOKEN_SENIOR_INSURANCE`), then add that secret to the "Pull ads, organic and GHL numbers" step in `daily-pulse.yml`. The older `GHL_TOKENS` JSON map still works.
6. Run Daily Pulse from the Actions tab and check the Sources page.

## Secrets

`WINDSOR_API_KEY`, `MONDAY_API_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `FIREFLIES_API_KEY`, `ANTHROPIC_API_KEY`, `GH_STATE_TOKEN`, `GHL_TOKENS`, `GHL_TOKEN_[SLUG]`. Netlify: `OPS_PASSCODE`, `GH_STATE_TOKEN`, `MONDAY_API_TOKEN`, `ANTHROPIC_API_KEY`, `FIREFLIES_API_KEY`.

## Retired (Nov 2026)

The old standup grid, the Performance, Timeline and Daily Ops pages, cards, workstreams, the 0-100 score, the daily verdict and the ops-pulse brief, plus the Full Smile and Healing Helps clients. Their scripts, functions and data were removed. The Tasks tab on the main page is the only drafting surface; it uses `queue`, `send-to-monday`, `retry-monday-assignment` and `item-chat`, which route into the Monday groups listed in `netlify/functions/lib/monday.js` (`CLIENT_GROUPS`, keep `drafter/validate.py` and `rules/drafting-rules.md` in sync with it).
