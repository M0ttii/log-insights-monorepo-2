#import "theme.typ": *

// Pitch deck around the worked investigation. Every figure is read at build
// time from the checked claim ledger or an original receipt; a missing fact
// stops compilation. Role views on slide 5 are analyst-written from real tool
// calls; slide 6 quotes actual Claude answers.
#let deck = (
  title: "Log Insights",
  team: "Log Insights",
  draft: false,
  status: "Every figure links to its original query receipt",
)
#show: setup.with(deck)

#let repo = "https://github.com/M0ttii/log-insights-monorepo-2"
#let source = repo + "/blob/main/submission/"
#let claims = json("../submission/worked-investigation/claims.json").claims
#let receipt(id) = json("../submission/evidence/" + id + ".json")

#let fid(id, dark: false) = text(size: 9.5pt, fill: if dark { palette.lilac } else { palette.muted })[
  #link(source + "evidence/" + id.split(".").first() + ".json", id)
]
#let val(id) = {
  let claim = claims.find(c => c.fact == id)
  assert(claim != none, message: "Fact missing from checked claim ledger: " + id)
  claim.value
}
#let f(id, dark: false) = [#val(id) #fid(id, dark: dark)]
// Facts outside the ledger, read from the original receipt (claim-check totals).
#let rf(id) = {
  let fact = receipt(id.split(".").first()).facts.find(x => x.id == id)
  assert(fact != none, message: "Fact missing from receipt: " + id)
  str(fact.value)
}
// Database round trips recorded in the receipt, rounded for display.
#let ms(id) = str(int(calc.round(receipt(id).duration_ms))) + " ms"
// Display grouping for integers read from JSON (no arithmetic on the value).
#let thousands(n) = {
  let digits = str(n).clusters().rev()
  digits.enumerate().map(((i, d)) => if i > 0 and calc.rem(i, 3) == 0 { d + "," } else { d }).rev().join()
}
#let stat(id, caption, dark: false, size: 40pt) = [
  #big(val(id), size: size, dark: dark)\
  #text(size: 14pt)[#caption] #fid(id, dark: dark)
]

// 1 ─────────────────────────────────────────────────────────────────────────
#slide(deck, dark: true)[
  #label("National AI Hackathon 2026 / SereneDB challenge", dark: true)
  #v(36pt)
  #text(size: 84pt, weight: "bold", tracking: -2.5pt)[Log#text(fill: palette.lilac)[ Insights]]
  #v(6pt)
  #text(size: 36pt, weight: "semibold", tracking: -0.6pt)[Every number has a receipt.]
  #v(14pt)
  #text(size: 19pt, fill: palette.mist)[Engineer, team lead and manager ask the same logs. SereneDB computes the evidence,\ Claude explains it, and each role leaves with its own decision.]
  #v(1fr)
  #grid(columns: (1fr, 1fr, 1fr), gutter: 24pt,
    stat("r_8f3bdd12.f4", "BGL log events, full span", dark: true),
    stat("r_2c4302ad.f4", "OpenStack log events, full span", dark: true),
    [#big("8 tools", dark: true)\ #text(size: 14pt)[one registry for MCP and web chat]],
  )
]

// 2 ─────────────────────────────────────────────────────────────────────────
#slide(deck, section: "Why not just chat with your logs?", title: [Chat over logs guesses. Log Insights measures.])[
  #let row(problem, answer) = (
    card(inset: 13pt, text(size: 15.5pt, fill: palette.muted, problem)),
    arrow(),
    card(inset: 13pt, fill: rgb("#f3efff"), text(size: 15.5pt, answer)),
  )
  #grid(columns: (1fr, 34pt, 1.35fr), row-gutter: 9pt, align: horizon,
    label[Typical chat over logs], [], label[Log Insights],
    ..row[Retrieves 50 lines and guesses how often an error happens.][*Frequencies come from SQL over the whole scope.* Search shows examples, aggregation counts, truncation is always stated.],
    ..row[The model adds, divides and ranks numbers itself.][*Every number cites a fact ID.* `check_claims` verifies value, metric and group against the stored receipt.],
    ..row[The manager gets a shorter engineer answer.][*Roles are playbooks.* They change the question, the evidence, the check and the next step.],
    ..row[A co-occurrence is sold as the root cause.][*Observation, hypothesis and cause stay apart.* Each hypothesis names the check that would decide it.],
  )
]

// 3 ─────────────────────────────────────────────────────────────────────────
#slide(deck, section: "SereneDB does the work", title: [From raw line to ranked priority, inside the database])[
  #let stage(n, name, body) = card(height: 168pt, inset: 14pt)[
    #text(size: 30pt, weight: "bold", fill: palette.violet)[#n]
    #h(6pt) #text(size: 19pt, weight: "semibold")[#name]
    #v(8pt)
    #text(size: 14.5pt, body)
  ]
  #grid(columns: (1fr, 22pt, 1fr, 22pt, 1fr, 22pt, 1fr),
    stage("1", "Parse")[`read_csv` + `regexp_extract` split raw lines in SQL. Rejects keep their reason: #f("r_45c7a4ec.f59") BGL lines.],
    arrow(height: 168pt),
    stage("2", "Normalize")[21 SQL pattern macros turn messages into templates. Diagnostic codes such as `status: 503` stay.],
    arrow(height: 168pt),
    stage("3", "Index")[ICU analyzer, inverted index, BM25 ranking and phrase positions from the index.],
    arrow(height: 168pt),
    stage("4", "Analyze")[`ts_phrase`, `ts_levenshtein`, `MATCH_RECOGNIZE` episodes, `quantile_cont`, window-function rankings.],
  )
  #v(16pt)
  #grid(columns: (1fr, 1fr), gutter: 30pt,
    [
      #label[What Claude receives]
      #v(8pt)
      Counts, shares, deltas, episodes, percentiles, rankings and rule outcomes, computed by SereneDB. Never raw rows to add up.
    ],
    [
      #label[Also native SereneDB]
      #v(8pt)
      Remote Parquet read in place over HTTPS, the built-in OTLP/HTTP listener, vector and hybrid search with RRF.
    ],
  )
  #evidence-strip[No parsing scripts and no client-side math. TypeScript validates inputs, assembles allowlisted SQL, assigns fact IDs and stores receipts. Function-by-function receipts: submission/serenedb-functions.md]
]

// 4 ─────────────────────────────────────────────────────────────────────────
#let precursor = receipt("r_16d9e58b")
#slide(deck, dark: true, section: "Worked investigation / BGL, June 2005", title: [Four queries changed the next step])[
  #card(dark: true, inset: (x: 16pt, y: 11pt))[
    #text(size: 17pt)[*Question:* Control streams fail during job start. Is one node broken, or the network?]
  ]
  #v(12pt)
  #let step(tool, time, body) = card(dark: true, height: 186pt, inset: 13pt)[
    #pill(tool, dark: true) #h(1fr) #text(size: 11pt, fill: palette.mist)[#time]
    #v(9pt)
    #body
  ]
  #grid(columns: (1fr, 18pt, 1fr, 18pt, 1fr, 18pt, 1fr),
    step("search_logs", ms("r_b63b6c6e"))[
      #big(val("r_b63b6c6e.f4"), size: 36pt, dark: true)\
      #text(size: 14pt)[exact matches for the phrase "failed to read message prefix"]
      #v(4pt)
      #note(dark: true)[Hits truncated, count exact] #fid("r_b63b6c6e.f4", dark: true)
    ],
    arrow(dark: true, height: 186pt),
    step("recurring_patterns", ms("r_bcd0408f"))[
      #big(val("r_bcd0408f.f8") + " episodes", size: 30pt, dark: true)\
      #text(size: 14pt)[on #val("r_bcd0408f.f12") nodes in #val("r_bcd0408f.f13") racks. *Not one node.*]
      #v(6pt)
      #fid("r_bcd0408f.f8", dark: true) #fid("r_bcd0408f.f12", dark: true) #fid("r_bcd0408f.f13", dark: true)
    ],
    arrow(dark: true, height: 186pt),
    step("get_log_context", ms("r_b6ce5f6c"))[
      #big(val("r_b6ce5f6c.f8") + " ms", size: 26pt, dark: true)\
      #text(size: 13pt)[before the first failure, on another node:]
      #v(4pt)
      #text(size: 10.5pt, fill: palette.mist, raw("ciod: LOGIN chdir(/p/gb2/draeger/benchmark/dat32k_060205) failed: No such file or directory"))
      #v(4pt)
      #fid("r_b6ce5f6c.f8", dark: true)
    ],
    arrow(dark: true, height: 186pt),
    step("context aggregate", ms("r_16d9e58b"))[
      #big(val("r_16d9e58b.f6") + " of " + val("r_16d9e58b.f1"), size: 36pt, dark: true)\
      #text(size: 13.5pt)[episode starts follow that chdir error within #precursor.input.window_minutes min. Background: #val("r_16d9e58b.f8") of #val("r_16d9e58b.f4") windows.]
      #v(4pt)
      #text(size: 14pt, weight: "semibold")[Ratio #val("r_16d9e58b.f9")] #fid("r_16d9e58b.f9", dark: true)
    ],
  )
  #v(12pt)
  #grid(columns: (1fr, 1.45fr), gutter: 22pt,
    [
      #note(dark: true)[Recorded before the check]\
      #text(size: 15pt)[Systemic job/network event at the I/O nodes]
      #v(4pt)
      #pill("one node: contradicted", dark: true) #h(4pt) #pill("cause: open", dark: true)
    ],
    [
      #note(dark: true)[Next step after the check]\
      #text(size: 17pt, weight: "semibold", fill: palette.lilac)[Check working directory and program image at job start before any network repair.]
      #v(4pt)
      #pill("temporal association: supported, not proven", dark: true)
    ],
  )
]

// 5 ─────────────────────────────────────────────────────────────────────────
#slide(deck, section: "Role-appropriate insight", title: [Same case. Three roles. Three different decisions.])[
  #let role(name, question, evidence, decision) = card(height: 306pt, inset: 16pt)[
    #label(name)
    #v(6pt)
    #text(size: 20pt, weight: "semibold")[#question]
    #v(10pt)
    #text(size: 14.5pt, evidence)
    #v(1fr)
    #label[Decision]
    #v(5pt)
    #text(size: 17pt, weight: "semibold", fill: palette.plum, decision)
  ]
  #grid(columns: (1fr, 1fr, 1fr), gutter: 20pt,
    role("Engineer", [Is one node at fault?],
      [Symptoms on #f("r_bcd0408f.f12") nodes. A missing working directory precedes #val("r_16d9e58b.f6") of #val("r_16d9e58b.f1") episode starts #fid("r_16d9e58b.f6"). Initiating component: open.],
      [Match job-start directory and filesystem availability to the failing streams.]),
    role("Team lead", [What keeps recurring?],
      [Program-image load errors: #f("r_8207d0e9.f16") episodes on #f("r_8207d0e9.f13") active days. Prior month is outside the BGL span: no growth claimed.],
      [Workload Runtime reviews program-image and directory validation at startup.]),
    role("Manager", [What gets effort first?],
      [Line volume points to control-stream errors: #f("r_8207d0e9.f11") events. Episodes point to program-image errors: #f("r_8207d0e9.f9") versus #f("r_8207d0e9.f38").],
      [Fund a bounded job-start check, not the loudest pattern. Business impact: unknown.]),
  )
  #evidence-strip[Analyst-written views from the real tool calls on slide 4. SereneDB ranks all #val("r_8207d0e9.f4") candidates by episodes, then breadth; no risk score. Ownership is fictional.]
]

// 6 ─────────────────────────────────────────────────────────────────────────
#slide(deck, section: "The agent in action", title: [Claude answers live through MCP, with citations])[
  #let quotes = json("walkthrough/quotes.json")
  #grid(columns: (1fr, 1fr, 1fr), gutter: 20pt, ..quotes.map(q => card(height: 312pt, inset: 15pt)[
    #label(q.role)
    #v(2pt)
    #text(size: 11.5pt, fill: palette.muted, q.client)
    #v(8pt)
    #text(size: 17pt, weight: "bold", fill: palette.plum, q.evidence)
    #v(8pt)
    #text(size: 13.5pt)["#q.text"]
    #v(1fr)
    #label[Next step]
    #v(4pt)
    #text(size: 13.5pt, weight: "semibold", q.next)
  ]))
  #evidence-strip[Original answer excerpts, unedited, from Claude Desktop and Claude Code with Opus 5.5. Complete answers, tool traces and receipts: submission/agent-examples/]
]

// 7 ─────────────────────────────────────────────────────────────────────────
#let probe = json("../submission/log-41/verification.json").records.first().discriminating_check.claims
#let reruns = json("../submission/worked-investigation/manifest.json").reruns
#slide(deck, section: "Show the work", title: [Don't trust the model. Open the receipt.])[
  #grid(columns: (1.2fr, 1fr), gutter: 24pt,
    card(inset: 15pt, height: 330pt)[
      #grid(columns: (auto, 1fr), column-gutter: 12pt, row-gutter: 7pt,
        text(size: 13pt, fill: palette.muted)[Receipt], text(size: 13pt, weight: "semibold", link(source + "evidence/r_16d9e58b.json", precursor.receipt_id + " / " + precursor.tool + " " + precursor.tool_version)),
        text(size: 13pt, fill: palette.muted)[Agent input], text(size: 10.5pt, raw(precursor.input.pairs().map(((k, v)) => k + ": " + str(v)).join(", "))),
        text(size: 13pt, fill: palette.muted)[Scope], text(size: 13pt)[#thousands(precursor.population.count) #precursor.population.unit.replace("_", " ") / truncated: #precursor.truncated],
        text(size: 13pt, fill: palette.muted)[Data version], text(size: 10pt, raw(precursor.data_version)),
        text(size: 13pt, fill: palette.muted)[Result digest], text(size: 10pt, raw(precursor.result_digest.slice(0, 32) + "…")),
        text(size: 13pt, fill: palette.muted)[Database], text(size: 13pt)[#ms("r_16d9e58b") over #precursor.sql.len() statements],
      )
      #v(10pt)
      #label[Executed SQL, statement #precursor.sql.len() of #precursor.sql.len() (excerpt)]
      #v(6pt)
      #let sql = precursor.sql.last()
      #block(fill: palette.paper, inset: 10pt, radius: 6pt, width: 100%)[
        #text(size: 9.5pt, raw(sql.slice(0, sql.position(", ranked AS")) + " …", lang: "sql"))
      ]
    ],
    [
      #card(inset: 14pt)[
        #label[check_claims catches a wrong number]
        #v(8pt)
        #for c in probe [
          #text(size: 14pt)[Claim: #thousands(c.claim.value) request IDs #h(1fr) #text(weight: "bold", fill: if c.status == "verified" { palette.plum } else { rgb("#b3261e") }, upper(c.status))]\
        ]
        #note[Fact #probe.first().claim.fact, request IDs over the full OpenStack span]
      ]
      #v(10pt)
      #card(inset: 14pt)[
        #label[Worked case]
        #v(8pt)
        #text(size: 14pt)[Cited values verified in three batches: #rf("r_0f3a6bca.f4"), #rf("r_a2f57065.f4"), #rf("r_51762d3b.f4"). Mismatches: #rf("r_0f3a6bca.f2"), #rf("r_a2f57065.f2"), #rf("r_51762d3b.f2"). Unresolved: #rf("r_0f3a6bca.f3"), #rf("r_a2f57065.f3"), #rf("r_51762d3b.f3").]
      ]
      #v(10pt)
      #card(inset: 14pt)[
        #label[Re-run]
        #v(8pt)
        #let same = reruns.filter(r => r.matches.signature and r.matches.data_version and r.matches.result_digest)
        #text(size: 14pt)[#same.len() of #reruns.len() registry re-runs return the same signature, data version and result digest.]
      ]
    ],
  )
  #evidence-strip[The agent sends validated parameters, never SQL. A re-run executes the registered tool with the stored input, not the stored SQL.]
]

// 8 ─────────────────────────────────────────────────────────────────────────
#slide(deck, section: "Execution and special awards", title: [Runs from a clean clone. Scales past the brief.])[
  #grid(columns: (1.15fr, 1fr), gutter: 24pt,
    [
      #block(radius: 6pt, clip: true, stroke: 0.7pt + palette.line, image("assets/web-ask.png", width: 100%))
      #v(10pt)
      #block(fill: palette.light, inset: 11pt, radius: 6pt, width: 100%)[
        #text(size: 10pt, raw(lang: "bash", "git clone --recurse-submodules " + repo + ".git\ncp .env.jury.example .env   # set password and API key\ndocker compose up            # download, verify, load, serve :3000"))
      ]
    ],
    [
      #card(inset: 14pt)[
        #label[Best MCP server]
        #v(7pt)
        #text(size: 14.5pt)[8 tools over stdio for Claude Desktop and Claude Code, one Docker command. Zod contracts state units, limits and truncation; errors return a correction hint, never a silent zero.]
      ]
      #v(10pt)
      #card(inset: 14pt)[
        #label[Huge datasets]
        #v(7pt)
        #text(size: 14.5pt)[OpenTelemetry Parquet read in place over HTTPS, never downloaded. A 60-second window:]
        #v(4pt)
        #big("32,605,195 rows", size: 26pt)
        #v(2pt)
        #text(size: 13pt)[54 of 1,624 row groups / 69.8 MiB fetched / 1.79 s wall]
        #v(4pt)
        #note[Plus five Loghub extensions and a bounded OTLP replay through SereneDB's own listener. Single local observation, 18 Oct 2026; README.]
      ]
    ],
  )
]

// 9 ─────────────────────────────────────────────────────────────────────────
#slide(deck, dark: true)[
  #label("Log Insights", dark: true)
  #v(30pt)
  #text(size: 46pt, weight: "bold", tracking: -1.5pt)[Question #text(fill: palette.lilac)[→] evidence #text(fill: palette.lilac)[→] recommendation.]
  #v(34pt)
  #grid(columns: (1fr, 1fr, 1fr), gutter: 30pt,
    [#big("SereneDB", size: 28pt, dark: true)\ #text(size: 16pt)[parses, searches, counts, forms episodes and ranks. The model never computes.]],
    [#big("Receipts", size: 28pt, dark: true)\ #text(size: 16pt)[for every number: input, SQL, scope, truncation, digest, re-run.]],
    [#big("Roles", size: 28pt, dark: true)\ #text(size: 16pt)[change the question, the evidence and the decision, not the length.]],
  )
  #v(1fr)
  #text(size: 20pt, weight: "semibold")[#link(repo)[github.com/M0ttii/log-insights-monorepo-2]]
  #v(4pt)
  #note(dark: true)[README: setup, tool contracts, MCP connection and limits / submission/: worked investigation, receipts, Claude answers]
]

// RESERVE SLIDES. Keep available for jury questions.

#slide(deck, appendix: true, section: "Reproducible query", title: [Original SQL and a matching registry re-run])[
  #let manifest = json("../submission/worked-investigation/manifest.json")
  #let step = manifest.steps.find(s => s.step == "appread-search")
  #let search = json("../" + step.receipt)
  #grid(columns: (1.2fr, 1fr), gutter: 36pt,
    [
      #label[Exact executed phrase-count query] #v(12pt)
      #block(fill: palette.light, inset: 17pt, radius: 6pt)[#text(size: 13pt)[#raw(search.sql.at(2), lang: "sql")]]
      #v(10pt)
      #text(size: 12pt)[#raw("Bound parameters: " + repr(search.params.at(2)))]
    ],
    [
      #label[Tool and result] #v(10pt)
      #tool-name[search_logs] #linebreak()
      #text(size: 14pt)[dataset: bgl / match: phrase]
      #v(15pt)
      #f("r_b63b6c6e.f4") exact matches\ Bounded hits are returned separately.
      #v(17pt)
      #note[Registry re-runs for the precursor, team-priority and OpenStack latency calls match signature, data version and result digest.]
    ],
  )
  #evidence-strip[Exact SQL and parameters are read from the original receipt at build time. Data version: #search.data_version. Re-run invokes the registered tool with stored input, never stored SQL.]
]

#slide(deck, appendix: true, section: "Tool catalog", title: [Eight tools the agent can choose from])[
  #grid(columns: (1fr, 1fr), gutter: 40pt,
    [
      #label[Find and inspect] #v(10pt)
      #tool-name[describe_corpus] #linebreak() #note[Population, fields, versions, capabilities and role guidance] #v(13pt)
      #tool-name[search_logs] #linebreak() #note[Terms, phrase, fuzzy; UTC window, filters, limit / bounded hits plus exact total] #v(13pt)
      #tool-name[get_log_context] #linebreak() #note[Event neighbours, or aggregate precursors with base rate and ratio] #v(13pt)
      #tool-name[check_claims] #linebreak() #note[Value, metric and group against a fact ID / verified, mismatch, unresolved]
    ],
    [
      #label[Measure and compare] #v(10pt)
      #tool-name[count_events] #linebreak() #note[Grouped counts, shares, rest group; period comparison with R-06 class] #v(13pt)
      #tool-name[event_trend] #linebreak() #note[UTC bucket grid within one dataset's span; outside the span is not zero] #v(13pt)
      #tool-name[recurring_patterns] #linebreak() #note[Episodes, breadth, recurrence status, investigation order and dominance] #v(13pt)
      #tool-name[latency_stats] #linebreak() #note[OpenStack API-access percentiles, 4xx/5xx rates over a named denominator]
    ],
  )
  #evidence-strip[Every output carries facts, a receipt ID, the row limit and a truncated flag. Unsupported dataset/function combinations return invalid_input with a hint. Full contracts: README, Tools.]
]

#slide(deck, appendix: true, section: "Limits we state on purpose", title: [What the evidence does not establish])[
  #grid(columns: (1fr, 1fr), gutter: 42pt,
    [
      #label[In this case] #v(13pt)
      Initiating node, job boundaries and why the working directory was unavailable remain open. The precursor is a temporal association, not a cause.
      #v(16pt)
      Episodes are not incidents. No downtime, cost or customer effect is established. Ownership is fictional.
    ],
    [
      #label[In the evaluation] #v(13pt)
      The role views on slide 5 are analyst-written from real tool calls; slide 6 shows selected real Claude answers. Neither is a blinded benchmark.
      #v(16pt)
      Database timings are recorded receipt round trips, not end-to-end model latency. Formal baseline and holdout runs are deferred.
    ],
  )
  #evidence-strip[See submission/minimum-scope.md and submission/worked-investigation.md. Original Loghub excerpts keep their attribution (CC BY 4.0).]
]
