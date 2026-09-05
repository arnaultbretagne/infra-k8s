# Home Assistant — phase 1

Home Assistant Container + **ZHA** over the **SLZB-06p10** network coordinator (IoT VLAN), recorder on
**CloudNativePG**, login through **Pocket-ID** via `hass-oidc-auth`. Config-only app (ADR 0015): stock
image, this directory, a `/config` PVC. Playbook: [`docs/hosting-an-app.md`](../../docs/hosting-an-app.md).

```
Companion app / browser ──HTTPS──> Traefik (ha.bretagne.dev) ──> HA :8123 ──> ha-pg (CNPG)
                                                                    │
                                                    Pocket-ID (id.bretagne.dev) OIDC, public+PKCE
                                                                    │
                                  10.10.20.10 (g4, masqueraded) ──> 10.10.40.10:6638 (SLZB-06p10, VLAN 40)
```

| File | Role |
|---|---|
| `deployment.yaml` | HA (root image, PSS baseline, read-only rootfs) + `provision` init + `onboard` native sidecar |
| `configmap.yaml` | `configuration.yaml` (Git-owned), `http-config.json` (reverse-proxy trust, written straight into `.storage/http` — see below), `provision.py`, `onboard.py` |
| `oidc-configmap.yaml` | owner username (= Pocket-ID username) and the Pocket-ID `client_id` |
| `cluster.yaml` | `ha-pg` CNPG cluster + daily backup; `restore-test.yaml` proves it restores |
| `config-backup.yaml` | nightly tarball of `/config` to R2 (`home-assistant-config/` prefix, 14 days) |
| `networkpolicy.yaml` | default-deny; egress = DNS, ha-pg, `10.10.40.10:6638`, HTTPS |

## Why these choices (short)

- **ZHA, not Zigbee2MQTT + Mosquitto.** The SLZB-06p10 is a Texas Instruments CC2674P10 (Z-Stack,
  radio type **ZNP** in ZHA — not EZSP, an earlier note here was wrong). One workload instead of three to harden/police/back up, one UI, one
  backup surface. Switch to Z2M only for a device ZHA lacks, or if an MQTT bus is wanted anyway.
- **No oauth2-proxy.** The Companion app cannot cross a cookie gate; HA is its own relying party
  (ADR 0021, amendment 2026-09-05). Authorization is still Pocket-ID group `admin` (spec.json) and
  mirrored in `auth_oidc.roles`.
- **Onboarding is automated** (`onboard.py`): `ha.bretagne.dev` is public the moment the route
  reconciles and the multi-SAN cert hits CT logs — an un-onboarded HA would let the first visitor
  become owner. The owner is created from localhost with a random, discarded password.
- **Recorder on Postgres** so history gets the CNPG backup/restore drill, and `/config` stays a small
  tar-able tree. `purge_keep_days: 14`.

## Verified on g4 (2026-09-05, disposable pod from this Deployment)

Read-only rootfs boots (s6 on tmpfs `/run`); `provision` fetched v1.2.1 with the pinned sha256 and
found its requirements already in the image; `onboard` created the owner and revoked its session;
`/auth/oidc/welcome` and `/auth/authorize` answer 302 (integration loaded, `default_redirect` on);
`hass --script check_config` clean.

## Bring-up

1. **Router (not in this repo):** allow VLAN 20 `10.10.20.10` → `10.10.40.10` TCP `6638`
   (verified 2026-09-05: refused today). Keep the SLZB web UI (`:80`) reachable from the admin VLAN
   only; it is where the firmware and the Zigbee/Thread mode live.
2. Merge. Flux creates the namespace, `ha-pg`, HA. `provision` fetches hass-oidc-auth (pinned tag +
   sha256) and pre-installs its Python deps into `/config/deps`; `onboard` creates the owner
   `arnault.bretagne`. Check: `k0s kubectl -n home-assistant logs deploy/home-assistant -c onboard`
   → `onboarded: owner 'arnault.bretagne' created`.
3. **OIDC client:** run the reconciler
   (`k0s kubectl -n pocket-id create job --from=cronjob/oidc-reconciler oidc-reconciler-manual`),
   read the new `home-assistant` client's id in Pocket-ID admin, put it in `oidc-configmap.yaml`,
   PR. Until then OIDC login fails and the native login is reachable via the break-glass below.
4. Log in at `https://ha.bretagne.dev` → straight to Pocket-ID (passkey) → lands on the owner
   account (`automatic_user_linking`, same username). Finish the location/timezone/unit settings in
   the UI. Verify a **non-`admin`** Pocket-ID user is refused.
5. **ZHA:** Settings → Devices → Add integration → Zigbee → *Enter manually* → radio type **ZNP**
   (Texas Instruments Z-Stack), path `socket://10.10.40.10:6638`, baud `115200`, no flow control. The coordinator accepts one client: never point
   a second ZHA/Z2M at it.
6. **Companion app:** device-code login. Add server `https://ha.bretagne.dev`, choose Pocket-ID, the
   app shows a code; open `https://ha.bretagne.dev/auth/oidc/welcome` in any browser, sign in, enter
   the code. Once per phone.
7. Backups: `Backup` objects `completed` for `ha-pg`, `ha-pg-restore-test` `PASSED` (05:45),
   `ha-config-backup` `DONE` (04:15). Restore of `/config` = untar the latest archive onto the PVC.

## HTTP config is storage-backed (why there is no `http:` in the YAML)

HA ≥ 2026 keeps `http` settings in `.storage/http` as a stable/pending pair. A YAML `http:` block is
migrated **once** into a *pending* trial that an admin must promote in the UI within 5 minutes,
otherwise HA reverts to the previous stable config and restarts (hit on first boot: reverted to
"no trusted proxies", every request via Traefik answered 400). Unattended and Git-owned, so
`provision.py` writes the desired config as the **stable** entry (from `http-config.json`) at every
start. Change proxy trust or the ban threshold there, not in the YAML.

## Config changes need a pod restart (known gap)

The Deployment reads its settings from ConfigMaps (`configmap.yaml`, `oidc-configmap.yaml`) via
env and a mounted volume: Flux updates the ConfigMaps, but a ConfigMap change does not roll the
Deployment. After merging such a change: `k0s kubectl -n home-assistant rollout restart
deploy/home-assistant`. TODO: switch both to kustomize `configMapGenerator` (hashed names) so a
change rolls the pod by itself.

## Break-glass (native login)

The username/password provider stays enabled but hidden. No password exists anywhere until you mint one:

```bash
k0s kubectl -n home-assistant exec deploy/home-assistant -c home-assistant -- \
  hass --script auth --config /config change_password arnault.bretagne '<new password>'
```

Then open `https://ha.bretagne.dev/auth/authorize?client_id=https://ha.bretagne.dev/&redirect_uri=https://ha.bretagne.dev/&skip_oidc_redirect=true`.
Change it back to something you throw away once Pocket-ID works again.

## Sessions and roles (read before adding household accounts)

HA sessions are long-lived refresh tokens. Removing someone from the Pocket-ID group blocks their
*next* login, not their current session: also delete the user (or their refresh tokens) in HA.
Roles are read at login only. To open HA to non-operators: add a group (e.g. `home-users`) in
`spec.json` `allowedGroups` **and** in `auth_oidc.roles.user`; keep `roles.admin: admin`.

## Known limits (phase 1)

- No mDNS/SSDP/CoAP: the pod lives on the vxlan overlay. Add Wi-Fi devices (Shelly, WLED, ESPHome)
  by IP; **HomeKit Bridge cannot work** until phase 2 (Multus macvlan leg on the IoT VLAN).
- No Bluetooth (needs D-Bus + privileged). `default_config`'s DHCP discovery logs one
  `aiodhcpwatcher ... Operation not permitted` at boot (no NET_RAW) — harmless, expected.
- Every HA restart (image bump, node reboot) drops the Zigbee link ~30 s; routers keep the mesh.
- Bumping `hass-oidc-auth`: change `OIDC_VERSION` **and** `OIDC_SHA256` together in
  `deployment.yaml` (sha256 of the tag archive); `provision.py` fails closed on a mismatch.
