import { z } from 'zod'
import type { Json } from '#/lib/json'

/**
 * What an LLM provider's `credential.meta` holds (SPA-29). The column is an
 * open JSON record; this is the one decode an adapter reads it through, so a
 * row written by hand or by an older build cannot hand the SDK a number where
 * a URL goes. Unknown keys are kept by the column and ignored here.
 *
 * - `baseUrl` + `headers` — gateway passthrough (`docs/spec-ai-substrate.md`
 *   §9): point a provider at Helicone / LiteLLM / Portkey by URL and header.
 *   These are *non-secret config* by the vault's contract: they are stored in
 *   plain jsonb, not encrypted, and shown back to the admin.
 * - `display` — the redacted key (`sk-…abcd`), written at save so the ledger
 *   never decrypts to draw a row.
 * - `lastTestedAt` / `lastTestOk` — the Test call's verdict. Never the
 *   model's answer and never the provider's error text.
 * - `embedTestedAt` / `embedTestOk` / `embedTestModel` — the embedding Test's
 *   verdict and the model it tested (SPA-83). Its own keys because Ollama's
 *   embedding half reuses the LLM row, and one Test must not answer for the
 *   other; the sensitive slot is offered on a green one.
 */
export const providerMeta = z.object({
  baseUrl: z.string().url().optional().catch(undefined),
  headers: z.record(z.string(), z.string()).optional().catch(undefined),
  display: z.string().optional().catch(undefined),
  lastTestedAt: z.string().optional().catch(undefined),
  lastTestOk: z.boolean().optional().catch(undefined),
  embedTestedAt: z.string().optional().catch(undefined),
  embedTestOk: z.boolean().optional().catch(undefined),
  embedTestModel: z.string().optional().catch(undefined),
})

export type ProviderMeta = z.infer<typeof providerMeta>

export function readProviderMeta(meta: { [k: string]: Json }): ProviderMeta {
  return providerMeta.parse(meta)
}

/** A header name as RFC 9110 spells a token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * The form's `Name: value` lines → a header record. Blank lines are skipped;
 * a line with no colon or a name that is not a header token is refused by
 * line number, so the admin sees which line and why instead of a request
 * that fails somewhere downstream.
 */
export function parseHeaderLines(
  text: string,
):
  { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  const headers: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon <= 0)
      return {
        ok: false,
        error: `Header line ${i + 1}: expected "Name: value"`,
      }
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!HEADER_NAME.test(name))
      return {
        ok: false,
        error: `Header line ${i + 1}: "${name}" is not a header name`,
      }
    headers[name] = value
  }
  return { ok: true, headers }
}

/** The inverse, for prefilling the form from a stored record. */
export function formatHeaderLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}
