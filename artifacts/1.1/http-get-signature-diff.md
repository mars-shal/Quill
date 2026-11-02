# `_http_get` signature — before / after

The shared outbound path used by `_ddg`, `_bing`, `_fetch`, and now `_searxng`.
Backward compatibility here is the highest-risk part of this increment: three
pre-existing callers depend on the old behavior with no changes of their own.

## Before

```python
@timed("ResearchEngine._http_get")
def _http_get(self, url: str) -> bytes:
    from utilis.safety import is_blocked_url
    blocked, reason = is_blocked_url(url)
    if blocked:
        logger.info("BLOCKED url={} reason={}", (url or "")[:120], reason)
        raise ValueError(f"blocked url ({reason}): {url!r}")
    if not url or not url.lower().startswith(("http://", "https://")):
        raise ValueError(f"unusable url: {url!r}")
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
            "Accept": "text/html,application/rss+xml",
        },
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        return resp.read()
```

## After

```python
_HTTP_DEFAULT_HEADERS: dict[str, str] = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "text/html,application/rss+xml",
}

@timed("ResearchEngine._http_get")
def _http_get(
    self,
    url: str,
    *,
    timeout: float = 12,
    headers: dict[str, str] | None = None,
) -> bytes:
    ...
    merged = dict(self._HTTP_DEFAULT_HEADERS)
    if headers:
        merged.update(headers)
    req = urllib.request.Request(url, headers=merged)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()
```

## Behavioral diff

| aspect | before | after | caller impact |
|---|---|---|---|
| positional arity | `(self, url)` | `(self, url)` — the two new params are keyword-only | none |
| `urlopen` timeout | literal `12` | `timeout`, default `12` | none |
| request headers | inline dict, 2 keys | `_HTTP_DEFAULT_HEADERS` merged with `{}` when `headers is None` | none; same two keys, same order, same values |
| extra headers | n/a | merged OVER the defaults | `_searxng` only |
| safety gate | `is_blocked_url` → `ValueError` | unchanged | none |
| non-http(s) gate | `ValueError("unusable url")` | unchanged | none (unreachable from outside: see below) |
| return | `bytes` from `resp.read()` | unchanged | none |

Still one HTTP path. No second fetcher was added.

## Why merge instead of replace

`headers` is merged over the defaults rather than replacing them. `_searxng`
needs only `Accept: application/json`; a replace-semantics argument would
silently drop the Firefox `User-Agent` and get the instance to bot-block us.
Merge keeps one header contract for all four providers.

`merged = dict(self._HTTP_DEFAULT_HEADERS)` copies before `update()`, so a
caller mutating what it passed in (or the shared class dict) cannot corrupt
subsequent requests. Pinned by
`_HTTP_DEFAULT_HEADERS not mutated by a request` in `tests/test_searxng.py`.

## Note on a dead branch

The `unusable url` check now reads as redundant: `is_blocked_url` rejects every
non-http(s) scheme first (`scheme:foo`, `scheme:none`, `scheme:javascript`, …),
so `startswith(("http://", "https://"))` can never be false by the time it is
reached. It is left in place — deleting it is a behavior-neutral cleanup that
belongs to whoever owns that gate, not to this increment. The baseline pins
assert the observable `ValueError`, not that unreachable wording.
