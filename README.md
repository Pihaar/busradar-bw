# Busradar BW

Live-Bustracker für Baden-Württemberg als Ersatz für die eingestellte "DB Busradar Baden-Württemberg" App.

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
- Bus-Interpolation (flüssige Bewegung zwischen API-Refreshes)
- Richtungspfeile auf Bus-Markern
- Haltestellensuche (BW-weit, 10.400+ Stops)
- Liniensuche BW-weit (findet Busse auch außerhalb des Viewports)
- Abfahrts-/Ankünftetafel pro Haltestelle mit Bussteig-Zuordnung
- Getrennte Linienfilter pro Tab (Abfahrten/Ankünfte unabhängig)
- Fahrtverlauf mit grau/türkis Route-Split (gefahren/kommend)
- "Bus folgen" (Karte folgt Bus automatisch)
- "Route zeigen" (fitBounds auf gesamte Polyline)
- Fortschrittsbalken in der Halteliste (sekundengenau animiert)
- URL-State (Kartenposition + Selektion im Hash → F5-safe, teilbar)
- Browser-Back Navigation (Haltestelle → Bus → zurück mit Map-Restore)
- Bottom-Sheet (Mobile) / Side-Panel (Desktop)
- Responsive Design (Mobile + Desktop)
- Mehrsprachig (Deutsch + English)
- Client-Einstellungen (Refresh-Intervall, Interpolation, Positionsmodus, Theme, Sprache)
- About/Impressum Dialog
- 10s Auto-Refresh (zoom-abhängig: 30s bei weitem Zoom)
- Offline-Toleranz: Circuit Breaker + stale-while-revalidate

## Architektur

```
[Browser: Leaflet + Vanilla JS + i18n]
        ↓ fetch /api/*
[proxy.py (FastAPI + uvicorn + httpx)]
        ↓ POST (async, cached)
[https://db-regio.hafas.de/bin/mgate.exe]
```

## Dateien

```
busradar-bw/
├── proxy.py                 # FastAPI Backend-Proxy (~690 LOC)
├── stops_builder.py         # BW-weiter Stops-Cache-Builder
├── stops_cache.json         # 10.400+ Stops (rebuilt daily 3:00)
├── requirements.txt         # Python deps
├── validate.sh              # Pflicht-Validation (ruff, node, CSS)
├── busradar_api.py          # CLI-Tool (standalone)
├── static/
│   ├── index.html           # Frontend HTML + About-Dialog
│   ├── app.js               # Frontend Logic (~2700 LOC)
│   ├── i18n.js              # Übersetzungen DE+EN (~270 LOC)
│   ├── style.css            # Design System (~1100 LOC)
│   ├── favicon.svg
│   ├── vendor/leaflet.*     # Self-hosted Leaflet 1.9.4
│   └── fonts/*.woff2        # Self-hosted (Syne, DM Mono, DM Sans)
├── CLAUDE.md                # API-Dokumentation
└── README.md
```

## API-Endpunkte (Proxy)

| Endpoint | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/vehicles` | GET | Live-Buspositionen (swLat, swLon, neLat, neLon, posMode) |
| `/api/journey` | POST | Fahrtdetails + Polyline (jid) |
| `/api/stationboard` | POST | Abfahrten/Ankünfte (lid, type, dur) |
| `/api/stops` | GET | Haltestellen im Radius (aus Cache) |
| `/api/search` | GET | HAFAS-Haltestellensuche (q, lat, lon) |
| `/api/line_search` | GET | BW-weite Liniensuche (q) |
| `/api/health` | GET | Server-Status + Circuit Breaker |

## Sicherheit

- Input-Validierung auf allen Endpunkten (Pydantic + Regex)
- Rate-Limiting (slowapi, per-IP)
- CSP mit Script-Hash, base-uri, object-src
- X-Frame-Options, X-Content-Type-Options Header
- Kein Passthrough — Proxy baut HAFAS-Payloads selbst
- Static Files aus `static/` Subdirectory (kein Path Traversal)
- localStorage-Validierung mit Allowlist bei jedem Read

## Validation

```bash
# MUSS nach jeder Code-Änderung ausgeführt werden:
./validate.sh
# Prüft: ruff, py_compile, node --check, JS balance, CSS balance
```

## Lizenz / Rechtliches

Privates Projekt. Die HAFAS-API ist nicht offiziell dokumentiert, wird aber seit 2017
von der Open-Transport-Community genutzt (hafas-client, bahn.expert, etc.) ohne
bekannte Abmahnungen. Keine kommerzielle Nutzung.
