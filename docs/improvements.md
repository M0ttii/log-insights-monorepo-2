# Log Insights – Optionale Verbesserungen

**Stand:** 17. Oktober 2026  
**Status:** Backlog. Keine Anforderung und keine Abnahmevoraussetzung. Grundlage: [Produktkonzept](concept.md) v3.8, [technische Spezifikation](technical.md) v3.4, [UI-Konzept](ui-concept.md) v3.1.

## Regeln

- Die Bonus-Tracks I-01–I-04 sind im Konzept P2 (A-32–A-35; I-02 bzw. A-32 seit Konzept 3.6 P1) und beginnen nach M1, sobald der Kernablauf funktioniert (concept 4); sie blockieren P0 und P1 nie.
- Alle übrigen Einträge werden erst begonnen, wenn alle P0-Anforderungen erfüllt sind und der README-Entwurf steht. P1 (Web-App) hat Vorrang.
- Wird ein Eintrag umgesetzt, wandert er mit Begründung ins Hauptdokument.
- Kein Eintrag darf eine Regel R-01–R-11 stillschweigend ändern.
- Reihenfolge innerhalb einer Tabelle = empfohlene Reihenfolge.

## Bonus-Tracks aus dem Brief (P2 im Konzept)

| ID | Verbesserung | Bezug | Aufwand | Hinweis |
|---|---|---|---|---|
| **I-01** | **Indizes durch den Agenten:** Tools `create_time_index(dataset, from, to)` und `drop_time_index(id)` mit Messung wiederholter Fragen mit und ohne Index; Tabelle Aufbauzeit gegen eingesparte Zeit. Nur bei `LOG_INSIGHTS_WORKSPACE_TOOLS=1` registriert | A-33 | mittel | Gut für den Sonderpreis „Best MCP Server“; zählt auf den Trade-off, den der Brief verlangt. Hinter dem Schalter, damit die Tool-Wahl im Kern unverändert bleibt |
| **I-02** | **Große Datensätze:** OpenTelemetry-Parquet direkt aus dem Object Storage (`read_parquet` über eine oder mehrere URLs); eine View bildet `ServiceName`, `SeverityText` und `Body` auf die Spalten von `log_events` ab, damit dieselben Tools mit `dataset = otel` arbeiten; ausgewiesen werden abgefragte Zeilen, Abfragezeiten und Nützlichkeit | A-32 | mittel–hoch | Sonderpreis „Working with Huge Datasets“; mit `part_000` beginnen. Zusammen mit I-01 eine Geschichte: Volltext über Remote-Daten, indexiertes Zeitfenster, gemessener Trade-off |
| **I-03** | **Log-Trace-Korrelation** mit HDFS_v3 TraceBench, RCAEval oder Nezha | A-34 | hoch | Nur mit klar abgegrenzter Frage. Seit U26 (A-39) liegt HDFS_v1 als Logkorpus vor; Traces und Metriken bleiben hier, eine Korrelation über Datensätze ist nicht Teil von U26 |
| **I-04** | **Row-Level-Security je Rolle** | A-35 | mittel | Widerspricht dem Grundsatz „Rollen sind Perspektiven“; nur als getrennte Demo |

## Funktionen aus Konzept v2.2 (zurückgestellt)

| ID | Verbesserung | Stand in v3.0 |
|---|---|---|
| **I-10** | Zeitliche Reihenfolge und gemeinsames Auftreten von Mustern (`onset_order`, `co_occurring_groups`) | Episoden je Muster und Vorläufer eines Musters über alle Episoden (A-36, R-11) sind P0; allgemeine Überlappung zwischen beliebigen Mustern fehlt |
| **I-11** | Veränderungszerlegung als eigenes Tool (`top_contributors`) mit Summenprobe | `count_events` mit `compare` und `group_by` liefert C, B und Δ je Wert |
| **I-12** | Adaptive Hypothesenschleife mit Katalog prüfbarer Erklärungstypen und Abschlussblock | Unterscheidende Prüfungen je Erklärungstyp sind als Playbook-Inhalt P0 (A-17, concept 6); offen bleiben ein formaler Katalog mit eigener Ablaufsteuerung und ein Abschlussblock |
| **I-13** | `Similar events` zu einem Ereignis über die Volltextsuche | Suche mit eigenen Begriffen möglich |
| **I-14** | Gespeicherte Untersuchungen, Historie und `Run again` | Unterhaltungen leben in der Browser-Sitzung; Receipts sind dauerhaft (Dateien). Seit UI-Konzept 3.0 gibt es Export und Import einzelner Läufe als Datei für den Demo-Rückfall (ui-concept 4.5), ohne Liste und Server-Speicher |
| **I-15** | Rückfragen mit Persistenz und Ablaufzeit | Claude fragt im Chat nach; keine Persistenz |
| **I-16** | Übergabetext je Rolle (`Copy summary`) und Markdown-Export | – |
| **I-17** | Ansicht `Answer quality` mit dem letzten Eval-Lauf | Eval-Ergebnis im README |
| **I-18** | Variable Musterstellen mit Werteverteilung | Muster ohne Parameterwerte |
| **I-19** | Deutsche Fragen und Antworten | Englisch |
| **I-20** | Semantisch ähnliche Ereignisse über Vektor- oder Hybridsuche | LOG-41 ausdrücklich beauftragt: versionierte Embedding-Snapshots, persistierte Query-Embeddings, SereneDB-Vektorindex und nachvollziehbare Fusion; ausdrücklicher Providerfehler statt Fallback. Kein Qualitätsvorteil ohne Vergleichsmessung. |

## Zusätzliche Evaluation

| ID | Verbesserung | Umfang und Grenze |
|---|---|---|
| **I-21** | **Nutzen historischer Vergleichsevidenz:** dieselben aktuellen Belege und Fragen mit bzw. ohne zusätzliche Evidenz aus einer passenden Vorperiode bewerten | Begrenztes Experiment nach vollständigem P0 und README-Entwurf; P1 hat Vorrang. Gleiche Modell- und Bewertungsbedingungen, nur die historische Evidenz variiert. Belegpakete aus bestehenden Tools, keine indirekte Historie in der Variante ohne Referenz. Prüft Hypothesenstatus, Untersuchungsreihenfolge und nächsten Schritt; auch unveränderte, schlechtere und unklare Ergebnisse werden berichtet. Keine neuen Tools, kein Ursachenbeweis, kein Nachweis für den gesamten Agentenablauf. Durchführung: [technical.md § 13.4](technical.md#134-optional-wirkung-historischer-vergleichsevidenz). |

Der Baseline-Vergleich, unabhängige Holdouts und die Messung von Antwortqualität, Laufzeit und Aufwand sind bereits P0 nach concept A-21. I-21 ergänzt diese Verifikation und ist weder Teil von U16 noch Voraussetzung für M2. Die vorhandenen Periodenvergleiche und Vorläufer-Grundraten bleiben verpflichtende Tool-Funktionen.

## UI-Komfort

| ID | Verbesserung |
|---|---|
| **I-30** | Nichtmodaler Split mit Antwort und Beleg nebeneinander ab etwa 1600 px (der Rollenvergleich, A-38, ist bereits P1) |
| **I-31** | Zeitraum per Diagrammauswahl ändern |
| **I-32** | Command Palette |
| **I-33** | ~~Dark Mode~~ – seit UI-Konzept 3.1 umgesetzt: SereneDB-Theme, dunkel als Standard, hell als zweites Theme |

## Änderungen

**18.10.2026 (Konzept v3.8):** Weitere Loghub-Korpora sind als A-39 (U26, LOG-40) beauftragter Ausbau im Hauptkonzept, kein Backlog-Eintrag. I-02 bleibt bei OTel-Parquet; I-03 grenzt sich von HDFS_v1 ab. Weitere Loghub-Quellen (etwa Hadoop, Spark, Thunderbird) wären je ein Katalogeintrag mit Parser, ohne eigenen Backlog-Eintrag.

**18.10.2026 (UI-Konzept v3.1):** I-33 (Dark Mode) mit dem SereneDB-Theme ins Hauptkonzept gewandert.

**18.10.2026 (UI-Konzept v3.0):** Grundlagen auf Konzept 3.7, technical 3.3 und UI-Konzept 3.0 aktualisiert; I-14 nennt den dateibasierten Export und Import einzelner Läufe, der ins Hauptkonzept gewandert ist.

**17.10.2026 (Konzept v3.6):** I-02 (A-32) ist im Konzept P1 nach M1 und läuft vor den UI-Einträgen I-30–I-33 (concept 4); bevorzugter Weg ist ein Index über externe Dateien. Historischer Ausschluss für I-20; durch den ausdrücklichen LOG-41-Auftrag vom 18.10.2026 gezielt aufgehoben (concept 3.2).

**17.10.2026 (Konzept v3.4):** I-21 als optionalen Evidenzvergleich ergänzt; Beginn nach vollständigem P0, ohne zusätzliche Tools oder Abnahmevoraussetzung. Baseline, Holdouts und Aufwandsmessung sind im Hauptkonzept A-21 verankert. Regelverweis auf R-01–R-11 aktualisiert.

**17.10.2026 (Konzept v3.3):** Bonus-Tracks beginnen nach M1 statt nach vollständigem P0. I-01 hinter Schalter, I-02 über eine View für dieselben Tools. I-10 und I-12 teilweise in P0 übernommen (Vorläuferanalyse, unterscheidende Prüfungen).

**17.10.2026:** Neu geordnet für Konzept v3.0. Bonus-Tracks aus dem Brief aufgenommen (I-01–I-04). Funktionen aus v2.2, die nicht mehr Pflichtumfang sind, als I-10–I-20 erhalten. Die Härtungen der früheren Version (Widerruf, Ablauf-Sweep, Lifecycle-Rennen, Heartbeats, Migrationslock) entfallen ersatzlos, da es weder Partnerdaten noch Jobsystem gibt.
