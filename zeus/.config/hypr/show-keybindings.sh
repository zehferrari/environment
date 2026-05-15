#!/bin/bash

# Hyprland Keyboard Shortcuts Cheat Sheet

notify-send "Hyprland Shortcuts" "Opening keybindings..." -t 2000

yad --title="Hyprland Keyboard Shortcuts" \
    --width=800 --height=600 \
    --center \
    --no-buttons \
    --text="<span size='large' weight='bold'>Hyprland Keyboard Shortcuts</span>\n\n\
<b>Window Management</b>
  Super + Q                    Open terminal (kitty)
  Super + C                    Close window
  Super + V                    Toggle floating mode
  Super + P                    Pseudo-tile (dwindle)
  Super + J                    Toggle split (dwindle)
  Super + M                    Exit Hyprland

<b>Navigation</b>
  Super + Arrow Keys           Move focus between windows
  Super + 1-9/0                Switch to workspace 1-10
  Super + Mouse Wheel          Scroll through workspaces

<b>Window Movement</b>
  Super + Shift + 1-9/0        Move window to workspace 1-10
  Super + Left Click + Drag    Move window
  Super + Right Click + Drag   Resize window

<b>Applications</b>
  Super + E                    File manager (dolphin)
  Super + R                    App launcher (wofi)

<b>Special Workspaces</b>
  Super + S                    Toggle scratchpad
  Super + Shift + S            Move to scratchpad

<b>This Cheat Sheet</b>
  Super + /                    Show this help" \
    --text-align=left
