# Mail an BRN/VRN — Linie 725 Sandhausen

**An:** rheinneckarbus@deutschebahn.com (BRN)
**CC:** info@vrn.de (VRN)
**Betreff:** Linie 725 (Ortsbus Sandhausen): Strukturelle Fahrplanunterdeckung in beiden Richtungen und Datenqualitätsprobleme

---

Sehr geehrte Damen und Herren,

als Fahrgast und Anwohner in Sandhausen habe ich über 16 Tage (08.06.–22.06.2026) systematisch die HAFAS-Echtzeitdaten Ihrer Linie 725 ausgewertet (n=393 Fahrten). Die Befunde sind über den gesamten Zeitraum stabil und statistisch belastbar.

## Hauptbefund: Fahrplan in beiden Richtungen strukturell zu eng

| Richtung | Plan-Abfahrt → -Ankunft | Plan-Dauer | Real-Median | Median Verspätung | Mean Verspätung | Max | n |
|---|---|---|---|---|---|---|---|
| Gegen Uhrzeigersinn (Schleife A) | :38 → :54 | 16 min | 19 min | **+4 min** | **+4,11 min** | +12 | 203 |
| Uhrzeigersinn (Schleife B) | :04 → :20 | 16 min | 19 min | **+4 min** | **+4,41 min** | +10 | 190 |

In beiden Richtungen ist die tatsächliche Fahrtdauer **median 19 % länger als geplant**.

In Uhrzeigerrichtung hat das die direkte Folge, dass der Anschluss zur S3 :24 nach Karlsruhe Hbf nur in **61,6 %** der Fahrten erreicht wird — **38,4 % der Fahrgäste verpassen den Anschluss**.

## Verspätungsverlauf — wo es konkret passiert

Die folgenden Tabellen zeigen pro Halt die **Median-Verspätung gegenüber dem Plan** und die **Plan-Abweichung gegenüber dem vorherigen Halt** (positive Werte = Verspätung baut sich weiter auf, negative Werte = Pufferzeit holt Verspätung wieder rein).

### Schleife A (gegen Uhrzeigersinn)

| Halt | Median Verspätung | Plan-Abweichung zum Vorhalt |
|---|---|---|
| Büchertstraße (1.) | 0 min | (Start) |
| Neues Rathaus (1.) | 1 | **+1** |
| Altes Rathaus | 1 | 0 |
| **Kisselgasse** | **2** | **+1** |
| **Lebenshilfe** | **3** | **+1** |
| **Stranggasse** | **4** | **+1** |
| Waldkindergarten | 3 | −1 (Pufferzeit) |
| Herrmann-Löns | 2 | −1 (Pufferzeit) |
| Waldstraße | 3 | +1 |
| Lattweg | 3 | 0 |
| Schillerstraße | 3 | 0 |
| **Herchheimer Straße** | **5** | **+2** |
| Neues Rathaus (2.) | 4 | −1 (Pufferzeit) |
| Büchertstraße (2.) | 4 | 0 |
| St. Ilgen West | 4 | 0 |

In A baut sich Verspätung in **zwei Phasen** auf: **kontinuierlich von Altes Rathaus über Kisselgasse und Lebenshilfe bis Stranggasse (insgesamt +3 min)**, wird durch Pufferzeit Stranggasse → Waldkindergarten → Herrmann-Löns wieder reduziert, dann zweite Spitze bei Herchheimer Straße (+2).

### Schleife B (Uhrzeigersinn)

| Halt | Median Verspätung | Plan-Abweichung zum Vorhalt |
|---|---|---|
| Büchertstraße (1.) | 1 min | (Start) |
| Neues Rathaus (1.) | 1 | 0 |
| **Herchheimer Straße** | **3** | **+2** |
| Schillerstraße | 1 | −2 (Pufferzeit) |
| Lattweg / Waldstraße / Herrmann-Löns / Waldkdg / Stranggasse / Lebenshilfe | 1 | ≈0 |
| **Kisselgasse** | **2** | **+1** |
| Altes Rathaus | 2 | 0 |
| **Neues Rathaus (2.)** | **3** | **+1** |
| **Büchertstraße (2.)** | **4** | **+1** |
| St. Ilgen West | 4 | 0 |

In B baut sich initial bei Herchheimer +2 Min auf, wird bis Schillerstraße durch Pufferzeit aufgeholt, bleibt stabil bei +1 Min — und entsteht dann **erneut in der zweiten Schleifenhälfte in drei Etappen** (Lebenshilfe→Kisselgasse, Altes→Neues Rathaus, Neues Rathaus→Büchertstraße).

## Konkrete Engstellen-Diagnose

**Zwei Streckenabschnitte sind in beiden Richtungen offensichtlich zu knapp im Plan:**

**1. Neues Rathaus ↔ Herchheimer Straße**

- Plan: 1 min
- Real-Median: 3 min in Uhrzeigerrichtung, in Gegenrichtung Aufbau +2 min (Schillerstraße → Herchheimer)
- Andere Linien benötigen für die **kürzere** Strecke Altes Rathaus → Herchheimer ebenfalls 2 Minuten — die im Plan vorgegebene 1 Minute ist daher unrealistisch
- Zusätzliches Problem: Linksabbiegen in die Hauptstraße ist bei dichtem Querverkehr aus dem Ortszentrum schwer zu schaffen

**2. Bereich Rathaus ↔ Kisselgasse ↔ Lebenshilfe**

- Plan: 1 min für Kisselgasse ↔ Altes Rathaus
- In Gegenuhrzeigerrichtung baut sich kontinuierlich +3 min Verspätung von Altes Rathaus bis Stranggasse auf (jeweils +1 min pro Streckenabschnitt)
- In Uhrzeigerrichtung +1 min Lebenshilfe → Kisselgasse und +1 min Altes Rathaus → Neues Rathaus
- **Andere Linien benötigen für die Strecke Kisselgasse ↔ Altes Rathaus ebenfalls 2 Minuten** — auch hier ist der 1-Minuten-Plan-Wert unrealistisch
- Vermutung: Lichtsignalanlagen verursachen einen Großteil dieser Verzögerungen

## Konkrete Verbesserungsvorschläge

**Variante A (nur für die :04-Fahrten in Uhrzeigerrichtung):** Plan-Abfahrt um 2 Minuten vorverlegen. Damit hätte die Realität (Median +4 min) wieder eine Chance gegen den 4-Minuten-Anschlusspuffer zur S3.

*Wichtig:* Die :38-Fahrten in Gegenuhrzeigerrichtung dürfen **nicht** vorverlegt werden — sie sind der einzige Anschluss für Züge aus Richtung Karlsruhe. Für diese Richtung kommt nur Variante B in Frage.

**Variante B (für beide Richtungen):** Streckenplan korrigieren:
- Neues Rathaus ↔ Herchheimer Straße: +1 Minute (in beiden Richtungen unrealistisch)
- Kisselgasse ↔ Altes Rathaus: +1 Minute (in beiden Richtungen unrealistisch)
- In Uhrzeigerrichtung zusätzlich +1 Min für Neues Rathaus→Büchertstraße
- In Gegenuhrzeigerrichtung zusätzlich +1 Min für Lebenshilfe→Stranggasse

Kompensation durch Reduktion der überdimensionierten Pufferzeiten Herchheimer → Schillerstraße (B) und Stranggasse → Herrmann-Löns (A), die ohnehin nie eingehalten werden.

## Weitere Beobachtungen

- **Start-Verspätung der :04-Fahrten** (Uhrzeigerrichtung): In ca. 14 % (26/183) der Fahrten startet der Bus 2–7 Minuten zu spät, obwohl die ankommenden Züge pünktlich sind.
- **Halt Sandhausen Herrmann-Löns-Weg/Friedhof** (planmäßig in den 07:04- und 08:04-Schul-Fahrten ausgelassen): Wird nach eigener Beobachtung von vielen Fahrern dennoch angefahren — das verschärft die Verspätung um geschätzt 2 Minuten in genau den schlimmsten Fahrten. (Aus den HAFAS-Daten nicht eindeutig nachweisbar, da die Daten auf interpolierte Fahrtkurven gemappt sind.)
- **Live-Daten im DB Navigator:** Die Linie 725 hat in HAFAS/HaCon Live-Daten unter dem Tenant „DB Regio Bus Baden-Württemberg" verfügbar, diese werden aber im DB Navigator nicht angezeigt. Wer kann das aktivieren?
- **Halt-Ansage Sandhausen Stranggasse** (Gegenuhrzeigerrichtung): kommt deutlich zu spät, meist erst wenn der Bus bereits am Halt vorbeifährt — vermutlich Folge der falschen Geokoordinate (siehe unten).
- **Status der Umstellung auf emissionsfreie Elektrobusse:** Zum Fahrplanwechsel am 14. Dezember 2025 hat die Gemeinde Sandhausen offiziell angekündigt, dass auf Linie 725 emissionsfreie Elektrobusse zum Einsatz kommen ([Quelle: sandhausen.de](https://www.sandhausen.de/de/Aktuelles/Neuigkeiten/Neuigkeit?view=publish&item=article&id=1911)). Sechs Monate nach diesem Termin werden auf der Linie weiterhin Verbrennerbusse eingesetzt. Ist die Umstellung weiterhin geplant — wenn ja, mit welchem Zeitplan?
- **Zukünftige Bauarbeiten Hauptstraße Sandhausen** sollten in der Plan-Anpassung mitgedacht werden.

## Datenqualität in HAFAS — falsche Geokoordinaten

Folgende Halte haben in HAFAS falsch hinterlegte Geokoordinaten (vermutlich durch BRN dort eingetragen):

- **Sandhausen Stranggasse** (extId 4407851 / BRN_305701 & BRN_305702): Die in HAFAS hinterlegte Position liegt zu weit südlich — der echte Halt liegt auf derselben Straße, aber nördlicher. Konsequenz: Halt-Ansage triggert basierend auf falscher Position, kommt zu spät.
- **Sandhausen Herchheimer Straße** (extId 4466856 / BRN_300293 & BRN_300294): Geokoordinaten ebenfalls falsch.

## Umstiegszeit Bushaltestelle West ↔ S3 (DB Navigator)

Im DB Navigator wird für den Umstieg von der Bushaltestelle West auf Gleis 2 (Richtung Karlsruhe) eine Umstiegszeit von **4 Minuten** angesetzt — die echte Umstiegszeit beträgt **1 Minute**. Gegenrichtung Gleis 1 → Bushaltestelle: real eher 2–3 Minuten statt 4. Die zu hohe Umstiegszeit kaschiert den unrealistischen Bus-Plan und sollte korrigiert werden.

## Linie 719

Die 9:40-Fahrt (St. Leon-Rot Bahnhof → St. Leon-Rot See) sollte das Industriegebiet (SAP-Allee, Opelstraße) anfahren — diese Verbindung ist die einzige sinnvolle Anschlussmöglichkeit für Pendler aus Sandhausen via Ortsbus 725.

## Strukturelle Verkehrsprobleme in Sandhausen — Antrag bei der Gemeinde

Folgende Punkte verursachen ebenfalls regelmäßig Verzögerungen für die Linie 725. Da BRN als Verkehrsunternehmen mehr Gewicht bei der Gemeinde hat als ein einzelner Fahrgast, bitte ich Sie, diese bei der Gemeinde Sandhausen zu beantragen:

**Parksituation — eingeschränktes Vorbeikommen bei Gegenverkehr:**
- Bahnhofstraße Hausnummer 16–32 beidseitig
- Bahnhofstraße 38–64 beidseitig
- Alter Postweg 31–47 beidseitig
- Hauptstraße 163–155 beidseitig
- Hauptstraße 42–58 beidseitig

In Bahnhofstraße, Alter Postweg und Hauptstraße bilden parkende PKW lange Felder, die das Vorbeikommen bei Gegenverkehr stark einschränken oder unmöglich machen. Ausweichbereiche durch Aufbruch dieser Felder wären notwendig.

**Wendekreis-Probleme beim Abbiegen durch Parker im Kreuzungsbereich:**
Parkende PKW nahe der Kreuzungsbereiche behindern den Wendekreis des Busses beim Abbiegen erheblich.
- Waldstraße 54→56 Nordseite (Sperrfläche bis mindestens zur Hofeinfahrt von Hausnummer 54, ggf. bis zum Baum bei Hausnummer 56)
- Wingertstraße 76→74 Nordseite (Sperrfläche bis Mitte von Hausnummer 74)

**Besonders kritisch — Sicht-Gefahrenstelle:**
Die markierten Parkplätze Hauptstraße Ecke Alter Postweg, vor Hausnummern 21 & 23: Für Fahrten **gegen den Uhrzeigersinn** ist beim Abbiegen auf die Hauptstraße der Querverkehr aus dem Ortszentrum kaum einzusehen. Es gab dort bereits viele Beinaheunfälle — nur eine Frage der Zeit, bis ein Unfall passiert. Diese markierten Parkplätze sollten entwidmet werden.

**Bodenwelle Konrad-Adenauer-Straße bei Haltestelle Stranggasse:**
Die Bodenwelle / Verkehrsschwelle in der Konrad-Adenauer-Straße im Bereich der Haltestelle Stranggasse ist deutlich zu hoch — das Heck der eingesetzten Busse setzt regelmäßig auf, was zu Schäden am Fahrzeug und Geräuschbelästigung führt.

Die Höhe einer solchen Bodenwelle muss nach geltender Rechtsprechung so bemessen sein, dass sie für den regulären Linienbusverkehr ohne Aufsetzen befahrbar ist. Relevante Urteile zur Verkehrssicherungspflicht:

- OLG Köln, Urteil vom 09.01.1992, Az. 7 U 10/91 ([openjur.de](https://openjur.de/u/443703.html))
- BGH, Urteil vom 16.05.1991, Az. III ZR 125/90 ([wolterskluwer-online.de](https://research.wolterskluwer-online.de/document/d4728ab0-2a26-40b6-bb14-5a148910d9e0))

Die Bodenwelle sollte bei der Gemeinde abgesenkt oder verflacht beantragt werden.

**LSA Hauptstraße / Carl-Benz-Straße:**
Wartezeit bei keinem Querverkehr zu lang — die Hauptstraße wird mindestens 30 Sekunden, manchmal länger ohne Grund blockiert. Es wirkt, als ob die Kontaktschleifen nicht funktionieren oder die Mindestzeit zu hoch angesetzt ist (5 Sekunden ohne Kontakt würden völlig ausreichen).

## Datengrundlage

Auf Wunsch liefere ich:
- JSONL-Rohdaten aller 393 ausgewerteten Fahrten
- Auswertungsskript mit reproduzierbaren Ergebnissen pro Halt und Streckenabschnitt
- Erweitertes Monitoring (läuft 24/7 weiter, Daten werden mit jedem Tag belastbarer)

Über eine Rückmeldung würde ich mich freuen.

Mit freundlichen Grüßen,
[Name, Adresse]
