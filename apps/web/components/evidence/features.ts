// Only SQL present in this receipt earns a feature chip (UI concept § 8).
export const features = [
  {
    label: "BM25 ranking",
    pattern: /\bBM25\s*\(/i,
    description: "Relevance ranking from the full-text index.",
  },
  {
    label: "Full-text index",
    pattern: /\bplainto_tsquery\s*\(/i,
    description: "Every search term matched in the index.",
  },
  {
    label: "Phrase search",
    pattern: /\bts_phrase\s*\(/i,
    description: "Words matched in their original order.",
  },
  {
    label: "Fuzzy search",
    pattern: /\bts_levenshtein\s*\(/i,
    description: "Typo-tolerant matching in the index.",
  },
  {
    label: "Match ranges",
    pattern: /\bts_offsets\s*\(/i,
    description: "Match positions returned by the index.",
  },
  {
    label: "Row pattern matching",
    pattern: /\bMATCH_RECOGNIZE\b/i,
    description: "Episode boundaries and anchors computed in SereneDB.",
  },
  {
    label: "Percentiles",
    pattern: /\bquantile_cont\s*\(/i,
    description: "Latency percentiles calculated in one query.",
  },
  {
    label: "UTC bucket grid",
    pattern: /\bunnest\s*\(\s*range\s*\(/i,
    description: "Half-open time buckets, with capture gaps preserved.",
  },
]
export function receiptFeatures(sql: readonly string[]) {
  return features.filter((feature) =>
    sql.some((statement) => feature.pattern.test(statement))
  )
}
