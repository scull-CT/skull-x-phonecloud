# Operations and troubleshooting

## Command line

| Command | Result |
| --- | --- |
| `phonecloud status` | Shows runit status and checks the dashboard's health endpoint. |
| `phonecloud start`, `stop`, `restart` | Controls the Termux service. |
| `phonecloud logs [--follow]` | Reads the supervisor log. Application logs are in the dashboard. |
| `phonecloud setup-code` | Shows the pending one-time setup code. |
| `phonecloud doctor` | Shows Termux, Node, SQLite, disk and service diagnostics. |
| `phonecloud repair [GITHUB_CLONE_URL]` | Reinstalls dependencies and service definitions and checks startup. |
| `phonecloud update [GITHUB_CLONE_URL]` | Installs the newest revision of the verified source repository's default branch. Use a repository you control or trust. |
| `phonecloud backup FILE` | Writes an encrypted snapshot to a new filename. |
| `phonecloud restore FILE --preview` | Decrypts the archive, checks SQLite integrity and reports contents. |
| `phonecloud restore FILE --apply` | Stops the manager and replaces its active data directory. Preserves the previous directory alongside it. Run `phonecloud start` afterward. |
| `phonecloud uninstall --yes` | Removes service entry scripts and the CLI. Data, logs, releases and Termux packages remain available. |

The installed service binds `127.0.0.1:8765` for administration and `127.0.0.1:8766` for the public gateway. If either is occupied, stop the conflicting listener before retrying. Consult `phonecloud logs` and `phonecloud doctor`. For package mirror errors, check the connection and use `termux-change-repo` before retrying. Low-space installs require at least 512 MiB available, and several data operations enforce additional free-space checks.

## Application deployment

Commands are JSON arrays. Examples include `["npm","ci"]`, `["npm","run","build"]` and `["node","server.mjs"]`. On Termux, install npm with `pkg install npm` if absent. For Python use `pkg install python python-pip`. Apps should use `PHONECLOUD_DATA_DIR` for writable data that survives release changes. A candidate starts on a new port and must return HTTP 2xx on its health path before activation. The previous process may run briefly alongside it. Avoid runtime migrations that would break the prior release. Node/Vite native toolchains must be tested on the phone. [Vite Android issue](https://github.com/vitejs/vite/issues/20766) · [Termux Rolldown issue](https://github.com/termux/termux-packages/issues/30852)

For a public GitHub sample use `https://github.com/render-examples/express-hello-world.git`, branch `main`, install `["npm","install"]`, start `["node","app.js"]`, health path `/`. That third-party sample manages its own bind address. The bundled sample respects `HOST`.

GitHub push webhooks use JSON at `https://YOUR_PUBLIC_HOST/hooks/PROJECT_ID`. Create a webhook secret in Projects and enter it in GitHub. The handler validates the [HMAC signature](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), repository and branch. A build already in progress can reject a delivery. Redeliver failed events from GitHub.

## Same Wi-Fi

For devices on the same Wi-Fi, use **Networking → Same Wi-Fi**. The selected app opens at the root of the phone's private IPv4 address on port 8767, so its normal asset and API paths work. Anyone on the same subnet can open it over HTTP. Guest Wi-Fi or client isolation can block traffic between devices. Refresh the panel for the new URL if the phone's IP changes. The management dashboard remains on loopback port 8765.

## Cloudflare

1. Run `pkg install cloudflared` in Termux. For a temporary test select a running app in **Networking**, start a Quick Tunnel and refresh until the URL appears. These URLs are public and temporary. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
2. For persistent HTTPS use an existing domain added to Cloudflare under a free full DNS setup. Create a scoped token for the account with Cloudflare Tunnel Edit, and scope DNS Edit to the specific zone if using automatic DNS. In **Networking**, enter the account ID, API token, optional zone ID and optional dedicated remotely managed tunnel ID. [Cloudflare tunnel API walkthrough](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)
3. In **Domains**, enter a hostname and choose its app or database. Enable automatic DNS to create a proxied CNAME. To manage DNS yourself in an eligible Cloudflare zone, create the proxied CNAME using the displayed target. Existing records require review. The app will not take ownership of them. For third-party authoritative DNS, Cloudflare's partial setup requires an eligible plan and is outside the mandatory free deployment path. [Partial DNS requirements](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)
4. Use **Check tunnel health** and **Test DNS and HTTPS**. The latter checks system DNS and a marker served by the mapped gateway. Then open the actual app URL or call the database API. If the connector cannot connect, confirm the network permits [Cloudflare Tunnel egress](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/).

## Backups and recovery

Archives use authenticated encryption and a passphrase-derived key. A snapshot contains each SQLite database via SQLite's backup API, the installation encryption key inside the encrypted archive, project source and mutable project files. Application release directories are excluded. Application files are copied as read and may change during a live backup. Quiesce apps before snapshotting their mutable files. The archive limit is 64 MiB uncompressed and 12,000 files. Scheduled backups retain up to the configured count. Download or copy archives off-device for phone-loss recovery.

On a fresh installation, or when recovering a damaged data directory, place the archive somewhere Termux can read it. Run `phonecloud restore FILE --preview`, then `phonecloud restore FILE --apply` and `phonecloud start`. Use the original administrator login and redeploy each project. If the wrapper is unavailable, install from source to get a new copy or, with the service stopped, run `node scripts/backup.mjs restore FILE --apply` from a separate checkout and enter the passphrase on standard input. Existing data is moved aside before the restore becomes active.
