# Hyprland Keyboard Shortcuts

This file reflects the active bindings in `~/.config/hypr/hyprland.conf` for the ThinkPad P16s mirror.

`Super` means the Windows key and maps to `$mainMod`.

## Applications

| Shortcut | Action |
| --- | --- |
| `Super + Q` | Open Kitty |
| `Super + E` | Open Nautilus |
| `Super + R` | Open Fuzzel launcher |
| `Super + O` | Open OpenCode in Kitty |
| `Super + B` | Open GNOME Bluetooth settings |
| `Ctrl + Shift + Alt + C` | Open GNOME Calculator |
| `Super + Z` | Load saved session with `~/Scripts/loadSession.sh --hard` |

## Window Management

| Shortcut | Action |
| --- | --- |
| `Super + C` | Kill active window |
| `Super + M` | Run `~/Scripts/closeWindows.sh`, then exit Hyprland |
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
| Three-finger horizontal gesture | Switch workspace |
| `Super + S` | Toggle special workspace `magic` |
| `Super + Shift + S` | Move active window to special workspace `magic` |

## Locking And Shutdown

| Shortcut | Action |
| --- | --- |
| `Super + L` | Lock with `hyprlock-dpms` |
| `Ctrl + Shift + Alt + Page_Down` | Run `~/Scripts/shutDown.sh` |

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

## Reloading

After editing `hyprland.conf`, reload with:

```bash
hyprctl reload
```
