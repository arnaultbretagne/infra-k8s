# The speech playground, end to end

Run by `.github/workflows/speech-playground-e2e.yml`, which runs `ci.sh` and nothing else. Until that file is
moved there, it sits in `workflow/` (see its header): the token that pushed it may not write workflows.

`npm test` runs two files:

- `manifests.test.mjs` reads the render of `apps/speech-playground` (with `kubectl kustomize`), the Gateway of
  `infrastructure/gateway` and `apps/pocket-id/oidc-reconciler/spec.json`:
  - the HTTPRoute reaches only the oauth2-proxy, which admits the group `admin`;
  - the Pocket-ID client, and its secret handed to the reconciler;
  - the listener;
  - the one config file;
  - the Xiaomi key's optional Secret volume;
  - the hardening of every container;
  - the network policies.
- `playground.test.mjs` runs the playground on a target (`TARGET`, `targets.mjs`) beside two fakes:
  - `fake-openai.mjs`: OpenAI's `/v1/audio/transcriptions` and `/v1/audio/speech`;
  - `fake-mimo.mjs`: Xiaomi MiMo's `/v1/chat/completions` TTS, which only answers the test key, sent in `api-key`.

## Targets

- **`TARGET=kind`**, what `ci.sh` runs. The setup:
  - kind (Kubernetes 1.36.4), with the Gateway API v1.6.3 CRDs, the CiliumNetworkPolicy CRD of Cilium 1.20.2 and
    the cluster's PriorityClasses;
  - the render of `apps/speech-playground`, applied as is, with two changes:
    - `services.json`'s Xiaomi url points at the fake (`mimo.fake-xiaomi`);
    - oauth2-proxy skips OIDC discovery: there is no Pocket-ID in kind, and it only has to redirect;
  - `fake-openai` serves as `stt.speech` and `tts.speech`, the addresses `services.json` names.
- **`TARGET=local`** (the default): the same server, page and config as processes on this machine, every url
  pointed at the fakes. `MUTATE=no-scrub` runs it with the server's `scrub()` disabled. The tests must then fail,
  and `ci.sh` checks that they do.

Not here:
- Cilium itself: the policies are validated by the CRD's schema and checked by `manifests.test.mjs`, not enforced;
- the real Pocket-ID and the real model services;
- `api.xiaomimimo.com`.

## What a run shows

| Case | What the run shows |
| --- | --- |
| No Secret `xiaomi-mimo` | The playground runs. `/api/services` lists Xiaomi as `available: false`, with the reason. A TTS request to it answers 503, and the fake Xiaomi receives nothing. |
| STT, each model of `cluster-stt` | The text is the fake's transcript of the exact bytes sent. The fake received the model, the language and the file. |
| TTS, `cluster-tts` | The audio is the fake's, byte for byte, with a `server-timing` header. |
| A model, voice or service not in `services.json` | 400 or 404. Nothing is sent upstream. |
| The Secret created | Xiaomi becomes available, on kind without the Pod restarting. |
| TTS, `xiaomi-mimo` | The audio is the fake's, decoded from base64. The fake received `api-key: <test key>`, the text as the assistant's message, and `audio: {format, voice}`. |
| The fake Xiaomi echoes the key in an error | The playground relays the error with `[redacted]` in place of the key. |
| The page, in headless Chromium | STT from the microphone (Chromium's fake device, converted to WAV in the page) and from a file. TTS from both services. The page shows the text, the request's duration, the time to first byte and the total. |
| Every answer the browser got | Bodies and headers, from the API and from the page (about 30). None holds the key: raw, base64, base64url or hex. Nor do the server's logs. |
| kind only | The Pods run in the `restricted` namespace. The reconciler's ServiceAccount may get and update `oauth2-proxy-client`, and nothing else. Once it writes the client there, oauth2-proxy (with its random cookie secret) sends an unauthenticated browser to `id.bretagne.dev/authorize`, with the client id and `speech.bretagne.dev`'s callback. |

## Running it here

```sh
cd tests/speech-playground && npm ci && npx playwright install chromium
npm test                       # TARGET=local
MUTATE=no-scrub npm test       # must fail
```
