# flux-alerts

`promtool` unit tests of the `bretagne-flux` PrometheusRule (`observability/rules.yaml`):
`FluxResourceNotReady`, `FluxResourceMetricsAbsent`, `FluxControllerMetricsAbsent`.

`run.mjs` renders `observability/` with `kubectl kustomize` (what the `observability` Flux
Kustomization applies), cuts the rule's `spec` out of it into a plain rule file, then runs
`promtool check rules` and `promtool test rules flux-alerts.test.yaml` on it. No workflow
covers `observability/**`: run it by hand.

```bash
node tests/flux-alerts/run.mjs   # kubectl and promtool on PATH, or KUBECTL= / PROMTOOL=
```

Tested with promtool 3.7.3 (`prometheus-3.7.3.linux-amd64.tar.gz`, sha256
`fc9e5da126817438cf2820d9a7206c75e3122802ba8d20add3a6219a59ca6913`) and kubectl v1.34.2
(`linux/amd64`, sha256 `9591f3d75e1581f3f7392e6ad119aab2f28ae7d6c6e083dc5d22469667f27253`).
