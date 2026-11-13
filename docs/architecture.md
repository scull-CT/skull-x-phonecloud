# Architecture and Android validation

PhoneCloud runs one Node.js 24 control process under Termux runit. The browser dashboard uses native HTML, CSS and JavaScript, so there is no dashboard build step on the phone. The manager uses the Node HTTP, crypto and SQLite modules. SQLite stores management state in WAL mode. Application releases, mutable application files and database backups have distinct paths under Termux's private home.

## Dependency decisions

The [official Termux ARM64 package index](https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages.gz) was downloaded and inspected on November 13, 2026. It listed nodejs-lts 24.22.3, libsqlite and sqlite 3.54.1-1, runit 2.3.1, git 2.56.1, python 3.14.10, cloudflared 2026.11.0, termux-api 0.60.0, Bash, curl, tar, coreutils and util-linux for aarch64. The npm, python-pip, ca-certificates and termux-services packages are architecture-independent. The installer runs a local Node/SQLite write probe before starting services. See [physical-device verification](android-validation.md) for executed checks.

- [Termux Node LTS](https://github.com/termux/termux-packages/blob/master/packages/nodejs-lts/build.sh) explicitly targets Android and links Termux SQLite. Using `node:sqlite` avoids addon compilation and Linux libc assumptions. The runtime floor is Node 24.
- [PocketBase](https://pocketbase.io/docs/) informed the embedded SQLite and change-stream design. Its published Linux ARM64 download is not an Android support commitment. One manager process also avoids an additional control plane and credential store.
- [Fastify 5](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/) supports Node 20 and above. The manager has a small, fixed route surface and uses Node HTTP with explicit body limits, validation and same-origin checks. React/Vite can be used by hosted projects.
- [Coolify](https://coolify.io/docs/core/how-coolify-works) informed the separation of application routing, builds and persistent state. Its Docker, Redis and PostgreSQL stack is unsuitable as a baseline for rootless Termux.
- [termux-services](https://github.com/termux/termux-services) provides runit supervision and rotating logs. [Termux:Boot](https://github.com/termux/termux-boot) can start the services after Android allows its boot receiver to run.
- [Termux cloudflared](https://github.com/termux/termux-packages/blob/master/packages/cloudflared/build.sh) is optional. Named tunnels use outbound connections and can publish applications on an existing Cloudflare DNS zone. [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) provide temporary URLs without an account, and do not support SSE. [Partial third-party DNS setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/) has Cloudflare plan requirements. The free path for an existing domain uses Cloudflare authoritative DNS or an eligible delegated zone.

## Boundaries

The dashboard listens on loopback only. Public application traffic uses a separate listener. The Android app sandbox protects Termux from other Android apps. All PhoneCloud workloads inside Termux share its UID and can access its files and other processes. Host only code and build dependencies you trust. Container isolation and enforceable per-project memory ceilings are outside this architecture.

Android may block device CPU counters, thermal sensors, or [network interface statistics](https://github.com/termux/termux-packages/wiki/Termux-file-system-layout). The collector returns null for inaccessible counters. Battery data uses optional Termux:API. [Doze](https://developer.android.com/training/monitoring-device-state/doze-standby), vendor background policies and Android child-process limits can suspend or kill Termux. A wake lock and battery exemption improve availability where allowed. A phone cannot provide guaranteed 24/7 service.

Core operation is local and has no software, API or cloud subscription fees. Electricity, network access and optional domain registration or renewal remain the operator's expenses.
