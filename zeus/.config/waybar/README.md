# Waybar Configuration for Vertical Monitor

Waybar is configured to display on your **vertical monitor (DP-6)** - the Dell 24" in portrait mode.

## Configuration

### Location
- Config: `~/.config/waybar/config`
- Style: `~/.config/waybar/style.css`

### Monitor
Waybar is pinned to **DP-6** (Dell 24" portrait monitor) on the **left edge**.

### Layout

```
┌─────┐
│  4  │ Workspaces (assigned to this monitor)
│  5  │
├─────┤
│     │ Window title
│     │
├─────┤
│ 11  │ Clock (HH:MM format)
│ 26  │
├─────┤
│ 🔊  │ Audio volume
│ 75% │
├─────┤
│ 📶  │ Network
│ 100%│
├─────┤
│ 💻  │ CPU usage
│ 15% │
├─────┤
│ 🧠  │ Memory usage
│ 32% │
├─────┤
│ 🌡️  │ Temperature
│ 45°C│
├─────┤
│ 🔋  │ Battery (if laptop)
│ 95% │
├─────┤
│ 📋  │ System tray
└─────┘
```

## Features

### Workspaces
- Shows workspaces 4 and 5 (assigned to DP-6)
- Active workspace highlighted with blue border
- Click to switch workspaces
- Scroll to navigate

### Clock
- Displays time in vertical format: `HH\nMM`
- Click to toggle date view: `YYYY\nMM\nDD`
- Hover for calendar popup
- Timezone: Australia/Sydney

### System Monitors

#### Audio (🔊)
- Shows current volume percentage
- Click to open Pavucontrol
- Scroll on module to adjust volume (±6%)
- Icon changes with volume level
- Muted shows 🔇

#### Network (📶)
- WiFi: Shows signal strength
- Ethernet: Shows 🔌 icon
- Disconnected: Shows ⚠️
- Click to open network manager
- Tooltip shows IP address and SSID

#### CPU (💻)
- Real-time usage percentage
- Updates every 2 seconds
- Hover for detailed info

#### Memory (🧠)
- RAM usage percentage
- Tooltip shows detailed RAM and swap usage

#### Temperature (🌡️)
- CPU temperature in Celsius
- Turns red and blinks above 80°C
- Adjust `hwmon-path` if not working

#### Battery (🔋)
- Shows charge percentage
- Different icon when charging
- Warning at 30%, critical at 15%
- Click for time remaining

#### System Tray (📋)
- Shows system tray applications
- Icons for apps running in background

## Customization

### Change Width
Edit line 6 in `config`:
```json
"width": 50,  // Change to 40-60
```

### Change Position
Edit line 4 in `config`:
```json
"position": "left",  // Options: left, right, top, bottom
```

### Move to Different Monitor
Edit line 5 in `config`:
```json
"output": "DP-4",  // Change to DP-4, DP-5, or DP-1
```

### Adjust Colors
Edit `style.css` and modify the color values:
- `#89b4fa` - Blue (workspaces, clock)
- `#94e2d5` - Cyan (network)
- `#f9e2af` - Yellow (CPU)
- `#cba6f7` - Purple (memory)
- `#fab387` - Orange (temperature)
- `#a6e3a1` - Green (battery)
- `#f38ba8` - Red (critical states)

### Change Font
Edit line 6 in `style.css`:
```css
font-family: "Font Awesome 6 Free", "JetBrains Mono", "Noto Sans", sans-serif;
```

### Temperature Sensor
If temperature doesn't work, find your sensor:
```bash
ls /sys/class/hwmon/hwmon*/temp*_input
cat /sys/class/hwmon/hwmon3/temp1_input
```

Then update line 98 in `config` with the correct path.

## Control Waybar

### Toggle Visibility
In Hyprland, press: `Super + S`

This sends a signal to toggle waybar visibility.

### Restart Waybar
```bash
killall waybar
waybar &
```

Or in Hyprland:
```bash
pkill waybar && waybar &
```

### Reload Configuration
```bash
pkill waybar -SIGUSR2
```

## Modules Available (Not Enabled)

You can add these modules to `config`:

- `backlight` - Screen brightness
- `bluetooth` - Bluetooth status
- `disk` - Disk usage
- `idle_inhibitor` - Prevent sleep
- `mpris` - Media player controls
- `sway/mode` - Current mode (Hyprland equivalent)

### Example: Add Backlight
In `config`, add to `modules-right`:
```json
"modules-right": [
    "backlight",
    "pulseaudio",
    ...
]
```

Then add configuration:
```json
"backlight": {
    "format": "{icon}\n{percent}%",
    "format-icons": ["", ""]
},
```

## Troubleshooting

### Waybar doesn't appear
1. Check if running: `ps aux | grep waybar`
2. Check output setting matches your monitor
3. Try launching manually: `waybar`
4. Check logs: `waybar --log-level debug`

### Wrong monitor
Edit `config` line 5 to change output.

### Icons not showing
Install Font Awesome:
```bash
sudo dnf install fontawesome-6-free-fonts fontawesome-6-brands-fonts
```

### Temperature not working
Different systems use different sensors. Find yours:
```bash
sensors
```

Then update the `hwmon-path` in config.

### Workspaces not showing
Make sure you're in Hyprland (not GNOME) and on the correct monitor.

## Fonts Required

- **Font Awesome 6 Free** ✓ Installed
- **Font Awesome 6 Brands** ✓ Installed
- **JetBrains Mono** (recommended for monospace)
- **Noto Sans** (fallback)

To install JetBrains Mono:
```bash
sudo dnf install jetbrains-mono-fonts
```

## Testing

Test with debug output:
```bash
waybar --config ~/.config/waybar/config --style ~/.config/waybar/style.css --log-level debug
```

## Auto-start

Waybar is already configured to auto-start in Hyprland via:
```
~/.config/hypr/hyprland.conf
```

Line 24: `exec-once = waybar`

## Additional Resources

- Waybar Wiki: https://github.com/Alexays/Waybar/wiki
- Module Documentation: https://github.com/Alexays/Waybar/wiki/Module:-*
- Style Guide: https://github.com/Alexays/Waybar/wiki/Styling
