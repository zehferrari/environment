#!/bin/bash

# Gracefully close all windows, then log out (exit Hyprland).
# Bound to SUPER+M.
#
# closeWindows.sh asks Hyprland to close every window, waits for apps to flush
# their state, and SIGTERMs browsers/editors with grace periods (never SIGKILL),
# so sessions/profiles are saved before the compositor exits.

~/Scripts/closeWindows.sh

# All windows are closed (or had their full grace period) — now exit Hyprland.
hyprctl dispatch exit
