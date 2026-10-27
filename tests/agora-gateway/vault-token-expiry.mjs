// When does the gateway's vault token expire? apps/agora-gateway/vault-token.secrets.yaml carries the date in
// its annotation `agora.bretagne.dev/expires` (metadata, which SOPS leaves readable). Fails when the date is
// unset, unreadable, or fewer than MIN_DAYS away, so a scheduled run says it before the vault answers 401.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

export const ANNOTATION = 'agora.bretagne.dev/expires'

/** `{ ok, message }` for the Secret's text, at `now`, with `minDays` of margin. */
export function check(text, now = new Date(), minDays = 21) {
  const value = parse(text)?.metadata?.annotations?.[ANNOTATION]
  // A calendar date: Date would roll 2027-02-30 over to March, so the date must read back unchanged.
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null
  const real = date !== null && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  if (!real) {
    return { ok: false, message: `${ANNOTATION} is ${JSON.stringify(value ?? null)}, not a date: no token is set, or its date is not` }
  }
  const days = Math.floor((Date.parse(`${value}T00:00:00Z`) - now.getTime()) / 86_400_000)
  if (days < minDays) return { ok: false, message: `the vault token expires ${value}, in ${days} day(s): mint a new one (PR #295, "Rotating the token")` }
  return { ok: true, message: `the vault token expires ${value}, in ${days} days` }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = resolve(process.argv[2] ?? 'apps/agora-gateway/vault-token.secrets.yaml')
  const { ok, message } = check(readFileSync(file, 'utf8'), new Date(), Number(process.env.MIN_DAYS ?? 21))
  console[ok ? 'log' : 'error'](message)
  process.exit(ok ? 0 : 1)
}
