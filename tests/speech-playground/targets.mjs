// Where the playground runs for the test (TARGET=local, the only one): the same server.mjs, page and
// services.json as processes on this machine, beside the two fakes, every url rewritten to them; the key is the
// file auth.keyFile names. MUTATE=no-scrub runs a server whose scrub() does nothing: the leak test must then fail.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = join(HERE, '../..')
export const APP = join(REPO, 'apps/speech-playground')
export const WORKLOAD = join(APP, 'workload')
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
    setKey: async () => writeFileSync(mimoService.auth.keyFile, `${key}\n`),
    logs: async () => logs.join(''),
    close: async () => procs.forEach((p) => p.kill()),
  }
}

export const start = (key) => local(key)
