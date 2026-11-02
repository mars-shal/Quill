# Doc review — docs/searxng.md

Every factual claim in the doc, classified by how it was established.
Date: 2026-10-09

## Verified empirically (this session)

| # | Claim in doc | Evidence |
|---|---|---|
| 1 | `searxng/searxng:latest` exists and pulls from Docker Hub | `docker run --rm` pulled it; digest sha256:5903efa50bc6b99293fa059f7a0ff37eddd910210196af77d02e5536ccdfb387. See `image-tag-check.txt` |
| 2 | Resolved version is SearXNG 2026.10.9-9f042d2f6 | Startup log line, captured in `image-tag-check.txt` |
| 3 | Settings live at `/etc/searxng/settings.yml` inside the container | `docker exec quill-doccheck ls -la /etc/searxng/` shows the file (204 bytes). See `settings-path-check.txt` |
| 4 | The entrypoint creates settings.yml from a template on first boot | Startup log: `"/etc/searxng/settings.yml" does not exist, creating from template...` |
| 5 | Default settings.yml has NO `search.formats` key (so json is off by default) | `docker exec quill-doccheck cat /etc/searxng/settings.yml` shows only `use_default_settings: true`, `server.secret_key`, `image_proxy: true` |
| 6 | Default instance returns HTTP 403 on `format=json` | Live test: `wget .../search?q=test&format=json...` → `HTTP/1.1 403 Forbidden` |
| 7 | Adding `search.formats: [html, json]` makes the same request return 200 JSON | Live test after mounting patched settings: `HTTP/1.1 200 OK`, body `{"query": "searxng", "results": [{"template": "default.html", "title": "...", "content": "..."}]}` |
| 8 | The response shape includes `query` and `results` with `title`/`content` fields | Same live 200 response |
| 9 | The image ships `wget` at `/usr/sbin/wget` and does NOT ship `curl` | `docker run --entrypoint sh ... -c "which curl wget"` → only `/usr/sbin/wget` |
| 10 | `/healthz` returns 200 "OK" via wget | `wget -q -O- http://localhost:8080/healthz` → `OK`, `HTTP/1.1 200 OK` |
| 11 | All three YAML blocks in the doc parse with PyYAML 6.0.3 | settings snippet → keys [use_default_settings, server, search]; compose → services [api, searxng], healthcheck wget command, depends_on service_healthy; tuning snippet → keys incl. engines |
| 12 | Container cleanup complete | `docker ps -a --filter name=quill-doccheck` → header only, zero rows |

## Taken on trust (from task context, not independently verified)

| # | Claim in doc | Note |
|---|---|---|
| 1 | SearXNG is AGPL-3.0, 38.1k stars, github.com/searxng/searxng | Given in task context; license verdict explicitly flagged as not-legal-advice per instructions |
| 2 | Consumer call shape `GET {base}/search?q=<query>&format=json&categories=<cats>&language=en` | Given in task context; consistent with live tests but the provider code itself is owned by another lane and was not read |
| 3 | Full success-body field list (`answers`, `corrections`, `infoboxes`, `suggestions`, `unresponsive_engines`, `engine`, `score`, `category`) | Given in task context; live 200 response confirmed `query`/`results`/`title`/`content`, remaining fields observed truncated or unverified |
| 4 | Many public instances have json disabled | Given in task context; not surveyed |
| 5 | Config read from env at call time; no constructor argument | Given in task context (design decision by the lane owning researchEngine.py) |
| 6 | Provider returns `[]` on failure, pipeline degrades silently | Given in task context; provider code not read (out of scope) |
| 7 | Engine list is broad; trimming to 2-3 engines cuts RAM, latency, rate-limit exposure | Given in task context; not benchmarked here |
| 8 | Redis/valkey unnecessary for single node; replicas need their own instance | Given in task context (standard SearXNG ops guidance) |
| 9 | Meilisearch = document index, not metasearch | Given in task context |
| 10 | MiroFish (`666ghj/MiroFish`) = multi-agent swarm prediction engine, GraphRAG over seed material only, no query-in/web-results-out endpoint | Given in task context; the repo was not fetched |

## Verification gaps (flagged)

- The provider's exact failure handling (403 → `[]`) was not executed; it is owned by `components/researchEngine.py`, which is out of scope. The 403 itself is verified; the `[]` behavior is trusted from task context.
- The compose file is machine-parseable but was not `docker compose up`-ed: the `api` service image (`quill-api:latest`) does not exist by design. The searxng side of the compose (image, volume mount, healthcheck, network) is exactly what was live-tested in Docker, just not via the compose file itself.
- The task's literal verify command (`split('```yaml')[1]`) parses the FIRST yaml block in the doc, which is the settings snippet, not the compose; it prints `compose yaml OK []`. The compose block (2nd yaml block) was parsed by index and yields `['api', 'searxng']`.
