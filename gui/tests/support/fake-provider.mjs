/**
 * A fake OpenAI-compatible provider, served over a real socket.
 *
 * Every provider-touching test needs the same three things: somewhere to send a
 * request, a record of what was sent, and a way to fail when nothing was sent.
 * The third is the one that is easy to get wrong, and it is the reason this file
 * exists rather than a stubbed `fetch`. A fixture that returns a canned body
 * regardless of what the caller did will let a suite stay green with the provider
 * call deleted outright -- the test still gets its reply, so it passes, and the
 * only symptom is a feature that ships doing nothing. So every claim this fixture
 * makes is falsifiable, and `provider-fixture.test.mjs` proves it by running those
 * claims against a request that deliberately never happens.
 *
 * Node stdlib only, on an ephemeral port. Port 0 lets the kernel pick, which is
 * the only arrangement that cannot collide twice: a fixed port collides with
 * whatever else the machine is running (there is an unrelated service holding
 * 8000 here, and binding it would fail the suite for a reason that has nothing
 * to do with the code under test), and two suites running side by side would
 * collide with each other.
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'

/** How long `waitForRequest` keeps looking before it reports that nothing arrived. */
const WAIT_MS = 1_000

/** How often `waitForRequest` re-checks. Short, because the fixture is local. */
const POLL_MS = 5

/**
 * How long `stop()` gives a still-connected client before destroying it.
 *
 * `server.close()` only resolves once every live connection has ended, and a
 * Node `fetch` parks its socket in a pool for the server's keep-alive window, so
 * a plain close can sit there for seconds. Idle sockets are dropped immediately;
 * only a connection that is still mid-request survives this window, and
 * destroying one is the right answer for a fixture whose caller has already moved
 * on. The bound is what makes `stop()` unable to hang rather than merely unlikely
 * to.
 */
const STOP_GRACE_MS = 250

/** How much of a recorded body a failure message quotes. */
const DUMP_CHARS = 160

/**
 * The canned replies, one per endpoint, keyed by exact path.
 *
 * These are the real OpenAI shapes rather than one generic `{ ok: true }`, because
 * a fixture that answers both endpoints identically cannot catch the bug worth
 * catching here: a client that posts a chat-completions body to `/v1/responses`
 * and reads a chat reply back. The two are distinguishable three ways -- the id
 * prefix (`chatcmpl-` vs `resp_`), the `object` discriminator (`chat.completion`
 * vs `response`), and the container the text lives in (`choices[]` vs `output[]`).
 */
const REPLIES = new Map([
  ['/v1/chat/completions', () => ({
    id: 'chatcmpl-fixture0000000000000000',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'fixture-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'fixture chat completion' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  })],
  ['/v1/responses', () => ({
    id: 'resp_fixture0000000000000000',
    object: 'response',
    created_at: 1_700_000_000,
    model: 'fixture-model',
    status: 'completed',
    output: [{
      id: 'msg_fixture00000000000000',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'fixture response' }],
    }],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  })],
])

/** Reads a request body to the end. A request with no body reads as empty. */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The bearer token a request presented, or `''` when it presented none.
 *
 * `''` rather than `null`, so "no credential" and "an empty credential" cannot be
 * confused for "some credential we have not parsed", and so `assertApiKey` can
 * branch on presence rather than on a parse that might have failed.
 */
function bearerOf(headers) {
  const match = /^Bearer\s+(.*)$/i.exec(String(headers.authorization ?? '').trim())
  return match ? match[1].trim() : ''
}

/** Accepts a path as shorthand for "any request to that path". */
const matches = (predicate) =>
  typeof predicate === 'string' ? (record) => record.path === predicate : predicate

/** Replies with JSON. `content-length` is set so a client can see the fixture is complete. */
function sendJson(res, status, payload) {
  const json = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

export function createFakeProvider() {
  /** Every request received, in order, whether or not it could be parsed. */
  const requests = []

  let server = null
  let starting = null
  let address = null
  /** Tracked so `stop()` can drop connections the way a hung test would leave them. */
  const sockets = new Set()

  const last = (predicate) => [...requests].reverse().find((r) => matches(predicate)(r))

  /** One line per recorded request, for a failure message. */
  const dump = () => {
    if (requests.length === 0) return '  (the fixture recorded no requests at all)'
    return requests.map((record, i) => {
      const body = record.bodyIsJson ? JSON.stringify(record.body) : `unparseable(${record.rawBody})`
      const credential = record.apiKey === '' ? 'no Authorization header' : `Bearer ${record.apiKey}`
      return `  #${i} ${record.method} ${record.path}${record.query} -> ${record.status}\n` +
        `      credential: ${credential}\n` +
        `      body: ${body.slice(0, DUMP_CHARS)}`
    }).join('\n')
  }

  /**
   * Handles one request: record it, then answer it.
   *
   * Recording happens before routing on purpose. An unknown path is exactly the
   * thing a caller needs to see in the log, and a fixture that only recorded the
   * paths it knows how to answer would turn "the client called the wrong URL" into
   * a 404 with no evidence attached.
   */
  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const rawBody = await readBody(req)
      let body = rawBody
      try {
        body = JSON.parse(rawBody)
      } catch {
        // Left as the raw string. A body the client meant to send as JSON and got
        // wrong is a case worth asserting on, so it is recorded rather than
        // rejected -- the fixture's job is to show what arrived, and throwing here
        // would take the whole test process down over one bad request.
      }
      const reply = REPLIES.get(url.pathname)
      // A known path answers only for POST, and says so. A fake that answers a GET
      // identically would let a client that lost its method still pass.
      const status = reply === undefined ? 404 : req.method === 'POST' ? 200 : 405

      requests.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: { ...req.headers },
        rawBody,
        body,
        bodyIsJson: body !== rawBody,
        apiKey: bearerOf(req.headers),
        status,
      })

      if (status === 404) {
        sendJson(res, 404, { error: { message: `no fixture route for ${url.pathname}`, type: 'not_found' } })
      } else if (status === 405) {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { error: { message: `${url.pathname} takes POST, not ${req.method}`, type: 'method_not_allowed' } })
      } else {
        sendJson(res, 200, reply())
      }
    } catch (err) {
      // An exception in a request handler is an uncaught exception in the test
      // process, so it is answered rather than allowed to escape. Recording the
      // message is what keeps that from being a silent swallow.
      //
      // This record is the short one -- `{ method, path, status, error }`, no body
      // fields -- because the usual cause is the client vanishing mid-body, which
      // means there is no body to describe. A test that reads `body` off every
      // record is reading records that all came back whole.
      requests.push({ method: req.method, path: req.url, status: 500, error: String(err?.message ?? err) })
      sendJson(res, 500, { error: { message: `fixture handler failed: ${err?.message ?? err}`, type: 'fixture_error' } })
    }
  }

  /** The base URL of the running fixture, or a throw if it is not running. */
  function baseUrl() {
    if (address === null) throw new Error('the fake provider is not started')
    return `http://127.0.0.1:${address.port}`
  }

/** The ephemeral port the kernel chose. Never a fixed one. */
const port = () => address.port

  /**
   * Starts listening on an ephemeral port. Repeat calls return the same server
   * rather than binding twice, so a test that starts in `beforeEach` and again in
   * the body does not get two fixtures it can no longer tell apart.
   */
  function start() {
    if (server !== null) return Promise.resolve(baseUrl())
    if (starting !== null) return starting
    starting = new Promise((resolve, reject) => {
      const next = createServer(handle)
      next.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      const onBindError = (err) => {
        starting = null
        reject(new Error(`the fake provider could not bind an ephemeral port: ${err.message}`))
      }
      next.once('error', onBindError)
      // 127.0.0.1 rather than the wildcard address, so the fixture is unreachable
      // from outside the machine and cannot race another process for the port.
      next.listen(0, '127.0.0.1', () => {
        // Detached before the resolve: a later runtime error must not re-run a
        // rejection that has already settled, which would leave a caller with an
        // unhandled-looking failure for a request error, not a bind error.
        next.removeListener('error', onBindError)
        address = next.address()
        server = next
        starting = null
        resolve(baseUrl())
      })
    })
    return starting
  }

  /**
   * Stops listening, releasing the port.
   *
   * Idempotent, and safe to call concurrently: the handle is cleared before the
   * close is awaited, so a second call sees nothing to do and resolves instead of
   * waiting on a close that is already under way. That is what lets `t.after`
   * stop the fixture on a path where the test already stopped it.
   */
  function stop() {
    const closing = server
    if (closing === null) return Promise.resolve()
    server = null
    address = null
    return new Promise((resolve, reject) => {
      let settled = false
      let grace = null
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(grace)
        if (err) reject(err)
        else resolve()
      }
      closing.close((err) => finish(err ?? null))
      // Idle keep-alive sockets are the normal case here -- the caller has already
      // read its response -- and dropping them is what lets the close resolve at
      // all rather than at the end of the keep-alive window.
      closing.closeIdleConnections()
      grace = setTimeout(() => {
        for (const socket of sockets) socket.destroy()
      }, STOP_GRACE_MS)
      // Unref'd because a pending teardown must never be the reason a process
      // stays alive; it is only a backstop, and `finish` clears it on every path.
      grace.unref?.()
    })
  }

  /** The first recorded request matching `predicate`, or `undefined`. */
  const findRequest = (predicate) => requests.find((r) => matches(predicate)(r))

  /** The most recent request matching `predicate`. `assertApiKey` reads the last one. */
  const lastRequest = (predicate = () => true) => last(predicate)

  /**
   * Waits for a request matching `predicate`, or resolves `null` after `timeoutMs`.
   *
   * Polling rather than an event, for the same reason `dom-harness.mjs` polls for
   * listeners: the honest wait here is bounded and cheap, and a fixture test that
   * hangs tells you nothing. Returns `null` rather than throwing so a test can
   * distinguish "nothing yet" from "that cannot happen" -- `assertRequest` is the
   * one that fails.
   */
  async function waitForRequest(predicate, timeoutMs = WAIT_MS) {
    const test = matches(predicate)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = requests.find((r) => test(r))
      if (found) return found
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  /**
   * Asserts a matching request arrived, and returns it.
   *
   * This is the assertion the rest of the suite's provider coverage rests on, so
   * its failure has to say what happened instead: the message names the claim that
   * failed and prints every request the fixture did see, credential included.
   * "Expected 1 request, got 0" on its own sends you to the client; "here is the
   * request that arrived, carrying this key, to this path" usually answers it.
   */
  async function assertRequest(predicate, description = 'the expected request') {
    const found = await waitForRequest(predicate)
    if (found === null) {
      throw new assert.AssertionError({
        message: `no request matching ${description} arrived within ${WAIT_MS}ms.\nRecorded:\n${dump()}`,
        actual: requests.length,
        expected: '>=1 matching request',
        operator: 'requests.filter(predicate).length',
      })
    }
    return found
  }

  /**
   * Asserts the credential the provider was presented, and returns the request it
   * checked.
   *
   * Reads the last matching request, because that is the one whose key the caller
   * just asserted about. Absence is reported as its own case rather than folded
   * into a mismatch: a client that sent no key at all and one that sent the wrong
   * key are different bugs, and they need different fixes.
   */
  async function assertApiKey(expected, { path } = {}) {
    const target = path === undefined ? () => true : path
    const record = lastRequest(target)
    const label = path === undefined ? 'the last request' : `the last request to ${path}`
    if (record === undefined) {
      throw new assert.AssertionError({
        message: `cannot check the credential: ${label} was never made.\nRecorded:\n${dump()}`,
        actual: requests.length,
        expected: '>=1 request',
        operator: 'requests.length',
      })
    }
    if (record.apiKey !== expected) {
      const presented = record.apiKey === ''
        ? 'no Authorization header at all (authorization: ' + (record.headers.authorization ?? 'absent') + ')'
        : `the key "${record.apiKey}"`
      throw new assert.AssertionError({
        message: `${label} presented ${presented}, expected the key "${expected}".\n` +
          'A missing header and a wrong key are different failures -- a client that ' +
          'never sent one is not misconfigured, it is unwired.',
        actual: record.apiKey,
        expected,
        operator: 'record.apiKey',
      })
    }
    return record
  }

  /** Empties the request log, for a test that reuses one fixture across phases. */
  const reset = () => { requests.length = 0 }

  return {
    requests,
    start,
    stop,
    baseUrl,
    port,
    reset,
    findRequest,
    lastRequest,
    waitForRequest,
    assertRequest,
    assertApiKey,
  }
}