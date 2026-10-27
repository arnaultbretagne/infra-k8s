# agora-gateway: the kubernetes route, end to end

Run by `.github/workflows/agora-gateway-kubernetes-e2e.yml`. Steps (details in the test's header):
- A real API server: kind, Kubernetes 1.36, with its audit log on (`kind.yaml`, `audit-policy.yaml`).
- This repository's ServiceAccount, ClusterRole and ClusterRoleBinding, applied as `kubectl kustomize apps/agora-gateway`
  renders them.
- The gateway-config of the same render, run by the agentgateway 1.6.0 release binary, its sha256 checked.
- Tokens from Agora's own `GrantSigner`, carried by Agora's bridge (`outbound.ts`), at a pinned commit of the contract's
  branch.
- kubectl 1.36.5 as in a sandbox: the bridge's `kubeconfig.yaml`, no credential, `HTTPS_PROXY` the bridge.
- Then the test runs twice more, with `MUTATE=route` (the route's rule set to `true`) and `MUTATE=role` (the role given
  `secrets` and `pods/exec`). Both runs must fail.
