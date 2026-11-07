# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A remote MCP server (Streamable HTTP, plus a stdio entrypoint) that lets Claude **manage** a
self-hosted [BookOrbit](https://github.com/bookorbit/bookorbit) instance: library, requests, Book
Dock, metadata, read-aloud. It started as a fork of joshstrange/bookorbit-mcp (read-only, stdio) and
was structurally rewritten; only `src/reading/*` (EPUB text modules, not yet registered) and the
test/lint/prettier setup carry over. See README.md for tools, config and deployment.

## Commands

```bash
npm install
npm run setup:types    # fetch pinned BookOrbit submodule (types only) + build @bookorbit/types
npm test               # offline unit tests (mocked BookOrbit)
npm run typecheck | lint | format:check | build
npm run dev            # stdio server       npm run dev:http   # HTTP server
node --import tsx --test test/library.test.ts     # one file
```

CI order: format:check → lint → typecheck → test → build, then the Docker image. Keep all green.
`prettier --write .` ignores `vendor/` (never reformat the submodule).

## Architecture

```
src/stdio.ts / src/server.ts → server-factory.ts → tools/*.ts → client/bookorbit.ts → BookOrbit /api/v1
                         http.ts (stateless /mcp, /healthz) ── auth/cf-access.ts (JWT verify)
```

- **`client/bookorbit.ts`**: typed fetch wrapper. Logs in as a `native` client (refresh token in
  the JSON body, rotated each refresh); on 401 refresh once, then re-login; single-flight re-auth.
  `sse()` reads SSE endpoints (also POST streams). Errors are `BookOrbitError`
  (`METHOD /path -> status: message [code]`).
- **`tools/define.ts` `registerActionTool`**: one tool = `action` discriminator. The advertised
  schema is flat (action + union of fields, all optional); strict per-action validation is a zod
  discriminated union in the handler. Destructive actions need `confirm: true` (else a dry-run
  summary); `ENABLE_DESTRUCTIVE=false` refuses them first, before any summary work. Tool
  annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`) are derived from the actions.
- **`series-gaps/plan.ts`**: pure planner (no I/O), dependency-injected, heavily unit tested. The
  tool in `tools/series-gaps.ts` wires it to BookOrbit.
- **`http.ts`**: a fresh `McpServer` + transport per request (stateless). `/healthz` is open;
  everything else requires a valid `Cf-Access-Jwt-Assertion` when `REQUIRE_CF_ACCESS` is on.
- **Types**: `@bookorbit/types` comes from the sparse submodule `vendor/bookorbit`, pinned to the
  tag of the **deployed** BookOrbit (see README). Bump = update submodule, `setup:types`, typecheck.
  `scripts/setup-types.sh` resets the submodule to the _recorded_ commit, so `git add vendor/bookorbit`
  before running it after changing the pin.

## Things that are easy to get wrong

- **Two pagination conventions in BookOrbit**: browse endpoints (`/series`, `/authors`, …) are
  0-based `page`/`size`; requests, Book Dock, duplicates and metadata-failed are 1-based
  `page`/`limit` (duplicates uses `pageSize`). Don't unify them.
- **The MCP SDK silently drops arguments a tool didn't declare** (no error), so "reject unknown
  field" can't be relied on; assert the outgoing request body instead.
- **Moves must not be aborted**: BookOrbit cancels `POST /books/move` when the client disconnects, so
  `move_books.execute` stops _waiting_ after ~50s but keeps reading the stream.
- **Never expose "all books matching a query" for destructive endpoints** (`DELETE /books`,
  Book Dock discard). Explicit ids, capped.
- **`read_aloud` is audiobook↔EPUB alignment**, not TTS; `tts` only manages voices/preferences.
  `replaceFileId` on job creation is deliberately not exposed.
- **Series gaps**: BookOrbit only reports gaps past your highest volume when it knows the series
  total and every owned book has an integer index; `assumeTotal` supplies it. Non-integer indices
  (1.5) are invisible.
- Prettier reformats test/source files; when patching text with scripts, match the formatted text.

## Testing note

All tests use a mocked BookOrbit (`test/helpers/harness.ts`, real MCP client over an in-memory
transport) written from reading upstream controllers/DTOs. `test/fixtures/` are **synthetic** EPUB
structures; do not add real book content (public repo, copyrighted). The first run against a real
instance is the true integration test; use a throwaway library for anything destructive.

## Scope

Read/manage BookOrbit only. Out of scope: RAG/embeddings, TTS audio synthesis, provider/indexer/
download-client admin CRUD, user/auth administration.
