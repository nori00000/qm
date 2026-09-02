# Fly sandbox

Per-scope **Fly Sprites** microVMs as the agent sandbox. `createSpritesSandbox`
(`src/sandbox/sprites-sandbox.ts`) drives sprites over the `@fly/sprites` SDK — this
replaced the earlier hand-rolled Fly Machines API client (`FlySandbox`); that class and
`src/sandbox/fly-sandbox.ts` no longer exist. The backend is selected as `SANDBOX_BACKEND=sprites`,
one of the three names in `SandboxBackendName` (`src/sandbox/sandbox-routing.ts`):
`"sprites" | "aws" | "local"`.

A Sprite's disk **persists** for the life of the sprite, so installed packages / venv /
build state stay warm — a private "laptop" per scope, in the same spirit as the old
Fly Machines design. The read-only mount layers (org/team/granted scopes) are
materialized into the sprite each turn via `materializeRoLayers`; the writable layer
lives on the sprite's own disk.

## When to use which sandbox

- **local** (default in most dev setups) — `src/sandbox/local-sandbox.ts` runs a
  **Docker container** (`docker run`, image built by `npm run sandbox:local:build`,
  default `qm-sandbox-local:latest`) via `docker-exec.ts`. Despite the name, this is
  container-isolated, not a bare host `child_process`.
- **sprites** — this backend. Persistent Fly Sprite microVM, warm state. Egress is
  **open** unless `SPRITES_EGRESS_PROXY_URL` is set, in which case egress is enforced
  per-domain; core logs a fail-open warning at startup if `SANDBOX_BACKEND=sprites`
  and the proxy URL is unset.
- **aws** — Lambda MicroVM sandboxes (`src/sandbox/aws-sandbox.ts`), the other
  isolated, persistent-disk option; selected instead of sprites when
  `sandbox.backend: "aws"` in the deployment config.

## Agent Computer profile

The sprites backend's `AgentComputerProfile` (`src/sandbox/sprites-sandbox.ts`):

- `backend: "sprites"`
- `writablePersistence: "resident_disk"`
- `processSessions: true`
- `egressEnforcement: "domain"` when `SPRITES_EGRESS_PROXY_URL` is configured, else `"none"`
- `os`: `"Ubuntu 26.04 LTS — Fly Sprite microVM (auto-sleeps when idle; the whole disk persists)"`
- `runtimes`: Node 24, Python 3
- baked tools: `git`, `curl`, `jq`, `tar`, `python3`, plus any deployment-layer `extraTools`
- reported as **not installed** (visible to the agent, installable residently): `gh`, `aws`,
  `gcloud`, `kubectl`, `flyctl`, `glab` — unless a deployment adds them to `extraTools`
- `diskGb: 100`, `homeDir: /home/sprite`, `workdir: /home/sprite/workspace`

<!-- DOC-SYNC: UNVERIFIED — whether/how durable `$HOME` volumes, auto-image-upgrade
(`FlySandbox.ensureMachine` image-digest comparison), and the `FLY_RESIDENT_ENV_*` /
`ephemeralCredLinkScript` resident-credential wiring carry over unchanged from the old
Fly Machines design to Sprites was not traced to source for this pass — the sprite
lifecycle (`ensureSprite`/`ensureScratch` in sprites-sandbox.ts) creates/deletes sprites
by name but does not expose an explicit "image upgrade, keep the volume" path in the code
read here. Confirm from `sprites-sandbox.ts` + `wiring.ts` before restating those claims. -->

## Backup exclusions

Backup/restore is shared logic across sandbox backends (`src/sandbox/exec-file-ops.ts`,
`createExecBackup`), not sprites-specific. It excludes `.aws/*` (so a stale AWS
credential cache cannot shadow the platform role after restore) and reproducible/noisy
runtime caches (`__pycache__`, `.cache`). Export/import is batched as one tar stream per
area (`workspace`, `home`) rather than one exec per file. The backup is durable by
default: written to S3 when `SNAPSHOT_STORE=s3` is configured, otherwise to the core's
local persistent volume (`$DATA_DIR/blobs`) — never left un-persisted, since for a
resident-disk backend (sprites, aws) it is the only durable record of agent files
outside the sandbox itself.

## Turn env

Sprites drops host-proxy routing env (`DROPPED_PROXY_ENV`, e.g. `http_proxy`,
`HTTPS_PROXY`) from the turn env and, only when an egress token is present and
`SPRITES_EGRESS_PROXY_URL` is configured, injects proxy env pointing at that URL
(`spritesProxyEnv`). Otherwise turn env passes through as provisioned.

## Egress

Dangerous posture permits direct outbound network access. Auto is meant to force
traffic through an audited proxy; on this backend that only happens when
`SPRITES_EGRESS_PROXY_URL` is set (see the startup warning above) — set it before
relying on Auto's egress screening on sprites. Strict does not provision a sandbox.

## Build & publish the sandbox base image

```bash
brew install flyctl
fly auth login
export FLY_SANDBOX_APP_NAME=<operator-owned-sandbox-app>
fly apps create "$FLY_SANDBOX_APP_NAME" --org <fly-org>
npm run deploy:fly-image
```

`npm run deploy:fly-image` (`package.json`) is
`flyctl deploy --remote-only --build-only --push ... --app "$FLY_SANDBOX_APP_NAME" -c fly/fly.toml --dockerfile fly/Dockerfile . --yes`
— it still requires `FLY_SANDBOX_APP_NAME`, builds on Fly's remote amd64 builder (works
unchanged from arm64/Apple Silicon hosts), and is exec-only (bare `fly deploy` would
create default launch machines that sprites don't use).

For an operator deployment managed through the `qm` CLI (`cli/README.md`), the
equivalent path is `qm sandbox build` (local validation build) and `qm sandbox publish`
(pushes through the configured OCI registry, records the image/base digest pin in the
deployment config, and repoints a running Fly or AWS core). `qm sandbox publish` on AWS
requires `sandbox.backend: "sprites"` explicitly; on a `fly`-target deployment, sprites
is the default sandbox backend.

The base image keeps a minimal generic toolset (coding-agent CLIs, AWS CLI v2; the
optional agentic browser engine is build-gated in `fly/Dockerfile`). Deployment-specific
tools are NOT baked here — a deployment stacks them on top via its sandbox layer
(`qm sandbox build` over `<deploy dir>/sandbox/`).

## Configure the core

Env vars actually read by `src/config.ts` for this backend (`spritesSandboxEnv`):

- `SANDBOX_BACKEND=sprites` — selects this backend.
- `SPRITES_TOKEN` — **required** when `SANDBOX_BACKEND=sprites`
  (`createSpritesSandbox` throws without it).
- `SPRITES_BASE_URL` — defaults to `https://api.sprites.dev`.
- `SPRITES_NAME_PREFIX` — defaults to `qm`; sprite names are
  `<prefix>-<scope-id-slug>-<hash>`.
- `SPRITES_EGRESS_PROXY_URL` — the audited egress proxy; strongly recommended (see
  Egress above), not required.
- `SANDBOX_TIMEOUT_SEC` — shared default exec timeout (also read by the `local` and
  `aws` backends); sprites' own in-code default is 600s if unset.

`FLY_SANDBOX_APP_NAME`, `FLY_API_TOKEN`, `FLY_BASE_IMAGE`, `FLY_VOLUME_GB`,
`FLY_CPU_KIND`, `FLY_CPUS`, `FLY_MEMORY_MB`, `FLY_AUTO_SUSPEND`, `FLY_REGION`, and
`FLY_RESIDENT_ENV_*` are **not read by `src/config.ts`** — none of them appear in the
core runtime source. `FLY_SANDBOX_APP_NAME` / `FLY_BASE_IMAGE` are still meaningful at
the CLI/deployment-config layer (`cli/src/config.ts`'s `sandboxCoreEnv`, driven by
`sandbox.app` / `sandbox.image`) and do get injected into a CLI-deployed core's env, but
the core process itself does not consume them by name. `FLY_APP_NAME` is read by
`src/config.ts`, but it is Fly's own runtime-injected app name for the **core's**
deployment (used for post-deploy health checks in `src/deployment/postdeploy-smoke.ts`),
unrelated to the sandbox.

**Per-command execute timeout.** Each `execute` command has a wall-clock cap (exit 124 on
kill), independent of the sandbox backend. The agent sets it per command via the tool's
`timeout_seconds` param; if it doesn't, the command falls to the configured default.
Knobs (orchestrator → tool context): `EXEC_TIMEOUT_DEFAULT_SEC` (120) and
`EXEC_TIMEOUT_MAX_SEC` (300, the hard ceiling `timeout_seconds` is clamped to).
Resolution order: agent param > default > sandbox backstop (`SANDBOX_TIMEOUT_SEC`).

## Smoke test

```bash
SANDBOX_BACKEND=sprites SPRITES_TOKEN=... npm run smoke:git-cli
```

`scripts/git-cli-smoke.ts` is backend-agnostic (it runs a real `execute` turn against
whichever `SANDBOX_BACKEND` is configured), but it has sprites-aware teardown: when
`GIT_CLI_SMOKE_DESTROY=1` (the default unless `GIT_CLI_SMOKE_ACTOR_ID` is set) and
`SPRITES_TOKEN` is set, it deletes the smoke sprite via `SpritesClient` after the run.
It verifies `git` and `gh` are on PATH in the sandbox and reports whether `glab` is
available, then runs `gh auth status` (and `glab auth status` if applicable) and
reports a sanitized status (`ok`, `auth_missing`, `host_unreachable`, or `auth_error`)
without printing command output. Add `GIT_CLI_SMOKE_REQUIRE_GLAB=1` when GitLab is
meant to be supported by the current image, `GIT_CLI_SMOKE_REQUIRE_GH_AUTH=1` after
running `gh auth login` on the resident computer, or `GIT_CLI_SMOKE_REQUIRE_GLAB_AUTH=1`
after `glab auth login`. Set `GIT_CLI_SMOKE_ACTOR_ID=<real actor>` to target an existing
resident computer instead of a synthetic, auto-destroyed one.

<!-- DOC-SYNC: 2026-08-14 — no fly/sprites-*specific* smoke script beyond
`smoke:git-cli` currently ships. `package.json` has `smoke:aws-sandbox` and
`smoke:local-sandbox` but no `smoke:fly`, `smoke:sprites`, or `smoke:x`; the pre-sprites
version of this section additionally documented a dedicated `npm run smoke:fly`
(full backup/restore round-trip) and `npm run smoke:x` (X-tooling readiness), neither
of which exist as scripts today. Left undocumented rather than inventing a procedure —
write `scripts/*-smoke.ts` analogous to the existing backends' smoke scripts if this
gap needs closing. -->
