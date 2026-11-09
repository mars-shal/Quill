"""Citation, plagiarism and OSINT checks for the evaluation harness.

All sources are open or public:
  * Crossref       -- DOI metadata
  * OpenAlex       -- works, authors, institutions, retraction flag, full text search
  * ORCID          -- author employment records
  * Wikidata       -- entity lookup
  * Wikipedia     -- an open-source web search engine

The checks are deliberately conservative. A DOI that resolves is "verified";
a citation string without a DOI is only "probable" when Crossref's top result
has a high title similarity. Plagiarism is reported as matched passages, not a
single percentage, because a single percentage hides which sentences matched.
"""

from __future__ import annotations

import difflib
import json
import re
import sys
import time
import urllib.parse
from dataclasses import dataclass, asdict, field
from typing import Any

import requests
from bs4 import BeautifulSoup

UA = "QuillEval/1.0 (open-source citation and plagiarism checks; mailto:eval@example.com)"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": UA, "Accept": "application/json"})

DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Z0-9]+\b", re.I)
URL_RE = re.compile(r"https?://[^\s<>)\]]+", re.I)


def _get(url: str, **kwargs) -> requests.Response | None:
    try:
        response = SESSION.get(url, timeout=kwargs.pop("timeout", 25), **kwargs)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response
    except requests.RequestException:
        return None


def _json(url: str, **kwargs) -> Any:
    response = _get(url, **kwargs)
    if response is None:
        return None
    try:
        return response.json()
    except ValueError:
        return None


def extract_dois(text: str) -> list[str]:
    seen: list[str] = []
    for match in DOI_RE.findall(text):
        doi = match.rstrip(".,;:)")
        if doi.lower() not in {item.lower() for item in seen}:
            seen.append(doi)
    return seen


def extract_urls(text: str) -> list[str]:
    seen: list[str] = []
    for match in URL_RE.findall(text):
        url = match.rstrip(".,;:)")
        if "doi.org/" in url:
            continue
        if url not in seen:
            seen.append(url)
    return seen


def title_similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()


def crossref_lookup(doi: str) -> dict | None:
    data = _json(f"https://api.crossref.org/works/{urllib.parse.quote(doi)}")
    if not data or "message" not in data:
        return None
    m = data["message"]
    authors = []
    for author in m.get("author") or []:
        name = " ".join(x for x in (author.get("given"), author.get("family")) if x)
        if name:
            authors.append(name)
    year = None
    for key in ("published-print", "published-online", "issued", "created"):
        parts = (m.get(key) or {}).get("date-parts") or []
        if parts and parts[0]:
            year = parts[0][0]
            break
    return {
        "source": "crossref",
        "doi": m.get("DOI", doi),
        "title": (m.get("title") or [""])[0],
        "authors": authors,
        "year": year,
        "venue": (m.get("container-title") or [""])[0],
        "publisher": m.get("publisher", ""),
        "url": m.get("URL", ""),
    }


def openalex_lookup(doi: str) -> dict | None:
    data = _json(
        "https://api.openalex.org/works/https://doi.org/"
        + urllib.parse.quote(doi)
        + "?mailto=eval@example.com"
    )
    if not data:
        return None
    authors = []
    institutions = []
    orcids = []
    countries = []
    for authorship in data.get("authorships") or []:
        author = authorship.get("author") or {}
        if author.get("display_name"):
            authors.append(author["display_name"])
        if author.get("orcid"):
            orcids.append(author["orcid"].rsplit("/", 1)[-1])
        for inst in authorship.get("institutions") or []:
            if inst.get("display_name"):
                institutions.append(inst["display_name"])
            if inst.get("country_code"):
                countries.append(inst["country_code"])
    return {
        "source": "openalex",
        "id": data.get("id", ""),
        "doi": (data.get("doi") or "").replace("https://doi.org/", ""),
        "title": data.get("title", ""),
        "authors": authors,
        "year": data.get("publication_year"),
        "venue": ((data.get("primary_location") or {}).get("source") or {}).get("display_name", ""),
        "cited_by": data.get("cited_by_count", 0),
        "is_retracted": bool(data.get("is_retracted")),
        "type": data.get("type", ""),
        "institutions": list(dict.fromkeys(institutions)),
        "countries": list(dict.fromkeys(countries)),
        "orcids": list(dict.fromkeys(orcids)),
    }


def search_crossref(query: str, rows: int = 3) -> list[dict]:
    data = _json(
        "https://api.crossref.org/works",
        params={"query.bibliographic": query, "rows": rows, "mailto": "eval@example.com"},
    )
    items = ((data or {}).get("message") or {}).get("items") or []
    out = []
    for m in items:
        out.append({
            "doi": m.get("DOI", ""),
            "title": (m.get("title") or [""])[0],
            "year": (((m.get("issued") or {}).get("date-parts") or [[None]])[0][0]),
            "venue": (m.get("container-title") or [""])[0],
        })
    return out


def orcid_employment(orcid: str) -> list[str]:
    data = _json(
        f"https://pub.orcid.org/v3.0/{urllib.parse.quote(orcid)}/employments",
        headers={"Accept": "application/json"},
    )
    orgs = []
    for group in (data or {}).get("affiliation-group") or []:
        for summary in group.get("summaries") or []:
            employment = summary.get("employment-summary") or {}
            org = (employment.get("organization") or {}).get("name")
            if org:
                orgs.append(org)
    return list(dict.fromkeys(orgs))


def wikidata_lookup(title: str) -> dict | None:
    data = _json(
        "https://www.wikidata.org/w/api.php",
        params={
            "action": "wbsearchentities",
            "search": title,
            "language": "en",
            "format": "json",
            "limit": 1,
        },
    )
    hits = (data or {}).get("search") or []
    if not hits:
        return None
    hit = hits[0]
    return {"qid": hit.get("id"), "label": hit.get("label"), "description": hit.get("description")}


def verify_citation(doi: str | None = None, reference: str = "") -> dict:
    doi = (doi or "").strip()
    if doi:
        crossref = crossref_lookup(doi)
        openalex = openalex_lookup(doi)
        if not crossref and not openalex:
            return {
                "input": doi,
                "status": "not_found",
                "reason": "DOI did not resolve at Crossref or OpenAlex",
            }
        base = openalex or crossref or {}
        osint = {
            "institutions": (openalex or {}).get("institutions", []),
            "countries": (openalex or {}).get("countries", []),
            "cited_by": (openalex or {}).get("cited_by", None),
            "is_retracted": (openalex or {}).get("is_retracted", None),
            "wikidata": wikidata_lookup(base.get("title", "")) if base.get("title") else None,
            "orcid_employment": [],
        }
        for orcid in (openalex or {}).get("orcids", [])[:2]:
            osint["orcid_employment"].append({
                "orcid": orcid,
                "employment": orcid_employment(orcid),
            })
        return {
            "input": doi,
            "status": "verified",
            "crossref": crossref,
            "openalex": openalex,
            "osint": osint,
        }

    candidates = search_crossref(reference)
    if not candidates:
        return {"input": reference, "status": "not_found", "reason": "no Crossref match"}
    best = max(candidates, key=lambda item: title_similarity(reference, item.get("title", "")))
    similarity = title_similarity(reference, best.get("title", ""))
    return {
        "input": reference,
        "status": "probable" if similarity >= 0.75 else "unverified",
        "similarity": round(similarity, 3),
        "best_match": best,
        "candidates": candidates,
    }


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [re.sub(r"\s+", " ", p).strip() for p in parts if len(p.split()) >= 12]


def _ngram_overlap(a: str, b: str, n: int = 4) -> float:
    aw = re.findall(r"[a-z0-9']+", (a or "").lower())
    bw = re.findall(r"[a-z0-9']+", (b or "").lower())
    if len(aw) < n or len(bw) < n:
        return 0.0
    aset = {" ".join(aw[i : i + n]) for i in range(len(aw) - n + 1)}
    bset = {" ".join(bw[i : i + n]) for i in range(len(bw) - n + 1)}
    return len(aset & bset) / max(1, len(aset))


def _openalex_phrase(phrase: str, limit: int = 3) -> list[dict]:
    query = urllib.parse.quote(f'"{phrase}"')
    data = _json(
        f"https://api.openalex.org/works?filter=fulltext.search:{query}&per-page={limit}&mailto=eval@example.com"
    )
    if not (data or {}).get("results"):
        # Exact fulltext search is strict. Fall back to the ordinary search,
        # then compare abstracts, so a paraphrased match is still visible.
        data = _json(
            "https://api.openalex.org/works",
            params={"search": phrase, "per-page": limit, "mailto": "eval@example.com"},
        )
    out = []
    for work in (data or {}).get("results") or []:
        abstract = ""
        inverted = work.get("abstract_inverted_index")
        if isinstance(inverted, dict):
            words = []
            for word, positions in inverted.items():
                for pos in positions or []:
                    words.append((pos, word))
            abstract = " ".join(word for _, word in sorted(words))
        out.append({
            "title": work.get("title", ""),
            "doi": (work.get("doi") or "").replace("https://doi.org/", ""),
            "url": work.get("id", ""),
            "abstract": abstract,
        })
    return out


def _page_text(url: str) -> str:
    response = _get(url, headers={"Accept": "text/html"}, timeout=12)
    if response is None:
        return ""
    soup = BeautifulSoup(response.text, "html.parser")
    for node in soup(["script", "style", "noscript"]):
        node.decompose()
    return " ".join(soup.get_text(" ", strip=True).split())


def _wikipedia(phrase: str, limit: int = 3) -> list[dict]:
    """Search Wikipedia's open API for the exact phrase.

    Wikipedia is currently bot-gated and returns a challenge page to scripted
    clients. Wikipedia is stable, open, and useful as a web-copy check even
    though it is not a scholarly index.
    """
    data = _json(
        "https://en.wikipedia.org/w/api.php",
        params={
            "action": "query",
            "list": "search",
            "srsearch": f'"{phrase}"',
            "srlimit": limit,
            "format": "json",
            "utf8": 1,
        },
    )
    out = []
    for hit in ((data or {}).get("query") or {}).get("search") or []:
        title = hit.get("title", "")
        snippet = BeautifulSoup(hit.get("snippet", ""), "html.parser").get_text(" ", strip=True)
        out.append({
            "title": title,
            "url": "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
            "snippet": snippet[:300],
            "phrase_found": phrase.lower() in snippet.lower(),
        })
    return out


def plagiarism_scan(text: str, max_sentences: int = 5) -> dict:
    candidates = []
    for sentence in _sentences(text):
        if len(sentence) < 90 or sentence.startswith("#"):
            continue
        candidates.append(sentence)
    # Prefer long, distinctive sentences, spread across the document.
    step = max(1, len(candidates) // max_sentences)
    selected = candidates[::step][:max_sentences] if candidates else []

    matches = []
    for sentence in selected:
        words = sentence.split()
        phrase = " ".join(words[:14])
        scholarly = _openalex_phrase(phrase)
        web = _wikipedia(phrase)
        best_similarity = 0.0
        best_title = ""
        for work in scholarly:
            score = max(
                _ngram_overlap(sentence, work.get("title", "")),
                _ngram_overlap(sentence, work.get("abstract", "")[:1200]),
            )
            if score > best_similarity:
                best_similarity = score
                best_title = work.get("title", "")
        matches.append({
            "sentence": sentence,
            "query": phrase,
            "scholarly": scholarly,
            "web": web,
            "best_similarity": round(best_similarity, 3),
            "best_title": best_title,
            "web_phrase_found": any(hit.get("phrase_found") for hit in web),
            "flagged": best_similarity >= 0.35 or any(hit.get("phrase_found") for hit in web),
        })
    flagged = [m for m in matches if m["flagged"]]
    return {
        "checked_sentences": len(matches),
        "flagged_sentences": len(flagged),
        "matches": matches,
    }


def analyse_document(text: str) -> dict:
    dois = extract_dois(text)
    urls = extract_urls(text)
    citations = [verify_citation(doi=doi) for doi in dois]
    # A short "References" line without a DOI can still be checked against
    # Crossref. Only lines that look like a citation are used.
    reference_lines = []
    for line in text.splitlines():
        stripped = line.strip(" -*\t")
        words = stripped.split()
        if len(words) < 8 or len(words) > 60:
            continue
        if any(doi.lower() in stripped.lower() for doi in dois):
            continue
        lower = stripped.lower()
        starts_like_reference = bool(
            re.match(r"^(?:\[\d+\]|\d+\.)\s", stripped)
            or re.match(r"^[A-Z][^.]{2,80}\(?(?:19|20)\d{2}\)?", stripped)
        )
        if ("doi" in lower or "http" in lower or starts_like_reference) and re.search(r"\b(19|20)\d{2}\b", stripped):
            reference_lines.append(stripped[:300])
    probable = [verify_citation(reference=line) for line in reference_lines[:6]]
    url_checks = []
    for url in urls[:8]:
        response = _get(url, headers={"Accept": "text/html"})
        title = ""
        if response is not None:
            soup = BeautifulSoup(response.text, "html.parser")
            title = (soup.title.string or "").strip() if soup.title else ""
        url_checks.append({
            "url": url,
            "status": "reachable" if response is not None else "unreachable",
            "title": title[:160],
        })
    return {
        "dois": dois,
        "urls": urls,
        "url_checks": url_checks,
        "citations": citations,
        "reference_lines": probable,
        "verified_dois": sum(1 for item in citations if item["status"] == "verified"),
        "plagiarism": plagiarism_scan(text),
    }


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: verify.py <file> [out.json]")
    path = sys.argv[1]
    text = open(path, encoding="utf-8").read()
    result = analyse_document(text)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if len(sys.argv) > 2:
        with open(sys.argv[2], "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
