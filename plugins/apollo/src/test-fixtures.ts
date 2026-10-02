import { readFileSync, readdirSync } from 'node:fs'
import { z } from 'zod'
import type { JsonValue } from '@spaces/sdk'

/** The committed Apollo responses under fixtures/, for the tests. */
export const FIXTURES_DIR = new URL('../fixtures/', import.meta.url)

export const fixtureNames = (): ReadonlyArray<string> =>
  readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))

export const fixtureText = (name: string): string =>
  readFileSync(new URL(name, FIXTURES_DIR), 'utf8')

export const fixture = (name: string): JsonValue =>
  z.json().parse(JSON.parse(fixtureText(name)))
