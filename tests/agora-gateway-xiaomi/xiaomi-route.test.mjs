// The agora-gateway's `xiaomi` route, end to end: Agora's server reads the operator's Xiaomi MiMo Token Plan consumption
// (`GET https://token-plan-ams.xiaomimimo.com/v1/platform/token_plan`) through the gateway, with a grant it signs for
// itself (`limits`, docs/specs/credentials.md on arnaultbretagne/agora, "Limits"); the gateway sets the `tp-` key.
// What reaches Xiaomi with the key, and what never leaves.
//
// The real agentgateway release binary (its sha256 checked) runs the configuration this repository deploys, as
// `kubectl kustomize apps/agora-gateway` renders it: only the files it reads, its ports, and the backends of the
// routes under test are moved to local ones — each keeps its hostnames, matches and policies, and sends to a
// stand-in that records the Authorization each request arrives with. No real secret.
//
// The tokens: signed here, EdDSA with a key made for the run, with the claims the gateway reads (iss, aud, exp, sub,
// jti, `ip`, `grants` of host / path / methods) — Agora's `limits` profile names this host only from its branch
// feat/xiaomi-limits on, so its GrantSigner on main cannot mint the grant; the gateway's rule is what is under test.
//
// Inputs (environment): AGENTGATEWAY, the binary; KUBECTL, kubectl (default `kubectl`).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import forge from 'node-forge'
import { ProxyAgent } from 'undici'
import { parse, parseAllDocuments, stringify } from 'yaml'

const SHA256 = '496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d' // agentgateway-linux-amd64 v1.6.0
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HOST = 'token-plan-ams.xiaomimimo.com'
const PATH = '/v1/platform/token_plan'
const KEY = 'tp-the-operators-key'
const ROTATED = 'tp-the-next-one'
const CALLER = 'Bearer the-callers-own'
// The grant Agora's server signs for itself, as limits.ts reads the endpoint: this host, this path exactly, GET.
const LIMITS = { host: HOST, path: `^${PATH}$`, methods: ['GET'] }
const INTERNET = { host: '*' }
// The routes moved to the stand-in: Xiaomi's, and those this test reaches to show the others answer as before.
const MOVED = ['xiaomi', 'zai', 'internet']

async function freePort() {
  const server = createServer()
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address()
  await new Promise((ok) => server.close(ok))
  return port
}

/** Xiaomi (and every other upstream), standing in: every request recorded with its Authorization; 200. */
async function startUpstream(port) {
  const seen = []
  const http = createHttpServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ host: req.headers.host, method: req.method, path: req.url, authorization: req.headers.authorization ?? null })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise((ok) => http.listen(port, '127.0.0.1', ok))
  return { seen, close: () => new Promise((ok) => { http.closeAllConnections(); http.close(ok) }) }
}

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

/** A Secret mounted the way the kubelet does it: files behind `..data`, swapped atomically on an update. */
function writeSecretVolume(dir, files) {
  mkdirSync(dir, { recursive: true })
  const version = `..${randomUUID()}`
  mkdirSync(join(dir, version))
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, version, name), value)
  symlinkSync(version, join(dir, '..data_tmp'))
  renameSync(join(dir, '..data_tmp'), join(dir, '..data'))
  for (const name of Object.keys(files)) {
    try { symlinkSync(join('..data', name), join(dir, name)) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
}

// The configuration this repository deploys, the Deployment that mounts its files, and the Secret they come from.
const rendered = execFileSync(process.env.KUBECTL ?? 'kubectl', ['kustomize', join(REPO, 'apps/agora-gateway')], { encoding: 'utf8' })
const objects = parseAllDocuments(rendered).map((doc) => doc.toJS())
const configMap = (name) => objects.find((o) => o.kind === 'ConfigMap' && new RegExp(`^${name}(-[a-z0-9]{10})?$`).test(o.metadata.name))
const deployed = configMap('gateway-config').data['config.yaml']
const kid = JSON.parse(configMap('grants-jwks').data['jwks.json']).keys[0].kid
const deployment = objects.find((o) => o.kind === 'Deployment' && o.metadata.name === 'gateway')
const upstreamCredentials = objects.find((o) => o.kind === 'Secret' && o.metadata.name === 'upstream-credentials')

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

/** The deployed configuration on the binary, its files written; `credentials/` mounted as the kubelet mounts it. */
async function startGateway() {
  const work = mkdtempSync(join(tmpdir(), 'xiaomi-route-'))
  const binary = process.env.AGENTGATEWAY
  assert.ok(binary, 'AGENTGATEWAY: the agentgateway 1.6.0 binary')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), SHA256, 'agentgateway-linux-amd64 v1.6.0, as released')

  const [connectPort, readyPort, adminPort, upstreamPort] = [await freePort(), await freePort(), await freePort(), await freePort()]
  const root = join(work, 'etc') + '/'
  const config = parse(deployed.replaceAll('/etc/agentgateway/', root))
  config.config.adminAddr = `127.0.0.1:${adminPort}`
  config.config.readinessAddr = `127.0.0.1:${readyPort}`
  config.binds[0].port = connectPort
  const listener = config.binds.find((bind) => bind.port === 443).listeners[0]
  for (const name of MOVED) {
    const route = listener.routes.find((r) => r.name === name)
    assert.ok(route, `route ${name}`)
    assert.deepEqual(route.backends, [{ dynamic: {}, policies: { backendTLS: {} } }], `${name}: to the host itself`)
    route.backends = [{ host: `127.0.0.1:${upstreamPort}` }]
  }
  const text = stringify(config)
  const credentials = {}
  for (const file of new Set([...text.matchAll(new RegExp(`${root}[^ }\\n"']+`, 'g'))].map((m) => m[0]))) {
    const name = file.slice(root.length)
    if (name.startsWith('credentials/')) { credentials[name.slice('credentials/'.length)] = name === 'credentials/xiaomi' ? KEY : `stand-in:${name}`; continue }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `stand-in:${name}`)
  }
  const volume = join(root, 'credentials')
  writeSecretVolume(volume, credentials)
  const ca = makeCa(join(work, 'etc/ca'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(work, 'etc/jwks/jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] }))
  const configFile = join(work, 'config.yaml')
  writeFileSync(configFile, text)

  const upstream = await startUpstream(upstreamPort)
  const log = []
  const gateway = spawn(binary, ['-f', configFile], { stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', (chunk) => log.push(String(chunk)))
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${readyPort}/healthz/ready`)).ok) break
    } catch {}
    if (Date.now() > deadline || gateway.exitCode !== null) {
      // Never left running: a live child would hold the test run open.
      gateway.kill('SIGKILL')
      await upstream.close()
      assert.fail(`the gateway is not ready:\n${log.join('').slice(-4000)}`)
    }
    await new Promise((ok) => setTimeout(ok, 200))
  }
  const { issuer, audiences: [audience] } = listener.policies.jwtAuth
  /** A JWT as Agora signs one: these grants, bound to `address`. */
  const mint = (grants, address) => {
    const now = Math.floor(Date.now() / 1000)
    const head = b64url({ alg: 'EdDSA', typ: 'JWT', kid })
    const body = b64url({ iss: issuer, aud: audience, sub: `agora ${randomUUID()}`, jti: randomUUID(), iat: now, exp: now + 600, ip: address, grants })
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
  }
  return {
    upstream, gateway, log, mint, ca, connectPort, credentials, volume,
    close: async () => { gateway.kill('SIGKILL'); await upstream.close(); rmSync(work, { recursive: true, force: true }) },
  }
}

/** A request holding a token for these grants: CONNECT through the gateway, TLS to `host`. */
async function send(gw, grants, { host = HOST, path = PATH, method = 'GET', address = '127.0.0.1' } = {}) {
  const token = gw.mint(grants, address)
  const dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${gw.connectPort}`, token: `Bearer ${token}`, requestTls: { ca: gw.ca } })
  const count = gw.upstream.seen.length
  try {
    let response
    try {
      response = await dispatcher.request({ origin: `https://${host}`, path, method, headers: { authorization: CALLER }, body: method === 'GET' || method === 'HEAD' ? undefined : '{}', signal: AbortSignal.timeout(10_000) })
      await response.body.text()
    } catch (error) {
      // A request the gateway never answers is a finding, not a hung run: said with what reached the stand-in.
      return { status: `no answer: ${error.code ?? error.name}`, authorization: gw.upstream.seen[count]?.authorization ?? null, reached: gw.upstream.seen.length > count }
    }
    const reached = gw.upstream.seen.slice(count)
    assert.ok(reached.length <= 1)
    return { status: response.statusCode, authorization: reached[0]?.authorization ?? null, reached: reached.length === 1, path: reached[0]?.path }
  } finally {
    await dispatcher.destroy()
  }
}

const where = (c) => `${c.method ?? 'GET'} ${c.host ?? HOST}${c.path ?? PATH}`

describe('the xiaomi route on agentgateway 1.6.0', () => {
  let gw
  before(async () => { gw = await startGateway() })
  after(async () => { await gw?.close() })

  it('reads the `xiaomi` key of upstream-credentials, the Secret the Deployment mounts whole at credentials/', () => {
    const routes = parse(deployed).binds.find((b) => b.port === 443).listeners[0].routes
    const reading = routes.filter((r) => r.policies?.backendAuth?.key?.value?.file === '/etc/agentgateway/credentials/xiaomi').map((r) => [r.name, r.hostnames, r.policies.backendAuth.key.location])
    assert.deepEqual(reading, [['xiaomi', [HOST], { header: { name: 'authorization', prefix: 'Bearer ' } }]])
    // Its rule is the credentialed routes' own, character for character.
    const rule = (name) => routes.find((r) => r.name === name).policies.authorization.rules
    assert.deepEqual(rule('xiaomi'), rule('zai'))
    assert.deepEqual(rule('xiaomi'), rule('antigravity'))
    // agentgateway 1.6.0 does not start on a missing backendAuth file: the key must be in the Secret, and the Secret
    // mounted without `items`, so every one of its keys is a file.
    assert.ok(upstreamCredentials, 'upstream-credentials is rendered')
    assert.ok(Object.hasOwn(upstreamCredentials.stringData ?? {}, 'xiaomi'), 'upstream-credentials has stringData.xiaomi')
    const spec = deployment.spec.template.spec
    assert.deepEqual(spec.containers[0].volumeMounts.find((m) => m.name === 'credentials'), { name: 'credentials', mountPath: '/etc/agentgateway/credentials', readOnly: true })
    assert.deepEqual(spec.volumes.find((v) => v.name === 'credentials').secret, { secretName: 'upstream-credentials', defaultMode: 0o440 })
  })

  it('a grant covering `GET /v1/platform/token_plan`: sent on with the key, in place of the caller\'s Authorization', async () => {
    for (const grants of [[LIMITS], [{ host: 'api.z.ai' }, LIMITS], [{ host: HOST }], [LIMITS, INTERNET]]) {
      const r = await send(gw, grants)
      assert.deepEqual([r.status, r.authorization, r.path], [200, `Bearer ${KEY}`, PATH], JSON.stringify(grants))
    }
  })

  it('every other path, method and query, and path tricks: refused 403, never sent on', async () => {
    for (const c of [
      { method: 'POST' },
      { method: 'DELETE' },
      { path: `${PATH}?x=1` },
      { path: `${PATH}/x` },
      { path: '/v1/platform/token_plans' },
      { path: '/v1/chat/completions', method: 'POST' },
      { path: '/anthropic/v1/messages', method: 'POST' },
      { path: '/v1/platform%2ftoken_plan' },
      { path: '/v1/platform/x/../token_plan' },
      { path: '/v1/x/../platform/token_plan' },
      { path: '/v1/platform/%2e%2e/platform/token_plan' },
      { path: '/' },
    ]) {
      const r = await send(gw, [LIMITS], c)
      assert.deepEqual([r.status, r.reached], [403, false], where(c))
    }
  })

  it('without a grant on the host, `internet` included: refused 403, never sent on — with the key or without', async () => {
    for (const grants of [[], [{ host: 'api.z.ai' }], [INTERNET], [{ ...LIMITS, host: 'token-plan-sgp.xiaomimimo.com' }], [{ ...LIMITS, methods: ['POST'] }], [{ ...LIMITS, path: '^/v1/platform/other$' }]]) {
      const r = await send(gw, grants)
      assert.deepEqual([r.status, r.reached], [403, false], JSON.stringify(grants))
    }
  })

  it('a token used from another address than the one it is bound to: refused 403, never sent on', async () => {
    const r = await send(gw, [LIMITS], { address: '10.244.9.9' })
    assert.deepEqual([r.status, r.reached], [403, false])
  })

  it('the other routes answer as before: zai with its own key, internet as the caller sent it', async () => {
    const z = await send(gw, [{ host: 'api.z.ai' }], { host: 'api.z.ai', path: '/api/paas/v4/chat/completions', method: 'POST' })
    assert.deepEqual([z.status, z.authorization], [200, 'Bearer stand-in:credentials/zai'])
    const i = await send(gw, [INTERNET], { host: 'example.com', path: '/' })
    assert.deepEqual([i.status, i.authorization], [200, CALLER])
  })

  it('a new key, swapped as the kubelet does, is the next request\'s, with no restart', async () => {
    writeSecretVolume(gw.volume, { ...gw.credentials, xiaomi: ROTATED })
    const deadline = Date.now() + 15_000
    let r
    do {
      r = await send(gw, [LIMITS])
      if (r.authorization === `Bearer ${ROTATED}`) break
      await new Promise((ok) => setTimeout(ok, 250))
    } while (Date.now() < deadline)
    assert.deepEqual([r.status, r.authorization], [200, `Bearer ${ROTATED}`])
    assert.equal(gw.gateway.exitCode, null)
  })

  it('the access log names the route and the execution, never the key', () => {
    const text = gw.log.join('')
    const lines = text.split('\n')
    assert.ok(lines.some((l) => (l.includes('route=default/xiaomi ') || l.endsWith('route=default/xiaomi')) && l.includes('jwt.sub=agora ')), 'route=default/xiaomi, jwt.sub')
    assert.ok(!text.includes(KEY) && !text.includes(ROTATED), 'no key in the log')
  })
})
