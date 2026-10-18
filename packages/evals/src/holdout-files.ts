import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { join } from "node:path"

/** Reject links and bound reads, including links in the selected directory. */
export async function readHoldoutFile(
  dir: string,
  file: string
): Promise<Buffer> {
  const maximum = 4_194_304
  const directory = await lstat(dir)
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Holdout artifact directory must not be a link")
  const target = join(dir, file)
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum)
    throw new Error("Invalid holdout artifact file")
  if ((await realpath(target)) !== join(await realpath(dir), file))
    throw new Error("Holdout artifact path leaves its directory")
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size > maximum
    )
      throw new Error("Holdout artifact changed while opening")
    const bytes = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < bytes.length) {
      const part = await handle.read(bytes, size, bytes.length - size, null)
      if (part.bytesRead === 0) break
      size += part.bytesRead
    }
    if (size > maximum)
      throw new Error("Holdout artifact file exceeds its limit")
    return bytes.subarray(0, size)
  } finally {
    await handle.close()
  }
}

export async function readHoldoutJson(
  dir: string,
  file: string
): Promise<unknown> {
  const raw = await readHoldoutFile(dir, file)
  try {
    return JSON.parse(raw.toString("utf8"))
  } catch {
    throw new Error("Invalid holdout JSON artifact")
  }
}
