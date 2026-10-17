/**
 * `BIGINT` values cross the driver as strings and stay exact until a range
 * check allows a JavaScript number (AGENTS.md). Nothing is rounded silently.
 */
export function toSafeInteger(value: string | number | bigint): number {
  let exact: bigint
  if (typeof value === "bigint") exact = value
  else if (typeof value === "number") {
    if (!Number.isInteger(value))
      throw new RangeError(`not an integer: ${value}`)
    exact = BigInt(value)
  } else {
    if (!/^-?\d+$/.test(value))
      throw new RangeError(`not an integer string: ${value}`)
    exact = BigInt(value)
  }
  if (
    exact > BigInt(Number.MAX_SAFE_INTEGER) ||
    exact < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError(`integer outside the safe range: ${exact}`)
  }
  return Number(exact)
}
