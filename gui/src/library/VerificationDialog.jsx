import React, { useEffect, useState } from 'react'
import { ModalLayer } from '../ModalLayer.jsx'
import { Icon } from '../Icon.jsx'
import { verifyText } from '../platform/store.js'

/**
 * Citation and plagiarism verification for the open draft.
 *
 * The checks are slow because they are real: DOIs are resolved against
 * Crossref and OpenAlex, works are enriched with institutions and ORCID
 * records, and distinctive sentences are searched in OpenAlex full text and
 * Wikipedia. The dialog never edits the document; it reports what it found so
 * the reader can decide what to keep.
 */
export function VerificationDialog({ text, onClose }) {
  const [state, setState] = useState('loading')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    verifyText({ text })
      .then((data) => {
        if (cancelled) return
        setResult(data && typeof data === 'object' ? data : null)
        setState('ready')
      })
      .catch((reason) => {
        if (cancelled) return
        setError(String(reason?.message || reason || 'Verification failed.'))
        setState('error')
      })
    return () => { cancelled = true }
  }, [text])

  const checks = [...(result?.citations || []), ...(result?.reference_lines || [])]
  const verified = checks.filter((item) => item.status === 'verified').length
  const fake = checks.filter((item) => item.status === 'not_found').length
  const scan = result?.plagiarism || {}
  const flagged = Number(scan.flagged_sentences || 0)
  const checked = Number(scan.checked_sentences || 0)

  return (
    <ModalLayer onClose={onClose}>
      <section className="dialog verify-dialog" role="dialog" aria-modal="true" aria-labelledby="verify-title">
        <header className="dialog-head">
          <div>
            <div className="eyebrow">Verification</div>
            <h2 id="verify-title">Citations, plagiarism and sources</h2>
          </div>
          <button className="dialog-close" type="button" aria-label="Close verification" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="verify-body">
          {state === 'loading' && (
            <div className="verify-loading" role="status">
              <Icon name="cloud" size={18} />
              <strong>Checking sources…</strong>
              <p>Crossref, OpenAlex, ORCID, Wikidata and Wikipedia. This can take a minute.</p>
            </div>
          )}

          {state === 'error' && (
            <div className="verify-error" role="alert">
              <strong>Could not verify this draft.</strong>
              <p>{error}</p>
            </div>
          )}

          {state === 'ready' && result && (
            <>
              <div className="verify-summary">
                <div><span>DOIs resolved</span><strong>{verified}</strong></div>
                <div><span>Fabricated / missing</span><strong className={fake ? 'is-bad' : ''}>{fake}</strong></div>
                <div><span>Passages flagged</span><strong className={flagged ? 'is-bad' : ''}>{flagged}<em> / {checked}</em></strong></div>
                <div><span>Links reachable</span><strong>{(result.url_checks || []).filter((item) => item.status === 'reachable').length}<em> / {(result.url_checks || []).length}</em></strong></div>
              </div>

              <h3 className="verify-heading">Citations</h3>
              {!checks.length ? (
                <p className="verify-note">No DOI or reference-like line was found in this draft.</p>
              ) : (
                <div className="verify-table" role="table" aria-label="Citation results">
                  <div className="verify-row verify-row--head" role="row">
                    <span>Input</span><span>Status</span><span>Resolved work</span><span>OSINT</span>
                  </div>
                  {checks.map((item, index) => {
                    const base = item.openalex || item.crossref || item.best_match || {}
                    const osint = item.osint || {}
                    const extra = []
                    if (osint.institutions?.length) extra.push(osint.institutions.slice(0, 2).join('; '))
                    if (osint.is_retracted) extra.push('RETRACTED')
                    if (osint.cited_by != null) extra.push(`${osint.cited_by} citations`)
                    return (
                      <div className="verify-row" role="row" key={`${item.input}-${index}`}>
                        <span className="verify-input" title={item.input}>{item.input}</span>
                        <span className={`verify-status is-${item.status}`}>{item.status}</span>
                        <span>{base.title || '—'}{base.year ? <small> · {base.year}</small> : null}</span>
                        <span className="verify-osint">{extra.join(' · ') || '—'}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {(result.url_checks || []).length > 0 && (
                <>
                  <h3 className="verify-heading">Links</h3>
                  <ul className="verify-links">
                    {result.url_checks.map((link) => (
                      <li key={link.url}>
                        <span className={`verify-status is-${link.status === 'reachable' ? 'verified' : 'not_found'}`}>{link.status}</span>
                        <a href={link.url} target="_blank" rel="noreferrer noopener">{link.title || link.url}</a>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <h3 className="verify-heading">Copied passages</h3>
              {!checked ? (
                <p className="verify-note">No sentence was long enough to search.</p>
              ) : (
                <div className="verify-matches">
                  {(scan.matches || []).map((match, index) => (
                    <div className={`verify-match${match.flagged ? ' is-flagged' : ''}`} key={`${match.sentence}-${index}`}>
                      <p>“{match.sentence}”</p>
                      <small>
                        {match.flagged ? 'Flagged' : 'Clear'} · best scholarly overlap {Math.round((match.best_similarity || 0) * 100)}%
                        {match.best_title ? ` · ${match.best_title}` : ''}
                      </small>
                      {match.web?.length > 0 && (
                        <div className="verify-web">
                          {match.web.slice(0, 2).map((hit) => (
                            <a key={hit.url} href={hit.url} target="_blank" rel="noreferrer noopener">{hit.title}</a>
                          ))}
                        </div>
                      )}
                      {match.web_phrase_found && <small className="verify-exact">Exact phrase found on a web page.</small>}
                    </div>
                  ))}
                </div>
              )}
              <p className="verify-note verify-footnote">
                A detector or a missing DOI is not proof of misconduct. OpenAlex and Wikipedia cover different
                corpora; a clear result means “not found in these indexes”.
              </p>
            </>
          )}
        </div>
      </section>
    </ModalLayer>
  )
}
