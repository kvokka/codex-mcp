/** What `codex_setup` answers with: one readiness report over the local machine. */
import { z } from "zod";

/** What `codex_setup` takes: the directory it reads project-local config from. */
export const setupInputShape = {
  cwd: z
    .string()
    .optional()
    .describe("Optional cwd to inspect for project-local Codex config. Default: server cwd."),
};

export const setupResultShape = {
  ready: z.boolean(),
  cwd: z.string(),
  executable: z.object({
    ok: z.boolean(),
    source: z.string(),
    command: z.string().optional(),
    isPath: z.boolean().optional(),
    detail: z.string(),
  }),
  auth: z.object({
    ok: z.boolean(),
    state: z.enum(["authenticated", "unauthenticated", "not_required", "unknown"]),
    accountType: z.enum(["apiKey", "chatgpt", "amazonBedrock"]).optional(),
    detail: z.string(),
  }),
  backend: z.object({
    ok: z.boolean(),
    cliVersion: z.string().nullable(),
    minimumCliVersion: z.string(),
    detail: z.string(),
  }),
  windowsSandbox: z
    .object({ status: z.enum(["ready", "notConfigured", "updateRequired"]) })
    .optional()
    .describe("Windows only: what `windowsSandbox/readiness` answered."),
  runtime: z.object({
    sameMachineRequired: z.boolean(),
    stateDir: z.string(),
  }),
  projectContext: z.object({
    hasUserConfig: z.boolean(),
    hasProjectConfig: z.boolean(),
  }),
  permissionProfiles: z
    .object({
      ok: z.boolean(),
      profiles: z
        .array(
          z.object({
            id: z.string(),
            allowed: z.boolean(),
            // Codex sends `null` for a profile that has no description.
            description: z.string().nullish(),
          })
        )
        .optional(),
      detail: z.string(),
    })
    .describe(
      "The ids a `codex` call may pass as `permissions`. `profiles` is absent where the listing failed or was never run, which is not the same as a machine offering none."
    ),
  warnings: z.array(z.string()),
  nextSteps: z.array(z.string()),
};
