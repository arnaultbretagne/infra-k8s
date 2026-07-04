# GitOps root of trust recommendations

This document is the operational checklist for ADR 0026. It is intentionally separate from the ADR: the ADR records the decision, while this file tracks the practical hardening work.

## Immediate Controls

1. Protect `main` with branch protection or a repository ruleset:
   - pull request required before merge;
   - required checks before merge;
   - force push disabled;
   - branch deletion disabled;
   - bypass disabled or restricted to the smallest emergency set;
   - stale approvals dismissed when relevant files change.

2. Add CODEOWNERS or an equivalent review rule for sensitive paths:
   - `.sops.yaml`;
   - `bootstrap/`;
   - `clusters/`;
   - `infrastructure/`;
   - `apps/**/secret*`;
   - `apps/**/rbac*`;
   - `apps/**/networkpolicy*`;
   - `apps/**/httproute*`;
   - `docs/adr/`.

3. Make the expected PR checks explicit:
   - render Flux/Kustomize outputs;
   - validate Kubernetes schemas;
   - verify SOPS encrypted files can decrypt in the operator environment or CI secret context;
   - block obvious plaintext secrets;
   - block mutable image tags such as `:latest`;
   - check namespace profile labels from ADR 0024;
   - check Pod Security Admission labels;
   - check required guardrail objects where this is practical.

4. Inventory all GitHub credentials:
   - human PATs;
   - GitHub App installations;
   - Flux deploy key;
   - Renovate identity;
   - Actions tokens;
   - any token present in `code-server`, agent runtimes, host files, or Kubernetes Secrets.

## Agent PR Model

The target model for infrastructure agents is:

```text
agent drafts change
  -> branch created outside protected main
    -> PR opened
      -> checks run
        -> human merges
```

Recommended phases:

| Phase | Model | Notes |
| --- | --- | --- |
| 0 | Human applies agent patch locally | Safest current model. Agent has no GitHub authority on `infra-k8s`. |
| 1 | Agent creates a branch, human opens PR | Useful if the agent runs in a trusted operator environment. Still no merge authority. |
| 2 | Dedicated PR-bot creates branch and PR | Good target model. Requires strict GitHub permissions and protected `main`. |
| 3 | Limited automerge for low-risk updates | Only for narrow cases such as dependency bumps with strong checks. Not for RBAC, ingress, secrets, bootstrap, policies, or agent runtime changes. |

The dedicated PR-bot, if introduced, should have:

- one identity per trust domain;
- repository scope limited to `infra-k8s`;
- permission to write branches and open/update PRs;
- no permission to merge PRs;
- no repository administration permission;
- no access to GitHub repository secrets or environments;
- no Actions workflow administration permission;
- no installation on app repos unless a separate ADR accepts it.

Do not place this PR-bot credential inside `untrusted-compute` namespaces by default. If an agent runtime needs to propose infrastructure PRs, prefer a brokered service that receives a patch and creates the PR, instead of giving the runtime a broad GitHub token.

## Flux And Automation

Flux should normally read `main` and reconcile. If Flux Image Automation is used, it should only update a dedicated branch such as `flux-image-updates`, then rely on a PR.

Recommended checks:

- confirm whether the Flux deploy key is read/write;
- confirm whether it can push directly to `main`;
- confirm branch protection blocks that direct push;
- consider moving image automation to a dedicated GitHub App if branch-level restriction is needed;
- keep Renovate PR-only;
- disable any automation path that can write directly to protected `main`.

## Credential Boundaries

Treat these as platform-admin credentials:

- a token that can push to `main`;
- a token that can merge PRs;
- a token that can bypass branch protection;
- a token that can change repository rules, branch protection, or GitHub App installations;
- the Flux deploy key if it can write to protected branches;
- the SOPS Age private key;
- root access to the host while the SOPS key and kubeconfig are present.

These credentials must not be available to:

- `public-app` namespaces;
- ordinary `private-app` namespaces;
- `untrusted-compute` workloads;
- `code-server` if it is intended to become a read-only or low-authority code browser;
- agent runtimes that execute untrusted repository, tool, or LLM output.

## Break-Glass Rules

Direct push to `main` is allowed only for emergency maintenance when the PR path is unavailable or would worsen an incident.

A break-glass change should leave an audit trail:

- reason for bypass;
- exact commit;
- incident or maintenance context;
- follow-up PR or issue if the emergency change needs cleanup;
- verification that branch protection and normal PR flow were restored.

## Open Questions

1. Should `infra-k8s` use a deploy key forever, or move Flux to a GitHub App for finer-grained audit and credential lifecycle?
2. Should agent-generated infrastructure PRs be created directly by a GitHub App, or through a small broker service that validates patches first?
3. Which checks are required before merge on day one: schema only, or schema plus policy plus secret scanning?
4. Which low-risk PR classes, if any, are eligible for automerge after checks?
5. Should CODEOWNERS distinguish ordinary app manifests from platform-critical paths?
