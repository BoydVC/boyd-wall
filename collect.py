#!/usr/bin/env python3
"""Boyd Wall collector: fetches public, no-key data sources, caches each one on disk,
and assembles a single wall.json. Every source carries a status block so the UI can
show "live", "cached (stale)", or "data unavailable". Nothing is ever invented.

Stdlib only. Run directly for a one-shot collect: python3 collect.py [--force]
"""
import datetime as dt
import glob
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "data", "cache")
IMG = os.path.join(HERE, "data", "img")
CFG = json.load(open(os.path.join(HERE, "config.json")))
ET = ZoneInfo(CFG.get("timezone", "America/New_York"))
UA = "BoydWall/1.0 (personal wall display; contact: none)"
os.makedirs(CACHE, exist_ok=True)
os.makedirs(IMG, exist_ok=True)


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def parse_iso(s):
    if not s:
        return None
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    if re.match(r".*T\d\d:\d\d\+", s):  # ESPN "2026-10-12T00:20Z" -> no seconds
        s = s.replace("+", ":00+", 1) if s.count(":") == 2 else s
    try:
        t = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t


# ----------------------------------------------------------------------------------- cache
def _cpath(name):
    return os.path.join(CACHE, name + ".json")


def cache_read(name):
    try:
        with open(_cpath(name)) as f:
            return json.load(f)
    except Exception:
        return None


def cache_write(name, payload):
    tmp = _cpath(name) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, _cpath(name))


_BACKOFF_FILE = os.path.join(CACHE, "_backoff.json")
try:
    _backoff = json.load(open(_BACKOFF_FILE))  # host -> epoch until which we must not call
except Exception:  # noqa: BLE001
    _backoff = {}


def _set_backoff(host, until):
    _backoff[host] = until
    try:
        json.dump(_backoff, open(_BACKOFF_FILE, "w"))
    except Exception:  # noqa: BLE001
        pass


def http_json(url, timeout=20):
    host = url.split("/")[2]
    if _backoff.get(host, 0) > time.time():
        raise RuntimeError(f"{host} rate-limited, retry in {int(_backoff[host] - time.time())}s")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/geo+json, application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            ra = e.headers.get("Retry-After") or "300"
            try:
                wait = int(float(ra))
            except ValueError:
                wait = 300
            body = ""
            try:
                body = e.read().decode("utf-8", "ignore")[:200]
            except Exception:  # noqa: BLE001
                pass
            if "Daily" in body or "daily" in body:  # Open-Meteo's free daily quota resets at 00:00 UTC
                tomorrow = (now_utc() + dt.timedelta(days=1)).replace(hour=0, minute=2, second=0, microsecond=0)
                _set_backoff(host, tomorrow.timestamp())
                raise RuntimeError(f"{host}: daily free quota used up on this network; retrying after 00:00 UTC")
            _set_backoff(host, time.time() + wait + 5)
            raise RuntimeError(f"HTTP 429 (rate limited) from {host}; retry after {wait}s")
        raise RuntimeError(f"HTTP {e.code} from {host}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"{host} unreachable: {e.reason}")


def cached_fetch(name, url, ttl, force=False, timeout=20):
    """Return (data, status). Uses the disk cache when fresh; refetches when stale;
    on failure falls back to the last good copy and says so."""
    c = cache_read(name)
    if c and c.get("url") and c["url"] != url:  # config changed: the cached copy is for a different query
        c = None
    age = time.time() - c["fetchedAt"] if c else None
    if c and not force and age < ttl:
        return c["data"], {"state": "live", "fetchedAt": c["fetchedAt"], "url": url, "error": None}
    try:
        data = http_json(url, timeout=timeout)
        cache_write(name, {"fetchedAt": time.time(), "url": url, "data": data})
        return data, {"state": "live", "fetchedAt": time.time(), "url": url, "error": None}
    except Exception as e:  # noqa: BLE001
        if c:
            return c["data"], {"state": "stale", "fetchedAt": c["fetchedAt"], "url": url, "error": str(e)}
        return None, {"state": "unavailable", "fetchedAt": None, "url": url, "error": str(e)}


def cache_image(url, max_bytes=600_000):
    """Download an image once into data/img and return its local /img/ path (or None)."""
    if not url:
        return None
    ext = os.path.splitext(url.split("?")[0])[1].lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"):
        ext = ".img"
    fn = hashlib.sha1(url.encode()).hexdigest()[:16] + ext
    p = os.path.join(IMG, fn)
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return "/img/" + fn
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=15) as r:
            b = r.read(max_bytes + 1)
        if len(b) > max_bytes:
            return None
        with open(p, "wb") as f:
            f.write(b)
        return "/img/" + fn
    except Exception:  # noqa: BLE001
        return None


# ------------------------------------------------------------------------------ Jim's notes
def jim_notes():
    """Headlines from Jim's newest Interest Journal research file (bold lead-ins only)."""
    files = sorted(glob.glob(CFG["researchGlob"]))
    if not files:
        return {"file": None, "date": None, "space": [], "sports": {}}
    path = files[-1]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    date = re.search(r"ij_(\d{4}-\d\d-\d\d)", path).group(1)
    sections = re.split(r"^## ", text, flags=re.M)
    space, sports = [], {}

    def clean(s):
        s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
        return s.replace("**", "").strip().rstrip(":").strip()

    for sec in sections:
        title = sec.split("\n", 1)[0]
        if re.match(r"A\.", title):
            group = None
            for line in sec.splitlines():
                m = re.match(r"^\*\*([^*]+)\*\*\s*$", line.strip())
                if m:
                    group = m.group(1)
                    continue
                m = re.match(r"^- \*\*(.+?)\*\*(.*)$", line.strip())
                if m and group and re.search(r"SpaceX|Starlink|Starship", group):
                    rest = clean(m.group(2))
                    rest = re.split(r"(?<=[.!?])\s+", rest)
                    space.append({"group": group, "text": clean(m.group(1)), "detail": " ".join(rest[:2])[:260]})
        if re.match(r"B\.", title):
            team = None
            for line in sec.splitlines():
                m = re.match(r"^\*\*([^*]+)\*\*", line.strip())
                if m and not line.strip().startswith("-"):
                    head = m.group(1)
                    for k, pat in (("ravens", "Ravens"), ("orioles", "Orioles"), ("terps", "Terps|Maryland"), ("chelsea", "Chelsea")):
                        if re.search(pat, head):
                            team = k
                            sports.setdefault(team, {"heading": clean(head), "items": []})
                    continue
                m = re.match(r"^- \*\*(.+?)\*\*(.*)$", line.strip())
                if m and team:
                    head, rest = clean(m.group(1)), re.split(r"(?<=[.!?])\s+", clean(m.group(2)))
                    if re.match(r"(Mostly repeats|No new|Quiet)", head) and rest and rest[0]:
                        head = " ".join(rest[:2])
                    elif len(head) < 60 and rest and rest[0]:
                        head = f"{head.rstrip('.')}: {rest[0]}"
                    if len(head) > 230:
                        head = head[:230].rsplit(" ", 1)[0].rstrip(",;:") + "…"
                    sports[team]["items"].append(head)
    space = [n for n in space if not re.match(r"(No follow-up|Quiet|Nothing new)", n.get("detail") or "")]
    return {"file": os.path.basename(path), "date": date, "space": space[:10], "sports": sports}


# ----------------------------------------------------------------------------------- SpaceX
def _launch(r):
    lsp = (r.get("launch_service_provider") or {}).get("name")
    rc = (r.get("rocket") or {}).get("configuration") or {}
    pad = r.get("pad") or {}
    mission = r.get("mission") or {}
    img = r.get("image") or {}
    if isinstance(img, str):
        img = {"image_url": img}
    stage = None
    for s in ((r.get("rocket") or {}).get("launcher_stage") or []):
        lnd = s.get("landing") or {}
        stage = {
            "serial": (s.get("launcher") or {}).get("serial_number"),
            "flightNo": s.get("launcher_flight_number"),
            "landing": (lnd.get("location") or {}).get("abbrev") or (lnd.get("type") or {}).get("abbrev"),
            "landingOk": lnd.get("success"),
            "landingAttempt": lnd.get("attempt"),
        }
        break
    vids = [v.get("url") for v in (r.get("vid_urls") or []) if v.get("url")]
    return {
        "id": r.get("id"),
        "name": r.get("name"),
        "mission": mission.get("name") or (r.get("name") or "").split("|")[-1].strip(),
        "missionType": mission.get("type"),
        "orbit": (mission.get("orbit") or {}).get("abbrev"),
        "description": (mission.get("description") or "")[:320],
        "rocket": rc.get("full_name") or rc.get("name"),
        "provider": lsp,
        "net": r.get("net"),
        "windowStart": r.get("window_start"),
        "windowEnd": r.get("window_end"),
        "precision": (r.get("net_precision") or {}).get("name"),
        "status": (r.get("status") or {}).get("abbrev"),
        "statusName": (r.get("status") or {}).get("name"),
        "probability": r.get("probability"),
        "weatherConcerns": r.get("weather_concerns"),
        "pad": pad.get("name"),
        "location": (pad.get("location") or {}).get("name"),
        "image": img.get("thumbnail_url") or img.get("image_url"),
        "imageFull": img.get("image_url"),
        "webcastLive": r.get("webcast_live"),
        "vid": vids[0] if vids else None,
        "stage": stage,
        "failReason": r.get("failreason") or None,
        "imageCredit": img.get("credit"),
        "lastUpdated": r.get("last_updated"),
    }


def collect_spacex(force=False):
    base, aid, ttl = CFG["ll2Base"], CFG["ll2SpaceXAgencyId"], CFG["ttl"]
    up, s_up = cached_fetch("ll2_upcoming", f"{base}/launches/upcoming/?limit=12&lsp__id={aid}&mode=normal", ttl["ll2_upcoming"], force, 75)
    prev, s_prev = cached_fetch("ll2_previous", f"{base}/launches/previous/?limit=10&lsp__id={aid}&mode=normal", ttl["ll2_previous"], force, 75)
    ss, s_ss = cached_fetch("ll2_starship", f"{base}/dashboard/starship/", ttl["ll2_starship"], force, 75)
    upcoming = [_launch(r) for r in (up or {}).get("results", [])]
    previous = [_launch(r) for r in (prev or {}).get("results", [])]
    # Hero image for the next launch, cached locally so the wall and the snapshot work offline.
    for L in upcoming[:1] + previous[:1]:
        L["imageLocal"] = cache_image(L.get("image"))
    starship = None
    if ss:
        upc = (ss.get("upcoming") or {})
        prv = (ss.get("previous") or {})
        bynet = lambda xs, rev: sorted(xs, key=lambda L: L.get("net") or "", reverse=rev)
        bydate = lambda xs, rev: sorted(xs, key=lambda e: e.get("date") or "", reverse=rev)
        active = []
        for v in (ss.get("vehicles") or []):  # boosters (launchers)
            stn = ((v.get("status") or {}).get("name") or "") if isinstance(v.get("status"), dict) else str(v.get("status") or "")
            if stn.lower() == "active" and not v.get("is_placeholder"):
                active.append(v.get("serial_number"))
        for o in (ss.get("orbiters") or []):  # ships (spacecraft)
            stn = ((o.get("status") or {}).get("name") or "") if isinstance(o.get("status"), dict) else str(o.get("status") or "")
            if stn.lower() == "active" and not o.get("is_placeholder"):
                active.append(o.get("serial_number") or o.get("name"))
        updates = sorted(ss.get("updates") or [], key=lambda u: u.get("created_on") or "", reverse=True)
        prev_l = [_launch(r) for r in bynet(prv.get("launches") or [], True)]
        starship = {
            "upcomingLaunches": [_launch(r) for r in bynet(upc.get("launches") or [], False)][:3],
            "previousLaunches": prev_l[:3],
            "flightsLogged": len(prev_l),
            "successes": sum(1 for L in prev_l if (L.get("status") or "").lower() == "success"),
            "upcomingEvents": [{"name": e.get("name"), "date": e.get("date"), "type": (e.get("type") or {}).get("name"), "location": e.get("location")} for e in bydate(upc.get("events") or [], False)][:4],
            "previousEvents": [{"name": e.get("name"), "date": e.get("date"), "type": (e.get("type") or {}).get("name")} for e in bydate(prv.get("events") or [], True)][:3],
            "updates": [{"text": (u.get("comment") or "")[:220], "date": u.get("created_on"), "url": u.get("info_url")} for u in updates[:3]],
            "liveStreams": [{"title": s.get("title"), "url": s.get("url")} for s in (ss.get("live_streams") or [])][:2],
            "roadClosures": [{"title": c.get("title"), "start": c.get("window_start"), "end": c.get("window_end"), "status": (c.get("status") or {}).get("name")} for c in (ss.get("road_closures") or [])][:4],
            "notices": [{"type": (n.get("type") or {}).get("name"), "date": n.get("date"), "url": n.get("url")} for n in (ss.get("notices") or [])][:3],
            "activeHardware": [a for a in active if a][:10],
        }
    # Starship launches can also simply appear in the SpaceX upcoming list.
    ss_in_list = [L for L in upcoming if "Starship" in (L.get("rocket") or "") or "Starship" in (L.get("name") or "")]
    return {
        "upcoming": upcoming,
        "previous": previous,
        "starship": starship,
        "starshipInList": ss_in_list[:2],
        "status": {"upcoming": s_up, "previous": s_prev, "starship": s_ss},
        "attribution": "Launch Library 2 by The Space Devs (ll.thespacedevs.com), free tier",
    }


# ------------------------------------------------------------------------------------ sports
ESPN = "https://site.api.espn.com/apis/site/v2/sports"


def _score(c):
    s = c.get("score")
    if isinstance(s, dict):
        return s.get("displayValue")
    return s


def _event(e, team_abbr, sport):
    c = e["competitions"][0]
    st = c["status"]["type"]
    comps = c["competitors"]
    me = next((x for x in comps if x["team"].get("abbreviation") == team_abbr), comps[0])
    opp = next((x for x in comps if x is not me), comps[-1])
    tv = []
    for b in c.get("broadcasts") or []:
        n = (b.get("media") or {}).get("shortName") or ", ".join(b.get("names") or [])
        if n and n not in tv:
            tv.append(n)
    result = None
    if st.get("completed"):
        ms, os_ = _score(me), _score(opp)
        try:
            a, b = int(float(ms)), int(float(os_))
            result = "W" if a > b else "L" if a < b else "D" if sport == "soccer" else "T"
        except (TypeError, ValueError):
            result = "W" if me.get("winner") else "L" if opp.get("winner") else None
    venue = (c.get("venue") or {})
    return {
        "id": e.get("id"),
        "date": e.get("date"),
        "timeValid": c.get("timeValid", True),
        "name": e.get("name"),
        "short": e.get("shortName"),
        "home": me.get("homeAway") == "home",
        "neutral": c.get("neutralSite", False),
        "opp": opp["team"].get("displayName"),
        "oppShort": opp["team"].get("shortDisplayName") or opp["team"].get("displayName"),
        "oppAbbr": opp["team"].get("abbreviation"),
        "oppLogo": ((opp["team"].get("logos") or [{}])[0].get("href")) or opp["team"].get("logo"),
        "state": st.get("state"),  # pre / in / post
        "statusDetail": st.get("shortDetail") or st.get("detail"),
        "completed": st.get("completed"),
        "score": _score(me),
        "oppScore": _score(opp),
        "result": result,
        "tv": tv[:3],
        "venue": venue.get("fullName"),
        "city": ((venue.get("address") or {}).get("city")),
        "competition": (e.get("league") or {}).get("abbreviation") or (e.get("league") or {}).get("name") or ((e.get("seasonType") or {}).get("name")),
        "week": (e.get("week") or {}).get("text"),
    }


def _standings_rows(node, out):
    if "standings" in node:
        out.append({"group": node.get("name") or node.get("abbreviation"), "entries": node["standings"].get("entries", [])})
    for ch in node.get("children", []) or []:
        _standings_rows(ch, out)


def _stat(entry, *names):
    for s in entry.get("stats", []):
        if s.get("name") in names or s.get("type") in names or s.get("abbreviation") in names:
            return s.get("displayValue")
    return None


def team_standings(t, force):
    summary_override = None
    sd = t.get("standings")
    if not sd:
        return None, None
    data, status = cached_fetch(f"espn_standings_{t['key']}", sd["url"], CFG["ttl"]["espn"] * 2, force)
    if not data:
        return None, status
    groups = []
    _standings_rows(data, groups)
    rows = []
    if t["key"] == "ravens":
        div = next((g for g in groups if (g["group"] or "") == sd["group"]), None)
        ents = (div or {}).get("entries", [])
        for e in ents:
            rows.append({"team": e["team"].get("shortDisplayName") or e["team"]["displayName"], "abbr": e["team"].get("abbreviation"),
                         "rec": _stat(e, "overall") or f"{_stat(e, 'wins')}-{_stat(e, 'losses')}", "div": _stat(e, "divisionRecord"),
                         "streak": _stat(e, "streak"), "pct": float(_stat(e, "winPercent") or 0), "seed": _stat(e, "playoffSeed"),
                         "me": e["team"].get("abbreviation") == t["abbr"]})
        rows.sort(key=lambda r: int(r["seed"] or 99))
        cols = ["W-L", "DIV", "STRK"]
        for r in rows:
            r["cells"] = [r["rec"], r["div"], r["streak"]]
        # Derived, not invented: position in ESPN's own division table, with ties called out.
        me = next((i for i, r in enumerate(rows) if r["me"]), None)
        if me is not None and rows:
            ahead_same = [r for r in rows[:me] if r["rec"] == rows[me]["rec"]]
            pos = me + 1 - len(ahead_same)
            tied = any(r["rec"] == rows[me]["rec"] for j, r in enumerate(rows) if j != me)
            rank_word = {1: "1st", 2: "2nd", 3: "3rd"}.get(pos, f"{pos}th")
            summary_override = f"{'T-' if tied else ''}{rank_word} in {sd['label']}" + (f" (tiebreak: {rows[0]['abbr']})" if tied and me > 0 and pos == 1 else "")
    elif t["key"] == "chelsea":
        g = groups[0] if groups else {"entries": []}
        for e in g["entries"]:
            rows.append({"rank": int(_stat(e, "rank") or 0), "team": e["team"].get("shortDisplayName") or e["team"]["displayName"], "abbr": e["team"].get("abbreviation"),
                         "cells": [_stat(e, "gamesPlayed"), _stat(e, "pointDifferential"), _stat(e, "points")],
                         "me": e["team"].get("abbreviation") == t["abbr"]})
        rows.sort(key=lambda r: r["rank"])
        idx = next((i for i, r in enumerate(rows) if r["me"]), 0)
        lo = max(0, min(idx - 3, len(rows) - 7))
        top = rows[:1] if lo > 0 else []
        rows = top + rows[lo:lo + 7]
        cols = ["P", "GD", "PTS"]
    else:  # Big Ten: keep ESPN's own row order (its playoffSeed field is unreliable mid-season); no invented ranks
        g = groups[0] if groups else {"entries": []}
        ranked = []
        for e in g["entries"]:
            ranked.append({"team": e["team"].get("shortDisplayName") or e["team"]["displayName"], "abbr": e["team"].get("abbreviation"),
                           "cells": [_stat(e, "vs. Conf.", "vsconf"), _stat(e, "overall", "total")],
                           "me": e["team"].get("abbreviation") == t["abbr"]})
        idx = next((i for i, r in enumerate(ranked) if r["me"]), 0)
        if idx <= 4:
            rows = ranked[:6]
        else:
            rows = ranked[:3] + [{"gap": True}] + ranked[idx - 1:idx + 2]
        cols = ["CONF", "OVR"]
    return {"label": sd["label"], "cols": cols, "rows": rows, "summary": summary_override}, status


def _game_window(name):
    """True if a cached schedule has a game starting soon or in progress (refresh faster then)."""
    c = cache_read(name)
    if not c:
        return False
    now = now_utc()
    for e in (c.get("data") or {}).get("events", []):
        t = parse_iso(e.get("date"))
        if t and now - dt.timedelta(hours=4) < t < now + dt.timedelta(minutes=15):
            return True
    return False


def collect_team(t, force=False):
    ttl = CFG["ttl"]["espn"]
    if any(_game_window(f"espn_{t['key']}_{k}") for k in ("schedule", "fixtures", "results")):
        ttl = CFG["ttl"]["espn_live"]
    out = {k: t.get(k) for k in ("key", "name", "full", "abbr", "colors", "sport", "league")}
    url = f"{ESPN}/{t['sport']}/{t['league']}/teams/{t['teamId']}/schedule"
    if t.get("sport") == "soccer":
        fix, s1 = cached_fetch(f"espn_{t['key']}_fixtures", url + "?fixture=true", ttl, force)
        res, s2 = cached_fetch(f"espn_{t['key']}_results", f"{ESPN}/{t['sport']}/{t.get('allCompsLeague', t['league'])}/teams/{t['teamId']}/schedule", ttl, force)
        info = (fix or res or {}).get("team", {})
        events = [_event(e, t["abbr"], t["sport"]) for e in (fix or {}).get("events", []) + (res or {}).get("events", [])]
        status = s1 if s1["state"] != "live" else s2
    elif t.get("offseason"):
        tm, status = cached_fetch(f"espn_{t['key']}_team", f"{ESPN}/{t['sport']}/{t['league']}/teams/{t['teamId']}", ttl * 4, force)
        info = (tm or {}).get("team", {})
        rec = ((info.get("record") or {}).get("items") or [{}])[0].get("summary")
        info = dict(info, recordSummary=rec)
        events = []
    else:
        sch, status = cached_fetch(f"espn_{t['key']}_schedule", url, ttl, force)
        info = (sch or {}).get("team", {})
        events = [_event(e, t["abbr"], t["sport"]) for e in (sch or {}).get("events", [])]
    seen, evs = set(), []
    for e in sorted(events, key=lambda e: e["date"] or ""):
        if e["id"] in seen:
            continue
        seen.add(e["id"])
        evs.append(e)
    now = now_utc()
    live = [e for e in evs if e["state"] == "in"]
    nxt = [e for e in evs if e["state"] == "pre" and (parse_iso(e["date"]) or now) > now - dt.timedelta(hours=6)]
    done = [e for e in evs if e["completed"]]
    logo = ((info.get("logos") or [{}])[0].get("href")) or info.get("logo")
    out.update({
        "record": info.get("recordSummary"),
        "standingSummary": info.get("standingSummary"),
        "logo": cache_image(logo),
        "live": live[:1],
        "next": nxt[:3],
        "last": list(reversed(done[-4:])),
        "status": status,
        "source": "ESPN public site API (site.api.espn.com)",
    })
    for e in out["next"][:2] + out["last"][:1] + out["live"]:
        e["oppLogoLocal"] = cache_image(e.get("oppLogo"))
    st, sst = team_standings(t, force)
    out["standings"], out["standingsStatus"] = st, sst
    if st and st.get("summary") and st["summary"] != out.get("standingSummary"):
        out["espnSummary"] = out.get("standingSummary")
        out["standingSummary"] = st["summary"]
    return out


def collect_sports(force=False):
    teams = []
    for t in CFG["teams"]:
        try:
            teams.append(collect_team(t, force))
        except Exception as e:  # noqa: BLE001
            teams.append({"key": t["key"], "name": t["name"], "full": t["full"], "colors": t["colors"], "status": {"state": "unavailable", "error": str(e)}})
    # Verified fallback game list from Bot Island's config (hand-checked times with sources).
    bi = {}
    try:
        bi = json.load(open(os.path.join(CFG["botIslandDir"], "config.json")))
    except Exception:  # noqa: BLE001
        pass
    return {"teams": teams, "verifiedGames": bi.get("gameDays", []), "verifiedCheckedAt": bi.get("gameDaysCheckedAt"), "notes": bi.get("gameNotes", [])}


# ----------------------------------------------------------------------------------- weather
WMO = {0: ("Clear", "☀️", "🌙"), 1: ("Mostly clear", "🌤️", "🌙"), 2: ("Partly cloudy", "⛅", "☁️"), 3: ("Overcast", "☁️", "☁️"),
       45: ("Fog", "🌫️", "🌫️"), 48: ("Rime fog", "🌫️", "🌫️"), 51: ("Light drizzle", "🌦️", "🌧️"), 53: ("Drizzle", "🌦️", "🌧️"),
       55: ("Heavy drizzle", "🌧️", "🌧️"), 56: ("Freezing drizzle", "🌧️", "🌧️"), 57: ("Freezing drizzle", "🌧️", "🌧️"),
       61: ("Light rain", "🌦️", "🌧️"), 63: ("Rain", "🌧️", "🌧️"), 65: ("Heavy rain", "🌧️", "🌧️"), 66: ("Freezing rain", "🌧️", "🌧️"),
       67: ("Freezing rain", "🌧️", "🌧️"), 71: ("Light snow", "🌨️", "🌨️"), 73: ("Snow", "🌨️", "🌨️"), 75: ("Heavy snow", "❄️", "❄️"),
       77: ("Snow grains", "🌨️", "🌨️"), 80: ("Showers", "🌦️", "🌧️"), 81: ("Showers", "🌧️", "🌧️"), 82: ("Violent showers", "⛈️", "⛈️"),
       85: ("Snow showers", "🌨️", "🌨️"), 86: ("Snow showers", "🌨️", "🌨️"), 95: ("Thunderstorm", "⛈️", "⛈️"), 96: ("Thunderstorm, hail", "⛈️", "⛈️"),
       99: ("Thunderstorm, hail", "⛈️", "⛈️")}


def collect_weather(force=False):
    loc = CFG["location"]
    url = ("https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
           "&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation"
           "&hourly=temperature_2m,precipitation_probability,weather_code,is_day"
           "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max"
           "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FNew_York&forecast_days=7").format(**loc)
    data, status = cached_fetch("openmeteo", url, CFG["ttl"]["weather"], force)
    aq, aqs = cached_fetch("openmeteo_aq", "https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lat}&longitude={lon}&current=us_aqi,pm2_5&timezone=America%2FNew_York".format(**loc), CFG["ttl"]["weather"] * 3, force)
    out = {"location": loc["name"], "status": status, "aqStatus": aqs, "source": "Open-Meteo (open-meteo.com), no key"}
    om_age = time.time() - (status.get("fetchedAt") or 0)
    if not data or (status["state"] == "stale" and om_age > 3600):  # Open-Meteo down or >1 h stale: use the NWS
        nws = collect_nws(force)
        if nws:
            nws["primaryError"] = status.get("error")
            if aq:
                nws["aqi"] = (aq.get("current") or {}).get("us_aqi")
            nws["aqStatus"] = aqs
            return nws
        return out
    off = data.get("utc_offset_seconds", -14400)
    sign = "-" if off < 0 else "+"
    tz = f"{sign}{abs(off) // 3600:02d}:{abs(off) % 3600 // 60:02d}"
    withtz = lambda s: (s + ":00" + tz) if s and len(s) == 16 else s  # "2026-10-07T16:00" -> "...T16:00:00-04:00"
    cur = data.get("current", {})
    code = cur.get("weather_code")
    w = WMO.get(code, ("—", "🌡️", "🌡️"))
    out["current"] = {
        "time": withtz(cur.get("time")), "temp": cur.get("temperature_2m"), "feels": cur.get("apparent_temperature"), "humidity": cur.get("relative_humidity_2m"),
        "wind": cur.get("wind_speed_10m"), "gust": cur.get("wind_gusts_10m"), "windDir": cur.get("wind_direction_10m"), "precip": cur.get("precipitation"),
        "code": code, "text": w[0], "icon": w[1] if cur.get("is_day", 1) else w[2], "isDay": cur.get("is_day"),
    }
    h = data.get("hourly", {})
    nowl = dt.datetime.now(ET).strftime("%Y-%m-%dT%H:00")
    times = h.get("time", [])
    i0 = next((i for i, t in enumerate(times) if t >= nowl), 0)
    out["hourly"] = [{"time": withtz(times[i]), "temp": h["temperature_2m"][i], "pop": h["precipitation_probability"][i],
                      "icon": WMO.get(h["weather_code"][i], ("", "🌡️", "🌡️"))[1 if h["is_day"][i] else 2]} for i in range(i0, min(i0 + 24, len(times)))]
    d = data.get("daily", {})
    out["daily"] = [{"date": d["time"][i], "hi": d["temperature_2m_max"][i], "lo": d["temperature_2m_min"][i], "pop": d["precipitation_probability_max"][i],
                     "text": WMO.get(d["weather_code"][i], ("—", "🌡️"))[0], "icon": WMO.get(d["weather_code"][i], ("", "🌡️"))[1],
                     "sunrise": withtz(d["sunrise"][i]), "sunset": withtz(d["sunset"][i]), "uv": d["uv_index_max"][i]} for i in range(len(d.get("time", [])))]
    if aq:
        out["aqi"] = (aq.get("current") or {}).get("us_aqi")
        out["pm25"] = (aq.get("current") or {}).get("pm2_5")
    return out


NWS_UA = {"User-Agent": "BoydWall/1.0 (personal wall display)", "Accept": "application/geo+json"}


def _nws_icon(text, is_day=True):
    t = (text or "").lower()
    for k, d, n in (("thunder", "⛈️", "⛈️"), ("snow", "🌨️", "🌨️"), ("sleet", "🌧️", "🌧️"), ("rain", "🌧️", "🌧️"), ("shower", "🌦️", "🌧️"),
                    ("drizzle", "🌦️", "🌧️"), ("fog", "🌫️", "🌫️"), ("haze", "🌫️", "🌫️"), ("mostly cloudy", "🌥️", "☁️"), ("overcast", "☁️", "☁️"),
                    ("cloudy", "☁️", "☁️"), ("partly", "⛅", "☁️"), ("mostly sunny", "🌤️", "🌙"), ("mostly clear", "🌤️", "🌙"),
                    ("sunny", "☀️", "🌙"), ("clear", "☀️", "🌙"), ("fair", "☀️", "🌙")):
        if k in t:
            return d if is_day else n
    return "🌡️"


def collect_nws(force=False):
    """Fallback weather: National Weather Service api.weather.gov (US government, no key)."""
    loc = CFG["location"]
    ttl = CFG["ttl"]["weather"]
    pt, s0 = cached_fetch("nws_point", f"https://api.weather.gov/points/{loc['lat']},{loc['lon']}", 86400 * 7, force)
    if not pt:
        return None
    pr = pt["properties"]
    fc, s1 = cached_fetch("nws_forecast", pr["forecast"], ttl * 3, force)
    hr, s2 = cached_fetch("nws_hourly", pr["forecastHourly"], ttl * 2, force)
    st_id = loc.get("nwsStation", "KBWI")
    ob, s3 = cached_fetch("nws_obs", f"https://api.weather.gov/stations/{st_id}/observations/latest", ttl, force)
    if not (fc or hr):
        return None
    out = {"location": loc["name"], "status": dict(s2 if hr else s1, note="Open-Meteo unavailable; using National Weather Service"),
           "source": "National Weather Service (api.weather.gov), no key", "provider": "nws"}
    hours = (hr or {}).get("properties", {}).get("periods", [])
    now = now_utc()
    hours = [h for h in hours if (parse_iso(h["endTime"]) or now) > now][:24]
    c2f = lambda c: None if c is None else round(c * 9 / 5 + 32, 1)
    op = (ob or {}).get("properties") or {}
    ob_t = parse_iso(op.get("timestamp"))
    h0 = hours[0] if hours else {}
    if op.get("temperature", {}).get("value") is not None and ob_t and now - ob_t < dt.timedelta(hours=2):
        temp = c2f(op["temperature"]["value"])
        feels_c = (op.get("heatIndex") or {}).get("value") or (op.get("windChill") or {}).get("value")
        text = op.get("textDescription") or h0.get("shortForecast")
        wind = op.get("windSpeed", {}).get("value")
        cur = {"time": op.get("timestamp"), "temp": temp, "feels": c2f(feels_c) if feels_c is not None else temp,
               "humidity": round(op.get("relativeHumidity", {}).get("value") or 0) or None,
               "wind": round(wind * 0.621371) if wind is not None else None, "windDir": op.get("windDirection", {}).get("value"),
               "text": text, "isDay": 1 if h0.get("isDaytime", True) else 0, "station": st_id}
    else:
        cur = {"time": h0.get("startTime"), "temp": h0.get("temperature"), "feels": h0.get("temperature"),
               "humidity": (h0.get("relativeHumidity") or {}).get("value"), "wind": (h0.get("windSpeed") or "").split(" ")[0],
               "text": h0.get("shortForecast"), "isDay": 1 if h0.get("isDaytime", True) else 0, "station": "hourly forecast"}
    cur["icon"] = _nws_icon(cur["text"], cur["isDay"])
    out["current"] = cur
    out["hourly"] = [{"time": h["startTime"], "temp": h["temperature"], "pop": (h.get("probabilityOfPrecipitation") or {}).get("value") or 0,
                      "icon": _nws_icon(h.get("shortForecast"), h.get("isDaytime"))} for h in hours]
    days = {}
    for p in (fc or {}).get("properties", {}).get("periods", []):
        d = p["startTime"][:10]
        e = days.setdefault(d, {"date": d, "hi": None, "lo": None, "pop": 0, "text": None, "icon": None})
        if p.get("isDaytime"):
            e["hi"], e["text"], e["icon"] = p["temperature"], p["shortForecast"], _nws_icon(p["shortForecast"])
        else:
            e["lo"] = p["temperature"]
            if not e["text"]:
                e["text"], e["icon"] = p["shortForecast"], _nws_icon(p["shortForecast"], False)
        e["pop"] = max(e["pop"], (p.get("probabilityOfPrecipitation") or {}).get("value") or 0)
        if p.get("isDaytime") and not e.get("detail"):
            e["detail"] = p.get("detailedForecast")
    # NWS night periods start on the day they begin; tonight's low belongs to today.
    out["daily"] = list(days.values())[:7]
    if out["daily"] and fc:
        out["todayDetail"] = fc["properties"]["periods"][0].get("detailedForecast")
        out["todayName"] = fc["properties"]["periods"][0].get("name")
    return out


# ------------------------------------------------------------------------------------- fleet
def _cron_field(f, lo, hi):
    vals = set()
    for part in f.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/")
            step = int(s)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a, b = map(int, part.split("-"))
        else:
            a = b = int(part)
        vals.update(range(a, b + 1, step))
    return vals


def cron_next(expr, after):
    """Next fire time (ET) for a 5-field cron (minute hour dom month dow). Good enough for routines."""
    try:
        m, h, dom, mon, dow = expr.split()
        M, H = _cron_field(m, 0, 59), _cron_field(h, 0, 23)
        D, MO = _cron_field(dom, 1, 31), _cron_field(mon, 1, 12)
        W = {d % 7 for d in _cron_field(dow, 0, 7)}
    except Exception:  # noqa: BLE001
        return None
    t = after.astimezone(ET).replace(second=0, microsecond=0) + dt.timedelta(minutes=1)
    for _ in range(0, 8 * 24 * 60):
        if t.minute in M and t.hour in H and t.day in D and t.month in MO and ((t.isoweekday() % 7) in W):
            return t
        t += dt.timedelta(minutes=1)
        if t.minute == 0 and t.hour not in H:  # skip whole hours quickly
            t += dt.timedelta(minutes=59)
    return None


def collect_fleet(force=False):
    src = CFG["botIslandUrl"]
    status = {"state": "live", "url": src + "/api/fleet", "error": None, "fetchedAt": time.time()}
    fleet = doctor = None
    try:
        fleet = http_json(src + "/api/fleet", timeout=8)
        cache_write("fleet", {"fetchedAt": time.time(), "data": fleet})
        try:
            doctor = http_json(src + "/api/doctor", timeout=8)
        except Exception:  # noqa: BLE001
            doctor = None
    except Exception as e:  # noqa: BLE001
        c = cache_read("fleet")
        if c:
            fleet, status = c["data"], {"state": "stale", "url": src, "error": str(e), "fetchedAt": c["fetchedAt"]}
        else:
            p = os.path.join(CFG["botIslandDir"], "data", "fleet.json")
            try:
                fleet = json.load(open(p))
                status = {"state": "stale", "url": p, "error": f"Bot Island API down ({e}); using its saved fleet.json", "fetchedAt": os.path.getmtime(p)}
            except Exception as e2:  # noqa: BLE001
                status = {"state": "unavailable", "url": src, "error": f"{e}; {e2}", "fetchedAt": None}
    now = now_utc()
    bots = []
    for b in (fleet or {}).get("bots", []):
        if b.get("name") in ("New Bot",):
            continue
        routines = [r for r in b.get("routines", []) if r.get("enabled")]
        nexts = []
        last_run = None
        running = None
        for r in b.get("routines", []):
            if r.get("lastRunAt"):
                lr = dt.datetime.fromtimestamp(r["lastRunAt"] / 1000, dt.timezone.utc)
                last_run = max(last_run, lr) if last_run else lr
                med = r.get("medianMinutes") or 10
                if r.get("enabled") and now - lr < dt.timedelta(minutes=max(5, med * 1.5)):
                    running = r["name"]
        for r in routines:
            n = cron_next(r["cron"], now)
            if n:
                nexts.append((n, r["name"]))
        nexts.sort()
        art = parse_iso(b.get("artifactUpdatedAt"))
        last_active = max([t for t in (last_run, art) if t], default=None)
        recent = last_active and now - last_active < dt.timedelta(minutes=10)
        state = "working" if running or recent else ("scheduled" if nexts else "idle")
        bots.append({
            "name": b["name"], "title": b.get("title") or "", "color": b.get("color"), "building": b.get("building"),
            "state": state, "doing": running or ("writing files" if recent else None),
            "next": iso(nexts[0][0]) if nexts else None, "nextName": nexts[0][1] if nexts else None,
            "routines": len(routines), "lastActive": iso(last_active),
        })
    order = {"working": 0, "scheduled": 1, "idle": 2}
    bots.sort(key=lambda x: (order[x["state"]], x["next"] or "9999"))
    doc = None
    if doctor:
        doc = {"score": doctor.get("score"), "counts": doctor.get("counts"),
               "top": [f.get("title") for f in (doctor.get("findings") or []) if f.get("severity") in ("high", "medium")][:5]}
    return {"bots": bots, "doctor": doc, "status": status, "source": "Bot Island (" + src + ")", "snapshotAt": (fleet or {}).get("generatedAt")}


def collect_usage():
    p = CFG["usageFile"]
    try:
        u = json.load(open(p))
        u["_mtime"] = os.path.getmtime(p)
        return {"data": u, "status": {"state": "live", "url": p, "error": None, "fetchedAt": os.path.getmtime(p)}}
    except Exception as e:  # noqa: BLE001
        return {"data": None, "status": {"state": "unavailable", "url": p, "error": str(e), "fetchedAt": None}}


# ---------------------------------------------------------------------------------- assemble
def collect(force=False, parts=("spacex", "sports", "weather", "fleet")):
    prev = cache_read("wall") or {}
    wall = dict(prev.get("data") or {})
    fns = {"spacex": collect_spacex, "sports": collect_sports, "weather": collect_weather, "fleet": collect_fleet}
    for k in parts:
        try:
            wall[k] = fns[k](force)
        except Exception as e:  # noqa: BLE001
            print(f"[collect] {k} failed: {e}", file=sys.stderr)
            wall.setdefault(k, {"status": {"state": "unavailable", "error": str(e)}})
    wall["usage"] = collect_usage()
    wall["jim"] = jim_notes()
    wall["generatedAt"] = iso(now_utc())
    wall["timezone"] = CFG["timezone"]
    wall["location"] = CFG["location"]
    cache_write("wall", {"fetchedAt": time.time(), "data": wall})
    return wall


if __name__ == "__main__":
    w = collect(force="--force" in sys.argv)
    def st(s):
        return f"{s.get('state')}{' (' + s['error'] + ')' if s.get('error') else ''}"
    print("spacex:", {k: st(v) for k, v in w["spacex"]["status"].items()}, len(w["spacex"]["upcoming"]), "upcoming", len(w["spacex"]["previous"]), "previous")
    for t in w["sports"]["teams"]:
        print(t["name"], st(t["status"]), t.get("record"), t.get("standingSummary"), "next:", [(e["short"], e["date"]) for e in t.get("next", [])][:1], "last:", [(e["short"], e["score"], e["oppScore"], e["result"]) for e in t.get("last", [])][:1])
    print("weather:", st(w["weather"]["status"]), w["weather"].get("current"))
    print("fleet:", st(w["fleet"]["status"]), len(w["fleet"]["bots"]), "bots", w["fleet"].get("doctor", {}) and w["fleet"]["doctor"].get("score"))
    print("jim:", w["jim"]["file"], len(w["jim"]["space"]), list(w["jim"]["sports"].keys()))
