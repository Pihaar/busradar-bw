"""
Line Logger — Track HAFAS journey delays for a specific bus line.

Polls HAFAS for active vehicles of a target line, tracks each journey
until it disappears (= terminated), then writes a final snapshot to
a JSONL log file.

Output schema (one journey per line):
{
  "jid": str,
  "date": "YYYYMMDD",
  "line": "725",
  "direction": str,
  "first_seen_ts": float (unix),
  "last_seen_ts": float,
  "stops": [
    {"name": str, "extId": str, "platform": str,
     "dTimeS": "HHMMSS"|null, "dTimeR": "HHMMSS"|null,
     "aTimeS": "HHMMSS"|null, "aTimeR": "HHMMSS"|null,
     "delay_dep_min": int|null, "delay_arr_min": int|null}
  ]
}
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

HAFAS_ENDPOINT = "https://db-regio.hafas.de/bin/mgate.exe"
AUTH_AID = "FiBa5ytjCvR0J47P"

# Sandhausen center, 20km radius — covers line 725 (Ortsbus Sandhausen)
RING_CENTER = {"x": 8_660_000, "y": 49_342_000}
RING_RADIUS_M = 20_000

POLL_INTERVAL_SECONDS = 30
JOURNEY_GONE_GRACE_SECONDS = 180  # write final after this many seconds without sighting
TARGET_LINES = os.environ.get("LINE_LOGGER_LINES", "725").split(",")
TICK_STATE_FILE = Path(os.environ.get("BUSRADAR_TICK_STATE", "/var/lib/busradar/.tick_state"))

LOG_DIR = Path(os.environ.get("LINE_LOGGER_DIR", "/var/lib/busradar/line-logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    format='%(asctime)s [%(levelname)s] %(message)s',
    level=logging.INFO,
)
log = logging.getLogger("line_logger")


def envelope(method: str, req: dict) -> dict:
    return {
        "auth": {"type": "AID", "aid": AUTH_AID},
        "client": {"type": "AND", "id": "DB-REGIO", "v": "3000000", "name": "DB Busradar BW"},
        "ext": "DB.REGIO.1", "ver": "1.39", "lang": "de",
        "svcReqL": [{"meth": method, "req": req}],
    }


def get_tick_aligned_ts(now_wall: float) -> tuple[float, float | None]:
    """Return (poll_ts, tick_ts_or_None). tick_ts is the wall-clock time of the
    most recent HAFAS tick at or before `now_wall`, computed from the proxy's
    persisted tick state. Returns None if state is unavailable or stale."""
    try:
        data = json.loads(TICK_STATE_FILE.read_text())
        wall_ts = data.get("wall_ts")
        period = data.get("period", 30.0)
        if wall_ts is None or now_wall < wall_ts:
            return now_wall, None
        age = now_wall - wall_ts
        if age > 10800:  # state older than 3 hours, don't trust
            return now_wall, None
        cycles = int(age / period)
        return now_wall, wall_ts + cycles * period
    except Exception:
        return now_wall, None


async def fetch_active_vehicles(client: httpx.AsyncClient) -> list[dict]:
    """Fetch all active vehicles in the ring, return flattened list."""
    payload = envelope("JourneyGeoPos", {
        "ring": {"cCrd": RING_CENTER, "maxDist": RING_RADIUS_M},
        "perSize": 60, "perStep": 5,
        "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
        "trainPosMode": "REPORT_ONLY",
    })
    resp = await client.post(HAFAS_ENDPOINT, json=payload, timeout=10.0)
    resp.raise_for_status()
    data = resp.json()
    if data.get("err") != "OK":
        log.warning("API error: %s", data.get("err"))
        return []
    res = data.get("svcResL", [{}])[0].get("res", {})
    common = res.get("common", {})
    prod_l = common.get("prodL", [])
    out = []
    for j in res.get("jnyL", []):
        prod_idx = j.get("prodX", -1)
        prod = prod_l[prod_idx] if 0 <= prod_idx < len(prod_l) else {}
        line = prod.get("nameS", prod.get("name", "?"))
        if line not in TARGET_LINES:
            continue
        out.append({
            "jid": j.get("jid", ""),
            "line": line,
            "direction": j.get("dirTxt", "?"),
        })
    return out


async def fetch_journey_details(client: httpx.AsyncClient, jid: str) -> dict | None:
    """Fetch full journey with stop list."""
    payload = envelope("JourneyDetails", {"jid": jid, "getPolyline": False})
    try:
        resp = await client.post(HAFAS_ENDPOINT, json=payload, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        if data.get("err") != "OK":
            return None
        res = data.get("svcResL", [{}])[0].get("res", {})
        return res
    except Exception as e:
        log.warning("Journey fetch failed for %s: %s", jid[:30], type(e).__name__)
        return None


def calc_delay(time_s: str | None, time_r: str | None) -> int | None:
    """Calculate delay in minutes between scheduled and real HHMMSS times."""
    if not time_s or not time_r:
        return None
    try:
        plan = int(time_s[:2]) * 60 + int(time_s[2:4])
        real = int(time_r[:2]) * 60 + int(time_r[2:4])
        delay = real - plan
        if delay < -720:
            delay += 1440
        elif delay > 720:
            delay -= 1440
        return delay
    except (ValueError, IndexError):
        return None


def extract_stops(journey_res: dict) -> list[dict]:
    """Flatten journey stops into our log schema."""
    journey = journey_res.get("journey", {})
    common = journey_res.get("common", {})
    loc_l = common.get("locL", [])
    stops = []
    for s in journey.get("stopL", []):
        loc_idx = s.get("locX", -1)
        loc = loc_l[loc_idx] if 0 <= loc_idx < len(loc_l) else {}
        platform = ""
        for gid in loc.get("gidL", []):
            if gid.startswith("A×"):
                parts = gid.split(":")
                if len(parts) >= 5 and parts[4]:
                    platform = parts[4]
                    break
        stops.append({
            "name": loc.get("name", "?"),
            "extId": loc.get("extId", ""),
            "platform": platform,
            "dTimeS": s.get("dTimeS"),
            "dTimeR": s.get("dTimeR"),
            "aTimeS": s.get("aTimeS"),
            "aTimeR": s.get("aTimeR"),
            "delay_dep_min": calc_delay(s.get("dTimeS"), s.get("dTimeR")),
            "delay_arr_min": calc_delay(s.get("aTimeS"), s.get("aTimeR")),
        })
    return stops


def log_file_for(date_str: str) -> Path:
    return LOG_DIR / f"line-{'_'.join(TARGET_LINES)}-{date_str}.jsonl"


def write_final(record: dict) -> None:
    date = record["date"]
    path = log_file_for(date)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    log.info("Finalized jid=%s line=%s dir=%s stops=%d",
             record["jid"][:20], record["line"], record["direction"][:30], len(record["stops"]))


async def run():
    tracked: dict[str, dict] = {}  # jid -> {first_seen, last_seen, line, direction, latest_stops, track, date}
    last_seen_in_api: dict[str, float] = {}

    async with httpx.AsyncClient(headers={"Content-Type": "application/json", "User-Agent": "BusradarLogger/1.0"}) as client:
        log.info("Starting line logger for lines: %s", TARGET_LINES)
        log.info("Polling every %ds, finalizing %ds after last sighting", POLL_INTERVAL_SECONDS, JOURNEY_GONE_GRACE_SECONDS)
        log.info("Output dir: %s", LOG_DIR)

        while True:
            now = time.time()
            try:
                active = await fetch_active_vehicles(client)
            except Exception as e:
                log.warning("Active fetch failed: %s", type(e).__name__)
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
                continue

            seen_now = set()
            for v in active:
                jid = v["jid"]
                seen_now.add(jid)
                last_seen_in_api[jid] = now

                if jid not in tracked:
                    tracked[jid] = {
                        "first_seen_ts": now,
                        "line": v["line"],
                        "direction": v["direction"],
                        "date": datetime.now().strftime("%Y%m%d"),
                        "latest_stops": [],
                        "track": [],
                    }
                    log.info("New journey: %s line=%s dir=%s", jid[:20], v["line"], v["direction"][:40])

                # Refresh stop details + record GPS position
                details = await fetch_journey_details(client, jid)
                if details:
                    tracked[jid]["latest_stops"] = extract_stops(details)
                    tracked[jid]["last_seen_ts"] = now
                    journey = details.get("journey", {})
                    pos = journey.get("pos") or {}
                    if pos.get("x") and pos.get("y"):
                        poll_ts, tick_ts = get_tick_aligned_ts(now)
                        track_entry = {
                            "ts": round(poll_ts, 2),
                            "lat": pos["y"] / 1_000_000,
                            "lon": pos["x"] / 1_000_000,
                            "proc": journey.get("proc"),
                        }
                        if tick_ts is not None:
                            track_entry["tick_ts"] = round(tick_ts, 2)
                        tracked[jid]["track"].append(track_entry)

            # Check for journeys that disappeared
            to_finalize = []
            for jid, info in tracked.items():
                if jid in seen_now:
                    continue
                last_seen = last_seen_in_api.get(jid, info.get("last_seen_ts", info["first_seen_ts"]))
                if now - last_seen >= JOURNEY_GONE_GRACE_SECONDS:
                    to_finalize.append(jid)

            for jid in to_finalize:
                info = tracked[jid]
                record = {
                    "jid": jid,
                    "date": info["date"],
                    "line": info["line"],
                    "direction": info["direction"],
                    "first_seen_ts": info["first_seen_ts"],
                    "last_seen_ts": info.get("last_seen_ts", info["first_seen_ts"]),
                    "stops": info["latest_stops"],
                    "track": info.get("track", []),
                }
                try:
                    write_final(record)
                except Exception as e:
                    log.error("Write failed for %s: %s", jid[:20], e)
                del tracked[jid]
                last_seen_in_api.pop(jid, None)

            await asyncio.sleep(POLL_INTERVAL_SECONDS)


def main():
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log.info("Interrupted, exiting")
        sys.exit(0)


if __name__ == "__main__":
    main()
