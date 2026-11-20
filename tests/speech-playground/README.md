# The speech playground: its tests

Two layers of proof:
- **here, locally**: the suites below. They need Node 24 and `npm ci`, and nothing else;
- **the PR's preview** (`preview/speech-playground`, catalogue entry `infrastructure/configs/previews/catalogue/speech-playground.yaml`), which runs the playground beside the real speech bricks (`apps/speech-playground/preview`). It is replayed by `preview-check.mjs`.

## Running it

```sh
cd tests/speech-playground
npm ci                       # yaml and playwright, from registry.npmjs.org
npm test                     # manifests + API: must pass (exit 0)
npm run test:mutations       # each mutation of server.mjs must fail exactly the tests that guard it (exit 0 when it does)
MUTATE=no-scrub npm test     # by hand: must fail (exit 1), on the three key tests

# The page, in headless Chromium (needs Playwright's browser and its system libraries):
npx playwright install --with-deps chromium
npm run test:page            # must pass
```

- **`kubectl`.** `npm test` renders kustomizations with `kubectl kustomize`. Its `pretest` (`ensure-kubectl.mjs`) uses `KUBECTL`, or the `kubectl` on the `PATH`. Failing both, on linux-amd64, it fetches kubectl v1.36.5 from `dl.k8s.io` into `.bin/`, checked against its sha256.
- **No browser in `npm test`.** It needs no Chromium: the page has its own suite, `npm run test:page`.

## The suites

**`manifests.test.mjs`** reads the render of `apps/speech-playground` and of `apps`, the Gateway of `infrastructure/gateway`, `apps/pocket-id/oidc-reconciler/spec.json` and the catalogue entry. It checks:
- the HTTPRoute reaches only the oauth2-proxy, which admits the group `admin` and waits 120 s for the playground;
- the Pocket-ID client, and its secret handed to the reconciler;
- the Gateway listener;
- the one config file;
- no production host name in the workload;
- the production `ExternalName` Services point at `speech`;
- `stt` and `tts` run as Deployments in namespace `speech` only;
- the preview folder: only what a preview may hold, and its size within the catalogue entry, with Kata and a surge Pod counted;
- the Xiaomi key's optional Secret volume;
- the hardening of every container;
- the network policies.

**`playground.test.mjs`** runs the playground's API (`targets.mjs`): the same `workload/server.mjs`, page and `services.json`, as processes on this machine. Every url is rewritten to one of two fakes:
- `fake-openai.mjs`: OpenAI's `/v1/audio/transcriptions` and `/v1/audio/speech`. A TTS text containing `CUT` gets an answer that breaks off after 20 of the 10000 bytes it announces.
- `fake-mimo.mjs`: Xiaomi MiMo's `/v1/chat/completions` TTS. It answers only the test key, sent in `api-key`. A text containing `ECHO-KEY` gets a 400 that echoes the key; a text containing `SLOW` is answered only on `POST /_release`.

The key is the file `auth.keyFile` names, written, rotated and removed by the test.

**`page.test.mjs`** drives the page in headless Chromium (`browser.mjs`) on the same local playground.

**`mutations.mjs`** runs `playground.test.mjs` once per mutation of `server.mjs` (`MUTATIONS` in `targets.mjs`), and checks that each fails exactly the tests listed for it:

| `MUTATE=` | What it undoes | Must fail exactly |
| --- | --- | --- |
| `no-scrub` | all scrubbing | the echoed key; the key of a request in flight; "no answer sent to the browser holds the key" |
| `scrub-current-only` | scrubs only the keys the files hold now: the behaviour before this fix | the key of a request in flight; "no answer sent to the browser holds the key" |
| `stream-cut-swallowed` | ends a broken-off stream as if complete: the behaviour before this fix | the broken-off stream |

## What a run shows

| Case | What the run shows |
| --- | --- |
| No key | `/api/services` lists Xiaomi as `available: false`, with the reason. A TTS request to it answers 503, and the fake receives nothing. |
| STT, each model of `cluster-stt` | The text is the fake's transcript of the exact bytes sent. The fake received the model, the language and the file. |
| TTS, `cluster-tts` | The audio is the fake's, byte for byte, with a `server-timing` header. |
| A model, voice or service not in `services.json` | 400 or 404. Nothing is sent upstream. |
| The key written | Xiaomi becomes available, without a restart. |
| TTS, `xiaomi-mimo` | The audio is the fake's, decoded from base64. The fake received `api-key: <test key>`, the text as the assistant's message, and `audio: {format, voice}`. |
| The fake echoes the key in an error | The playground relays the error with `[redacted]` in place of the key. |
| The key file rotated, then removed, while a request waits on the fake (`SLOW`), which then echoes the key it got | The answer holds `[redacted]`, never the key the request read when it started. |
| The TTS service breaks off mid-stream | The browser's read of the answer fails (`TypeError`), instead of ending as a complete answer. The next request is served. |
| Every answer the API gave | About 20, bodies and headers. None holds the test key or the rotated one, raw, base64, base64url or hex. Neither do the server's logs. |
| The page (`test:page`) | STT from the microphone (Chromium's fake device, converted to WAV by the page) and from a file. TTS from both services, with "Premier octet" and "Durée totale". A broken-off TTS shows "Réponse interrompue : …", with no timings, no audio and no history row. No answer the page got holds the key. |
