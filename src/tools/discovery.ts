import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BookCard, BookDetail, Library, SeriesSummary } from "@bookorbit/types";
import { registerActionTool, type ToolContext } from "./define.js";
import { fail, ok, page, pick } from "../util/format.js";

const pageShape = {
  page: z.number().int().min(0).optional().describe("0-based page number (default 0)."),
  size: z.number().int().min(1).max(100).optional().describe("Page size (default 25)."),
};
const pq = (i: { page?: number; size?: number }) => ({
  page: i.page ?? 0,
  size: i.size ?? 25,
});

/** A compact book row, tolerant of both the card and the search-result shapes. */
export function shapeBook(
  b: Partial<BookCard> & { libraryName?: string; formats?: (string | null)[] },
) {
  // Cards carry `files: [{format}]`; /books/search carries a top-level `formats: [..]`.
  const fromFiles = (b.files ?? []).map((f) => f.format);
  const formats = [
    ...new Set(
      [...fromFiles, ...(b.formats ?? [])]
        .map((f) => f?.toLowerCase())
        .filter((f): f is string => Boolean(f)),
    ),
  ];
  return {
    ...pick(b, [
      "id",
      "title",
      "seriesId",
      "seriesName",
      "libraryId",
      "libraryName",
      "readStatus",
    ]),
    ...(b.authors?.length ? { authors: b.authors } : {}),
    ...(b.seriesIndex != null ? { seriesIndex: b.seriesIndex } : {}),
    ...(formats.length ? { formats } : {}),
  };
}

export function shapeBookDetail(b: BookDetail) {
  return {
    ...pick(b, [
      "id",
      "title",
      "subtitle",
      "libraryId",
      "libraryName",
      "status",
      "seriesId",
      "seriesName",
      "seriesIndex",
      "publisher",
      "publishedYear",
      "language",
      "pageCount",
      "isbn10",
      "isbn13",
      "rating",
      "readStatus",
      "metadataScore",
      "lockedFields",
    ]),
    description: b.description?.slice(0, 1000),
    authors: b.authors?.map((a) => ({ id: a.id, name: a.name })),
    genres: b.genres,
    tags: b.tags,
    collections: b.collections,
    providerIds: b.providerIds,
    customMetadata: b.customMetadata,
    files: b.files?.map((f) => ({
      ...pick(f, ["id", "format", "role", "sizeBytes", "filename", "durationSeconds"]),
      mediaOverlay: f.mediaOverlay?.available ?? undefined,
    })),
    readAloudSync: b.readAloudSync?.state,
  };
}

const shapeSeries = (s: SeriesSummary) => ({
  ...pick(s, [
    "id",
    "name",
    "bookCount",
    "ownedVolumeCount",
    "expectedBookCount",
    "gapCount",
    "nextBookId",
  ]),
  authors: s.authors,
  libraries: s.libraryNames,
  gapsPreview: s.gaps,
});

export function registerDiscoveryTools(server: McpServer, ctx: ToolContext) {
  const { client } = ctx;

  server.registerTool(
    "search_books",
    {
      title: "Search books",
      description:
        'Find books in the library by title, author or series. Use this first to get a bookId for any other tool. Example: {q: "Dune", limit: 5}.',
      inputSchema: {
        q: z.string().min(1).describe("Search text."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max results (default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ q, limit }) => {
      try {
        const res = await client.get<Partial<BookCard>[]>("/books/search", { q, limit });
        return ok({ items: (res ?? []).map(shapeBook) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_book",
    {
      title: "Get book detail",
      description:
        "Full detail for one book: metadata, files (file IDs for epub/audio, needed by read_aloud), collections and which metadata fields are locked. Example: {bookId: 42}.",
      inputSchema: { bookId: z.number().int().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ bookId }) => {
      try {
        return ok(shapeBookDetail(await client.get<BookDetail>(`/books/${bookId}`)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerActionTool(server, ctx, {
    title: "Browse the library",
    name: "browse",
    description:
      "Read-only browsing of series, authors, libraries, collections and smart scopes. Use *_books actions with the id from the list action. " +
      "Fields: q (filter text, series/authors), id (series/author/collection/smart scope id), completionStatus (series: not_started|in_progress|complete|has_gaps), libraryId, page, size. " +
      'Example: {action: "series", q: "Expanse", completionStatus: "has_gaps"}.',
    actions: {
      series: {
        readOnly: true,
        schema: {
          q: z.string().optional(),
          libraryId: z.number().int().optional(),
          completionStatus: z
            .enum(["not_started", "in_progress", "complete", "has_gaps"])
            .optional(),
          ...pageShape,
        },
        run: async (i, { client }) =>
          ok(
            page(
              await client.get<any>("/series", {
                q: i.q,
                libraryId: i.libraryId,
                completionStatus: i.completionStatus,
                ...pq(i),
              }),
              shapeSeries,
            ),
          ),
      },
      series_books: {
        readOnly: true,
        schema: { id: z.number().int().describe("Series id."), ...pageShape },
        run: async (i, { client }) => {
          const res = await client.get<any>(`/series/${i.id}/books`, pq(i));
          return ok({
            series: pick(res.seriesInfo, [
              "id",
              "name",
              "bookCount",
              "expectedBookCount",
              "possibleGaps",
            ]),
            ...page(res, shapeBook),
          });
        },
      },
      authors: {
        readOnly: true,
        schema: {
          q: z.string().optional(),
          libraryId: z.number().int().optional(),
          ...pageShape,
        },
        run: async (i, { client }) =>
          ok(
            page(
              await client.get<any>("/authors", {
                q: i.q,
                libraryId: i.libraryId,
                ...pq(i),
              }),
              (a: any) => pick(a, ["id", "name", "bookCount"]),
            ),
          ),
      },
      author_books: {
        readOnly: true,
        schema: { id: z.number().int().describe("Author id."), ...pageShape },
        run: async (i, { client }) =>
          ok(page(await client.get<any>(`/authors/${i.id}/books`, pq(i)), shapeBook)),
      },
      libraries: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) => {
          const libs = await client.get<Library[]>("/libraries");
          return ok({
            items: libs.map((l) =>
              pick(l, ["id", "name", "organizationMode", "allowedFormats", "watch"]),
            ),
          });
        },
      },
      collections: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) => {
          const res = await client.get<any[]>("/collections");
          return ok({
            items: res.map((c) => pick(c, ["id", "name", "description", "bookCount"])),
          });
        },
      },
      collection_books: {
        readOnly: true,
        schema: {
          id: z.number().int().describe("Collection id."),
          q: z.string().optional(),
          ...pageShape,
        },
        run: async (i, { client }) =>
          ok(
            page(
              await client.get<any>(`/collections/${i.id}/books`, { q: i.q, ...pq(i) }),
              shapeBook,
            ),
          ),
      },
      smart_scopes: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) => {
          const res = await client.get<any[]>("/smart-scopes");
          return ok({ items: res.map((s) => pick(s, ["id", "name", "description"])) });
        },
      },
      smart_scope_books: {
        readOnly: true,
        schema: { id: z.number().int().describe("Smart scope id."), ...pageShape },
        run: async (i, { client }) =>
          ok(
            page(await client.get<any>(`/smart-scopes/${i.id}/books`, pq(i)), shapeBook),
          ),
      },
    },
  });
}
