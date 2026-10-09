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

## Tam-Taro FR · 3 VF + 2 VO-STFR

`tamtaro-fr-3vf-2vostfr.json` is generated, never edited by hand. `tamtaro-fr/generate.mjs`
takes Tam-Taro's latest "Complete SEL Setup", resolves it with the answers in
`tamtaro-fr/overlay.json` through AIOStreams' own template resolver (the module the
import wizard runs, fetched at the tag of the image in `../deployment.yaml`), then applies
the overlay:

- StremThru Torz is the only source.
- Tam-Taro's ranking decides the order (`sorting.selScore: high`): his synced release-group
  and language lists, Vidhin's English lists, seeders last.
- Two expressions added after his own keep at most 3 videos with a French audio track,
  pinned first, then at most 2 without French audio but with French subtitles reported.
  Each group keeps 4K when it has some, else 1080p. Nothing else is shown.
- No bitrate cap. Torz reports subtitle languages without per-track detail, so a
  French track that is only forced cannot be told apart.
- `tmdb: "none"` turns off what needs a TMDB key (title, year and digital-release checks,
  bitrate from runtime) so a profile saves with the TorBox key alone. With a key set on the
  instance (`TMDB_ACCESS_TOKEN` or `TMDB_API_KEY`), `tmdb: "instance"` keeps them on.

The version is Tam-Taro's with `patch × 100 + overlay revision` as its patch (3.2.9 with
revision 1 is 3.2.901), so AIOStreams flags an update whenever either side changes.
Bump `revision` in the overlay for every overlay change.

```sh
node apps/stremio/templates/tamtaro-fr/generate.mjs           # regenerate
node apps/stremio/templates/tamtaro-fr/generate.mjs --check   # fail if stale
TORBOX_API_KEY=... node apps/stremio/templates/tamtaro-fr/check-live.mjs http://<aiostreams>:3000
```

`check-live.mjs` replays eight titles: for each it compares what AIOStreams returns with
what the 3 + 2 rule gives on the same candidates. It sends the template in a request
header of about 110 KB, more than Node's default limit: run it against an instance started
with `NODE_OPTIONS=--max-http-header-size=262144`, not through the HEAD shim. Stored
profiles never send the template in a header, so the deployment needs no such option.

`.github/workflows/tamtaro-template.yml` regenerates the template every day. When
Tam-Taro changed something, it opens a pull request if the `TEMPLATES_PR_TOKEN` secret is
set, and fails otherwise so the change is still noticed. Run `check-live.mjs` before
merging such a pull request.

Checked on AIOStreams 2.35.9: the template loads without errors, its formatter
renders, and searches return the expected selection. Since 2.35, cropped scope
releases (for example 3840×1606) are classified 2160p, so the engine patch
prepared for 2.26 is no longer needed.
