#import "settings.typ": deck
#import "theme.typ": *

#show: setup.with(deck)
#let fill(body, dark: false) = slot(body, draft: deck.draft, dark: dark)

// Six main slides. SQL, the full tool catalog and evaluation follow as reserves.

#slide(deck, dark: true)[
  #label(deck.event, dark: true)
  #v(64pt)
  #text(size: 76pt, weight: "semibold", tracking: -2pt)[Log#text(fill: palette.lilac)[ Insights]]
  #v(13pt)
  #text(size: 30pt)[The right insights\ for the right people]
  #v(32pt)
  #text(size: 18pt, fill: palette.mist)[Questions, query evidence and recommendations]
  #v(43pt)
  #text(size: 14pt)[#if deck.team == none { fill("Team name / presenters", dark: true) } else { deck.team } / #deck.date]
]

#slide(deck, section: "Approach and system", title: [SereneDB computes. Claude explains.])[
  #grid(columns: (180pt, 32pt, 240pt, 32pt, 1fr), align: horizon,
    column("Clients", [
      *Claude Code / Desktop*\ MCP over stdio
      #v(14pt)
      *Web chat*\ AI SDK adapter
    ]),
    text(size: 26pt, fill: palette.plum)[↔],
    block(fill: palette.light, inset: 19pt)[
      #label[Shared tool registry]
      #v(9pt)
      Zod contracts\ Parameterized SQL\ Limits and fact IDs
    ],
    text(size: 26pt, fill: palette.plum)[↔],
    column("SereneDB", [
      *BGL + OpenStack*\ Search and aggregation
      #v(14pt)
      Counts, trends, episodes\ and percentiles
    ]),
  )
  #v(22pt)
  #rule()
  #v(14pt)
  #grid(columns: (1fr, 1fr, 1fr), gutter: 28pt,
    column("Retrieve", [#note[search_logs / get_log_context] #linebreak() Limited hits and nearby events.]),
    column("Aggregate", [#note[count_events / event_trend] #linebreak() Whole-scope counts and trends.]),
    column("Verify", [#note[check_claims] #linebreak() Submitted numerical claims against fact IDs.]),
  )
  #evidence-strip[Clients share role playbooks. The agent selects tools. The registry saves receipts with scope, facts and truncation. Full catalog in the appendix.]
]

#slide(deck, section: "Query evidence", title: [The evidence for one worked investigation])[
  #grid(columns: (1fr, 1fr), gutter: 38pt,
    [
      #label[BGL / 2005-2006]
      #v(8pt)
      #fill("Loaded population, full-span grouped counts + fact IDs")
    ],
    [
      #label[OpenStack / 2017]
      #v(8pt)
      #fill("Loaded population, full-span grouped counts + fact IDs")
    ],
  )
  #v(19pt)
  #rule()
  #v(15pt)
  #grid(columns: (1fr, 1fr), gutter: 38pt,
    [
      #label[Full-text search and nearby events]
      #v(10pt)
      #fill("Question, dataset, UTC window and filters")
      #v(13pt)
      #block(fill: palette.light, inset: 16pt, width: 100%)[
        #text(size: 16pt)[#fill("Verbatim error, surrounding events and event IDs")]
      ]
    ],
    [
      #block(fill: palette.light, inset: 18pt, width: 100%, height: 143pt)[
        #label[Grouped counts and trend]
        #v(13pt)
        #fill("Chart from actual tool results, with units and fact IDs")
        #v(12pt)
        #note[Separate dataset time axes.]
      ]
    ],
  )
  #evidence-strip[#fill("Receipts for retrieval + aggregation on both datasets / full corpus or samples / data version / UTC [start, end) / filters / truncation")]
]

#slide(deck, section: "Findings and recommendations", title: [The same case, three different decisions])[
  #grid(columns: (1fr, 1fr, 1fr), gutter: 32pt,
    [
      #label[Engineer]
      #v(10pt)
      #text(size: 25pt, weight: "semibold")[What happened?]
      #v(18pt)
      #fill("Observed error and context + fact IDs")
      #v(24pt)
      #action("Next diagnostic check", fill("Specific check and missing causal evidence"))
    ],
    [
      #label[Team lead]
      #v(10pt)
      #text(size: 25pt, weight: "semibold")[What recurs?]
      #v(18pt)
      #fill("Episodes, trend and fictional owner + fact IDs")
      #v(24pt)
      #action("Team investigation", fill("Owner, check and completion condition"))
    ],
    [
      #label[Manager]
      #v(10pt)
      #text(size: 25pt, weight: "semibold")[What comes first?]
      #v(18pt)
      #fill("Priority by episodes and breadth + fact IDs")
      #v(24pt)
      #action("Priority decision", fill("Next action, trade-off and review condition"))
    ],
  )
  #evidence-strip[#fill("Shared scope and actual receipts / role-specific unknowns / check_claims checked count and outcomes")]
]

#slide(deck, dark: true, section: "Worked investigation", title: [The check behind the recommendation])[
  #grid(columns: (1fr, 1fr, 1fr), gutter: 32pt,
    column("Initial hypothesis", [
      #fill("Initial explanation or priority", dark: true)
      #v(18pt)
      #note(dark: true)[Name the evidence that could distinguish it.]
    ], dark: true),
    column("Executed check", [
      #fill("Tool input, result and actual fact IDs", dark: true)
      #v(18pt)
      #note(dark: true)[Use a check that actually ran.]
    ], dark: true),
    column("Decision after the check", [
      #fill("Changed, retained or still open, with reason", dark: true)
      #v(18pt)
      #note(dark: true)[Supported does not establish causality.]
    ], dark: true),
  )
  #v(37pt)
  #evidence-strip(dark: true)[#fill("Public worked investigation and receipt links", dark: true)]
]

#slide(deck, section: "Limitations and handoff", title: [What the evidence leaves open])[
  #grid(columns: (1.15fr, 1fr), gutter: 42pt,
    [
      #label[Limits of the conclusion]
      #v(13pt)
      Log entries and episodes do not establish incidents or outages. Ownership is fictional.
      #v(15pt)
      Causal proof, downtime and business impact need additional evidence.
      #v(19pt)
      #fill("Case-specific unknowns and result truncation")
    ],
    [
      #public-link("Source and setup", deck.repository, draft: deck.draft)
      #v(20pt)
      #public-link("Worked investigation", deck.evidence, draft: deck.draft)
      #v(20pt)
      #public-link("Presentation PDF", deck.pdf, draft: deck.draft)
    ],
  )
  #v(24pt)
  #rule()
  #v(12pt)
  #note[Public repository, PDF and evidence must open without signing in or requesting access.]
]

// RESERVE SLIDES. Keep available for jury questions.

#slide(deck, appendix: true, section: "Query evidence", title: [An auditable tool call])[
  #grid(columns: (1.2fr, 1fr), gutter: 36pt,
    [
      #label[Executed SQL and bound parameters]
      #v(12pt)
      #block(width: 100%, height: 191pt, fill: palette.light, inset: 19pt)[
        #text(size: 16pt)[#fill("Paste exact SQL and parameters from the saved receipt. No illustrative query.")]
      ]
    ],
    [
      #label[Tool call and result]
      #v(10pt)
      #fill("Tool name and validated input")
      #v(15pt)
      #fill("Relevant returned rows, units + fact IDs")
      #v(15pt)
      #fill("Duration, population and truncated status")
    ],
  )
  #evidence-strip[#fill("Public receipt link / data version / scope / check_claims checked count and outcomes. Checks cover submitted numerical claims, not explanations.")]
]

#slide(deck, appendix: true, section: "Tool design", title: [A small tool set the agent can choose])[
  #grid(columns: (1fr, 1fr), gutter: 40pt,
    [
      #label[Find and inspect]
      #v(10pt)
      #tool-name[describe_corpus] #linebreak() #note[Scope, field meaning and capabilities]
      #v(10pt)
      #tool-name[search_logs] #linebreak() #note[Full-text query, time filters, bounded hits]
      #v(10pt)
      #tool-name[get_log_context] #linebreak() #note[Nearby events or aggregate precursor evidence]
      #v(10pt)
      #tool-name[check_claims] #linebreak() #note[Value, metric and group against a fact ID]
    ],
    [
      #label[Measure and compare]
      #v(10pt)
      #tool-name[count_events] #linebreak() #note[Grouped counts, shares and period comparison]
      #v(10pt)
      #tool-name[event_trend] #linebreak() #note[Buckets within one dataset's time span]
      #v(10pt)
      #tool-name[recurring_patterns] #linebreak() #note[Episodes, breadth and investigation order]
      #v(10pt)
      #tool-name[latency_stats] #linebreak() #note[OpenStack API access percentiles and rates]
    ],
  )
  #evidence-strip[Inputs: validated scope, filters and limits. Outputs: data, facts, receipt and truncation notes. Source: actual analytics registry.]
]

#slide(deck, appendix: true, section: "Evaluation", title: [Measured quality and its limits])[
  #grid(columns: (1fr, 1fr), gutter: 42pt,
    [
      #label[Quality evidence]
      #v(13pt)
      #fill("Saved baseline versus playbook results, per role")
      #v(17pt)
      #fill("First holdout, sample size, failures and follow-up runs")
      #v(17pt)
      #fill("Claim mismatches, unresolved facts and scope errors")
    ],
    [
      #label[Performance evidence]
      #v(13pt)
      #fill("Database time from receipts")
      #v(17pt)
      #fill("End-to-end time and model/tool calls from run artifacts")
      #v(17pt)
      #fill("Tokens and estimated API cost with pricing date")
    ],
  )
  #evidence-strip[#fill("Public evaluation report / model + configuration / data version / run artifact links / limitations")]
]
