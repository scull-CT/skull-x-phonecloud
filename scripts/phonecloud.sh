#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root="$HOME/.phonecloud"
service="$PREFIX/var/service/phonecloud"
log="$PREFIX/var/log/sv/phonecloud/current"
url=http://127.0.0.1:8765

fail() { printf '%s\n' "$*" >&2; exit 1; }
supervise() {
  if "$PREFIX/bin/sv" status "$service" >/dev/null 2>&1; then return; fi
  export SVDIR="$PREFIX/var/service"
  if [[ -x "$PREFIX/bin/service-daemon" ]]; then
    "$PREFIX/bin/service-daemon" start >/dev/null 2>&1 || :
  else
    fail 'termux-services is incomplete. Run phonecloud repair.'
  fi
  for ((i=0;i<40;i++)); do
    "$PREFIX/bin/sv" status "$service" >/dev/null 2>&1 && return 0
    sleep .25
  done
  fail 'Termux service supervisor is unavailable. Open a new Termux session and retry.'
}
wait_health() {
  local status health
  for ((i=0;i<40;i++)); do
    status=$("$PREFIX/bin/sv" status "$service" 2>/dev/null || :)
    if [[ "$status" == run:* ]] && health=$(curl --noproxy '*' --max-time 1 -fs "$url/healthz") && [[ "$health" == *'"status":"ok"'* ]]; then
      printf 'Dashboard: %s\n' "$url"
      show_wifi_url "$health"
      return 0
    fi
    sleep .25
  done
  printf 'Dashboard did not become healthy. See phonecloud logs.\n' >&2
  return 1
}
show_wifi_url() {
  if [[ "$1" =~ \"lanUrl\":\"(http://[0-9.]+:[0-9]+)\" ]]; then
    printf 'Dashboard on the same Wi-Fi: %s\n' "${BASH_REMATCH[1]}"
  fi
}
no_extra() { [[ "$#" == 0 ]] || fail 'Unexpected command arguments. Run phonecloud help.'; }
command="${1:-help}"
if [[ "$#" -gt 0 ]]; then shift; fi
case "$command" in
  status)
    no_extra "$@"
    "$PREFIX/bin/sv" status "$service"
    health=$(curl --noproxy '*' --max-time 2 -fsS "$url/healthz")
    printf '%s\n' "$health"
    show_wifi_url "$health"
    ;;
  start|restart)
    no_extra "$@"
    supervise
    if [[ "$command" == start ]]; then "$PREFIX/bin/sv" up "$service"
    else "$PREFIX/bin/sv" -w 12 down "$service"; "$PREFIX/bin/sv" up "$service"; fi
    rm -f -- "$service/down"
    wait_health
    ;;
  stop)
    no_extra "$@"
    touch "$service/down"
    if "$PREFIX/bin/sv" status "$service" >/dev/null 2>&1; then "$PREFIX/bin/sv" -w 12 down "$service"; fi
    printf 'PhoneCloud is stopped.\n'
    ;;
  logs)
    [[ -f "$log" ]] || fail 'There is no current service log.'
    case "${1:-}" in '') no_extra "$@"; tail -n 100 "$log";; --follow) [[ "$#" == 1 ]] || fail 'Usage: phonecloud logs [--follow]'; exec tail -F "$log";; *) fail 'Usage: phonecloud logs [--follow]';; esac
    ;;
  setup-code)
    no_extra "$@"
    [[ -f "$root/data/setup-code" ]] || fail 'Initial setup code is unavailable. Check service status or sign in.'
    cat "$root/data/setup-code"
    ;;
  update|repair)
    [[ "$#" -le 1 ]] || fail "Usage: phonecloud $command [GitHub clone URL]"
    if [[ "$command" == update && "$#" == 0 && ! -f "$root/source" ]]; then fail 'Supply the published GitHub clone URL to update this source checkout.'; fi
    exec "$PREFIX/bin/bash" "$root/current/install.sh" "$command" "$@"
    ;;
  boot|battery|wake-lock)
    [[ "$#" == 1 ]] || fail "Usage: phonecloud $command enable|disable"
    feature="$command"
    [[ "$command" == boot ]] && feature=boot-enabled
    case "$1" in
      enable)
        if [[ "$command" == battery ]]; then command -v termux-battery-status >/dev/null || fail 'Install the matching Termux:API add-on and run pkg install termux-api first.'; fi
        touch "$root/$feature"
        if [[ "$command" == wake-lock ]]; then termux-wake-lock; fi
        ;;
      disable)
        rm -f -- "$root/$feature"
        if [[ "$command" == wake-lock ]]; then termux-wake-unlock; fi
        ;;
      *) fail "Usage: phonecloud $command enable|disable" ;;
    esac
    if [[ "$command" == battery ]]; then printf 'Run phonecloud restart to apply battery collection settings.\n'; fi
    ;;
  doctor)
    no_extra "$@"
    printf 'Android API: '; /system/bin/getprop ro.build.version.sdk
    printf 'Termux architecture: '; dpkg --print-architecture
    node --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; console.log("Node " + process.version, new DatabaseSync(":memory:").prepare("SELECT sqlite_version() AS sqlite").get().sqlite)'
    df -h "$root/data"
    "$PREFIX/bin/sv" status "$service" || :
    curl --noproxy '*' --max-time 2 -fsS "$url/healthz" || printf 'Dashboard health check failed.\n'
    printf '\nDisk hardware health counters require Android privileges.\n'
    ;;
  backup|restore)
    if [[ "$command" == backup ]]; then [[ "$#" == 1 ]] || fail 'Usage: phonecloud backup FILE'
    else
      [[ "$#" == 2 && ( "$2" == --preview || "$2" == --apply ) ]] || fail 'Usage: phonecloud restore FILE --preview|--apply'
    fi
    [[ "$1" == /* ]] || set -- "$PWD/$1" "${@:2}"
    read -rsp 'Backup passphrase: ' passphrase </dev/tty
    printf '\n' >&2
    if [[ "$command" == restore && "$2" == --apply ]]; then
      printf '%s\n' "$passphrase" | "$PREFIX/bin/node" "$root/current/scripts/backup.mjs" restore "$1" --preview >/dev/null
      "$PREFIX/bin/bash" "${BASH_SOURCE[0]}" stop
    fi
    printf '%s\n' "$passphrase" | "$PREFIX/bin/node" "$root/current/scripts/backup.mjs" "$command" "$@"
    ;;
  uninstall)
    [[ "$#" == 1 && "$1" == --yes ]] || fail 'Run phonecloud uninstall --yes to remove the service and CLI while keeping data.'
    "$PREFIX/bin/bash" "${BASH_SOURCE[0]}" stop
    if "$PREFIX/bin/sv" status "$service" >/dev/null 2>&1; then
      "$PREFIX/bin/sv" exit "$service"
      "$PREFIX/bin/sv" exit "$service/log" || :
    fi
    if [[ -f "$root/wake-lock" ]]; then termux-wake-unlock || :; fi
    rm -f -- "$service/run" "$service/log/run" "$HOME/.termux/boot/30-phonecloud" "$PREFIX/bin/phonecloud" "$root/boot-enabled"
    printf 'PhoneCloud disabled. Data and installed releases are preserved at %s.\n' "$root"
    ;;
  help|-h|--help)
    no_extra "$@"
    printf '%s\n' 'phonecloud status|start|stop|restart|logs|doctor|setup-code|update|repair' \
      'phonecloud boot|battery|wake-lock enable|disable' 'phonecloud backup FILE' 'phonecloud restore FILE --preview|--apply' 'phonecloud uninstall --yes'
    ;;
  *) fail "Unknown command: $command. Run phonecloud help." ;;
esac
