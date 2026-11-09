import React, { useState } from 'react'
import { ModalLayer } from '../ModalLayer.jsx'
import { Icon } from '../Icon.jsx'
import { listComments, removeComment } from './comments/comments.js'

/** Document comments. The anchor is the text selection the reader had when
    opening the dialog; the thread is local to this machine. */
export function CommentsDialog({ docId, quote = '', onClose, onAdd }) {
  const [comments, setComments] = useState(() => listComments(docId))
  const [text, setText] = useState('')

  const submit = (event) => {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    onAdd?.(value, quote)
    setComments(listComments(docId))
    setText('')
  }

  const remove = (id) => {
    setComments(removeComment(docId, id))
  }

  return (
    <ModalLayer onClose={onClose}>
      <section className="dialog comments-dialog" role="dialog" aria-modal="true" aria-labelledby="comments-title">
        <header className="dialog-head">
          <div>
            <div className="eyebrow">Review</div>
            <h2 id="comments-title">Comments</h2>
          </div>
          <button className="dialog-close" type="button" aria-label="Close comments" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
        <form className="comment-form" onSubmit={submit}>
          {quote ? (
            <blockquote className="comment-quote">{quote}</blockquote>
          ) : (
            <p className="comment-hint">Select text first to anchor a new comment.</p>
          )}
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Write a comment…"
            rows="3"
            disabled={!quote}
          />
          <button className="soft-button primary" type="submit" disabled={!quote || !text.trim()}>
            Add comment
          </button>
        </form>
        <div className="comment-list" aria-label="Comment threads">
          {comments.length === 0 ? (
            <p className="comment-hint">No comments yet.</p>
          ) : comments.map((comment) => (
            <article className="comment-item" key={comment.id}>
              <div className="comment-item-head">
                <strong>Comment</strong>
                <button type="button" aria-label="Delete comment" onClick={() => remove(comment.id)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
              {comment.quote && <blockquote>{comment.quote}</blockquote>}
              <p>{comment.text}</p>
            </article>
          ))}
        </div>
        <p className="comment-note">Comments are stored on this machine.</p>
      </section>
    </ModalLayer>
  )
}
