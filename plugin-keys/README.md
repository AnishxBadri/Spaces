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
- The private half is a GitHub Actions secret used only by the plugin release
  workflow (ship-9, project 19). No private key is ever committed; tests
  generate ephemeral pairs.

Empty until the first signing key is minted with that workflow.
