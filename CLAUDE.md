# Busradar BW — Live-Bustracker für Baden-Württemberg

## Projektziel

Ersatz für die eingestellte Android-App "DB Busradar Baden-Württemberg" (de.hafas.android.rvsbusradar).
Eine Webseite (HTML+JS) die Live-Buspositionen auf einer OpenStreetMap-Karte anzeigt.

**Primärer Fokus:**
- Linie 725 (Ortsbus Sandhausen, 69207)
- Linie 719 (St. Leon-Rot)
- Zentrum: 49.3420088, 8.6597789 (Sandhausen)

**Betreiber:** BRN (Busverkehr Rhein-Neckar), eine DB Regio Bus Tochter.
Sandhausen liegt im VRN-Gebiet (Verkehrsverbund Rhein-Neckar).

---

## API-Details (HAFAS mgate.exe)

### Endpunkt

```
POST https://db-regio.hafas.de/bin/mgate.exe
Content-Type: application/json
```

Der Server läuft auf AWS: `db-regio-fleet-prod-application-1444017465.eu-central-1.elb.amazonaws.com`

### Authentifizierung

```json
{
  "auth": {"type": "AID", "aid": "FiBa5ytjCvR0J47P"},
  "client": {"type": "AND", "id": "DB-REGIO", "v": "3000000", "name": "DB Busradar BW"},
  "ext": "DB.REGIO.1",
  "ver": "1.39",
  "lang": "de"
}
```

**WICHTIG:** KEINE Checksum/mic/mac URL-Parameter senden! Der Server akzeptiert Requests
ohne diese Parameter problemlos. MIT falschen Parametern antwortet er mit HTTP 401.
Die alte App ist genau daran gescheitert — der Checksum-Salt wurde serverseitig geändert.

### Methode: JourneyGeoPos (Live-Fahrzeugpositionen)

```json
{
  "auth": {"type": "AID", "aid": "FiBa5ytjCvR0J47P"},
  "client": {"type": "AND", "id": "DB-REGIO", "v": "3000000", "name": "DB Busradar BW"},
  "ext": "DB.REGIO.1",
  "ver": "1.39",
  "lang": "de",
  "svcReqL": [{
    "meth": "JourneyGeoPos",
    "req": {
      "ring": {
        "cCrd": {"x": 8660000, "y": 49342000},
        "maxDist": 15000
      },
      "perSize": 120,
      "perStep": 10,
      "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "127"}],
      "trainPosMode": "CALC"
    }
  }]
}
```

**Parameter:**
- `ring.cCrd.x` — Längengrad × 1.000.000 (z.B. 8.66 → 8660000)
- `ring.cCrd.y` — Breitengrad × 1.000.000 (z.B. 49.342 → 49342000)
- `ring.maxDist` — Radius in Metern (max ~80.000)
- `perSize` — Zeitfenster in Sekunden (wie weit in die Zukunft interpolieren)
- `perStep` — Schrittweite der Interpolation in Sekunden
- `jnyFltrL` — Produktfilter (127 = alle Produkte, 32 = nur Busse)
- `trainPosMode` — "CALC" = interpolierte Positionen

### Response-Struktur

```json
{
  "ver": "1.39",
  "err": "OK",
  "svcResL": [{
    "meth": "JourneyGeoPos",
    "err": "OK",
    "res": {
      "common": {
        "prodL": [...],   // Produktliste (Linien-Infos)
        "locL": [...]     // Haltestellenliste
      },
      "jnyL": [...]       // Fahrzeuge/Journeys
    }
  }]
}
```

**Journey-Objekt (jnyL[]):**
```json
{
  "jid": "1|12345|0|80|15052026",  // Journey-ID
  "date": "20260515",
  "prodX": 0,           // Index in prodL → Linienname
  "dirTxt": "St. Ilgen, Bf West",  // Fahrtziel
  "pos": {"x": 8660000, "y": 49342000},  // Aktuelle GPS-Position
  "proc": 45,           // Fortschritt der Fahrt (0-100%)
  "stopL": [...]        // Nächste Halte mit Soll/Ist-Zeiten
}
```

**Stop-Objekt (stopL[]):**
```json
{
  "locX": 0,            // Index in locL → Haltestellenname
  "dTimeS": "134500",   // Soll-Abfahrt (HHMMSS)
  "dTimeR": "134800",   // Ist-Abfahrt (HHMMSS) → Delay = +3 min
  "aTimeS": "134400",   // Soll-Ankunft
  "aTimeR": "134700"    // Ist-Ankunft
}
```

**Delay berechnen:** `dTimeR - dTimeS` (in Minuten). Wenn nur dTimeS vorhanden → keine Echtzeit.

### Weitere nützliche HAFAS-Methoden

**ServerInfo** (Server-Status prüfen):
```json
{"meth": "ServerInfo", "req": {"getServerDateTime": true}}
```
→ Gibt Fahrplandaten-Zeitraum (fpB/fpE) und Server-Zeit zurück.

**LocSearch** (Haltestellensuche):
```json
{"meth": "LocSearch", "req": {"input": {"loc": {"name": "Sandhausen"}, "field": "S"}}}
```

**StationBoard** (Abfahrtstafel):
```json
{"meth": "StationBoard", "req": {"stbLoc": {"lid": "A=1@L=6003411@"}, "type": "DEP", "dur": 60}}
```

### Produktfilter (jnyFltrL value)

| Bit | Produkt |
|-----|---------|
| 1   | ICE/Fernverkehr |
| 2   | IC/EC |
| 4   | RE/RB |
| 8   | S-Bahn |
| 16  | U-Bahn/Stadtbahn |
| 32  | Bus |
| 64  | Fähre |
| 127 | Alle |

Für nur Busse: `"value": "32"`

### Rate-Limits & Best Practices

- Kein bekanntes Rate-Limit, aber moderat anfragen (alle 10-30 Sekunden reicht)
- Keine Checksum-Parameter in der URL senden
- Kein User-Agent-Filter bekannt
- CORS: Der Endpunkt sendet KEINE CORS-Header → Direkter Fetch aus dem Browser schlägt fehl!
  **Lösung:** Entweder ein kleiner Proxy (Node.js/Python), oder eine Browser-Extension,
  oder ein CORS-Proxy verwenden.

---

## Tile-Server (Karten-Kacheln)

Die Original-App nutzte eigene HAFAS-Kacheln:
```
http://gis-de.haf.as/hafas-tiles/v1/happ_pt/1/$(z)/$(x)/$(y).png
```
Dieser Server ist noch aktiv (HTTP 200), aber nicht nötig — wir nutzen OpenStreetMap.

---

## Alternative Datenquellen (Vergleich)

| Quelle | GPS-Positionen | Delays | Linie 725 RT | Latenz |
|--------|---------------|--------|-------------|--------|
| **HAFAS mgate** | JA | JA (Soll/Ist) | **JA** | ~80ms |
| EFA-BW (efa-bw.de) | Nein | Teilweise | **NEIN** | ~3700ms |
| GTFS.de (DELFI) | Nein | Teilweise | Unklar | 50MB Download |
| MobiData BW | Nein | Über TRIAS (auth) | Nein | N/A |

**HAFAS ist die einzige Quelle mit Live-GPS für BRN-Busse.**

### EFA-BW (für Ergänzungen nutzbar)

```
GET https://www.efa-bw.de/nvbw/XML_DM_REQUEST?outputFormat=JSON&type_dm=stop&name_dm=6003411&mode=direct&useRealtime=1&limit=10
```
- Stop-IDs für Sandhausen: 6003411 (Altes Rathaus), 6003466 (Neues Rathaus)
- Hat Echtzeit für manche Linien (722: ja, 725: nein!)
- Kein CORS-Problem (sendet Access-Control-Allow-Origin)

---

## Warum die Original-App nicht mehr funktioniert

1. **Google Maps API Key deaktiviert** (seit Jahren → weiße Karte)
2. **HAFAS Checksum-Salt geändert** (kürzlich → keine Busse mehr)
   - Die App sendet `?checksum=X&mic=Y&mac=Z` in der URL
   - Server antwortet mit HTTP 401 bei ungültiger Signatur
   - Ohne diese Parameter funktioniert die API einwandfrei

App-Details:
- Package: `de.hafas.android.rvsbusradar`
- Version: 3.1.0 (Build 10), November 2022
- Neuere Version 3.3.0 (Dez 2024) war auf APKCombo, aber auch nicht mehr funktional
- Entwickler: HaCon Ingenieurgesellschaft mbH (jetzt Siemens Mobility)
- Min SDK: Android 6.0
- Aus dem Play Store entfernt (aber Seite existiert noch)

---

## Rechtliche Einschätzung

### Zusammenfassung
Grauzone. Kein explizites Nutzungsrecht, aber auch kein Verbot. Für privaten Gebrauch
praktisch risikolos.

### Details

**HaCon (Siemens Mobility):**
- Technologie-Lieferant, nicht Dateneigentümer
- Keine öffentliche API-Policy, keine ToS für HAFAS-Endpunkte
- Keine explizite Erlaubnis oder Verbot
- Website: https://www.hacon.de/

**Dateneigentümer:** DB Regio Bus Baden-Württemberg (Südwestbus)
- Impressum: Südwestbus, Gutschstraße 4, 76137 Karlsruhe
- Web: https://www.dbregiobus-bawue.de/
- Mail: busbw@deutschebahn.com

**Community-Nutzung (seit 2017, nie abgemahnt):**
- hafas-client: 1000+ Stars auf GitHub
- transport-apis: Dokumentiert Endpunkte maschinenlesbar
- bahn.expert: Nutzt HAFAS seit Jahren öffentlich
- Öffi, Transportr: Populäre Android-Apps mit HAFAS

**Endpunkt-Eigenschaften:**
- Kein Passwort/API-Key erforderlich (AID ist öffentlich)
- Kein Rate-Limiting
- Kein IP-Blocking
- Funktioniert ohne Checksum-Parameter (bewusst offen?)

**EU-Regulierung:**
- EU 2017/1926: Verkehrsunternehmen müssen Daten bereitstellen
- PBefG §3a: Bereitstellungspflicht für Fahrplandaten in DE
- Aber: Fokus auf Fahrplan über nationale Zugangspunkte, nicht zwingend GPS-Positionen

**Empfehlung:**
- Privater Gebrauch: Kein Risiko
- Öffentliche Webseite (nicht-kommerziell): Geringes Risiko
- Kommerzielle Nutzung: Vereinbarung mit DB Regio Bus empfohlen

---

## Technische Architektur (Vorschlag)

### Option A: Statische HTML-Datei (einfachste Lösung)

```
busradar-bw/
├── index.html          # Leaflet-Karte + JS für API-Calls
├── proxy.py            # Kleiner Python CORS-Proxy (3 Zeilen Flask)
└── README.md
```

**Problem:** CORS. Der HAFAS-Endpunkt sendet keine CORS-Header.
**Lösung:** Kleiner lokaler Proxy oder Nutzung über Server-Side.

### Option B: Vollständige Web-App

```
busradar-bw/
├── index.html          # Frontend (Leaflet + OSM)
├── api/
│   └── hafas.py        # Backend-Proxy (Flask/FastAPI)
├── docker-compose.yml  # Optional: Containerisierung
└── README.md
```

### Frontend-Features (Minimum Viable)

1. OpenStreetMap-Karte zentriert auf Sandhausen
2. Bus-Marker mit Liniennummer
3. Auto-Refresh alle 15-30 Sekunden
4. Farbcodierung: grün=pünktlich, gelb=1-3min, rot=>3min Verspätung
5. Klick auf Bus zeigt: Linie, Richtung, Delay, nächste Halte

### Frontend-Features (Nice-to-have)

- Filter nach Linien (725, 719, alle)
- Haltestellennamen einblenden
- Fahrtrichtungspfeil
- Offline-Erkennung
- PWA für Handy-Homescreen

---

## Getestete Beispiel-Requests

### Live-Positionen Sandhausen (15km Radius)
```bash
curl -s -X POST "https://db-regio.hafas.de/bin/mgate.exe" \
  -H "Content-Type: application/json" \
  -d '{
  "auth": {"type": "AID", "aid": "FiBa5ytjCvR0J47P"},
  "client": {"type": "AND", "id": "DB-REGIO", "v": "3000000", "name": "DB Busradar BW"},
  "ext": "DB.REGIO.1", "ver": "1.39", "lang": "de",
  "svcReqL": [{"meth": "JourneyGeoPos", "req": {
    "ring": {"cCrd": {"x": 8660000, "y": 49342000}, "maxDist": 15000},
    "perSize": 120, "perStep": 10,
    "jnyFltrL": [{"type": "PROD", "mode": "INC", "value": "32"}],
    "trainPosMode": "CALC"
  }}]
}'
```

### Ergebnis (15.05.2026, 13:37 Uhr):
- **Bus 725** → Ortsbus Sandhausen (49.34252, 8.66151) — pünktlich
- **Bus 719** → Rot-Malsch Bf. (49.26046, 8.63734) — +1 min
- **Bus 719** → Neulußheim Bf. (49.24279, 8.65055) — pünktlich
- Plus ~80 weitere Busse im Umkreis

### Server-Status prüfen
```bash
curl -s -X POST "https://db-regio.hafas.de/bin/mgate.exe" \
  -H "Content-Type: application/json" \
  -d '{
  "auth": {"type": "AID", "aid": "FiBa5ytjCvR0J47P"},
  "client": {"type": "AND", "id": "DB-REGIO", "v": "3000000"},
  "ext": "DB.REGIO.1", "ver": "1.39", "lang": "de",
  "svcReqL": [{"meth": "ServerInfo", "req": {"getServerDateTime": true}}]
}'
```

---

## Bekannte Endpunkte (HAFAS DB Regio)

| Region | AID | Endpoint | Status |
|--------|-----|----------|--------|
| **BW (Baden-Württemberg)** | `FiBa5ytjCvR0J47P` | `https://db-regio.hafas.de/bin/mgate.exe` | Aktiv |
| NRW (Nordrhein-Westfalen) | `OGBAqytjHhCvr0J4` | `https://db-regio.hafas.de/bin/mgate.exe` | Aktiv |

Gleicher Endpunkt, verschiedene AIDs. Die Daten sind durch die AID regionssepariert —
NRW-AID gibt 0 Ergebnisse für BW-Koordinaten und umgekehrt.

---

## Referenzen

- HaCon (Betreiber): https://www.hacon.de/
- hafas-client Library: https://github.com/public-transport/hafas-client
- transport-apis Registry: https://github.com/public-transport/transport-apis
- Original-App (Play Store, eingestellt): https://play.google.com/store/apps/details?id=de.hafas.android.rvsbusradar
- DB Regio Bus BaWü: https://www.dbregiobus-bawue.de/
- EFA-BW (alternative Quelle, ohne GPS): https://www.efa-bw.de/nvbw/
- MobiData BW (Open Data Portal): https://mobidata-bw.de/
- APK-Download (v3.1.0): https://d-02.winudf.com/b/APK/ZGUuaGFmYXMuYW5kcm9pZC5ydnNidXNyYWRhcl8xMDAwMTAwXzdiMWMwZDIw (aus APKPure)
