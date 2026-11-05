#!/usr/bin/env bash
# DeepSeek Harness Connector — installer for macOS and Linux.
#
# Installs the connector into a DeepSeek Harness profile with the official `dsh plugin` command,
# then starts the local broker and prints the pairing code for the Chrome extension. Re-running it
# upgrades. `--uninstall` reverses it. It never edits DeepSeek Harness's own files: the only change
# to the profile is the dependency `dsh plugin` adds, which `dsh plugin remove` takes away.
#
# Usage:
#   ./install.sh [--profile web] [--package @corsen-ai/dsh-browser-connector | --package ./x.tgz]
#   ./install.sh --uninstall [--profile web]
#
# This is an unofficial community project by Corsen AI, not affiliated with DeepSeek.

set -euo pipefail

PROFILE="web"
PACKAGE="@corsen-ai/dsh-browser-connector"
UNINSTALL=0
BROKER_PORT="${DSH_CONNECTOR_PORT:-8781}"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --package) PACKAGE="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is required (22.19 or newer). https://nodejs.org"
# `parseInt` needs no quoting inside the expression, which keeps this identical to the Windows
# installer where inner quotes do not survive the trip to a native executable.
NODE_MAJOR="$(node -p 'parseInt(process.versions.node)')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22.19 or newer is required; found $(node --version)"

if command -v dsh >/dev/null 2>&1; then
  DSH="dsh"
elif command -v npx >/dev/null 2>&1; then
  DSH="npx --yes @deepseek-ai/dsh"
else
  fail "DeepSeek Harness (dsh) was not found on PATH. Install it first: npm install -g @deepseek-ai/dsh"
fi

# `dsh plugin` forwards to pnpm, which DeepSeek Harness itself does not install: a machine with a
# working `dsh` and no pnpm fails inside dsh after the profile has been created. Checked here, before
# anything is created, with the command that fixes it.
if [ "$UNINSTALL" -eq 0 ] && ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm is required by DeepSeek Harness's plugin command and was not found on PATH. Install it with: npm install -g pnpm"
fi

# Resolve the Harness home exactly as DeepSeek Harness does (`resolveDshHome` in
# @deepseek-ai/dsh-home-paths), so the pairing secret lands where the plugin will look for it and the
# installed package is looked for where `dsh plugin add` put it: a DSH_HOME that is not blank, else
# ~/.dsh; a leading ~ or ~/ expanded; a relative path made absolute against this directory.
case "${DSH_HOME:-}" in
  *[![:space:]]*) HOME_DIR="$DSH_HOME" ;;
  *) HOME_DIR="$HOME/.dsh" ;;
esac
case "$HOME_DIR" in
  "~") HOME_DIR="$HOME" ;;
  "~/"*) HOME_DIR="$HOME/${HOME_DIR#\~/}" ;;
esac
case "$HOME_DIR" in
  /*) ;;
  *) HOME_DIR="$PWD/$HOME_DIR" ;;
esac
PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"

if [ "$UNINSTALL" -eq 1 ]; then
  say "Removing the connector from profile '$PROFILE'..."
  $DSH plugin --profile "$PROFILE" remove "@corsen-ai/dsh-browser-connector" || true
  if [ -f "$HOME_DIR/connector/broker.pid" ]; then
    PID="$(cat "$HOME_DIR/connector/broker.pid")"
    kill "$PID" 2>/dev/null && say "Stopped the broker (pid $PID)." || true
    rm -f "$HOME_DIR/connector/broker.pid"
  fi
  say "Connector state (pairing secret, ownership) is kept at $HOME_DIR/connector so a reinstall"
  say "does not force every browser to pair again. Delete that directory to remove it."
  exit 0
fi

# Absolute-ize a local path: `dsh plugin` runs pnpm with cwd = the profile directory, where a
# relative path would resolve to nothing — and pnpm reads a bare `dir/file.tgz` as a GitHub
# shorthand and goes looking for a repository. A path that names nothing here is refused now,
# with a reason, rather than by pnpm with a git error.
case "$PACKAGE" in
  /*|@*) ;;
  *)
    if [ -e "$PACKAGE" ]; then
      PACKAGE="$(cd "$(dirname "$PACKAGE")" && pwd)/$(basename "$PACKAGE")"
    elif [ "${PACKAGE%.tgz}" != "$PACKAGE" ] || [ "${PACKAGE#*/}" != "$PACKAGE" ]; then
      fail "no such file: $PACKAGE (a --package path is read from this directory: $(pwd))"
    fi
    ;;
esac

say "Installing $PACKAGE into DeepSeek Harness profile '$PROFILE'..."
$DSH plugin --profile "$PROFILE" add "$PACKAGE"

BROKER="$PROFILE_DIR/node_modules/@corsen-ai/dsh-browser-connector/lib/broker-main.js"
[ -f "$BROKER" ] || fail "the connector was installed but its broker was not found at $BROKER"

mkdir -p "$HOME_DIR/connector"
chmod 700 "$HOME_DIR/connector"

# Stop a broker from a previous version before starting this one: two brokers on one port would
# leave the older one serving a newer extension.
if [ -f "$HOME_DIR/connector/broker.pid" ]; then
  OLD="$(cat "$HOME_DIR/connector/broker.pid")"
  kill "$OLD" 2>/dev/null && say "Stopped the previous broker (pid $OLD)." || true
  rm -f "$HOME_DIR/connector/broker.pid"
fi

# Prove the broker can load before starting it detached: --pairing-code runs the same entry, its
# modules and its credentials, in this shell, so a broker that cannot even start says why here.
CODE="$(node "$BROKER" --pairing-code --home "$HOME_DIR" 2>&1)" || fail "the broker cannot start: $CODE"

# Its stderr is kept too: a broker that dies later, before it can write its own log, must leave
# the reason where the message below points.
nohup node "$BROKER" --home "$HOME_DIR" --port "$BROKER_PORT" >/dev/null 2>>"$HOME_DIR/connector/broker.stderr.log" &
echo $! > "$HOME_DIR/connector/broker.pid"
sleep 1
kill -0 "$(cat "$HOME_DIR/connector/broker.pid")" 2>/dev/null \
  || fail "the broker did not stay running; see $HOME_DIR/connector/broker.log and broker.stderr.log"

say ""
say "Installed. The connector broker is running on 127.0.0.1:$BROKER_PORT."
say ""
say "  Pairing code:  $CODE"
say ""
say "Open the DeepSeek Harness Connector panel in Chrome and type that code once."
say "Restart any DeepSeek Harness that is already running so it loads the connector."
say ""
say "To remove: $0 --uninstall --profile $PROFILE"
