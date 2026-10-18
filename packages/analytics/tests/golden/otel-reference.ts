/**
 * Independent LOG-35 oracle, written from design D1/D3 and the domain catalog.
 * No tool, filter compiler, relation router or loader SQL is imported here.
 * Context7 /serenedb/serenedb: read_parquet HTTPS, file_row_number,
 * TIMESTAMPTZ_NS predicates and scalar ts_lexize (consulted 2026-10-18).
 */
export const otelUrls = [
  "https://public-pme.s3.eu-west-3.amazonaws.com/text_bench/part_000.parquet",
  "https://public-pme.s3.eu-west-3.amazonaws.com/text_bench/part_001.parquet",
] as const

// The next file's minimum is the exclusive end assigned to part_000 (D3).
const otelBoundary = "2025-09-23T00:29:24.039037200Z"
export const otelReferenceWindow = {
  from: "2025-09-23T00:29:14.000000Z",
  to: "2025-09-23T00:29:34.000000Z",
}

export type OtelWindow = {
  from: string
  to: string
  files: readonly (0 | 1)[]
}

/**
 * Every branch keeps the Parquet timestamp bare for row-group pruning. Both
 * request bounds and the file assignment use ns, even for microsecond input.
 * `assigned: false` is only for measuring rows excluded by the boundary rule.
 * Time values stay bound. The two fixed, catalog-allowlisted URLs are SQL
 * literals: binding a read_parquet path makes SereneDB 26.10.1 describe an
 * unknown result (G1; reproduced by this suite on 2026-10-18). No input or
 * database value can select or alter these literals.
 */
export function otelReferenceSql(window: OtelWindow, assigned = true) {
  const params: unknown[] = [window.from, window.to, otelBoundary]
  const branches = window.files.map((file) => {
    const assignment = assigned
      ? file === 0
        ? 'AND "Timestamp" < $3::TIMESTAMPTZ_NS'
        : 'AND "Timestamp" >= $3::TIMESTAMPTZ_NS'
      : ""
    return `
      SELECT ${file}::INTEGER AS file_index, file_row_number,
        "Timestamp" AS ts, "ServiceName" AS component,
        "SeverityText" AS level, "Body" AS message,
        "TraceId" AS trace_id, "SpanId" AS span_id,
        "SeverityNumber" AS severity_number
      FROM read_parquet('${otelUrls[file]}', file_row_number = true)
      WHERE "Timestamp" >= $1::TIMESTAMPTZ_NS
        AND "Timestamp" < $2::TIMESTAMPTZ_NS ${assignment}`
  })
  return { cte: `WITH source AS (${branches.join(" UNION ALL ")})`, params }
}
