# Line-Logs — Linie 725 Tracking-Daten

## Inhalt

Per-Fahrt JSONL-Logs der BRN-Linie 725 (Ortsbus Sandhausen), gesammelt vom Collector
`line_logger.py` zwischen 2026-06-08 und 2026-06-23.

Eine Datei pro Tag (`line-725-YYYYMMDD.jsonl`), eine Zeile pro abgeschlossene Fahrt.

### Schema

```
jid              HAFAS Journey-ID
date             Datum (YYYYMMDD)
line             Linie (hier immer "725")
direction        Fahrt-Richtung ("Ortsbus Sandhausen" / "St. Ilgen, Bahnhof West")
first_seen_ts    Unix-Zeit erster GPS-Beobachtung
last_seen_ts     Unix-Zeit letzter GPS-Beobachtung
stops            Array von Halten mit Soll/Ist-Zeiten:
  name             Haltestellenname
  extId            HAFAS ext-ID
  platform         Bahnsteig
  dTimeS/dTimeR    Soll/Ist-Abfahrt (HHMMSS)
  aTimeS/aTimeR    Soll/Ist-Ankunft (HHMMSS)
  delay_dep_min    Abfahrts-Verspätung (min, gerundet)
  delay_arr_min    Ankunfts-Verspätung (min, gerundet)
```

## Sammlung

- **Quelle:** HAFAS mgate.exe (`https://db-regio.hafas.de/bin/mgate.exe`)
- **Methode:** `JourneyGeoPos` mit `trainPosMode: REPORT_ONLY`, 30s-Polling
- **Filter:** Produkte "32" (Bus), Linie 725 client-seitig
- **Status:** Collector wurde 2026-06-23 deaktiviert nach Abschluss der Analyse

## Analyse

`analysis-2026-06-23.txt` — Output von `line_analyze.py --days 16 --line 725`, basis
für die Eingabe an BRN/VRN in `mail-brn-vrn-2026-06-22.md`.

Kennzahlen 16 Tage (n=429 Fahrten):
- Schleife A (gegen Uhrzeigersinn, 16 Halte): n=221, Endverspätung mean +4.18 / median +4 / max +12, ≤4 min 55.7%
- Schleife B (Uhrzeigersinn, 16 Halte): n=184, Endverspätung mean +4.35 / median +4 / max +10, ≤4 min 60.9%
- Schleife B-Kurz (15 Halte, ohne Lebenshilfe): n=24, mean +4.58, ≤4 min 54.2%

## Datenschutz

Reine Fahrplandaten, keine Personendaten. Bus-Positionen und Soll/Ist-Zeiten sind
öffentlich über die HAFAS-API verfügbar (siehe CLAUDE.md zur API-Beschreibung und
rechtlichen Einschätzung).
