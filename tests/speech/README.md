# Speech e2e

The proof of `apps/speech` (the STT and TTS bricks), run by `.github/workflows/speech-e2e.yml (now tests/speech/workflow/, see its header)` on every pull
request that touches them. There is no preview of these bricks: this run is the proof.

1. `check-manifests.mjs` checks what kustomize renders: two Deployments and their port-80 Services, no
   HTTPRoute, the pod security of every container, its resources and priority, images pinned by tag and
   digest, and the shape of the CiliumNetworkPolicy.
2. A kind cluster with Cilium 1.20.2 (the cluster's version, so the policy is enforced as in production,
   `toFQDNs` included: the models really are downloaded through it), the cluster's PriorityClasses, and
   `apps/speech` applied as rendered.
3. `e2e.sh`, from a curl pod in `speech-playground`: each STT model transcribes the French clip below and
   the text must hold every word of `EXPECTED_WORDS`; the TTS returns a WAV for a French sentence with
   `ff_siwis`; the memory of each container once its models are loaded; the policy refusing an outsider,
   a host or port not named, the kube-apiserver and flux-system, each beside a control that reaches the
   same target; then TTS at 0 replicas (STT passes, TTS fails), and STT at 0 (the reverse).

## The fixture

`fixtures/fr-mls-1406_1028_000000.opus`: utterance `1406_1028_000000` of the French test split of
[Multilingual LibriSpeech](https://huggingface.co/datasets/facebook/multilingual_librispeech) (CC BY 4.0),
from the LibriVox public-domain recording of *Les Mille et Une Nuits* (Galland), 16.5 s:

> pendant le second siècle je fis serment d'ouvrir tous les trésors de la terre à quiconque me mettrait en
> liberté mais je ne fus pas plus heureux dans le troisième je promis de faire puissant monarque mon
> libérateur d'être toujours près de lui en esprit

sha256 `d23790461cd6c2d451c00385fc960db094ca0628754c56f991b507d2b63fcdc1`.
