#!/bin/bash
# Matter Device Connection Monitor
# Run this to watch the door sensor connection attempts

echo "=== Matter Device Monitor ==="
echo "Started: $(date)"
echo ""
echo "Watching for Node:13 (NEO Door Sensor) connection status..."
echo "Press Ctrl+C to stop"
echo ""

while true; do
    clear
    echo "=== Matter Monitor - $(date) ==="
    echo ""
    
    # Get last 10 lines related to Node:13
    echo "Recent Node:13 Activity:"
    ha apps logs core_matter_server 2>&1 | grep -E "Node:13|000000000000000D" | tail -5
    echo ""

    # Check for errors
    echo "Recent Errors:"
    ha apps logs core_matter_server 2>&1 | grep -iE "error.*000000000000000D|CASE.*timeout|retransmission.*failure" | tail -3
    echo ""
    
    # Check Matter Server status
    echo "Matter Server Status:"
    ha apps 2>/dev/null | grep -A2 "Matter Server" | grep "state:" | head -1
    echo ""
    
    sleep 10
done
