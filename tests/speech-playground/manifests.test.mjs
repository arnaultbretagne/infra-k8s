// What apps/speech-playground declares, read from its kustomize render: the gate (route → oauth2-proxy only,
// ALLOWED_GROUPS=admin, the Pocket-ID client, the Gateway listener), the one config file, the key's Secret, the
// hardening of every container and the network policies.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { REPO, APP, WORKLOAD, render } from './targets.mjs'

const objects = render(APP)
const find = (kind, name) => objects.find((o) => o.kind === kind && (name === undefined || o.metadata.name === name || o.metadata.name.startsWith(`${name}-`)))
const deployments = objects.filter((o) => o.kind === 'Deployment')
const envOf = (container) => Object.fromEntries((container.env ?? []).map((e) => [e.name, e.value ?? e.valueFrom]))

test('the app is in apps/kustomization.yaml, and apps/ builds with it', () => {
  const apps = parse(readFileSync(join(REPO, 'apps/kustomization.yaml'), 'utf8'))
  assert.ok(apps.resources.includes('speech-playground'))
  const all = render(join(REPO, 'apps'))
  assert.ok(all.some((o) => o.kind === 'Deployment' && o.metadata.namespace === 'speech-playground' && o.metadata.name === 'speech-playground'))
})

test('public images only, pinned; the page and the server are ConfigMaps', () => {
  const images = deployments.flatMap((d) => [...(d.spec.template.spec.initContainers ?? []), ...d.spec.template.spec.containers]).map((c) => c.image)
  assert.deepEqual([...new Set(images)].sort(), [
    'node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1',
    'quay.io/oauth2-proxy/oauth2-proxy:v7.15.5',
  ])
  const app = find('ConfigMap', 'speech-playground-app')
  assert.deepEqual(Object.keys(app.data).sort(), ['app.js', 'index.html', 'server.mjs'])
  assert.equal(app.data['server.mjs'], readFileSync(join(WORKLOAD, 'server.mjs'), 'utf8'))
})

test('the route reaches nothing but the oauth2-proxy, on speech.bretagne.dev, with HSTS', () => {
  const routes = objects.filter((o) => o.kind === 'HTTPRoute')
  assert.equal(routes.length, 1)
  const [route] = routes
  assert.deepEqual(route.spec.hostnames, ['speech.bretagne.dev'])
  assert.deepEqual(route.spec.parentRefs, [{ name: 'bretagne-gateway', namespace: 'traefik', sectionName: 'https-speech' }])
  for (const rule of route.spec.rules) {
    assert.deepEqual(rule.backendRefs, [{ name: 'oauth2-proxy', port: 4180 }])
    const hsts = rule.filters.find((f) => f.type === 'ResponseHeaderModifier').responseHeaderModifier.set.find((h) => h.name === 'Strict-Transport-Security')
    assert.match(hsts.value, /^max-age=\d+; includeSubDomains$/)
  }
  const service = find('Service', 'oauth2-proxy')
  assert.deepEqual(service.spec.selector, { app: 'oauth2-proxy' })
})

test('the oauth2-proxy admits the group admin only, in front of the playground', () => {
  const proxy = find('Deployment', 'oauth2-proxy').spec.template.spec.containers[0]
  const env = envOf(proxy)
  assert.equal(env.OAUTH2_PROXY_ALLOWED_GROUPS, 'admin')
  assert.equal(env.OAUTH2_PROXY_UPSTREAMS, 'http://speech-playground.speech-playground.svc.cluster.local:8080')
  assert.equal(env.OAUTH2_PROXY_REDIRECT_URL, 'https://speech.bretagne.dev/oidc/callback')
  assert.match(env.OAUTH2_PROXY_SCOPE, /\bgroups\b/)
  assert.equal(env.OAUTH2_PROXY_UPSTREAM_TIMEOUT, '120s', 'as long as the server waits for its service')
  assert.deepEqual(env.OAUTH2_PROXY_CLIENT_ID, { secretKeyRef: { name: 'oauth2-proxy-client', key: 'client_id', optional: true } })
  assert.deepEqual(env.OAUTH2_PROXY_CLIENT_SECRET, { secretKeyRef: { name: 'oauth2-proxy-client', key: 'client_secret', optional: true } })
  assert.ok(proxy.args.includes('--cookie-secret-file=/cookie/secret'))
})

test('the Pocket-ID client: spec.json, allowedGroups admin, its secret handed to the reconciler', () => {
  const spec = JSON.parse(readFileSync(join(REPO, 'apps/pocket-id/oidc-reconciler/spec.json'), 'utf8'))
  const client = spec.clients.find((c) => c.name === 'speech-playground')
  assert.deepEqual(client.allowedGroups, ['admin'])
  assert.deepEqual(client.callbackURLs, ['https://speech.bretagne.dev/oidc/callback'])
  assert.deepEqual(client.secret, { namespace: 'speech-playground', name: 'oauth2-proxy-client' })
  const secret = find('Secret', 'oauth2-proxy-client')
  assert.equal(secret.metadata.annotations['kustomize.toolkit.fluxcd.io/ssa'], 'IfNotPresent')
  const role = find('Role', 'oidc-reconciler-oauth2-proxy-client')
  assert.deepEqual(role.rules, [{ apiGroups: [''], resources: ['secrets'], resourceNames: ['oauth2-proxy-client'], verbs: ['get', 'update'] }])
  const binding = find('RoleBinding', 'oidc-reconciler-oauth2-proxy-client')
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'oidc-reconciler', namespace: 'pocket-id' }])
})

test('the Gateway has the https-speech listener', () => {
  const gateway = render(join(REPO, 'infrastructure/gateway')).find((o) => o.kind === 'Gateway')
  const listener = gateway.spec.listeners.find((l) => l.name === 'https-speech')
  assert.deepEqual(listener, {
    name: 'https-speech', port: 8443, protocol: 'HTTPS', hostname: 'speech.bretagne.dev',
    tls: { mode: 'Terminate', certificateRefs: [{ kind: 'Secret', name: 'bretagne-tls' }] },
    allowedRoutes: { namespaces: { from: 'All' } },
  })
})

test('services.json: the cluster STT and TTS, and Xiaomi mimo-v2.5-tts; mounted as the server config', () => {
  const config = JSON.parse(readFileSync(join(WORKLOAD, 'services.json'), 'utf8'))
  const by = (id) => config.services.find((s) => s.id === id)
  assert.equal(by('cluster-stt').type, 'stt')
  assert.equal(by('cluster-stt').url, 'http://stt/v1')
  assert.ok(by('cluster-stt').models.includes('parakeet-tdt-0.6b-v3'))
  assert.ok(by('cluster-stt').models.some((m) => /whisper/.test(m)))
  assert.equal(by('cluster-tts').url, 'http://tts/v1')
  assert.ok(by('cluster-tts').voices.includes('ff_siwis'))
  assert.equal(by('xiaomi-mimo').api, 'mimo')
  assert.equal(by('xiaomi-mimo').url, 'https://api.xiaomimimo.com/v1')
  assert.deepEqual(by('xiaomi-mimo').models, ['mimo-v2.5-tts'])
  assert.equal(by('xiaomi-mimo').voices[0], 'mimo_default')
  assert.equal(find('ConfigMap', 'speech-playground-config').data['services.json'], readFileSync(join(WORKLOAD, 'services.json'), 'utf8'))
})

test('no production host name in the workload: its stt and tts are the bricks beside it in a preview, namespace speech in production', () => {
  const workload = render(WORKLOAD)
  assert.ok(!/\.svc\.cluster\.local|bretagne\.dev/.test(JSON.stringify(workload)), 'a production host name in workload/')
  assert.deepEqual(workload.map((o) => o.kind).sort(), ['ConfigMap', 'ConfigMap', 'Deployment', 'Service'])
  for (const name of ['stt', 'tts']) {
    const s = find('Service', name)
    assert.deepEqual(s.spec, { type: 'ExternalName', externalName: `${name}.speech.svc.cluster.local` })
  }
})

test('production runs the speech bricks in namespace speech only', () => {
  const all = render(join(REPO, 'apps'))
  const bricks = all.filter((o) => o.kind === 'Deployment' && ['stt', 'tts'].includes(o.metadata.name))
  assert.deepEqual(bricks.map((o) => `${o.metadata.namespace}/${o.metadata.name}`).sort(), ['speech/stt', 'speech/tts'])
  const services = all.filter((o) => o.kind === 'Service' && ['stt', 'tts'].includes(o.metadata.name))
  assert.deepEqual(services.map((o) => `${o.metadata.namespace}/${o.metadata.name}`).sort(), ['speech-playground/stt', 'speech-playground/tts', 'speech/stt', 'speech/tts'])
})

test('the preview runs the playground and the speech bricks side by side, with what a preview may hold', () => {
  const preview = render(join(APP, 'preview'))
  assert.ok(preview.every((o) => ['Deployment', 'Service', 'ConfigMap'].includes(o.kind) && !o.metadata.namespace))
  assert.deepEqual(preview.filter((o) => o.kind === 'Deployment').map((o) => o.metadata.name).sort(), ['speech-playground', 'stt', 'tts'])
  const services = Object.fromEntries(preview.filter((o) => o.kind === 'Service').map((o) => [o.metadata.name, o.spec.ports[0].port]))
  assert.deepEqual(services, { 'speech-playground': 8080, stt: 80, tts: 80 })
  const config = JSON.parse(preview.find((o) => o.metadata.name.startsWith('speech-playground-config')).data['services.json'])
  assert.deepEqual(config.services.filter((s) => s.id.startsWith('cluster-')).map((s) => s.url), ['http://stt/v1', 'http://tts/v1'])
  const mi = (q) => Number(q.replace(/Gi$/, '')) * (q.endsWith('Gi') ? 1024 : 1) || Number(q.replace(/Mi$/, ''))
  for (const d of preview.filter((o) => o.kind === 'Deployment')) {
    for (const c of [...(d.spec.template.spec.initContainers ?? []), ...d.spec.template.spec.containers]) {
      const limit = mi(c.resources.limits.memory)
      assert.ok(limit >= 64 && limit <= 7 * 1024, `${d.metadata.name}/${c.name}: memory limit ${c.resources.limits.memory}`)
    }
  }
})

test('the Xiaomi key: an optional Secret volume, read by the server alone, never in its environment', () => {
  const pod = find('Deployment', 'speech-playground').spec.template.spec
  const volume = pod.volumes.find((v) => v.secret)
  assert.deepEqual(volume.secret, { secretName: 'xiaomi-mimo', optional: true })
  const [server] = pod.containers
  assert.ok(server.volumeMounts.some((m) => m.name === volume.name && m.mountPath === '/secrets/xiaomi-mimo'))
  assert.ok(!JSON.stringify(server.env ?? []).includes('xiaomi-mimo') && !server.envFrom)
  const config = JSON.parse(readFileSync(join(WORKLOAD, 'services.json'), 'utf8'))
  assert.equal(config.services.find((s) => s.id === 'xiaomi-mimo').auth.keyFile, '/secrets/xiaomi-mimo/MIMO_API_KEY')
})

test('every container is hardened, bounded and low priority, in a restricted namespace', () => {
  const ns = find('Namespace', 'speech-playground')
  assert.equal(ns.metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted')
  assert.equal(ns.metadata.labels['platform.bretagne.dev/profile'], 'private-app')
  assert.equal(deployments.length, 2)
  for (const d of deployments) {
    const pod = d.spec.template.spec
    assert.equal(pod.priorityClassName, 'bretagne-low', d.metadata.name)
    assert.equal(pod.automountServiceAccountToken, false, d.metadata.name)
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      const where = `${d.metadata.name}/${c.name}`
      const sc = c.securityContext ?? {}
      assert.equal(sc.runAsNonRoot ?? pod.securityContext?.runAsNonRoot, true, where)
      assert.equal((sc.seccompProfile ?? pod.securityContext?.seccompProfile)?.type, 'RuntimeDefault', where)
      assert.equal(sc.readOnlyRootFilesystem, true, where)
      assert.equal(sc.allowPrivilegeEscalation, false, where)
      assert.deepEqual(sc.capabilities, { drop: ['ALL'] }, where)
      assert.ok(c.resources.requests.cpu && c.resources.requests.memory, where)
      assert.ok(c.resources.limits.memory, where)
      assert.equal(c.resources.limits.cpu, undefined, where)
    }
  }
})

test('network policies: in, Traefik through the oauth2-proxy and the probes; out, DNS, speech and api.xiaomimimo.com:443', () => {
  const cnps = objects.filter((o) => o.kind === 'CiliumNetworkPolicy')
  assert.deepEqual(cnps.map((c) => c.metadata.name).sort(), ['default-deny', 'oauth2-proxy', 'speech-playground'])
  const deny = find('CiliumNetworkPolicy', 'default-deny')
  assert.deepEqual(deny.spec, { endpointSelector: {}, ingress: [{}], egress: [{}] })

  const play = find('CiliumNetworkPolicy', 'speech-playground').spec
  assert.deepEqual(play.endpointSelector, { matchLabels: { app: 'speech-playground' } })
  assert.deepEqual(play.ingress, [
    { fromEndpoints: [{ matchLabels: { app: 'oauth2-proxy' } }], toPorts: [{ ports: [{ port: '8080', protocol: 'TCP' }] }] },
    { fromEntities: ['host'], toPorts: [{ ports: [{ port: '8080', protocol: 'TCP' }] }] },
  ])
  assert.deepEqual(play.egress, [
    {
      toEndpoints: [{ matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'kube-system', 'k8s:k8s-app': 'kube-dns' } }],
      toPorts: [{ ports: [{ port: '53', protocol: 'UDP' }, { port: '53', protocol: 'TCP' }], rules: { dns: [{ matchPattern: '*' }] } }],
    },
    { toEndpoints: [{ matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'speech' } }] },
    { toFQDNs: [{ matchName: 'api.xiaomimimo.com' }], toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }] },
  ])

  const proxy = find('CiliumNetworkPolicy', 'oauth2-proxy').spec
  assert.deepEqual(proxy.ingress, [
    { fromEndpoints: [{ matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'traefik' } }], toPorts: [{ ports: [{ port: '4180', protocol: 'TCP' }] }] },
    { fromEntities: ['host'], toPorts: [{ ports: [{ port: '4180', protocol: 'TCP' }] }] },
  ])
  // The proxy reaches the playground on its port and nothing else inside the cluster but DNS and Traefik (for the IdP).
  const inCluster = proxy.egress.filter((e) => e.toEndpoints).map((e) => e.toEndpoints[0].matchLabels)
  assert.deepEqual(inCluster, [
    { 'k8s:io.kubernetes.pod.namespace': 'kube-system', 'k8s:k8s-app': 'kube-dns' },
    { app: 'speech-playground' },
    { 'k8s:io.kubernetes.pod.namespace': 'traefik' },
  ])
})
