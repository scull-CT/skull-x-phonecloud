# Skull X PhoneCloud

Run a personal application server and realtime SQLite service on an Android ARM64 phone with Termux. Skull X PhoneCloud is MIT-licensed and runs without root, Docker, a paid cloud service or a credit card. Electricity, internet access and any custom domain registration or renewal are separate costs.

## First run

**Install in Termux**

1. Install Termux from its [official releases](https://github.com/termux/termux-app/releases) or [F-Droid](https://f-droid.org/en/packages/com.termux/), then open it. Use Android 7 or later and a 64-bit ARM Termux installation.
2. Run this command in Termux and keep it open during installation.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/scull-CT/skull-x-phonecloud/main/install.sh | bash
   ```

3. On the same phone, open [the local dashboard](http://127.0.0.1:8765). Enter the displayed one-time code and choose an admin username and a password of at least 14 characters. Recover a pending code with `phonecloud setup-code`.
4. For startup after reboot, install Termux:Boot from the same source as Termux, open it once, then run `phonecloud boot enable`. Follow the [Android validation checklist](docs/android-validation.md).

To install from a local checkout, place the source in Termux's private home and run `bash install.sh` from the checkout directory.

**Desktop development**

Use Node.js 24 or newer. Run `npm test` and `npm start`. The setup code is in `~/.phonecloud/data/setup-code`. Set `PHONECLOUD_HOME`, `PHONECLOUD_PORT` and `PHONECLOUD_PUBLIC_PORT` to use a different local development installation. Termux lifecycle commands use the standard Termux installation paths and ports.

## Use it

1. In **Projects**, create a Node.js project. Set the health path to `/healthz`.
2. In **Storage**, upload [examples/node/server.mjs](examples/node/server.mjs) to the source area as `server.mjs`.
3. In **Projects**, choose **Deploy**. Refresh **Deployments** until the release is ready, then open the application from **Projects**. For GitHub import, enter an HTTPS repository URL and branch instead of uploading the source.
4. In **Databases**, create a database and collection. Add a record and open the same collection in **Realtime** in another tab to watch subsequent changes. See the [database API](docs/database-api.md) for a second-device client.
5. For public HTTPS, follow the [Cloudflare setup](docs/operations.md). Keep the dashboard on loopback.
6. In **Backups**, create an encrypted snapshot. Download it off the phone and keep its passphrase separately. See [restore instructions](docs/operations.md).

To share a deployed website on your Wi-Fi, open **Networking → Same Wi-Fi**, choose the app and select **Share on Wi-Fi**. Open the displayed phone IP and port from another device on the same network. This uses local HTTP and works without Cloudflare. Keep sharing off on networks you don't trust.

## Support matrix

| Capability | Status |
| --- | --- |
| Node.js backend | Implemented. The app must bind `HOST` and `PORT` and provide an HTTP health endpoint. Native npm packages need Android-compatible builds. |
| Python web app | Implemented as a command runtime. Install `python python-pip` in Termux first. Native extensions require compatible packages. |
| Static HTML, CSS and JavaScript | Implemented. Use a dedicated public output folder for GitHub sources. |
| React/Vite | Built static output supported. On-device build support depends on that project's Vite version, plugins and native bindings. Upload prebuilt files when the toolchain fails on Android. |
| ASP.NET Core | Unsupported. A Linux-bionic ARM64 runtime identifier alone does not establish a supported ASP.NET Core distribution and operating profile on Termux. |
| Project deployments | Public GitHub branches, local files, explicit install/build/start commands, environment secrets, health checks, release history, rollback, restart and signed GitHub push webhooks. |
| Realtime database | Separate SQLite stores, JSON CRUD, API keys, user sign-in, collection rules, typed indexed fields, JSON/CSV exchange and SSE. Uses the PhoneCloud REST API. |
| Public HTTPS | Cloudflare Quick Tunnels for app testing, named tunnels and scoped Cloudflare DNS API integration. Existing domain and live device validation needed for custom HTTPS. |
| Backups | Encrypted manual and scheduled snapshots, retention, download, verification, offline preview and restore. Source, app data and settings are included within the documented limits. |
| Pending | TOTP, GitHub polling, private GitHub import, managed non-admin dashboard roles, application WebSocket proxying, OS disk health, and enforceable per-project memory limits. |

[Architecture](docs/architecture.md) · [Operations and troubleshooting](docs/operations.md) · [Security](docs/security.md) · [Database API and SDK examples](docs/database-api.md) · [Android acceptance checklist](docs/android-validation.md)
