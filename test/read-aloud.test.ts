import { test } from "node:test";
import assert from "node:assert/strict";
import { registerReadAloudTools } from "../src/tools/read-aloud.js";
import { connect, mockBookOrbit } from "./helpers/harness.js";

const JOB = "7b7c8f0e-8e55-4c0a-9c3a-1f0a5a2d9b11";

test("status trims the capability and surfaces eligibility", async () => {
  const mock = mockBookOrbit({
    "GET /books/5/read-aloud": {
      eligible: false,
      reason: "no_audio",
      workerAvailable: true,
      supportedLanguages: ["en"],
      epubFiles: [
        {
          id: 1,
          filename: "a.epub",
          format: "epub",
          sizeBytes: 10,
          absolutePath: "/secret",
        },
      ],
      audioFiles: [],
      existingReadAlongs: [],
      estimatedOutputBytes: null,
      latestJob: null,
      workerFreeBytes: 1,
    },
  });
  const { call } = await connect(registerReadAloudTools, mock.client);
  const r = await call("read_aloud", { action: "status", bookId: 5 });
  assert.equal(r.data.eligible, false);
  assert.equal(r.data.reason, "no_audio");
  assert.deepEqual(r.data.epubFiles, [
    { id: 1, filename: "a.epub", format: "epub", sizeBytes: 10 },
  ]);
  assert.equal(r.data.workerFreeBytes, undefined);
});

test("create_job sends only provided options and never replaceFileId", async () => {
  const mock = mockBookOrbit({
    "POST /books/5/read-aloud-jobs": { id: JOB, status: "queued", extra: 1 },
  });
  const { call } = await connect(registerReadAloudTools, mock.client);
  const r = await call("read_aloud", {
    action: "create_job",
    bookId: 5,
    language: "en",
    audioFileIds: [2, 3],
  });
  assert.deepEqual(mock.calls[0]!.body, { language: "en", audioFileIds: [2, 3] });
  assert.deepEqual(r.data, { id: JOB, status: "queued" });
  // Unknown arguments are dropped by the SDK, so replaceFileId can never reach BookOrbit.
  await call("read_aloud", { action: "create_job", bookId: 5, replaceFileId: 9 });
  assert.equal("replaceFileId" in (mock.calls[1]!.body as object), false);
});

test("job ids must be UUIDs", async () => {
  const mock = mockBookOrbit({});
  const { call } = await connect(registerReadAloudTools, mock.client);
  const r = await call("read_aloud", { action: "get_job", jobId: "12" });
  assert.equal(r.isError, true);
  assert.equal(mock.calls.length, 0);
});

test("resync wraps chapter and audio decisions", async () => {
  const mock = mockBookOrbit({
    [`POST /read-aloud-jobs/${JOB}/resync`]: { id: JOB, status: "queued" },
  });
  const { call } = await connect(registerReadAloudTools, mock.client);
  await call("read_aloud", {
    action: "resync",
    jobId: JOB,
    chapters: { "ch1.xhtml": "excluded" },
    audio: [{ track: "t1.mp3", start: 0, end: 30 }],
  });
  assert.deepEqual(mock.calls[0]!.body, {
    decisions: {
      chapters: { "ch1.xhtml": "excluded" },
      audio: [{ track: "t1.mp3", start: 0, end: 30 }],
    },
  });
});

test("delete is gated and shows the job", async () => {
  const mock = mockBookOrbit({
    [`GET /read-aloud-jobs/${JOB}`]: { id: JOB, status: "running" },
    [`DELETE /read-aloud-jobs/${JOB}`]: {},
  });
  const { call } = await connect(registerReadAloudTools, mock.client);
  const dry = await call("read_aloud", { action: "delete", jobId: JOB });
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.wouldDo.job.status, "running");
  assert.equal(
    mock.calls.some((c) => c.method === "DELETE"),
    false,
  );
  await call("read_aloud", { action: "delete", jobId: JOB, confirm: true });
  assert.equal(
    mock.calls.some((c) => c.method === "DELETE"),
    true,
  );
});

test("tts preferences: global vs per-book, and empty updates are rejected", async () => {
  const mock = mockBookOrbit({
    "GET /tts/preferences": { voiceId: "a" },
    "GET /tts/preferences/book/4": { voiceId: "b" },
    "PUT /tts/preferences/book/4": { voiceId: "c" },
    "DELETE /tts/preferences/book/4": {},
  });
  const { call } = await connect(registerReadAloudTools, mock.client);
  assert.equal((await call("tts", { action: "get_preferences" })).data.voiceId, "a");
  assert.equal(
    (await call("tts", { action: "get_preferences", bookId: 4 })).data.voiceId,
    "b",
  );
  await call("tts", {
    action: "set_book_preferences",
    bookId: 4,
    voiceId: "c",
    speed: 1.2,
  });
  assert.deepEqual(mock.calls.find((c) => c.method === "PUT")!.body, {
    voiceId: "c",
    speed: 1.2,
  });
  assert.equal(
    (await call("tts", { action: "set_book_preferences", bookId: 4 })).isError,
    true,
  );
  assert.equal(
    (await call("tts", { action: "set_book_preferences", bookId: 4, speed: 9 })).isError,
    true,
  );
  const dry = await call("tts", { action: "clear_book_preferences", bookId: 4 });
  assert.equal(dry.data.dryRun, true);
});
