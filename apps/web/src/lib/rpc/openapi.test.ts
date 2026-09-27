import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DOCS_PATH, OPENAPI_PATH, handleApiRequest } from './api'
import { API_PREFIX, API_VERSION } from './versions'

/**
 * The external contract, pinned (SPA-45). `GET /api/v1/openapi.json` is what
 * an automation tool imports, so it is checked two ways: structurally, as an
 * OpenAPI 3.1 document a consumer can resolve without guessing, and whole,
 * as a file snapshot — adding a procedure changes the snapshot, and removing
 * a field shows up as a diff in review. Updating the snapshot
 * (`vitest -u`) is a statement that the change is additive, or that it is v2
 * (`docs/api-versioning.md`).
 *
 * No validator dependency: the rules below are the ones the OpenAPI 3.1
 * specification states for the parts this generator emits, written out.
 */

const ORIGIN = 'http://spaces.test'
const HELLO_PATH = `${API_PREFIX}/capture/hello`

const fetchDocument = async (): Promise<unknown> => {
  const response = await handleApiRequest(
    new Request(`${ORIGIN}${OPENAPI_PATH}`),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/json')
  return response.json()
}

const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const

/** OAS 3.1 §4.8.16: a response code is a status, a `1XX`-style range, or `default`. */
const StatusKey = z.string().regex(/^(?:[1-5](?:\d\d|XX)|default)$/)

const Parameter = z.object({
  name: z.string().min(1),
  in: z.enum(['query', 'header', 'path', 'cookie']),
  required: z.boolean().optional(),
})

const Operation = z.object({
  operationId: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  parameters: z.array(Parameter).optional(),
  // §4.8.17: every Response Object requires a description.
  responses: z
    .record(StatusKey, z.object({ description: z.string() }))
    .refine((responses) => Object.keys(responses).length > 0, {
      message: 'an operation declares at least one response',
    }),
})

const PathItem = z.object(
  Object.fromEntries(METHODS.map((m) => [m, Operation.optional()])),
)

const Document = z.object({
  openapi: z.string().regex(/^3\.1\.\d+$/),
  info: z.object({ title: z.string().min(1), version: z.string().min(1) }),
  // §4.8.8: a path key begins with a slash.
  paths: z.record(z.string().regex(/^\//), PathItem),
  components: z.object({ schemas: z.record(z.string(), z.unknown()) }),
  tags: z.array(z.object({ name: z.string().min(1) })).optional(),
})

/** Every `$ref` in the document, wherever it sits. */
function refsIn(node: unknown, out: Array<string> = []): Array<string> {
  if (Array.isArray(node)) {
    for (const item of node) refsIn(item, out)
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value)
      else refsIn(value, out)
    }
  }
  return out
}

/** RFC 6901: resolve a `#/a/b` pointer against the document, or undefined. */
function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = doc
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (typeof node !== 'object' || node === null) return undefined
    node = Object.entries(node).find(([k]) => k === key)?.[1]
  }
  return node
}

describe(`GET ${OPENAPI_PATH}`, () => {
  it('is a structurally valid OpenAPI 3.1 document', async () => {
    const raw = await fetchDocument()
    const result = Document.safeParse(raw)
    expect(result.error?.issues ?? []).toEqual([])
    const doc = Document.parse(raw)

    expect(doc.info.version).toBe(String(API_VERSION))

    const operationIds: Array<string> = []
    for (const [path, item] of Object.entries(doc.paths)) {
      // Every procedure lives under the one namespace (D27).
      expect(path.startsWith(`${API_PREFIX}/`), path).toBe(true)
      for (const method of METHODS) {
        const operation = item[method]
        if (operation === undefined) continue
        if (operation.operationId !== undefined) {
          operationIds.push(operation.operationId)
        }
        // §4.8.12.3: every template segment has a required path parameter.
        for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
          expect(
            operation.parameters?.some(
              (p) => p.in === 'path' && p.name === name && p.required === true,
            ),
            `${method.toUpperCase()} ${path} declares {${name}}`,
          ).toBe(true)
        }
        for (const tag of operation.tags ?? []) {
          expect(doc.tags?.map((t) => t.name) ?? []).toContain(tag)
        }
      }
    }
    // §4.8.10: operationId is unique across the document.
    expect(new Set(operationIds).size).toBe(operationIds.length)
  })

  it('resolves every $ref inside itself', async () => {
    const doc = await fetchDocument()
    const unresolved = refsIn(doc).filter(
      (ref) => resolvePointer(doc, ref) === undefined,
    )
    expect(unresolved).toEqual([])
  })

  it('lists the handshake with a 200 carrying both clocks', async () => {
    const raw = await fetchDocument()
    expect(Document.parse(raw).paths).toHaveProperty([HELLO_PATH, 'get'])

    const Ok = z.object({
      content: z.object({
        'application/json': z.object({ schema: z.unknown() }),
      }),
    })
    const ok = Ok.parse(
      resolvePointer(
        raw,
        `#/paths/${HELLO_PATH.replaceAll('/', '~1')}/get/responses/200`,
      ),
    )
    const schema = ok.content['application/json'].schema
    const asRef = z.object({ $ref: z.string() }).safeParse(schema)

    expect(
      asRef.success ? resolvePointer(raw, asRef.data.$ref) : schema,
    ).toMatchObject({
      type: 'object',
      properties: {
        apiVersion: { type: 'integer' },
        captureSchemaVersion: { type: 'integer' },
      },
      required: expect.arrayContaining(['apiVersion', 'captureSchemaVersion']),
    })
  })

  it('is deterministic — two fetches are byte-identical', async () => {
    const first = await (
      await handleApiRequest(new Request(`${ORIGIN}${OPENAPI_PATH}`))
    ).text()
    const second = await (
      await handleApiRequest(new Request(`${ORIGIN}${OPENAPI_PATH}`))
    ).text()
    expect(second).toBe(first)
  })

  it('matches the committed snapshot — the diff is the review', async () => {
    const doc = await fetchDocument()
    await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/openapi.json',
    )
  })
})

describe(`GET ${DOCS_PATH}`, () => {
  it('serves the Scalar reference page over the same document', async () => {
    const response = await handleApiRequest(
      new Request(`${ORIGIN}${DOCS_PATH}`),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('<title>Spaces</title>')
    expect(html).toContain(HELLO_PATH)
  })
})
