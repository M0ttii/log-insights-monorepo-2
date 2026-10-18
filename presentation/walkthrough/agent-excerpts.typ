#set page(width: 960pt, height: 540pt, margin: 32pt, fill: rgb("#1c1c1c"))
#set text(font: "Urbanist", size: 16pt, fill: white, lang: "en")
#set par(leading: 0.65em)
#text(size: 12pt, fill: rgb("#c4b1ff"))[EDITED WALKTHROUGH / ORIGINAL MODEL ANSWER EXCERPTS]
#v(10pt)
#text(size: 30pt, weight: "bold")[Actual Claude answers for each role]
#v(17pt)
#let quotes = json("quotes.json")
#grid(columns: (1fr, 1fr, 1fr), gutter: 25pt, ..quotes.map(q => [
  #text(size: 21pt, weight: "bold", fill: rgb("#c4b1ff"))[#q.role]
  #v(10pt) #text(size: 11pt, fill: rgb("#bbbbbb"))[#q.client]
  #v(12pt) #text(size: 14pt)[#q.evidence]
  #v(13pt) #text(size: 14pt)[#q.text]
  #v(15pt) #text(size: 13pt)[#q.next]
]))
#v(8pt)
#text(size: 12pt, fill: rgb("#bbbbbb"))[Excerpts preserve original wording. Complete answers and original query receipts: submission/agent-examples/. Known demonstration material; no formal quality or holdout claim.]
