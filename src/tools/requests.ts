import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  BookRequestAvailability,
  BookRequestBulkResult,
  BookRequestItem,
  BookRequestPage,
  BookRequestSubmitResult,
  BookRequestPairSubmitResult,
} from "@bookorbit/types";
import { registerActionTool, type ToolContext } from "./define.js";
import { ok, pick } from "../util/format.js";

const MEDIA = z.enum(["ebook", "audiobook"]);
const STATUS = z.enum([
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "searching",
  "grabbed",
  "downloading",
  "importing",
  "needs_review",
  "available",
  "failed",
]);

export function shapeRequest(r: BookRequestItem): Record<string, unknown> {
  return {
    ...pick(r, [
      "id",
      "title",
      "seriesName",
      "seriesIndex",
      "mediaKind",
      "status",
      "statusReason",
      "failureCode",
      "requesterUsername",
      "targetLibraryName",
      "matchedBookId",
      "companionRequestId",
      "decisionNote",
      "dismissed",
      "createdAt",
    ]),
    ...(r.authors?.length ? { authors: r.authors } : {}),
    ...(r.download
      ? {
          download: pick(r.download as any, [
            "id",
            "status",
            "progress",
            "clientName",
            "name",
          ]),
        }
      : {}),
  };
}

/** Request lists are 1-based (page/limit) — unlike the library browse endpoints. */
const listShape = {
  status: STATUS.optional(),
  mediaKind: MEDIA.optional(),
  includeDismissed: z.boolean().optional(),
  page: z.number().int().min(1).optional().describe("1-based page (default 1)."),
  limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20)."),
};

function pagedRequests(res: BookRequestPage, page: number, limit: number) {
  return {
    total: res.total,
    page,
    items: res.items.map(shapeRequest),
    nextPage: page * limit < res.total ? page + 1 : null,
  };
}

const idShape = { id: z.number().int().min(1).describe("Request id.") };

const workShape = {
  title: z.string().min(1).max(500),
  authors: z.array(z.string()).max(50).optional(),
  seriesName: z.string().optional(),
  seriesIndex: z.number().int().min(0).optional(),
  isbn13: z.string().optional(),
  publishedYear: z.number().int().optional(),
  language: z.string().optional(),
  providerKey: z
    .string()
    .optional()
    .describe("Metadata provider key from metadata_lookup."),
  providerId: z.string().optional().describe("Provider's id for the work."),
  note: z.string().max(2000).optional(),
};

const stripUndef = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function registerRequestTools(server: McpServer, ctx: ToolContext) {
  registerActionTool(server, ctx, {
    name: "requests",
    title: "Book requests",
    description:
      "Create and manage book requests as the BookOrbit user: ask for an ebook or audiobook to be acquired, check whether it's already owned/requested, track status, cancel. " +
      "create needs title+mediaKind; create_pair asks for ebook and audiobook together; check_availability takes items:[{title,mediaKind,author?}] (max 50). " +
      'Example: {action: "create", title: "Leviathan Wakes", authors: ["James S. A. Corey"], mediaKind: "ebook", seriesName: "The Expanse", seriesIndex: 1}.',
    actions: {
      list: {
        readOnly: true,
        schema: listShape,
        run: async (i, { client }) => {
          const page = i.page ?? 1;
          const limit = i.limit ?? 20;
          const res = await client.get<BookRequestPage>("/book-requests", {
            status: i.status,
            mediaKind: i.mediaKind,
            includeDismissed: i.includeDismissed,
            page,
            limit,
          });
          return ok(pagedRequests(res, page, limit));
        },
      },
      get: {
        readOnly: true,
        schema: idShape,
        run: async (i, { client }) =>
          ok(shapeRequest(await client.get<BookRequestItem>(`/book-requests/${i.id}`))),
      },
      summary: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) => ok(await client.get("/book-requests/summary")),
      },
      check_availability: {
        readOnly: true,
        schema: {
          items: z
            .array(
              z.object({
                title: z.string(),
                mediaKind: MEDIA,
                author: z.string().optional(),
                isbn13: z.string().optional(),
                providerKey: z.string().optional(),
                providerId: z.string().optional(),
              }),
            )
            .min(1)
            .max(50),
        },
        run: async (i, { client }) => {
          const res = await client.post<
            BookRequestAvailability[] | { items: BookRequestAvailability[] }
          >("/book-requests/availability", { items: i.items });
          const list = Array.isArray(res) ? res : res.items;
          return ok({
            items: list.map((a, n) => ({
              title: i.items[n]?.title,
              mediaKind: i.items[n]?.mediaKind,
              ...a,
            })),
          });
        },
      },
      create: {
        schema: {
          ...workShape,
          mediaKind: MEDIA,
          targetLibraryId: z.number().int().optional(),
          preferredFormats: z.array(z.string()).optional(),
        },
        run: async (i, { client }) => {
          const { action: _a, confirm: _c, ...body } = i as any;
          const res = await client.post<BookRequestSubmitResult>(
            "/book-requests",
            stripUndef(body),
          );
          return ok({
            subscribedToExisting: res.subscribed,
            request: shapeRequest(res.request),
          });
        },
      },
      create_pair: {
        schema: {
          ...workShape,
          ebookLibraryId: z.number().int().optional(),
          audiobookLibraryId: z.number().int().optional(),
        },
        run: async (i, { client }) => {
          const {
            action: _a,
            confirm: _c,
            ebookLibraryId,
            audiobookLibraryId,
            ...work
          } = i as any;
          const body = {
            ...stripUndef(work),
            ebook: stripUndef({ targetLibraryId: ebookLibraryId }),
            audiobook: stripUndef({ targetLibraryId: audiobookLibraryId }),
          };
          const res = await client.post<BookRequestPairSubmitResult>(
            "/book-requests/pairs",
            body,
          );
          return ok({
            ebook: {
              subscribedToExisting: res.ebook.subscribed,
              request: shapeRequest(res.ebook.request),
            },
            audiobook: {
              subscribedToExisting: res.audiobook.subscribed,
              request: shapeRequest(res.audiobook.request),
            },
          });
        },
      },
      cancel: {
        destructive: true,
        schema: idShape,
        summarize: (i) =>
          `cancel your request #${i.id} (stops any search/download for it)`,
        run: async (i, { client }) =>
          ok(
            shapeRequest(
              await client.post<BookRequestItem>(`/book-requests/${i.id}/cancel`),
            ),
          ),
      },
      cancel_download: {
        destructive: true,
        schema: { ...idShape, downloadId: z.number().int() },
        summarize: (i) => `cancel active download ${i.downloadId} of request #${i.id}`,
        run: async (i, { client }) =>
          ok(
            await client.post(`/book-requests/${i.id}/downloads/${i.downloadId}/cancel`),
          ),
      },
      dismiss: {
        schema: { ids: z.array(z.number().int()).min(1).max(100) },
        run: async (i, { client }) =>
          ok(await client.post("/book-requests/dismiss", { ids: i.ids })),
      },
      restore: {
        schema: idShape,
        run: async (i, { client }) =>
          ok(await client.post(`/book-requests/${i.id}/restore`)),
      },
      set_language: {
        schema: {
          ...idShape,
          language: z.string().nullable().describe("Language code, or null to clear."),
        },
        run: async (i, { client }) =>
          ok(
            await client.post(`/book-requests/${i.id}/language`, {
              language: i.language,
            }),
          ),
      },
    },
  });

  registerActionTool(server, ctx, {
    name: "requests_admin",
    title: "Book requests (admin)",
    description:
      "Approver/fulfiller actions on everyone's requests; needs the manage_book_requests permission. Typical flow: list status=pending → approve → search_releases → inspect_release → grab. " +
      "approve/reject accept ids (bulk) or id; reject/force_file/discard_import/delete/remove_download need confirm. " +
      'Example: {action: "search_releases", id: 12} then {action: "grab", id: 12, indexerId: 3, releaseGuid: "…"}.',
    actions: {
      list: {
        readOnly: true,
        schema: { ...listShape, requesterUserId: z.number().int().optional() },
        run: async (i, { client }) => {
          const page = i.page ?? 1;
          const limit = i.limit ?? 20;
          const res = await client.get<BookRequestPage>("/admin/book-requests", {
            status: i.status,
            mediaKind: i.mediaKind,
            includeDismissed: i.includeDismissed,
            requesterUserId: i.requesterUserId,
            page,
            limit,
          });
          return ok(pagedRequests(res, page, limit));
        },
      },
      approve: {
        schema: {
          id: z.number().int().optional(),
          ids: z.array(z.number().int()).max(100).optional(),
          decisionNote: z.string().optional(),
          targetLibraryId: z.number().int().optional(),
        },
        run: async (i, { client }) => {
          if (i.ids?.length) {
            const r = await client.post<BookRequestBulkResult>(
              "/admin/book-requests/approve",
              { ids: i.ids },
            );
            return ok({ updated: r.updated.map(shapeRequest), failed: r.failed });
          }
          if (!i.id) throw new Error("approve needs id or ids");
          const body = stripUndef({
            decisionNote: i.decisionNote,
            targetLibraryId: i.targetLibraryId,
          });
          return ok(
            shapeRequest(
              await client.post<BookRequestItem>(
                `/admin/book-requests/${i.id}/approve`,
                body,
              ),
            ),
          );
        },
      },
      reject: {
        destructive: true,
        schema: {
          id: z.number().int().optional(),
          ids: z.array(z.number().int()).max(100).optional(),
          decisionNote: z.string().optional(),
        },
        summarize: (i) => `reject request(s) ${i.ids?.join(",") ?? i.id}`,
        run: async (i, { client }) => {
          if (i.ids?.length) {
            const r = await client.post<BookRequestBulkResult>(
              "/admin/book-requests/reject",
              {
                ids: i.ids,
                decisionNote: i.decisionNote,
              },
            );
            return ok({ updated: r.updated.map(shapeRequest), failed: r.failed });
          }
          if (!i.id) throw new Error("reject needs id or ids");
          return ok(
            shapeRequest(
              await client.post<BookRequestItem>(
                `/admin/book-requests/${i.id}/reject`,
                stripUndef({ decisionNote: i.decisionNote }),
              ),
            ),
          );
        },
      },
      search_releases: {
        readOnly: true,
        schema: {
          ...idShape,
          title: z.string().optional().describe("Override the search title."),
          authors: z.array(z.string()).optional(),
          isbn: z.string().optional(),
          language: z.string().optional(),
          preferredFormats: z.array(z.string()).optional(),
          refresh: z
            .boolean()
            .optional()
            .describe("With no overrides: false returns cached results."),
        },
        run: async (i, { client }) => {
          const { id, refresh, ...overrides } = i as any;
          delete overrides.action;
          delete overrides.confirm;
          const o = stripUndef(overrides);
          const res =
            Object.keys(o).length || refresh !== false
              ? await client.post(`/admin/book-requests/${id}/releases/search`, o)
              : await client.get(`/admin/book-requests/${id}/releases`);
          return ok(res);
        },
      },
      inspect_release: {
        readOnly: true,
        schema: { ...idShape, indexerId: z.number().int(), releaseGuid: z.string() },
        run: async (i, { client }) =>
          ok(
            await client.post(`/admin/book-requests/${i.id}/releases/inspect`, {
              indexerId: i.indexerId,
              releaseGuid: i.releaseGuid,
            }),
          ),
      },
      grab: {
        schema: {
          ...idShape,
          indexerId: z.number().int().optional(),
          releaseGuid: z.string().optional(),
          magnet: z.string().optional(),
          downloadClientId: z.number().int().optional(),
          holdForReview: z.boolean().optional(),
        },
        run: async (i, { client }) => {
          const { id, ...rest } = i as any;
          delete rest.action;
          delete rest.confirm;
          return ok(
            await client.post(`/admin/book-requests/${id}/grab`, stripUndef(rest)),
          );
        },
      },
      attempts: {
        readOnly: true,
        schema: idShape,
        run: async (i, { client }) =>
          ok(await client.get(`/admin/book-requests/${i.id}/attempts`)),
      },
      fulfill: {
        schema: {
          ...idShape,
          bookDockFileId: z.number().int().optional(),
          matchedBookId: z.number().int().optional(),
          note: z.string().optional(),
        },
        run: async (i, { client }) =>
          ok(
            await client.post(
              `/admin/book-requests/${i.id}/fulfill`,
              stripUndef({
                bookDockFileId: i.bookDockFileId,
                matchedBookId: i.matchedBookId,
                note: i.note,
              }),
            ),
          ),
      },
      force_file: {
        destructive: true,
        schema: idShape,
        summarize: (i) =>
          `file the held import for request #${i.id} into the library despite verification concerns`,
        run: async (i, { client }) =>
          ok(await client.post(`/admin/book-requests/${i.id}/force-file`)),
      },
      discard_import: {
        destructive: true,
        schema: idShape,
        summarize: (i) => `discard the held import for request #${i.id}`,
        run: async (i, { client }) =>
          ok(await client.post(`/admin/book-requests/${i.id}/discard-import`)),
      },
      remove_download: {
        destructive: true,
        schema: {
          ...idShape,
          downloadId: z.number().int(),
          deleteFiles: z.boolean().optional(),
        },
        summarize: (i) =>
          `remove download ${i.downloadId} of request #${i.id} from the download client${i.deleteFiles ? " and delete its files" : ""}`,
        run: async (i, { client }) =>
          ok(
            await client.post(
              `/admin/book-requests/${i.id}/downloads/${i.downloadId}/remove`,
              {
                deleteFiles: i.deleteFiles ?? false,
              },
            ),
          ),
      },
      delete: {
        destructive: true,
        schema: idShape,
        summarize: (i) => `permanently delete request #${i.id}`,
        run: async (i, { client }) => {
          await client.delete(`/admin/book-requests/${i.id}`);
          return ok({ deleted: i.id });
        },
      },
    },
  });
}
