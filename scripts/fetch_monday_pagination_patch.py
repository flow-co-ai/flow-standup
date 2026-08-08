# PATCH for fetch_monday.py — fixes the second silent-miss bug: items_page was
# called with limit:100 and no cursor loop, so any board over 100 active items
# has items past #100 permanently invisible to every fetch (standup text,
# performance snapshot, completion detection — all of it). Combined with the
# archived-items gap (items_page also never returns archived items at all,
# regardless of pagination — see monday-done-webhook.js's comment for why that
# one needs a webhook, not a query fix), these two are why "Done" tracking has
# felt inconsistent.
#
# This patch does NOT fix the archived-items gap (that's structural to
# items_page and can't be fixed by paginating harder) — only the >100-items
# gap. The webhook covers the archived-items gap; this covers the
# more-than-100-items gap. Together they close both known holes.
#
# HOW TO APPLY: replace fetch_board()'s single query + single requests.post
# call with the version below. Everything after `raw_items = ...` (the
# per-item processing loop) is UNCHANGED — only how raw_items gets populated
# changes.

_BOARD_FRAGMENT = """
    cursor
    items {
      id
      name
      created_at
      group { id title }
      column_values {
        id
        text
        value
        type
      }
      subitems {
        id
        name
        board { id }
        column_values {
          id
          text
          value
          type
        }
        updates(limit: 25) {
          id
          body
          created_at
          creator_id
          creator { name }
          viewers { user_id }
        }
      }
      updates(limit: 25) {
        id
        body
        created_at
        creator_id
        creator { name }
        viewers { user_id }
      }
    }
"""

_QUERY_FIRST_PAGE = """
    query GetBoard($ids: [ID!]!) {
      boards(ids: $ids) {
        id
        name
        groups { id title }
        items_page(limit: 100) {
""" + _BOARD_FRAGMENT + """
        }
      }
    }
    """

_QUERY_NEXT_PAGE = """
    query GetBoardPage($ids: [ID!]!, $cursor: String!) {
      boards(ids: $ids) {
        id
        name
        items_page(limit: 100, cursor: $cursor) {
""" + _BOARD_FRAGMENT + """
        }
      }
    }
    """


def _fetch_all_items_paginated(board_id: str, headers: dict) -> list:
    """Loops items_page with cursor until exhausted. Replaces the single
    limit:100-and-done call — boards with >100 active items were silently
    truncating before this."""
    all_items = []
    cursor = None
    while True:
        if cursor:
            body = {"query": _QUERY_NEXT_PAGE, "variables": {"ids": [str(board_id)], "cursor": cursor}}
        else:
            body = {"query": _QUERY_FIRST_PAGE, "variables": {"ids": [str(board_id)]}}

        resp = requests.post(MONDAY_API_URL, headers=headers, json=body, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        if "errors" in payload:
            raise ValueError(f"Monday API errors: {payload['errors']}")

        page = payload["data"]["boards"][0]["items_page"]
        items = page.get("items") or []
        all_items.extend(items)

        cursor = page.get("cursor")
        if not cursor or not items:
            break

    return all_items


# Inside fetch_board(), replace the old single query + single requests.post
# call (that builds raw_items from payload["data"]["boards"][0]["items_page"]["items"])
# with:
#
#     raw_items = _fetch_all_items_paginated(board_id, headers)
#
# The old inline `query = """ ... """` string can be deleted — it's
# superseded by _QUERY_FIRST_PAGE / _QUERY_NEXT_PAGE at module level.
