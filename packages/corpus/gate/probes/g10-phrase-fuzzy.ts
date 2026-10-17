import { failureOf } from "../db.ts"
import { check, equals, type Probe } from "../probe.ts"

const countAndList = (predicate: string) =>
  [
    `SELECT count(*) FROM gate.bgl_idx WHERE ${predicate}`,
    `SELECT count(*) FROM (SELECT event_id FROM gate.bgl_idx WHERE ${predicate}
     ORDER BY BM25(bgl_idx.tableoid) DESC, event_id)`,
  ] as const

export const g10PhraseFuzzy: Probe = {
  id: "G10",
  title: "Phrase and fuzzy search with bound parameters",
  async run({ db, loadBgl }) {
    const load = await loadBgl()
    if (load === null) return [{ skipped: "BGL.log not downloaded" }]

    const [phraseCount, phraseList] = countAndList("message @@ ts_phrase($1)")
    const phrase = await db.value(phraseCount, ["Cache Parity Error"])
    const phraseHits = await db.value(phraseList, ["Cache Parity Error"])
    const phraseBase = await db.value(
      "SELECT count(*) FROM gate.bgl WHERE regexp_matches(lower(message), $1)",
      ["(^|[^a-z0-9])cache parity error([^a-z0-9]|$)"]
    )
    const reversed = await db.value(phraseCount, ["error parity cache"])
    const slop = await db.value(
      "SELECT count(*) FROM gate.bgl_idx WHERE message @@ ts_phrase($1, slop := 1)",
      ["instruction parity"]
    )
    const syntaxInPhrase = await db.value(phraseCount, [
      '(( "cache parity error',
    ])

    const [fuzzyCount, fuzzyList] = countAndList(
      "message @@ ts_levenshtein($1, $2)"
    )
    const fuzzy = await db.value(fuzzyCount, ["parrity", 1])
    const fuzzyHits = await db.value(fuzzyList, ["parrity", 1])
    const exact = await db.value(
      "SELECT count(*) FROM gate.bgl_idx WHERE message @@ $1",
      ["parity"]
    )
    const distance4 = await failureOf(() => db.rows(fuzzyCount, ["parrity", 4]))
    const distance4Strict = await failureOf(() =>
      db.rows(
        "SELECT count(*) FROM gate.bgl_idx WHERE message @@ ts_levenshtein($1, $2, false)",
        ["parrity", 4]
      )
    )
    const distance5 = await failureOf(() => db.rows(fuzzyCount, ["parrity", 5]))

    // Expansion is capped per index segment (sdb_levenshtein_max_terms, default 50).
    const maxTerms = await db.value("SHOW sdb_levenshtein_max_terms")
    const shortCapped = await db.value(fuzzyCount, ["node", 2])
    await db.rows("SET sdb_levenshtein_max_terms = 0")
    const shortUncapped = await db.value(fuzzyCount, ["node", 2])
    await db.rows("RESET sdb_levenshtein_max_terms")

    return [
      equals(
        "ts_phrase($1): count(*) equals full hit list",
        phrase,
        phraseHits
      ),
      equals(
        "ts_phrase is case-insensitive and equals an independent regex count",
        phraseBase,
        phrase
      ),
      equals("ts_phrase respects order", "0", reversed),
      check(
        "ts_phrase(…, slop := 1) allows one word in between",
        "> 0",
        slop,
        Number(slop) > 0
      ),
      equals(
        "query syntax inside ts_phrase is tokenised, not parsed",
        phrase,
        syntaxInPhrase
      ),
      equals(
        "ts_levenshtein($1, $2): count(*) equals full hit list",
        fuzzy,
        fuzzyHits
      ),
      equals(
        "ts_levenshtein('parrity', 1) finds the exact term's rows",
        exact,
        fuzzy
      ),
      check(
        "distance 4 with transpositions (default) is rejected",
        "error: 0-3 with transpositions",
        distance4?.message ?? "accepted",
        distance4 !== null
      ),
      equals(
        "distance 4 without transpositions is accepted",
        null,
        distance4Strict
      ),
      check(
        "distance 5 is rejected",
        "error",
        distance5?.message ?? "accepted",
        distance5 !== null
      ),
      equals("default sdb_levenshtein_max_terms", "50", maxTerms),
      check(
        "term expansion cap: short term at distance 2, capped vs uncapped",
        "recorded (cap can hide matches)",
        `${String(shortCapped)} capped vs ${String(shortUncapped)} uncapped`,
        Number(shortCapped) <= Number(shortUncapped)
      ),
    ]
  },
}
