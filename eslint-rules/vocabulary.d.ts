import type { ESLint, Rule } from 'eslint'

export interface BannedTokenHit {
  index: number
  length: number
  token: string
  use: string
}

/** Every banned token in one class string. Exported for the fixture test. */
export function findBannedTokens(
  value: string,
  isRootRoute: boolean,
): Array<BannedTokenHit>

export interface ArbitraryTypeHit {
  index: number
  length: number
  token: string
  fix: string
}

/** The named type steps, diffed against styles.css by the fixture test. */
export const NAMED_STEPS: Array<{
  name: string
  rem: number
  lineRem: number
}>

/** Every arbitrary type size in one class string (DESIGN.md §3). */
export function findArbitraryType(value: string): Array<ArbitraryTypeHit>

export const rule: Rule.RuleModule

declare const plugin: ESLint.Plugin
export default plugin
