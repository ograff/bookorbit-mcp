import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BOOK_METADATA_LOCK_FIELDS,
  type BookDetail,
  type MetadataCandidate,
} from "@bookorbit/types";
import type { BookOrbitClient } from "../client/bookorbit.js";
import { registerActionTool, type ToolContext } from "./define.js";
import { shapeBookDetail } from "./discovery.js";
import { fail, ok, pick } from "../util/format.js";

const strip = (o: Record<string, unknown>): Record<string, any> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const LOCK_FIELD = z.enum(BOOK_METADATA_LOCK_FIELDS as unknown as [string, ...string[]]);

/** Provider key -> the id field BookOrbit stores it under. */
const PROVIDER_ID_FIELD: Record<string, string> = {
  google: "googleBooksId",
  goodreads: "goodreadsId",
  amazon: "amazonId",
  hardcover: "hardcoverId",
  openLibrary: "openLibraryId",
  itunes: "itunesId",
  audible: "audibleId",
  librofm: "librofmId",
  kobo: "koboId",
  comicvine: "comicvineId",
  ranobedb: "ranobedbId",
  lubimyczytac: "lubimyczytacId",
  aladin: "aladinId",
};

const APPLY_FIELDS = [
  "title",
  "subtitle",
  "authors",
  "description",
  "publisher",
  "publishedYear",
  "language",
  "pageCount",
  "isbn10",
  "isbn13",
  "series",
  "genres",
  "providerId",
] as const;

export function shapeCandidate(c: MetadataCandidate, n: number) {
  return {
    n,
    ...pick(c, [
      "provider",
      "providerId",
      "title",
      "subtitle",
      "publisher",
      "publishedYear",
      "language",
      "pageCount",
      "isbn13",
      "seriesName",
      "seriesIndex",
      "seriesTotalBooks",
    ]),
    ...(c.authors?.length ? { authors: c.authors } : {}),
    ...(c.narrators?.length ? { narrators: c.narrators } : {}),
    ...(c.description ? { description: c.description.slice(0, 200) } : {}),
  };
}

interface SearchInput {
  bookId?: number;
  title?: string;
  author?: string;
  isbn?: string;
  mediaKind?: "ebook" | "audiobook";
  providers?: string[];
  limit?: number;
}

async function searchCandidates(client: BookOrbitClient, i: SearchInput) {
  if (!i.bookId && !i.title && !i.author && !i.isbn) {
    throw new Error("Give a bookId, title, author or isbn to search for.");
  }
  const res = await client.sse<MetadataCandidate>("/metadata-fetch/stream", {
    bookId: i.bookId,
    title: i.title,
    author: i.author,
    isbn: i.isbn,
    mediaKind: i.mediaKind,
    providers: i.providers,
    resultsPerProvider: 5,
  });
  const limit = i.limit ?? 15;
  return {
    total: res.length,
    candidates: res.slice(0, limit).map((c, n) => shapeCandidate(c, n + 1)),
  };
}

const searchShape = {
  title: z.string().optional(),
  author: z.string().optional(),
  isbn: z.string().optional(),
  mediaKind: z.enum(["ebook", "audiobook"]).optional(),
  providers: z.array(z.string()).optional().describe("Restrict to these provider keys."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max candidates (default 15)."),
};

/** Build the PATCH body for the chosen fields from one candidate. */
export function buildApplyBody(c: MetadataCandidate, fields: readonly string[]) {
  const body: Record<string, unknown> = {};
  const skipped: string[] = [];
  const set = (field: string, key: string, v: unknown) => {
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0))
      skipped.push(field);
    else body[key] = v;
  };
  for (const f of fields) {
    switch (f) {
      case "series":
        if (c.seriesName) {
          body.seriesName = c.seriesName;
          if (c.seriesIndex !== undefined) body.seriesIndex = c.seriesIndex;
        } else skipped.push("series");
        break;
      case "providerId": {
        const key = PROVIDER_ID_FIELD[c.provider];
        if (key) body[key] = c.providerId;
        else skipped.push("providerId");
        break;
      }
      case "authors":
        set(f, "authors", c.authors);
        break;
      case "genres":
        set(f, "genres", c.genres);
        break;
      default:
        set(f, f, (c as unknown as Record<string, unknown>)[f]);
    }
  }
  return { body, skipped };
}

export function registerMetadataTools(server: McpServer, ctx: ToolContext) {
  const { client } = ctx;

  server.registerTool(
    "metadata_lookup",
    {
      title: "Look up metadata",
      description:
        "Search the configured metadata providers (Hardcover, Google, Open Library, …) for candidate records. Use it to identify a book or find series/ISBN data; results are numbered and carry provider+providerId for book_metadata apply or requests create. " +
        'Example: {title: "Leviathan Wakes", author: "Corey"}.',
      inputSchema: {
        bookId: z
          .number()
          .int()
          .optional()
          .describe("Search using this book's own data."),
        ...searchShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (i) => {
      try {
        return ok(await searchCandidates(client, i));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerActionTool(server, ctx, {
    name: "book_metadata",
    title: "Book metadata",
    description:
      "Fetch and apply provider metadata for one book, lock fields so refreshes won't overwrite them, and set custom fields. " +
      "fetch_candidates lists matches; apply writes only the fields you list (from provider+providerId); refresh_preview/refresh show/apply BookOrbit's own automatic best match. " +
      `Lockable fields: ${BOOK_METADATA_LOCK_FIELDS.join(", ")}. ` +
      'Example: {action: "apply", bookId: 42, provider: "hardcover", providerId: "123", fields: ["title","series","isbn13"]}.',
    actions: {
      fetch_candidates: {
        readOnly: true,
        schema: { bookId: z.number().int().min(1), ...searchShape },
        run: async (i, { client }) => ok(await searchCandidates(client, i)),
      },
      refresh_preview: {
        readOnly: true,
        schema: { bookId: z.number().int().min(1) },
        run: async (i, { client }) =>
          ok(
            await client.post(`/books/${i.bookId}/refresh-metadata`, undefined, {
              preview: true,
            }),
          ),
      },
      refresh: {
        schema: { bookId: z.number().int().min(1) },
        run: async (i, { client }) => {
          const res = await client.post<BookDetail>(
            `/books/${i.bookId}/refresh-metadata`,
          );
          return ok(shapeBookDetail(res));
        },
      },
      apply: {
        schema: {
          bookId: z.number().int().min(1),
          provider: z.string().describe("Provider key from a candidate."),
          providerId: z.string().describe("Provider record id from a candidate."),
          fields: z
            .array(z.enum(APPLY_FIELDS))
            .min(1)
            .describe("Exactly which fields to overwrite."),
        },
        run: async (i, { client }) => {
          const cand = await client.get<MetadataCandidate | null>(
            "/metadata-fetch/lookup",
            {
              provider: i.provider,
              id: i.providerId,
            },
          );
          if (!cand)
            throw new Error(`Provider ${i.provider} has no record ${i.providerId}.`);
          const { body, skipped } = buildApplyBody(cand, i.fields);
          if (Object.keys(body).length === 0) {
            throw new Error(`That record has no data for: ${i.fields.join(", ")}.`);
          }
          const res = await client.patch<BookDetail>(`/books/${i.bookId}/metadata`, body);
          return ok({
            applied: Object.keys(body),
            skippedNoData: skipped.length ? skipped : undefined,
            book: shapeBookDetail(res),
          });
        },
      },
      lock_fields: {
        schema: { bookId: z.number().int().min(1), fields: z.array(LOCK_FIELD).min(1) },
        run: async (i, { client }) => {
          const book = await client.get<BookDetail>(`/books/${i.bookId}`);
          const next = [...new Set([...(book.lockedFields ?? []), ...i.fields])];
          await client.patch(`/books/${i.bookId}/metadata-locks`, { lockedFields: next });
          return ok({ bookId: i.bookId, lockedFields: next });
        },
      },
      unlock_fields: {
        schema: { bookId: z.number().int().min(1), fields: z.array(LOCK_FIELD).min(1) },
        run: async (i, { client }) => {
          const book = await client.get<BookDetail>(`/books/${i.bookId}`);
          const drop = new Set<string>(i.fields);
          const next = (book.lockedFields ?? []).filter((f) => !drop.has(f));
          await client.patch(`/books/${i.bookId}/metadata-locks`, { lockedFields: next });
          return ok({ bookId: i.bookId, lockedFields: next });
        },
      },
      custom_fields: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) =>
          ok(await client.get("/custom-metadata/fields/active")),
      },
      set_custom: {
        schema: {
          bookId: z.number().int().min(1),
          values: z
            .array(z.object({ fieldId: z.number().int().min(1), value: z.unknown() }))
            .min(1)
            .describe("fieldId from custom_fields; value must match the field's type."),
        },
        run: async (i, { client }) => {
          const res = await client.patch<BookDetail>(
            `/books/${i.bookId}/metadata`,
            strip({ customMetadata: i.values }),
          );
          return ok({ customMetadata: res.customMetadata });
        },
      },
    },
  });

  registerActionTool(server, ctx, {
    name: "metadata_bulk",
    title: "Bulk metadata fetch runs",
    description:
      "Control BookOrbit's background metadata-fetch runs over many books (needs manage_metadata_config). status shows the queue; preview_count/preview_books show what a run would touch (default: the configured conditions); run/run_library queue it; pause/resume/cancel/retry_failed manage the queue; failed lists errors. " +
      "cancel needs confirm. A run overwrites unlocked fields on every matched book, so preview first. " +
      'Example: {action: "preview_count"} then {action: "run_library", libraryId: 2}.',
    actions: {
      status: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) =>
          ok(await client.get("/book-metadata-fetch/status")),
      },
      preview_count: {
        readOnly: true,
        schema: {
          libraryId: z.number().int().optional(),
          conditions: z
            .record(z.unknown())
            .optional()
            .describe("Override the configured conditions."),
        },
        run: async (i, { client }) => {
          const conditions = i.conditions ?? (await effectiveConditions(client));
          return ok(
            await client.post(
              "/book-metadata-fetch/preview-count",
              strip({ conditions, libraryId: i.libraryId }),
            ),
          );
        },
      },
      preview_books: {
        readOnly: true,
        schema: {
          libraryIds: z.array(z.number().int()).optional(),
          limit: z.number().int().min(1).max(24).optional(),
          conditions: z.record(z.unknown()).optional(),
        },
        run: async (i, { client }) => {
          const conditions = i.conditions ?? (await effectiveConditions(client));
          return ok(
            await client.post(
              "/book-metadata-fetch/preview-books",
              strip({ conditions, libraryIds: i.libraryIds, limit: i.limit }),
            ),
          );
        },
      },
      run: {
        schema: { ignoreCache: z.boolean().optional() },
        run: async (i, { client }) =>
          ok(
            await client.post("/book-metadata-fetch/run", {
              ignoreCache: i.ignoreCache === true,
            }),
          ),
      },
      run_library: {
        schema: { libraryId: z.number().int(), ignoreCache: z.boolean().optional() },
        run: async (i, { client }) =>
          ok(
            await client.post(`/book-metadata-fetch/run/${i.libraryId}`, {
              ignoreCache: i.ignoreCache === true,
            }),
          ),
      },
      pause: {
        schema: {},
        run: async (_i, { client }) =>
          ok(await client.post("/book-metadata-fetch/pause")),
      },
      resume: {
        schema: {},
        run: async (_i, { client }) =>
          ok(await client.post("/book-metadata-fetch/resume")),
      },
      cancel: {
        destructive: true,
        schema: {},
        summarize: async (_i, { client }) => ({
          effect:
            "drops all queued (not yet processed) books from the metadata-fetch queue",
          queue: await client.get("/book-metadata-fetch/status"),
        }),
        run: async (_i, { client }) =>
          ok(await client.post("/book-metadata-fetch/cancel")),
      },
      failed: {
        readOnly: true,
        schema: {
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        run: async (i, { client }) =>
          ok(
            await client.get("/book-metadata-fetch/failed", {
              page: i.page ?? 1,
              limit: i.limit ?? 20,
            }),
          ),
      },
      retry_failed: {
        schema: {},
        run: async (_i, { client }) =>
          ok(await client.post("/book-metadata-fetch/retry-failed")),
      },
    },
  });
}

async function effectiveConditions(client: BookOrbitClient) {
  const cfg = await client.get<{ conditions?: unknown }>("/book-metadata-fetch/config");
  if (!cfg?.conditions)
    throw new Error("Could not read the configured fetch conditions; pass `conditions`.");
  return cfg.conditions;
}
