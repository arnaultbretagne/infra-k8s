// The vault token's refresher (apps/agora-gateway/vault-refresher.yaml): its script, as the ConfigMap
// ships it, run against a stand-in Pocket-ID token endpoint and a stand-in API server. It mints by
// client_credentials, writes the token to vault-token keeping the Secret's other keys, never logs it,
// and says why it stops: 4 without a client secret, 1 refused, 2 unable to write, 3 a token too short.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseAllDocuments } from 'yaml'

const ROOT = new URL('../../', import.meta.url).pathname
const manifests = parseAllDocuments(readFileSync(join(ROOT, 'apps/agora-gateway/vault-refresher.yaml'), 'utf8')).map((d) => d.toJS())
const script = manifests.find((m) => m.kind === 'ConfigMap' && m.metadata.name === 'vault-refresher').data['refresh.mjs']
const cronJob = manifests.find((m) => m.kind === 'CronJob')
const env = Object.fromEntries(cronJob.spec.jobTemplate.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]))
const spec = JSON.parse(readFileSync(join(ROOT, 'apps/pocket-id/oidc-reconciler/spec.json'), 'utf8'))
const client = spec.clients.find((c) => c.name === 'agora_gateway_vault')

const TOKEN = 'eyJ.the-minted-token.sig'
const SECRET = 'the-client-secret'

/** Pocket-ID's token endpoint and the API server, standing in; what each was asked. */
async function standIns({ tokenStatus = 200, expiresIn = 900, putStatus = 200 } = {}) {
  const asked = { token: [], api: [] }
  const secret = { metadata: { name: 'vault-token', namespace: 'agora-gateway' }, data: { access_token: '', other: 'a2VwdA==' } }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.url === '/api/oidc/token') {
        asked.token.push({ authorization: req.headers.authorization, body })
        res.writeHead(tokenStatus, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(tokenStatus === 200 ? { access_token: TOKEN, token_type: 'Bearer', expires_in: expiresIn } : { error: 'invalid_client' }))
      }
      asked.api.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
      if (req.url !== '/api/v1/namespaces/agora-gateway/secrets/vault-token') return res.writeHead(404).end()
      if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(secret))
      if (putStatus !== 200) return res.writeHead(putStatus).end()
      Object.assign(secret, JSON.parse(body))
      return res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, asked, secret, close: () => server.close() }
}

/** The script as the CronJob runs it: its env, a ServiceAccount's files, the client secret mounted. */
async function refresh(base, clientSecret) {
  const dir = mkdtempSync(join(tmpdir(), 'vault-refresher-'))
  writeFileSync(join(dir, 'refresh.mjs'), script)
  mkdirSync(join(dir, 'sa'))
  writeFileSync(join(dir, 'sa', 'namespace'), 'agora-gateway\n')
  writeFileSync(join(dir, 'sa', 'token'), 'the-service-account-token\n')
  writeFileSync(join(dir, 'client_secret'), `${clientSecret}\n`)
  const child = spawn(process.execPath, [join(dir, 'refresh.mjs')], {
    env: {
      ...process.env,
      ...env,
      TOKEN_URL: `${base}/api/oidc/token`,
      KUBE_API: base,
      SA_DIR: join(dir, 'sa'),
      CLIENT_SECRET_FILE: join(dir, 'client_secret'),
      RETRY_MS: '1',
    },
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const code = await new Promise((resolve) => child.on('close', resolve))
  return { code, output }
}

test('a token minted by client_credentials, written to vault-token with the Secret\'s other keys, never logged', async () => {
  const s = await standIns()
  try {
    const { code, output } = await refresh(s.url, SECRET)
    assert.equal(code, 0, output)
    assert.equal(s.asked.token.length, 1)
    assert.equal(s.asked.token[0].authorization, `Basic ${Buffer.from(`${env.CLIENT_ID}:${SECRET}`).toString('base64')}`)
    assert.deepEqual(Object.fromEntries(new URLSearchParams(s.asked.token[0].body)), { grant_type: 'client_credentials' })
    assert.deepEqual(s.asked.api.map((a) => a.method), ['GET', 'PUT'])
    assert.ok(s.asked.api.every((a) => a.authorization === 'Bearer the-service-account-token'))
    assert.equal(Buffer.from(s.secret.data.access_token, 'base64').toString(), TOKEN)
    assert.equal(s.secret.data.other, 'a2VwdA==')
    assert.match(output, /written: token valid until \d{4}-/)
    assert.ok(!output.includes(TOKEN) && !output.includes(SECRET), output)
  } finally {
    s.close()
  }
})

test('no client secret yet: exit 4, Pocket-ID never asked, nothing written', async () => {
  const s = await standIns()
  try {
    const { code, output } = await refresh(s.url, 'set-me')
    assert.equal(code, 4, output)
    assert.equal(s.asked.token.length, 0)
    assert.equal(s.asked.api.length, 0)
  } finally {
    s.close()
  }
})

test('the client refused: exit 1, nothing written', async () => {
  const s = await standIns({ tokenStatus: 401 })
  try {
    const { code, output } = await refresh(s.url, SECRET)
    assert.equal(code, 1, output)
    assert.match(output, /token refused: 401 invalid_client/)
    assert.equal(s.asked.api.length, 0)
  } finally {
    s.close()
  }
})

test('the Secret cannot be written: five attempts, then exit 2', async () => {
  const s = await standIns({ putStatus: 409 })
  try {
    const { code, output } = await refresh(s.url, SECRET)
    assert.equal(code, 2, output)
    assert.equal(s.asked.api.filter((a) => a.method === 'PUT').length, 5)
  } finally {
    s.close()
  }
})

test('a token that would not outlive two runs: written, and exit 3 says so', async () => {
  const s = await standIns({ expiresIn: 300 })
  try {
    const { code, output } = await refresh(s.url, SECRET)
    assert.equal(code, 3, output)
    assert.equal(Buffer.from(s.secret.data.access_token, 'base64').toString(), TOKEN)
    assert.match(output, /raise the client's access token duration/)
  } finally {
    s.close()
  }
})

test('the client the spec declares: its pinned id, and tokens that outlive two runs of the schedule', () => {
  assert.equal(client.id, env.CLIENT_ID)
  assert.equal(cronJob.spec.schedule, '*/5 * * * *')
  assert.ok(client.accessTokenDurationMinutes >= Number(env.MIN_LIFE_MINUTES), `${client.accessTokenDurationMinutes} min`)
  assert.ok(client.accessTokenDurationMinutes > 2 * 5, `${client.accessTokenDurationMinutes} min`)
})
