import type { SearchHit } from "@workspace/domain/tools/search-logs"
/** SereneDB offsets address Unicode code points, so surrogate pairs stay intact. */
export function messageParts(
  message: string,
  ranges: SearchHit["match_ranges"]
) {
  const points = Array.from(message)
  const parts: { text: string; matched: boolean; start: number }[] = []
  let offset = 0
  for (const range of ranges) {
    if (range.start > offset)
      parts.push({
        text: points.slice(offset, range.start).join(""),
        matched: false,
        start: offset,
      })
    parts.push({
      text: points.slice(range.start, range.end).join(""),
      matched: true,
      start: range.start,
    })
    offset = range.end
  }
  if (offset < points.length)
    parts.push({
      text: points.slice(offset).join(""),
      matched: false,
      start: offset,
    })
  return parts
}
