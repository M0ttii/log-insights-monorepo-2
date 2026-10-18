#import "theme.typ": *

// Known development case. The evidence is archived, not a live model answer.
#let deck = (
  title: "Log Insights - worked investigation",
  team: "Log Insights",
  draft: false,
  status: "KNOWN CASE / QUERY EVIDENCE",
)
#show: setup.with(deck)
#let claims = json("../submission/worked-investigation/claims.json").claims
#let source = "https://github.com/M0ttii/log-insights-monorepo-2/blob/main/submission/"
#let f(id, dark: false) = {
  let claim = claims.find(c => c.fact == id)
  assert(claim != none, message: "Fact missing from checked claim ledger: " + id)
  [#claim.value #text(size: 9.5pt, fill: if dark { palette.lilac } else { palette.muted })[#link(source + "evidence/" + id.split(".").first() + ".json", id)]]
}

#slide(deck, dark: true)[
  #label("Known development case", dark: true)
  #v(58pt)
  #text(size: 72pt, weight: "semibold", tracking: -2pt)[Log#text(fill: palette.lilac)[ Insights]]
  #v(24pt)
  #text(size: 30pt)[Control-stream failures\ during BGL job startup]
  #v(28pt)
  #text(size: 18pt, fill: palette.mist)[Engineer diagnosis / Team investigation / Manager allocation]
  #v(31pt)
  #note(dark: true)[Analyst-written walkthrough from real tool calls.\ No new Claude answer or quality-evaluation result.]
]

#slide(deck, section: "Approach and system", title: [Shared tools and evidence])[
  #grid(columns: (180pt, 32pt, 240pt, 32pt, 1fr), align: horizon,
    column("Clients", [*Claude Code / Desktop*\ MCP over stdio #v(14pt) *Web chat*\ AI SDK adapter]),
    text(size: 26pt, fill: palette.plum)[↔],
    block(fill: palette.light, inset: 19pt)[#label[Shared registry] #v(9pt) Zod contracts\ Parameterized SQL\ Limits and fact IDs],
    text(size: 26pt, fill: palette.plum)[↔],
    column("SereneDB", [*BGL + OpenStack*\ Separate systems #v(14pt) Search, counts, trends\ episodes and percentiles]),
  )
  #v(22pt) #rule() #v(14pt)
  #grid(columns: (1fr, 1fr, 1fr), gutter: 28pt,
    column("Retrieve", [#note[search_logs / get_log_context] #linebreak() Original bounded evidence.]),
    column("Aggregate", [#note[count_events / recurring_patterns] #linebreak() Counts over the stated population.]),
    column("Verify", [#note[check_claims] #linebreak() Submitted values, metrics and groups.]),
  )
  #evidence-strip[The database computes analytical values. Claude explains in the product. This capture invokes the same registry directly, without a model call.]
]

#slide(deck, section: "Query evidence", title: [Full populations, bounded original examples])[
  #grid(columns: (1fr, 1fr), gutter: 38pt,
    [#label[BGL / full loaded span] #v(8pt) #f("r_8f3bdd12.f4") log events],
    [#label[OpenStack / full loaded span] #v(8pt) #f("r_2c4302ad.f4") log events],
  )
  #v(18pt) #rule() #v(14pt)
  #grid(columns: (1fr, 1fr), gutter: 38pt,
    [
      #label[APPREAD / requested BGL window]
      #v(8pt)
      #f("r_bcd0408f.f3") events\
      #f("r_bcd0408f.f8") episodes
      #v(13pt)
      #text(size: 15pt, "ciod: failed to read message prefix on control stream (CioStream socket to 172.16.96.116:33399")
      #v(6pt)
      #note[Original event 14738 / search is truncated.]
    ],
    [
      #label[Independent OpenStack example]
      #v(8pt)
      #f("r_872d82bd.f8") 5xx accesses\ out of #f("r_872d82bd.f6") API accesses
      #v(13pt)
      #text(size: 15pt, "Bad response code while validating token: 503")
      #v(6pt)
      #note[Original event 10070743 / complete same-request context.]
    ],
  )
  #evidence-strip[APPREAD scope: #f("r_bcd0408f.f15") to #f("r_bcd0408f.f16"), end exclusive, UTC. OpenStack uses its own full span. No shared time axis.]
]

#slide(deck, section: "Role decisions", title: [Investigation changes with the role])[
  #grid(columns: (1fr, 1fr, 1fr), gutter: 30pt,
    [
      #label[Engineer] #v(10pt)
      #text(size: 25pt, weight: "semibold")[Locate the origin]
      #v(16pt)
      #f("r_bcd0408f.f12") emitting nodes.\
      Broad symptoms leave the initiating component open.
      #v(22pt)
      #action("Next check", [Match job-start inputs and filesystem availability.])
    ],
    [
      #label[Team Lead] #v(10pt)
      #text(size: 25pt, weight: "semibold")[Investigate recurrence]
      #v(16pt)
      Program-image errors:\ #f("r_8207d0e9.f16") episodes.\
      Previous-period trend is unavailable.
      #v(22pt)
      #action("Team check", [Workload Runtime reviews startup validation.])
    ],
    [
      #label[Manager] #v(10pt)
      #text(size: 25pt, weight: "semibold")[Allocate effort]
      #v(16pt)
      Team ranking favors program-image errors by episodes and breadth.
      #v(22pt)
      #action("Decision", [Prioritize the startup check over line volume alone.])
    ],
  )
  #evidence-strip[Same BGL window. Ownership is fictional. The team ranking is truncated but evaluates all candidates. Business impact unknown. These are analyst-written views, not client acceptance.]
]

#slide(deck, dark: true, section: "Executed discriminating check", title: [Inspect job-start inputs before network repair])[
  #grid(columns: (1fr, 1fr, 1fr), gutter: 32pt,
    column("Original assessment", [
      A systemic job/network event at the I/O nodes was suspected.
      #v(18pt)
      #note(dark: true)[Recorded before the original full-corpus profiling. Untested background.]
    ], dark: true),
    column("Executed precursor check", [
      Missing-directory errors precede\ #f("r_16d9e58b.f6", dark: true) of\ #f("r_16d9e58b.f1", dark: true) episode-start anchors.
      #v(18pt)
      #note(dark: true)[June-scoped background rate:\ #f("r_16d9e58b.f7", dark: true).]
    ], dark: true),
    column("Changed next step", [
      Check the working directory and program image at startup.
      #v(18pt)
      #note(dark: true)[Temporal association: supported.\ Initiating cause: open.\ No repair was performed.]
    ], dark: true),
  )
  #v(25pt)
  #evidence-strip(dark: true)[The context preserves an earlier chdir error on another node. Broad symptoms and temporal precursors do not prove a shared job, a network defect or causality.]
]

#slide(deck, section: "Limits and evidence", title: [What remains unknown])[
  #grid(columns: (1.15fr, 1fr), gutter: 42pt,
    [
      #label[Limits of this conclusion] #v(13pt)
      Initiating node, job boundaries and why the working directory was unavailable remain open.
      #v(16pt)
      No downtime, cost or customer effect is established. Episodes are not incidents.
      #v(16pt)
      Formal baseline and holdout evaluation are deferred. This known case makes no model-quality comparison.
    ],
    [
      #label[Reviewable artifacts] #v(12pt)
      #link(source + "worked-investigation.md")[English investigation]
      #v(18pt)
      #link(source + "worked-investigation/manifest.json")[Inputs, original receipts and hashes]
      #v(18pt)
      #link(source + "worked-investigation/claims.json")[Checked values and groups]
      #v(18pt)
      #note[Repository visibility and signed-out access still need verification.]
    ],
  )
  #evidence-strip[Known development/demo material. No claim of holdout performance, proven cause or complete role compliance. Original public log excerpts retain their Loghub attribution.]
]

#slide(deck, appendix: true, section: "Reproducible query", title: [Original SQL and a matching registry re-run])[
  #let manifest = json("../submission/worked-investigation/manifest.json")
  #let step = manifest.steps.find(s => s.step == "appread-search")
  #let receipt = json("../" + step.receipt)
  #grid(columns: (1.2fr, 1fr), gutter: 36pt,
    [
      #label[Exact executed phrase-count query] #v(12pt)
      #block(fill: palette.light, inset: 17pt)[#text(size: 13pt)[#raw(receipt.sql.at(2), lang: "sql")]]
      #v(10pt)
      #text(size: 12pt)[#raw("Bound parameters: " + repr(receipt.params.at(2)))]
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
  #evidence-strip[Exact SQL and parameters are read from the original receipt at build time. Data version: #receipt.data_version. Re-run invokes the registered tool with stored input, never stored SQL.]
]

#slide(deck, appendix: true, section: "Tool catalog", title: [The shared registry])[
  #grid(columns: (1fr, 1fr), gutter: 40pt,
    [
      #label[Find and inspect] #v(10pt)
      #tool-name[describe_corpus] #linebreak() #note[Population, fields, versions and capabilities] #v(13pt)
      #tool-name[search_logs] #linebreak() #note[Full-text query and bounded original hits] #v(13pt)
      #tool-name[get_log_context] #linebreak() #note[Event neighbours or precursor evidence] #v(13pt)
      #tool-name[check_claims] #linebreak() #note[Values, metrics and groups against fact IDs]
    ],
    [
      #label[Measure and compare] #v(10pt)
      #tool-name[count_events] #linebreak() #note[Grouped counts, shares and period comparison] #v(13pt)
      #tool-name[event_trend] #linebreak() #note[Buckets within a dataset span] #v(13pt)
      #tool-name[recurring_patterns] #linebreak() #note[Episodes, breadth and technical investigation order] #v(13pt)
      #tool-name[latency_stats] #linebreak() #note[OpenStack API-access percentiles and rates]
    ],
  )
  #evidence-strip[SereneDB computes analytical values. TypeScript validates contracts, assigns fact IDs, stores receipts and checks claims. The core tools do not change the corpus.]
]

#slide(deck, appendix: true, section: "Verification and limits", title: [Verified facts, bounded conclusions])[
  #grid(columns: (1fr, 1fr), gutter: 42pt,
    [
      #label[Observed in this capture] #v(13pt)
      All cited values were submitted to the shared claim checker, including their metric and group.
      #v(16pt)
      The saved batches report no mismatch or unresolved fact. This does not check explanations or prove causality.
      #v(16pt)
      The manifest retains successful registry re-run comparisons.
    ],
    [
      #label[Deferred optional evaluation] #v(13pt)
      Baseline versus playbooks, a first holdout and independent quality ratings have not run. No improvement in model quality is claimed.
      #v(16pt)
      End-to-end model latency, tokens and API costs were not measured here.
      #v(16pt)
      Historical database timings are separate receipt measurements, not a controlled model benchmark.
    ],
  )
  #evidence-strip[See submission/worked-investigation.md and submission/performance/. Archived query evidence does not establish autonomous answer quality or complete client compliance.]
]
