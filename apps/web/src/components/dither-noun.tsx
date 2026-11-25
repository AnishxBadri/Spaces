import { useId } from 'react'
import type { ReactNode } from 'react'
import { cellsFor } from './dither'
import { cn } from '#/lib/utils'

/** The kinds with a drawing of their own. */
export type NounKind =
  | 'tasks'
  | 'notes'
  | 'files'
  | 'meetings'
  | 'deals'
  | 'companies'
  | 'people'
  | 'spaces'
  | 'feeds'
  | 'email'

/** The Bayer densities the drawings use: shadow 8, detail 12, a deeper shadow 4. */
const LEVELS = [4, 8, 12] as const
type Level = (typeof LEVELS)[number]

/**
 * Each drawing on a 160×120 grid: a paper object in a 1px ink outline, a
 * pine dither shadow offset 8px, one pine dithered detail. Half-pixel
 * coordinates put a 1px stroke on whole pixels. `u` names a density's fill.
 */
const NOUNS: Record<NounKind, (u: (level: Level) => string) => ReactNode> = {
  tasks: (u) => (
    <>
      <rect x="44" y="24" width="88" height="88" fill={u(8)} />
      <rect
        x="36.5"
        y="16.5"
        width="87"
        height="87"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect
        x="50.5"
        y="34.5"
        width="11"
        height="11"
        fill={u(12)}
        stroke="var(--hairline)"
      />
      <rect x="70" y="39" width="40" height="2" fill="var(--rule)" />
      <rect
        x="50.5"
        y="56.5"
        width="11"
        height="11"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="70" y="61" width="44" height="2" fill="var(--rule)" />
      <rect
        x="50.5"
        y="78.5"
        width="11"
        height="11"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="70" y="83" width="30" height="2" fill="var(--rule)" />
    </>
  ),
  notes: (u) => (
    <>
      <path d="M48,20 L116,20 L132,36 L132,116 L48,116 Z" fill={u(8)} />
      <path
        d="M40.5,12.5 L108.5,12.5 L124.5,28.5 L124.5,108.5 L40.5,108.5 Z"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <path
        d="M108.5,12.5 L108.5,28.5 L124.5,28.5 Z"
        fill={u(12)}
        stroke="var(--hairline)"
      />
      <rect x="52" y="36" width="56" height="2" fill="var(--rule)" />
      <rect x="52" y="48" width="68" height="2" fill="var(--rule)" />
      <rect x="52" y="60" width="62" height="2" fill="var(--rule)" />
      <rect x="52" y="72" width="68" height="2" fill="var(--rule)" />
      <rect x="52" y="84" width="40" height="2" fill="var(--rule)" />
    </>
  ),
  files: (u) => (
    <>
      <path d="M36,38 L72,38 L80,46 L140,46 L140,108 L36,108 Z" fill={u(8)} />
      <rect
        x="46.5"
        y="18.5"
        width="67"
        height="49"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="56" y="30" width="40" height="2" fill="var(--rule)" />
      <rect x="56" y="40" width="48" height="2" fill="var(--rule)" />
      <path
        d="M28.5,46.5 L132.5,46.5 L132.5,100.5 L28.5,100.5 Z"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <path
        d="M28.5,30.5 L64.5,30.5 L72.5,38.5 L72.5,46.5 L28.5,46.5 Z"
        fill={u(12)}
        stroke="var(--hairline)"
      />
    </>
  ),
  meetings: (u) => (
    <>
      <rect x="40" y="28" width="96" height="84" fill={u(8)} />
      <rect
        x="32.5"
        y="20.5"
        width="95"
        height="83"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="32" y="20" width="96" height="18" fill="var(--hairline)" />
      <rect x="50" y="14" width="2" height="12" fill="var(--hairline)" />
      <rect x="108" y="14" width="2" height="12" fill="var(--hairline)" />
      <rect
        x="42"
        y="48"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="58"
        y="48"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="74"
        y="48"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="90"
        y="48"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="106"
        y="48"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="42"
        y="64"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="58"
        y="64"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect x="74" y="64" width="12" height="12" fill={u(12)} />
      <rect
        x="90"
        y="64"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="106"
        y="64"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="42"
        y="80"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="58"
        y="80"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="74"
        y="80"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="90"
        y="80"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
      <rect
        x="106"
        y="80"
        width="11"
        height="11"
        fill="none"
        stroke="var(--rule)"
        transform="translate(.5 .5)"
      />
    </>
  ),
  deals: (u) => (
    <>
      <rect x="30" y="66" width="40" height="44" fill={u(8)} />
      <rect x="66" y="46" width="40" height="64" fill={u(8)} />
      <rect x="102" y="26" width="40" height="84" fill={u(8)} />
      <rect
        x="24.5"
        y="60.5"
        width="39"
        height="43"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="32" y="70" width="22" height="2" fill="var(--rule)" />
      <rect x="32" y="78" width="16" height="2" fill="var(--rule)" />
      <rect
        x="60.5"
        y="40.5"
        width="39"
        height="63"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="68" y="50" width="22" height="2" fill="var(--rule)" />
      <rect x="68" y="58" width="16" height="2" fill="var(--rule)" />
      <rect
        x="96.5"
        y="20.5"
        width="39"
        height="83"
        fill={u(12)}
        stroke="var(--hairline)"
      />
    </>
  ),
  companies: (u) => (
    <>
      <rect x="52" y="22" width="72" height="92" fill={u(8)} />
      <rect
        x="44.5"
        y="14.5"
        width="71"
        height="91"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="56" y="26" width="12" height="8" fill="var(--rule)" />
      <rect x="74" y="26" width="12" height="8" fill="var(--rule)" />
      <rect x="92" y="26" width="12" height="8" fill="var(--rule)" />
      <rect x="56" y="42" width="12" height="8" fill="var(--rule)" />
      <rect x="74" y="42" width="12" height="8" fill="var(--rule)" />
      <rect x="92" y="42" width="12" height="8" fill={u(12)} />
      <rect x="56" y="58" width="12" height="8" fill="var(--rule)" />
      <rect x="74" y="58" width="12" height="8" fill="var(--rule)" />
      <rect x="92" y="58" width="12" height="8" fill="var(--rule)" />
      <rect x="56" y="74" width="12" height="8" fill="var(--rule)" />
      <rect x="74" y="74" width="12" height="8" fill="var(--rule)" />
      <rect x="92" y="74" width="12" height="8" fill="var(--rule)" />
      <rect
        x="72.5"
        y="90.5"
        width="15"
        height="15"
        fill="var(--hairline)"
        stroke="var(--hairline)"
      />
    </>
  ),
  people: (u) => (
    <>
      <rect x="36" y="32" width="104" height="72" fill={u(8)} />
      <rect
        x="28.5"
        y="24.5"
        width="103"
        height="71"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <circle
        cx="58.5"
        cy="54.5"
        r="16"
        fill={u(12)}
        stroke="var(--hairline)"
      />
      <rect x="84" y="46" width="36" height="2" fill="var(--hairline)" />
      <rect x="84" y="56" width="30" height="2" fill="var(--rule)" />
      <rect x="84" y="64" width="24" height="2" fill="var(--rule)" />
      <rect x="40" y="82" width="80" height="2" fill="var(--rule)" />
    </>
  ),
  spaces: (u) => (
    <>
      <rect x="36" y="28" width="72" height="56" fill={u(8)} />
      <rect
        x="28.5"
        y="20.5"
        width="71"
        height="55"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect
        x="44.5"
        y="36.5"
        width="71"
        height="55"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="60" y="52" width="72" height="56" fill={u(4)} />
      <rect
        x="60.5"
        y="52.5"
        width="71"
        height="55"
        fill={u(12)}
        stroke="var(--hairline)"
      />
      <rect
        x="68.5"
        y="60.5"
        width="55"
        height="39"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="76" y="70" width="32" height="2" fill="var(--rule)" />
      <rect x="76" y="80" width="40" height="2" fill="var(--rule)" />
    </>
  ),
  feeds: (u) => (
    <>
      <rect x="36" y="36" width="88" height="80" fill={u(8)} />
      <rect
        x="28.5"
        y="28.5"
        width="87"
        height="79"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <rect x="38" y="40" width="14" height="14" fill={u(12)} />
      <rect x="58" y="42" width="44" height="2" fill="var(--hairline)" />
      <rect x="58" y="49" width="30" height="2" fill="var(--rule)" />
      <rect x="38" y="62" width="14" height="14" fill="var(--rule)" />
      <rect x="58" y="64" width="44" height="2" fill="var(--rule)" />
      <rect x="58" y="71" width="30" height="2" fill="var(--rule)" />
      <rect x="38" y="84" width="14" height="14" fill="var(--rule)" />
      <rect x="58" y="86" width="44" height="2" fill="var(--rule)" />
      <rect x="58" y="93" width="30" height="2" fill="var(--rule)" />
      <g
        fill="none"
        stroke="var(--hairline)"
        shapeRendering="geometricPrecision"
      >
        <path d="M122 30 a10 10 0 0 1 10 10" />
        <path d="M122 20 a20 20 0 0 1 20 20" />
      </g>
      <rect x="120" y="36" width="4" height="4" fill="var(--primary)" />
    </>
  ),
  email: (u) => (
    <>
      <rect x="36" y="38" width="104" height="68" fill={u(8)} />
      <path
        d="M28.5,30.5 L132.5,30.5 L132.5,98.5 L28.5,98.5 Z"
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      <path
        d="M28.5,30.5 L80.5,68.5 L132.5,30.5 Z"
        fill={u(12)}
        stroke="var(--hairline)"
      />
      <path
        d="M28.5 98.5 L66.5 58.5 M131.5 98.5 L93.5 58.5"
        stroke="var(--hairline)"
        fill="none"
        shapeRendering="geometricPrecision"
      />
    </>
  ),
}

/**
 * An empty page's picture: its kind's object, drawn in paper, ink and pine
 * dither. Decorative; the title under it says what is missing.
 */
export function DitherNoun({
  kind,
  className,
}: {
  kind: NounKind
  className?: string | undefined
}) {
  // Pattern ids are document-wide, so each drawing scopes its own.
  const id = useId()
  const u = (level: Level) => `url(#${id}-d${level})`
  return (
    <svg
      aria-hidden
      data-dither-noun={kind}
      width="160"
      height="120"
      viewBox="0 0 160 120"
      shapeRendering="crispEdges"
      className={cn('shrink-0', className)}
    >
      <defs>
        {LEVELS.map((level) => (
          <pattern
            key={level}
            id={`${id}-d${level}`}
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
          >
            {cellsFor(level).map(([x, y]) => (
              <rect
                key={`${x}-${y}`}
                x={x}
                y={y}
                width="2"
                height="2"
                fill="var(--primary)"
              />
            ))}
          </pattern>
        ))}
      </defs>
      {NOUNS[kind](u)}
    </svg>
  )
}
