import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { check } from './vault-token-expiry.mjs'

const secret = (expires) => `apiVersion: v1\nkind: Secret\nmetadata:\n  name: vault-token\n  annotations:\n    agora.bretagne.dev/expires: ${expires}\nstringData:\n  access_token: ENC[...]\n`
const now = new Date('2026-11-01T12:00:00Z')

it('the expiry check: a date far enough passes; near, past, unset or malformed fails', () => {
  assert.equal(check(secret('2027-01-30'), now).ok, true)
  assert.equal(check(secret('2026-11-20'), now).ok, false, '18 days: under 21')
  assert.equal(check(secret('2026-10-01'), now).ok, false, 'past')
  assert.equal(check(secret('unset'), now).ok, false)
  assert.equal(check(secret('2027-13-45'), now).ok, false)
  assert.equal(check(secret('2027-02-30'), now).ok, false, 'no 30 February')
  assert.equal(check(secret('2027-04-31'), now).ok, false, 'no 31 April')
  assert.equal(check(secret('2028-02-29'), now).ok, true, 'a leap day')
  assert.equal(check('apiVersion: v1\nkind: Secret\nmetadata:\n  name: vault-token\n', now).ok, false, 'no annotation')
})

it('the file in this repository carries the annotation the check reads', () => {
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../apps/agora-gateway/vault-token.secrets.yaml'), 'utf8')
  assert.match(text, /^ {8}agora\.bretagne\.dev\/expires: /m)
})
