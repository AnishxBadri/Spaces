//  @ts-check

/**
 * `effect/io-is-effect` — a module that does I/O is an Effect program.
 *
 * A file that imports the `db` value (from `@spaces/db` or `#/db`) must
 * import from `effect` too. The `db` import is the proxy for I/O: a pure
 * helper, a type module and client code import no `db`, so they stay plain.
 * - Type-only imports count on neither side: they erase.
 * - A dynamic `import('@spaces/db')` counts as the `db` value.
 * - An exempt file says why in an `eslint-disable` on the import.
 */

const DB_SOURCES = new Set(['@spaces/db', '#/db'])

/** `effect` or one of its subpaths. */
const isEffect = (/** @type {unknown} */ source) =>
  typeof source === 'string' &&
  (source === 'effect' || source.startsWith('effect/'))

/**
 * Whether a static import binds the `db` value: a named `db` that is not a
 * type, or the whole module as a namespace.
 * @param {import('estree').ImportDeclaration} node
 */
function bindsDb(node) {
  if ('importKind' in node && node.importKind === 'type') return false
  return node.specifiers.some((s) => {
    if (s.type === 'ImportNamespaceSpecifier') return true
    if (s.type !== 'ImportSpecifier') return false
    if ('importKind' in s && s.importKind === 'type') return false
    const imported = s.imported
    return (
      (imported.type === 'Identifier' ? imported.name : imported.value) === 'db'
    )
  })
}

/**
 * Whether a static import brings a value from `effect`: anything but an
 * `import type`, or a list of type-only specifiers.
 * @param {import('estree').ImportDeclaration} node
 */
function bindsEffect(node) {
  if (!isEffect(node.source.value)) return false
  if ('importKind' in node && node.importKind === 'type') return false
  if (node.specifiers.length === 0) return true
  return node.specifiers.some(
    (s) => !('importKind' in s) || s.importKind !== 'type',
  )
}

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A module that imports the db value imports effect: I/O is an Effect program.',
    },
    schema: [],
    messages: {
      ioIsEffect:
        'This module imports the `db` value and nothing from `effect`. I/O in apps/web/src/lib is an Effect program: write the query as an `Effect.fn` program and keep any async export as a one-line run of it. A pure helper, a type module and client code import no `db`. An exempt file says why in an eslint-disable on this import.',
    },
  },
  create(context) {
    /** @type {Array<import('eslint').Rule.Node>} */
    const dbImports = []
    let effect = false
    return {
      ImportDeclaration(node) {
        if (bindsEffect(node)) effect = true
        if (DB_SOURCES.has(String(node.source.value)) && bindsDb(node))
          dbImports.push(node)
      },
      ImportExpression(node) {
        const source = node.source
        if (source.type !== 'Literal') return
        if (isEffect(source.value)) effect = true
        if (DB_SOURCES.has(String(source.value))) dbImports.push(node)
      },
      'Program:exit'() {
        if (effect) return
        for (const node of dbImports)
          context.report({ node, messageId: 'ioIsEffect' })
      },
    }
  },
}

export default { rules: { 'io-is-effect': rule } }
