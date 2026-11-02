"""Hard content-safety gate for outbound URLs.

Relevance scoring is a *quality* control; it decides whether a page is on
topic. It is not a *safety* control. A broadened query such as "urban
redevelopment of the Roman Forum" can legitimately match off-topic pages, and
quality filtering may still admit a page that should never be downloaded in
the first place.

This module blocks those URLs before any request is made, by matching the
registrable host suffix. Matching is deliberately suffix-based rather than a
substring test on the whole URL: ``example.com/pornhub-news`` is a normal
article URL and must not be blocked, while ``es.pornhub.com/pornstars`` must.
"""
from __future__ import annotations

import urllib.parse

# Host suffixes. Checked against the host's dot-boundary, so "pornhub.com"
# matches "pornhub.com" and "es.pornhub.com" but never "notpornhub.com".
BLOCKED_DOMAINS: frozenset[str] = frozenset(
    {
        # adult / explicit
        "pornhub.com", "xvideos.com", "xnxx.com", "redtube.com", "youporn.com",
        "tube8.com", "spankbang.com", "beeg.com", "xhamster.com", "hclips.com",
        "drtuber.com", "tnaflix.com", "eporner.com", "nuvid.com", "fantasticnudepics.com",
        "onlyfans.com", "fansly.com", "chaturbate.com", "stripchat.com",
        "bongacams.com", "livejasmin.com", "cam4.com", "myfreecams.com",
        "fapdu.com", "efukt.com", "motherless.com", "spanicbang.com",
        "bangbros.com", "realityking.com", "braazzers.com", "bangbrosnetwork.com",
        # gambling
        "bet365.com", "draftkings.com", "fanduel.com", "betmgm.com",
        "williamhill.com", "paddypower.com", "bwin.com", "888casino.com",
        "partycasino.com", "stake.com", "betonline.ag", "bovada.lv",
        # gore / shock
        "liveleak.com", "bestgore.com", "theync.com", "goreview.com",
        "freakytaboo.com", "documenting-reality.com",
        # link shorteners (unresolvable destination = unverifiable provenance)
        "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd",
        "cutt.ly", "rb.gy", "shorturl.at", "tiny.cc", "t.ly",
        # scraping / redirector junk
        "web.archive.org.cache", "bitly.io",
    }
)

# Broad adult terms as a *secondary* defence, matched as a whole host label.
# Kept small on purpose: broad label matching over-blocks legitimate sites.
BLOCKED_HOST_LABELS: frozenset[str] = frozenset(
    {
        "xxx", "porn", "pornhub", "nsfw", "hentai", "xxxvideo", "sexfilm",
    }
)


def _host_matches(host: str, domain: str) -> bool:
    """True when ``host`` equals ``domain`` or is a subdomain of it."""
    if host == domain:
        return True
    return host.endswith("." + domain)


def is_blocked_url(url: str) -> tuple[bool, str]:
    """Return ``(blocked, reason)`` for a candidate URL.

    Non-HTTP schemes are blocked too: only ``http`` and ``https`` may be
    fetched, which also stops ``file://``, ``javascript:`` and ``data:``.
    """
    raw = str(url or "").strip()
    if not raw:
        return True, "empty-url"

    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return True, "unparseable-url"

    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        return True, f"scheme:{scheme or 'none'}"

    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        return True, "no-host"

    # Strip any trailing port already handled by hostname; reject obvious junk.
    if " " in host:
        return True, "malformed-host"

    for domain in BLOCKED_DOMAINS:
        if _host_matches(host, domain):
            return True, f"domain:{domain}"

    labels = host.split(".")
    for label in labels:
        if label in BLOCKED_HOST_LABELS:
            return True, f"host-label:{label}"

    return False, ""


def filter_urls(urls: list[str]) -> tuple[list[str], list[tuple[str, str]]]:
    """Split ``urls`` into ``(kept, blocked)`` where blocked is ``[(url, reason)]``."""
    kept: list[str] = []
    blocked: list[tuple[str, str]] = []
    for url in urls or []:
        hit, reason = is_blocked_url(url)
        if hit:
            blocked.append((url, reason))
        else:
            kept.append(url)
    return kept, blocked
