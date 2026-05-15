# Hyprland Monitor Configuration

This setup is managed by `~/.config/hypr/apply-displays.sh`, not by fixed `monitor = ...` lines in `hyprland.conf`.

The script matches monitors by EDID description so the layout survives connector renames across boots, cable changes, and GPU output changes.

## Current Layout

```text
Top row:
+------------------+ +--------------------+ +---------------------------+
| KOGAN 27"        | | Dell U2421E        | | KOGAN 34" Ultrawide      |
| 2560x1440 @ 60   | | 1920x1200 @ 60     | | 3440x1440 @ 60           |
| scale 1.0        | | portrait, scale 1.0| | primary area, scale 1.0  |
| workspaces 1, 2  | | workspaces 3, 4    | | workspaces 5, 6          |
+------------------+ +--------------------+ +---------------------------+

Bottom row:
          +------------------------+          +------------------------+
          | ZEUSLAP left-ish       |          | ZEUSLAP right          |
          | 2560x1600 @ 60         |          | 2560x1600 @ 60         |
          | scale 1.6              |          | scale 1.6              |
          | workspaces 9, 10       |          | workspaces 7, 8        |
          +------------------------+          +------------------------+
```

## Scripted Positions

The active script applies these logical positions:

| Display | Position | Scale | Transform | Workspaces |
| --- | --- | --- | --- | --- |
| KOGAN 27" | `0x129` | `1` | `0` | `1, 2` |
| Dell U2421E | `2560x129` | `1` | `1` | `3, 4` |
| KOGAN 34" Ultrawide | `3760x129` | `1` | `0` | `5, 6` |
| ZEUSLAP left-ish | `961x1569` | `1.60` | `0` | `9, 10` |
| ZEUSLAP right | `3760x1569` | `1.60` | `0` | `7, 8` |

## Connector Notes

Do not rely on `DP-*` names staying stable. The current runtime may show different connector names than previous boots.

Stable matching is done by these descriptions:

| Description | Purpose |
| --- | --- |
| `KOGAN AUSTRALIA PTY LTD KAMN27Q18CSA 0000000000000` | Left KOGAN 27" |
| `Dell Inc. DELL U2421E 8TS0YG3` | Portrait Dell |
| `KOGAN AUSTRALIA PTY LTD KAMN34FXQULA` | Ultrawide |
| `ZUS ZEUSLAP-HDMI 0000000` | Both portable displays |

The two ZEUSLAP displays have identical EDID descriptions. The script sorts their connector names and assigns the higher connector name to the left-ish bottom display.

## Useful Commands

```bash
hyprctl monitors
hyprctl monitors -j
hyprctl workspaces
hyprctl dispatch moveworkspacetomonitor 5 <monitor-name>
~/.config/hypr/apply-displays.sh
```

## Notes

The connected monitors advertise higher refresh modes than the script currently applies. The setup intentionally remains at 60 Hz until higher refresh is enabled and tested explicitly.
