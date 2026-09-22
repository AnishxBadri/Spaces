import { createHash, randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import type { ActivityMeta } from '@spaces/db/schema/activity'
import type { NoteBody } from '@spaces/db/schema/kinds'
import type { Condition, ViewExtra } from '@spaces/core/views/filter'
import {
  account,
  activity,
  attribute,
  attributeEvent,
  distribution,
  document,
  entity,
  entitySpace,
  fxRate,
  holding,
  interaction,
  interactionEntity,
  investment,
  link,
  mandate,
  mark,
  note,
  objectDef,
  round,
  roundCoInvestor,
  space,
  task,
  taskEntity,
  template,
  term,
  user,
  view,
} from '@spaces/db/schema'
import { createAttributeProgram } from '#/lib/attributes/create'
import { birthValues } from '#/lib/attributes/defaults'
import {
  createObjectProgram,
  createRecordProgram,
} from '#/lib/attributes/object-registry'
import { objectIdForKindAsync } from '#/lib/attributes/objects'
import { getRegistry, setValues } from '#/lib/attributes/values'
import { resolveEntity } from '#/lib/entities/resolve'
import { storage } from '#/lib/storage'
import type { ObjectKind } from '@spaces/core/attributes/registry'

/**
 * Dev fixtures — a whole working fund, so every surface has something on it.
 *
 * Distinct from `demo.ts`, which is the operator-facing worked example
 * offered at setup: deliberately tiny, obviously fictional, one seam. This
 * is the developer's bench — pipeline at every stage with real stage
 * history, a portfolio with marks that have gone stale, dedupe candidates,
 * private notes, a second member, documents in every extraction state,
 * currencies with and without an fx rate. Nothing here is offered in the UI.
 *
 * Every company, person, and number is invented. Real firms are avoided on
 * purpose: fabricated valuations should not attach to real names, even in a
 * local database.
 *
 * Writes go through the same choke points as the app — `resolveEntity` for
 * identity, `setValues`/`birthValues` for attribute values — so the
 * fixtures exercise the real rules (dedupe sweeps, attribute events,
 * reference links) rather than faking their output. The exceptions are
 * deliberate and local: `entity.created_at`, `activity.at`, and stage
 * `attribute_event.at` are backdated afterwards, because a bench needs
 * history and the write paths only ever stamp now.
 */

const DAY = 86_400_000
const NOW = new Date()

/** ISO date `days` before the run — dates are strings, compared lexically. */
function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString().slice(0, 10)
}

/** A timestamp `days` back, spread through the working day. */
function at(days: number, hour = 10): Date {
  const d = new Date(NOW.getTime() - days * DAY)
  d.setHours(hour, (days * 7) % 60, 0, 0)
  return d
}

/** Deterministic jitter — a re-run lands the same fixtures on the same days. */
function wobble(n: number, span: number): number {
  return Math.abs(Math.sin(n * 12.9898) * 43758.5453) % span
}

type Ids = Map<string, string>

const registryCache = new Map<ObjectKind, Set<string>>()

/**
 * Drop slugs the workspace doesn't have. The operator may have archived or
 * renamed a system attribute long before running this; a fixture dying on
 * their vocabulary is a worse outcome than a thinner fixture.
 */
async function known(
  kind: ObjectKind,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let slugs = registryCache.get(kind)
  if (!slugs) {
    slugs = new Set((await getRegistry(kind)).map((d) => d.slug))
    registryCache.set(kind, slugs)
  }
  const live = slugs
  return Object.fromEntries(
    Object.entries(values).filter(([slug]) => live.has(slug)),
  )
}

/**
 * Backdate a birth and mark where the row came from. The record's birth
 * attribute events move with it — otherwise every company's timeline opens
 * with a burst of edits dated the moment the seed ran.
 */
async function stamp(entityId: string, when: Date): Promise<void> {
  await db
    .update(entity)
    .set({ createdAt: when, sourceClass: 'seed' })
    .where(eq(entity.id, entityId))
  await db
    .update(attributeEvent)
    .set({ at: when })
    .where(eq(attributeEvent.entityId, entityId))
}

async function logActivity(opts: {
  verb: string
  subject: string
  object?: string | undefined
  actorId: string | null
  when: Date
  meta?: ActivityMeta
}): Promise<void> {
  await db.insert(activity).values({
    actorId: opts.actorId,
    verb: opts.verb,
    subjectEntityId: opts.subject,
    objectEntityId: opts.object,
    meta: opts.meta ?? {},
    at: opts.when,
  })
}

/** BlockNote paragraphs from plain prose — the shape the editor round-trips. */
function blocks(md: string): NoteBody {
  return md.split('\n\n').map((para) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: para, styles: {} }],
  }))
}

// ---------------------------------------------------------------------------
// The fixture itself — DELTA, a fictional India-first deeptech angel book.
// ---------------------------------------------------------------------------

type SpaceNode = { slug: string; name: string; children?: Array<SpaceNode> }

const SPACES: Array<SpaceNode> = [
  {
    slug: 'aerospace',
    name: 'Aerospace',
    children: [
      { slug: 'launch', name: 'Launch' },
      { slug: 'earth_observation', name: 'Earth observation' },
      { slug: 'in_space_manufacturing', name: 'In-space manufacturing' },
      { slug: 'ground_systems', name: 'Ground systems' },
    ],
  },
  {
    slug: 'defence_autonomy',
    name: 'Defence autonomy',
    children: [
      { slug: 'uas', name: 'UAS' },
      { slug: 'c4isr', name: 'C4ISR' },
    ],
  },
  {
    slug: 'compute',
    name: 'Compute',
    children: [
      { slug: 'interconnect', name: 'Interconnect' },
      { slug: 'thermal', name: 'Thermal' },
      { slug: 'edge', name: 'Edge' },
    ],
  },
  {
    slug: 'energy',
    name: 'Energy',
    children: [
      { slug: 'storage', name: 'Storage' },
      { slug: 'grid_software', name: 'Grid software' },
    ],
  },
  {
    slug: 'fintech',
    name: 'Fintech',
    children: [
      { slug: 'lending_infra', name: 'Lending infrastructure' },
      { slug: 'wealth', name: 'Wealth' },
    ],
  },
  {
    slug: 'health',
    name: 'Health',
    children: [{ slug: 'diagnostics', name: 'Diagnostics' }],
  },
  {
    slug: 'industrial',
    name: 'Industrial',
    children: [
      { slug: 'robotics', name: 'Robotics' },
      { slug: 'photonics', name: 'Photonics' },
      { slug: 'materials', name: 'Materials' },
    ],
  },
]

type CompanySpec = {
  name: string
  domain: string
  space: string
  added: number
  values: Record<string, unknown>
}

const COMPANIES: Array<CompanySpec> = [
  {
    name: 'Vayu Orbital',
    domain: 'vayuorbital.com',
    space: 'aerospace.launch',
    added: 760,
    values: {
      description:
        'Small-lift launch vehicle, 300kg to SSO, methalox upper stage.',
      funding_stage: 'series_a',
      location: 'Chennai',
      founded_year: 2019,
      business_model: ['b2b', 'deep_tech', 'hardware'],
      linkedin: 'https://linkedin.com/company/vayu-orbital',
    },
  },
  {
    name: 'Kalpana Systems',
    domain: 'kalpanasystems.in',
    space: 'aerospace.earth_observation',
    added: 690,
    values: {
      description: 'Hyperspectral smallsats for crop and mineral analytics.',
      funding_stage: 'series_a',
      location: 'Bengaluru',
      founded_year: 2020,
      business_model: ['b2b', 'deep_tech'],
    },
  },
  {
    name: 'Antariksh Labs',
    domain: 'antariksh.space',
    space: 'aerospace.in_space_manufacturing',
    added: 410,
    values: {
      description: 'Microgravity fibre-drawing payloads flown on rideshare.',
      funding_stage: 'seed',
      location: 'Hyderabad',
      founded_year: 2021,
      business_model: ['b2b', 'deep_tech'],
    },
  },
  {
    name: 'Nakshatra Ground',
    domain: 'nakshatraground.com',
    space: 'aerospace.ground_systems',
    added: 520,
    values: {
      description: 'Ground-station-as-a-service across six Indian sites.',
      funding_stage: 'seed',
      location: 'Pune',
      founded_year: 2020,
      business_model: ['b2b', 'services'],
    },
  },
  {
    name: 'Dhruva Navigation',
    domain: 'dhruvanav.com',
    space: 'aerospace.ground_systems',
    added: 180,
    values: {
      description: 'GNSS correction network for precision agriculture.',
      funding_stage: 'pre_seed',
      location: 'Ahmedabad',
      founded_year: 2023,
      business_model: ['b2b'],
    },
  },
  {
    name: 'Garuda Autonomy',
    domain: 'garudaautonomy.com',
    space: 'defence_autonomy.uas',
    added: 640,
    values: {
      description: 'Autonomy stack for tactical UAS; GPS-denied navigation.',
      funding_stage: 'series_b_plus',
      location: 'Bengaluru',
      founded_year: 2018,
      business_model: ['b2b', 'deep_tech'],
    },
  },
  {
    name: 'Trishul Defence Systems',
    domain: 'trishuldefence.in',
    space: 'defence_autonomy.c4isr',
    added: 300,
    values: {
      description: 'Battlefield management software for mechanised units.',
      funding_stage: 'seed',
      location: 'Pune',
      founded_year: 2021,
      business_model: ['b2b'],
    },
  },
  {
    name: 'Sentinel Mesh',
    domain: 'sentinelmesh.io',
    space: 'defence_autonomy.c4isr',
    added: 150,
    values: {
      description: 'Mesh radios that hold a link when the tower is gone.',
      funding_stage: 'pre_seed',
      location: 'Gurugram',
      founded_year: 2023,
      business_model: ['b2b', 'hardware'],
    },
  },
  {
    name: 'Shakti Compute',
    domain: 'shakticompute.com',
    space: 'compute.interconnect',
    added: 580,
    values: {
      description: 'Optical interconnect for rack-scale accelerator clusters.',
      funding_stage: 'series_a',
      location: 'Bengaluru',
      founded_year: 2019,
      business_model: ['b2b', 'deep_tech', 'hardware'],
    },
  },
  {
    name: 'Himalaya Cooling',
    domain: 'himalayacooling.com',
    space: 'compute.thermal',
    added: 800,
    values: {
      description: 'Single-phase immersion cooling for 40kW+ racks.',
      funding_stage: 'seed',
      location: 'Noida',
      founded_year: 2018,
      business_model: ['b2b', 'hardware'],
    },
  },
  {
    name: 'Meghdoot Edge',
    domain: 'meghdootedge.com',
    space: 'compute.edge',
    added: 430,
    values: {
      description: 'Edge inference boxes for retail and industrial floors.',
      funding_stage: 'seed',
      location: 'Singapore',
      founded_year: 2020,
      business_model: ['b2b', 'hardware'],
    },
  },
  {
    name: 'Surya Cells',
    domain: 'suryacells.in',
    space: 'energy.storage',
    added: 470,
    values: {
      description:
        'Sodium-ion cells for stationary storage; no lithium supply risk.',
      funding_stage: 'series_a',
      location: 'Vadodara',
      founded_year: 2019,
      business_model: ['b2b', 'deep_tech', 'hardware'],
    },
  },
  {
    name: 'Anant Storage',
    domain: 'anantstorage.com',
    space: 'energy.storage',
    added: 210,
    values: {
      description: 'Flow batteries for eight-hour grid discharge.',
      funding_stage: 'seed',
      location: 'Chennai',
      founded_year: 2021,
      business_model: ['b2b', 'hardware'],
    },
  },
  {
    name: 'Ohm Grid',
    domain: 'ohmgrid.io',
    space: 'energy.grid_software',
    added: 260,
    values: {
      description: 'Forecasting and dispatch software for discoms.',
      funding_stage: 'seed',
      location: 'Bengaluru',
      founded_year: 2021,
      business_model: ['b2b'],
    },
  },
  {
    name: 'Rupaya Rails',
    domain: 'rupayarails.com',
    space: 'fintech.lending_infra',
    added: 540,
    values: {
      description: 'Loan-management-system API for NBFCs and co-lending.',
      funding_stage: 'series_a',
      location: 'Mumbai',
      founded_year: 2019,
      business_model: ['b2b', 'b2b2c'],
    },
  },
  {
    name: 'Kosh Wealth',
    domain: 'koshwealth.com',
    space: 'fintech.wealth',
    added: 330,
    values: {
      description: 'Advisory platform for first-generation equity holders.',
      funding_stage: 'seed',
      location: 'Mumbai',
      founded_year: 2021,
      business_model: ['b2c', 'marketplace'],
    },
  },
  {
    name: 'Khata Ledger',
    domain: 'khataledger.com',
    space: 'fintech.lending_infra',
    added: 120,
    values: {
      description: 'Cash-flow underwriting from GST and bank-statement data.',
      funding_stage: 'pre_seed',
      location: 'Jaipur',
      founded_year: 2023,
      business_model: ['b2b'],
    },
  },
  {
    name: 'Aarogya Diagnostics',
    domain: 'aarogyadx.com',
    space: 'health.diagnostics',
    added: 900,
    values: {
      description: 'Point-of-care immunoassay readers for tier-3 towns.',
      funding_stage: 'series_b_plus',
      location: 'Hyderabad',
      founded_year: 2017,
      business_model: ['b2b2c', 'hardware'],
    },
  },
  {
    name: 'Nadi Bio',
    domain: 'nadibio.com',
    space: 'health.diagnostics',
    added: 240,
    values: {
      description: 'Cell-free DNA assays for early cancer screening.',
      funding_stage: 'seed',
      location: 'Bengaluru',
      founded_year: 2022,
      business_model: ['b2b2c', 'deep_tech'],
    },
  },
  {
    name: 'Chakra Robotics',
    domain: 'chakrarobotics.com',
    space: 'industrial.robotics',
    added: 610,
    values: {
      description: 'Mobile manipulators for European contract manufacturers.',
      funding_stage: 'series_a',
      location: 'Berlin',
      founded_year: 2019,
      business_model: ['b2b', 'hardware'],
    },
  },
  {
    name: 'Bharat Photonics',
    domain: 'bharatphotonics.com',
    space: 'industrial.photonics',
    added: 350,
    values: {
      description: 'Fibre lasers for domestic sheet-metal cutting.',
      funding_stage: 'seed',
      location: 'Coimbatore',
      founded_year: 2020,
      business_model: ['b2b', 'hardware'],
    },
  },
  {
    name: 'Silicon Ghat',
    domain: 'siliconghat.com',
    space: 'industrial.materials',
    added: 700,
    values: {
      description: 'Analog RF front-ends on a domestic fab-lite model.',
      funding_stage: 'series_a',
      location: 'Bengaluru',
      founded_year: 2018,
      business_model: ['b2b', 'deep_tech'],
    },
  },
  {
    name: 'Astra Materials',
    domain: 'astramaterials.com',
    space: 'industrial.materials',
    added: 190,
    values: {
      description: 'Ceramic matrix composites for hot-section components.',
      funding_stage: 'pre_seed',
      location: 'Nagpur',
      founded_year: 2022,
      business_model: ['b2b', 'deep_tech'],
    },
  },
  {
    name: 'Vidyut Motors',
    domain: 'vidyutmotors.in',
    space: 'industrial.robotics',
    added: 280,
    values: {
      description: 'Axial-flux motors for light commercial EVs.',
      funding_stage: 'seed',
      location: 'Pune',
      founded_year: 2020,
      business_model: ['b2b', 'hardware'],
    },
  },
  {
    name: 'Neel Quantum',
    domain: 'neelquantum.com',
    space: 'compute.interconnect',
    added: 95,
    values: {
      description: 'Room-temperature photonic qubits. Claims outrun the data.',
      funding_stage: 'pre_seed',
      location: 'Kolkata',
      founded_year: 2023,
      business_model: ['deep_tech'],
    },
  },
  {
    name: 'Pravah Analytics',
    domain: 'pravahanalytics.com',
    space: 'energy.grid_software',
    added: 165,
    values: {
      description: 'Water-network leak detection from pressure telemetry.',
      funding_stage: 'seed',
      location: 'Indore',
      founded_year: 2021,
      business_model: ['b2b', 'services'],
    },
  },
  {
    name: 'Jal Systems',
    domain: 'jalsystems.in',
    space: 'energy.grid_software',
    added: 88,
    values: {
      description: 'Desalination pretreatment membranes, pilot stage.',
      funding_stage: 'pre_seed',
      location: 'Bhuj',
      founded_year: 2023,
      business_model: ['b2b', 'hardware'],
    },
  },
  {
    name: 'Mrida Agritech',
    domain: 'mridaagritech.com',
    space: 'health',
    added: 145,
    values: {
      description: 'Soil-carbon measurement for compliance markets.',
      funding_stage: 'seed',
      location: 'Bhopal',
      founded_year: 2021,
      business_model: ['b2b', 'services'],
    },
  },
  {
    name: 'Samudra Marine Tech',
    domain: 'samudramarine.com',
    space: 'defence_autonomy.uas',
    added: 75,
    values: {
      description: 'Uncrewed surface vessels for coastal survey.',
      funding_stage: 'pre_seed',
      location: 'Visakhapatnam',
      founded_year: 2024,
      business_model: ['b2b', 'hardware'],
    },
  },
  {
    name: 'Prithvi Imaging',
    domain: 'prithviimaging.com',
    space: 'aerospace.earth_observation',
    added: 55,
    values: {
      description: 'SAR constellation, all-weather. Two founders, ex-ISRO.',
      funding_stage: 'pre_seed',
      location: 'Thiruvananthapuram',
      founded_year: 2024,
      business_model: ['b2b', 'deep_tech'],
    },
  },
]

/**
 * Near-duplicates with no identity key, so the fuzzy sweep in
 * `resolveEntity` files them as candidates instead of attaching them —
 * the dedupe inbox needs something in it.
 */
const NEAR_DUPES = [
  { kind: 'company' as const, name: 'Garuda Autonomy Pvt Ltd' },
  { kind: 'company' as const, name: 'Shakti Compute Technologies' },
  { kind: 'person' as const, name: 'Aditi Raghunathan Iyer' },
]

/**
 * Co-investors are Companies, since clean-1 deleted the ghost kind they used
 * to carry (CONTEXT.md "Two-tier object model": no fourth system object for
 * funds/investors — a user models co-investors as Companies or as a custom
 * object, their call). Each carries a domain — an identity key is what makes
 * a re-run attach to the firm already on file instead of minting a second one.
 */
const INVESTORS = [
  { name: 'Meridian Deeptech', domain: 'meridiandeeptech.example' },
  { name: 'Sona Capital', domain: 'sonacapital.example' },
  { name: 'Indus Frontier Fund', domain: 'indusfrontier.example' },
  { name: 'Eleven Rivers Ventures', domain: 'elevenrivers.example' },
  { name: 'Kaveri Angels', domain: 'kaveriangels.example' },
]

type PersonSpec = {
  name: string
  email: string
  at?: string
  added: number
  values: Record<string, unknown>
}

const PEOPLE: Array<PersonSpec> = [
  {
    name: 'Ishaan Mehra',
    email: 'ishaan@vayuorbital.com',
    at: 'Vayu Orbital',
    added: 758,
    values: {
      job_title: 'Co-founder & CEO',
      location: 'Chennai',
      linkedin: 'https://linkedin.com/in/ishaanmehra',
    },
  },
  {
    name: 'Revathi Iyer',
    email: 'revathi@vayuorbital.com',
    at: 'Vayu Orbital',
    added: 758,
    values: { job_title: 'Co-founder & CTO', location: 'Chennai' },
  },
  {
    name: 'Aditi Raghunathan',
    email: 'aditi@kalpanasystems.in',
    at: 'Kalpana Systems',
    added: 688,
    values: {
      job_title: 'Founder & CEO',
      location: 'Bengaluru',
      phone: '+91 98450 11223',
    },
  },
  {
    name: 'Suresh Pillai',
    email: 'suresh@antariksh.space',
    at: 'Antariksh Labs',
    added: 405,
    values: { job_title: 'Founder', location: 'Hyderabad' },
  },
  {
    name: 'Farida Qureshi',
    email: 'farida@nakshatraground.com',
    at: 'Nakshatra Ground',
    added: 515,
    values: { job_title: 'CEO', location: 'Pune' },
  },
  {
    name: 'Vikram Rao',
    email: 'vikram@dhruvanav.com',
    at: 'Dhruva Navigation',
    added: 175,
    values: { job_title: 'Founder', location: 'Ahmedabad' },
  },
  {
    name: 'Karan Sodhi',
    email: 'karan@garudaautonomy.com',
    at: 'Garuda Autonomy',
    added: 636,
    values: {
      job_title: 'Co-founder & CEO',
      location: 'Bengaluru',
      twitter: 'https://twitter.com/karansodhi',
    },
  },
  {
    name: 'Neha Bhatt',
    email: 'neha@garudaautonomy.com',
    at: 'Garuda Autonomy',
    added: 630,
    values: { job_title: 'VP Engineering', location: 'Bengaluru' },
  },
  {
    name: 'Colonel R. Menon',
    email: 'menon@trishuldefence.in',
    at: 'Trishul Defence Systems',
    added: 295,
    values: { job_title: 'Founder (retd.)', location: 'Pune' },
  },
  {
    name: 'Yusuf Ali',
    email: 'yusuf@sentinelmesh.io',
    at: 'Sentinel Mesh',
    added: 148,
    values: { job_title: 'Founder & CTO', location: 'Gurugram' },
  },
  {
    name: 'Ananya Deshpande',
    email: 'ananya@shakticompute.com',
    at: 'Shakti Compute',
    added: 575,
    values: { job_title: 'Co-founder & CEO', location: 'Bengaluru' },
  },
  {
    name: 'Tarun Gopal',
    email: 'tarun@himalayacooling.com',
    at: 'Himalaya Cooling',
    added: 795,
    values: { job_title: 'Founder', location: 'Noida' },
  },
  {
    name: 'Lim Wei Jie',
    email: 'weijie@meghdootedge.com',
    at: 'Meghdoot Edge',
    added: 428,
    values: { job_title: 'CEO', location: 'Singapore' },
  },
  {
    name: 'Pallavi Nair',
    email: 'pallavi@suryacells.in',
    at: 'Surya Cells',
    added: 465,
    values: { job_title: 'Co-founder & CEO', location: 'Vadodara' },
  },
  {
    name: 'Devendra Joshi',
    email: 'dev@anantstorage.com',
    at: 'Anant Storage',
    added: 205,
    values: { job_title: 'Founder', location: 'Chennai' },
  },
  {
    name: 'Sneha Kulkarni',
    email: 'sneha@ohmgrid.io',
    at: 'Ohm Grid',
    added: 255,
    values: { job_title: 'Co-founder', location: 'Bengaluru' },
  },
  {
    name: 'Rohit Bansal',
    email: 'rohit@rupayarails.com',
    at: 'Rupaya Rails',
    added: 535,
    values: { job_title: 'Founder & CEO', location: 'Mumbai' },
  },
  {
    name: 'Meera Shetty',
    email: 'meera@koshwealth.com',
    at: 'Kosh Wealth',
    added: 325,
    values: { job_title: 'Founder', location: 'Mumbai' },
  },
  {
    name: 'Arjun Vyas',
    email: 'arjun@khataledger.com',
    at: 'Khata Ledger',
    added: 118,
    values: { job_title: 'Founder', location: 'Jaipur' },
  },
  {
    name: 'Dr. Lakshmi Venkat',
    email: 'lakshmi@aarogyadx.com',
    at: 'Aarogya Diagnostics',
    added: 890,
    values: { job_title: 'Founder & CSO', location: 'Hyderabad' },
  },
  {
    name: 'Sameer Kaul',
    email: 'sameer@nadibio.com',
    at: 'Nadi Bio',
    added: 235,
    values: { job_title: 'CEO', location: 'Bengaluru' },
  },
  {
    name: 'Hannah Brecht',
    email: 'hannah@chakrarobotics.com',
    at: 'Chakra Robotics',
    added: 605,
    values: { job_title: 'Co-founder & COO', location: 'Berlin' },
  },
  {
    name: 'Selvam Raj',
    email: 'selvam@bharatphotonics.com',
    at: 'Bharat Photonics',
    added: 345,
    values: { job_title: 'Founder', location: 'Coimbatore' },
  },
  {
    name: 'Nitin Pathak',
    email: 'nitin@siliconghat.com',
    at: 'Silicon Ghat',
    added: 695,
    values: { job_title: 'Co-founder & CEO', location: 'Bengaluru' },
  },
  {
    name: 'Ritika Shah',
    email: 'ritika@astramaterials.com',
    at: 'Astra Materials',
    added: 185,
    values: { job_title: 'Founder', location: 'Nagpur' },
  },
  {
    name: 'Gautam Bose',
    email: 'gautam@neelquantum.com',
    at: 'Neel Quantum',
    added: 90,
    values: { job_title: 'Founder', location: 'Kolkata' },
  },
  {
    name: 'Zoya Rahman',
    email: 'zoya@prithviimaging.com',
    at: 'Prithvi Imaging',
    added: 50,
    values: { job_title: 'Co-founder', location: 'Thiruvananthapuram' },
  },
  {
    name: 'Harish Pai',
    email: 'harish@sonacapital.example',
    added: 300,
    values: {
      job_title: 'Partner, Sona Capital',
      description:
        'Reliable co-investor on hardware rounds; slow on paperwork.',
      location: 'Bengaluru',
    },
  },
  {
    name: 'Ellen Schroeder',
    email: 'ellen@meridiandeeptech.example',
    added: 260,
    values: { job_title: 'Principal, Meridian Deeptech', location: 'Berlin' },
  },
]

type Stage =
  | 'pre_lead'
  | 'screening'
  | 'meeting'
  | 'diligence'
  | 'term_sheet'
  | 'early_revisit'
  | 'invested'
  | 'passed'
  | 'lost'

type DealSpec = {
  company: string
  name: string
  owner: 'lead' | 'partner'
  value?: number
  source?: string
  people?: Array<string>
  closeDate?: number
  closeReason?: string
  /** [stage, days ago it was entered] — the whole history, oldest first. */
  path: Array<[Stage, number]>
}

const DEALS: Array<DealSpec> = [
  {
    company: 'Vayu Orbital',
    name: 'Vayu Orbital — Seed',
    owner: 'lead',
    value: 250000,
    source: 'referral',
    people: ['Ishaan Mehra', 'Revathi Iyer'],
    path: [
      ['pre_lead', 730],
      ['screening', 722],
      ['meeting', 706],
      ['diligence', 690],
      ['term_sheet', 675],
      ['invested', 665],
    ],
  },
  {
    company: 'Kalpana Systems',
    name: 'Kalpana Systems — Seed',
    owner: 'lead',
    value: 300000,
    source: 'inbound',
    people: ['Aditi Raghunathan'],
    path: [
      ['pre_lead', 686],
      ['screening', 678],
      ['meeting', 668],
      ['diligence', 652],
      ['invested', 640],
    ],
  },
  {
    company: 'Garuda Autonomy',
    name: 'Garuda Autonomy — Seed',
    owner: 'partner',
    value: 200000,
    source: 'event',
    people: ['Karan Sodhi'],
    path: [
      ['pre_lead', 634],
      ['meeting', 624],
      ['diligence', 612],
      ['invested', 600],
    ],
  },
  {
    company: 'Shakti Compute',
    name: 'Shakti Compute — Seed',
    owner: 'lead',
    value: 240000,
    source: 'referral',
    people: ['Ananya Deshpande'],
    path: [
      ['screening', 590],
      ['meeting', 580],
      ['diligence', 570],
      ['invested', 560],
    ],
  },
  {
    company: 'Rupaya Rails',
    name: 'Rupaya Rails — SAFE',
    owner: 'partner',
    value: 150000,
    source: 'inbound',
    people: ['Rohit Bansal'],
    path: [
      ['pre_lead', 552],
      ['screening', 544],
      ['meeting', 534],
      ['invested', 520],
    ],
  },
  {
    company: 'Surya Cells',
    name: 'Surya Cells — CCD',
    owner: 'lead',
    value: 180000,
    source: 'outbound',
    people: ['Pallavi Nair'],
    path: [
      ['pre_lead', 480],
      ['screening', 472],
      ['diligence', 462],
      ['invested', 450],
    ],
  },
  {
    company: 'Himalaya Cooling',
    name: 'Himalaya Cooling — Seed',
    owner: 'lead',
    value: 180000,
    source: 'referral',
    people: ['Tarun Gopal'],
    path: [
      ['screening', 792],
      ['meeting', 784],
      ['diligence', 778],
      ['invested', 770],
    ],
  },
  {
    company: 'Aarogya Diagnostics',
    name: 'Aarogya Diagnostics — Seed',
    owner: 'lead',
    value: 120000,
    source: 'referral',
    people: ['Dr. Lakshmi Venkat'],
    path: [
      ['pre_lead', 886],
      ['meeting', 876],
      ['diligence', 868],
      ['invested', 860],
    ],
  },
  {
    company: 'Chakra Robotics',
    name: 'Chakra Robotics — Series A',
    owner: 'partner',
    value: 215000,
    source: 'event',
    people: ['Hannah Brecht'],
    path: [
      ['pre_lead', 620],
      ['screening', 612],
      ['meeting', 604],
      ['invested', 590],
    ],
  },
  {
    company: 'Meghdoot Edge',
    name: 'Meghdoot Edge — Seed',
    owner: 'partner',
    value: 185000,
    source: 'inbound',
    people: ['Lim Wei Jie'],
    path: [
      ['pre_lead', 425],
      ['screening', 420],
      ['diligence', 415],
      ['invested', 410],
    ],
  },
  {
    company: 'Nakshatra Ground',
    name: 'Nakshatra Ground — SAFE',
    owner: 'lead',
    value: 90000,
    source: 'outbound',
    people: ['Farida Qureshi'],
    path: [
      ['pre_lead', 512],
      ['meeting', 506],
      ['invested', 500],
    ],
  },
  {
    company: 'Silicon Ghat',
    name: 'Silicon Ghat — Seed',
    owner: 'lead',
    value: 220000,
    source: 'referral',
    people: ['Nitin Pathak'],
    path: [
      ['screening', 698],
      ['meeting', 692],
      ['diligence', 686],
      ['invested', 680],
    ],
  },

  {
    company: 'Antariksh Labs',
    name: 'Antariksh Labs — Seed',
    owner: 'lead',
    value: 250000,
    source: 'inbound',
    people: ['Suresh Pillai'],
    path: [
      ['pre_lead', 96],
      ['screening', 78],
      ['meeting', 55],
      ['diligence', 34],
    ],
  },
  {
    company: 'Trishul Defence Systems',
    name: 'Trishul — Seed',
    owner: 'partner',
    value: 300000,
    source: 'referral',
    people: ['Colonel R. Menon'],
    path: [
      ['pre_lead', 88],
      ['screening', 70],
      ['meeting', 44],
      ['diligence', 26],
      ['term_sheet', 12],
    ],
  },
  {
    company: 'Ohm Grid',
    name: 'Ohm Grid — Seed',
    owner: 'lead',
    value: 175000,
    source: 'outbound',
    people: ['Sneha Kulkarni'],
    path: [
      ['pre_lead', 40],
      ['screening', 25],
      ['meeting', 9],
    ],
  },
  {
    company: 'Nadi Bio',
    name: 'Nadi Bio — Seed',
    owner: 'partner',
    value: 275000,
    source: 'inbound',
    people: ['Sameer Kaul'],
    path: [
      ['pre_lead', 74],
      ['screening', 58],
      ['meeting', 41],
      ['diligence', 26],
    ],
  },
  {
    company: 'Anant Storage',
    name: 'Anant Storage — Seed',
    owner: 'lead',
    value: 200000,
    source: 'event',
    people: ['Devendra Joshi'],
    path: [
      ['pre_lead', 62],
      ['screening', 40],
    ],
  },
  {
    company: 'Bharat Photonics',
    name: 'Bharat Photonics — Seed',
    owner: 'partner',
    value: 160000,
    source: 'outbound',
    people: ['Selvam Raj'],
    path: [
      ['pre_lead', 48],
      ['screening', 32],
      ['meeting', 18],
    ],
  },
  {
    company: 'Sentinel Mesh',
    name: 'Sentinel Mesh — Pre-seed',
    owner: 'lead',
    value: 125000,
    source: 'referral',
    people: ['Yusuf Ali'],
    path: [['pre_lead', 6]],
  },
  {
    company: 'Khata Ledger',
    name: 'Khata Ledger — Pre-seed',
    owner: 'partner',
    value: 100000,
    source: 'inbound',
    people: ['Arjun Vyas'],
    path: [
      ['pre_lead', 14],
      ['screening', 3],
    ],
  },
  {
    company: 'Prithvi Imaging',
    name: 'Prithvi Imaging — Pre-seed',
    owner: 'lead',
    value: 150000,
    source: 'referral',
    people: ['Zoya Rahman'],
    path: [['pre_lead', 2]],
  },

  {
    company: 'Vidyut Motors',
    name: 'Vidyut Motors — Seed',
    owner: 'lead',
    value: 200000,
    source: 'outbound',
    people: ['Vikram Rao'],
    path: [
      ['pre_lead', 120],
      ['screening', 100],
      ['early_revisit', 65],
    ],
  },
  {
    company: 'Astra Materials',
    name: 'Astra Materials — Pre-seed',
    owner: 'partner',
    value: 120000,
    source: 'event',
    people: ['Ritika Shah'],
    path: [
      ['pre_lead', 140],
      ['meeting', 118],
      ['early_revisit', 95],
    ],
  },

  {
    company: 'Neel Quantum',
    name: 'Neel Quantum — Pre-seed',
    owner: 'lead',
    value: 150000,
    source: 'inbound',
    people: ['Gautam Bose'],
    closeDate: 30,
    closeReason:
      'Claims outrun the data. No third-party measurement of coherence time; asked twice.',
    path: [
      ['pre_lead', 84],
      ['screening', 60],
      ['passed', 30],
    ],
  },
  {
    company: 'Jal Systems',
    name: 'Jal Systems — Pre-seed',
    owner: 'partner',
    value: 100000,
    source: 'outbound',
    closeDate: 55,
    closeReason:
      'Pilot-stage membranes with a five-year procurement cycle. Wrong clock for us.',
    path: [
      ['pre_lead', 86],
      ['screening', 72],
      ['passed', 55],
    ],
  },
  {
    company: 'Pravah Analytics',
    name: 'Pravah Analytics — Seed',
    owner: 'lead',
    value: 175000,
    source: 'referral',
    closeDate: 140,
    closeReason:
      'Services revenue dressed as software. Gross margin never cleared 40%.',
    path: [
      ['pre_lead', 190],
      ['screening', 172],
      ['meeting', 158],
      ['passed', 140],
    ],
  },

  {
    company: 'Kosh Wealth',
    name: 'Kosh Wealth — Seed',
    owner: 'partner',
    value: 200000,
    source: 'inbound',
    people: ['Meera Shetty'],
    closeDate: 80,
    closeReason:
      'Round filled by a tier-1 in nine days. We were still scheduling the second call.',
    path: [
      ['pre_lead', 130],
      ['screening', 118],
      ['meeting', 104],
      ['term_sheet', 92],
      ['lost', 80],
    ],
  },
  {
    company: 'Dhruva Navigation',
    name: 'Dhruva Navigation — Pre-seed',
    owner: 'lead',
    value: 90000,
    source: 'event',
    people: ['Vikram Rao'],
    closeDate: 200,
    closeReason:
      'Founder took a strategic cheque from an OEM. Better outcome for them.',
    path: [
      ['pre_lead', 230],
      ['meeting', 216],
      ['lost', 200],
    ],
  },
]

type Instrument = 'priced' | 'safe_post_money' | 'safe_pre_money' | 'ccd'

type HoldingSpec = {
  company: string
  opened: number
  vehicle?: string
  rounds: Array<{
    days: number
    kind: string
    raised?: number
    currency: string
    preMoney?: number
    postMoney?: number
    pricePerShare?: number
    sharesOutstanding?: number
    coInvestors?: Array<string>
  }>
  investments: Array<{
    days: number
    amount: number
    currency: string
    instrument: Instrument
    shares?: number
    cap?: number
    discount?: number
    roundIdx?: number
  }>
  marks: Array<{
    days: number
    fairValue: number
    currency: string
    basis: 'round_price' | 'manual' | '409a'
  }>
  distributions?: Array<{
    days: number
    amount: number
    currency: string
    kind: 'exit' | 'secondary' | 'dividend' | 'writeoff'
    sharesSold?: number
    pricePerShare?: number
  }>
}

/**
 * Twelve holdings covering the shapes the metrics code has to survive:
 * four instruments, four currencies (one of them deliberately unrated in
 * fx_rate, so the gap surfaces instead of being faked), follow-ons, marks
 * that have gone stale, a full exit, a secondary, a dividend, a write-off.
 */
const HOLDINGS: Array<HoldingSpec> = [
  {
    company: 'Vayu Orbital',
    opened: 665,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 700,
        kind: 'Seed',
        raised: 3000000,
        currency: 'USD',
        postMoney: 15000000,
        pricePerShare: 1.5,
        sharesOutstanding: 10000000,
        coInvestors: ['Sona Capital', 'Kaveri Angels'],
      },
      {
        days: 305,
        kind: 'Series A',
        raised: 12000000,
        currency: 'USD',
        preMoney: 48000000,
        postMoney: 60000000,
        pricePerShare: 4,
        sharesOutstanding: 15000000,
        coInvestors: ['Meridian Deeptech', 'Sona Capital'],
      },
    ],
    investments: [
      {
        days: 665,
        amount: 250000,
        currency: 'USD',
        instrument: 'safe_post_money',
        cap: 12000000,
      },
      {
        days: 300,
        amount: 400000,
        currency: 'USD',
        instrument: 'priced',
        shares: 100000,
        roundIdx: 1,
      },
    ],
    marks: [
      { days: 300, fairValue: 1600000, currency: 'USD', basis: 'round_price' },
      { days: 120, fairValue: 1750000, currency: 'USD', basis: 'manual' },
      { days: 20, fairValue: 1900000, currency: 'USD', basis: 'manual' },
    ],
  },
  {
    company: 'Kalpana Systems',
    opened: 640,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 645,
        kind: 'Seed',
        raised: 2200000,
        currency: 'USD',
        postMoney: 11000000,
        pricePerShare: 2,
        sharesOutstanding: 5500000,
      },
    ],
    investments: [
      {
        days: 640,
        amount: 300000,
        currency: 'USD',
        instrument: 'priced',
        shares: 150000,
        roundIdx: 0,
      },
    ],
    // Last mark is ten months old: the staleness lane on Today needs one.
    marks: [
      { days: 600, fairValue: 300000, currency: 'USD', basis: 'round_price' },
      { days: 310, fairValue: 420000, currency: 'USD', basis: 'manual' },
    ],
  },
  {
    company: 'Garuda Autonomy',
    opened: 600,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 610,
        kind: 'Seed',
        raised: 4000000,
        currency: 'USD',
        postMoney: 20000000,
        pricePerShare: 2,
        sharesOutstanding: 10000000,
      },
      {
        days: 240,
        kind: 'Series B',
        raised: 30000000,
        currency: 'USD',
        preMoney: 90000000,
        postMoney: 120000000,
        pricePerShare: 6,
        sharesOutstanding: 20000000,
        coInvestors: ['Meridian Deeptech', 'Indus Frontier Fund'],
      },
    ],
    investments: [
      {
        days: 600,
        amount: 200000,
        currency: 'USD',
        instrument: 'safe_post_money',
        cap: 20000000,
      },
    ],
    marks: [
      { days: 240, fairValue: 600000, currency: 'USD', basis: 'round_price' },
      { days: 60, fairValue: 720000, currency: 'USD', basis: 'manual' },
    ],
    distributions: [
      {
        days: 90,
        amount: 150000,
        currency: 'USD',
        kind: 'secondary',
        sharesSold: 25000,
        pricePerShare: 6,
      },
    ],
  },
  {
    company: 'Shakti Compute',
    opened: 560,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 565,
        kind: 'Seed',
        raised: 90000000,
        currency: 'INR',
        postMoney: 450000000,
        pricePerShare: 450,
        sharesOutstanding: 1000000,
      },
    ],
    investments: [
      {
        days: 560,
        amount: 20000000,
        currency: 'INR',
        instrument: 'priced',
        shares: 44444,
        roundIdx: 0,
      },
    ],
    marks: [
      { days: 240, fairValue: 26000000, currency: 'INR', basis: 'round_price' },
      { days: 30, fairValue: 31000000, currency: 'INR', basis: 'manual' },
    ],
  },
  {
    company: 'Rupaya Rails',
    opened: 520,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 525,
        kind: 'Seed',
        raised: 2500000,
        currency: 'USD',
        postMoney: 10000000,
      },
    ],
    // Pre-money SAFE: cost basis only, no implied percentage anywhere.
    investments: [
      {
        days: 520,
        amount: 150000,
        currency: 'USD',
        instrument: 'safe_pre_money',
        cap: 8000000,
        discount: 0.2,
      },
    ],
    marks: [{ days: 200, fairValue: 150000, currency: 'USD', basis: 'manual' }],
  },
  {
    company: 'Surya Cells',
    opened: 450,
    vehicle: 'Fund II',
    rounds: [
      {
        days: 455,
        kind: 'Series A',
        raised: 400000000,
        currency: 'INR',
        postMoney: 1800000000,
      },
    ],
    investments: [
      { days: 450, amount: 15000000, currency: 'INR', instrument: 'ccd' },
    ],
    marks: [
      { days: 120, fairValue: 21000000, currency: 'INR', basis: 'manual' },
    ],
  },
  {
    company: 'Himalaya Cooling',
    opened: 770,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 775,
        kind: 'Seed',
        raised: 1800000,
        currency: 'USD',
        postMoney: 9000000,
        pricePerShare: 2,
        sharesOutstanding: 4500000,
      },
    ],
    investments: [
      {
        days: 770,
        amount: 180000,
        currency: 'USD',
        instrument: 'priced',
        shares: 90000,
        roundIdx: 0,
      },
    ],
    marks: [
      { days: 600, fairValue: 180000, currency: 'USD', basis: 'round_price' },
      { days: 330, fairValue: 90000, currency: 'USD', basis: 'manual' },
    ],
    distributions: [
      { days: 150, amount: 0, currency: 'USD', kind: 'writeoff' },
    ],
  },
  {
    company: 'Aarogya Diagnostics',
    opened: 860,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 865,
        kind: 'Seed',
        raised: 1500000,
        currency: 'USD',
        postMoney: 7500000,
        pricePerShare: 2,
        sharesOutstanding: 3750000,
      },
      {
        days: 400,
        kind: 'Series B',
        raised: 25000000,
        currency: 'USD',
        postMoney: 90000000,
        pricePerShare: 12,
        coInvestors: ['Indus Frontier Fund'],
      },
    ],
    investments: [
      {
        days: 860,
        amount: 120000,
        currency: 'USD',
        instrument: 'priced',
        shares: 60000,
        roundIdx: 0,
      },
    ],
    marks: [
      { days: 700, fairValue: 300000, currency: 'USD', basis: 'round_price' },
      { days: 400, fairValue: 800000, currency: 'USD', basis: 'round_price' },
    ],
    distributions: [
      {
        days: 110,
        amount: 960000,
        currency: 'USD',
        kind: 'exit',
        sharesSold: 60000,
        pricePerShare: 16,
      },
    ],
  },
  {
    company: 'Chakra Robotics',
    opened: 590,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 595,
        kind: 'Series A',
        raised: 8000000,
        currency: 'EUR',
        postMoney: 34000000,
        pricePerShare: 10,
        sharesOutstanding: 3400000,
        coInvestors: ['Meridian Deeptech'],
      },
    ],
    investments: [
      {
        days: 590,
        amount: 200000,
        currency: 'EUR',
        instrument: 'priced',
        shares: 20000,
        roundIdx: 0,
      },
    ],
    marks: [
      { days: 250, fairValue: 340000, currency: 'EUR', basis: 'round_price' },
      { days: 40, fairValue: 380000, currency: 'EUR', basis: 'manual' },
    ],
  },
  {
    // No SGD row in fx_rate, on purpose: a missing rate must surface as a
    // gap in the roll-up rather than quietly convert at 1.0.
    company: 'Meghdoot Edge',
    opened: 410,
    vehicle: 'Fund II',
    rounds: [
      {
        days: 415,
        kind: 'Seed',
        raised: 4000000,
        currency: 'SGD',
        postMoney: 15000000,
      },
    ],
    investments: [
      {
        days: 410,
        amount: 250000,
        currency: 'SGD',
        instrument: 'safe_post_money',
        cap: 15000000,
      },
    ],
    marks: [{ days: 100, fairValue: 300000, currency: 'SGD', basis: 'manual' }],
  },
  {
    company: 'Nakshatra Ground',
    opened: 500,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 505,
        kind: 'Seed',
        raised: 1200000,
        currency: 'USD',
        postMoney: 6000000,
      },
    ],
    investments: [
      {
        days: 500,
        amount: 90000,
        currency: 'USD',
        instrument: 'safe_post_money',
        cap: 6000000,
      },
    ],
    marks: [{ days: 200, fairValue: 140000, currency: 'USD', basis: 'manual' }],
    distributions: [
      { days: 70, amount: 20000, currency: 'USD', kind: 'dividend' },
    ],
  },
  {
    company: 'Silicon Ghat',
    opened: 680,
    vehicle: 'Fund I',
    rounds: [
      {
        days: 685,
        kind: 'Seed',
        raised: 2000000,
        currency: 'USD',
        postMoney: 10000000,
        pricePerShare: 5,
        sharesOutstanding: 2000000,
      },
      {
        days: 265,
        kind: 'Series A',
        raised: 14000000,
        currency: 'USD',
        preMoney: 46000000,
        postMoney: 60000000,
        pricePerShare: 9,
        sharesOutstanding: 6666666,
        coInvestors: ['Eleven Rivers Ventures', 'Sona Capital'],
      },
    ],
    investments: [
      {
        days: 680,
        amount: 220000,
        currency: 'USD',
        instrument: 'priced',
        shares: 44000,
        roundIdx: 0,
      },
      {
        days: 260,
        amount: 180000,
        currency: 'USD',
        instrument: 'priced',
        shares: 20000,
        roundIdx: 1,
      },
    ],
    marks: [
      { days: 500, fairValue: 300000, currency: 'USD', basis: 'round_price' },
      { days: 260, fairValue: 600000, currency: 'USD', basis: 'round_price' },
      { days: 45, fairValue: 780000, currency: 'USD', basis: '409a' },
    ],
  },
]

/** Sparse manual rates to the workspace base currency. SGD is absent. */
const FX: Array<{ currency: string; days: number; rate: number }> = [
  { currency: 'INR', days: 900, rate: 0.0121 },
  { currency: 'INR', days: 720, rate: 0.012 },
  { currency: 'INR', days: 540, rate: 0.0119 },
  { currency: 'INR', days: 360, rate: 0.0118 },
  { currency: 'INR', days: 180, rate: 0.0117 },
  { currency: 'INR', days: 30, rate: 0.0116 },
  { currency: 'EUR', days: 720, rate: 1.09 },
  { currency: 'EUR', days: 360, rate: 1.08 },
  { currency: 'EUR', days: 120, rate: 1.06 },
  { currency: 'USD', days: 900, rate: 1 },
]

type NoteSpec = {
  title: string
  body: string
  kind: 'note' | 'memo' | 'scratch'
  author: 'lead' | 'partner'
  visibility: 'shared' | 'private'
  days: number
  mentions?: Array<string>
  space?: string
}

const NOTES: Array<NoteSpec> = [
  {
    title: 'Why small-lift, and why now',
    kind: 'memo',
    author: 'lead',
    visibility: 'shared',
    days: 690,
    mentions: ['Vayu Orbital'],
    space: 'aerospace.launch',
    body: 'The rideshare manifest is full and the payloads that miss it are the ones with an orbit requirement — which is exactly the customer who pays a premium. That is the whole thesis.\n\nWhat has to be true: methalox upper stage lights twice, and the Chennai test site clears its noise permits. Neither is a technology risk; both are schedule risk.\n\nWhat would kill it: a dedicated small-lift price war. If the incumbent drops to $18k/kg the market floor moves under everyone.',
  },
  {
    title: 'Vayu Orbital — first call',
    kind: 'note',
    author: 'lead',
    visibility: 'shared',
    days: 728,
    mentions: ['Vayu Orbital', 'Ishaan Mehra'],
    body: 'Ishaan is an engineer who sells, which is rarer than either half. Walked the stage-2 test cadence without notes.\n\nOpen: who owns the ground segment? They are renting from three providers and the margin leaks there.',
  },
  {
    title: 'Hyperspectral: the buyer is the problem, not the sensor',
    kind: 'memo',
    author: 'partner',
    visibility: 'shared',
    days: 640,
    mentions: ['Kalpana Systems'],
    space: 'aerospace.earth_observation',
    body: 'Everyone in this space can build the payload. Nobody has a repeat buyer. Crop insurance is the only line item with budget, and it moves on a 14-month procurement cycle.\n\nKalpana is the only one selling into mining, where the customer signs in a quarter. That is the reason to be here.',
  },
  {
    title: 'Garuda — diligence summary',
    kind: 'memo',
    author: 'partner',
    visibility: 'shared',
    days: 610,
    mentions: ['Garuda Autonomy', 'Karan Sodhi'],
    space: 'defence_autonomy.uas',
    body: 'Two references from serving officers, both unprompted about the GPS-denied demo. Third reference was lukewarm on delivery timelines.\n\nRevenue is lumpy and will stay lumpy: defence procurement is not a SaaS curve. Underwrite the cheque on the 2029 programme of record, not on ARR.',
  },
  {
    title: 'Thermal: where the 30kW wall actually bites',
    kind: 'memo',
    author: 'lead',
    visibility: 'shared',
    days: 520,
    space: 'compute.thermal',
    mentions: ['Himalaya Cooling'],
    body: 'Air runs out past 30kW a rack and accelerator racks are already past it, so liquid is a when-not-if market. The question is which approach wins, and the honest answer is that single-phase is duller and probably right.\n\nIndia-specific: the retrofit market is bigger than new-build for the next four years. Anyone selling only to greenfield is addressing a tenth of the spend.',
  },
  {
    title: 'Himalaya Cooling — post-mortem',
    kind: 'memo',
    author: 'lead',
    visibility: 'shared',
    days: 150,
    mentions: ['Himalaya Cooling', 'Tarun Gopal'],
    body: 'Written off. Worth being precise about why, because the thesis was right and the company still died.\n\nThey sold a retrofit product through a channel that only touches new builds. Eighteen months of pilots that never converted because the buyer in the room could not sign. Founder saw it a year before we did and said so; we read it as pessimism.\n\nLesson for the next one: ask who signs, in the first meeting, in writing.',
  },
  {
    title: 'Aarogya exit — what the 8x actually came from',
    kind: 'memo',
    author: 'lead',
    visibility: 'shared',
    days: 108,
    mentions: ['Aarogya Diagnostics'],
    body: 'Not the assay. The assay was table stakes. The multiple came from owning the reader install base — 4,200 units in tier-3 towns that no competitor could dislodge without a second capex cycle from the buyer.\n\nWe underwrote the science and got paid for the distribution. Be honest about that when writing the next diagnostics memo.',
  },
  {
    title: 'Sodium-ion: cost curve, not chemistry',
    kind: 'note',
    author: 'lead',
    visibility: 'shared',
    days: 455,
    mentions: ['Surya Cells'],
    space: 'energy.storage',
    body: 'Sodium-ion will not beat lithium on energy density this decade and does not need to. Stationary storage buys cycles per rupee and does not care about mass.\n\nThe import-exposure argument is the one that lands with Indian buyers, and it is a policy argument, so it is only as durable as the policy.',
  },
  {
    title: 'Neel Quantum — why we passed',
    kind: 'memo',
    author: 'lead',
    visibility: 'shared',
    days: 30,
    mentions: ['Neel Quantum', 'Gautam Bose'],
    body: 'Asked twice for a third-party coherence-time measurement. Got a simulation both times.\n\nThis may well be a real result. It is not a result we can underwrite, and the round is priced as if it already is.',
  },
  {
    title: 'Trishul — reference call notes (Col. Menon network)',
    kind: 'note',
    author: 'partner',
    visibility: 'shared',
    days: 20,
    mentions: ['Trishul Defence Systems', 'Colonel R. Menon'],
    body: 'Three calls. Consistent: the software is genuinely used in exercises, not just procured. One flag on support response times during a live deployment.\n\nPricing discussion pending — they anchored at a 40 pre which is rich for pre-revenue defence software in this geography.',
  },
  {
    title: 'What I actually think about the Kosh loss',
    kind: 'note',
    author: 'partner',
    visibility: 'private',
    days: 78,
    mentions: ['Kosh Wealth'],
    body: 'We lost this on speed, not price. Nine days from first meeting to signed term sheet and we spent four of them scheduling.\n\nIf the process cannot compress to a week for a founder we already like, the process is the product problem.',
  },
  {
    title: 'Pipeline hygiene — read before Monday',
    kind: 'scratch',
    author: 'lead',
    visibility: 'private',
    days: 4,
    body: 'Anything sitting in Diligence past three weeks either has an owner problem or a conviction problem. Both get resolved by a decision, not by another call.\n\nPark the two that are really "not now" so the funnel stops lying.',
  },
  {
    title: 'Defence autonomy — the mapping as I understand it',
    kind: 'note',
    author: 'lead',
    visibility: 'shared',
    days: 300,
    space: 'defence_autonomy',
    body: 'Three layers worth separating: the airframe (commoditising fast), the autonomy stack (where the margin is), and C4ISR integration (where the incumbents defend).\n\nWe should only ever be buying the middle layer, and only where the team has a serving-officer channel.',
  },
  {
    title: 'Interconnect: what breaks first at rack scale',
    kind: 'note',
    author: 'partner',
    visibility: 'shared',
    days: 240,
    space: 'compute.interconnect',
    mentions: ['Shakti Compute'],
    body: 'Copper is out of road at 200G per lane over a rack-length reach. Optical is inevitable; the fight is over whether it lives on the board or in the module.\n\nShakti is betting on-board, which is the harder engineering problem and the better business if it lands.',
  },
]

type TermSpec = {
  name: string
  aliases: Array<string>
  definition: string
  space: string
}

const TERMS: Array<TermSpec> = [
  {
    name: 'SSO',
    aliases: ['sun-synchronous orbit'],
    definition:
      'Sun-synchronous orbit — a near-polar orbit that crosses the equator at the same local solar time each pass. The default for earth observation, which is why launch pricing to SSO is the number that matters.',
    space: 'aerospace.launch',
  },
  {
    name: 'Methalox',
    aliases: ['methane-oxygen'],
    definition:
      'Liquid methane and liquid oxygen as a propellant pair. Cleaner-burning than kerolox (engines are reusable sooner), denser than hydrolox (smaller tanks).',
    space: 'aerospace.launch',
  },
  {
    name: 'GSD',
    aliases: ['ground sample distance'],
    definition:
      'Ground sample distance — the real-world size of one pixel. Every earth-observation deck quotes its best GSD; ask for the swath width in the same sentence or the number is meaningless.',
    space: 'aerospace.earth_observation',
  },
  {
    name: 'GPS-denied',
    aliases: ['gnss-denied'],
    definition:
      'Navigation without satellite positioning, via visual odometry or inertial dead-reckoning. The only capability question that matters for tactical UAS, and the one every deck overstates.',
    space: 'defence_autonomy.uas',
  },
  {
    name: 'Programme of record',
    aliases: ['PoR'],
    definition:
      'A defence line item with allocated multi-year budget. Revenue before a programme of record is a pilot; revenue after it is a business.',
    space: 'defence_autonomy',
  },
  {
    name: 'PUE',
    aliases: ['power usage effectiveness'],
    definition:
      'Total facility power divided by IT equipment power. 1.0 is perfect; air-cooled halls sit near 1.5, liquid-cooled ones near 1.05. Everyone quotes the figure from their best installation.',
    space: 'compute.thermal',
  },
  {
    name: 'Rack density',
    aliases: ['kW per rack'],
    definition:
      'Power drawn by a single rack. Air cooling runs out somewhere past 30kW, which is the wedge every liquid-cooling company sells into.',
    space: 'compute.thermal',
  },
  {
    name: 'C-rate',
    aliases: [],
    definition:
      'Charge or discharge current relative to capacity. A 0.25C cell discharges over four hours — the number grid storage buyers actually specify.',
    space: 'energy.storage',
  },
  {
    name: 'Co-lending',
    aliases: ['co-origination'],
    definition:
      'A bank and an NBFC splitting a loan at origination, typically 80:20. The RBI framework that makes lending infrastructure a market rather than a feature.',
    space: 'fintech.lending_infra',
  },
  {
    name: 'cfDNA',
    aliases: ['cell-free DNA'],
    definition:
      'Fragmented DNA circulating in plasma. The substrate for liquid-biopsy screening; sensitivity at stage-1 disease is the whole ballgame.',
    space: 'health.diagnostics',
  },
]

type DocSpec = {
  filename: string
  kind: 'deck' | 'dd' | 'cap_table' | 'legal' | 'article' | 'other'
  attachTo: string
  days: number
  text: string
  status: 'done' | 'pending' | 'failed' | 'unsupported'
  error?: string
}

const DOCUMENTS: Array<DocSpec> = [
  {
    filename: 'vayu-orbital-seed-deck.txt',
    kind: 'deck',
    attachTo: 'Vayu Orbital',
    days: 726,
    status: 'done',
    text: 'Vayu Orbital — Seed\n\nSmall-lift to SSO. 300kg class. Methalox upper stage.\n\nProblem: rideshare cannot serve payloads with an orbit requirement. 41% of smallsat operators report a mission-design compromise to fit a rideshare manifest.\n\nProduct: two-stage vehicle, 300kg to 500km SSO, 14-day call-up.\n\nTraction: two LOIs (defence, one commercial EO). Stage-1 hot fire complete, 92 seconds.\n\nAsk: $3M seed at $15M post. Runway to first orbital attempt Q3 next year.',
  },
  {
    filename: 'garuda-diligence-pack.txt',
    kind: 'dd',
    attachTo: 'Garuda Autonomy',
    days: 612,
    status: 'done',
    text: 'Garuda Autonomy — diligence pack\n\nReference calls: 3 completed, 2 strongly positive on GPS-denied performance, 1 neutral on delivery timelines.\n\nTechnical review: visual odometry stack benchmarked against an in-house baseline. 2.1m drift over 4km in a jamming environment; the incumbent figure is 9m.\n\nContracts: one signed evaluation order, two in negotiation. Revenue recognition is milestone-based and will look lumpy.\n\nRisks: key-person concentration on the CTO. Export-control exposure if the US channel opens.',
  },
  {
    filename: 'silicon-ghat-cap-table.txt',
    kind: 'cap_table',
    attachTo: 'Silicon Ghat',
    days: 264,
    status: 'done',
    text: 'Silicon Ghat — cap table, post Series A\n\nFounders 44.2%\nESOP pool 12.0%\nSeed investors 18.8%\nSeries A 25.0%\n\nFully diluted shares outstanding: 6,666,666. Series A price per share $9.00.\n\nOur position: 64,000 shares across seed and Series A, 0.96% fully diluted.',
  },
  {
    filename: 'aarogya-share-purchase-agreement.txt',
    kind: 'legal',
    attachTo: 'Aarogya Diagnostics',
    days: 112,
    status: 'done',
    text: 'Share Purchase Agreement — summary of economic terms\n\nSecondary sale of 60,000 equity shares at $16.00 per share. Total consideration $960,000.\n\nDrag-along waived for this transaction. Standard fundamental reps, 18-month survival, escrow 10%.\n\nClosing conditions satisfied. Consideration received in full.',
  },
  {
    filename: 'trishul-term-sheet-draft.txt',
    kind: 'legal',
    attachTo: 'Trishul Defence Systems',
    days: 11,
    status: 'done',
    text: 'Trishul Defence Systems — term sheet (draft, not executed)\n\nPre-money: $40,000,000. New money: $6,000,000.\n\nInstrument: CCPS. 1x non-participating liquidation preference. Broad-based weighted-average anti-dilution.\n\nBoard: one investor seat at the lead. Information rights quarterly.\n\nNote: the pre-money is rich for pre-revenue defence software in this geography. Counter at 28.',
  },
  {
    filename: 'surya-cells-cell-test-data.txt',
    kind: 'dd',
    attachTo: 'Surya Cells',
    days: 452,
    status: 'done',
    text: 'Surya Cells — third-party cell test summary\n\n1,800 cycles at 0.25C to 80% capacity retention. Test house: independent, report on file.\n\nEnergy density 142 Wh/kg — below LFP, as expected and as stated.\n\nCost model: claims $58/kWh at 2GWh scale. Bill of materials supports $71/kWh today at pilot volumes.',
  },
  // A document the worker has not reached yet — the "still working" state.
  {
    filename: 'prithvi-imaging-teaser.txt',
    kind: 'deck',
    attachTo: 'Prithvi Imaging',
    days: 2,
    status: 'pending',
    text: 'Prithvi Imaging — SAR constellation teaser. Two founders, ex-ISRO. Pre-seed.',
  },
  // And one that broke, with the operator-facing reason kept.
  {
    filename: 'meghdoot-edge-scan.txt',
    kind: 'other',
    attachTo: 'Meghdoot Edge',
    days: 60,
    status: 'failed',
    text: '',
    error:
      'Extraction failed: the PDF has no text layer (scanned at 200dpi). A vision model would be needed to read it.',
  },
]

type TaskSpec = {
  content: string
  due: number | null
  assignee: 'lead' | 'partner'
  entities?: Array<string>
  doneDaysAgo?: number
  created: number
}

const TASKS: Array<TaskSpec> = [
  {
    content:
      'Send Trishul a counter at 28 pre — the 40 is not defensible pre-revenue',
    due: -6,
    assignee: 'lead',
    entities: ['Trishul Defence Systems'],
    created: 14,
  },
  {
    content: 'Chase Antariksh for the microgravity flight manifest',
    due: -3,
    assignee: 'partner',
    entities: ['Antariksh Labs'],
    created: 20,
  },
  {
    content: 'Nadi Bio: get the stage-1 sensitivity numbers in writing',
    due: -1,
    assignee: 'lead',
    entities: ['Nadi Bio', 'Sameer Kaul'],
    created: 12,
  },
  {
    content: 'Decide on Anant Storage — it has been in Screening for six weeks',
    due: 0,
    assignee: 'lead',
    entities: ['Anant Storage'],
    created: 9,
  },
  {
    content: 'Q3 mark review: Kalpana is ten months stale',
    due: 0,
    assignee: 'partner',
    entities: ['Kalpana Systems'],
    created: 7,
  },
  {
    content: 'Intro Zoya to the ground-segment team at Nakshatra',
    due: 2,
    assignee: 'lead',
    entities: ['Prithvi Imaging', 'Nakshatra Ground'],
    created: 3,
  },
  {
    content: 'Second call with Ohm Grid — discom pipeline detail',
    due: 4,
    assignee: 'lead',
    entities: ['Ohm Grid', 'Sneha Kulkarni'],
    created: 6,
  },
  {
    content: 'Revisit Vidyut Motors after their Q4 numbers land',
    due: 21,
    assignee: 'lead',
    entities: ['Vidyut Motors'],
    created: 65,
  },
  {
    content: 'Revisit Astra Materials once the CMC pilot has a customer',
    due: 45,
    assignee: 'partner',
    entities: ['Astra Materials'],
    created: 95,
  },
  {
    content: 'Draft the annual LP letter — portfolio section first',
    due: 30,
    assignee: 'lead',
    created: 10,
  },
  {
    content: 'Write up the Himalaya post-mortem properly and file it',
    due: null,
    assignee: 'lead',
    entities: ['Himalaya Cooling'],
    created: 150,
  },
  {
    content: 'Reconcile the SGD position — no fx rate on file for Meghdoot',
    due: 5,
    assignee: 'partner',
    entities: ['Meghdoot Edge'],
    created: 5,
  },
  {
    content: 'Book the Garuda secondary proceeds against Fund I',
    due: null,
    assignee: 'lead',
    entities: ['Garuda Autonomy'],
    doneDaysAgo: 85,
    created: 90,
  },
  {
    content: 'Close out the Aarogya escrow paperwork',
    due: null,
    assignee: 'partner',
    entities: ['Aarogya Diagnostics'],
    doneDaysAgo: 100,
    created: 112,
  },
  {
    content: 'Pass note to Gautam at Neel Quantum — do it by phone',
    due: null,
    assignee: 'lead',
    entities: ['Neel Quantum'],
    doneDaysAgo: 29,
    created: 31,
  },
]

type ViewSpec = {
  object: ObjectKind
  name: string
  visibility: 'shared' | 'private'
  owner: 'lead' | 'partner'
  filter: Array<Condition>
  sort: { id: string; desc: boolean } | null
  columns: Record<string, boolean>
  extra?: ViewExtra
}

const VIEWS: Array<ViewSpec> = [
  {
    object: 'deal',
    name: 'Live pipeline',
    visibility: 'shared',
    owner: 'lead',
    filter: [],
    sort: { id: 'attr:value', desc: true },
    columns: {
      name: true,
      'attr:stage': true,
      'attr:value': true,
      'attr:company': true,
      'attr:owner': true,
      'attr:source': false,
      'attr:close_date': false,
      'attr:close_reason': false,
    },
    extra: { group: 'active', stage: null },
  },
  {
    object: 'deal',
    name: 'In diligence',
    visibility: 'shared',
    owner: 'lead',
    filter: [{ slug: 'stage', op: 'is', value: 'diligence' }],
    sort: null,
    columns: {
      name: true,
      'attr:stage': true,
      'attr:company': true,
      'attr:owner': true,
      'attr:value': true,
    },
    extra: { group: null, stage: null },
  },
  {
    object: 'deal',
    name: 'Post-mortems',
    visibility: 'shared',
    owner: 'partner',
    filter: [{ slug: 'close_reason', op: 'not_empty' }],
    sort: { id: 'attr:close_date', desc: true },
    columns: {
      name: true,
      'attr:stage': true,
      'attr:close_date': true,
      'attr:close_reason': true,
    },
    extra: { group: 'closed', stage: null },
  },
  {
    object: 'company',
    name: 'Series A and later',
    visibility: 'shared',
    owner: 'lead',
    filter: [{ slug: 'funding_stage', op: 'is_not', value: 'pre_seed' }],
    sort: null,
    columns: {
      name: true,
      'attr:funding_stage': true,
      'attr:location': true,
      'attr:description': true,
    },
  },
  {
    object: 'person',
    name: 'Founders only',
    visibility: 'private',
    owner: 'lead',
    filter: [{ slug: 'job_title', op: 'contains', value: 'Founder' }],
    sort: null,
    columns: { name: true, 'attr:job_title': true, 'attr:location': true },
  },
]

const NOTE_TEMPLATE_BODY = [
  {
    type: 'heading',
    props: { level: 3 },
    content: [{ type: 'text', text: 'Call notes', styles: {} }],
  },
  {
    type: 'paragraph',
    content: [{ type: 'text', text: 'Who was on: ', styles: {} }],
  },
  {
    type: 'heading',
    props: { level: 3 },
    content: [{ type: 'text', text: 'What has to be true', styles: {} }],
  },
  { type: 'bulletListItem', content: [{ type: 'text', text: '', styles: {} }] },
  {
    type: 'heading',
    props: { level: 3 },
    content: [{ type: 'text', text: 'What would kill it', styles: {} }],
  },
  { type: 'bulletListItem', content: [{ type: 'text', text: '', styles: {} }] },
  {
    type: 'heading',
    props: { level: 3 },
    content: [{ type: 'text', text: 'Who signs', styles: {} }],
  },
  { type: 'paragraph', content: [{ type: 'text', text: '', styles: {} }] },
]

const SPACE_TEMPLATE_BODY = {
  terms: [
    {
      name: 'TAM note',
      definition: 'Where the market number came from, and who disputes it.',
    },
  ],
  children: [
    { name: 'Market map', terms: [], children: [] },
    { name: 'Incumbents', terms: [], children: [] },
    { name: 'Open questions', terms: [], children: [] },
  ],
}

/** Custom object — the registry-generated surface needs a real inhabitant. */
const VEHICLE_ATTRS = [
  { name: 'Vintage', type: 'number' as const },
  { name: 'Committed', type: 'currency' as const, config: { code: 'USD' } },
  {
    name: 'Status',
    type: 'select' as const,
    options: [
      { label: 'Investing', color: 'emerald' as const },
      { label: 'Harvesting', color: 'amber' as const },
      { label: 'Closed', color: 'slate' as const },
    ],
  },
  {
    name: 'Anchor company',
    type: 'record_reference' as const,
    config: { targetKind: 'company' as const, multi: false },
  },
  { name: 'Manager', type: 'actor_reference' as const },
]

const VEHICLES = [
  {
    name: 'Fund I',
    values: { vintage: 2019, committed: 8000000, status: 'harvesting' },
  },
  {
    name: 'Fund II',
    values: { vintage: 2023, committed: 22000000, status: 'investing' },
  },
  {
    name: 'SPV — Garuda Series B',
    values: {
      vintage: 2024,
      committed: 1500000,
      status: 'investing',
      anchor_company: 'Garuda Autonomy',
    },
  },
  {
    name: 'SPV — Silicon Ghat Series A',
    values: {
      vintage: 2024,
      committed: 900000,
      status: 'investing',
      anchor_company: 'Silicon Ghat',
    },
  },
]

const INTERACTION_SUBJECTS = [
  'Intro call',
  'Metrics follow-up',
  'Deep dive: technology',
  'Founder catch-up',
  'Reference call',
  'Quarterly update',
  'Data room walkthrough',
  'Pricing discussion',
]

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** Idempotent on path: slugs are unique per parent, paths are not. */
async function seedSpaces(): Promise<Ids> {
  const ids: Ids = new Map()
  const insert = async (
    node: SpaceNode,
    parent: { id: string; path: string } | null,
  ): Promise<void> => {
    const path = parent ? `${parent.path}.${node.slug}` : node.slug
    const existing = (
      await db
        .select({ entityId: space.entityId })
        .from(space)
        .where(eq(space.path, path))
    ).at(0)
    let id = existing?.entityId
    if (!id) {
      const [ent] = await db
        .insert(entity)
        .values({
          kind: 'space',
          canonicalName: node.name,
          sourceClass: 'seed',
        })
        .returning({ id: entity.id })
      await db.insert(space).values({
        entityId: ent.id,
        parentId: parent?.id ?? null,
        slug: node.slug,
        path,
        isSeeded: true,
      })
      id = ent.id
    }
    ids.set(path, id)
    for (const child of node.children ?? []) await insert(child, { id, path })
  }
  for (const node of SPACES) await insert(node, null)
  return ids
}

const PARTNER = {
  name: 'Priya Nair',
  email: 'priya@fund.example',
  password: 'seeded-partner-pw',
}

/**
 * The second seat. A one-member workspace cannot exercise private notes,
 * owner filters, or "assigned to someone else", so the bench gets a partner
 * with a real credential row — sign in as them and the other half of the
 * permission model becomes visible.
 */
async function seedPartner(): Promise<{ id: string; password: string | null }> {
  const existing = (
    await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, PARTNER.email))
  ).at(0)
  if (existing) return { id: existing.id, password: null }
  const id = randomUUID()
  await db.insert(user).values({
    id,
    name: PARTNER.name,
    email: PARTNER.email,
    emailVerified: true,
    role: 'member',
  })
  try {
    const { auth } = await import('#/lib/auth')
    const ctx = await auth.$context
    await db.insert(account).values({
      id: randomUUID(),
      accountId: id,
      providerId: 'credential',
      userId: id,
      password: await ctx.password.hash(PARTNER.password),
    })
    return { id, password: PARTNER.password }
  } catch (err) {
    // A seat that can't log in still owns deals and tasks — worth keeping.
    console.warn('[seed] partner has no password:', err)
    return { id, password: null }
  }
}

/**
 * Two custom attributes on a system object — the registry has to survive
 * user columns on core records, and every table/filter/editor path differs
 * subtly between system and custom.
 */
async function seedCustomCompanyAttributes(userId: string): Promise<void> {
  const objectId = await objectIdForKindAsync('company')
  const wanted = [
    {
      slug: 'thesis_fit',
      name: 'Thesis fit',
      type: 'rating' as const,
      config: { max: 5 },
    },
    {
      slug: 'team_size',
      name: 'Team size',
      type: 'number' as const,
      config: {},
    },
  ]
  for (const w of wanted) {
    const existing = (
      await db
        .select({ id: attribute.id })
        .from(attribute)
        .where(
          and(eq(attribute.objectId, objectId), eq(attribute.slug, w.slug)),
        )
    ).at(0)
    if (existing) continue
    await Effect.runPromise(
      createAttributeProgram({
        objectId,
        name: w.name,
        type: w.type,
        config: w.config,
        createdBy: userId,
      }),
    )
  }
  registryCache.delete('company')
}

async function seedCompanies(spaces: Ids, userId: string): Promise<Ids> {
  const ids: Ids = new Map()
  for (const [i, c] of COMPANIES.entries()) {
    const res = await resolveEntity({
      kind: 'company',
      name: c.name,
      keys: { domain: c.domain },
      source: { class: 'import' },
      createdBy: userId,
      values: await known('company', {
        ...c.values,
        thesis_fit: 1 + (i % 5),
        team_size: 4 + ((i * 7) % 60),
      }),
    })
    ids.set(c.name, res.entityId)
    if (res.action === 'created') {
      await stamp(res.entityId, at(c.added))
      await logActivity({
        verb: 'company.created',
        subject: res.entityId,
        actorId: userId,
        when: at(c.added),
      })
    }
    const spaceId = spaces.get(c.space)
    if (spaceId) {
      const tagged = await db
        .insert(entitySpace)
        .values({
          entityId: res.entityId,
          spaceId,
          source: 'manual',
          createdBy: userId,
        })
        .onConflictDoNothing()
        .returning({ entityId: entitySpace.entityId })
      if (tagged.length > 0) {
        await logActivity({
          verb: 'space.tagged',
          subject: res.entityId,
          object: spaceId,
          actorId: userId,
          when: at(c.added),
        })
      }
    }
  }
  return ids
}

async function seedPeople(companies: Ids, userId: string): Promise<Ids> {
  const ids: Ids = new Map()
  for (const p of PEOPLE) {
    const res = await resolveEntity({
      kind: 'person',
      name: p.name,
      keys: { email: p.email },
      source: { class: 'import' },
      createdBy: userId,
      values: await known('person', p.values),
    })
    ids.set(p.name, res.entityId)
    if (res.action === 'created') {
      await stamp(res.entityId, at(p.added))
      await logActivity({
        verb: 'person.created',
        subject: res.entityId,
        actorId: userId,
        when: at(p.added),
      })
    }
    const employer = p.at ? companies.get(p.at) : undefined
    if (employer) {
      await db
        .insert(link)
        .values({
          fromEntityId: res.entityId,
          toEntityId: employer,
          relation: 'contact_at',
          source: 'manual',
          createdBy: userId,
        })
        .onConflictDoNothing()
    }
  }
  return ids
}

/**
 * Deals carry their whole stage history. The write path only ever stamps
 * now, so the events are backdated afterwards — `dealFunnelStats` reads
 * them, and a funnel where every deal entered its stage this second says
 * nothing.
 */
async function seedDeals(
  companies: Ids,
  people: Ids,
  users: { lead: string; partner: string },
): Promise<{ byName: Ids; byCompany: Ids }> {
  const byName: Ids = new Map()
  const byCompany: Ids = new Map()
  const objectId = await objectIdForKindAsync('deal')
  for (const d of DEALS) {
    const companyId = companies.get(d.company)
    if (!companyId) continue
    const existing = (
      await db
        .select({ id: entity.id })
        .from(entity)
        .where(and(eq(entity.kind, 'deal'), eq(entity.canonicalName, d.name)))
    ).at(0)
    if (existing) {
      byName.set(d.name, existing.id)
      byCompany.set(d.company, existing.id)
      continue
    }
    const ownerId = d.owner === 'lead' ? users.lead : users.partner
    const born = at(d.path[0][1])
    const [ent] = await db
      .insert(entity)
      .values({
        kind: 'deal',
        objectId,
        canonicalName: d.name,
        sourceClass: 'seed',
        createdBy: ownerId,
      })
      .returning({ id: entity.id })

    const attendees = (d.people ?? [])
      .map((n) => people.get(n))
      .filter((v): v is string => Boolean(v))
    await birthValues({
      entityId: ent.id,
      actor: { type: 'user', id: ownerId },
      supplied: await known('deal', {
        company: companyId,
        stage: d.path[0][0],
        owner: ownerId,
        ...(d.value !== undefined ? { value: d.value } : {}),
        ...(d.source ? { source: d.source } : {}),
        ...(attendees.length > 0 ? { people: attendees } : {}),
      }),
    })

    for (let i = 1; i < d.path.length; i++) {
      const last = i === d.path.length - 1
      await setValues({
        entityId: ent.id,
        actor: { type: 'user', id: ownerId },
        patch: await known('deal', {
          stage: d.path[i][0],
          // Close reason is captured at close time, while it is fresh.
          ...(last && d.closeDate !== undefined
            ? { close_date: isoDaysAgo(d.closeDate) }
            : {}),
          ...(last && d.closeReason ? { close_reason: d.closeReason } : {}),
        }),
      })
    }

    // Stage events first (ordered as written), then everything else back to
    // the birth date — order has to be captured before the timestamps move.
    const stageEvents = await db
      .select({ id: attributeEvent.id })
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, ent.id),
          eq(attributeEvent.attrSlug, 'stage'),
        ),
      )
      .orderBy(asc(attributeEvent.at))
    await db
      .update(attributeEvent)
      .set({ at: born })
      .where(eq(attributeEvent.entityId, ent.id))
    const steps = Math.min(stageEvents.length, d.path.length)
    for (let i = 0; i < steps; i++) {
      await db
        .update(attributeEvent)
        .set({ at: at(d.path[i][1]) })
        .where(eq(attributeEvent.id, stageEvents[i].id))
    }

    await db
      .update(entity)
      .set({ createdAt: born })
      .where(eq(entity.id, ent.id))
    await logActivity({
      verb: 'deal.created',
      subject: companyId,
      object: ent.id,
      actorId: ownerId,
      when: born,
    })
    byName.set(d.name, ent.id)
    byCompany.set(d.company, ent.id)
  }
  return { byName, byCompany }
}

async function seedInvestors(userId: string): Promise<Ids> {
  const ids: Ids = new Map()
  for (const inv of INVESTORS) {
    // The domain is the identity key, so a re-run attaches to the firm
    // already on file rather than minting a second copy of it.
    const res = await resolveEntity({
      kind: 'company',
      name: inv.name,
      keys: { domain: inv.domain },
      source: { class: 'import' },
      createdBy: userId,
    })
    ids.set(inv.name, res.entityId)
  }
  return ids
}

async function seedPortfolio(
  companies: Ids,
  dealByCompany: Ids,
  investors: Ids,
  userId: string,
): Promise<number> {
  let created = 0
  for (const h of HOLDINGS) {
    const companyId = companies.get(h.company)
    if (!companyId) continue
    // The event tables are append-only: re-running against a holding that
    // already exists would double every round, mark, and cheque.
    const existing = (
      await db
        .select({ id: holding.id })
        .from(holding)
        .where(eq(holding.companyId, companyId))
    ).at(0)
    if (existing) continue

    const [row] = await db
      .insert(holding)
      .values({
        companyId,
        openedAt: isoDaysAgo(h.opened),
        createdBy: userId,
      })
      .returning({ id: holding.id })
    await logActivity({
      verb: 'holding.created',
      subject: companyId,
      actorId: userId,
      when: at(h.opened),
    })
    created++

    const roundIds: Array<string> = []
    for (const r of h.rounds) {
      const [rr] = await db
        .insert(round)
        .values({
          companyId,
          date: isoDaysAgo(r.days),
          kind: r.kind,
          raised: r.raised?.toString(),
          currency: r.currency,
          preMoney: r.preMoney?.toString(),
          postMoney: r.postMoney?.toString(),
          pricePerShare: r.pricePerShare?.toString(),
          sharesOutstanding: r.sharesOutstanding?.toString(),
          createdBy: userId,
        })
        .returning({ id: round.id })
      roundIds.push(rr.id)
      for (const name of r.coInvestors ?? []) {
        const investorEntityId = investors.get(name)
        if (!investorEntityId) continue
        await db
          .insert(roundCoInvestor)
          .values({ roundId: rr.id, investorEntityId })
          .onConflictDoNothing()
      }
      await logActivity({
        verb: 'round.added',
        subject: companyId,
        actorId: userId,
        when: at(r.days),
      })
    }

    for (const inv of h.investments) {
      await db.insert(investment).values({
        holdingId: row.id,
        dealId: dealByCompany.get(h.company),
        roundId:
          inv.roundIdx === undefined ? undefined : roundIds[inv.roundIdx],
        date: isoDaysAgo(inv.days),
        amount: inv.amount.toString(),
        currency: inv.currency,
        instrument: inv.instrument,
        shares: inv.shares?.toString(),
        cap: inv.cap?.toString(),
        discount: inv.discount?.toString(),
        vehicle: h.vehicle,
        createdBy: userId,
      })
      await logActivity({
        verb: 'investment.added',
        subject: companyId,
        actorId: userId,
        when: at(inv.days),
      })
    }

    for (const m of h.marks) {
      await db.insert(mark).values({
        holdingId: row.id,
        date: isoDaysAgo(m.days),
        fairValue: m.fairValue.toString(),
        currency: m.currency,
        basis: m.basis,
        createdBy: userId,
      })
      await logActivity({
        verb: 'mark.added',
        subject: companyId,
        actorId: userId,
        when: at(m.days),
      })
    }

    for (const dist of h.distributions ?? []) {
      await db.insert(distribution).values({
        holdingId: row.id,
        date: isoDaysAgo(dist.days),
        amount: dist.amount.toString(),
        currency: dist.currency,
        kind: dist.kind,
        sharesSold: dist.sharesSold?.toString(),
        pricePerShare: dist.pricePerShare?.toString(),
        createdBy: userId,
      })
      await logActivity({
        verb:
          dist.kind === 'writeoff'
            ? 'holding.writtenoff'
            : 'distribution.added',
        subject: companyId,
        actorId: userId,
        when: at(dist.days),
      })
    }
  }

  for (const f of FX) {
    await db
      .insert(fxRate)
      .values({
        currency: f.currency,
        date: isoDaysAgo(f.days),
        rateToBase: f.rate.toString(),
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [fxRate.currency, fxRate.date],
        set: { rateToBase: f.rate.toString() },
      })
  }
  return created
}

type Directory = Map<string, { id: string; kind: string }>

async function seedNotes(
  directory: Directory,
  spaces: Ids,
  users: { lead: string; partner: string },
): Promise<number> {
  let created = 0
  for (const n of NOTES) {
    const existing = (
      await db
        .select({ id: entity.id })
        .from(entity)
        .where(and(eq(entity.kind, 'note'), eq(entity.canonicalName, n.title)))
    ).at(0)
    if (existing) continue
    const authorId = n.author === 'lead' ? users.lead : users.partner
    const when = at(n.days)
    const [ent] = await db
      .insert(entity)
      .values({
        kind: 'note',
        canonicalName: n.title,
        sourceClass: 'seed',
        createdBy: authorId,
      })
      .returning({ id: entity.id })

    const mentioned = (n.mentions ?? [])
      .map((name) => {
        const hit = directory.get(name)
        return hit ? { name, ...hit } : null
      })
      .filter(
        (v): v is { name: string; id: string; kind: string } => v !== null,
      )

    // body_json is authoritative; body_md is the derived lane search reads,
    // with mentions in the [[Label|entity:uuid]] form the editor emits.
    const body: NoteBody = [...blocks(n.body)]
    let bodyMd = n.body
    if (mentioned.length > 0) {
      body.push({
        type: 'paragraph',
        content: mentioned.flatMap((m, i) => [
          ...(i > 0 ? [{ type: 'text', text: ' · ', styles: {} }] : []),
          {
            type: 'mention',
            props: {
              entityId: m.id,
              label: m.name,
              kind: m.kind,
              objectSlug: '',
            },
          },
        ]),
      })
      bodyMd += `\n\n${mentioned
        .map((m) => `[[${m.name}|entity:${m.id}]]`)
        .join(' · ')}`
    }

    await db.insert(note).values({
      entityId: ent.id,
      title: n.title,
      bodyJson: body,
      bodyMd,
      kind: n.kind,
      authorId,
      visibility: n.visibility,
      updatedAt: when,
    })
    for (const m of mentioned) {
      await db
        .insert(link)
        .values({
          fromEntityId: ent.id,
          toEntityId: m.id,
          relation: 'mentions',
          source: 'extracted',
          createdBy: authorId,
        })
        .onConflictDoNothing()
    }
    const spaceId = n.space ? spaces.get(n.space) : undefined
    if (spaceId) {
      await db
        .insert(entitySpace)
        .values({
          entityId: ent.id,
          spaceId,
          source: 'manual',
          createdBy: authorId,
        })
        .onConflictDoNothing()
    }
    await db
      .update(entity)
      .set({ createdAt: when })
      .where(eq(entity.id, ent.id))
    await logActivity({
      verb: 'note.created',
      subject: mentioned[0]?.id ?? ent.id,
      object: mentioned[0] ? ent.id : undefined,
      actorId: authorId,
      when,
    })
    created++
  }
  return created
}

async function seedTerms(spaces: Ids, userId: string): Promise<number> {
  let created = 0
  for (const t of TERMS) {
    const existing = (
      await db
        .select({ entityId: term.entityId })
        .from(term)
        .where(eq(term.name, t.name))
    ).at(0)
    if (existing) continue
    const [ent] = await db
      .insert(entity)
      .values({
        kind: 'term',
        canonicalName: t.name,
        sourceClass: 'seed',
        createdBy: userId,
      })
      .returning({ id: entity.id })
    await db.insert(term).values({
      entityId: ent.id,
      name: t.name,
      aliases: t.aliases,
      definitionMd: t.definition,
      spaceId: spaces.get(t.space) ?? null,
    })
    created++
  }
  return created
}

/**
 * Real blobs on disk, so download and preview work, and every extraction
 * state is represented — "still working", "we tried and it broke", and the
 * happy path the search index reads.
 */
async function seedDocuments(
  directory: Directory,
  userId: string,
): Promise<number> {
  let created = 0
  for (const d of DOCUMENTS) {
    const target = directory.get(d.attachTo)
    if (!target) continue
    const existing = (
      await db
        .select({ entityId: document.entityId })
        .from(document)
        .where(eq(document.filename, d.filename))
    ).at(0)
    if (existing) continue

    const bytes = Buffer.from(d.text || `${d.filename}\n`, 'utf8')
    const sha = createHash('sha256').update(bytes).digest('hex')
    await storage().put(sha, bytes, { mime: 'text/plain' })

    const when = at(d.days)
    const [ent] = await db
      .insert(entity)
      .values({
        kind: 'document',
        canonicalName: d.filename,
        sourceClass: 'seed',
        createdBy: userId,
      })
      .returning({ id: entity.id })
    // Exempt from the one-writer rule `lib/documents/birth.test.ts` asserts:
    // these are backdated, pre-extracted fixtures, and birth would stamp them
    // with `now()` and enqueue extraction work for text already written here.
    await db.insert(document).values({
      entityId: ent.id,
      blobSha: sha,
      filename: d.filename,
      mime: 'text/plain',
      sizeBytes: bytes.byteLength,
      kind: d.kind,
      // The row's writer, not a fiction about how the bytes arrived: this
      // file wrote it, and its entity row has said `seed` since SPA-118.
      sourceClass: 'seed',
      extractedText: d.status === 'done' ? d.text : null,
      // Same expression the extraction worker writes — one tsvector config.
      tsv: d.status === 'done' ? sql`to_tsvector('english', ${d.text})` : null,
      extractionStatus: d.status,
      extractionError: d.error ?? null,
      extractedAt: d.status === 'pending' ? null : when,
      uploadedBy: userId,
    })
    await db.insert(link).values({
      fromEntityId: ent.id,
      toEntityId: target.id,
      relation: 'tagged_in',
      source: 'manual',
      createdBy: userId,
    })
    await db
      .update(entity)
      .set({ createdAt: when })
      .where(eq(entity.id, ent.id))
    await logActivity({
      verb: 'document.filed',
      subject: target.id,
      object: ent.id,
      actorId: userId,
      when,
      meta: { filename: d.filename, kind: d.kind },
    })
    created++
  }
  return created
}

/**
 * Interaction history — what "last touched" and relationship strength are
 * computed from. Generated rather than hand-written: the shape matters
 * (who, when, how often), the subjects do not.
 */
async function seedInteractions(
  companies: Ids,
  people: Ids,
  deals: Ids,
  userId: string,
): Promise<number> {
  const marker = '<seed-0-0@dealos.local>'
  const already = (
    await db
      .select({ id: interaction.id })
      .from(interaction)
      .where(eq(interaction.messageId, marker))
  ).at(0)
  if (already) return 0

  let created = 0
  for (const [i, c] of COMPANIES.entries()) {
    const companyId = companies.get(c.name)
    if (!companyId) continue
    const founder = PEOPLE.find((p) => p.at === c.name)
    const personId = founder ? people.get(founder.name) : undefined
    const dealId = deals.get(c.name)
    for (let k = 0; k < 3; k++) {
      const days = Math.round(4 + wobble(i * 7 + k, Math.min(c.added, 300)))
      const kind = (['email', 'meeting', 'call'] as const)[(i + k) % 3]
      const when = at(days, 9 + ((i + k) % 8))
      const [row] = await db
        .insert(interaction)
        .values({
          kind,
          // Was `email_sync` for the email rows — the only writer of a
          // vendor-named lane anywhere in the tree, and the reason SPA-137
          // had a backfill to decide at all. Nothing synced these: this file
          // generated them, so they say `seed` like every other row it
          // writes. The lane a real email arrives by will be an integration
          // row in `source_ref`, not a word in a shared enum.
          sourceClass: 'seed',
          messageId: kind === 'email' ? `<seed-${i}-${k}@dealos.local>` : null,
          threadId: `seed-thread-${i}`,
          subject: `${INTERACTION_SUBJECTS[(i * 3 + k) % INTERACTION_SUBJECTS.length]} — ${c.name}`,
          occurredAt: when,
        })
        .returning({ id: interaction.id })
      for (const id of [companyId, personId, dealId]) {
        if (!id) continue
        await db
          .insert(interactionEntity)
          .values({ interactionId: row.id, entityId: id })
          .onConflictDoNothing()
      }
      if (kind !== 'email') {
        await logActivity({
          verb: `interaction.${kind}`,
          subject: companyId,
          actorId: userId,
          when,
          meta: { interactionId: row.id },
        })
      }
      created++
    }
  }
  return created
}

async function seedTasks(
  directory: Directory,
  users: { lead: string; partner: string },
): Promise<number> {
  let created = 0
  for (const t of TASKS) {
    const existing = (
      await db
        .select({ id: task.id })
        .from(task)
        .where(eq(task.content, t.content))
    ).at(0)
    if (existing) continue
    const assigneeId = t.assignee === 'lead' ? users.lead : users.partner
    const [row] = await db
      .insert(task)
      .values({
        content: t.content,
        // `due` counts forward from today, so a negative one is overdue.
        dueDate: t.due === null ? null : isoDaysAgo(-t.due),
        assigneeId,
        doneAt: t.doneDaysAgo === undefined ? null : at(t.doneDaysAgo),
        createdBy: users.lead,
        createdAt: at(t.created),
      })
      .returning({ id: task.id })
    for (const name of t.entities ?? []) {
      const hit = directory.get(name)
      if (!hit) continue
      await db
        .insert(taskEntity)
        .values({ taskId: row.id, entityId: hit.id })
        .onConflictDoNothing()
    }
    created++
  }
  return created
}

async function seedViews(users: {
  lead: string
  partner: string
}): Promise<number> {
  let created = 0
  for (const v of VIEWS) {
    const objectId = await objectIdForKindAsync(v.object)
    const existing = (
      await db
        .select({ id: view.id })
        .from(view)
        .where(and(eq(view.objectId, objectId), eq(view.name, v.name)))
    ).at(0)
    if (existing) continue
    await db.insert(view).values({
      objectId,
      name: v.name,
      filter: v.filter,
      sort: v.sort,
      columns: v.columns,
      extra: v.extra ?? {},
      visibility: v.visibility,
      createdBy: v.owner === 'lead' ? users.lead : users.partner,
    })
    created++
  }
  return created
}

async function seedTemplates(userId: string): Promise<number> {
  const rows = [
    {
      kind: 'note' as const,
      name: 'Diligence call notes',
      body: NOTE_TEMPLATE_BODY,
      suggestOn: ['company', 'deal'],
      objectKind: null,
    },
    {
      kind: 'record' as const,
      name: 'Deeptech company (defaults)',
      body: {
        values: { funding_stage: 'seed', business_model: ['b2b', 'deep_tech'] },
      },
      suggestOn: ['company'],
      objectKind: 'company',
    },
    {
      kind: 'space' as const,
      name: 'New market scaffold',
      body: SPACE_TEMPLATE_BODY,
      suggestOn: ['space'],
      objectKind: null,
    },
  ]
  let created = 0
  for (const r of rows) {
    const existing = (
      await db
        .select({ id: template.id })
        .from(template)
        .where(eq(template.name, r.name))
    ).at(0)
    if (existing) continue
    await db.insert(template).values({
      kind: r.kind,
      objectKind: r.objectKind,
      name: r.name,
      body: r.body,
      suggestOn: r.suggestOn,
      createdBy: userId,
    })
    created++
  }
  return created
}

/** A custom object with records — the registry-generated /o/ surface. */
async function seedVehicles(companies: Ids, userId: string): Promise<number> {
  const existingObject = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, 'vehicles'))
  ).at(0)
  const objectId =
    existingObject?.id ??
    (
      await Effect.runPromise(
        createObjectProgram({
          singular: 'Vehicle',
          plural: 'Vehicles',
          icon: 'landmark',
          createdBy: userId,
        }),
      )
    ).id

  for (const a of VEHICLE_ATTRS) {
    const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    const held = (
      await db
        .select({ id: attribute.id })
        .from(attribute)
        .where(and(eq(attribute.objectId, objectId), eq(attribute.slug, slug)))
    ).at(0)
    if (held) continue
    await Effect.runPromise(
      createAttributeProgram({
        objectId,
        name: a.name,
        type: a.type,
        options: 'options' in a ? a.options : undefined,
        config: 'config' in a ? a.config : undefined,
        createdBy: userId,
      }),
    )
  }

  let created = 0
  for (const v of VEHICLES) {
    const existing = (
      await db
        .select({ id: entity.id })
        .from(entity)
        .where(
          and(eq(entity.objectId, objectId), eq(entity.canonicalName, v.name)),
        )
    ).at(0)
    if (existing) continue
    const anchor =
      'anchor_company' in v.values
        ? companies.get(String(v.values.anchor_company))
        : undefined
    await Effect.runPromise(
      createRecordProgram({
        objectId,
        name: v.name,
        values: {
          ...v.values,
          ...(anchor
            ? { anchor_company: anchor }
            : { anchor_company: undefined }),
          manager: userId,
        },
        actor: { type: 'user', id: userId },
      }),
    )
    created++
  }
  return created
}

/** The mandate's typed facts; prose stays in its note. */
async function seedMandate(userId: string): Promise<void> {
  const body =
    'We write first cheques into Indian deeptech where the technical risk is real and the buyer is identifiable on day one.\n\n' +
    'Aerospace, defence autonomy, compute infrastructure, energy storage. Pre-seed and seed, occasionally a seed-extension follow-on into a company we already own.\n\n' +
    'We do not write cheques into consumer, into services dressed as software, or into anything whose first customer is a government programme that does not yet exist.\n\n' +
    'We take 21 days from first meeting to a yes or a no, and we say the no out loud.'
  const active = (
    await db
      .select({ id: mandate.id, noteEntityId: mandate.noteEntityId })
      .from(mandate)
      .where(eq(mandate.status, 'active'))
  ).at(0)
  if (active) {
    await db
      .update(mandate)
      .set({
        stages: ['pre_seed', 'seed', 'series_a'],
        geos: ['India', 'Singapore'],
        checkMin: 75000,
        checkMax: 400000,
        currency: 'USD',
        updatedAt: new Date(),
      })
      .where(eq(mandate.id, active.id))
    const held = (
      await db
        .select({ bodyMd: note.bodyMd })
        .from(note)
        .where(eq(note.entityId, active.noteEntityId))
    ).at(0)
    if (!held?.bodyMd) {
      await db
        .update(note)
        .set({ bodyMd: body, bodyJson: blocks(body), title: 'Mandate' })
        .where(eq(note.entityId, active.noteEntityId))
    }
    return
  }
  const [ent] = await db
    .insert(entity)
    .values({
      kind: 'note',
      canonicalName: 'Mandate',
      sourceClass: 'seed',
      createdBy: userId,
    })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: ent.id,
    title: 'Mandate',
    bodyMd: body,
    bodyJson: blocks(body),
    kind: 'memo',
    authorId: userId,
  })
  await db.insert(mandate).values({
    noteEntityId: ent.id,
    stages: ['pre_seed', 'seed', 'series_a'],
    geos: ['India', 'Singapore'],
    checkMin: 75000,
    checkMax: 400000,
    currency: 'USD',
  })
  await logActivity({
    verb: 'mandate.created',
    subject: ent.id,
    actorId: userId,
    when: at(600),
  })
}

/** Names with no identity key: the fuzzy sweep files them, never attaches. */
async function seedNearDuplicates(userId: string): Promise<number> {
  let created = 0
  for (const d of NEAR_DUPES) {
    const existing = (
      await db
        .select({ id: entity.id })
        .from(entity)
        .where(and(eq(entity.kind, d.kind), eq(entity.canonicalName, d.name)))
    ).at(0)
    if (existing) continue
    await resolveEntity({
      kind: d.kind,
      name: d.name,
      source: { class: 'import' },
      createdBy: userId,
    })
    created++
  }
  return created
}

/** Filler for table and filter behaviour at volume. Off by default. */
async function seedBulk(count: number, userId: string): Promise<number> {
  let created = 0
  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(3, '0')
    const res = await resolveEntity({
      kind: 'company',
      name: `Bench Co ${n}`,
      keys: { domain: `benchco${n}.example` },
      source: { class: 'import' },
      createdBy: userId,
      values: await known('company', {
        description: 'Volume filler — safe to delete.',
        funding_stage: ['pre_seed', 'seed', 'series_a', 'series_b_plus'][i % 4],
        location: ['Bengaluru', 'Mumbai', 'Delhi', 'Chennai', 'Pune'][i % 5],
        founded_year: 2015 + (i % 10),
      }),
    })
    if (res.action === 'created') {
      await stamp(res.entityId, at(1 + (i % 400)))
      created++
    }
  }
  return created
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Every table the fixtures touch, children first. Auth, the workspace row,
 * the object registry, the attribute registry, and the credential vault are
 * deliberately absent: a reset clears the *data*, not the deployment — you
 * stay logged in, and custom objects keep their columns.
 */
const DATA_TABLES = [
  'activity',
  'attribute_event',
  'duplicate_candidate',
  'merge_event',
  'entity_alias',
  'entity_space',
  'link',
  'interaction_entity',
  'interaction',
  'signal',
  'enrichment_record',
  'document_chunk',
  'document',
  'mandate',
  'note',
  'term',
  'space',
  'company',
  'person',
  'task_entity',
  'task',
  'view',
  'template',
  'round_co_investor',
  'investment',
  'mark',
  'distribution',
  'round',
  'holding',
  'fx_rate',
  'entity',
]

/** Destructive: drops every record, event, and file reference in the app. */
export async function resetDevData(): Promise<void> {
  const list = DATA_TABLES.map((t) => `"${t}"`).join(', ')
  await db.execute(sql.raw(`truncate table ${list} restart identity cascade`))
}

export type DevSeedSummary = {
  spaces: number
  companies: number
  people: number
  investors: number
  deals: number
  holdings: number
  notes: number
  terms: number
  documents: number
  interactions: number
  tasks: number
  views: number
  templates: number
  vehicles: number
  duplicates: number
  bulk: number
  partner: { email: string; password: string | null }
}

/**
 * Seed the bench. Additive and re-runnable: identity keys make companies
 * and people idempotent, and everything else is guarded on a natural key,
 * so a second run fills gaps rather than doubling the fixture. The one
 * exception is the append-only portfolio tables — a company that already
 * has a holding is skipped whole, because there is no such thing as
 * re-inserting a cheque.
 */
export async function seedDevData(opts: {
  userId: string
  bulk?: number
}): Promise<DevSeedSummary> {
  const { userId } = opts
  const partner = await seedPartner()
  const users = { lead: userId, partner: partner.id }

  await seedCustomCompanyAttributes(userId)
  const spaces = await seedSpaces()
  const companies = await seedCompanies(spaces, userId)
  const people = await seedPeople(companies, userId)
  const investors = await seedInvestors(userId)
  const deals = await seedDeals(companies, people, users)

  const directory: Directory = new Map()
  for (const [name, id] of companies)
    directory.set(name, { id, kind: 'company' })
  for (const [name, id] of people) directory.set(name, { id, kind: 'person' })
  for (const [name, id] of deals.byName)
    directory.set(name, { id, kind: 'deal' })

  const holdings = await seedPortfolio(
    companies,
    deals.byCompany,
    investors,
    userId,
  )
  const notes = await seedNotes(directory, spaces, users)
  const terms = await seedTerms(spaces, userId)
  const documents = await seedDocuments(directory, userId)
  const interactions = await seedInteractions(
    companies,
    people,
    deals.byCompany,
    userId,
  )
  const tasks = await seedTasks(directory, users)
  const views = await seedViews(users)
  const templates = await seedTemplates(userId)
  const vehicles = await seedVehicles(companies, userId)
  await seedMandate(userId)
  const duplicates = await seedNearDuplicates(userId)
  const bulk = opts.bulk ? await seedBulk(opts.bulk, userId) : 0

  return {
    spaces: spaces.size,
    companies: companies.size,
    people: people.size,
    investors: investors.size,
    deals: deals.byName.size,
    holdings,
    notes,
    terms,
    documents,
    interactions,
    tasks,
    views,
    templates,
    vehicles,
    duplicates,
    bulk,
    partner: { email: PARTNER.email, password: partner.password },
  }
}
