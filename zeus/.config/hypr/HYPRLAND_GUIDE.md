# Hyprland Quick Reference Guide

## Installation Complete! ✓

Hyprland v0.51.1 has been successfully installed on your Fedora 43 system with all necessary components.

## Starting Hyprland

### From GDM (GNOME Display Manager)
1. Log out of your current session
2. At the GDM login screen, click the gear icon ⚙️ (bottom right)
3. Select "Hyprland" from the session list
4. Log in

### From TTY (Alternative)
If you prefer to start from a TTY:
```bash
# Switch to TTY (Ctrl+Alt+F3)
# Login and run:
Hyprland
```

## Installed Components

### Core
- **Hyprland** 0.51.1 - The compositor
- **Hyprpaper** - Wallpaper utility
- **Hyprlock** - Screen locker
- **Hypridle** - Idle daemon
- **xdg-desktop-portal-hyprland** - Desktop portal

### UI Components
- **Waybar** - Status bar
- **Wofi** - Application launcher (Super+D)
- **Dunst** - Notification daemon
- **Kitty** - Terminal emulator

### Utilities
- **grim** & **slurp** - Screenshot tools
- **wl-clipboard** - Clipboard manager
- **pavucontrol** - Audio control
- **nm-applet** - Network manager
- **blueman** - Bluetooth manager
- **lxpolkit** - Authentication agent
- **Thunar** - File manager
- **file-roller** - Archive manager

## Key Bindings (Super = Windows Key)

### Essential
- `Super + Return` - Open terminal (Kitty)
- `Super + D` - Open application launcher (Wofi)
- `Super + Q` - Close active window
- `Super + M` - Exit Hyprland
- `Super + V` - Toggle floating mode
- `Super + E` - Open file manager (Nautilus)

### Window Navigation
- `Super + H/J/K/L` - Move focus (vim keys)
- `Super + Arrow Keys` - Move focus (arrow keys)

### Workspaces
- `Super + 1-9` - Switch to workspace 1-9
- `Super + Shift + 1-9` - Move window to workspace 1-9
- `Super + Mouse Wheel` - Cycle workspaces

### Window Management
- `Super + Left Click` - Move window
- `Super + Right Click` - Resize window

### Screenshots
- `Print` - Select area screenshot (to clipboard)
- `Shift + Print` - Full screen screenshot (to clipboard)
- `Super + Print` - Screenshot to ~/Pictures/

### Media Keys
- `XF86AudioRaiseVolume/LowerVolume` - Volume up/down
- `XF86AudioMute` - Mute toggle
- `XF86AudioPlay/Next/Prev` - Media controls

## Configuration Files

Main config: `~/.config/hypr/hyprland.conf`
Wallpaper config: `~/.config/hypr/hyprpaper.conf`

## Hardware Optimization

Your system has been configured for:
- **AMD Ryzen 9 9950X3D** (integrated graphics)
- **NVIDIA RTX 5080** (with proper Wayland environment variables)

Environment variables set:
```
LIBVA_DRIVER_NAME=nvidia
GBM_BACKEND=nvidia-drm
__GLX_VENDOR_LIBRARY_NAME=nvidia
WLR_NO_HARDWARE_CURSORS=1  # Required for NVIDIA
```

## Customization

### Change Wallpaper
Edit `~/.config/hypr/hyprpaper.conf` and change the image paths.

### Modify Keybindings
Edit `~/.config/hypr/hyprland.conf` and search for "Key bindings" section.

### Theme & Appearance
- Use `qt5ct` for Qt applications theming
- GTK themes work automatically
- Modify colors in the "General settings" and "Decoration" sections

## Troubleshooting

### Black screen on login
- Press `Super + Return` to open a terminal
- Check logs: `journalctl --user -xe`

### NVIDIA issues
- Ensure you've rebooted after installing NVIDIA drivers
- Check driver status: `nvidia-smi`

### Screen tearing
- The config includes NVIDIA-specific settings
- If issues persist, try different render backends in config

## Useful Commands

```bash
# Reload Hyprland config
hyprctl reload

# Get window info
hyprctl clients

# Check active monitors
hyprctl monitors

# Show current config
cat ~/.config/hypr/hyprland.conf

# View Hyprland logs
journalctl --user -u hyprland -f
```

## Next Steps

1. **Reboot** (if you haven't already) to ensure NVIDIA drivers are fully active
2. **Log out** and select Hyprland from GDM session menu
3. **Test basic functions**:
   - Open terminal (Super+Return)
   - Launch apps (Super+D)
   - Test screenshots (Print key)
4. **Customize** your config to your preferences

## Resources

- Hyprland Wiki: https://wiki.hyprland.org/
- Configuration docs: https://wiki.hyprland.org/Configuring/Configuring-Hyprland/
- Discord: https://discord.gg/hyprland

## Notes

- You're currently running GNOME Shell on Wayland
- Hyprland is a standalone Wayland compositor (replacement for GNOME/KDE)
- You can switch between GNOME and Hyprland at the login screen
- Your GNOME settings and apps remain available
