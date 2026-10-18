// Native Typst. No packages, network requests, or generated image assets.
#let palette = (
  ink: rgb("#11121d"),
  dark: rgb("#1c1c1c"),
  paper: rgb("#ffffff"),
  violet: rgb("#895af8"),
  plum: rgb("#6f48cb"),
  lilac: rgb("#c4b1ff"),
  muted: rgb("#506182"),
  light: rgb("#f0f2f5"),
  line: rgb("#d8dce5"),
  mist: rgb("#bbbbbb"),
)

#let label(body, dark: false) = text(
  size: 12pt, weight: "semibold", tracking: 0.9pt,
  fill: if dark { palette.lilac } else { palette.plum },
  upper(body),
)

#let slot(body, draft: true, dark: false) = {
  assert(draft, message: "Unfilled template slot: " + body)
  text(fill: if dark { palette.lilac } else { palette.plum })[
    #text(weight: "semibold")[TO FILL] / #body
  ]
}

#let setup(deck, body) = {
  set document(
    title: deck.title + if deck.draft { if "status" in deck { " - Draft" } else { " - Presentation template" } } else { "" },
    author: if deck.team == none { deck.title } else { deck.team },
    date: none,
  )
  set text(font: "Urbanist", size: 19pt, fill: palette.ink, lang: "en")
  set par(leading: 0.6em, spacing: 0.7em)
  set heading(numbering: none)
  show strong: set text(weight: "bold")
  body
}

#let slide(deck, title: none, section: none, dark: false, appendix: false, body) = {
  let fg = if dark { palette.paper } else { palette.ink }
  set page(
    width: 960pt, height: 540pt,
    margin: (x: 52pt, top: 36pt, bottom: 42pt),
    fill: if dark { palette.dark } else { palette.paper },
    footer: context {
      set text(size: 10.5pt, fill: if dark { palette.mist } else { palette.muted })
      grid(columns: (1fr, auto, 1fr), align: (left, center, right),
        text(if appendix { deck.title + " / Appendix" } else { deck.title }),
        if "status" in deck { text(deck.status) } else if deck.draft { [TEMPLATE / EVIDENCE PENDING] },
        [#counter(page).display("1")],
      )
    },
  )
  set text(fill: fg)
  if section != none {
    label(section, dark: dark)
    v(11pt)
  }
  if title != none {
    block(width: 100%)[#text(size: 36pt, weight: "semibold", tracking: -0.6pt, title)]
    v(21pt)
  }
  body
  pagebreak(weak: true)
}

#let rule(dark: false) = line(length: 100%, stroke: 0.7pt + if dark { rgb("#474747") } else { palette.line })

#let column(title, body, dark: false) = [
  #label(title, dark: dark)
  #v(10pt)
  #body
]

#let note(body, dark: false) = text(size: 13pt, fill: if dark { palette.mist } else { palette.muted }, body)

#let evidence-strip(body, dark: false) = block(
  width: 100%, above: 16pt, inset: (top: 10pt),
  stroke: (top: 0.7pt + if dark { rgb("#474747") } else { palette.line }),
)[#note(body, dark: dark)]

#let action(title, body, dark: false) = [
  #label(title, dark: dark)
  #v(7pt)
  #text(size: 22pt, weight: "semibold", body)
]

#let tool-name(body) = text(size: 15pt, weight: "semibold", body)

// Empty evidence frame, deliberately without synthetic data or invented axes.
#let trend-frame(body) = block(
  width: 100%, height: 170pt, fill: palette.light,
  inset: 22pt,
)[
  #label[Verified trend]
  #v(18pt)
  #body
  #v(14pt)
  #note[Dataset / UTC window / bucket / unit / fact IDs]
]

#let public-link(title, url, draft: true, dark: false) = [
  #label(title, dark: dark)
  #v(8pt)
  #if url == none {
    slot("Public HTTPS link", draft: draft, dark: dark)
  } else {
    assert(url.starts-with("https://"), message: "Use a public HTTPS URL")
    text(size: 20pt, weight: "semibold", link(url, [Open #lower(title)]))
  }
]
