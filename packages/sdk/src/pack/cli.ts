#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { packPlugin } from './index.ts'

/**
 * `spaces-plugin-pack [pluginDir] [--out dir] [--key file] [--base-url url]`
 *
 * Packs `<pluginDir>/dist` (run the plugin's `build` first) into
 * `<out>` (default `<pluginDir>/dist/pack`, gitignored with dist/):
 * `<out>/<id>-<version>.tgz` + `.sha256`, and — given a key — `.sig` and the
 * registry entry `<id>-<version>.json`. The key is an ed25519 private key in
 * PEM, from `--key <file>` or the `SPACES_PLUGIN_SIGNING_KEY` variable (how
 * the release workflow hands it over from its secret). No key → unsigned,
 * which only a box with `.allow-unsigned` will load.
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    key: { type: 'string' },
    'base-url': { type: 'string' },
  },
})

const pluginDir = path.resolve(positionals.at(0) ?? '.')
const keyPem =
  values.key === undefined
    ? process.env.SPACES_PLUGIN_SIGNING_KEY
    : await readFile(values.key, 'utf8')

const result = await packPlugin({
  distDir: path.join(pluginDir, 'dist'),
  outDir: path.resolve(values.out ?? path.join(pluginDir, 'dist', 'pack')),
  ...(values['base-url'] === undefined
    ? {}
    : { tarballBaseUrl: values['base-url'] }),
  ...(keyPem ? { privateKey: keyPem } : {}),
})

console.info(`packed   ${result.tarball}`)
console.info(`sha256   ${result.sha256}`)
console.info(
  result.sig === null
    ? 'unsigned (loads only where ./data/plugins/.allow-unsigned exists)'
    : `signed   ${result.keyId ?? ''}`,
)
