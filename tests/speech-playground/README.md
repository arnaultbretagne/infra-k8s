# The speech playground: its tests

Two layers of proof:
- `npm test`, here, on any machine with Node 24 and `kubectl` (for `kubectl kustomize`);
- the PR's preview (`preview/speech-playground`, catalogue entry `infrastructure/configs/previews/catalogue/speech-playground.yaml`), which runs the playground beside the real speech bricks (`apps/speech-playground/preview`).

`npm test` runs two files.

**`manifests.test.mjs`** reads the render of `apps/speech-playground` and of `apps`, the Gateway of `infrastructure/gateway`, and `apps/pocket-id/oidc-reconciler/spec.json`. It checks:
- the HTTPRoute reaches only the oauth2-proxy, which admits the group `admin`;
- the Pocket-ID client, and its secret handed to the reconciler;
- the Gateway listener;
- the one config file;
- the workload holds no production host name;
- the production `ExternalName` Services point at namespace `speech`;
- `stt` and `tts` run as Deployments in namespace `speech` only;
- the Xiaomi key comes from an optional Secret volume;
- the hardening of every container;
- the network policies.

**`playground.test.mjs`** runs the playground (`targets.mjs`): the same `workload/server.mjs`, page and `services.json`, as processes on this machine, with every url rewritten to two fakes:
- `fake-openai.mjs`: OpenAI's `/v1/audio/transcriptions` and `/v1/audio/speech`;
- `fake-mimo.mjs`: Xiaomi MiMo's `/v1/chat/completions` TTS. It answers only the test key, sent in `api-key`.

The key is the file `auth.keyFile` names, written mid-test. With `MUTATE=no-scrub`, the server's `scrub()` does nothing, and the leak tests must then fail.

## What a run shows

| Case | What the run shows |
| --- | --- |
| No key | `/api/services` lists Xiaomi as `available: false`, with the reason. A TTS request to Xiaomi answers 503, and the fake receives nothing. |
| STT, each model of `cluster-stt` | The text is the fake's transcript of the exact bytes sent. The fake received the model, the language and the file. |
| TTS, `cluster-tts` | The audio is the fake's, byte for byte, with a `server-timing` header. |
| A model, voice or service not in `services.json` | 400 or 404. Nothing is sent upstream. |
| The key written | Xiaomi becomes available, without a restart. |
| TTS, `xiaomi-mimo` | The audio is the fake's, decoded from base64. The fake received `api-key: <test key>`, the text as the assistant's message, and `audio: {format, voice}`. |
| The fake echoes the key in an error | The playground relays the error with `[redacted]` in place of the key. |
| The page, in headless Chromium | STT from the microphone (Chromium's fake device, converted to WAV by the page) and from a file. TTS from both services. The page shows the text, the request's duration, the time to first byte and the total. |
| Every answer the browser got | About 30, bodies and headers, from the API and from the page. None holds the key, raw, base64, base64url or hex. Neither do the server's logs. |

## Running it

```sh
cd tests/speech-playground && npm ci && npx playwright install chromium   # --with-deps where you may
npm test                       # must pass
MUTATE=no-scrub npm test       # must fail: 2 tests, the scrubbed error and the leak check
```
