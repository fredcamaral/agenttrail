#!/usr/bin/env bash
# Checks install.sh without installing anything: syntax, shellcheck if it is
# here, and the two paths that must never touch the machine (--help, --dry-run).
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
INSTALL="$HERE/install.sh"
fails=0

check() { # check <name> <command...>
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then
    printf 'ok    %s\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"
    fails=$((fails + 1))
  fi
}

# Output only. Several of these commands are supposed to exit non-zero.
contains() { # contains <name> <needle> <command...>
  local name=$1 needle=$2; shift 2
  local out
  out=$("$@" 2>&1) || true
  case $out in
    *"$needle"*) printf 'ok    %s\n' "$name" ;;
    *) printf 'FAIL  %s (expected %s, got: %s)\n' "$name" "$needle" "$out"; fails=$((fails + 1)) ;;
  esac
}

check "parses"        bash -n "$INSTALL"
check "executable"    test -x "$INSTALL"

if command -v shellcheck >/dev/null 2>&1; then
  check "shellcheck"  shellcheck "$INSTALL"
else
  printf 'skip  shellcheck (not installed)\n'
fi

contains "--help"                 "usage:"    bash "$INSTALL" --help
contains "--dry-run plans"        "dry run"   bash "$INSTALL" --dry-run
contains "--dry-run honours port" ":5331"     bash "$INSTALL" --dry-run --port 5331
contains "--dry-run tailnet"      "never funnel" bash "$INSTALL" --dry-run --tailnet
contains "--dry-run uninstall"    "autostart --remove" bash "$INSTALL" --dry-run --uninstall
contains "rejects bad port"       "needs a number" bash "$INSTALL" --port abc
contains "rejects unknown flag"   "unknown argument" bash "$INSTALL" --nope

# A dry run must write nothing. Run it against a throwaway HOME and assert that
# HOME is still empty afterwards, so a future dry run that calls autostart for
# real is caught here instead of on someone's machine.
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
HOME="$sandbox" bash "$INSTALL" --dry-run --tailnet >/dev/null 2>&1 || true
if [ -z "$(ls -A "$sandbox")" ]; then
  printf 'ok    dry run writes nothing\n'
else
  printf 'FAIL  dry run wrote into HOME: %s\n' "$(ls -A "$sandbox")"
  fails=$((fails + 1))
fi

if [ "$fails" -eq 0 ]; then
  printf '\nall good\n'
else
  printf '\n%d failed\n' "$fails"
  exit 1
fi
