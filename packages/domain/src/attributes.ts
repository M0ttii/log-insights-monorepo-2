import { z } from "zod"

import {
  DATASETS,
  EXTENSION_COLUMNS,
  OTEL_COLUMNS,
  type Dataset,
  type ExtensionColumn,
  type OtelColumn,
} from "./datasets.ts"

/**
 * Dataset-specific columns on event rows (search hits, context events):
 * present only for datasets whose catalog entry gives the column a meaning,
 * so BGL and OpenStack rows keep their exact shape (U26). The extension
 * columns live in log_events; the OpenTelemetry columns only in the otel
 * relations (LOG-35).
 */
export const EXTENSION_ATTRIBUTES = {
  host: z
    .string()
    .nullable()
    .optional()
    .describe("Syslog host (OpenSSH, Linux); absent for other datasets."),
  process_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Process ID as logged (OpenSSH, Linux); IDs repeat over time. Absent for other datasets."
    ),
  client_ip: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Remote IPv4 address (OpenSSH, Apache); null when the line names none. Absent for other datasets."
    ),
  thread: z
    .string()
    .nullable()
    .optional()
    .describe("Thread name (ZooKeeper); absent for other datasets."),
  block_id: z
    .string()
    .nullable()
    .optional()
    .describe("HDFS block ID; absent for other datasets."),
  trace_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      "OTel TraceId as logged (otel); the empty string when the record has no trace. Absent for other datasets."
    ),
  span_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      "OTel SpanId as logged (otel); the empty string when absent. Absent for other datasets."
    ),
  severity_number: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "OTel SeverityNumber as logged (otel; 0 = unspecified); the level is SeverityText. Absent for other datasets."
    ),
} satisfies Record<ExtensionColumn | OtelColumn, z.ZodType>

export type ExtensionAttributes = Partial<
  Record<ExtensionColumn | "trace_id" | "span_id", string | null>
> & { severity_number?: number | null }

/** Parser of the eight columns as SereneDB returns them. */
export const extensionColumnsRow = z.object({
  host: z.string().nullable(),
  process_id: z.string().nullable(),
  client_ip: z.string().nullable(),
  thread: z.string().nullable(),
  block_id: z.string().nullable(),
  trace_id: z.string().nullable(),
  span_id: z.string().nullable(),
  severity_number: z.number().int().nullable(),
})

export type ExtensionColumnsRow = z.infer<typeof extensionColumnsRow>

/** The attributes the dataset carries, picked from a row with all eight columns. */
export function extensionAttributes(
  dataset: Dataset,
  row: ExtensionColumnsRow
): ExtensionAttributes {
  const attributes: ExtensionAttributes = {}
  const fields = DATASETS[dataset].fields
  for (const column of EXTENSION_COLUMNS)
    if (fields[column] !== undefined) attributes[column] = row[column]
  for (const column of OTEL_COLUMNS) {
    if (fields[column] === undefined) continue
    if (column === "severity_number")
      attributes.severity_number = row.severity_number
    else attributes[column] = row[column]
  }
  return attributes
}

/** Splits the eight attribute columns off a parsed row. */
export function splitAttributes<R extends ExtensionColumnsRow>(
  row: R
): [Omit<R, keyof ExtensionColumnsRow>, ExtensionColumnsRow] {
  const {
    host,
    process_id,
    client_ip,
    thread,
    block_id,
    trace_id,
    span_id,
    severity_number,
    ...rest
  } = row
  return [
    rest,
    {
      host,
      process_id,
      client_ip,
      thread,
      block_id,
      trace_id,
      span_id,
      severity_number,
    },
  ]
}
