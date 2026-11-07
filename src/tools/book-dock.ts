import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerActionTool, type ToolContext } from "./define.js";
import { ok, pick } from "../util/format.js";

const strip = (o: Record<string, unknown>): Record<string, any> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const fileId = z.number().int().min(1).describe("Book Dock file id from list_files.");
const sel = {
  fileIds: z.array(z.number().int().min(1)).min(1).max(200).optional(),
  allReady: z
    .boolean()
    .optional()
    .describe(
      "Instead of fileIds: every file that is ready to file (use excludedIds to carve out).",
    ),
  excludedIds: z.array(z.number().int()).optional(),
};
type Sel = { fileIds?: number[]; allReady?: boolean; excludedIds?: number[] };

/** Exactly one of fileIds / allReady; allReady maps to selectAll+readyToFile. */
export function selection(i: Sel): Record<string, unknown> {
  if (i.fileIds?.length && i.allReady)
    throw new Error("Pass either fileIds or allReady, not both.");
  if (i.allReady)
    return strip({ selectAll: true, readyToFile: true, excludedIds: i.excludedIds });
  if (i.fileIds?.length) return { fileIds: i.fileIds };
  throw new Error("Select files with fileIds (max 200) or allReady: true.");
}

const metadataFields = {
  title: z.string().max(1000).nullable().optional(),
  subtitle: z.string().max(1000).nullable().optional(),
  authors: z.array(z.string()).optional(),
  seriesName: z.string().max(500).nullable().optional(),
  seriesIndex: z.string().max(20).nullable().optional(),
  publishedYear: z.number().int().min(1000).max(2200).nullable().optional(),
  language: z.string().max(100).nullable().optional(),
  publisher: z.string().max(500).nullable().optional(),
  description: z.string().optional(),
  isbn10: z.string().nullable().optional(),
  isbn13: z.string().nullable().optional(),
  genres: z.array(z.string()).optional(),
  narrators: z.array(z.string()).optional(),
};
const METADATA_KEYS = Object.keys(metadataFields);

function pickMetadata(i: Record<string, unknown>) {
  return strip(Object.fromEntries(METADATA_KEYS.map((k) => [k, i[k]])));
}

function shapeFile(f: any) {
  const md = f.selectedMetadata ?? f.metadata ?? {};
  return {
    ...pick(f, [
      "id",
      "fileName",
      "format",
      "status",
      "fileSize",
      "needsReview",
      "readyToFile",
      "targetLibraryId",
      "targetFolderId",
      "errorMessage",
    ]),
    ...pick(md, ["title", "authors", "seriesName", "seriesIndex"]),
  };
}

const destination = {
  defaultLibraryId: z
    .number()
    .int()
    .optional()
    .describe("With defaultFolderId: where files go."),
  defaultFolderId: z.number().int().optional(),
};

function finalizeBody(i: Sel & { defaultLibraryId?: number; defaultFolderId?: number }) {
  if ((i.defaultLibraryId === undefined) !== (i.defaultFolderId === undefined)) {
    throw new Error("defaultLibraryId and defaultFolderId must be given together.");
  }
  return strip({
    ...selection(i),
    defaultLibraryId: i.defaultLibraryId,
    defaultFolderId: i.defaultFolderId,
  });
}

export function registerBookDockTools(server: McpServer, ctx: ToolContext) {
  registerActionTool(server, ctx, {
    name: "book_dock",
    title: "Book Dock (import staging)",
    description:
      "Review and file incoming books staged in Book Dock. Typical flow: summary → list_files → (edit_file / refetch_metadata / apply_fetched) → set_target → preview_finalize → finalize. " +
      "Bulk actions take fileIds (max 200) or allReady:true. finalize, discard and discard_duplicates need confirm; finalize moves the files into the library. " +
      'Example: {action: "preview_finalize", allReady: true, defaultLibraryId: 2, defaultFolderId: 7}.',
    actions: {
      summary: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) => ok(await client.get("/book-dock/summary")),
      },
      list_files: {
        readOnly: true,
        schema: {
          status: z.enum(["pending", "ready", "error"]).optional(),
          needsReview: z.boolean().optional(),
          readyToFile: z.boolean().optional(),
          search: z.string().optional(),
          page: z.number().int().min(1).optional().describe("1-based (default 1)."),
          limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
        },
        run: async (i, { client }) => {
          const page = i.page ?? 1;
          const limit = i.limit ?? 20;
          const res = await client.get<any>("/book-dock/files", {
            status: i.status,
            needsReview: i.needsReview,
            readyToFile: i.readyToFile,
            search: i.search,
            page,
            limit,
          });
          const items: any[] = res.items ?? res.files ?? [];
          const total: number = res.total ?? items.length;
          return ok({
            total,
            page,
            items: items.map(shapeFile),
            nextPage: page * limit < total ? page + 1 : null,
          });
        },
      },
      get_file: {
        readOnly: true,
        schema: { id: fileId },
        run: async (i, { client }) => ok(await client.get(`/book-dock/files/${i.id}`)),
      },
      edit_file: {
        schema: {
          id: fileId,
          ...metadataFields,
          targetLibraryId: z.number().int().nullable().optional(),
          targetFolderId: z.number().int().nullable().optional(),
        },
        run: async (i, { client }) => {
          const selectedMetadata = pickMetadata(i as any);
          const body = strip({
            selectedMetadata: Object.keys(selectedMetadata).length
              ? selectedMetadata
              : undefined,
            targetLibraryId: (i as any).targetLibraryId,
            targetFolderId: (i as any).targetFolderId,
          });
          if (Object.keys(body).length === 0)
            throw new Error("edit_file needs metadata or a target to change.");
          return ok(shapeFile(await client.patch<any>(`/book-dock/files/${i.id}`, body)));
        },
      },
      bulk_edit: {
        schema: {
          ...sel,
          ...metadataFields,
          mergeArrays: z
            .boolean()
            .optional()
            .describe("Merge list fields (authors/genres) instead of replacing."),
        },
        run: async (i, { client }) => {
          const fields = pickMetadata(i as any);
          if (Object.keys(fields).length === 0)
            throw new Error("bulk_edit needs at least one field.");
          return ok(
            await client.post(
              "/book-dock/files/bulk-edit",
              strip({
                ...selection(i),
                fields,
                enabledFields: Object.keys(fields),
                mergeArrays: i.mergeArrays,
              }),
            ),
          );
        },
      },
      set_target: {
        schema: {
          ...sel,
          targetLibraryId: z.number().int().nullable().describe("null clears."),
          targetFolderId: z
            .number()
            .int()
            .nullable()
            .describe("Folder id from manage_library list."),
        },
        run: async (i, { client }) =>
          ok(
            await client.post("/book-dock/files/set-target", {
              ...selection(i),
              targetLibraryId: i.targetLibraryId,
              targetFolderId: i.targetFolderId,
            }),
          ),
      },
      refetch_metadata: {
        schema: { id: fileId },
        run: async (i, { client }) =>
          ok(
            (await client.post(`/book-dock/files/${i.id}/refetch-metadata`)) ?? {
              queued: i.id,
            },
          ),
      },
      retry_fetch: {
        schema: sel,
        run: async (i, { client }) =>
          ok(await client.post("/book-dock/files/retry-fetch", selection(i))),
      },
      apply_fetched: {
        schema: sel,
        run: async (i, { client }) =>
          ok(await client.post("/book-dock/files/apply-fetched", selection(i))),
      },
      preview_finalize: {
        readOnly: true,
        schema: { ...sel, ...destination },
        run: async (i, { client }) =>
          ok(await client.post("/book-dock/finalize/preview", finalizeBody(i))),
      },
      finalize: {
        destructive: true,
        schema: { ...sel, ...destination },
        summarize: async (i, { client }) => ({
          moveFilesIntoLibrary: true,
          preview: await client.post("/book-dock/finalize/preview", finalizeBody(i)),
        }),
        run: async (i, { client }) =>
          ok(await client.post("/book-dock/finalize", finalizeBody(i))),
      },
      discard_duplicates: {
        destructive: true,
        schema: { ...sel, ...destination },
        summarize: async (i, { client }) => ({
          discardsDuplicateStagedFiles: true,
          preview: await client.post("/book-dock/finalize/preview", finalizeBody(i)),
        }),
        run: async (i, { client }) =>
          ok(
            await client.post("/book-dock/finalize/discard-duplicates", finalizeBody(i)),
          ),
      },
      discard: {
        destructive: true,
        schema: { fileIds: z.array(z.number().int().min(1)).min(1).max(100) },
        summarize: async (i, { client }) => {
          const files = await Promise.all(
            i.fileIds.map(async (id: number) => {
              try {
                return shapeFile(await client.get<any>(`/book-dock/files/${id}`));
              } catch (e) {
                return { id, error: e instanceof Error ? e.message : String(e) };
              }
            }),
          );
          return {
            warning: "Discards these staged files (removed from Book Dock).",
            files,
          };
        },
        run: async (i, { client }) => {
          await client.post("/book-dock/files/discard", { fileIds: i.fileIds });
          return ok({ discarded: i.fileIds.length });
        },
      },
      rescan: {
        schema: {},
        run: async (_i, { client }) => {
          await client.post("/book-dock/rescan");
          return ok({ started: true });
        },
      },
      pause: {
        schema: {},
        run: async (_i, { client }) =>
          ok((await client.post("/book-dock/pause")) ?? { paused: true }),
      },
      resume: {
        schema: {},
        run: async (_i, { client }) =>
          ok((await client.post("/book-dock/resume")) ?? { resumed: true }),
      },
    },
  });
}
