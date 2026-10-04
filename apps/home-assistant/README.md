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
                                                                ──> 10.10.30.110:3001 + udp/9 (LG webOS TV, VLAN 30)
```

| File | Role |
|---|---|
| `deployment.yaml` | HA (root image, PSS baseline, read-only rootfs) + `provision` init + `onboard` native sidecar |
| `configmap.yaml` | `configuration.yaml` (Git-owned), `http-config.json` (reverse-proxy trust, written straight into `.storage/http` — see below), `provision.py`, `onboard.py`, `dashboard-*.yaml` (Git-owned dashboards), `tv-remote-card.js` (the Télécommande card) |
| `oidc-configmap.yaml` | owner username (= Pocket-ID username) and the Pocket-ID `client_id` |
| `cluster.yaml` | `ha-pg` CNPG cluster + daily backup; `restore-test.yaml` proves it restores |
| `config-backup.yaml` | nightly tarball of `/config` to R2 (`home-assistant-config/` prefix, 14 days) |
| `networkpolicy.yaml` | default-deny; egress = DNS, ha-pg, `10.10.40.10:6638`, `10.10.30.110:3001` + UDP `9` (Wake-on-LAN), HTTPS |

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

## LG TV remote (webostv)

The TV is an LG OLED65CX6LA (webOS 5.6.2) on VLAN 30 at `10.10.30.110`, MAC
`58:fd:b1:65:fe:04` (keep its DHCP reservation: the IP is pinned in the network policy). HA talks to
it with the built-in **LG webOS TV** integration over the SSAP WebSocket, `wss://10.10.30.110:3001`.

- **Router (not in this repo):** VLAN 20 `10.10.20.10` → `10.10.30.110` TCP `3001` (in place since
  2026-10-03). The pod has no SSDP path to VLAN 30, so the TV is never auto-discovered.
- **Port 3000 must be refused, not dropped.** aiowebostv tries plain `ws://:3000` first and falls
  back to `wss://:3001` only on a refusal; a silent drop outlasts its 2 s connect timeout and the
  flow fails with "cannot connect" and no prompt on the TV. So the network policy lets `:3000` out,
  and the router answers it with a reset. Keep the router refusing `:3000` (plain text).
- **The router's "host unreachable" must come back too.** When the TV is off, each reconnect to
  `:3001` is answered by an ICMP destination-unreachable from the VLAN 30 gateway `10.10.30.1`, not
  from the TV. Cilium only ties an ICMP error to the connection when the peer itself sends it, so
  the network policy admits ICMP type 3 from `10.10.30.1`; without it, NetworkPolicyDrops fires
  every time the TV is in standby.
- **Pairing (once, TV on):** Settings → Devices & services → Add integration → *LG webOS TV* → host
  `10.10.30.110` → accept the prompt on the TV with the physical remote. The client key lands in the
  config entry (and in the nightly `/config` backup).
- **Entity id:** the manual flow titles the device `LG webOS TV <modelName>`; the TV was named
  *Salon TV* when paired (2026-10-03), so the media player is `media_player.salon_tv` (the screen
  switch, disabled by default, kept `switch.lg_webos_tv_oled65cx6la_screen`). The **Télécommande**
  dashboard (`dashboard-telecommande-tv.yaml`, sidebar) names it once, in the card's `entity`:
  rename the entity, change that line. HA re-reads a YAML dashboard when its file changes,
  so a fix can also be written to `/config/dashboards/` ahead of the merge; `provision.py` reseeds it
  from Git at the next start.
- **Keys:** `webostv.button` sends the remote's key names over the TV's pointer input socket, so a
  key acts like the physical remote (volume follows an ARC soundbar). The authoritative list of key
  names is the table inside the TV's `/usr/sbin/network-input-service` (`ssh lg-tv` from g4). Apps
  and HDMI inputs are launched by id with `webostv.command` `system.launcher/launch`; list ids with
  `luna-send -n 1 luna://com.webos.applicationManager/listLaunchPoints '{}'` on the TV.
- **The Télécommande is one full-screen card.** `tv-remote-card.js` (a key of `configmap.yaml`) is
  a custom card that `provision.py` copies to `www/` and `frontend.extra_module_url` loads on every
  page. The dashboard is a panel view holding only that card; its `kiosk_mode` block makes the
  pinned kiosk-mode module (`KIOSK_MODE_VERSION` / `KIOSK_MODE_SHA256` in `deployment.yaml`) hide
  the header and sidebar on that dashboard only. The card holds power (`media_player.toggle`), quick
  settings, transport keys, the wheel, back, a volume capsule (mute, −, + only: with
  `sound_output: external_arc` webostv has no volume level) and a scrolling row of tiles defined in
  the dashboard YAML (Accueil is the TV's own Home key). Arrows and volume repeat while held, taps
  fire the companion app's haptics,
  and the tint follows the app in front (the tile whose `source` matches). `provision.py` puts a
  hash of each module in its URL, so a change in Git reaches the phone's cache at the next start
  (HA serves `/local/` with a 31-day cache). The card is `position: fixed` over the whole screen,
  under the status bar and the home indicator, and takes no height in the page: `hui-view-container`
  keeps `min-height: 100vh` plus the safe-area paddings, so a card sized to the viewport inside it
  overflowed by the bottom inset and scrolled. Haptics (companion app types, chosen by the user on
  a test page since removed): `haptic` on keys and tiles and `haptic_power` on power, both
  `selection`, and `haptic_off` (`failure`) on a key pressed while the TV is off, which does
  nothing. Arrows and volume are sent on pointerdown (to repeat while held); the click that
  follows is ignored by its `detail` (> 0 for a finger), never by a timer, which once sent a
  second press when iOS delivered the click late.
  Every control was checked in a phone-sized headless browser against a fake `hass` (one service
  call each, the right one).
- **iPhone shortcut:** in the Shortcuts app, one action *Open URLs* with
  `homeassistant://navigate/telecommande-tv/tv?server=default`, added to the Home Screen. It opens
  the HA app straight on the full-screen remote, while the app's own icon keeps the normal
  dashboards. The app's native kiosk mode was ruled out: it locks the whole app to one dashboard.
- **Power on/off.** Off is native (`media_player.turn_off` → SSAP `system/turnOff`). On is
  Wake-on-LAN: in standby the TV leaves the network and its NIC listens for a magic packet only
  (Quick Start+ and *Turn on via Wi-Fi/LAN* are on). webostv cannot wake it: its `turn_on` runs the
  automations on the `webostv.turn_on` trigger, here the Git-owned `tv_salon_power_on`
  (`configuration.yaml`, `automation gitops`), which sends the packet with `wake_on_lan`. While
  that automation exists the media player stays available (`off`) in standby and offers turn on,
  so `media_player.toggle` (the Télécommande's power button) does both.
  A broadcast cannot leave VLAN 20, so the packet goes **unicast** to `10.10.30.110` UDP `9`.
- **Router for Wake-on-LAN (not in this repo, in place since 2026-10-03):** traffic rule
  `g4-media-wol` = `10.10.20.10` → `10.10.30.110` **UDP** `9`, accept (the `g4-media` rule is TCP
  only), and a permanent ARP entry for the TV, because in standby it no longer answers ARP and the
  router would drop the packet with "host unreachable". RutOS 7 has no form for it; in System →
  Maintenance → CLI:
  `uci set network.tv_salon=neighbor`, then `interface='lan3'`, `ipaddr='10.10.30.110'`,
  `mac='58:fd:b1:65:fe:04'` on that section, `uci commit network`, and
  `ip neigh replace 10.10.30.110 lladdr 58:fd:b1:65:fe:04 nud permanent dev br-lan.30` to apply it
  now. `ip neigh show 10.10.30.110` must say `PERMANENT`, also after `ifup lan3`. Verified
  2026-10-03: a magic packet from g4 woke the TV within a second, while 20 minutes of webostv
  reconnects reaching the sleeping NIC had not.

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
- The LG TV cannot be switched on from HA yet (Wake-on-LAN across VLANs, see "LG TV remote").
- Bumping `hass-oidc-auth`: change `OIDC_VERSION` **and** `OIDC_SHA256` together in
  `deployment.yaml` (sha256 of the tag archive); `provision.py` fails closed on a mismatch.
