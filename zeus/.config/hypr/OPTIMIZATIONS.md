# Hyprland Optimizations for Your Hardware
## AMD Ryzen 9 9950X3D + NVIDIA RTX 5080 + 64GB RAM

Your system is high-end and can handle much more than the default configuration. Here are recommended optimizations:

---

## 🚨 CRITICAL: NVIDIA Driver Activation

**You need to reboot!** According to your computer.txt:
```
Status: Kernel modules built and ready (will activate on next reboot)
Current: Using nouveau driver (temporary until reboot)
```

Your RTX 5080 is currently using the open-source nouveau driver. After reboot:
- NVIDIA proprietary driver will activate
- Hardware acceleration will be fully enabled
- Performance will dramatically improve
- All NVIDIA-specific features will work

---

## 🖥️ Monitor Refresh Rates

Your current config uses 60Hz for all monitors. Check capabilities and increase:

### Check Available Modes
In Hyprland, run:
```bash
hyprctl monitors all
```

Look for higher refresh rates available for each monitor.

### Likely Updates Needed

**KOGAN 34" Ultrawide (DP-4)**
```
# Current
monitor=DP-4,3440x1440@60,3760x211,1

# Try
monitor=DP-4,3440x1440@100,3760x211,1  # or @120, @144
```

**KOGAN 27" (DP-5)**
```
# Current  
monitor=DP-5,2560x1440@60,0x0,1

# Try
monitor=DP-5,2560x1440@144,0x0,1  # or @165, @180
```

**Dell 24" Portrait (DP-6)**
```
# Current
monitor=DP-6,1920x1200@60,2560x0,1,transform,3

# Try
monitor=DP-6,1920x1200@144,2560x0,1,transform,3  # Dell U2421E likely supports 144Hz
```

---

## 🎨 Enhanced Animations & Effects

Your RTX 5080 can handle much more intensive effects:

### Update hyprland.conf:

```conf
# Decoration - Enhanced for high-end GPU
decoration {
    rounding = 12  # Increased from 8
    
    blur {
        enabled = true
        size = 8  # Increased from 3
        passes = 3  # Increased from 1
        new_optimizations = true
        xray = false
        ignore_opacity = false
        noise = 0.0117
        contrast = 0.8916
        brightness = 0.8172
        vibrancy = 0.1696
        vibrancy_darkness = 0.0
    }

    drop_shadow = true
    shadow_range = 20  # Increased from 4
    shadow_render_power = 4  # Increased from 3
    shadow_offset = 0 2
    col.shadow = rgba(00000099)
    col.shadow_inactive = rgba(00000066)
    
    # Additional effects
    dim_inactive = false
    dim_strength = 0.05
}

# Animations - Smoother for high refresh rate
animations {
    enabled = true
    
    bezier = myBezier, 0.05, 0.9, 0.1, 1.05
    bezier = overshot, 0.05, 0.9, 0.1, 1.1
    bezier = smoothOut, 0.36, 0, 0.66, -0.56
    bezier = smoothIn, 0.25, 1, 0.5, 1
    bezier = easeOutExpo, 0.16, 1, 0.3, 1

    animation = windows, 1, 5, myBezier, slide
    animation = windowsOut, 1, 7, smoothOut, slide
    animation = windowsMove, 1, 6, overshot, slide
    animation = border, 1, 10, default
    animation = borderangle, 1, 20, default, loop
    animation = fade, 1, 8, easeOutExpo
    animation = fadeOut, 1, 8, easeOutExpo
    animation = workspaces, 1, 6, overshot, slidevert
    animation = specialWorkspace, 1, 6, overshot, slidevert
}

# Misc - Performance optimizations
misc {
    force_default_wallpaper = 0
    disable_hyprland_logo = true
    disable_splash_rendering = true
    vfr = true  # Variable refresh rate
    vrr = 1  # Variable refresh rate for monitors
    mouse_move_enables_dpms = true
    key_press_enables_dpms = true
    animate_manual_resizes = true
    animate_mouse_windowdragging = true
    enable_swallow = true
    swallow_regex = ^(kitty)$
}
```

---

## 🎮 Gaming & Performance Tweaks

### Add to hyprland.conf:

```conf
# OpenGL optimizations
opengl {
    nvidia_anti_flicker = true
    force_introspection = 2
}

# Render settings
render {
    explicit_sync = 2  # For NVIDIA
    explicit_sync_kms = 2
    direct_scanout = true
}
```

---

## 🔧 Additional NVIDIA Environment Variables

### Update your env section:

```conf
# NVIDIA optimizations
env = LIBVA_DRIVER_NAME,nvidia
env = XDG_SESSION_TYPE,wayland
env = GBM_BACKEND,nvidia-drm
env = __GLX_VENDOR_LIBRARY_NAME,nvidia
env = WLR_NO_HARDWARE_CURSORS,1

# Additional NVIDIA Wayland fixes
env = CLUTTER_BACKEND,wayland
env = SDL_VIDEODRIVER,wayland
env = QT_QPA_PLATFORM,wayland
env = QT_WAYLAND_DISABLE_WINDOWDECORATION,1
env = MOZ_ENABLE_WAYLAND,1
env = _JAVA_AWT_WM_NONREPARENTING,1

# NVIDIA hardware acceleration
env = NVD_BACKEND,direct
env = __GL_GSYNC_ALLOWED,1
env = __GL_VRR_ALLOWED,1

# Cursor size for 4K/high DPI
env = XCURSOR_SIZE,32  # Increased from 24 for better visibility
```

---

## 📦 Missing Packages to Install

### Performance & Eye Candy
```bash
# Advanced compositor features
sudo dnf install -y wl-clipboard cliphist

# Better terminal (if you want alternatives to kitty)
sudo dnf install -y alacritty

# Screenshot tools (enhanced)
sudo dnf install -y swappy  # Screenshot editing

# Color picker
sudo dnf install -y hyprpicker  # Already installed via COPR

# Idle management (better than hypridle alone)
sudo dnf install -y swayidle

# Better app launcher alternatives
sudo dnf install -y rofi-wayland  # More powerful than wofi

# Clipboard manager
sudo dnf install -y cliphist

# Desktop notifications (enhanced)
sudo dnf install -y mako  # Alternative to dunst, better for Wayland
```

### Audio & Video
```bash
# Better audio control
sudo dnf install -y easyeffects  # Audio effects & equalizer

# Screen recorder (better than basic wf-recorder)
sudo dnf install -y obs-studio

# Hardware video encoding support
sudo dnf install -y ffmpeg-full nvidia-vaapi-driver
```

### Utilities
```bash
# File manager alternatives
sudo dnf install -y dolphin  # KDE file manager, very feature-rich

# Image viewer
sudo dnf install -y imv  # Lightweight Wayland image viewer

# PDF viewer
sudo dnf install -y zathura zathura-pdf-mupdf

# System monitor for waybar
sudo dnf install -y btop  # Better than htop
```

---

## 🖼️ Wallpaper Enhancements

Instead of static hyprpaper, use animated wallpapers:

```bash
sudo dnf install -y mpvpaper
```

Then in hyprland.conf:
```conf
# Replace hyprpaper with mpvpaper for video wallpapers
exec-once = mpvpaper -o "no-audio loop" DP-4 ~/Videos/wallpaper.mp4
```

Or use swww for smooth wallpaper transitions:
```bash
sudo dnf copr enable alternateved/swww
sudo dnf install -y swww
```

---

## 🎯 Workspace Optimizations

Your 4-monitor setup deserves better workspace management:

```conf
# Better workspace distribution
workspace = 1, monitor:DP-5, default:true, persistent:true
workspace = 2, monitor:DP-5, persistent:true
workspace = 3, monitor:DP-5, persistent:true

workspace = 4, monitor:DP-6, persistent:true
workspace = 5, monitor:DP-6, persistent:true

workspace = 6, monitor:DP-4, default:true, persistent:true
workspace = 7, monitor:DP-4, persistent:true
workspace = 8, monitor:DP-4, persistent:true

workspace = 9, monitor:DP-1, persistent:true
workspace = 10, monitor:DP-1, persistent:true

# Special workspaces for specific purposes
workspace = special:scratchpad, on-created-empty:kitty
workspace = special:music, on-created-empty:spotify
workspace = special:comm, on-created-empty:discord
```

---

## 🔍 Window Rules for Optimization

Add these to handle your specific applications:

```conf
# Development apps on ultrawide
windowrulev2 = workspace 6, class:^(Code|phpstorm|jetbrains-.*)$
windowrulev2 = workspace 6, title:^(.*Visual Studio Code.*)$

# Browsers on main monitor
windowrulev2 = workspace 7, class:^(chrome|chromium|firefox)$

# Communication apps on portrait monitor
windowrulev2 = workspace 4, class:^(discord|slack|teams)$
windowrulev2 = workspace 4, title:^(.*Telegram.*)$

# Media on left monitor
windowrulev2 = workspace 2, class:^(spotify|vlc)$

# GIMP full workspace
windowrulev2 = workspace 3, class:^(Gimp)$
windowrulev2 = float, class:^(Gimp)$, title:^(?!GNU Image Manipulation Program).*$

# Float specific windows
windowrulev2 = float, class:^(pavucontrol|nm-connection-editor)$
windowrulev2 = float, title:^(Picture-in-Picture)$

# Opacity for specific windows
windowrulev2 = opacity 0.95 0.85, class:^(kitty|alacritty)$
windowrulev2 = opacity 0.90 0.85, class:^(code)$

# Size rules for dialogs
windowrulev2 = size 800 600, title:^(Open File|Save File)$
windowrulev2 = center, title:^(Open File|Save File)$

# Pinning windows (always on top)
windowrulev2 = pin, title:^(Picture-in-Picture)$

# Disable blur for performance in games
windowrulev2 = noblur, class:^(steam_app_.*)$
windowrulev2 = noblur, fullscreen:1

# Immediate focus for new windows
windowrulev2 = immediate, class:^(steam_app_.*)$
```

---

## 📊 System Monitoring

Add to waybar or create keybindings:

```conf
# Quick system monitor
bind = $mainMod, I, exec, kitty --class floating_kitty -e btop

# GPU stats
bind = $mainMod SHIFT, G, exec, kitty --class floating_kitty -e nvidia-smi -l 1

# Resource usage
windowrulev2 = float, class:^(floating_kitty)$
windowrulev2 = size 1200 800, class:^(floating_kitty)$
windowrulev2 = center, class:^(floating_kitty)$
```

---

## 🔄 Auto-tiling Script

Create `~/.config/hypr/scripts/auto-tile.sh`:

```bash
#!/bin/bash
# Auto-arrange windows based on monitor
# Place on ultrawide in columns, others stacked

handle() {
  case $1 in
    openwindow*)
      # Get window info
      ADDR=$(echo "$1" | awk -F',' '{print $1}' | cut -d'>' -f2)
      WORKSPACE=$(hyprctl activewindow -j | jq -r '.workspace.id')
      MONITOR=$(hyprctl activeworkspace -j | jq -r '.monitor')
      
      # Ultrawide gets column layout
      if [ "$MONITOR" = "DP-4" ]; then
        hyprctl dispatch layoutmsg orientationcycle
      fi
      ;;
  esac
}

socat -U - "UNIX-CONNECT:/tmp/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock" | while read -r line; do handle "$line"; done
```

Add to autostart:
```conf
exec-once = ~/.config/hypr/scripts/auto-tile.sh
```

---

## 🎨 Eye Candy Extras

### Borders with Gradients
```conf
general {
    col.active_border = rgba(33ccffee) rgba(00ff99ee) 45deg
    col.inactive_border = rgba(595959aa)
    border_size = 3  # Increased from 2
}
```

### Window Dimming
```conf
decoration {
    dim_inactive = true
    dim_strength = 0.1
    dim_special = 0.4
}
```

---

## ⚡ Performance Verification

After optimizations, test:

1. **Check FPS**: Should be at your monitor's max refresh rate
   ```bash
   hyprctl monitors | grep refreshRate
   ```

2. **GPU Usage**: Ensure NVIDIA is being used
   ```bash
   nvidia-smi
   ```

3. **Blur Performance**: Should be smooth with size=8, passes=3

4. **VRR Working**: Check if variable refresh rate is active
   ```bash
   hyprctl monitors | grep vrr
   ```

---

## 📝 Implementation Order

1. **REBOOT FIRST** - Activate NVIDIA driver
2. Install missing packages
3. Update monitor refresh rates
4. Enhance animations & blur
5. Add window rules
6. Install optional enhancements
7. Test and adjust

---

## 🚀 Expected Performance

With your hardware + optimizations:
- **Smooth 100-144Hz** on all monitors
- **No tearing** with VRR
- **Heavy blur** with no lag
- **Instant** window switching
- **Butter smooth** animations
- **Full GPU acceleration** for everything

Your Ryzen 9 9950X3D and RTX 5080 are overkill for a compositor - embrace it!
