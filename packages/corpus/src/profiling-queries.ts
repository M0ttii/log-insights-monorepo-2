import { splitSqlScript } from "./sql-script.ts"

export type ProfilingQuery = { title: string; sql: string }

const TITLE = /^-- @ (.+)$/

/**
 * Splits a profiling file into titled queries. A query starts at a line
 * `-- @ <title>` and holds exactly one statement; text before the first title
 * is the file's description and must not contain a statement.
 */
export function profilingQueries(text: string): ProfilingQuery[] {
  const queries: ProfilingQuery[] = []
  let title: string | null = null
  let body: string[] = []

  const flush = () => {
    const statements = splitSqlScript(body.join("\n"))
    if (title === null) {
      if (statements.length > 0)
        throw new Error("Statement before the first `-- @` title")
    } else {
      const [sql, ...extra] = statements
      if (sql === undefined || extra.length > 0) {
        throw new Error(`Query "${title}" must hold exactly one statement`)
      }
      queries.push({ title, sql })
    }
  }

  for (const line of text.split("\n")) {
    const match = TITLE.exec(line)
    if (match?.[1] === undefined) {
      body.push(line)
      continue
    }
    flush()
    title = match[1].trim()
    body = []
  }
  flush()
  return queries
}
