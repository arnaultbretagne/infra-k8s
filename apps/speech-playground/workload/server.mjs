// The speech playground's server: Node's standard library only, run from a ConfigMap on the public
// node image (no build, no dependency). It serves the page, lists the services of services.json,
// and relays each STT or TTS request to the service the page names. Keys stay here: read from their
// file on every request, sent upstream only, scrubbed from anything relayed back to the browser.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

const PORT = Number(process.env.PORT || 8080)
const CONFIG_FILE = process.env.CONFIG_FILE || '/config/services.json'
const WEB_DIR = process.env.WEB_DIR || '/app'
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000)
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_TEXT_CHARS = 5000

const services = loadServices(CONFIG_FILE)

function loadServices(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(config.services)) throw new Error(`${file}: "services" must be a list`)
  const seen = new Set()
  for (const s of config.services) {
    const where = `${file}: service ${JSON.stringify(s.id)}`
    if (typeof s.id !== 'string' || !s.id || seen.has(s.id)) throw new Error(`${where}: id must be a unique string`)
    seen.add(s.id)
    if (s.type !== 'stt' && s.type !== 'tts') throw new Error(`${where}: type must be stt or tts`)
    s.api ??= 'openai'
    if (s.api !== 'openai' && !(s.api === 'mimo' && s.type === 'tts')) throw new Error(`${where}: api must be openai, or mimo for a tts`)
    if (!/^https?:\/\//.test(s.url ?? '')) throw new Error(`${where}: url must be http(s)`)
    s.url = s.url.replace(/\/+$/, '')
    if (!Array.isArray(s.models) || s.models.length === 0) throw new Error(`${where}: models must be a non-empty list`)
    if (s.type === 'tts' && (!Array.isArray(s.voices) || s.voices.length === 0)) throw new Error(`${where}: a tts needs voices`)
    if (s.auth && (typeof s.auth.header !== 'string' || typeof s.auth.keyFile !== 'string')) throw new Error(`${where}: auth needs header and keyFile`)
  }
  return config.services
}

// Every key this process has read, the current ones and those rotated away or removed since: a request
// keeps the key it read when it started, and what its service answers may echo that key back.
const knownKeys = new Set()

// The key of a service, read fresh: a Secret mounted later, or rotated, is seen without a restart.
function keyOf(service) {
  if (!service.auth) return null
  let key
  try {
    key = readFileSync(service.auth.keyFile, 'utf8').trim() || undefined
  } catch {
    key = undefined
  }
  if (key) knownKeys.add(key)
  return key
}

// Every key the server has held, scrubbed from what goes back to the browser, the longest first so that
// a key containing another is scrubbed whole.
function scrub(text) {
  let out = String(text)
  for (const key of [...knownKeys].sort((a, b) => b.length - a.length)) out = out.split(key).join('[redacted]')
  return out
}

function publicView(s) {
  const available = keyOf(s) !== undefined
  return {
    id: s.id,
    label: s.label ?? s.id,
    type: s.type,
    models: s.models,
    ...(s.type === 'tts' ? { voices: s.voices } : {}),
    available,
    ...(available ? {} : { reason: 'its API key is not configured (Secret missing)' }),
  }
}

function sendJson(res, status, body) {
  const data = Buffer.from(scrub(JSON.stringify(body)))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' })
  res.end(data)
}

function fail(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra })
}

function upstreamHeaders(service, key, extra = {}) {
  const headers = { ...extra }
  if (service.auth && key) headers[service.auth.header] = (service.auth.prefix ?? '') + key
  return headers
}

function pick(type, id, res) {
  const service = services.find((s) => s.id === id && s.type === type)
  if (!service) return fail(res, 404, `no ${type} service ${JSON.stringify(id)}`)
  const key = keyOf(service)
  if (key === undefined) return fail(res, 503, `${service.label ?? service.id} is unavailable: its API key is not configured`)
  return { service, key }
}

async function readUpstreamError(r) {
  const body = await r.text().catch(() => '')
  return scrub(body).slice(0, 2000)
}

async function stt(req, res) {
  const length = Number(req.headers['content-length'] || 0)
  if (length > MAX_UPLOAD_BYTES) return fail(res, 413, `audio larger than ${MAX_UPLOAD_BYTES} bytes`)
  let form
  try {
    form = await new Request('http://playground/', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      body: Readable.toWeb(req),
      duplex: 'half',
    }).formData()
  } catch {
    return fail(res, 400, 'expected multipart/form-data with service, model and file')
  }
  const picked = pick('stt', form.get('service'), res)
  if (!picked) return
  const { service, key } = picked
  const model = form.get('model')
  if (!service.models.includes(model)) return fail(res, 400, `model ${JSON.stringify(model)} is not one of ${service.id}'s`)
  const file = form.get('file')
  if (!(file instanceof Blob) || file.size === 0) return fail(res, 400, 'no audio file')
  if (file.size > MAX_UPLOAD_BYTES) return fail(res, 413, `audio larger than ${MAX_UPLOAD_BYTES} bytes`)

  const upstream = new FormData()
  upstream.append('file', file, file.name || 'audio')
  upstream.append('model', model)
  const language = form.get('language')
  if (typeof language === 'string' && /^[a-z]{2,3}$/.test(language)) upstream.append('language', language)

  const started = performance.now()
  let r
  try {
    r = await fetch(`${service.url}/audio/transcriptions`, {
      method: 'POST',
      headers: upstreamHeaders(service, key),
      body: upstream,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (e) {
    return fail(res, 502, `${service.id} did not answer: ${e.cause?.code ?? e.name}`)
  }
  let body
  try {
    body = await r.text()
  } catch (e) {
    return fail(res, 502, `${service.id} broke off its answer: ${e.cause?.code ?? e.message}`)
  }
  const upstreamMs = Math.round(performance.now() - started)
  if (!r.ok) return fail(res, 502, `${service.id} answered ${r.status}`, { upstream: { status: r.status, ms: upstreamMs, body: scrub(body).slice(0, 2000) } })
  let text = body
  try {
    const parsed = JSON.parse(body)
    if (typeof parsed.text === 'string') text = parsed.text
  } catch {}
  sendJson(res, 200, { service: service.id, model, text, upstream: { status: r.status, ms: upstreamMs } })
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function tts(req, res) {
  let body
  try {
    body = await readJson(req)
  } catch {
    return fail(res, 400, 'expected a JSON body {service, model, voice, input}')
  }
  const picked = pick('tts', body.service, res)
  if (!picked) return
  const { service, key } = picked
  if (!service.models.includes(body.model)) return fail(res, 400, `model ${JSON.stringify(body.model)} is not one of ${service.id}'s`)
  if (!service.voices.includes(body.voice)) return fail(res, 400, `voice ${JSON.stringify(body.voice)} is not one of ${service.id}'s`)
  const input = typeof body.input === 'string' ? body.input.trim() : ''
  if (!input) return fail(res, 400, 'no text to read')
  if (input.length > MAX_TEXT_CHARS) return fail(res, 400, `text longer than ${MAX_TEXT_CHARS} characters`)

  const started = performance.now()
  const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  let r
  try {
    if (service.api === 'mimo') {
      // Xiaomi MiMo: the text to read is the assistant's message; the audio comes back whole, base64,
      // in choices[0].message.audio.data.
      r = await fetch(`${service.url}/chat/completions`, {
        method: 'POST',
        headers: upstreamHeaders(service, key, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          model: body.model,
          messages: [{ role: 'assistant', content: input }],
          audio: { format: service.format ?? 'wav', voice: body.voice },
        }),
        signal,
      })
    } else {
      r = await fetch(`${service.url}/audio/speech`, {
        method: 'POST',
        headers: upstreamHeaders(service, key, { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: body.model, voice: body.voice, input, response_format: service.format ?? 'mp3' }),
        signal,
      })
    }
  } catch (e) {
    return fail(res, 502, `${service.id} did not answer: ${e.cause?.code ?? e.name}`)
  }
  const headersMs = Math.round(performance.now() - started)
  if (!r.ok) {
    const upstreamBody = await readUpstreamError(r)
    return fail(res, 502, `${service.id} answered ${r.status}`, { upstream: { status: r.status, ms: headersMs, body: upstreamBody } })
  }

  if (service.api === 'mimo') {
    let audio
    try {
      const json = await r.json()
      audio = Buffer.from(json.choices[0].message.audio.data, 'base64')
    } catch {
      return fail(res, 502, `${service.id} answered without audio`)
    }
    const upstreamMs = Math.round(performance.now() - started)
    res.writeHead(200, {
      'content-type': `audio/${service.format ?? 'wav'}`,
      'content-length': audio.length,
      'cache-control': 'no-store',
      'server-timing': `upstream;dur=${upstreamMs};desc="service, whole answer"`,
    })
    return res.end(audio)
  }

  // OpenAI-compatible: the audio is streamed through as it comes, so the browser's time to first
  // byte is the service's.
  const type = r.headers.get('content-type')
  res.writeHead(200, {
    'content-type': type && type.startsWith('audio/') ? type : 'application/octet-stream',
    'cache-control': 'no-store',
    'server-timing': `upstream;dur=${headersMs};desc="service, headers"`,
  })
  try {
    for await (const chunk of r.body) res.write(chunk)
  } catch (e) {
    // The service broke off mid-stream. The status is already sent: the browser learns it from the
    // response itself, cut without its last chunk, which makes its read fail instead of ending well.
    console.error(`${service.id} broke off its audio: ${e.cause?.code ?? e.message}`)
    return res.destroy()
  }
  res.end()
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
}

const server = createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  try {
    const path = new URL(req.url, 'http://playground').pathname
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('ok')
    }
    if (req.method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path]
      const data = readFileSync(`${WEB_DIR}/${file}`)
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-cache',
        'content-security-policy': "default-src 'self'; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      })
      return res.end(data)
    }
    if (req.method === 'GET' && path === '/api/services') return sendJson(res, 200, { services: services.map(publicView) })
    if (req.method === 'POST' && path === '/api/stt') return await stt(req, res)
    if (req.method === 'POST' && path === '/api/tts') return await tts(req, res)
    fail(res, 404, 'not found')
  } catch (e) {
    console.error(scrub(e?.stack ?? e))
    if (!res.headersSent) fail(res, 500, 'internal error')
    else res.end()
  }
})

server.listen(PORT, () => {
  console.log(`speech-playground on :${PORT}, ${services.length} services: ` +
    services.map((s) => `${s.id} (${s.type}, ${keyOf(s) === undefined ? 'unavailable: no key' : 'available'})`).join(', '))
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))
