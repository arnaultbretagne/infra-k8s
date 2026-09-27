# Instance templates

JSON files listed in the parent `configMapGenerator` are mounted read-only at
`/app/data/templates`. AIOStreams loads them as custom templates during startup
and exposes them through `/api/v1/templates` and the configuration UI.
Kustomize's generated ConfigMap name changes with the content, triggering a
Deployment rollout when a template is updated.

`knaben-stfr-top3-torbox-v2.26.json` is version 1.2.0 of the tested Knaben/TorBox
template: up to three results with reported embedded French subtitles, falling
back to candidates without a subtitle requirement only when none qualify.
It prioritises cache, chooses 4K or 1080p (1080p for anime), and sorts retained
seeder counts descending. Season packs are allowed. The template contains no
credentials and asks for the user's TorBox key when selected.

Publishing a template here does not apply it to existing user profiles. This
change does not include the separately investigated AIOStreams 2.26 cropped
resolution parsing fix; the upstream image and its known parsing limits remain.
