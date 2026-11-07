import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./define.js";
import type { BookOrbitClient } from "../client/bookorbit.js";
import {
  buildPlan,
  buildRequestCalls,
  gapsAgainstTotal,
  normalizeName,
  type Availability,
  type Candidate,
  type GapPlanRow,
  type MediaKind,
  type SeriesContext,
} from "../series-gaps/plan.js";
import { fail, ok } from "../util/format.js";
import { submitWithDestination } from "./destination.js";

interface SeriesPage {
  items: { seriesIndex?: string | number | null }[];
  total: number;
  seriesInfo: {
    id: number;
    name: string;
    authors?: string[];
    bookCount: number;
    expectedBookCount: number | null;
    possibleGaps: number[];
  };
}

async function resolveSeriesId(
  client: BookOrbitClient,
  series: string | number,
): Promise<number> {
  if (typeof series === "number") return series;
  if (/^\d+$/.test(series.trim())) return Number(series.trim());
  const res = await client.get<{ items: { id: number; name: string }[] }>("/series", {
    q: series,
    page: 0,
    size: 20,
  });
  const want = normalizeName(series);
  const exact = res.items.filter((s) => normalizeName(s.name) === want);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length === 0 && res.items.length === 1) return res.items[0]!.id;
  const names = res.items.map((s) => `${s.id}: ${s.name}`).join("; ");
  throw new Error(
    res.items.length === 0
      ? `No series matches "${series}".`
      : `"${series}" matches several series; pass the numeric seriesId. Candidates: ${names}`,
  );
}

async function loadSeries(client: BookOrbitClient, id: number, assumeTotal?: number) {
  const first = await client.get<SeriesPage>(`/series/${id}/books`, {
    page: 0,
    size: 100,
  });
  let items = first.items;
  if (assumeTotal) {
    for (let page = 1; items.length < first.total && page < 20; page++) {
      const next = await client.get<SeriesPage>(`/series/${id}/books`, {
        page,
        size: 100,
      });
      items = items.concat(next.items);
    }
  }
  return { info: first.seriesInfo, owned: items };
}

function kindsOf(mediaKind: "ebook" | "audiobook" | "both"): MediaKind[] {
  return mediaKind === "both" ? ["ebook", "audiobook"] : [mediaKind];
}

function tableRow(r: GapPlanRow) {
  return {
    index: r.index,
    title: r.title,
    confidence: r.confidence,
    existing: r.existing.length ? r.existing : undefined,
    action: r.action,
    wouldRequest: r.requestKinds.length ? r.requestKinds : undefined,
    note: r.note,
  };
}

async function libraryScan(client: BookOrbitClient, libraryId?: number) {
  const rows: unknown[] = [];
  let total = 0;
  for (let page = 0; page < 10; page++) {
    const res = await client.get<{ items: any[]; total: number; size: number }>(
      "/series",
      {
        completionStatus: "has_gaps",
        libraryId,
        page,
        size: 100,
      },
    );
    total = res.total;
    for (const s of res.items) {
      rows.push({
        seriesId: s.id,
        name: s.name,
        authors: s.authors,
        owned: s.ownedVolumeCount,
        expectedBookCount: s.expectedBookCount,
        gapCount: s.gapCount,
        gapsPreview: s.gaps,
      });
    }
    if ((page + 1) * res.size >= res.total) break;
  }
  return {
    scope: "library",
    seriesWithGaps: total,
    shown: rows.length,
    note: "Summary only: nothing was requested. Run fill_series_gaps with a seriesId to plan/create requests for one series.",
    series: rows,
  };
}

export function registerSeriesGapTools(server: McpServer, ctx: ToolContext) {
  const { client } = ctx;
  server.registerTool(
    "fill_series_gaps",
    {
      title: "Fill series gaps",
      description:
        "Find volumes missing from a series you own and (optionally) request them. Defaults to a dry run that returns a plan table (index, resolved title, confidence, existing request, action); set dryRun:false to create the requests. " +
        "scope:'library' only summarizes every series with gaps and never requests. BookOrbit can only detect gaps past your highest volume if it knows the series total; pass assumeTotal to supply it. " +
        'Example: {series: "The Expanse", mediaKind: "both", dryRun: true}.',
      inputSchema: {
        series: z
          .union([z.number().int(), z.string()])
          .optional()
          .describe("Series id, or a series name to resolve (scope 'series')."),
        scope: z.enum(["series", "library"]).optional().describe("Default 'series'."),
        libraryId: z
          .number()
          .int()
          .optional()
          .describe("With scope 'library': limit to one library."),
        mediaKind: z
          .enum(["ebook", "audiobook", "both"])
          .optional()
          .describe("Default 'ebook'."),
        targetLibraryId: z
          .number()
          .int()
          .optional()
          .describe("Destination library for new requests."),
        assumeTotal: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Treat the series as having this many volumes (overrides BookOrbit's gap list).",
          ),
        minConfidence: z
          .enum(["high", "medium"])
          .optional()
          .describe("Lowest confidence that is auto-requested (default 'medium')."),
        dryRun: z.boolean().optional().describe("Default true. false creates requests."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if ((args.scope ?? "series") === "library") {
          return ok(await libraryScan(client, args.libraryId));
        }
        if (args.series === undefined)
          return fail("Provide `series` (id or name), or scope:'library'.");

        const dryRun = args.dryRun ?? true;
        const kinds = kindsOf(args.mediaKind ?? "ebook");
        const seriesId = await resolveSeriesId(client, args.series);
        const { info, owned } = await loadSeries(client, seriesId, args.assumeTotal);
        const series: SeriesContext = { name: info.name, authors: info.authors ?? [] };

        const gaps = args.assumeTotal
          ? gapsAgainstTotal(
              owned.map((b) => b.seriesIndex),
              args.assumeTotal,
            )
          : info.possibleGaps;

        const warnings: string[] = [];
        if (gaps.length === 0) {
          warnings.push(
            info.expectedBookCount == null
              ? "No gaps found, and BookOrbit has no total for this series, so it can only see holes between volumes you own. Pass assumeTotal to check beyond your highest volume."
              : "No gaps: every volume up to the expected total is owned (or the series has unnumbered/non-integer entries BookOrbit can't compare).",
          );
        }

        const mediaKindParams =
          kinds.length === 2
            ? { mediaKinds: ["ebook", "audiobook"] }
            : { mediaKind: kinds[0] };
        const search = (title: string) =>
          client.sse<Candidate>("/metadata-fetch/stream", {
            title,
            author: series.authors[0],
            resultsPerProvider: 20,
            ...mediaKindParams,
          });

        const rows = await buildPlan(
          {
            searchSeries: () => search(series.name),
            searchIndex: (index) => search(`${series.name} ${index}`),
            checkAvailability: async (title, author, candidate, ks) => {
              const res = await client.post<Availability[]>(
                "/book-requests/availability",
                {
                  items: ks.map((mediaKind) => ({
                    title,
                    mediaKind,
                    author,
                    isbn13: candidate.isbn13,
                    providerKey: candidate.provider,
                    providerId: candidate.providerId,
                  })),
                },
              );
              return res;
            },
          },
          { series, gaps, kinds, minConfidence: args.minConfidence ?? "medium" },
        );

        const calls = buildRequestCalls(rows, series, kinds, args.targetLibraryId);
        const summary = {
          gaps: gaps.length,
          wouldRequest: calls.length,
          needsReview: rows.filter((r) => r.action === "needs_review").length,
          unresolved: rows.filter((r) => r.action === "unresolved").length,
          skipped: rows.filter((r) => r.action.startsWith("skip")).length,
        };
        const base = {
          series: {
            id: seriesId,
            name: info.name,
            owned: info.bookCount,
            expected: info.expectedBookCount,
          },
          mediaKind: kinds.length === 2 ? "both" : kinds[0],
          plan: rows.map(tableRow),
          summary,
          warnings: warnings.length ? warnings : undefined,
        };
        if (dryRun) {
          return ok({
            dryRun: true,
            ...base,
            note: "Nothing was requested. Re-run with dryRun:false to create the 'request' rows. needs_review/unresolved rows are never auto-requested; use `requests` create for those.",
          });
        }

        const results: unknown[] = [];
        for (const call of calls) {
          try {
            const res = await submitWithDestination(client, (defaults) => {
              const body = applyDefaults(call.body, call, defaults);
              return client.post<any>(
                call.kind === "pair" ? "/book-requests/pairs" : "/book-requests",
                body,
              );
            });
            results.push(
              call.kind === "pair"
                ? {
                    index: call.index,
                    title: call.title,
                    ebookRequestId: res.ebook?.request?.id,
                    audiobookRequestId: res.audiobook?.request?.id,
                  }
                : {
                    index: call.index,
                    title: call.title,
                    mediaKind: call.mediaKind,
                    requestId: res.request?.id,
                    subscribedToExisting: res.subscribed || undefined,
                  },
            );
          } catch (err) {
            results.push({
              index: call.index,
              title: call.title,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return ok({ dryRun: false, ...base, created: results });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** Fill in BookOrbit's default destination where the plan didn't name a target library. */
function applyDefaults(
  body: Record<string, unknown>,
  call: { kind: "single" | "pair"; mediaKind?: MediaKind },
  defaults?: Record<MediaKind, { libraryId: number | null; folderId: number | null }>,
): Record<string, unknown> {
  if (!defaults) return body;
  const dest = (kind: MediaKind) =>
    defaults[kind].libraryId
      ? {
          targetLibraryId: defaults[kind].libraryId,
          ...(defaults[kind].folderId ? { targetFolderId: defaults[kind].folderId } : {}),
        }
      : {};
  if (call.kind === "pair") {
    const half = (kind: MediaKind) => {
      const existing = (body[kind] ?? {}) as Record<string, unknown>;
      return existing.targetLibraryId ? existing : { ...existing, ...dest(kind) };
    };
    return { ...body, ebook: half("ebook"), audiobook: half("audiobook") };
  }
  return body.targetLibraryId ? body : { ...body, ...dest(call.mediaKind!) };
}
