# Quill generation ledger (Convex)

The Python pipeline appends one metadata record per long-form `WRITE` to
`output-api/generations.jsonl`. When the app is configured with a Convex HTTP
Actions URL and token, the same record is POSTed to `/generations` and becomes
queryable in the Convex dashboard.

The record contains **no document text**. It includes the run/session ids, the
provider and model, status, stage timings, corpus size, source/relevance counts,
research quality, word/section counts and token usage. The prompt is represented
by a SHA-256 hash and its length; a short preview is sent only when
`QUILL_TELEMETRY_PROMPT=1`.

## Deploy

This directory is the Convex project root. Its functions live in `convex/`.

```bash
cd convex
npm install
npx convex dev --once        # deploys to the configured dev deployment
npx convex env set QUILL_TELEMETRY_TOKEN "$(openssl rand -hex 32)"
```

Set the same values in Quill's `.env` (and in
`~/.local/share/app.quill.workspace/.env` for the installed AppImage):

```bash
QUILL_CONVEX_URL=https://<deployment>.convex.site/generations
QUILL_CONVEX_TOKEN=<the token set above>
```

The current deployment is `diligent-turtle-964`:

- Cloud: `https://diligent-turtle-964.convex.cloud`
- HTTP Actions: `https://diligent-turtle-964.convex.site`

For a production deployment, run `npx convex deploy` with a production deploy
key and use its `.convex.site` URL.

## Inspect

```bash
npx convex data generations
# or, from the dashboard:
# https://dashboard.convex.dev/t/ietorobong/quill/diligent-turtle-964
```

`generations:recent` returns the newest records first. The Python sidecar also
serves the last 100 local records at `GET /generations`.

## Files

- `convex/schema.ts` — table, indexes and validators
- `convex/generations.ts` — idempotent `record` mutation and `recent` query
- `convex/http.ts` — `POST /generations` with a bearer-token check
- `convex/validators.ts` — the shared argument validator
