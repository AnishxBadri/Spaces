import { useState } from 'react'
import type { ReactNode } from 'react'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { Switch } from '#/components/ui/switch'
import type {
  FormValue,
  FormValues,
  SecretField,
  SettingsField,
  SettingsForm,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/**
 * One plugin's settings card, drawn from its manifest: the key fields its
 * `requires` asks for, then one row per setting — a switch for a boolean, a
 * picker for an enum, a field for a number or a string.
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

const inputId = (key: string) => `setting-${key}`

function Control({
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
          id={inputId(field.key)}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      )
    case 'enum':
      return (
        <Select
          id={inputId(field.key)}
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
          id={inputId(field.key)}
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
          id={inputId(field.key)}
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

/** The Settings group: the generated form, or why the manifest cannot be drawn. */
export function SettingsFields({
  form,
  values,
  errors,
  disabled,
  dirty,
  onChange,
  onSave,
}: {
  form: SettingsForm
  values: FormValues
  errors: { readonly [key: string]: string }
  disabled: boolean
  dirty: boolean
  onChange: (key: string, value: FormValue) => void
  onSave: () => void
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
    <form
      className="flex flex-col pt-8"
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <SectionHead
        as="h3"
        title="Settings"
        count={String(form.fields.length)}
        action={
          <Button type="submit" size="sm" disabled={disabled || !dirty}>
            Save settings
          </Button>
        }
      />
      {form.fields.map((field) => {
        const error = Object.hasOwn(errors, field.key)
          ? errors[field.key]
          : null
        return (
          <FieldRow
            key={field.key}
            htmlFor={inputId(field.key)}
            label={field.label}
            hint={field.hint}
            error={error}
          >
            <Control
              field={field}
              value={
                Object.hasOwn(values, field.key) ? values[field.key] : undefined
              }
              invalid={error !== null}
              disabled={disabled}
              onChange={(v) => onChange(field.key, v)}
            />
          </FieldRow>
        )
      })}
    </form>
  )
}

/**
 * One key field. Write-only: the input starts empty every time; a saved key
 * reads as its redacted display, and an empty save keeps it.
 */
export function SecretFieldRow({
  field,
  value,
  disabled,
  onChange,
  onSave,
  onRemove,
}: {
  field: SecretField
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onSave: () => void
  onRemove: () => void
}) {
  const saved = field.display !== null
  const id = `secret-${field.slot}`
  return (
    <form
      className="flex min-h-12 items-center justify-between gap-6 border-b border-rule px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
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
          placeholder={saved ? '••••••••' : 'Paste the key'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-72 mono"
        />
        <Button
          type="submit"
          size="sm"
          disabled={disabled || value.trim() === ''}
        >
          Save key
        </Button>
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
    </form>
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
