// The agora-gateway's `agora` route, end to end (docs/specs/credentials.md on arnaultbretagne/agora, "Agora's MCP";
// docs/specs/mcp.md).
//
// The real agentgateway release binary (its sha256 checked) runs the configuration this repository deploys, as
// `kubectl kustomize apps/agora-gateway` renders it: only the files it reads, its ports and the server's address are
// moved to local ones. Tokens are signed by Agora's own GrantSigner (packages/credentials at a pinned commit), with a
// signing key made for the test. A stand-in for Agora's port 8082 records every message and the caller the gateway
// named in it. No real secret is used.
//
// Inputs (environment): AGORA_GRANTS, the path of Agora's packages/credentials/src/grants.ts; AGENTGATEWAY, the
// binary; KUBECTL, kubectl (default `kubectl`).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import forge from 'node-forge'
import { ProxyAgent } from 'undici'
import { parse, parseAllDocuments } from 'yaml'

const SHA256 = '496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d' // agentgateway-linux-amd64 v1.6.0
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SERVER = 'server.agora.svc.cluster.local:8082'
const AGORA = 'https://mcp.agora.internal'

async function freePort() {
  const server = createServer()
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address()
  await new Promise((ok) => server.close(ok))
  return port
}

/** The stand-in for Agora's port 8082: every message recorded with the caller the gateway named; a JSON-RPC result. */
async function startAgora(port) {
  const seen = []
  const http = createHttpServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, execution: req.headers['x-agora-execution'] ?? null, authorization: req.headers.authorization ?? null })
      const id = JSON.parse(body || '{}').id ?? null
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }))
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
  const work = mkdtempSync(join(tmpdir(), 'agora-route-'))

  // The binary, as released.
  const binary = process.env.AGENTGATEWAY
  assert.ok(binary, 'AGENTGATEWAY: the agentgateway 1.6.0 binary')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), SHA256, 'agentgateway-linux-amd64 v1.6.0, as released')

  // The configuration this repository deploys.
  const rendered = execFileSync(process.env.KUBECTL ?? 'kubectl', ['kustomize', join(REPO, 'apps/agora-gateway')], { encoding: 'utf8' })
  const objects = parseAllDocuments(rendered).map((doc) => doc.toJS())
  const configMap = (name) => objects.find((o) => o.kind === 'ConfigMap' && new RegExp(`^${name}(-[a-z0-9]{10})?$`).test(o.metadata.name))
  let config = configMap('gateway-config').data['config.yaml']
  const listener = parse(config).binds.find((bind) => bind.port === 443).listeners[0]
  const jwt = listener.policies.jwtAuth
  const route = listener.routes.find((r) => r.name === 'agora')
  assert.ok(route, 'a route named agora')
  assert.deepEqual(route.hostnames, ['mcp.agora.internal'])
  assert.equal(route.backends[0].host, SERVER, 'the server’s Service, its port for the gateway')
  assert.equal(route.policies.backendAuth, undefined, 'no credential')
  const kid = JSON.parse(configMap('grants-jwks').data['jwks.json']).keys[0].kid

  // Agora's signer, with a key made for the test; the gateway trusts its public half under the deployed kid.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyFile = join(work, 'grants-key.pem')
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const { GrantSigner } = await import(process.env.AGORA_GRANTS ?? assert.fail('AGORA_GRANTS: Agora\'s packages/credentials/src/grants.ts'))

  // Every file the configuration reads, moved under the work directory.
  const root = join(work, 'etc') + '/'
  config = config.replaceAll('/etc/agentgateway/', root)
  for (const file of new Set([...config.matchAll(new RegExp(`${root}[^ }\\n]+`, 'g'))].map((m) => m[0]))) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'stand-in')
  }
  const ca = makeCa(join(work, 'etc/ca'))
  writeFileSync(join(work, 'etc/jwks/jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] }))

  // Ports and the server, local.
  const [connectPort, readyPort, adminPort, agoraPort] = [await freePort(), await freePort(), await freePort(), await freePort()]
  const swap = (from, to) => {
    assert.ok(config.includes(from), `the rendered configuration has ${from}`)
    config = config.replace(from, to)
  }
  swap('- port: 3000', `- port: ${connectPort}`)
  swap('readinessAddr: 0.0.0.0:15021', `readinessAddr: 127.0.0.1:${readyPort}`)
  swap('adminAddr: 127.0.0.1:15000', `adminAddr: 127.0.0.1:${adminPort}`)
  swap(SERVER, `127.0.0.1:${agoraPort}`)
  const configFile = join(work, 'config.yaml')
  writeFileSync(configFile, config)

  const agora = await startAgora(agoraPort)
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

  const signer = new GrantSigner({ proxy: `127.0.0.1:${connectPort}`, keyFile, keyId: kid, issuer: jwt.issuer, audience: jwt.audiences[0] })
  ctx = { agora, gateway, log, signer, ca, connectPort }
})

after(async () => {
  ctx?.gateway.kill()
  await ctx?.agora.close()
})

/** A message from a sandbox holding a token for these profiles, bound to `address`: CONNECT through the gateway, TLS to Agora's host. */
async function send(profiles, { address = '127.0.0.1', path = '/mcp', method = 'POST', headers = {} } = {}) {
  const label = `agora ${randomUUID()}`
  const { token } = await ctx.signer.mint({ label, ttlSeconds: 600, profiles, address })
  const dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${ctx.connectPort}`, token: `Bearer ${token}`, requestTls: { ca: ctx.ca } })
  try {
    const response = await dispatcher.request({
      origin: AGORA,
      path,
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) : undefined,
    })
    await response.body.text()
    return { label, status: response.statusCode }
  } finally {
    await dispatcher.close()
  }
}

describe('the agora route on agentgateway 1.6.0', () => {
  it('agora:read reaches Agora, named by the token’s own execution, whatever x-agora-execution the sandbox sent (M8)', async () => {
    const count = ctx.agora.seen.length
    const plain = await send(['agora:read'])
    const forged = await send(['agora:read'], { headers: { 'x-agora-execution': `agora ${randomUUID()}` } })
    assert.deepEqual([plain.status, forged.status], [200, 200], ctx.log.join(''))
    assert.deepEqual(
      ctx.agora.seen.slice(count).map((s) => [s.method, s.path, s.execution]),
      [
        ['POST', '/mcp', plain.label],
        ['POST', '/mcp', forged.label],
      ],
    )
  })

  it('without agora:read — internet alone, anthropic alone, no profile —, or from another address: 403, Agora never reached (M8)', async () => {
    const count = ctx.agora.seen.length
    for (const [profiles, options] of [[['internet'], {}], [['anthropic'], {}], [[], {}], [['agora:read'], { address: '10.244.9.9' }]]) {
      assert.equal((await send(profiles, options)).status, 403, `${profiles.join(',') || 'none'} ${JSON.stringify(options)}`)
    }
    assert.equal(ctx.agora.seen.length, count)
  })

  it('paths and methods the grant does not cover, and path tricks: 403, Agora never reached', async () => {
    const count = ctx.agora.seen.length
    for (const [path, method] of [['/mcp/', 'POST'], ['/mcp?x=1', 'POST'], ['/api/workstreams', 'GET'], ['/mcp/../api', 'POST'], ['/%2e%2e/api', 'POST'], ['/mcp', 'PUT']]) {
      assert.equal((await send(['agora:read'], { path, method })).status, 403, `${method} ${path}`)
    }
    assert.equal(ctx.agora.seen.length, count)
  })

  it('the gateway logs the route and the execution', () => {
    const lines = ctx.log.join('').split('\n')
    assert.ok(lines.some((l) => l.includes('route=default/agora') && l.includes('jwt.sub=agora ')), lines.filter((l) => l.includes('route=')).slice(-3).join('\n'))
  })
})
