#!/usr/bin/env python3
"""Unit tests for the collector (stdlib unittest). Uses a temp cache dir; makes no network calls
except where a test explicitly simulates failure (which never touches the network)."""
import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import collect  # noqa: E402

ET = collect.ET


class CronTests(unittest.TestCase):
    def test_same_day(self):
        t = dt.datetime(2026, 10, 7, 16, 0, tzinfo=ET)
        self.assertEqual(collect.cron_next("45 17 * * *", t), dt.datetime(2026, 10, 7, 17, 45, tzinfo=ET))

    def test_weekday_rollover(self):
        fri = dt.datetime(2026, 10, 9, 9, 0, tzinfo=ET)  # Friday after the run
        self.assertEqual(collect.cron_next("0 8 * * 1-5", fri), dt.datetime(2026, 10, 12, 8, 0, tzinfo=ET))

    def test_hour_list_sunday(self):
        sat = dt.datetime(2026, 10, 10, 20, 0, tzinfo=ET)
        self.assertEqual(collect.cron_next("0 11,15 * * 0", sat), dt.datetime(2026, 10, 11, 11, 0, tzinfo=ET))

    def test_bad_expr(self):
        self.assertIsNone(collect.cron_next("not a cron", dt.datetime.now(ET)))


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.old = collect.CACHE
        collect.CACHE = self.tmp
        self.real_http = collect.http_json

    def tearDown(self):
        collect.CACHE = self.old
        collect.http_json = self.real_http
        shutil.rmtree(self.tmp)

    def _fail(self, *a, **k):
        raise RuntimeError("simulated outage")

    def test_unavailable_without_cache(self):
        collect.http_json = self._fail
        data, st = collect.cached_fetch("x", "https://example.invalid/a", 60)
        self.assertIsNone(data)
        self.assertEqual(st["state"], "unavailable")
        self.assertIn("simulated", st["error"])

    def test_stale_fallback(self):
        collect.cache_write("x", {"fetchedAt": 1, "url": "https://example.invalid/a", "data": {"v": 42}})
        collect.http_json = self._fail
        data, st = collect.cached_fetch("x", "https://example.invalid/a", 60)
        self.assertEqual(data, {"v": 42})
        self.assertEqual(st["state"], "stale")

    def test_fresh_cache_skips_network(self):
        import time
        collect.cache_write("x", {"fetchedAt": time.time(), "url": "https://example.invalid/a", "data": {"v": 1}})
        collect.http_json = self._fail  # would raise if called
        data, st = collect.cached_fetch("x", "https://example.invalid/a", 600)
        self.assertEqual(st["state"], "live")

    def test_url_change_invalidates(self):
        import time
        collect.cache_write("x", {"fetchedAt": time.time(), "url": "https://example.invalid/old", "data": {"v": 1}})
        collect.http_json = lambda url, timeout=20: {"v": 2}
        data, _ = collect.cached_fetch("x", "https://example.invalid/new", 600)
        self.assertEqual(data, {"v": 2})

    def test_spacex_all_sources_down_is_honest(self):
        collect.http_json = self._fail
        sp = collect.collect_spacex()
        self.assertEqual(sp["upcoming"], [])
        self.assertEqual(sp["previous"], [])
        self.assertIsNone(sp["starship"])
        self.assertTrue(all(v["state"] == "unavailable" for v in sp["status"].values()))

    def test_weather_all_down_has_no_numbers(self):
        collect.http_json = self._fail
        w = collect.collect_weather()
        self.assertNotIn("current", w)
        self.assertEqual(w["status"]["state"], "unavailable")


class ParseTests(unittest.TestCase):
    def test_event_result(self):
        e = {"id": "1", "date": "2026-10-04T17:00Z", "name": "TEN at BAL", "shortName": "TEN @ BAL",
             "competitions": [{"status": {"type": {"state": "post", "completed": True, "shortDetail": "Final"}},
                               "competitors": [{"homeAway": "home", "team": {"abbreviation": "BAL", "displayName": "Baltimore Ravens"}, "score": {"displayValue": "24"}},
                                               {"homeAway": "away", "team": {"abbreviation": "TEN", "displayName": "Tennessee Titans"}, "score": {"displayValue": "18"}}]}]}
        ev = collect._event(e, "BAL", "football")
        self.assertEqual((ev["result"], ev["score"], ev["oppScore"], ev["home"]), ("W", "24", "18", True))

    def test_soccer_draw(self):
        e = {"id": "2", "date": "2026-09-12T14:00Z", "competitions": [{"status": {"type": {"state": "post", "completed": True}},
             "competitors": [{"homeAway": "home", "team": {"abbreviation": "CHE", "displayName": "Chelsea"}, "score": "2"},
                             {"homeAway": "away", "team": {"abbreviation": "HUL", "displayName": "Hull"}, "score": "2"}]}]}
        self.assertEqual(collect._event(e, "CHE", "soccer")["result"], "D")

    def test_parse_espn_short_iso(self):
        self.assertEqual(collect.parse_iso("2026-10-12T00:20Z"), dt.datetime(2026, 10, 12, 0, 20, tzinfo=dt.timezone.utc))

    def test_jim_notes(self):
        j = collect.jim_notes()
        if j["file"]:
            self.assertIsInstance(j["space"], list)
            self.assertIn("date", j)


if __name__ == "__main__":
    unittest.main(verbosity=2)
