# Workstreams layer

`build_workstreams.js` writes `workstreams/[slug].json` for every active client. One file per slug; Steel Round Bars writes identical data to `steel-forte`, `steel-advance`, and `steel-ohare`.

## Data sources

| What | File | Used for |
|---|---|---|
| Item list, status column | `site/monday-items.json` | Primary — every top-level item on a client's four boards |
| Comms timestamps | `site/inbox.json` | `last_movement` dates only |
| Completion dates | `standups/*.json` | `last_movement` + `done_count` via pulse URL |
| Manual overrides | `workstreams/[slug].manual.json` | See below |

Each top-level Monday item becomes one workstream candidate. Subitems are never workstreams — they roll into their parent (`subitem_count`, `subitem_done`). Items matching the record filter (meeting notes, check-ins, recaps, bare dates) are dropped before any other processing.

Names are normalized for cross-board dedup (lowercase, strip punctuation, strip trailing "ads"/"setup", collapse gerunds and plurals). When two items on different boards normalize to the same key they merge into one workstream; the longer original name wins and `boards` lists all boards.

## State field

Derived from the Monday Status column only — never from dates.

| Monday status | `state` |
|---|---|
| Done | `done` |
| Stuck | `blocked` |
| Working | `live` |
| In Review / Pending | `building` |
| Start / missing | `unknown` |

`⛔` in the item name overrides everything → `state: blocked`, `blocked_reason: "name"`. Stuck via status column → `blocked_reason: "status"`.

## Movement field

Derived from dates only — never from item status.

| Age of `last_movement` | `movement` |
|---|---|
| ≤ 7 days | `moved_7d` |
| 8–30 days | `slow_30d` |
| > 30 days or no date | `stale_30d_plus` |

## Cap rule

10 workstreams per client, board-balanced:

1. Blocked items fill first slots (all boards, sorted by movement recency).
2. Remaining slots fill by round-robin across Ads → CRM → Video → Web+SEO, most recent movement first per board, so each board gets one slot before any board takes a second.

Overflow is tracked in `hidden_by_board` (per-board counts) and `hidden_count` (total) in the JSON.

## Manual overrides

Place `workstreams/[slug].manual.json` next to the generated file:

```json
{
  "overrides": [
    { "match": "Exact Workstream Name", "rename": "New Name", "state": "blocked" }
  ],
  "add": [
    { "name": "New Workstream", "boards": ["CRM"], "state": "live", "movement": "moved_7d" }
  ]
}
```

`overrides` mutate a workstream matched by name; all fields except `match` and `rename` are merged in. `add` entries are prepended and evict any existing entry with the same name. Manual entries win outright.

## Current blocker

`site/monday-items.json` has never been generated. It is not gitignored and has never been committed. Run `python write_monday_snapshot.py` with `MONDAY_API_TOKEN` set to populate it. Until then `build_workstreams.js` warns and produces empty output.
