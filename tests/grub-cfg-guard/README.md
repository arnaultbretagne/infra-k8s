# grub-cfg-guard

Tests of `bootstrap/grub-guard/grub-cfg-guard`, which checks after every dpkg run and hourly that
`/boot/grub/grub.cfg` would boot and regenerates it if not, and of the `HostGrub*` alerts fed by it
(`observability/rules.yaml`, through node-exporter's textfile collector).

`ci.sh` does two things:

1. It runs the guard on a fake `/boot` (the kernels the fixtures load) with a fake `grub-mkconfig`,
   case by case. A good config passes. The 2026-11-22 config is caught by `--check`, which changes
   nothing, and is replaced when the regenerated config boots. A regenerated config that would not
   boot is rejected. The check follows the layout (`/vmlinuz-*` on a separate `/boot`, `/boot/vmlinuz-*`
   when `/boot` is on `/`). A missing initrd fails, and so does a search for another filesystem.
2. It runs `promtool check rules` and `promtool test rules alerts.test.yaml` on the
   `bretagne-critical` PrometheusRule, cut out of `kubectl kustomize observability`. Its promtool is
   pinned and checked as in `tests/flux-alerts`.

`fixtures/` holds g4's two real configs. `broken-2026-11-22.cfg` is the one unattended-upgrades wrote
that morning: entries search the root LV (LUKS2 + LVM, unreadable by GRUB) for `/boot/vmlinuz-*`.
`separate-boot.cfg` is the one `update-grub` wrote once the host was healthy again.

By hand, on Linux (GNU `stat`), with kubectl and promtool on the machine:

```bash
PROMTOOL=$(command -v promtool) bash tests/grub-cfg-guard/ci.sh
```
