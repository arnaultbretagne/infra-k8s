// The agora-gateway's `vault` route, end to end (docs/specs/credentials.md on arnaultbretagne/agora, "The vault").
//
// The real agentgateway release binary (its sha256 checked) runs the configuration this repository deploys, as
// `kubectl kustomize apps/agora-gateway` renders it: only the files it reads, its ports and the vault Service's
// address are moved to local ones. Tokens are signed by Agora's own GrantSigner (packages/credentials at a pinned
// commit), with a signing key made for the test. A stand-in for obsidian-mcp — its twelve tools, its prompt, and
// a thirteenth tool the server could add — records every message and the Authorization it came with. The machine
// token is made for the test too: no real secret is used.
//
// Inputs (environment): AGORA_GRANTS, the path of Agora's packages/credentials/src/grants.ts; AGENTGATEWAY, the
// binary; KUBECTL, kubectl (default `kubectl`).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import forge from 'node-forge'
import { ProxyAgent } from 'undici'
import { parse, parseAllDocuments } from 'yaml'

const SHA256 = '496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d' // agentgateway-linux-amd64 v1.6.0
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const UPSTREAM = 'http://obsidian-mcp.obsidian.svc.cluster.local:4000/mcp'
const VAULT = 'https://vault.bretagne.dev'
const READ_TOOLS = ['read_note', 'search_content', 'search_properties', 'get_backlinks', 'list_properties', 'get_property_values']
const WRITE_TOOLS = ['create_note', 'update_note', 'delete_note', 'move_note', 'update_schema', 'clip_url']
const ADDED_TOOL = 'added_tool' // a tool the server could add: write only (spec, C42)
const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, ADDED_TOOL]
const PROMPT = 'clip-to-vault'
/** What a sandbox could send itself: it must never reach the server. */
const SANDBOX_AUTHORIZATION = 'Bearer forged-by-the-sandbox'

const sorted = (list) => [...list].sort()

async function freePort() {
  const server = createServer()
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address()
  await new Promise((ok) => server.close(ok))
  return port
}

/** The stand-in for obsidian-mcp: Streamable HTTP with sessions, every message recorded. */
async function startVault(port) {
  const seen = []
  const sessions = new Map()
  // Tokens the server no longer accepts, as Pocket-ID's would expire: 401, as obsidian-mcp answers.
  const refused = new Set()
  const app = express()
  app.use(express.json())
  app.all('/mcp', async (req, res) => {
    seen.push({ method: req.method, authorization: req.headers.authorization ?? null, rpc: req.body?.method ?? null, name: req.body?.params?.name ?? null, raw: JSON.stringify(req.headers) })
    if (refused.has(req.headers.authorization)) return res.status(401).json({ error: 'Invalid or expired token' })
    let transport = sessions.get(req.headers['mcp-session-id'])
    if (!transport) {
      if (req.method !== 'POST' || req.body?.method !== 'initialize') return res.status(404).json({ error: 'no session' })
      // As obsidian-mcp 0.4.0 does (mcp-server/src/index.ts, createSession): a DELETE ends the session.
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, transport), onsessionclosed: (id) => sessions.delete(id) })
      const server = new McpServer({ name: 'vault-mcp', version: '0.4.0' })
      for (const name of ALL_TOOLS) server.registerTool(name, { description: name }, async () => ({ content: [{ type: 'text', text: `ran ${name}` }] }))
      server.registerPrompt(PROMPT, { description: PROMPT }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'clip it' } }] }))
      await server.connect(transport)
    }
    await transport.handleRequest(req, res, req.body)
  })
  const http = await new Promise((ok) => { const s = app.listen(port, '127.0.0.1', () => ok(s)) })
  return { seen, refused, sessions, close: () => new Promise((ok) => { http.closeAllConnections(); http.close(ok) }) }
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

let ctx

before(async () => {
  const work = mkdtempSync(join(tmpdir(), 'vault-route-'))

  // The binary, as released.
  const binary = process.env.AGENTGATEWAY
  assert.ok(binary, 'AGENTGATEWAY: the agentgateway 1.6.0 binary')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), SHA256, 'agentgateway-linux-amd64 v1.6.0, as released')

  // The configuration this repository deploys.
  const rendered = execFileSync(process.env.KUBECTL ?? 'kubectl', ['kustomize', join(REPO, 'apps/agora-gateway')], { encoding: 'utf8' })
  const objects = parseAllDocuments(rendered).map((doc) => doc.toJS())
  // A generated ConfigMap's name carries its content's hash (apps/agora-gateway/kustomization.yaml): <name>-<hash>.
  const configMap = (name) => objects.find((o) => o.kind === 'ConfigMap' && new RegExp(`^${name}(-[a-z0-9]{10})?$`).test(o.metadata.name))
  let config = configMap('gateway-config').data['config.yaml']
  const parsed = parse(config)
  const internal = parsed.binds.find((bind) => bind.port === 443)
  const listener = internal.listeners[0]
  const jwt = listener.policies.jwtAuth
  const route = listener.routes.find((r) => r.name === 'vault')
  assert.ok(route, 'a route named vault')
  assert.deepEqual(route.hostnames, ['vault.bretagne.dev'])
  assert.equal(route.backends[0].mcp.targets[0].mcp.host, UPSTREAM, 'the vault Service, not the public address')
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
  const vaultDir = join(work, 'etc/vault')
  rmSync(vaultDir, { recursive: true, force: true })
  const machineToken = `machine-${randomUUID()}`
  writeSecretVolume(vaultDir, { access_token: machineToken })

  // Ports and the upstream, local.
  const [connectPort, readyPort, adminPort, vaultPort] = [await freePort(), await freePort(), await freePort(), await freePort()]
  const swap = (from, to) => {
    assert.ok(config.includes(from), `the rendered configuration has ${from}`)
    config = config.replace(from, to)
  }
  swap('- port: 3000', `- port: ${connectPort}`)
  swap('readinessAddr: 0.0.0.0:15021', `readinessAddr: 127.0.0.1:${readyPort}`)
  swap('adminAddr: 127.0.0.1:15000', `adminAddr: 127.0.0.1:${adminPort}`)
  swap(UPSTREAM, `http://127.0.0.1:${vaultPort}/mcp`)
  const configFile = join(work, 'config.yaml')
  writeFileSync(configFile, config)

  const vault = await startVault(vaultPort)
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
  ctx = { work, vault, gateway, log, signer, ca, connectPort, vaultDir, machineToken, tokens: [], privateKey, kid, jwt }
})

after(async () => {
  ctx?.gateway.kill()
  await ctx?.vault.close()
})

/** A sandbox: a token from Agora for these profiles, bound to `address`; CONNECT through the gateway, TLS to the vault. */
async function sandbox(profiles, { address = '127.0.0.1', authorization = SANDBOX_AUTHORIZATION, grants } = {}) {
  const token = grants ? handMade(grants, address) : (await ctx.signer.mint({ label: `agora test-${profiles.join('+') || 'none'}`, ttlSeconds: 600, profiles, address })).token
  ctx.tokens.push(token)
  const dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${ctx.connectPort}`, token: `Bearer ${token}`, requestTls: { ca: ctx.ca } })
  let session
  let id = 0
  const raw = async (method, path, body) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization }
    if (session) headers['mcp-session-id'] = session
    const response = await dispatcher.request({ origin: VAULT, path, method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.body.text()
    session = response.headers['mcp-session-id'] ?? session
    const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5)).join('') || text
    let json = null
    try { json = JSON.parse(data) } catch {}
    return { status: response.statusCode, json, text }
  }
  const rpc = (method, params) => raw('POST', '/mcp', { jsonrpc: '2.0', id: ++id, method, params })
  return {
    raw,
    rpc,
    async open() {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sandbox', version: '1' } })
      if (init.status === 200) await raw('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })
      return init
    },
    async tools() {
      const listed = await rpc('tools/list', {})
      assert.equal(listed.status, 200)
      return listed.json.result.tools.map((tool) => tool.name)
    },
    async prompts() {
      const listed = await rpc('prompts/list', {})
      assert.equal(listed.status, 200)
      return listed.json.result.prompts.map((prompt) => prompt.name)
    },
    call: (name) => rpc('tools/call', { name, arguments: {} }),
    prompt: (name) => rpc('prompts/get', { name }),
    close: () => dispatcher.close(),
  }
}

/** A token of the same form and key as GrantSigner's, for grants no profile compiles to. */
function handMade(grants, address) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const data = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: ctx.kid })}.${encode({ iss: ctx.jwt.issuer, aud: ctx.jwt.audiences[0], sub: 'agora test-hand-made', jti: randomUUID(), iat: now, exp: now + 600, ip: address, profiles: [], grants })}`
  return `${data}.${sign(null, Buffer.from(data), ctx.privateKey).toString('base64url')}`
}

const reached = (rpc, name) => ctx.vault.seen.filter((m) => m.rpc === rpc && m.name === name).length

function assertAllowed(result, what) {
  assert.equal(result.status, 200, `${what}: ${result.text}`)
  assert.equal(result.json.error, undefined, `${what}: ${result.text}`)
}

function assertRefusedByGateway(result, kind, name) {
  assert.equal(result.status, 400, `${kind} ${name}: ${result.text}`)
  assert.equal(result.json.error.code, -32602)
  assert.equal(result.json.error.message, `Unknown ${kind}: ${name}`)
}

/** Until the server has received nothing for 300 ms: the gateway closes its upstream sessions after it answers. */
async function quiet() {
  for (let count = -1; count !== ctx.vault.seen.length; ) {
    count = ctx.vault.seen.length
    await new Promise((ok) => setTimeout(ok, 300))
  }
}

async function assertForbidden(profiles, options, request = (s) => s.open()) {
  await quiet()
  const before = ctx.vault.seen.length
  const s = await sandbox(profiles, options)
  const result = await request(s)
  await s.close()
  assert.equal(result.status, 403, result.text)
  assert.match(result.text, /authorization failed/)
  await quiet()
  assert.deepEqual(ctx.vault.seen.slice(before).map((m) => [m.method, m.rpc]), [], 'the server sees nothing')
}

describe('the vault route on agentgateway 1.6.0', () => {
  it('vault:read lists and runs the six read tools only; writes, an added tool and the prompt are refused before the server', async () => {
    const s = await sandbox(['vault:read'])
    assertAllowed(await s.open(), 'initialize')
    assert.deepEqual(sorted(await s.tools()), sorted(READ_TOOLS))
    for (const tool of READ_TOOLS) assertAllowed(await s.call(tool), tool)
    for (const tool of [...WRITE_TOOLS, ADDED_TOOL]) {
      assertRefusedByGateway(await s.call(tool), 'tool', tool)
      assert.equal(reached('tools/call', tool), 0, `${tool} never reaches the server`)
    }
    assert.deepEqual(await s.prompts(), [])
    assertRefusedByGateway(await s.prompt(PROMPT), 'prompt', PROMPT)
    assert.equal(reached('prompts/get', PROMPT), 0)
    await s.close()
  })

  it('vault:write opens the whole server: every tool, the added one, and the prompt', async () => {
    const s = await sandbox(['vault:write'])
    assertAllowed(await s.open(), 'initialize')
    assert.deepEqual(sorted(await s.tools()), sorted(ALL_TOOLS))
    for (const tool of ALL_TOOLS) assertAllowed(await s.call(tool), tool)
    assert.deepEqual(await s.prompts(), [PROMPT])
    assertAllowed(await s.prompt(PROMPT), PROMPT)
    await s.close()
  })

  for (const profiles of [['vault:read', 'vault:write'], ['vault:write', 'vault:read']]) {
    it(`${profiles.join(' then ')} in one token: the grants add up, the prompt included (C46)`, async () => {
      const s = await sandbox(profiles)
      assertAllowed(await s.open(), 'initialize')
      assert.deepEqual(sorted(await s.tools()), sorted(ALL_TOOLS))
      for (const tool of ['clip_url', 'delete_note', 'read_note']) assertAllowed(await s.call(tool), tool)
      assert.deepEqual(await s.prompts(), [PROMPT])
      assertAllowed(await s.prompt(PROMPT), PROMPT)
      await s.close()
    })
  }

  it('without a vault grant: 403 from the gateway, with internet alone, anthropic alone, or no profile (C45)', async () => {
    await assertForbidden(['internet'])
    await assertForbidden(['anthropic'])
    await assertForbidden([])
  })

  it('a token used from another address than its own: 403 (C45)', async () => {
    await assertForbidden(['vault:write'], { address: '10.244.0.99' })
  })

  it('paths and methods the grant does not cover, and path tricks: 403, the server never reached', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }
    for (const path of ['/sse', '/health', '/.well-known/oauth-protected-resource', '/mcp/', '/mcp?x=1', '/./mcp', '/x/../mcp', '/x/%2e%2e/mcp', '/mcp%2f', '/%2fmcp']) {
      await assertForbidden(['vault:write'], {}, (s) => s.raw('POST', path, init))
    }
    for (const method of ['PUT', 'PATCH']) await assertForbidden(['vault:write'], {}, (s) => s.raw(method, '/mcp', init))
  })

  it('the route\'s own path-trick check: a vault grant with no path still cannot reach the server through a trick', async () => {
    // Every vault grant Agora signs is pinned to ^/mcp$, which already refuses these paths; this grant has no path,
    // so only the route's own check stands between them and the server.
    const grants = [{ host: 'vault.bretagne.dev', methods: ['GET', 'POST', 'DELETE'] }]
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }
    const control = await sandbox([], { grants })
    assertAllowed(await control.raw('POST', '/mcp', init), 'the same grant on /mcp')
    await control.close()
    for (const path of ['/./mcp', '/x/../mcp', '/x/%2e%2e/mcp', '/x/%2E%2E/mcp', '/mcp%2f', '/%2fmcp', '/mcp/.']) {
      await assertForbidden([], { grants }, (s) => s.raw('POST', path, init))
    }
  })

  it('the server receives the gateway\'s machine token only: never the sandbox\'s Authorization nor Agora\'s token', () => {
    assert.ok(ctx.vault.seen.length > 30, `${ctx.vault.seen.length} messages`)
    for (const message of ctx.vault.seen) {
      assert.equal(message.authorization, `Bearer ${ctx.machineToken}`)
      assert.ok(!message.raw.includes('forged-by-the-sandbox'))
      for (const token of ctx.tokens) assert.ok(!message.raw.includes(token.split('.')[2]), 'no execution token reaches the server')
    }
  })

  it('a session opened before the machine token rotates keeps working once the old token has expired', async () => {
    const s = await sandbox(['vault:read'])
    assertAllowed(await s.open(), 'initialize')
    assertAllowed(await s.call('read_note'), 'read_note before the rotation')
    const old = `Bearer ${ctx.machineToken}`
    const fresh = `machine-${randomUUID()}`
    writeSecretVolume(ctx.vaultDir, { access_token: fresh })
    ctx.machineToken = fresh
    // The gateway reloads the file within seconds, as the kubelet's swap is seen: wait until a new session has it.
    const deadline = Date.now() + 30_000
    for (;;) {
      const probe = await sandbox(['vault:read'])
      const mark = ctx.vault.seen.length
      assertAllowed(await probe.open(), 'initialize')
      await probe.close()
      if (ctx.vault.seen.slice(mark).every((m) => m.authorization === `Bearer ${fresh}`)) break
      if (Date.now() > deadline) assert.fail('the gateway never took the new token')
      await new Promise((ok) => setTimeout(ok, 500))
    }
    // The old token expires: the server refuses it from now on.
    ctx.vault.refused.add(old)
    const mark = ctx.vault.seen.length
    assertAllowed(await s.call('read_note'), 'read_note in the session opened before the rotation')
    assert.deepEqual(sorted(await s.tools()), sorted(READ_TOOLS), 'its tools, still filtered')
    assertRefusedByGateway(await s.call('create_note'), 'tool', 'create_note')
    const used = ctx.vault.seen.slice(mark).map((m) => m.authorization)
    assert.ok(used.length > 0 && used.every((a) => a === `Bearer ${fresh}`), `the server saw ${used}`)
    await s.close()
    assert.equal(ctx.gateway.exitCode, null, 'the same gateway process: no restart')
  })


  it('every upstream session the gateway opens, it closes: none left open on the server', async () => {
    await quiet()
    const opened = ctx.vault.seen.filter((m) => m.rpc === 'initialize').length
    const deleted = ctx.vault.seen.filter((m) => m.method === 'DELETE').length
    assert.ok(opened > 20, `${opened} sessions opened`)
    assert.equal(ctx.vault.sessions.size, 0, `${ctx.vault.sessions.size} of ${opened} sessions left open (${deleted} DELETE)`)
  })

  it('the gateway logs the route, the execution and the tool', () => {
    const lines = ctx.log.join('').split('\n')
    assert.ok(lines.some((l) => l.includes('route=default/vault') && l.includes('jwt.sub=agora test-vault:read') && l.includes('gen_ai.tool.name=read_note')))
  })
})
