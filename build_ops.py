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
import re
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


def active_ad_slugs(config: dict) -> dict:
    """config.ops.ad_slugs without clients whose every slug is active:false in clients.json."""
    inactive = {e.get("slug") for e in (load(Path("clients.json")) or []) if e.get("active") is False}
    return {client: slugs for client, slugs in ((config.get("ops") or {}).get("ad_slugs") or {}).items()
            if any(s not in inactive for s in slugs)}


def main() -> None:
    config = json.loads(Path("config.json").read_text())
    config.setdefault("ops", {})["ad_slugs"] = active_ad_slugs(config)
    ops = config.get("ops") or {}
    inactive_clients = [
        e["name"] for e in (load(Path("clients.json")) or [])
        if e.get("active") is False and "name" in e
    ]
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "settings": {"quiet_days": ops.get("quiet_days", 14),
                     "quiet_days_ongoing": ops.get("quiet_days_ongoing", 30),
                     "recent_days": ops.get("recent_days", 30),
                     "not_clients": ops.get("not_clients") or [],
                     "inactive_clients": inactive_clients,
                     "boards": {str(b["id"]): b["name"] for b in config.get("boards") or []}},
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
    add_context(config, hub, ops.get("recent_days", 30))
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

    disc = load(Path("series/_gbp_discovery.json")) or {}
    for client, slugs in (ops.get("ad_slugs") or {}).items():
        merged, prof_daily, found, kind, long_hist = {}, {}, [], "leads", True
        # every listing configured for this client, named from clients.json first
        lab = {}
        for slug in slugs:
            for l in disc.get("listings") or []:
                if l.get("slug") == slug:
                    lab[l["id"]] = l.get("title") or l["id"]
            gmb = ((cfg.get(slug) or {}).get("windsor") or {}).get("google_my_business") or []
            for lid in (gmb.get("accounts") or [] if isinstance(gmb, dict) else gmb):
                lab.setdefault(lid, lid)
            lab.update((cfg.get(slug) or {}).get("gbp_labels") or {})
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
                for pid, name in (hist.get("profile_labels") or {}).items():
                    if lab.get(pid, pid) == pid:
                        lab[pid] = name
                for r in hist["rows"]:
                    row = merged.setdefault(r["date"], {k: 0.0 for k in SERIES})
                    for k in SERIES:
                        row[k] += float(r.get(k) or 0)
                    for pid, vals in (r.get("gbp_by_profile") or {}).items():
                        p = prof_daily.setdefault(pid, {})
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
                pid = prof.get("account_id") or prof.get("label")
                profiles.append({"id": pid, **{key: prof.get(key) for key in PROFILE_KEYS}})
            tc = w.get("top_campaign")
            if tc and tc.get("spend") and (not top or tc["spend"] > top["spend"]):
                top = tc
            g = pulse.get("ghl")
            if isinstance(g, dict) and not g.get("error") and (cfg.get(slug) or {}).get("ghl_location_id"):
                opps = g.get("opportunities") or {}
                crm = {"contacts": g.get("contacts"), "opps_created": (opps.get("created") or {}).get("count"),
                       "opps_won": (opps.get("won") or {}).get("count"), "opps_won_value": (opps.get("won") or {}).get("value"),
                       "appointments": g.get("appointments"), "window_days": pulse.get("window_days")}
                recon = (pulse.get("reconciliation") or {}).get("windsor_leads")
        if merged:
            global_end = max(global_end, max(merged))
        sources = sorted({k for slug in slugs for k in ((cfg.get(slug) or {}).get("windsor") or {})
                          if not k.endswith("_field") and not k.endswith("_fields")})
        staged[client] = dict(labels=lab, merged=merged, prof_daily=prof_daily, found=found, kind=kind, days=186 if (long_hist and found) else 28,
                              channels=channels, profiles=profiles, top=top, crm=crm, recon=recon, sources=sources,
                              results=load(Path("results") / f"{slugs[0]}.json") if slugs else None)

    for client, st in staged.items():
        merged, n = st["merged"], st["days"]
        end = max(merged) if merged else global_end
        dates = [_shift(end, -i) for i in range(n - 1, -1, -1)] if end else []
        zero = {k: 0.0 for k in SERIES}
        series = {k: [round((merged.get(d) or zero)[k], 2) for d in dates] for k in SERIES}
        # one row per listing, keyed by listing id; listings with no data still get a row
        lab = st["labels"]
        for pid in st["prof_daily"]:
            lab.setdefault(pid, pid)
        seen_names = {}
        for pid in sorted(lab, key=lambda x: str(lab[x]).lower()):
            seen_names.setdefault(lab[pid], []).append(pid)
        name_of = {pid: (lab[pid] if len(seen_names[lab[pid]]) == 1 else f"{lab[pid]} ({pid[-4:]})") for pid in lab}
        prof_series = [{"id": pid, "label": name_of[pid], "has_data": pid in st["prof_daily"],
                        **{k: [round((st["prof_daily"].get(pid, {}).get(d) or {}).get(k, 0)) for d in dates] for k in PROFILE_KEYS}}
                       for pid in sorted(lab, key=lambda x: name_of[x].lower())]
        profiles28 = [{"label": name_of.get(p["id"], p["id"]), **{k: p.get(k) for k in PROFILE_KEYS}} for p in st["profiles"]]
        have28 = {p["id"] for p in st["profiles"]}
        profiles28 += [{"label": name_of[pid], **{k: 0 for k in PROFILE_KEYS}, "no_data": True} for pid in lab if pid not in have28]
        meta_label = next((cfg[s_].get("meta_leads_label") for s_ in (ops.get("ad_slugs") or {}).get(client, [])
                           if (cfg.get(s_) or {}).get("meta_leads_label")), "leads")
        crm_name = next((cfg[s_].get("crm") for s_ in (ops.get("ad_slugs") or {}).get(client, []) if (cfg.get(s_) or {}).get("crm")), None)
        system = systems.get(client)
        out["clients"][client] = {
            "accounts": st["found"], "sources": st["sources"], "kind": st["kind"], "system": system,
            "meta_label": meta_label, "crm_system": "GHL" if any((cfg.get(s_) or {}).get("ghl_location_id") for s_ in (ops.get("ad_slugs") or {}).get(client, [])) else crm_name,
            "dates": dates, "series": series, "profiles_daily": prof_series,
            "channels": st["channels"], "top_campaign": st["top"], "profiles": profiles28,
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

# ── What the AI layers and the source list add to each client ──────────────
CONNECTOR_KEY = {"facebook": ("Meta Ads", "meta_spend"), "google_ads": ("Google Ads", "google_spend"),
                 "googleanalytics4": ("Google Analytics", "ga4_sessions"), "instagram": ("Instagram", "ig_reach"),
                 "searchconsole": ("Search Console", "sc_clicks"), "google_my_business": ("Google Business Profile", "gbp_actions")}
PROFILE_SUBJECTS = ("primary_contact", "intake_owner", "scope", "kpi", "crm_system", "booking_system", "contract_start", "contract_end")
PLAN_WORDS = ("sow", "milestone", "playbook", "phase 1", "standup card")


def _days_ago(stamp: str) -> int:
    try:
        d = datetime.fromisoformat(stamp.replace("Z", "+00:00")[:19])
        return (datetime.now() - d.replace(tzinfo=None)).days
    except (ValueError, AttributeError):
        return 9999


def _fact_out(f: dict) -> dict:
    return {"subject": f.get("subject"), "value": f.get("value"), "by": f.get("stated_by"), "at": (f.get("stated_at") or "")[:10],
            "where": f.get("chat") or f.get("source"), "excerpt": (f.get("excerpt") or "")[:280], "confidence": f.get("confidence")}


def add_context(config: dict, hub: dict, recent_days: int) -> None:
    ops = config.get("ops") or {}
    cfg = {c.get("slug"): c for c in (load(Path("clients.json")) or [])}
    disc = load(Path("series/_gbp_discovery.json")) or {}
    for client, c in hub["clients"].items():
        slugs = (ops.get("ad_slugs") or {}).get(client) or []
        name_slug = re.sub(r"[^a-z0-9]+", "-", client.lower()).strip("-")
        facts = next((f for f in (load(Path("facts") / f"{s}.json") for s in slugs + [name_slug]) if f), None)
        pulse = next((p for p in (load(Path("pulse") / f"{s}.json") for s in slugs) if p), None) or {}
        comms = next((x for x in (load(Path("comms") / f"{s}.json") for s in slugs) if x), None) or {}

        # account facts (latest stated value per subject) and recent decisions, commitments, blockers
        by_id = {f["id"]: f for f in (facts or {}).get("facts") or []}
        cur = (facts or {}).get("current") or {}
        c["profile"] = {k: _fact_out(by_id[cur[k]]) for k in PROFILE_SUBJECTS if cur.get(k) in by_id}
        said = [f for f in by_id.values() if f.get("subject") in ("decision", "commitment", "blocker")
                and not f.get("superseded_by") and _days_ago(f.get("stated_at") or "") <= recent_days]
        c["said"] = [_fact_out(f) for f in sorted(said, key=lambda f: f.get("stated_at") or "", reverse=True)[:10]]

        # AI read of the numbers: only fresh, only findings about the data (not plan/playbook claims)
        perf = pulse.get("performance") or {}
        ai = None
        if perf.get("generated_at") and _days_ago(perf["generated_at"]) <= 7:
            plan = lambda t: any(w in (t or "").lower() for w in PLAN_WORDS)
            # Google profile data lands ~4 days late, so "0 in the last few days" is a reporting gap, not a drop.
            lag = lambda f: str(f.get("channel", "")).lower() in ("gbp", "organic", "google_my_business") and re.search(
                r"collapsed to 0|\b0\b[^.]*\b(last|past) \d+ days|(last|past) \d+ days[^.]*\b0\b", f.get("text") or "", re.I)
            fnd = [f for f in perf.get("findings") or [] if not plan(f.get("text")) and not lag(f)
                   and str(f.get("channel", "")).lower() not in ("sow", "plan")]
            ids = {f.get("id") for f in fnd}
            sug = [x for x in perf.get("suggestions") or [] if not plan(x.get("text")) and (not x.get("cites") or ids & set(x["cites"]))]
            ai = {"at": perf["generated_at"][:10], "next_check": perf.get("next_check"),
                  "findings": [{k: f.get(k) for k in ("id", "text", "confidence", "channel", "priority")} for f in fnd],
                  "suggestions": [{k: x.get(k) for k in ("text", "type", "cites")} for x in sug]}
        c["ai"] = ai

        # client threads waiting on us, last 14 days only
        c["threads"] = [{"chat": t.get("chat"), "at": (t.get("last_at") or "")[:10], "text": (t.get("last_text") or "")[:200],
                         "hours": round(t.get("unanswered_hours") or 0)} for t in comms.get("threads") or []
                        if t.get("state") == "awaiting_flow" and _days_ago(t.get("last_at") or "") <= 14]

        # sources: what is connected and whether it is actually sending data
        dates, series = c.get("dates") or [], c.get("series") or {}
        tail = lambda key: [d for d, v in zip(dates, series.get(key) or []) if v > 0]
        conns = sorted({k for s in slugs for k in ((cfg.get(s) or {}).get("windsor") or {}) if k in CONNECTOR_KEY}
                       | ({"google_my_business"} if c.get("profiles_daily") else set()))
        errs = []
        for s_ in slugs:
            p_ = load(Path("pulse") / f"{s_}.json") or {}
            h_ = load(Path("series") / f"{s_}.json") or {}
            errs += [dict(e, where="28-day pull") for e in ((p_.get("windsor") or {}).get("errors") or [])]
            errs += [dict(e, where="186-day history") for e in (h_.get("errors") or [])]
        uniq = {}
        for e in errs:
            uniq.setdefault((e.get("connector"), tuple(e.get("accounts") or []), (e.get("message") or "")[:80]), e)
        errs = list(uniq.values())
        windsor = []
        for k in conns:
            label, key = CONNECTOR_KEY[k]
            hits = tail(key)
            err = next((e["message"] for e in errs if e.get("connector") in (k, "all") and (k != "google_my_business" or e.get("connector") == "all")), None)
            windsor.append({"name": label, "last": hits[-1] if hits else None, "total_28": round(sum((series.get(key) or [])[-28:])), "error": err})
        labels = {}
        for s in slugs:
            labels.update((cfg.get(s) or {}).get("gbp_labels") or {})
        for l in disc.get("listings") or []:
            if l.get("slug") in slugs:
                labels.setdefault(l["id"], l.get("title") or l["id"])
        daily = {p["id"]: p for p in c.get("profiles_daily") or []}
        prof28 = {p["label"]: p for p in c.get("profiles") or []}
        listings = []
        for lid, label in labels.items():
            p = daily.get(lid) or prof28.get(label)
            if p and p.get("has_data") is False:
                p = None
            if p and daily.get(lid):
                label = daily[lid]["label"]
            total = (sum(sum(p[k][-28:]) for k in ("calls", "directions", "web_clicks")) if p and isinstance(p.get("calls"), list)
                     else (sum(p.get(k) or 0 for k in ("calls", "directions", "web_clicks")) if p else 0))
            views = (sum(p["impressions"][-28:]) if p and isinstance(p.get("impressions"), list) else (p or {}).get("impressions") or 0)
            lerr = next((e["message"] for e in errs if e.get("connector") == "google_my_business" and lid in (e.get("accounts") or [])), None)
            listings.append({"id": lid, "label": label, "actions_28": round(total), "views_28": round(views), "has_data": bool(p), "error": lerr})
        first = cfg.get(slugs[0]) if slugs else None
        c["source_list"] = {
            "windsor": windsor, "listings": listings,
            "ghl": {"configured": bool(first and first.get("ghl_location_id")), "data": bool(c.get("crm")),
                    "error": (pulse.get("ghl") or {}).get("error") if isinstance(pulse.get("ghl"), dict) else None,
                    "crm": "GHL" if (first and first.get("ghl_location_id")) else (first or {}).get("crm")},
            "errors": errs,
            "chats": ((facts or {}).get("last_processed_at") or {}).get("whatsapp"),
            "meetings": ((facts or {}).get("last_processed_at") or {}).get("fireflies"),
            "facts": len(by_id), "playbook": any((Path("playbooks") / f"{s}.md").exists() for s in slugs + [name_slug]),
        }
    add_week(config, hub)
    hub["unlinked_listings"] = [l for l in disc.get("listings") or [] if not l.get("slug")]
    hub["discovery_ok"] = disc.get("ok")


# ── Quiet this week: no Monday activity, chats, meetings or Done items in 7 days ──
def _stamp_days(stamp) -> int:
    return _days_ago(str(stamp or "")[:19]) if stamp else 9999


def add_week(config: dict, hub: dict) -> None:
    ops = config.get("ops") or {}
    snap = load(Path("site/monday-items.json")) or {}
    meetings = (load(Path("facts/_meetings.json")) or {}).get("meetings") or []
    shipped = shipped_events(7)
    for client, c in hub["clients"].items():
        slugs = (ops.get("ad_slugs") or {}).get(client) or []
        items = 0
        for it in (snap.get("by_client") or {}).get(client) or []:
            stamps = [it.get(k) for k in ("item_updated_at", "updated_at", "last_activity", "created_at")]
            stamps += [u.get("date") for u in it.get("recent_updates") or []]
            for sub in it.get("subitems") or []:
                stamps += [sub.get(k) for k in ("updated_at", "created_at")] + [u.get("date") for u in sub.get("recent_updates") or []]
            if min((_stamp_days(x) for x in stamps if x), default=9999) <= 7:
                items += 1
        chats = 0
        for s_ in slugs:
            comms = load(Path("comms") / f"{s_}.json") or {}
            chats += sum(1 for t in comms.get("threads") or [] if _stamp_days(t.get("last_at")) <= 7)
        mtgs = sum(1 for m in meetings if m.get("client") == client and _stamp_days(m.get("date")) <= 7)
        done = sum(1 for e in shipped if e.get("client") == client)
        c["week"] = {"monday_items": items, "chat_threads": chats, "meetings": mtgs, "done": done,
                     "quiet": not (items or chats or mtgs or done)}


if __name__ == "__main__":
    main()
