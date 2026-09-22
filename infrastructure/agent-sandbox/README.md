# Agent Sandbox

[Kubernetes SIGs Agent Sandbox v1.0.3](https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v1.0.3),
including SandboxClaim, SandboxTemplate and SandboxWarmPool extensions. Flux
reconciles it independently as `agent-sandbox` from the versioned upstream release
manifest. Local patches add restricted PSA, non-root/read-only execution, resource
bounds, health probes and Cilium network isolation.

The controller's upstream ClusterRoles manage runtime resources across namespaces.
It is a trusted infrastructure controller; its Kubernetes token is intentional.
Only API-server and DNS egress are allowed. Metrics are readable by Prometheus.
No pool, product runtime, Agora RBAC or new runtime image is provisioned here.

Runtime templates must use the existing `RuntimeClass sandboxed` (gVisor),
restricted pod security, bounded resources and no service-account token in an
`untrusted-compute` namespace. Agent Sandbox creates Kubernetes pods; it does not
install gVisor or make arbitrary templates safe. Runtime namespace policy and
capacity remain infra-k8s responsibilities.

Agora will request runtimes through the Kubernetes Sandbox APIs. Runtime lifecycle
and expiry belong here; conversation state belongs to Agora. Use upstream lifecycle
fields where sufficient, and extend the infrastructure controller separately if an
additional reaper becomes necessary. No reconciliation code is added to Agora.

```sh
flux get kustomization agent-sandbox
kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller
kubectl get crd sandboxes.agents.x-k8s.io sandboxclaims.extensions.agents.x-k8s.io sandboxtemplates.extensions.agents.x-k8s.io sandboxwarmpools.extensions.agents.x-k8s.io
kubectl get runtimeclass sandboxed
kubectl -n agent-sandbox-system logs deployment/agent-sandbox-controller --tail=50
```

After deployment, verify creation and deletion of a disposable Sandbox using the
actual consumer namespace/template and `runtimeClassName: sandboxed`. Controller
readiness alone does not prove that gVisor runtime provisioning works. No such live
check has been run from the authoring environment, which has no kubeconfig.

CRDs are retained when this Flux installation is pruned, to prevent accidental
cascading deletion of all sandboxes. Uninstallation requires explicitly draining
runtimes and removing CRDs; deleting the controller while finalizers remain can
leave runtime deletion stuck.
