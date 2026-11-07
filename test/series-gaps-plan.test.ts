import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorsOverlap,
  buildPlan,
  buildRequestCalls,
  gapsAgainstTotal,
  integerIndex,
  normalizeName,
  resolveGap,
  scoreCandidate,
  type Availability,
  type Candidate,
  type MediaKind,
  type PlanDeps,
} from "../src/series-gaps/plan.js";

const series = { name: "The Expanse", authors: ["James S. A. Corey"] };

const cand = (over: Partial<Candidate> & { idx?: string }): Candidate => ({
  provider: "hardcover",
  providerId: "p" + Math.random(),
  title: "Caliban's War",
  authors: ["James S. A. Corey"],
  seriesName: "The Expanse",
  seriesIndex: "2",
  ...over,
});

test("normalizeName strips articles, accents, punctuation and suffix words", () => {
  assert.equal(normalizeName("The Expanse"), "expanse");
  assert.equal(normalizeName("Expanse Series"), "expanse");
  assert.equal(normalizeName("Les Misérables!"), "les miserables");
  assert.equal(normalizeName("Dungeon Crawler Carl (Series)"), "dungeon crawler carl");
  assert.equal(normalizeName(undefined), "");
});

test("integerIndex only accepts whole numbers", () => {
  assert.equal(integerIndex("3"), 3);
  assert.equal(integerIndex(" 4 "), 4);
  assert.equal(integerIndex("1.5"), null);
  assert.equal(integerIndex("Omnibus"), null);
  assert.equal(integerIndex(undefined), null);
  assert.equal(integerIndex(2), 2);
});

test("authorsOverlap compares last names, ignoring initials/punctuation", () => {
  assert.equal(authorsOverlap(["James S. A. Corey"], ["Corey, James"]), true);
  assert.equal(authorsOverlap(["Daniel Abraham"], ["James S. A. Corey"]), false);
});

test("scoreCandidate: exact name + index + author = high", () => {
  assert.equal(scoreCandidate(cand({}), 2, series).confidence, "high");
});

test("scoreCandidate: wrong index is ineligible", () => {
  assert.equal(scoreCandidate(cand({ seriesIndex: "3" }), 2, series).confidence, "none");
  assert.equal(
    scoreCandidate(cand({ seriesIndex: "2.5" }), 2, series).confidence,
    "none",
  );
  assert.equal(
    scoreCandidate(cand({ seriesIndex: undefined }), 2, series).confidence,
    "none",
  );
});

test("scoreCandidate: partial series name = medium", () => {
  const c = cand({ seriesName: "The Expanse Novels Collection" });
  assert.equal(scoreCandidate(c, 2, series).confidence, "medium");
});

test("scoreCandidate: different series name or author = low", () => {
  assert.equal(
    scoreCandidate(cand({ seriesName: "Foundation" }), 2, series).confidence,
    "low",
  );
  const a = scoreCandidate(cand({ authors: ["Someone Else"] }), 2, series);
  assert.equal(a.confidence, "low");
  assert.match(a.note!, /author/);
});

test("scoreCandidate: unknown candidate authors or series authors does not penalize", () => {
  assert.equal(scoreCandidate(cand({ authors: [] }), 2, series).confidence, "high");
  assert.equal(
    scoreCandidate(cand({ authors: ["X Y"] }), 2, { name: "The Expanse", authors: [] })
      .confidence,
    "high",
  );
});

test("scoreCandidate: uses seriesMemberships when the primary series differs", () => {
  const c = cand({
    seriesName: "Omnibus Line",
    seriesIndex: "9",
    seriesMemberships: [{ seriesName: "The Expanse", seriesIndex: "2" }],
  });
  assert.equal(scoreCandidate(c, 2, series).confidence, "high");
});

test("resolveGap prefers the highest confidence and an ISBN", () => {
  const low = cand({ seriesName: "Foundation", title: "Wrong" });
  const noIsbn = cand({ providerId: "a" });
  const withIsbn = cand({ providerId: "b", isbn13: "9780316129060" });
  const r = resolveGap([low, noIsbn, withIsbn], 2, series)!;
  assert.equal(r.confidence, "high");
  assert.equal(r.candidate.providerId, "b");
});

test("resolveGap: same work from several providers is not ambiguous", () => {
  const r = resolveGap(
    [
      cand({ provider: "hardcover" }),
      cand({ provider: "openlibrary", title: "Caliban’s War" }),
    ],
    2,
    series,
  )!;
  assert.equal(r.confidence, "high");
});

test("resolveGap: different titles claiming one index are capped to low", () => {
  const r = resolveGap(
    [cand({ title: "Caliban's War" }), cand({ title: "Totally Other Book" })],
    2,
    series,
  )!;
  assert.equal(r.confidence, "low");
  assert.match(r.note!, /ambiguous/);
});

test("resolveGap returns null when nothing claims the index", () => {
  assert.equal(resolveGap([cand({ seriesIndex: "5" })], 2, series), null);
  assert.equal(resolveGap([], 2, series), null);
});

function deps(over: {
  pool?: Candidate[];
  perIndex?: Record<number, Candidate[]>;
  avail?: (title: string, kinds: MediaKind[]) => Availability[];
}): PlanDeps & { searched: number[]; checked: string[] } {
  const searched: number[] = [];
  const checked: string[] = [];
  return {
    searched,
    checked,
    searchSeries: async () => over.pool ?? [],
    searchIndex: async (i) => {
      searched.push(i);
      return over.perIndex?.[i] ?? [];
    },
    checkAvailability: async (title, _a, _c, kinds) => {
      checked.push(title);
      return (
        over.avail?.(title, kinds) ??
        kinds.map(() => ({
          ownedBookId: null,
          existingRequestId: null,
          existingRequestStatus: null,
        }))
      );
    },
  };
}

const opts = (gaps: number[], kinds: MediaKind[] = ["ebook"]) => ({
  series,
  gaps,
  kinds,
  minConfidence: "medium" as const,
});

test("plan: requests resolved, unowned gaps and sorts/dedupes indexes", async () => {
  const d = deps({
    pool: [
      cand({ seriesIndex: "2", title: "Caliban's War" }),
      cand({ seriesIndex: "3", title: "Abaddon's Gate" }),
    ],
  });
  const rows = await buildPlan(d, opts([3, 2, 2]));
  assert.deepEqual(
    rows.map((r) => [r.index, r.title, r.action]),
    [
      [2, "Caliban's War", "request"],
      [3, "Abaddon's Gate", "request"],
    ],
  );
  assert.deepEqual(d.searched, []);
});

test("plan: falls back to a per-index search when the series search misses", async () => {
  const d = deps({
    pool: [],
    perIndex: { 4: [cand({ seriesIndex: "4", title: "Cibola Burn" })] },
  });
  const rows = await buildPlan(d, opts([4]));
  assert.equal(rows[0]!.title, "Cibola Burn");
  assert.deepEqual(d.searched, [4]);
});

test("plan: unresolved when nothing claims the index", async () => {
  const rows = await buildPlan(deps({}), opts([7]));
  assert.equal(rows[0]!.action, "unresolved");
  assert.deepEqual(rows[0]!.requestKinds, []);
});

test("plan: low confidence needs review and never checks availability", async () => {
  const d = deps({ pool: [cand({ seriesName: "Foundation", seriesIndex: "2" })] });
  const rows = await buildPlan(d, opts([2]));
  assert.equal(rows[0]!.action, "needs_review");
  assert.equal(d.checked.length, 0);
});

test("plan: minConfidence=high turns a medium match into needs_review", async () => {
  const d = deps({ pool: [cand({ seriesName: "The Expanse Novels Collection" })] });
  const rows = await buildPlan(d, { ...opts([2]), minConfidence: "high" });
  assert.equal(rows[0]!.confidence, "medium");
  assert.equal(rows[0]!.action, "needs_review");
});

test("plan: skips owned and already-requested", async () => {
  const d = deps({
    pool: [
      cand({ seriesIndex: "2", title: "Two" }),
      cand({ seriesIndex: "3", title: "Three" }),
    ],
    avail: (title) => [
      title === "Two"
        ? { ownedBookId: 11, existingRequestId: null, existingRequestStatus: null }
        : { ownedBookId: null, existingRequestId: 5, existingRequestStatus: "approved" },
    ],
  });
  const rows = await buildPlan(d, opts([2, 3]));
  assert.equal(rows[0]!.action, "skip_owned");
  assert.equal(rows[1]!.action, "skip_already_requested");
  assert.equal(rows[1]!.existing[0]!.existingRequestStatus, "approved");
});

test("plan (both): only the missing kind is requested", async () => {
  const d = deps({
    pool: [cand({ seriesIndex: "2" })],
    avail: () => [
      { ownedBookId: 9, existingRequestId: null, existingRequestStatus: null },
      { ownedBookId: null, existingRequestId: null, existingRequestStatus: null },
    ],
  });
  const rows = await buildPlan(d, opts([2], ["ebook", "audiobook"]));
  assert.equal(rows[0]!.action, "request");
  assert.deepEqual(rows[0]!.requestKinds, ["audiobook"]);
  const calls = buildRequestCalls(rows, series, ["ebook", "audiobook"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.kind, "single");
  assert.equal(calls[0]!.mediaKind, "audiobook");
});

test("plan (both): ebook owned + audiobook requested = skip_already_requested", async () => {
  const d = deps({
    pool: [cand({ seriesIndex: "2" })],
    avail: () => [
      { ownedBookId: 9, existingRequestId: null, existingRequestStatus: null },
      { ownedBookId: null, existingRequestId: 3, existingRequestStatus: "pending" },
    ],
  });
  const rows = await buildPlan(d, opts([2], ["ebook", "audiobook"]));
  assert.equal(rows[0]!.action, "skip_already_requested");
});

test("requests: both kinds missing and wanted uses a single pair call", async () => {
  const rows = await buildPlan(
    deps({ pool: [cand({ seriesIndex: "2", isbn13: "978" })] }),
    opts([2], ["ebook", "audiobook"]),
  );
  const calls = buildRequestCalls(rows, series, ["ebook", "audiobook"], 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.kind, "pair");
  assert.deepEqual(calls[0]!.body.ebook, { targetLibraryId: 4 });
  assert.equal(calls[0]!.body.seriesIndex, 2);
  assert.equal(calls[0]!.body.isbn13, "978");
  assert.equal(calls[0]!.body.providerKey, "hardcover");
});

test("requests: only executable rows produce calls", async () => {
  const d = deps({
    pool: [cand({ seriesIndex: "2" }), cand({ seriesIndex: "3", seriesName: "Other" })],
  });
  const rows = await buildPlan(d, opts([2, 3, 9]));
  const calls = buildRequestCalls(rows, series, ["ebook"]);
  assert.deepEqual(
    calls.map((c) => c.index),
    [2],
  );
  assert.equal(calls[0]!.body.mediaKind, "ebook");
});

test("gapsAgainstTotal ignores non-integer and out-of-range indices", () => {
  assert.deepEqual(
    gapsAgainstTotal(["1", "2", "4", "1.5", null, "Omnibus", "9"], 5),
    [3, 5],
  );
  assert.deepEqual(gapsAgainstTotal([], 3), [1, 2, 3]);
  assert.deepEqual(gapsAgainstTotal(["1", "2", "3"], 3), []);
});
