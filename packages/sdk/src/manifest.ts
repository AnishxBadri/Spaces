import { z } from 'zod'
import { DOMAIN_EVENTS, PORT_NAMES } from './contract.ts'
import type { PortName } from './contract.ts'
import { isVersion, parseSdkRange } from './range.ts'
import { ENRICHMENT_VOCABULARY, isVocabularyKey } from './vocabulary.ts'

/**
 * The manifest (docs/spec-plugin-sdk.md §3, amended 2026-09-30 by D51).
 *
 * Authored once, as a TS const whose `settings` is a zod schema
 * (`defineManifest`), and emitted by the plugin build as `manifest.json` with
 * `settings` serialised through `z.toJSONSchema` (`toManifestJson`). Web reads
 * the JSON and renders the settings card without loading the bundle — that is
 * why the on-disk shape carries JSON Schema and the authored one carries zod.
 * `manifestSchema` validates the on-disk shape; the build runs it on what it
 * writes and the loader on what it reads.
 *
 * There is no plugin-level `kind` (D51). Each job declares a `trigger`, which
 * fixes what it is handed and returns, and the ports it `uses`, which the
 * loader grants for that (integration, job) and nothing more. `provides:
 * 'storage-source'` is a provider interface core calls into, not a job.
 */

/**
 * The six triggers (D51; `watch` since SDK 1.5, D72). Closed and
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
 * them (D81). Optional on the manifest and on the registry entry, so the
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

const jobSchema = z.strictObject({
  trigger: z.enum(TRIGGERS),
  // The ports this job is granted — the admin reads this list at install,
  // and the loader's Layer holds exactly these (D51).
  uses: z
    .array(
      z.enum(PORT_NAMES, {
        error: (issue) =>
          `unknown port ${JSON.stringify(issue.input)} — uses names ports from PORT_NAMES (${PORT_NAMES.join(', ')})`,
      }),
    )
    .min(1),
  schedule: z
    .string()
    .regex(CRON, { error: 'schedule is a five-field cron expression' })
    .optional(),
  on: z
    .array(
      z.enum(DOMAIN_EVENTS, {
        error: (issue) =>
          `unknown event ${JSON.stringify(issue.input)} — on names events from DOMAIN_EVENTS (${DOMAIN_EVENTS.join(', ')})`,
      }),
    )
    .min(1)
    .optional(),
  concurrency: z.int().positive().optional(),
  timeout: z
    .string()
    .regex(DURATION, { error: 'timeout is a duration like 60s or 500ms' })
    .optional(),
  retry: z.int().nonnegative().optional(),
  interactive: z.boolean().optional(),
  // An action the host prepares and sends on no record — Send on a draft:
  // its job is handed `{ payload }`, never `{ entityId }`. (SDK 1.5)
  input: z.literal('payload').optional(),
  // A file job's claim on dropped files: a pattern, matched
  // case-insensitively against the filename, that web reads from the stored
  // manifest to route a drop without running plugin code. (SDK 1.1)
  accepts: z
    .strictObject({
      filename: z.string().min(1).refine(compiles, {
        error: 'accepts.filename is a regular expression',
      }),
    })
    .optional(),
  // A watch job's own settings — what one `space_watch` row holds — as JSON
  // Schema, rendered as the watch form like the plugin's settings. (SDK 1.5)
  settings: z.record(z.string(), z.unknown()).optional(),
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

const actionSchema = z.strictObject({
  id: z.string().regex(JOB_NAME),
  label: z.string().min(1),
  on: z.enum(ACTION_TARGETS),
  job: z.string().min(1),
  // An enrich action's vocabulary keys: what the host's Enrichment page
  // shows it can fill. Each key describes the action's own kind. (SDK 1.5)
  answers: z
    .array(
      z.string().refine(isVocabularyKey, {
        error: (issue) =>
          `${JSON.stringify(issue.input)} is not in the enrichment vocabulary`,
      }),
    )
    .min(1)
    .refine((keys) => new Set(keys).size === keys.length, {
      error: 'answers names each key once',
    })
    .optional(),
})

/** An HTTP header name, as `auth.header` spells the one the key goes in. */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/

/**
 * A plugin's remote MCP server, which Ask mounts for a turn while the
 * integration runs. (D72, SDK 1.5)
 * - `url` is https: the workspace key travels with every call.
 * - `auth.header` names the header the key from `requires.credential` goes
 *   in, never the URL, so no error line can carry it; `scheme` prefixes it.
 */
const mcpSchema = z.strictObject({
  url: z.url({
    protocol: /^https$/,
    error: 'mcp.url is an https URL',
  }),
  auth: z.strictObject({
    header: z.string().regex(HEADER_NAME, {
      error: 'mcp.auth.header is an HTTP header name',
    }),
    scheme: z.literal('Bearer').optional(),
  }),
})

/** The on-disk manifest (`manifest.json`). */
export const manifestSchema = z
  .strictObject(
    {
      manifestVersion: z.literal(1),
      id: z.string().regex(PLUGIN_ID, {
        error:
          'id is lowercase letters, digits and hyphens — no uppercase, and no dots (core.* is reserved for first-party channels)',
      }),
      version: z
        .string()
        .refine(isVersion, { error: 'version is major.minor.patch' }),
      sdk: z.string().refine((r) => parseSdkRange(r) !== null, {
        error: 'sdk is a range: ^x.y, ~x.y or an exact x.y.z',
      }),
      name: z.string().min(1),
      description: z.string().min(1),
      icon: z.string().min(1).optional(),
      // What the catalogue groups it under (SDK 1.4). Absent → "Other".
      roles: z
        .array(
          z.enum(ROLES, {
            error: (issue) =>
              `unknown role ${JSON.stringify(issue.input)} — roles name jobs from ROLES (${ROLES.join(', ')})`,
          }),
        )
        .min(1)
        .refine((roles) => new Set(roles).size === roles.length, {
          error: 'roles names each role once',
        })
        .optional(),
      requires: z
        .strictObject({
          credential: z
            .strictObject({
              kind: z.enum(['enrichment', 'search', 'llm']),
              scope: z.literal('workspace'),
            })
            .optional(),
          // An OAuth grant with its scopes, or a key each member pastes for
          // their own account (`key: true`, SDK 1.5, D78): then every
          // schedule job runs once per member's connection.
          connection: z
            .union([
              z.strictObject({
                provider: z.string().min(1),
                scopes: z.array(z.string().min(1)).min(1),
              }),
              z.strictObject({
                provider: z.string().min(1),
                key: z.literal(true),
              }),
            ])
            .optional(),
        })
        .optional(),
      // JSON Schema, emitted from the authored zod schema by the build.
      settings: z.record(z.string(), z.unknown()),
      // Job names are checked below rather than as the record's key schema:
      // zod reports a bad key only as "Invalid key in record".
      jobs: z.record(z.string(), jobSchema),
      ingress: z
        .strictObject({ signature: z.enum(['hmac-sha256', 'none']) })
        .optional(),
      actions: z.array(actionSchema).optional(),
      http: z
        .strictObject({
          rateLimit: z.strictObject({ rpm: z.int().positive() }).optional(),
        })
        .optional(),
      provides: z.literal('storage-source').optional(),
      mcp: mcpSchema.optional(),
      sensitivity: z.literal('inherit').optional(),
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys' && issue.keys.includes('kind')
          ? 'kind is not a manifest field (D51): a plugin has no kind — each job declares a trigger and the ports it uses'
          : undefined,
    },
  )
  .superRefine((m, ctx) => {
    const jobs = Object.entries(m.jobs)
    for (const [name, job] of jobs) {
      if (!JOB_NAME.test(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name],
          message:
            'a job name is a letter then letters, digits, - or _ — no dots (it is the last segment of plugin.<id>.<job>)',
        })
      }
      if ((job.trigger === 'schedule') !== (job.schedule !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'schedule'],
          message:
            job.trigger === 'schedule'
              ? 'a schedule job needs schedule'
              : `schedule is only for a schedule job, and ${name} is ${job.trigger}`,
        })
      }
      if (job.input !== undefined && job.trigger !== 'action') {
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'input'],
          message: `input is only for an action job, and ${name} is ${job.trigger}`,
        })
      }
      if (job.accepts !== undefined && job.trigger !== 'file') {
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'accepts'],
          message: `accepts is only for a file job, and ${name} is ${job.trigger}`,
        })
      }
      if ((job.trigger === 'event') !== (job.on !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'on'],
          message:
            job.trigger === 'event'
              ? 'an event job needs on'
              : `on is only for an event job, and ${name} is ${job.trigger}`,
        })
      }
      if ((job.trigger === 'watch') !== (job.settings !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['jobs', name, 'settings'],
          message:
            job.trigger === 'watch'
              ? 'a watch job needs settings — the schema of what one watch holds, rendered as its form'
              : `settings on a job is only for a watch job, and ${name} is ${job.trigger}`,
        })
      }
      if (m.provides === 'storage-source') {
        job.uses.forEach((port, i) => {
          if (STORAGE_SOURCE_WITHHELD.some((withheld) => withheld === port)) {
            ctx.addIssue({
              code: 'custom',
              path: ['jobs', name, 'uses', i],
              message: `a storage-source plugin is granted no ${STORAGE_SOURCE_WITHHELD.join(' and no ')} port — it delivers bytes and never decides filing or calls Ai, and ${name} uses ${port}`,
            })
          }
        })
      }
    }
    // A `space_watch` row names its integration, not a job.
    const watches = jobs.filter(([, j]) => j.trigger === 'watch')
    if (watches.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['jobs', watches[1][0]],
        message: `a plugin declares at most one watch job — a watch names its plugin, not a job — and this one declares ${watches.map(([n]) => n).join(', ')}`,
      })
    }
    if (m.mcp !== undefined && m.requires?.credential === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['mcp'],
        message:
          'an mcp server needs requires.credential — its key comes from the vault, never the manifest',
      })
    }
    const hasWebhook = jobs.some(([, j]) => j.trigger === 'webhook')
    if (hasWebhook !== (m.ingress !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ingress'],
        message: hasWebhook
          ? 'a plugin with a webhook job needs ingress'
          : 'ingress is only for a plugin with a webhook job',
      })
    }
    m.actions?.forEach((action, i) => {
      action.answers?.forEach((key, k) => {
        const entry = isVocabularyKey(key) ? ENRICHMENT_VOCABULARY[key] : null
        if (entry !== null && entry.kind !== action.on)
          ctx.addIssue({
            code: 'custom',
            path: ['actions', i, 'answers', k],
            message: `action ${action.id} is on ${action.on}, and ${key} describes a ${entry.kind}`,
          })
      })
      const job = Object.hasOwn(m.jobs, action.job)
        ? m.jobs[action.job]
        : undefined
      if (job?.trigger !== 'action') {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'job'],
          message: job
            ? `action ${action.id} names job ${action.job}, whose trigger is ${job.trigger}, not action`
            : `action ${action.id} names job ${action.job}, which the manifest does not declare`,
        })
      } else if (job.input === 'payload') {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'job'],
          message: `action ${action.id} names job ${action.job}, which takes the host's payload and runs on no record`,
        })
      }
    })
  })

export type Manifest = z.output<typeof manifestSchema>
export type JobDeclaration = Manifest['jobs'][string]

/**
 * The authored manifest: the on-disk shape with `settings` as the zod schema
 * the Config port will be typed by. `jobs` is a record here so a const
 * literal keeps its job names — `definePlugin` constrains the bundle's job
 * functions to exactly those keys.
 */
export type AuthoredManifest = Omit<Manifest, 'settings' | 'jobs'> & {
  readonly settings: z.ZodType
  readonly jobs: { readonly [name: string]: AuthoredJob }
}

/**
 * A job as authored. `uses` and `on` are readonly so a `const` literal keeps
 * them as tuples — `['Identity']` stays `'Identity'`, not `PortName` — which
 * is what lets `definePlugin` bound the job's `R` by exactly what it declared.
 * A watch job's `settings` is the zod schema `watchSettingsOf` parses by.
 */
export type AuthoredJob = Omit<JobDeclaration, 'uses' | 'on' | 'settings'> & {
  readonly uses: ReadonlyArray<JobDeclaration['uses'][number]>
  readonly on?: ReadonlyArray<NonNullable<JobDeclaration['on']>[number]>
  readonly settings?: z.ZodType
}

/**
 * Identity at runtime; at the type level it keeps the literal job names (the
 * `const` type parameter) and checks the shape as it is written.
 */
export const defineManifest = <const TManifest extends AuthoredManifest>(
  manifest: TManifest,
): TManifest => manifest

/**
 * The settings block as web renders it: JSON Schema of what the operator
 * *types* (`io: 'input'`), so a field with a default is optional on the
 * form, where the output schema would mark it required.
 * - `propertyOrder` names the properties in declaration order: the host
 *   stores the manifest as jsonb, which keeps object keys sorted, so the
 *   order the form draws in has to travel as a list. (SDK 1.5)
 */
export const settingsJsonSchema = (settings: z.ZodType) => {
  const schema = z.toJSONSchema(settings, { io: 'input' })
  return schema.properties === undefined
    ? schema
    : { ...schema, propertyOrder: Object.keys(schema.properties) }
}

/**
 * The authored manifest as it goes on disk: settings — the plugin's and a
 * watch job's — through `settingsJsonSchema`, then validated by
 * `manifestSchema`: a build that would write a manifest the loader refuses
 * fails here instead.
 */
export const toManifestJson = (manifest: AuthoredManifest): Manifest =>
  manifestSchema.parse({
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
