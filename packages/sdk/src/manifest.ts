import type { SchemaIssue } from 'effect'
import { JsonSchema, Predicate, Result, Schema, SchemaParser } from 'effect'
import { DOMAIN_EVENTS, PORT_NAMES } from './contract.ts'
import { issuesOf } from './issues.ts'
import type { PortName } from './contract.ts'
import { isVersion, parseSdkRange } from './range.ts'
import { ENRICHMENT_VOCABULARY, isVocabularyKey } from './vocabulary.ts'

/**
 * The manifest.
 *
 * Authored once, as a TS const whose `settings` is an Effect schema
 * (`defineManifest`), and emitted by the plugin build as `manifest.json` with
 * `settings` serialised as JSON Schema (`settingsJsonSchema`). Web reads the
 * JSON and renders the settings card without loading the bundle — that is
 * why the on-disk shape carries JSON Schema and the authored one a schema.
 * `decodeManifest` reads the on-disk shape; the build runs it on what it
 * writes and the loader on what it reads.
 *
 * There is no plugin-level `kind`. Each job declares a `trigger`, which
 * fixes what it is handed and returns, and the ports it `uses`, which the
 * loader grants for that (integration, job) and nothing more. `provides:
 * 'storage-source'` is a provider interface core calls into, not a job.
 */

/**
 * The six triggers (`watch` from SDK 1.5). Closed and
 * semver-frozen: a new one is a minor.
 */
export const TRIGGERS = [
  'action',
  'schedule',
  'event',
  'webhook',
  'file',
  'watch',
] as const
export type Trigger = (typeof TRIGGERS)[number]

/**
 * The jobs a plugin does for the operator, as the Plugins catalogue groups
 * them. Optional on the manifest and on the registry entry, so the
 * catalogue can group a plugin before it is installed. A new role is a minor.
 */
export const ROLES = [
  'enrichment',
  'research',
  'email-calendar',
  'files',
  'meeting-notes',
  'import',
  'feeds',
] as const
export type PluginRole = (typeof ROLES)[number]

/**
 * The plugin id: the `source_ref` slug, the `plugin_<id>` schema name and the
 * `plugin.<id>.<job>` queue prefix, frozen after first publish. Lowercase
 * letters, digits and single hyphens. Dots are reserved — first-party channel
 * rows are `core.*` (the mailbox's `core.mailbox`) and a plugin must never be
 * able to name itself into that namespace.
 */
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** A job name: the last segment of `plugin.<id>.<job>`, so no dots either. */
const JOB_NAME = /^[a-z][a-zA-Z0-9]*(?:[-_][a-zA-Z0-9]+)*$/

/** `60s`, `500ms`, `5m`, `1h` — the job timeout. */
const DURATION = /^[1-9]\d*(?:ms|s|m|h)$/

/** A five-field cron expression, as `boss.schedule` takes it. */
const CRON = /^\S+(?:\s+\S+){4}$/

/** Whether a manifest pattern compiles, as web will compile it. */
const compiles = (pattern: string): boolean => {
  try {
    new RegExp(pattern, 'i')
    return true
  } catch {
    return false
  }
}

/**
 * One of `values`, refused with `refused(input)` so the operator reads which
 * name was wrong and where the list lives.
 */
const oneOf = <const TValues extends ReadonlyArray<string>>(
  values: TValues,
  refused: (input: string) => string,
) =>
  Schema.String.check(
    // Aborts, so the refinement below never adds a second, wordless issue.
    Schema.makeFilter(
      (s: string) => values.includes(s) || refused(s),
      undefined,
      true,
    ),
  ).pipe(Schema.refine((s): s is TValues[number] => values.includes(s)))

/** A list that names each entry once. */
const distinct = (message: string) =>
  Schema.makeFilter(
    (list: ReadonlyArray<string>) =>
      new Set(list).size === list.length || message,
  )

/** Whether `text` parses as a URL whose scheme `scheme` accepts. */
const urlWith = (text: string, scheme: RegExp): boolean => {
  if (!URL.canParse(text)) return false
  return scheme.test(new URL(text).protocol.replace(/:$/, ''))
}

const nonEmpty = Schema.String.check(Schema.isMinLength(1))

const jobSchema = Schema.Struct({
  trigger: Schema.Literals(TRIGGERS),
  // The ports this job is granted — the admin reads this list at install,
  // and the loader's Layer holds exactly these.
  uses: Schema.Array(
    oneOf(
      PORT_NAMES,
      (input) =>
        `unknown port ${JSON.stringify(input)} — uses names ports from PORT_NAMES (${PORT_NAMES.join(', ')})`,
    ),
  ).check(Schema.isMinLength(1)),
  schedule: Schema.optional(
    Schema.String.check(
      Schema.isPattern(CRON, {
        message: 'schedule is a five-field cron expression',
      }),
    ),
  ),
  on: Schema.optional(
    Schema.Array(
      oneOf(
        DOMAIN_EVENTS,
        (input) =>
          `unknown event ${JSON.stringify(input)} — on names events from DOMAIN_EVENTS (${DOMAIN_EVENTS.join(', ')})`,
      ),
    ).check(Schema.isMinLength(1)),
  ),
  concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  timeout: Schema.optional(
    Schema.String.check(
      Schema.isPattern(DURATION, {
        message: 'timeout is a duration like 60s or 500ms',
      }),
    ),
  ),
  retry: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  interactive: Schema.optional(Schema.Boolean),
  // An action the host prepares and sends on no record — Send on a draft:
  // its job is handed `{ payload }`, never `{ entityId }`. (SDK 1.5)
  input: Schema.optional(Schema.Literal('payload')),
  // A file job's claim on dropped files: a pattern, matched
  // case-insensitively against the filename, that web reads from the stored
  // manifest to route a drop without running plugin code. (SDK 1.1)
  accepts: Schema.optional(
    Schema.Struct({
      filename: nonEmpty.check(
        Schema.makeFilter(
          (pattern: string) =>
            compiles(pattern) || 'accepts.filename is a regular expression',
        ),
      ),
    }),
  ),
  // A watch job's own settings — what one `space_watch` row holds — as JSON
  // Schema, rendered as the watch form like the plugin's settings. (SDK 1.5)
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

/**
 * The ports a `provides: 'storage-source'` plugin is never granted, in any
 * job: it is a bytes pipe with hints — core files what it delivers and fires
 * its own features on `document.extracted`.
 */
export const STORAGE_SOURCE_WITHHELD = [
  'Facts',
  'Ai',
] as const satisfies ReadonlyArray<PortName>

export const ACTION_TARGETS = ['company', 'person', 'deal'] as const

const actionSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(JOB_NAME)),
  label: nonEmpty,
  on: Schema.Literals(ACTION_TARGETS),
  job: nonEmpty,
  // An enrich action's vocabulary keys: what the host's Enrichment page
  // shows it can fill. Each key describes the action's own kind. (SDK 1.5)
  answers: Schema.optional(
    Schema.Array(
      Schema.String.check(
        Schema.makeFilter(
          (key: string) =>
            isVocabularyKey(key) ||
            `${JSON.stringify(key)} is not in the enrichment vocabulary`,
        ),
      ),
    ).check(Schema.isMinLength(1), distinct('answers names each key once')),
  ),
})

/** An HTTP header name, as `auth.header` spells the one the key goes in. */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/

/**
 * A plugin's remote MCP server, which Ask mounts for a turn while the
 * integration runs. (SDK 1.5)
 * - `url` is https: the workspace key travels with every call.
 * - `auth.header` names the header the key from `requires.credential` goes
 *   in, never the URL, so no error line can carry it; `scheme` prefixes it.
 */
const mcpSchema = Schema.Struct({
  url: Schema.String.check(
    Schema.makeFilter(
      (url: string) => urlWith(url, /^https$/) || 'mcp.url is an https URL',
    ),
  ),
  auth: Schema.Struct({
    header: Schema.String.check(
      Schema.isPattern(HEADER_NAME, {
        message: 'mcp.auth.header is an HTTP header name',
      }),
    ),
    scheme: Schema.optional(Schema.Literal('Bearer')),
  }),
})

const manifestFields = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  id: Schema.String.check(
    Schema.isPattern(PLUGIN_ID, {
      message:
        'id is lowercase letters, digits and hyphens — no uppercase, and no dots (core.* is reserved for first-party channels)',
    }),
  ),
  version: Schema.String.check(
    Schema.makeFilter(
      (v: string) => isVersion(v) || 'version is major.minor.patch',
    ),
  ),
  sdk: Schema.String.check(
    Schema.makeFilter(
      (r: string) =>
        parseSdkRange(r) !== null ||
        'sdk is a range: ^x.y, ~x.y or an exact x.y.z',
    ),
  ),
  name: nonEmpty,
  description: nonEmpty,
  icon: Schema.optional(nonEmpty),
  // What the catalogue groups it under (SDK 1.4). Absent → "Other".
  roles: Schema.optional(
    Schema.Array(
      oneOf(
        ROLES,
        (input) =>
          `unknown role ${JSON.stringify(input)} — roles name jobs from ROLES (${ROLES.join(', ')})`,
      ),
    ).check(Schema.isMinLength(1), distinct('roles names each role once')),
  ),
  requires: Schema.optional(
    Schema.Struct({
      credential: Schema.optional(
        Schema.Struct({
          kind: Schema.Literals(['enrichment', 'search', 'llm']),
          scope: Schema.Literal('workspace'),
        }),
      ),
      // An OAuth grant with its scopes, or a key each member pastes for
      // their own account (`key: true`, SDK 1.5): then every
      // schedule job runs once per member's connection.
      connection: Schema.optional(
        Schema.Union([
          Schema.Struct({
            provider: nonEmpty,
            scopes: Schema.Array(nonEmpty).check(Schema.isMinLength(1)),
          }),
          Schema.Struct({ provider: nonEmpty, key: Schema.Literal(true) }),
        ]),
      ),
    }),
  ),
  // JSON Schema, emitted from the authored settings schema by the build.
  settings: Schema.Record(Schema.String, Schema.Unknown),
  // Job names are checked below rather than as the record's key schema, so
  // the refusal names the job.
  jobs: Schema.Record(Schema.String, jobSchema),
  ingress: Schema.optional(
    Schema.Struct({ signature: Schema.Literals(['hmac-sha256', 'none']) }),
  ),
  actions: Schema.optional(Schema.Array(actionSchema)),
  http: Schema.optional(
    Schema.Struct({
      rateLimit: Schema.optional(
        Schema.Struct({ rpm: Schema.Int.check(Schema.isGreaterThan(0)) }),
      ),
    }),
  ),
  provides: Schema.optional(Schema.Literal('storage-source')),
  mcp: Schema.optional(mcpSchema),
  sensitivity: Schema.optional(Schema.Literal('inherit')),
})

type ManifestFields = typeof manifestFields.Type

/** The rules that span fields, each refusal at the path it is about. */
const crossChecks = (m: ManifestFields): Array<Schema.FilterIssue> => {
  const found: Array<Schema.FilterIssue> = []
  const add = (path: ReadonlyArray<PropertyKey>, issue: string) =>
    found.push({ path, issue })
  const jobs = Object.entries(m.jobs)
  for (const [name, job] of jobs) {
    if (!JOB_NAME.test(name))
      add(
        ['jobs', name],
        'a job name is a letter then letters, digits, - or _ — no dots (it is the last segment of plugin.<id>.<job>)',
      )
    if ((job.trigger === 'schedule') !== (job.schedule !== undefined))
      add(
        ['jobs', name, 'schedule'],
        job.trigger === 'schedule'
          ? 'a schedule job needs schedule'
          : `schedule is only for a schedule job, and ${name} is ${job.trigger}`,
      )
    if (job.input !== undefined && job.trigger !== 'action')
      add(
        ['jobs', name, 'input'],
        `input is only for an action job, and ${name} is ${job.trigger}`,
      )
    if (job.accepts !== undefined && job.trigger !== 'file')
      add(
        ['jobs', name, 'accepts'],
        `accepts is only for a file job, and ${name} is ${job.trigger}`,
      )
    if ((job.trigger === 'event') !== (job.on !== undefined))
      add(
        ['jobs', name, 'on'],
        job.trigger === 'event'
          ? 'an event job needs on'
          : `on is only for an event job, and ${name} is ${job.trigger}`,
      )
    if ((job.trigger === 'watch') !== (job.settings !== undefined))
      add(
        ['jobs', name, 'settings'],
        job.trigger === 'watch'
          ? 'a watch job needs settings — the schema of what one watch holds, rendered as its form'
          : `settings on a job is only for a watch job, and ${name} is ${job.trigger}`,
      )
    if (m.provides === 'storage-source')
      job.uses.forEach((port, i) => {
        if (STORAGE_SOURCE_WITHHELD.some((withheld) => withheld === port))
          add(
            ['jobs', name, 'uses', i],
            `a storage-source plugin is granted no ${STORAGE_SOURCE_WITHHELD.join(' and no ')} port — it delivers bytes and never decides filing or calls Ai, and ${name} uses ${port}`,
          )
      })
  }
  // A `space_watch` row names its integration, not a job.
  const watches = jobs.filter(([, j]) => j.trigger === 'watch')
  if (watches.length > 1)
    add(
      ['jobs', watches[1][0]],
      `a plugin declares at most one watch job — a watch names its plugin, not a job — and this one declares ${watches.map(([n]) => n).join(', ')}`,
    )
  if (m.mcp !== undefined && m.requires?.credential === undefined)
    add(
      ['mcp'],
      'an mcp server needs requires.credential — its key comes from the vault, never the manifest',
    )
  const hasWebhook = jobs.some(([, j]) => j.trigger === 'webhook')
  if (hasWebhook !== (m.ingress !== undefined))
    add(
      ['ingress'],
      hasWebhook
        ? 'a plugin with a webhook job needs ingress'
        : 'ingress is only for a plugin with a webhook job',
    )
  m.actions?.forEach((action, i) => {
    action.answers?.forEach((key, k) => {
      const entry = isVocabularyKey(key) ? ENRICHMENT_VOCABULARY[key] : null
      if (entry !== null && entry.kind !== action.on)
        add(
          ['actions', i, 'answers', k],
          `action ${action.id} is on ${action.on}, and ${key} describes a ${entry.kind}`,
        )
    })
    const job = Object.hasOwn(m.jobs, action.job)
      ? m.jobs[action.job]
      : undefined
    if (job?.trigger !== 'action')
      add(
        ['actions', i, 'job'],
        job
          ? `action ${action.id} names job ${action.job}, whose trigger is ${job.trigger}, not action`
          : `action ${action.id} names job ${action.job}, which the manifest does not declare`,
      )
    else if (job.input === 'payload')
      add(
        ['actions', i, 'job'],
        `action ${action.id} names job ${action.job}, which takes the host's payload and runs on no record`,
      )
  })
  return found
}

/**
 * The on-disk manifest (`manifest.json`). Every object in it is closed: an
 * unknown key is refused at any depth, however the schema is decoded.
 */
export const manifestSchema = manifestFields
  .check(Schema.makeFilter(crossChecks))
  // After the check: a schema with checks reads its parse options off the
  // last one, and they reach every struct inside it.
  .annotate({ parseOptions: { onExcessProperty: 'error', errors: 'all' } })

export type Manifest = typeof manifestSchema.Type
export type JobDeclaration = Manifest['jobs'][string]

/** One reason a manifest is refused: where, and what to change. */
export type ManifestIssue = {
  readonly path: ReadonlyArray<PropertyKey>
  readonly message: string
}

/** A manifest refused, every issue with its path; `message` lists them. */
export class ManifestRefused extends Schema.TaggedError<ManifestRefused>()(
  'ManifestRefused',
  {
    message: Schema.String,
    issues: Schema.Array(
      Schema.Struct({
        path: Schema.Array(Schema.PropertyKey),
        message: Schema.String,
      }),
    ),
  },
) {}

/**
 * An unknown key is reported on the object that holds it, as the loader has
 * always worded it; `kind` at the top gets its own sentence.
 */
const unrecognized = (
  at: ReadonlyArray<PropertyKey>,
  key: PropertyKey,
): ManifestIssue => ({
  path: at,
  message:
    at.length === 0 && key === 'kind'
      ? 'kind is not a manifest field (D51): a plugin has no kind — each job declares a trigger and the ports it uses'
      : `Unrecognized key: ${JSON.stringify(String(key))}`,
})

const flatten = (
  issue: SchemaIssue.Issue,
  at: ReadonlyArray<PropertyKey>,
): Array<ManifestIssue> => {
  switch (issue._tag) {
    case 'Pointer':
      return issue.issue._tag === 'UnexpectedKey'
        ? issue.path.map((key) => unrecognized(at, key))
        : flatten(issue.issue, [...at, ...issue.path])
    case 'Composite':
      return issue.issues.flatMap((inner) => flatten(inner, at))
    case 'Encoding':
      return flatten(issue.issue, at)
    case 'AnyOf':
      if (issue.issues.length > 0)
        return issue.issues.flatMap((inner) => flatten(inner, at))
      break
    default:
      break
  }
  return issuesOf(issue).map(({ message, path }) => ({
    path: [...at, ...path],
    message,
  }))
}

const decodeFields = SchemaParser.decodeUnknownResult(manifestSchema)

/** The result of reading a manifest: the manifest, or why it is refused. */
export type ManifestRead =
  | { readonly success: true; readonly data: Manifest }
  | { readonly success: false; readonly error: ManifestRefused }

/**
 * A `manifest.json` (or a stored manifest) read against `manifestSchema`.
 * Each issue reads `<path>: <message>` in `error.message`, joined by `; `.
 */
export const decodeManifest = (raw: unknown): ManifestRead => {
  const decoded = decodeFields(raw)
  if (Result.isSuccess(decoded)) return { success: true, data: decoded.success }
  const issues = flatten(decoded.failure, [])
  return {
    success: false,
    error: new ManifestRefused({
      message: issues
        .map(({ path, message }) => `${path.map(String).join('.')}: ${message}`)
        .join('; '),
      issues,
    }),
  }
}

/**
 * A plugin's settings as authored: a struct whose fields are what the
 * operator sets. A field with `Schema.withDecodingDefaultKey` is optional on
 * the form and shows its default; a field without one is required unless it
 * is `Schema.optionalKey`.
 */
export type SettingsSchema = Schema.Struct<Schema.Struct.Fields> & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

/**
 * The authored manifest: the on-disk shape with `settings` as the Effect
 * schema the Config port will be typed by. `jobs` is a record here so a const
 * literal keeps its job names — `definePlugin` constrains the bundle's job
 * functions to exactly those keys.
 */
export type AuthoredManifest = Omit<Manifest, 'settings' | 'jobs'> & {
  readonly settings: SettingsSchema
  readonly jobs: { readonly [name: string]: AuthoredJob }
}

/**
 * A job as authored. `uses` and `on` are readonly so a `const` literal keeps
 * them as tuples — `['Identity']` stays `'Identity'`, not `PortName` — which
 * is what lets `definePlugin` bound the job's `R` by exactly what it declared.
 * A watch job's `settings` is the schema `watchSettingsOf` decodes by.
 */
export type AuthoredJob = Omit<JobDeclaration, 'uses' | 'on' | 'settings'> & {
  readonly uses: ReadonlyArray<JobDeclaration['uses'][number]>
  readonly on?: ReadonlyArray<NonNullable<JobDeclaration['on']>[number]>
  readonly settings?: SettingsSchema
}

/**
 * Identity at runtime; at the type level it keeps the literal job names (the
 * `const` type parameter) and checks the shape as it is written.
 */
export const defineManifest = <const TManifest extends AuthoredManifest>(
  manifest: TManifest,
): TManifest => manifest

type JsonSchemaObject = { readonly [key: string]: unknown }

/**
 * Effect's output in the shape the settings form reads, at every depth:
 * - `additionalProperties: false` comes off every object: decoding ignores a
 *   key the settings do not name, so the keyword would be a claim the
 *   decoder does not keep.
 * - An `anyOf` of one schema is that schema (`Schema.Literals(['a'])`).
 */
const normalized = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(normalized)
  if (!Predicate.isObject(node)) return node
  const anyOf = node['anyOf']
  if (Array.isArray(anyOf) && anyOf.length === 1) {
    const { anyOf: _, ...rest } = node
    const only: unknown = anyOf[0]
    if (Predicate.isObject(only)) return normalized({ ...rest, ...only })
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(
        ([key, value]) =>
          !(key === 'additionalProperties' && value === false) ||
          !Object.hasOwn(node, 'type'),
      )
      .map(([key, value]) => [key, normalized(value)]),
  )
}

/**
 * The default the field decodes to when the key is absent, encoded as the
 * operator would type it; `undefined` when absence is not filled in.
 */
const defaultOf = (settings: SettingsSchema, key: string) => {
  // One field of a settings struct needs no services: the struct's are never.
  const one = Schema.make<Schema.Codec<object, object>>(
    Schema.Struct({ [key]: settings.fields[key] }).ast,
  )
  const decoded = SchemaParser.decodeUnknownResult(one)({})
  if (Result.isFailure(decoded) || !Object.hasOwn(decoded.success, key))
    return undefined
  const encoded = SchemaParser.encodeUnknownResult(one)(decoded.success)
  return Result.isSuccess(encoded) && Predicate.isObject(encoded.success)
    ? encoded.success[key]
    : undefined
}

/**
 * The settings block as web renders it: JSON Schema (draft 2020-12) of what
 * the operator *types*, so a field with a default is optional on the form
 * and carries its `default`.
 * - `propertyOrder` names the properties in declaration order: the host
 *   stores the manifest as jsonb, which keeps object keys sorted, so the
 *   order the form draws in has to travel as a list. (SDK 1.5)
 * - Annotate a field before its checks (`Schema.String.annotate({ title })
 *   .check(...)`): an annotation after a check describes the check, and
 *   lands in an `allOf` the form does not read.
 */
export const settingsJsonSchema = (
  settings: SettingsSchema,
): JsonSchemaObject => {
  const keys = Object.keys(settings.fields)
  const header = { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12 }
  // An empty struct accepts any object or array; the form reads it as none.
  if (keys.length === 0)
    return { ...header, type: 'object', properties: {}, propertyOrder: [] }
  const document = Schema.toJsonSchemaDocument(settings)
  const root = normalized(document.schema)
  if (!Predicate.isObject(root) || !Predicate.isObject(root['properties']))
    return { ...header, ...document.schema }
  const declared = root['properties']
  const properties = Object.fromEntries(
    Object.entries(declared).map(([key, property]) => {
      const fallback = Object.hasOwn(settings.fields, key)
        ? defaultOf(settings, key)
        : undefined
      return [
        key,
        fallback === undefined || !Predicate.isObject(property)
          ? property
          : { default: fallback, ...property },
      ]
    }),
  )
  const definitions = Object.keys(document.definitions).length
  return {
    ...header,
    ...root,
    properties,
    ...(definitions > 0 ? { $defs: normalized(document.definitions) } : {}),
    propertyOrder: keys,
  }
}

/**
 * The authored manifest as it goes on disk: settings — the plugin's and a
 * watch job's — through `settingsJsonSchema`, then read by `decodeManifest`:
 * a build that would write a manifest the loader refuses fails here instead,
 * throwing `ManifestRefused`.
 */
export const toManifestJson = (manifest: AuthoredManifest): Manifest => {
  const read = decodeManifest({
    ...manifest,
    settings: settingsJsonSchema(manifest.settings),
    jobs: Object.fromEntries(
      Object.entries(manifest.jobs).map(([name, job]) => [
        name,
        job.settings === undefined
          ? job
          : { ...job, settings: settingsJsonSchema(job.settings) },
      ]),
    ),
  })
  if (!read.success) throw read.error
  return read.data
}

/**
 * The provider whose members each paste their own key (`requires.connection.key`,
 * SDK 1.5): the host runs this plugin's schedule jobs once per such connection.
 * Null for a plugin bound to one OAuth grant, or to none.
 */
export const keyedProviderOf = (manifest: Manifest): string | null => {
  const connection = manifest.requires?.connection
  return connection !== undefined && 'key' in connection
    ? connection.provider
    : null
}
