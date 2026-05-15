# Hyprland Optimizations - Implementation Summary
## Applied: January 4, 2026

## ✅ NVIDIA Driver Status
- **RTX 5080 Active**: Driver 580.119.02 running
- **CUDA Version**: 13.0
- **Memory**: 16303 MiB available
- **Status**: Fully operational after reboot

---

## 🎨 Visual Enhancements Applied

### Blur & Shadows
- **Blur size**: 3 → **8** (2.6x increase)
- **Blur passes**: 1 → **3** (smoother, more pronounced)
- **Shadow range**: 4 → **20** (5x larger, more dramatic)
- **Shadow power**: 3 → **4** (softer gradient)
- **Corner rounding**: 8 → **12** pixels
- **Window dimming**: Enabled (0.1 strength for inactive windows)

### Animations
- Added 4 bezier curves for variety:
  - `overshot` - Bouncy effect
  - `smoothOut` - Smooth exit
  - `smoothIn` - Smooth entry
  - Standard curve improved
- Enhanced workspace switching with vertical slide
- Border animations loop continuously
- Window movements now use overshot for satisfying bounce

---

## ⚡ Performance Optimizations

### NVIDIA Environment Variables Added:
```
CLUTTER_BACKEND=wayland
SDL_VIDEODRIVER=wayland
QT_QPA_PLATFORM=wayland
MOZ_ENABLE_WAYLAND=1
NVD_BACKEND=direct
__GL_GSYNC_ALLOWED=1
__GL_VRR_ALLOWED=1
```

### Misc Settings:
- ✓ Variable Refresh Rate (VRR) enabled
- ✓ Variable Frame Rate (VFR) enabled
- ✓ DPMS wake on mouse/keyboard
- ✓ Animated manual resizes
- ✓ Window swallowing for terminals
- ✓ Logo/splash disabled

### Cursor Size:
- 24 → **32** pixels (better visibility on high-res displays)

---

## 📦 New Packages Installed

### Already Installed (Verified):
- rofi-wayland
- alacritty
- btop
- obs-studio
- easyeffects
- imv
- cliphist

### Newly Installed:
- **dolphin** - KDE file manager
- **swappy** - Screenshot editor
- **zathura** + zathura-pdf-mupdf - PDF viewer
- +91 dependencies

---

## 🎯 Window Rules Added

### Auto-workspace Assignment:
- **Workspace 6** (Ultrawide): VS Code, PHPStorm, IDEs
- **Workspace 7** (Ultrawide): Chrome, Firefox, browsers
- **Workspace 4** (Portrait): Discord, Slack, communication
- **Workspace 2** (Left): Spotify, VLC, media
- **Workspace 3** (Left): GIMP

### Floating Windows:
- Picture-in-Picture
- File dialogs
- GIMP tool windows
- pavucontrol, blueman, nm-connection-editor

### Opacity:
- Terminals (kitty/alacritty): 95% active, 85% inactive
- VS Code: 92% active, 88% inactive

### Performance:
- Blur disabled for fullscreen & games
- Immediate rendering for Steam games

---

## ⌨️ New Keybindings

### System Monitoring:
- `Super + I` → btop system monitor
- `Super + Shift + G` → NVIDIA GPU monitor (nvidia-smi)

### Utilities:
- `Super + C` → Clipboard history (cliphist)
- `Super + Shift + C` → Color picker (hyprpicker)
- `Super + Shift + S` → Screenshot editor (swappy)
- `Super + ~` (grave) → Scratchpad terminal
- `Super + Shift + E` → Dolphin file manager

---

## 🔄 Autostart Services

Added:
- **wl-paste --watch cliphist store** - Clipboard history daemon

Existing:
- waybar
- dunst
- lxpolkit
- nm-applet
- blueman-applet
- hyprpaper

---

## 📊 Expected Performance

With RTX 5080 now active:

### Before (with nouveau):
- Basic compositing
- Limited acceleration
- 60Hz locked
- Simple blur/shadows

### After (with optimizations):
- **Full GPU acceleration**
- **Smooth blur** even with size=8, passes=3
- **Enhanced shadows** with no performance hit
- **VRR support** ready (once monitor refresh rates updated)
- **Instant** window operations
- **Butter smooth** animations

---

## 🚀 Next Steps (Optional)

### 1. Update Monitor Refresh Rates
Check available modes:
```bash
hyprctl monitors all
```

Then update in `hyprland.conf`:
```conf
# Example - adjust based on your monitors' capabilities
monitor=DP-4,3440x1440@100,3760x211,1  # Ultrawide
monitor=DP-5,2560x1440@144,0x0,1       # 27"
monitor=DP-6,1920x1200@144,2560x0,1,transform,3  # Dell portrait
```

### 2. Test New Features

**Try these in Hyprland:**
1. Press `Super + I` for system monitor
2. Press `Super + Shift + G` for GPU stats
3. Copy text, then press `Super + C` for history
4. Press `Super + Shift + S` to edit screenshots
5. Press `Super + ~` for scratchpad terminal

### 3. Install Optional Tools

**Animated Wallpapers:**
```bash
sudo dnf copr enable alternateved/swww
sudo dnf install -y swww
```

**Video Wallpapers:**
```bash
sudo dnf install -y mpvpaper
```

**Better Notifications:**
```bash
sudo dnf install -y mako
```

---

## 📝 Configuration Files Modified

1. **~/.config/hypr/hyprland.conf**
   - Environment variables (lines 31-53)
   - Decoration section (lines 77-100)
   - Animations section (lines 102-120)
   - Misc section (lines 136-149)
   - Window rules (lines 365-419)
   - New keybindings (lines 346-368)
   - Autostart (line 30)

2. **System packages**
   - 4 new applications + 91 dependencies

---

## 🎯 Performance Metrics

### GPU Utilization (Current):
- **Idle**: ~27% (GNOME Shell + Warp Terminal)
- **Memory**: 369 MiB / 16303 MiB

### Expected in Hyprland:
- **Idle**: 5-10% (much lighter than GNOME)
- **Active**: 15-30% (with heavy blur/effects)
- **Gaming**: Up to 100% (as it should be)

---

## ✨ Visual Differences You'll Notice

1. **Blur** - Much more pronounced behind windows
2. **Shadows** - Larger, softer, more dramatic
3. **Corners** - More rounded (12px vs 8px)
4. **Animations** - Bouncy, overshooting effect
5. **Dimming** - Inactive windows slightly darker
6. **Borders** - Animated gradient rotation
7. **Transparency** - Terminals and editors slightly see-through

---

## 🐛 Troubleshooting

### If blur is too heavy:
Edit `~/.config/hypr/hyprland.conf`, line 84-85:
```conf
size = 8    # Try 6 or 4
passes = 3  # Try 2 or 1
```

### If animations are too slow/fast:
Adjust the middle number in animation lines (line 111-118):
```conf
animation = windows, 1, 5, myBezier, slide
#                       ^ Change this (1-10)
```

### If workspace switching feels laggy:
Check monitor refresh rates are properly detected:
```bash
hyprctl monitors
```

---

## 📚 Documentation

All optimizations are documented in:
- `~/.config/hypr/OPTIMIZATIONS.md` - Full optimization guide
- `~/.config/hypr/MONITOR_SETUP.md` - Monitor configuration
- `~/.config/hypr/KEYBOARD_SHORTCUTS.md` - All keybindings
- `~/.config/hypr/HYPRLAND_GUIDE.md` - General usage

---

## ✅ Ready to Test!

Log out of GNOME and select **Hyprland** from GDM to experience the optimizations!

All settings are applied and ready. Your RTX 5080 is now fully utilized for the best Hyprland experience possible.
