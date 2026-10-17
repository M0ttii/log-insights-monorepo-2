/**
 * Reference implementation of the OpenStack endpoint mask, for tests of the
 * SQL normalization only (technical.md § 8.2). Production endpoints come from
 * the `endpoint` column computed at load time; tools never normalize in
 * TypeScript.
 *
 * Rule (R-04: mask variable path segments, keep meaningful parts): drop the
 * query string, replace every UUID with `<UUID>`, every segment of 32 hex
 * digits with `<ID>` and every all-digit segment with `<NUM>`.
 */

const UUID =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
const HEX_ID = /^[0-9a-f]{32}$/
const NUMBER = /^\d+$/

export function normalizeEndpoint(path: string): string {
  const [withoutQuery = ""] = path.split("?")
  return withoutQuery
    .replace(UUID, "<UUID>")
    .split("/")
    .map((segment) =>
      HEX_ID.test(segment) ? "<ID>" : NUMBER.test(segment) ? "<NUM>" : segment
    )
    .join("/")
}
