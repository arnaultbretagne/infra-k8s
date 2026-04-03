# ADR 0002 — Flux as GitOps Tool

## Status

Accepted

## Context

The cluster must be managed declaratively from Git. Two major tools: Flux and ArgoCD.

## Decision

Flux.

## Rationale

- Lightweight (~100-200MB RAM) vs ArgoCD (~500MB-1GB) — important on a resource-limited VPS
- Native SOPS support for secret encryption (no plugin to install)
- Pure Git-centric philosophy: no bypass UI, everything goes through commits
- Self-bootstraps and self-manages via Git (`flux bootstrap`)
- Coherent with the current workflow (PR → merge → automatic deploy)
- ArgoCD would make sense in a team setting (UI for communication), not solo

## Consequences

- No web UI to visualize cluster state — `flux get` via CLI
- Git repo polling by default (1-5min latency), optional webhook
- Flux commits its own manifests to the repo (`flux-system/` directory)
- Secrets are managed via SOPS + Age (ADR 0003), native integration
