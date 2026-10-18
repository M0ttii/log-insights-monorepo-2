#import "settings.typ": deck
#import "theme.typ": *

#show: setup.with(deck)
#let fill(body, dark: false) = slot(body, draft: deck.draft, dark: dark)

// MAIN DECK. Aim for one short argument per slide. See README for timing.
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

#slide(deck, section: "Approach", title: [Different decisions need different evidence])[
  #grid(columns: (1fr, 1fr, 1fr), gutter: 30pt,
    column("Engineer", [
      #text(size: 25pt, weight: "semibold")[What happened?]
      #v(13pt)
      Original messages and nearby events.
      #v(18pt)
      #note[Next step: a discriminating diagnostic check.]
    ]),
    column("Team lead", [
      #text(size: 25pt, weight: "semibold")[What recurs?]
      #v(13pt)
      Episodes, trends and fictional team ownership.
      #v(18pt)
      #note[Next step: a focused investigation for the team.]
    ]),
    column("Manager", [
      #text(size: 25pt, weight: "semibold")[What comes first?]
      #v(13pt)
      Technical priorities by episodes and breadth.
      #v(18pt)
      #note[Next step: a priority with an explicit trade-off.]
    ]),
  )
  #v(28pt)
  #rule()
  #v(14pt)
  Same agent and base corpus. SereneDB computes. Claude explains.
]

#slide(deck, section: "System diagram", title: [One shared path to the evidence])[
  // Editable system diagram. Arrows describe tool calls and returned evidence.
  #grid(columns: (180pt, 32pt, 240pt, 32pt, 1fr), align: horizon,
    column("Clients", [
      *Claude Code / Desktop*\ MCP over stdio
      #v(15pt)
      *Web chat*\ AI SDK adapter
    ]),
    text(size: 26pt, fill: palette.plum)[↔],
    block(fill: palette.light, inset: 19pt)[
      #label[Tool registry]
      #v(9pt)
      Zod contracts\ Parameterized SQL\ Limits and fact IDs
    ],
    text(size: 26pt, fill: palette.plum)[↔],
    column("SereneDB", [
      *BGL + OpenStack*\ Search and aggregation
      #v(15pt)
      Counts, trends, episodes and percentiles
    ]),
  )
  #v(24pt)
  #rule()
  #v(13pt)
  #grid(columns: (1fr, 1fr), gutter: 32pt,
    column("Shared role playbooks", [Question, evidence selection and next step.]),
    column("Saved query receipts", [Validated input, executed SQL, results and fact IDs.]),
  )
  #evidence-strip[Architecture: packages/analytics, packages/agent, apps/mcp and apps/web.]
]

#slide(deck, section: "Tool design", title: [A small tool set the agent can choose])[
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

#slide(deck, section: "Data scope", title: [Both datasets, separate time axes])[
  #grid(columns: (1fr, 1fr), gutter: 42pt,
    [
      #text(size: 31pt, weight: "semibold")[BGL]
      #v(10pt)
      #note[2005-2006 / source timestamps in Unix seconds]
      #v(17pt)
      #fill("Loaded population + data version")
      #v(14pt)
      #fill("Search, context, grouped count + trend receipts")
    ],
    [
      #text(size: 31pt, weight: "semibold")[OpenStack]
      #v(10pt)
      #note[2017 / log events and API accesses counted separately]
      #v(17pt)
      #fill("Loaded population + data version")
      #v(14pt)
      #fill("Search, context, grouped count + trend receipts")
    ],
  )
  #v(26pt)
  #rule()
  #v(13pt)
  #label[Whole base corpus]
  #v(8pt)
  #fill("Full-span counts for BGL and OpenStack, units + fact IDs")
  #evidence-strip[State full corpus or samples, UTC #raw("[start, end)"), all filters, rejected rows and any truncation. Cross-dataset totals cover each full span.]
]

#slide(deck, section: "Engineer", title: [The error and its surrounding events])[
  #grid(columns: (1.12fr, 1fr), gutter: 37pt,
    [
      #label[Question and scope]
      #v(8pt)
      #fill("Question + dataset + UTC window + filters")
      #v(22pt)
      #label[Original log evidence]
      #v(8pt)
      #block(fill: palette.light, inset: 18pt, width: 100%)[
        #text(size: 16pt)[#fill("Verbatim error and nearby events with timestamps and event IDs")]
      ]
    ],
    [
      #label[Observation]
      #v(8pt)
      #fill("What the returned evidence establishes")
      #v(19pt)
      #label[Hypothesis / still unknown]
      #v(8pt)
      #fill("Possible explanation and missing evidence")
      #v(19pt)
      #action("Next check", fill("Specific diagnostic action"))
    ],
  )
  #evidence-strip[#fill("search_logs + get_log_context receipts / actual fact IDs / result limits")]
]

#slide(deck, section: "Team lead", title: [Recurring patterns over the stated period])[
  #grid(columns: (1.18fr, 1fr), gutter: 35pt,
    [
      #trend-frame[#fill("Replace with a trend from event_trend; retain units and fact IDs")]
      #v(18pt)
      #fill("Episodes, active days and affected components")
    ],
    [
      #label[Question and scope]
      #v(8pt)
      #fill("Recurrence question, dataset and UTC window")
      #v(18pt)
      #label[Observed recurrence]
      #v(8pt)
      #fill("Pattern, fictional owner and trend + fact IDs")
      #v(18pt)
      #action("Team investigation", fill("Owner, check and completion condition"))
    ],
  )
  #evidence-strip[#fill("recurring_patterns + event_trend receipts / filters / truncation / unknowns")]
]

#slide(deck, section: "Manager", title: [A technical investigation order])[
  #set text(size: 18pt)
  #fill("Priority question + dataset + time window + filtered population")
  #v(18pt)
  #table(
    columns: (1.2fr, 1fr, 1fr, 1.5fr), inset: (x: 10pt, y: 12pt),
    stroke: none,
    table.header(
      label[Candidate], label[Episodes], label[Breadth], label[Next decision],
    ),
    table.hline(stroke: 0.7pt + palette.line),
    fill("First pattern"), fill("Fact ID"), fill("Unit + fact ID"), fill("Action + fictional owner"),
    table.hline(stroke: 0.7pt + palette.line),
    fill("Next pattern"), fill("Fact ID"), fill("Unit + fact ID"), fill("Action + fictional owner"),
    table.hline(stroke: 0.7pt + palette.line),
  )
  #v(21pt)
  #label[Trade-off and unknowns]
  #v(9pt)
  #fill("Explain episode-versus-breadth trade-off and missing impact evidence")
  #evidence-strip[#fill("recurring_patterns with rank: investigation_order / receipt / scope / truncation")]
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

#slide(deck, section: "Recommendations and limitations", title: [Actions bounded by the available evidence])[
  #grid(columns: (1.15fr, 1fr), gutter: 42pt,
    [
      #action("Engineer", fill("Next diagnostic check + evidence"))
      #v(22pt)
      #action("Team lead", fill("Investigation owner + completion condition"))
      #v(22pt)
      #action("Manager", fill("Priority + trade-off + review condition"))
    ],
    [
      #label[Limits of the conclusion]
      #v(12pt)
      Observed entries and episodes do not establish incidents or outages.
      #v(16pt)
      Fictional ownership. Business impact and causal proof remain unknown without additional evidence.
      #v(16pt)
      #fill("Case-specific missing evidence or truncation")
    ],
  )
]

#slide(deck, dark: true, section: "Log Insights", title: [Questions welcome])[
  #text(size: 29pt)[Every measured claim leads back\ to an executed query.]
  #v(34pt)
  #grid(columns: (1fr, 1fr), gutter: 42pt,
    public-link("Source and setup", deck.repository, draft: deck.draft, dark: true),
    public-link("Worked investigation", deck.evidence, draft: deck.draft, dark: true),
  )
  #v(27pt)
  #public-link("Presentation PDF", deck.pdf, draft: deck.draft, dark: true)
  #v(22pt)
  #note(dark: true)[All jury links must open without signing in or requesting access.]
]

// APPENDIX. Keep available for questions, outside the rehearsed main argument.
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

#slide(deck, appendix: true, section: "Submission", title: [Public access is part of the handoff])[
  #grid(columns: (1fr, 1fr), gutter: 42pt,
    [
      #label[Repository]
      #v(13pt)
      Public source, setup instructions, tool contracts and known limitations.
      #v(18pt)
      One worked investigation with the questions, tool calls, executed SQL, results and answers for every role.
    ],
    [
      #label[PDF and evidence]
      #v(13pt)
      Public PDF and referenced evidence, accessible without a login or permission request.
      #v(18pt)
      #fill("Test final links in a signed-out browser and record release commit")
    ],
  )
  #v(23pt)
  #rule()
  #v(13pt)
  #note[Optional awards: include MCP connection steps or actual large-dataset scope, timings and costs only when demonstrated.]
]
