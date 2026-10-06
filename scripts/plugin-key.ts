/**
 * Writes `plugin-keys/<keyId>.pub` from the plugin signing key, so the image
 * trusts what the release workflow signs with it. The private key never
 * enters the repo; it is the SPACES_PLUGIN_SIGNING_KEY secret.
 *
 *   openssl genpkey -algorithm ed25519 -out spaces-plugin-signing.pem
 *   pnpm exec tsx scripts/plugin-key.ts spaces-plugin-signing.pem
 */
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { keyIdOf } from '@spaces/sdk/pack'
import { ROOT } from './release/versioning.ts'

const file = process.argv.at(2)
if (file === undefined) {
  console.error('usage: plugin-key.ts <ed25519 private key PEM>')
  process.exit(2)
}
const publicKey = createPublicKey(createPrivateKey(readFileSync(file, 'utf8')))
const keyId = keyIdOf(publicKey)
const out = path.join(ROOT, 'plugin-keys', `${keyId}.pub`)
writeFileSync(out, publicKey.export({ format: 'pem', type: 'spki' }))
console.info(`wrote ${path.relative(ROOT, out)} — commit it before the release`)
