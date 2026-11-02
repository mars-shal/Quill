# SearXNG deployment and operations guide

Quill's research provider talks to [SearXNG](https://github.com/searxng/searxng), a free, self-hosted metasearch engine licensed under AGPL-3.0 (38.1k stars). The provider issues:

```
GET {base}/search?q=<query>&format=json&categories=<cats>&language=en
```

A successful response carries `query`, `results`, `answers`, `corrections`, `infoboxes`, `suggestions`, and `unresponsive_engines`. Each result has `url`, `title`, `content` (the snippet), `engine`, `score`, and `category`.

Configuration is read from the environment at call time. There is deliberately no constructor argument for it.

> **Self-host. Do not point Quill at a public instance.** Many public SearXNG instances disable the `json` format, which makes every research call fail with HTTP 403. The rest of this guide gets you a working instance in about ten minutes.

## 1. Quick start (development)

The dev script runs SearXNG for you, which is the normal way to get this working:

```bash
cd gui
bash scripts/dev-sidecar.sh            # SearXNG + sidecar + window
bash scripts/dev-sidecar.sh --keep-search   # leave SearXNG up after exit
bash scripts/dev-sidecar.sh --no-search     # skip it; scrapers only
```

It creates a container named `quill-searxng` from `searxng/searxng:latest`, bound to
`127.0.0.1:8080`, with [`scripts/searxng/settings.yml`](../scripts/searxng/settings.yml)
mounted read-only over `/etc/searxng/settings.yml` (that file is what enables `json`).
It waits for `/healthz`, probes one real `format=json` request so a 403 is reported at
startup instead of surfacing later as flaky research, exports `QUILL_SEARXNG_URL`, and
stops the container on exit unless `--keep-search` was given.

Every failure is a warning, not an abort: with no Docker, a stopped daemon, or a
container that will not boot, it says so and exports `QUILL_SEARXNG_URL=""` -- the
explicit opt-out -- so the log reads `searxng skipped: QUILL_SEARXNG_URL set to empty`
instead of a connection traceback, and research falls back to the scrapers.

`--searxng-port` (or `SEARXNG_PORT`) changes the port; the same value is what
`QUILL_SEARXNG_URL` points at.

The steps below are for an instance you manage yourself — a different host, a
non-Docker install, or a machine where the container should outlive the dev script.

## 2. Manual setup (Docker)

Run the image:

```bash
docker run -d --name searxng -p 8080:8080 searxng/searxng:latest
```

Settings live at `/etc/searxng/settings.yml` inside the container. The entrypoint creates it from a built-in template on first boot (verified: the file exists at that path in `searxng/searxng:latest`). The reproducible way to edit it is to copy the template out, edit locally, and mount it back in:

```bash
docker cp searxng:/etc/searxng/settings.yml ./searxng-settings.yml
# edit ./searxng-settings.yml (see section 2)
docker rm -f searxng
docker run -d --name searxng -p 8080:8080 \
  -v "$(pwd)/searxng-settings.yml:/etc/searxng/settings.yml:ro" \
  searxng/searxng:latest
```

## 3. Enabling the json format

Add this to `settings.yml`:

```yaml
use_default_settings: true

server:
  secret_key: "change-me-to-a-long-random-string"

search:
  formats:
    - html
    - json
```

With `use_default_settings: true`, SearXNG merges your file over its built-in defaults, so this short file is enough. Set your own `secret_key`; the container generates a random one on first boot otherwise.

**The critical line is `json` under `search.formats`.** SearXNG's built-in default is `['html']` only. Skip it and every `format=json` request returns HTTP 403. The provider treats that as failure and returns `[]`, so the pipeline silently degrades to no research: no exception, no crash, just missing results. This is the single most likely misconfiguration.

## 4. Verifying it works

```bash
curl -i "http://localhost:8080/search?q=searxng+json+format&format=json&categories=general&language=en"
```

A healthy response:

```
HTTP/1.1 200 OK
Content-Type: application/json

{"query":"searxng json format","results":[{"url":"https://example.com/...","title":"...","content":"...","engine":"duckduckgo","score":1.0,"category":"general"}],"answers":[],"corrections":[],"infoboxes":[],"suggestions":[],"unresponsive_engines":[]}
```

(Abridged; a real response carries more fields.) A 403 here means you skipped section 2.

## 5. Compose sidecar

Quill plans to bundle SearXNG as a sidecar for a future HTTP API. No API image exists yet; the app is currently CLI-only via `main.py`. When it does:

```yaml
services:
  api:
    image: quill-api:latest  # future HTTP API image, not built yet
    environment:
      QUILL_SEARXNG_URL: http://searxng:8080
      QUILL_SEARXNG_CATEGORIES: general
    depends_on:
      searxng:
        condition: service_healthy
    networks:
      - quill

  searxng:
    image: searxng/searxng:latest
    volumes:
      - ./searxng-settings.yml:/etc/searxng/settings.yml:ro
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://localhost:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - quill

networks:
  quill:
    driver: bridge
```

Notes:

- The image ships `wget`, not `curl` (verified), so the healthcheck uses wget. `/healthz` returns `200 OK` when the server is ready (verified).
- Because config is a URL, this migration is configuration-only: `http://localhost:8080` today becomes `http://searxng:8080` with zero code change.

## 6. Kubernetes pod-sidecar

Co-locate the SearXNG container in the app's pod: the shared network namespace means the app keeps using `http://127.0.0.1:8080` with no code or config change.
Add `shareProcessNamespace: true` only if the app must see SearXNG's processes; plain HTTP needs nothing beyond same-pod placement.

## 7. Configuration reference

| Variable | Default | Effect |
| --- | --- | --- |
| `QUILL_SEARXNG_URL` | unset (provider disabled, returns `[]`) | Base URL of the SearXNG instance, e.g. `http://localhost:8080` |
| `QUILL_SEARXNG_CATEGORIES` | `general` | Comma-separated SearXNG categories sent as the `categories` query parameter |

When `QUILL_SEARXNG_URL` is unset the provider does not perform research. The local development convention is `http://localhost:8080`, which is what `.env.example` ships.

## 8. Tuning

SearXNG's default engine list is broad. Trimming it to 2-3 engines is the single most effective lever on low-memory devices: less RAM, lower per-query latency, and less rate-limit exposure. With `use_default_settings: false`, only the engines you declare are loaded:

```yaml
use_default_settings: false

server:
  secret_key: "change-me-to-a-long-random-string"
  port: 8080
  bind_address: "0.0.0.0"

search:
  formats:
    - html
    - json

engines:
  - name: duckduckgo
  - name: brave
  - name: wikipedia
```

SearXNG logs warnings for anything else that is missing; treat the log as your checklist.

Redis or valkey is unnecessary for a single node. If you run multiple API replicas, each needs its own SearXNG instance. Sharing one instance makes the replicas hammer the same upstream engines in lockstep and get rate-limited.

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| HTTP 403 on every search | `format=json` not enabled | Add `json` under `search.formats` in settings.yml, restart |
| Empty results, no error | Engine list trimmed too far, or all upstream engines unresponsive | Check `unresponsive_engines` in the response and the SearXNG log; re-enable engines |
| Slow first query | Cold start: engine metadata loads on first query | Send one warm-up request after boot |
| Connection refused | Container not up, or wrong port | `docker ps`; confirm the port mapping. Under `scripts/dev-sidecar.sh` this means it could not start the container -- read its `==> search:` line |

## 10. Licensing

SearXNG is AGPL-3.0. Running an unmodified SearXNG as a separate sidecar process alongside your own API is fine. The AGPL network clause becomes relevant when you modify SearXNG and offer it over a network. If Quill is ever distributed, flag this for whoever owns licensing. This is not legal advice and not a definitive legal conclusion.

## 11. Why not the alternatives

- **Meilisearch** is a document index over your own data, not a web metasearch engine. Wrong tool.
- **MiroFish** (`666ghj/MiroFish`) is a multi-agent swarm prediction engine. Its GraphRAG indexes only uploaded seed material, and it exposes no query-in/web-results-out endpoint. Using it here is a category error.
