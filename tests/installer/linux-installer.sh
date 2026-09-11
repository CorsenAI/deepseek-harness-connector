#!/usr/bin/env bash
# Installer acceptance on Linux and macOS: fresh install, install over existing, uninstall.
#
# Runs the real `scripts/install.sh` against a real `dsh` on PATH and a throwaway DSH_HOME, then
# reports what actually happened. Every line of output is a fact this script checked, not a claim.
# It exits non-zero when any expectation fails, so CI can gate on it.
#
# Usage:
#   tests/installer/linux-installer.sh <path to connector .tgz> [dsh bin dir to prepend to PATH]
#
# The tarball path may contain spaces; that is one of the things under test.

set -u

TGZ="${1:?usage: linux-installer.sh <tarball> [dsh-bin-dir]}"
DSH_BIN="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$HERE/../../scripts/install.sh"
[ -n "$DSH_BIN" ] && export PATH="$DSH_BIN:$PATH"

export DSH_HOME="${TMPDIR:-/tmp}/dsh-installer-test-$$"
export DSH_CONNECTOR_PORT="${DSH_CONNECTOR_PORT:-18782}"
mkdir -p "$DSH_HOME"
MANIFEST="$DSH_HOME/profiles/headless/package.json"
BROKER="$DSH_HOME/profiles/headless/node_modules/@corsen-ai/dsh-browser-connector/lib/broker-main.js"

failures=0
expect() { # expect <label> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "ok   $1: $2"; else echo "FAIL $1: got '$2', expected '$3'"; failures=$((failures + 1)); fi
}
bundles() { grep -oE "@(deepseek-ai|corsen-ai)/[a-z-]+" "$MANIFEST" 2>/dev/null | sort -u | tr "\n" " " | sed "s/ $//"; }
alive() { kill -0 "$1" 2>/dev/null && echo true || echo false; }
exists() { [ -e "$1" ] && echo true || echo false; }
# GNU stat and BSD stat spell the octal mode differently; macOS ships the BSD one.
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }

echo "node: $(node --version)   dsh: $(command -v dsh || echo MISSING)   home: $DSH_HOME"
echo "tarball: $TGZ"
echo

echo "=== fresh install ==="
bash "$INSTALLER" --profile headless --package "$TGZ" > "$DSH_HOME/install-1.log" 2>&1
expect "install exit code" "$?" "0"
sed "s/^/  | /" "$DSH_HOME/install-1.log" | tail -12
expect "connector bundle registered" "$(bundles | grep -c corsen-ai)" "1"
expect "broker.pid written" "$(exists "$DSH_HOME/connector/broker.pid")" "true"
expect "credentials.json written" "$(exists "$DSH_HOME/connector/credentials.json")" "true"
expect "credentials mode 600" "$(mode "$DSH_HOME/connector/credentials.json")" "600"
expect "connector dir mode 700" "$(mode "$DSH_HOME/connector")" "700"
PID1="$(cat "$DSH_HOME/connector/broker.pid" 2>/dev/null)"
expect "broker process alive" "$(alive "$PID1")" "true"
expect "broker answers 426 on loopback" "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$DSH_CONNECTOR_PORT/")" "426"
CODE1="$(node "$BROKER" --pairing-code --home "$DSH_HOME" 2>/dev/null | tail -1)"
expect "pairing code has the expected shape" "$(echo "$CODE1" | grep -cE "^[34679ACDEFGHJKMNPQRTUVWXY]{4}(-[34679ACDEFGHJKMNPQRTUVWXY]{4}){4}$")" "1"
echo

echo "=== install over existing (upgrade path) ==="
bash "$INSTALLER" --profile headless --package "$TGZ" > "$DSH_HOME/install-2.log" 2>&1
expect "reinstall exit code" "$?" "0"
grep -E "Stopped the previous broker" "$DSH_HOME/install-2.log" | sed "s/^/  | /"
PID2="$(cat "$DSH_HOME/connector/broker.pid" 2>/dev/null)"
expect "previous broker stopped" "$(alive "$PID1")" "false"
expect "new broker alive" "$(alive "$PID2")" "true"
expect "exactly one broker on the port" "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$DSH_CONNECTOR_PORT/")" "426"
CODE2="$(node "$BROKER" --pairing-code --home "$DSH_HOME" 2>/dev/null | tail -1)"
expect "pairing code unchanged across reinstall" "$([ "$CODE1" = "$CODE2" ] && echo same || echo different)" "same"
echo

echo "=== uninstall ==="
bash "$INSTALLER" --uninstall --profile headless > "$DSH_HOME/uninstall.log" 2>&1
expect "uninstall exit code" "$?" "0"
sed "s/^/  | /" "$DSH_HOME/uninstall.log" | tail -6
expect "connector bundle removed" "$(bundles | grep -c corsen-ai)" "0"
expect "dsh base bundles untouched" "$(bundles | grep -c deepseek-ai)" "1"
sleep 1
expect "broker stopped" "$(alive "$PID2")" "false"
expect "credentials kept for re-pair" "$(exists "$DSH_HOME/connector/credentials.json")" "true"
echo

if [ "$failures" -eq 0 ]; then echo "all installer expectations met"; else echo "$failures installer expectation(s) failed"; fi
exit "$failures"
