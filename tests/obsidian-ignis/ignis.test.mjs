// Ignis in production (apps/obsidian) and in its preview (apps/ignis/workload), as `kubectl kustomize` renders
// them: the vault and its volume, the init container's cache, no second sync, the gate and its route, the
// network policies, PSS restricted, the secret. The init container's script runs for real, under bash, with
// `curl` and `npx` replaced by stubs that record their calls.
//
// Inputs (environment): KUBECTL, kubectl (default `kubectl`).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse, parseAllDocuments } from 'yaml'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const KUBECTL = process.env.KUBECTL || 'kubectl'
const HOST = 'obsidian.bretagne.dev'
const IMAGE = 'nobbe/ignis:0.9.0'

const build = dir => parseAllDocuments(execFileSync(KUBECTL, ['kustomize', join(REPO, dir)], { encoding: 'utf8' }))
  .map(d => d.toJS()).filter(Boolean)
const prod = build('apps/obsidian')
const preview = build('apps/ignis/workload')
const find = (objs, kind, name) => {
  const o = objs.find(x => x.kind === kind && x.metadata.name === name)
  assert.ok(o, `${kind}/${name} is rendered`)
  return o
}
const pod = d => d.spec.template.spec
const containers = d => [...(pod(d).initContainers || []), ...pod(d).containers]
const env = (c, name) => (c.env || []).find(e => e.name === name)?.value

const ignis = find(prod, 'Deployment', 'ignis')
const server = pod(ignis).containers.find(c => c.name === 'ignis')
const init = pod(ignis).initContainers.find(c => c.name === 'obsidian')
const gate = find(prod, 'Deployment', 'ignis-oauth2-proxy')

describe('the Deployment ignis and the vault (criterion 1)', () => {
  it('runs nobbe/ignis:0.9.0 in every container', () => {
    for (const c of containers(ignis)) assert.equal(c.image, IMAGE, c.name)
  })

  it('takes its volume `data` from the PVC obsidian-data, the MCP server\'s and the clipper\'s', () => {
    const data = pod(ignis).volumes.find(v => v.name === 'data')
    assert.deepEqual(data, { name: 'data', persistentVolumeClaim: { claimName: 'obsidian-data' } })
    for (const name of ['obsidian-mcp', 'web-clipper']) {
      const d = find(prod, 'Deployment', name)
      assert.equal(pod(d).volumes.find(v => v.name === 'data').persistentVolumeClaim.claimName, 'obsidian-data')
      assert.ok(containers(d).some(c => c.volumeMounts.some(m => m.name === 'data' && m.subPath === 'vault')), name)
    }
  })

  it('mounts obsidian-data three ways: the vault, its settings, the Obsidian cache', () => {
    const mounts = server.volumeMounts.filter(m => m.name === 'data')
    assert.deepEqual(mounts.map(m => m.subPath).sort(), ['ignis-data', 'obsidian-app', 'vault'])
    const vault = mounts.find(m => m.subPath === 'vault')
    assert.equal(vault.mountPath, '/vaults/Arvault', 'the vault is named Arvault in Ignis')
    assert.ok(!vault.readOnly)
    assert.equal(mounts.find(m => m.subPath === 'ignis-data').mountPath, env(server, 'DATA_ROOT'))
    const cache = mounts.find(m => m.subPath === 'obsidian-app')
    assert.equal(cache.mountPath, env(server, 'OBSIDIAN_ASSETS_PATH'))
    assert.equal(cache.readOnly, true)
    // The init container fills the same cache, and touches nothing else of the PVC.
    assert.deepEqual(init.volumeMounts.filter(m => m.name === 'data'), [{ name: 'data', mountPath: cache.mountPath, subPath: 'obsidian-app' }])
  })

  it('opens that folder as its only vault: VAULT_ROOT holds one link to it, read-only for the server', () => {
    const vault = server.volumeMounts.find(m => m.subPath === 'vault').mountPath
    const root = env(server, 'VAULT_ROOT')
    assert.equal(server.volumeMounts.find(m => m.mountPath === root).readOnly, true)
    assert.equal(server.volumeMounts.filter(m => m.mountPath.startsWith('/vaults/')).length, 1)
    assert.ok(!env(server, 'AUTO_CREATE_DEFAULT'), 'no default vault is created')
    const script = init.command.at(-1)
    assert.ok(script.includes(`ln -sfn ${vault} ${root}/${vault.split('/').pop()}`), 'the init container links the vault')
  })

  it('runs a single copy (Recreate): two servers would write the same files', () => {
    assert.equal(ignis.spec.replicas, 1)
    assert.equal(ignis.spec.strategy.type, 'Recreate')
  })
})

describe('the init container downloads Obsidian only when the cache lacks the pinned version (criterion 2)', () => {
  const work = mkdtempSync(join(tmpdir(), 'ignis-init-'))
  after(() => rmSync(work, { recursive: true, force: true }))
  const cacheDir = init.volumeMounts.find(m => m.subPath === 'obsidian-app').mountPath
  const indexDir = init.volumeMounts.find(m => m.name === 'vault-index').mountPath

  // The script as rendered, its three directories moved into the test's own.
  const setup = name => {
    const root = join(work, name)
    for (const d of ['app', 'index', 'tmp', 'bin']) mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, 'bin', 'curl'), `#!/bin/bash\necho "curl $*" >> "${root}/calls"\n[ -f "${root}/curl-fails" ] && exit 22\nprintf 'asar' | gzip\n`)
    writeFileSync(join(root, 'bin', 'npx'), `#!/bin/bash\necho "npx $*" >> "${root}/calls"\nmkdir -p "$5" && echo '<html>' > "$5/index.html"\n`)
    for (const b of ['curl', 'npx']) chmodSync(join(root, 'bin', b), 0o755)
    return root
  }
  const run = (root, pin = '1.14.4') => {
    const script = init.command.at(-1)
      .replaceAll('/tmp/obsidian.asar', join(root, 'tmp', 'obsidian.asar'))
      .replaceAll(cacheDir, join(root, 'app'))
      .replaceAll(` ${indexDir}/`, ` ${join(root, 'index')}/`)
    const r = spawnSync(init.command[0], [...init.command.slice(1, -1), script], {
      encoding: 'utf8',
      env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, IGNIS_OBSIDIAN_PIN: pin, HOME: join(root, 'tmp') },
    })
    const calls = existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') : []
    rmSync(join(root, 'calls'), { force: true })
    return { ...r, calls }
  }
  const URL = 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.14.4/obsidian-1.14.4.asar.gz'

  it('an empty cache: downloads the pinned release, unpacks it, stamps it, links the vault', () => {
    const root = setup('empty')
    const r = run(root)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.calls.length, 2)
    assert.equal(r.calls[0], `curl -fsSL ${URL}`)
    assert.match(r.calls[1], /^npx --yes @electron\/asar@4\.3\.2 extract /)
    assert.equal(readFileSync(join(root, 'app', '.obsidian-version'), 'utf8'), '1.14.4\n')
    assert.ok(existsSync(join(root, 'app', 'index.html')))
    assert.equal(readlinkSync(join(root, 'index', 'Arvault')), '/vaults/Arvault')
    assert.deepEqual(readdirSync(join(root, 'index')), ['Arvault'], 'the index holds that one vault only')
  })

  it('the pinned version already in the cache: downloads nothing, keeps the cache as it is', () => {
    const root = setup('cached')
    assert.equal(run(root).status, 0)
    writeFileSync(join(root, 'app', 'kept'), 'x')
    const r = run(root)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.calls, [])
    assert.match(r.stdout, /Obsidian 1\.14\.4 already in the cache/)
    assert.ok(existsSync(join(root, 'app', 'kept')))
    assert.equal(readlinkSync(join(root, 'index', 'Arvault')), '/vaults/Arvault')
  })

  it('another version in the cache (an image bump): clears it, downloads the new pin', () => {
    const root = setup('older')
    writeFileSync(join(root, 'app', 'index.html'), 'old')
    writeFileSync(join(root, 'app', '.obsidian-version'), '1.12.7\n')
    writeFileSync(join(root, 'app', 'stale.js'), 'old')
    const r = run(root)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.calls[0], `curl -fsSL ${URL}`)
    assert.ok(!existsSync(join(root, 'app', 'stale.js')))
    assert.equal(readFileSync(join(root, 'app', '.obsidian-version'), 'utf8'), '1.14.4\n')
  })

  it('a cache left half-written (stamp without index.html): downloads again', () => {
    const root = setup('partial')
    writeFileSync(join(root, 'app', '.obsidian-version'), '1.14.4\n')
    const r = run(root)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.calls[0], `curl -fsSL ${URL}`)
  })

  it('a failed download: the container fails, and no stamp claims the version is there', () => {
    const root = setup('failed')
    writeFileSync(join(root, 'curl-fails'), '')
    const r = run(root)
    assert.notEqual(r.status, 0)
    assert.ok(!existsSync(join(root, 'app', '.obsidian-version')))
  })
})

describe('no second sync client (criterion 3)', () => {
  it('nothing installs or runs obsidian-headless or `ob`, and the image\'s root entrypoint never runs', () => {
    for (const c of containers(ignis)) {
      assert.ok(c.command?.length, `${c.name} sets its command, so the image entrypoint (npm install -g obsidian-headless) is not run`)
      const line = [...c.command, ...(c.args || [])].join(' ')
      assert.doesNotMatch(line, /obsidian-headless|\bob (sync|login)|npm (i|install)\b/, c.name)
      assert.equal(c.securityContext.readOnlyRootFilesystem, true, `${c.name}: nothing can be installed globally`)
    }
  })

  // Two sync clients on one vault once deleted 446 files. Obsidian Sync leaves in its own pull request
  // (fix/obsidian-remove-sync), merged before this one; until then this fails, and nothing should merge.
  it('the build renders no obsidian-sync object: Sync and Ignis never run together', () => {
    const sync = prod.filter(o => /obsidian-sync/.test(o.metadata.name) || /obsidian-sync/.test(JSON.stringify(o.spec?.selector ?? {})))
    assert.deepEqual(sync.map(o => `${o.kind}/${o.metadata.name}`), [], 'merge fix/obsidian-remove-sync first, then update this branch')
  })
})

describe('the route and the gate (criterion 4)', () => {
  it('HTTPRoute obsidian.bretagne.dev on https-obsidian, with HSTS, to the gate only', () => {
    const routes = prod.filter(o => o.kind === 'HTTPRoute' && o.spec.hostnames.includes(HOST))
    assert.equal(routes.length, 1)
    const [route] = routes
    assert.deepEqual(route.spec.parentRefs, [{ name: 'bretagne-gateway', namespace: 'traefik', sectionName: 'https-obsidian' }])
    assert.deepEqual(route.spec.hostnames, [HOST])
    for (const rule of route.spec.rules) {
      assert.deepEqual(rule.backendRefs, [{ name: 'ignis-oauth2-proxy', port: 4180 }])
      const hsts = rule.filters.find(f => f.type === 'ResponseHeaderModifier').responseHeaderModifier.set
      assert.deepEqual(hsts, [{ name: 'Strict-Transport-Security', value: 'max-age=86400; includeSubDomains' }])
    }
  })

  it('the listener https-obsidian exists on the shared Gateway, for this host, open to the obsidian namespace only', () => {
    const gw = parse(readFileSync(join(REPO, 'infrastructure/gateway/gateway.yaml'), 'utf8'))
    const l = gw.spec.listeners.find(x => x.name === 'https-obsidian')
    assert.equal(l.hostname, HOST)
    assert.equal(l.protocol, 'HTTPS')
    assert.equal(l.tls.certificateRefs[0].name, 'bretagne-tls')
    assert.deepEqual(l.allowedRoutes.namespaces, { from: 'Selector', selector: { matchLabels: { 'kubernetes.io/metadata.name': 'obsidian' } } })
  })

  it('the gate: oauth2-proxy, ALLOWED_GROUPS=admin, in front of the Service ignis', () => {
    const c = pod(gate).containers[0]
    assert.match(c.image, /^quay\.io\/oauth2-proxy\/oauth2-proxy:v/)
    assert.equal(env(c, 'OAUTH2_PROXY_ALLOWED_GROUPS'), 'admin')
    assert.match(env(c, 'OAUTH2_PROXY_SCOPE'), /\bgroups\b/)
    assert.equal(env(c, 'OAUTH2_PROXY_UPSTREAMS'), 'http://ignis.obsidian.svc.cluster.local:8080')
    assert.equal(env(c, 'OAUTH2_PROXY_REDIRECT_URL'), `https://${HOST}/oidc/callback`)
    assert.equal(c.envFrom[0].secretRef.name, 'ignis-oauth2-proxy')
    const svc = find(prod, 'Service', 'ignis')
    assert.deepEqual(svc.spec.selector, { app: 'ignis' })
    assert.equal(svc.spec.ports[0].port, 8080)
  })

  it('the Pocket-ID client `ignis` in spec.json: admin only, the gate\'s callback', () => {
    const spec = JSON.parse(readFileSync(join(REPO, 'apps/pocket-id/oidc-reconciler/spec.json'), 'utf8'))
    const client = spec.clients.filter(c => c.name === 'ignis')
    assert.equal(client.length, 1)
    assert.deepEqual(client[0].allowedGroups, ['admin'])
    assert.deepEqual(client[0].callbackURLs, [env(pod(gate).containers[0], 'OAUTH2_PROXY_REDIRECT_URL')])
    assert.ok(!client[0].isPublic)
    assert.ok(spec.groups.some(g => g.name === 'admin'))
  })
})

describe('WS_ORIGINS (criterion 5)', () => {
  it('is https://obsidian.bretagne.dev in production', () => {
    assert.equal(env(server, 'WS_ORIGINS'), `https://${HOST}`)
  })
})

describe('network policies (criterion 6)', () => {
  const ign = find(prod, 'CiliumNetworkPolicy', 'ignis')
  const gp = find(prod, 'CiliumNetworkPolicy', 'ignis-oauth2-proxy')
  const DNS = { matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'kube-system', 'k8s:k8s-app': 'kube-dns' } }
  const ports = r => r.toPorts.flatMap(p => p.ports.map(x => `${x.port}/${x.protocol}`)).sort()

  it('Ignis accepts its gate only', () => {
    assert.deepEqual(ign.spec.ingress, [{ fromEndpoints: [{ matchLabels: { app: 'ignis-oauth2-proxy' } }], toPorts: [{ ports: [{ port: '8080', protocol: 'TCP' }] }] }])
    assert.deepEqual(pod(gate).containers[0].ports, [{ containerPort: 4180 }])
  })

  it('the gate accepts Traefik only', () => {
    assert.deepEqual(gp.spec.ingress, [{ fromEndpoints: [{ matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'traefik' } }], toPorts: [{ ports: [{ port: '4180', protocol: 'TCP' }] }] }])
  })

  it('Ignis goes out to DNS and to 443, nothing else', () => {
    assert.equal(ign.spec.egress.length, 2)
    const [dns, out] = ign.spec.egress
    assert.deepEqual(dns.toEndpoints, [DNS])
    assert.deepEqual(ports(dns), ['53/TCP', '53/UDP'])
    assert.deepEqual(out, { toEntities: ['world'], toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }] })
  })

  it('the gate goes out to DNS, Ignis, and id.bretagne.dev on 443 (its public address, or its in-cluster paths to Traefik)', () => {
    const [dns, toIgnis, idp, traefik] = gp.spec.egress
    assert.equal(gp.spec.egress.length, 4)
    assert.deepEqual(dns.toEndpoints, [DNS])
    assert.deepEqual(toIgnis.toEndpoints, [{ matchLabels: { app: 'ignis' } }])
    assert.deepEqual(ports(toIgnis), ['8080/TCP'])
    assert.deepEqual(idp.toEntities, ['world', 'host'])
    assert.deepEqual(ports(idp), ['443/TCP'])
    assert.deepEqual(traefik.toEndpoints, [{ matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'traefik' } }])
    assert.deepEqual(ports(traefik), ['8443/TCP'])
  })

  it('neither reaches flux-system, the kube-apiserver or the whole cluster; the world on 443 only', () => {
    for (const p of [ign, gp]) {
      const s = JSON.stringify(p.spec.egress)
      assert.doesNotMatch(s, /flux-system|kube-apiserver|"all"|"cluster"|"remote-node"|0\.0\.0\.0/)
      for (const r of p.spec.egress) if (r.toEntities?.includes('world')) assert.deepEqual(ports(r), ['443/TCP'])
      for (const r of p.spec.egress) for (const e of r.toEndpoints || []) assert.notDeepEqual(e, {}, 'no empty selector')
    }
  })

  it("no toFQDNs and no DNS rule: Cilium's DNS proxy is dropped by the node's firewall (docs/hosting-an-app.md)", () => {
    for (const p of [ign, gp]) {
      assert.doesNotMatch(JSON.stringify(p.spec.egress), /toFQDNs/)
      assert.equal(p.spec.egress[0].toPorts[0].rules, undefined)
    }
  })
})

describe('PSS restricted and resources (criterion 7)', () => {
  const deployments = [['production', ignis], ['production', gate], ['preview', find(preview, 'Deployment', 'ignis')]]
  for (const [where, d] of deployments) {
    for (const c of containers(d)) {
      it(`${where} ${d.metadata.name}/${c.name}`, () => {
        const s = c.securityContext
        assert.equal(s.runAsNonRoot, true)
        assert.equal(s.allowPrivilegeEscalation, false)
        assert.deepEqual(s.capabilities.drop, ['ALL'])
        assert.ok(!s.capabilities.add)
        assert.equal(s.readOnlyRootFilesystem, true)
        assert.equal(s.seccompProfile.type, 'RuntimeDefault')
        assert.ok(!s.privileged)
        assert.ok(c.resources.requests.cpu && c.resources.requests.memory)
        assert.ok(c.resources.limits.memory)
        assert.equal(pod(d).securityContext.seccompProfile.type, 'RuntimeDefault')
        assert.equal(pod(d).automountServiceAccountToken, false)
        assert.ok(!pod(d).hostNetwork && !pod(d).hostPID && !pod(d).hostIPC)
      })
    }
  }

  it('the namespace enforces PSS restricted', () => {
    assert.equal(find(prod, 'Namespace', 'obsidian').metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted')
  })
})

describe('the gate\'s secret (criterion 8)', () => {
  const file = readFileSync(join(REPO, 'apps/obsidian/ignis-oauth2-proxy.secrets.yaml'), 'utf8')
  const doc = parse(file)

  it('is SOPS-encrypted to the repository\'s age key, every value', () => {
    assert.equal(doc.kind, 'Secret')
    assert.equal(doc.metadata.name, 'ignis-oauth2-proxy')
    assert.deepEqual(Object.keys(doc.stringData).sort(), ['OAUTH2_PROXY_CLIENT_ID', 'OAUTH2_PROXY_CLIENT_SECRET', 'OAUTH2_PROXY_COOKIE_SECRET'])
    for (const [k, v] of Object.entries(doc.stringData)) assert.match(v, /^ENC\[AES256_GCM,data:.+,type:str\]$/, k)
    assert.ok(!doc.data)
    const sops = parse(readFileSync(join(REPO, '.sops.yaml'), 'utf8')).creation_rules[0]
    assert.equal(doc.sops.age[0].recipient, sops.age)
    assert.equal(doc.sops.encrypted_regex, sops.encrypted_regex)
    assert.ok(doc.sops.mac.startsWith('ENC['))
  })

  it('is what the gate reads, and is listed in the build', () => {
    assert.equal(find(prod, 'Secret', 'ignis-oauth2-proxy').type, 'Opaque')
  })
})

describe('the preview (catalogue entry ignis) can still apply apps/ignis/workload', () => {
  const entry = parse(readFileSync(join(REPO, 'infrastructure/configs/previews/catalogue/ignis.yaml'), 'utf8')).spec.defaultValues

  it('holds only a Deployment and a Service', () => {
    assert.equal(entry.path, 'apps/ignis/workload')
    assert.deepEqual(preview.map(o => o.kind).sort(), ['Deployment', 'Service'])
  })

  it('names the Deployment, the container, the Service and the port the entry expects', () => {
    const d = find(preview, 'Deployment', entry.urlDeployment)
    assert.ok(pod(d).containers.some(c => c.name === entry.urlContainer && env(c, entry.urlEnv)))
    assert.equal(String(find(preview, 'Service', entry.service).spec.ports[0].port), entry.port)
  })

  it('gets no PVC: its `data` is an emptyDir', () => {
    const d = find(preview, 'Deployment', 'ignis')
    assert.ok(pod(d).volumes.every(v => v.emptyDir && !v.persistentVolumeClaim))
  })

  it('every container has a memory limit between 64Mi and the entry\'s containerMemoryMax', () => {
    const mi = q => q.endsWith('Gi') ? parseFloat(q) * 1024 : parseFloat(q)
    for (const c of containers(find(preview, 'Deployment', 'ignis'))) {
      const m = mi(c.resources.limits.memory)
      assert.ok(m >= 64 && m <= mi(entry.containerMemoryMax), `${c.name}: ${c.resources.limits.memory}`)
    }
  })

  it('production differs from it by the volume only', () => {
    const strip = d => JSON.stringify({ ...d, metadata: { name: d.metadata.name }, spec: { ...d.spec, template: { ...d.spec.template, spec: { ...pod(d), volumes: pod(d).volumes.filter(v => v.name !== 'data') } } } })
    assert.equal(strip(ignis), strip(find(preview, 'Deployment', 'ignis')))
  })
})
