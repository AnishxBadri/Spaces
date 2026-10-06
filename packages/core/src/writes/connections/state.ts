import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { Effect, Option, Schema } from 'effect'
import { loadMasterKey } from '../vault/key'

/**
 * The OAuth `state` a connect dance carries out and back: who asked, for
 * which provider, product and scopes, and where to land afterwards.
 * - `<base64url(canonical JSON)>.<base64url(HMAC-SHA256)>`, keyed off the
 *   master key. Signed, not encrypted: it holds nothing secret.
 * - Never carries the PKCE verifier — the state travels through the
 *   provider; the verifier stays in the browser's cookie (`pkce.ts`).
 * - Ten-minute life, checked against `issuedAt` on the way back.
 */

export const STATE_TTL_MS = 10 * 60 * 1000

export type ConnectState = {
  readonly userId: string
  readonly provider: string
  /** The product the grant is for (D66): `drive`, `calendar`, `gmail`, `box`. */
  readonly product: string
  /** Registry `value`s, as asked for. */
  readonly scopes: ReadonlyArray<string>
  /** A same-origin path, never a URL. */
  readonly returnTo: string
  /** Keys the verifier cookie, so a callback finds the one this state set. */
  readonly nonce: string
  /** Epoch milliseconds. */
  readonly issuedAt: number
}

const Payload = Schema.Struct({
  v: Schema.Literal(1),
  userId: Schema.String,
  provider: Schema.String,
  product: Schema.String,
  scopes: Schema.Array(Schema.String),
  returnTo: Schema.String,
  nonce: Schema.String,
  issuedAt: Schema.Number,
})

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Payload))

export class StateInvalid extends Schema.TaggedError<StateInvalid>()(
  'StateInvalid',
  {
    reason: Schema.Literals(['tampered', 'expired', 'wrong-user']),
    message: Schema.String,
  },
) {}

/** 16 random bytes, base64url: cookie-name safe. */
export function newNonce(): string {
  return randomBytes(16).toString('base64url')
}

// FROZEN: this HKDF info label is a key-derivation input — renaming it
// invalidates every state in flight.
const stateKey = (master: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', master, '', 'spaces:connect-state', 32))

const mac = (master: Buffer, payload: string): Buffer =>
  createHmac('sha256', stateKey(master)).update(payload).digest()

/** Fixed key order, so one state has one encoding. */
function canonical(state: ConnectState): string {
  return JSON.stringify({
    v: 1,
    userId: state.userId,
    provider: state.provider,
    product: state.product,
    scopes: [...state.scopes],
    returnTo: state.returnTo,
    nonce: state.nonce,
    issuedAt: state.issuedAt,
  })
}

export function signState(
  state: ConnectState,
  master: Buffer = loadMasterKey(),
): string {
  const payload = Buffer.from(canonical(state)).toString('base64url')
  return `${payload}.${mac(master, payload).toString('base64url')}`
}

const invalid = (reason: StateInvalid['reason'], message: string) =>
  new StateInvalid({ reason, message })

/**
 * The state a callback was handed, checked: signature, then life, then the
 * session user. A malformed token is `tampered` like a re-signed one.
 */
export const verifyState = Effect.fn('verifyState')(function* (
  token: string,
  expected: { readonly userId: string; readonly now?: number },
  master: Buffer = loadMasterKey(),
): Effect.fn.Return<ConnectState, StateInvalid> {
  const parts = token.split('.')
  const [payload, signature] = parts
  if (parts.length !== 2 || !payload || !signature)
    return yield* invalid('tampered', 'The connect state is malformed')
  const given = Buffer.from(signature, 'base64url')
  const wanted = mac(master, payload)
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
    return yield* invalid('tampered', 'The connect state was altered')
  const decoded = decodePayload(
    Buffer.from(payload, 'base64url').toString('utf8'),
  )
  if (Option.isNone(decoded))
    return yield* invalid('tampered', 'The connect state is malformed')
  const state = decoded.value
  const now = expected.now ?? Date.now()
  if (now - state.issuedAt > STATE_TTL_MS || state.issuedAt > now)
    return yield* invalid('expired', 'The connect request expired; start again')
  if (state.userId !== expected.userId)
    return yield* invalid(
      'wrong-user',
      'This connect request was started by someone else',
    )
  return {
    userId: state.userId,
    provider: state.provider,
    product: state.product,
    scopes: state.scopes,
    returnTo: state.returnTo,
    nonce: state.nonce,
    issuedAt: state.issuedAt,
  }
})
