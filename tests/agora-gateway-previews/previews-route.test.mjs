// The agora-gateway's `previews` route and the previews' gateway gate, end to end (docs/specs/credentials.md on
// arnaultbretagne/agora, "Previews"; infra-k8s ADR 0017, amendment 2026-10-27).
//
// kind, with Traefik (the chart and values of infrastructure/gateway) and this repository's Gateway `bretagne-gateway`.
// One preview, rendered from infrastructure/configs/previews/resourceset.yaml by flux-operator (the cluster's
// version), its gates applied as rendered — the browser gate and the gateway gate, both the real oauth2-proxy of the
// template — and its HTTPRoute. One change only: the gates' OIDC issuer is a stand-in in the cluster (no Pocket-ID
// here), which signs tokens shaped as Pocket-ID 2.18.0's. The preview's app is a test app that answers with what it
// received. On the runner: the real agentgateway release binary on the gateway-config this repository renders, tokens
// from Agora's GrantSigner carried by Agora's bridge (a pinned commit of the contract's branch). The preview's name
// resolves to kind's Traefik (an /etc/hosts entry), as it resolves to the node in the cluster.
//
// Inputs (environment): AGENTGATEWAY, FLUX_OPERATOR, KUBECTL, AGORA_SRC (Agora's packages), BASE_RESOURCESET (the
// template on the base branch, to show the browser gate unchanged), MUTATE (`route` or `gate`, broken on purpose).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import forge from 'node-forge'
import { Agent, ProxyAgent } from 'undici'
import { parse, parseAllDocuments, stringify } from 'yaml'

const SHA256 = '496ed27e6a96b55a9ad7cabe5c2be7172511f44a3cb113e533d22bf93a7f079d' // agentgateway-linux-amd64 v1.6.0
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const KUBECTL = process.env.KUBECTL ?? 'kubectl'
const MUTATE = process.env.MUTATE ?? ''
const APP = 'preview-demo'
const PR = '42'
const P = `${APP}-pr${PR}`
const NS = `pv-${P}`
const HOST = `pr-${PR}-${APP}.preview.bretagne.dev`
const ISSUER = 'http://issuer.e2e-idp.svc.cluster.local:8080'
const NODE_IMAGE = 'node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'
const SANDBOX_AUTHORIZATION = 'Bearer forged-by-the-sandbox'

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const admin = (args, input) => execFileSync(KUBECTL, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 })
const apply = (objects) => admin(['apply', '-f', '-'], objects.map((o) => stringify(o)).join('---\n'))

async function freePort() {
  const server = createServer()
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address()
  await new Promise((ok) => server.close(ok))
  return port
}

/** A CA, and optionally a server certificate it signs for `names`. */
function makeCa(cn) {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 3_600_000)
  cert.validity.notAfter = new Date(Date.now() + 86_400_000)
  cert.setSubject([{ name: 'commonName', value: cn }])
  cert.setIssuer([{ name: 'commonName', value: cn }])
  cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true }, { name: 'subjectKeyIdentifier' }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const ca = { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey))) }
  ca.issue = (names) => {
    const k = forge.pki.rsa.generateKeyPair(2048)
    const c = forge.pki.createCertificate()
    c.publicKey = k.publicKey
    c.serialNumber = '02'
    c.validity.notBefore = new Date(Date.now() - 3_600_000)
    c.validity.notAfter = new Date(Date.now() + 86_400_000)
    c.setSubject([{ name: 'commonName', value: names[0] }])
    c.setIssuer(cert.subject.attributes)
    c.setExtensions([{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }, { name: 'extKeyUsage', serverAuth: true }])
    c.sign(keys.privateKey, forge.md.sha256.create())
    return { cert: forge.pki.certificateToPem(c), key: forge.pki.privateKeyToPem(k.privateKey) }
  }
  return ca
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

/** The ResourceSet rendered by flux-operator for one preview of the catalogue entry, as the cluster renders it. */
function render(resourceset) {
  const provider = parse(readFileSync(join(REPO, `infrastructure/configs/previews/catalogue/${APP}.yaml`), 'utf8'))
  const inputs = [{ ...provider.spec.defaultValues, id: PR, sha: '0123456789abcdef0123456789abcdef01234567', branch: 'feat/x', author: 'someone', title: 'a change' }]
  const dir = mkdtempSync(join(tmpdir(), 'rset-'))
  writeFileSync(join(dir, 'inputs.yaml'), stringify(inputs))
  const out = execFileSync(process.env.FLUX_OPERATOR ?? 'flux-operator', ['build', 'rset', '-f', resourceset, '--inputs-from', join(dir, 'inputs.yaml')], { encoding: 'utf8' })
  return parseAllDocuments(out).map((d) => d.toJS()).filter(Boolean)
}

const SPEC = JSON.parse(readFileSync(join(REPO, 'apps/pocket-id/oidc-reconciler/spec.json'), 'utf8'))
const CLIENT = SPEC.clients.find((c) => c.name === 'agora_gateway_previews')
const IDENTITY = `client-${CLIENT.id}`

let ctx

before(async () => {
  const work = mkdtempSync(join(tmpdir(), 'previews-route-'))
  const binary = process.env.AGENTGATEWAY
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), SHA256, 'agentgateway-linux-amd64 v1.6.0, as released')

  // The stand-in issuer's key, and tokens shaped as Pocket-ID 2.18.0 issues a client-credentials token.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  // A key id of its own per run: the gates fetch the new key instead of trusting a cached one under the same id.
  const issuerKid = `e2e-${randomUUID()}`
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: issuerKid, alg: 'RS256', use: 'sig' }] }
  const mint = (claims, seconds = 900) => {
    const now = Math.floor(Date.now() / 1000)
    const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const data = `${enc({ alg: 'RS256', typ: 'JWT', kid: issuerKid })}.${enc({ iss: ISSUER, iat: now, exp: now + seconds, jti: randomUUID(), scp: [], ...claims })}`
    return `${data}.${sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`
  }
  const gatewayToken = () => mint({ sub: IDENTITY, aud: [CLIENT.id] })

  // In the cluster: the stand-in issuer, and the preview's app.
  const issuerScript = `const http = require('node:http'); const jwks = ${JSON.stringify(JSON.stringify(jwks))}; const url = ${JSON.stringify(ISSUER)}
http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (req.url === '/.well-known/openid-configuration') return json({ issuer: url, authorization_endpoint: url + '/authorize', token_endpoint: url + '/api/oidc/token', userinfo_endpoint: url + '/api/oidc/userinfo', jwks_uri: url + '/.well-known/jwks.json', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] })
  if (req.url === '/.well-known/jwks.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(jwks) }
  res.writeHead(404); res.end()
}).listen(8080)`
  const appScript = `const http = require('node:http')
http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    console.log(JSON.stringify({ seen: true, method: req.method, url: req.url, headers: req.headers }))
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first part\\n'); return setTimeout(() => res.end('second part\\n'), 4000) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
  })
}).listen(8080)`
  const restricted = { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } }
  const node = (name, namespace, script, annotations = {}) => [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace }, data: { 'main.js': script } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace }, spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name }, annotations }, spec: { automountServiceAccountToken: false, containers: [{ name, image: NODE_IMAGE, command: ['node', '/app/main.js'], ports: [{ containerPort: 8080 }], securityContext: restricted, resources: { requests: { cpu: '10m', memory: '64Mi' }, limits: { memory: '128Mi' } }, volumeMounts: [{ name: 'app', mountPath: '/app' }] }], volumes: [{ name: 'app', configMap: { name } }] } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace }, spec: { selector: { app: name }, ports: [{ port: 8080, targetPort: 8080 }] } },
  ]

  // The preview, as this repository's template renders it.
  const rendered = render(join(REPO, 'infrastructure/configs/previews/resourceset.yaml'))
  // Applied as rendered (a copy: `rendered` stays the template's output, compared below with the base branch's).
  const keep = structuredClone(rendered.filter((o) => ['Namespace', 'ResourceQuota', 'LimitRange', 'Deployment', 'Service', 'HTTPRoute'].includes(o.kind)))
  const gates = keep.filter((o) => o.kind === 'Deployment')
  assert.deepEqual(gates.map((g) => g.metadata.name).sort(), [`${P}-gate`, `${P}-gateway-gate`])
  for (const g of gates) {
    const env = g.spec.template.spec.containers[0].env
    const issuer = env.find((e) => e.name === 'OAUTH2_PROXY_OIDC_ISSUER_URL')
    assert.equal(issuer.value, 'https://id.bretagne.dev')
    issuer.value = ISSUER // the one change: the stand-in issuer
    if (MUTATE === 'gate' && g.metadata.name === `${P}-gateway-gate`) {
      // Broken open: no identities file, any identity whose token carries the client's audience.
      g.spec.template.spec.containers[0].env = env.filter((e) => e.name !== 'OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE').concat([{ name: 'OAUTH2_PROXY_EMAIL_DOMAINS', value: '*' }, { name: 'OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL', value: 'true' }])
    }
  }
  const previews = parseAllDocuments(admin(['kustomize', join(REPO, 'infrastructure/configs/previews')])).map((d) => d.toJS()).filter(Boolean)
  const systemNs = previews.find((o) => o.kind === 'Namespace' && o.metadata.name === 'preview-system')
  const identities = previews.find((o) => o.kind === 'ConfigMap' && o.metadata.name === 'preview-gateway-identities')
  assert.equal(identities.data['gateway-identities'].trim(), IDENTITY, 'the ConfigMap names client-<id> alone')
  // The cluster's PriorityClasses (infrastructure/configs/priorityclasses): the gates run at bretagne-low.
  apply(parseAllDocuments(readFileSync(join(REPO, 'infrastructure/configs/priorityclasses/priorityclasses.yaml'), 'utf8')).map((d) => d.toJS()).filter((o) => o?.kind === 'PriorityClass'))
  apply([systemNs, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'e2e-idp' } }])
  apply([identities, { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'preview-gate', namespace: 'preview-system' }, stringData: { OAUTH2_PROXY_CLIENT_ID: 'preview', OAUTH2_PROXY_CLIENT_SECRET: 'browser-secret', OAUTH2_PROXY_COOKIE_SECRET: randomBytes(16).toString('hex') } }])
  // The key's id on the Pod template: a new key per run rolls the issuer, which reads its script at start.
  apply([...node('issuer', 'e2e-idp', issuerScript, { 'e2e/kid': issuerKid })])
  apply(keep.filter((o) => o.kind === 'Namespace'))
  apply(keep.filter((o) => o.kind !== 'Namespace'))
  apply(node(APP, NS, appScript))
  for (const [ns, name] of [['e2e-idp', 'issuer'], [NS, APP], ['preview-system', `${P}-gate`], ['preview-system', `${P}-gateway-gate`]]) {
    try {
      admin(['-n', ns, 'rollout', 'status', `deployment/${name}`, '--timeout=240s'])
    } catch (error) {
      let why = ''
      try { why = admin(['-n', ns, 'describe', `deployment/${name}`]) + admin(['-n', ns, 'get', 'events', '--sort-by=.lastTimestamp']) + admin(['-n', ns, 'logs', `deployment/${name}`, '--tail=40']) } catch (e) { why += String(e.stderr ?? e) }
      assert.fail(`${ns}/${name} did not roll out:\n${why}`)
    }
  }

  // This repository's Gateway (infrastructure/gateway), its https-preview listener among the others.
  const gatewayObj = parseAllDocuments(admin(['kustomize', join(REPO, 'infrastructure/gateway')])).map((d) => d.toJS()).find((o) => o?.kind === 'Gateway' && o.metadata.name === 'bretagne-gateway')
  assert.ok(gatewayObj.spec.listeners.some((l) => l.name === 'https-preview' && l.hostname === '*.preview.bretagne.dev'))
  apply([gatewayObj])
  // Traefik serves the preview's name with a certificate the runner trusts; the gateway reaches it there.
  const previewCa = makeCa('Test preview CA')
  const tls = previewCa.issue(['*.preview.bretagne.dev'])
  writeFileSync(join(work, 'tls.crt'), tls.cert)
  writeFileSync(join(work, 'tls.key'), tls.key)
  admin(['-n', 'traefik', 'delete', 'secret', 'bretagne-preview-wildcard-tls', '--ignore-not-found'])
  admin(['-n', 'traefik', 'create', 'secret', 'tls', 'bretagne-preview-wildcard-tls', `--cert=${join(work, 'tls.crt')}`, `--key=${join(work, 'tls.key')}`])
  writeFileSync(join(work, 'roots.pem'), readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8') + '\n' + previewCa.cert)
  const browser = new Agent({ connect: { ca: previewCa.cert } })
  for (const deadline = Date.now() + 120_000; ; await sleep(2000)) {
    try {
      const r = await browser.request({ origin: `https://${HOST}`, path: '/', method: 'GET' })
      await r.body.text()
      if (r.statusCode === 302) break
    } catch {}
    if (Date.now() > deadline) assert.fail('Traefik never served the preview')
  }

  // The gateway, on the configuration this repository renders.
  const objects = parseAllDocuments(admin(['kustomize', join(REPO, 'apps/agora-gateway')])).map((d) => d.toJS())
  const find = (kind, name) => objects.find((o) => o.kind === kind && o.metadata.name === name)
  let config = find('ConfigMap', 'gateway-config').data['config.yaml']
  const listener = parse(config).binds.find((b) => b.port === 443).listeners[0]
  const route = listener.routes.find((r) => r.name === 'previews')
  assert.deepEqual(route.hostnames, ['*.preview.bretagne.dev'])
  const root = join(work, 'etc') + '/'
  config = config.replaceAll('/etc/agentgateway/', root)
  for (const file of new Set([...config.matchAll(new RegExp(`${root}[^ }\\n]+`, 'g'))].map((m) => m[0]))) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'stand-in')
  }
  const gatewayCa = makeCa('Test gateway CA')
  writeFileSync(join(work, 'etc/ca/ca-cert.pem'), gatewayCa.cert)
  writeFileSync(join(work, 'etc/ca/ca-key.pem'), gatewayCa.key)
  const credential = join(work, 'etc/previews')
  execFileSync('rm', ['-rf', credential])
  writeSecretVolume(credential, { access_token: gatewayToken() })
  const signing = generateKeyPairSync('ed25519')
  const keyFile = join(work, 'grants-key.pem')
  writeFileSync(keyFile, signing.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const kid = JSON.parse(find('ConfigMap', 'grants-jwks').data['jwks.json']).keys[0].kid
  writeFileSync(join(work, 'etc/jwks/jwks.json'), JSON.stringify({ keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] }))
  const [connectPort, readyPort, adminPort] = [await freePort(), await freePort(), await freePort()]
  const swap = (from, to) => { assert.ok(config.includes(from), from); config = config.replace(from, to) }
  swap('- port: 3000', `- port: ${connectPort}`)
  swap('readinessAddr: 0.0.0.0:15021', `readinessAddr: 127.0.0.1:${readyPort}`)
  swap('adminAddr: 127.0.0.1:15000', `adminAddr: 127.0.0.1:${adminPort}`)
  if (MUTATE === 'route') {
    const i = config.indexOf('- name: previews')
    const j = config.indexOf('- allow: ', i)
    config = config.slice(0, j) + "- allow: 'true'\n" + config.slice(config.indexOf('\n', j) + 1)
  }
  writeFileSync(join(work, 'config.yaml'), config)
  const log = []
  // The roots a production gateway has, plus the CA that signs kind's Traefik certificate.
  const gateway = spawn(binary, ['-f', join(work, 'config.yaml')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SSL_CERT_FILE: join(work, 'roots.pem') } })
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', (c) => log.push(String(c)))
  for (const deadline = Date.now() + 20_000; ; await sleep(200)) {
    try { if ((await fetch(`http://127.0.0.1:${readyPort}/healthz/ready`)).ok) break } catch {}
    if (Date.now() > deadline || gateway.exitCode !== null) assert.fail(`the gateway is not ready:\n${log.join('')}`)
  }

  const agora = process.env.AGORA_SRC
  const { GrantSigner, compileProfile } = await import(join(agora, 'credentials/src/grants.ts'))
  const { startOutbound } = await import(join(agora, 'harness-bridge/src/outbound.ts'))
  const signer = new GrantSigner({ proxy: `127.0.0.1:${connectPort}`, keyFile, keyId: kid, issuer: listener.policies.jwtAuth.issuer, audience: listener.policies.jwtAuth.audiences[0] })
  ctx = { work, gateway, log, signer, startOutbound, compileProfile, gatewayCa, previewCa, browser, credential, mint, gatewayToken, rendered, outbounds: [] }
})

after(async () => {
  for (const o of ctx?.outbounds ?? []) await o.close()
  ctx?.gateway.kill()
})

/** A sandbox with Agora's bridge holding a token for these profiles, bound to `address`. */
async function sandbox(profiles, address = '127.0.0.1') {
  const outbound = await ctx.startOutbound({ log: () => {} })
  ctx.outbounds.push(outbound)
  outbound.set(await ctx.signer.mint({ label: `agora e2e-${profiles.join('+') || 'none'}`, ttlSeconds: 3600, profiles, address }))
  const http = new ProxyAgent({ uri: outbound.url, requestTls: { ca: ctx.gatewayCa.cert } })
  return {
    request: async (host, path = '/echo', { method = 'GET', headers = {}, body } = {}) => {
      const r = await http.request({ origin: `https://${host}`, path, method, headers: { authorization: SANDBOX_AUTHORIZATION, ...headers }, body })
      const text = await r.body.text()
      return { status: r.statusCode, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
    },
  }
}

/** A browser straight to Traefik, with no gateway. */
async function browserRequest(path = '/echo', headers = {}) {
  const r = await ctx.browser.request({ origin: `https://${HOST}`, path, method: 'GET', headers })
  const text = await r.body.text()
  return { status: r.statusCode, location: r.headers.location ?? '', text }
}

/** How many requests the preview's app has received so far, from its log. */
function appSeen() {
  return admin(['-n', NS, 'logs', `deployment/${APP}`]).split('\n').filter((l) => l.startsWith('{"seen":true')).length
}

describe('the previews route and the gateway gate: agentgateway 1.6.0, Traefik and oauth2-proxy in kind', () => {
  it('a covered request reaches the app with the gate\'s identity; the app never receives the gateway\'s token nor the sandbox\'s Authorization', async (t) => {
    const s = await sandbox(['previews'])
    const get = await s.request(HOST, '/echo?x=1', { headers: { 'x-forwarded-user': 'forged-by-the-sandbox', 'x-agora-gate': 'forged' } })
    t.diagnostic(`GET: ${get.status}; the app received: authorization=${get.json?.headers?.authorization} x-forwarded-user=${get.json?.headers?.['x-forwarded-user']} x-agora-gate=${get.json?.headers?.['x-agora-gate']}`)
    assert.equal(get.status, 200, get.text)
    const post = await s.request(HOST, '/echo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' })
    t.diagnostic(`POST: ${post.status}; the app received body=${JSON.stringify(post.json?.body)}`)
    assert.equal(post.status, 200, post.text)
    assert.equal(post.json.body, 'hello')
    for (const seen of [get.json, post.json]) {
      assert.equal(seen.headers.authorization, `Basic ${Buffer.from(`${IDENTITY}:none`).toString('base64')}`)
      assert.equal(seen.headers['x-forwarded-user'], IDENTITY)
      assert.equal(seen.headers['x-agora-gate'], 'gateway')
      assert.ok(!JSON.stringify(seen).includes(ctx.gatewayToken().split('.')[0] + '.'), 'no token of the gateway')
      assert.ok(!JSON.stringify(seen).includes('forged-by-the-sandbox'))
    }
  })

  it('names the pattern refuses, no profile, internet alone, anthropic alone, another address: 403 from the gateway; the app receives nothing', async (t) => {
    const before = appSeen()
    const s = await sandbox(['previews'])
    for (const host of ['preview.bretagne.dev', 'x.preview.bretagne.dev', `a.${HOST}`, `pr-0-${APP}.preview.bretagne.dev`, `pr-${PR}-.preview.bretagne.dev`, `pr-${PR}-${APP}-.preview.bretagne.dev`, `pr-${PR}-a_b.preview.bretagne.dev`]) {
      // A name that is not a valid DNS name never gets a certificate from the gateway: refused at TLS. One that
      // Agora's bridge does not take as host:port is refused by the bridge, before the gateway (400 to the CONNECT).
      let r
      try { r = await s.request(host) } catch (error) { const m = String(error.message).split('\n')[0]; r = { status: /Proxy response \(400\)/.test(m) ? 'BRIDGE' : /alert|SSL|TLS/i.test(m) ? 'TLS' : 'ERROR', text: m } }
      const said = { TLS: `refused by the gateway at TLS (${r.text.slice(0, 90)})`, BRIDGE: `refused by Agora's bridge before the gateway (${r.text.slice(0, 60)})`, ERROR: `failed: ${r.text.slice(0, 90)}` }[r.status] ?? `${r.status} ${r.text.trim().slice(0, 60)}`
      t.diagnostic(`${host} with previews: ${said}`)
      assert.ok(['TLS', 'BRIDGE'].includes(r.status) || (r.status === 403 && /authorization failed/.test(r.text)), `${host}: ${r.status} ${r.text}`)
    }
    for (const [profiles, address] of [[[], '127.0.0.1'], [['internet'], '127.0.0.1'], [['anthropic'], '127.0.0.1'], [['previews'], '10.244.0.99']]) {
      const other = await sandbox(profiles, address)
      const r = await other.request(HOST)
      t.diagnostic(`${HOST} with [${profiles}] from ${address}: ${r.status} ${r.text.trim().slice(0, 60)}`)
      assert.equal(r.status, 403, `${profiles}: ${r.text}`)
      assert.match(r.text, /authorization failed/)
    }
    await sleep(1000)
    const after = appSeen()
    t.diagnostic(`requests the app received during this test: ${after - before}`)
    assert.equal(after, before)
  })

  it('x-agora-gate forged by a sandbox or a browser gives nothing more: the gateway gate wants the gateway\'s token', async (t) => {
    const before = appSeen()
    const internet = await sandbox(['internet'])
    const r1 = await internet.request(HOST, '/echo', { headers: { 'x-agora-gate': 'gateway' } })
    t.diagnostic(`sandbox with internet alone, x-agora-gate: gateway: ${r1.status} ${r1.text.trim().slice(0, 60)}`)
    assert.equal(r1.status, 403)
    const cases = {
      'no token': {},
      'a forged token': { authorization: 'Bearer forged-by-the-browser' },
      'another client\'s token': { authorization: `Bearer ${ctx.mint({ sub: 'client-285e5889-e9b4-40cf-b1e8-a6f430f42c35', aud: ['285e5889-e9b4-40cf-b1e8-a6f430f42c35'] })}` },
      'the client\'s audience, another identity': { authorization: `Bearer ${ctx.mint({ sub: 'client-285e5889-e9b4-40cf-b1e8-a6f430f42c35', aud: [CLIENT.id] })}` },
      'an admin\'s session-like token, the browser client\'s audience': { authorization: `Bearer ${ctx.mint({ sub: randomUUID(), aud: ['preview'], groups: ['admin'], email: 'admin@example.com' })}` },
    }
    for (const [name, headers] of Object.entries(cases)) {
      const r = await browserRequest('/echo', { 'x-agora-gate': 'gateway', ...headers })
      t.diagnostic(`browser with x-agora-gate: gateway, ${name}: ${r.status}`)
      assert.ok([401, 403].includes(r.status), `${name}: ${r.status} ${r.text}`)
    }
    await sleep(1000)
    const after = appSeen()
    t.diagnostic(`requests the app received during this test: ${after - before}`)
    assert.equal(after, before)
  })

  it('the browser gate is unchanged: its Deployment, Service, network policy and route rule render as on the base branch, and it takes no bearer', async (t) => {
    const base = render(process.env.BASE_RESOURCESET)
    const pick = (objs, kind, name) => objs.find((o) => o.kind === kind && o.metadata.name === name)
    for (const [kind, name] of [['Deployment', `${P}-gate`], ['Service', `${P}-gate`], ['CiliumNetworkPolicy', `${P}-gate`]]) {
      const now = pick(ctx.rendered, kind, name)
      assert.deepEqual(now, pick(base, kind, name), `${kind}/${name}`)
      t.diagnostic(`${kind}/${name}: identical to the base branch's render`)
    }
    const rules = pick(ctx.rendered, 'HTTPRoute', P).spec.rules
    const baseRules = pick(base, 'HTTPRoute', P).spec.rules
    assert.equal(baseRules.length, 1)
    assert.deepEqual(rules.at(-1), baseRules[0], 'the rule without a header match is the base branch\'s')
    t.diagnostic(`HTTPRoute ${P}: ${rules.length} rules; the last, without a match, identical to the base branch's only rule; the first matches x-agora-gate: gateway -> ${rules[0].backendRefs[0].name}`)
    const plain = await browserRequest('/echo')
    t.diagnostic(`browser, no header: ${plain.status} -> ${plain.location.split('?')[0]} client_id=${new URL(plain.location, ISSUER).searchParams.get('client_id')}`)
    assert.equal(plain.status, 302)
    assert.ok(plain.location.startsWith(`${ISSUER}/authorize`))
    const bearer = await browserRequest('/echo', { authorization: `Bearer ${ctx.gatewayToken()}` })
    t.diagnostic(`browser, no header, the gateway's own token as Bearer: ${bearer.status} -> ${bearer.location.split('?')[0]}`)
    assert.equal(bearer.status, 302, 'the browser gate takes no bearer token')
  })

  it('no secret reaches the preview\'s namespace', (t) => {
    const inPreview = ctx.rendered.filter((o) => o.metadata?.namespace === NS).map((o) => o.kind)
    t.diagnostic(`rendered into ${NS}: ${[...new Set(inPreview)].join(', ')}`)
    assert.ok(!inPreview.includes('Secret'))
    const live = admin(['-n', NS, 'get', 'secrets', '-o', 'name']).trim()
    t.diagnostic(`secrets in ${NS}: ${live || 'none'}`)
    assert.equal(live, '')
  })

  it('the token rotated during an open response: the response ends whole, the next request carries the new token, nothing is cut', async (t) => {
    const s = await sandbox(['previews'])
    // A valid token replaced by another while a response is open.
    const slow = s.request(HOST, '/slow')
    await sleep(1000)
    writeSecretVolume(ctx.credential, { access_token: ctx.gatewayToken() })
    const first = await slow
    t.diagnostic(`/slow open while the token was replaced by a new one: ${first.status} ${JSON.stringify(first.text)}`)
    assert.deepEqual([first.status, first.text], [200, 'first part\nsecond part\n'])
    const next = await s.request(HOST)
    t.diagnostic(`the next request: ${next.status}`)
    assert.equal(next.status, 200)
    // Then an invalid one, to see that the next request carries the file's current token.
    const slow2 = s.request(HOST, '/slow')
    await sleep(1000)
    writeSecretVolume(ctx.credential, { access_token: 'not-a-token' })
    const second = await slow2
    t.diagnostic(`/slow open while the token was replaced by an invalid one: ${second.status} ${JSON.stringify(second.text)}`)
    assert.deepEqual([second.status, second.text], [200, 'first part\nsecond part\n'])
    let refused
    for (const deadline = Date.now() + 20_000; ; await sleep(500)) {
      refused = await s.request(HOST)
      if (refused.status !== 200 || Date.now() > deadline) break
    }
    t.diagnostic(`a request after the invalid token: ${refused.status}`)
    assert.ok([401, 403].includes(refused.status), String(refused.status))
    writeSecretVolume(ctx.credential, { access_token: ctx.gatewayToken() })
    let back
    for (const deadline = Date.now() + 20_000; ; await sleep(500)) {
      back = await s.request(HOST)
      if (back.status === 200 || Date.now() > deadline) break
    }
    t.diagnostic(`a valid token back: ${back.status}`)
    assert.equal(back.status, 200)
  })

  it('revocation: client-<id> out of preview-gateway-identities refuses the gateway\'s token; back in, it is taken again', async (t) => {
    const s = await sandbox(['previews'])
    assert.equal((await s.request(HOST)).status, 200)
    const started = Date.now()
    admin(['-n', 'preview-system', 'patch', 'configmap', 'preview-gateway-identities', '--type=merge', '-p', JSON.stringify({ data: { 'gateway-identities': 'client-nobody\n' } })])
    let r
    for (const deadline = Date.now() + 180_000; ; await sleep(2000)) {
      r = await s.request(HOST)
      if (r.status !== 200 || Date.now() > deadline) break
    }
    t.diagnostic(`identity taken out: ${r.status} after ${((Date.now() - started) / 1000).toFixed(0)} s (the kubelet's sync of the mounted ConfigMap, then oauth2-proxy's reload)`)
    assert.ok([401, 403].includes(r.status), String(r.status))
    admin(['-n', 'preview-system', 'patch', 'configmap', 'preview-gateway-identities', '--type=merge', '-p', JSON.stringify({ data: { 'gateway-identities': `${IDENTITY}\n` } })])
    const back = Date.now()
    for (const deadline = Date.now() + 180_000; ; await sleep(2000)) {
      r = await s.request(HOST)
      if (r.status === 200 || Date.now() > deadline) break
    }
    t.diagnostic(`identity back: ${r.status} after ${((Date.now() - back) / 1000).toFixed(0)} s`)
    assert.equal(r.status, 200)
  })

  it('the gateway logs the route and the execution', () => {
    const lines = ctx.log.join('').split('\n')
    assert.ok(lines.some((l) => l.includes('route=default/previews') && l.includes('jwt.sub=agora e2e-previews')))
  })
})
