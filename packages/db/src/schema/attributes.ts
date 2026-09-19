import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { entity } from './entities'
import { integration } from './integrations'
import { objectDef } from './objects'
import type { IdentityKey } from './objects'
import { user } from './auth'
import type { Json } from '../json'

/**
 * The payload of `attribute.options`, declared at the column that claims it
 * and re-exported by the registry that validates against it
 * (`apps/web/src/lib/attributes/registry.ts` — SPA-142). Only the shapes
 * moved: the type menu, the validators, the seeded SYSTEM_ATTRIBUTES and the
 * badge palette are behaviour and stayed in the app.
 */

/** The three core object kinds; `entity.kind` is the wider vocabulary. */
export type ObjectKind = 'company' | 'person' | 'deal'

/** The badge colour vocabulary — `apps/web/src/lib/attributes/colors.ts`. */
export type BadgeColor =
  | 'slate'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'fuchsia'
  | 'rose'
  | 'orange'
  | 'amber'
  | 'lime'
  | 'emerald'
  | 'teal'
  | 'cyan'

export type SelectOption = {
  id: string
  label: string
  /** status only: funnel semantics for kanban/filters */
  group?: 'active' | 'parked' | 'closed'
  /** one of BADGE_COLORS; absent falls back to the option's position */
  color?: BadgeColor
  /** retired: hidden from write pickers, writes rejected, stored values kept */
  archived?: boolean
}

export type AttributeOptions = {
  options?: Array<SelectOption>
  /** record_reference — a core kind, or any object row (custom objects) */
  targetKind?: ObjectKind
  targetObjectId?: string
  multi?: boolean
  required?: boolean
  /** currency */
  code?: string
  /** rating */
  max?: number
  /** number: display decimals; stored numbers untouched */
  precision?: number
  /**
   * This attribute backs one of its object's declared identity keys (spec
   * §9). Set by `createObjectProgram` when the key is declared, in the same
   * transaction as the object row; the write path reads it instead of
   * guessing at slugs, and archiving is refused while the key stands.
   */
  identityKey?: IdentityKey
  /**
   * Default (spec §4): a static value in the type's write shape, or one of
   * exactly two dynamic forms — `'current-user'` (actor_reference) and an
   * ISO-8601 duration for dates (`'P7D'` = a week out). Fires on every
   * creation path, fills blanks only. Validated at attribute save
   * (`validateDefault`), resolved at record birth (`resolveDefault`).
   */
  default?: Json
}

/**
 * The attribute engine (CONTEXT.md "Attribute engine"). Every object — core
 * or custom — carries a registry of attributes keyed by object_id; ALL
 * values (system and custom) live in entity.values jsonb keyed by slug.
 * Identity, kind, canonical_name never enter this system.
 */

/** Fixed menu — users define attributes, never types. */
export const attributeType = pgEnum('attribute_type', [
  'text',
  'number',
  'currency',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'status',
  'domain',
  'email',
  'url',
  'phone',
  'rating',
  'record_reference',
  'actor_reference',
])

export const attribute = pgTable(
  'attribute',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objectDef.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    // Optional, human-facing. The expansion path (spec §8) later feeds it to
    // the AI extract lane as prompt context; today it's help text.
    description: text('description'),
    type: attributeType('type').notNull(),
    /**
     * Per-type config: select/multi_select/status → {options: [{id, label,
     * color?, group?}]} (status groups: active|parked|closed);
     * record_reference → {targetKind, multi, required};
     * currency → {code}; rating → {max}.
     */
    options: jsonb('options').$type<AttributeOptions>().notNull().default({}),
    // System attrs ship with the product: non-deletable, archivable only.
    // Their *options* stay editable — structure fixed, content free.
    isSystem: boolean('is_system').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('attribute_object_slug_unique').on(t.objectId, t.slug)],
)

/**
 * Who *attended* to a value — never merely who caused the flow (spec §4,
 * grilled 2026-09). A sync-created value is `integration`, traceable to
 * whoever connected it through the integration's own config; the merge
 * executor's rewrites are `system`. Attio's typed-actor idea without its
 * polymorphic (type, id) pair: `actor_id` stays a real user FK, set iff
 * type = 'user', and `actor_ref` is a real integration FK, set iff
 * type = 'integration' (SPA-70 — the integration table exists now, so the
 * second half of the invariant is a constraint rather than a comment).
 */
export const actorType = pgEnum('actor_type', ['user', 'integration', 'system'])

/**
 * Which door the value came through — orthogonal to actor_type. A user
 * accepting an AI suggestion is `user` + `suggestion`; an Apollo fill-blank
 * is `integration` + `enrichment`; a default firing in the create dialog is
 * `user` + `default`.
 */
export const attributeEventSource = pgEnum('attribute_event_source', [
  'direct',
  'default',
  'suggestion',
  'enrichment',
  'import',
  'merge',
  'seed',
])

/**
 * Per-attribute change history — one row per changed attribute, written in
 * the same transaction as the value write. Deal stage history is
 * `attr_slug = 'stage'`. Timeline condenses bursts at read time.
 *
 * Provenance lives on the event, not only on the suggestion row: once a
 * suggestion is accepted, this row is what "from p.4 of the deck" joins to.
 */
export const attributeEvent = pgTable(
  'attribute_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    attrSlug: text('attr_slug').notNull(),
    from: jsonb('from').$type<Json>(),
    to: jsonb('to').$type<Json>(),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id').references(() => user.id),
    /**
     * Which integration attended to the value — the same row `source_ref`
     * will point at, so the record timeline's "which integration wrote this"
     * and the provenance stamp cannot disagree.
     */
    actorRef: uuid('actor_ref').references(() => integration.id),
    source: attributeEventSource('source').notNull().default('direct'),
    // No FK yet: the suggestion table lands with the review inbox. Added
    // then, same pattern as the integration FK on actor.
    suggestionId: uuid('suggestion_id'),
    // Citation refs — spec-ai-substrate `ContextItem.ref` ids, or an
    // enrichment_record id. Array of strings; null when there's no receipt.
    refs: jsonb('refs').$type<Array<string>>(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attribute_event_entity_idx').on(t.entityId, t.at),
    index('attribute_event_slug_idx').on(t.entityId, t.attrSlug),
    // actor_type = 'user' ⇔ actor_id set, and actor_type = 'integration' ⇔
    // actor_ref set (spec §4 invariant, both halves). Biconditionals, not
    // implications: a `system` row carrying an integration id would be a
    // provenance lie in the other direction, and an integration write that
    // cannot say *which* integration is the hole this column closes.
    check(
      'attribute_event_actor_invariant',
      sql`(${t.actorType} = 'user') = (${t.actorId} IS NOT NULL) AND (${t.actorType} = 'integration') = (${t.actorRef} IS NOT NULL)`,
    ),
  ],
)
