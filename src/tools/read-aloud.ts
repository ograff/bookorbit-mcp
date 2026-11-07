import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadAloudCapability } from "@bookorbit/types";
import { registerActionTool, type ToolContext } from "./define.js";
import { ok, pick } from "../util/format.js";

const strip = (o: Record<string, unknown>): Record<string, any> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const jobId = z
  .string()
  .uuid()
  .describe("Read-aloud job id (UUID) from status or create_job.");
const bookId = z.number().int().min(1);

export function shapeJob(j: any) {
  if (!j) return j;
  return pick(j, [
    "id",
    "bookId",
    "status",
    "phase",
    "progress",
    "error",
    "errorMessage",
    "epubFileId",
    "audioFileIds",
    "language",
    "granularity",
    "publishedFileId",
    "createdAt",
    "updatedAt",
    "finishedAt",
  ]);
}

const shapeFiles = (files: any[] | undefined) =>
  (files ?? []).map((f) =>
    pick(f, ["id", "filename", "format", "sizeBytes", "durationSeconds"]),
  );

export function registerReadAloudTools(server: McpServer, ctx: ToolContext) {
  registerActionTool(server, ctx, {
    name: "read_aloud",
    title: "Read-aloud (audiobook ↔ EPUB alignment)",
    description:
      "Build a synchronized read-along EPUB by aligning an audiobook to its EPUB (this is alignment of existing audio, NOT text-to-speech; use `tts` for voices). Needs a book with both an EPUB and audio files and a healthy alignment worker. " +
      "Flow: status (eligibility, file ids) → create_job → get_job until done → job_report → publish. resync re-runs alignment with chapter/audio decisions; cancel deletes a job and needs confirm. " +
      'Example: {action: "create_job", bookId: 42, language: "en"}.',
    actions: {
      status: {
        readOnly: true,
        schema: { bookId },
        run: async (i, { client }) => {
          const c = await client.get<ReadAloudCapability>(
            `/books/${i.bookId}/read-aloud`,
          );
          return ok({
            eligible: c.eligible,
            reason: c.reason,
            workerAvailable: c.workerAvailable,
            supportedLanguages: c.supportedLanguages,
            epubFiles: shapeFiles(c.epubFiles as any),
            audioFiles: shapeFiles(c.audioFiles as any),
            existingReadAlongs: c.existingReadAlongs,
            estimatedOutputBytes: c.estimatedOutputBytes,
            latestJob: shapeJob(c.latestJob),
          });
        },
      },
      create_job: {
        schema: {
          bookId,
          epubFileId: z
            .number()
            .int()
            .optional()
            .describe("Required only if the book has several EPUBs."),
          audioFileIds: z
            .array(z.number().int())
            .min(1)
            .optional()
            .describe("Default: all audio files."),
          language: z
            .string()
            .optional()
            .describe('Narration language subtag, e.g. "en".'),
          granularity: z.enum(["sentence", "word"]).optional(),
        },
        run: async (i, { client }) => {
          const { bookId: id, ...rest } = i as any;
          delete rest.action;
          delete rest.confirm;
          return ok(
            shapeJob(await client.post(`/books/${id}/read-aloud-jobs`, strip(rest))),
          );
        },
      },
      get_job: {
        readOnly: true,
        schema: { jobId },
        run: async (i, { client }) =>
          ok(shapeJob(await client.get(`/read-aloud-jobs/${i.jobId}`))),
      },
      events: {
        readOnly: true,
        schema: {
          jobId,
          after: z
            .number()
            .int()
            .optional()
            .describe("Only events after this sequence number."),
        },
        run: async (i, { client }) =>
          ok(
            await client.get(
              `/read-aloud-jobs/${i.jobId}/events`,
              strip({ after: i.after }),
            ),
          ),
      },
      job_report: {
        readOnly: true,
        schema: { jobId },
        run: async (i, { client }) =>
          ok(await client.get(`/read-aloud-jobs/${i.jobId}/report`)),
      },
      retry: {
        schema: { jobId },
        run: async (i, { client }) =>
          ok(shapeJob(await client.post(`/read-aloud-jobs/${i.jobId}/retry`))),
      },
      resync: {
        schema: {
          jobId,
          chapters: z
            .record(z.enum(["excluded", "included", "approved"]))
            .describe("Chapter href -> decision, from job_report."),
          audio: z
            .array(
              z.object({
                track: z.string(),
                start: z.number().min(0).nullable(),
                end: z.number().min(0).nullable(),
              }),
            )
            .optional()
            .describe("Audio ranges to exclude."),
        },
        run: async (i, { client }) =>
          ok(
            shapeJob(
              await client.post(`/read-aloud-jobs/${i.jobId}/resync`, {
                decisions: strip({ chapters: i.chapters, audio: i.audio }),
              }),
            ),
          ),
      },
      publish: {
        schema: { jobId },
        run: async (i, { client }) =>
          ok(shapeJob(await client.post(`/read-aloud-jobs/${i.jobId}/publish`))),
      },
      dismiss: {
        schema: { jobId },
        run: async (i, { client }) =>
          ok(shapeJob(await client.post(`/read-aloud-jobs/${i.jobId}/dismiss`))),
      },
      delete: {
        destructive: true,
        schema: { jobId },
        summarize: async (i, { client }) => {
          const j = await client.get<any>(`/read-aloud-jobs/${i.jobId}`);
          return {
            effect: "cancels the job if running and deletes it and its working files",
            job: shapeJob(j),
          };
        },
        run: async (i, { client }) =>
          ok(
            (await client.delete(`/read-aloud-jobs/${i.jobId}`)) ?? { deleted: i.jobId },
          ),
      },
    },
  });

  const prefs = {
    providerId: z.string().optional(),
    voiceId: z.string().max(200).optional(),
    speed: z.number().min(0.25).max(4).optional(),
  };
  registerActionTool(server, ctx, {
    name: "tts",
    title: "Text-to-speech voices & preferences",
    description:
      "List TTS providers/voices and read or change the user's voice preferences, globally or per book (used when the reader speaks a book). Does not synthesize audio. " +
      "clear_book_preferences needs confirm. " +
      'Example: {action: "set_book_preferences", bookId: 42, voiceId: "af_bella", speed: 1.15}.',
    actions: {
      providers: {
        readOnly: true,
        schema: {},
        run: async (_i, { client }) => ok(await client.get("/tts/providers")),
      },
      voices: {
        readOnly: true,
        schema: { providerId: z.string().optional() },
        run: async (i, { client }) => {
          const res = await client.get<any>(
            "/tts/voices",
            strip({ providerId: i.providerId }),
          );
          const voices: any[] = Array.isArray(res) ? res : (res?.voices ?? []);
          return ok({ total: voices.length, voices: voices.slice(0, 100) });
        },
      },
      get_preferences: {
        readOnly: true,
        schema: {
          bookId: bookId
            .optional()
            .describe("With bookId: the effective prefs for that book."),
        },
        run: async (i, { client }) =>
          ok(
            await client.get(
              i.bookId ? `/tts/preferences/book/${i.bookId}` : "/tts/preferences",
            ),
          ),
      },
      set_preferences: {
        schema: prefs,
        run: async (i, { client }) =>
          ok(await client.put("/tts/preferences", strip(prefsBody(i)))),
      },
      set_book_preferences: {
        schema: { bookId, ...prefs },
        run: async (i, { client }) =>
          ok(await client.put(`/tts/preferences/book/${i.bookId}`, strip(prefsBody(i)))),
      },
      clear_book_preferences: {
        destructive: true,
        schema: { bookId },
        summarize: (i) =>
          `remove book #${i.bookId}'s TTS overrides so it uses your global voice again`,
        run: async (i, { client }) => {
          await client.delete(`/tts/preferences/book/${i.bookId}`);
          return ok({ cleared: i.bookId });
        },
      },
    },
  });
}

function prefsBody(i: { providerId?: string; voiceId?: string; speed?: number }) {
  const body = { providerId: i.providerId, voiceId: i.voiceId, speed: i.speed };
  if (Object.values(body).every((v) => v === undefined)) {
    throw new Error("Give at least one of providerId, voiceId, speed.");
  }
  return body;
}
