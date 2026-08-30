#!/usr/bin/env bash
# install.sh — install agenttrail as a login service, from this checkout.
#
# It does not write a unit file of its own: `agenttrail autostart` already
# writes the launchd plist / systemd user unit, pointing at the checkout it was
# run from. This script preflights, invokes that, activates the result, and
# checks the daemon actually answers.
set -euo pipefail

# Must match AUTOSTART_LABEL and the unit filename in bin/agenttrail.mjs.
LABEL=dev.agenttrail.daemon
UNIT=agenttrail

PORT=5330
TAILNET=0
UNINSTALL=0
DRY_RUN=0
OS=
NODE=
TS=

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
bold() { if [ -t 1 ]; then printf '\033[1m%s\033[0m' "$1"; else printf '%s' "$1"; fi; }

usage() {
  cat <<'EOF'
install agenttrail as a login service, from this checkout.

usage:
  scripts/install.sh [--port N] [--tailnet]
  scripts/install.sh --uninstall [--port N]
  scripts/install.sh --dry-run [...]      print the plan, change nothing
  scripts/install.sh --help

  --port N     port for the daemon (default 5330)
  --tailnet    also expose it on your tailnet over https, tailnet-only,
               never funnel
  --uninstall  stop and remove the service, and our tailnet serve; leaves
               ~/.agenttrail alone
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --port) [ $# -ge 2 ] || die "--port needs a number"
              PORT=$2; shift 2
              case $PORT in ''|*[!0-9]*) die "--port needs a number, got: $PORT";; esac ;;
      --tailnet) TAILNET=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown argument: $1" ;;
    esac
  done
}

detect_os() {
  case $(uname -s) in
    Darwin) OS=macos ;;
    Linux) OS=linux ;;
    *) die "$(uname -s) is not supported. agenttrail installs as a service on macOS and Linux only; elsewhere run 'node bin/agenttrail.mjs up' from your own startup." ;;
  esac
}

# The repo is wherever this script lives, so it works from any cwd.
resolve_repo() {
  local dir
  dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  REPO=$(dirname -- "$dir")
  [ -f "$REPO/bin/agenttrail.mjs" ] || die "$REPO does not look like an agenttrail checkout (no bin/agenttrail.mjs)"
}

preflight() {
  command -v git >/dev/null 2>&1 || die "git is not installed"
  NODE=$(command -v node) || die "node is not installed. agenttrail needs Node 22 or newer."
  local v major
  v=$("$NODE" -v)       # v22.11.0
  v=${v#v}
  major=${v%%.*}
  case $major in ''|*[!0-9]*) die "could not read the node version from '$("$NODE" -v)'";; esac
  [ "$major" -ge 22 ] || die "node $v is too old, agenttrail needs 22 or newer"
}

# ---------- health ----------

# Node is already a hard requirement, so it is also the http client.
probe() {
  "$NODE" -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(1500)}).then(r=>r.text()).then(t=>process.stdout.write(t),()=>process.exit(1))' \
    "http://127.0.0.1:$PORT/whoami"
}

# Prints the last response either way, so a failure can be reported with what
# the port actually said. A stranger on the port is a failure, not a success.
wait_healthy() {
  local n=0 out=''
  while [ "$n" -lt 20 ]; do
    out=$(probe 2>/dev/null) || out=''
    case $out in *'"name":"agenttrail"'*) printf '%s' "$out"; return 0 ;; esac
    n=$((n + 1))
    sleep 0.5
  done
  printf '%s' "$out"
  return 1
}

logs_hint() {
  if [ "$OS" = macos ]; then
    printf 'launchctl print gui/%s/%s' "$(id -u)" "$LABEL"
  else
    printf 'journalctl --user -u %s -n 50' "$UNIT"
  fi
}

# ---------- service ----------

activate_macos() {
  local plist=$1 uid
  uid=$(id -u)
  # Drop any live copy first, so re-running over an install is clean rather
  # than a "service already loaded" failure.
  launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$uid" "$plist" >/dev/null 2>&1; then return 0; fi
  launchctl load -w "$plist" || die "launchctl could not load $plist"
}

activate_linux() {
  systemctl --user daemon-reload || die "systemctl --user daemon-reload failed"
  systemctl --user enable "$UNIT" >/dev/null || die "systemctl --user enable $UNIT failed"
  # restart, not start: over a live install this is what picks up the new unit.
  systemctl --user restart "$UNIT" || die "systemctl --user restart $UNIT failed, see: $(logs_hint)"
  check_linger
}

check_linger() {
  local linger
  linger=$(loginctl show-user "$USER" --property=Linger 2>/dev/null || true)
  if [ "$linger" = "Linger=no" ]; then
    say "warning: lingering is off, so the service stops when you log out."
    say "  keep it running:  sudo loginctl enable-linger $USER"
  fi
}

# ---------- tailnet ----------

tailscale_bin() {
  if command -v tailscale >/dev/null 2>&1; then command -v tailscale; return 0; fi
  # The macOS app ships its CLI inside the bundle and often is not on PATH.
  if [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    printf '%s\n' /Applications/Tailscale.app/Contents/MacOS/Tailscale
    return 0
  fi
  return 1
}

# On Linux `tailscale serve` is root-only until you are set as the operator.
serve_available() {
  local out low
  out=$("$TS" serve status 2>&1) && return 0
  low=$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')
  case $low in
    *"access denied"*|*"permission denied"*|*operator*)
      say "tailscale serve needs you registered as its operator."
      say "  run once:  sudo tailscale set --operator=$USER"
      if sudo -n true 2>/dev/null; then
        say "  sudo works without a password here, running it now"
        sudo -n "$TS" set --operator="$USER" || return 1
        "$TS" serve status >/dev/null 2>&1 && return 0
      fi
      return 1 ;;
  esac
  say "$out"
  return 1
}

tailnet_url() {
  "$TS" status --json 2>/dev/null | "$NODE" -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const n = JSON.parse(s).Self.DNSName.replace(/\.$/, "")
        if (n) process.stdout.write("https://" + n + "\n")
      } catch {}
    })' || true
}

tailnet_on() {
  TS=$(tailscale_bin) || die "tailscale is not installed, or its CLI is not on PATH. Install it, or drop --tailnet."
  serve_available || die "tailscale serve is not usable yet, see the hint above"
  # Tailnet-only, forever. Never funnel: funnel would publish every transcript
  # on this machine to the public internet.
  "$TS" serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null \
    || die "tailscale serve failed for http://127.0.0.1:$PORT"
  local url
  url=$(tailnet_url)
  if [ -n "$url" ]; then
    say "tailnet: $(bold "$url")"
  else
    say "tailnet: serving on https 443, run 'tailscale status' for this machine's name"
  fi
}

# Only turn off a serve that is ours.
tailnet_off() {
  TS=$(tailscale_bin) || return 0
  local out
  out=$("$TS" serve status 2>/dev/null || true)
  case $out in
    *"127.0.0.1:$PORT"*)
      if "$TS" serve --https=443 off >/dev/null 2>&1; then
        say "stopped the tailscale serve on https 443"
      else
        say "could not stop the tailscale serve, do it with:  tailscale serve --https=443 off"
      fi ;;
    *) : ;;  # someone else's serve, or none — leave it alone
  esac
}

# ---------- commands ----------

install_service() {
  local out unit
  # -y so it overwrites an existing unit without asking; the daemon points the
  # unit at its own path, which is this checkout.
  out=$("$NODE" "$REPO/bin/agenttrail.mjs" autostart -y --port "$PORT") \
    || die "agenttrail autostart failed"
  unit=$(printf '%s\n' "$out" | sed -n 's/^wrote //p')
  [ -n "$unit" ] || die "agenttrail autostart wrote no service file. It said: $out"
  say "service:  $unit"
  say "runs:     $NODE $REPO/bin/agenttrail.mjs --port $PORT"

  if [ "$OS" = macos ]; then activate_macos "$unit"; else activate_linux; fi

  local body
  if body=$(wait_healthy); then
    say ""
    say "$(bold "agenttrail is up") · http://127.0.0.1:$PORT"
    say "  $body"
  else
    say ""
    say "the service did not answer on port $PORT within 10s."
    [ -n "$body" ] && say "  port $PORT said: $body"
    say "  the daemon walks up a port when $PORT is taken — check: $(logs_hint)"
    exit 1
  fi

  [ "$TAILNET" -eq 1 ] && tailnet_on
  return 0
}

uninstall_service() {
  if [ "$OS" = macos ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 \
      || launchctl remove "$LABEL" >/dev/null 2>&1 \
      || true
  else
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
  fi
  "$NODE" "$REPO/bin/agenttrail.mjs" autostart --remove || die "could not remove the service file"
  [ "$OS" = linux ] && { systemctl --user daemon-reload || true; }
  tailnet_off
  say "agenttrail is uninstalled."
  say "  its state is still at $HOME/.agenttrail (read offsets and the digest journal). Delete it yourself if you want it gone."
}

print_plan() {
  say "$(bold "plan") (dry run, nothing will change)"
  say "  os:      $OS"
  say "  repo:    $REPO"
  say "  node:    $NODE $("$NODE" -v)"
  say "  port:    $PORT"
  if [ "$UNINSTALL" -eq 1 ]; then
    if [ "$OS" = macos ]; then
      say "  1. launchctl bootout gui/$(id -u)/$LABEL"
    else
      say "  1. systemctl --user disable --now $UNIT"
    fi
    say "  2. node bin/agenttrail.mjs autostart --remove"
    say "  3. tailscale serve --https=443 off, only if it points at 127.0.0.1:$PORT"
    say "  keeps $HOME/.agenttrail"
  else
    say "  1. node bin/agenttrail.mjs autostart -y --port $PORT"
    if [ "$OS" = macos ]; then
      say "  2. launchctl bootout, then bootstrap gui/$(id -u) (load -w if that is too old)"
    else
      say "  2. systemctl --user daemon-reload, enable $UNIT, restart $UNIT"
    fi
    say "  3. poll http://127.0.0.1:$PORT/whoami for up to 10s"
    [ "$TAILNET" -eq 1 ] && say "  4. tailscale serve --bg --https=443 http://127.0.0.1:$PORT (tailnet-only, never funnel)"
  fi
  return 0
}

main() {
  parse_args "$@"
  detect_os
  resolve_repo
  preflight
  if [ "$DRY_RUN" -eq 1 ]; then print_plan; exit 0; fi
  if [ "$UNINSTALL" -eq 1 ]; then uninstall_service; else install_service; fi
}

main "$@"
