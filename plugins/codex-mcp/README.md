# codex-mcp — Claude Code plugin

Runs OpenAI Codex from Claude Code. One connection installs three parts that
work together:

- the **`codex-mcp` MCP server**, pinned to `@kvokka/codex-mcp@2.3.0`;
- the **`codex` subagent**, which carries a prompt to Codex, drives the turn to
  a terminal status and hands back what Codex answered;
- a **`PreToolUse` hook**, which lets the Codex tools through for that subagent
  and denies them to everyone else.

## Install

```text
/plugin marketplace add kvokka/codex-mcp
/plugin install codex-mcp@codex-mcp
```

To enable it for a whole project without typing the commands, put this in
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "codex-mcp": {
      "source": { "source": "github", "repo": "kvokka/codex-mcp" }
    }
  },
  "enabledPlugins": ["codex-mcp@codex-mcp"]
}
```

The server needs the Codex CLI on `PATH` and an OpenAI login. Where a session
will not start, the subagent runs `codex_setup` and reports what it said.

## Use

Spawn the subagent and hand it the work:

```text
Agent(subagent_type="codex-mcp:codex", prompt="<what Codex should do>")
```

It answers with one block: `status`, `sessionId`, `model`, whether it closed the
session, anything it declined, and Codex's result verbatim.

## Why the hook

The Codex tools belong to the subagent. The head agent that spawns it must not
call them itself — a Codex turn is long, it holds a session, and a head agent
that polls it burns the context the delegation was meant to save.

`permissions.deny` does not express that. A deny rule is inherited by every
subagent the session spawns, so denying `mcp__…codex-mcp__*` in the head agent
denies it in the `codex` subagent too, and kills the one caller that needs it.
Measured, not assumed.

A `PreToolUse` hook draws the line where the deny rule cannot. Claude Code sends
`agent_type` in the hook payload only when the hook fires inside a subagent (or
on the main thread of a `--agent` session), so its absence identifies the head
agent. `hooks/codex-subagent-only.mjs` exits 0 — allow — for `codex-mcp:codex`
and for a bare `codex`, which is what a copy of the agent placed in a project's
own `.claude/agents/` is called. Everything else, unreadable input included,
gets `permissionDecision: deny` and a line telling the caller to spawn the
subagent.

The hook finds itself through `${CLAUDE_PLUGIN_ROOT}`, so it runs from wherever
the plugin is installed.

## Picking work back up after the server went away

A Codex session is driven by one codex-mcp process. When that process goes — the
client quit, `/mcp` reconnected it, the machine rebooted — the turn it was running
is left as `abandoned`: nothing failed, nobody holds the session, and Codex still
carries the thread in its rollout log.

"Continue what was interrupted" runs as two spawns:

1. Spawn the subagent with the question and no `sessionId`. It calls
   `codex_session(action="list")`, keeps the entries carrying no `owner` — those
   are the free ones — and answers with a numbered list, one line each, and
   nothing else:

   ```text
   1. sess_abc123 — Counting the TypeScript files in src — 2026-08-26T11:04:18Z
   2. sess_def456 — Running the test suite — 2026-08-26T09:51:02Z
   ```

2. The user picks a number. Spawn a fresh subagent with that `sessionId` and what
   Codex should do next. It reads the session with `codex_session(action="get")`,
   sees `abandoned`, calls `codex_session(action="resume", sessionId)` — which
   starts a codex process and restores the thread, the cut-off turn included —
   and then continues with `codex_reply`.

The head agent cannot do step 1 itself: the hook denies it the Codex tools, and
that denial is the whole design. The subagent is the only path the list travels
to the person asking, which is why it answers the list alone — no session
started, nothing polled, no context spent.

Two things this cannot do:

- `codex_reply` to an abandoned session that was not resumed answers
  `SESSION_NOT_RUNNING` and names `resume`.
- On a codex CLI with no `app-server` the server runs in `exec` mode, where
  `resume` fails with `THREAD_FORK_RESUME_FAILED` carrying `EXEC_NOT_SUPPORTED`:
  `codex exec` implements no thread resume. The session stays `abandoned`, and
  the work has to be handed to a new session.

## What the pieces are

```text
plugins/codex-mcp/
├── .claude-plugin/plugin.json          the manifest
├── .mcp.json                           the codex-mcp server
├── agents/codex.md                     the subagent
└── hooks/
    ├── hooks.json                      registers the hook on the Codex tools
    └── codex-subagent-only.mjs         allow the subagent, deny the rest
```

The MCP server is pinned to the exact published version rather than `latest`, so
a given plugin release always runs the server it was written against. A release
moves `package.json`, `plugins/codex-mcp/.claude-plugin/plugin.json`, the
marketplace entry in `.claude-plugin/marketplace.json` and the pin in
`.mcp.json` to the same number.
