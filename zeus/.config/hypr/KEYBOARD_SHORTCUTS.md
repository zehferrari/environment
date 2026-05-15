# Hyprland Keyboard Shortcuts

This file reflects the active bindings in `~/.config/hypr/hyprland.conf`.

`Super` means the Windows key and maps to `$mainMod`.

## Applications

| Shortcut | Action |
| --- | --- |
| `Super + Q` | Open Ghostty |
| `Super + E` | Open Nautilus |
| `Super + R` | Open Fuzzel launcher |
| `Super + B` | Open GNOME Bluetooth settings |
| `Ctrl + Shift + Alt + C` | Open GNOME Calculator |
| `Super + Z` | Load saved session with `~/Scripts/loadSession.sh --hard` |

## Window Management

| Shortcut | Action |
| --- | --- |
| `Super + C` | Kill active window |
| `Super + M` | Exit Hyprland |
| `Super + V` | Toggle floating |
| `Super + P` | Toggle pseudotile for dwindle |
| `Super + J` | Toggle split for dwindle |
| `Super + Left/Right/Up/Down` | Move focus |
| `Super + Left Mouse Drag` | Move window |
| `Super + Right Mouse Drag` | Resize window |
| `Super + Shift + C` | Run `~/Scripts/closeWindows.sh` |

## Workspaces

| Shortcut | Action |
| --- | --- |
| `Super + 1` through `Super + 9` | Switch to workspaces 1 through 9 |
| `Super + 0` | Switch to workspace 10 |
| `Super + Shift + 1` through `Super + Shift + 9` | Move active window to workspaces 1 through 9 |
| `Super + Shift + 0` | Move active window to workspace 10 |
| `Super + Mouse Down` | Next existing workspace |
| `Super + Mouse Up` | Previous existing workspace |
| `Super + S` | Toggle special workspace `magic` |
| `Super + Shift + S` | Move active window to special workspace `magic` |

## Displays And Locking

| Shortcut | Action |
| --- | --- |
| `Super + L` | Lock with `hyprlock-dpms` |
| `Super + A` | Re-apply monitor layout with `apply-displays.sh` |
| `Ctrl + Shift + Alt + Page_Down` | Run shutdown script |

## Screenshots

| Shortcut | Action |
| --- | --- |
| `Print` | Freeze screen, select region, copy and save screenshot |
| `Shift + Print` | Copy and save full-screen screenshot |
| `Alt + Print` | Copy and save active-window screenshot |
| `Super + Print` | Freeze screen, select region, then edit in Swappy |
| `Ctrl + Print` | Run legacy region screenshot script |

Screenshots are saved under `~/Pictures/Screenshots/` where applicable.

## Audio And Media

| Shortcut | Action |
| --- | --- |
| `XF86AudioRaiseVolume` | Increase volume via `volume-osd` |
| `XF86AudioLowerVolume` | Decrease volume via `volume-osd` |
| `XF86AudioMute` | Play/pause media via `playerctl` |
| `XF86AudioMicMute` | Toggle default microphone mute |

## Help

| Shortcut | Action |
| --- | --- |
| `Super + /` | Show keybindings helper |
| `Super + F1` | Show keybindings helper |

## Workspace Placement

Workspace placement is handled by `~/.config/hypr/apply-displays.sh`:

| Workspaces | Display |
| --- | --- |
| `1, 2` | KOGAN 27" |
| `3, 4` | Dell U2421E portrait |
| `5, 6` | KOGAN 34" ultrawide |
| `7, 8` | ZEUSLAP right |
| `9, 10` | ZEUSLAP left-ish |

## Reloading

After editing `hyprland.conf`, reload with:

```bash
hyprctl reload
```
