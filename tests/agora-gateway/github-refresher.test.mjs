// The GitHub tokens' refresher (apps/agora-gateway/github-refresher.yaml): its script, as the ConfigMap ships it,
// run against a stand-in GitHub API and a stand-in API server. For each App it signs a JWT with that App's key and
// buys an installation token; it buys a third, the contributor's narrowed to its public repositories with read
// permissions; it writes all three to github-tokens, each also as git's Basic credential, keeping the Secret's other
// keys, never logging a token; and it says why it stops: 4 a key missing, 1 refused, 2 unable to write, 3 a token
// too short. And the manifests hand the gateway every file its GitHub routes read.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse, parseAllDocuments } from 'yaml'

const ROOT = new URL('../../', import.meta.url).pathname
const read = (path) => parseAllDocuments(readFileSync(join(ROOT, path), 'utf8')).map((d) => d.toJS())
const manifests = read('apps/agora-gateway/github-refresher.yaml')
const script = manifests.find((m) => m.kind === 'ConfigMap' && m.metadata.name === 'github-refresher').data['refresh.mjs']
const cronJob = manifests.find((m) => m.kind === 'CronJob')
const pod = cronJob.spec.jobTemplate.spec.template.spec
const env = Object.fromEntries(pod.containers[0].env.map((e) => [e.name, e.value]))

const APPS = {
  contributor: { id: env.CONTRIBUTOR_APP_ID, installation: env.CONTRIBUTOR_INSTALLATION_ID, ...generateKeyPairSync('rsa', { modulusLength: 2048 }) },
  reviewer: { id: env.REVIEWER_APP_ID, installation: env.REVIEWER_INSTALLATION_ID, ...generateKeyPairSync('rsa', { modulusLength: 2048 }) },
}
const REPOSITORIES = [
  { id: 11, full_name: 'o/agora', private: false },
  { id: 12, full_name: 'o/lg-tv', private: true },
  { id: 13, full_name: 'o/infra', private: false },
]
const TOKEN = { contributor: 'ghs_contributor-token', reviewer: 'ghs_reviewer-token', public: 'ghs_public-token' }

/** The App a JWT names, its signature checked against that App's public key; null if it is not one of theirs. */
function appOf(authorization) {
  const [header, payload, signature] = String(authorization).replace(/^Bearer /, '').split('.')
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString() || '{}')
  const app = Object.entries(APPS).find(([, a]) => a.id === claims.iss)
  if (!app) return null
  const valid = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(app[1].publicKey, signature, 'base64url')
  return valid && claims.exp - claims.iat <= 600 && claims.iat <= Date.now() / 1000 ? app[0] : null
}

/** GitHub's API and the API server, standing in; what each was asked. Repositories listed two by page. */
async function standIns({ mintStatus = 201, lifeMs = 3_600_000, putStatus = 200 } = {}) {
  const asked = { github: [], api: [] }
  const secret = { metadata: { name: 'github-tokens', namespace: 'agora-gateway' }, data: { contributor: '', other: 'a2VwdA==' } }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      const url = new URL(req.url, 'http://x')
      if (url.pathname.startsWith('/github/')) {
        const path = url.pathname.slice('/github'.length)
        asked.github.push({ method: req.method, path, query: url.search, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null })
        const minted = /^\/app\/installations\/([0-9]+)\/access_tokens$/.exec(path)
        if (minted && req.method === 'POST') {
          const identity = appOf(req.headers.authorization)
          if (identity === null || APPS[identity].installation !== minted[1]) return json(401, { message: 'A JSON web token could not be decoded' })
          if (mintStatus !== 201) return json(mintStatus, { message: 'Bad credentials' })
          const narrowed = body !== '' && JSON.parse(body).repository_ids !== undefined
          return json(201, { token: narrowed ? TOKEN.public : TOKEN[identity], expires_at: new Date(Date.now() + lifeMs).toISOString().replace(/\.\d{3}Z$/, 'Z') })
        }
        if (path === '/installation/repositories' && req.headers.authorization === `Bearer ${TOKEN.contributor}`) {
          const page = Number(url.searchParams.get('page'))
          return json(200, { total_count: REPOSITORIES.length, repositories: REPOSITORIES.slice((page - 1) * 2, page * 2) })
        }
        return json(404, { message: 'Not Found' })
      }
      asked.api.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
      if (req.url !== '/api/v1/namespaces/agora-gateway/secrets/github-tokens') return res.writeHead(404).end()
      if (req.method === 'GET') return json(200, secret)
      if (putStatus !== 200) return res.writeHead(putStatus).end()
      Object.assign(secret, JSON.parse(body))
      return res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, asked, secret, close: () => server.close() }
}

/** The script as the CronJob runs it: its env, a ServiceAccount's files, the Apps' keys mounted (those given). */
async function refresh(base, identities = Object.keys(APPS)) {
  const dir = mkdtempSync(join(tmpdir(), 'github-refresher-'))
  writeFileSync(join(dir, 'refresh.mjs'), script)
  mkdirSync(join(dir, 'sa'))
  mkdirSync(join(dir, 'keys'))
  writeFileSync(join(dir, 'sa', 'namespace'), 'agora-gateway\n')
  writeFileSync(join(dir, 'sa', 'token'), 'the-service-account-token\n')
  for (const identity of identities) writeFileSync(join(dir, 'keys', `${identity}.pem`), APPS[identity].privateKey.export({ type: 'pkcs1', format: 'pem' }))
  const child = spawn(process.execPath, [join(dir, 'refresh.mjs')], {
    env: { ...process.env, ...env, GITHUB_API: `${base}/github`, KUBE_API: base, SA_DIR: join(dir, 'sa'), KEYS_DIR: join(dir, 'keys'), RETRY_MS: '1' },
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const code = await new Promise((resolve) => child.on('close', resolve))
  return { code, output }
}

const decoded = (secret, key) => Buffer.from(secret.data[key] ?? '', 'base64').toString()

test('three tokens bought with each App’s own key, written to github-tokens with git’s Basic form and the Secret’s other keys, never logged', async () => {
  const s = await standIns()
  try {
    const { code, output } = await refresh(s.url)
    assert.equal(code, 0, output)
    const mints = s.asked.github.filter((a) => a.path.endsWith('/access_tokens'))
    assert.deepEqual(mints.map((m) => [appOf(m.authorization), m.path]), [
      ['contributor', `/app/installations/${env.CONTRIBUTOR_INSTALLATION_ID}/access_tokens`],
      ['reviewer', `/app/installations/${env.REVIEWER_INSTALLATION_ID}/access_tokens`],
      ['contributor', `/app/installations/${env.CONTRIBUTOR_INSTALLATION_ID}/access_tokens`],
    ])
    // The public token: the contributor's public repositories only — every page read —, every permission a read.
    assert.deepEqual(mints[0].body, null)
    assert.deepEqual(mints[2].body.repository_ids, [11, 13])
    assert.ok(Object.values(mints[2].body.permissions).every((p) => p === 'read'), JSON.stringify(mints[2].body.permissions))
    assert.deepEqual(s.asked.github.filter((a) => a.path === '/installation/repositories').map((a) => a.query), ['?per_page=100&page=1', '?per_page=100&page=2'])
    for (const [identity, token] of Object.entries(TOKEN)) {
      assert.equal(decoded(s.secret, identity), token, identity)
      assert.equal(Buffer.from(decoded(s.secret, `${identity}-basic`), 'base64').toString(), `x-access-token:${token}`, `${identity}-basic`)
    }
    assert.equal(s.secret.data.other, 'a2VwdA==')
    assert.deepEqual(s.asked.api.map((a) => a.method), ['GET', 'PUT'])
    assert.ok(s.asked.api.every((a) => a.authorization === 'Bearer the-service-account-token'))
    assert.match(output, /written: contributor, reviewer and public \(2 public repositories\), valid until \d{4}-/)
    for (const token of Object.values(TOKEN)) assert.ok(!output.includes(token) && !output.includes(Buffer.from(`x-access-token:${token}`).toString('base64')), output)
  } finally {
    s.close()
  }
})

test('a key missing: exit 4, GitHub never asked, nothing written', async () => {
  for (const identities of [['contributor'], ['reviewer'], []]) {
    const s = await standIns()
    try {
      const { code, output } = await refresh(s.url, identities)
      assert.equal(code, 4, output)
      assert.match(output, /github-apps has no (contributor|reviewer)\.pem/)
      assert.equal(s.asked.github.length, 0)
      assert.equal(s.asked.api.length, 0)
    } finally {
      s.close()
    }
  }
})

test('GitHub refusing: exit 1, nothing written', async () => {
  const s = await standIns({ mintStatus: 401 })
  try {
    const { code, output } = await refresh(s.url)
    assert.equal(code, 1, output)
    assert.match(output, /minting: POST \/app\/installations\/[0-9]+\/access_tokens: 401 Bad credentials/)
    assert.equal(s.asked.api.length, 0)
  } finally {
    s.close()
  }
})

test('the Secret cannot be written: five attempts, then exit 2', async () => {
  const s = await standIns({ putStatus: 409 })
  try {
    const { code, output } = await refresh(s.url)
    assert.equal(code, 2, output)
    assert.equal(s.asked.api.filter((a) => a.method === 'PUT').length, 5)
  } finally {
    s.close()
  }
})

test('tokens that would not outlive two runs: written, and exit 3 says so', async () => {
  const s = await standIns({ lifeMs: 20 * 60_000 })
  try {
    const { code, output } = await refresh(s.url)
    assert.equal(code, 3, output)
    assert.equal(decoded(s.secret, 'reviewer'), TOKEN.reviewer)
    assert.match(output, /under 40 minutes from now/)
  } finally {
    s.close()
  }
})

test('the manifests: an hour’s token outlives two runs; the keys from github-apps alone; the gateway mounts every file its GitHub routes read', () => {
  assert.equal(cronJob.spec.schedule, '*/15 * * * *')
  assert.ok(Number(env.MIN_LIFE_MINUTES) > 2 * 15 && Number(env.MIN_LIFE_MINUTES) < 60, env.MIN_LIFE_MINUTES)
  for (const id of ['CONTRIBUTOR_APP_ID', 'CONTRIBUTOR_INSTALLATION_ID', 'REVIEWER_APP_ID', 'REVIEWER_INSTALLATION_ID']) assert.match(env[id], /^[0-9]+$/, id)
  const keys = pod.volumes.find((v) => v.name === 'keys').secret
  assert.equal(keys.secretName, 'github-apps')
  assert.deepEqual(keys.items.map((i) => i.path), ['contributor.pem', 'reviewer.pem'])
  const sealed = read('apps/agora-gateway/github-apps.secrets.yaml')[0]
  assert.deepEqual(Object.keys(sealed.stringData), ['contributor.pem', 'reviewer.pem'])
  assert.ok(Object.values(sealed.stringData).every((v) => v.startsWith('ENC[AES256_GCM,')), 'encrypted by sops')
  const tokens = manifests.find((m) => m.kind === 'Secret' && m.metadata.name === 'github-tokens')
  const gateway = read('apps/agora-gateway/gateway.yaml').find((m) => m.kind === 'Deployment').spec.template.spec
  const volume = gateway.volumes.find((v) => v.secret?.secretName === 'github-tokens')
  const mount = gateway.containers[0].volumeMounts.find((m) => m.name === volume.name).mountPath
  const config = parse(readFileSync(join(ROOT, 'apps/agora-gateway/config/config.yaml'), 'utf8'))
  // Every GitHub route but the operator's, which sets the operator's PAT for Agora's merge card alone.
  const files = config.binds[1].listeners[0].routes.filter((r) => r.name.startsWith('github-') && r.name !== 'github-api-operator').map((r) => r.policies.backendAuth.key.value.file)
  assert.deepEqual(files.sort(), Object.keys(tokens.data).map((k) => `${mount}/${k}`).sort(), 'one route per token the refresher writes')
  // The refresher alone mounts the keys; nothing in the gateway reads them.
  assert.ok(!JSON.stringify(gateway).includes('github-apps'))
})
