import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BookDetail, BookMovePreviewResult, Library } from "@bookorbit/types";
import { registerActionTool, type ToolContext } from "./define.js";
import { shapeBookDetail } from "./discovery.js";
import { ok, pick } from "../util/format.js";

const bookId = z.number().int().min(1).describe("Book id from search_books.");
const bookIds = (max: number) => z.array(z.number().int().min(1)).min(1).max(max);
const READ_STATUSES = [
  "unread",
  "want_to_read",
  "reading",
  "on_hold",
  "rereading",
  "read",
  "skimmed",
  "abandoned",
] as const;

const strip = (o: Record<string, unknown>): Record<string, any> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const nullableStr = (max: number) =>
  z.string().max(max).nullable().optional().describe("null clears the field.");

export function registerLibraryTools(server: McpServer, ctx: ToolContext) {
  registerActionTool(server, ctx, {
    name: "manage_book",
    title: "Manage books",
    description:
      "Edit a book's metadata, set read status, or delete books. Metadata fields set to null are cleared; omitted fields are untouched; authors/genres/tags replace the whole list. " +
      "delete removes books AND their files from disk (explicit bookIds only, max 50) and needs confirm. " +
      'Example: {action: "update", bookId: 42, seriesName: "The Expanse", seriesIndex: "2"}.',
    actions: {
      update: {
        schema: {
          bookId,
          title: nullableStr(1000),
          subtitle: nullableStr(1000),
          description: z.string().nullable().optional(),
          publisher: nullableStr(500),
          publishedYear: z.number().int().min(1000).max(2200).nullable().optional(),
          language: nullableStr(100),
          pageCount: z.number().int().min(1).nullable().optional(),
          seriesName: nullableStr(500),
          seriesIndex: z
            .string()
            .max(20)
            .nullable()
            .optional()
            .describe('e.g. "2" or "2.5".'),
          isbn10: nullableStr(10),
          isbn13: nullableStr(13),
          rating: z.number().int().min(1).max(5).nullable().optional(),
          authors: z.array(z.string()).optional(),
          genres: z.array(z.string()).optional(),
          tags: z.array(z.string()).optional(),
        },
        run: async (i, { client }) => {
          const { bookId: id, ...fields } = i as any;
          delete fields.action;
          delete fields.confirm;
          const body = strip(fields);
          if (Object.keys(body).length === 0)
            throw new Error("update needs at least one field to change.");
          const res = await client.patch<BookDetail>(`/books/${id}/metadata`, body);
          return ok(shapeBookDetail(res));
        },
      },
      set_status: {
        schema: {
          bookId,
          status: z.enum(READ_STATUSES),
          startedAt: z
            .string()
            .nullable()
            .optional()
            .describe("YYYY-MM-DD or ISO datetime; null clears."),
          finishedAt: z.string().nullable().optional(),
        },
        run: async (i, { client }) => {
          const { bookId: id, ...rest } = i as any;
          delete rest.action;
          delete rest.confirm;
          return ok(await client.patch(`/books/${id}/status`, strip(rest)));
        },
      },
      bulk_set_status: {
        schema: { bookIds: bookIds(200), status: z.enum(READ_STATUSES) },
        run: async (i, { client }) => {
          await client.post("/books/bulk-set-status", {
            bookIds: i.bookIds,
            status: i.status,
          });
          return ok({ updated: i.bookIds.length, status: i.status });
        },
      },
      delete: {
        destructive: true,
        schema: { bookIds: bookIds(50) },
        summarize: async (i, { client }) => {
          const books = await Promise.all(
            i.bookIds.map(async (id: number) => {
              try {
                const b = await client.get<BookDetail>(`/books/${id}`);
                return {
                  id,
                  title: b.title,
                  library: b.libraryName,
                  files: b.files?.length ?? 0,
                };
              } catch (e) {
                return { id, error: e instanceof Error ? e.message : String(e) };
              }
            }),
          );
          return {
            warning: "Permanently deletes these books and their files from disk.",
            books,
          };
        },
        run: async (i, { client }) =>
          ok(await client.delete("/books", { bookIds: i.bookIds })),
      },
    },
  });

  registerActionTool(server, ctx, {
    name: "manage_collection",
    title: "Manage collections",
    description:
      "Create, edit, fill and delete collections (list them with browse). Membership changes need explicit bookIds. " +
      'Example: {action: "create", name: "To buy", icon: "🛒"} then {action: "add_books", id: 5, bookIds: [1,2]}. delete needs confirm.',
    actions: {
      create: {
        schema: {
          name: z.string().min(1).max(255),
          icon: z
            .string()
            .max(100)
            .optional()
            .describe("Emoji or icon name (default 📚)."),
          description: z.string().max(1000).optional(),
          isPublic: z.boolean().optional(),
        },
        run: async (i, { client }) =>
          ok(
            await client.post(
              "/collections",
              strip({
                name: i.name,
                icon: i.icon ?? "📚",
                description: i.description,
                isPublic: i.isPublic,
              }),
            ),
          ),
      },
      update: {
        schema: {
          id: z.number().int().describe("Collection id."),
          name: z.string().min(1).max(255).optional(),
          icon: z.string().max(100).optional(),
          description: z.string().max(1000).optional(),
          isPublic: z.boolean().optional(),
        },
        run: async (i, { client }) => {
          const { id, ...rest } = i as any;
          delete rest.action;
          delete rest.confirm;
          return ok(await client.patch(`/collections/${id}`, strip(rest)));
        },
      },
      add_books: {
        schema: { id: z.number().int(), bookIds: bookIds(500) },
        run: async (i, { client }) =>
          ok(
            (await client.post(`/collections/${i.id}/books`, { bookIds: i.bookIds })) ?? {
              added: i.bookIds.length,
            },
          ),
      },
      remove_books: {
        schema: { id: z.number().int(), bookIds: bookIds(500) },
        run: async (i, { client }) =>
          ok(
            (await client.delete(`/collections/${i.id}/books`, {
              bookIds: i.bookIds,
            })) ?? {
              removed: i.bookIds.length,
            },
          ),
      },
      delete: {
        destructive: true,
        schema: { id: z.number().int() },
        summarize: async (i, { client }) => {
          const c = await client.get<any>(`/collections/${i.id}`);
          return `delete collection #${i.id} "${c?.name ?? "?"}" (books are kept)`;
        },
        run: async (i, { client }) => {
          await client.delete(`/collections/${i.id}`);
          return ok({ deleted: i.id });
        },
      },
    },
  });

  registerActionTool(server, ctx, {
    name: "manage_library",
    title: "Manage libraries",
    description:
      "Inspect libraries and trigger a rescan. list shows each library's folders (folder ids are needed by move_books). scan starts a rescan of the library's disk folders; it only adds/updates what's on disk. " +
      'Example: {action: "scan", id: 2}.',
    actions: {
      list: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) => {
          const libs = await client.get<Library[]>("/libraries");
          return ok({
            items: libs.map((l) => ({
              ...pick(l, ["id", "name", "organizationMode", "allowedFormats", "watch"]),
              folders: (l.folders ?? []).map((f: any) => pick(f, ["id", "path"])),
            })),
          });
        },
      },
      stats: {
        readOnly: true,
        schema: { id: z.number().int().describe("Library id.") },
        run: async (i, { client }) => ok(await client.get(`/libraries/${i.id}/stats`)),
      },
      scan: {
        schema: { id: z.number().int().describe("Library id.") },
        run: async (i, { client }) =>
          ok(
            (await client.post(`/scanner/libraries/${i.id}/scan`)) ?? {
              started: true,
              libraryId: i.id,
            },
          ),
      },
      scan_history: {
        readOnly: true,
        schema: {
          id: z.number().int(),
          limit: z.number().int().min(1).max(50).optional(),
        },
        run: async (i, { client }) =>
          ok(
            await client.get(`/scanner/libraries/${i.id}/scan-history`, {
              limit: i.limit ?? 5,
            }),
          ),
      },
    },
  });

  const moveShape = {
    bookIds: bookIds(500),
    targetLibraryId: z.number().int().min(1),
    targetFolderId: z
      .number()
      .int()
      .min(1)
      .describe("Folder id from manage_library list."),
  };
  registerActionTool(server, ctx, {
    name: "move_books",
    title: "Move books between libraries",
    description:
      "Move books (and their files on disk) to another library folder. Always run preview first: it reports ready, already-there and colliding books. execute needs confirm and a collisionPolicy. " +
      'Example: {action: "preview", bookIds: [1,2], targetLibraryId: 3, targetFolderId: 7}.',
    actions: {
      preview: {
        readOnly: true,
        schema: moveShape,
        run: async (i, { client }) => {
          const res = await client.post<BookMovePreviewResult>("/books/move/preview", {
            selection: { bookIds: i.bookIds },
            targetLibraryId: i.targetLibraryId,
            targetFolderId: i.targetFolderId,
          });
          return ok(res);
        },
      },
      execute: {
        destructive: true,
        schema: {
          ...moveShape,
          collisionPolicy: z
            .enum(["suggested", "keep_both", "merge", "skip"])
            .describe(
              "How to resolve name collisions; 'suggested' decides per collision.",
            ),
        },
        summarize: async (i, { client }) => {
          const p = await client.post<BookMovePreviewResult>("/books/move/preview", {
            selection: { bookIds: i.bookIds },
            targetLibraryId: i.targetLibraryId,
            targetFolderId: i.targetFolderId,
          });
          return {
            moveFilesOnDisk: true,
            collisionPolicy: i.collisionPolicy,
            ...pick(p, [
              "totalSelected",
              "readyCount",
              "alreadyInTargetCount",
              "collisionCount",
            ]),
          };
        },
        run: async (i, { client }) => {
          // The server cancels a move when the client disconnects, so never abort this stream:
          // stop waiting after ~50s but let the read finish in the background.
          const stream = client.sse<any>("/books/move", undefined, {
            method: "POST",
            body: {
              selection: { bookIds: i.bookIds },
              targetLibraryId: i.targetLibraryId,
              targetFolderId: i.targetFolderId,
              collisionPolicy: i.collisionPolicy,
            },
            timeoutMs: 30 * 60_000,
            maxEvents: 100_000,
          });
          const waited = await Promise.race([
            stream,
            new Promise<"pending">((r) => setTimeout(() => r("pending"), 50_000)),
          ]);
          if (waited === "pending") {
            stream.catch(() => undefined);
            return ok({
              status: "running",
              note: "The move is still running on the server. Check with get_book / manage_library.",
            });
          }
          const done = waited.find((e) => e?.done);
          const failed = waited.filter(
            (e) => e?.status && e.status !== "moved" && !e.done,
          );
          return ok({
            status: "finished",
            summary: done ?? null,
            notMoved: failed.slice(0, 50),
          });
        },
      },
    },
  });

  registerActionTool(server, ctx, {
    name: "duplicates",
    title: "Find duplicate books",
    description:
      "Scan for duplicate books, review the groups, and dismiss false positives. scan starts a background scan; poll scan_status, then read groups. " +
      "To remove a duplicate, delete it with manage_book (confirm). " +
      'Example: {action: "scan", similarityPercent: 90} → {action: "groups", scanId: 3}.',
    actions: {
      scan: {
        schema: {
          libraryId: z.number().int().optional(),
          similarityPercent: z
            .number()
            .int()
            .min(70)
            .max(100)
            .optional()
            .describe("Default 90."),
        },
        run: async (i, { client }) =>
          ok(
            await client.post(
              "/book-duplicates/scans",
              strip({
                libraryId: i.libraryId,
                similarityPercent: i.similarityPercent ?? 90,
              }),
            ),
          ),
      },
      scan_status: {
        readOnly: true,
        schema: {
          scanId: z.number().int().optional().describe("Omit for the active scan."),
        },
        run: async (i, { client }) =>
          ok(
            await client.get(
              i.scanId
                ? `/book-duplicates/scans/${i.scanId}`
                : "/book-duplicates/scans/active",
            ),
          ),
      },
      groups: {
        readOnly: true,
        schema: {
          scanId: z.number().int(),
          page: z.number().int().min(1).optional(),
          pageSize: z.number().int().min(1).max(50).optional().describe("Default 10."),
          reason: z
            .enum(["file_hash", "isbn", "exact_metadata", "fuzzy_metadata"])
            .optional(),
          sortBy: z.enum(["reclaimable", "copies", "confidence", "title"]).optional(),
        },
        run: async (i, { client }) =>
          ok(
            await client.get(
              `/book-duplicates/scans/${i.scanId}/groups`,
              strip({
                page: i.page ?? 1,
                pageSize: i.pageSize ?? 10,
                reason: i.reason,
                sortBy: i.sortBy,
              }),
            ),
          ),
      },
      list_dismissals: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) =>
          ok(await client.get("/book-duplicates/dismissals")),
      },
      dismiss: {
        schema: { scanId: z.number().int(), groupId: z.number().int() },
        run: async (i, { client }) => {
          await client.post("/book-duplicates/dismissals", {
            scanId: i.scanId,
            groupId: i.groupId,
          });
          return ok({ dismissed: i.groupId });
        },
      },
      undismiss: {
        schema: { bookIdA: z.number().int(), bookIdB: z.number().int() },
        run: async (i, { client }) => {
          await client.delete(`/book-duplicates/dismissals/${i.bookIdA}/${i.bookIdB}`);
          return ok({ restored: [i.bookIdA, i.bookIdB] });
        },
      },
    },
  });
}
