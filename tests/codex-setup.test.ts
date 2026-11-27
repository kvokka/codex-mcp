import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { setupResultShape } from "../src/mcp/schemas/setup.js";
import { executeCodexSetup } from "../src/tools/codex-setup/index.js";
import { _resetForTesting } from "../src/utils/codex-executable.js";
import { isCodexCliBelowMinimum } from "../src/utils/codex-version.js";
import { mockModule } from "./helpers/mock.js";

const { spawnSyncMock, spawnMock, homedirMock } = {
  spawnSyncMock: jest.fn(),
  spawnMock: jest.fn(),
  homedirMock: jest.fn(),
};

const realModule1 = { ...(await import("node:child_process")) };
mockModule("child_process", realModule1, () => {
  const actual = realModule1;
  return { ...actual, spawnSync: spawnSyncMock, spawn: spawnMock };
});

const realModule2 = { ...(await import("node:os")) };
mockModule("os", realModule2, () => {
  const actual = realModule2;
  return { ...actual, default: { ...actual, homedir: homedirMock }, homedir: homedirMock };
});

let root: string;
let home: string;
let serverCwd: string;
const envBackup = { ...process.env };
const realPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function makeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

function writeConfig(dir: string): void {
  mkdirSync(path.join(dir, ".codex"), { recursive: true });
  writeFileSync(path.join(dir, ".codex", "config.toml"), "model = 'gpt-5'\n");
}

type SpawnResult = { status: number | null; stdout?: string; stderr?: string; error?: Error };

/** What the stubbed CLI answers `codex --version` with; every test starts on a supported build. */
let versionResult: SpawnResult = { status: 0, stdout: "codex-cli 0.150.1", stderr: "" };

function installSpawnSyncStub(): void {
  spawnSyncMock.mockImplementation(() => versionResult);
}

// ── The stand-in app server ────────────────────────────────────────

/** One answer of the stand-in, either a JSON-RPC result or a JSON-RPC error. */
type Reply = { result: unknown } | { error: { code: number; message: string } };

/** Method → what the stand-in app server answers it with, one entry of a list per call. */
let replies: Record<string, Reply | Reply[]>;

/** Every method the client asked the stand-in for, in order. */
let requested: string[];

/** The `cwd` of every `permissionProfile/list` the client sent. */
let listedCwds: unknown[];

/** When set, the stand-in reports this failure instead of completing `initialize`. */
let startFailure: Error | null;

function createAppServerStub() {
  const proc = new EventEmitter() as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough & { write: PassThrough["write"] };
    killed: boolean;
    exitCode: number | null;
    /** Undefined, so `destroy` signals the child rather than a process group of this machine. */
    pid: undefined;
    kill: () => boolean;
    on: EventEmitter["on"];
    emit: EventEmitter["emit"];
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough() as typeof proc.stdin;
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = undefined;
  proc.kill = () => {
    proc.killed = true;
    // A real child reports its exit after the signal returns, and the client
    // attaches its `exit` listener in between: a synchronous emit is one no
    // listener hears, and the wait then runs to its fallback timer.
    queueMicrotask(() => {
      proc.exitCode = 0;
      proc.emit("exit", 0, null);
    });
    return true;
  };

  let buffered = "";
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let nl = buffered.indexOf("\n");
    while (nl !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      nl = buffered.indexOf("\n");
      if (!line) continue;
      answer(proc.stdout, JSON.parse(line) as { id: number; method: string }, proc);
    }
    return origWrite(chunk as never, encoding as never, cb as never);
  }) as typeof proc.stdin.write;

  return proc;
}

function answer(
  stdout: PassThrough,
  msg: { id: number; method: string; params?: { cwd?: unknown } },
  proc: { emit: EventEmitter["emit"] }
): void {
  requested.push(msg.method);
  if (msg.method === "permissionProfile/list") listedCwds.push(msg.params?.cwd);
  if (startFailure) {
    const failure = startFailure;
    queueMicrotask(() => proc.emit("error", failure));
    return;
  }
  const configured = replies[msg.method];
  const reply: Reply = (Array.isArray(configured) ? configured.shift() : configured) ?? {
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  };
  stdout.write(
    Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply })}\n`, "utf8")
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codex-mcp-setup-"));
  home = path.join(root, "home");
  serverCwd = path.join(root, "server-cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(serverCwd, { recursive: true });
  homedirMock.mockReturnValue(home);
  spawnSyncMock.mockReset();
  spawnMock.mockReset();
  versionResult = { status: 0, stdout: "codex-cli 0.150.1", stderr: "" };
  installSpawnSyncStub();

  // The install this machine measures: a model provider carrying its own
  // credentials, which is what `requiresOpenaiAuth: false` reports.
  replies = {
    initialize: { result: { userAgent: "codex-mcp/0.0.0" } },
    "account/read": { result: { account: null, requiresOpenaiAuth: false } },
    "permissionProfile/list": { result: { data: [], nextCursor: null } },
  };
  requested = [];
  listedCwds = [];
  startFailure = null;
  spawnMock.mockImplementation(() => createAppServerStub());

  delete process.env.CODEX_MCP_COMMAND;
  process.env.CODEX_MCP_STATE_DIR = path.join(root, "state");
  process.env.CODEX_MCP_PATH = makeExecutable(path.join(root, "bin"), "codex");
  _resetForTesting();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setPlatform(realPlatform);
  _resetForTesting();
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in envBackup)) delete process.env[key];
  }
  Object.assign(process.env, envBackup);
  jest.restoreAllMocks();
});

describe("executeCodexSetup", () => {
  it("reports a ready environment", async () => {
    writeConfig(home);
    const result = await executeCodexSetup(undefined, serverCwd);

    expect(result.ready).toBe(true);
    expect(result.cwd).toBe(serverCwd);
    expect(result.executable).toEqual({
      ok: true,
      source: "env_path",
      command: process.env.CODEX_MCP_PATH,
      isPath: true,
      detail: "Codex resolves via env_path.",
    });
    expect(result.auth).toEqual({
      ok: true,
      state: "not_required",
      detail:
        "`account/read` answered `requiresOpenaiAuth: false`: the configured model provider carries its own credentials, so this install needs no Codex login.",
    });
    expect(result.backend).toEqual({
      ok: true,
      cliVersion: "0.150.1",
      minimumCliVersion: "0.101.0",
      detail: "Codex CLI 0.150.1 carries `codex app-server`, which every session runs on.",
    });
    expect(result.windowsSandbox).toBeUndefined();
    expect(result.runtime).toEqual({
      sameMachineRequired: true,
      stateDir: path.join(root, "state"),
    });
    expect(result.projectContext).toEqual({ hasUserConfig: true, hasProjectConfig: false });
    expect(result.warnings).toEqual([]);
    expect(result.nextSteps).toEqual([]);
  });

  it("asks its three questions on one app server, spawned from the resolved executable", async () => {
    await executeCodexSetup(undefined, serverCwd);

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe(process.env.CODEX_MCP_PATH);
    expect(args).toEqual(["app-server"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(requested).toEqual(["initialize", "account/read", "permissionProfile/list"]);
    // The one subprocess this tool still scrapes a string out of.
    expect(spawnSyncMock.mock.calls.map(([, callArgs]) => callArgs)).toEqual([["--version"]]);
  });

  it("reads an install whose provider carries its own credentials as ready", async () => {
    writeConfig(home);
    const result = await executeCodexSetup(undefined, serverCwd);

    expect(result.auth.state).toBe("not_required");
    expect(result.auth.ok).toBe(true);
    expect(result.ready).toBe(true);
  });

  it("reports an install that needs a login it does not have", async () => {
    writeConfig(home);
    replies["account/read"] = { result: { account: null, requiresOpenaiAuth: true } };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.auth).toEqual({
      ok: false,
      state: "unauthenticated",
      detail:
        "`account/read` answered `requiresOpenaiAuth: true` with no account: this install has no Codex login.",
    });
    expect(result.ready).toBe(false);
    expect(result.nextSteps).toEqual(["Run `codex login` and rerun `codex_setup`."]);
  });

  it("names an API key account", async () => {
    writeConfig(home);
    replies["account/read"] = {
      result: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
    };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.auth).toEqual({
      ok: true,
      state: "authenticated",
      accountType: "apiKey",
      detail: "`account/read` answered an API key account.",
    });
    expect(result.ready).toBe(true);
  });

  it("names a ChatGPT account and its plan", async () => {
    writeConfig(home);
    replies["account/read"] = {
      result: {
        account: { type: "chatgpt", email: "tester@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.auth).toEqual({
      ok: true,
      state: "authenticated",
      accountType: "chatgpt",
      detail: "`account/read` answered a ChatGPT account on the pro plan.",
    });
    // The account's email is not part of the report.
    expect(JSON.stringify(result)).not.toContain("tester@example.com");
    expect(result.ready).toBe(true);
  });

  it("names an Amazon Bedrock account", async () => {
    writeConfig(home);
    replies["account/read"] = {
      result: {
        account: { type: "amazonBedrock", usesCodexManagedCredentials: true },
        requiresOpenaiAuth: false,
      },
    };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.auth).toEqual({
      ok: true,
      state: "authenticated",
      accountType: "amazonBedrock",
      detail: "`account/read` answered an Amazon Bedrock account.",
    });
    expect(result.ready).toBe(true);
  });

  it("reports an app server that would not start as an auth state it could not read", async () => {
    writeConfig(home);
    startFailure = new Error("spawn ENOENT");

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.auth).toEqual({
      ok: false,
      state: "unknown",
      detail: "`codex app-server` did not start, so the auth state was not read: spawn ENOENT",
    });
    expect(result.ready).toBe(false);
    // One connection carried all three questions, so the failure that stopped
    // it is reported once rather than per question.
    expect(result.warnings).toEqual([result.auth.detail]);
    expect(result.permissionProfiles).toEqual({
      ok: false,
      detail: "Permission profiles not listed because `codex app-server` did not start.",
    });
    // Nothing here tells the caller to log in: no answer said they are logged out.
    expect(result.nextSteps).toEqual([]);
  });

  it("reports an account/read that failed as an auth state it could not read", async () => {
    writeConfig(home);
    replies["account/read"] = { error: { code: -32601, message: "Method not found" } };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.auth).toEqual({
      ok: false,
      state: "unknown",
      detail:
        "`account/read` failed, so the auth state was not read: RPC error -32601: Method not found",
    });
    expect(result.ready).toBe(false);
  });

  it("uses the requested cwd and detects a project config there", async () => {
    const projectCwd = path.join(root, "project");
    mkdirSync(projectCwd, { recursive: true });
    writeConfig(projectCwd);

    const result = await executeCodexSetup({ cwd: projectCwd }, serverCwd);
    expect(result.cwd).toBe(projectCwd);
    expect(result.projectContext).toEqual({ hasUserConfig: false, hasProjectConfig: true });
    expect(result.warnings).toEqual([]);
  });

  it("falls back to the server cwd for a blank input cwd", async () => {
    const result = await executeCodexSetup({ cwd: "   " }, serverCwd);
    expect(result.cwd).toBe(serverCwd);
  });

  it("warns when no Codex config is present anywhere", async () => {
    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.warnings).toContain(
      "No Codex config.toml was found in ~/.codex or this project."
    );
  });

  it("reports a missing executable without asking anything", async () => {
    writeConfig(home);
    delete process.env.CODEX_MCP_PATH;
    process.env.PATH = "";
    _resetForTesting();

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.executable.ok).toBe(false);
    expect(result.executable.source).toBe("default");
    expect(result.executable.detail).toContain("No codex executable was auto-detected");
    expect(result.auth).toEqual({
      ok: false,
      state: "unknown",
      detail: "Auth state not read because no codex executable was detected.",
    });
    expect(result.backend).toEqual({
      ok: false,
      cliVersion: null,
      minimumCliVersion: "0.101.0",
      detail: "Codex CLI version not checked because no codex executable was detected.",
    });
    expect(result.ready).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(result.warnings[0]).toContain("No codex executable was auto-detected");
    expect(result.nextSteps).toContain(
      "Install Codex or fix CODEX_MCP_COMMAND / CODEX_MCP_PATH so the executable can be resolved."
    );
  });

  it("reports a misconfigured executable resolution as an error source", async () => {
    writeConfig(home);
    process.env.CODEX_MCP_COMMAND = "codex";
    _resetForTesting();

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.executable.source).toBe("error");
    expect(result.executable.ok).toBe(false);
    expect(result.executable.command).toBeUndefined();
    expect(result.executable.detail).toContain(
      "Cannot set both CODEX_MCP_PATH and CODEX_MCP_COMMAND"
    );
    expect(result.auth.detail).toBe("Auth state not read because executable resolution failed.");
    expect(result.ready).toBe(false);
  });

  it("refuses readiness for a CLI below the minimum and names the upgrade", async () => {
    writeConfig(home);
    versionResult = { status: 0, stdout: "codex-cli 0.100.0", stderr: "" };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.backend.ok).toBe(false);
    expect(result.backend.cliVersion).toBe("0.100.0");
    expect(result.warnings).toContain(
      "Codex CLI 0.100.0 is below the 0.101.0 this server needs: it carries no `codex app-server`, so no session starts. Upgrade the CLI."
    );
    expect(result.nextSteps).toContain("Upgrade the Codex CLI to 0.101.0 or newer.");
    expect(result.ready).toBe(false);
  });

  it("refuses readiness when the CLI printed no version to hold against the floor", async () => {
    // An unread version is not an old CLI, and the report says which of the two it is.
    writeConfig(home);
    versionResult = { status: 1, stdout: "", stderr: "error: unrecognized argument '--version'\n" };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.backend).toEqual({
      ok: false,
      cliVersion: null,
      minimumCliVersion: "0.101.0",
      detail:
        "`codex --version` printed no version, so this build cannot be held against the 0.101.0 floor.",
    });
    expect(result.ready).toBe(false);
  });

  it("counts the floor release itself as supported", async () => {
    writeConfig(home);
    versionResult = { status: 0, stdout: "codex-cli 0.101.0", stderr: "" };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.backend.ok).toBe(true);
    expect(result.ready).toBe(true);
  });

  it("defaults the state dir under the home directory", async () => {
    delete process.env.CODEX_MCP_STATE_DIR;
    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.runtime.stateDir).toBe(path.join(home, ".codex-mcp", "state"));

    process.env.CODEX_MCP_STATE_DIR = "   ";
    const blank = await executeCodexSetup(undefined, serverCwd);
    expect(blank.runtime.stateDir).toBe(path.join(home, ".codex-mcp", "state"));
  });
});

/**
 * What these prove and what they do not: they drive `process.platform`, which is
 * the value the code branches on, and a stand-in app server whose readiness
 * answers are written here. No Windows machine ran them, so the Windows sandbox
 * of a real install — whether Codex reports it `ready` where a `workspace-write`
 * turn then works — is not what is measured; the branch and the report are.
 */
describe("executeCodexSetup on Windows", () => {
  beforeEach(() => {
    writeConfig(home);
    replies["windowsSandbox/readiness"] = { result: { status: "ready" } };
  });

  it("asks for the readiness of the sandbox and reports it", async () => {
    setPlatform("win32");
    const result = await executeCodexSetup(undefined, serverCwd);

    expect(requested).toEqual([
      "initialize",
      "account/read",
      "windowsSandbox/readiness",
      "permissionProfile/list",
    ]);
    expect(result.windowsSandbox).toEqual({ status: "ready" });
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("refuses readiness for a sandbox that is not configured", async () => {
    setPlatform("win32");
    replies["windowsSandbox/readiness"] = { result: { status: "notConfigured" } };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.windowsSandbox).toEqual({ status: "notConfigured" });
    expect(result.ready).toBe(false);
    expect(result.warnings).toContain(
      'The Windows sandbox is not configured; a turn started with `sandbox: "workspace-write"` fails.'
    );
    expect(result.nextSteps).toContain(
      'Complete the Windows sandbox setup in the Codex CLI, or start sessions with `sandbox: "read-only"`.'
    );
  });

  it("refuses readiness for a sandbox that needs an update", async () => {
    setPlatform("win32");
    replies["windowsSandbox/readiness"] = { result: { status: "updateRequired" } };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.windowsSandbox).toEqual({ status: "updateRequired" });
    expect(result.ready).toBe(false);
    expect(result.warnings).toContain(
      'The Windows sandbox needs an update; a turn started with `sandbox: "workspace-write"` fails until it has one.'
    );
  });

  it("reports a readiness call that failed and holds the rest of the report", async () => {
    setPlatform("win32");
    replies["windowsSandbox/readiness"] = { error: { code: -32601, message: "Method not found" } };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.windowsSandbox).toBeUndefined();
    expect(result.warnings).toEqual([
      "`windowsSandbox/readiness` failed, so the Windows sandbox state was not read: RPC error -32601: Method not found",
    ]);
    expect(result.auth.state).toBe("not_required");
    expect(result.ready).toBe(true);
  });

  it("asks nothing about the sandbox off Windows, where the answer would be the same", async () => {
    // The backend answers `notConfigured` on Linux too, so an unconditional call
    // would report a missing Windows sandbox on every machine that has no Windows.
    setPlatform("linux");
    replies["windowsSandbox/readiness"] = { result: { status: "notConfigured" } };

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(requested).toEqual(["initialize", "account/read", "permissionProfile/list"]);
    expect(result.windowsSandbox).toBeUndefined();
    expect(result.ready).toBe(true);
  });
});

describe("isCodexCliBelowMinimum", () => {
  it("ranks a release against the floor", () => {
    expect(isCodexCliBelowMinimum("0.100.9")).toBe(true);
    expect(isCodexCliBelowMinimum("0.101.0")).toBe(false);
    expect(isCodexCliBelowMinimum("0.150.1")).toBe(false);
    expect(isCodexCliBelowMinimum("1.0.0")).toBe(false);
  });

  it("counts a prerelease of the floor release as the floor", () => {
    expect(isCodexCliBelowMinimum("0.101.0-alpha.1")).toBe(false);
    expect(isCodexCliBelowMinimum("0.100.0-alpha.1")).toBe(true);
  });

  it("reports a string carrying no three release numbers as not below the floor", () => {
    // An unreadable version is reported as unread — `codex_setup` says so in its
    // own branch — never as an old CLI this ranked and refused.
    expect(isCodexCliBelowMinimum("0.150")).toBe(false);
    expect(isCodexCliBelowMinimum("nightly")).toBe(false);
  });
});

describe("executeCodexSetup permission profiles", () => {
  it("names the ids a codex call may pass as permissions", async () => {
    replies["permissionProfile/list"] = {
      result: {
        data: [
          { id: ":read-only", allowed: true, description: "Reads only" },
          { id: ":workspace", allowed: true },
          { id: ":danger-full-access", allowed: false },
        ],
        nextCursor: null,
      },
    };

    const result = await executeCodexSetup(undefined, serverCwd);

    expect(listedCwds).toEqual([serverCwd]);
    expect(result.permissionProfiles.ok).toBe(true);
    expect(result.permissionProfiles.profiles?.map((profile) => profile.id)).toEqual([
      ":read-only",
      ":workspace",
      ":danger-full-access",
    ]);
    // The detail names the selectable ones only; `allowed: false` is a distinct
    // case the profile list itself still carries.
    expect(result.permissionProfiles.detail).toBe(
      "Pass one of these ids as `permissions`: :read-only, :workspace."
    );
    expect(result.warnings).not.toContain(result.permissionProfiles.detail);
  });

  it("answers a listing whose profiles carry a null description within the output schema", async () => {
    // Codex 0.169 sends `"description": null` for the profiles that have none; the
    // MCP SDK validates the structured content against this shape before replying.
    replies["permissionProfile/list"] = {
      result: {
        data: [
          { id: ":read-only", allowed: true, description: null },
          { id: ":workspace", allowed: true, description: "Writes the workspace" },
          { id: ":danger-full-access", allowed: false },
        ],
        nextCursor: null,
      },
    };

    const result = await executeCodexSetup(undefined, serverCwd);
    const parsed = z.object(setupResultShape).safeParse(result);

    expect(parsed.success).toBe(true);
    expect(result.permissionProfiles.profiles?.[0]?.description).toBeNull();
  });

  it("follows the cursor of a listing that answered in pages", async () => {
    replies["permissionProfile/list"] = [
      { result: { data: [{ id: ":read-only", allowed: true }], nextCursor: "page2" } },
      { result: { data: [{ id: ":workspace", allowed: true }], nextCursor: null } },
    ];

    const result = await executeCodexSetup(undefined, serverCwd);

    expect(requested.filter((method) => method === "permissionProfile/list")).toHaveLength(2);
    expect(result.permissionProfiles.profiles?.map((profile) => profile.id)).toEqual([
      ":read-only",
      ":workspace",
    ]);
  });

  it("resolves the profiles of the cwd the call named", async () => {
    const projectCwd = path.join(root, "project");
    mkdirSync(projectCwd, { recursive: true });

    const result = await executeCodexSetup({ cwd: projectCwd }, serverCwd);

    expect(listedCwds).toEqual([projectCwd]);
    expect(result.permissionProfiles).toEqual({
      ok: true,
      profiles: [],
      detail: "This machine offers no permission profile; `permissions` has no id to name here.",
    });
  });

  it("carries a listing that failed through beside an auth probe that answered", async () => {
    replies["permissionProfile/list"] = {
      error: { code: -32603, message: "permissionProfile/list timed out after 30000ms" },
    };

    const result = await executeCodexSetup(undefined, serverCwd);

    expect(result.permissionProfiles.ok).toBe(false);
    expect(result.permissionProfiles.profiles).toBeUndefined();
    expect(result.permissionProfiles.detail).toBe(
      "Failed to list permission profiles: RPC error -32603: permissionProfile/list timed out after 30000ms"
    );
    expect(result.warnings).toContain(result.permissionProfiles.detail);
    expect(result.nextSteps).toContain(
      "Start a session with `sandbox` rather than `permissions` until the profile listing answers."
    );
    // The listing failed and the account call did not: one question of the
    // connection says nothing about the other.
    expect(result.auth.state).toBe("not_required");
  });

  it("reads the auth state off a connection whose listing was refused", async () => {
    replies["account/read"] = { error: { code: -32601, message: "Method not found" } };

    const result = await executeCodexSetup(undefined, serverCwd);

    expect(result.auth.state).toBe("unknown");
    expect(result.permissionProfiles).toEqual({
      ok: true,
      profiles: [],
      detail: "This machine offers no permission profile; `permissions` has no id to name here.",
    });
  });

  it("does not list profiles when no codex executable resolved", async () => {
    delete process.env.CODEX_MCP_PATH;
    process.env.PATH = "";

    const result = await executeCodexSetup(undefined, serverCwd);

    expect(listedCwds).toEqual([]);
    expect(result.permissionProfiles).toEqual({
      ok: false,
      detail: "Permission profiles not listed because no codex executable was detected.",
    });
  });
});
