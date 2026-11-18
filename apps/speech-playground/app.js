// The playground's page: picks a service, model and voice from /api/services, sends STT and TTS
// requests through the playground's server, and shows what came back with its timings, measured
// here in the browser: time to first byte of the answer, and its total duration.
const $ = (id) => document.getElementById(id)
let services = []

function fill(select, values, label = (v) => v) {
  select.replaceChildren(...values.map((v) => new Option(label(v), v)))
}

function serviceLabel(s) {
  return s.available ? s.label : `${s.label} — indisponible (${s.reason})`
}

function wire(kind) {
  const select = $(`${kind}-service`)
  const list = services.filter((s) => s.type === kind)
  select.replaceChildren(...list.map((s) => {
    const o = new Option(serviceLabel(s), s.id)
    o.disabled = !s.available
    return o
  }))
  const first = list.find((s) => s.available)
  if (first) select.value = first.id
  const update = () => {
    const s = list.find((x) => x.id === select.value)
    fill($(`${kind}-model`), s ? s.models : [])
    if (kind === 'tts') fill($('tts-voice'), s ? s.voices : [])
  }
  select.addEventListener('change', update)
  update()
}

const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`)

function remember(row) {
  const tr = document.createElement('tr')
  for (const v of [row.kind, row.service, row.model, row.voice ?? '—', ms(row.ttfb), ms(row.total), ms(row.upstream)]) {
    const td = document.createElement('td')
    td.textContent = v
    tr.append(td)
  }
  $('history').prepend(tr)
}

function serverTiming(response) {
  const m = /upstream;dur=([\d.]+)/.exec(response.headers.get('server-timing') ?? '')
  return m ? Number(m[1]) : null
}

// Reads a response to the end, noting when its first byte came.
async function readTimed(response, started) {
  const reader = response.body.getReader()
  const chunks = []
  let ttfb = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (ttfb === null) ttfb = performance.now() - started
    chunks.push(value)
  }
  return { chunks, ttfb, total: performance.now() - started }
}

// --- STT ------------------------------------------------------------------------------------

let sttAudio = null // { blob, name }
let recorder = null

function setSttAudio(blob, name) {
  sttAudio = { blob, name }
  $('stt-input-status').textContent = `${name} — ${(blob.size / 1024).toFixed(1)} Kio`
  const preview = $('stt-preview')
  preview.src = URL.createObjectURL(blob)
  preview.hidden = false
  $('stt-run').disabled = false
}

// What MediaRecorder gives (webm/opus, mp4…) is not what every service reads: it is decoded here
// and sent as 16 kHz mono 16-bit WAV, which they all do.
async function toWav(blob) {
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer())
  const rate = 16000
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const samples = (await offline.startRendering()).getChannelData(0)
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  str(36, 'data'); view.setUint32(40, samples.length * 2, true)
  samples.forEach((x, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true))
  return new Blob([view], { type: 'audio/wav' })
}

$('stt-record').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const chunks = []
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => chunks.push(e.data)
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      const recorded = new Blob(chunks, { type: recorder.mimeType })
      try {
        setSttAudio(await toWav(recorded), 'micro.wav')
      } catch {
        setSttAudio(recorded, 'micro.webm')
      }
    }
    recorder.start()
    $('stt-record').disabled = true
    $('stt-stop').disabled = false
    $('stt-input-status').textContent = 'Enregistrement…'
  } catch (e) {
    $('stt-input-status').textContent = `Micro indisponible : ${e.message}`
  }
})

$('stt-stop').addEventListener('click', () => {
  recorder?.stop()
  $('stt-record').disabled = false
  $('stt-stop').disabled = true
})

$('stt-file').addEventListener('change', (e) => {
  const file = e.target.files[0]
  if (file) setSttAudio(file, file.name)
})

$('stt-run').addEventListener('click', async () => {
  if (!sttAudio) return
  const service = $('stt-service').value
  const model = $('stt-model').value
  const form = new FormData()
  form.append('service', service)
  form.append('model', model)
  const language = $('stt-language').value.trim()
  if (language) form.append('language', language)
  form.append('file', sttAudio.blob, sttAudio.name)
  $('stt-run').disabled = true
  $('stt-result').textContent = '…'
  $('stt-result').classList.remove('error')
  $('stt-metrics').textContent = ''
  const started = performance.now()
  try {
    const response = await fetch('/api/stt', { method: 'POST', body: form })
    const { chunks, ttfb, total } = await readTimed(response, started)
    const body = JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()))
    const upstream = body.upstream?.ms ?? null
    $('stt-metrics').textContent = `Durée de la requête : ${ms(total)} (service seul : ${ms(upstream)})`
    if (!response.ok) {
      $('stt-result').textContent = `${body.error}${body.upstream?.body ? `\n${body.upstream.body}` : ''}`
      $('stt-result').classList.add('error')
    } else {
      $('stt-result').textContent = body.text
    }
    remember({ kind: 'STT', service, model, ttfb, total, upstream })
  } catch (e) {
    $('stt-result').textContent = e.message
    $('stt-result').classList.add('error')
  } finally {
    $('stt-run').disabled = false
  }
})

// --- TTS ------------------------------------------------------------------------------------

$('tts-run').addEventListener('click', async () => {
  const request = {
    service: $('tts-service').value,
    model: $('tts-model').value,
    voice: $('tts-voice').value,
    input: $('tts-input').value,
  }
  $('tts-run').disabled = true
  $('tts-error').textContent = ''
  $('tts-metrics').textContent = '…'
  const started = performance.now()
  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const { chunks, ttfb, total } = await readTimed(response, started)
    const upstream = serverTiming(response)
    $('tts-metrics').textContent = `Premier octet : ${ms(ttfb)} · Durée totale : ${ms(total)}`
    if (!response.ok) {
      const body = JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()))
      $('tts-error').textContent = `${body.error}${body.upstream?.body ? `\n${body.upstream.body}` : ''}`
    } else {
      const audio = $('tts-audio')
      audio.src = URL.createObjectURL(new Blob(chunks, { type: response.headers.get('content-type') }))
      audio.hidden = false
      audio.play().catch(() => {})
    }
    remember({ kind: 'TTS', ...request, ttfb, total, upstream })
  } catch (e) {
    $('tts-error').textContent = e.message
  } finally {
    $('tts-run').disabled = false
  }
})

// --- Services -------------------------------------------------------------------------------

try {
  const response = await fetch('/api/services')
  services = (await response.json()).services
  wire('stt')
  wire('tts')
  const down = services.filter((s) => !s.available)
  $('services-status').textContent = `${services.length} services` +
    (down.length ? ` — indisponibles : ${down.map((s) => s.label).join(', ')}` : '')
} catch (e) {
  $('services-status').textContent = `Services illisibles : ${e.message}`
  $('services-status').classList.add('error')
}
