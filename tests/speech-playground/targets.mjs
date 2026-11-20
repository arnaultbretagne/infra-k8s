// Where the playground runs for the test (TARGET=local, the only one): the same server.mjs, page and
// services.json as processes on this machine, beside the two fakes, every url rewritten to them; the key is the
// file auth.keyFile names. MUTATE=<name> runs a server with one of MUTATIONS below: the tests that guard what
// it breaks must then fail (mutations.mjs checks which).
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = join(HERE, '../..')
export const APP = join(REPO, 'apps/speech-playground')
export const WORKLOAD = join(APP, 'workload')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// kubectl for kustomize: KUBECTL, else the one ensure-kubectl.mjs fetched into .bin/ (npm test's pretest), else PATH's.
export const KUBECTL = process.env.KUBECTL ?? (existsSync(join(HERE, '.bin/kubectl')) ? join(HERE, '.bin/kubectl') : 'kubectl')

export function render(dir) {
  return parseAllDocuments(execFileSync(KUBECTL, ['kustomize', dir], { encoding: 'utf8', maxBuffer: 64 << 20 }))
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

// Each one undoes a guarantee of server.mjs, by a replacement in its source.
export const MUTATIONS = {
  // No scrubbing at all.
  'no-scrub': ['function scrub(text) {', 'function scrub(text) {\n  return String(text)'],
  // Only the keys the files hold now: the key a request in flight read before a rotation is not scrubbed.
  'scrub-current-only': ['for (const key of [...knownKeys]', 'for (const key of [...services.map((s) => keyOf(s)).filter(Boolean)]'],
  // A stream the service breaks off is ended as if complete.
  'stream-cut-swallowed': ['return res.destroy()', 'return res.end()'],
}

function mutate(serverSource) {
  const name = process.env.MUTATE
  if (!name) return serverSource
  if (!MUTATIONS[name]) throw new Error(`MUTATE=${name}: not one of ${Object.keys(MUTATIONS).join(', ')}`)
  const [from, to] = MUTATIONS[name]
  if (!serverSource.includes(from)) throw new Error(`MUTATE=${name}: ${JSON.stringify(from)} not found in server.mjs`)
  return serverSource.replace(from, to)
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

  const config = JSON.parse(readFileSync(join(WORKLOAD, 'services.json'), 'utf8'))
  mkdirSync(join(dir, 'keys'))
  for (const s of config.services) {
    s.url = s.api === 'mimo' ? `http://127.0.0.1:${mimo}/v1` : `http://127.0.0.1:${openai}/v1`
    if (s.auth) s.auth.keyFile = join(dir, 'keys', s.auth.keyFile.split('/').pop())
  }
  writeFileSync(join(dir, 'services.json'), JSON.stringify(config))
  mkdirSync(join(dir, 'app'))
  for (const f of ['index.html', 'app.js']) copyFileSync(join(WORKLOAD, f), join(dir, 'app', f))
  writeFileSync(join(dir, 'server.mjs'), mutate(readFileSync(join(WORKLOAD, 'server.mjs'), 'utf8')))
  run([join(dir, 'server.mjs')], { CONFIG_FILE: join(dir, 'services.json'), WEB_DIR: join(dir, 'app') }, play)

  const base = `http://127.0.0.1:${play}`
  await Promise.all([waitHttp(`${base}/healthz`), waitHttp(`http://127.0.0.1:${openai}/healthz`), waitHttp(`http://127.0.0.1:${mimo}/healthz`)])
  const mimoService = config.services.find((s) => s.api === 'mimo')
  return {
    name: 'local',
    base,
    fakeOpenai: `http://127.0.0.1:${openai}`,
    fakeMimo: `http://127.0.0.1:${mimo}`,
    keyFile: mimoService.auth.keyFile,
    setKey: async (value = key) => writeFileSync(mimoService.auth.keyFile, `${value}\n`),
    removeKey: async () => rmSync(mimoService.auth.keyFile, { force: true }),
    logs: async () => logs.join(''),
    close: async () => procs.forEach((p) => p.kill()),
  }
}

export const start = (key) => local(key)
