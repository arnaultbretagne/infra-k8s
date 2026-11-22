# Speech checks

What proves `apps/speech` (the STT and TTS bricks). Their live proof is the speech playground's preview, which
runs `apps/speech/workload` beside the playground (ADR 0017, amendment 2026-11-18).

- `fixtures/fr-mls-1406_1028_000000.opus`: the French clip every STT model must transcribe.
- `expected-words.txt`: the words each transcription must contain.
- `check.mjs`: the check itself, against any `STT_URL` / `TTS_URL` (Node, no dependency): each STT model
  (`parakeet-tdt-0.6b-v3`, `whisper-large-v3-turbo`) on the clip, then Kokoro with `ff_siwis` on a French
  sentence, which must return a non-empty WAV.

## The fixture

Utterance `1406_1028_000000` of the French test split of
[Multilingual LibriSpeech](https://huggingface.co/datasets/facebook/multilingual_librispeech) (CC BY 4.0),
from the LibriVox public-domain recording of *Les Mille et Une Nuits* (Galland), 16.5 s:

> pendant le second siècle je fis serment d'ouvrir tous les trésors de la terre à quiconque me mettrait en
> liberté mais je ne fus pas plus heureux dans le troisième je promis de faire puissant monarque mon
> libérateur d'être toujours près de lui en esprit

sha256 `d23790461cd6c2d451c00385fc960db094ca0628754c56f991b507d2b63fcdc1`.
