/**
 * Live integration check: drives every tool, in-process over the MCP protocol, against a REAL
 * BookOrbit. Intended for a THROWAWAY instance: it creates, edits, moves and deletes data.
 *
 *   BOOKORBIT_URL=... BOOKORBIT_USERNAME=... BOOKORBIT_PASSWORD=... \
 *     node --import tsx scripts/live-check.mts
 *
 * Assumes the layout the test instance is seeded with: library 1 with folder 1 containing the
 * series "Test Saga" (volumes 1, 2, 4), an empty second folder at /books/ebooks2, and files waiting
 * in Book Dock. Steps never abort the run; the exit code is 1 if any hard check failed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createClient, createMcpServer } from "../src/server-factory.js";

const config = loadConfig({ ...process.env, REQUIRE_CF_ACCESS: "false" });
const bo = createClient(config);
const server = createMcpServer(config, bo);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const mcp = new Client({ name: "live-check", version: "0" });
await mcp.connect(b);

type R = { isError: boolean; data: any; text: string };
async function t(name: string, args: Record<string, unknown>): Promise<R> {
  const r = (await mcp.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  const text = r.content[0]?.text ?? "";
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  return { isError: Boolean(r.isError), data, text };
}

const results: { name: string; status: "PASS" | "FAIL" | "INFO"; detail: string }[] = [];
const short = (s: unknown, n = 160) =>
  String(typeof s === "string" ? s : JSON.stringify(s)).slice(0, n);

async function step(name: string, fn: () => Promise<string | void>, soft = false) {
  try {
    const detail = (await fn()) ?? "";
    results.push({ name, status: "PASS", detail });
    console.log(`PASS  ${name}  ${detail}`);
  } catch (e) {
    const status = soft ? "INFO" : "FAIL";
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, status, detail });
    console.log(`${status}  ${name}  ${short(detail, 300)}`);
  }
}
function ok(r: R, what: string): any {
  if (r.isError) throw new Error(`${what}: tool error: ${short(r.text, 300)}`);
  return r.data;
}
function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- discovery
let seriesId = 0;
let book1 = 0;
let book4 = 0;
await step("tools/list exposes every tool", async () => {
  const names = (await mcp.listTools()).tools.map((x) => x.name);
  for (const n of [
    "search_books",
    "get_book",
    "browse",
    "manage_book",
    "manage_collection",
    "manage_library",
    "move_books",
    "duplicates",
    "book_dock",
    "requests",
    "requests_admin",
    "fill_series_gaps",
    "metadata_lookup",
    "book_metadata",
    "metadata_bulk",
    "read_aloud",
    "tts",
  ])
    must(names.includes(n), `missing ${n}`);
  return `${names.length} tools`;
});
await step("search_books", async () => {
  const d = ok(await t("search_books", { q: "Voyage" }), "search");
  must(d.items.length >= 3, `expected >=3 results, got ${d.items.length}`);
  must(d.items[0].formats?.includes("epub"), "formats missing");
  book1 = d.items.find((i: any) => /First/.test(i.title))?.id;
  book4 = d.items.find((i: any) => /Fourth/.test(i.title))?.id;
  must(book1 && book4, "seed books not found");
  return `${d.items.length} items`;
});
await step("get_book", async () => {
  const d = ok(await t("get_book", { bookId: book1 }), "get_book");
  must(d.files?.length >= 1, "no files");
  must(d.seriesName === "Test Saga", `series ${d.seriesName}`);
  return `${d.title}; files=${d.files.map((f: any) => f.format)}; locks=${JSON.stringify(d.lockedFields ?? [])}`;
});
await step(
  "browse: series / series_books / authors / libraries / collections / smart_scopes",
  async () => {
    const s = ok(
      await t("browse", { action: "series", completionStatus: "has_gaps" }),
      "series",
    );
    const ts = s.items.find((x: any) => x.name === "Test Saga");
    must(ts, "Test Saga missing from has_gaps list");
    seriesId = ts.id;
    must(ts.gapCount === 1, `gapCount ${ts.gapCount}`);
    const sb = ok(
      await t("browse", { action: "series_books", id: seriesId }),
      "series_books",
    );
    must(
      JSON.stringify(sb.series.possibleGaps) === "[3]",
      `possibleGaps ${sb.series.possibleGaps}`,
    );
    const au = ok(await t("browse", { action: "authors" }), "authors");
    must(
      au.items.some((x: any) => /McTestface/.test(x.name)),
      "author missing",
    );
    ok(await t("browse", { action: "author_books", id: au.items[0].id }), "author_books");
    const li = ok(await t("browse", { action: "libraries" }), "libraries");
    must(li.items.length >= 1, "no libraries");
    ok(await t("browse", { action: "collections" }), "collections");
    ok(await t("browse", { action: "smart_scopes" }), "smart_scopes");
    return `series=${seriesId} libs=${li.items.length}`;
  },
);

// -------------------------------------------------------------- collections
await step(
  "manage_collection: create/add/list/update/remove/delete(dry)/delete",
  async () => {
    const c = ok(
      await t("manage_collection", { action: "create", name: "Live Check" }),
      "create",
    );
    const id = c.id ?? c.collection?.id;
    must(id, `no id in ${short(c)}`);
    ok(
      await t("manage_collection", { action: "add_books", id, bookIds: [book1, book4] }),
      "add_books",
    );
    const cb = ok(
      await t("browse", { action: "collection_books", id }),
      "collection_books",
    );
    must(cb.items.length === 2, `expected 2 books, got ${cb.items.length}`);
    ok(
      await t("manage_collection", { action: "update", id, name: "Live Check 2" }),
      "update",
    );
    ok(
      await t("manage_collection", { action: "remove_books", id, bookIds: [book4] }),
      "remove_books",
    );
    const dry = ok(await t("manage_collection", { action: "delete", id }), "delete dry");
    must(dry.dryRun === true, "delete without confirm was not a dry run");
    must(
      ok(await t("browse", { action: "collections" }), "list").items.some(
        (x: any) => x.id === id,
      ),
      "collection vanished after dry run",
    );
    ok(await t("manage_collection", { action: "delete", id, confirm: true }), "delete");
    must(
      !ok(await t("browse", { action: "collections" }), "list2").items.some(
        (x: any) => x.id === id,
      ),
      "collection still present after delete",
    );
    return `collection ${id}`;
  },
);

// -------------------------------------------------------------- manage_book
await step("manage_book: update, null-clear, set_status, bulk_set_status", async () => {
  const u = ok(
    await t("manage_book", { action: "update", bookId: book4, subtitle: "live-check" }),
    "update",
  );
  must(u.subtitle === "live-check", `subtitle ${u.subtitle}`);
  const c = ok(
    await t("manage_book", { action: "update", bookId: book4, subtitle: null }),
    "clear",
  );
  must(!c.subtitle, `subtitle not cleared: ${c.subtitle}`);
  ok(
    await t("manage_book", { action: "set_status", bookId: book4, status: "reading" }),
    "set_status",
  );
  must(
    ok(await t("get_book", { bookId: book4 }), "get").readStatus === "reading",
    "status not applied",
  );
  ok(
    await t("manage_book", {
      action: "bulk_set_status",
      bookIds: [book1, book4],
      status: "unread",
    }),
    "bulk",
  );
  return "ok";
});
await step("book_metadata: lock/unlock merge, custom_fields", async () => {
  const l = ok(
    await t("book_metadata", { action: "lock_fields", bookId: book1, fields: ["title"] }),
    "lock",
  );
  must(l.lockedFields.includes("title"), "title not locked");
  const l2 = ok(
    await t("book_metadata", {
      action: "lock_fields",
      bookId: book1,
      fields: ["authors"],
    }),
    "lock2",
  );
  must(
    l2.lockedFields.includes("title") && l2.lockedFields.includes("authors"),
    "lock merge lost a field",
  );
  const u = ok(
    await t("book_metadata", {
      action: "unlock_fields",
      bookId: book1,
      fields: ["title", "authors"],
    }),
    "unlock",
  );
  must(u.lockedFields.length === 0, `locks remain ${u.lockedFields}`);
  ok(await t("book_metadata", { action: "custom_fields" }), "custom_fields");
  return "ok";
});
await step(
  "book_metadata: refresh_preview / metadata_lookup (needs provider network)",
  async () => {
    const p = await t("book_metadata", { action: "refresh_preview", bookId: book1 });
    const l = await t("metadata_lookup", { title: "Dune", author: "Herbert" });
    return `preview=${p.isError ? "error: " + short(p.text, 80) : "ok"}; lookup=${l.isError ? "error: " + short(l.text, 80) : (l.data.total ?? 0) + " candidates"}`;
  },
  true,
);
await step("metadata_bulk: status / preview_count (read-only)", async () => {
  const s = ok(await t("metadata_bulk", { action: "status" }), "status");
  const c = await t("metadata_bulk", { action: "preview_count" });
  return `status=${short(s, 80)}; preview_count=${c.isError ? "error: " + short(c.text, 100) : short(c.data, 60)}`;
});

// ------------------------------------------------------------------ library
let lib1 = 0;
let folder1 = 0;
await step("manage_library: list / stats / scan_history", async () => {
  const l = ok(await t("manage_library", { action: "list" }), "list");
  lib1 = l.items[0].id;
  folder1 = l.items[0].folders[0].id;
  must(folder1, "no folder ids exposed");
  ok(await t("manage_library", { action: "stats", id: lib1 }), "stats");
  ok(await t("manage_library", { action: "scan_history", id: lib1 }), "scan_history");
  return `lib=${lib1} folder=${folder1}`;
});

// ----------------------------------------------------------------- requests
let reqA = 0;
let reqB = 0;
await step("requests: create / get / list / summary / check_availability", async () => {
  const c = ok(
    await t("requests", {
      action: "create",
      title: "Live Check Request A",
      authors: ["Testy McTestface"],
      mediaKind: "ebook",
      seriesName: "Test Saga",
      seriesIndex: 3,
    }),
    "create",
  );
  reqA = c.request.id;
  const g = ok(await t("requests", { action: "get", id: reqA }), "get");
  must(g.title === "Live Check Request A", "title mismatch");
  const l = ok(await t("requests", { action: "list" }), "list");
  must(
    l.items.some((x: any) => x.id === reqA),
    "request not listed",
  );
  ok(await t("requests", { action: "summary" }), "summary");
  const av = ok(
    await t("requests", {
      action: "check_availability",
      items: [
        { title: "Live Check Request A", mediaKind: "ebook" },
        {
          title: "The First Test Voyage",
          mediaKind: "ebook",
          author: "Testy McTestface",
        },
      ],
    }),
    "availability",
  );
  must(av.items.length === 2, "availability length");
  return `req=${reqA} status=${g.status}; availability[0]=${short(av.items[0], 100)}; [1]=${short(av.items[1], 100)}`;
});
await step(
  "requests: duplicate create attaches to the existing request",
  async () => {
    const c = ok(
      await t("requests", {
        action: "create",
        title: "Live Check Request A",
        mediaKind: "ebook",
        authors: ["Testy McTestface"],
      }),
      "create dup",
    );
    return `subscribedToExisting=${c.subscribedToExisting} id=${c.request.id} (orig ${reqA})`;
  },
  true,
);
await step("requests: create_pair", async () => {
  const c = ok(
    await t("requests", {
      action: "create_pair",
      title: "Live Check Pair",
      authors: ["Testy McTestface"],
    }),
    "pair",
  );
  reqB = c.ebook.request.id;
  return `ebook=${c.ebook.request.id} audiobook=${c.audiobook.request.id}`;
});
await step("requests_admin: list / approve / attempts", async () => {
  const l = ok(await t("requests_admin", { action: "list" }), "list");
  must(l.items.length >= 2, "admin list too small");
  const ap = await t("requests_admin", { action: "approve", id: reqA });
  const at = await t("requests_admin", { action: "attempts", id: reqA });
  return `approve=${ap.isError ? "error: " + short(ap.text, 120) : ap.data.status}; attempts=${at.isError ? "error: " + short(at.text, 80) : short(at.data, 60)}`;
});
await step(
  "requests_admin: search_releases fails readably with no indexers",
  async () => {
    const r = await t("requests_admin", { action: "search_releases", id: reqA });
    return r.isError
      ? `readable error: ${short(r.text, 200)}`
      : `returned: ${short(r.data, 120)}`;
  },
  true,
);
await step("requests_admin: reject is gated, then rejects", async () => {
  const dry = ok(
    await t("requests_admin", { action: "reject", id: reqB, decisionNote: "live check" }),
    "dry",
  );
  must(dry.dryRun === true, "reject without confirm executed");
  const r = ok(
    await t("requests_admin", {
      action: "reject",
      id: reqB,
      decisionNote: "live check",
      confirm: true,
    }),
    "reject",
  );
  must(r.status === "rejected", `status ${r.status}`);
  return "rejected";
});
await step("requests: cancel is gated, then cancels", async () => {
  const dry = ok(await t("requests", { action: "cancel", id: reqA }), "dry");
  must(dry.dryRun === true, "cancel without confirm executed");
  const r = ok(
    await t("requests", { action: "cancel", id: reqA, confirm: true }),
    "cancel",
  );
  return `status=${r.status}`;
});
await step("requests_admin: delete is gated, then deletes", async () => {
  const dry = ok(await t("requests_admin", { action: "delete", id: reqB }), "dry");
  must(dry.dryRun === true, "delete without confirm executed");
  ok(await t("requests_admin", { action: "delete", id: reqB, confirm: true }), "delete");
  const g = await t("requests", { action: "get", id: reqB });
  must(g.isError, "request still readable after delete");
  return `get after delete -> ${short(g.text, 100)}`;
});

// ---------------------------------------------------------- fill_series_gaps
await step(
  "fill_series_gaps: dry-run by name finds the gap and creates nothing",
  async () => {
    const before = ok(await t("requests", { action: "list" }), "before").total;
    const d = ok(await t("fill_series_gaps", { series: "Test Saga" }), "dry");
    must(d.dryRun === true, "not a dry run");
    must(
      d.plan.some((p: any) => p.index === 3),
      `gap 3 missing from plan ${short(d.plan)}`,
    );
    const after = ok(await t("requests", { action: "list" }), "after").total;
    must(after === before, "dry run created requests");
    return `plan=${short(d.plan.map((p: any) => `${p.index}:${p.action}(${p.confidence})`))}`;
  },
);
await step(
  "fill_series_gaps: assumeTotal adds volumes beyond the highest owned",
  async () => {
    const d = ok(
      await t("fill_series_gaps", { series: seriesId, assumeTotal: 5 }),
      "assume",
    );
    const idx = d.plan.map((p: any) => p.index).join(",");
    must(idx === "3,5", `expected 3,5 got ${idx}`);
    return `indexes ${idx}`;
  },
);
await step("fill_series_gaps: library scope summarizes only", async () => {
  const d = ok(await t("fill_series_gaps", { scope: "library" }), "library");
  must(
    d.series.some((s: any) => s.name === "Test Saga"),
    "Test Saga missing",
  );
  return `${d.seriesWithGaps} series with gaps`;
});

// ---------------------------------------------------------------- book dock
let dockIds: { id: number; fileName: string }[] = [];
await step(
  "book_dock: summary / rescan / list_files (files seeded by the harness)",
  async () => {
    ok(await t("book_dock", { action: "summary" }), "summary");
    await t("book_dock", { action: "rescan" });
    for (let i = 0; i < 20; i++) {
      const l = ok(await t("book_dock", { action: "list_files" }), "list");
      dockIds = l.items.map((x: any) => ({ id: x.id, fileName: x.fileName }));
      if (dockIds.length >= 3 && l.items.every((x: any) => x.status !== "pending")) break;
      await sleep(3000);
    }
    must(dockIds.length >= 3, `expected >=3 dock files, got ${dockIds.length}`);
    return dockIds.map((d) => `${d.id}:${d.fileName.slice(-30)}`).join(" | ");
  },
);
const dock = (frag: string) =>
  dockIds.find((d) => d.fileName.includes(frag))?.id as number;
await step(
  "book_dock: get_file / edit_file / set_target / preview_finalize",
  async () => {
    const id5 = dock("05");
    must(id5, "Saga 05 not in dock");
    ok(await t("book_dock", { action: "get_file", id: id5 }), "get_file");
    ok(
      await t("book_dock", {
        action: "edit_file",
        id: id5,
        title: "The Fifth Test Voyage",
        seriesName: "Test Saga",
        seriesIndex: "5",
      }),
      "edit",
    );
    ok(
      await t("book_dock", {
        action: "set_target",
        fileIds: [id5],
        targetLibraryId: lib1,
        targetFolderId: folder1,
      }),
      "set_target",
    );
    const p = ok(
      await t("book_dock", {
        action: "preview_finalize",
        fileIds: [id5],
        defaultLibraryId: lib1,
        defaultFolderId: folder1,
      }),
      "preview",
    );
    return short(p, 220);
  },
);
await step("book_dock: finalize is gated, then files the book", async () => {
  const id5 = dock("05");
  const args = {
    action: "finalize",
    fileIds: [id5],
    defaultLibraryId: lib1,
    defaultFolderId: folder1,
  };
  const dry = ok(await t("book_dock", args), "dry");
  must(dry.dryRun === true, "finalize without confirm executed");
  const r = ok(await t("book_dock", { ...args, confirm: true }), "finalize");
  await sleep(4000);
  const s = ok(await t("search_books", { q: "Fifth" }), "search");
  must(s.items.length >= 1, `finalized book not found: ${short(r)}`);
  return `result=${short(r, 100)}; found id ${s.items[0].id}`;
});
await step(
  "book_dock: duplicate of an owned book is reported by preview_finalize",
  async () => {
    const idDup = dock("01");
    must(idDup, "dup file not in dock");
    ok(
      await t("book_dock", {
        action: "set_target",
        fileIds: [idDup],
        targetLibraryId: lib1,
        targetFolderId: folder1,
      }),
      "target",
    );
    const p = ok(
      await t("book_dock", {
        action: "preview_finalize",
        fileIds: [idDup],
        defaultLibraryId: lib1,
        defaultFolderId: folder1,
      }),
      "preview",
    );
    return short(p, 300);
  },
  true,
);
await step("book_dock: discard is gated, then discards", async () => {
  const id6 = dock("06");
  must(id6, "Saga 06 not in dock");
  const dry = ok(await t("book_dock", { action: "discard", fileIds: [id6] }), "dry");
  must(dry.dryRun === true, "discard without confirm executed");
  ok(
    await t("book_dock", { action: "discard", fileIds: [id6], confirm: true }),
    "discard",
  );
  const l = ok(await t("book_dock", { action: "list_files" }), "list");
  must(!l.items.some((x: any) => x.id === id6), "file still in dock");
  return "discarded";
});
await step("book_dock: pause / resume", async () => {
  ok(await t("book_dock", { action: "pause" }), "pause");
  ok(await t("book_dock", { action: "resume" }), "resume");
});

// --------------------------------------------------------------- duplicates
await step("duplicates: scan -> status -> groups", async () => {
  const s = ok(await t("duplicates", { action: "scan", similarityPercent: 90 }), "scan");
  const scanId = s.id ?? s.scanId ?? s.scan?.id;
  must(scanId, `no scan id in ${short(s)}`);
  let st: any;
  for (let i = 0; i < 20; i++) {
    st = ok(await t("duplicates", { action: "scan_status", scanId }), "status");
    if (["completed", "failed"].includes(st.status)) break;
    await sleep(2000);
  }
  must(st.status === "completed", `scan status ${st.status}`);
  const g = ok(await t("duplicates", { action: "groups", scanId }), "groups");
  return `scan ${scanId} ${st.status}; groups=${short(g, 160)}`;
});

// --------------------------------------------------------------------- move
await step("move_books: preview -> gated execute -> verify", async () => {
  const created = await bo.post<any>("/libraries", {
    name: "Second Library",
    icon: "📦",
    folders: ["/books/ebooks2"],
  });
  const folders = (await bo.get<any[]>("/libraries")).find(
    (l) => l.id === created.id,
  )?.folders;
  const lib2 = created.id;
  const folder2 = folders[0].id;
  const args = { bookIds: [book4], targetLibraryId: lib2, targetFolderId: folder2 };
  const p = ok(await t("move_books", { action: "preview", ...args }), "preview");
  must(p.readyCount === 1, `readyCount ${p.readyCount}: ${short(p)}`);
  const dry = ok(
    await t("move_books", { action: "execute", ...args, collisionPolicy: "suggested" }),
    "dry",
  );
  must(dry.dryRun === true, "move without confirm executed");
  must(
    ok(await t("get_book", { bookId: book4 }), "get").libraryId === lib1,
    "moved on dry run",
  );
  const r = ok(
    await t("move_books", {
      action: "execute",
      ...args,
      collisionPolicy: "suggested",
      confirm: true,
    }),
    "execute",
  );
  const after = ok(await t("get_book", { bookId: book4 }), "get after");
  must(
    after.libraryId === lib2,
    `book still in library ${after.libraryId}; result ${short(r)}`,
  );
  return `moved ${book4} to library ${lib2}; ${short(r, 120)}`;
});

// ------------------------------------------------------------------- delete
await step("manage_book: delete is gated, then deletes book + file", async () => {
  const s = ok(await t("search_books", { q: "Fifth" }), "search");
  const id = s.items[0]?.id;
  must(id, "no Fifth book to delete");
  const dry = ok(await t("manage_book", { action: "delete", bookIds: [id] }), "dry");
  must(dry.dryRun === true && dry.wouldDo.books[0].title, "dry run missing book titles");
  must(ok(await t("get_book", { bookId: id }), "still").id === id, "deleted on dry run");
  ok(
    await t("manage_book", { action: "delete", bookIds: [id], confirm: true }),
    "delete",
  );
  const g = await t("get_book", { bookId: id });
  must(g.isError, "book still readable after delete");
  return `deleted ${id}; get -> ${short(g.text, 90)}`;
});

// ---------------------------------------------------------------- read-aloud
await step("read_aloud: status; create_job fails readably without a worker", async () => {
  const s = ok(await t("read_aloud", { action: "status", bookId: book1 }), "status");
  const c = await t("read_aloud", { action: "create_job", bookId: book1 });
  return `eligible=${s.eligible} reason=${s.reason}; create_job=${c.isError ? "error: " + short(c.text, 160) : short(c.data, 80)}`;
});
await step(
  "tts: providers / voices / preferences round trip",
  async () => {
    const p = ok(await t("tts", { action: "providers" }), "providers");
    const v = await t("tts", { action: "voices" });
    const g = ok(await t("tts", { action: "get_preferences" }), "get");
    const bad = await t("tts", { action: "set_preferences" });
    must(bad.isError, "empty set_preferences should be rejected");
    return `providers=${short(p, 60)}; voices=${v.isError ? "error: " + short(v.text, 60) : "ok"}; prefs=${short(g, 60)}`;
  },
  true,
);
await step("destructive action error on a missing id is readable", async () => {
  const r = await t("manage_collection", { action: "delete", id: 999999, confirm: true });
  must(r.isError, "expected an error");
  must(/BookOrbit|404|not found/i.test(r.text), `unreadable error: ${short(r.text)}`);
  return short(r.text, 140);
});

// ------------------------------------------------------------------ summary
const fails = results.filter((r) => r.status === "FAIL");
const infos = results.filter((r) => r.status === "INFO");
console.log(
  `\n==== ${results.length} steps: ${results.filter((r) => r.status === "PASS").length} pass, ${fails.length} FAIL, ${infos.length} info ====`,
);
for (const f of fails) console.log(`FAILED: ${f.name}\n   ${short(f.detail, 400)}`);
await mcp.close();
process.exit(fails.length ? 1 : 0);
