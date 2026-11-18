import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate'
import type { WriteStream } from 'node:fs'
import type { Readable } from 'node:stream'

/**
 * A zip written to a file as it is built, hashed and counted on the way, so
 * the archive is never held whole: fflate emits each chunk as an entry is
 * pushed, the chunk goes straight to disk, and every push waits for the file
 * to drain. Entries are written one after another — fflate buffers a second
 * entry's bytes until the first ends, so an entry is always ended before the
 * next opens.
 */
export class ZipSink {
  private readonly out: WriteStream
  private readonly zip: Zip
  private readonly hash = createHash('sha256')
  private readonly closed: Promise<void>
  private failure: Error | null = null
  private bytes = 0

  constructor(path: string) {
    this.out = createWriteStream(path, { mode: 0o600 })
    // A write error is raised by the next push and by `finish`, not lost:
    // `once` rejects on `error`, and the rejection is kept as the failure.
    this.closed = once(this.out, 'finish').then(
      () => undefined,
      (err: unknown) => {
        this.failure ??= err instanceof Error ? err : new Error(String(err))
      },
    )
    this.zip = new Zip((err, chunk, final) => {
      if (err !== null) {
        this.failure ??= err
        return
      }
      this.hash.update(chunk)
      this.bytes += chunk.length
      this.out.write(chunk)
      if (final) this.out.end()
    })
  }

  private async drain(): Promise<void> {
    if (this.failure !== null) throw this.failure
    if (this.out.writableNeedDrain) await once(this.out, 'drain')
  }

  /** A text entry, deflated, written in pieces as `write` is called. */
  text(name: string): {
    write: (text: string) => Promise<void>
    end: () => Promise<void>
  } {
    const entry = new ZipDeflate(name, { level: 6 })
    this.zip.add(entry)
    return {
      write: async (text) => {
        entry.push(strToU8(text))
        await this.drain()
      },
      end: async () => {
        entry.push(new Uint8Array(0), true)
        await this.drain()
      },
    }
  }

  /** A whole text entry at once: a note, a manifest page is `text` instead. */
  async file(name: string, text: string): Promise<void> {
    const entry = this.text(name)
    await entry.write(text)
    await entry.end()
  }

  /**
   * A stored blob, stored rather than deflated: decks and images are
   * compressed already, and deflating them again costs the worker for nothing.
   */
  async stream(name: string, source: Readable): Promise<void> {
    const entry = new ZipPassThrough(name)
    this.zip.add(entry)
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array))
        throw new Error(`${name} did not read as bytes`)
      entry.push(chunk)
      await this.drain()
    }
    entry.push(new Uint8Array(0), true)
    await this.drain()
  }

  /** Ends the archive and waits for the file; the digest and size of what landed. */
  async finish(): Promise<{ sha: string; sizeBytes: number }> {
    this.zip.end()
    await this.closed
    if (this.failure !== null) throw this.failure
    return { sha: this.hash.digest('hex'), sizeBytes: this.bytes }
  }
}
