/** Small SQL building blocks shared by the filter compiler and the tools. */

export type SqlValue = string | number | boolean | null

/** Collects bound values for one SQL text and hands out their `$n` placeholders. */
export class SqlParams {
  readonly values: SqlValue[] = []

  add(value: SqlValue): string {
    this.values.push(value)
    return `$${this.values.length}`
  }

  list(values: readonly SqlValue[]): string {
    return values.map((value) => this.add(value)).join(", ")
  }
}

/**
 * ISO-8601 text with microseconds and `Z` (technical.md § 6.1). strftime
 * follows the session time zone, which every pooled connection sets to UTC.
 * `column` must come from code, never from input.
 */
export function isoTime(column: string): string {
  return `strftime(${column}, '%Y-%m-%dT%H:%M:%S.%fZ')`
}
