// The previews client as this repository declares it: the Pocket-ID reconciler owns its secret (spec.json
// `secret`; ADR 0022, amendment 2026-10-29), in a Secret this app creates empty and hands over alone; the
// refresher mints with the client the spec pins, tokens that outlive two of its runs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseAllDocuments } from 'yaml'

const ROOT = new URL('../../', import.meta.url).pathname
const manifests = parseAllDocuments(readFileSync(join(ROOT, 'apps/agora-gateway/previews-refresher.yaml'), 'utf8')).map((d) => d.toJS())
const cronJob = manifests.find((m) => m.kind === 'CronJob')
const env = Object.fromEntries(cronJob.spec.jobTemplate.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]))
const spec = JSON.parse(readFileSync(join(ROOT, 'apps/pocket-id/oidc-reconciler/spec.json'), 'utf8'))
const client = spec.clients.find((c) => c.name === 'agora_gateway_previews')

test('the client the spec declares: its pinned id, restricted to no group, tokens that outlive two runs of the refresher', () => {
  assert.equal(client.id, env.CLIENT_ID)
  assert.equal(client.isGroupRestricted, true)
  assert.deepEqual(client.allowedGroups ?? [], [])
  assert.deepEqual(client.callbackURLs, [])
  assert.equal(cronJob.spec.schedule, '*/5 * * * *')
  assert.ok(client.accessTokenDurationMinutes >= Number(env.MIN_LIFE_MINUTES), `${client.accessTokenDurationMinutes} min`)
})

test('the client secret handed to the Pocket-ID reconciler: an empty Secret Flux creates once, that Secret alone to it', () => {
  const secret = manifests.find((m) => m.kind === 'Secret' && m.metadata.name === 'previews-client')
  assert.equal(secret.metadata.annotations['kustomize.toolkit.fluxcd.io/ssa'], 'IfNotPresent')
  assert.deepEqual(secret.data, { client_secret: '' })
  assert.deepEqual(client.secret, { namespace: 'agora-gateway', name: 'previews-client' })
  const role = manifests.find((m) => m.kind === 'Role' && m.metadata.name === 'oidc-reconciler-previews-client')
  assert.deepEqual(role.rules, [{ apiGroups: [''], resources: ['secrets'], resourceNames: ['previews-client'], verbs: ['get', 'update'] }])
  const binding = manifests.find((m) => m.kind === 'RoleBinding' && m.roleRef.name === role.metadata.name)
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'oidc-reconciler', namespace: 'pocket-id' }])
  const volume = cronJob.spec.jobTemplate.spec.template.spec.volumes.find((v) => v.secret?.secretName === 'previews-client')
  assert.equal(volume.secret.optional, true)
})
