import { useState } from 'react'
import type { ReactNode } from 'react'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { Switch } from '#/components/ui/switch'
import type {
  AutoEnrichScopeName,
  AutoEnrichView,
  FormValue,
  FormValues,
  SecretField,
  SecretSlot,
  SettingsField,
  SettingsForm,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * One plugin's settings card, drawn from its manifest: one group per secret
 * slot it asks for (its key, its webhook secret with the webhook URL), then
 * one row per setting — a switch for a boolean, a picker for an enum, a
 * field for a number or a string.
 * - A switch, a picker or a checkbox saves when it changes; a typed field or
 *   a key joins the page's Save bar (D81). The card draws no Save of its own.
 * - A field that failed its schema turns its row rose and says why under the
 *   label, with `not saved`; nothing is written until every field passes.
 * - A saved key is never shown: the row reads its redacted display.
 */

/** A 48px settings row on a rule, tinted when its value was refused. */
function FieldRow({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string
  hint: string | null
  error: string | null
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex min-h-12 items-center justify-between gap-6 border-b border-rule px-3 py-2',
        error !== null && 'bg-[var(--badge-rose)]',
      )}
    >
      <div className="flex min-w-0 flex-col">
        <label htmlFor={htmlFor} className="text-ui font-medium">
          {label}
        </label>
        {error !== null ? (
          <span role="alert" className="mono text-micro text-destructive">
            {error} · not saved
          </span>
        ) : hint !== null ? (
          <span className="text-label text-graphite">{hint}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export const settingInputId = (key: string) => `setting-${key}`

/** One setting's control, by kind; the Add watch window draws these too. */
export function SettingControl({
  field,
  value,
  invalid,
  disabled,
  onChange,
}: {
  field: SettingsField
  value: FormValue | undefined
  invalid: boolean
  disabled: boolean
  onChange: (value: FormValue) => void
}) {
  switch (field.kind) {
    case 'boolean':
      return (
        <Switch
          id={settingInputId(field.key)}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      )
    case 'enum':
      return (
        <Select
          id={settingInputId(field.key)}
          aria-label={field.label}
          width="content"
          value={typeof value === 'string' ? value : ''}
          items={field.options.map((o) => ({ value: o, label: o }))}
          disabled={disabled}
          onChange={onChange}
          className="w-44"
        />
      )
    case 'number':
      return (
        <Input
          id={settingInputId(field.key)}
          inputMode="decimal"
          aria-invalid={invalid || undefined}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.required ? 'required' : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-28 text-right mono"
        />
      )
    case 'string':
      return (
        <Input
          id={settingInputId(field.key)}
          aria-invalid={invalid || undefined}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.required ? 'required' : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-72"
        />
      )
  }
}

/**
 * The Settings group: the generated form, or why the manifest cannot be drawn.
 * Headed `not yet` while a required setting has no value, as the Key group is
 * while no key is saved.
 */
export function SettingsFields({
  form,
  values,
  errors,
  disabled,
  notYet = false,
  onChange,
}: {
  form: SettingsForm
  values: FormValues
  errors: { readonly [key: string]: string }
  disabled: boolean
  notYet?: boolean
  onChange: (field: SettingsField, value: FormValue) => void
}) {
  if (!form.ok)
    return (
      <div className="flex flex-col pt-8">
        <SectionHead as="h3" title="Settings" />
        <p
          role="alert"
          className="border-b border-rule px-3 py-3 mono text-micro text-destructive"
        >
          {form.reason}
        </p>
      </div>
    )
  if (form.fields.length === 0) return null
  return (
    <div className="flex flex-col pt-8">
      <SectionHead
        as="h3"
        title="Settings"
        count={notYet ? 'not yet' : String(form.fields.length)}
      />
      {form.fields.map((field) => {
        const error = Object.hasOwn(errors, field.key)
          ? errors[field.key]
          : null
        return (
          <FieldRow
            key={field.key}
            htmlFor={settingInputId(field.key)}
            label={field.label}
            hint={field.hint}
            error={error}
          >
            <SettingControl
              field={field}
              value={
                Object.hasOwn(values, field.key) ? values[field.key] : undefined
              }
              invalid={error !== null}
              disabled={disabled}
              onChange={(v) => onChange(field, v)}
            />
          </FieldRow>
        )
      })}
    </div>
  )
}

/** The three auto-enrich scopes, each the trigger it stands for. (D76) */
export const SCOPE_ROWS: ReadonlyArray<{
  readonly scope: AutoEnrichScopeName
  readonly label: string
}> = [
  { scope: 'deal', label: 'When a record joins a deal' },
  { scope: 'space', label: 'When a record is filed into a space' },
  { scope: 'meeting', label: 'When a record appears in a synced meeting' },
]

/** One checkbox row in the auto-enrich group. */
function CheckRow({
  id,
  label,
  checked,
  disabled,
  indent = false,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  disabled: boolean
  indent?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div
      className={cn(
        'flex min-h-10 items-center gap-3 border-b border-rule py-2 pr-3',
        indent ? 'pl-10' : 'pl-3',
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      <label htmlFor={id} className={indent ? 'text-label' : 'text-ui'}>
        {label}
      </label>
    </div>
  )
}

/**
 * The Auto-enrich group: which triggers press Enrich for the owner. With
 * Spaces ticked, the spaces it covers; none chosen is every space. Each tick
 * saves the whole scope at once.
 */
export function AutoEnrichFields({
  view,
  disabled,
  onSave,
}: {
  view: AutoEnrichView
  disabled: boolean
  onSave: (scope: {
    scopes: Array<AutoEnrichScopeName>
    spaces: Array<string>
  }) => void
}) {
  const [scopes, setScopes] = useState<ReadonlyArray<AutoEnrichScopeName>>(
    view.scopes,
  )
  const [spaces, setSpaces] = useState<ReadonlyArray<string>>(view.spaces)
  const toggle = <T,>(list: ReadonlyArray<T>, item: T, on: boolean) =>
    on
      ? [...list.filter((x) => x !== item), item]
      : list.filter((x) => x !== item)
  const commit = (
    nextScopes: ReadonlyArray<AutoEnrichScopeName>,
    nextSpaces: ReadonlyArray<string>,
  ) => {
    setScopes(nextScopes)
    setSpaces(nextSpaces)
    onSave({
      scopes: SCOPE_ROWS.map((r) => r.scope).filter((s) =>
        nextScopes.includes(s),
      ),
      spaces: [...nextSpaces],
    })
  }
  return (
    <div className="flex flex-col pt-8">
      <SectionHead
        as="h3"
        title="Auto-enrich"
        count={scopes.length === 0 ? 'off' : String(scopes.length)}
      />
      {SCOPE_ROWS.map((row) => (
        <div key={row.scope} className="flex flex-col">
          <CheckRow
            id={`auto-enrich-${row.scope}`}
            label={row.label}
            checked={scopes.includes(row.scope)}
            disabled={disabled}
            onChange={(on) => commit(toggle(scopes, row.scope, on), spaces)}
          />
          {row.scope === 'space' && scopes.includes('space') ? (
            <>
              {spaces.length === 0 ? (
                <p className="border-b border-rule py-2 pr-3 pl-10 text-label text-graphite">
                  No space chosen: every space.
                </p>
              ) : null}
              {view.options.map((option) => (
                <CheckRow
                  key={option.id}
                  id={`auto-enrich-space-${option.id}`}
                  label={option.label}
                  checked={spaces.includes(option.id)}
                  disabled={disabled}
                  indent
                  onChange={(on) =>
                    commit(scopes, toggle(spaces, option.id, on))
                  }
                />
              ))}
            </>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** Each secret slot's group heading, in the order the card draws them. */
export const SECRET_GROUPS: ReadonlyArray<{
  readonly slot: SecretSlot
  readonly title: string
}> = [
  { slot: 'credential', title: 'Key' },
  { slot: 'webhook', title: 'Webhook secret' },
]

const nounOf = (slot: SecretSlot) => (slot === 'webhook' ? 'secret' : 'key')

/**
 * Where the provider posts deliveries. Read-only; the row id in it is what
 * makes it unguessable, so it is shown only here, to the admin.
 */
export function WebhookUrlRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 border-b border-rule px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-ui font-medium">Webhook URL</span>
        <span className="truncate mono text-micro text-graphite select-all">
          {url}
        </span>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          void navigator.clipboard.writeText(url).then(() => setCopied(true))
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

/**
 * One secret field, a typed field in the page's Save bar. Write-only: the
 * input starts empty every time; a saved secret reads as its redacted
 * display, and an empty field keeps it.
 */
export function SecretFieldRow({
  field,
  value,
  disabled,
  onChange,
  onRemove,
}: {
  field: SecretField
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onRemove: () => void
}) {
  const saved = field.display !== null
  const noun = nounOf(field.slot)
  const id = `secret-${field.slot}`
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 border-b border-rule px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <label htmlFor={id} className="text-ui font-medium">
          {saved ? `Replace ${field.label}` : field.label}
        </label>
        <span className="text-label text-graphite">
          {saved
            ? `Saved as ${field.display}. Leave empty to keep it.`
            : 'Not set yet. Stored encrypted as the workspace key.'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={saved ? '••••••••' : `Paste the ${noun}`}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-72 mono"
        />
        {saved ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Uninstall's one option: also drop the plugin's own tables. Off by default,
 * so a reinstall finds its data where it left it.
 */
export function DropDataOption({
  onChange,
}: {
  onChange: (dropData: boolean) => void
}) {
  const [checked, setChecked] = useState(false)
  const toggle = (next: boolean) => {
    setChecked(next)
    onChange(next)
  }
  return (
    <span className="mt-3 flex items-center gap-2">
      <Checkbox
        id="uninstall-drop-data"
        checked={checked}
        onCheckedChange={toggle}
      />
      <label htmlFor="uninstall-drop-data" className="text-label">
        Also delete the data it keeps in its own tables
      </label>
    </span>
  )
}
