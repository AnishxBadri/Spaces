//  @ts-check

/**
 * `instrument/no-key-in-button` — no key is printed inside a button (A2).
 *
 * A key lives in the button's tooltip (`Button`'s `shortcut`), the `?` sheet
 * and Cmd-K. The rule reports a key hint anywhere inside a `Button` or a
 * `DropdownMenuItem` element:
 * - a `<kbd>`, or a `KeyHint` / `Kbd` element;
 * - text carrying a key glyph (`⌘`, `↵`, `⇧`, `⌥`, `⌃`).
 *
 * The lanes where a key is the row's data — the sidebar, Cmd-K rows, the `?`
 * sheet and a composer's end lane — print it in a plain element (a `<button>`
 * row, an `<li>`), which is neither control, so they pass by construction.
 */

/** The elements a key may not sit inside. */
const CONTROLS = new Set([
  'Button',
  'DropdownMenuItem',
  'DropdownMenuCheckboxItem',
])

/** The elements that print a key. */
const KEY_ELEMENTS = new Set(['kbd', 'KeyHint', 'Kbd'])

/** A key glyph in text. */
const KEY_GLYPH = /[⌘↵⇧⌥⌃]/

/**
 * The element name of a JSX opening element, `Foo.Bar` as `Bar`.
 *
 * @param {any} name
 * @returns {string | null}
 */
function nameOf(name) {
  if (!name) return null
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXMemberExpression') return nameOf(name.property)
  return null
}

/**
 * The nearest enclosing control, by name, or null.
 *
 * @param {any} node
 * @returns {string | null}
 */
function enclosingControl(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === 'JSXElement') {
      const name = nameOf(at.openingElement.name)
      if (name !== null && CONTROLS.has(name)) return name
    }
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No key printed inside a Button or a menu item; the key goes in the tooltip.',
    },
    schema: [],
    messages: {
      keyInControl:
        'a key printed inside `{{control}}` — pass it as `shortcut` on `Button` so it shows in the tooltip, or drop it (`↵` on a primary is universal). Keys print only in the sidebar, Cmd-K, the `?` sheet and a composer’s end lane (design contract A2).',
    },
  },
  create(context) {
    return {
      JSXElement(node) {
        const el = /** @type {any} */ (node)
        const name = nameOf(el.openingElement.name)
        if (name === null || !KEY_ELEMENTS.has(name)) return
        const control = enclosingControl(el)
        if (control !== null) {
          context.report({ node, messageId: 'keyInControl', data: { control } })
        }
      },
      JSXText(node) {
        const text = /** @type {any} */ (node)
        if (!KEY_GLYPH.test(text.value)) return
        const control = enclosingControl(text)
        if (control !== null) {
          context.report({ node, messageId: 'keyInControl', data: { control } })
        }
      },
    }
  },
}

export default { rules: { 'no-key-in-button': rule } }
