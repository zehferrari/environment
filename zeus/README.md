# Zeus Desktop Environment

This folder mirrors the Wayland/Hyprland desktop configuration for the workstation `fedora` (hostname), the multi-monitor Ryzen + RTX 5080 build referred to as **Zeus**.

## Managed Paths

- `~/.config/hypr` -> `.config/hypr`
- `~/.config/waybar` -> `.config/waybar`
- `~/.config/wob` -> `.config/wob`
- `~/.config/environment.d/50-uwsm.conf` -> `.config/environment.d/50-uwsm.conf`
- `~/.config/systemd/user/wayland-wm-env@hyprland.desktop.service.d` -> `.config/systemd/user/wayland-wm-env@hyprland.desktop.service.d`
- `~/.config/systemd/user/wayland-wm@hyprland.desktop.service.d` -> `.config/systemd/user/wayland-wm@hyprland.desktop.service.d`
- `~/.local/share/wayland-sessions/hyprland-uwsm.desktop` -> `.local/share/wayland-sessions/hyprland-uwsm.desktop`
- `~/.local/bin/hyprlock-dpms` -> `.local/bin/hyprlock-dpms`
- `~/.local/bin/volume-osd` -> `.local/bin/volume-osd`
- `~/.local/bin/grimblast` -> `.local/bin/grimblast`
- `~/.local/bin/disable-hdmi-audio` -> `.local/bin/disable-hdmi-audio`
- `~/.local/bin/start-wob` -> `.local/bin/start-wob`
- `~/Scripts/closeWindows.sh` -> `Scripts/closeWindows.sh`
- `~/Scripts/screenshot.sh` -> `Scripts/screenshot.sh`
- `~/Scripts/shutDown.sh` -> `Scripts/shutDown.sh`
- `~/Scripts/loadSession.sh` -> `Scripts/loadSession.sh`

## Hardware Specs

- Hostname: `fedora`
- OS: Fedora Linux 43 (Workstation Edition)
- Kernel: Linux 7.0.4-100.fc43.x86_64
- Filesystem: BTRFS for `/` and `/home`
- CPU: AMD Ryzen 9 9950X3D (16C/32T, up to 5.7 GHz)
- GPU: NVIDIA GeForce RTX 5080 16GB (GB203)
- iGPU: AMD Radeon Graphics (Granite Ridge)
- Memory: 64 GiB DDR5-6000 (2x32GB Kingston Fury Beast)
- Motherboard: Gigabyte X870 Aorus Elite WiFi7
- Storage: Samsung 9100 PRO 2TB PCIe 5.0 NVMe
- Ethernet: Realtek RTL8125 (r8169)
- Wi-Fi: Realtek RTL8922AE Wi-Fi 7 (rtw89_8922ae)
- Bluetooth: Realtek (btusb)

## Display Layout (5 Monitors)

- DP-5: Kogan 27in QHD, 2560x1440, 144 Hz, workspaces 1-2
- DP-6: Dell U2421E, 1920x1200, 60 Hz, workspaces 3-4
- DP-4: Kogan 34in ultrawide, 3440x1440, 144 Hz, VRR enabled, workspaces 5-6
- HDMI (AMD): ZeusLap P16F, 2560x1600, 60 Hz, scale 1.6, workspaces 7-8
- HDMI-A-3 (NVIDIA): ZeusLap P16F, 2560x1600, 60 Hz, scale 1.6, workspaces 9-10

## Desktop Stack

- Compositor: Hyprland
- Session manager: UWSM via `hyprland-uwsm.desktop`
- Bar: Waybar
- Lock helper: hyprlock via `hyprlock-dpms`
- Screenshots: `grimblast`, `grim`, `slurp`, `wl-copy`, optional `swappy`
- Volume OSD: `volume-osd` with Wob FIFO support (`start-wob`)
- HDMI audio: disabled at session start via `disable-hdmi-audio`

## Peripherals

- Keyboard: Keychron Q6 Max
- Mouse: Logitech MX Ergo
- Webcam: Logitech StreamCam (x2)
- Microphone: Blue Yeti Nano

## Drivers and Media Stack

- NVIDIA proprietary stack installed (`akmod-nvidia`, CUDA userspace available)
- AMD GPU stack active via `amdgpu`
- Multimedia stack installed (RPM Fusion + codecs, FFmpeg, GStreamer full plugins, HEIC/AVIF/WebP support)

## ComfyUI / Confy Image Service

- Host/IP: `fedora`, `10.0.0.17`
- Service: user unit `confy.service`
- Wrapper: `~/.local/bin/confy {start|stop|restart}`
- ComfyUI root: `~/Code/ComfyUI`
- Python environment: `~/Code/ComfyUI/.venv`
- API/UI: `http://10.0.0.17:8188`
- PM webapp usage: agent profile-image generation from `ai/web` through
  `PM_PROFILE_IMAGE_CONFY_URL` (default `http://10.0.0.17:8188`).

The PM app generates agent `profile.png` and `avatar.png` as 256x256 PNGs.
The Profile is generated with FLUX.1-dev FP8. The Avatar uses the Profile as a
face identity reference through PuLID-FLUX, so it should
preserve the same face shape, age cues, gender presentation, ethnicity cues,
hairline, and facial proportions much better than plain img2img.
The PM UI stages the Profile first; Avatar generation is manually triggered only
after a Profile source has been delivered. If an Avatar is not generated, PM
saves `avatar.png` as a symlink to `profile.png`.

Installed ComfyUI custom node:

- `~/Code/ComfyUI/custom_nodes/ComfyUI-PuLID-Flux`
  - Local compatibility patch: `pulidflux.py::forward_orig` accepts
    `timestep_zero_index`/extra kwargs for ComfyUI `0.24.0`.

Installed model files:

- `~/Code/ComfyUI/models/checkpoints/flux1-dev-fp8.safetensors`
- `~/Code/ComfyUI/models/pulid/pulid_flux_v0.9.1.safetensors`
- `~/Code/ComfyUI/models/insightface/models/antelopev2/`

Important PM-side tuning knobs:

- `PM_PROFILE_IMAGE_CONFY_MODEL`: checkpoint name, defaults to
  `flux1-dev-fp8.safetensors`
- `PM_PROFILE_IMAGE_STEPS`: normal saved-generation sampling steps, defaults
  to `20`
- `PM_PROFILE_IMAGE_PREVIEW_STEPS`: staged preview/regeneration sampling steps,
  defaults to `18`
- `PM_PROFILE_IMAGE_PULID_FLUX_MODEL`: PuLID-FLUX model name, defaults to
  `pulid_flux_v0.9.1.safetensors`
- `PM_PROFILE_IMAGE_PULID_FLUX_WEIGHT`: identity-reference strength, defaults
  to `1.15`

Verification:

```bash
systemctl --user status confy.service --no-pager
curl -s http://127.0.0.1:8188/object_info | rg 'PulidFlux|ApplyPulid'
```
