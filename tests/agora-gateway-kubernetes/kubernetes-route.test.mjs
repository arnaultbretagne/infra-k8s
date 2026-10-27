// The agora-gateway's `kubernetes` route, end to end (docs/specs/credentials.md on arnaultbretagne/agora, "Kubernetes").
//
// A real API server (kind, its audit log on), on which this repository's ServiceAccount, ClusterRole and
// ClusterRoleBinding are applied as `kubectl kustomize apps/agora-gateway` renders them. The real agentgateway release
// binary (sha256 checked) runs the gateway-config of the same render: only its files, ports and the API server's
// address are made local. Tokens are signed by Agora's GrantSigner, and carried by Agora's bridge, its outbound proxy
// (both at a pinned commit of the contract's branch). kubectl runs as in a sandbox: the bridge's kubeconfig.yaml, no
// credential, HTTPS_PROXY the bridge.
//
// Inputs (environment): AGORA_SRC, Agora's packages directory; AGENTGATEWAY; KUBECTL (the sandbox's and the admin's);
// KUBECONFIG, the kind admin's; KIND_NODE, the kind control-plane container (its audit log is read with docker exec);
// MUTATE, `route` or `role`, to break one on purpose (the workflow checks that the run then fails).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
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
const HOST = 'kubernetes.agora.internal'
const SERVICE = 'kubernetes.default.svc.cluster.local:443'
const SA = 'system:serviceaccount:agora-gateway:gateway'
const NS = 'e2e'
const KUBECTL = process.env.KUBECTL ?? 'kubectl'
const MUTATE = process.env.MUTATE ?? ''
const run = `${Date.now()}`

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const admin = (args, input) => execFileSync(KUBECTL, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })

async function freePort() {
  const server = createServer()
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address()
  await new Promise((ok) => server.close(ok))
  return port
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
  return join(dir, 'ca-cert.pem')
}

/** A projected volume as the kubelet writes it: files behind `..data`, swapped atomically when the token is renewed. */
function writeProjected(dir, files) {
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

/** The audit events written since `mark` (a line count). */
function audit(mark = 0) {
  const text = execFileSync('docker', ['exec', process.env.KIND_NODE ?? 'kind-control-plane', 'cat', '/var/log/kubernetes/audit.log'], { encoding: 'utf8', maxBuffer: 256 << 20 })
  const lines = text.split('\n').filter(Boolean)
  return { count: lines.length, events: lines.slice(mark).map((line) => JSON.parse(line)) }
}

/** kubectl straight to the API server with this token and no other identity (no client certificate). */
function direct(token, args) {
  try {
    execFileSync(KUBECTL, ['--kubeconfig=/dev/null', '--server=https://127.0.0.1:443', `--certificate-authority=${ctx.kubeCa}`, '--token', token, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return 'allowed'
  } catch (error) {
    return String(error.stderr)
  }
}

/** A token of the ServiceAccount bound to a Secret: deleting the Secret makes the API server refuse the token. */
function mintBound(anchor) {
  admin(['-n', 'agora-gateway', 'create', 'secret', 'generic', anchor])
  return admin(['-n', 'agora-gateway', 'create', 'token', 'gateway', '--bound-object-kind', 'Secret', '--bound-object-name', anchor, '--duration', '3600s']).trim()
}

let ctx

before(async () => {
  const work = mkdtempSync(join(tmpdir(), 'kubernetes-route-'))
  const binary = process.env.AGENTGATEWAY
  assert.ok(binary, 'AGENTGATEWAY')
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), SHA256, 'agentgateway-linux-amd64 v1.6.0, as released')
  const agora = process.env.AGORA_SRC ?? assert.fail('AGORA_SRC: Agora\'s packages directory')

  // What this repository deploys.
  const objects = parseAllDocuments(admin(['kustomize', join(REPO, 'apps/agora-gateway')])).map((d) => d.toJS())
  const find = (kind, name) => objects.find((o) => o.kind === kind && o.metadata.name === name) ?? assert.fail(`${kind}/${name} in the render`)
  const role = find('ClusterRole', 'agora-kubernetes-read')
  if (MUTATE === 'role') role.rules.push({ apiGroups: [''], resources: ['secrets', 'pods/exec'], verbs: ['get', 'create'] })
  const rbac = [find('Namespace', 'agora-gateway'), find('ServiceAccount', 'gateway'), role, find('ClusterRoleBinding', 'agora-kubernetes-read')]
  admin(['apply', '-f', '-'], rbac.map((o) => stringify(o)).join('---\n'))

  // The cluster the agent reads: a namespace, a Pod with a log line, a ConfigMap, a Secret.
  admin(['apply', '-f', '-'], [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'readable', namespace: NS }, data: { a: 'b' } },
    { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'never', namespace: NS }, stringData: { password: 'not-for-the-agent' } },
    { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web', namespace: NS }, spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'web', image: 'busybox:1.37', command: ['sh', '-c', 'echo hello-from-the-pod; sleep 3600'] }] } },
  ].map((o) => stringify(o)).join('---\n'))
  admin(['-n', NS, 'wait', '--for=condition=Ready', 'pod/web', '--timeout=180s'])

  // The gateway-config, with its files, ports and the API server's address made local.
  let config = find('ConfigMap', 'gateway-config').data['config.yaml']
  const parsed = parse(config)
  const listener = parsed.binds.find((b) => b.port === 443).listeners[0]
  const route = listener.routes.find((r) => r.name === 'kubernetes') ?? assert.fail('a route named kubernetes')
  assert.deepEqual(route.hostnames, [HOST])
  assert.equal(route.backends[0].host, SERVICE)
  const root = join(work, 'etc') + '/'
  config = config.replaceAll('/etc/agentgateway/', root)
  for (const file of new Set([...config.matchAll(new RegExp(`${root}[^ }\\n]+`, 'g'))].map((m) => m[0]))) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'stand-in')
  }
  const gatewayCa = makeCa(join(work, 'etc/ca'))
  writeFileSync(join(work, 'etc/kube-ca/ca.crt'), admin(['-n', 'agora-gateway', 'get', 'configmap', 'kube-root-ca.crt', '-o', 'jsonpath={.data.ca\\.crt}']))
  const tokenDir = join(work, 'etc/kubernetes')
  execFileSync('rm', ['-rf', tokenDir])
  const anchor = `anchor-${run}-1`
  writeProjected(tokenDir, { token: mintBound(anchor) })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyFile = join(work, 'grants-key.pem')
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const kid = JSON.parse(find('ConfigMap', 'grants-jwks').data['jwks.json']).keys[0].kid
  writeFileSync(join(work, 'etc/jwks/jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] }))
  const [connectPort, readyPort, adminPort] = [await freePort(), await freePort(), await freePort()]
  const swap = (from, to) => {
    assert.ok(config.includes(from), `the rendered configuration has ${from}`)
    config = config.replace(from, to)
  }
  swap('- port: 3000', `- port: ${connectPort}`)
  swap('readinessAddr: 0.0.0.0:15021', `readinessAddr: 127.0.0.1:${readyPort}`)
  swap('adminAddr: 127.0.0.1:15000', `adminAddr: 127.0.0.1:${adminPort}`)
  swap(`host: ${SERVICE}`, 'host: 127.0.0.1:443') // kind's API server, on 443 like the Service
  if (MUTATE === 'route') {
    const i = config.indexOf('- name: kubernetes')
    const j = config.indexOf('- allow: ', i)
    config = config.slice(0, j) + "- allow: 'true'\n" + config.slice(config.indexOf('\n', j) + 1)
  }
  writeFileSync(join(work, 'config.yaml'), config)

  const log = []
  const gateway = spawn(binary, ['-f', join(work, 'config.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', (chunk) => log.push(String(chunk)))
  for (const deadline = Date.now() + 20_000; ;) {
    try { if ((await fetch(`http://127.0.0.1:${readyPort}/healthz/ready`)).ok) break } catch {}
    if (Date.now() > deadline || gateway.exitCode !== null) assert.fail(`the gateway is not ready:\n${log.join('')}`)
    await sleep(200)
  }

  // Agora: its signer, and its bridge's outbound proxy and kubeconfig.
  const { GrantSigner } = await import(join(agora, 'credentials/src/grants.ts'))
  const { startOutbound } = await import(join(agora, 'harness-bridge/src/outbound.ts'))
  const jwt = listener.policies.jwtAuth
  const signer = new GrantSigner({ proxy: `127.0.0.1:${connectPort}`, keyFile, keyId: kid, issuer: jwt.issuer, audience: jwt.audiences[0] })
  const kubeconfig = join(work, 'kubeconfig.yaml')
  const shipped = readFileSync(join(agora, 'harness-bridge/src/kubeconfig.yaml'), 'utf8')
  assert.ok(shipped.includes('/etc/agora/credential-proxy/ca.pem'))
  writeFileSync(kubeconfig, shipped.replace('/etc/agora/credential-proxy/ca.pem', gatewayCa))

  ctx = { work, gateway, log, signer, startOutbound, kubeconfig, gatewayCa, kubeCa: join(work, 'etc/kube-ca/ca.crt'), tokenDir, anchor, outbounds: [], mark: audit().count, adminUser: 'kubernetes-admin' }
})

after(async () => {
  for (const o of ctx?.outbounds ?? []) await o.close()
  ctx?.gateway.kill()
})

/** A sandbox: Agora's bridge holding a token for these profiles, bound to `address`. */
async function sandbox(profiles, address = '127.0.0.1') {
  const outbound = await ctx.startOutbound({ log: () => {} })
  ctx.outbounds.push(outbound)
  outbound.set(await ctx.signer.mint({ label: `agora e2e-${profiles.join('+') || 'none'}`, ttlSeconds: 3600, profiles, address }))
  const env = { ...process.env, KUBECONFIG: ctx.kubeconfig, HTTPS_PROXY: outbound.url, https_proxy: outbound.url, NO_PROXY: 'localhost,127.0.0.1' }
  return {
    outbound,
    /** kubectl as the agent runs it: `{ code, out, err }`. */
    kubectl: (args, options = {}) => new Promise((ok) => {
      const child = spawn(KUBECTL, ['--request-timeout=20s', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (err += c))
      const timer = options.timeout ? setTimeout(() => child.kill(), options.timeout) : null
      child.on('close', (code) => { if (timer) clearTimeout(timer); ok({ code, out, err }) })
    }),
    watch: (args) => {
      const child = spawn(KUBECTL, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      const state = { out: '', child }
      child.stdout.on('data', (c) => (state.out += c))
      child.stderr.on('data', (c) => (state.out += c))
      return state
    },
    /** A raw HTTP client through the bridge, keeping its tunnel. */
    // Idle connections kept 2 minutes, as a Go client keeps them 90 s (undici's default is 4 s).
    http: new ProxyAgent({ uri: outbound.url, requestTls: { ca: readFileSync(ctx.gatewayCa) }, keepAliveTimeout: 120_000, keepAliveMaxTimeout: 120_000 }),
  }
}

const refusedByGateway = (r) => r.code !== 0 && /authorization failed/.test(r.err)
const forbiddenBySA = (r) => r.code !== 0 && /forbidden/i.test(r.err) && r.err.includes(SA)

describe('the kubernetes route, agentgateway 1.6.0 against a real API server', () => {
  it('kubernetes:read reads: version, Pods across namespaces, a Pod, nodes, ConfigMaps, a log, a watch', async () => {
    const s = await sandbox(['kubernetes:read'])
    for (const args of [['version', '-o', 'json'], ['get', 'pods', '-A'], ['-n', NS, 'get', 'pod', 'web'], ['get', 'nodes'], ['-n', NS, 'get', 'configmap', 'readable', '-o', 'yaml']]) {
      const r = await s.kubectl(args)
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`)
    }
    const logs = await s.kubectl(['-n', NS, 'logs', 'web'])
    assert.equal(logs.code, 0, logs.err)
    assert.match(logs.out, /hello-from-the-pod/)
    const watch = s.watch(['-n', NS, 'get', 'configmaps', '--watch', '-o', 'name'])
    await sleep(2000)
    admin(['-n', NS, 'create', 'configmap', `watched-${run}`])
    for (const deadline = Date.now() + 20_000; !watch.out.includes(`watched-${run}`); await sleep(200)) {
      if (Date.now() > deadline) assert.fail(`the watch never printed the new ConfigMap: ${watch.out}`)
    }
    watch.child.kill()
  })

  it('Secrets, exec, attach, port-forward, the proxies and --as: refused by the RBAC, as the gateway\'s ServiceAccount', async () => {
    const s = await sandbox(['kubernetes:read'])
    const cases = {
      'get secrets': ['-n', NS, 'get', 'secrets'],
      'get secret': ['-n', NS, 'get', 'secret', 'never', '-o', 'yaml'],
      'get secrets -A': ['get', 'secrets', '-A'],
      'get --raw node proxy': ['get', '--raw', `/api/v1/nodes/${admin(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'])}/proxy/healthz`],
      'get --raw pod proxy': ['get', '--raw', `/api/v1/namespaces/${NS}/pods/web/proxy/`],
      'get pods --as': ['get', 'pods', '--as=system:admin'],
    }
    for (const [name, args] of Object.entries(cases)) {
      const r = await s.kubectl(args)
      assert.ok(forbiddenBySA(r), `${name}: ${r.code} ${r.err}`)
    }
    // exec, attach and port-forward: kubectl tries a WebSocket (a GET the grant lets through, which the RBAC refuses),
    // then SPDY (a POST the gateway refuses). Either way, refused; nothing ran.
    for (const [name, args, timeout] of [['exec', ['-n', NS, 'exec', 'web', '--', 'echo', 'ran-in-the-pod'], 0], ['attach', ['-n', NS, 'attach', 'web'], 0], ['port-forward', ['-n', NS, 'port-forward', 'pod/web', `${await freePort()}:80`], 15_000]]) {
      const r = await s.kubectl(args, { timeout })
      assert.notEqual(r.code, 0, `${name}: ${r.out}`)
      assert.ok(forbiddenBySA(r) || refusedByGateway(r), `${name}: ${r.err}`)
      assert.ok(!r.out.includes('ran-in-the-pod') && !/Forwarding from/.test(r.out), `${name}: ${r.out}`)
    }
  })

  it('every write, a token, auth can-i: refused by the gateway, the API server receiving none', async () => {
    const mark = audit().count
    const s = await sandbox(['kubernetes:read'])
    const cases = {
      'create configmap': ['-n', NS, 'create', 'configmap', `made-${run}`],
      'delete configmap': ['-n', NS, 'delete', 'configmap', 'readable'],
      'patch configmap': ['-n', NS, 'patch', 'configmap', 'readable', '-p', '{"data":{"a":"changed"}}'],
      'label pod': ['-n', NS, 'label', 'pod', 'web', 'touched=yes'],
      'create token': ['-n', 'agora-gateway', 'create', 'token', 'gateway'],
      'auth can-i': ['auth', 'can-i', 'get', 'secrets'],
      'auth whoami': ['auth', 'whoami'],
    }
    for (const [name, args] of Object.entries(cases)) {
      const r = await s.kubectl(args)
      // kubectl auth whoami words a 403 its own way; the audit below shows the API server received nothing.
      const whoami = name === 'auth whoami' && r.code !== 0 && /selfsubjectreviews API is not enabled in the cluster or you do not have permission/.test(r.err)
      assert.ok(refusedByGateway(r) || whoami, `${name}: ${r.code} ${r.err}`)
    }
    assert.equal(admin(['-n', NS, 'get', 'configmap', 'readable', '-o', 'jsonpath={.data.a}']), 'b', 'the ConfigMap is untouched')
    const writes = audit(mark).events.filter((e) => e.user.username !== ctx.adminUser && !['get', 'list', 'watch'].includes(e.verb))
    assert.deepEqual(writes.map((e) => `${e.user.username} ${e.verb} ${e.requestURI}`).filter((l) => l.startsWith(SA)), [], 'no write reached the API server')
  })

  it('the RBAC refuses the same on its own: the ServiceAccount\'s token straight to the API server', () => {
    // A subresource is asked with --subresource: `can-i get pods/exec` would ask about a Pod named exec.
    const can = (verb, resource, ns = NS) => {
      const [name, sub] = resource.split('/')
      return admin(['auth', 'can-i', verb, name, ...(sub ? [`--subresource=${sub}`] : []), '-n', ns, `--as=${SA}`]).trim()
    }
    const ask = (verb, resource, ns = NS) => { try { return can(verb, resource, ns) } catch (error) { return String(error.stdout).trim() } }
    for (const [verb, resource] of [['get', 'secrets'], ['list', 'secrets'], ['watch', 'secrets'], ['create', 'pods/exec'], ['get', 'pods/exec'], ['create', 'pods/attach'], ['get', 'pods/attach'], ['create', 'pods/portforward'], ['get', 'pods/portforward'], ['get', 'pods/proxy'], ['get', 'services/proxy'], ['get', 'nodes/proxy'], ['create', 'serviceaccounts/token'], ['update', 'pods/ephemeralcontainers'], ['create', 'configmaps'], ['delete', 'configmaps'], ['patch', 'pods'], ['update', 'deployments.apps'], ['impersonate', 'users'], ['get', 'resourcesets.fluxcd.controlplane.io']]) {
      assert.equal(ask(verb, resource), 'no', `${verb} ${resource}`)
    }
    for (const [verb, resource] of [['get', 'pods'], ['list', 'pods'], ['watch', 'pods'], ['get', 'pods/log'], ['list', 'configmaps'], ['list', 'nodes'], ['list', 'deployments.apps'], ['list', 'helmreleases.helm.toolkit.fluxcd.io']]) {
      assert.equal(ask(verb, resource), 'yes', `${verb} ${resource}`)
    }
    // And with the token itself, past the gateway: a write and a Secret refused.
    const token = readFileSync(join(ctx.tokenDir, 'token'), 'utf8')
    assert.equal(direct(token, ['-n', NS, 'get', 'configmap', 'readable']), 'allowed', 'the token itself reads')
    for (const args of [['-n', NS, 'get', 'secrets'], ['-n', NS, 'delete', 'configmap', 'readable'], ['-n', NS, 'exec', 'web', '--', 'true'], ['-n', 'agora-gateway', 'create', 'token', 'gateway']]) {
      const answer = direct(token, args)
      assert.match(answer, /forbidden/i, args.join(' '))
      assert.ok(answer.includes(SA), `${args.join(' ')}: refused as the ServiceAccount: ${answer}`)
    }
  })

  it('without kubernetes:read — no profile, internet alone, anthropic alone — 403 from the gateway', async () => {
    const mark = audit().count
    for (const profiles of [[], ['internet'], ['anthropic']]) {
      const s = await sandbox(profiles)
      const r = await s.kubectl(['get', 'pods', '-A'])
      assert.ok(refusedByGateway(r), `${profiles}: ${r.err}`)
    }
    assert.deepEqual(audit(mark).events.filter((e) => e.user.username === SA), [], 'the API server receives nothing')
  })

  it('kubernetes:read from another address than the token\'s: 403 from the gateway', async () => {
    const mark = audit().count
    const s = await sandbox(['kubernetes:read'], '10.244.0.99')
    const r = await s.kubectl(['get', 'pods', '-A'])
    assert.ok(refusedByGateway(r), r.err)
    assert.deepEqual(audit(mark).events.filter((e) => e.user.username === SA), [])
  })

  it('paths outside the grant and path tricks: 403 from the gateway', async () => {
    const s = await sandbox(['kubernetes:read'])
    for (const path of ['/', '/healthz', '/livez', '/metrics', '/logs/', '/api/../healthz', '/api/v1/%2e%2e/%2e%2e/healthz', '/api%2fv1/pods']) {
      const response = await s.http.request({ origin: `https://${HOST}`, path, method: 'GET' })
      const body = await response.body.text()
      assert.equal(response.statusCode, 403, `${path}: ${body}`)
      assert.match(body, /authorization failed/)
    }
  })

  it('the internet route cannot reach the API server anonymously: its certificate is not a public one', async () => {
    const mark = audit().count
    const s = await sandbox(['internet'])
    // A name resolving to the API server's address, on 443, through the route that sets no credential.
    let failed = null
    try {
      const response = await s.http.request({ origin: 'https://localhost', path: '/api/v1/namespaces', method: 'GET' })
      failed = response.statusCode
      await response.body.text()
    } catch (error) {
      failed = error.code ?? error.message
    }
    assert.notEqual(failed, 200, 'refused')
    assert.deepEqual(audit(mark).events.filter((e) => /system:anonymous/.test(e.user.username) && !/^kube-probe\//.test(e.userAgent ?? '')).map((e) => e.requestURI), [], 'no anonymous request reached the API server')
  })

  it('the API server only ever saw the gateway\'s ServiceAccount: never the sandbox\'s Basic agora:, never anonymous', () => {
    const events = audit(ctx.mark).events
    const fromSandboxes = events.filter((e) => /^kubectl\//.test(e.userAgent ?? '') && e.user.username !== ctx.adminUser)
    assert.ok(fromSandboxes.length > 10, `${fromSandboxes.length} requests from the sandboxes`)
    assert.deepEqual([...new Set(fromSandboxes.map((e) => e.user.username))], [SA])
    // The kubelet's own probes of the API server are anonymous (kube-probe/…): they are not the sandboxes'.
    const probe = (e) => /^kube-probe\//.test(e.userAgent ?? '')
    assert.deepEqual(events.filter((e) => ['system:anonymous', 'agora'].includes(e.user.username) && !probe(e)).map((e) => `${e.user.username} ${e.userAgent} ${e.requestURI}`), [])
  })

  it('the ServiceAccount\'s token renewed, the old one revoked: the open tunnel and an open watch keep working', async () => {
    const s = await sandbox(['kubernetes:read'])
    const get = async () => {
      const response = await s.http.request({ origin: `https://${HOST}`, path: `/api/v1/namespaces/${NS}/configmaps/readable`, method: 'GET' })
      await response.body.text()
      return response.statusCode
    }
    assert.equal(await get(), 200)
    const watch = s.watch(['-n', NS, 'get', 'configmaps', '--watch', '-o', 'name'])
    await sleep(2000)
    const tunnels = s.outbound.describe().tunnels

    // The kubelet's renewal: a new token, the file swapped.
    const old = readFileSync(join(ctx.tokenDir, 'token'), 'utf8')
    writeProjected(ctx.tokenDir, { token: mintBound(`anchor-${run}-2`) })
    await sleep(5000)
    // The old token made worthless: its bound Secret deleted, until the API server refuses it (its cache lasts ~10 s).
    admin(['-n', 'agora-gateway', 'delete', 'secret', ctx.anchor])
    const stale = () => /Unauthorized|401/.test(direct(old, ['get', '--raw', '/api']))
    for (const deadline = Date.now() + 60_000; !stale(); await sleep(1000)) if (Date.now() > deadline) assert.fail('the old token is still accepted')

    assert.equal(await get(), 200, 'the request on the tunnel opened before the renewal')
    assert.equal(s.outbound.describe().tunnels, tunnels, 'the same tunnel: no new CONNECT')
    admin(['-n', NS, 'create', 'configmap', `after-renewal-${run}`])
    for (const deadline = Date.now() + 20_000; !watch.out.includes(`after-renewal-${run}`); await sleep(200)) {
      if (Date.now() > deadline) assert.fail(`the watch opened before the renewal stopped: ${watch.out}`)
    }
    watch.child.kill()
    const fresh = await sandbox(['kubernetes:read'])
    const r = await fresh.kubectl(['-n', NS, 'get', 'configmap', 'readable'])
    assert.equal(r.code, 0, `a new session after the renewal: ${r.err}`)
    assert.equal(ctx.gateway.exitCode, null, 'the same gateway process: no restart')
  })
})
