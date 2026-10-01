/**
 * A small ustar (POSIX.1-1988) reader and writer — the plugin tarball's
 * format (sdk-21a). Hand-rolled rather than a dependency: the repo had no tar
 * reader or writer (`fflate` is zip), the SDK may depend on effect, zod and
 * tldts only (D55), and owning the reader makes the verifier's
 * path-traversal check ours by construction — it sees every header field,
 * including the ones a permissive extractor would quietly honour.
 *
 * The writer is deterministic: entries sorted by path, mtime 0, uid/gid 0,
 * mode 0644 (0755 for directories), no owner names. The same files always
 * pack to the same bytes, so the sha256 in the registry is reproducible.
 *
 * The reader returns every header it meets, typed, and judges nothing but
 * the format: it rejects a bad checksum or a truncated archive, and leaves
 * "is this entry safe to unpack" to the verifier, which refuses links,
 * devices, absolute paths and `..` (core's `plugins/verify.ts`).
 */

const BLOCK = 512

export type TarEntryType =
  'file' | 'directory' | 'symlink' | 'hardlink' | 'other'

export type TarEntry = {
  readonly path: string
  readonly type: TarEntryType
  /** The raw typeflag byte, for a refusal message. */
  readonly typeflag: string
  readonly mode: number
  readonly linkname: string
  readonly data: Uint8Array
}

export class TarFormatError extends Error {
  override readonly name = 'TarFormatError'
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const writeString = (
  header: Uint8Array,
  offset: number,
  length: number,
  value: string,
) => {
  const bytes = encoder.encode(value)
  if (bytes.length > length) {
    throw new TarFormatError(`"${value}" does not fit a ${length}-byte field`)
  }
  header.set(bytes, offset)
}

/** An octal field: zero-padded digits, then a NUL, filling `length`. */
const writeOctal = (
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
) =>
  writeString(
    header,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, '0')}\0`,
  )

/** Split a path over ustar's `prefix` (155) and `name` (100) fields. */
const splitPath = (path: string): { prefix: string; name: string } => {
  if (encoder.encode(path).length <= 100) return { prefix: '', name: path }
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (
      encoder.encode(prefix).length <= 155 &&
      encoder.encode(name).length <= 100
    ) {
      return { prefix, name }
    }
  }
  throw new TarFormatError(`path too long for ustar: ${path}`)
}

export type TarInput = {
  readonly path: string
  /** Omitted for a directory. */
  readonly data?: Uint8Array
}

const header = (path: string, type: 'file' | 'directory', size: number) => {
  const h = new Uint8Array(BLOCK)
  const { prefix, name } = splitPath(type === 'directory' ? `${path}/` : path)
  writeString(h, 0, 100, name)
  writeOctal(h, 100, 8, type === 'directory' ? 0o755 : 0o644)
  writeOctal(h, 108, 8, 0) // uid
  writeOctal(h, 116, 8, 0) // gid
  writeOctal(h, 124, 12, size)
  writeOctal(h, 136, 12, 0) // mtime: deterministic
  h.fill(0x20, 148, 156) // checksum field counts as spaces while summing
  writeString(h, 156, 1, type === 'directory' ? '5' : '0')
  writeString(h, 257, 6, 'ustar\0')
  writeString(h, 263, 2, '00')
  writeString(h, 345, 155, prefix)
  const sum = h.reduce((acc, b) => acc + b, 0)
  writeString(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return h
}

/** Pack `files` (and any directories they imply) into an uncompressed ustar. */
export const writeTar = (files: ReadonlyArray<TarInput>): Uint8Array => {
  const dirs = new Set<string>()
  for (const f of files) {
    if (f.data === undefined) dirs.add(f.path)
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const entries = [
    ...[...dirs].map((path) => ({ path, data: undefined })),
    ...files.filter((f) => f.data !== undefined),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const chunks: Array<Uint8Array> = []
  for (const e of entries) {
    const size = e.data?.length ?? 0
    chunks.push(
      header(e.path, e.data === undefined ? 'directory' : 'file', size),
    )
    if (e.data) {
      chunks.push(e.data)
      const pad = (BLOCK - (size % BLOCK)) % BLOCK
      if (pad) chunks.push(new Uint8Array(pad))
    }
  }
  chunks.push(new Uint8Array(BLOCK * 2)) // end-of-archive marker
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const readString = (block: Uint8Array, offset: number, length: number) => {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return decoder.decode(end < 0 ? field : field.subarray(0, end))
}

const readOctal = (block: Uint8Array, offset: number, length: number) => {
  const text = readString(block, offset, length).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new TarFormatError(`bad octal field "${text}" at offset ${offset}`)
  }
  return parseInt(text, 8)
}

const TYPES: { readonly [flag: string]: TarEntryType } = {
  '0': 'file',
  '\0': 'file',
  '7': 'file',
  '5': 'directory',
  '2': 'symlink',
  '1': 'hardlink',
}

/** Every entry of an uncompressed ustar archive, in archive order. */
export const readTar = (archive: Uint8Array): Array<TarEntry> => {
  const entries: Array<TarEntry> = []
  let at = 0
  while (at + BLOCK <= archive.length) {
    const block = archive.subarray(at, at + BLOCK)
    if (block.every((b) => b === 0)) return entries // end of archive
    const stored = readOctal(block, 148, 8)
    let sum = 0
    for (let i = 0; i < BLOCK; i++)
      sum += i >= 148 && i < 156 ? 0x20 : (block.at(i) ?? 0)
    if (sum !== stored) {
      throw new TarFormatError(`header checksum mismatch at byte ${at}`)
    }
    const name = readString(block, 0, 100)
    const prefix = readString(block, 345, 155)
    const typeflag = String.fromCharCode(block.at(156) ?? 0)
    const size = readOctal(block, 124, 12)
    const start = at + BLOCK
    if (start + size > archive.length) {
      throw new TarFormatError(`entry ${name} runs past the end of the archive`)
    }
    const path = (prefix ? `${prefix}/${name}` : name).replace(/\/$/, '')
    entries.push({
      path,
      type: TYPES[typeflag] ?? 'other',
      typeflag,
      mode: readOctal(block, 100, 8),
      linkname: readString(block, 157, 100),
      data: archive.slice(start, start + size),
    })
    at = start + Math.ceil(size / BLOCK) * BLOCK
  }
  throw new TarFormatError('archive ends without its end-of-archive marker')
}
