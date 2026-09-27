# API versioning

The external API (`apps/web/src/lib/rpc/api.ts`, D8, D27) describes itself at
`GET /api/v1/openapi.json`, with a Scalar reference page over the same
document at `GET /api/v1/docs`. SPA-45 set down the rules below, and every
later external surface follows them.

## One version, in the path

`/api/v1` is the only versioning. There are no version headers, no query
parameters and no media-type versions. `API_VERSION` in
`apps/web/src/lib/rpc/versions.ts` is the `1` in the path and the
`info.version` of the document.

**Within a version, changes are additive.** Allowed in v1:

- a new procedure (new path or new method)
- a new optional input field or query parameter
- a new output field
- a new declared failure on a new procedure

**v2 is required for** anything a v1 caller could trip on:

- a removed or renamed procedure, path or field
- a narrowed type: an input v1 accepted is refused, or an output loses a case
  it used to have
- an optional input made required
- a changed status code or error `tag` for an existing failure
- a changed meaning of an existing field

v2 is a second `Api` under `/api/v2`, with v1 still served next to it until
it is retired on purpose.

Additive only works if callers tolerate additions. A v1 client must ignore
response fields it does not know. The generator writes
`additionalProperties: false` on every object schema, and that describes the
shape at the time the document was generated. It does not promise that no
field will be added.

## Two clocks

`capture.hello` answers both versions:

| Clock                  | Constant                 | Moves when                                                                                   |
| ---------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| `apiVersion`           | `API_VERSION`            | a v2-forcing change above; the path moves with it                                            |
| `captureSchemaVersion` | `CAPTURE_SCHEMA_VERSION` | the capture extension's payload shape changes; this happens inside v1 and the path stays put |

The capture extension ships on its own release cycle (CONTEXT.md integration
map #8), so its payload has its own version inside v1 on purpose. An installed
extension calls the handshake first and compares both numbers. If
`apiVersion` differs, the API it was built for is gone. If only
`captureSchemaVersion` differs, it should update itself.

`POST /api/v1/capture` (SPA-111) holds the instance's side of that promise.
It accepts every version in `ACCEPTED_CAPTURE_SCHEMA_VERSIONS`
(`apps/web/src/lib/rpc/versions.ts`), which is the current version plus each
older one the handler can still read. Any other version gets a 422
`UnsupportedCaptureSchemaVersion` whose message says to update the extension
and lists the accepted versions. When `CAPTURE_SCHEMA_VERSION` is bumped, add
the new number to that list and keep the old one for as long as its shape is
still read.

SPA-134 added an optional `object` input and an `extraction` output
(`queued` | `skipped`) to the capture. Both are additive within v1 by the
rules above, so neither `API_VERSION` nor `CAPTURE_SCHEMA_VERSION` moved: a
client that sends no `object` gets the capture it always did, plus a field it
may ignore.

## The snapshot is the review

`apps/web/src/lib/rpc/openapi.test.ts` checks that the served document is
valid OpenAPI 3.1 and compares it to
`apps/web/src/lib/rpc/__snapshots__/openapi.json`. Any change to the external
contract shows up in a pull request as a diff of that file. Running
`vitest -u` to accept the diff says the change is additive. If the diff
removes or narrows anything, it belongs in v2.

## Raw routes stay raw

`/api/auth/$`, `/api/blob/$key`, `/api/health`, `/api/mcp` and the future
`/api/webhooks/$provider` ingress are not procedures and never move under
`/api/v1`. For example, an HMAC computed over an exact raw body is not a
procedure (docs/spec-plugin-sdk.md §11). `apps/web/src/lib/rpc/namespace.test.ts`
checks that `/api/v1` is a single splat route and that every other `/api`
route is on the raw list.

## Manual check: a generated client calls the handshake

This is not a dependency and does not run in tests. With `pnpm dev` running:

```sh
npx openapi-typescript http://localhost:3000/api/v1/openapi.json -o /tmp/spaces-api.d.ts
curl -s http://localhost:3000/api/v1/capture/hello
# {"apiVersion":1,"captureSchemaVersion":1}
```

`/tmp/spaces-api.d.ts` should declare `paths["/api/v1/capture/hello"]["get"]`
with a 200 response of `{ apiVersion: number; captureSchemaVersion: number }`.
To check the same thing in an automation tool, import the document URL into
Postman or n8n and call "Version handshake".
