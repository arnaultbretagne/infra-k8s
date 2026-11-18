# The sandbox admission policies, on a real API server

Run by `.github/workflows/sandbox-admission-policies.yml`. A kind cluster (Kubernetes 1.36.4); this repository's
RuntimeClasses (`kubectl apply -k infrastructure/configs/sandboxed-runtime`) and policies
(`kubectl apply -k infrastructure/configs/policies`), as Flux applies them; the namespaces `agora-runs`,
`agora-sandboxes` and `preview-system` from their own manifests, and a preview namespace labelled as
`infrastructure/configs/previews/resourceset.yaml` renders one. Each case is a real Pod CREATE made by kubectl,
as a given principal (`--as`): a ServiceAccount granted Pod create and nothing else (`intruder`), kind's admin,
the job controller (`system:serviceaccount:kube-system:job-controller`, who creates a Job's Pods), and CNPG's
operator (`system:serviceaccount:cnpg-system:cloudnative-pg`). Each prints what the API server answered (`ℹ`).

Before applying, the test deletes both policies and waits until no Pod is refused, then applies and waits until
both refuse: the answers come from the policies of this run, not from ones the API server still had cached.

```sh
kind create cluster --image kindest/node:v1.36.4
cd tests/sandbox-admission-policies && npm test
```

## What a run shows

| Case | Answer |
| --- | --- |
| `agora-runs`, `agora-sandboxes`: a Pod labelled as a CNPG instance (`cnpg.io/cluster`, …), no `runtimeClassName` — by `intruder`, kind's admin, the job controller, CNPG's operator | Refused by `untrusted-compute-requires-sandbox`, each time. |
| The same with `runtimeClassName: runc`, and a Pod with no label | Refused. |
| A Pod with `sandboxed` or `kata`, labelled or not | Admitted. |
| `agora-runs`: a Job whose Pod template is CNPG-labelled, no runtime | The job controller's Pod CREATE is refused (`FailedCreate`, naming the policy); the Job has no Pod. |
| Preview namespace: a CNPG-labelled Pod, no runtime | Refused by both policies. With `sandboxed`, by `preview-requires-kata`, CNPG's operator included. With `kata`: admitted. |
| `preview-system`, where CNPG runs preview databases: an instance Pod by CNPG's operator, a Job Pod by the job controller, a real CNPG-labelled Job | Admitted; the Job's Pod is created (`SuccessfulCreate`). |

## The run broken on purpose

The workflow then runs the test again with the policies as they were before the fix (`POLICIES`, the kustomization
at f1350b4, the last commit of `main` with the exemption), when a `cnpg.io/cluster` label exempted a Pod. That run
must fail, and the workflow checks it fails on the labelled Pods.
