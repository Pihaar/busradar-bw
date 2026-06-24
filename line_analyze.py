"""
Line Analyzer — Aggregate delay statistics from line_logger output.

Reads JSONL files from LINE_LOGGER_DIR and produces per-direction,
per-stop delay statistics.

Usage:
    python line_analyze.py [--line 725] [--days 7] [--dir /path/to/logs]
"""
from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


def hhmmss_to_minutes(t: str | None) -> int | None:
    if not t or len(t) < 4:
        return None
    try:
        return int(t[:2]) * 60 + int(t[2:4])
    except ValueError:
        return None


def load_records(log_dir: Path, line: str, days: int) -> list[dict]:
    cutoff = datetime.now() - timedelta(days=days)
    records = []
    for path in sorted(log_dir.glob(f"line-*-*.jsonl")):
        try:
            date_part = path.stem.split('-')[-1]
            file_date = datetime.strptime(date_part, "%Y%m%d")
        except ValueError:
            continue
        if file_date < cutoff:
            continue
        with path.open(encoding="utf-8") as f:
            for line_text in f:
                line_text = line_text.strip()
                if not line_text:
                    continue
                try:
                    rec = json.loads(line_text)
                    if rec.get("line") == line:
                        records.append(rec)
                except json.JSONDecodeError:
                    continue
    return records


def analyze_direction(records: list[dict], seq_key: tuple, label: str) -> dict:
    """Aggregate delays per stop for one canonical stop sequence."""
    matched = [r for r in records if tuple(s["extId"] for s in r["stops"]) == seq_key]
    if not matched:
        return {}

    canonical_names = [s["name"] for s in matched[0]["stops"]]
    n_stops = len(seq_key)

    # Collect delays per stop position
    delays_dep = [[] for _ in range(n_stops)]
    delays_arr = [[] for _ in range(n_stops)]
    durations_planned = []
    durations_actual = []
    start_delays = []
    end_delays = []

    # Per-segment delay buildup (delta between consecutive stops)
    segment_buildups = [[] for _ in range(max(0, n_stops - 1))]
    # Per-stop dwell-time buildup (delta within a single stop: dep_delay - arr_delay)
    dwell_buildups = [[] for _ in range(n_stops)]

    for r in matched:
        stops = r["stops"]
        # All records in this group share the same stop sequence (positional iteration)
        for i, s in enumerate(stops[:n_stops]):
            if s["delay_dep_min"] is not None:
                delays_dep[i].append(s["delay_dep_min"])
            if s["delay_arr_min"] is not None:
                delays_arr[i].append(s["delay_arr_min"])
            # Dwell-time buildup at this stop
            if s["delay_arr_min"] is not None and s["delay_dep_min"] is not None:
                dwell_buildups[i].append(s["delay_dep_min"] - s["delay_arr_min"])

        # Start/End delay
        first_with_d = next((s for s in stops if s["delay_dep_min"] is not None), None)
        last_with_a = next((s for s in reversed(stops) if s["delay_arr_min"] is not None), None)
        if first_with_d:
            start_delays.append(first_with_d["delay_dep_min"])
        if last_with_a:
            end_delays.append(last_with_a["delay_arr_min"])

        # Duration: scheduled vs actual from first dTimeS to last aTimeS/aTimeR
        first_dep = stops[0] if stops else None
        last_arr = stops[-1] if stops else None
        if first_dep and last_arr:
            d_plan_start = hhmmss_to_minutes(first_dep.get("dTimeS"))
            d_plan_end = hhmmss_to_minutes(last_arr.get("aTimeS"))
            d_real_start = hhmmss_to_minutes(first_dep.get("dTimeR")) or d_plan_start
            d_real_end = hhmmss_to_minutes(last_arr.get("aTimeR")) or d_plan_end
            if d_plan_start is not None and d_plan_end is not None:
                dur_p = d_plan_end - d_plan_start
                if dur_p < 0:
                    dur_p += 1440
                durations_planned.append(dur_p)
            if d_real_start is not None and d_real_end is not None:
                dur_a = d_real_end - d_real_start
                if dur_a < 0:
                    dur_a += 1440
                durations_actual.append(dur_a)

        # Segment buildup: change in delay between consecutive stops (positional)
        for i in range(min(len(stops), n_stops) - 1):
            s1 = stops[i]
            s2 = stops[i + 1]
            d1 = s1["delay_dep_min"] if s1["delay_dep_min"] is not None else s1["delay_arr_min"]
            d2 = s2["delay_arr_min"] if s2["delay_arr_min"] is not None else s2["delay_dep_min"]
            if d1 is not None and d2 is not None:
                segment_buildups[i].append(d2 - d1)

    def stats(values: list[int]) -> dict:
        if not values:
            return {"n": 0}
        return {
            "n": len(values),
            "mean": round(statistics.mean(values), 2),
            "median": statistics.median(values),
            "min": min(values),
            "max": max(values),
            "p90": round(statistics.quantiles(values, n=10)[8], 2) if len(values) >= 10 else None,
        }

    return {
        "direction": label,
        "journeys": len(matched),
        "canonical_stops": canonical_names,
        "delays_dep_per_stop": [stats(d) for d in delays_dep],
        "delays_arr_per_stop": [stats(d) for d in delays_arr],
        "segment_buildup": [stats(s) for s in segment_buildups],
        "dwell_buildup": [stats(d) for d in dwell_buildups],
        "start_delay": stats(start_delays),
        "end_delay": stats(end_delays),
        "end_punctual_count": sum(1 for v in end_delays if v <= 0),
        "end_within_1min_count": sum(1 for v in end_delays if v <= 1),
        "end_within_4min_count": sum(1 for v in end_delays if v <= 4),
        "duration_planned": stats(durations_planned),
        "duration_actual": stats(durations_actual),
    }


def print_report(line: str, days: int, results: list[dict]) -> None:
    print(f"\n=== Line {line} — last {days} days ===\n")
    for res in results:
        if not res:
            continue
        print(f"Direction: {res['direction']}")
        print(f"  Journeys analyzed: {res['journeys']}")
        sd, ed = res["start_delay"], res["end_delay"]
        print(f"  Start delay  (n={sd['n']}): mean={sd.get('mean','-')} median={sd.get('median','-')} min={sd.get('min','-')} max={sd.get('max','-')}")
        ed_punctual = res.get("end_punctual_count")
        ed_within_1 = res.get("end_within_1min_count")
        ed_within_4 = res.get("end_within_4min_count")
        ed_punctual_str = ""
        if ed_punctual is not None and ed_within_1 is not None and ed_within_4 is not None and ed["n"] > 0:
            pct0 = round(100 * ed_punctual / ed["n"], 1)
            pct1 = round(100 * ed_within_1 / ed["n"], 1)
            pct4 = round(100 * ed_within_4 / ed["n"], 1)
            ed_punctual_str = f"  (≤0 min: {ed_punctual}/{ed['n']} = {pct0}%, ≤1 min: {ed_within_1}/{ed['n']} = {pct1}%, ≤4 min: {ed_within_4}/{ed['n']} = {pct4}%)"
        print(f"  End delay    (n={ed['n']}): mean={ed.get('mean','-')} median={ed.get('median','-')} min={ed.get('min','-')} max={ed.get('max','-')}{ed_punctual_str}")
        dp = res["duration_planned"]
        da = res["duration_actual"]
        if dp.get("n", 0) > 0 and da.get("n", 0) > 0:
            print(f"  Duration planned median: {dp['median']} min")
            print(f"  Duration actual median:  {da['median']} min  (Δ {da['median'] - dp['median']:+} min)")

        names = res["canonical_stops"]
        deps = res["delays_dep_per_stop"]
        segs = res["segment_buildup"]

        print(f"\n  {'Stop':<40} {'med dep':>8} {'mean dep':>9} {'min':>5} {'max':>5} {'n':>4}")
        for i, name in enumerate(names):
            d = deps[i]
            if d.get("n", 0) == 0:
                continue
            print(f"  {name[:40]:<40} {d['median']:>8} {d['mean']:>9} {d['min']:>5} {d['max']:>5} {d['n']:>4}")

        print(f"\n  Verspätungs-Aufbau zwischen Halten (median Δ min, Fahrzeit):")
        for i in range(len(segs)):
            s = segs[i]
            if s.get("n", 0) == 0:
                continue
            from_n = names[i][:25] if i < len(names) else "?"
            to_n = names[i + 1][:25] if i + 1 < len(names) else "?"
            arrow = "↑" if s["median"] > 0 else ("↓" if s["median"] < 0 else "·")
            print(f"    {from_n:<27} → {to_n:<27} {arrow}{abs(s['median']):>3} (mean {s['mean']:+.1f}, min {s['min']:+}, max {s['max']:+}, n={s['n']})")

        dwell = res.get("dwell_buildup", [])
        if dwell:
            print(f"\n  Standzeit-Aufbau pro Halt (median Δ min, dep_delay − arr_delay):")
            for i, d in enumerate(dwell):
                if d.get("n", 0) == 0:
                    continue
                name = names[i][:35] if i < len(names) else "?"
                arrow = "↑" if d["median"] > 0 else ("↓" if d["median"] < 0 else "·")
                print(f"    {name:<37} {arrow}{abs(d['median']):>3} (mean {d['mean']:+.1f}, min {d['min']:+}, max {d['max']:+}, n={d['n']})")
        print()


DEFAULT_LOG_DIR = Path(__file__).resolve().parent / "data" / "line-logs"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--line", default="725")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--dir", default=str(DEFAULT_LOG_DIR))
    args = p.parse_args()

    log_dir = Path(args.dir)
    if not log_dir.exists():
        print(f"Log dir not found: {log_dir}")
        return

    records = load_records(log_dir, args.line, args.days)
    if not records:
        print(f"No records found for line {args.line} in last {args.days} days")
        return

    # Group by canonical stop sequence (extId tuple), since dirTxt can vary
    # between equivalent journeys (HAFAS sometimes returns line name, sometimes endpoint).
    seq_groups = defaultdict(list)
    for r in records:
        seq = tuple(s["extId"] for s in r["stops"])
        seq_groups[seq].append(r)

    # Build human-readable label per sequence: most common direction + endpoint hints
    results = []
    for seq, recs in sorted(seq_groups.items(), key=lambda kv: -len(kv[1])):
        if len(recs) < 1 or not seq:
            continue
        # Find most common dirTxt among matching records
        dirs = defaultdict(int)
        for r in recs:
            dirs[r["direction"]] += 1
        common_dir = max(dirs, key=dirs.get)
        stops = recs[0]["stops"]
        first_name = stops[0]["name"] if stops else "?"
        last_name = stops[-1]["name"] if stops else "?"
        if first_name == last_name and len(stops) > 4:
            # Show 2nd, 3rd, 4th stop to disambiguate loop direction
            preview = " → ".join(s["name"] for s in stops[1:4])
            label = f"{common_dir}  [{len(seq)} Halte] ({first_name} → {preview} → ... → {first_name})"
        else:
            label = f"{common_dir} ({first_name} → {last_name}, {len(seq)} Halte)"
        results.append(analyze_direction(records, seq, label))

    print_report(args.line, args.days, results)


if __name__ == "__main__":
    main()
