/**
 * Splits a SQL script into single statements.
 *
 * SereneDB runs a multi-statement simple query as one batch in which a text
 * search dictionary created earlier is not yet visible to CREATE INDEX (gate
 * G1), so scripts are sent one statement at a time. The splitter supports what
 * our own scripts use: `;` ends a statement, `--` comments are dropped, and `;`
 * inside quotes, dollar quotes or block comments is not a statement end.
 */
export function splitSqlScript(script: string): string[] {
  const statements: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let inBlockComment = false
  let dollarTag: string | null = null

  for (let i = 0; i < script.length; i++) {
    const char = script[i] ?? ""
    const next = script[i + 1]

    if (inBlockComment) {
      current += char
      if (char === "*" && next === "/") {
        current += next
        i++
        inBlockComment = false
      }
      continue
    }
    if (dollarTag !== null) {
      if (script.startsWith(dollarTag, i)) {
        current += dollarTag
        i += dollarTag.length - 1
        dollarTag = null
      } else {
        current += char
      }
      continue
    }
    if (quote !== null) {
      current += char
      // A doubled quote ('' or "") is an escaped quote and stays inside.
      if (char === quote) {
        if (next === quote) {
          current += next
          i++
        } else {
          quote = null
        }
      }
      continue
    }

    if (char === "-" && next === "-") {
      const end = script.indexOf("\n", i)
      i = end === -1 ? script.length : end - 1
      continue
    }
    if (char === "/" && next === "*") {
      inBlockComment = true
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(script.slice(i))?.[0]
      if (tag !== undefined) {
        dollarTag = tag
        current += tag
        i += tag.length - 1
        continue
      }
    }
    if (char === ";") {
      const statement = current.trim()
      if (statement !== "") statements.push(statement)
      current = ""
      continue
    }
    current += char
  }

  if (quote !== null || inBlockComment || dollarTag !== null) {
    throw new Error("SQL script ends inside a quote or comment")
  }
  const rest = current.trim()
  if (rest !== "") statements.push(rest)
  return statements
}

/** Replaces `{{NAME}}` placeholders; an unknown placeholder is an error, not an empty string. */
export function fillPlaceholders(
  script: string,
  values: Readonly<Record<string, string>>
): string {
  return script.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name: string) => {
    const value = values[name]
    if (value === undefined) {
      throw new Error(`No value for placeholder {{${name}}}`)
    }
    return value
  })
}

/** A SQL string literal; quotes are doubled, control characters are refused. */
export function sqlString(value: string): string {
  if ([...value].some((char) => char.charCodeAt(0) < 0x20)) {
    throw new Error("SQL literal must not contain control characters")
  }
  return `'${value.replaceAll("'", "''")}'`
}

/** A SQL list literal of strings, e.g. `['/data/raw/a.log', '/data/raw/b.log']`. */
export function sqlStringList(values: readonly string[]): string {
  if (values.length === 0) throw new Error("SQL list must not be empty")
  return `[${values.map((value) => sqlString(value)).join(", ")}]`
}
