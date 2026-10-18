import { z } from "zod"

import {
  DATASETS,
  EXTENSION_COLUMNS,
  type Dataset,
  type ExtensionColumn,
} from "./datasets.ts"

/**
 * Columns of the extension datasets on event rows (search hits, context
 * events): present only for datasets whose catalog entry gives the column a
 * meaning, so BGL and OpenStack rows keep their exact shape (U26).
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
} satisfies Record<ExtensionColumn, z.ZodType>

export type ExtensionAttributes = Partial<
  Record<ExtensionColumn, string | null>
>

/** Parser of the five columns as SereneDB returns them. */
export const extensionColumnsRow = z.object({
  host: z.string().nullable(),
  process_id: z.string().nullable(),
  client_ip: z.string().nullable(),
  thread: z.string().nullable(),
  block_id: z.string().nullable(),
})

/** The attributes the dataset carries, picked from a row with all five columns. */
export function extensionAttributes(
  dataset: Dataset,
  row: z.infer<typeof extensionColumnsRow>
): ExtensionAttributes {
  const attributes: ExtensionAttributes = {}
  for (const column of EXTENSION_COLUMNS)
    if (DATASETS[dataset].fields[column] !== undefined)
      attributes[column] = row[column]
  return attributes
}
