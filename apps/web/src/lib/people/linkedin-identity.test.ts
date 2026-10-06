import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { SYSTEM_ATTRIBUTES } from '@spaces/core/attributes/registry'
import { setValues } from '@spaces/core/writes/attributes/values'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { FIXTURE_ACTOR } from '../../../vitest.seed'

/**
 * LinkedIn on a person or a company is an identity alias, never
 * `values.linkedin`. Three locks:
 * - the registry seeds no `linkedin` attribute, so the one write path
 *   refuses the slug;
 * - no source writes a `linkedin` key under `values` or `patch`, seeds and
 *   plugins included (a custom object's declared key is materialized by
 *   slug lookup, not spelt, and stays);
 * - turbo hashes the worker and plugin sources into this package's test task.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

const ROOTS = ['apps/web/src', 'apps/worker/src', 'packages', 'plugins']

const walk = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = join(dir, e.name)
    if (e.isDirectory())
      return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(file)
    return /\.(ts|tsx)$/.test(e.name) &&
      !/\.test\.(ts|tsx)$/.test(e.name) &&
      !e.name.endsWith('.d.ts')
      ? [file]
      : []
  })

const WRITE_BAGS = new Set(['values', 'patch'])

const nameOf = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null

/**
 * Every `linkedin` key inside an object literal that is (or is spread into)
 * the value of a `values:` or `patch:` property, as `line:column`.
 */
function linkedinValueWrites(file: string, text: string): Array<string> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const hits: Array<string> = []
  const bagAbove = (node: ts.Node): boolean => {
    let at: ts.Node = node.parent
    while (
      ts.isObjectLiteralExpression(at) ||
      ts.isSpreadAssignment(at) ||
      ts.isParenthesizedExpression(at) ||
      ts.isConditionalExpression(at) ||
      ts.isBinaryExpression(at) ||
      ts.isAsExpression(at) ||
      ts.isSatisfiesExpression(at)
    )
      at = at.parent
    if (!ts.isPropertyAssignment(at)) return false
    const bag = nameOf(at.name)
    return bag !== null && WRITE_BAGS.has(bag)
  }
  const visit = (node: ts.Node) => {
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node)) &&
      nameOf(node.name) === 'linkedin' &&
      bagAbove(node.parent)
    ) {
      const { line, character } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      )
      hits.push(`${line + 1}:${character + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe('LinkedIn is identity on people and companies', () => {
  it('seeds no linkedin attribute for either', () => {
    for (const kind of ['person', 'company'] as const)
      expect(SYSTEM_ATTRIBUTES[kind].map((a) => a.slug)).not.toContain(
        'linkedin',
      )
  })

  it('refuses values.linkedin through the one write path', async () => {
    for (const kind of ['person', 'company'] as const) {
      const { entityId } = await resolveEntity({
        kind,
        name: `LinkedIn refusal ${kind}`,
        source: { class: 'manual' },
      })
      await expect(
        setValues({
          entityId,
          patch: { linkedin: 'https://linkedin.com/in/someone' },
          actor: { type: 'user', id: FIXTURE_ACTOR.id },
        }),
      ).rejects.toThrow(/linkedin: Unknown attribute/)
    }
  })

  it('recognises the shapes it is looking for', () => {
    const scan = (text: string) => linkedinValueWrites('x.ts', text)
    expect(scan(`f({ values: { location: 'x', linkedin: url } })`)).toEqual([
      '1:30',
    ])
    expect(
      scan(`f({ values: { ...(u ? { linkedin: u } : {}), title: t } })`),
    ).toHaveLength(1)
    expect(scan(`f({ patch: { linkedin } })`)).toHaveLength(1)
    expect(scan(`f({ patch: { 'linkedin': u } })`)).toHaveLength(1)
    // Identity keys are the point, not a violation.
    expect(scan(`f({ keys: { email: e, linkedin: u } })`)).toEqual([])
    expect(scan(`const linkedin = { linkedin: 'LinkedIn' }`)).toEqual([])
  })

  it('has no writer in any package, plugin or seed', () => {
    const sources = ROOTS.map((r) => join(repoRoot, r))
      .filter((dir) => existsSync(dir))
      .flatMap(walk)
    // The seed and Apollo are where the last writers lived.
    expect(sources.some((f) => f.endsWith('lib/seeds/dev.ts'))).toBe(true)
    expect(sources.some((f) => f.endsWith('plugins/apollo/src/map.ts'))).toBe(
      true,
    )

    const writers = sources.flatMap((f) =>
      linkedinValueWrites(f, readFileSync(f, 'utf8')).map(
        (at) => `${relative(repoRoot, f)}:${at}`,
      ),
    )
    expect(writers).toEqual([])
  })
})
