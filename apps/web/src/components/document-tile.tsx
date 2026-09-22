/**
 * The three-letter tile in front of a filename: the kind when it says
 * something, else the extension.
 *
 * Shared rather than retyped because two surfaces draw it — the record Files
 * tab and the `/documents` shelf (SPA-58) — and a tile that reads `DCK` in one
 * and `PDF` in the other for the same file is the drift this prevents.
 */
const KIND_CODES: Record<string, string> = {
  deck: 'DCK',
  cap_table: 'CAP',
  dd: 'DD',
  legal: 'LGL',
}

function extCode(filename: string): string {
  const ext = filename.split('.').pop()?.toUpperCase() ?? ''
  return ext.length > 0 && ext.length <= 4 ? ext.slice(0, 3) : 'FILE'
}

export function DocumentTile({
  kind,
  filename,
}: {
  kind: string
  filename: string
}) {
  return (
    <span
      aria-hidden
      /* Optical sizing, not a type step: a three-letter kind code has to sit
         inside a 22px square, and the smallest named step (field, 10px)
         overflows it. DESIGN.md §3's list is for type; this is a glyph. */
      // eslint-disable-next-line instrument/vocabulary
      className="flex size-[1.375rem] shrink-0 items-center justify-center border border-hairline bg-paper mono text-[0.5rem] leading-[0.625rem] text-foreground"
    >
      {KIND_CODES[kind] ?? extCode(filename)}
    </span>
  )
}
