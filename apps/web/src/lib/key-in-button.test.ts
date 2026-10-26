import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

// The rule module is @spaces/config's, loaded by the eslint base beside the
// vocabulary.
import keys from '../../../../packages/config/eslint-rules/keys.js'

/**
 * No key is printed inside a button (A2). The lint gate runs the rule over
 * the real tree; this holds what it reports and what it leaves alone.
 */

const linter = new Linter()

function lint(code: string) {
  return linter.verify(
    code,
    {
      files: ['**/*.tsx'],
      plugins: { instrument: keys },
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: { 'instrument/no-key-in-button': 'error' },
    },
    'src/routes/_app/fixture.tsx',
  )
}

describe('instrument/no-key-in-button', () => {
  it('refuses a <kbd> inside a Button, naming the shortcut prop', () => {
    const messages = lint('<Button>Log interaction<kbd>L</kbd></Button>')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('`Button`')
    expect(messages[0]?.message).toContain('shortcut')
  })

  it('refuses a KeyHint however deep inside the control', () => {
    expect(
      lint(
        '<Button><span>Save<span className="ml-2"><KeyHint>⌘↵</KeyHint></span></span></Button>',
      ),
    ).toHaveLength(2)
    expect(lint('<ui.Button>New<Kbd>N</Kbd></ui.Button>')).toHaveLength(1)
  })

  it('refuses a key glyph typed into the label', () => {
    expect(lint('<Button>Continue ⌘↵</Button>')).toHaveLength(1)
    expect(lint('<Button>Sign in ↵</Button>')).toHaveLength(1)
  })

  it('refuses a key in a menu item', () => {
    const messages = lint(
      '<DropdownMenuItem>Rename<kbd>R</kbd></DropdownMenuItem>',
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('`DropdownMenuItem`')
  })

  it('leaves the lanes alone: a composer row, a sidebar row, a Cmd-K row', () => {
    for (const code of [
      // A composer's end lane is a plain button row.
      '<button type="button"><span>Add a task…</span><kbd className="mono">T</kbd></button>',
      // A picker row in a list.
      '<li role="option">Flent<kbd>↵</kbd></li>',
      // The `?` sheet.
      '<dl><dt><kbd>G</kbd> <kbd>T</kbd></dt><dd>Today</dd></dl>',
      // A lane beside a button, not inside it.
      '<div><Button>Add task</Button><span className="mono">↵ add · ⇧↵ add & keep open</span></div>',
    ]) {
      expect(lint(code), code).toEqual([])
    }
  })

  it('leaves a button with its key in the tooltip alone', () => {
    expect(
      lint('<Button variant="outline" shortcut="L">Log interaction</Button>'),
    ).toEqual([])
  })
})
