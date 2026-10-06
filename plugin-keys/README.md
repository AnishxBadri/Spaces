# plugin-keys

The public keys this image trusts to sign plugins (D54; `docs/spec-plugin-sdk.md`
§9). Copied into the image at `/app/plugin-keys` by `docker/Dockerfile` and read
by `@spaces/core/plugins/trust` — never from `registry.json`, whose server would
then choose the key, and never from the environment.

- One file per key: `<keyId>.pub`, an ed25519 public key in PEM (SPKI).
- The key id is content-derived: `ed25519-` and the first 16 hex digits of
  sha256 over the raw 32-byte public key (`keyIdOf` in `@spaces/sdk/pack`). A
  file whose key does not hash to its name is not trusted.
- A rotation adds the new key beside the old one, so a release signed by either
  verifies; the old file leaves once no published version needs it.
- The private half is the GitHub Actions secret **`SPACES_PLUGIN_SIGNING_KEY`**
  (the PEM, whole), used only by `.github/workflows/plugin-release.yml` — the
  same variable `spaces-plugin-pack` reads. No private key is ever committed;
  tests and the `--no-push` dry run generate throwaway pairs.

Minting the release key, once:

```sh
openssl genpkey -algorithm ed25519 -out spaces-plugin-signing.pem   # outside the repo
pnpm exec tsx scripts/plugin-key.ts spaces-plugin-signing.pem       # writes plugin-keys/<keyId>.pub
```

Commit the `.pub`, paste the PEM into the `SPACES_PLUGIN_SIGNING_KEY`
repository secret, and keep the file offline. A plugin release refuses to
publish under a key this directory does not hold, because the image could not
verify it; and an image only trusts keys it was built with, so the `.pub` must
reach a `core@` release before plugins signed with it install anywhere.

Empty until that key is minted.
