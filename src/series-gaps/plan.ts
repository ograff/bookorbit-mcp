/**
 * Pure planning logic for filling series gaps. No I/O: callers inject candidate lookup and
 * availability checks, which keeps every decision here unit-testable.
 */

export type Confidence = "high" | "medium" | "low" | "none";
export type MediaKind = "ebook" | "audiobook";

export interface Candidate {
  provider: string;
  providerId: string;
  title?: string;
  displayTitle?: string;
  authors?: string[];
  seriesName?: string;
  seriesIndex?: string | number;
  seriesMemberships?: {
    seriesName?: string;
    name?: string;
    seriesIndex?: string | number;
  }[];
  isbn13?: string;
  publishedYear?: number;
  language?: string;
}

export interface SeriesContext {
  name: string;
  authors: string[];
}

export interface Resolution {
  candidate: Candidate;
  confidence: Confidence;
  note?: string;
}

export interface Availability {
  ownedBookId: number | null;
  existingRequestId: number | null;
  existingRequestStatus: string | null;
}

export type GapAction =
  "skip_owned" | "skip_already_requested" | "request" | "needs_review" | "unresolved";

export interface KindState {
  kind: MediaKind;
  ownedBookId?: number;
  existingRequestId?: number;
  existingRequestStatus?: string;
}

export interface GapPlanRow {
  index: number;
  title: string | null;
  authors: string[];
  confidence: Confidence;
  note?: string;
  candidate?: Candidate;
  /** Media kinds that would actually be requested. */
  requestKinds: MediaKind[];
  /** What already exists for the other kinds. */
  existing: KindState[];
  action: GapAction;
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export function atLeast(c: Confidence, min: Confidence): boolean {
  return CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[min];
}

/** Lowercase, strip accents/punctuation and leading articles, collapse whitespace. */
export function normalizeName(s: string | undefined | null): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "")
    .replace(/\s+(series|saga|trilogy|cycle|novels?|books?)$/, "")
    .trim();
}

/** Parse a provider series index into an integer, or null for "1.5", "", "Omnibus" etc. */
export function integerIndex(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** Surnames of each author, handling both "First Last" and "Last, First". */
function lastNames(authors: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of authors) {
    const surname = a.includes(",") ? a.split(",")[0]! : a;
    const parts = normalizeName(surname).split(" ").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last.length > 1) out.add(last);
  }
  return out;
}

export function authorsOverlap(a: string[], b: string[]): boolean {
  const left = lastNames(a);
  for (const n of lastNames(b)) if (left.has(n)) return true;
  return false;
}

/** How well a candidate's series name matches: 2 exact, 1 partial, 0 none. */
function seriesNameMatch(names: (string | undefined)[], seriesName: string): 0 | 1 | 2 {
  const want = normalizeName(seriesName);
  let best: 0 | 1 | 2 = 0;
  for (const n of names) {
    const got = normalizeName(n);
    if (!got || !want) continue;
    if (got === want) return 2;
    if (got.includes(want) || want.includes(got)) best = 1;
  }
  return best;
}

/** Series names + index pairs a candidate claims membership in. */
function memberships(c: Candidate): { name?: string; index: number | null }[] {
  const out = [{ name: c.seriesName, index: integerIndex(c.seriesIndex) }];
  for (const m of c.seriesMemberships ?? []) {
    out.push({ name: m.seriesName ?? m.name, index: integerIndex(m.seriesIndex) });
  }
  return out;
}

export function scoreCandidate(
  c: Candidate,
  gapIndex: number,
  series: SeriesContext,
): { confidence: Confidence; note?: string } {
  // Only memberships that claim exactly this index can make the candidate eligible.
  const claims = memberships(c).filter((m) => m.index === gapIndex);
  if (claims.length === 0) return { confidence: "none" };

  const name = seriesNameMatch(
    claims.map((m) => m.name),
    series.name,
  );
  if (name === 0) return { confidence: "low", note: "series name does not match" };

  const authorOk =
    series.authors.length === 0 ||
    !c.authors?.length ||
    authorsOverlap(c.authors, series.authors);
  if (!authorOk)
    return { confidence: "low", note: "author differs from the series' author" };

  return { confidence: name === 2 ? "high" : "medium" };
}

/**
 * Pick the best candidate for one missing index. If the top-confidence candidates are
 * different works (not the same title from several providers) the result is capped at "low".
 */
export function resolveGap(
  candidates: Candidate[],
  gapIndex: number,
  series: SeriesContext,
): Resolution | null {
  const scored = candidates
    .map((c) => ({ c, ...scoreCandidate(c, gapIndex, series) }))
    .filter((s) => s.confidence !== "none");
  if (scored.length === 0) return null;

  const top = Math.max(...scored.map((s) => CONFIDENCE_RANK[s.confidence]));
  const best = scored.filter((s) => CONFIDENCE_RANK[s.confidence] === top);
  // Prefer candidates with an ISBN, then those that already have a full title.
  best.sort(
    (a, b) =>
      Number(Boolean(b.c.isbn13)) - Number(Boolean(a.c.isbn13)) ||
      Number(Boolean(b.c.title)) - Number(Boolean(a.c.title)),
  );
  const chosen = best[0]!;

  const titles = new Set(best.map((s) => normalizeName(s.c.title ?? s.c.displayTitle)));
  titles.delete("");
  if (titles.size > 1) {
    return {
      candidate: chosen.c,
      confidence: "low",
      note: `ambiguous: ${titles.size} different titles claim #${gapIndex}`,
    };
  }
  return { candidate: chosen.c, confidence: chosen.confidence, note: chosen.note };
}

export function candidateTitle(c: Candidate | undefined): string | null {
  return c ? (c.title ?? c.displayTitle ?? null) : null;
}

export interface PlanDeps {
  /** Candidates for the series as a whole (one search shared by all gaps). */
  searchSeries(): Promise<Candidate[]>;
  /** Fallback search for one index when the series-wide search had no match. */
  searchIndex(index: number): Promise<Candidate[]>;
  /** Availability for one resolved title in each kind. Order matches `kinds`. */
  checkAvailability(
    title: string,
    author: string | undefined,
    candidate: Candidate,
    kinds: MediaKind[],
  ): Promise<Availability[]>;
}

export interface PlanOptions {
  series: SeriesContext;
  gaps: number[];
  kinds: MediaKind[];
  minConfidence: Confidence;
}

/** Build the plan: one row per gap, deciding what (if anything) would be requested. */
export async function buildPlan(
  deps: PlanDeps,
  opts: PlanOptions,
): Promise<GapPlanRow[]> {
  const { series, kinds, minConfidence } = opts;
  const gaps = [...new Set(opts.gaps)].sort((a, b) => a - b);
  const pool = await deps.searchSeries();
  const rows: GapPlanRow[] = [];

  for (const index of gaps) {
    let res = resolveGap(pool, index, series);
    if (!res || !atLeast(res.confidence, "medium")) {
      const extra = await deps.searchIndex(index);
      const retry = resolveGap([...pool, ...extra], index, series);
      if (
        retry &&
        (!res || CONFIDENCE_RANK[retry.confidence] > CONFIDENCE_RANK[res.confidence])
      ) {
        res = retry;
      }
    }

    if (!res) {
      rows.push({
        index,
        title: null,
        authors: [],
        confidence: "none",
        note: "no provider result claims this series index",
        requestKinds: [],
        existing: [],
        action: "unresolved",
      });
      continue;
    }

    const title = candidateTitle(res.candidate);
    const base = {
      index,
      title,
      authors: res.candidate.authors ?? [],
      confidence: res.confidence,
      note: res.note,
      candidate: res.candidate,
    };

    if (!title || !atLeast(res.confidence, minConfidence)) {
      rows.push({ ...base, requestKinds: [], existing: [], action: "needs_review" });
      continue;
    }

    const avail = await deps.checkAvailability(
      title,
      res.candidate.authors?.[0] ?? series.authors[0],
      res.candidate,
      kinds,
    );
    const existing: KindState[] = [];
    const requestKinds: MediaKind[] = [];
    let owned = 0;
    kinds.forEach((kind, i) => {
      const a = avail[i];
      if (a?.ownedBookId != null) {
        owned++;
        existing.push({ kind, ownedBookId: a.ownedBookId });
      } else if (a?.existingRequestId != null) {
        existing.push({
          kind,
          existingRequestId: a.existingRequestId,
          existingRequestStatus: a.existingRequestStatus ?? undefined,
        });
      } else {
        requestKinds.push(kind);
      }
    });

    let action: GapAction = "request";
    if (requestKinds.length === 0)
      action = owned === kinds.length ? "skip_owned" : "skip_already_requested";
    rows.push({ ...base, requestKinds, existing, action });
  }
  return rows;
}

export interface RequestCall {
  kind: "single" | "pair";
  mediaKind?: MediaKind;
  index: number;
  title: string;
  body: Record<string, unknown>;
}

/**
 * Turn executable rows into API calls. Both kinds missing and both wanted → one pair call;
 * otherwise one single call per kind still missing.
 */
export function buildRequestCalls(
  rows: GapPlanRow[],
  series: SeriesContext,
  wantedKinds: MediaKind[],
  targetLibraryId?: number,
): RequestCall[] {
  const calls: RequestCall[] = [];
  for (const row of rows) {
    if (row.action !== "request" || !row.candidate || !row.title) continue;
    const c = row.candidate;
    const work: Record<string, unknown> = {
      title: row.title,
      ...(c.authors?.length ? { authors: c.authors } : {}),
      seriesName: c.seriesName ?? series.name,
      seriesIndex: row.index,
      ...(c.isbn13 ? { isbn13: c.isbn13 } : {}),
      ...(c.publishedYear ? { publishedYear: c.publishedYear } : {}),
      ...(c.language ? { language: c.language } : {}),
      providerKey: c.provider,
      providerId: c.providerId,
    };
    const lib = targetLibraryId ? { targetLibraryId } : {};
    const both = wantedKinds.length === 2 && row.requestKinds.length === 2;
    if (both) {
      calls.push({
        kind: "pair",
        index: row.index,
        title: row.title,
        body: { ...work, ebook: lib, audiobook: lib },
      });
    } else {
      for (const mediaKind of row.requestKinds) {
        calls.push({
          kind: "single",
          mediaKind,
          index: row.index,
          title: row.title,
          body: { ...work, mediaKind, ...lib },
        });
      }
    }
  }
  return calls;
}

/** Integer indexes in 1..total not present in `owned` (used when the caller asserts a total). */
export function gapsAgainstTotal(
  ownedIndices: (string | number | null | undefined)[],
  total: number,
): number[] {
  const have = new Set(
    ownedIndices.map(integerIndex).filter((n): n is number => n !== null),
  );
  const out: number[] = [];
  for (let i = 1; i <= total; i++) if (!have.has(i)) out.push(i);
  return out;
}
