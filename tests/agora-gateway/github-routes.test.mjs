// The agora-gateway's GitHub routes, end to end (docs/specs/credentials.md on arnaultbretagne/agora, "GitHub
// identities"): who acts on GitHub for each request — the contributor's App, the reviewer's, the public token, or
// nobody.
//
// The real agentgateway release binary (its sha256 checked) runs the configuration this repository deploys, as
// `kubectl kustomize apps/agora-gateway` renders it: only the files it reads, its ports, and the GitHub routes'
// backend are moved to local ones — each GitHub route keeps its hostnames, matches and policies, and sends to a
// stand-in for GitHub that records the credential each request arrives with. Tokens are signed by Agora's own
// GrantSigner (packages/credentials at a pinned commit), with a signing key made for the test. No real secret.
//
// Inputs (environment): AGORA_GRANTS, the path of Agora's packages/credentials/src/grants.ts; AGENTGATEWAY, the
// binary; KUBECTL, kubectl (default `kubectl`).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SignJWT } from 'jose'
import forge from 'node-forge'
import { ProxyAgent } from 'undici'
import { parse, parseAllDocuments, stringify } from 'yaml'

const SHA256 = '496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d' // agentgateway-linux-amd64 v1.6.0
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// What each credential file holds in the test: a name the stand-in can tell apart, as the refresher writes it.
const TOKENS = { contributor: 'ghs_contributor', reviewer: 'ghs_reviewer', public: 'ghs_public' }
const CREDENTIALS = {
  ...Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, v])),
  ...Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [`${k}-basic`, Buffer.from(`x-access-token:${v}`).toString('base64')])),
}

async function freePort() {
  const server = createServer()
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address()
  await new Promise((ok) => server.close(ok))
  return port
}

/** GitHub, standing in for both hosts: every request recorded with who it arrives as; 200. */
async function startGitHub(port) {
  const seen = []
  const who = (authorization = '') => {
    const bearer = /^Bearer (.*)$/.exec(authorization)?.[1]
    const basic = /^Basic (.*)$/.exec(authorization)?.[1]
    const token = bearer ?? (basic ? Buffer.from(basic, 'base64').toString().replace(/^x-access-token:/, '') : '')
    const name = Object.entries(TOKENS).find(([, t]) => t === token)?.[0] ?? `unknown:${authorization}`
    return basic ? `${name}-basic` : name
  }
  const http = createHttpServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ host: req.headers.host, method: req.method, path: req.url, as: who(req.headers.authorization), grantHeader: req.headers['x-gateway-grant'] ?? null })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise((ok) => http.listen(port, '127.0.0.1', ok))
  return { seen, close: () => new Promise((ok) => { http.closeAllConnections(); http.close(ok) }) }
}

/** The gateway CA the sandboxes trust, made for the test. */
function makeCa(dir) {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 3_600_000)
  cert.validity.notAfter = new Date(Date.now() + 86_400_000)
  const attrs = [{ name: 'commonName', value: 'Test gateway CA' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true }, { name: 'subjectKeyIdentifier' }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ca-cert.pem'), forge.pki.certificateToPem(cert))
  writeFileSync(join(dir, 'ca-key.pem'), forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey))))
  return readFileSync(join(dir, 'ca-cert.pem'))
}

let ctx

before(async () => {
  const work = mkdtempSync(join(tmpdir(), 'github-routes-'))

  const binary = process.env.AGENTGATEWAY
  assert.ok(binary, 'AGENTGATEWAY: the agentgateway 1.6.0 binary')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), SHA256, 'agentgateway-linux-amd64 v1.6.0, as released')

  // The configuration this repository deploys.
  const rendered = execFileSync(process.env.KUBECTL ?? 'kubectl', ['kustomize', join(REPO, 'apps/agora-gateway')], { encoding: 'utf8' })
  const objects = parseAllDocuments(rendered).map((doc) => doc.toJS())
  const configMap = (name) => objects.find((o) => o.kind === 'ConfigMap' && new RegExp(`^${name}(-[a-z0-9]{10})?$`).test(o.metadata.name))
  const deployed = configMap('gateway-config').data['config.yaml']
  assert.ok(!deployed.includes('/etc/agentgateway/credentials/github'), 'the operator’s PAT is on no route')
  const kid = JSON.parse(configMap('grants-jwks').data['jwks.json']).keys[0].kid

  // Ports, files, and the GitHub routes' backend, local; nothing else touched.
  const [connectPort, readyPort, adminPort, githubPort] = [await freePort(), await freePort(), await freePort(), await freePort()]
  const root = join(work, 'etc') + '/'
  const config = parse(deployed.replaceAll('/etc/agentgateway/', root))
  config.config.adminAddr = `127.0.0.1:${adminPort}`
  config.config.readinessAddr = `127.0.0.1:${readyPort}`
  config.binds[0].port = connectPort
  const listener = config.binds.find((bind) => bind.port === 443).listeners[0]
  const jwt = listener.policies.jwtAuth
  const github = listener.routes.filter((r) => r.name.startsWith('github-'))
  assert.deepEqual(github.map((r) => r.name), ['github-api', 'github-api-reviewer', 'github-git', 'github-git-reviewer', 'github-api-public', 'github-git-public'])
  for (const route of github) {
    assert.deepEqual(route.backends, [{ dynamic: {}, policies: { backendTLS: {} } }], `${route.name}: to GitHub itself`)
    route.backends = [{ host: `127.0.0.1:${githubPort}` }]
  }
  const text = stringify(config)
  for (const file of new Set([...text.matchAll(new RegExp(`${root}[^ }\\n"']+`, 'g'))].map((m) => m[0]))) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, file.startsWith(`${root}github/`) ? CREDENTIALS[file.slice(`${root}github/`.length)] : 'stand-in')
  }
  const ca = makeCa(join(work, 'etc/ca'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(work, 'etc/jwks/jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] }))
  const keyFile = join(work, 'grants-key.pem')
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const configFile = join(work, 'config.yaml')
  writeFileSync(configFile, text)

  const stand = await startGitHub(githubPort)
  const log = []
  const gateway = spawn(binary, ['-f', configFile], { stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', (chunk) => log.push(String(chunk)))
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${readyPort}/healthz/ready`)).ok) break
    } catch {}
    if (Date.now() > deadline || gateway.exitCode !== null) assert.fail(`the gateway is not ready:\n${log.join('')}`)
    await new Promise((ok) => setTimeout(ok, 200))
  }

  const { GrantSigner } = await import(process.env.AGORA_GRANTS ?? assert.fail('AGORA_GRANTS: Agora\'s packages/credentials/src/grants.ts'))
  const signer = new GrantSigner({ proxy: `127.0.0.1:${connectPort}`, keyFile, keyId: kid, issuer: jwt.issuer, audience: jwt.audiences[0] })
  /** A token of grants as given, signed as Agora signs: for the grants an older Agora wrote, with no identity. */
  const raw = (grants) =>
    new SignJWT({ ip: '127.0.0.1', grants })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
      .setIssuer(jwt.issuer)
      .setAudience(jwt.audiences[0])
      .setSubject(`agora ${randomUUID()}`)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(createPrivateKey(readFileSync(keyFile)))
  ctx = { stand, gateway, log, signer, raw, ca, connectPort }
})

after(async () => {
  ctx?.gateway.kill()
  await ctx?.stand.close()
})

/** A request from a sandbox holding a token for these profiles (or this raw token): CONNECT through the gateway, TLS to GitHub's host. */
async function send(profiles, { host = 'api.github.com', path, method = 'GET', headers = {}, token } = {}) {
  token ??= (await ctx.signer.mint({ label: `agora ${randomUUID()}`, ttlSeconds: 600, profiles, address: '127.0.0.1' })).token
  const dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${ctx.connectPort}`, token: `Bearer ${token}`, requestTls: { ca: ctx.ca } })
  const count = ctx.stand.seen.length
  try {
    const response = await dispatcher.request({ origin: `https://${host}`, path, method, headers: { authorization: 'Bearer sandbox-own', ...headers }, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' })
    await response.body.text()
    const reached = ctx.stand.seen.slice(count)
    assert.ok(reached.length <= 1)
    return { status: response.statusCode, as: reached[0]?.as ?? null, reached: reached[0] ?? null }
  } finally {
    await dispatcher.close()
  }
}

const A = 'octo/app'
const B = 'octo/infra'

describe('the GitHub routes on agentgateway 1.6.0 (C69)', () => {
  it('write: REST and git as the contributor; review: REST, clone and fetch as the reviewer, never a push', async () => {
    const cases = [
      [[`github:${A}:write`], { path: `/repos/${A}` }, 'contributor'],
      [[`github:${A}:write`], { path: `/repos/${A}/pulls`, method: 'POST' }, 'contributor'],
      [[`github:${A}:write`], { host: 'github.com', path: `/${A}.git/info/refs?service=git-receive-pack` }, 'contributor-basic'],
      [[`github:${A}:write`], { host: 'github.com', path: `/${A}.git/git-receive-pack`, method: 'POST' }, 'contributor-basic'],
      [[`github:${A}:read`], { path: `/repos/${A}/pulls/7` }, 'contributor'],
      [[`github:${B}:review`], { path: `/repos/${B}/pulls/3` }, 'reviewer'],
      [[`github:${B}:review`], { path: `/repos/${B}/pulls/3/reviews`, method: 'POST' }, 'reviewer'],
      [[`github:${B}:review`], { path: `/repos/${B}/issues/3/comments`, method: 'POST' }, 'reviewer'],
      [[`github:${B}:review`], { host: 'github.com', path: `/${B}.git/info/refs?service=git-upload-pack` }, 'reviewer-basic'],
      [[`github:${B}:review`], { host: 'github.com', path: `/${B}.git/git-upload-pack`, method: 'POST' }, 'reviewer-basic'],
      [[`github:${B}:review`], { host: 'github.com', path: `/${B}.git/info/refs?service=git-receive-pack` }, null],
      [[`github:${B}:review`], { path: '/graphql', method: 'POST' }, null],
      [[`github:${B}:review`], { path: `/repos/${A}` }, null],
    ]
    for (const [profiles, request, expected] of cases) {
      const { status, as } = await send(profiles, request)
      assert.deepEqual([status, as], expected === null ? [403, null] : [200, expected], `${profiles}: ${request.method ?? 'GET'} ${request.host ?? 'api.github.com'}${request.path}\n${ctx.log.slice(-3).join('')}`)
    }
  })

  it('both identities in one token: each repository its own; write and review on one repository, the contributor; read and review, the review as the reviewer', async () => {
    const cases = [
      [[`github:${A}:write`, `github:${B}:review`], { path: `/repos/${A}/pulls`, method: 'POST' }, 'contributor'],
      [[`github:${A}:write`, `github:${B}:review`], { path: `/repos/${B}/pulls/3/reviews`, method: 'POST' }, 'reviewer'],
      [[`github:${B}:review`, `github:${A}:write`], { host: 'github.com', path: `/${A}.git/git-receive-pack`, method: 'POST' }, 'contributor-basic'],
      [[`github:${A}:review`, `github:${A}:write`], { path: `/repos/${A}/pulls/7/reviews`, method: 'POST' }, 'contributor'],
      [[`github:${A}:read`, `github:${A}:review`], { path: `/repos/${A}` }, 'contributor'],
      [[`github:${A}:read`, `github:${A}:review`], { path: `/repos/${A}/pulls/7/reviews`, method: 'POST' }, 'reviewer'],
    ]
    for (const [profiles, request, expected] of cases) {
      const { status, as } = await send(profiles, request)
      assert.deepEqual([status, as], [200, expected], `${profiles}: ${request.method ?? 'GET'} ${request.path}`)
    }
  })

  it('internet: what no grant covers read with the public token, never a write or a push; without it, 403', async () => {
    const cases = [
      [['internet'], { path: '/repos/someone/else' }, 'public'],
      [['internet', `github:${B}:review`], { path: `/repos/${A}` }, 'public'],
      [['internet'], { host: 'github.com', path: '/someone/else.git/git-upload-pack', method: 'POST' }, 'public-basic'],
      [['internet'], { path: '/repos/someone/else', method: 'PATCH' }, null],
      [['internet', `github:${B}:review`], { host: 'github.com', path: `/${B}.git/info/refs?service=git-receive-pack` }, null],
      [['anthropic'], { path: '/repos/someone/else' }, null],
    ]
    for (const [profiles, request, expected] of cases) {
      const { status, as } = await send(profiles, request)
      assert.deepEqual([status, as], expected === null ? [403, null] : [200, expected], `${profiles}: ${request.method ?? 'GET'} ${request.path}`)
    }
  })

  it('x-gateway-grant sent by the sandbox changes nothing, and never reaches GitHub', async () => {
    const cases = [
      [[`github:${A}:write`], 'reviewer', { path: `/repos/${A}/pulls`, method: 'POST' }, 'contributor'],
      [[`github:${B}:review`], 'contributor', { path: `/repos/${B}/pulls/3/reviews`, method: 'POST' }, 'reviewer'],
      [[`github:${B}:review`], 'contributor', { host: 'github.com', path: `/${B}.git/git-receive-pack`, method: 'POST' }, null],
      [['internet'], 'contributor', { path: '/repos/someone/else', method: 'PATCH' }, null],
      [['internet'], 'reviewer', { path: '/repos/someone/else/pulls/1/reviews', method: 'POST' }, null],
    ]
    for (const [profiles, forged, request, expected] of cases) {
      const { status, as, reached } = await send(profiles, { ...request, headers: { 'x-gateway-grant': forged } })
      assert.deepEqual([status, as], expected === null ? [403, null] : [200, expected], `${profiles} forging ${forged}: ${request.method} ${request.path}`)
      if (reached) assert.equal(reached.grantHeader, null)
    }
  })

  it('a token from an older Agora, its grants naming no identity: the contributor, as before', async () => {
    const grants = [
      { host: 'api.github.com', path: `^/repos/octo/app(/[^?]*)?(\\?.*)?$` },
      { host: 'github.com', path: `^/octo/app(\\.git)?/(info/refs\\?service=git-(upload|receive)-pack|git-(upload|receive)-pack)$` },
    ]
    const token = await ctx.raw(grants)
    assert.deepEqual(await send(null, { token, path: `/repos/${A}/pulls`, method: 'POST' }).then((r) => [r.status, r.as]), [200, 'contributor'])
    assert.deepEqual(await send(null, { token, host: 'github.com', path: `/${A}.git/git-receive-pack`, method: 'POST' }).then((r) => [r.status, r.as]), [200, 'contributor-basic'])
  })

  it('a token used from another address: 403, GitHub never reached', async () => {
    const { token } = await ctx.signer.mint({ label: `agora ${randomUUID()}`, ttlSeconds: 600, profiles: [`github:${A}:write`, `github:${B}:review`, 'internet'], address: '10.244.9.9' })
    for (const path of [`/repos/${A}`, `/repos/${B}/pulls/3/reviews`, '/repos/someone/else']) {
      assert.deepEqual(await send(null, { token, path }).then((r) => [r.status, r.as]), [403, null], path)
    }
  })

  it('no request arrived with the sandbox’s own Authorization, or anything but the three tokens; the gateway logs each route', () => {
    assert.ok(ctx.stand.seen.length > 20)
    assert.ok(ctx.stand.seen.every((s) => !s.as.startsWith('unknown')), JSON.stringify(ctx.stand.seen.filter((s) => s.as.startsWith('unknown'))))
    const lines = ctx.log.join('').split('\n')
    for (const route of ['github-api', 'github-api-reviewer', 'github-git', 'github-git-reviewer', 'github-api-public', 'github-git-public']) {
      assert.ok(lines.some((l) => l.includes(`route=default/${route} `) || l.endsWith(`route=default/${route}`)), route)
    }
  })
})
