#!/usr/bin/env bash
# scripts/test-user-lifecycle.sh — Sandbox lifecycle test for openclaw-manage-user

set -euo pipefail

# Ensure running as root (sudo)
if [ "$EUID" -ne 0 ]; then
  echo "Error: This test script must be run under sudo (as root)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER_SCRIPT="$REPO_ROOT/ai/openclaw/bin/openclaw-manage-user"

# Enable sandbox testing mode
export OPENCLAW_SANDBOX_TESTING="true"

# Setup sandbox directories
SANDBOX_DIR=$(mktemp -d /tmp/openclaw-sandbox.XXXXXX)
echo "Setting up sandbox in $SANDBOX_DIR..."

REGISTRY="$SANDBOX_DIR/agents.json"
SUDOERS_D="$SANDBOX_DIR/sudoers.d"
SAMBA_SHARED_ROOT="$SANDBOX_DIR/samba/shared"
SAMBA_PASSWORD_SYNC_DIR="$SANDBOX_DIR/samba-password-sync"

# Initialize mock registry
cat > "$REGISTRY" <<EOF
{
  "version": 1,
  "codeRoot": "/srv/Code",
  "codeOwner": "zeh",
  "codeGroup": "code-agents",
  "agents": [
    {
      "user": "karen",
      "uid": 1001,
      "name": "Karen Monitor",
      "enabled": true,
      "role": "monitor",
      "home": "/home/karen",
      "workspace": "/home/karen/workspace",
      "email": "karen@vixi.au"
    }
  ]
}
EOF

# Make sure directory structure exists
mkdir -p "$SUDOERS_D"
mkdir -p "$SAMBA_SHARED_ROOT"
mkdir -p "$SAMBA_PASSWORD_SYNC_DIR"

# === ADVERSARIAL TESTS ===
echo "=== TEST: Adversarial checks ==="

# 1. REPO_ROOT validation with OPENCLAW_SANDBOX_TESTING unset and malicious path
echo "Checking invalid REPO_ROOT rejection (OPENCLAW_SANDBOX_TESTING unset)..."
if env OPENCLAW_SANDBOX_TESTING="" \
       REGISTRY="$REGISTRY" \
       SUDOERS_D="$SUDOERS_D" \
       SAMBA_SHARED_ROOT="$SAMBA_SHARED_ROOT" \
       SAMBA_PASSWORD_SYNC_DIR="$SAMBA_PASSWORD_SYNC_DIR" \
       REPO_ROOT="/tmp/evil" \
       "$HELPER_SCRIPT" delete "nonexistentagent" >/dev/null 2>&1; then
  echo "FAIL: Expected non-zero exit code for invalid REPO_ROOT '/tmp/evil' with OPENCLAW_SANDBOX_TESTING unset." >&2
  exit 1
fi
echo "PASS: Rejected invalid REPO_ROOT '/tmp/evil' with OPENCLAW_SANDBOX_TESTING unset."

# 2. REPO_ROOT validation with OPENCLAW_SANDBOX_TESTING="true" but non-/tmp/ malicious path
echo "Checking invalid REPO_ROOT rejection (OPENCLAW_SANDBOX_TESTING=true but non-/tmp/ path)..."
if env OPENCLAW_SANDBOX_TESTING="true" \
       REGISTRY="$REGISTRY" \
       SUDOERS_D="$SUDOERS_D" \
       SAMBA_SHARED_ROOT="$SAMBA_SHARED_ROOT" \
       SAMBA_PASSWORD_SYNC_DIR="$SAMBA_PASSWORD_SYNC_DIR" \
       REPO_ROOT="/opt/evil" \
       "$HELPER_SCRIPT" delete "nonexistentagent" >/dev/null 2>&1; then
  echo "FAIL: Expected non-zero exit code for invalid REPO_ROOT '/opt/evil' with OPENCLAW_SANDBOX_TESTING=true." >&2
  exit 1
fi
echo "PASS: Rejected invalid REPO_ROOT '/opt/evil' with OPENCLAW_SANDBOX_TESTING=true."

# 3. Attempting to delete a system user with UID < 1001 (mock user)
echo "Checking rejection when attempting to delete mock system user with UID < 1001..."
# Create a temporary system user with UID 999
useradd -u 999 -M -N -r -s /usr/sbin/nologin mocktestsysuser 2>/dev/null || true
if ! id -u mocktestsysuser >/dev/null 2>&1; then
  echo "WARNING: Could not create mock system user mocktestsysuser for UID < 1001 check."
else
  if env REGISTRY="$REGISTRY" \
         SUDOERS_D="$SUDOERS_D" \
         SAMBA_SHARED_ROOT="$SAMBA_SHARED_ROOT" \
         SAMBA_PASSWORD_SYNC_DIR="$SAMBA_PASSWORD_SYNC_DIR" \
         REPO_ROOT="$REPO_ROOT" \
         "$HELPER_SCRIPT" delete "mocktestsysuser" >/dev/null 2>&1; then
    echo "FAIL: Allowed deletion of mock system user with UID < 1001." >&2
    userdel mocktestsysuser 2>/dev/null || true
    exit 1
  fi
  echo "PASS: Rejected deletion of mock system user with UID < 1001."
  userdel mocktestsysuser 2>/dev/null || true
fi

# 4. Attempting to delete protected system user 'nobody'
echo "Checking rejection when attempting to delete system user 'nobody'..."
if env REGISTRY="$REGISTRY" \
       SUDOERS_D="$SUDOERS_D" \
       SAMBA_SHARED_ROOT="$SAMBA_SHARED_ROOT" \
       SAMBA_PASSWORD_SYNC_DIR="$SAMBA_PASSWORD_SYNC_DIR" \
       REPO_ROOT="$REPO_ROOT" \
       "$HELPER_SCRIPT" delete "nobody" >/dev/null 2>&1; then
  echo "FAIL: Expected non-zero exit code when attempting to delete system user 'nobody'." >&2
  exit 1
fi
echo "PASS: Rejected deletion of system user 'nobody'."

# 5. Registry JSON integrity validation
echo "Checking registry JSON integrity check..."
# Backup registry
cp "$REGISTRY" "$REGISTRY.bak"
# Corrupt registry
echo "invalid json {" > "$REGISTRY"
if env REGISTRY="$REGISTRY" \
       SUDOERS_D="$SUDOERS_D" \
       SAMBA_SHARED_ROOT="$SAMBA_SHARED_ROOT" \
       SAMBA_PASSWORD_SYNC_DIR="$SAMBA_PASSWORD_SYNC_DIR" \
       REPO_ROOT="$REPO_ROOT" \
       "$HELPER_SCRIPT" add "anotheragent" 20001 coding >/dev/null 2>&1; then
  echo "FAIL: Expected non-zero exit code when registry JSON is corrupted." >&2
  mv "$REGISTRY.bak" "$REGISTRY"
  exit 1
fi
echo "PASS: Rejected provisioning with corrupted registry JSON."
# Restore registry
mv "$REGISTRY.bak" "$REGISTRY"

# === MAIN LIFECYCLE TESTS ===
TEST_USER="octestagent"
TEST_UID=19999

# Ensure the test user does not exist yet (from any previous aborted runs)
echo "Pre-cleanup of test user if exists..."
env REGISTRY="$REGISTRY" \
    SUDOERS_D="$SUDOERS_D" \
    SAMBA_SHARED_ROOT="$SAMBA_SHARED_ROOT" \
    SAMBA_PASSWORD_SYNC_DIR="$SAMBA_PASSWORD_SYNC_DIR" \
    REPO_ROOT="$REPO_ROOT" \
    "$HELPER_SCRIPT" delete "$TEST_USER" >/dev/null 2>&1 || true

echo "=== TEST: Adding User ==="
env REGISTRY="$REGISTRY" \
    SUDOERS_D="$SUDOERS_D" \
    SAMBA_SHARED_ROOT="$SAMBA_SHARED_ROOT" \
    SAMBA_PASSWORD_SYNC_DIR="$SAMBA_PASSWORD_SYNC_DIR" \
    REPO_ROOT="$REPO_ROOT" \
    "$HELPER_SCRIPT" add "$TEST_USER" "$TEST_UID" coding

# --- VERIFICATIONS (ADD) ---
echo "--- Verifying Add Results ---"

# 1. System account created
if ! getent passwd "$TEST_USER" >/dev/null 2>&1; then
  echo "FAIL: System user $TEST_USER was not created." >&2
  exit 1
fi
echo "PASS: System user account created."

# 2. Code-agents group membership
if ! id -nG "$TEST_USER" | grep -q "code-agents"; then
  echo "FAIL: User $TEST_USER is not in code-agents group." >&2
  exit 1
fi
echo "PASS: Group membership verified."

# 3. Directories created with correct permissions/owner
if [ ! -d "$SAMBA_SHARED_ROOT/$TEST_USER" ]; then
  echo "FAIL: Samba shared folder not created." >&2
  exit 1
fi
owner=$(stat -c '%U:%G' "$SAMBA_SHARED_ROOT/$TEST_USER")
perms=$(stat -c '%a' "$SAMBA_SHARED_ROOT/$TEST_USER")
if [ "$owner" != "$TEST_USER:$TEST_USER" ] || [ "$perms" != "700" ]; then
  echo "FAIL: Incorrect owner ($owner) or perms ($perms) on Samba shared folder." >&2
  exit 1
fi
echo "PASS: Samba shared folder verified."

# 4. Symlinks
if [ ! -L "/home/$TEST_USER/Shared" ]; then
  echo "FAIL: Symlink /home/$TEST_USER/Shared not created." >&2
  exit 1
fi
target=$(readlink "/home/$TEST_USER/Shared")
if [ "$target" != "$SAMBA_SHARED_ROOT/$TEST_USER" ]; then
  echo "FAIL: Symlink points to $target instead of $SAMBA_SHARED_ROOT/$TEST_USER." >&2
  exit 1
fi
echo "PASS: Samba Shared symlink verified."

# 5. Password sync folder
if [ ! -d "$SAMBA_PASSWORD_SYNC_DIR/$TEST_USER" ]; then
  echo "FAIL: Password sync folder not created." >&2
  exit 1
fi
owner_pw=$(stat -c '%U:%G' "$SAMBA_PASSWORD_SYNC_DIR/$TEST_USER")
perms_pw=$(stat -c '%a' "$SAMBA_PASSWORD_SYNC_DIR/$TEST_USER")
if [ "$owner_pw" != "$TEST_USER:$TEST_USER" ] || [ "$perms_pw" != "700" ]; then
  echo "FAIL: Incorrect owner ($owner_pw) or perms ($perms_pw) on Password sync folder." >&2
  exit 1
fi
echo "PASS: Password sync folder verified."

# 6. Sudoers wake fragment
wake_frag="$SUDOERS_D/openclaw-wake-$TEST_USER"
if [ ! -f "$wake_frag" ]; then
  echo "FAIL: Sudoers wake fragment not created." >&2
  exit 1
fi
if ! visudo -c -f "$wake_frag" >/dev/null 2>&1; then
  echo "FAIL: Sudoers wake fragment did not pass visudo validation." >&2
  exit 1
fi
echo "PASS: Sudoers wake fragment verified and validated."

# 7. Sudoers monitor control
karen_sudoers="$SUDOERS_D/karen-openclaw-control"
if [ ! -f "$karen_sudoers" ]; then
  echo "FAIL: Karen sudoers control file not created." >&2
  exit 1
fi
if ! visudo -c -f "$karen_sudoers" >/dev/null 2>&1; then
  echo "FAIL: Karen sudoers control file did not pass visudo validation." >&2
  exit 1
fi
if ! grep -q "$TEST_USER" "$karen_sudoers"; then
  echo "FAIL: Karen sudoers control file does not contain active coding user $TEST_USER." >&2
  exit 1
fi
echo "PASS: Karen sudoers control file verified, validated, and updated."

echo "=== TEST: Deleting User ==="
env REGISTRY="$REGISTRY" \
    SUDOERS_D="$SUDOERS_D" \
    SAMBA_SHARED_ROOT="$SAMBA_SHARED_ROOT" \
    SAMBA_PASSWORD_SYNC_DIR="$SAMBA_PASSWORD_SYNC_DIR" \
    REPO_ROOT="$REPO_ROOT" \
    "$HELPER_SCRIPT" delete "$TEST_USER"

# --- VERIFICATIONS (DELETE) ---
echo "--- Verifying Delete Results ---"

# 1. System account deleted
if getent passwd "$TEST_USER" >/dev/null 2>&1; then
  echo "FAIL: System user $TEST_USER was not deleted." >&2
  exit 1
fi
echo "PASS: System user account deleted."

# 2. Home directory deleted
if [ -d "/home/$TEST_USER" ]; then
  echo "FAIL: Home directory /home/$TEST_USER still exists." >&2
  exit 1
fi
echo "PASS: Home directory removed."

# 3. Samba shared folder cleaned up
if [ -d "$SAMBA_SHARED_ROOT/$TEST_USER" ]; then
  echo "FAIL: Samba shared folder still exists." >&2
  exit 1
fi
echo "PASS: Samba shared folder cleaned up."

# 4. Password sync folder cleaned up
if [ -d "$SAMBA_PASSWORD_SYNC_DIR/$TEST_USER" ]; then
  echo "FAIL: Password sync folder still exists." >&2
  exit 1
fi
echo "PASS: Password sync folder cleaned up."

# 5. Sudoers wake fragment removed
if [ -f "$wake_frag" ]; then
  echo "FAIL: Sudoers wake fragment still exists." >&2
  exit 1
fi
echo "PASS: Sudoers wake fragment removed."

# 6. Sudoers monitor control regenerated and does not contain test user
if ! visudo -c -f "$karen_sudoers" >/dev/null 2>&1; then
  echo "FAIL: Karen sudoers control file did not pass visudo validation after deletion." >&2
  exit 1
fi
if grep -q "$TEST_USER" "$karen_sudoers"; then
  echo "FAIL: Karen sudoers control file still contains $TEST_USER after deletion." >&2
  exit 1
fi
echo "PASS: Karen sudoers control file regenerated and test user purged."

# Cleanup sandbox directory
rm -rf "$SANDBOX_DIR"
echo "=== ALL TESTS PASSED SUCCESSFULLY ==="
