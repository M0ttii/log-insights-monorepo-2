# Audit der Entwicklungsfragen · LOG-52

Stand: 18.10.2026. Geprüft wurde die bestehende Fragenbank gegen
`technical.md` § 13.1–13.3, `concept.md` A-21/A-37, R-07/R-11 und die
Abnahmefälle. Das Audit erzeugt keine neuen Korpuszahlen und wertet keine
neuen Modellantworten aus. Es ändert weder Playbooks noch die Bestehensgrenze.
Alle 14 Fragen sind bekannt und bleiben Entwicklung bzw. Regression. Es wurden
keine Holdout-Fragen erstellt oder eingesehen.

## Rollen und Abdeckung

Version 2 unterscheidet `role_answer` und `routing_control`. `role: null`
bedeutet einen Aufruf ohne Rollen-Prompt; `effective_role` ist ausschließlich
Bewertungsmetadatum für die erwartete Erkennung. Bei der unklaren Kontrollfrage
bleibt auch `effective_role` null. Diese Felder, Pflichtbelege, Prüfungen,
Referenzen und erlaubten Tool-Folgen dürfen dem antwortenden Agenten nicht
als Zusatzanweisung zugespielt werden.

| Rolle | Explizite Entwicklungsfragen | Ohne Rollen-Prompt |
| --- | --- | --- |
| Engineer | `dev-eng-01`, `dev-eng-02`, `dev-eng-03`, `dev-eng-05` | `dev-eng-04` |
| Team Lead | `dev-tl-01`, `dev-tl-02`, `dev-tl-03` | `dev-tl-04` |
| Manager | `dev-mgr-01`, `dev-mgr-02`, `dev-mgr-03` | `dev-mgr-04` |

Damit hat jede Rolle mindestens drei explizite Fragen und zusätzlich eine
Frage ohne Prompt-Wahl. Die übrige Frage `dev-clarify-01` prüft eine Rückfrage
vor jeder analytischen Empfehlung. Sie ist keine Rollenantwort und darf weder
den Rollenmittelwert verbessern noch fehlende Rollenantworten ersetzen.

`dev-eng-04` wechselt in dieser Version von explizitem Engineer-Aufruf zum
Aufruf ohne Rollen-Prompt. Die diagnostische Frage nach einer bestimmten
Fehlermeldung und Komponente liefert den Engineer-Kontext. Die Bewertung
prüft zusätzlich die erkannte Rolle. Frühere Aufrufe behalten ihre damalige
Metadatenversion; die vier Demo-Kennzeichen und deren Rollen bleiben erhalten.

| Fall | Frage | Zu prüfender Nachweis |
| --- | --- | --- |
| S-06 | `dev-eng-03` | Suchlimit 50, exakte Gesamtzahl, tatsächliche Kürzung; Häufigkeit aus Aggregation statt Suchbeispielen |
| S-07 | `dev-eng-04` | Tatsächlich leere Suche im genannten Umfang und ausdrückliche Grenze |
| S-10 | `dev-mgr-02` | Messbare Häufigkeit/Breite; Kosten, Ausfallzeit und Kundeneffekt unbekannt |
| S-14 | `dev-eng-04`, `dev-tl-04`, `dev-mgr-04`, `dev-clarify-01` | Jede Rolle ohne Prompt-Wahl und Rückfrage bei unklarer Perspektive |
| S-15 | `dev-eng-01`, `dev-eng-02` | Ausgeführte unterscheidende Prüfung, logisch begründeter Status mit Prüffakten, kein Ursachenbeweis aus Vorläufern |
| S-16 | `dev-mgr-01` | Ereignisvolumen gegen Untersuchungsreihenfolge, tatsächlich gültige Rangbasis und benannter Zielkonflikt |

Die Bank legt die Fälle fest, ihre historischen Zahlen beweisen deren
heutige Ausübung nicht. Liefert der geprüfte Datenstand etwa höchstens 50
Parity-Treffer, Treffer für die erwartete Leersuche oder keinen S-16-Kontrast,
muss der Lauf diesen Abnahmefall als nicht ausgeübt ausweisen. Eine belegte
Antwort auf eine veränderte Datenlage ist kein Ersatz für diesen Fallnachweis.

## Historische Referenzen und unabhängige Belege

`reference_data_version: dv_263e378cd8560c4a` bezeichnet ausschließlich die
übernommenen Profiling-Anmerkungen. `reference_status: historical_unverified`
heißt: Die Herkunft ist nachvollzogen, die Zahlen wurden in diesem Audit weder
erneut gerechnet noch gegen den aktuellen Datenstand verifiziert. Dieser Wert
ist keine gewünschte oder automatisch erkannte Lauf-Datenversion.

Die ursprüngliche Bank wurde in Commit
`a72f40f336aa4a3bfece96e5490469588c7927f5` angelegt. Die in
`reference_provenance` mit `Commit:Pfad` festgehaltenen SQL-Dateien stimmen
zwischen diesem Commit und dem Audit-Ausgangsstand `9f988f9` überein. Die
Commit-Pins sichern die historischen Texte; sie ersetzen keine damaligen
Ergebnisdateien oder heutigen Receipts. Insbesondere enthalten diese alten
Profiling-Abfragen noch damalige Sichten wie `component_teams` und sind keine
Anweisung, sie unverändert auf dem heutigen Schema auszuführen.

| Referenz in der Frage | Historische Herkunft | Begrenzung der Annotation |
| --- | --- | --- |
| `dev-eng-01` | `80_cases.sql`: APPREAD-Kategorien, Episoden, Vorläuferskizze, chdir je Episode und abschließende Juni-Breite | Episoden und Vorläufergrundrate stammen aus einer Vollkorpus-Skizze; die Juni-Breite allein belegt keine Streuung pro Episode oder Gleichzeitigkeit. Die alte Grundrate ist kein Sollwert für einen Juni-Receipt. |
| `dev-eng-02` | `80_cases.sql`: KERNDTLB-Episoden; `40_episodes.sql`: Sensitivität je Muster | Vollspannenzahlen und größte Episode sind historische Orientierung; Konzentration und wiederkehrende Beobachtungen sind im jeweiligen Lauf gesondert zu belegen. |
| `dev-eng-03` | `80_cases.sql`: abschließende Entwicklungsreferenz für die Parity-Volltextsuche | Die alte Trefferzahl ist weder eine Fehlerzahl noch ein Erwartungswert für die aktuelle Suchkonfiguration. |
| `dev-eng-04` | Ursprüngliches `dev.yaml`: `matches: 0` | In den geprüften Profiling-SQL-Dateien fehlt eine spezifische reproduzierbare Abfrage für diese Leersuche. Die Null bleibt ausdrücklich ungeprüfte Historie. |
| `dev-eng-05` | `20_http.sql`: Vollspannenverteilung und 5xx-Zeilen; `80_cases.sql`: 5xx-Umgebung und Stundenlatenz | Die API-Gesamtzahlen beziehen sich auf die volle OpenStack-Spanne, nicht auf die angefragte Stunde. Eine Request-ID ist ein Suchhinweis; seine Umgebung und jede weitere Tagesbehauptung brauchen eigene Receipts. |
| `dev-tl-03` | Ursprüngliches `dev.yaml`; `40_episodes.sql`: Muster und Abstände | Die Annotation zu Durchläufen ist keine belegte Zuordnung zwischen verschiedenen Traceback-Mustern. Gleiche Episodenzahlen beweisen diese Zuordnung nicht. |
| `dev-mgr-01` | `80_cases.sql`: S-16, Rang nach Ereignissen gegen Rang nach Episoden; `50_breadth.sql`: Feldabdeckung | Der historische Episodenrang ist kein heutiger Rang der technischen Untersuchungsreihenfolge. Fehlende Breite wird über alle Kandidaten geprüft. |

Unabhängige Golden-Quellen wurden zur Prüfung der fachlichen Belegwege gelesen:

- `packages/analytics/tests/golden/search-and-claims.test.ts` zählt Suchtreffer
  unabhängig über Rohmeldungs-Prädikate und prüft Limit, Leersuche und Kürzung.
  Dessen S-07-Fall nutzt einen anderen Suchbegriff und validiert daher nicht
  die historische Null von `dev-eng-04`.
- `packages/analytics/tests/golden/get-log-context-aggregate.sql` bildet
  Episodenanfänge unabhängig per Anti-Join und grenzt die Grundrate nach dem
  angefragten Umfang ab. `get-log-context.test.ts` vergleicht Anker,
  Grundratenraster, Anteile und Kürzung gegen diese Abfrage.
- `packages/analytics/tests/golden/recurring-patterns.sql` und
  `recurring-patterns.test.ts` prüfen Episoden, Rangbasis und den echten
  S-16-Kontrast unabhängig von den Tool-Abfragen.
- `packages/analytics/tests/golden/count-events.test.ts` trennt Zähleinheiten,
  fehlende Dimensionen, gruppierte Summen und den unaufgelisteten Rest.

Diese Dateien sind Belegwege und Testorakel, keine in diesem Audit neu
ausgeführten Korpusmessungen. Erwartungen wurden nicht aus der SQL-Umsetzung
der Tools oder aus ungeprüften Modellantworten abgeleitet. Die Tool-Verträge
wurden nur auf verfügbare Eingaben und Dimensionen geprüft.

## Korrektur der Erwartungen

| Frage | Ergebnis der Prüfung |
| --- | --- |
| `dev-clarify-01` | Bleibt eine mehrdeutige Routingkontrolle ohne analytische Empfehlung und ohne Rollenzuordnung. |
| `dev-eng-01` | Breite Symptome widerlegen nur eine notwendige Annahme über Symptombegrenzung. Ein einzelner gemeinsam genutzter auslösender Ursprung bleibt ohne eigene widerlegende Prüfung offen. Juni-Anker, Grundrate und Fenster müssen zum ausgeführten Receipt passen. Ein Vorläuferverhältnis beweist keine Ursache; Summen je Vorläufer erlauben keine Zuordnung zum gleichen oder fehlenden Anker. Das gilt auch für Einleitung und Folgecheck. |
| `dev-eng-02` | Die Frage setzt den historischen Häufigkeitsrang nicht mehr als Tatsache voraus. Konzentration braucht Gesamtzahl und Rest, Episodenaussagen ihren eigenen Umfang. Die Erwartung behauptet keine vorab feststehende lokale Ursache. |
| `dev-eng-03` | Muster und Level müssen vor einer Fehler- oder Mehrheitsaussage aggregiert werden. INFO- oder korrigierte Meldungen werden nach tatsächlichem Befund eingeordnet. |
| `dev-eng-04` | Engineer-Erkennung wird ohne Prompt geprüft. Die Leersuche ist ein auszuführender Nachweis, keine festgeschriebene historische Null. Zahlen werden gegebenenfalls mit `check_claims` geprüft. |
| `dev-eng-05` | Request-Kontext, API-Population und Vergleichszeitraum bleiben getrennt. Zeitliche Nähe und wiederholte Sequenzen beweisen keine Ursache im Identity-Dienst. |
| `dev-tl-01` | Beibehaltung: Wiederkehrend bedeutet mindestens zwei Episoden, nicht viele Zeilen; Team, Trend und Untersuchungsschritt gehören zur Frage. |
| `dev-tl-02` | Beibehaltung: Gleich lange Vergleichszeiträume und R-06/R-10, einschließlich nicht bestimmbarer Referenz und erstem Auftreten. |
| `dev-tl-03` | Gleiche Episodenzahlen reichen nicht zum Zusammenführen von Tracebacks. Kontext kann den Zusammenhang prüfen; andernfalls bleibt er offen. Zusätzliche zulässige Tool-Folge für diesen Kontextcheck. |
| `dev-tl-04` | Beibehaltung: Team-Lead-Erkennung ohne Prompt sowie wiederkehrend gegen einmalig; `effective_role` macht die Zuordnung explizit. |
| `dev-mgr-01` | S-16 wird mit den aktuellen Rangbelegen geprüft. Ein Kandidat mit fehlender Breiteneinheit auf nur einem Ereignis reicht für den Wegfall des Kriteriums in der gesamten Rangfolge. Kein historischer Rang als Sollwert. |
| `dev-mgr-02` | Beibehaltung: Keine Ableitung von Geschäftsauswirkungen aus Korpusmetriken. |
| `dev-mgr-03` | Beibehaltung: Getrennte Vollspannen je Datensatz und `unowned`, keine gemeinsame Zeitachse. |
| `dev-mgr-04` | Manager-Erkennung ohne Prompt bleibt. Die Erwartung folgt der tatsächlich zurückgegebenen Kandidatenabdeckung und hält Zähler/Nenner der API-Rate getrennt. |

Die erlaubten Tool-Folgen beschreiben Produktprüfungen der vollständigen
Playbooks. Sie geben der Baseline keinen inhaltlichen Qualitätsbonus und
erlauben keine erfundenen Ergebnisse. Gemeinsame Vorläufe, zusätzliche sachlich
nötige Prüfungen und Claim-Batches werden anhand des tatsächlichen Traces
bewertet; eine Tool-Namensliste allein beweist weder den Modus noch den Umfang
oder die Reihenfolge einer ausgeführten Prüfung.

## Bereits bekannte S-15-Ergebnisse

Die gespeicherte Kriterienkorrektur
`packages/evals/results/s15-2026-10-18/criterion-audit.json` ist für
`dev-eng-01` maßgeblich: Eine positive Vorläuferbeobachtung entschuldigt keinen
unbegründeten `contradicted`-Status der konkurrierenden kausalen Erklärung.
Das ursprüngliche Audit sowie die erste und zweite Fehlrunde bleiben erhalten.
Die dritte Runde unter `s15-2026-10-18-r3/` dokumentiert außerdem, dass ein
anderer Vorläufer im vorgeschlagenen Folgecheck keinen weiteren Auslöser
beweist. `s15-2026-10-18-r4/assessment.json` klassifiziert den technischen
Fehlversuch getrennt als nicht bewertbar.

`s15-2026-10-18-r5/report.json` und die unabhängige Bewertung dokumentieren
den fokussierten S-15-Nachweis mit Guidance 1.0.5, Vertrag 2.9.0 und Datenstand
`dv_7ea6fcb2c9eb6882`. Die dort erhaltenen übrigen Mängel betreffen unter
anderem Scope/Null-Buckets, unvollständige Zahlenprüfung und eine aus
Aggregatsummen nicht belegte LINKCARD/chdir-Ankerzuordnung. Diese Runde ist
bekannte Regression; sie validiert weder die alten Referenzen der Datenversion
`dv_263e378cd8560c4a` noch die gesamte Fragenbank, Baseline, Holdout oder
vollständige U16-Abnahme. Die Artefakte und ihre Versionsangaben bleiben
unverändert.

## Verifikation und verbleibende Nachweise

Die YAML-Struktur, eindeutigen IDs, Rollenabdeckung und Metadaten werden mit
den Loader- und Fragenbanktests von LOG-52 geprüft. Das Audit selbst erfordert
keinen neuen Datenbanktest: Es ändert weder SQL noch Laufzeitverhalten und
behauptet keine erneut validierten Korpuszahlen. Neue bezahlte Modellläufe,
Profiling-Läufe und Datenbankänderungen wurden nicht ausgeführt.

Offen für die folgenden Tickets bleiben die tatsächlichen vollständigen
Dev-Versuche und unabhängigen Bewertungen, menschliche Stichprobe,
Konfigurations-Freeze mit frischen geschützten Holdouts und die separaten
Client-/S-13-Nachweise. Weder die strukturelle Abdeckung der Bank noch dieses
Audit erklärt diese Nachweise für bestanden.
