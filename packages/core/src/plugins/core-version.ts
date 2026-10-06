import root from '../../../../package.json' with { type: 'json' }

/** This core's version — the root package's — which `lock.json` pins as `core`. */
export const CORE_VERSION: string = root.version
