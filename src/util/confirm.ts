import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ok, fail } from "./format.js";

/**
 * Gate for destructive actions. Returns a result to short-circuit with, or null to proceed.
 * - ENABLE_DESTRUCTIVE=false refuses outright, even with confirm.
 * - Without confirm: true, returns a dry-run summary and does nothing.
 */
export function gateDestructive(opts: {
  enabled: boolean;
  confirm?: boolean;
  action: string;
  summary: unknown;
}): CallToolResult | null {
  if (!opts.enabled) {
    return fail(
      `'${opts.action}' is destructive and this server runs with ENABLE_DESTRUCTIVE=false.`,
    );
  }
  if (opts.confirm !== true) {
    return ok({
      dryRun: true,
      action: opts.action,
      wouldDo: opts.summary,
      note: "Nothing was changed. Re-call with confirm: true to execute.",
    });
  }
  return null;
}
