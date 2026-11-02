# Sample log lines — before / after

Scope: audit logging for the SearXNG provider (`ResearchEngine._searxng`) and the entity
resolver (`ResearchEngine._resolve_entity`). **Logging only** — no search-result behavior,
no hit shape, no `_http_get` signature, no `search()` precedence, and no resolver decision
logic changed.

## The "before" is real evidence, not a reconstruction

Taken from the incident run itself, `logs/quill-20261008-171831.log` — the run where the
prompt named no stadium and the resolver returned `Stadio dei Marmi`.

```
$ grep -ic searxng logs/quill-20261008-171831.log
0
$ for p in "searxng request:" "searxng response:" "entity provenance:" "entity resolution:"; do
      printf '%-22s %s\n' "$p" "$(grep -cF "$p" logs/quill-20261008-171831.log)"; done
searxng request:       0
searxng response:      0
entity provenance:     0
entity resolution:     1
```

Three facts fall out of that count, and they are the whole motivation:

1. **The request was never auditable.** The only provider-level evidence was
   `CALL ResearchEngine.search query=<text>` — the query text, never the URL, host, or
   categories actually sent.
2. **The entity's origin was invisible.** The single `entity resolution:` line reads:

   ```
   entity resolution: Thesis on the demolition of a stadium in Rome -> Stadio dei Marmi confirmed by 'The Studio and the Sons of the She-Wolf ... | Stadio dei Marmi - Wikipedia | -The Olympic stadium of Rome after 1990 and Sta' ambiguous=False
   ```

   Nothing in that line distinguishes *"the user wrote `Stadio dei Marmi`"* from *"the model
   chose `Stadio dei Marmi` out of a generic concept"*. The user wrote neither.
3. **A silent provider failure.** That run made **zero** SearXNG calls (`_ddg` 21, `_bing` 20,
   `_searxng` 0) and the log never says so — the unconfigured-instance early return was
   invisible. That is why the change adds a `searxng skipped:` line as well.

---

## `_searxng` — one call, before and after

### Before (nothing)

```
(only this, from @timed's CALL line)
CALL  ResearchEngine.search query=Stadio dei Marmi demolition 1968 official reason
```

No host. No path. No `format`/`categories`/`language`. No idea whether the instance returned
0 results or 40 that were all filtered.

### After

From a real request against a listening instance (`artifacts/logging/manual-qa.txt`, §1):

```
searxng request: base=http://127.0.0.1:33929 url=http://127.0.0.1:33929/search?q=Stadio+Olimpico+demolition+Rome&format=json&categories=general%2Cscience&language=en params: q='Stadio Olimpico demolition Rome' format=json categories=general,science language=en
searxng response: instance_returned=12 usable=10 kept=8 dropped=2
```

* `base=` is the configured host — a misconfigured instance is now obvious at a glance, and
  it also preserves a reverse-proxy path prefix (`/searxng`) in the echoed `url=`.
* `params:` repeats every parameter with its real value, so a check that omits
  `categories=` fails loudly instead of silently logging a partial line.
* Both the structured params **and** the percent-encoded URL come from the same `params`
  dict, so the log cannot drift from the request it describes. The *raw* URL is deliberately
  not echoed — it carries the untruncated query back in.

### The three failure shapes are now distinguishable

```
# instance had nothing
searxng response: instance_returned=0 usable=0 kept=0 dropped=0

# instance had plenty, everything unusable here (non-http url)
searxng response: instance_returned=20 usable=0 kept=0 dropped=0

# over the 8-hit cap
searxng response: instance_returned=20 usable=20 kept=8 dropped=12
```

The first two both return `[]` to `search()` and both fall through to `_ddg`. Before, they
were indistinguishable. A third shape — the instance unreachable — emits the request line
plus the pre-existing `searxng failed:` warning and **no** outcome line, correctly, because
there is no response to size:

```
searxng request: base=http://127.0.0.1:1 url=http://127.0.0.1:1/search?q=the+instance+is+gone&... params: q='the instance is gone' ...
searxng failed: URLError: <urlopen error [Errno 111] Connection refused>
```

And the unconfigured case now says so instead of returning silently:

```
searxng skipped: QUILL_SEARXNG_URL unset/empty, no request sent q='q'
```

### Truncation (cap = 200 chars, stated in a comment at the constant)

A 480-char query, logged:

```
searxng request: base=http://127.0.0.1:40411 url=...q=tok0000+tok0001+...+tok0024+...%28%2B279+chars%29&format=json&... params: q='tok0000 tok0001 ... tok0024 ...(+279 chars)' format=json categories=general,science language=en
```

200 chars of query plus an explicit `...(+279 chars)` marker — a reader can tell a shortened
value from a complete one. The **request itself is untouched**: `parse_qs(...)["q"]` still
returns all 480 characters, verified by a test. The untruncated query also remains in
`@timed`'s `CALL` line.

Whitespace is flattened before logging, so a query carrying newlines cannot split one record
into several or forge one:

```
q='Stadio dei Marmi demolition FORGED: searxng response: instance_returned=99'
```

— that text stays inside the quoted `q` field of a real record. It cannot become a record of
its own; the test asserts no record *starts with* `searxng response: instance_returned=99`.

---

## `_resolve_entity` — before and after

The existing line is **kept verbatim** in every branch (other tooling greps its wording);
the provenance line is additive and is emitted immediately before it.

### INFERRED — the incident. Entity absent from the user's text

```
entity provenance: origin=model-generated (INVENTED: the entity string does NOT occur in the concept/user text) entity='Stadio dei Marmi' concept='Thesis on the demolition of a stadium in Rome' confirmed_by='Stadio dei Marmi - Wikipedia | Stadio dei Marmi (Carrara)' ambiguous=False
entity resolution: Thesis on the demolition of a stadium in Rome -> Stadio dei Marmi confirmed by 'Stadio dei Marmi - Wikipedia | Stadio dei Marmi (Carrara)' ambiguous=False
```

`INVENTED` is the word that would have surfaced the Carrara homonym immediately: the
confirming titles are right there, and they are about a stadium of capacity 4,194 in Tuscany,
not the Rome Olympic Stadium. Note the resolver still returns `Stadio dei Marmi` — this is
the logging-only increment, and the log is precisely where the invention stays visible.

### SUPPLIED — the user named it

```
entity provenance: origin=user-supplied (the entity string occurs in the concept/user text) entity='Stadio Olimpico' concept='History of the Stadio Olimpico in Rome' confirmed_by='Stadio Olimpico - Wikipedia | Stadio Olimpico history' ambiguous=False
entity resolution: History of the Stadio Olimpico in Rome -> Stadio Olimpico confirmed by 'Stadio Olimpico - Wikipedia | Stadio Olimpico history' ambiguous=False
```

### Third branch — the name came from result titles, not from the model or the user

```
entity provenance: origin=result-titles (attested in 2+ hit titles, not from the model or the concept) entity='Stadio dei Marmi' ...
```

Reported before the user-supplied check, because it is the more specific origin.

### Ambiguity gets its own line

```
entity provenance: origin=result-titles (attested in 2+ hit titles, not from the model or the concept) entity='Stadium of Domitian' concept='thesis on the demolition of the Stadium of Rome' confirmed_by='Stadium of Domitian - Wikipedia | Stadium of Domitian reconstructed' ambiguous=True
entity anchor risk: ambiguous=true, downstream planner queries will be anchored on 'Stadium of Domitian' (titles admitting other referents: 'Stadium of Domitian - Wikipedia | Stadium of Domitian reconstructed')
entity resolution: thesis on the demolition of the Stadium of Rome -> Stadium of Domitian confirmed by '...' ambiguous=True (resolved from result titles)
```

`ambiguous=True` used to ride inside the combined line, where its consequence is invisible:
the anchor is applied anyway, and all ~30 planner queries inherit it. The new line states
the consequence explicitly.

### Cache hit — otherwise a re-run reports nothing at all

```
entity provenance: origin=cache-hit (not re-verified this run) entity='Stadio dei Marmi' concept='Thesis on the demolition of a stadium in Rome'
```

A cache hit short-circuits every confirmation below it, so without this line the second run
of a concept emits no provenance and a reviewer assumes the anchor was checked. It was not,
this run.

---

## Matching rule behind `origin=user-supplied`

The check is a casefolded, whitespace-flattened, **word-bounded** phrase match against the
concept text — not a bare substring test:

| input | result | why |
| --- | --- | --- |
| entity `Stadio dei Marmi` in `thesis on Stadio dei Marmi in Rome` | present | full phrase |
| entity `Stadio dei Mar` in `thesis on Stadio dei Marmi in Rome` | **absent** | prefix of a longer word — a substring test would wrongly call this user-supplied |
| entity `stadio  dei MARMI` in `Thesis On\nStadio   Dei Marmi Today` | present | case + whitespace insensitive |
| entity `""` or empty text | absent | never a mention |

The concept is the only text available at that point — `_resolve_entity(concept)` is not
handed the raw prompt, and widening its signature would be a behavior change beyond logging.
The concept is derived from the user's prompt, which is the text the anchor has to be
traceable to.

## Log levels

`searxng request:` and `searxng response:` are **DEBUG** (file sink; they are per-query and
would drown the console). The entity lines are **INFO** — the resolver runs once per run, and
the incident was diagnosed from a log file where INFO is the loudest thing still readable.
No line was escalated to WARNING, so no existing severity-based tooling changes meaning.
