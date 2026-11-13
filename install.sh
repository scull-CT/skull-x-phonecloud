#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

main() {
  local mode="${1:-install}" source="${2:-}" root="$HOME/.phonecloud"
  local previous='' sdk architecture available ram commit release service stage_name=preflight
  stage=''
  install_root="$root"
  trap 'printf "PhoneCloud installation stopped during %s (line %s). Fix the error and rerun the same command.\n" "$stage_name" "$LINENO" >&2' ERR
  fail() { printf '%s\n' "$*" >&2; exit 1; }
  case "$mode" in install|update|repair) ;; *) fail 'Usage: bash install.sh [install|update|repair] [https://github.com/OWNER/REPO.git]';; esac
  [[ -n "${PREFIX:-}" && -x "$PREFIX/bin/pkg" && -x /system/bin/getprop ]] ||
    fail 'Run this installer inside the F-Droid or GitHub build of Termux.'
  sdk=$(/system/bin/getprop ro.build.version.sdk)
  architecture=$(dpkg --print-architecture)
  [[ "$sdk" =~ ^[0-9]+$ && "$sdk" -ge 24 && "$architecture" == aarch64 ]] ||
    fail "Requires Android 7+ and 64-bit ARM Termux. Found SDK $sdk and $architecture."
  [[ "$HOME" == "${PREFIX%/usr}/home" && ! -L "$root" ]] ||
    fail 'Use Termux private home storage for this installation.'
  available=$(df -Pk "$HOME" | awk 'END { print $4 }')
  [[ "$available" =~ ^[0-9]+$ && "$available" -ge 524288 ]] ||
    fail 'Free at least 512 MiB in Termux internal storage, then retry.'
  ram=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || :)
  printf 'Android API %s, Termux %s, free disk %s MiB, device RAM %s\n' "$sdk" "$architecture" "$((available / 1024))" "${ram:+$ram KiB}"
  if [[ -n "$ram" && "$ram" -lt 1048576 ]]; then printf 'Low device RAM. Run only the control panel until performance is checked.\n'; fi
  mkdir -p "$root/releases" "$root/data"
  stage_name='Termux package installation'
  pkg update -y
  pkg install -y nodejs-lts git curl termux-services util-linux
  exec 9>"$root/install.lock"
  flock -n 9 || fail 'Another PhoneCloud installation is running.'
  stage=$(mktemp -d "$root/releases/stage.XXXXXXXX")
  trap '[[ -z "${stage:-}" ]] || { [[ "$stage" == "$install_root/releases/stage."* ]] && rm -rf -- "$stage"; }; :' EXIT
  stage_name='source checkout'
  if [[ -z "$source" && -f "$root/source" ]]; then read -r source < "$root/source"; fi
  if [[ -z "$source" && ! -f "${BASH_SOURCE[0]:-}" ]]; then
    source='https://github.com/scull-CT/skull-x-phonecloud.git'
  fi
  if [[ -n "$source" ]]; then
    [[ "$source" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]] || fail 'Use a public GitHub HTTPS clone URL.'
    git clone --depth 1 -- "$source" "$stage/source"
    commit=$(git -C "$stage/source" rev-parse HEAD)
  elif [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    local checkout
    checkout=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
    [[ -f "$checkout/apps/server/index.mjs" ]] || fail 'Run the installer from a PhoneCloud source checkout.'
    mkdir "$stage/source"
    cp -R -- "$checkout/apps" "$checkout/packages" "$checkout/scripts" "$checkout/install.sh" "$checkout/package.json" "$stage/source/"
    commit="local-$(date +%s)-$$"
  else
    fail 'No published source configured. Run bash install.sh from a source checkout.'
  fi
  [[ -f "$stage/source/apps/server/index.mjs" && -f "$stage/source/scripts/phonecloud.sh" ]] || fail 'Source does not contain PhoneCloud.'
  stage_name='Android runtime probe'
  node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    if (process.arch !== "arm64" || +process.versions.node.split(".")[0] < 24) process.exit(1);
    const db = new DatabaseSync(process.argv[1]);
    db.exec("CREATE TABLE probe (n INT); INSERT INTO probe VALUES (42)");
    if (db.prepare("SELECT n FROM probe").get().n !== 42) process.exit(1);
    db.close();
  ' "$stage/probe.sqlite"
  node --check "$stage/source/apps/server/index.mjs"

  stage_name='service registration'
  release="$root/releases/$commit"
  if [[ ! -e "$release" ]]; then mv -- "$stage/source" "$release"; fi
  service="$PREFIX/var/service/phonecloud"
  [[ ! -e "$service" || -f "$service/.phonecloud" ]] || fail "A different service already exists at $service."
  mkdir -p "$service/log" "$PREFIX/var/log/sv/phonecloud" "$HOME/.termux/boot"
  touch "$service/.phonecloud"
  [[ -L "$root/current" ]] && previous=$(readlink "$root/current")
  if [[ -z "$previous" ]]; then touch "$service/down"; fi
  local target script
  for target in "$PREFIX/bin/phonecloud" "$service/run" "$service/log/run" "$HOME/.termux/boot/30-phonecloud"; do
    case "$target" in
      "$PREFIX/bin/phonecloud") script='exec "$PREFIX/bin/bash" "$HOME/.phonecloud/current/scripts/phonecloud.sh" "$@"' ;;
      "$service/run") script='exec 2>&1; export PHONECLOUD_HOME="$HOME/.phonecloud/data"; if [[ -f "$HOME/.phonecloud/battery" ]]; then export PHONECLOUD_BATTERY=1; fi; exec "$PREFIX/bin/node" "$HOME/.phonecloud/current/apps/server/index.mjs"' ;;
      "$service/log/run") script='exec "$PREFIX/bin/svlogd" -tt "$PREFIX/var/log/sv/phonecloud"' ;;
      *) script='if [[ -f "$HOME/.phonecloud/boot-enabled" ]]; then if [[ -f "$HOME/.phonecloud/wake-lock" ]]; then termux-wake-lock; fi; phonecloud start; fi' ;;
    esac
    [[ ! -e "$target" || -f "$target" && $(sed -n '2p' "$target") == '# Managed by Skull X PhoneCloud' ]] ||
      fail "A different file already exists at $target."
    printf '#!%s/bin/bash\n# Managed by Skull X PhoneCloud\n%s\n' "$PREFIX" "$script" > "$target.new"
    chmod 700 "$target.new"
    mv -f -- "$target.new" "$target"
  done
  printf 's1048576\nn5\n' > "$PREFIX/var/log/sv/phonecloud/config"
  ln -s -- "$release" "$stage/current"
  mv -Tf -- "$stage/current" "$root/current"
  stage_name='service health check'
  if ! "$PREFIX/bin/phonecloud" start || { [[ -n "$previous" ]] && ! "$PREFIX/bin/phonecloud" restart; }; then
    touch "$service/down"
    if [[ -n "$previous" ]]; then
      ln -s -- "$previous" "$stage/previous"
      mv -Tf -- "$stage/previous" "$root/current"
      "$PREFIX/bin/phonecloud" restart || :
    else
      "$PREFIX/bin/sv" down "$service" || :
    fi
    fail 'Service could not start. Run phonecloud logs and check whether port 8765 is already in use.'
  fi
  if [[ -n "$source" ]]; then printf '%s\n' "$source" > "$root/source"; fi
  printf '\nDashboard: http://127.0.0.1:8765\n'
  if [[ -f "$root/data/setup-code" ]]; then printf 'One-time setup code: '; cat "$root/data/setup-code"; fi
  printf 'For boot startup, install and open matching Termux:Boot, then run phonecloud boot enable.\n'
}

# A streamed installer starts work only after Bash has read the entire function.
main "$@"
