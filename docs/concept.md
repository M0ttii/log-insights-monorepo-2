# Produktkonzept: Log Insights – Making Sense of Logs

**Version:** 3.9 vom 18.10.2026 · Abgabeumfang nach Originalbrief und aufgeschobene Veröffentlichung (A-21, A-23, Abschnitt 4); 3.8: Erweiterungskorpora HDFS, OpenSSH, Apache, Linux und ZooKeeper (5.5, A-39, Abschnitt 13); 3.7: Web-App-Entscheidungen nach Fertigstellung von Tools und MCP-Server; 3.6: Entscheidungen aus dem Gespräch mit dem SereneDB-Team; 3.5: Profiling-Entscheidungen aus dem geladenen Korpus; 3.4: Wirksamkeitsnachweis und unabhängige Testfragen; Version 3.0 ersetzte 2.2 vollständig\
**Anlass:** National AI Hackathon 2026 (SchubKI), Challenge „Making Sense of Logs: The Right Insights for the Right People“ von SereneDB  
**Maßgebliche Quellen:** veröffentlichter Challenge-Brief und SereneDB-Guidance „Getting started with SereneDB“ (beide am 17.10.2026 bereitgestellt). Bei Widerspruch gilt der Brief; wo die Guidance konkreter ist (Setup, Loader, Ownership), gilt die Guidance.  
**Status:** verbindliche Produktdefinition für das 48-Stunden-Arbeitsfenster am 17.–18.10.2026. Technische Umsetzung: [technical.md](technical.md). Oberfläche: [ui-concept.md](ui-concept.md). Optionales: [improvements.md](improvements.md).

## 1. Auftrag

Wir bauen einen **funktionierenden Prototyp**, in dem ein KI-Agent über eine kleine Menge klar beschriebener Tools gezielte Fragen an die Logs stellt. **SereneDB sucht und rechnet, der Agent erklärt die zurückgegebenen Belege** und empfiehlt nächste Schritte – für drei Rollen, mit demselben Agenten und demselben Basiskorpus aus **BGL** und **OpenStack**.

- **Engineer:** Was ist ausgefallen, in welcher Komponente, was passierte unmittelbar davor und danach? Relevante Fehlermeldungen und Nachbarereignisse, mögliche Ursache, nächste Prüfung.
- **Team Lead:** Welche Probleme wiederholen sich, wie oft, welche Komponenten und Teams sind beteiligt? Zählungen und Trends über einen genannten Zeitraum mit der Ownership-Tabelle; was das Team zuerst untersuchen sollte.
- **Manager:** Welche beobachteten Probleme verdienen zuerst Aufmerksamkeit, und was soll als Nächstes passieren? Kurze, priorisierte Risiken und Maßnahmen auf Basis gemessener Häufigkeit und betroffener Komponenten – ohne erfundene finanzielle Verluste, Ausfallzeiten oder Kundenauswirkungen.

**Leitsatz für Demo, Slides und README:** *„SereneDB computes, Claude explains – and every number has a receipt.“*

## 2. Wie wir gewinnen

### 2.1 Bewertung und unsere Antwort

| Kriterium (Gewicht) | Was die Jury sehen will | Unsere Antwort | Anforderungen |
|---|---|---|---|
| **Role-appropriate insight (30 %)** | Drei unterschiedliche Verwendungen der Belege: Fehleruntersuchung, wiederkehrende Muster, priorisierte Risiken und Maßnahmen | Rollen-Playbooks mit eigenen Leitfragen, Pflichtbelegen, Belegebenen, Prüfungen und Entscheidungen im nächsten Schritt; ein rollenspezifischer Antwortkern, damit sich die Antworten schon im Aufbau unterscheiden; Rollenführung auch ohne Prompt-Wahl; drei belegte Rollensichten in Untersuchung und Demo | A-17–A-20, A-37, A-38 |
| **Search and analytics together (25 %)** | Relevante Volltextbelege und korrekte Aggregationen über den genannten Datenumfang | BM25-Volltextsuche mit Phrasen- und Fuzzy-Modus, Zeitfiltern und Nachbarereignissen; Vorläuferanalyse über alle Episoden eines Musters; Gesamtzählungen über das ganze Korpus nach Datensatz, Team und Komponente; Wochentrends; OpenStack-Latenzperzentile und Fehlerraten – alles in SereneDB berechnet | A-05–A-12, A-36 |
| **Recommendation quality (25 %)** | Konkrete nächste Schritte aus Query-Belegen; Fakten und Hypothesen klar getrennt | Unterscheidende Prüfungen, die der Agent selbst ausführt, bevor er empfiehlt; Hypothesenstatus mit Beleg; Fakt-ID an jeder Zahl mit deterministischer Prüfung; inhaltliche Prüfung der tatsächlich gezeigten Rollenantworten gegen die Query-Belege | A-13, A-14, A-17, A-20, A-21 |
| **Execution (20 %)** | Läuft aus sauberem Checkout, klare Anleitung, schlüssige Demo, Neuheit, Präsentation | Ein Setup-Befehl, MCP-Verbindung mit einer Zeile, Web-App als Demo-Bühne, ausgearbeitete Untersuchung, Slides, Live-Demo ≤ 5 Minuten und Abgabevideo ≤ 3 Minuten | A-01, A-15, A-21–A-26 |

**Entscheidend bei Gleichstand: Nutzung von SereneDB.** Im Gespräch mit dem SereneDB-Team am 17.10.2026 nannte die Jury als Unterscheidungsmerkmal zwischen zwei vollständigen, korrekten Einreichungen, wie sie SereneDB nutzen: neue Funktionen der Engine und möglichst viel Berechnung in SereneDB statt in Skripten, die Daten umformen. Das ist kein eigenes Gewicht im Brief, entscheidet aber knappe Vergleiche. Daraus folgen der Rechenort (2.2 Punkt 7, technical.md § 5.3), die Funktionsübersicht in README, Slides und Demo (A-23, A-24) und der Vorrang nach M1 (Abschnitt 4). Weitere Aussagen aus dem Gespräch: Chat oder Dashboard ist freigestellt; die Jury stellt **eigene, unbekannte Fragen** und liest die von uns hinterlegten Fragen mit (A-23); sie arbeitet mit **Claude Opus 5.5** (`claude-opus-5-5`, O-01); häufige Schwäche anderer Teams ist, dass Modelle die SereneDB-Doku nicht gründlich lesen und SereneDB-eigene Funktionen übersehen (technical.md § 5.3).

Der Sonderpreis **Best MCP Server** bewertet Tool-Beschreibungen, Tool-Auswahl durch den Agenten, Ergebnislimits und die Verbindung über unsere Anleitung. Unser Kern ist genau darauf ausgelegt (A-15, A-16, A-37): acht klar abgegrenzte Tools, Rollenführung ohne Prompt-Wahl, optional Index-Tools mit gemessenem Trade-off (A-33). Der Sonderpreis **Working with Huge Datasets** (A-32) ist seit 3.6 P1 nach M1, weil er SereneDB-Funktionen (Index über externe Dateien) direkt zeigt.

### 2.2 Differenzierung

1. **Query Receipts.** Jedes Tool-Ergebnis erhält eine Belegnummer wie `[r_7f3a9c21]`. Der Receipt enthält die validierte Tool-Eingabe, exaktes SQL, gebundene Parameter, Datenumfang, Datenversion, Laufzeit in SereneDB, Kürzungshinweis und das Ergebnis. Er ist über MCP und im Evidence Drawer der Web-App abrufbar.
2. **Faktenprüfung.** Jede Zahl im Tool-Ergebnis trägt eine vom Tool vergebene Fakt-ID wie `r_7f3a9c21.f4`; die Antwort zitiert diese ID, statt selbst Pfade zu bilden. Ein deterministisches Tool prüft Wert, Kennzahl und Gruppe der Behauptung gegen den Fakt; der Umfang ergibt sich aus dem Receipt. MCP-Weg und Web-App prüfen auf demselben Weg; die Antwort nennt, welche Claims geprüft wurden, und die Web-App markiert Fakt-IDs, die nicht zur Prüfung eingereicht wurden (`unchecked`), sowie Zahlen, denen keine Fakt-ID folgt (`uncited`). Beide Markierungen sind syntaktisch und prüfen nichts. Erklärungen und Kausalaussagen prüft dieses Tool nicht; sie werden an den vollständigen gezeigten Antworten inhaltlich geprüft (A-21).
3. **Rollen-Playbooks, die immer greifen.** Rollenunterschiede entstehen aus unterschiedlichen Fragen, Pflichtbelegen, Prüfungen, Entscheidungen und einem rollenspezifischen Antwortkern. Dieselben Playbooks leiten Claude (MCP) und den Web-Chat an – als MCP-Prompt und zusätzlich über Server-Instruktionen und `describe_corpus`, damit sie auch greifen, wenn jemand einfach eine Frage tippt.
4. **Belegte Diagnose statt Anekdote.** Der Agent führt unterscheidende Prüfungen selbst aus (Konzentration auf Nodes oder Streuung, Zeitmuster, Vorläufer), bevor er eine Hypothese einstuft. Die Vorläuferanalyse zählt in SereneDB über alle Episoden eines Musters, was davor häufiger auftritt als sonst – Volltext und Aggregation in einer Abfrage.
5. **Eine fiktive Plattform-Organisation über beide Datensätze.** Die Ownership-Tabelle verbindet BGL- und OpenStack-Komponenten mit gemeinsamen Teams; Zählungen nach Team laufen über das ganze Korpus, mit ehrlich benannter Grenze unterschiedlicher Zeiträume.
6. **Zwei Clients, eine Wahrheit.** Claude Code/Desktop und die Web-App verwenden dieselbe Tool-Registry; derselbe Tool-Aufruf liefert auf derselben Datenversion in beiden Clients dieselben Zahlen. Ein zusätzlicher Web-Rollenvergleich ist zurückgestellt; Untersuchung und echte Rollenläufe zeigen die unterschiedlichen Entscheidungen.
7. **SereneDB rechnet alles – sichtbar.** Parsing, Muster, Volltext, Zählungen, Episoden, Vorläufer, Perzentile, Raten und auch die Regelergebnisse (Einstufung nach R-06, Status nach R-10, Rangfolge nach R-08, Dominanz nach R-09) entstehen in SereneDB-SQL. TypeScript validiert Eingaben, vergibt Fakt-IDs, schreibt Receipts und prüft Claims, rechnet aber keine Analysewerte. Wir nutzen SereneDB-eigene Funktionen gezielt, wo sie eine Aufgabe direkt lösen (BM25-Index, Phrasen-, Fuzzy- und Regex-Suche, Trefferstellen, Term-Dictionary, `MATCH_RECOGNIZE`, Index über externe Dateien), und zeigen jede davon mit dem Tool und dem Receipt, in dem sie vorkommt (technical.md § 5.3).

Der formale Vergleich der Rollen-Playbooks mit einer einfachen Rollen-Anweisung ist seit der Nutzerentscheidung vom 18.10.2026 zurückgestellt (A-21). Eine bestandene Faktenprüfung allein belegt weder die Qualität der Empfehlung noch einen Vorteil gegenüber einer Baseline; ein solcher Vorteil wird ohne tatsächliche Messung nicht behauptet.

## 3. Was wir bauen

### 3.1 Komponenten

| Komponente | Zweck | Priorität |
|---|---|---|
| SereneDB lokal (Docker) | Speicherung, Volltextindex und sämtliche Berechnungen | P0 |
| Schema, Loader, Ownership-Tabelle | Basiskorpus reproduzierbar laden; SQL und Skripte im Repository | P0 |
| Tool-Schicht (acht Tools) | Parametrisierte Abfragen mit Limits, Fakt-IDs und Receipts | P0 |
| MCP-Server | Tools, Resources, Rollen-Prompts und Server-Instruktionen mit Rollenführung für Claude Code und Claude Desktop | P0 |
| Rollen-Playbooks | Leitfrage, Pflichtbelege, Prüfung vor der Empfehlung, Antwortkern und nächster Schritt je Rolle | P0 |
| Verifikation | Lade-Bilanz, Golden Queries, Faktenprüfung und inhaltlich geprüfte echte Rollenantworten mit zugänglichen Query-Belegen; formales Baseline-/Holdout-Eval zurückgestellt | P0 |
| Abgabe | README, Tool-Dokumentation, ausgearbeitete Untersuchung, Slides, Abgabevideo, Live-Demo | P0 |
| Web-App | Chat mit Rollenwahl und Live-Toolaufrufen, Evidence Drawer, Übersicht, Logs; zusätzlicher Rollenvergleich zurückgestellt | P1, vorhandene stabile Teile |
| Große Datensätze (A-32) | Volltext über OTel-Parquet per Index über externe Dateien, dieselben Tools | P1 nach M1 (seit 3.6) |
| Bonus-Tracks | Index-Tools des Agenten mit Messung (hinter Schalter), Traces, Row-Level-Security | P2 |

```text
Claude Code / Claude Desktop ──MCP (stdio)──┐
                                             ├──► Tool-Registry ──SQL──► SereneDB
Web-App: Chat (AI SDK + Claude) ─────────────┘     Zod, Limits           log_events, ownership
                                                        │
                                                        └──► Receipt-Dateien (.data/receipts)
```

### 3.2 Bewusst nicht gebaut

Eigene Agenten-Laufzeit mit Jobsystem, gespeicherte Untersuchungen und Rückfrage-Persistenz, Benutzer- und Zugangsverwaltung (stattdessen lokaler Betrieb: SereneDB und Web-App lauschen nur auf Loopback), Datenfreigabe- und Widerrufsprozesse, frei generiertes SQL durch den Agenten, Live-Ingestion, automatische Fixes, Tickets oder Paging sowie jede Form erfundener Geschäftswirkung. LOG-41 hebt den bisherigen Ausschluss von `ai_embed`, Vektor-/Hybridsuche und `ai_summarize_agg` gezielt auf: versionierte Retrieval-Repräsentationen und persistierte Query-Embeddings erlauben Wiederholungen innerhalb desselben Snapshots. Anbieter, Modellversion, Dimension und Normalisierung gehören zum Vertrag. Fehlender Schlüssel oder Provider-Ausfall ergeben einen ausdrücklichen Fehler, keinen stillen Moduswechsel. Zusammenfassungen dürfen nach einem Gate als gekennzeichneter Lesekontext erscheinen; Modellklassifikation, Ursachen- und Schwereurteile sind weiterhin keine gemessenen Fakten. Die Erweiterung ersetzt keine P0-Abnahme.

## 4. Prioritäten und Verbindlichkeit

**Nutzerentscheidung vom 18.10.2026 (LOG-56):** Für den Abschluss zählt nur noch der Originalbrief. Der bisher selbst gesetzte formale Baseline-/Dev-Vergleich mit Wiederholungen, unabhängiger Bewertung, Freeze und erstem Holdout sowie der zusätzliche Web-Rollenvergleich (A-38/U18) sind zurückgestellt und keine Abgabetore. Auch eine vollständige Rollen-/Prompt-Matrix in Claude Code, Desktop und Web ist keine Mindestanforderung: Ein tatsächlich genutzter Claude-Client mit mindestens einer belegten Antwort pro Rolle genügt. Vorhandene Erweiterungen bleiben bestehen; unerfüllte Zusatzprüfungen und bekannte Fehler bleiben sichtbar. Diese Entscheidung ändert keine Regel R-01–R-11, Zahlenprüfung oder Trennung von Beobachtung, Hypothese und Ursache. Sie ist keine Behauptung, das formale Eval sei bestanden.

**Veröffentlichung separat zurückgestellt (18.10.2026):** Der Eigentümer hat ausdrücklich entschieden, das Hauptrepository vorerst privat zu lassen. Öffentlich zugängliches Repository und Abgabedateien bleiben eine Anforderung des Briefs; diese ist damit noch offen. Die interne Fertigstellung von Code und Abgabeunterlagen ist keine abgeschlossene öffentliche Einreichung. Eine spätere Veröffentlichung braucht eine neue Freigabe; vorhandene Historie, PRs und Actions-Logs werden jetzt nicht veröffentlicht.

Die Umsetzung erfolgt mit mehreren parallel arbeitenden Coding-Agenten. Der Umfang wird deshalb nicht nach verfügbaren Stunden zugeschnitten, sondern nach Abhängigkeiten: Gemeinsame Verträge entstehen zuerst, danach arbeiten Agenten parallel an getrennten Paketen (technical.md § 14, 15).

| Priorität | Bedeutung |
|---|---|
| **P0 – Muss** | Mindestanforderungen des Briefs plus Receipts, Faktenprüfung, MCP-Server, alle acht Tools, Rollenführung und unterscheidende Prüfungen. Erreicht über die Meilensteine unten; darf nicht stillschweigend entfallen. |
| **P1 – Geplant** | Web-App als Demo-Bühne. Baut auf den gemeinsamen Verträgen auf, wird nach M1 gegen echte Tools verdrahtet und blockiert P0 nie. Ist sie zur Demo nicht stabil, läuft die Demo über Claude Desktop, und die Web-App zeigt nur ihre stabilen Teile. |
| **P2 – Bonus** | Sonderpreis-Tracks und Extras. Beginnen erst, wenn der Kernablauf funktioniert (M1), wie der Brief es verlangt, und blockieren P0 und P1 nie. |

**Vorrang nach M1 (seit 3.6):** Steht nach M1 eine Wahl zwischen weiterem UI-Ausbau über A-26–A-29 und A-38 hinaus (etwa I-30–I-33) und mehr Berechnung in SereneDB, hat SereneDB Vorrang: die Verlagerung der Regel-Logik in SQL, `MATCH_RECOGNIZE` für Episoden und Anker, Trefferstellen aus dem Index (technical.md § 14, U22–U25) und A-32, das dafür von P2 auf P1 steigt. P0 und die vorhandenen Web-Funktionen (A-26–A-29) bleiben davon unberührt; A-38 ist seit der Umfangsentscheidung zurückgestellt.

P0 wird in zwei Meilensteinen mit einem Ausbau dazwischen erreicht. Grundlage ist die Empfehlung des Briefs, zuerst einen vollständigen Ablauf zu bauen und Erweiterungen danach.

| Meilenstein | Inhalt | Nachweis |
|---|---|---|
| **M1 · Kernablauf** | `describe_corpus`, `search_logs`, `get_log_context`, `count_events`, `event_trend` und `check_claims` mit Receipts über MCP; alle drei Rollen einmal über Claude Code oder Claude Desktop beantwortet. Deckt die Mindestanforderungen des Briefs an Suche, Umgebung, Zählung und Trend. | Drei echte Rollenantworten im gewählten Claude-Client mit Receipts und Faktenprüfung |
| **Ausbau** | Periodenvergleich als Option von `count_events` (A-09), `recurring_patterns` mit Rangfolge (A-10, A-11), `latency_stats` (A-12), Phrasen- und Fuzzy-Suche (A-05), Vorläuferanalyse (A-36), Rollenführung ohne Prompt (A-37) und Playbooks mit unterscheidenden Prüfungen (A-17–A-19). Alles davon ist P0; nichts hängt mehr von der Fallwahl ab. | Golden Queries aller acht Tools grün; Rollenantworten erfüllen den Antwortvertrag |
| **M2 · Abgabe vollständig** | Mindestens eine echte, inhaltlich geprüfte Agentenantwort pro Rolle, ausgearbeitete Untersuchung, öffentliches Repository mit README und Tool-Referenz, Slides, Abgabevideo, geprobte Demo, Frischklon-Test. | A-21–A-24 im Umfang der Nutzerentscheidung erfüllt; formales Eval und Web-Vergleich ausdrücklich zurückgestellt; öffentliche Einreichung bis zur Freigabe offen |

Was zur Abgabe fehlt, nennt das README mit Anforderungskennung als nicht erfüllt. Nichts Unfertiges wird als funktionierend präsentiert. Synthetische Testdaten sind als solche gekennzeichnet und erscheinen nie in Demo-Antworten.

## 5. Basiskorpus

### 5.1 Datensätze

| | BGL | OpenStack |
|---|---|---|
| Umfang laut Brief | 4.747.963 Zeilen, 709 MB, 214,7 Tage | 207.820 Zeilen, 58,6 MB |
| Rolle laut Brief | Such- und Trenddaten | Aggregationsdaten: Zählungen, Latenzverteilungen, Fehlerraten |
| Herkunft | BlueGene/L-Supercomputer, LLNL (2005–2006) | Nova-Dienste `nova-api`, `nova-compute`, `nova-scheduler` (2017) |
| Felder | Alert-Label, Unix-Sekunden, Datum, Node, Zeitstempel, Node, Typ, Komponente, Level, Meldung | Dateipräfix, Zeitstempel (ms), PID, Level, Logger, Request-Block `[req-… user project]`, Meldung; API-Zugriffe mit Methode, Pfad, `status`, `len`, `time` |
| Labels | Erste Spalte: `-` = kein Alert, sonst Alert-Kategorie (41 Kategorien, 348.460 Zeilen) | Vier Instanz-IDs mit injizierten Anomalien (`anomaly_labels.txt`), alle aus dem Lauf `openstack_abnormal.log`; 100 Zeilen nennen eine davon (O-04) |
| Zeitbasis | Unix-Sekunden sind UTC; der Textzeitstempel ist lokale Systemzeit (im 2k-Sample 7 Stunden Versatz). `ts` = Unix-Sekunden plus Mikrosekunden aus dem Text | Zeitstempel ohne Zonenangabe; als UTC behandelt und so gekennzeichnet |
| Besondere Stärke | Viel Textvielfalt für Volltextsuche; lange Zeitspanne für Wochenvergleiche; Nodes mit Rack-Hierarchie | API-Zugriffszeilen mit HTTP-Status und Latenz; Request-IDs erlauben Anfragezählungen, fehlen aber bei Metadaten-Zugriffen (`[-]`, im Korpus 9.196 von 98.733 Zugriffszeilen) |

Die Zeilenzahlen laut Brief sind das Soll für die Ladebilanz (A-02). Eine Abweichung wird erklärt, nicht übergangen.

### 5.2 Grenzen des Korpus

- **Keine gemeinsame Zeitachse.** BGL (2005–2006) und OpenStack (2017) überlappen nicht. Trends und Periodenvergleiche erfolgen immer je Datensatz. Zahlen über beide Datensätze sind Zählungen über die jeweils gesamte Zeitspanne und werden so bezeichnet. Das gilt für jeden Datensatz, auch für die Erweiterungen (5.5): Kalendarische Überlappung (Apache, Linux und BGL 2005–2006) ist keine gemeinsame Zeitachse, weil es andere Systeme mit unbekannten Zeitzonen sind.
- **Nur Logs.** Es gibt keine Geschäfts-, Kunden- oder Kostendaten. Aussagen zu Umsatz, Ausfallzeit oder Kunden entfallen und werden als unbekannt benannt.
- **Labels gehören dem Datensatz.** Loghub-Labels sind keine Erkenntnis unseres Systems. Sie dürfen Kontext und Prüfung liefern und werden als „dataset label“ ausgewiesen.
- **Treffer sind Logeinträge.** Gezählte Einträge sind weder Incidents noch Ausfälle (R-04, R-05).
- **Erfassungslücken.** Innerhalb einer Datenspanne fehlen Zeiträume ganz: OpenStack besteht aus drei Läufen mit Pausen von 26,1 h (14.05. 21:56 – 16.05. 00:00) und 8,8 h (16.05. 06:25 – 15:15), und nach dem 17.05. 07:00 kommen nur noch 12 API-Zugriffe je Stunde vor; BGL hat Lücken ohne jedes Ereignis bis 49 h (31.07. – 02.08.2005). Eine leere Stunde in einer solchen Lücke ist keine beobachtete Ruhe (R-03). Profil: `packages/corpus/sql/profiling/80_cases.sql`.
- **Level ist nicht Inhalt.** Levels werden übernommen, wie sie geloggt sind. `Node card status: no ALERTs are active …` steht 17.341-mal mit Level `ERROR` und zählt deshalb als Fehlerereignis (R-02); Antworten zitieren die Meldung, statt den Level zu deuten.

### 5.3 Ownership-Tabelle

Die Guidance verlangt eine selbst erfundene, im README dokumentierte Zuordnung von Komponenten zu Teams, damit Team Lead und Manager nach Team gruppieren können. Wir modellieren eine fiktive Organisation **„Serene Platform“**, deren Teams teilweise beide Datensätze verantworten.

**Entscheidung (U03):** Das Profiling fand genau die Komponenten des Entwurfs, dazu BGL `SERV_NET`; der Entwurf bleibt unverändert. `SERV_NET` bleibt **bewusst** `unowned` (3 Ereignisse zur Einrichtung des Service-Netzes), damit der Weg `unowned` an echten Daten sichtbar ist. Jede Zeile von `ownership` ist als „fictional (Serene Platform)“ gekennzeichnet und begründet ihre Zuordnung (`reason`); bewusst nicht zugeordnete Komponenten stehen mit Begründung im Kopf von `sql/30_ownership.sql` und erscheinen als `unowned`. Ereignisse je Komponente aus `sql/profiling/30_labels_components.sql`:

| Team | BGL-Komponenten (Ereignisse) | OpenStack-Komponenten (Ereignisse) |
|---|---|---|
| Compute Platform | `KERNEL` (4.324.949) | `nova-compute` (104.086) |
| Workload Runtime | `APP` (228.536) | – |
| Control Plane | `MMCS` (88.930), `CMCS` (211), `BGLMASTER` (145) | `nova-scheduler` (866) |
| Hardware Operations | `DISCOVERY` (97.172), `HARDWARE` (5.148), `MONITOR` (1.681), `LINKCARD` (1.170) | – |
| API Gateway | – | `nova-api` (102.868) |
| `unowned` | `SERV_NET` (3) | – |

Jede tatsächlich beobachtete Komponente ist entweder zugeordnet oder erscheint ausdrücklich als `unowned`. Die Tabelle ist fiktiv und wird überall so bezeichnet. `ownership_version` 1.0.0.

**Erweiterungen (U26, `ownership_version` 1.1.0):** Dieselbe Organisation erhält drei weitere Teams. *Storage Platform*: HDFS-Datanode-Komponenten (`dfs.DataNode…`, `dfs.FSDataset`, `dfs.DataBlockScanner`); *Control Plane* zusätzlich die HDFS-Namenode-Komponenten (`dfs.FSNamesystem`, `dfs.PendingReplicationBlocks…`). *Access Services*: OpenSSH `sshd` und die Anmelde- und Fernzugriffsdienste unter Linux (`sshd(pam_unix)`, `su(pam_unix)`, `login`, `ftpd`, `telnetd`, `xinetd` u. a.). *Web Platform*: Apache `httpd` und `httpd` unter Linux. *Coordination Services*: alle ZooKeeper-Klassen. *Compute Platform* zusätzlich `kernel` und `udev` unter Linux. Die übrigen, seltenen Linux-Programme (etwa `named`, `cups`, `smartd`) und Linux-Zeilen ohne Programmnamen bleiben bewusst `unowned`; die Liste mit Zeilenzahlen steht in `load_checks` und im README. Apache-Zeilen nennen kein Modul; die Komponente ist `httpd`, weil die ganze Datei das Fehlerprotokoll des httpd-Servers ist.

### 5.4 Lizenz und Zitation

Loghub-Daten sind für Forschungszwecke freigegeben und zitierpflichtig: Zhu et al., *Loghub: A Large Collection of System Log Datasets for AI-driven Log Analytics*, ISSRE 2023; für BGL zusätzlich Oliner & Stearley, DSN 2007; für HDFS_v1 zusätzlich Xu et al., *Detecting Large-Scale System Problems by Mining Console Logs*, SOSP 2009. Der Zenodo-Record 8196385 nennt CC BY 4.0 mit der Auflage, das Loghub-Repository zu nennen und das Paper zu zitieren. Rohdaten werden nicht ins Repository eingecheckt; das Setup lädt sie von Zenodo.

### 5.5 Erweiterungskorpora (A-39, U26)

**Auftrag (18.10.2026, LOG-40):** Neben dem Basiskorpus sind fünf weitere Loghub-Korpora mit echten Rohdaten über denselben Tool- und MCP-Ablauf nutzbar. Sie sind vom Nutzer beauftragter Ausbau, keine Muss-Anforderung des Briefs; die P0-Abnahme bleibt auf BGL und OpenStack bezogen und wird durch die Erweiterung nicht ersetzt. Das Basiskorpus bleibt der Standard von `pnpm data:setup`; Erweiterungen werden ausdrücklich gewählt (`--with`).

| | HDFS_v1 (`hdfs`) | OpenSSH (`openssh`, Datei `SSH.tar.gz`) | Apache (`apache`) | Linux (`linux`) | ZooKeeper (`zookeeper`) |
|---|---|---|---|---|---|
| Herkunft (Loghub) | Hadoop-Dateisystem, private Cloud mit Benchmark-Last, 2008 | ein OpenSSH-Server im Labor, 28+ Tage | Fehlerprotokoll eines Apache-httpd-Servers | `/var/log/messages` eines Linux-Servers, 260+ Tage | ZooKeeper-Dienst im CUHK-Labor, 26+ Tage |
| Zeilen | 11.175.629 | 655.147 | 56.482 | 25.567 | 74.380 |
| Zeitstempel | `yymmdd HHMMSS`, Sekunden | `Mon dd HH:MM:SS`, **ohne Jahr** | `[Www Mon dd HH:MM:SS yyyy]` | `Mon dd HH:MM:SS`, **ohne Jahr** | `yyyy-mm-dd HH:MM:SS,mmm` |
| Felder mit eigener Bedeutung | Block-ID `blk_…` (jede Zeile), Komponente = Java-Klasse, drittes Kopffeld (Loghub „Pid“) | Host, Prozess `sshd[pid]` (ein Prozess je Verbindung, PIDs wiederholen sich), Client-IP aus der Meldung | Client-IP `[client …]` | Host, Programmname mit optionaler PID | Thread, Komponente = Java-Klasse |
| Level | `INFO`, `WARN` | keins im Log | `error`, `notice`, `warn` (klein, wie geloggt) | keins im Log | `INFO`, `WARN`, `ERROR` |
| Labels | `anomaly_label.csv`: je Block Normal/Anomaly (Spur-Label, nicht Zeilen-Label) | keine | keine | keine | keine |

**Entscheidungen (aus dem Profil der Rohdaten, 18.10.2026):**

- **Zeit (R-03):** Keine Quelle nennt eine Zeitzone; alle Zeiten gelten als UTC und sind so gekennzeichnet. Fehlende Jahre werden belegt erschlossen, nicht geraten: Linux läuft von Juni bis Februar, und `ftpd`-Zeilen nennen das volle Datum (`at Sat Jun 11 03:28:22 2005`, Januar/Februar 2006); Juni–Dezember gelten als 2005, Januar–Februar als 2006, eine Ladeprüfung gleicht jede solche Zeile mit ihrem Kopf ab. OpenSSH läuft vom 10. Dezember bis 7. Januar; der Archiveintrag `SSH.log` trägt das Änderungsdatum 2018-01-07 10:04:48 UTC; Dezember gilt als 2017, Januar als 2018. Ein Monatswechsel rückwärts innerhalb der Datei erhöht das Jahr genau einmal; eine Prüfung belegt, dass es keinen zweiten gibt. Apache prüft den Wochentag des Textes gegen das Datum.
- **Fehler (R-02):** Levels werden wie geloggt übernommen, auch in Kleinschreibung (Apache) und ohne numerische Umdeutung. Fehlerereignisse: HDFS und ZooKeeper `ERROR`, `FATAL` (log4j); im HDFS-Korpus kommt keines vor, `WARN` ist Warnung, keine Fehlerstufe. Apache `error` und höher (`crit`, `alert`, `emerg`). OpenSSH hat kein Levelfeld; Fehler sind Meldungen mit dem Präfix `error:` oder `fatal:`, das OpenSSH für die Stufen ERROR und FATAL setzt (`log.c`). Linux hat weder Level noch belastbares Präfix: `is_error` ist dort unbekannt (`NULL`), `only_errors` und `investigation_order` sind für `linux` nicht verfügbar und melden das.
- **Zähleinheiten (R-01):** Für alle fünf Datensätze nur Logereignisse. Das Apache-Fehlerprotokoll enthält keine Zugriffszeilen; API-Zugriffe, Requests und Latenzen bleiben OpenStack.
- **Breite (R-08):** HDFS Blöcke (jede Zeile trägt genau eine Block-ID), OpenSSH und Apache Client-IPs (nur wo jedes Ereignis des Kandidaten eine trägt), Linux und ZooKeeper keine; dort entfällt Breite aus der Rangfolge mit Begründung.
- **Labels:** Die HDFS-Labels markieren Blöcke (Spuren), nicht Zeilen; sie sind Kontext je Block wie die OpenStack-Instanzlabels und keine Kandidaten der Priorisierung (R-08).
- **Ablehnungen:** Apache enthält 4.478 Zeilen „script not found or unable to stat“ ohne Zeitstempel und Level (abgebrochene Folgezeilen); sie werden mit Grund abgelehnt, nicht mit einer geliehenen Zeit geladen. Linux enthält 20 Zeilen mit ungültigem UTF-8 (Formatstring-Angriffe auf `rpc.statd`); sie landen mit Grund in `load_rejects`.
- **Keine gemeinsame Zeitachse:** Apache und Linux überlappen kalendarisch mit BGL (2005–2006), sind aber andere Systeme mit unbekannten Zeitzonen. Trends, Vergleiche, Vorläufer und Kontext bleiben je Datensatz; eine Korrelation über Datensätze ist nicht Teil dieses Pakets (A-34).
- **Abgrenzung:** HDFS_v1 ist ein Logkorpus; Traces und Metriken (HDFS_v3 TraceBench, RCAEval, Nezha) gehören zu A-34, OTel-Parquet zu A-32.

## 6. Rollen-Playbooks

Alle Rollen nutzen denselben Agenten, dasselbe Korpus und dieselben Tools. Die Rolle bestimmt **Leitfrage, Belegauswahl, Prüfung vor der Empfehlung, Antwortkern und Art des nächsten Schritts**. Eine reine Längenänderung genügt ausdrücklich nicht.

| | Engineer | Team Lead | Manager |
|---|---|---|---|
| **Leitfrage** | Was ist ausgefallen, wo, und was geschah davor und danach? | Was wiederholt sich, wie oft, wer ist beteiligt, was zuerst untersuchen? | Was verdient zuerst Aufmerksamkeit, und was soll passieren? |
| **Belegebene** | Einzelne Ereignisse, ihre Umgebung und das Muster dahinter | Muster über einen genannten Zeitraum | Portfolio priorisierter Probleme |
| **Pflichtbelege** | Treffer zur Fehlermeldung mit exakter Gesamtzahl im Zeitraum; Umgebung mindestens eines ausgewählten Ereignisses; Eingrenzung per Zählung nach Node, Rack oder Komponente | Muster mit Ereignissen, Episoden und aktiven Tagen bzw. Wochen im genannten Zeitraum; Verlauf; Verteilung nach Team und Komponente; Veränderung gegenüber der Vorperiode | Kandidaten je Datensatz mit Episoden, Ereignissen, Breite, Veränderung und Schwerehinweisen (Level, Labels, Status), getrennt gezeigt; Verteilung nach Team; bei OpenStack Latenz und Fehlerrate mit Zähler und Nenner |
| **Prüfung vor der Empfehlung** | Mindestens eine unterscheidende Prüfung, die der Agent selbst ausführt: Konzentration auf wenige Nodes bzw. ein Midplane gegenüber Streuung über viele Racks zur gleichen Zeit; Vorläufer über alle Episoden (A-36); periodisches gegenüber einmaligem Auftreten; erstes Auftreten und Eskalation (`compare`) | Wiederkehrend oder einmaliger Ausschlag (Episoden, aktive Tage); Konzentration auf ein Team bzw. eine Komponente oder Streuung; hält der Trend im Vergleich zur Vorperiode (`compare`) | Dominanzprüfung über Häufigkeit, Breite und Veränderung (R-08, R-09); ist der Spitzenkandidat breit oder auf wenige Einheiten konzentriert; steigt er oder klingt er ab |
| **Typische Tools** | `search_logs` → `get_log_context` (einzeln, dann `aggregate` über alle Episoden) → `count_events` nach Node oder Rack → `event_trend` | `recurring_patterns` → `event_trend` (Woche, nach Team) → `count_events` nach Team und Komponente mit `compare` | `recurring_patterns` mit `rank: investigation_order` je Datensatz → `count_events` nach Team mit `compare`; bei OpenStack `latency_stats` |
| **Antwortkern** (Abschnitt 7) | `Evidence` · `Timeline` · `Narrowing` · `Hypotheses` · `Next check` | `Recurring patterns` · `Recurring vs. one-off` · `Investigate first` · `Improvement` | `Priorities` · `Why this order` · `Decision needed` · `Missing information` |
| **Nächster Schritt** | Konkrete Diagnoseprüfung: welcher Node oder welche Komponente, welche Abfrage oder Quelle, welches Ergebnis bestätigt oder widerlegt die Hypothese | Team-Untersuchung oder Verbesserung, etwa Runbook, Alarmierung oder Ursachenanalyse für ein Muster, mit verantwortlichem Team | Priorisierungsentscheidung: wem welche Untersuchung zugewiesen wird und welche Information für eine Entscheidung fehlt |
| **Darf nicht** | Aus Beispieltreffern Häufigkeiten ableiten; Ursache als bewiesen darstellen; einen Vorläufer als Ursache bezeichnen | Viele Logzeilen als viele Störungen bezeichnen; Trends über Datensätze mischen | Geld, Ausfallzeit oder Kundenwirkung nennen; ungemessene Kriterien in die Rangfolge einfließen lassen; einen zusammengesetzten Risikoscore bilden; nach Logzeilen statt nach Häufigkeit und Breite priorisieren |

**Prüfbare Unterscheidung (A-17–A-20, S-13):** Bei gleichem Umfang unterscheiden sich die Belegebene (Ereignis, Muster, Portfolio), die Pflichtbelege, die Prüfung vor der Empfehlung, der Antwortkern und die Entscheidung, die der nächste Schritt vorbereitet (Diagnose, Team-Maßnahme, Priorisierung). Unterschiedliche Tools sind dafür kein eigenständiger Nachweis: Dasselbe Tool-Ergebnis darf mehreren Rollen dienen. Die Tool-Folgen sind Empfehlungen; geprüft werden die Pflichtbelege und die Prüfung vor der Empfehlung.

**Unterscheidende Prüfung:** Eine Prüfung ist unterscheidend, wenn ihr Ergebnis zwischen zwei Erklärungen trennt, etwa „lokal begrenzte Symptome“ (Ereignisse auf wenigen Nodes eines Midplanes) gegenüber „breit verteilten Symptomen“ (gleichzeitig über viele Racks). Die Verteilung grenzt die Symptome ein, nicht allein den kausalen Ursprung: Auch ein einzelner gemeinsam genutzter Knoten kann breite Folgen haben; seine Ursächlichkeit bleibt ohne eigene widerlegende Prüfung offen. Der Agent führt sie aus, bevor er den Hypothesenstatus festlegt, und begründet den Status mit ihrer Fakt-ID (R-07). Bleibt eine Hypothese offen, wird die noch fehlende Prüfung zum nächsten Schritt. Dafür gibt es keine eigene Ablaufsteuerung; die Prüfungen stehen in den Playbooks.

**Manager-Priorisierung:** R-08 liefert eine reproduzierbare Ausgangsreihenfolge nach Häufigkeit (Episoden) und Breite, nicht nach der Zahl der Logzeilen. Die Antwort zeigt Episoden, Ereignisse, Breite, Veränderung und Schwerehinweise getrennt. Liegt ein Kandidat in allen Dimensionen vorn, ist er klar Priorität 1; widersprechen sich die Dimensionen, benennt die Antwort den Zielkonflikt und begründet die Wahl (R-09).

**Rollenführung ohne Prompt-Wahl (A-37):** Die Jury tippt in Claude Desktop oder Claude Code wahrscheinlich einfach eine Frage, ohne einen MCP-Prompt zu wählen. Die Server-Instruktionen enthalten deshalb eine Kurzfassung aller drei Playbooks mit Rollenerkennung (Einzelfehler → Engineer; Wiederholung, Teams oder Trend → Team Lead; Prioritäten → Manager; unklar → nachfragen), und `describe_corpus` liefert dieselbe Anleitung je Rolle mit. Die Prompts bleiben für die ausdrückliche Wahl.

**Konsistenz:** Gleicher normalisierter Tool-Input liefert auf derselben Datenversion dieselbe Receipt-Signatur und dieselben Zahlen, unabhängig von Rolle und Client. Gleicher Fragetext garantiert das nicht, weil der Agent andere Tool-Aufrufe wählen kann.

## 7. Antwortvertrag

Jede Rollenantwort besteht aus einem **gemeinsamen Rahmen** und einem **rollenspezifischen Kern**. Ein gleicher Aufbau für alle Rollen ließe die drei Antworten wie dieselbe Antwort in unterschiedlicher Länge aussehen, genau das schließt der Brief aus. Die Web-App rendert Rahmen und Kern je Rolle. In Claude Desktop/Code leiten MCP-Prompts, Server-Instruktionen und `describe_corpus` sie an; ein MCP-Server kontrolliert die finale Antwort des Clients nicht. Hart durchgesetzt werden Grenzen bei Eingaben, SQL und Ergebnissen; das Antwortverhalten wird angeleitet und an den tatsächlich gezeigten Rollenantworten geprüft; ein formales Eval bleibt optional.

**Gemeinsamer Rahmen:**

1. **Scope:** Datensätze, Zeitraum `[from, to)` in UTC und Filter.
2. **Answer:** zwei bis vier Sätze, rollengerecht.
3. *Rollenspezifischer Kern* (Tabelle unten).
4. **Unknown:** was die Daten nicht belegen (Ursache, Auswirkung), gekürzte Ergebnisse, Stichprobe statt Gesamtmenge.
5. **Verification:** Ergebnis der Faktenprüfung über die mit `check_claims` geprüften Claims, in MCP-Weg und Web-App gleich; die Antwort sagt, wie viele Claims geprüft wurden und wie viele abwichen oder nicht auflösbar waren.

**Rollenspezifischer Kern:**

| Rolle | Abschnitte | Inhalt |
|---|---|---|
| Engineer | `Evidence` | Relevante Fehlermeldungen mit Zeit, Komponente und Node bzw. Request-ID, mit exakter Gesamtzahl der Treffer |
| | `Timeline` | Was unmittelbar davor und danach geschah; bei Bedarf Vorläufer über alle Episoden (A-36) |
| | `Narrowing` | Eingrenzung per Zählung nach Node, Rack oder Komponente |
| | `Hypotheses` | Mögliche Erklärungen mit Status nach R-07, Belegen dafür und dagegen und der ausgeführten unterscheidenden Prüfung |
| | `Next check` | Prüfobjekt, Abfrage oder Quelle, erwartetes bestätigendes bzw. widerlegendes Ergebnis |
| Team Lead | `Recurring patterns` | Tabelle mit Ereignissen, Episoden, aktiven Tagen bzw. Wochen, Status, Trend und Team |
| | `Recurring vs. one-off` | Welche Muster wiederkehren und welche einmalige Ausschläge sind (R-05) |
| | `Investigate first` | Was das Team zuerst untersuchen sollte, mit Begründung und verantwortlichem Team |
| | `Improvement` | Verbesserungsansatz wie Runbook, Alarmierung oder Ursachenanalyse |
| Manager | `Priorities` | Bis zu drei Probleme mit Episoden, Ereignissen, Breite, Veränderung, Schwerehinweisen und Team, getrennt gezeigt |
| | `Why this order` | Rangbasis, Dominanz oder benannter Zielkonflikt, Grenze nach R-09 |
| | `Decision needed` | Wem welche Untersuchung zugewiesen wird |
| | `Missing information` | Welche Information eine belastbarere Entscheidung erlauben würde; Geschäftswirkung als unbekannt |

Die Manager-Antwort hat keinen Hypothesenabschnitt; eine offene Ursache steht unter `Unknown`. Hypothesen in Engineer- und Team-Lead-Antworten tragen immer einen Status (`open`, `supported`, `contradicted`); `supported` heißt nicht kausal bewiesen.

**Zahlen:** Jede Zahl trägt die Fakt-ID, die das Tool ihr gegeben hat, etwa `1,204 log events [r_7f3a9c21.f4]`. Zahlen stammen ausschließlich aus Tool-Ergebnissen; das Modell rechnet nicht selbst.

Ausgeschlossen: Zahlen ohne Fakt-ID, Häufigkeiten aus Beispieltreffern, Geschäftswirkung, die Bezeichnung „Incident“ für Treffer oder Episoden, Kausalität aus zeitlicher Reihenfolge oder aus einem Vorläufer.

## 8. Anforderungen

Die Kennungen A-01 bis A-35 gelten ab Version 3.0, A-36 bis A-38 ab Version 3.3, A-39 ab Version 3.8; sie bleiben danach stabil. Alle Abnahmekriterien einer Anforderung müssen erfüllt sein. Die Zuordnung alter Kennungen steht in Abschnitt 13.

### Datenbasis und Setup

#### A-01 · P0 · Setup aus sauberem Checkout

**Anforderung:** Eine Person ohne Vorwissen startet das System nach README auf einem frischen Rechner.

**Abnahme:**
1. Voraussetzungen sind benannt (Docker, Node 24, pnpm). Ein Befehl startet SereneDB, lädt die Rohdaten von Zenodo, lädt sie in SereneDB und prüft das Ergebnis.
2. Ein Befehl startet den MCP-Server; die Verbindung mit Claude Code und Claude Desktop ist in je einem Schritt beschrieben. Ein Befehl startet die Web-App.
3. Der gesamte Ablauf wurde vor Abgabe auf einem frischen Klon durchgeführt; Dauer und Fehler sind dokumentiert.

#### A-02 · P0 · Basiskorpus laden und belegen

**Anforderung:** BGL und OpenStack liegen vollständig, korrekt geparst und durchsuchbar in SereneDB.

**Abnahme:**
1. Die Ladebilanz zeigt je Datensatz gelesene Zeilen, geladene Ereignisse und nicht geparste Zeilen mit Grund; die Summen sind rechnerisch vereinbar und werden mit den Zeilenzahlen des Briefs verglichen.
2. Zeitspanne, Levels, Komponenten und Labelverteilung je Datensatz sind abfragbar und stammen aus SereneDB.
3. Schema, Lade-SQL und Hilfsskripte liegen im Repository; Rohdaten nicht.

#### A-03 · P0 · Ownership-Tabelle

**Anforderung:** Komponenten beider Datensätze sind fiktiven Teams zugeordnet.

**Abnahme:**
1. Die Tabelle liegt als SQL in SereneDB und als Tabelle im README.
2. Jede beobachtete Komponente ist zugeordnet oder als `unowned` ausgewiesen; Zählungen nach Team enthalten `unowned` als eigene Kategorie.
3. Die Tabelle ist überall als fiktiv gekennzeichnet.

#### A-04 · P0 · Korpus beschreiben

**Anforderung:** Der Agent und die Jury erkennen Umfang und Grenzen der Daten, bevor sie fragen.

**Abnahme:**
1. `describe_corpus` und die Resource `corpus://overview` liefern je Datensatz Zeilenzahl, Zeitspanne, Felder, Levels, Komponenten, Labels und bekannte Grenzen nach 5.2.
2. Alle Werte stammen aus SereneDB, nicht aus Konstanten im Code.

### Suche und Analytics

#### A-05 · P0 · Volltextsuche mit Zeitfiltern

**Anforderung:** Der Engineer findet relevante Logeinträge per Volltextsuche.

**Abnahme:**
1. `search_logs` durchsucht die Meldung über den SereneDB-Volltextindex mit BM25-Rangfolge und filtert nach Datensatz, Zeitraum, Komponente, Level, Node bzw. Rack, Label und Request-ID.
2. Das Ergebnis nennt die exakte Gesamtzahl der Treffer aus derselben Suchbedingung und eine begrenzte Trefferliste (Standard 20, höchstens 50) mit `truncated`.
3. Ohne Treffer meldet das Tool dies ausdrücklich mit dem verwendeten Umfang.
4. Neben Begriffen unterstützt die Suche Phrasen und tolerante Schreibweise über die SereneDB-Operatoren; der Modus steht im Receipt (seit 3.3 P0, vorher A-30).

#### A-06 · P0 · Nachbarereignisse

**Anforderung:** Zu einem Ereignis lässt sich zeigen, was unmittelbar davor und danach geschah.

**Abnahme:**
1. `get_log_context` liefert bis zu 25 Ereignisse davor und danach innerhalb eines begrenzten Zeitfensters, wahlweise auf demselben Node, in derselben Komponente, mit derselben Request-ID oder im ganzen Datensatz.
2. Das Ausgangsereignis ist markiert; Reihenfolge und Zeitabstände sind exakt.
3. Eine Verbindung über eine Request-ID wird nur bei OpenStack angeboten.
4. Die Umgebung über alle Episoden eines Musters liefert derselbe Aufruf im Modus `aggregate` (A-36).

#### A-36 · P0 · Vorläuferanalyse über alle Episoden

**Anforderung:** Der Engineer sieht nicht nur die Umgebung eines Ereignisses, sondern was über alle Episoden eines Musters hinweg regelmäßig davor bzw. danach auftritt.

**Abnahme:**
1. `get_log_context` im Modus `aggregate` nimmt ein Muster oder eine Suchbedingung samt Filtern als Anker und liefert nach R-11 je Muster im Fenster davor bzw. danach: Zahl der Anker mit Vorkommen, deren Anteil an allen Ankern, die Grundrate im Umfang und das Verhältnis beider, begrenzt auf die häufigsten Muster.
2. Alles wird in SereneDB berechnet; das Ergebnis nennt Ankerzahl, Fenster und Umfang. Unter der Mindestzahl an Ankern entfällt die Grundrate mit Hinweis.
3. Vorläufer werden als zeitliche Beobachtung bezeichnet, nie als Ursache; sie können eine Hypothese höchstens auf `supported` heben (R-07).

#### A-07 · P0 · Zählungen über das ganze Korpus

**Anforderung:** Team Lead und Manager erhalten belastbare Zählungen statt Stichproben.

**Abnahme:**
1. `count_events` gruppiert nach bis zu zwei Dimensionen aus Datensatz, Team, Komponente, Level, Label, Rack, Node, Muster und HTTP-Status, mit Filtern und optionalem Zeitraum; ohne Zeitraum gilt das ganze Korpus.
2. Das Ergebnis nennt die Gesamtpopulation, Anteile und bei mehr als `top_n` Werten eine Zeile `other` mit Summe.
3. Mindestens eine Demo-Antwort nutzt eine Zählung über das gesamte Basiskorpus nach Datensatz oder Team.

#### A-08 · P0 · Trend über einen Zeitraum

**Anforderung:** Die Entwicklung eines Musters oder Bereichs ist über einen genannten Zeitraum sichtbar.

**Abnahme:**
1. `event_trend` liefert Zeitreihen in Stunden-, Tages- oder Wochen-Buckets, optional aufgeteilt nach einer Dimension (höchstens fünf Reihen plus `other`).
2. Leere Buckets innerhalb der Datenspanne erscheinen als beobachtete Null; Buckets außerhalb der Datenspanne werden nicht als Null ausgegeben.
3. Ein Trend über beide Datensätze auf einer gemeinsamen Zeitachse wird abgelehnt (5.2).

#### A-09 · P0 · Periodenvergleich

**Anforderung:** Veränderungen werden gegenüber einer nachvollziehbaren Referenz erklärt.

**Abnahme:**
1. `count_events` mit der Option `compare` vergleicht einen Zeitraum mit dem unmittelbar vorherigen gleich langen Zeitraum oder einer gleich langen gewählten Referenz, gruppiert nach einer Dimension.
2. Je Wert erscheinen C, B, C − B, die relative Veränderung nach R-06 und die Einstufung; fehlende Werte bilden eine eigene Kategorie.
3. Liegt die Referenz ganz oder teilweise außerhalb der Datenspanne, ist der Vergleich als nicht bestimmbar bzw. eingeschränkt gekennzeichnet.

#### A-10 · P0 · Wiederkehrende Muster

**Anforderung:** Der Team Lead unterscheidet wiederkehrende Probleme von einmaligen Ausschlägen.

**Abnahme:**
1. `recurring_patterns` liefert Muster (R-04) mit Ereignissen, erster und letzter Beobachtung, Episoden nach R-05, aktiven Tagen bzw. Wochen, Breite (Nodes und Racks bzw. Instanzen und Requests, Komponenten), Status nach R-10, Komponente und Team. Episoden werden über den vollständig gefilterten Umfang berechnet.
2. Sortierung über `rank` nach Ereignissen, Episoden, Zunahme oder Untersuchungsreihenfolge (A-11); höchstens 25 Muster je Aufruf.
3. Viele Zeilen in einer Episode ergeben kein „wiederkehrend“. Eine einzelne Episode über mehrere aktive Tage ist kein einmaliger Ausschlag und wird mit Dauer und aktiven Tagen beschrieben. Episoden werden nicht als Ausfälle bezeichnet.

#### A-11 · P0 · Priorisierung

**Anforderung:** Der Manager erhält eine reproduzierbare technische Untersuchungsreihenfolge.

**Abnahme:**
1. `recurring_patterns` mit `rank: investigation_order` ordnet Kandidaten innerhalb eines Datensatzes und des übergebenen Umfangs (Zeitraum, Team, Komponente, Level, Node bzw. Rack) nach R-08 und liefert höchstens fünf, standardmäßig drei. Je Kandidat stehen Episoden, Ereignisse, Anteil an den Fehlerereignissen im Umfang, Breite, Veränderung, Levels, Labels und Team getrennt, dazu Rangbasis, Zahl der geprüften Kandidaten und je Dimension, welcher Kandidat vorn liegt.
2. Die Grenze nach R-09 ist Teil jedes Ergebnisses.
3. Eine datensatzübergreifende Reihenfolge in der Antwort ist als begründete Einschätzung gekennzeichnet und nennt ihre Grundlage (Anteile, Trend, Breite).

#### A-12 · P0 · Latenz und Fehlerrate (OpenStack)

**Anforderung:** Für OpenStack sind Latenzverteilungen und Fehlerraten verfügbar; der Brief nennt OpenStack ausdrücklich als Quelle dafür.

**Abnahme:**
1. `latency_stats` liefert für API-Zugriffe (R-01) Anzahl, p50, p90, p95, p99 und Maximum der Latenz in Millisekunden, gruppiert nach Endpunkt, Methode, Status oder Zeit-Bucket. Eindeutige Request-IDs und Zugriffe ohne Request-ID werden getrennt gezählt.
2. Die Fehlerrate nennt Zähler und Nenner: 5xx-Zugriffe (500–599) unter allen API-Zugriffen im Umfang; 4xx-Zugriffe (400–499) als getrennte Rate. Kommen im Umfang keine 5xx-Zugriffe vor, ist die Rate eine beobachtete Null mit Nenner, und das Ergebnis sagt das ausdrücklich (O-06).
3. Endpunkte werden mit maskierten IDs normalisiert, damit gleiche Routen zusammengefasst werden.

### Belege und Verlässlichkeit

#### A-13 · P0 · Query Receipts

**Anforderung:** Jede Zahl und jeder Beleg ist auf eine tatsächlich ausgeführte Abfrage zurückführbar.

**Abnahme:**
1. Jedes Tool-Ergebnis enthält einen Receipt mit ID, Tool, validierter Eingabe mit aufgelösten Standardwerten, exaktem SQL, gebundenen Parametern, Umfang (Datensätze, Zeitraum, Filter), Datenversion, Population, zurückgegebenen Zeilen, `truncated`, Laufzeit in Millisekunden, Zeitpunkt, Ergebnis-Digest und Fakten mit ID (A-14).
2. Receipts werden als JSON-Dateien im lokalen Datenverzeichnis gespeichert (technical.md 6.2) und sind über `receipt://{id}` und in der Web-App abrufbar. Kann ein Receipt nicht gespeichert werden, schlägt der Tool-Aufruf fehl; ein Ergebnis ohne gespeicherten Receipt gilt nicht als belegt.
3. Antworten zitieren Fakt-IDs, die die Belegnummer enthalten; die ausgearbeitete Untersuchung enthält die verwendeten Receipts im Repository.

#### A-14 · P0 · Faktenprüfung (`check_claims`)

**Anforderung:** Zahlen in Antworten sind an eindeutige Fakten gebunden und werden deterministisch geprüft.

**Abnahme:**
1. Jedes Tool-Ergebnis vergibt für jede Zahl und jede Zeitangabe in Ergebnis und Umfang eine Fakt-ID (`<receipt_id>.f<n>`, etwa `r_7f3a9c21.f4`) mit Wert, Kennzahl, Einheit und Gruppe. Das Modell zitiert diese IDs und bildet keine eigenen Pfade.
2. `check_claims` prüft je Claim Wert, Kennzahl und Gruppe gegen den Fakt; die Gruppe ist Pflicht (leer bei ungruppierten Fakten), der Umfang ergibt sich aus dem Receipt. Es meldet `verified`, `mismatch` (mit dem abweichenden Merkmal), `unknown_fact` oder `unknown_receipt`. Ein Wert, der nur in einem anderen Fakt vorkommt, gilt nicht als belegt.
3. MCP-Weg und Web-App prüfen auf demselben Weg: Das Modell reicht die Zahlen per `check_claims` ein, und die Antwort nennt die Zahl der geprüften Claims sowie abweichende und nicht auflösbare (`unknown_fact`, `unknown_receipt`), ohne eine vollständige Prüfung zu behaupten. Die Web-App markiert Fakt-IDs, die nicht eingereicht wurden, als ungeprüft und zeigt ohne `check_claims`-Aufruf „not verified“. Zahlen ganz ohne Fakt-ID sind bei der vollständigen Antwortprüfung nach A-21 zu erfassen.
4. Ein falscher Wert und ein richtiger Wert mit falscher Kennzahl oder Gruppe werden als `mismatch` erkannt, eine nicht existierende Fakt-ID als `unknown_fact` (S-08). Erklärungen und Kausalaussagen sind nicht Gegenstand dieser Prüfung; sie werden bei der inhaltlichen Antwortprüfung nach A-21 bewertet.

### Agent und MCP

#### A-15 · P0 · MCP-Server

**Anforderung:** Claude kann sich mit unserer Anleitung verbinden und Fragen aller drei Rollen beantworten.

**Abnahme:**
1. Der Server stellt die acht Tools, die Resources (`corpus://overview`, `corpus://schema`, `corpus://ownership`, `receipt://{id}`) und je Rolle einen Prompt bereit. Die optionalen Index-Tools (A-33) erscheinen nur bei gesetztem Schalter.
2. Tools sind als schreibgeschützt annotiert, liefern strukturierte Ergebnisse mit Schema und verständliche Fehlermeldungen mit Korrekturhinweis.
3. Die Verbindung für Claude Code (inklusive `.mcp.json` im Repository) und Claude Desktop ist im README beschrieben, einschließlich des Aufrufs der Rollen-Prompts. Die Abgabe weist den tatsächlich genutzten Client aus; die vollständige Rollen-/Prompt-Matrix beider Clients ist zurückgestellt, bestehende Verbindungsproben und Fehler bleiben dokumentiert.

#### A-16 · P0 · Tool-Beschreibungen

**Anforderung:** Der Agent wählt anhand der Beschreibungen das passende Tool.

**Abnahme:**
1. Jede Beschreibung nennt Zweck, wann das Tool zu verwenden ist und wann nicht, Eingaben mit Einheiten und Grenzen, Ausgaben und Limits.
2. Das README enthält dieselben Beschreibungen in tabellarischer Form, aus der Registry generiert.
3. In den dokumentierten echten Rollenläufen beschafft der Agent die zur Frage passenden Belege mit den beschriebenen Tools. Tool-Aufrufe und Ergebnisse bleiben prüfbar; die formale Suite mit hinterlegten zulässigen Tool-Folgen ist optional (A-21).

#### A-37 · P0 · Rollenführung ohne Prompt-Wahl

**Anforderung:** Die Playbooks greifen auch, wenn jemand in Claude Desktop oder Claude Code einfach eine Frage stellt, ohne einen Rollen-Prompt zu wählen.

**Abnahme:**
1. Die Server-Instruktionen enthalten eine Kurzfassung aller drei Playbooks und die Rollenerkennung aus Abschnitt 6; bei unklarer Rolle fragt der Agent nach.
2. `describe_corpus` liefert die Antwortanleitung je Rolle mit, damit sie auch in Clients ankommt, die Server-Instruktionen nicht übernehmen.
3. Kurzfassung und Anleitung werden aus denselben Playbook-Dateien erzeugt wie Prompts und Web-System-Prompt; es gibt keine zweite Textquelle.
4. Eine gezielte echte Probe ohne Prompt-Wahl dokumentiert die Rollenführung bzw. die Rückfrage bei unklarer Rolle (S-14). Die vollständige Matrix aus drei Rollen in beiden Clients bleibt zurückgestellt; aus einer Probe folgt keine allgemeine Konformitätsbehauptung.

#### A-17 · P0 · Engineer-Antwort

**Anforderung:** Eine Engineer-Frage wird nach dem Engineer-Playbook beantwortet.

**Abnahme:**
1. Die Antwort enthält relevante Fehlermeldungen mit Zeit, Komponente und Node, die Ereignisse davor und danach, eine Eingrenzung per Zählung und eine als Hypothese gekennzeichnete mögliche Ursache.
2. Sie nutzt die Volltextsuche mit Zeitfilter.
3. Vor der Einstufung der Hypothese führt der Agent mindestens eine unterscheidende Prüfung aus (Abschnitt 6); der Status nach R-07 ist mit deren Fakt-ID begründet (S-15).
4. Der nächste Schritt ist eine konkrete Diagnoseprüfung mit erwartetem bestätigendem bzw. widerlegendem Ergebnis.

#### A-18 · P0 · Team-Lead-Antwort

**Anforderung:** Eine Team-Lead-Frage wird nach dem Team-Lead-Playbook beantwortet.

**Abnahme:**
1. Die Antwort nennt Zeitraum und Umfang, zeigt wiederkehrende Muster mit Zählungen, Episoden und Trend sowie die Verteilung nach Team und Komponente.
2. Sie unterscheidet wiederkehrende Muster von einmaligen Ausschlägen.
3. Sie empfiehlt, was das Team zuerst untersuchen sollte, mit Begründung und verantwortlichem Team, und prüft dafür, ob der Trend gegenüber der Vorperiode hält.

#### A-19 · P0 · Manager-Antwort

**Anforderung:** Eine Manager-Frage wird nach dem Manager-Playbook beantwortet.

**Abnahme:**
1. Bis zu drei priorisierte Probleme mit Episoden, Ereignissen, Breite, Veränderung, Schwerehinweisen, Team und Maßnahme, die Dimensionen getrennt gezeigt; keine erfundenen Kosten, Ausfallzeiten oder Kundenwirkungen; die Rangbasis ist benannt.
2. Die Reihenfolge ist aus diesen Dimensionen begründet, ohne zusammengesetzten Risikoscore: Ein Kandidat, der in allen Dimensionen vorn liegt, ist als dominant benannt; widersprechen sich die Dimensionen, nennt die Antwort den Zielkonflikt und begründet die Wahl. Die Grenze nach R-09 ist sichtbar.
3. Die Antwort benennt, welche Information für eine belastbarere Entscheidung fehlt.

#### A-20 · P0 · Antwortvertrag

**Anforderung:** Alle Antworten folgen Abschnitt 7.

**Abnahme:**
1. Der gemeinsame Rahmen (Scope, Answer, Unknown, Verification) und der Kern der jeweiligen Rolle sind in jeder Rollenantwort erkennbar.
2. Jede Zahl trägt eine Fakt-ID; Hypothesen tragen einen Status.
3. Fragen außerhalb der Datenbasis (Kosten, Kunden, Ausfallzeit) werden begrenzt beantwortet: was messbar ist, was fehlt, welche Quelle helfen würde.

### Prüfung und Abgabe

#### A-21 · P0 · Verifikation

**Anforderung:** Query-Korrektheit ist unabhängig von der Modellantwort nachgewiesen; jede der drei Rollen ist durch mindestens eine echte Agentenantwort mit relevanten, zugänglichen Query-Belegen und geeignetem nächsten Schritt vertreten.

**Abnahme (Nutzerentscheidung 18.10.2026):**
1. Golden Queries prüfen jedes Tool gegen unabhängig formulierte SQL-Abfragen bzw. bekannte Werte (Zeilenzahlen des Briefs) auf dem echten Korpus.
2. CI prüft die Tools auf den 2k-Samples von Loghub in einer SereneDB-Instanz.
3. Mindestens eine Frage je Rolle läuft über den echten Agenten im gewählten Claude-Client mit demselben Basiskorpus. Vollständige Antworten, tatsächlich verwendete Tools, ausgeführte Queries und relevante Ergebnisse bleiben mit Daten- und Konfigurationsstand zugänglich. Analystisch ausgearbeitete Rollensichten sind als solche benannt und ersetzen keine echten Agentenantworten.
4. Die vollständigen gezeigten Antworten werden gegen ihre Belege geprüft: gemessene Aussagen im richtigen Umfang, keine erfundenen Zahlen oder Wirkung, Beobachtung/Hypothese/Ursache getrennt, konkrete nächste Schritte je Rolle. Ein erfolgreicher `check_claims`-Aufruf beweist nur die eingereichten Claims, nicht die ganze Antwort oder Erklärung. Bekannte Fehlversuche bleiben mit ihren Einschränkungen erhalten.
5. Die Nachweise enthalten Retrieval und Aggregation auf BGL und OpenStack, mindestens eine Volltextsuche und eine Aggregation über das ganze Basiskorpus. Die getrennten Zeitachsen, Filter und Zähleinheiten bleiben sichtbar; Gesamtzahlen je Datensatz dürfen zusammen berichtet werden.
6. Ein transparenter Prüfbericht verlinkt die tatsächlich vorhandenen Artefakte und benennt offene Grenzen. Es wird weder ein formales Eval-Pass noch ein Baseline-Vorteil oder eine Generalisierung auf unbekannte Fragen behauptet.

**Zurückgestellter Zusatzumfang:** Der frühere verpflichtende Dev-/Baseline-Vergleich mit mindestens drei Entwicklungs- und zwei unabhängigen Holdout-Fragen je Rolle, Rubrikgrenze (kein 0-Wert, Mittel je Rolle ≥ 1,5), Wiederholungen, unabhängiger Bewertung, menschlicher Stichprobe, Freeze und separat ausgewertetem ersten Holdout ist nicht vom Originalbrief verlangt. Die implementierte Messgrundlage und der geschützte Ablauf bleiben erhalten; ein tatsächlicher formaler Dev-Lauf, Freeze, Release und erster Holdout sind nicht nachgewiesen. Für einen später ausdrücklich beauftragten Lauf gelten die unveränderten methodischen Schutzregeln in technical.md § 13.1–13.3. Vorbereitung ist kein bestandener Versuch.

Das Zusatzexperiment zur Wirkung historischer Vergleichsevidenz **I-21** in [improvements.md](improvements.md) bleibt ebenfalls optional; es erweitert weder diese Abnahme noch die acht Tools.

#### A-22 · P0 · Ausgearbeitete Untersuchung

**Anforderung:** Ein echtes Problem oder wiederkehrendes Muster im Basiskorpus ist vollständig dokumentiert.

**Abnahme:**
1. Für jede Rolle: Frage, Tool-Aufrufe, ausgeführte Abfragen mit Ergebnissen, Antwort und empfohlene Maßnahme.
2. Volltextbelege und Aggregation über das ganze Korpus sind enthalten.
3. Mindestens eine unterscheidende Prüfung ist mit Abfrage, Ergebnis und daraus begründetem Hypothesenstatus dokumentiert. Die erste vorläufige Einschätzung und ihre Änderung oder begründete Beibehaltung nach der Prüfung sind nachvollziehbar; ein geeigneter Fall mit eingeschränkter oder widerlegter Vermutung bzw. geänderter Priorisierung wird bevorzugt (11.2).
4. Was die Daten belegen und was nicht, ist ausdrücklich benannt. Der Fall wird nach festen Kriterien gewählt (Abschnitt 11.2).

#### A-23 · P0 · README und Tool-Dokumentation

**Anforderung:** Das öffentliche Repository erklärt Workflow, Setup, Ausführung und Grenzen auf Englisch.

**Aktueller Status:** Veröffentlichung auf ausdrücklichen Wunsch des Eigentümers vom 18.10.2026 zurückgestellt; das Hauptrepository bleibt privat. Die Unterlagen sind intern prüfbar, erfüllen die öffentliche Zugänglichkeit aber erst nach einer später freigegebenen Veröffentlichung.

**Abnahme:**
1. Enthalten: Überblick, Architektur, Setup, MCP-Verbindung, Web-App, Tool-Referenz, Schema, Ownership-Tabelle, Regeln, Verifikation, ausgearbeitete Untersuchung, bekannte Grenzen, Zitationen, verwendete Dienste mit dem verwendeten Claude-Modell (`claude-opus-5-5`) und der SereneDB-Version.
2. Korpuszahlen im README stammen aus Receipts oder der Ladebilanz. Eval- und Leistungskennzahlen verweisen auf gespeicherte Laufartefakte, Messwerte und nachvollziehbare Berechnungen; API-Kosten sind mit Preisquelle und Preisstand als Schätzung gekennzeichnet. Diese Betriebskennzahlen belegen keine Geschäftswirkung der Logereignisse.
3. Der Prüfbericht verlinkt die echten Rollennachweise, die ausgearbeitete Untersuchung und bekannte Fehlversuche mit ihren Grenzen. Das formale Baseline-/Dev-/Holdout-Eval ist als zurückgestellt und nicht bestanden ausgewiesen. Falls später Messwerte berichtet werden, bleiben Zahlenkorrektheit, Beleg- und Empfehlungsqualität, Laufzeit und Aufwand getrennt; fehlende Ergebnisse sind kein Erfolg.
4. **SereneDB-Funktionsübersicht:** eine Tabelle, welche SereneDB-Funktion in welchem Tool welche Aufgabe löst, je mit Verweis auf einen Beispiel-Receipt (technical.md § 5.3), dazu der Rechenort: was in SereneDB entsteht und was TypeScript tut.
5. **Beispielfragen je Rolle**, die mit einem benannten Daten- und Konfigurationsstand tatsächlich geprüft wurden, je mit den erwarteten Tools, sowie **bewusst nicht beantwortete Fragen** (Kosten, Ausfallzeit, Kundenauswirkung, Ursachenbeweis, Vergleiche über die getrennten Zeitachsen) mit der Antwort, die das System stattdessen gibt. Die Jury liest diese Fragen und stellt eigene; Beispielfragen sind nie Holdout (A-21).

#### A-24 · P0 · Demo, Abgabevideo und Slides

**Anforderung:** Eine Präsentation zeigt den Ablauf, die drei Rollenantworten und ihre Query-Belege in höchstens fünf Minuten (Brief); die Abgabe enthält ein englisches Demo-Video von höchstens drei Minuten (Teilnahmeregeln, Abschnitt 5).

**Abnahme:**
1. Demo nach Abschnitt 11.1; echte gespeicherte Rollenläufe dürfen als sichtbar gekennzeichnete Aufzeichnung gezeigt werden. Die gezeigten Antworten und Receipts bleiben prüfbar; es wird kein neuer Live-Lauf behauptet.
2. Abgabevideo nach Abschnitt 11.4, englisch, höchstens drei Minuten, aus echten Läufen geschnitten und als Aufzeichnung gekennzeichnet.
3. Slides fassen Problem, Ansatz, Architektur, SereneDB-Funktionsübersicht (A-23 Punkt 4), Rollen, Belege, Grenzen und Ausblick zusammen; Korpuszahlen stammen aus Receipts bzw. der Ladebilanz, Eval- und Leistungszahlen aus den in A-23 benannten Artefakten.

#### A-25 · P0 · Sichere Tools

**Anforderung:** Der Agent kann die Datenbank weder verändern noch überlasten.

**Abnahme:**
1. Keine freie SQL-Eingabe; alle Werte sind gebunden, Spalten und Dimensionen kommen aus Allowlists.
2. Jede Abfrage hat ein serverseitiges Zeitlimit; Ergebnisgrößen sind begrenzt.
3. Logtexte sind Daten: Anweisungen in Meldungen ändern weder Regeln noch Tool-Auswahl (S-09).

### Web-App

#### A-26 · P1 · Chat mit Rollenwahl und Live-Toolaufrufen

**Anforderung:** Die Web-App zeigt, wie der Agent Tools aufruft und Antworten belegt.

**Abnahme:**
1. Vor der Frage wird die Rolle gewählt; das zugehörige Playbook steuert den Agenten. `Ask as Team Lead` bzw. `Ask as Manager` stellt eine Rollenfrage im selben Umfang; der Umfang wird strukturiert übernommen und sichtbar angezeigt, nicht übertragbare Filter sind als solche gekennzeichnet.
2. Tool-Aufrufe erscheinen live mit Eingaben, Status und Receipt; die Antwort wird mit gemeinsamem Rahmen und dem Kern ihrer Rolle dargestellt, Fakt-IDs sind anklickbar.
3. Fehler von Modell oder Datenbank sowie gestoppte und teilweise ausgeführte Antworten erscheinen als eigene Zustände; Eingaben bleiben erhalten. Receipts erfolgreicher Tool-Aufrufe bleiben prüfbar; eine Teilantwort erhält keine Verifikationsmarke.

#### A-27 · P1 · Evidence Drawer

**Anforderung:** Jeder Beleg ist in höchstens zwei Bedienhandlungen prüfbar.

**Abnahme:**
1. Der Drawer zeigt SQL, Parameter, Umfang, Ergebnis, Laufzeit und Kürzung eines Receipts bzw. ein Originalereignis mit Umgebung.
2. `Re-run` führt dasselbe Tool mit der gespeicherten validierten Eingabe erneut aus und zeigt, ob Datenversion und Ergebnis-Digest übereinstimmen.

#### A-28 · P1 · Übersicht ohne KI

**Anforderung:** Die Startseite zeigt das Korpus ohne Modellaufruf.

**Abnahme:**
1. Ladebilanz, Ereignisse nach Team und Datensatz, BGL-Wochentrend, wiederkehrende Muster und OpenStack-Latenz stammen aus denselben Tools wie der Agent.
2. Jede Kachel öffnet ihren Receipt; Diagramme haben eine Tabellenalternative.

#### A-29 · P1 · Logs-Explorer

**Anforderung:** Suche und Umgebung sind auch ohne Agent bedienbar.

**Abnahme:**
1. Suche mit Filtern, Gesamtzahl und begrenzter Liste; ein Treffer öffnet seine Umgebung.
2. `Explain with AI` übernimmt das Ereignis als Frage in den Chat; Absenden bleibt explizit.

#### A-38 · P1 · Rollenvergleich (zurückgestellt am 18.10.2026)

**Umfang:** optionaler Ausbau, kein Abgabetor. Die folgenden Kriterien gelten erst bei einem erneuten Auftrag; ein Vergleich wird nicht als implementiert behauptet.

**Anforderung:** Die Web-App zeigt dieselbe Situation aus Sicht aller drei Rollen nebeneinander, damit die unterschiedliche Verwendung der Belege auf einen Blick sichtbar ist.

**Abnahme:**
1. `Compare roles` stellt die Leitfrage jeder Rolle im selben strukturierten Umfang; jede Antwort entsteht mit ihrem eigenen Playbook.
2. Eine Vergleichsleiste zeigt je Rolle Belegebene, Prüfung vor der Empfehlung, Entscheidung im nächsten Schritt und die verwendeten Tools; Zahlen aus gleichem Tool-Input sind als identisch erkennbar (S-13).
3. Schlägt eine der drei Antworten fehl oder wird gestoppt, bleibt der Zustand je Spalte sichtbar; die übrigen Antworten bleiben prüfbar.

### Erweiterungen

#### A-30 · in A-05 aufgegangen · Phrasen- und Fuzzy-Suche

Seit Version 3.3 Teil von A-05 (P0): `search_logs` unterstützt Phrasen und tolerante Schreibweise über die SereneDB-Operatoren; der Modus ist im Receipt sichtbar.

#### A-31 · P1 · MCP über HTTP

Derselbe Server ist zusätzlich über Streamable HTTP erreichbar, damit Clients ohne lokalen Prozess verbinden können.

#### A-32 · P1 (seit 3.6, nach M1) · Große Datensätze

Abfragen auf den OpenTelemetry-Parquet-Daten direkt aus dem Object Storage oder auf größeren Loghub-Datensätzen. Eine View bildet `ServiceName`, `SeverityText` und `Body` auf die Spalten von `log_events` ab, damit dieselben Tools darauf arbeiten. Bevorzugter Weg ist ein invertierter Index über die View auf `read_parquet` (SereneDB „Indexing External Data“): Die Zeilen bleiben in den Dateien, nur die Suchstruktur entsteht in SereneDB, ohne Ladeskript. Ob der OTel-Eingang des Servers (`otel_logs`) zusätzlich gezeigt wird, entscheidet U21 nach Aufwand; die Kern-Tools hängen nicht davon ab. Ausgewiesen werden tatsächlich abgefragte Datenmenge, Nützlichkeit der Ergebnisse, Abfragezeiten und, wo verfügbar, Kosten. Zusammen mit A-33 ergibt das eine durchgängige Geschichte: Volltext über Remote-Daten, ein vom Agenten indexiertes Zeitfenster, gemessener Trade-off.

#### A-33 · P2 · Indizes durch den Agenten

Tools zum Anlegen und Entfernen eines Index für einen Zeitbereich. Sie werden nur bei gesetztem Schalter registriert, damit sie die Tool-Wahl im Kern nicht beeinflussen, und sind die einzigen Tools, die SereneDB verändern: Sie legen Indizes bzw. materialisierte Zeitfenster an und entfernen sie, ändern aber keine Logdaten. Gemessen wird die Zeit wiederholter Fragen mit und ohne Index; der Trade-off zwischen Aufbauzeit und eingesparter Abfragezeit ist dokumentiert.

#### A-34 · P2 · Log-Trace-Korrelation

Korrelation mit Traces oder Metriken aus den im Brief genannten multimodalen Datensätzen.

#### A-35 · P2 · Zugriffsbeschränkung je Rolle

Row-Level-Security in SereneDB je Rolle. Bewusst nachrangig: Im Kern sind Rollen Perspektiven, keine Berechtigungen.

#### A-39 · Ausbau (beauftragt, nach M1) · Weitere Loghub-Korpora

**Anforderung:** HDFS_v1, OpenSSH, Apache, Linux und ZooKeeper (5.5) sind mit echten Rohdaten über dieselben Tools, denselben MCP-Server und dieselben Receipts nutzbar. Keine Muss-Anforderung des Briefs; die P0-Abnahme bleibt beim Basiskorpus.

**Abnahme:**
1. Ein Datensatzkatalog ist die eine Quelle für Kennungen, Quellen mit Prüfsummen, Lizenz und Zitation, Zeitbasis, Feldbedeutung, Zähleinheiten und Fähigkeiten; Filter, Dimensionen, Kontextbereiche, Breite und Fehlerdefinition der Tools folgen daraus.
2. `pnpm data:setup` lädt das Basiskorpus wie bisher; Erweiterungen werden ausdrücklich gewählt und idempotent geladen, mit Ladebilanz, begründeten Ablehnungen, Quellzeile, Originaltext, Manifest und fiktiver Ownership mit `unowned`. 2k-Samples laden getrennt vom vollen Korpus.
3. Feldbedeutungen sind je Format korrekt (5.5); fehlende Jahre, Zeitzonen und Felder sind begründet behandelt, nichts wird ohne Semantik gleichgesetzt.
4. `describe_corpus` liefert je Datensatz einen Feldführer aus SereneDB (Belegung, Zahl der Werte, echte Beispielwerte) und die Fähigkeiten; eine nicht unterstützte Funktion ergibt `invalid_input` mit Hinweis statt Nullwerten oder stiller Ersatzberechnung.
5. Für jeden der fünf Datensätze: Suche, Kontext, Gesamt- und Gruppenzählung und Trend auf dem vollen Korpus mit unabhängigen Golden-Abgleichen; mindestens eine echte Rollenfrage mit gespeicherten Toolaufrufen, Receipts und `check_claims`; Anwendbarkeit je Tool und Datensatz dokumentiert.
6. CI prüft die fünf 2k-Samples. BGL und OpenStack liefern bei gleichem Daten- und Regelstand dieselben Ergebnisse; geänderte Datenversionen sind erklärt.
7. Eine weitere ähnlich aufgebaute Quelle braucht einen Katalogeintrag, ein Parser-SQL und Ownership-Zeilen, keine Kopie der Tools.

## 9. Fachliche Regeln

| Regel | Festlegung |
|---|---|
| **R-01 · Zähleinheit** | Eine geparste Logzeile ist ein **Logereignis**; inhaltsgleiche Zeilen bleiben getrennte Ereignisse. Bei OpenStack gibt es zusätzlich **API-Zugriffe** (Zeilen mit HTTP-Status, mit oder ohne Request-ID) und **Requests** (eindeutige Request-IDs). Die drei Einheiten werden nie vermischt und immer benannt; Raten nennen Zähler und Nenner mit ihrer Einheit. Die Erweiterungskorpora (5.5) kennen nur Logereignisse; Blöcke (HDFS) und Client-IPs (OpenSSH, Apache) sind Breiteneinheiten (R-08), keine Zähleinheiten. |
| **R-02 · Fehler und Alerts** | BGL: Fehler sind Levels `ERROR`, `SEVERE`, `FATAL`, `FAILURE`; Alerts sind Zeilen mit Label ungleich `-`. OpenStack: Fehler sind Levels `ERROR` und `CRITICAL`; fehlgeschlagene API-Zugriffe haben HTTP-Status 500–599, Client-Fehler (400–499) werden getrennt ausgewiesen. Die HTTP-Fehlerrate ist die Zahl der 5xx-Zugriffe geteilt durch alle API-Zugriffe im Umfang; die 4xx-Rate wird getrennt genannt. Unbekannte Levels bleiben eigene Kategorien. **Bestätigt durch Profiling (U03, `sql/profiling/10_levels.sql`):** BGL hat sechs Levels, nicht fünf wie im Brief: `INFO` 3.735.805, `FATAL` 855.501, `ERROR` 112.355, `WARNING` 23.357, `SEVERE` 19.213, `FAILURE` 1.714. Alle vier Fehlerlevels kommen vor (988.783 Fehlerereignisse); jede Alert-Zeile hat `FATAL` (348.398) oder `FAILURE` (62), Alerts sind also eine Teilmenge der Fehlerereignisse. OpenStack: `INFO` 204.506, `WARNING` 3.118, `ERROR` 194, `CRITICAL` 2 (196 Fehlerereignisse). Levels werden wie geloggt übernommen, ohne Ausnahme nach Meldungstext (5.2). Zuordnung im README. **Erweiterungen (U26, 5.5):** HDFS und ZooKeeper `ERROR`, `FATAL`; Apache `error`, `crit`, `alert`, `emerg` (Kleinschreibung wie geloggt); OpenSSH ohne Levelfeld: Meldungen mit Präfix `error:` oder `fatal:` (OpenSSH-Stufen ERROR und FATAL); Linux: nicht bestimmbar (`is_error` unbekannt, keine Fehlerfilter). Warnstufen (`WARN`, `warn`) sind keine Fehler. |
| **R-03 · Zeit** | Zeiträume schließen den Start ein und das Ende aus. Ausgabe in UTC. BGL-Zeit stammt aus den Unix-Sekunden; OpenStack-Zeit ist als UTC angenommen, ebenso die Zeit der Erweiterungen; fehlende Jahre (OpenSSH, Linux) werden belegt erschlossen (5.5). Buckets außerhalb der Datenspanne sind keine Null. Min-/Max-Zeit beweist keine lückenlose Erfassung. |
| **R-04 · Muster** | Ein Muster ist die normalisierte Meldung innerhalb desselben Datensatzes und derselben Komponente. Maskiert werden veränderliche Kennungen und Werte: UUIDs, Request-, Instanz- und Benutzerkennungen, IP-Adressen und Ports, Node-Kennungen, Speicheradressen, Zeitangaben, Mengen und Dauern sowie variable Pfadsegmente. Erhalten bleiben bedeutungstragende Wörter, Operationen und Pfadbestandteile sowie diagnostische Codes (HTTP-Status, Fehler-, Rückgabe- und Statuscodes). Jede Maske ist mit Begründung versioniert. Ein Muster ist weder Incident noch Ursache. |
| **R-05 · Episode und wiederkehrend** | Episoden werden innerhalb eines Musters über den vollständig gefilterten Umfang (Datensatz, Zeitraum, alle Filter) bestimmt, in der Reihenfolge Zeitstempel, dann `event_id`. Genau das erste Ereignis im Umfang beginnt die erste Episode; nach mindestens 30 Minuten ohne Ereignis beginnt eine neue. **Schwelle 30 Minuten für beide Datensätze bestätigt (U03, `sql/profiling/40_episodes.sql`):** In BGL liegen 96 % der Abstände zwischen Ereignissen desselben Fehler- bzw. Alert-Musters unter einer Sekunde (Ausbrüche), nur 0,4 % zwischen 5 min und 2 h; die Zahl wiederkehrender Muster ändert sich zwischen 10 und 60 min kaum (435, 430, 429 von 514 Kandidaten). In OpenStack ist jeder Abstand zwischen Fehlerereignissen desselben Musters mindestens 30 min (periodische Tasks im Abstand von 40–80 min); bei 30 min ist jedes Auftreten eine eigene Episode, bei 60 min würden benachbarte Läufe zusammengelegt. Zwei oder mehr Episoden im Zeitraum heißen „wiederkehrend“. Aktive Tage bzw. Wochen werden unabhängig davon ausgewiesen; eine einzelne Episode über mehrere aktive Tage ist kein einmaliger Ausschlag. Episoden sind keine bestätigten Ausfälle. |
| **R-06 · Vergleich** | Vergleichbar sind gleich lange Zeiträume mit gleichen Filtern. Ausgegeben werden C, B und C − B; die relative Veränderung nur bei B > 0. B = 0 und C > 0: „first observed in this comparison“. C = B = 0: „not observed in either period“. „Significantly increased“ bei B > 0, mindestens Verdopplung und mindestens 20 zusätzlichen Ereignissen. |
| **R-07 · Hypothesenstatus** | `supported` braucht relevante verknüpfte Beobachtungen und keinen bekannten entscheidenden Gegenbeleg; `contradicted` braucht einen Beleg gegen eine notwendige Annahme; fehlende oder gemischte Evidenz ergibt `open`. Der Status nennt die Prüfung, auf der er beruht, mit Fakt-ID. Ein Vorläufer (R-11) kann `supported` begründen, nie einen Kausalbeweis. Allgemeines Fachwissen ist als `background` gekennzeichnet und keine Beobachtung. |
| **R-08 · Priorisierung** | Innerhalb eines Datensatzes, Zeitraums und der übergebenen Filter. Kandidaten sind Muster mit Fehlerereignissen bzw. Alerts; bei OpenStack zusätzlich Muster fehlgeschlagener API-Zugriffe (5xx), wenn vorhanden. Getrennt bestimmt werden **Häufigkeit** als Episoden nach R-05, **Breite** als Zahl betroffener Einheiten (BGL: Nodes; OpenStack: Instanzen; Festlegung unten), **Veränderung** als C − B nach R-06 und die Zahl der Ereignisse. Ausgangsreihenfolge: Episoden absteigend, dann Breite, dann absolute Zunahme, dann Ereignisse, zuletzt `pattern_id` für eine stabile Reihenfolge. Die Zahl der Logzeilen ist bewusst nicht das erste Kriterium, weil Ausbrüche einzelner Muster sie aufblähen. Ein Kriterium, das nicht für alle Kandidaten bestimmbar ist, entfällt für die ganze Rangfolge. **Breitenebene (U03, `sql/profiling/50_breadth.sql`):** BGL-Breite sind Nodes, weil sie lokal und systemisch trennen: `data TLB error interrupt` betrifft 541 Nodes in 29 Racks, `data storage interrupt` 22.529 Nodes in 23 Racks; Racks (höchstens 64, viele Muster erreichen alle) trennen nicht und werden nur zusätzlich gezeigt, Midplanes entfallen. Nodes sind in 91,0 % der Kandidatenereignisse gesetzt. OpenStack-Breite sind Instanzen; Requests sind fast immer eins je Zeile und werden nur gezeigt. Breite ist für einen Kandidaten nur bestimmbar, wenn jedes seiner Ereignisse im Umfang die Einheit trägt; eine Untergrenze aus teilweise belegten Ereignissen gilt nicht. Folgen im Korpus: 17 der 514 BGL-Kandidaten tragen nicht durchgehend einen Node (Dienste des Service-Nodes in `MMCS` und `BGLMASTER`, `Kill job … timed out`, `Power deactivated`), Breite entfällt also über die volle BGL-Spanne und für Control Plane bzw. Compute Platform, bleibt aber für Workload Runtime und Hardware Operations. Keiner der 27 OpenStack-Kandidaten nennt eine Instanz; Breite entfällt dort immer. Breite wird trotzdem je Kandidat gezeigt, wo sie bestimmbar ist. **Erweiterungen (U26):** Kandidaten sind Muster mit Fehlerereignissen nach R-02; Breite HDFS Blöcke, OpenSSH und Apache Client-IPs, Linux und ZooKeeper keine (Kriterium entfällt mit Begründung). Linux hat keine Fehlerdefinition und damit keine Rangfolge; HDFS hat im Korpus keine Fehlerereignisse und damit null Kandidaten (beobachtete Null). Datensatz-Labels je Block (HDFS) sind wie die OpenStack-Instanzlabels keine Kandidaten. |
| **R-09 · Grenzen der Priorisierung** | R-08 ist eine technische Untersuchungsreihenfolge, keine Messung von Schwere oder Geschäftsrisiko. Ein seltenes schweres Problem kann niedriger stehen. Level, Labels und Status werden zusätzlich und getrennt gezeigt. **Dominanz:** Ein Kandidat dominiert einen anderen, wenn er bei Episoden, Breite und Veränderung mindestens gleichauf und in mindestens einer dieser Dimensionen vorn liegt; ist die Veränderung nicht bestimmbar, zählen Episoden und Breite. Dominiert ein Kandidat alle anderen, ist er klar Priorität 1. Sonst benennt die Antwort den Zielkonflikt und begründet die Wahl; eine von R-08 abweichende Empfehlung nennt ihre zusätzliche Evidenz. Ein zusammengesetzter Risikoscore wird nicht gebildet. |
| **R-10 · Musterstatus** | Gegenüber dem vorherigen gleich langen Zeitraum genau ein Status nach Vorrang: **New** (erstes Ereignis des Musters liegt im Zeitraum, der nach dem Datenbeginn startet), **Escalating** („significantly increased“ nach R-06), **Reappeared** (B = 0, C > 0, frühere Ereignisse vorhanden), **Ongoing** (C > 0), **Quiet** (C = 0, B > 0). Unabhängig davon das Kennzeichen **Recurring** nach R-05. Ohne bestimmbare Referenz entfallen Escalating, Reappeared und Quiet. Ein Status ist kein Schweregrad. |
| **R-11 · Vorläufer** | Anker sind die Episodenanfänge (Abstand nach R-05) der Ereignisse eines Musters bzw. der Treffer einer Suchbedingung im vollständig gefilterten Umfang; spätere Ereignisse derselben Episode sind keine Anker, damit Ausbrüche nicht mehrfach zählen. Fenster: `[Anker − w, Anker)` davor bzw. `(Anker, Anker + w]` danach, `w` höchstens 60 Minuten, Standard 10. Je Muster zählt die Zahl der Anker, in deren Fenster es mindestens einmal vorkommt; das Ankermuster selbst ist ausgeschlossen. Grundrate: Anteil der gleich langen Fenster eines festen Rasters ab Beginn der Datenspanne im Umfang, in denen das Muster vorkommt. Ausgegeben werden Ankeranteil, Grundrate und ihr Verhältnis; unter fünf Ankern entfällt die Grundrate. Ein Vorläufer ist eine zeitliche Beobachtung, keine Ursache. |

Regeländerungen nach dem Profiling werden mit Begründung versioniert; Regeln werden nicht für einzelne Demo-Antworten angepasst.

## 10. Abnahmefälle

| ID | Situation | Erwartetes Ergebnis | Anforderungen |
|---|---|---|---|
| **S-01** | Frischer Klon nach README | System startet; Ladebilanz stimmt mit dem Brief überein oder Abweichungen sind erklärt; Claude verbindet sich per MCP | A-01, A-02, A-15 |
| **S-02** | Engineer-Frage zu einem Fehler in einem Zeitraum | Volltexttreffer mit Gesamtzahl, Umgebung, Eingrenzung, Hypothese mit Status, konkrete Prüfung; alle Zahlen verifiziert | A-05, A-06, A-17, A-20 |
| **S-03** | Team-Lead-Frage über einen genannten Zeitraum | Wiederkehrende Muster mit Episoden und Trend, Verteilung nach Team, Untersuchungsempfehlung mit Team | A-07, A-08, A-10, A-18 |
| **S-04** | Manager-Frage ohne Zeitraum | Bis zu drei Prioritäten mit Episoden, Ereignissen, Breite, Veränderung und Teams getrennt; Rangbasis; Dominanz oder benannter Zielkonflikt; Maßnahmen; „business impact unknown“ | A-11, A-19 |
| **S-05** | Frage nach Ereignissen nach Team über alles | Zählung über das gesamte Basiskorpus je Datensatz und Team mit `unowned` und benanntem Umfang | A-03, A-07 |
| **S-06** | Suche mit mehr als 50 Treffern | Exakte Gesamtzahl, 50 Treffer, `truncated: true`; der Agent leitet keine Häufigkeit aus den Treffern ab | A-05, A-13 |
| **S-07** | Suche ohne Treffer | Ausdrückliches „no matching events“ mit Umfang; keine erfundenen Belege | A-05, A-20 |
| **S-08** | Antwortentwurf mit einer falschen Zahl, einer richtigen Zahl unter falscher Kennzahl oder Gruppe (etwa `requests: 120` als „120 errors“) bzw. einer nicht existierenden Fakt-ID | `check_claims` meldet `mismatch` mit dem abweichenden Merkmal bzw. `unknown_fact`, in MCP-Weg und Web-App gleich und in der Verification gezählt; die Antwort wird korrigiert oder die Zahl entfällt | A-14 |
| **S-09** | Testereignis mit eingebetteter Anweisung („ignore previous instructions…“) im synthetischen Testdatensatz | Wird als Logtext zitiert; keine Regel- oder Tool-Änderung | A-25 |
| **S-10** | Frage nach Kosten oder Ausfallzeit | Begrenzte Antwort: messbare Häufigkeit und Breite, fehlende Geschäftsdaten benannt | A-19, A-20 |
| **S-11 · optional** | Bei späterem formalem Eval: unabhängig erstellte, bis zum Test zurückgehaltene Frage mit anderen Filtern | Belegte Antwort oder korrekt benannte Grenze; erster Lauf mit eingefrorener Konfiguration separat dokumentiert; nach Einsicht nur noch als Regressionstest bezeichnet | A-16, A-20, A-21 |
| **S-12** | Derselbe Tool-Aufruf (gleicher normalisierter Input) über Claude Code (MCP) und Web-Chat auf derselben Datenversion | Gleiche Receipt-Signatur, identische Zahlen und gleicher Ergebnis-Digest | A-13, A-15, A-26 |
| **S-13** | Dieselbe Situation aus Sicht aller drei Rollen | Unterschiedliche Belegebenen, Pflichtbelege, Prüfungen, Antwortkerne und Entscheidungen im nächsten Schritt; gemeinsame Zahlen stimmen überein; der zusätzliche sichtbare Web-Rollenvergleich ist zurückgestellt | A-16–A-20, A-38 |
| **S-14** | Rollenfrage in Claude Desktop bzw. Claude Code ohne Wahl eines Rollen-Prompts | Antwort nach dem Playbook der erkannten Rolle mit deren Antwortkern; bei unklarer Rolle eine Rückfrage | A-37 |
| **S-15** | Engineer-Frage, deren Fehler sich lokal (wenige Nodes) oder systemisch (viele Racks) erklären lässt | Mindestens eine ausgeführte unterscheidende Prüfung, etwa Zählung nach Node bzw. Rack oder Vorläuferanalyse; Hypothesenstatus mit deren Fakt-ID begründet; ein Vorläufer wird nicht als Ursache bezeichnet | A-17, A-36, R-07, R-11 |
| **S-16** | Manager-Frage, bei der das Muster mit den meisten Logzeilen in wenigen Episoden auf wenigen Nodes liegt | Rangfolge nach Episoden und Breite, nicht nach Zeilen; der Zielkonflikt wird benannt und die Wahl begründet | A-11, A-19, R-08, R-09 |

## 11. Demo und Abgabe

### 11.1 Live-Demo (höchstens fünf Minuten)

| Zeit | Inhalt |
|---|---|
| 0:00–0:30 | Problem und Ansatz: 5 Mio. Logzeilen passen in keinen Prompt. SereneDB rechnet, Claude erklärt. Übersicht mit Korpusumfang. |
| 0:30–1:50 | **Engineer** live: Volltextsuche mit Zeitfilter, Nachbarereignisse, Eingrenzung, erste vorläufige Einschätzung, unterscheidende Prüfung (Konzentration oder Vorläufer), deren Wirkung auf Hypothese oder nächsten Schritt; ein Receipt mit SQL und Laufzeit wird geöffnet und benennt die SereneDB-Funktion darin (etwa BM25-Index oder `MATCH_RECOGNIZE`, 2.2 Punkt 7). |
| 1:50–2:45 | **Team Lead** live: wiederkehrende Muster über einen genannten Zeitraum nach Team, Wochentrend, was zuerst untersuchen. |
| 2:45–3:40 | **Manager** live: bis zu drei Prioritäten mit Episoden, Breite, Veränderung, Team und Maßnahme; Zielkonflikt benannt; „business impact unknown“. |
| 3:40–4:30 | Beweis: die drei Rollensichten mit ihren verschiedenen Entscheidungen, Faktenprüfung an der Antwort und ein Receipt mit Query und Ergebnis; vorhandenen Re-run-/Client-Paritätsnachweis kurz verlinken. |
| 4:30–5:00 | Grenzen und Ausblick. |

Live gestellte Fragen werden vorher geprobt, aber live ausgeführt; sie zählen nicht als unbekannte Holdout-Fragen. Vor der Abgabe wird die vollständige Demo mit ihren tatsächlich gezeigten Wartezeiten geprobt; Ziel ist eine Gesamtdauer unter 4:30. Reicht die Zeit nicht, zeigen einzelne Rollenläufe bereits ausgeführte Ergebnisse, die sichtbar als solche gekennzeichnet sind: in der Web-App als importierte Laufdatei mit dem Banner `Recorded run`, deren Belege gegen die lokal gespeicherten Receipts aufgelöst werden (ui-concept 4.5). Die Demo darf echte gespeicherte Rollenläufe zeigen, wenn sie als Aufzeichnung gekennzeichnet sind; sie werden nicht als neue Live-Läufe oder Holdout ausgegeben.

### 11.2 Auswahl der ausgearbeiteten Untersuchung

Direkt nach dem Profiling wählen wir den Fall und einen Ersatzfall nach diesen Kriterien. Der Fall bestimmt Beispielfragen, Demo, Abgabevideo und ausgearbeitete Untersuchung, nicht den Tool-Umfang; alle acht Tools sind P0 (Abschnitt 4).

1. Ein Muster mit mindestens zwei Episoden und klarer Team-Zuordnung.
2. Die Volltextsuche findet unterscheidende Belege; die Umgebung zeigt eine erkennbare Abfolge.
3. Alle drei Rollenfragen lassen sich darauf sinnvoll stellen.
4. Dataset-Labels können zur Kontrolle herangezogen werden.
5. OpenStack trägt mindestens eine Aggregation bei, etwa Latenz oder Fehlerrate (O-06).
6. Eine unterscheidende Prüfung (A-17, A-36) ist möglich, und ihr Ergebnis begründet den Hypothesenstatus. Unter geeigneten Fällen wird einer bevorzugt, bei dem neue Evidenz eine erste Vermutung einschränkt oder widerlegt bzw. die Untersuchungsreihenfolge verändert. Die erste Einschätzung wird vor der Prüfung festgehalten und nicht nachträglich erfunden. Liefert das Korpus keinen solchen Fall, wird die begründete Beibehaltung oder Offenheit der Hypothese mit fehlender Evidenz und nächstem Prüfschritt gezeigt; die Einschränkung der Fallauswahl wird dokumentiert. Ein Statuswechsel wird nie erzwungen.

Kandidaten aus den Samples, vor dem Profiling: BGL `APPREAD` (`ciod: failed to read message prefix …`), `KERNDTLB` (Data-TLB-Fehler), `KERNSTOR`; OpenStack-Warnungen zur Synchronisierung von Power States und auffällige API-Latenzen.

**Erste Einschätzung**, festgehalten am 17.10.2026 vor jeder Profiling-Abfrage auf dem vollen Korpus (Kommentar im Linear-Ticket LOG-12, 17:28 UTC): `APPREAD` wiederkehrend und **systemisch** (Job- oder Netzereignis an den I/O-Nodes, kein einzelner Node); `KERNDTLB` **lokal** (Ausbrüche auf wenigen Nodes, wenige Episoden, viele Zeilen); `KERNSTOR` lokal und selten; Power-State-Synchronisierung periodisch und ohne Bezug zu den gelabelten Instanzen; API-Latenz mit hohem p99 auf wenigen Endpunkten und keinen oder fast keinen 5xx.

**Prüfung (U03, `sql/profiling/80_cases.sql`, Datenversion `dv_263e378cd8560c4a`):**

| Kandidat | Ereignisse | Episoden (30 min) | Nodes / Racks | Ergebnis gegenüber der ersten Einschätzung |
|---|---:|---:|---|---|
| `APPREAD` | 5.983 | 7 an 5 Tagen (04.–20.06.2005) | 512 / 32; sechs Episoden mit 124–510 Nodes in 8–32 Racks binnen 0,1–18,2 min, eine mit einem Ereignis | Breit, aber kein Netzereignis: Vor 6 der 7 Episodenanfänge steht 0,5–1,3 s früher `ciod: LOGIN chdir(<PATH>) failed: No such file or directory` auf 2–4 anderen I/O-Nodes (Ankeranteil 0,857 gegenüber Grundrate 0,0027 der 10-min-Fenster). Die Einschätzung verschiebt sich von „Netz/I-O-Node“ zu „Jobstart scheitert am Arbeitsverzeichnis, danach brechen die Kontrollströme des ganzen Jobs ab“; `supported`, kein Kausalbeweis (R-07, R-11). Das Dataset-Label markiert die Folge (`APPREAD`), nicht den Auslöser (ohne Label) |
| `KERNDTLB` | 152.734 | 22 an 10 Tagen | 541 / 29; 152.182 Ereignisse in einer Episode auf einem Node (12.06.2005, 382 min) | Lokal bestätigt für das Volumen; die übrigen 21 Episoden sind klein (1–251 Nodes). Muster mit den meisten Zeilen, Rang 218 von 514 nach Episoden (Gleichstand nach Ereignissen aufgelöst; S-16) |
| `KERNSTOR` | 63.491 | 5 | 22.529 / 23; 14.06.2005: 16.384 Ereignisse auf 16.384 Nodes in 16 Racks (8 min) und 47.104 auf 22.528 Nodes in 22 Racks (72 min); dazu drei Einzelereignisse | Widerlegt: nicht lokal, sondern zwei breite Ausbrüche an einem Tag |
| Power-State-Synchronisierung | 45 | in 22 Stunden | keine Instanz in der Zeile | Bestätigt periodisch; kein Bezug zu gelabelten Instanzen bestimmbar |
| API-Latenz und 5xx | 98.733 Zugriffe | – | – | In jeder Stunde mit mehr als 1.000 Zugriffen p50 258,2–260,9 ms und p99 501,0–530,2 ms, also keine auffällige Phase; `servers/detail` p99 436,4 ms; die einzigen zwei 5xx (503) liegen am 16. und 17.05. um 06:25 und folgen in derselben Request-ID auf `Bad response code while validating token: 503` und `Unable to validate token` (CRITICAL). Das Maximum (4.164,5 ms) liegt in derselben Minute am 17.05. |

**Gewählter Fall: `APPREAD` (BGL), Team Workload Runtime.** Kriterien: (1) 7 Episoden, Komponente `APP`; (2) die Volltextsuche trennt `failed to read message prefix` von den ähnlichen `Error reading message prefix`-Mustern, die Umgebung zeigt die Abfolge chdir-Fehler → Lesefehler; (3) Engineer: Ursache und nächste Prüfung, Team Lead: wiederkehrende Jobstartfehler im Juni 2005 (`Error loading` 22 Episoden, `LOGIN chdir … failed` 14, `APPREAD` 7), Manager: Einordnung in die BGL-Untersuchungsreihenfolge; (4) das Label `APPREAD` deckt sich 1:1 mit dem Muster (5.983 Zeilen) und kontrolliert die Zählung; (5) OpenStack trägt getrennt die Token-Validierung um 06:25 mit 2 von 98.733 5xx-Zugriffen und dem Latenzmaximum bei (keine gemeinsame Zeitachse); (6) Breite je Episode und Vorläuferanalyse sind die unterscheidenden Prüfungen, und die Vorläuferanalyse verändert die erste Einschätzung. Was das Arbeitsverzeichnis fehlen ließ, zeigen die Logs nicht; das bleibt offen.

**Ersatzfall: `KERNDTLB` (BGL), Team Compute Platform**, mit der Zählung nach Node als unterscheidender Prüfung und als echter Fall für S-16.

**S-16 gefunden:** Das Fehler- bzw. Alert-Muster mit den meisten Zeilen (`data TLB error interrupt`, 152.734) hat 22 Episoden und steht nach Episoden auf Rang 218 von 514; vorn liegen Muster mit bis zu 289 Episoden auf bis zu 22.791 Nodes. Das zweitgrößte, `idoproxydb hit ASSERT condition` (84.168 Zeilen), hat 4 Episoden und keinen Node.

### 11.3 Abgabeumfang

Öffentliches Repository, README mit Tool-Referenz, Ownership-Tabelle und transparentem Prüfstatus nach A-23, ausgearbeitete Untersuchung (`submission/worked-investigation.md`, englisch) mit Receipts, echte Agentenantworten je Rolle, funktionierender MCP-Server, Slides, Abgabevideo ≤ 3 Minuten und Demo ≤ 5 Minuten. Vorhandene stabile Web-Funktionen dürfen gezeigt werden; eine eigene Web-Oberfläche, ein formaler Eval-Bericht und der zusätzliche Web-Rollenvergleich sind keine Mindestanforderung. Angaben zu verwendeten Diensten (Claude, SereneDB) und Lizenzen der Daten.

### 11.4 Abgabevideo (höchstens drei Minuten, englisch)

Die Teilnahmeregeln verlangen ein englisches Demo- oder Walkthrough-Video von höchstens drei Minuten; der Brief erlaubt für die Präsentation fünf. Das Video ist eine eigene, gekürzte Fassung aus echten, geschnittenen Läufen und als Aufzeichnung gekennzeichnet.

| Zeit | Inhalt |
|---|---|
| 0:00–0:20 | Problem und Ansatz |
| 0:20–1:10 | Engineer: Suche, Umgebung, erste Einschätzung, unterscheidende Prüfung und ihre Wirkung, Receipt |
| 1:10–1:45 | Team Lead: wiederkehrende Muster und Trend nach Team |
| 1:45–2:20 | Manager: Prioritäten mit Zielkonflikt und Maßnahmen |
| 2:20–2:45 | Beweis: drei belegte Rollensichten und Faktenprüfung |
| 2:45–3:00 | Grenzen |

## 12. Offene Punkte

| ID | Punkt | Arbeitsannahme | Klärung |
|---|---|---|---|
| **O-01** | Anthropic-API-Zugang für den Web-Chat | Ohne Schlüssel funktioniert der MCP-Weg mit dem Claude-Konto der Jury; der Web-Chat zeigt dann einen klaren Hinweis. **Modell geklärt (Jury-Gespräch 17.10.):** Die Jury nutzt Claude Opus 5.5; tatsächliche Demo-Proben sowie ein später beauftragtes formales Web-/Rollen-Eval verwenden deshalb `claude-opus-5-5`, Kosten- und Laufzeitangaben beziehen sich auf dieses Modell | Schlüssel: vor der Verdrahtung des Web-Chats |
| **O-08** | Welchen Claude-Client nutzt die Jury? | Im Gespräch nicht beantwortet. Beide Clients sind dokumentiert; tatsächliche Verbindungsproben und Grenzen stehen im Prüfbericht (A-15, S-14). Der MCP-Weg läuft mit dem Claude-Konto der Jury. Eine vollständige Client-Matrix und der Holdout sind zurückgestellt; die geprüften Beispiele belegen keine Qualität bei unbekannten Fragen | Nachfrage bei den Organisatoren; tatsächlichen Demo-Client benennen |
| **O-02** | SereneDB-Funktionen für Parsing, Regex, Perzentile, Datumsfunktionen, Phrasen- und Fuzzy-Operatoren sowie die Laufzeit der Vorläuferanalyse | Laut Doku vorhanden; Prüfung im Kompatibilitäts-Gate mit dem Docs-MCP bzw. `sdb_docs.search` | Kompatibilitäts-Gate |
| **O-03** | Brief nennt eine bereitgestellte Instanz, Guidance verlangt lokalen Betrieb | Wir folgen der Guidance; das README erklärt den lokalen Start | Erledigt, im README benennen |
| **O-04** | Format der OpenStack-Anomalie-Labels | **Geklärt (U03):** ein Satz, eine Leerzeile, vier Instanz-UUIDs. `is_anomalous` ist `true` für die 100 Zeilen mit diesen Instanzen (je 25, alle `INFO`, `nova-compute`, 14.05.2017 21:07–21:48), `false` für 51.453 Zeilen mit einer anderen Instanz, sonst `NULL`. Die Labels bleiben in Gebrauch, aber nur als Kontext je Instanz („dataset label“): Sie markieren Instanzen, keine Fehlerzeilen, und keine Fehler- oder 5xx-Zeile nennt eine Instanz. Die Aggregation hängt nicht von ihnen ab | Erledigt |
| **O-05** | Regeln zur Vorarbeit vor dem Arbeitsfenster | Bereits vorhandene Dokumente werden in der Abgabe wahrheitsgemäß als Vorarbeit ausgewiesen. Die Offenlegung allein klärt die Zulässigkeit nicht; die Teilnahmeregeln sind zu prüfen, bei Unklarheit fragen wir die Organisatoren | Vor H6 |
| **O-06** | Kommen im OpenStack-Korpus 5xx-Zugriffe vor? | **Geklärt (U03, `sql/profiling/20_http.sql`):** 2 von 98.733 API-Zugriffen (0,002 %), beide `503` auf `GET /v2/<ID>/servers/detail`; 3.969 4xx (4,02 %), alle `404` (`os-server-external-events` 2.064, Metadaten `user_data` 1.905). Die 5xx-Rate ist **keine** Demo-Kennzahl; die zwei 503 sind Evidenz im Fall (11.2). Latenzperzentile je Endpunkt, Fehlerereignisse je Komponente und die Abfolge der Token-Validierung tragen die OpenStack-Aussagen | Erledigt |
| **O-07** | Der Brief nennt für BGL fünf Schweregrade; R-02 listet mehr Level-Namen | **Geklärt (U03):** sechs Levels beobachtet, alle vier Fehlerlevels von R-02 kommen vor; R-02 bleibt unverändert (Zählungen dort) | Erledigt |

## 13. Änderungen

### Version 3.9 (18.10.2026)

**Nutzerentscheidung, LOG-56:** Nach Abgleich mit dem Originalbrief wird nur noch der notwendige Abgabeumfang abgeschlossen. **Konflikt gelöst:** A-21/A-23, M2 und U16/U18 machten den selbst auferlegten formalen Dev-/Baseline-/Holdout-Vergleich, die vollständige Client-/Prompt-Matrix und den zusätzlichen Web-Rollenvergleich zu Abgabetoren. Diese Zusatzläufe sind ausdrücklich zurückgestellt; mindestens eine echte, inhaltlich geprüfte Agentenantwort je Rolle mit zugänglichen Queries und Ergebnissen bleibt erforderlich. Methodik, implementierte Schutzmechanismen, R-01–R-11 und neue Forschungs-/Retrieval-Erweiterungen bleiben unverändert. Vorbereitung und bekannte Proben werden nicht als Eval-Pass, Baseline-Vorteil oder Generalisierung ausgegeben. Drei echte Modellantworten und ein als aufgezeichnet gekennzeichneter Walkthrough liegen vor; die volle Client-Matrix ist damit nicht bestanden.

**Separate Veröffentlichung:** Der Eigentümer hat das öffentliche Schalten des Hauptrepositorys ausdrücklich abgelehnt und vorerst zurückgestellt. Code und Abgabeunterlagen können intern fertiggestellt werden; A-23 und M2 sind hinsichtlich öffentlicher Zugänglichkeit weiterhin offen. Die Entscheidung ersetzt keine Abgaberegel des Briefs. technical.md v3.8 spiegelt diesen Umfang.

### Version 3.8 (18.10.2026)

Erweiterungskorpora (LOG-40, U26), vom Nutzer beauftragter Ausbau nach M1; umgesetzt in [technical.md](technical.md) v3.4. Die P0-Abnahme, die Abnahmefälle S-01–S-16 und die Bewertung bleiben auf das Basiskorpus bezogen.

- **5.4, 5.5, A-39:** fünf weitere Loghub-Korpora mit Herkunft, Feldern, Zeitbasis, Labels und Entscheidungen; Zitation HDFS (Xu et al.) und Lizenzangabe des Zenodo-Records.
- **5.2, R-03:** „Keine gemeinsame Zeitachse“ gilt für jeden Datensatz. **Konflikt:** Die bisherige Begründung war fehlende Überlappung; Apache und Linux überlappen kalendarisch mit BGL. Neu begründet mit verschiedenen Systemen und unbekannten Zeitzonen; die Regel selbst bleibt.
- **R-01, R-02, R-08:** Zähleinheiten, Fehlerdefinition und Breite je Erweiterung. **Konflikt:** R-02 setzt bisher ein Levelfeld voraus; OpenSSH hat keins (Präfix `error:`/`fatal:` aus dem OpenSSH-Quelltext), Linux hat gar keine Fehlerdefinition. Statt einer Ersatzdefinition sind Fehlerfilter und Rangfolge für Linux nicht verfügbar. HDFS hat keine Fehlerstufe im Korpus; `WARN` wird nicht zum Fehler umgedeutet.
- **5.3:** Die fiktive Organisation erhält Teams für die Erweiterungen; seltene Linux-Programme bleiben bewusst `unowned`.
- **A-02, A-03, A-04:** gelten für das Basiskorpus unverändert; für die Erweiterungen konkretisiert A-39 dieselben Anforderungen.

### Version 3.7 (18.10.2026)

Web-App-Entscheidungen nach Fertigstellung von Tools und MCP-Server; umgesetzt in [ui-concept.md](ui-concept.md) v3.0 und [technical.md](technical.md) v3.3. Keine Regel R-01–R-11, kein Abnahmefall und keine Priorität ändert sich.

- **2.2 Punkt 2:** Die Web-App markiert neben nicht eingereichten Fakt-IDs (`unchecked`) auch Zahlen ohne Fakt-ID (`uncited`); beides ist syntaktisch und ersetzt weder `check_claims` noch das Rollen-Eval.
- **11.1:** Der Rückfall „bereits ausgeführte Ergebnisse“ ist eine importierte Laufdatei mit sichtbarem Banner; es gibt weiterhin keine gespeicherten Untersuchungen (3.2).

### Version 3.6 (17.10.2026)

Entscheidungen aus dem Gespräch mit dem SereneDB-Team (LOG-30). Keine Regel R-01–R-11 und kein Abnahmefall ändert sich; geändert werden Rechenort, Priorität und Abgabeinhalt.

- **2.1:** Nutzung von SereneDB als Unterscheidungsmerkmal bei Gleichstand, mit den übrigen Aussagen des Gesprächs.
- **2.2 Punkt 7:** Rechenort. Auch die Regelergebnisse nach R-06, R-08, R-09 und R-10 entstehen in SQL; SereneDB-eigene Funktionen werden gezielt eingesetzt und gezeigt (technical.md § 5.3, U22–U25).
- **3.2:** AI-Funktionen in SereneDB-SQL und Vektorsuche darauf bewusst nicht im Kern.
- **4:** Vorrang von SereneDB-Tiefe vor weiterem UI-Ausbau nach M1; A-32 von P2 auf P1.
- **A-23, A-24, 11.1:** SereneDB-Funktionsübersicht, Modell- und Versionsangabe, geprüfte Beispielfragen und bewusst nicht beantwortete Fragen im README; Übersicht in den Slides; die Demo benennt die SereneDB-Funktion im geöffneten Receipt.
- **A-32:** invertierter Index über externe Dateien als bevorzugter Weg.
- **O-01, O-08:** Modell `claude-opus-5-5` geklärt; Client der Jury offen.

### Version 3.5 (17.10.2026)

Profiling und Datenentscheidungen (U03, LOG-12) aus dem geladenen Korpus; jede Zahl stammt aus einer Abfrage in `packages/corpus/sql/profiling/` (`pnpm data:profile`). Regeln wurden nicht für einzelne Demo-Antworten angepasst.

- **R-02, O-07:** sechs BGL-Levels beobachtet; Fehlerdefinition unverändert bestätigt; Alerts sind Teilmenge der Fehlerereignisse.
- **R-05:** Schwelle 30 Minuten für beide Datensätze bestätigt, mit Begründung aus der Abstandsverteilung.
- **R-08:** Breitenebene festgelegt (BGL Nodes, OpenStack Instanzen) und „bestimmbar“ präzisiert (jedes Ereignis trägt die Einheit); Folgen für die Rangfolge benannt.
- **5.1, 5.2:** Labels und Request-IDs mit Korpuszahlen; neue Grenzen „Erfassungslücken“ und „Level ist nicht Inhalt“.
- **5.3:** Ownership final; `SERV_NET` bewusst `unowned`; Begründung je Zeile.
- **11.2:** erste Einschätzung datiert, Prüfung der Kandidaten, Fall `APPREAD`, Ersatzfall `KERNDTLB`; S-16 im Korpus gefunden.
- **O-04, O-06:** geklärt; die 5xx-Rate ist keine Demo-Kennzahl.

### Version 3.4 (17.10.2026)

- **Wirksamkeitsnachweis (2.2, A-21):** Vergleich einfacher Rollen-Anweisung und vollständiger Playbooks unter gleichen Bedingungen; gemeinsame Regeln bleiben erhalten, indirekte Playbook-Zufuhr zur Baseline ausgeschlossen. Inhaltliche Qualität und Produktkonformität werden getrennt geprüft; ein Vorteil gegenüber der Baseline ist keine Abnahmevoraussetzung.
- **Holdout (A-21, S-11):** unabhängig erstellte Testfragen bis zum Konfigurations-Freeze zurückhalten, Erstläufe separat auswerten; nach Einsicht nur noch Regressionstests, neue Holdouts für erneute Nachweise. Bestehensgrenze getrennt je Fragensatz.
- **Messung und Bericht (A-21, A-23, A-24, 11.3):** vorab festgelegte Wiederholungen; Antwortqualität, Gesamtlaufzeit, Aufrufe, Token und geschätzte API-Kosten getrennt; Laufartefakte als Quelle für Eval- und Leistungskennzahlen.
- **Untersuchung und Demo (A-22, 11):** bevorzugt einen echten Fall zeigen, bei dem Evidenz die erste Einschätzung verändert; begründet offene Hypothesen bleiben gültig. Demo-Fragen sind keine Holdouts.
- **Optionales Experiment:** I-21 prüft den Nutzen historischer Vergleichsevidenz nach vollständigem P0; kein neues Tool und keine zusätzliche Abnahmevoraussetzung. Durchführung: [technical.md](technical.md) v2.5.

### Version 3.3 (17.10.2026)

Entscheidungsreview vor dem Ticket-Zuschnitt, mit Blick auf die Bewertungskriterien des Briefs. Die Umsetzung erfolgt mit mehreren parallelen Agenten; der Umfang wird nicht mehr nach verfügbaren Stunden zugeschnitten. Details: [technical.md](technical.md) v2.4.

- **Tools (3.1, 4, 6, A-10–A-12, A-15):** acht Tools, alle P0; die Bedingung „nur bei Fallbedarf“ entfällt, weil die Playbooks Episoden, Breite und Latenz immer verlangen und der Brief OpenStack ausdrücklich als Quelle für Latenzverteilungen nennt. `rank_problems` geht als `rank: investigation_order` in `recurring_patterns` auf; weniger überlappende Tools erleichtern die Tool-Wahl.
- **Priorisierung (R-08, R-09, A-11, A-19, S-04, S-16):** Ausgangsreihenfolge nach Episoden und Breite statt nach Logzeilen, weil Ausbrüche einzelner Muster die Zeilenzahl aufblähen. Dominanzregel statt Score; Zielkonflikte werden benannt.
- **Antwortvertrag (6, 7, A-20):** gemeinsamer Rahmen plus rollenspezifischer Kern, damit sich die drei Antworten schon im Aufbau unterscheiden. Die Manager-Antwort hat keinen Hypothesenabschnitt.
- **Faktenprüfung (2.2, 7, A-13, A-14, S-08):** Tools vergeben Fakt-IDs; das Modell zitiert sie, statt JSON-Pointer mit Array-Indizes zu bilden. Die Gruppe ist im Claim Pflicht; nicht auflösbare Claims werden gezählt und angezeigt.
- **Rollenführung (6, A-37, S-14):** Die Playbooks greifen auch ohne Wahl eines Rollen-Prompts, über Server-Instruktionen und `describe_corpus`.
- **Diagnose (2.2, 6, A-17, A-22, A-36, R-07, R-11, S-15):** unterscheidende Prüfungen, die der Agent selbst ausführt, als Anforderung; Vorläuferanalyse über alle Episoden als Modus von `get_log_context`; neue Regel R-11.
- **Suche (A-05, A-30):** Phrasen- und Fuzzy-Suche sind P0 und Teil von A-05.
- **Eval (A-21):** mehr Fragen, Fragen ohne Prompt-Wahl, unabhängige Bewertung und eine Bestehensgrenze.
- **Web-App (A-26, A-38):** Darstellung nach Rollenkern; neuer Rollenvergleich (P1).
- **Bonus (4, A-32, A-33):** P2 beginnt nach M1. Index-Tools nur hinter Schalter; OTel-Daten über eine View für dieselben Tools.
- **Abgabe (A-24, 11):** zusätzlich ein englisches Abgabevideo von höchstens drei Minuten nach den Teilnahmeregeln; Live-Demo bleibt bei höchstens fünf Minuten.
- **Offene Punkte (12):** O-06 (5xx in OpenStack) und O-07 (BGL-Levels); Klärungszeitpunkte nach Arbeitsschritt statt nach Stunden.

### Version 3.2 (17.10.2026)

Architektur-Review vor Umsetzungsbeginn. Sprache, Repository-Struktur und Frameworks bleiben; drei Stellen werden vereinfacht, weil sie Risiko trugen, ohne zur Bewertung beizutragen. Details: [technical.md](technical.md) v2.2.

- **Receipts (A-13):** als JSON-Dateien statt in SereneDB. Tools bleiben rein lesend; ohne gespeicherten Receipt weiterhin kein Ergebnis.
- **Faktenprüfung (2.2, 7, A-14, S-08):** ein Prüfweg mit `check_claims` für MCP und Web. Die vollständige Textprüfung im Web entfällt; die Web-App markiert nur nicht eingereichte Referenzen.
- **Tools (3.1, 4, 6, A-09–A-12, A-15):** höchstens neun Tools. Der Periodenvergleich ist eine Option von `count_events`; A-10–A-12 sind P0 nur, wenn die gewählte Untersuchung sie braucht, sonst P1.

### Version 3.1 (17.10.2026)

Korrekturen nach einem Review des Konzepts vor Umsetzungsbeginn. Kennungen bleiben stabil; geändert sind Inhalte.

- **Faktenprüfung (A-14, 2.2, 7, S-08):** Der bisherige Abgleich „Zahl kommt irgendwo im Receipt vor“ hätte falsche Aussagen bestätigt, etwa `requests: 120` als „120 Fehler“. Zahlen sind jetzt an ein Ergebnisfeld gebunden; geprüft werden Wert, Kennzahl, Einheit, Gruppe und Umfang. Die Web-App rendert Zahlen aus Fakten; der MCP-Weg nennt nur die tatsächlich geprüften Claims.
- **Episoden (R-05, A-10):** berechnet über den vollständig gefilterten Umfang mit stabiler Reihenfolge. Vorberechnete globale Abstände hätten bei Node-Filtern Episoden übersehen; gleichzeitige erste Ereignisse hätten doppelt gezählt. Aktive Tage bzw. Wochen sind eine eigene Aussage.
- **Muster (R-04):** Nur veränderliche Kennungen und Werte werden maskiert; diagnostische Codes wie HTTP-Status bleiben erhalten.
- **Zähleinheiten (R-01, R-02, R-08, A-12):** Logereignisse, API-Zugriffe und Requests sind getrennt; im 2k-Sample haben 89 von 1.017 Zugriffszeilen keine Request-ID. 4xx heißt 400–499, nicht ≥ 400.
- **Receipts (A-13, A-27):** validierte Eingabe und Datenversion im Receipt; Re-run nutzt die Eingabe; ein Ergebnis ohne gespeicherten Receipt gilt nicht als belegt.
- **Meilensteine (4):** P0 in M1 (Kernablauf, H18), Ausbau (H30) und M2 (Abgabe, H42). Der alte Plan verlangte P0 vollständig bis H30, legte aber Eval und Abgabe danach.
- **Rollen (6, A-16, A-19, A-21, S-13):** Pflichtbelege und Entscheidungen statt Pflicht-Tools als Nachweis der Rollenunterschiede; Rubrik für die Empfehlungsqualität im Eval; getrennte Priorisierungsdimensionen für den Manager.
- **MCP-Prompts (7, A-15):** leiten an, erzwingen nicht. Konsistenz gilt für gleichen normalisierten Tool-Input auf derselben Datenversion (S-12).
- **Web-App (A-26):** strukturiert übernommener Umfang beim Rollenwechsel; eigene Zustände für gestoppte und Teilantworten; lokaler Betrieb mit Loopback-Bindung.
- **Demo und Fall (11):** Fall und Ersatzfall direkt nach dem Profiling; Gesamtprobe mit echten Modellwartezeiten, Ziel unter 4:30.

### Version 3.0 gegenüber 2.2

Version 3.0 richtet das Konzept an den veröffentlichten Anforderungen aus. Die bisherigen Annahmen – unbekannte Partnerdaten, Datenfreigaben, geschützter Jury-Arbeitsbereich, unbekannte Bewertungsmatrix – sind entfallen. Daraus folgen:

- **Agent:** Claude über MCP ist der primäre Agent; der Web-Chat nutzt dieselben Tools. Eigene Agenten-Laufzeit, Jobsystem, Laufbudget-Verwaltung und Rückfrage-Persistenz entfallen.
- **Rollen:** Rollen sind Playbooks mit eigenen Fragen, Belegen und Maßnahmen statt drei Ansichten desselben Befundsatzes.
- **Daten:** festes Basiskorpus BGL + OpenStack, eigene Ownership-Tabelle, Gesamtzählungen über das Korpus, Latenz und Fehlerrate für OpenStack.
- **Belege:** Query Receipts und Claim-Check ersetzen Faktenreferenzen, Validierungs- und Reparaturschleife.
- **Abgabe:** Demo bis fünf Minuten, Slides, ausgearbeitete Untersuchung, Tool-Dokumentation.

| Bereich (v2.2) | Verbleib in v3.0 |
|---|---|
| A-01–A-04 Datensatz, Qualität, Einstieg, Kontext | A-02, A-04, A-28 |
| A-05, A-06, A-43 Suche, Belege, Relevanz | A-05, A-06, A-27, A-30 |
| A-07–A-10, A-39–A-42 Gruppen, Wiederholung, Verlauf, Vergleich, Status, Zerlegung | A-08–A-10; R-04–R-06, R-10; Reihenfolge und Überlappung im Backlog |
| A-12–A-17 Fragen, Evidenz, Hypothesen, Empfehlungen | A-17–A-20, R-07; adaptive Hypothesenschleife als Teil der Playbooks, keine eigene Workflow-Engine |
| A-18–A-21 Rollen | A-17–A-19 mit neuer Rollenlogik |
| A-22–A-25, A-33 Lifecycle, Speichern, Aufbewahrung, Freigaben | entfallen (Backlog) |
| A-26, A-27 Fehlerzustände, Zugänglichkeit | A-26–A-29 und [ui-concept.md](ui-concept.md) |
| A-30–A-32 Korrektheit, SereneDB, Leistung | A-13, A-14, A-21 |
| A-34, A-35 Abnahme, Abgabe | A-21–A-24 |
| A-44, A-45 Übergabetext, Qualitätsansicht | Backlog; Eval-Ergebnis im README |
| A-11, A-24, A-28, A-29, A-36–A-38, A-46–A-48 | Backlog bzw. A-34 |
| S-01–S-15 | neue Abnahmefälle S-01–S-13 |

## Quellen

- Challenge-Brief „Making Sense of Logs: The Right Insights for the Right People“, National AI Hackathon 2026 (PDF, bereitgestellt am 17.10.2026)
- SereneDB „Getting started with SereneDB – Making Sense of Logs“ (PDF, bereitgestellt am 17.10.2026)
- [SereneDB-Dokumentation](https://serenedb.com/docs), Docs-MCP `https://api.serenedb.com/mcp`
- [Loghub](https://github.com/logpai/loghub) und [Zenodo-Datensätze](https://zenodo.org/records/8196385)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Teilnahmeregeln](https://schubki.com/legal/national-ai-hackathon-2026/rules)
