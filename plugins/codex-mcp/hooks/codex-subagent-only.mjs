#!/usr/bin/env bun
// Lets the codex-mcp tools through for the agents that drive Codex, and denies
// them to every other caller.
//
// Claude Code sends `agent_type` only when the hook fires inside a subagent, or
// on the main thread of a session started with `--agent`, so its absence
// identifies the main conversation.
//
// A plugin prefixes its agents with its own name, so the driver shipped here
// answers to `codex-mcp:codex`, while a copy placed in a project's
// `.claude/agents/` answers to the bare `codex`.
//
// `CODEX_MCP_ALLOWED_AGENTS` names more of them, comma-separated: an agent that
// drives Codex in its own context rather than through the driver. The hook runs
// in the environment of the session that spawned it, so the `env` block of a
// Claude Code settings file is what sets it.

const ALLOWED = new Set([
  "codex",
  "codex-mcp:codex",
  ...(process.env.CODEX_MCP_ALLOWED_AGENTS ?? "")
    .split(",")
    .map((agent) => agent.trim())
    .filter((agent) => agent !== ""),
]);

const DENIAL = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "codex-mcp is reachable only through the codex subagent; spawn it with the Agent tool.",
  },
});

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let agentType;
  try {
    agentType = JSON.parse(raw).agent_type;
  } catch {
    // Unreadable input names no caller, so it is not the codex subagent.
  }
  if (ALLOWED.has(agentType)) {
    process.exit(0);
  }
  process.stdout.write(DENIAL);
});
