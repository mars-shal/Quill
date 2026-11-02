# syntax=docker/dockerfile:1
# Quill sidecar — the pipeline as an HTTP service.
#
# This is the engine only (api.py): classify, research, write. The Tauri
# desktop app talks to it over HTTP and is not built here; `docker compose
# up` in the repository root wires it to SearXNG, a persistent database and
# a model cache. See docker-compose.yml for the whole stack.
FROM python:3.14-slim-bookworm

# uv installs from the committed lockfile; the torch index in pyproject.toml
# pins CPU-only wheels, so the image stays ~2GB instead of ~7GB of CUDA.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    UV_HTTP_TIMEOUT=600 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# Dependencies first: the lockfile changes rarely, the source changes daily,
# so this layer stays cached across ordinary commits.
#
# The cache mount is what makes a dropped connection cheap: without it every
# retry re-downloads the ~200MB torch wheel from scratch, and this network
# does drop large transfers (two builds in a row timed out mid-wheel). With
# it, an interrupted `uv sync` resumes from what it already fetched.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project

# The pipeline itself. The json store files are small fallbacks; the sqlite
# database is a volume (see compose), so a fresh clone starts fresh.
COPY api.py main.py smoke_concept.py ./
COPY components/ components/
COPY utilis/ utilis/
COPY database/database.json database/db.json database/
COPY scripts/ scripts/

EXPOSE 8000

# 0.0.0.0 because inside a container 127.0.0.1 would refuse the port mapping.
CMD ["python", "api.py", "--host", "0.0.0.0", "--port", "8000"]
