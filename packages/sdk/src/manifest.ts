import { z } from 'zod'
import { DOMAIN_EVENTS, PORT_NAMES } from './contract.ts'
import { isVersion, parseSdkRange } from './range.ts'

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

/** The five triggers (D51). Closed and semver-frozen: a new one is a minor. */
export const TRIGGERS = [
  'action',
  'schedule',
  'event',
  'webhook',
  'file',
] as const
export type Trigger = (typeof TRIGGERS)[number]

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
})

export const ACTION_TARGETS = ['company', 'person', 'deal'] as const

const actionSchema = z.strictObject({
  id: z.string().regex(JOB_NAME),
  label: z.string().min(1),
  on: z.enum(ACTION_TARGETS),
  job: z.string().min(1),
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
      requires: z
        .strictObject({
          credential: z
            .strictObject({
              kind: z.enum(['enrichment', 'search', 'llm']),
              scope: z.literal('workspace'),
            })
            .optional(),
          connection: z
            .strictObject({
              provider: z.string().min(1),
              scopes: z.array(z.string().min(1)).min(1),
            })
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
 */
export type AuthoredJob = Omit<JobDeclaration, 'uses' | 'on'> & {
  readonly uses: ReadonlyArray<JobDeclaration['uses'][number]>
  readonly on?: ReadonlyArray<NonNullable<JobDeclaration['on']>[number]>
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
 */
export const settingsJsonSchema = (settings: z.ZodType) =>
  z.toJSONSchema(settings, { io: 'input' })

/**
 * The authored manifest as it goes on disk: settings through
 * `settingsJsonSchema`, then validated by `manifestSchema` — a build that
 * would write a manifest the loader refuses fails here instead.
 */
export const toManifestJson = (manifest: AuthoredManifest): Manifest =>
  manifestSchema.parse({
    ...manifest,
    settings: settingsJsonSchema(manifest.settings),
  })
