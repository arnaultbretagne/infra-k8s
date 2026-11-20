// The page itself, in headless Chromium: STT from the microphone (Chromium's fake device, a beep) and
// from a file, TTS through each service. Returns what the page showed, and every answer it received.
import { chromium } from 'playwright'

export async function drivePage(base, { audioFile, tts }) {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  })
  const answers = []
  try {
    const context = await browser.newContext()
    await context.grantPermissions(['microphone'], { origin: base })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('response', async (r) => {
      try {
        answers.push({ url: r.url(), status: r.status(), headers: await r.allHeaders(), body: await r.body() })
      } catch {}
    })
    await page.goto(base)
    await page.waitForFunction(() => document.getElementById('stt-service').options.length > 0)
    const shown = { errors }

    // STT, microphone: record a second of the fake device, stop, transcribe.
    await page.click('#stt-record')
    await page.waitForTimeout(1200)
    await page.click('#stt-stop')
    await page.waitForFunction(() => !document.getElementById('stt-run').disabled)
    shown.micInput = await page.textContent('#stt-input-status')
    await page.click('#stt-run')
    await page.waitForFunction(() => /ms/.test(document.getElementById('stt-metrics').textContent))
    shown.micText = await page.textContent('#stt-result')
    shown.micMetrics = await page.textContent('#stt-metrics')

    // STT, file.
    await page.setInputFiles('#stt-file', audioFile)
    await page.selectOption('#stt-model', { index: 1 })
    await page.click('#stt-run')
    await page.waitForFunction((before) => document.getElementById('stt-metrics').textContent !== before, shown.micMetrics)
    await page.waitForFunction(() => /ms/.test(document.getElementById('stt-metrics').textContent))
    shown.fileText = await page.textContent('#stt-result')
    shown.fileMetrics = await page.textContent('#stt-metrics')

    // TTS, each service asked for.
    shown.tts = []
    for (const t of tts) {
      await page.selectOption('#tts-service', t.service)
      await page.selectOption('#tts-model', t.model)
      await page.selectOption('#tts-voice', t.voice)
      await page.fill('#tts-input', t.input)
      await page.evaluate(() => { document.getElementById('tts-metrics').textContent = ''; document.getElementById('tts-error').textContent = '' })
      await page.click('#tts-run')
      // Done when the button is enabled again: timings shown, or an error.
      await page.waitForFunction(() => !document.getElementById('tts-run').disabled && document.getElementById('tts-metrics').textContent !== '…')
      shown.tts.push({
        ...t,
        metrics: await page.textContent('#tts-metrics'),
        error: await page.textContent('#tts-error'),
        audioSrc: await page.getAttribute('#tts-audio', 'src'),
        audioHidden: await page.$eval('#tts-audio', (a) => a.hidden)
      })
    }
    shown.serviceOptions = await page.$$eval('#tts-service option', (os) => os.map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled })))
    shown.history = await page.$$eval('#history tr', (rows) => rows.map((r) => r.textContent))
    return { shown, answers }
  } finally {
    await browser.close()
  }
}
