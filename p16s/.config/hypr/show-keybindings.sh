#!/usr/bin/env bash
set -euo pipefail

SHORTCUTS_TEXT=$(cat <<'EOF'
Hyprland Keyboard Shortcuts

Window Management
  Super + Q                    Open terminal (kitty)
  Super + C                    Close window
  Super + V                    Toggle floating mode
  Super + P                    Pseudo-tile (dwindle)
  Super + J                    Toggle split (dwindle)
  Super + M                    Exit Hyprland

Navigation
  Super + Arrow Keys           Move focus between windows
  Super + 1-9/0                Switch to workspace 1-10
  Super + Mouse Wheel          Scroll through workspaces
  Three-finger horizontal      Switch workspaces

Window Movement
  Super + Shift + 1-9/0        Move window to workspace 1-10
  Super + Left Click + Drag    Move window
  Super + Right Click + Drag   Resize window

Applications
  Super + E                    File manager (nautilus)
  Super + R                    App launcher (fuzzel)
  Super + O                    OpenCode

Special Workspaces
  Super + S                    Toggle scratchpad
  Super + Shift + S            Move to scratchpad

This Cheat Sheet
  Super + /                    Show this help
EOF
)

if command -v kitty >/dev/null 2>&1; then
  export SHORTCUTS_TEXT
  kitty --title "Hyprland Keyboard Shortcuts" sh -c 'printf "%s\n\nPress Enter to close..." "$SHORTCUTS_TEXT"; read -r _'
else
  printf "%s\n" "$SHORTCUTS_TEXT"
fi
