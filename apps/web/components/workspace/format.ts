// Reused from the original demo. UTC formatting never changes stored instants.
const utcDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
})
export function formatUtcDate(iso: string) {
  return utcDate.format(new Date(iso))
}
