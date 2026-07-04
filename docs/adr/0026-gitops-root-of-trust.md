# ADR 0026 — GitOps root of trust and repository authority

## Status

**Accepted — 2026-07-04.** This ADR amends ADR 0002 and ADR 0016 by making the GitOps repository authority explicit.

## Context

ADR 0002 establishes Flux as the GitOps reconciler. ADR 0016 separates application repositories from `infra-k8s` and states that agents should not directly write deployment manifests.

That model is directionally right, but the root of trust was still too implicit. In practice, `infra-k8s/main` is not just a Git branch: it is the desired-state API for the cluster. Once a change reaches `main`, Flux reconciles it with broad cluster authority.

The security boundary is therefore not only Kubernetes admission, RBAC, or network policy. It is also GitHub repository authority:

- who can write to `infra-k8s`;
- who can merge into `main`;
- which automation can update branches;
- which workloads or agents hold GitHub credentials;
- whether a compromised runtime can turn repository access into cluster control.

This matters even more with agent-driven workflows. Agents are expected to help generate code, manifests, and pull requests, but they must not become implicit platform administrators.

## Decision

`infra-k8s/main` is a platform administration boundary.

Any principal that can push to `main`, merge a pull request into `main`, bypass branch protection, administer repository settings, or obtain the SOPS Age private key must be treated as having platform administrator authority.

All normal changes to `infra-k8s/main` MUST go through a pull request. Direct commits to `main` are reserved for documented break-glass maintenance only.

The target authority model is:

| Actor | Authority | `infra-k8s` access |
| --- | --- | --- |
| Human operator | Reviews and merges platform changes; may perform break-glass maintenance. | Can merge PRs. Direct push only as break-glass. |
| Flux | Reconciles the cluster from the repository. | Reads `main`; may write only automation branches if image automation is enabled. Must not bypass protected `main`. |
| Renovate | Proposes dependency and chart updates. | Opens PRs only. No merge authority. |
| Flux Image Automation | Proposes image tag changes. | Writes a dedicated branch and opens or feeds a PR. No direct `main` writes. |
| Product/code agent | Works on application code repositories. | No direct `infra-k8s` write access. |
| Infra operator agent | Helps the human operator inspect or prepare infrastructure changes. | Long-term target is branch/PR authoring only; any direct local commit is treated as human-authorized break-glass or maintenance. |
| In-cluster untrusted agents | Execute user-, repo-, or LLM-supplied code. | No `infra-k8s` credential, no SOPS key, no deploy key, no GitHub token with platform authority. |

Branch protection or repository rulesets MUST make the pull request gate real:

- require pull requests before merge;
- require the expected CI/policy checks before merge;
- block force pushes and branch deletion;
- prevent automation from bypassing protected `main`;
- include administrators where practical;
- use CODEOWNERS or equivalent review ownership for high-risk paths.

The GitHub permission model must be least-privilege and actor-specific:

- app repository credentials must not grant access to `infra-k8s`;
- `infra-k8s` automation credentials must not grant access to application code repositories unless explicitly required;
- a credential that can write arbitrary branches in `infra-k8s` is still sensitive, even if `main` is protected;
- a credential that can change branch protection, repository rules, secrets, workflows, or GitHub App installations is platform-admin material.

## Agent Pull Request Model

Agents may help with infrastructure changes, but the safe target workflow is PR-authoring, not PR-merging:

```text
agent proposes patch
  -> agent or human creates branch
    -> PR opens on infra-k8s
      -> CI and policy checks run
        -> human reviews
          -> human merges
            -> Flux reconciles
```

For future agent-created PRs on `infra-k8s`, use a dedicated identity with the narrowest practical GitHub permissions:

- repository-scoped, not account-wide;
- able to create/update non-protected branches and pull requests;
- unable to merge, administer the repository, edit secrets, edit rulesets, or bypass protections;
- separate from app-repo agent credentials;
- unavailable inside `untrusted-compute` workloads unless the workflow explicitly requires it and the risk has been reviewed.

If GitHub cannot technically restrict a credential to only the desired branch namespace, branch protection and review policy become mandatory compensating controls. In that case the credential is still considered sensitive and must not be placed in ordinary app or untrusted runtime namespaces.

## Consequences

This ADR turns the PR gate from a workflow preference into a security boundary.

It also clarifies the status of several existing design choices:

- Flux running with broad Kubernetes authority is acceptable only because Git is the intended control point;
- branch protection is not optional if automation or agents can write to the repository;
- `code-server` or an agent runtime is not an admin surface solely because it can edit code, but it becomes an admin surface if it holds credentials that can affect `infra-k8s/main`;
- SOPS Age private key custody is part of the same root-of-trust model;
- admission policy from ADR 0025 reduces bad Kubernetes objects, but it does not replace GitHub repository controls.

The operational recommendations for implementing this ADR are tracked separately in [`docs/gitops-root-of-trust-recommendations.md`](../gitops-root-of-trust-recommendations.md).
