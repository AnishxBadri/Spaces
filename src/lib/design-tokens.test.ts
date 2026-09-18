import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

import instrument, { NAMED_STEPS } from '../../eslint-rules/no-v1-tokens.js'

/**
 * SPA-16: the v1 vocabulary is out, and the thing that keeps it out is a lint
 * rule instead of the old CLAUDE.md grep. Two halves are tested here — the rule
 * over tsx class strings (gate 4 runs it for real), and the `@theme` block,
 * which no lint rule reads.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const linter = new Linter()

function lint(code: string, filename = 'src/routes/_app/fixture.tsx') {
  return linter.verify(
    code,
    {
      files: ['**/*.tsx'],
      plugins: { instrument },
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: { 'instrument/no-v1-tokens': 'error' },
    },
    filename,
  )
}

describe('instrument/no-v1-tokens', () => {
  it('does not read comments — the line the old grep printed forever', () => {
    // Verbatim from src/components/attributes/attribute-dialog.tsx:979-981,
    // the single false positive the gate-5 grep produced on a clean tree.
    const code = `
      /** A checkbox whose whole row is the hit area — no dead zone between box
       *  and text. The box is a 14px square that fills with pine (never a
       *  native rounded control). */
      export function CheckRow() {
        return <div className="flex items-center gap-2 rounded-md" />
      }
    `
    expect(lint(code)).toEqual([])
  })

  it('reads a real bare `rounded` in a className', () => {
    const messages = lint('<div className="flex rounded p-2" />')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('`rounded`')
    expect(messages[0]?.message).toContain('rounded-none')
  })

  it('names the Instrument replacement for each token (the SPA-16 demo)', () => {
    const messages = lint('<div className="bg-muted rounded-lg" />')
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.message).join('\n')).toContain('bg-bone')
    expect(messages.map((m) => m.message).join('\n')).toContain('rounded-none')
  })

  it('catches the semantic names the old grep missed', () => {
    for (const cls of [
      'bg-sidebar',
      'border-sidebar-border',
      'text-chart-1',
      'bg-card',
      'bg-popover',
      'text-popover-foreground',
      'bg-secondary',
      'text-muted-foreground',
      'border-border',
      'border-input',
      'bg-accent',
      'shadow-xs',
      'text-xs',
      'text-sm',
      'rounded-full',
      'dark:bg-bone',
    ]) {
      expect(lint(`<div className="${cls}" />`), cls).toHaveLength(1)
    }
  })

  it('leaves the Instrument vocabulary alone', () => {
    const ok =
      'flex items-center gap-2 rounded-md border border-rule bg-bone p-2 ' +
      'text-label text-graphite hover:bg-bone-deep focus-ring rounded-none ' +
      'shadow-[2px_2px_0_0_var(--hairline)] data-[state=open]:bg-paper'
    expect(lint(`<div className="${ok}" />`)).toEqual([])
  })

  it('sees through variants and opacity modifiers', () => {
    expect(lint('<div className="hover:bg-muted/50" />')).toHaveLength(1)
  })

  it('reads cn() and cva() string arguments, including nested variants', () => {
    const code = `
      const v = cva('rounded-md', {
        variants: { variant: { destructive: 'focus-visible:ring-destructive/20 bg-muted' } },
      })
      const c = cn('flex', isOpen && 'text-sm', ['border-border'])
    `
    // bg-muted (cva variant), text-sm and border-border (cn).
    expect(lint(code)).toHaveLength(3)
  })

  it('reports a cn() call inside className exactly once', () => {
    expect(lint('<div className={cn("bg-muted")} />')).toHaveLength(1)
  })

  it('allows bg-background only where the document ground is painted', () => {
    expect(lint('<div className="bg-background" />')).toHaveLength(1)
    expect(
      lint('<div className="bg-background" />', 'src/routes/__root.tsx'),
    ).toEqual([])
  })
})

describe('arbitrary type sizes (SPA-79)', () => {
  it('names the step when an arbitrary size spells one out', () => {
    const messages = lint('<div className="label-caps text-[0.625rem]" />')
    expect(messages[0]?.message).toContain('text-field')
    expect(messages[0]?.message).toContain('spelled out by hand')
    expect(
      lint('<div className="font-serif text-[0.9375rem]" />')[0]?.message,
    ).toContain('text-title')
  })

  it('names the nearest step when the size is off the list entirely', () => {
    const messages = lint('<div className="mono text-[0.5rem]" />')
    expect(messages[0]?.message).toContain(
      'text-field (10px), the nearest named',
    )
    expect(messages[0]?.message).toContain('scoped disable')
  })

  it('rejects arbitrary line heights, pointing at the scale or the step', () => {
    expect(
      lint('<div className="text-ui leading-[1.125rem]" />')[0]?.message,
    ).toContain('leading-4.5 (the 0.25rem scale)')
    expect(
      lint('<div className="font-serif text-title leading-[1.375rem]" />')[0]
        ?.message,
    ).toContain("22px is the `title` step's own leading")
  })

  it('sees through variants, and reads cn() the same way', () => {
    expect(lint('<div className="[&_p]:text-[0.625rem]" />')).toHaveLength(1)
    expect(lint('<div className={cn("text-[0.625rem]")} />')).toHaveLength(1)
  })

  it('leaves arbitrary colours alone — a different axis, a different slice', () => {
    expect(
      lint('<div className="mono text-[var(--badge-amber-ink)]" />'),
    ).toEqual([])
    expect(lint('<div className="bg-[var(--badge-amber)]" />')).toEqual([])
  })

  it('passes the vocabulary it is there to protect', () => {
    expect(
      lint(
        '<div className="field-label mono text-field text-label leading-4 leading-3.5" />',
      ),
    ).toEqual([])
  })
})

describe('the named type steps', () => {
  const css = readFileSync(`${repoRoot}/src/styles.css`, 'utf8')

  /** Every `--text-<name>` / `--text-<name>--line-height` pair in styles.css. */
  function stepsFromStyles() {
    const sizes = new Map<string, number>()
    const lines = new Map<string, number>()
    for (const [, name, kind, value] of css.matchAll(
      /--text-([a-z]+)(--line-height)?:\s*([\d.]+)rem;/g,
    )) {
      ;(kind ? lines : sizes).set(name, Number(value))
    }
    return [...sizes]
      .map(([name, rem]) => ({ name, rem, lineRem: lines.get(name) ?? 0 }))
      .sort((a, b) => a.rem - b.rem)
  }

  // The rule names the nearest step in its message; if styles.css grows or
  // loses a step and the rule's table doesn't, the message starts lying.
  it('are the same list in styles.css and in the lint rule', () => {
    expect(stepsFromStyles()).toEqual(NAMED_STEPS)
  })

  it('include the field step — DESIGN.md §3’s sixth mono step, 10/12', () => {
    expect(css).toContain('--text-field: 0.625rem;')
    expect(css).toContain('--text-field--line-height: 0.75rem;')
  })

  it('carry a field-label utility: mono, caps, tracked, 400', () => {
    const utility = /@utility field-label \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(utility).toContain('font-family: var(--font-mono);')
    expect(utility).toContain('font-size: var(--text-field);')
    expect(utility).toContain('line-height: var(--text-field--line-height);')
    expect(utility).toContain('font-weight: 400;')
    expect(utility).toContain('letter-spacing: 0.08em;')
    expect(utility).toContain('text-transform: uppercase;')
  })
})

describe('@theme colour exports', () => {
  const css = readFileSync(`${repoRoot}/src/styles.css`, 'utf8')
  const theme = css.slice(
    css.indexOf('@theme'),
    css.indexOf('\n}', css.indexOf('@theme')),
  )

  it('exports no v1 colour name Tailwind could build a class from', () => {
    // Deleted 2026-09-18 (SPA-16). Each aliased bone, paper, hairline or ink,
    // so nothing rendered differently — they only kept the v1 class names
    // reachable. The `:root` --muted / --muted-foreground vars stay: they are
    // still read by .mention-chip and .glossary-term.
    const dead = [
      '--color-sidebar',
      '--color-chart-',
      '--color-card',
      '--color-accent',
      '--color-secondary',
      '--color-muted',
    ]
    for (const name of dead) expect(theme, name).not.toContain(name)
  })

  it('still exports the Instrument materials', () => {
    for (const name of [
      '--color-paper',
      '--color-bone',
      '--color-hairline',
      '--color-rule',
      '--color-graphite',
    ]) {
      expect(theme, name).toContain(name)
    }
  })
})
