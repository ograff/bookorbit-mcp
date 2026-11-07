# bookorbit-mcp

A remote [MCP](https://modelcontextprotocol.io) server that lets Claude manage a self-hosted
[BookOrbit](https://github.com/bookorbit/bookorbit) instance: library management, book requests,
Book Dock imports, metadata, and read-along generation. It runs next to BookOrbit and talks to it
over the in-cluster Service; Claude reaches it as a custom connector behind Cloudflare Access.

```
claude.ai connector ── Cloudflare Access ──▶ https://bookorbit-mcp.<domain>/mcp
                                                 │ cloudflared tunnel → Envoy
                                                 ▼
                                        bookorbit-mcp pod (Node 22, Streamable HTTP)
                                                 │ in-cluster HTTP (no Access)
                                                 ▼
                                        bookorbit Service :3000 /api/v1
```

License: AGPL-3.0-only (it builds against BookOrbit's AGPL `@bookorbit/types`). See `NOTICE`.
Portions derive from [joshstrange/bookorbit-mcp](https://github.com/joshstrange/bookorbit-mcp) (MIT,
`LICENSE-MIT-upstream`).

## Tools

Action tools take an `action` plus that action's fields (and `confirm`).

| Tool                                                              | What it does                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `search_books`, `get_book`, `browse`                              | Find books; full detail (files, locks); series / authors / libraries / collections / smart scopes                  |
| `manage_book`                                                     | Edit metadata, set read status, delete books                                                                       |
| `manage_collection`, `manage_library`, `move_books`, `duplicates` | Collections; library stats and rescan; move books between libraries (preview first); duplicate scans               |
| `book_dock`                                                       | Review staged imports, edit/refetch metadata, set targets, preview and finalize, discard                           |
| `requests`, `requests_admin`                                      | Create / track / cancel requests; approve, reject, search releases, grab, fulfill                                  |
| `fill_series_gaps`                                                | Find missing volumes of a series, resolve titles through metadata providers, and request them (dry run by default) |
| `metadata_lookup`, `book_metadata`, `metadata_bulk`               | Provider search; apply chosen fields, lock/unlock, custom fields; bulk fetch runs                                  |
| `read_aloud`, `tts`                                               | Align an existing audiobook to its EPUB (read-along, **not** TTS); TTS voices and preferences                      |

### Safety model

- **Destructive actions need `confirm: true`.** Without it they return a dry-run summary and change
  nothing (delete books, reject/cancel requests, finalize/discard Book Dock files, execute a move,
  cancel the bulk metadata queue, delete a read-aloud job, …).
- **`ENABLE_DESTRUCTIVE=false`** refuses all of them even with `confirm: true` (read-only-ish deploy).
- Book deletion and discard take **explicit ids only** (max 50 / 100); BookOrbit's "everything
  matching this query" selection is deliberately not exposed for them.
- `fill_series_gaps` defaults to `dryRun: true`; low-confidence or ambiguous matches are never
  requested automatically; `scope: "library"` only summarizes and never creates requests.
- Responses are trimmed; covers and files are never returned.

## Configuration

| Env                                        | Default  | Notes                                                                                    |
| ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `BOOKORBIT_URL`                            | required | In-cluster URL, e.g. `http://bookorbit.books.svc.cluster.local:3000`                     |
| `BOOKORBIT_USERNAME`, `BOOKORBIT_PASSWORD` | required | Dedicated BookOrbit user (local password login)                                          |
| `REQUIRE_CF_ACCESS`                        | `true`   | Verify `Cf-Access-Jwt-Assertion` on every request except `/healthz`                      |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`   | —        | Required when Access is on. `<team>` or `<team>.cloudflareaccess.com`; the app's AUD tag |
| `ENABLE_DESTRUCTIVE`                       | `true`   | `false` refuses every destructive action                                                 |
| `PORT`                                     | `8080`   |                                                                                          |

The server is stateless (a fresh MCP server per request) and logs in to BookOrbit as a `native`
client: the refresh token travels in the JSON body and is rotated on every refresh. On a 401 it
refreshes once and then logs in again.

### BookOrbit user permissions

Create a dedicated user (don't reuse yours). Grant only what you want Claude to be able to do:

| Capability                                          | Permission(s)                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Browse / search / read                              | (library access to the libraries it should see)                                                 |
| `requests`                                          | `book_request_access`                                                                           |
| `requests_admin`                                    | `manage_book_requests`                                                                          |
| `manage_book` update, `move_books`, `book_metadata` | `library_edit_metadata`                                                                         |
| `manage_book` delete, `duplicates`                  | `library_delete_books`                                                                          |
| `manage_library` scan / stats                       | `manage_libraries`                                                                              |
| `book_dock`                                         | `book_dock_access` (+ `manage_book_dock` for pause/resume/rescan, `library_upload` to finalize) |
| `metadata_bulk`                                     | `manage_metadata_config`                                                                        |
| `read_aloud`                                        | `library_generate_read_aloud`                                                                   |

A missing permission surfaces as a 403 naming the endpoint. A superuser also works but defeats the
point of a scoped account. For a read-only deploy, grant none of the write permissions.

## Cloudflare Access

Authentication is a self-hosted Access application on the MCP hostname; the server additionally
verifies Cloudflare's signed JWT (defense in depth, and it protects the Service from other pods,
since flannel does not enforce NetworkPolicy).

1. Tunnel/route: publish `bookorbit-mcp.<domain>` to the cluster (in this homelab: an `HTTPRoute`
   on `envoy-external`, see `deploy/homelab-flux`).
2. Zero Trust → Access → Applications → **Add application → Self-hosted** for that hostname, with a
   policy allowing your identity. Give it its own app so it is not under a wildcard policy.
3. Pick one auth mode:
   - **Managed OAuth** (what this was designed for): enable _Managed OAuth_ on the app with dynamic
     client registration, so claude.ai registers itself. Check Cloudflare's current docs for the
     exact steps; the feature is still evolving.
   - **Service Auth + header token** (what `k8s-mcp` uses in this cluster): a Service Auth policy
     with `read_service_tokens_from_header: x-auth-token`, and the connector sends the token JSON in
     that header. The JWT check works the same with either mode.
4. Copy the app's **Application Audience (AUD) tag** into `CF_ACCESS_AUD`, and your team name into
   `CF_ACCESS_TEAM_DOMAIN`.
5. Verify: `curl https://bookorbit-mcp.<domain>/.well-known/oauth-authorization-server` returns the
   issuer and endpoints (Managed OAuth), and an unauthenticated `POST /mcp` is refused.
6. claude.ai → Settings → Connectors → **Add custom connector** →
   `https://bookorbit-mcp.<domain>/mcp`.

If requests are rejected with `unauthorized`, the pod log says why (`auth rejected …: <reason>`).
First thing to confirm for a new Access mode: that Access forwards `Cf-Access-Jwt-Assertion` to the
origin for that mode.

## Deploying

The image is published to `ghcr.io/ograff/bookorbit-mcp` by CI (tags `sha-<short>`, `latest` on
main, semver on `v*` tags). **The GHCR package must be public**, or the cluster needs an
`imagePullSecret`.

- `deploy/base`: generic Kustomize base (Deployment + Service; Secret and ingress are yours).
- `deploy/homelab-flux`: the Flux/app-template variant in this homelab's conventions. Copy it to
  `kubernetes/apps/mcp/bookorbit-mcp`, register it in `kubernetes/apps/mcp/kustomization.yaml`,
  create `secret.sops.yaml` from `secret.example.yaml`, and set the image tag.

## Development

```bash
npm install
npm run setup:types   # fetch the pinned BookOrbit submodule (types only) and build @bookorbit/types
npm test              # offline, mocked BookOrbit
npm run dev           # stdio server (Claude Code / local), reads BOOKORBIT_* from the env
npm run dev:http      # HTTP server; set REQUIRE_CF_ACCESS=false locally
```

`@bookorbit/types` is vendored as a sparse git submodule (`vendor/bookorbit`) **pinned to the tag
matching the deployed BookOrbit version** (currently `v3.6.0`), so upstream API changes surface as
compile errors when the pin is bumped: update the submodule, run `npm run setup:types`, then
`npm run typecheck && npm test`.

CI (`.github/workflows/ci.yml`): format → lint → typecheck → test → build, then the image.

Tests run against a mocked BookOrbit built from reading the upstream controllers/DTOs. Treat the
first run against a real instance as the real integration test, and try destructive actions only
against a throwaway library.

### Optional: EPUB text tools

The fork's chapter-text modules (`src/reading/`) are kept for a future opt-in `reading` module
(`list_chapters` / `get_chapter` / `search_in_book`); they are not registered yet.
