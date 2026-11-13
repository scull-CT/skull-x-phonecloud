# Android acceptance checklist

Verified on a physical Samsung SM-E176B with Android 16, Termux 0.118.3, Node 24.22.3 and SQLite 3.54.1. The local-source installer started the runit service, a repeat install preserved setup state, and CLI restart returned the service to healthy status. All five integration tests passed under the Termux app user. A native Python 3.14.10 app served a response through a real Cloudflare Quick Tunnel using cloudflared 2026.11.0 and HTTP/2. The tests used disposable fixture data. The installed service is ready for its first administrator.

The remaining acceptance checks include named Cloudflare HTTPS and DNS on an account with a domain, reboot startup with Termux:Boot, battery permissions, and toolchains that use Android-specific native bindings. Repeat these checks on each target device and Android release.

| Check on a physical ARM64 phone | Expected result |
| --- | --- |
| Clean install in F-Droid/GitHub Termux | The ARM64 SQLite write probe passes, the local dashboard responds, and a setup code is shown. |
| Repeat the install and run repair | Existing admin and user data remain available. |
| Stop, start and restart the manager | Service status agrees with the dashboard health endpoint. |
| Deploy the bundled app and a GitHub repository | Health checks pass, the app opens and the GitHub release shows its commit. |
| Upload a prebuilt Vite site and try a compatible local build | Static assets load. Any Android linker failures are reported in build logs. |
| Start two authenticated realtime clients | Both receive the next successfully committed record. |
| Start a Quick Tunnel and a named tunnel | A second device can open the app via HTTPS. The database SSE route uses a named tunnel. |
| Switch mobile data/Wi-Fi and reconnect | The named connector reconnects and reports health. |
| Enable boot startup and reboot | The manager and enabled apps return when Android permits. |
| Install the matching Termux:API add-on and enable battery sampling | Battery readings appear when the device and permission settings provide them. |
| Back up, verify and restore to a separate installation | Database and project data can be read, and apps can be redeployed. |

To test boot startup, open Termux:Boot once, set Android battery usage to unrestricted where available, and run `phonecloud boot enable`. Optionally run `phonecloud wake-lock enable`. For optional battery readings, install the same-source Termux:API companion, grant permissions manually when prompted, run `pkg install termux-api`, `phonecloud battery enable` and `phonecloud restart`. A stopped or force-stopped app can require manual relaunch.
