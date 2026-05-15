#!/bin/bash
# Matter Device Diagnostics Script

echo "=== Matter Diagnostics ==="
echo "Date: $(date)"
echo ""

echo "=== 1. Matter Server Status ==="
ha apps 2>/dev/null | grep -A10 "Matter Server"
echo ""

echo "=== 2. Recent Matter Errors ==="
ha apps logs core_matter_server 2>&1 | grep -i "error\|fail\|timeout" | tail -20
echo ""

echo "=== 3. Node 13 (NEO Door Sensor) Status ==="
ha apps logs core_matter_server 2>&1 | grep -E "Node:13|000000000000000D" | tail -20
echo ""

echo "=== 4. Thread Network Status ==="
cat /homeassistant/.storage/thread.datasets 2>/dev/null | jq '.data.datasets | length' 2>/dev/null && echo "Thread dataset(s) found"
echo ""

echo "=== 5. Network Interface ==="
ip addr show enp0s31f6 2>/dev/null | grep -E "inet6|mtu"
echo ""

echo "=== 6. Matter Device Entity Status ==="
curl -s -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
  -H "Content-Type: application/json" \
  http://supervisor/core/api/states/binary_sensor.door_sensor_door 2>/dev/null | jq '{state: .state, last_changed: .last_changed, last_updated: .last_updated}' 2>/dev/null || echo "Could not fetch entity state"
echo ""

echo "=== End of Diagnostics ==="
