# codex-mcp — Claude Code plugin

Runs OpenAI Codex from Claude Code. One connection installs three parts that
work together:

- the **`codex-mcp` MCP server**, pinned to `@kvokka/codex-mcp@3.0.3`;
- the **`codex` subagent**, a proxy running on Haiku: it hands the delegator's
  prompt to Codex unchanged, follows the turn in rounds of five minutes, writes
  a `**Progress summary**` line after each of them, and hands back what Codex
  answered;
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

The server needs `bun`, which starts it, the Codex CLI on `PATH`, and an OpenAI
login. Where a session will not start, the subagent runs `codex_setup` and
reports what it said.

A plugin that depends on this one holds it at a range, and every release carries
the `codex-mcp--v<version>` tag that a range resolves against:

```json
{
  "dependencies": [{ "name": "codex-mcp", "marketplace": "codex-mcp", "version": "^3.0" }]
}
```

The marketplace hosting that plugin lists `codex-mcp` under
`allowCrossMarketplaceDependenciesOn`, which is what lets Claude Code install
this one alongside it.

## Use

Spawn the subagent and hand it the work:

```text
Agent(subagent_type="codex-mcp:codex", prompt="<what Codex should do>")
```

Spawn one per task. Two of them started in the same message run at once, each on
its own Codex session, and the head agent carries on with its own work while
they do — which is what the subagent is for: the turn's polling, its approval
answers and its transcript stay out of the head agent's context, and only the
report comes back.

## What the subagent will not do

It is a proxy with no discretion. Whatever the delegator sent goes to Codex as
the prompt, verbatim: `1 + 1`, a line of gibberish, a page of shell commands
with hard instructions, a question it could answer in a second. It writes no
answer of its own, runs no command, reads no file, and rephrases nothing. The
only thing it decides is the cwd.

Its `tools:` frontmatter names the five codex-mcp tools and nothing else, so
reading a file or running a command is not a rule it keeps: it holds no tool
that does either.

How Codex starts is not its to pick either. `.mcp.json` sets five variables the
server reads — `CODEX_MCP_DEFAULT_MODEL`, `CODEX_MCP_DEFAULT_EFFORT`,
`CODEX_MCP_DEFAULT_APPROVAL_TIMEOUT_MS`, `CODEX_MCP_DEFAULT_APPROVAL_POLICY` and
`CODEX_MCP_DEFAULT_SANDBOX` — the server starts every session that names none of
them on those, and the tool description it publishes carries the values in
force. Edit `.mcp.json` to change them; name one in the prompt to change it for
a single turn.

As it ships, that means `never` and `danger-full-access`: Codex asks for nothing
and is stopped by nothing, so a turn runs to its answer rather than to an
approval nobody is watching. Name a `sandbox` and an `approvalPolicy` in the
prompt to fence the turn, and the subagent passes what you named.

An answer written by the subagent is shaped exactly like Codex's own, so the
delegator cannot tell them apart. That is why the rule is absolute rather than a
preference.

## What it writes while the turn runs

One line per round, and nothing else:

```text
**Progress summary**: reading src/session/manager/store.ts
**Progress summary**: running the test suite — 5 min
**Progress summary**: running the test suite — 15 min
```

The number comes from `progress.activityStandingMs`, which the server measures
from when the line arrived, so it is right however the rounds fell. The bold
marker opens every one of those lines and nothing else the subagent writes, so a
delegator scanning its output picks them out by it.

## What comes back

One block, and nothing around it: the `outcome` of the turn, the `sessionId`,
the `model` Codex ran on, whether the `session` is closed, anything it
`declined`, and last the `result` — what Codex answered, verbatim and whole. The
progress lines are not repeated there; the run is over by then.

`outcome` is the turn's, read from `lastTurn` and untouched by the close, so a
finished turn reads `completed` even though the closed session's own status is
`cancelled`. Where the subagent holds no result it writes
`result: unavailable — <what the tools answered>`; it never writes an account of
the work in place of the answer.

## How a turn is followed

`codex` returns as soon as the thread is up — no start blocks for a result — and
the subagent polls with `codex_check(action="poll", waitMs=300000)`. That call
comes back the moment Codex says it is working on something new, an action
arrives, the status changes or the turn ends, and at the end of the five minutes
otherwise, so each round either reports a change or says the same work is still
running.

The server also sends each activity line to the MCP client as
`notifications/progress` while a poll is held, with a heartbeat every 30 seconds
(`CODEX_MCP_PROGRESS_HEARTBEAT_MS`). A client renders those under the call it
made itself, so they are for a client driving the tools directly; under a
subagent's call they reach nobody, which is why the subagent writes the line
itself after every round.

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

`CODEX_MCP_ALLOWED_AGENTS` admits more agent types, comma-separated — an agent
that drives Codex in its own context rather than through this subagent. The hook
runs in the environment of the session that spawned it, so the `env` block of a
Claude Code settings file is where it goes:

```json
{ "env": { "CODEX_MCP_ALLOWED_AGENTS": "my-plugin:researcher, my-plugin:reviewer" } }
```

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

Resume the session before replying to it: `codex_reply` to an abandoned session
answers `SESSION_NOT_RUNNING` and names `resume`.

## What the pieces are

```text
plugins/codex-mcp/
├── .claude-plugin/plugin.json          the manifest
├── .mcp.json                           the codex-mcp server, at its pinned version,
│                                       and the defaults it starts sessions on
├── agents/codex.md                     the subagent
└── hooks/
    ├── hooks.json                      registers the hook on the Codex tools
    └── codex-subagent-only.mjs         allow the subagent, deny the rest
```

The MCP server is pinned to the exact published version rather than `latest`, so
a given plugin release always runs the server it was written against.
`.mcp.json` starts it with `bunx @kvokka/codex-mcp@<version>`.

`npx` in that place starts nothing where the package is already in the tree. npm
exec answers the request from the tree of the directory the client started the
server in, so a project that carries the package at that version — the server's
own checkout, or anything depending on it — makes npm exec skip the fetch and
run the bare name `codex-mcp`, which no `PATH` answers to: the process exits 127
before writing a frame and the client reads `CONNECTION_CLOSED`. bunx fetches
the version it was asked for whatever the surrounding tree holds.

A release moves `package.json`, `plugins/codex-mcp/.claude-plugin/plugin.json`,
the marketplace entry in `.claude-plugin/marketplace.json`, the pin in
`.mcp.json` and the version this README names to the same number.
