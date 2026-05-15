# Waybar Configuration

This Waybar config is for the ThinkPad P16s Hyprland session.

## Managed Files

- `~/.config/waybar/config`
- `~/.config/waybar/style.css`
- `~/.config/waybar/launch-waybar.sh`
- `~/.config/waybar/power-menu.sh`

## Layout

- Output: `eDP-1`
- Position: top
- Height: 48px
- Left: Hyprland workspaces with workspace taskbar window icons
- Center: clock and calendar tooltip
- Right: performance and hardware groups

## Workspace Taskbar

The workspace module uses Waybar's `workspace-taskbar` mode:

- Icons are rendered from desktop/icon theme metadata.
- `update-active-window` marks the focused taskbar item as active.
- JetBrains transient popup windows titled `win0`, `win1`, etc. are ignored so PhpStorm menus do not add/remove taskbar icons.

PhpStorm icon lookup is supported by these managed aliases:

- `~/.local/share/applications/jetbrains-phpstorm.desktop`
- `~/.local/share/icons/hicolor/scalable/apps/jetbrains-phpstorm.svg`
- `~/.local/share/icons/hicolor/index.theme`

If icons are changed, refresh the local icon cache:

```bash
gtk-update-icon-cache -q -f -t ~/.local/share/icons/hicolor
```

## Modules

| Module | Purpose |
| --- | --- |
| `hyprland/workspaces` | Workspace taskbar and workspace switching |
| `clock` | Time, date, and calendar tooltip |
| `cpu` | CPU usage |
| `memory` | Memory usage |
| `temperature` | CPU temperature |
| `network` | Wi-Fi/Ethernet status and bandwidth tooltip |
| `bluetooth` | Bluetooth status |
| `pulseaudio` | Audio output status |
| `battery` | Battery status |
| `custom/displays` | Opens `wdisplays` |
| `custom/power` | Opens the Waybar power menu |

## Control

Restart Waybar with the managed launcher:

```bash
pkill -x waybar
setsid ~/.config/waybar/launch-waybar.sh >/tmp/waybar-restart.log 2>&1 &
```

Inspect logs:

```bash
cat /tmp/waybar-restart.log
```

Run a foreground debug session:

```bash
waybar -c ~/.config/waybar/config -s ~/.config/waybar/style.css --log-level debug
```

## Dependencies

- Waybar
- Hyprland
- Font Awesome 6 Free
- JetBrains Mono
- Noto Sans
- `wdisplays`
- GNOME Control Center for audio, Wi-Fi, and Bluetooth shortcuts
