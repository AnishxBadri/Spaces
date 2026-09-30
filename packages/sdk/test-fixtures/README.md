Manifest fixtures for `src/manifest.test.ts`, each the on-disk `manifest.json`
shape. `legacy-kind.json` still says `kind: 'enricher'` and must be refused
(D51); `too-new-sdk.json` is well-formed but asks for an sdk major this host
does not provide, so it parses and then fails `satisfiesSdk` with the reason
the loader writes. The valid manifest is the echo fixture's build output
(`plugins/_fixtures/echo`), not a file here.
