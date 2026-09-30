import type { Screenshot } from '../integrations/sync-assets'

/**
 * The landing page's copy, as data. Every claim here is drawn from
 * docs/ARCHITECTURE.md or CONTEXT.md and describes what ships in 0.1.0;
 * anything unbuilt belongs in NEXT, labelled as such.
 */

export type Feature = {
  id: string
  label: string
  title: string
  body: ReadonlyArray<string>
  facts: ReadonlyArray<string>
  shot: Screenshot
  alt: string
  caption: string
}

export const FEATURES: ReadonlyArray<Feature> = [
  {
    id: 'pipeline',
    label: 'Pipeline and deals',
    title: 'One deal is one round in one company.',
    body: [
      'A deal is born pre-lead when something arrives, moves through stages you edit, and closes as Invested, Passed or Lost. Passed is your no and Lost is theirs, and the record keeps the difference.',
      'Stage history and time-in-stage come from the attribute event log, so nobody maintains them by hand. A deal that reaches Invested opens a holding in the portfolio.',
    ],
    facts: ['table or board', 'parked group', 'mandate hint'],
    shot: 'deals',
    alt: 'The deals table in Spaces, grouped by stage.',
    caption: 'Deals, the pipeline as a table',
  },
  {
    id: 'records',
    label: 'Records and attributes',
    title: 'Companies, people, deals, and objects you define.',
    body: [
      'Add attributes from a fixed menu of fifteen types, from currency and status to rating and record reference. Every value goes through one write path that validates it, logs the change and links referenced records in the same transaction.',
      'Custom objects get the same engine, with fuzzy-name dedupe and merge. Merges keep a full snapshot of what they replaced.',
    ],
    facts: ['15 attribute types', 'custom objects', 'saved views'],
    shot: 'settings-objects',
    alt: 'Object settings in Spaces, listing the attributes on an object.',
    caption: 'Settings, objects and their attributes',
  },
  {
    id: 'notes',
    label: 'Notes with context',
    title: 'The research is already there when the deal arrives.',
    body: [
      'Notes and memos are block documents. Typing [[Orbital Composites]] writes a link, so every company lists the notes that mention it.',
      'Glossary terms defined on a space are marked in every note filed under it. Notes are shared by default, and private is one click for the author.',
    ],
    facts: ['backlinks', 'glossary per space', 'memo templates'],
    shot: 'note',
    alt: 'A memo in Spaces with a linked company and glossary terms marked.',
    caption: 'A memo, with its links and glossary',
  },
  {
    id: 'documents',
    label: 'Documents and search',
    title: 'Upload a deck and search what it says.',
    body: [
      'PDF, DOCX, PPTX and XLSX files are hashed in the browser, stored by content hash and read on the worker. Previews draw in the page and downloads stay downloads.',
      'One Cmd-K search covers names with typo tolerance, note bodies and document text, ranked together in a single Postgres query. Add an embedding model and semantic matches join the same ranking.',
    ],
    facts: ['⌘K', 'pdf · docx · pptx · xlsx', 'pgvector'],
    shot: 'documents',
    alt: 'The documents list in Spaces with extracted text previews.',
    caption: 'Documents, filed and extracted',
  },
  {
    id: 'portfolio',
    label: 'Portfolio ledger',
    title: 'A ledger that never edits history.',
    body: [
      'Investments, marks and distributions are dated events. Cost basis, unrealized value, MOIC, TVPI, DPI and gross XIRR are computed from them on every read, for any as-of date.',
      'A correction appends a reversing event instead of changing the original, so a view dated before the fix still shows what you believed then. A post-money SAFE shows implied ownership from its cap. A pre-money SAFE shows cost basis until it converts, and no invented percentage.',
    ],
    facts: ['append-only', 'as-of any date', 'multi-currency'],
    shot: 'portfolio',
    alt: 'The portfolio table in Spaces with invested, value, MOIC and last mark columns.',
    caption: 'Portfolio, every figure derived',
  },
  {
    id: 'spaces',
    label: 'Spaces',
    title: 'A market map you build and own.',
    body: [
      'Spaces are your own taxonomy of markets, nested as deep as you need. A company can sit in several; a memo files under one.',
      'Save a space as a template and stamp the same breakdown onto the next market. The seed is tiny on purpose. The ontology is yours.',
    ],
    facts: ['nested', 'many-to-many tags', 'space templates'],
    shot: 'spaces',
    alt: 'The spaces tree in Spaces with nested markets.',
    caption: 'Spaces, the taxonomy',
  },
  {
    id: 'ai',
    label: 'Bring your own key',
    title: 'Your key, or your own model.',
    body: [
      'Anthropic, OpenAI, Google, OpenRouter or a local Ollama. Keys are encrypted at rest under a master key that stays on your box, and you choose which model does which job.',
      'Every model output lands as a suggestion that a person accepts or rejects. A rejection is remembered, so the same thing is not proposed twice.',
    ],
    facts: ['5 providers', 'encrypted vault', 'suggestions only'],
    shot: 'settings-ai',
    alt: 'AI settings in Spaces listing configured providers.',
    caption: 'Settings, AI providers',
  },
  {
    id: 'import',
    label: 'Import',
    title: 'Start from the spreadsheet you already keep.',
    body: [
      'Upload a CSV or XLSX, map its columns onto your attributes, and see how each row resolves against the records you have before anything is written.',
      'Errors are reported per row and never sink the whole file. A file you imported before is flagged before you commit it twice.',
    ],
    facts: ['csv · tsv · xlsx', 'resolve preview', 'per-row errors'],
    shot: 'import',
    alt: 'The import wizard in Spaces mapping spreadsheet columns to attributes.',
    caption: 'Import, columns mapped to attributes',
  },
]

export type Reason = { n: string; title: string; body: string }

/** CONTEXT.md, "Why self-host wins here". */
export const WHY: ReadonlyArray<Reason> = [
  {
    n: '01',
    title: 'Deal terms stay in-house.',
    body: "Funds won't put deal terms, decks and cap tables in someone else's SaaS. Spaces runs in two containers on a machine you control, and it phones nobody home.",
  },
  {
    n: '02',
    title: 'Decks stay off third-party APIs.',
    body: 'Point the AI at Ollama and a confidential deck is read by a model on your own hardware. Flag a space or a document sensitive and its work goes to the local model, whatever the task.',
  },
  {
    n: '03',
    title: 'No lock-in.',
    body: 'The schema is plain Postgres and the code is AGPL-3.0. A backup is one pg_dump and one tar of ./data, and it holds everything you would take with you.',
  },
]

export type Next = { name: string; body: string }

/** In progress, not in 0.1.0 (docs/roadmap-2026-09.md). */
export const NEXT: ReadonlyArray<Next> = [
  {
    name: 'Plugin SDK',
    body: 'Integrations installed from the running app into ./data/plugins, run by the worker only.',
  },
  {
    name: 'Enrichment',
    body: 'Company and person data from your own Apollo key, proposed as suggestions.',
  },
  {
    name: 'Gmail and Calendar sync',
    body: 'Mail and meetings matched to the people and companies you track.',
  },
  {
    name: 'Drive and Box',
    body: 'Bind a folder as a storage source and search it without copying its bytes.',
  },
  {
    name: 'Data room',
    body: "A bound data room: a company's shared folder, searchable in place.",
  },
]
