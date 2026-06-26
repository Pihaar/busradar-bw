# Busradar BW

Live-Bustracker für Baden-Württemberg als Ersatz für die eingestellte "DB Busradar Baden-Württemberg" App.

**Live-Demo:** <https://busradar.pihaar.de/>

## Quickstart

```bash
# Dependencies installieren
pip install -r requirements.txt

# Stops-Cache bauen (einmalig, ~50 min für ganz BW)
python3 stops_builder.py

# Server starten
python3 -m uvicorn proxy:app --host 0.0.0.0 --port 8000

# Dann öffnen: http://localhost:8000
```

## Features

- Live-Buspositionen auf OpenStreetMap (Dark + Light Theme)
- Echtzeit-Verspätungsanzeige (farbcodiert: grün/gelb/rot/weiß/grau)
- Bus-Interpolation (flüssige Bewegung zwischen Tick-Updates)
- Tick-aware Cache (synchronisiert auf HAFAS-Update-Tick, vermeidet stale data)
- Richtungspfeile auf Bus-Markern
- Haltestellensuche (BW-weit, 10.400+ Stops)
- Liniensuche BW-weit (findet Busse auch außerhalb des Viewports)
- Abfahrts-/Ankünftetafel pro Haltestelle mit Bussteig-Zuordnung
- Getrennte Linienfilter pro Tab (Abfahrten/Ankünfte unabhängig)
- Fahrtverlauf mit grau/türkis Route-Split (gefahren/kommend)
- "Bus folgen" (Karte folgt Bus automatisch)
- "Route zeigen" (fitBounds auf gesamte Polyline)
- Fortschrittsbalken in der Halteliste (sekundengenau animiert)
- URL-State (Kartenposition + Selektion im Hash, F5-safe, teilbar)
- Browser-Back Navigation (Haltestelle → Bus → zurück mit Map-Restore)
- Bottom-Sheet (Mobile) / Side-Panel (Desktop)
- Responsive Design (Mobile + Desktop)
- Mehrsprachig (Deutsch + English)
- Connected-Users-Counter (exakt ≤99, "100+" darüber, anonym aus Subscriber-Registry)
- Client-Einstellungen (Interpolation, Positionsmodus, Theme, Sprache, Cache-Reset)
- About/Impressum Dialog
- Server-Sent Events (Push statt Polling, Frontend pollt nicht mehr)
- Auto-Reconnect mit Backoff (1/2/5/15/15s + Jitter), Terminal-Banner nach 5 Fehlschlägen
- PWA: Service Worker + Web App Manifest (installierbar, offline-capable)

## Architektur

```
[Browser: Leaflet + Vanilla JS + i18n + Service Worker]
        ↓ EventSource /api/stream/  (persistent, server pushes vehicles/journey/stationboard)
        ↓ POST /api/stream/viewport (Map-Pan/Zoom, debounced 250ms)
        ↓ POST /api/stream/select   (Bus/Stop-Auswahl)
[proxy.py (FastAPI + uvicorn + httpx)]
        ↓ POST (async, cached, tick-aware, singleflight)
[https://db-regio.hafas.de/bin/mgate.exe]
```

Persistent SSE-Connection statt Polling-Loop. Server pushed Vehicles auf jedem HAFAS-Tick (~30s),
plus journey/stationboard für die aktuelle Auswahl. Viewport-Updates und Selektionswechsel
fließen als kleine POSTs zurück; der State lebt server-seitig auf der Subscriber-Connection.

## Dateien

```
busradar-bw/
├── proxy.py                 # FastAPI Backend-Proxy mit SSE-Stream (~1500 LOC)
├── fanout.py                # Subscriber-Registry + Tick-Fanout (Condition + selection_seq)
├── tick.py                  # Tick-Tracker (HAFAS-Update-Detection)
├── stops_builder.py         # BW-weiter Stops-Cache-Builder
├── stops_cache.json         # 10.400+ Stops (täglich neu gebaut)
├── line_analyze.py          # Verspätungs-Analyzer für gesammelte Tracking-Daten
├── line_logger.py           # Per-Fahrt JSONL-Logger (auf Wunsch reaktivierbar)
├── requirements.txt         # Python deps (fastapi, uvicorn, httpx, pydantic v2)
├── static/
│   ├── index.html           # Frontend HTML + About-Dialog
│   ├── init.js              # Bootstrap, Service-Worker-Registration
│   ├── state.js, config.js  # State + Konfiguration
│   ├── api.js               # Fetch-Layer + selectStream-Wrapper
│   ├── map.js               # Leaflet-Karte, Marker, Polylines
│   ├── ui.js                # Sheet/Panel, Listen, Dialoge (~2200 LOC)
│   ├── refresh.js           # EventSource-Driver, Reconnect-Backoff, _applyJourneyPayload
│   ├── status.js            # Status-Bar (Tick, User-Counter)
│   ├── sw.js                # Service Worker (precache, offline)
│   ├── i18n.js              # Übersetzungen DE+EN
│   ├── style.css            # Design System (~1300 LOC)
│   ├── manifest.webmanifest # PWA Manifest
│   ├── favicon.svg
│   ├── vendor/leaflet.*     # Self-hosted Leaflet 1.9.4
│   └── fonts/*.woff2        # Self-hosted (Syne, DM Mono, DM Sans)
├── deploy/                  # systemd Units, nginx Config, OBS Spec
├── data/line-logs/          # Linie-725 Tracking-Daten (16 Tage Archiv)
├── tests/                   # pytest + JS-Tests + Playwright Smoke
├── CLAUDE.md                # API-Dokumentation HAFAS mgate.exe
└── README.md
```

## API-Endpunkte (Proxy)

| Endpoint | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/stream/` | GET | SSE-Connection (`subscribe`, `vehicles`, `journey`, `stationboard`, `connected`, `error`) |
| `/api/stream/viewport` | POST | Sichtbaren Bbox an Subscriber binden (HttpOnly-Cookie-bound) |
| `/api/stream/select` | POST | Aktuelle Auswahl an Subscriber binden (journey/stationboard/none) |
| `/api/journey` | POST | Fahrtdetails + Polyline (Click-Time, parallel zum SSE-Push) |
| `/api/stationboard` | POST | Abfahrten/Ankünfte (Click-Time, ARR über tab-switch) |
| `/api/stops` | GET | Haltestellen im Radius (aus Cache) |
| `/api/search` | GET | HAFAS-Haltestellensuche (q, lat, lon) |
| `/api/line_search` | GET | BW-weite Liniensuche (q) |
| `/api/health` | GET | Server-Status + Tick-Calibrator |

## Sicherheit

- Input-Validierung auf allen Endpunkten (Pydantic + Regex)
- CSP mit Script-Hash, base-uri, object-src
- X-Frame-Options, X-Content-Type-Options Header
- Kein Passthrough, der Proxy baut HAFAS-Payloads selbst
- Static Files aus `static/` Subdirectory (kein Path Traversal)
- localStorage-Validierung mit Allowlist bei jedem Read
- Connected-Users-Counter mit Per-IP-Cap (DPP-konform, IP gehasht in Logs)

## Tracking-Analyse

```bash
# Auswertung aus den archivierten line-725 Logs (Default: 7 Tage)
python3 line_analyze.py --line 725 --days 30
```

Siehe `data/line-logs/README.md` und `data/line-logs/analysis-2026-06-23.txt` für die
fertige Auswertung (16 Tage, n=429 Fahrten).

## Deployment

RPM/OBS-Paket via `deploy/busradar-bw.spec`, systemd-Units in `deploy/`, nginx-Vhost
in `deploy/busradar.pihaar.de.conf`. Single-Worker uvicorn unter sysuser `busradar`.

## Lizenz / Rechtliches

Privates Projekt. Die HAFAS-API ist nicht offiziell dokumentiert, wird aber seit 2017
von der Open-Transport-Community genutzt (hafas-client, bahn.expert, etc.) ohne
bekannte Abmahnungen. Keine kommerzielle Nutzung.
