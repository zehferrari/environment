# ThinkPad P16s Gen 2 Environment

This folder mirrors the Wayland/Hyprland desktop configuration for the laptop `thinkpad` — the AI agent host (see [`../ai/README.md`](../ai/README.md)).

## Managed Paths

- `~/.config/hypr` -> `.config/hypr`
- `~/.config/waybar` -> `.config/waybar`
- `~/.config/wob` -> `.config/wob`
- `~/.config/environment.d/50-uwsm.conf` -> `.config/environment.d/50-uwsm.conf`
- `~/.config/systemd/user/wayland-wm-env@hyprland.desktop.service.d` -> `.config/systemd/user/wayland-wm-env@hyprland.desktop.service.d`
- `~/.config/systemd/user/wayland-wm@hyprland.desktop.service.d` -> `.config/systemd/user/wayland-wm@hyprland.desktop.service.d`
- `~/.local/share/wayland-sessions/hyprland-uwsm.desktop` -> `.local/share/wayland-sessions/hyprland-uwsm.desktop`
- `~/.local/share/applications/jetbrains-phpstorm.desktop` -> `.local/share/applications/jetbrains-phpstorm.desktop`
- `~/.local/share/icons/hicolor/index.theme` -> `.local/share/icons/hicolor/index.theme`
- `~/.local/share/icons/hicolor/scalable/apps/jetbrains-phpstorm.svg` -> `.local/share/icons/hicolor/scalable/apps/jetbrains-phpstorm.svg`
- `~/.local/bin/hyprlock-dpms` -> `.local/bin/hyprlock-dpms`
- `~/.local/bin/volume-osd` -> `.local/bin/volume-osd`
- `~/.local/bin/grimblast` -> `.local/bin/grimblast`
- `~/Scripts/closeWindows.sh` -> `Scripts/closeWindows.sh`
- `~/Scripts/screenshot.sh` -> `Scripts/screenshot.sh`
- `~/Scripts/shutDown.sh` -> `Scripts/shutDown.sh`
- `~/Scripts/loadSession.sh` -> `Scripts/loadSession.sh`

## Hardware Specs

- Model: Lenovo ThinkPad P16s Gen 2
- Hostname: `thinkpad`
- OS: openSUSE Tumbleweed
- Kernel: Linux 7.0.2-1-default
- Firmware: R2FET68W 1.48, dated 2026-01-28
- CPU: AMD Ryzen 7 PRO 7840U w/ Radeon 780M Graphics
- CPU layout: 8 cores, 16 threads, up to 5.13 GHz
- GPU: AMD Radeon 780M / Phoenix1 integrated graphics
- Memory: 60 GiB online reported by the OS
- Storage: Samsung SSD 990 PRO 1TB NVMe
- Internal display: Lenovo 3840x2400 at 60 Hz, 340x220 mm, scale 2.0
- Ethernet: Realtek RTL8111/8168/8211/8411 Gigabit Ethernet
- Wi-Fi: Qualcomm QCNFA765 wireless adapter
- Camera: Luxvisions Innotech integrated camera
- Fingerprint/security device: Synaptics USB device

## Desktop Stack

- Compositor: Hyprland
- Session manager: UWSM via `hyprland-uwsm.desktop`
- Bar: Waybar
- Lock helper: hyprlock via `hyprlock-dpms`
- Screenshots: `grimblast`, `grim`, `slurp`, `wl-copy`, optional `swappy`
- Volume OSD: `volume-osd` with Wob FIFO support
