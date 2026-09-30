/**
 * The architecture page's lead figure, as data: the three layers of a
 * Spaces install on one box. Ported from the Paper file "spaces", page
 * "Site · Landing", artboard "Stack — C · Layers"; positions are the
 * design's pixels on its 1200×760 mat.
 */

export const STACK = { name: 'mat', width: 1200, height: 760 } as const

export const BOX_LABEL = {
  label: 'Your box',
  note: 'a small server, or the machine under your desk',
}

export type Layer = {
  readonly id: string
  readonly eyebrow: string
  readonly title: string
  readonly body: string
  readonly y: number
  readonly h: number
}

export const AI_LAYER: Layer = {
  id: 'ai',
  eyebrow: 'AI · built into Spaces',
  title: 'Thinks with your book.',
  body: 'Drafts memos, answers with sources, suggests changes. Nothing lands until you accept it.',
  y: 88,
  h: 168,
}

export const SOCKETS_HEAD = {
  label: 'The model underneath · your choice',
  note: 'swap any time',
}

export type Socket = {
  readonly name: string
  readonly logo: string
  readonly note: string
  /** The local model: drawn on paper with an ink frame, its note in pine. */
  readonly local: boolean
}

export const SOCKETS: ReadonlyArray<Socket> = [
  { name: 'Claude', logo: 'claude.svg', note: 'your key', local: false },
  { name: 'OpenAI', logo: 'openai.svg', note: 'your key', local: false },
  { name: 'Gemini', logo: 'gemini.svg', note: 'your key', local: false },
  {
    name: 'OpenRouter',
    logo: 'openrouter.svg',
    note: 'your key',
    local: false,
  },
  { name: 'Ollama', logo: 'ollama.svg', note: '● on this box', local: true },
]

export const SPACES_LAYER: Layer = {
  id: 'spaces',
  eyebrow: 'Your spaces',
  title: 'The map you built.',
  body: 'Your markets, the companies in them, and everything you know about each one.',
  y: 292,
  h: 204,
}

export const MARKETS: ReadonlyArray<{
  readonly name: string
  readonly children: ReadonlyArray<string>
}> = [
  { name: 'Aerospace', children: ['Launch', 'Earth observation'] },
  { name: 'Compute', children: ['Thermal', 'Interconnect'] },
  { name: 'Energy', children: ['Storage', 'Grid software'] },
]

export const WATCHING = 'a market you’re watching'

export const CARRIES = {
  label: 'Every company carries',
  items: ['People', 'Deals', 'Notes', 'Documents', 'Calls', 'Your checks'],
}

export const PLUGINS_LAYER: Layer = {
  id: 'plugins',
  eyebrow: 'Plugins · what arrives',
  title: 'Your world, filed in.',
  body: 'Install from inside the app. Each one lands on the right company, never on its own island.',
  y: 532,
  h: 160,
}

export type PluginGroup = {
  readonly label: string
  readonly items: ReadonlyArray<{
    readonly name: string
    readonly logo?: string
  }>
}

export const PLUGIN_GROUPS: ReadonlyArray<PluginGroup> = [
  {
    label: 'Upload',
    items: [{ name: 'Files' }, { name: 'Email' }, { name: 'Sheets' }],
  },
  {
    label: 'Enrich',
    items: [
      { name: 'Apollo', logo: 'apollo.svg' },
      { name: 'Exa', logo: 'exa.png' },
    ],
  },
  {
    label: 'Mail',
    items: [
      { name: 'Gmail', logo: 'gmail.svg' },
      { name: 'Calendar', logo: 'google-calendar.svg' },
    ],
  },
  { label: 'Calls', items: [{ name: 'Fathom', logo: 'fathom.png' }] },
  {
    label: 'Folders',
    items: [
      { name: 'Drive', logo: 'google-drive.svg' },
      { name: 'Box', logo: 'box.svg' },
    ],
  },
  { label: 'Feeds', items: [{ name: 'Any RSS', logo: 'rss.svg' }] },
]

/** The joins between layers: a 1px ink line and a label on it. */
export const JOINS: ReadonlyArray<{
  readonly label: string
  readonly line: {
    readonly x: number
    readonly y1: number
    readonly y2: number
  }
  readonly box: { readonly x: number; readonly y: number; readonly w: number }
}> = [
  {
    label: '↑ reads it',
    line: { x: 560, y1: 256, y2: 292 },
    box: { x: 506, y: 263, w: 108 },
  },
  {
    label: '↓ suggests',
    line: { x: 740, y1: 256, y2: 292 },
    box: { x: 680, y: 263, w: 120 },
  },
  {
    label: '↑ files in',
    line: { x: 650, y1: 496, y2: 532 },
    box: { x: 590, y: 503, w: 120 },
  },
]
