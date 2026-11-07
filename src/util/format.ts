import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "./errors.js";

export function ok(data: unknown): CallToolResult {
  // Empty API responses (204) must still produce a valid text block.
  return {
    content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 1) }],
  };
}

export function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
}

/** Keep only the listed keys (dropping undefined/null) so responses stay small. */
export function pick<T extends object>(
  obj: T | null | undefined,
  keys: readonly string[],
) {
  const out: Record<string, unknown> = {};
  if (!obj) return out;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** Trim a Nest/BookOrbit page `{items,total,page,size}` and compute the next page cursor. */
export function page<T>(
  res: { items?: T[]; total?: number; page?: number; size?: number } | undefined,
  shape: (item: T) => unknown,
) {
  const items = res?.items ?? [];
  const pageNo = res?.page ?? 0;
  const size = res?.size ?? items.length;
  const total = res?.total ?? items.length;
  const hasMore = (pageNo + 1) * size < total;
  return {
    total,
    page: pageNo,
    items: items.map(shape),
    nextPage: hasMore ? pageNo + 1 : null,
  };
}
