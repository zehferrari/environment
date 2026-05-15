#!/bin/bash

# Power menu for Waybar

CHOICE=$(echo -e "Logout\nRestart\nShutdown\nCancel" | wofi --dmenu --prompt "Power Menu" --width 250 --height 200)

case "$CHOICE" in
    "Logout")
        hyprctl dispatch exit
        ;;
    "Restart")
        systemctl reboot
        ;;
    "Shutdown")
        systemctl poweroff
        ;;
    "Cancel")
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
