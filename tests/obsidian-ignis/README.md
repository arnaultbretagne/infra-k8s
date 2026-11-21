# obsidian-ignis: Ignis in production and in its preview, as rendered

Run by the `tests` workflow (`ci.paths`; `tests/README.md`) on every pull request touching Obsidian, Ignis,
the gateway or Pocket-ID's clients. It reads what this repository deploys, `kubectl kustomize apps/obsidian` (production) and
`kubectl kustomize apps/ignis/workload` (what the preview applies), and runs the init container's script.

| Case | Expected |
| --- | --- |
| The Deployment `ignis` | `nobbe/ignis:0.9.0` in every container; its volume `data` is the PVC `obsidian-data`, the MCP server's and the clipper's, mounted three ways: subPath `vault` at `/vaults/<Name>`, `ignis-data` at `DATA_ROOT`, `obsidian-app` at `OBSIDIAN_ASSETS_PATH`. `VAULT_ROOT` is read-only and holds a link to the vault, nothing else. |
| The init container's script, under bash, `curl` and `npx` stubbed | Empty cache: one download of the pinned release, unpacked and stamped. Pinned version cached: no download, the cache kept. Another version, or a stamp without `index.html`: cleared and downloaded. A failed download: the container fails, no stamp. |
| No second sync | The build renders no `obsidian-sync` object: this fails until `fix/obsidian-remove-sync` is on `main` and the branch is updated, so that Sync and Ignis never run together. Every container sets its command (the image's entrypoint, which installs `obsidian-headless`, never runs); nothing runs `ob` or `npm install`; the root filesystem is read-only. Ignis's egress names hosts only, none under `obsidian.md`. |
| The route and the gate | One HTTPRoute for `obsidian.bretagne.dev`, listener `https-obsidian`, HSTS, its one backend the gate. The listener admits routes from `obsidian` only. The gate: `ALLOWED_GROUPS=admin`, upstream the Service `ignis`. The Pocket-ID client `ignis`: `allowedGroups: ["admin"]`, the gate's callback. |
| `WS_ORIGINS` | `https://obsidian.bretagne.dev`. |
| Network policies | Ignis accepts its gate only; the gate, Traefik only. Out: DNS, and 443 to named hosts (the gate also reaches Traefik on its in-cluster paths). Never `flux-system`, the kube-apiserver, `world`, `all` or `cluster`. |
| PSS restricted | Every container, production and preview: `runAsNonRoot`, `allowPrivilegeEscalation: false`, `drop: [ALL]`, `readOnlyRootFilesystem`, seccomp `RuntimeDefault`, requests and a memory limit. |
| The gate's secret | SOPS, every value encrypted, to the age key of `.sops.yaml`. |
| The preview | A Deployment and a Service only, no PVC; the names, container and port the catalogue entry gives; memory limits between 64Mi and `containerMemoryMax`; production differs from it by the volume only. |

```sh
cd tests/obsidian-ignis
npm ci
npm test   # KUBECTL=/path/to/kubectl to use another kubectl
```
