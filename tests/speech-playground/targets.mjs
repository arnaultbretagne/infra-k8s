// Where the playground runs for the test (TARGET):
// - kind: what apps/speech-playground renders, applied to a kind cluster (ci.sh makes it), beside the two fakes:
//   fake-openai as stt.speech and tts.speech (the addresses services.json names), fake-mimo in fake-xiaomi. Two
//   changes to the render, both test-only: services.json's Xiaomi url points at fake-mimo, and oauth2-proxy skips
//   OIDC discovery (no IdP in kind; it only has to redirect). The key is a Secret xiaomi-mimo, created mid-test.
// - local: the same server.mjs, page and services.json as processes on this machine, the fakes beside them, every
//   url rewritten to them; the key is the file auth.keyFile names. MUTATE=no-scrub runs a server whose scrub() does
//   nothing: the leak test must then fail.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments, stringify } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = join(HERE, '../..')
export const APP = join(REPO, 'apps/speech-playground')
const NODE_IMAGE = 'node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function render(dir) {
  return parseAllDocuments(execFileSync('kubectl', ['kustomize', dir], { encoding: 'utf8', maxBuffer: 64 << 20 }))
    .map((d) => d.toJS())
    .filter(Boolean)
}

async function waitHttp(url, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    if (Date.now() > end) throw new Error(`${url} never answered`)
    await sleep(300)
  }
}

function mutate(serverSource) {
  if (process.env.MUTATE !== 'no-scrub') return serverSource
  const mutated = serverSource.replace('function scrub(text) {', 'function scrub(text) {\n  return String(text)')
  if (mutated === serverSource) throw new Error('MUTATE=no-scrub: scrub() not found in server.mjs')
  return mutated
}

// --- local --------------------------------------------------------------------------------------

async function local(key) {
  const dir = mkdtempSync(join(tmpdir(), 'speech-playground-'))
  const procs = []
  const logs = []
  const run = (args, env, port) => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout.on('data', (d) => logs.push(String(d)))
    p.stderr.on('data', (d) => logs.push(String(d)))
    procs.push(p)
  }
  const first = 20000 + Math.floor(Math.random() * 20000)
  const [play, openai, mimo] = [first, first + 1, first + 2]
  run([join(HERE, 'fake-openai.mjs')], { FAKE_SERVE: '1' }, openai)
  run([join(HERE, 'fake-mimo.mjs')], { FAKE_SERVE: '1', MIMO_EXPECTED_KEY: key }, mimo)

  const config = JSON.parse(readFileSync(join(APP, 'services.json'), 'utf8'))
  mkdirSync(join(dir, 'keys'))
  for (const s of config.services) {
    s.url = s.api === 'mimo' ? `http://127.0.0.1:${mimo}/v1` : `http://127.0.0.1:${openai}/v1`
    if (s.auth) s.auth.keyFile = join(dir, 'keys', s.auth.keyFile.split('/').pop())
  }
  writeFileSync(join(dir, 'services.json'), JSON.stringify(config))
  mkdirSync(join(dir, 'app'))
  for (const f of ['index.html', 'app.js']) copyFileSync(join(APP, f), join(dir, 'app', f))
  writeFileSync(join(dir, 'server.mjs'), mutate(readFileSync(join(APP, 'server.mjs'), 'utf8')))
  run([join(dir, 'server.mjs')], { CONFIG_FILE: join(dir, 'services.json'), WEB_DIR: join(dir, 'app') }, play)

  const base = `http://127.0.0.1:${play}`
  await Promise.all([waitHttp(`${base}/healthz`), waitHttp(`http://127.0.0.1:${openai}/healthz`), waitHttp(`http://127.0.0.1:${mimo}/healthz`)])
  const mimoService = config.services.find((s) => s.api === 'mimo')
  return {
    name: 'local',
    base,
    fakeOpenai: `http://127.0.0.1:${openai}`,
    fakeMimo: `http://127.0.0.1:${mimo}`,
    setKey: async () => writeFileSync(mimoService.auth.keyFile, `${key}\n`),
    logs: async () => logs.join(''),
    close: async () => procs.forEach((p) => p.kill()),
  }
}

// --- kind ---------------------------------------------------------------------------------------

export const kubectl = (...args) => execFileSync('kubectl', args, { encoding: 'utf8', maxBuffer: 64 << 20 })
const apply = (objects) =>
  execFileSync('kubectl', ['apply', '-f', '-'], { input: objects.map((o) => stringify(o)).join('---\n'), encoding: 'utf8' })

async function portForward(namespace, target, port) {
  const p = spawn('kubectl', ['-n', namespace, 'port-forward', target, `:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const local = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`port-forward ${target}: ${out}`)), 30000)
    p.stdout.on('data', (d) => {
      out += d
      const m = /127\.0\.0\.1:(\d+)/.exec(out)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    p.stderr.on('data', (d) => { out += d })
    p.on('exit', () => reject(new Error(`port-forward ${target} exited: ${out}`)))
  })
  return { url: `http://127.0.0.1:${local}`, close: () => p.kill() }
}

function fake(namespace, name, file, env = {}, services = [name]) {
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace }, data: { [file]: readFileSync(join(HERE, file), 'utf8') } },
    {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace },
      spec: {
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [{
              name, image: NODE_IMAGE, command: ['node', `/fake/${file}`],
              env: [{ name: 'FAKE_SERVE', value: '1' }, ...Object.entries(env).map(([k, v]) => ({ name: k, ...v }))],
              ports: [{ containerPort: 8080 }],
              readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 2 },
              volumeMounts: [{ name: 'fake', mountPath: '/fake' }],
            }],
            volumes: [{ name: 'fake', configMap: { name } }],
          },
        },
      },
    },
    ...services.map((s) => ({
      apiVersion: 'v1', kind: 'Service', metadata: { name: s, namespace },
      spec: { selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] },
    })),
  ]
}

// The render, as the test applies it: see the header.
export function renderForKind() {
  const objects = render(APP).filter((o) => !(o.kind === 'Secret' && o.metadata.name === 'xiaomi-mimo'))
  for (const o of objects) {
    if (o.kind === 'ConfigMap' && o.metadata.name.startsWith('speech-playground-config')) {
      const config = JSON.parse(o.data['services.json'])
      for (const s of config.services) if (s.api === 'mimo') s.url = 'http://mimo.fake-xiaomi.svc.cluster.local/v1'
      o.data['services.json'] = JSON.stringify(config, null, 2)
    }
    if (o.kind === 'Deployment' && o.metadata.name === 'oauth2-proxy') {
      o.spec.template.spec.containers[0].env.push(
        { name: 'OAUTH2_PROXY_SKIP_OIDC_DISCOVERY', value: 'true' },
        { name: 'OAUTH2_PROXY_LOGIN_URL', value: 'https://id.bretagne.dev/authorize' },
        { name: 'OAUTH2_PROXY_REDEEM_URL', value: 'https://id.bretagne.dev/api/oidc/token' },
        { name: 'OAUTH2_PROXY_OIDC_JWKS_URL', value: 'https://id.bretagne.dev/.well-known/jwks.json' },
      )
    }
  }
  return objects
}

async function kind(key) {
  if (process.env.MUTATE) throw new Error('MUTATE runs on TARGET=local only')
  kubectl('apply', '-k', join(REPO, 'infrastructure/configs/priorityclasses'))
  apply([
    ...fake('speech', 'fake-openai', 'fake-openai.mjs', {}, ['stt', 'tts']),
    ...fake('fake-xiaomi', 'mimo', 'fake-mimo.mjs', { MIMO_EXPECTED_KEY: { valueFrom: { secretKeyRef: { name: 'mimo-expected', key: 'key' } } } }),
  ])
  kubectl('-n', 'fake-xiaomi', 'create', 'secret', 'generic', 'mimo-expected', `--from-literal=key=${key}`)
  apply(renderForKind())
  for (const [ns, d] of [['speech', 'fake-openai'], ['fake-xiaomi', 'mimo'], ['speech-playground', 'speech-playground']]) {
    kubectl('-n', ns, 'rollout', 'status', `deployment/${d}`, '--timeout=180s')
  }
  const forwards = await Promise.all([
    portForward('speech-playground', 'svc/speech-playground', 8080),
    portForward('speech', 'svc/stt', 80),
    portForward('fake-xiaomi', 'svc/mimo', 80),
  ])
  return {
    name: 'kind',
    base: forwards[0].url,
    fakeOpenai: forwards[1].url,
    fakeMimo: forwards[2].url,
    setKey: async () => kubectl('-n', 'speech-playground', 'create', 'secret', 'generic', 'xiaomi-mimo', `--from-literal=MIMO_API_KEY=${key}`),
    logs: async () => kubectl('-n', 'speech-playground', 'logs', 'deployment/speech-playground', '--all-containers'),
    portForward,
    close: async () => forwards.forEach((f) => f.close()),
  }
}

export const start = (key) => ((process.env.TARGET ?? 'local') === 'kind' ? kind(key) : local(key))
