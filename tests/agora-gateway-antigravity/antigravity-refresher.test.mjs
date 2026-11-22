// The Google login's refresher (apps/agora-gateway/antigravity-refresher.yaml): its script, as the ConfigMap ships
// it, run against a stand-in for Google's token endpoint and a stand-in API server, in both places the refresh token
// may live — the SOPS key of upstream-credentials (it does not rotate) or antigravity-session (it rotates). It writes
// the access token to antigravity-token keeping the Secret's other keys, never logs a token, says when it refreshed
// and when the refresh is refused, and why it stops: 4 no login yet, 1 refused, 2 unable to read or write, 3 a token
// too short or a rotation the SOPS key cannot follow. And its manifests: RBAC on its own two Secrets alone, the one
// key of upstream-credentials mounted, optional, egress to Google's token endpoint alone.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseAllDocuments } from 'yaml'

const ROOT = new URL('../../', import.meta.url).pathname
const own = parseAllDocuments(readFileSync(join(ROOT, 'apps/agora-gateway/antigravity-refresher.yaml'), 'utf8')).map((d) => d.toJS())
const script = own.find((m) => m.kind === 'ConfigMap' && m.metadata.name === 'antigravity-refresher').data['refresh.mjs']
// The manifests as Flux applies them (kustomize reads 0440 as the octal mode, as Kubernetes does).
const rendered = parseAllDocuments(execFileSync(process.env.KUBECTL ?? 'kubectl', ['kustomize', join(ROOT, 'apps/agora-gateway')], { encoding: 'utf8' })).map((d) => d.toJS())
const cronJob = rendered.find((m) => m.kind === 'CronJob' && m.metadata.name === 'antigravity-refresher')
const pod = cronJob.spec.jobTemplate.spec.template.spec
const env = Object.fromEntries(pod.containers[0].env.map((e) => [e.name, e.value]))

const REFRESH = '1//the-refresh-token'
const NEXT = '1//the-next-refresh-token'
const ACCESS = 'ya29.the-access-token'
const PATHS = { token: '/api/v1/namespaces/agora-gateway/secrets/antigravity-token', session: '/api/v1/namespaces/agora-gateway/secrets/antigravity-session' }
const b64 = (s) => Buffer.from(s).toString('base64')
const unb64 = (s) => Buffer.from(s, 'base64').toString()

/** Google's token endpoint and the API server, standing in; what each was asked. */
async function standIns({ session = null, tokenStatus = 200, tokenBody, putStatus = {} } = {}) {
  const asked = { token: [], api: [] }
  const secrets = {
    token: { metadata: { name: 'antigravity-token', namespace: 'agora-gateway', resourceVersion: '1' }, data: { access_token: '', other: b64('kept') } },
    session: session === null ? null : { metadata: { name: 'antigravity-session', namespace: 'agora-gateway', resourceVersion: '1' }, data: { refresh_token: b64(session), other: b64('kept') } },
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.url === '/token') {
        asked.token.push(Object.fromEntries(new URLSearchParams(body)))
        res.writeHead(tokenStatus, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(tokenBody ?? (tokenStatus === 200 ? { access_token: ACCESS, expires_in: 3599, scope: 'openid', token_type: 'Bearer' } : { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })))
      }
      asked.api.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
      const key = Object.entries(PATHS).find(([, p]) => p === req.url)?.[0]
      if (!key || secrets[key] === null) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"kind":"Status","code":404}')
      if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(secrets[key]))
      if (putStatus[key]) return res.writeHead(putStatus[key]).end()
      secrets[key] = JSON.parse(body)
      return res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    })
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${server.address().port}`, asked, secrets, close: () => server.close() }
}

/** The script as the CronJob runs it: its env, a ServiceAccount's files, the SOPS key mounted or not. */
async function refresh(base, { sops = null, overrides = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'antigravity-refresher-'))
  writeFileSync(join(dir, 'refresh.mjs'), script)
  mkdirSync(join(dir, 'sa'))
  writeFileSync(join(dir, 'sa', 'namespace'), 'agora-gateway\n')
  writeFileSync(join(dir, 'sa', 'token'), 'the-service-account-token\n')
  if (sops !== null) writeFileSync(join(dir, 'refresh_token'), `${sops}\n`)
  const child = spawn(process.execPath, [join(dir, 'refresh.mjs')], {
    env: { ...process.env, ...env, TOKEN_URL: `${base}/token`, KUBE_API: base, SA_DIR: join(dir, 'sa'), REFRESH_TOKEN_FILE: join(dir, 'refresh_token'), RETRY_MS: '1', ...overrides },
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const code = await new Promise((ok) => child.on('close', ok))
  for (const secret of [REFRESH, NEXT, ACCESS, env.CLIENT_SECRET]) assert.ok(!output.includes(secret), `never logged: ${output}`)
  return { code, output }
}

describe('the refresher, the refresh token in upstream-credentials (it does not rotate)', () => {
  it('refreshes with agy\'s client, writes the access token and its expiry, keeps the other keys, says so', async () => {
    const s = await standIns()
    try {
      const { code, output } = await refresh(s.url, { sops: REFRESH })
      assert.equal(code, 0, output)
      assert.deepEqual(s.asked.token, [{ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: REFRESH }])
      assert.equal(unb64(s.secrets.token.data.access_token), ACCESS)
      assert.equal(unb64(s.secrets.token.data.other), 'kept')
      assert.ok(Date.parse(unb64(s.secrets.token.data.expires_at)) > Date.now() + 3_500_000)
      assert.match(output, /refreshed \(upstream-credentials\): access token valid until \d{4}-\d\d-\d\dT[\d:.]+Z \(3599 s\), refresh token unchanged/)
      assert.ok(s.asked.api.every((a) => a.authorization === 'Bearer the-service-account-token'))
    } finally {
      s.close()
    }
  })

  it('refused by Google: exit 1, the log says it and what to do, nothing written', async () => {
    const s = await standIns({ tokenStatus: 400 })
    try {
      const { code, output } = await refresh(s.url, { sops: REFRESH })
      assert.equal(code, 1)
      assert.match(output, /refresh refused \(upstream-credentials\): 400 invalid_grant: Token has been expired or revoked\. — .*log in again/)
      assert.equal(s.secrets.token.data.access_token, '')
      assert.ok(!s.asked.api.some((a) => a.method === 'PUT'))
    } finally {
      s.close()
    }
  })

  it('Google unreachable: exit 1, said', async () => {
    const s = await standIns()
    try {
      const { code, output } = await refresh(s.url, { sops: REFRESH, overrides: { TOKEN_URL: 'http://127.0.0.1:9/token' } })
      assert.equal(code, 1)
      assert.match(output, /refresh failed \(upstream-credentials\): Google's token endpoint unreachable/)
    } finally {
      s.close()
    }
  })

  it('Google rotates it all the same: the access token written, exit 3, the move to antigravity-session asked for', async () => {
    const s = await standIns({ tokenBody: { access_token: ACCESS, expires_in: 3599, refresh_token: NEXT } })
    try {
      const { code, output } = await refresh(s.url, { sops: REFRESH })
      assert.equal(code, 3)
      assert.equal(unb64(s.secrets.token.data.access_token), ACCESS)
      assert.match(output, /the login rotates — move it to antigravity-session/)
      assert.match(output, /refresh token rotated/)
    } finally {
      s.close()
    }
  })

  it('no login yet (neither the key nor antigravity-session): exit 4, Google never asked', async () => {
    const s = await standIns()
    try {
      const { code, output } = await refresh(s.url)
      assert.equal(code, 4)
      assert.match(output, /no refresh token yet/)
      assert.equal(s.asked.token.length, 0)
    } finally {
      s.close()
    }
  })

  it('unable to write antigravity-token: exit 2 after its retries', async () => {
    const s = await standIns({ putStatus: { token: 500 } })
    try {
      const { code, output } = await refresh(s.url, { sops: REFRESH })
      assert.equal(code, 2)
      assert.match(output, /antigravity-token not written/)
      assert.equal(s.asked.api.filter((a) => a.method === 'PUT').length, 5)
    } finally {
      s.close()
    }
  })

  it('a token shorter than two runs: written, exit 3', async () => {
    const s = await standIns({ tokenBody: { access_token: ACCESS, expires_in: 600 } })
    try {
      const { code, output } = await refresh(s.url, { sops: REFRESH })
      assert.equal(code, 3)
      assert.equal(unb64(s.secrets.token.data.access_token), ACCESS)
      assert.match(output, /lives 600 s/)
    } finally {
      s.close()
    }
  })
})

describe('the refresher, the refresh token in antigravity-session (it rotates)', () => {
  it('antigravity-session wins over the SOPS key; a new refresh token is written there first, then the access token', async () => {
    const s = await standIns({ session: REFRESH, tokenBody: { access_token: ACCESS, expires_in: 3599, refresh_token: NEXT } })
    try {
      const { code, output } = await refresh(s.url, { sops: 'a-stale-one' })
      assert.equal(code, 0, output)
      assert.equal(s.asked.token[0].refresh_token, REFRESH)
      assert.equal(unb64(s.secrets.session.data.refresh_token), NEXT)
      assert.equal(unb64(s.secrets.session.data.other), 'kept')
      assert.equal(unb64(s.secrets.token.data.access_token), ACCESS)
      const puts = s.asked.api.filter((a) => a.method === 'PUT').map((a) => a.url)
      assert.deepEqual(puts, [PATHS.session, PATHS.token])
      assert.match(output, /refreshed \(antigravity-session\): .*refresh token rotated/)
    } finally {
      s.close()
    }
  })

  it('the new refresh token cannot be written: exit 2, said, the access token not written either', async () => {
    const s = await standIns({ session: REFRESH, tokenBody: { access_token: ACCESS, expires_in: 3599, refresh_token: NEXT }, putStatus: { session: 409 } })
    try {
      const { code, output } = await refresh(s.url)
      assert.equal(code, 2)
      assert.match(output, /new refresh token was not written to antigravity-session/)
      assert.equal(s.asked.api.filter((a) => a.method === 'PUT' && a.url === PATHS.session).length, 6)
      assert.equal(s.secrets.token.data.access_token, '')
    } finally {
      s.close()
    }
  })

  it('an empty antigravity-session: exit 4', async () => {
    const s = await standIns({ session: '' })
    try {
      const { code } = await refresh(s.url, { sops: REFRESH })
      assert.equal(code, 4)
      assert.equal(s.asked.token.length, 0)
    } finally {
      s.close()
    }
  })
})

describe('the refresher\'s manifests', () => {
  it('every 15 minutes, never twice at once, no retry by a new Pod', () => {
    assert.equal(cronJob.spec.schedule, '7-59/15 * * * *')
    assert.equal(cronJob.spec.concurrencyPolicy, 'Forbid')
    assert.equal(cronJob.spec.jobTemplate.spec.backoffLimit, 0)
  })

  it('its RBAC reaches its own two Secrets alone, get and update', () => {
    const roles = rendered.filter((o) => o.kind === 'RoleBinding' && o.subjects?.some((s) => s.kind === 'ServiceAccount' && s.name === 'antigravity-refresher'))
    assert.deepEqual(roles.map((b) => b.roleRef), [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'antigravity-refresher' }])
    assert.ok(!rendered.some((o) => o.kind === 'ClusterRoleBinding' && o.subjects?.some((s) => s.name === 'antigravity-refresher')))
    const role = rendered.find((o) => o.kind === 'Role' && o.metadata.name === 'antigravity-refresher')
    assert.deepEqual(role.rules, [{ apiGroups: [''], resources: ['secrets'], resourceNames: ['antigravity-token', 'antigravity-session'], verbs: ['get', 'update'] }])
  })

  it('upstream-credentials: its one key, optional; antigravity-token created empty and left to the refresher', () => {
    const login = pod.volumes.find((v) => v.name === 'login').secret
    assert.deepEqual(login, { secretName: 'upstream-credentials', optional: true, defaultMode: 0o440, items: [{ key: 'antigravity-refresh-token', path: 'refresh_token' }] })
    const token = rendered.find((o) => o.kind === 'Secret' && o.metadata.name === 'antigravity-token')
    assert.equal(token.metadata.annotations['kustomize.toolkit.fluxcd.io/ssa'], 'IfNotPresent')
    assert.deepEqual(token.data, { access_token: '' })
    assert.ok(!rendered.some((o) => o.kind === 'Secret' && o.metadata.name === 'antigravity-session'), 'antigravity-session is kept out of git')
  })

  it('its network: DNS, the API server, 443 out — claude-refresher\'s, never by name', () => {
    const policy = rendered.find((o) => o.kind === 'CiliumNetworkPolicy' && o.metadata.name === 'antigravity-refresher')
    assert.deepEqual(policy.spec.endpointSelector, { matchLabels: { app: 'antigravity-refresher' } })
    assert.deepEqual(cronJob.spec.jobTemplate.spec.template.metadata.labels, { app: 'antigravity-refresher' })
    const egress = policy.spec.egress
    assert.equal(egress.length, 3)
    assert.deepEqual(egress[1], { toEntities: ['kube-apiserver'] })
    assert.deepEqual(egress[2], { toEntities: ['world'], toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }] })
    assert.equal(egress[0].toPorts[0].rules, undefined, 'no DNS rule: it would send DNS through Cilium\'s proxy')
    const claude = rendered.find((o) => o.kind === 'CiliumNetworkPolicy' && o.metadata.name === 'claude-refresher')
    assert.deepEqual(egress, claude.spec.egress)
    assert.equal(cronJob.spec.jobTemplate.spec.template.spec.dnsConfig, undefined)
  })
})
