// The agora-gateway's antigravity routes, end to end (docs/specs/credentials.md on arnaultbretagne/agora,
// "Antigravity", C71 and C72 as far as a stand-in for Google can take them): what reaches Google with the cluster's
// Google login, what reaches it without, and what never leaves.
//
// The real agentgateway release binary (its sha256 checked) runs the configuration this repository deploys, as
// `kubectl kustomize apps/agora-gateway` renders it: only the files it reads, its ports, and the backends of the
// routes under test are moved to local ones — each keeps its hostnames, matches and policies, and sends to a
// stand-in for Google that records the Authorization each request arrives with. Tokens are signed by Agora's own
// GrantSigner (packages/credentials at the commit that brought `antigravity`). No real secret.
//
// Inputs (environment): AGORA_GRANTS, the path of Agora's packages/credentials/src/grants.ts; AGENTGATEWAY, the
// binary; KUBECTL, kubectl (default `kubectl`).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
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
const LOGIN = 'ya29.the-cluster-login'
const ROTATED = 'ya29.the-next-one'
const SANDBOX = 'Bearer agora-placeholder'
// The routes moved to the stand-in: agy's two, and those this test reaches to show the others answer as before.
const MOVED = ['antigravity', 'antigravity-userinfo', 'anthropic', 'chatgpt', 'internet']

async function freePort() {
  const server = createServer()
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address()
  await new Promise((ok) => server.close(ok))
  return port
}

/** Google (and every other upstream), standing in: every request recorded with its Authorization; 200. */
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

// The configuration this repository deploys, and the Deployment that mounts its files.
const rendered = execFileSync(process.env.KUBECTL ?? 'kubectl', ['kustomize', join(REPO, 'apps/agora-gateway')], { encoding: 'utf8' })
const objects = parseAllDocuments(rendered).map((doc) => doc.toJS())
const configMap = (name) => objects.find((o) => o.kind === 'ConfigMap' && new RegExp(`^${name}(-[a-z0-9]{10})?$`).test(o.metadata.name))
const deployed = configMap('gateway-config').data['config.yaml']
const kid = JSON.parse(configMap('grants-jwks').data['jwks.json']).keys[0].kid
const deployment = objects.find((o) => o.kind === 'Deployment' && o.metadata.name === 'gateway')
const init = deployment.spec.template.spec.initContainers.find((c) => c.name === 'antigravity-login')
const { GrantSigner } = await import(process.env.AGORA_GRANTS ?? assert.fail("AGORA_GRANTS: Agora's packages/credentials/src/grants.ts"))

/**
 * The deployed configuration on the binary, its credential files written; `antigravity` the login's Secret:
 * 'token', 'empty' (the Secret as Flux creates it) or 'absent' (no Secret: the optional volume is an empty dir).
 * Then the Deployment's own init container, antigravity-login, run as deployed (its paths moved), before the gateway.
 */
async function startGateway(antigravity) {
  const work = mkdtempSync(join(tmpdir(), 'antigravity-routes-'))
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
  for (const file of new Set([...text.matchAll(new RegExp(`${root}[^ }\\n"']+`, 'g'))].map((m) => m[0]))) {
    if (file.startsWith(`${root}antigravity/`) || file.startsWith(`${root}antigravity-secret/`)) continue
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `stand-in:${file.slice(root.length)}`)
  }
  const volume = join(root, 'antigravity-secret')
  if (antigravity === 'token') writeSecretVolume(volume, { access_token: LOGIN })
  else if (antigravity === 'empty') writeSecretVolume(volume, { access_token: '' })
  else mkdirSync(volume, { recursive: true })
  mkdirSync(join(root, 'antigravity'), { recursive: true })
  const [command, ...args] = init.command.map((arg) => arg.replaceAll('/etc/agentgateway/', root))
  const initLog = execFileSync(command, args, { encoding: 'utf8' }).trim()
  const ca = makeCa(join(work, 'etc/ca'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(work, 'etc/jwks/jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] }))
  const keyFile = join(work, 'grants-key.pem')
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
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
      assert.fail(`the gateway (login ${antigravity}) is not ready:\n${log.join('').slice(-4000)}`)
    }
    await new Promise((ok) => setTimeout(ok, 200))
  }
  const signer = new GrantSigner({ proxy: `127.0.0.1:${connectPort}`, keyFile, keyId: kid, issuer: listener.policies.jwtAuth.issuer, audience: listener.policies.jwtAuth.audiences[0] })
  return {
    upstream, gateway, log, signer, ca, connectPort, volume, initLog,
    close: async () => { gateway.kill('SIGKILL'); await upstream.close(); rmSync(work, { recursive: true, force: true }) },
  }
}

/** A request from a sandbox holding a token for these profiles: CONNECT through the gateway, TLS to `host`. */
async function send(gw, profiles, { host, path, method = 'GET', address = '127.0.0.1' }) {
  const { token } = await gw.signer.mint({ label: `agora ${randomUUID()}`, ttlSeconds: 600, profiles, address })
  const dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${gw.connectPort}`, token: `Bearer ${token}`, requestTls: { ca: gw.ca } })
  const count = gw.upstream.seen.length
  try {
    let response
    try {
      response = await dispatcher.request({ origin: `https://${host}`, path, method, headers: { authorization: SANDBOX }, body: method === 'GET' || method === 'HEAD' ? undefined : '{}', signal: AbortSignal.timeout(10_000) })
      await response.body.text()
    } catch (error) {
      // A request the gateway never answers is a finding, not a hung run: said with what reached the stand-in.
      return { status: `no answer: ${error.code ?? error.name}`, authorization: gw.upstream.seen[count]?.authorization ?? null, reached: gw.upstream.seen.length > count }
    }
    const reached = gw.upstream.seen.slice(count)
    assert.ok(reached.length <= 1)
    return { status: response.statusCode, authorization: reached[0]?.authorization ?? null, reached: reached.length === 1 }
  } finally {
    await dispatcher.destroy()
  }
}

const CLOUDCODE = 'daily-cloudcode-pa.googleapis.com'
const WWW = 'www.googleapis.com'
const where = (c) => `${c.method ?? 'GET'} ${c.host}${c.path}`

describe('the antigravity routes on agentgateway 1.6.0, the login present (C71)', () => {
  let gw
  before(async () => { gw = await startGateway('token') })
  after(async () => { await gw?.close() })

  it('the deployment mounts the login optional, at the path both routes read', () => {
    const routes = parse(deployed).binds.find((b) => b.port === 443).listeners[0].routes
    const reading = routes.filter((r) => r.policies?.backendAuth?.key?.value?.file === '/etc/agentgateway/antigravity/access_token').map((r) => [r.name, r.hostnames])
    assert.deepEqual(reading, [['antigravity', [CLOUDCODE]], ['antigravity-userinfo', [WWW]]])
    const spec = deployment.spec.template.spec
    const mounts = Object.fromEntries(spec.containers[0].volumeMounts.map((m) => [m.name, m]))
    assert.deepEqual(mounts.antigravity, { name: 'antigravity', mountPath: '/etc/agentgateway/antigravity', readOnly: true })
    assert.deepEqual(mounts['antigravity-secret'], { name: 'antigravity-secret', mountPath: '/etc/agentgateway/antigravity-secret', readOnly: true })
    assert.deepEqual(spec.volumes.find((v) => v.name === 'antigravity').emptyDir, { medium: 'Memory', sizeLimit: '1Mi' })
    // The init container sees both volumes at the gateway's own paths, so the link it writes resolves the same there.
    assert.deepEqual(init.volumeMounts.map((m) => [m.name, m.mountPath]), [['antigravity', '/etc/agentgateway/antigravity'], ['antigravity-secret', '/etc/agentgateway/antigravity-secret']])
    assert.match(gw.initLog, /antigravity-token mounted/)
    const volume = spec.volumes.find((v) => v.name === 'antigravity-secret')
    assert.deepEqual(volume.secret, { secretName: 'antigravity-token', optional: true, defaultMode: 0o440, items: [{ key: 'access_token', path: 'access_token' }] })
    assert.deepEqual(routes.flatMap((r) => r.hostnames ?? []).filter((h) => /oauth2\.googleapis|play\.googleapis/.test(h)), [], 'no route for the token endpoint nor telemetry')
  })

  it("agy's requests leave with the cluster's login in place of the sandbox's placeholder", async () => {
    for (const c of [
      { host: CLOUDCODE, path: '/v1internal:loadCodeAssist', method: 'POST' },
      { host: CLOUDCODE, path: '/v1internal:streamGenerateContent?alt=sse', method: 'POST' },
      { host: CLOUDCODE, path: '/v1internal:fetchAvailableModels', method: 'POST' },
      { host: WWW, path: '/oauth2/v2/userinfo' },
    ]) {
      const r = await send(gw, ['antigravity'], c)
      assert.deepEqual([r.status, r.authorization], [200, `Bearer ${LOGIN}`], where(c))
    }
  })

  it('every other path, method and host is refused, never sent with the login, without `internet`', async () => {
    for (const c of [
      { host: CLOUDCODE, path: '/v1internal', method: 'POST' },
      { host: CLOUDCODE, path: '/v1internal:loadCodeAssist/x', method: 'POST' },
      { host: CLOUDCODE, path: '/v1/projects', method: 'GET' },
      { host: CLOUDCODE, path: '/v1internal:a%2fb', method: 'POST' },
      { host: CLOUDCODE, path: '/x/../v1internal:loadCodeAssist', method: 'POST' },
      { host: WWW, path: '/oauth2/v2/userinfo', method: 'POST' },
      { host: WWW, path: '/oauth2/v2/userinfo?alt=json' },
      { host: WWW, path: '/oauth2/v3/tokeninfo' },
      { host: WWW, path: '/drive/v3/files' },
      { host: 'oauth2.googleapis.com', path: '/token', method: 'POST' },
      { host: 'play.googleapis.com', path: '/log', method: 'POST' },
      { host: 'cloudcode-pa.googleapis.com', path: '/v1internal:loadCodeAssist', method: 'POST' },
      { host: 'generativelanguage.googleapis.com', path: '/v1beta/models' },
    ]) {
      const r = await send(gw, ['antigravity'], c)
      assert.deepEqual([r.status, r.reached], [403, false], where(c))
    }
  })

  it('with `internet` too: the other hosts and paths of Google leave as the sandbox sent them, never with the login', async () => {
    for (const c of [
      { host: WWW, path: '/drive/v3/about' },
      { host: WWW, path: '/oauth2/v2/userinfo', method: 'POST' },
      { host: 'oauth2.googleapis.com', path: '/token', method: 'POST' },
      { host: 'play.googleapis.com', path: '/log', method: 'POST' },
    ]) {
      const r = await send(gw, ['antigravity', 'internet'], c)
      assert.deepEqual([r.status, r.authorization], [200, SANDBOX], where(c))
    }
    // Paths of agy's routes that its grants do not cover stay refused: `internet` never opens a route of its own.
    for (const c of [{ host: CLOUDCODE, path: '/v1/projects' }, { host: WWW, path: '/oauth2/v2/userinfo?alt=json' }]) {
      const r = await send(gw, ['antigravity', 'internet'], c)
      assert.deepEqual([r.status, r.reached], [403, false], where(c))
    }
  })

  it('without `antigravity`, from another address: refused', async () => {
    for (const profiles of [[], ['anthropic'], ['chatgpt'], ['internet']]) {
      for (const c of [{ host: CLOUDCODE, path: '/v1internal:loadCodeAssist', method: 'POST' }, { host: WWW, path: '/oauth2/v2/userinfo' }]) {
        const r = await send(gw, profiles, c)
        // With `internet` alone the user info is the route's still: refused, not sent without the login either.
        assert.deepEqual([r.status, r.reached], [403, false], `${profiles.join(',') || 'none'}: ${where(c)}`)
      }
    }
    const r = await send(gw, ['antigravity'], { host: CLOUDCODE, path: '/v1internal:loadCodeAssist', method: 'POST', address: '10.9.9.9' })
    assert.deepEqual([r.status, r.reached], [403, false])
  })

  it('a new access token, swapped as the kubelet does, is the next request\'s, with no restart (C73)', async () => {
    writeSecretVolume(gw.volume, { access_token: ROTATED })
    const c = { host: CLOUDCODE, path: '/v1internal:loadCodeAssist', method: 'POST' }
    const deadline = Date.now() + 15_000
    let r
    do {
      r = await send(gw, ['antigravity'], c)
      if (r.authorization === `Bearer ${ROTATED}`) break
      await new Promise((ok) => setTimeout(ok, 250))
    } while (Date.now() < deadline)
    assert.deepEqual([r.status, r.authorization], [200, `Bearer ${ROTATED}`])
    assert.equal(gw.gateway.exitCode, null)
  })

  it('the access log names the route and the execution', () => {
    const lines = gw.log.join('').split('\n')
    for (const route of ['antigravity', 'antigravity-userinfo']) {
      assert.ok(lines.some((l) => (l.includes(`route=default/${route} `) || l.endsWith(`route=default/${route}`)) && l.includes('jwt.sub=agora ')), route)
    }
  })
})

// agentgateway 1.6.0 exits at start when a file a backendAuth reads is missing ('read resource file …: No such file or
// directory', seen on this test's first run). With antigravity-login, the routes never read the Secret's own file.
for (const state of ['empty', 'absent']) {
  describe(`the login ${state === 'empty' ? 'as Flux creates it, empty' : 'absent, no Secret at all'}: the gateway starts and the other routes answer as before`, () => {
    let gw
    before(async () => { gw = await startGateway(state) })
    after(async () => { await gw?.close() })

    it('anthropic, chatgpt, internet: as before', async () => {
      assert.match(gw.initLog, state === 'absent' ? /antigravity-token absent: an empty token in its place/ : /antigravity-token mounted/)
      const a = await send(gw, ['anthropic'], { host: 'api.anthropic.com', path: '/v1/messages', method: 'POST' })
      assert.deepEqual([a.status, a.authorization], [200, 'Bearer stand-in:credentials/anthropic'])
      const c = await send(gw, ['chatgpt'], { host: 'chatgpt.com', path: '/backend-api/codex/responses', method: 'POST' })
      assert.deepEqual([c.status, c.authorization], [200, 'Bearer stand-in:chatgpt/access_token'])
      const i = await send(gw, ['internet'], { host: 'example.com', path: '/' })
      assert.deepEqual([i.status, i.authorization], [200, SANDBOX])
    })

    it("agy's routes never send the sandbox's placeholder on", async () => {
      const r = await send(gw, ['antigravity'], { host: CLOUDCODE, path: '/v1internal:loadCodeAssist', method: 'POST' })
      console.log(`ℹ ${state}: ${r.status}, upstream reached: ${r.reached}, authorization: ${JSON.stringify(r.authorization)}`)
      assert.deepEqual([r.status, r.authorization], [200, 'Bearer'], 'an empty Bearer: Google answers 401, never the placeholder')
      assert.equal(gw.gateway.exitCode, null, 'the gateway still runs')
    })

    it(state === 'empty' ? 'the login filled in afterwards is used with no restart' : 'the Secret back: used after a restart of the gateway', async () => {
      if (state === 'absent') {
        // The fallback is fixed until the Pod restarts; then the init container links the Secret's file.
        await gw.close()
        gw = await startGateway('token')
        const r = await send(gw, ['antigravity'], { host: CLOUDCODE, path: '/v1internal:loadCodeAssist', method: 'POST' })
        assert.deepEqual([r.status, r.authorization], [200, `Bearer ${LOGIN}`])
        return
      }
      writeSecretVolume(gw.volume, { access_token: LOGIN })
      const deadline = Date.now() + 15_000
      let r
      do {
        r = await send(gw, ['antigravity'], { host: CLOUDCODE, path: '/v1internal:loadCodeAssist', method: 'POST' })
        if (r.authorization === `Bearer ${LOGIN}`) break
        await new Promise((ok) => setTimeout(ok, 250))
      } while (Date.now() < deadline)
      console.log(`ℹ ${state} then filled: ${r.status}, ${JSON.stringify(r.authorization)}`)
      assert.deepEqual([r.status, r.authorization], [200, `Bearer ${LOGIN}`])
    })
  })
}
