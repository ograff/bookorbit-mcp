import { z, type ZodObject, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BookOrbitClient } from "../client/bookorbit.js";
import { gateDestructive } from "../util/confirm.js";
import { fail } from "../util/format.js";

export interface ToolContext {
  client: BookOrbitClient;
  enableDestructive: boolean;
}

export interface ActionDef<S extends ZodRawShape = ZodRawShape> {
  /** Fields for this action (the `action` discriminator is added automatically). */
  schema: S;
  /** Destructive actions need `confirm: true`; without it they return a dry-run summary. */
  destructive?: boolean;
  /** What a destructive action would do, shown in the dry-run. Defaults to the parsed input. */
  summarize?: (
    input: z.infer<ZodObject<S>>,
    ctx: ToolContext,
  ) => unknown | Promise<unknown>;
  /** Marks a pure read; the tool is readOnly only if every action is. */
  readOnly?: boolean;
  run: (input: z.infer<ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>;
}

export interface ActionToolSpec {
  name: string;
  title: string;
  description: string;
  actions: Record<string, ActionDef<any>>;
  idempotent?: boolean;
}

/**
 * Registers a tool that dispatches on an `action` enum.
 *
 * MCP input schemas must be a flat object, so the advertised schema is `action` + the union of
 * every action's fields (all optional) + `confirm`. Strict per-action validation is a zod
 * discriminated union applied in the handler, which returns readable errors.
 */
export function registerActionTool(
  server: McpServer,
  ctx: ToolContext,
  spec: ActionToolSpec,
) {
  const names = Object.keys(spec.actions);
  if (names.length === 0) throw new Error(`${spec.name}: no actions`);

  const variants = names.map((name) =>
    z
      .object({
        action: z.literal(name),
        confirm: z.boolean().optional(),
        ...spec.actions[name]!.schema,
      })
      .strict(),
  );
  const union = z.discriminatedUnion("action", variants as any);

  const flat: ZodRawShape = {};
  for (const name of names) {
    for (const [k, v] of Object.entries(spec.actions[name]!.schema)) {
      if (!(k in flat)) flat[k] = (v as z.ZodTypeAny).optional();
    }
  }
  const anyDestructive = names.some((n) => spec.actions[n]!.destructive);
  const allReadOnly = names.every((n) => spec.actions[n]!.readOnly);

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: {
        action: z
          .enum(names as [string, ...string[]])
          .describe("Which operation to perform."),
        ...flat,
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Must be true to execute destructive actions; omitted = dry-run summary.",
          ),
      },
      annotations: {
        readOnlyHint: allReadOnly,
        destructiveHint: allReadOnly ? false : anyDestructive,
        idempotentHint: allReadOnly || (spec.idempotent ?? false),
        openWorldHint: false,
      },
    },
    async (args: Record<string, unknown>) => {
      const parsed = union.safeParse(args);
      if (!parsed.success) {
        const action = typeof args.action === "string" ? args.action : "?";
        return fail(
          `Invalid input for ${spec.name}.${action}: ` +
            parsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; "),
        );
      }
      const input = parsed.data as { action: string; confirm?: boolean };
      const def = spec.actions[input.action]!;
      try {
        if (def.destructive) {
          const summary = def.summarize ? await def.summarize(input as any, ctx) : input;
          const blocked = gateDestructive({
            enabled: ctx.enableDestructive,
            confirm: input.confirm,
            action: `${spec.name}.${input.action}`,
            summary,
          });
          if (blocked) return blocked;
        }
        return await def.run(input as any, ctx);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
