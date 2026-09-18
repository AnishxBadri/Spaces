import type { ESLint, Rule } from 'eslint'

export interface V1TokenHit {
  index: number
  length: number
  token: string
  use: string
}

/** Every v1 token in one class string. Exported for the fixture test. */
export function findV1Tokens(
  value: string,
  isRootRoute: boolean,
): Array<V1TokenHit>

export const rule: Rule.RuleModule

declare const plugin: ESLint.Plugin
export default plugin
