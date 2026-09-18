# Installing DSH (Tali's fork + plugins) on a fresh Mac

Untracked working document — **do not commit**. Assembled 2026-09-18 from this
checkout, `~/github/tali-dash-plugins` (tools, recipes, plugin READMEs) and the
session transcripts `deepseek-harness/hybrid-local-remote` (T15–T17, T39–T43)
and `laptop/alpha-setup`, which set up the `alpha` MacBook Pro (macOS 27.0,
Apple Silicon) on 2026-09-16/17.

## What "the macOS app" is

Two things are called "the app"; this guide installs the first one.

| | What it is | Built by |
|---|---|---|
| **`~/Applications/DSH.app`** (what alpha got) | A ~350-line AppKit/WKWebView wrapper that opens `https://<host>.<tailnet>.ts.net/dsh/`, is admitted by the Mac's own Tailscale identity (no token, no expiring cookie), falls back to `http://127.0.0.1:<port>/?token=…` when Tailscale is down, and gets a Dock tile. Ad-hoc signed, no permissions. | `plugins/dsh-tailscale-remote/dock-app.mjs` in the plugins repo, compiled on the target with `xcrun swiftc` (Command Line Tools are enough; Xcode is not needed). |
| `apps/desktop` (Electron shell in this repo) | DeepSeek's signed/notarised Desktop release with a bundled Node runtime. Requires an Apple Developer ID, Team ID and notarytool credentials (`apps/desktop/README.md`). | Not used in Tali's setup. Not covered here. |

The Dock app is a thin client; the real install is the **DSH server** running
from a built checkout of this fork, plus a handful of out-of-tree plugins.
There are two ways to get that onto a fresh Mac:

- **Path B — deploy from a Mac that already runs DSH** (`pnpm deploy-remote
  user@host`). This is exactly what alpha received and is the verified path.
  The new Mac becomes a *remote* (headless server + its own Dock app) and
  appears in the deploying Mac's "Remotes" sidebar section.
- **Path C — standalone install** on the new Mac itself (what Tali's Air runs,
  minus the preview instance). Assembled from the live configuration and the
  recipes; **not yet run end-to-end on a blank machine** — expect to fix
  small things.

Both paths share the manual prerequisites in Part A. The preview instance
(`~/.dsh-preview`, `DSH Preview.app`, port 3088) is deliberately left out.

## Resulting topology (Path B, as on alpha)

```
Dock app / browsers on the tailnet ─▶ https://alpha.tailbce956.ts.net/dsh/
  └▶ tailscaled (TLS, injects Tailscale-User-Login) ─▶ dsh-tailscale-remote proxy 127.0.0.1:3084 (inside DSH)
        └▶ DSH web 127.0.0.1:3080   (LaunchAgent ai.symbolica.dsh-remote, KeepAlive, zsh -lc)
Local fallback: http://127.0.0.1:3084/?token=<standing token>   (Dock app uses it when Tailscale is off)
```

| On the target | Path |
|---|---|
| Node (pinned to the deployer's version, no sudo/brew) | `~/.local/node/bin/node` |
| Built checkout incl. `node_modules` (same darwin-arm64) | `~/dsh/checkout/` |
| Plugins shipped | `~/dsh/plugins/{dsh-tailscale-remote,local-model-supervisor,enforce-model-preset,session-title-slug}` |
| DSH home | `~/.dsh/` (`settings.yaml`, `.credentials.yaml` copied from the deployer on first run) |
| Composition overlay (regenerated every deploy) | `~/.dsh/deploy/remote.cordis.yml` |
| Remote state: standing token + allowlist (kept across deploys) | `~/.dsh/tailscale-remote.json` (0600) |
| User preset for the on-device model | `~/.dsh/.agent-presets/minimal-no-tools/` |
| LaunchAgent | `~/Library/LaunchAgents/ai.symbolica.dsh-remote.plist` |
| Logs (launchd stdout/stderr) | `~/dsh/logs/dsh.log`, `~/dsh/logs/afm.log` |
| Dock app | `~/Applications/DSH.app` (`Contents/Resources/dsh-dock-app.json` holds url/fallback/tokenFile) |

Path C differs: the checkout is `~/github/deepseek-harness` (it must sit next
to `~/github/tali-dash-plugins` — the plugins link into it relatively) run
through `pnpm dsh web`, an always-on **relay** LaunchAgent (`io.github.taliesinb.dsh-web-relay`,
port 3083) starts DSH on demand, and the plugins load from
`~/github/tali-dash-plugins/plugins/*` via `~/.dsh/profiles/web/cordis.patch.yml`.

---

## Part A — manual prerequisites on the new Mac

Assumes: Apple Silicon, macOS 26 or newer (alpha: 27.0), Homebrew installed,
an admin user. Nothing below is automated by the deploy script except
`brew install rsync`.

### A1. Xcode Command Line Tools (gives `swiftc` for the Dock app)

```sh
xcode-select --install          # GUI prompt; wait for it to finish
xcode-select -p                 # → /Library/Developer/CommandLineTools
xcrun --find swiftc && swift --version   # alpha: Apple Swift 6.4 (macOS 27)
```

The deploy script skips the Dock app with "no Swift toolchain" if `xcrun
--find swiftc` fails. `swiftc` must be invoked through `xcrun` (the CLT binary
called directly says "unable to load standard library") — the plugin does this.

### A2. Tailscale

1. Install **Tailscale.app** (tailscale.com standalone build or App Store; both
   put the CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, which
   is the path the deploy script and plugin default to). Optional:
   `ln -s /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale`.
2. Log in to the **right tailnet as the right user**. The symbolica tailnet's
   ACL lets a user reach only *their own* devices plus tagged infrastructure;
   alpha was logged in as `alpha@symbolica.ai`, so `tali@` could not reach it
   (all TCP silently dropped over the tailnet, fine over LAN) until the admin
   added a policy rule (`src: group:research → dst: alpha@symbolica.ai, all
   ports`). Options, in order of preference: log in as the same user as the
   deploying Mac; ask for an ACL rule; or tag the node — but **tagged nodes
   carry no `Tailscale-User-Login`**, so identity admission stops working and
   only the token/QR path remains.
3. Name it: `tailscale set --hostname=alpha` (MagicDNS name becomes
   `alpha.<tailnet>.ts.net`). Match the OS name if you like:
   `sudo scutil --set HostName alpha; sudo scutil --set LocalHostName alpha; sudo scutil --set ComputerName alpha`.
4. Tailnet must have **MagicDNS and HTTPS certificates** enabled (they are on
   symbolica); `tailscale serve` needs them. First HTTPS hit after publishing
   can take a few seconds while the cert is issued.
5. Verify from the deploying Mac: `tailscale ping alpha` and `nc -z -G 4 <tailnet-ip> 22`.

Known trap (worked around in the LaunchAgent): the macOS Tailscale CLI fails
with *"The Tailscale GUI failed to start"* from a bare launchd environment; it
works from a login shell (`SHLVL` set). Anything that runs `tailscale` under
launchd must go through `/bin/zsh -lc`.

### A3. Remote Login + key auth (Path B only)

System Settings → General → Sharing → **Remote Login** on. Then from the
deploying Mac (password prompt once):

```sh
ssh-copy-id -i ~/.ssh/id_ed25519.pub alpha@192.168.0.42     # LAN IP or tailnet name
ssh -o BatchMode=yes alpha@alpha 'echo ok'                  # must succeed without a prompt
```

`deploy-remote.sh` uses `BatchMode=yes`; it dies with "cannot ssh … (key auth
required)" otherwise. Note that a non-interactive `ssh host cmd` does **not**
load `~/.zprofile`, so `brew`/`/opt/homebrew/bin` is not on PATH — the script
wraps brew calls in `zsh -lc` for that reason; do the same when poking around.

### A4. Apple Intelligence + AFM (the `apple/foundation` model)

The fork's default preview/remote model is Apple's on-device model, reached
through **AFM** (`scouzi1966/maclocal-api`), an OpenAI-compatible Swift server
on `127.0.0.1:9997` that the `local-model-supervisor` plugin starts on demand.
Both pieces are manual:

1. System Settings → **Apple Intelligence & Siri** → enable, and wait for the
   model download. Until then every request fails with
   `"Apple Intelligence is not enabled."`.
2. Install afm (needs brew in a login shell):

   ```sh
   brew trust scouzi1966/afm            # Homebrew ≥ 6 refuses untrusted taps
   brew install scouzi1966/afm/afm      # macOS 27 / Swift 6.4: current stable works (alpha: v0.9.19)
   afm --version
   ```

   On **macOS 26 / Swift 6.3** stable afm ≥ 0.9.17 aborts with `503 … Swift
   6.4 toolchain`; install `scouzi1966/afm/afm@0.9.10` and add the metallib
   symlinks — see `tali-dash-plugins/recipes/apple-foundation-model-provider.md` §1–2.
3. Smoke test (then kill it; DSH will manage it):

   ```sh
   afm --port 9997 &
   curl -s http://127.0.0.1:9997/v1/models | head -c 200
   curl -s http://127.0.0.1:9997/v1/chat/completions -H 'content-type: application/json' -H 'authorization: Bearer x' \
     -d '{"model":"foundation","messages":[{"role":"user","content":"Reply with exactly: ok"}],"max_tokens":20}'
   kill %1
   ```

Skipping this is fine if you never select the Apple model; the deploy still
succeeds (alpha ran without afm for a day — "the apple foundation model isn't
working on alpha" was simply afm not being installed).

### A5. Homebrew rsync (Path B; auto-installed if missing)

Apple's `/usr/bin/rsync` is **openrsync** (protocol 29) and stalls forever on
the checkout's ~85k-file listing (the first deploy sat 15 minutes transferring
nothing). The script checks for `/opt/homebrew/bin/rsync` and runs `zsh -lc
"brew install rsync"` on the host when absent; doing it up front avoids the
surprise: `brew install rsync`.

### A6. Optional apps for the optional tool plugins

Only needed if you load these plugins (Path C, or if you later extend the
deploy's plugin list):

| Plugin | Needs on the Mac | Note |
|---|---|---|
| `browser-automation` (`safari_*`, `chrome_*` tools) | **Safari Technology Preview** (developer.apple.com/safari/technology-preview) — only STP ships `safaridriver --mcp`; stable Safari has no fallback. **Google Chrome** for `chrome_*` (`chrome-devtools-mcp` is a pinned dependency of the plugin, run by node). | First run of each may prompt: Safari ▸ Develop ▸ Allow Remote Automation is *not* needed for STP `--mcp`, but STP must be launched once to accept its licence. |
| `dash-docsets` | Dash 8 with docsets installed | plugin enables Dash's HTTP API itself |
| `wolfram-kernel-supervisor` | Mathematica / Wolfram 15 (`Wolfram.app`, `WolframScript.app`) with the AgentTools MCP server | |
| `notion-mcp` (a `dsh-mcp-client` row) | Node + one-time terminal login: `npx -y mcp-remote https://mcp.notion.com/mcp` (browser OAuth; token cached in `~/.mcp-auth`) | do this *before* the row loads or the prompt fires from the server process |
| LM Studio provider (`lmstudio`, `:1234`) | LM Studio.app with a model loaded and the local server on | |

### A7. Keep a headless remote awake

alpha reported `sleep 1 (sleep prevented by powerd …)`; for a lid-closed or
unattended server set `sudo pmset -a sleep 0 disablesleep 1` (or keep it on
power with "Prevent automatic sleeping" on).

---

## Part B — deploy from an existing DSH Mac (verified on alpha)

Run on the Mac that already has the fork built (Tali's Air). Requirements
there: `rsync`, `python3`, `tailscale` on PATH (used for `whois` to learn your
login for the allowlist; otherwise set `DSH_REMOTE_ALLOWED_USERS=you@example.com`),
the fork at `~/github/deepseek-harness` (override `DSH_CHECKOUT`), and the same
platform/arch as the target (`uname -sm` must match — `node_modules` incl.
native addons is shipped as-is).

```sh
cd ~/github/tali-dash-plugins
pnpm deploy-remote alpha@alpha                # tailnet name, or alpha@192.168.0.42 on the LAN
# flags: --no-build (reuse built artifacts)  --credentials (re-copy settings/credentials)  --port=N (default 3080)
# env:   DSH_REMOTE_TARGET  DSH_CHECKOUT  DSH_REMOTE_PORT  DSH_REMOTE_ALLOWED_USERS
```

What one run does (idempotent; first-run steps only when missing):

1. Builds the fork (`pnpm run build`, log `/tmp/dsh-deploy-build.log`) and the
   `dsh-tailscale-remote` client bundle.
2. Installs the deployer's exact Node version into `~/.local/node` on the host
   (nodejs.org tarball, no sudo). Ensures Homebrew rsync.
3. rsyncs the built checkout (+`node_modules`, minus `.git website snapshots
   python .agents coverage .turbo`) to `~/dsh/checkout/`; the four plugins to
   `~/dsh/plugins/`; the `minimal-no-tools` preset to `~/.dsh/.agent-presets/`.
   First transfer: ~1.7 GB / 81k files (~70 s on LAN); later ones seconds.
4. Copies `~/.dsh/.credentials.yaml` and `~/.dsh/settings.yaml` from the
   deployer **if the host has none** (or with `--credentials`). Your cloud API
   keys therefore land on the remote — intended, since its agents run there.
5. Writes `~/.dsh/deploy/remote.cordis.yml` (tailscale-remote with
   `publishPort: 0`, slug-style `session-title-llm`, session-title-slug,
   enforce-model-preset `apple → minimal-no-tools`, local-model-supervisor
   for `afm --port 9997`), creates `~/.dsh/tailscale-remote.json` with a fresh
   standing token and your tailnet login allowlisted (kept on later runs), and
   (re)writes + restarts the LaunchAgent. Waits for HTTP 401 on `:3080`.
6. If `xcrun --find swiftc` works: logs in on the host with the launch token
   from `~/dsh/logs/dsh.log`, calls the plugin's control channel to add the
   **host's own tailnet login** to the allowlist and `install-dock-app` →
   `~/Applications/DSH.app` built, pinned to the Dock and launched.
7. Prints `remote GUI: https://alpha.tailbce956.ts.net/dsh/`, the token link,
   `tailscale serve status`, and probes the URL from your Mac (200/303 = you are
   admitted by identity; 401 = use the token link or fix the allowlist).

Then on the deploying Mac's GUI: Remotes section → **add remote workspace** →
paste the URL (identity mode, no token needed) → pick a directory on the
remote (e.g. `~/projects/scratch`, create it first over ssh).

Day-to-day:

```sh
pnpm remote-status [user@host]      # launchd state, HTTP 401 check, node/checkout version, serve status, log tail
pnpm remote-logs   [user@host]      # tail -f ~/dsh/logs/dsh.log
pnpm remote-restart | pnpm remote-stop
pnpm deploy-remote user@host --no-build     # config-only redeploy (~10 s)
```

Only the launch line reaches `dsh.log` (`ctx.logger` output does not); plugin
diagnostics are file traces where the plugin offers one.

What went wrong on alpha and is now handled by the script (keep in mind when
extending it): openrsync stall (A5); Tailscale CLI under launchd (A2, hence
`zsh -lc`); the plugin's default `publishPort: 3083` expects a relay LaunchAgent
the headless host never had → Serve pointed at a dead port (502) — deploy now
sets `publishPort: 0` so Serve targets the proxy (`:3084`) directly and the
plugin re-points it on every boot; `mkdir` of the plugin's `node_modules`
before syncing `uqr`; `enforce-model-preset` did not fire for sessions on the
*default* model (no `model/selection` event) — fixed in the plugin (`2d63ac9`).

---

## Part C — standalone install (the new Mac is the primary)

This mirrors Tali's Air. Every step is taken from the live config
(`~/.dsh/profiles/web/cordis.patch.yml`, `~/.dsh/settings.yaml`) and the
recipes, but has not been replayed on a blank machine as one sequence.

### C1. Node, pnpm, git, and the fork

```sh
brew install node pnpm git            # Air: node 26.7.0; the repo pins pnpm 11.7.0 via packageManager
                                      # and pnpm ≥ 10 fetches/uses that version itself
mkdir -p ~/github && cd ~/github
git clone git@github.com:taliesinb/deepseek-harness.git
cd deepseek-harness
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git checkout feat/embed-session       # the live branch (Remotes, Move/Rehome, embed); see note
pnpm install
pnpm run build                        # ~100 s
pnpm dsh web --no-open                # first launch initialises ~/.dsh and ~/.dsh/profiles/web/cordis.patch.yml;
                                      # prints http://127.0.0.1:3080/?token=… — open it once, then Ctrl-C
```

> **Branch note (2026-09-18):** `feat/embed-session` exists only in the Air's
> local clone — `origin` has `master` and `fix/tailscale-mounting`. Push it
> (`git push -u origin feat/embed-session`) before a fresh clone can check it
> out. `fix/tailscale-mounting` is the minimum the tailnet path mount needs
> (document-relative URLs); stock `master` loads the remote page's HTML and
> then 404s on everything else.

Node engines: `^22.19.0 || >=24.0.0`. Remove any stale `~/Library/pnpm`
state if `pnpm` and the repo disagree about versions.

### C2. The plugins repo

```sh
cd ~/github && git clone https://github.com/taliesinb/dsh-plugins tali-dash-plugins
cd tali-dash-plugins
```

Since plugins-repo commit `5785d17` (2026-09-18) every plugin's `link:`
dependency is **relative** (`link:../../../deepseek-harness/vendor/cordis`
…), so the only layout requirement is that the two repos are siblings under
one parent directory (`~/github/deepseek-harness` next to
`~/github/tali-dash-plugins`, as above). `browser-automation` and
`wolfram-kernel-supervisor` depend on `@modelcontextprotocol/sdk` / `sharp`
from npm at the checkout's versions instead of linking into its `.pnpm`
store. Nothing to rewrite in `package.json`.

The one remaining absolute-path file is `cordis.dev.yml` (dev overlay; row
`name:` must be an absolute module path — the loader's `!!js` interpolation
applies to `config` only, never `name`). It matters only if you use the
preview/dev overlay; otherwise skip it:

```sh
sed -i '' "s#/Users/tali/github#$HOME/github#g" cordis.dev.yml
```

Install and build (host-only plugins without deps need nothing):

```sh
for p in dsh-tailscale-remote dsh-remote-workspaces foreign-link-opener wolfram-kernel-supervisor \
         browser-automation dash-docsets fs-tools session-introspect; do (cd plugins/$p && pnpm install); done
for p in dsh-tailscale-remote dsh-remote-workspaces session-title-slug settings-shortcut \
         agent-status-indicator foreign-link-opener wolfram-kernel-supervisor; do (cd plugins/$p && pnpm build); done
```

`enforce-model-preset`, `local-model-supervisor`, `preview-identity` are plain
ESM with `node:` imports only. A `dsh.client` package whose `lib/client.js` is
missing fails activation loudly at boot, so build before loading.

### C3. Providers and the on-device preset

Add to `~/.dsh/settings.yaml` under `llm-pi-ai.providers` (the file exists
after C1; cloud providers/keys are added through Settings → Providers in the
GUI and land in `~/.dsh/.credentials.yaml`):

```yaml
llm-pi-ai:
  providers:
    apple:
      displayName: Apple Foundation
      api: openai-completions
      baseURL: http://127.0.0.1:9997/v1
      headers:
        Authorization: Bearer x          # afm needs no key; pi-ai insists on one
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: foundation
          name: Apple Foundation (on-device)
          contextWindow: 16384           # deliberate over-claim (pi-ai's 4096 reserve); real window 4096
          maxTokens: 1024
```

Create the user preset the Apple rule switches sessions to:

```sh
mkdir -p ~/.dsh/.agent-presets/minimal-no-tools
cat > ~/.dsh/.agent-presets/minimal-no-tools/preset.yml <<'EOF'
name: Minimal (no tools)
description: Chat-only composition for tiny local models — a one-line persona, no tools, no runtime context. Pairs with small context windows (e.g. Apple Foundation on-device).
order: 4
EOF
cat > ~/.dsh/.agent-presets/minimal-no-tools/agent.cordis.yml <<'EOF'
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful, concise assistant.
    complete: true
    includeRuntimeContext: false
EOF
```

### C4. The web profile patch

`~/.dsh/profiles/web/cordis.patch.yml` is `patchReload: live` — saving it
reloads the running server. Minimal set (replace `/Users/tali` with the real
home; `name:` must be absolute):

```yaml
- insert:
    - id: tali-tailscale-remote
      name: '/Users/tali/github/tali-dash-plugins/plugins/dsh-tailscale-remote/index.js'
      config:
        listenPort: 3084
        publishPort: 3083                       # the relay (C5); 0 = publish the proxy directly, no relay
        relayCwd: /Users/tali/github/deepseek-harness
        relayStart: pnpm dsh web --no-open
    - id: tali-enforce-model-preset
      name: '/Users/tali/github/tali-dash-plugins/plugins/enforce-model-preset/index.js'
      config:
        rules:
          - provider: apple
            preset: minimal-no-tools
          - provider: lmstudio
            preset: minimal
          - provider: '*'
            preset: standard
    - id: tali-local-model-supervisor
      name: '/Users/tali/github/tali-dash-plugins/plugins/local-model-supervisor/index.js'
      config:
        servers:
          - id: afm
            providers: [apple]
            command: afm
            args: ['--port', '9997']
            healthUrl: http://127.0.0.1:9997/v1/models
            idleMinutes: 15
            startupTimeoutMs: 90000
            logFile: /tmp/local-model-supervisor-afm.log
    - id: tali-session-title-slug
      name: '/Users/tali/github/tali-dash-plugins/plugins/session-title-slug/index.js'
    - id: tali-fs-tools
      name: '/Users/tali/github/tali-dash-plugins/plugins/fs-tools/index.js'
    - id: tali-session-introspect
      name: '/Users/tali/github/tali-dash-plugins/plugins/session-introspect/index.js'
      config: { scope: all }
    - id: tali-settings-shortcut
      name: '/Users/tali/github/tali-dash-plugins/plugins/settings-shortcut/index.js'
    - id: tali-remote-workspaces                  # the "Remotes" section (only on a controlling Mac)
      name: '/Users/tali/github/tali-dash-plugins/plugins/dsh-remote-workspaces/index.js'
- id: session-title-llm
  config:                                        # replaces the bundle row's config wholesale
    targetWords: 5
    targetCjkCharacters: 10
    maxInputBytes: 4096
    maxOutputTokens: 64
    timeoutMs: 60000
    style: slug
```

Optional rows, each gated on A6: `tali-browser-automation`, `tali-dash-docsets`,
`tali-wolfram-kernel-supervisor`, `tali-notion-mcp`, `tali-foreign-link-opener`
(only meaningful for a Safari "Add to Dock" web app, which the WKWebView app
replaces). Copy their blocks verbatim from the Air's file. Verify the
composition without booting:
`pnpm dsh --profile web --dump-config | grep -n tali-`.

### C5. Relay LaunchAgent, enable the route, build the Dock app

```sh
cd ~/github/tali-dash-plugins/plugins/dsh-tailscale-remote
pnpm relay:install --cwd ~/github/deepseek-harness --start "pnpm dsh web --no-open"
#  → ~/Library/LaunchAgents/io.github.taliesinb.dsh-web-relay.plist, listens :3083, relays to :3084,
#    starts `dsh web` (through zsh -lc) when it is down. Logs: ~/.dsh/logs/{relay,dsh-web}.log
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/     # 503 splash → DSH starts (~3 s) → 401
grep -o 'http://127.0.0.1:3080/?token=[^ ]*' ~/.dsh/logs/dsh-web.log | tail -1   # open this in Safari
```

In the GUI: Settings → **Tailscale remote** → **Enable** (publishes
`tailscale serve --bg --yes --https=443 --set-path /dsh http://127.0.0.1:3083`,
state to `~/.dsh/tailscale-remote.json`). Then either press **Install Dock
app** in the *This Mac* group, or:

```sh
pnpm dock-app:install --name DSH --fallback http://127.0.0.1:3083/
pnpm dock-app:status   # and: pnpm relay:status
```

The Dock app is admitted by the node's own login implicitly — no allowlist
entry needed for the Mac itself. Add other people's logins under *Allowed
Tailscale users*, or hand them the QR (carries the standing token).

Restart everything after host-side plugin edits:
`launchctl kickstart -k gui/$UID/io.github.taliesinb.dsh-web-relay`.

---

## Verification checklist

```sh
# server up (401 = auth wall, i.e. alive)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
# route published
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status        # https://<host>.<tailnet>.ts.net (tailnet only) |-- /dsh proxy http://127.0.0.1:3084 (or :3083 with a relay)
# admitted by identity from this Mac (200/303), anonymous from elsewhere (401)
curl -s -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/dsh/
# Dock app present, running, pinned
ls ~/Applications/DSH.app/Contents/MacOS/DSH; cat ~/Applications/DSH.app/Contents/Resources/dsh-dock-app.json
pgrep -fl 'Applications/DSH.app'; defaults read com.apple.dock persistent-apps | grep -c DSH.app
# Apple model: pick "Apple Foundation (on-device)" in a NEW session → chip must read "Minimal (no tools)";
# a one-line prompt answers in ~1 s and afm appears:
pgrep -fl 'afm --port 9997'
```

## Troubleshooting (consolidated from the alpha work)

| Symptom | Cause / fix |
|---|---|
| Deploy hangs at "syncing the checkout", nothing arrives | Apple openrsync on the host — `brew install rsync` there (script does it if brew is reachable via `zsh -lc`) |
| `cannot ssh to … (key auth required)` | A3: Remote Login off or key not installed |
| `host is Darwin x86_64, local is Darwin arm64` | Path B ships `node_modules`; same platform/arch only |
| Deploy fine, `tailscale serve status` empty, no `/dsh` | Tailscale CLI run from bare launchd; the plist must exec via `/bin/zsh -lc` (current script does) |
| Tailnet URL 502 | Serve targets a port nobody listens on (a relay that is not installed) — `publishPort: 0` on a headless host, or install the relay (C5) |
| Tailnet URL times out from another Mac, LAN works | Tailnet ACL: different Tailscale users; same-user login, ACL rule, or tag (loses identity headers) |
| Tailnet URL 401 for you | your login not allowlisted and not the node's own; use the token link or `DSH_REMOTE_ALLOWED_USERS` / Settings → Allowed users |
| First HTTPS request `000` right after enabling | cert issuance for the new MagicDNS name; retry in a few seconds |
| `Dock app: skipped (no Swift toolchain)` | A1 |
| `swiftc … unable to load standard library` | must be `xcrun swiftc` (plugin does; don't call the CLT binary directly) |
| Apple model: `Apple Intelligence is not enabled` | A4 step 1 |
| Apple model never answers / picker lacks it | afm not installed (A4) or `apple` provider missing from `settings.yaml`; check `pgrep -fl afm` and `~/dsh/logs/afm.log` (deploy) / `/tmp/local-model-supervisor-afm.log` (standalone) |
| Apple model replies cut at 1 token | `contextWindow: 16384` + `maxTokens: 1024` missing (pi-ai's 4096 reserve) |
| Apple session shows "Standard mode", huge prompt, errors | preset rule not applied: `minimal-no-tools` preset files missing, or an `enforce-model-preset` older than `2d63ac9` (default-model sessions fire no `model/selection`) |
| Remote page HTML loads, then 404s on `/api`, `/plugins` | DSH not on `fix/tailscale-mounting` / `feat/embed-session` |
| Two DSH tiles in the Dock | Dock plist `<data>` parsing trap; drag one off |
| `resume failed … SessionAlreadyOwnedError` | two servers on one `$DSH_HOME` — never share a home between instances |
| Plugin prints nothing, no error | `inject` names an unavailable service → PENDING; or a `dsh.client` package with no built `lib/client.js` (build it) |
| `pnpm install` in a plugin fails on `link:` | the plugins repo is not a sibling of `deepseek-harness` under one parent directory (links are `../../../deepseek-harness/…`) |

## Uninstall / rollback

Path B host: `launchctl bootout gui/$(id -u)/ai.symbolica.dsh-remote; rm ~/Library/LaunchAgents/ai.symbolica.dsh-remote.plist;
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 --set-path /dsh off; rm -rf ~/dsh ~/.local/node ~/Applications/DSH.app`
(keep or delete `~/.dsh` — sessions live there).

Path C: `cd ~/github/tali-dash-plugins/plugins/dsh-tailscale-remote && pnpm dock-app:uninstall --name DSH && pnpm relay:uninstall`,
then `tailscale serve --https=443 --set-path /dsh off` and drop the rows from the profile patch.

## Sources

- `~/github/tali-dash-plugins/tools/deploy-remote.sh`, `tools/remote-ctl.sh`
- `~/github/tali-dash-plugins/plugins/dsh-tailscale-remote/README.md`
- recipes: `dock-app-via-tailnet.md`, `tailscale-remote-plugin.md`,
  `apple-foundation-model-provider.md`, `browser-automation-plugin.md`,
  `remote-workspaces-plugin.md`; `AGENTS.md`, `PREVIEWING.md`
- transcripts: `deepseek-harness/hybrid-local-remote` T15–T17 (first deploy,
  openrsync, launchd/Tailscale), T39–T40 (tailnet deploy, `publishPort: 0`),
  T42 (Dock app on alpha), T43 (afm + preset fix); `laptop/alpha-setup`
  (hostname rename, ACL diagnosis, ssh key)
- `apps/desktop/README.md` (why the Electron shell is out of scope)
