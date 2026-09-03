import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain ESM, shared with the scripts that run it.
import { REQUIRED_TOOLS } from "../scripts/lib/mcp-client.mjs";
import { resolveSessionDefaults } from "../src/utils/session-defaults.js";
import { present } from "./helpers/present.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const PLUGIN_SERVER = JSON.parse(read("plugins/codex-mcp/.mcp.json")).mcpServers["codex-mcp"];
const PLUGIN_HOOK = JSON.parse(read("plugins/codex-mcp/hooks/hooks.json")).hooks.PreToolUse[0];
const HOOK_SCRIPT = join(ROOT, "plugins/codex-mcp/hooks/codex-subagent-only.mjs");

/** The tool names the driver may be given, under both spellings of the server. */
const TOOL_NAMES: string[] = (REQUIRED_TOOLS as string[]).flatMap((tool) => [
  `mcp__plugin_codex-mcp_codex-mcp__${tool}`,
  `mcp__codex-mcp__${tool}`,
]);

/**
 * What the hook answers a caller: it writes nothing where it allows the call.
 *
 * `allowed` is the `CODEX_MCP_ALLOWED_AGENTS` of the session the hook runs in,
 * left out of the environment entirely where the test names none.
 */
function decide(payload: unknown, allowed?: string): string {
  const env = { ...process.env, CODEX_MCP_ALLOWED_AGENTS: allowed };
  if (allowed === undefined) delete env.CODEX_MCP_ALLOWED_AGENTS;
  const run = spawnSync("bun", [HOOK_SCRIPT], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  expect(run.status, run.stderr).toBe(0);
  if (run.stdout === "") return "allow";
  const answer = JSON.parse(run.stdout).hookSpecificOutput;
  expect(answer.hookEventName).toBe("PreToolUse");
  return answer.permissionDecision;
}

describe("the server the plugin starts", () => {
  const server = PLUGIN_SERVER;

  it("is bunx on the version this repository publishes", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(server.command).toBe("bunx");
    expect(server.args).toEqual([`@kvokka/codex-mcp@${version}`]);
  });

  // The subagent runs on Haiku and names none of these, so the plugin is where
  // every session's model, effort, approval timeout, approval policy and
  // sandbox are set.
  it("names what a session starts on, down to the permission level of the turn", () => {
    expect(resolveSessionDefaults(server.env)).toEqual({
      model: "gpt-5.6-luna",
      effort: "high",
      approvalTimeoutMs: 900_000,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  // npm exec answers a package request from the tree of the directory the client
  // started the server in, so in this repository's own checkout — and in any
  // project depending on the package — it ran the bare name `codex-mcp` from PATH,
  // exited 127 and the client read CONNECTION_CLOSED. bunx fetches the pin.
  it("is not npx, which cannot start it inside a tree that carries the package", () => {
    expect(server.command).not.toBe("npx");
  });
});

describe("the hook the plugin installs", () => {
  it("runs under bun, the one runtime the plugin already asks for", () => {
    expect(PLUGIN_HOOK.hooks[0].command).toStartWith("bun ");
  });

  it("fires on every tool the driver is given, under either spelling", () => {
    const matcher = new RegExp(`^${PLUGIN_HOOK.matcher}$`);
    for (const tool of TOOL_NAMES) {
      expect(matcher.test(tool), `the matcher lets ${tool} past unguarded`).toBe(true);
    }
  });

  // `codex-mcp:codex` is the driver as the plugin names it, and `codex` the same
  // file copied into a project's `.claude/agents/`.
  it.each(["codex", "codex-mcp:codex"])("lets %s through with no setting named", (agentType) => {
    expect(decide({ agent_type: agentType })).toBe("allow");
  });

  it("denies the head agent, whose payload carries no agent_type", () => {
    expect(decide({ tool_name: TOOL_NAMES[0] })).toBe("deny");
  });

  it("denies a subagent no setting admits", () => {
    expect(decide({ agent_type: "reviewer" })).toBe("deny");
  });

  it("denies input it cannot read, which names no caller", () => {
    expect(decide("{ not json")).toBe("deny");
  });

  it("admits the agent type CODEX_MCP_ALLOWED_AGENTS names", () => {
    expect(decide({ agent_type: "reviewer" }, "reviewer")).toBe("allow");
  });

  it("keeps the two it ships with beside the ones the setting names", () => {
    expect(decide({ agent_type: "codex-mcp:codex" }, "reviewer")).toBe("allow");
  });

  it.each(["researcher", "my-plugin:reviewer", "auditor"])(
    "admits %s out of a list written with spaces",
    (agentType) => {
      expect(decide({ agent_type: agentType }, " researcher, my-plugin:reviewer ,auditor ")).toBe(
        "allow"
      );
    }
  );

  it("reads a list carrying an empty entry, and admits no empty agent type", () => {
    expect(decide({ agent_type: "researcher" }, "researcher,,auditor")).toBe("allow");
    expect(decide({ agent_type: "auditor" }, "researcher,,auditor")).toBe("allow");
    expect(decide({ agent_type: "" }, "researcher,,auditor")).toBe("deny");
    expect(decide({ tool_name: TOOL_NAMES[0] }, "researcher,,auditor")).toBe("deny");
  });

  it("admits nobody extra where the setting is empty", () => {
    expect(decide({ agent_type: "reviewer" }, "")).toBe("deny");
  });
});

describe("the driver the plugin ships", () => {
  const agent = read("plugins/codex-mcp/agents/codex.md");

  it("polls in rounds short enough to say something between them", () => {
    expect(agent).toContain('codex_check(action="poll", sessionId, waitMs: 300000)');
    // A round of the maximum says nothing to the person waiting for an hour.
    expect(agent).not.toContain("3600000");
  });

  it("writes the activity line out itself, and says how long it has stood", () => {
    expect(agent).toContain("**Progress summary**: <progress.activity>");
    expect(agent).toContain("**Progress summary**: <progress.activity> — 15 min");
    expect(agent).toContain("progress.activityStandingMs");
  });

  it("leaves those lines out of the report, where the run is already over", () => {
    const report = agent.slice(agent.indexOf("## Report"));
    expect(report).not.toContain("progress:");
  });

  it("runs on the cheapest model, since it decides nothing", () => {
    expect(agent).toContain("model: haiku");
  });

  // `.mcp.json` is where a session's model, effort, approval timeout, approval
  // policy and sandbox are stated. A copy in the driver's prose is a second
  // place to change and a Haiku turn away from disagreeing with the server.
  it("repeats none of the values .mcp.json sets", () => {
    const defaults = resolveSessionDefaults(PLUGIN_SERVER.env);
    const named = [
      `model: ${defaults.model}`,
      `effort: ${defaults.effort}`,
      `approvalPolicy: ${defaults.approvalPolicy}`,
      `sandbox: ${defaults.sandbox}`,
      `approvalTimeoutMs: ${defaults.approvalTimeoutMs}`,
    ];
    for (const line of named) {
      expect(agent, `the driver names ${line} itself`).not.toContain(line);
    }
  });

  it("proxies every prompt to Codex rather than answering one", () => {
    expect(agent).toContain("You are a proxy.");
    // The three the driver kept answering itself instead of forwarding.
    expect(agent).toContain("1 + 1");
    expect(agent).toContain("прпгшукрпагкышщп");
    expect(agent).toContain("A page of shell commands");
  });

  it("keeps its own decisions to how Codex is started", () => {
    expect(agent).toContain("**What you decide is only how Codex is started**");
  });

  // The prose tells the driver to read no file and run no command; the
  // frontmatter is what leaves it holding no tool that could.
  it("is given the five codex-mcp tools and nothing else", () => {
    const line = present(/^tools:(.*)$/m.exec(agent), "the driver's tools: line")[1];
    const named = line.split(",").map((tool) => tool.trim());
    expect(new Set(named)).toEqual(new Set(TOOL_NAMES));
  });
});
