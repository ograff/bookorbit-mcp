import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSeriesGapTools } from "../src/tools/series-gaps.js";
import { connect, mockBookOrbit } from "./helpers/harness.js";

const sse = (events: unknown[]) =>
  new Response(
    [
      `event: provider-status\ndata: ${JSON.stringify({ provider: "x", state: "done" })}\n\n`,
      ...events.map((e) => `data: ${JSON.stringify(e)}\n\n`),
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const c = (idx: string, title: string) => ({
  provider: "hardcover",
  providerId: "h" + idx,
  title,
  authors: ["James S. A. Corey"],
  seriesName: "The Expanse",
  seriesIndex: idx,
});

function routes(extra: Record<string, unknown> = {}) {
  return {
    "GET /series": {
      items: [{ id: 7, name: "The Expanse" }],
      total: 1,
      page: 0,
      size: 20,
    },
    "GET /series/7/books": {
      items: [{ seriesIndex: "1" }, { seriesIndex: "4" }],
      total: 2,
      seriesInfo: {
        id: 7,
        name: "The Expanse",
        authors: ["James S. A. Corey"],
        bookCount: 2,
        expectedBookCount: null,
        possibleGaps: [2, 3],
      },
    },
    "GET /metadata-fetch/stream": () =>
      sse([c("2", "Caliban's War"), c("3", "Abaddon's Gate")]),
    "POST /book-requests/availability": (call: any) =>
      call.body.items.map((i: any) =>
        i.title === "Abaddon's Gate"
          ? {
              ownedBookId: null,
              existingRequestId: 42,
              existingRequestStatus: "approved",
              alreadySubscribed: true,
            }
          : {
              ownedBookId: null,
              existingRequestId: null,
              existingRequestStatus: null,
              alreadySubscribed: false,
            },
      ),
    "POST /book-requests": { request: { id: 100 }, subscribed: false },
    ...extra,
  };
}

test("dry run (default) returns a plan and creates nothing", async () => {
  const mock = mockBookOrbit(routes());
  const { call } = await connect(registerSeriesGapTools, mock.client);
  const r = await call("fill_series_gaps", { series: "The Expanse" });
  assert.equal(r.data.dryRun, true);
  assert.deepEqual(
    r.data.plan.map((p: any) => [p.index, p.title, p.action]),
    [
      [2, "Caliban's War", "request"],
      [3, "Abaddon's Gate", "skip_already_requested"],
    ],
  );
  assert.equal(r.data.summary.wouldRequest, 1);
  assert.equal(
    mock.calls.some((x) => x.method === "POST" && x.path === "/book-requests"),
    false,
  );
});

test("dryRun:false creates only the executable requests", async () => {
  const mock = mockBookOrbit(routes());
  const { call } = await connect(registerSeriesGapTools, mock.client);
  const r = await call("fill_series_gaps", {
    series: 7,
    dryRun: false,
    targetLibraryId: 3,
  });
  assert.deepEqual(r.data.created, [
    { index: 2, title: "Caliban's War", mediaKind: "ebook", requestId: 100 },
  ]);
  const post = mock.calls.find(
    (x) => x.method === "POST" && x.path === "/book-requests",
  )!;
  assert.equal((post.body as any).targetLibraryId, 3);
  assert.equal((post.body as any).seriesIndex, 2);
});

test("a failing create is reported per row without aborting", async () => {
  const mock = mockBookOrbit(
    routes({
      "GET /metadata-fetch/stream": () => sse([c("2", "Caliban's War"), c("3", "Other")]),
      "POST /book-requests": () => {
        throw new Error("boom");
      },
    }),
  );
  const { call } = await connect(registerSeriesGapTools, mock.client);
  const r = await call("fill_series_gaps", { series: 7, dryRun: false });
  assert.equal(r.isError, false);
});

test("assumeTotal computes gaps beyond the highest owned volume", async () => {
  const mock = mockBookOrbit(routes());
  const { call } = await connect(registerSeriesGapTools, mock.client);
  const r = await call("fill_series_gaps", { series: 7, assumeTotal: 5 });
  assert.deepEqual(
    r.data.plan.map((p: any) => p.index),
    [2, 3, 5],
  );
});

test("empty gap list explains why when no total is known", async () => {
  const r0 = routes();
  (r0["GET /series/7/books"] as any).seriesInfo.possibleGaps = [];
  const mock = mockBookOrbit(r0);
  const { call } = await connect(registerSeriesGapTools, mock.client);
  const r = await call("fill_series_gaps", { series: 7 });
  assert.match(r.data.warnings[0], /assumeTotal/);
});

test("ambiguous series name asks for an id", async () => {
  const mock = mockBookOrbit(
    routes({
      "GET /series": {
        items: [
          { id: 1, name: "Expanse Short Stories" },
          { id: 2, name: "Expanse Extras" },
        ],
        total: 2,
      },
    }),
  );
  const { call } = await connect(registerSeriesGapTools, mock.client);
  const r = await call("fill_series_gaps", { series: "Expanse" });
  assert.equal(r.isError, true);
  assert.match(r.text, /numeric seriesId/);
});

test("scope:library summarizes series with gaps and never requests", async () => {
  const mock = mockBookOrbit({
    "GET /series": {
      items: [
        {
          id: 1,
          name: "A",
          gapCount: 2,
          gaps: [2, 3],
          ownedVolumeCount: 1,
          expectedBookCount: 3,
        },
      ],
      total: 1,
      size: 100,
    },
  });
  const { call } = await connect(registerSeriesGapTools, mock.client);
  const r = await call("fill_series_gaps", { scope: "library" });
  assert.equal(r.data.series[0].gapCount, 2);
  assert.match(mock.calls[0]!.path, /completionStatus=has_gaps/);
  assert.equal(
    mock.calls.some((x) => x.method === "POST"),
    false,
  );
});
