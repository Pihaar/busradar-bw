"""
GPS Stop Detector — derives actual arrival/departure times from GPS track,
compares against HAFAS reported aTimeR/dTimeR.

Usage:
    python line_gps_analyze.py --jid <JID> [--dir /path/to/logs]
    python line_gps_analyze.py --line 725 --days 1 [--dir ...]
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import datetime
from pathlib import Path

STOP_RADIUS_M = 50  # bus considered "at stop" if within this distance
MIN_DWELL_SECONDS = 5  # ignore stops shorter than this (drive-through)


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def hhmmss_str(unix_ts: float) -> str:
    return datetime.fromtimestamp(unix_ts).strftime("%H:%M:%S")


def detect_stops_from_track(track: list[dict], stops: list[dict]) -> list[dict]:
    """For each scheduled stop, find when the GPS track was nearest and within radius."""
    results = []
    for stop in stops:
        s_lat = stop["lat"] if "lat" in stop else None
        s_lon = stop["lon"] if "lon" in stop else None
        # Stops in our log don't have lat/lon — we have to look them up elsewhere or skip
        # Actually, line_logger stores extId but not coords. Use stops_cache instead?
        results.append({"name": stop["name"], "extId": stop["extId"]})
    return results


def analyze_journey(record: dict, stops_cache: dict[str, tuple[float, float]] | None = None) -> None:
    print(f"\n=== Journey {record['jid'][:30]}... ===")
    print(f"Direction: {record['direction']}")
    print(f"Date: {record['date']}, first_seen: {hhmmss_str(record['first_seen_ts'])}")
    track = record.get("track", [])
    print(f"Track points: {len(track)}")
    if not track:
        print("(no GPS track)")
        return

    stops = record["stops"]

    # Print track summary: position changes & speed
    print(f"\n{'Time':>10} {'Lat':>10} {'Lon':>9} {'Δm':>6} {'m/s':>5} {'proc':>5}")
    print("-" * 55)
    prev = None
    for p in track:
        ts_str = hhmmss_str(p['ts'])
        if prev:
            dist = haversine_m(prev['lat'], prev['lon'], p['lat'], p['lon'])
            dt = p['ts'] - prev['ts']
            speed = dist / dt if dt > 0 else 0
            print(f"{ts_str:>10} {p['lat']:>10.5f} {p['lon']:>9.5f} {dist:>6.0f} {speed:>5.1f} {str(p.get('proc','-')):>5}")
        else:
            print(f"{ts_str:>10} {p['lat']:>10.5f} {p['lon']:>9.5f} {'-':>6} {'-':>5} {str(p.get('proc','-')):>5}")
        prev = p

    if stops_cache:
        print(f"\n{'Stop':<37} {'HAFAS arr':>10} {'HAFAS dep':>10} {'GPS-arr':>10} {'GPS-dep':>10} {'Distance':>10}")
        print("-" * 100)
        for stop in stops:
            extId = stop["extId"]
            coords = stops_cache.get(extId)
            if not coords:
                continue
            s_lat, s_lon = coords
            # Find points within radius
            close = [(p, haversine_m(s_lat, s_lon, p['lat'], p['lon'])) for p in track]
            in_range = [(p, d) for p, d in close if d <= STOP_RADIUS_M]
            arr_str = stop.get("aTimeR") or "-"
            dep_str = stop.get("dTimeR") or "-"
            arr_str = f"{arr_str[:2]}:{arr_str[2:4]}" if arr_str != "-" else "-"
            dep_str = f"{dep_str[:2]}:{dep_str[2:4]}" if dep_str != "-" else "-"
            if in_range:
                gps_arr = hhmmss_str(in_range[0][0]['ts'])
                gps_dep = hhmmss_str(in_range[-1][0]['ts'])
                min_d = min(d for _, d in close)
                print(f"{stop['name'][:35]:<37} {arr_str:>10} {dep_str:>10} {gps_arr:>10} {gps_dep:>10} {min_d:>10.0f}m")
            else:
                min_d = min(d for _, d in close) if close else 0
                print(f"{stop['name'][:35]:<37} {arr_str:>10} {dep_str:>10} {'(>50m)':>10} {'-':>10} {min_d:>10.0f}m")


def load_stops_cache(path: Path) -> dict[str, tuple[float, float]]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        return {s["extId"]: (s["lat"], s["lon"]) for s in data.get("stops", []) if s.get("extId")}
    except Exception:
        return {}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--jid", help="Specific journey ID (substring match)")
    p.add_argument("--line", default="725")
    p.add_argument("--days", type=int, default=1)
    p.add_argument("--dir", default="/var/lib/busradar/line-logs")
    p.add_argument("--stops-cache", default="/opt/busradar/stops_cache.json")
    args = p.parse_args()

    log_dir = Path(args.dir)
    if not log_dir.exists():
        print(f"Log dir not found: {log_dir}")
        return

    stops_cache = load_stops_cache(Path(args.stops_cache))
    print(f"Stops cache loaded: {len(stops_cache)} stops")

    records = []
    for path in sorted(log_dir.glob(f"line-*.jsonl")):
        with path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line.strip())
                    records.append(rec)
                except json.JSONDecodeError:
                    continue

    if args.jid:
        matched = [r for r in records if args.jid in r["jid"]]
    else:
        matched = [r for r in records if r.get("line") == args.line]

    if not matched:
        print("No matching records")
        return

    for rec in matched:
        analyze_journey(rec, stops_cache)


if __name__ == "__main__":
    main()
