# Copilot Cloud Agent Instructions for NanoClaw

This is **NanoClaw** (package name: `nanoclaw`) — a personal Claude assistant that orchestrates per-session agent containers. Read this file fully before making any changes.

---

## Architecture in One Sentence

The host is a single Node.js process; when a chat message arrives it writes to an SQLite `inbound.db`, wakes a Docker container, which reads the DB, calls Claude, and writes replies to `outbound.db`, which the host polls and delivers back through the originating channel adapter.

---

## Runtime Split — Two Separate Codebases

There are **two distinct package trees** in this repo. They use different runtimes and lockfiles and must never be mixed:

| Area | Location | Runtime | Package manager | Lockfile |
|------|----------|---------|----------------|---------|
| **Host** | `src/` | Node.js 22 | pnpm | `pnpm-lock.yaml` |
| **Agent-runner** | `container/agent-runner/src/` | Bun 1.3.12 | bun | `container/agent-runner/bun.lock` |

- Do **not** run `pnpm install` inside `container/agent-runner/` — it is not a pnpm workspace.
- Do **not** run `bun install` at the repo root — the host uses pnpm.

---

## Build & Test Commands

### Host (run from repo root)

```bash
pnpm install --frozen-lockfile   # install host deps (CI/automation always uses --frozen-lockfile)
pnpm run build                   # compile host TypeScript → dist/
pnpm exec tsc --noEmit           # typecheck host (no emit)
pnpm run lint                    # ESLint on src/ only
pnpm run format:check            # Prettier check
pnpm run format:fix              # Prettier autofix
pnpm test                        # vitest run (host tests: src/**/*.test.ts, setup/**/*.test.ts)
pnpm run dev                     # host with tsx hot-reload (development)
```

### Agent-runner (run from `container/agent-runner/`)

```bash
bun install --frozen-lockfile    # install agent-runner deps
bun test                         # container tests (bun:test)
bun run typecheck                # tsc --noEmit (separate tsconfig)
```

Or from the repo root:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

### Container image

```bash
./container/build.sh             # build nanoclaw-agent-v2-<slug>:latest Docker image
```

The image tag includes an install slug (SHA1 of project root). Source is never baked in — `container/agent-runner/src/` is mounted read-only at runtime.

---

## CI Pipeline

The CI workflow (`.github/workflows/ci.yml`) runs on every PR to `main`:

1. `pnpm install --frozen-lockfile`
2. `bun install --frozen-lockfile` (agent-runner)
3. `pnpm run format:check`
4. `pnpm exec tsc --noEmit` (host typecheck)
5. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (container typecheck)
6. `pnpm exec vitest run` (host tests)
7. `bun test` (container tests)

All steps must pass before merging.

---

## Code Style & Linting

- **Formatter:** Prettier — `singleQuote: true`, `printWidth: 120`
- **Linter:** ESLint scoped to `src/**/*.{js,ts}` only (container/ and groups/ are excluded)
- **TypeScript:** `strict: true`, `target: ES2022`, `module: NodeNext`
- **Unused vars:** prefixed with `_` to suppress the lint error (e.g. `_unused`)
- **Caught errors:** must be named (not bare `catch {}`); the `no-catch-all` plugin warns on `catch (e: unknown)`
- Run `pnpm run lint` and `pnpm run format:check` before submitting any PR

---

## Key Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: DB init, migrations, channel adapters, delivery poll, sweep, shutdown |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → `inbound.db` → wake |
| `src/delivery.ts` | Polls `outbound.db`, delivers via adapter, handles system actions |
| `src/host-sweep.ts` | 60s sweep: stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens `inbound.db` / `outbound.db`; heartbeat path |
| `src/container-runner.ts` | Spawns Docker containers with session DB mounts, OneCLI `ensureAgent` |
| `src/container-runtime.ts` | Runtime selection (Docker vs Apple containers), orphan cleanup |
| `src/install-slug.ts` | Per-checkout slug (SHA1 of project root) used for service/image naming |
| `src/db/` | Host DB layer — agent_groups, messaging_groups, sessions, user_roles, migrations |
| `src/channels/` | Channel adapter infra + Chat SDK bridge (specific adapters installed via skills) |
| `src/modules/permissions/access.ts` | `canAccessAgentGroup` — owner/admin/member access resolution |
| `src/modules/approvals/primitive.ts` | `pickApprover`, `requestApproval`, approval-handler registry |
| `src/command-gate.ts` | Router-side admin command gate (queries `user_roles` directly) |
| `container/agent-runner/src/index.ts` | Container poll loop entry point |
| `container/agent-runner/src/poll-loop.ts` | Container poll loop: read `inbound.db`, call Claude, write `outbound.db` |

---

## Database Architecture

### Central DB (`data/v2.db`)

Holds all non-session state: `users`, `user_roles`, `agent_groups`, `messaging_groups`, `messaging_group_agents`, `agent_group_members`, `user_dms`, `pending_approvals`, `chat_sdk_*`, `schema_version`.

- Uses `better-sqlite3` on the host, WAL journal mode, foreign keys ON
- Migrations in `src/db/migrations/` — numbered sequentially (e.g. `001-initial.ts`)

### Per-Session DBs (`data/v2-sessions/<session_id>/`)

Each session has exactly **two** SQLite files — one writer per file to avoid lock contention:

| File | Writer | Reader | Contents |
|------|--------|--------|----------|
| `inbound.db` | Host | Container | `messages_in`, routing, destinations, `pending_questions`, `processing_ack` |
| `outbound.db` | Container | Host | `messages_out`, `session_state` |

- Container uses `journal_mode=DELETE` — **load-bearing** for cross-mount visibility. Do not change this without reading the comment block in `container/agent-runner/src/db/connection.ts`.
- Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB write.
- Host uses **even** `seq` numbers; container uses **odd**.

### SQLite Named Params (Container Only)

`bun:sqlite` does **not** strip the `$` prefix from named params. Always use `$name` in both SQL and the JS object:

```ts
stmt.run({ $id: msg.id });  // correct in container
stmt.run({ id: msg.id });   // correct on host (better-sqlite3 strips the prefix)
```

---

## Entity Model

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)       — owner | admin (global or scoped)
agent_group_members (user_id, agent_group_id)    — unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id)

agent_groups ↔ messaging_groups  (via messaging_group_agents: session_mode, trigger_rules, priority)
sessions (agent_group_id + messaging_group_id + thread_id → container)
```

Privilege is user-level (roles in `user_roles`), not agent-group-level. No env-var-based admin lists — always query the DB.

---

## Supply Chain Security (pnpm)

`pnpm-workspace.yaml` enforces `minimumReleaseAge: 4320` (3 days). New npm versions must be at least 3 days old before pnpm resolves them.

**Do not bypass without explicit human approval:**
- Never add entries to `minimumReleaseAgeExclude` — if required, the human must approve and the entry must pin an exact version (`package@x.y.z`, not a range).
- Never add packages to `onlyBuiltDependencies` — build scripts execute arbitrary code.
- Always use `pnpm install --frozen-lockfile` in CI and automation.

---

## Skills

Skills are markdown files (with optional supporting files) in `.agents/skills/<name>/`. There are four types:

1. **Feature skills** — install a channel/integration by fetching a `skill/*` git branch (e.g. `/add-telegram`, `/add-slack`).
2. **Utility skills** — standalone tools with code files in the skill directory (e.g. `/claw`).
3. **Operational skills** — instruction-only workflows, no code changes (e.g. `/setup`, `/debug`).
4. **Container skills** — loaded inside agent containers at runtime (`container/skills/`).

**SKILL.md rules:** under 500 lines, `name` lowercase alphanumeric+hyphens max 64 chars, `description` required, code in separate files (not inline).

---

## Channel Adapters and Providers

Trunk ships no specific channel adapter or non-default agent provider. They live on long-lived sibling branches:

- **`channels` branch** — Discord, Slack, Telegram, WhatsApp, Teams, Linear, GitHub, iMessage, Webex, etc.
- **`providers` branch** — OpenCode and other non-default providers.

Install via the corresponding skill (e.g. `/add-discord`). Each skill is idempotent: fetch branch → copy files → wire import barrel → `pnpm install <pkg>@<pinned>` → build.

---

## Install Slug

Two NanoClaw installs on one host coexist via a slug: `sha1(projectRoot)[:8]`.

- `src/install-slug.ts` — TypeScript implementation
- `setup/lib/install-slug.sh` — shell mirror that **must** produce identical slug/prefix output

Used for launchd labels (`com.nanoclaw-v2-<slug>`), systemd units (`nanoclaw-v2-<slug>`), and Docker image names (`nanoclaw-agent-v2-<slug>:latest`).

---

## Container Image Gotchas

- Source (`container/agent-runner/src/`) is **never baked in** — it's a read-only bind mount at runtime. Source-only changes never require an image rebuild.
- `--no-cache` alone does **not** invalidate COPY steps due to buildkit volume caching. To force a truly clean rebuild: prune the builder, then re-run `./container/build.sh`.
- Keep entrypoint as `exec bun ...` so signals forward cleanly to Bun (no intermediate shell).
- The image has no `/app/dist` — do not add a tsc build step.
- Global Node CLIs (claude-code, agent-browser, vercel) are installed via pnpm in the Dockerfile, pinned to exact versions via ARG. Use `bun install -g` only for Bun-native tools, not for Node CLIs.

---

## Accepted Code Changes

Per `CONTRIBUTING.md`: **only** bug fixes, security fixes, simplifications, and code reduction are accepted as source changes. Features and new capabilities should be implemented as **skills**.

Each PR must do exactly one thing. Check the PR template at `.github/PULL_REQUEST_TEMPLATE.md`.

---

## Errors & Workarounds Log

*(Document errors encountered and their workarounds here as they are discovered.)*
