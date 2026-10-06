"""
build_ops.py -- writes site/ops.json for the Ops page (site/index.html).

1. Ads: reads the Windsor daily series that pulse.js already saves in
   pulse/<slug>.json and reduces it to one fixed window for every client: the
   last 7 days in the series vs the 7 days before.
2. Shipped: copies recent "status changed to Done" events that the Monday
   webhook (netlify/functions/monday-done-webhook.js) records in
   standups/completed-accumulator.json. Only real webhook events (source MON,
   not generated) -- nothing inferred.

No model calls, no scoring, no wording.

Standard library only. Run after `node pulse.js`:  python build_ops.py
"""

import json
from datetime import datetime, timezone
from pathlib import Path

FIELDS = ("spend", "leads", "purchases", "revenue")


def load(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def daily_rows(pulse: dict) -> dict:
    """{date: {spend, leads, purchases, revenue}} from one pulse file."""
    series = ((pulse or {}).get("windsor") or {}).get("series") or {}
    dates = series.get("dates") or []
    rows = {}
    for i, d in enumerate(dates):
        rows[d] = {f: float((series.get(f) or [0] * len(dates))[i] or 0) for f in FIELDS}
    return rows


def window_sum(rows: dict, dates: list) -> dict:
    return {f: round(sum(rows.get(d, {}).get(f, 0) for d in dates), 2) for f in FIELDS}


def shipped_events(days: int = 14) -> list:
    acc = load(Path("standups/completed-accumulator.json")) or {}
    weeks = [{"items": acc.get("items") or []}] + list(acc.get("history") or [])
    cutoff = datetime.now(timezone.utc).date().toordinal() - days
    seen, out = set(), []
    for week in weeks:
        for e in week.get("items") or []:
            if e.get("source") != "MON" or e.get("generated") is True:
                continue
            date = (e.get("sourceDate") or "")[:10]
            try:
                if datetime.strptime(date, "%Y-%m-%d").date().toordinal() < cutoff:
                    continue
            except ValueError:
                continue
            key = e.get("monday_item_id") or e.get("text")
            if key in seen:
                continue
            seen.add(key)
            name = (e.get("text") or "").replace("Marked Done on Monday:", "").strip()
            out.append({"monday_item_id": e.get("monday_item_id"), "name": name,
                        "client": e.get("client"), "date": date})
    return sorted(out, key=lambda x: x["date"], reverse=True)


def main() -> None:
    config = json.loads(Path("config.json").read_text())
    ops = config.get("ops") or {}
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "settings": {"quiet_days": ops.get("quiet_days", 14),
                     "quiet_days_ongoing": ops.get("quiet_days_ongoing", 30),
                     "recent_days": ops.get("recent_days", 30)},
        "shipped": shipped_events(),
        "through": None,
        "window": None,
        "clients": {},
    }

    for client, slugs in (ops.get("ad_slugs") or {}).items():
        merged, kind, found = {}, "leads", []
        for slug in slugs:
            pulse = load(Path("pulse") / f"{slug}.json")
            if not pulse:
                continue
            found.append(slug)
            if pulse.get("type") == "ecom":
                kind = "sales"
            for d, vals in daily_rows(pulse).items():
                acc = merged.setdefault(d, {f: 0.0 for f in FIELDS})
                for f in FIELDS:
                    acc[f] += vals[f]

        dates = sorted(merged)[-28:]
        if len(dates) < 14:
            out["clients"][client] = {"kind": kind, "accounts": found, "has_paid": False}
            continue

        cur, prev = dates[-7:], dates[-14:-7]
        total_spend_28 = sum(merged[d]["spend"] for d in dates)
        out["clients"][client] = {
            "kind": kind,
            "accounts": found,
            "has_paid": total_spend_28 > 0,
            "through": cur[-1],
            "last_spend": max((d for d in dates if merged[d]["spend"] > 0), default=None),
            "cur": window_sum(merged, cur),
            "prev": window_sum(merged, prev),
            "daily": {
                "dates": dates,
                "spend": [round(merged[d]["spend"], 2) for d in dates],
                "results": [round(merged[d]["purchases" if kind == "sales" else "leads"], 2) for d in dates],
            },
        }
        # Every client shares the same window; record it once.
        if out["window"] is None or cur[-1] > out["through"]:
            out["through"] = cur[-1]
            out["window"] = {"cur": [cur[0], cur[-1]], "prev": [prev[0], prev[-1]]}

    Path("site").mkdir(exist_ok=True)
    Path("site/ops.json").write_text(json.dumps(out, indent=1))
    print(f"ops.json: {len(out['clients'])} ad clients through {out['through']}, "
          f"{len(out['shipped'])} Done events in the last 14 days")

    hub = build_hub(config)
    Path("site/hub.json").write_text(json.dumps(hub, separators=(",", ":")))
    print(f"hub.json: {len(hub['clients'])} clients, organic complete through {hub['complete_through']}")


# ── Client hub (site/hub.json): Paid, Organic, CRM per client ──────────────
# Daily series come from series/<slug>.json (186 days, written by
# build_history.js) when present, else the 28 days pulse.js keeps.
SERIES = ("spend", "leads", "purchases", "revenue", "meta_spend", "google_spend",
          "meta_leads", "meta_clicks", "google_conversions", "google_clicks",
          "gbp_actions", "sc_clicks", "ga4_sessions", "ig_reach")
LAGGED = ("gbp_actions", "sc_clicks", "ga4_sessions", "ig_reach")
PROFILE_KEYS = ("calls", "directions", "web_clicks", "impressions")


def _shift(day: str, n: int) -> str:
    return datetime.fromordinal(datetime.strptime(day, "%Y-%m-%d").toordinal() + n).strftime("%Y-%m-%d")


def build_hub(config: dict) -> dict:
    ops = config.get("ops") or {}
    systems = ops.get("systems") or {}
    cfg = {c.get("slug"): c for c in (load(Path("clients.json")) or [])}
    out = {"generated_at": datetime.now(timezone.utc).isoformat(), "complete_through": {}, "clients": {}}
    staged, global_end = {}, ""

    for client, slugs in (ops.get("ad_slugs") or {}).items():
        merged, prof_daily, found, kind, long_hist = {}, {}, [], "leads", True
        channels = {"meta": {"spend": 0, "leads": 0, "clicks": 0}, "google_ads": {"spend": 0, "conversions": 0, "clicks": 0}}
        profiles, top, crm, recon = [], None, None, None
        for slug in slugs:
            pulse = load(Path("pulse") / f"{slug}.json") or {}
            hist = load(Path("series") / f"{slug}.json")
            if not pulse and not hist:
                continue
            found.append(slug)
            if pulse.get("type") == "ecom" or (hist or {}).get("kind") == "sales":
                kind = "sales"
            if hist and len(hist.get("rows") or []) >= 28:
                labels = hist.get("profile_labels") or {}
                for r in hist["rows"]:
                    row = merged.setdefault(r["date"], {k: 0.0 for k in SERIES})
                    for k in SERIES:
                        row[k] += float(r.get(k) or 0)
                    for pid, vals in (r.get("gbp_by_profile") or {}).items():
                        p = prof_daily.setdefault(labels.get(pid, pid), {})
                        day = p.setdefault(r["date"], {k: 0.0 for k in PROFILE_KEYS})
                        for k in PROFILE_KEYS:
                            day[k] += float(vals.get(k) or 0)
            else:
                long_hist = False
                s = (pulse.get("windsor") or {}).get("series") or {}
                for i, d in enumerate(s.get("dates") or []):
                    row = merged.setdefault(d, {k: 0.0 for k in SERIES})
                    for k in SERIES:
                        vals = s.get(k) or []
                        row[k] += float(vals[i] or 0) if i < len(vals) else 0
            w = pulse.get("windsor") or {}
            by = (w.get("totals") or {}).get("byChannel") or {}
            for ch, keys in channels.items():
                for key in keys:
                    keys[key] += float((by.get(ch) or {}).get(key) or 0)
            for prof in (by.get("gbp") or {}).get("by_profile") or []:
                profiles.append({key: prof.get(key) for key in ("label",) + PROFILE_KEYS})
            tc = w.get("top_campaign")
            if tc and tc.get("spend") and (not top or tc["spend"] > top["spend"]):
                top = tc
            if isinstance(pulse.get("ghl"), dict):
                g = pulse["ghl"]
                opps = g.get("opportunities") or {}
                crm = {"contacts": g.get("contacts"), "opps_created": (opps.get("created") or {}).get("count"),
                       "opps_won": (opps.get("won") or {}).get("count"), "opps_won_value": (opps.get("won") or {}).get("value"),
                       "appointments": g.get("appointments"), "window_days": pulse.get("window_days")}
                recon = (pulse.get("reconciliation") or {}).get("windsor_leads")
        if merged:
            global_end = max(global_end, max(merged))
        sources = sorted({k for slug in slugs for k in ((cfg.get(slug) or {}).get("windsor") or {})
                          if not k.endswith("_field") and not k.endswith("_fields")})
        staged[client] = dict(merged=merged, prof_daily=prof_daily, found=found, kind=kind, days=186 if (long_hist and found) else 28,
                              channels=channels, profiles=profiles, top=top, crm=crm, recon=recon, sources=sources,
                              results=load(Path("results") / f"{slugs[0]}.json") if slugs else None)

    for client, st in staged.items():
        merged, n = st["merged"], st["days"]
        end = max(merged) if merged else global_end
        dates = [_shift(end, -i) for i in range(n - 1, -1, -1)] if end else []
        zero = {k: 0.0 for k in SERIES}
        series = {k: [round((merged.get(d) or zero)[k], 2) for d in dates] for k in SERIES}
        prof_series = [{"label": label, **{k: [round((days.get(d) or {}).get(k, 0)) for d in dates] for k in PROFILE_KEYS}}
                       for label, days in sorted(st["prof_daily"].items())]
        out["clients"][client] = {
            "accounts": st["found"], "sources": st["sources"], "kind": st["kind"], "system": systems.get(client),
            "dates": dates, "series": series, "profiles_daily": prof_series,
            "channels": st["channels"], "top_campaign": st["top"], "profiles": st["profiles"],
            "crm": st["crm"], "windsor_leads_28d": st["recon"], "results": st["results"],
        }
        for k in SERIES:
            last = max((d for d in dates if (merged.get(d) or zero)[k] > 0), default=None)
            if k in LAGGED:
                if last and last > (out["complete_through"].get(k) or ""):
                    out["complete_through"][k] = last
            elif dates:
                out["complete_through"][k] = dates[-1]
    return out

if __name__ == "__main__":
    main()
