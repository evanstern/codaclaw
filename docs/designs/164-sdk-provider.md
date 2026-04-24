# Design: #164 — SDK Provider / Agent-Runner

**Status:** draft
**Author:** Kit
**Card:** #164 (p1, backlog)
**Scope:** `container/agent-runner/` only. No host-side changes. No A2A changes.

---

## TL;DR

The SDK provider already exists. `container/agent-runner/src/providers/claude.ts`
is a 336-line wrapper around `@anthropic-ai/claude-agent-sdk` that does
streamed querying, session resume, MCP passthrough, hooks, and env
injection. It was inherited from NanoClaw and it already satisfies most
of the card's Done-when criteria.

This design proposes we **audit and minimally re-fit** the existing
provider for CodaClaw rather than rewrite it. The deltas are cosmetic
and configuration — not architectural.

---

## What already works

Against the card's "Done when" checklist:

| Requirement                                                  | State         | Where                                                   |
| ------------------------------------------------------------ | ------------- | ------------------------------------------------------- |
| SDK provider polls inbound.db, responds via Claude Agent SDK | ✅            | `poll-loop.ts` + `providers/claude.ts`                  |
| Credentials injected via env, routed through CLIProxyAPI     | ✅            | `ClaudeProvider.env` passthrough                        |
| AGENTS.md loaded as system prompt                            | ✅ (implicit) | `cwd: /workspace/agent` + `settingSources: ['project']` |
| MCP tools accessible to the SDK session                      | ✅            | `options.mcpServers` + allowlist `mcp__nanoclaw__*`     |
| Existing agent-runner tests pass or are updated              | ⚠️ unverified | `bun test` in `container/agent-runner/`                 |
| Container builds and runs with `./container/build.sh`        | ⚠️ unverified | needs validation                                        |

The execution loop is:

```
poll-loop.ts
  getPendingMessages()  →  formatMessages(XML)  →  provider.query({prompt, continuation, cwd, systemContext})
    ClaudeProvider.query
      sdkQuery({ prompt: MessageStream, options: { cwd, resume, mcpServers, hooks, env, systemPrompt, allowedTools }})
        → AsyncIterable<SDKMessage>  →  translated to ProviderEvent  →  poll-loop consumes
  writeMessageOut(outbound.db)
```

The session DB contract (`inbound.db`/`outbound.db` with
`journal_mode=DELETE`) is already the SOLE IO surface. There is no
stdin piping, no stdout markers, no side channels. This is exactly
what v3 wants.

---

## Real gaps (the actual work)

### 1. Container executable path

`providers/claude.ts:274` hardcodes:

```ts
pathToClaudeCodeExecutable: '/pnpm/claude';
```

This matches NanoClaw's container image layout. Need to confirm
CodaClaw's `container/Dockerfile` + `container/build.sh` still
install Claude Code at `/pnpm/claude`, or update this path.

**Action:** audit Dockerfile; if path differs, parameterise via env
(`CLAUDE_CODE_EXECUTABLE`) rather than hardcoding.

### 2. MCP server naming (`nanoclaw` → `codaclaw`?)

`index.ts:77` registers the built-in MCP server under the key
`nanoclaw`. The provider's `TOOL_ALLOWLIST` includes
`mcp__nanoclaw__*` to match.

If we rename the MCP key to `codaclaw`, every tool an agent sees
becomes `mcp__codaclaw__*`. That's a breaking change for anything
that references tool names — skills, allowlists, user-written
AGENTS.md.

**Recommendation:** keep `nanoclaw` for now. It's an internal key,
not user-visible in the product identity. Rename is pure churn
until #165 boot milestone proves the substrate. We can rename in
a follow-up card with a compat shim if desired.

### 3. Tool allowlist has NanoClaw-specific tools

```ts
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete', // NanoClaw sub-team feature
  'SendMessage', // NanoClaw destinations feature
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];
```

`TeamCreate`/`TeamDelete`/`SendMessage` come from NanoClaw's
destinations + sub-team features. In coda v3 those are coda's
concern, not the container's. Leaving them in the allowlist is
harmless (they just won't be wired), but it's noise.

**Recommendation:** leave as-is for #164. Clean up in a follow-up
once the v3 destinations/routing story is defined by Ash (coda
core). We do not yet have the authoritative answer on whether
coda wants the container to send structured messages.

### 4. SDK disallowed tools

```ts
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];
```

These are legitimately wrong for any headless container. Keep
as-is — this list is portable to v3.

### 5. PreCompact transcript archiving writes to `/workspace/agent/conversations/`

`createPreCompactHook` archives compacted transcripts to
`/workspace/agent/conversations/*.md`. This is a useful feature
inherited from NanoClaw. It's orthogonal to v3 and should keep
working as-is.

### 6. Test + build verification

Before declaring #164 done we need:

- `cd container/agent-runner && bun test` → green
- `./container/build.sh` → image builds
- Round-trip: host starts → message delivered → agent responds → outbound.db updated

The round-trip is card #165's milestone. #164 just needs 1 and 2.

---

## Alignment with #165

#164 and #165 are deliberately separated. #164 = the provider
implementation is correct in isolation. #165 = the whole system
actually runs end-to-end. #165 explicitly `Depends on #164`.

The split:

| Check                                                             | Card     |
| ----------------------------------------------------------------- | -------- |
| SDK provider uses `@anthropic-ai/claude-agent-sdk` correctly      | #164     |
| Credentials, MCP wiring, systemPrompt, hooks                      | #164     |
| `bun test` in `container/agent-runner/` green                     | #164     |
| `./container/build.sh` produces an image                          | #164     |
| `/pnpm/claude` _exists inside the built image_ (static check)     | #164     |
| `/pnpm/claude` _actually runs and talks to CLIProxyAPI_ (dynamic) | **#165** |
| Host starts, container spawns, DB round-trip                      | **#165** |
| Clean container teardown                                          | **#165** |

#164 does not attempt the round-trip. If static + build + tests
pass, #164 is done per its own Done-when list. #165 will catch
anything that only surfaces at runtime, and fixes land in the
correct component at that point.

## Proposed PR plan

**One PR, small:**

1. Run `bun test` in `container/agent-runner/`. Fix any breakage.
   Current tests: `formatter.test.ts`, `poll-loop.test.ts`,
   `integration.test.ts`, `timezone.test.ts`,
   `providers/factory.test.ts`.
2. Run `./container/build.sh`. Fix any breakage.
3. Static check: `docker run --rm <image> ls -la /pnpm/claude`
   confirms the Claude Code executable is where `claude.ts:274`
   expects. If not, either fix the Dockerfile or parameterise the
   path via env (`CLAUDE_CODE_EXECUTABLE`, default `/pnpm/claude`).
4. Add a short note to `docs/agent-runner-details.md` confirming
   the v3 contract: "agent-runner polls session DB, calls SDK,
   writes back. No other IO."
5. Update card #164 with the audit findings; mark Done.

**What this PR does NOT do:**

- Invoke `claude` or attempt any network call (that's #165).
- Rename MCP server key (`nanoclaw` stays).
- Clean up tool allowlist (`TeamCreate`, `SendMessage`, etc. stay).
- Change system prompt injection (stays implicit via settingSources).
- Touch host-side code.
- Resolve the "is the destinations addendum meaningful in v3?"
  question — card explicitly keeps A2A/destinations out of scope
  for #164.

Those are separate cards if and when they matter.

---

## Risks / open questions

1. **Does `/pnpm/claude` still exist in the container?** If the
   OneCLI removal work in PR #2 didn't update the install path,
   the runner is already broken and nobody's noticed because no
   one has booted a container since the fork. This is the single
   most likely landmine.

2. **Is `systemContext.instructions` still needed?** The poll
   loop builds a destinations addendum (`buildSystemPromptAddendum`
   in `destinations.ts`) and passes it via `systemContext`. That
   addendum assumes NanoClaw's destinations model. In v3, coda
   is the one deciding routing — the addendum content may be
   empty or wrong.

   **Resolution:** card #164 explicitly keeps A2A/destinations
   out of scope. Leave as-is. Revisit when Ash defines the v3
   routing contract.

3. **Is anything still called `nanoclaw` in user-visible output?**
   Log prefixes (`[claude-provider]`, `[poll-loop]`) — fine.
   `log('Starting v2 agent-runner (provider: …)')` in `index.ts:46`
   — fine, "v2" refers to the runner, not NanoClaw. The `nanoclaw`
   MCP key is the main offender; see §2.

---

## Out of scope (but noted for future cards)

- **Destinations / `<message to="name">` dispatch** in `poll-loop.ts`.
  NanoClaw-specific. coda v3 uses a different routing model. Needs
  Ash's input.
- **Ignored-message policy / accumulate gate**. NanoClaw feature.
  coda may or may not want it.
- **Scheduling module pre-task scripts** (`MODULE-HOOK:scheduling-pre-task`).
  NanoClaw-specific. Separate card.
- **Sub-team (`Task`/`TaskOutput`/`TeamCreate`)**. NanoClaw feature.
  v3 may replace with coda's own session spawning.

---

## Decisions (confirmed with user 2026-04-25)

- ✅ Minimal-audit approach (vs. full v3-ification).
- ✅ AGENTS.md implicit auto-load is sufficient.
- ✅ Keep `nanoclaw` MCP key for now.
- ✅ Do not block on destinations addendum's v3 meaning — card
  keeps it out of scope.
- ✅ Round-trip validation belongs to #165, not #164.
