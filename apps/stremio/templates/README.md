# Instance templates

JSON files listed in the parent `configMapGenerator` are mounted individually,
read-only, using `subPath` under `/app/data/templates`. AIOStreams loads them as custom templates during startup
and exposes them through `/api/v1/templates` and the configuration UI.
Kustomize's generated ConfigMap name changes with the content, triggering a
Deployment rollout when a template is updated.

Do not mount the whole ConfigMap directory at `/app/data/templates`: the
recursive loader (still recursive in 2.35) reads the visible JSON, `..data/` link, and timestamp directory,
publishing the same template three times with suffixed IDs. Add an explicit file
mount for each new JSON. The generated name and rollout are necessary because
`subPath` mounts do not receive in-place ConfigMap updates.

`knaben-stfr-top5-torbox-v2.26.json` is version 1.3.0 of the tested Knaben/TorBox
template: up to five results with reported embedded French subtitles, falling
back to candidates without a subtitle requirement only when none qualify.
It prioritises cache, chooses 4K or 1080p (1080p for anime), and orders the
retained candidates by source quality first (`BluRay REMUX`, `BluRay`,
`WEB-DL`, `WEBRip`, unknown last) then seeder counts descending.
Season packs are allowed. The template contains no credentials and asks for
the user's TorBox key when selected.

Publishing a template here does not apply it to existing user profiles.

Checked on AIOStreams 2.35.9: the template loads without errors, its formatter
renders, and searches return the expected selection. Since 2.35, cropped scope
releases (for example 3840×1606) are classified 2160p, so the engine patch
prepared for 2.26 is no longer needed.
