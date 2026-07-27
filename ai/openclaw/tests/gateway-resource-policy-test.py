#!/usr/bin/env python3
"""Contract checks for thinkpad gateway memory policy wiring."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
HOST = ROOT / "ai/host"


def main() -> None:
    gateway_policy = (
        HOST
        / "systemd/user/openclaw-gateway.service.d/30-memory-policy.conf"
    ).read_text()
    assert "MemoryHigh=6G" in gateway_policy
    assert "MemoryMax=8G" in gateway_policy
    assert "MemorySwapMax=2G" in gateway_policy
    assert "TasksMax=1024" in gateway_policy
    assert "max-old-space-size" not in gateway_policy

    delegation = (
        HOST / "systemd/user-manager/80-openclaw-resource-controllers.conf"
    ).read_text()
    assert "Delegate=pids memory" in delegation

    host_installer = (HOST / "install.sh").read_text()
    assert "/etc/systemd/system/user@$uid.service.d/" in host_installer
    assert "memoryPressureSnapshot: true" in host_installer
    assert "config validate --json" in host_installer
    assert "sdbootutil update-all-entries" in host_installer
    assert "ENABLED_AGENT_TSV" in host_installer
    assert "runuser -u zeh -- test -w /var/log/nginx" in host_installer
    assert "openclaw-backup.service" in host_installer
    assert "reconcile_gateway_config_links" in host_installer
    assert "refusing to replace divergent home gateway config" in host_installer

    update_service = (HOST / "systemd/zypper-dup.service").read_text()
    assert "TimeoutStartSec=infinity" in update_service

    lifecycle = (
        ROOT / "ai/openclaw/bin/openclaw-manage-user"
    ).read_text()
    assert "install_user_manager_resource_delegation" in lifecycle
    assert "remove_user_manager_resource_delegation" in lifecycle

    cmdline = (HOST / "kernel/required-cmdline").read_text().splitlines()
    assert "psi=1" in cmdline
    assert "q /tmp 1777 root root 3d" in (
        HOST / "tmpfiles/fs-tmp.conf"
    ).read_text()

    print("gateway-resource-policy-test: ok")


if __name__ == "__main__":
    main()
