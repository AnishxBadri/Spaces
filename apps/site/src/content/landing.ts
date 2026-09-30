/**
 * The landing page's copy and compositions, as data. The page is ported from
 * the Paper file "spaces", page "Site · Landing", artboard "Landing — revised";
 * every string here is the design's, and every number is a position in the
 * design's own pixels (the page is drawn at 1440 wide on a 1120 column, and
 * the orbit and the architecture stack at 1200). Every integration named here
 * ships; nothing on the site is labelled as coming later.
 */

// ---- fragments -----------------------------------------------------------

/**
 * The product pieces the page shows: tight crops of the real app, taken by
 * `pnpm screenshots` (apps/e2e/screenshots/capture.spec.ts, the FRAGMENTS
 * list) into docs/assets/screenshots/fragments/ and synced here by
 * src/integrations/sync-assets.ts. The names are shared with that list; the
 * page uses these six.
 */
export const FRAGMENT_NAMES = [
  'today-main',
  'today-portfolio',
  'deals-rows',
  'spaces-tree',
  'documents-rows',
  'portfolio-table',
] as const

export type FragmentName = (typeof FRAGMENT_NAMES)[number]

export const FRAGMENT_ALT: Readonly<Record<FragmentName, string>> = {
  'today-main':
    'Spaces open on Today: the sidebar, a readout of overdue tasks, idle deals and stale marks, the due list and the deals idle in their stage.',
  'today-portfolio':
    'The portfolio card on Today: invested, value and MOIC across twelve holdings.',
  'deals-rows':
    'Five rows of the deals table, each with its stage, check size and company.',
  'spaces-tree':
    'The market map: nested spaces with counts of companies, memos and glossary terms.',
  'documents-rows':
    'Five documents with their kind and the company each is filed against.',
  'portfolio-table':
    'Six holdings in the portfolio table with invested, current value, realized, ownership, MOIC and gross XIRR.',
}

// ---- geometry ------------------------------------------------------------

export type Rect = {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * A fixed-size composition in the design's pixels: a dither plate and what
 * sits on it. The plate is printed from these numbers (src/dither/stages.ts):
 * the dots gather toward `corner` and thin to nothing under every rect in
 * `clear`, so each card sits in its own light.
 */
export type Stage = {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly corner: 'tl' | 'tr' | 'bl' | 'br'
  readonly seed: number
  readonly clear: ReadonlyArray<Rect>
}

/**
 * A screenshot on a stage, in a frame. `w` is the outer width, frame and
 * padding included; `pad` is the paper drawn around the crop. `clip`, when
 * set, is the width of the crop that shows: the picture keeps its width `w`
 * would give it and is cut on the right.
 */
export type Shot = {
  readonly fragment: FragmentName
  readonly x: number
  readonly y: number
  readonly w: number
  readonly pad: number
  readonly clip?: { readonly show: number; readonly full: number }
}

// ---- nav and footer ------------------------------------------------------

export const RIBBON = {
  tag: 'v0.1.0',
  text: 'Spaces is open source. Run it on your own machine in five minutes.',
  cta: 'Get started →',
}

export const FOOTER_LINE = 'Spaces · the deal book you run yourself'

// ---- hero ----------------------------------------------------------------

export const HERO_COPY = {
  eyebrow: 'For angels and small funds · Open source',
  title: 'The deal book you run yourself.',
  sub: 'Every company you’ve looked at, what you thought of it, and what you own. On your own machine, read by the AI you choose.',
  primary: 'Self-host in 5 minutes',
  secondary: 'Star on GitHub ↗',
}

export const HERO_SHOTS: ReadonlyArray<Shot> = [
  { fragment: 'today-main', x: 170, y: 64, w: 780, pad: 0 },
  { fragment: 'today-portfolio', x: 820, y: 120, w: 300, pad: 0 },
  { fragment: 'deals-rows', x: 40, y: 420, w: 470, pad: 0 },
]

export const HERO: Stage = {
  name: 'hero',
  width: 1120,
  height: 600,
  corner: 'tl',
  seed: 11,
  clear: [
    { x: 170, y: 64, w: 780, h: 455 },
    { x: 820, y: 120, w: 300, h: 158 },
    { x: 40, y: 420, w: 470, h: 149 },
  ],
}

// ---- how it fits together: the orbit --------------------------------------

export const ORBIT_HEAD = {
  eyebrow: 'How it fits together',
  title: 'Everything orbits what you know.',
  body: 'A space is a market you follow: something you’d write a memo about and track companies in. The AI inside Spaces thinks with it. Your mail, calls, files and data sources file into it. All of it runs on a machine you own.',
}

/** The orbit's plate and size (src/dither/stages.ts prints the rings). */
export const ORBIT = { name: 'orbit', width: 1200, height: 840 } as const

export const SPACE_CARD = {
  parent: 'Compute ›',
  tag: 'A space',
  name: 'Thermal',
  companies: 'Himalaya Cooling, Coldplate Labs +7',
  memo: 'Why two-phase wins above 50 kW',
  terms: ['PUE', 'Rack density', 'Two-phase'],
  deal: 'Himalaya Cooling, Seed',
  dealStage: 'Diligence',
  inside: ['Immersion', 'Cold plates'],
  add: '+ subspace',
}

/** A tile on a ring, at its top-left corner in the orbit's pixels. */
export type Tile = {
  readonly label: string
  /** A file in public/logos/, synced from docs/assets/logos. */
  readonly logo?: string
  readonly x: number
  readonly y: number
  readonly w: number
}

export const AI_RING = { label: 'AI · built into Spaces', x: 490, y: 166 }

export const MODELS: ReadonlyArray<Tile> = [
  { label: 'Claude', logo: 'claude.svg', x: 368, y: 234, w: 124 },
  { label: 'OpenAI', logo: 'openai.svg', x: 708, y: 234, w: 124 },
  { label: 'Gemini', logo: 'gemini.svg', x: 368, y: 574, w: 124 },
  { label: 'OpenRouter', logo: 'openrouter.svg', x: 708, y: 574, w: 124 },
]

export const LOCAL_MODEL = {
  label: 'Ollama',
  logo: 'ollama.svg',
  note: '● runs on this box',
  x: 510,
  y: 638,
  w: 180,
}

export const DOES: ReadonlyArray<Tile> = [
  { label: 'drafts memos', x: 296, y: 409, w: 118 },
  { label: 'answers, cited', x: 786, y: 409, w: 118 },
]

export const BOX_RING = {
  label: 'Your box',
  note: 'everything below runs here',
  x: 500,
  y: 34,
}

export const PLUGINS: ReadonlyArray<Tile> = [
  { label: 'Apollo', logo: 'apollo.svg', x: 235, y: 193, w: 124 },
  { label: 'Exa', logo: 'exa.png', x: 174, y: 341, w: 124 },
  { label: 'Gmail', logo: 'gmail.svg', x: 174, y: 469, w: 124 },
  {
    label: 'Google Calendar',
    logo: 'google-calendar.svg',
    x: 222,
    y: 617,
    w: 150,
  },
  { label: 'Fathom', logo: 'fathom.png', x: 841, y: 193, w: 124 },
  { label: 'Google Drive', logo: 'google-drive.svg', x: 895, y: 341, w: 138 },
  { label: 'Box', logo: 'box.svg', x: 902, y: 469, w: 124 },
  { label: 'Any RSS feed', logo: 'rss.svg', x: 841, y: 617, w: 124 },
  { label: 'Any file', x: 418, y: 753, w: 110 },
  { label: 'Spreadsheets', x: 540, y: 777, w: 120 },
  { label: 'Forwarded mail', x: 672, y: 753, w: 110 },
]

// ---- the lifecycle -------------------------------------------------------

export type ResearchDetail = {
  readonly kind: 'research'
  readonly memo: Rect & {
    readonly filed: string
    readonly space: string
    readonly title: string
    readonly body: string
    readonly before: string
    readonly term: string
    readonly after: string
    readonly links: ReadonlyArray<string>
  }
  readonly glossary: Rect & {
    readonly term: string
    readonly where: string
    readonly body: string
  }
}

export type ScreenDetail = {
  readonly kind: 'screen'
  readonly card: Rect & {
    readonly company: string
    readonly label: string
    readonly rows: ReadonlyArray<{
      readonly date: string
      readonly stage: string
      readonly tone: 'slate' | 'blue'
      readonly note: string
      /** A quoted pass reason, set in italic serif. */
      readonly quote: boolean
    }>
  }
}

export type DecideDetail = {
  readonly kind: 'decide'
  readonly card: Rect & {
    readonly asked: string
    readonly model: string
    readonly question: string
    readonly answer: string
    readonly sources: ReadonlyArray<string>
    readonly foot: string
    readonly accept: string
    readonly dismiss: string
  }
}

export type OwnDetail = {
  readonly kind: 'own'
  readonly card: Rect & {
    readonly name: string
    readonly label: string
    readonly readout: ReadonlyArray<{
      readonly label: string
      readonly value: string
    }>
    readonly ledger: ReadonlyArray<{
      readonly date: string
      readonly kind: string
      readonly note: string
      readonly amount: string
      /** The voided mark: struck through, in graphite. */
      readonly voided: boolean
    }>
  }
}

export type Detail = ResearchDetail | ScreenDetail | DecideDetail | OwnDetail

export type Chapter = {
  readonly id: string
  readonly eyebrow: string
  readonly title: string
  readonly body: string
  readonly proof: ReadonlyArray<string>
  readonly stage: Stage
  readonly shot: Shot
  readonly detail: Detail
}

export const CHAPTERS: ReadonlyArray<Chapter> = [
  {
    id: 'research',
    eyebrow: '01 Research',
    title: 'Your market map, compounding.',
    body: 'Each space is a market you follow. Companies, memos and glossary terms file into it long before a deal exists, so the thinking is already there when a founder writes.',
    proof: [
      'Nest markets as deep as the thesis goes',
      'A company can sit in several spaces at once',
      'Glossary terms light up in every note',
    ],
    stage: {
      name: 'research',
      width: 680,
      height: 460,
      corner: 'br',
      seed: 3,
      clear: [
        { x: 24, y: 28, w: 402, h: 289 },
        { x: 298, y: 176, w: 356, h: 239 },
        { x: 470, y: 100, w: 196, h: 87 },
      ],
    },
    // The map crop's right column is cut off by the capture; the frame
    // shows the first 372px of a 406px-wide picture.
    shot: {
      fragment: 'spaces-tree',
      x: 24,
      y: 28,
      w: 402,
      pad: 14,
      clip: { show: 372, full: 406 },
    },
    detail: {
      kind: 'research',
      memo: {
        x: 298,
        y: 176,
        w: 356,
        h: 239,
        filed: 'Memo · filed in',
        space: 'Aerospace › Launch',
        title: 'Why small-lift, and why now',
        body: 'The rideshare manifest is full, and the payloads that miss it are the ones with an orbit requirement. That is the whole thesis.',
        before: 'It works if the',
        term: 'methalox',
        after: 'stage relights.',
        links: ['↗ Vayu Orbital', '↗ Kalpana Systems'],
      },
      glossary: {
        x: 470,
        y: 100,
        w: 196,
        h: 87,
        term: 'Methalox',
        where: 'term · Launch',
        body: 'Liquid methane and liquid oxygen. A cleaner burn that makes an engine reusable.',
      },
    },
  },
  {
    id: 'screen',
    eyebrow: '02 Screen',
    title: 'Every deal remembers how it went.',
    body: 'Deals move through stages you define, and a pass stays a pass, with the reason. When a company comes back a year later, you land on what you thought last time.',
    proof: [
      'Stages you define, history kept for you',
      'Passed and lost stay apart, with the reason',
      'Duplicates found and merged, nothing lost',
    ],
    stage: {
      name: 'screen',
      width: 680,
      height: 460,
      corner: 'tr',
      seed: 5,
      clear: [
        { x: 24, y: 28, w: 550, h: 195 },
        { x: 212, y: 226, w: 448, h: 122 },
      ],
    },
    shot: { fragment: 'deals-rows', x: 24, y: 28, w: 550, pad: 14 },
    detail: {
      kind: 'screen',
      card: {
        x: 212,
        y: 226,
        w: 448,
        h: 122,
        company: 'Himalaya Cooling',
        label: 'Deal history',
        rows: [
          {
            date: '2025-03-12',
            stage: 'Passed',
            tone: 'slate',
            note: '“Too early. Revisit at Series A.”',
            quote: true,
          },
          {
            date: '2026-09-02',
            stage: 'Diligence',
            tone: 'blue',
            note: 'Back for a Seed. Your old note is here.',
            quote: false,
          },
        ],
      },
    },
  },
  {
    id: 'decide',
    eyebrow: '03 Decide',
    title: 'Everything that arrives, read.',
    body: 'Decks, term sheets, cap tables, diligence packs and forwarded intros land on the company they’re about. Search what they say, and let your AI draft from them. It suggests; you decide.',
    proof: [
      'PDF, Word, PowerPoint and Excel, read in full',
      'One search across names, notes and files',
      'AI answers with sources; you accept or dismiss',
    ],
    stage: {
      name: 'decide',
      width: 680,
      height: 460,
      corner: 'bl',
      seed: 7,
      clear: [
        { x: 24, y: 28, w: 570, h: 210 },
        { x: 196, y: 248, w: 464, h: 212 },
      ],
    },
    shot: { fragment: 'documents-rows', x: 24, y: 28, w: 570, pad: 14 },
    detail: {
      kind: 'decide',
      card: {
        x: 196,
        y: 248,
        w: 464,
        h: 212,
        asked: 'Asked on Trishul Defence Systems',
        model: 'Claude · your key',
        question: 'What does the term sheet say about pro-rata?',
        answer:
          'A pro-rata right on the next two rounds, capped at one and a half times your first check.',
        sources: ['trishul-term-sheet-draft · §4', 'call notes · 09-18'],
        foot: 'A suggestion. You decide.',
        accept: 'Add to deal notes',
        dismiss: 'Dismiss',
      },
    },
  },
  {
    id: 'own',
    eyebrow: '04 Own',
    title: 'What you own, honestly.',
    body: 'Checks, marks and distributions go into a ledger you never overwrite. What you put in, what it’s worth and what came back, as of any date.',
    proof: [
      'Invested, value, MOIC and IRR, always current',
      'Corrections are new entries, never edits',
      'Any currency, rolled up into yours',
    ],
    stage: {
      name: 'own',
      width: 680,
      height: 460,
      corner: 'tl',
      seed: 13,
      clear: [
        { x: 24, y: 20, w: 590, h: 185 },
        { x: 196, y: 200, w: 464, h: 234 },
      ],
    },
    shot: { fragment: 'portfolio-table', x: 24, y: 20, w: 590, pad: 14 },
    detail: {
      kind: 'own',
      card: {
        x: 196,
        y: 200,
        w: 464,
        h: 234,
        name: 'Vayu Orbital',
        label: 'Holding · as of today',
        readout: [
          { label: 'Invested', value: '$650K' },
          { label: 'Value', value: '$1.9M' },
          { label: 'MOIC', value: '2.92×' },
        ],
        ledger: [
          {
            date: '2024-02-14',
            kind: 'Invest',
            note: 'Seed check',
            amount: '$650,000',
            voided: false,
          },
          {
            date: '2025-11-20',
            kind: 'Mark',
            note: 'Series A price, wrong round',
            amount: '$1,450,000',
            voided: true,
          },
          {
            date: '2025-11-21',
            kind: 'Corrects',
            note: 'Voids the mark above',
            amount: '−$1,450,000',
            voided: false,
          },
          {
            date: '2026-06-30',
            kind: 'Mark',
            note: 'Series B price',
            amount: '$1,900,000',
            voided: false,
          },
        ],
      },
    },
  },
]

// ---- closing -------------------------------------------------------------

export const CLOSING: Stage = {
  name: 'closing',
  width: 1120,
  height: 440,
  corner: 'br',
  seed: 29,
  clear: [{ x: 210, y: 60, w: 700, h: 309 }],
}

export const CLOSING_COPY = {
  title: 'Two containers. One backup. Yours.',
  // As the design sets it: the compose file's URL is elided to fit the card,
  // and the guide it links to spells it out.
  install: [
    'mkdir spaces && cd spaces',
    'curl -fsSLO …/docker-compose.yml',
    'docker compose up -d',
    'docker compose logs app | grep "setup token"',
  ],
  primary: 'Self-host in 5 minutes',
  secondary: 'Read the guide',
}

/** Every plate-bearing stage on the landing page, for src/dither/stages.ts. */
export const STAGES: ReadonlyArray<Stage> = [
  HERO,
  ...CHAPTERS.map((c) => c.stage),
  CLOSING,
]
