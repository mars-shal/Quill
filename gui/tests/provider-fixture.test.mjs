/**
 * The fake provider, proving it can fail.
 *
 * A fixture that cannot fail is worse than no fixture. `fake-provider.mjs` exists
 * so that later provider work is checked against something real rather than a
 * stubbed `fetch`, and a stubbed `fetch` has one failure mode that no assertion
 * catches: if the code under test stops calling the provider, the stub returns its
 * canned body to nobody and every test that used it still passes. The suite is
 * green, the feature does nothing, and the only evidence is the absence of a
 * call nobody was checking for.
 *
 * So this file does not just use the fixture -- it attacks it. Each of the first
 * two tests runs an assertion that is *meant* to fail, catches the failure, and
 * inspects it: the message has to name the claim that failed, name the requests
 * that did arrive, and say the credential rather than leaving the reader to go
 * and find it. Those are the properties every later provider test depends on, and
 * a fixture whose failure message is `AssertionError: false` satisfies none of
 * them while still exiting zero.
 *
 * Each of those tests also asserts the opposite direction first. A helper that
 * always throws would pass a suite full of expected-failures, so every rejection
 * below is paired with a claim that resolved because it was true. A fake that
 * cannot fail and one that can only fail are equally useless, and only the pair
 * distinguishes them.
 *
 * The rest pins the things a fixture is allowed to be sloppy about. It has to
 * survive a body that is not JSON, stop without throwing when it is already
 * stopped, release its port, and never take a port that another process or
 * another fixture already holds.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'

import { createFakeProvider } from './support/fake-provider.mjs'

/** Posts a body to the fixture and returns the decoded reply. */
async function post(provider, path, { body = {}, authorization = 'Bearer sk-fixture-123' } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (authorization !== null) headers.authorization = authorization
  const response = await fetch(`${provider.baseUrl()}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

/** Starts a fixture and stops it when the test ends, pass or fail. */
async function withProvider(t) {
  const provider = createFakeProvider()
  await provider.start()
  t.after(() => provider.stop())
  return provider
}

/** Whether something is still listening on `port`. True means the fixture leaked. */
const isListening = (port) => new Promise((resolve) => {
  const socket = connect(port, '127.0.0.1')
  socket.on('connect', () => { socket.destroy(); resolve(true) })
  socket.on('error', (err) => resolve(err.code !== 'ECONNREFUSED'))
})

test('a claim about a request that never arrived fails loudly, and the same claim about one that did resolve', async (t) => {
  const provider = await withProvider(t)

  await post(provider, '/v1/chat/completions', { body: { model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] } })

  // The control, and the half that makes the rejection below mean something: if
  // this did not resolve, the test would pass on a helper that always throws.
  const arrived = await provider.assertRequest('/v1/chat/completions')
  assert.equal(arrived.method, 'POST')
  assert.equal(arrived.body.model, 'fixture-model', 'the recorded body is the parsed JSON, not the bytes')
  assert.equal(arrived.status, 200)
  await provider.assertApiKey('sk-fixture-123')
  assert.equal(provider.requests.length, 1)

  // The claim that is expected to fail: no request was ever made to this path.
  await assert.rejects(
    () => provider.assertRequest('/v1/responses', 'a request to /v1/responses'),
    (err) => {
      assert.ok(err instanceof assert.AssertionError, 'a missing request is an assertion failure, not a crash')
      assert.match(err.message, /no request matching a request to \/v1\/responses/)
      assert.match(err.message, /#0 POST \/v1\/chat\/completions/, 'the failure prints the request that did arrive')
      assert.match(err.message, /Bearer sk-fixture-123/, 'and the credential that request carried')
      return true
    },
  )

  // And the same helper against a request that never came, by method rather than
  // path, because the other way a call goes missing is being made with the wrong verb.
  await assert.rejects(
    () => provider.assertRequest((r) => r.method === 'GET', 'a GET anywhere'),
    /no request matching a GET anywhere/,
  )
})

test('a request with no credential fails as absence, not as a mismatch', async (t) => {
  const provider = await withProvider(t)

  await post(provider, '/v1/chat/completions', { authorization: null })

  const record = await provider.assertRequest('/v1/chat/completions')
  assert.equal(record.apiKey, '', 'an absent header is an empty credential, not a parsed one')
  assert.equal(record.headers.authorization, undefined)

  await assert.rejects(
    () => provider.assertApiKey('sk-fixture-123'),
    (err) => {
      assert.match(err.message, /presented no Authorization header at all/)
      assert.match(err.message, /authorization: absent/)
      assert.match(err.message, /never sent one is not misconfigured/, 'the message distinguishes the two ways a key goes missing')
      return true
    },
  )
})

test('a request with the wrong credential names the credential it was given', async (t) => {
  const provider = await withProvider(t)

  await post(provider, '/v1/responses', { authorization: 'Bearer sk-the-wrong-one' })

  await assert.rejects(
    () => provider.assertApiKey('sk-fixture-123'),
    (err) => {
      assert.match(err.message, /presented the key "sk-the-wrong-one", expected the key "sk-fixture-123"/)
      return true
    },
  )

  // The truth resolves, which is what makes the rejection above evidence.
  const record = await provider.assertApiKey('sk-the-wrong-one')
  assert.equal(record.path, '/v1/responses')

  // Scoping to one path, so a test with several calls in flight checks the one it means.
  await assert.rejects(
    () => provider.assertApiKey('sk-fixture-123', { path: '/v1/chat/completions' }),
    /the last request to \/v1\/chat\/completions was never made/,
  )
})

test('both endpoints answer with distinguishable shapes and are recorded apart', async (t) => {
  const provider = await withProvider(t)

  const chat = await post(provider, '/v1/chat/completions', { body: { model: 'fixture-model', messages: [] } })
  const responses = await post(provider, '/v1/responses', { body: { model: 'fixture-model', input: 'hello' } })

  // The three differences are the real API's, so a test asserting on a parsed reply
  // cannot pass against a fixture that returns the same object for both paths.
  assert.equal(chat.json.object, 'chat.completion')
  assert.equal(chat.json.id.startsWith('chatcmpl-'), true)
  assert.equal(chat.json.choices[0].message.content, 'fixture chat completion')
  assert.equal(responses.json.object, 'response')
  assert.equal(responses.json.id.startsWith('resp_'), true)
  assert.equal(responses.json.output[0].content[0].text, 'fixture response')
  assert.notEqual(chat.json.id, responses.json.id)

  // Recorded apart as well as answered apart: a client that sent both bodies to the
  // same path would otherwise still get two usable replies.
  assert.deepEqual(provider.requests.map((r) => r.path), ['/v1/chat/completions', '/v1/responses'])
  assert.deepEqual(provider.requests[0].body.messages, [])
  assert.equal(provider.requests[1].body.input, 'hello')

  // An unknown path is recorded and refused, rather than 404-ing invisibly.
  const unknown = await post(provider, '/v1/embeddings', { body: { input: 'hi' } })
  assert.equal(unknown.status, 404)
  assert.equal(provider.requests.at(-1).path, '/v1/embeddings')

  // A known path refuses the wrong verb, so a client that lost its method cannot pass.
  const wrongVerb = await fetch(`${provider.baseUrl()}/v1/responses`)
  assert.equal(wrongVerb.status, 405)
  assert.equal((await provider.assertRequest((r) => r.method === 'GET')).status, 405)
})

test('a body that is not JSON is recorded, not crashed on', async (t) => {
  const provider = await withProvider(t)

  const notJson = await post(provider, '/v1/chat/completions', { body: 'this is not json {{{' })
  assert.equal(notJson.status, 200, 'the fixture answers rather than refusing: it exists to show what arrived')

  const record = provider.requests[0]
  assert.equal(record.bodyIsJson, false)
  assert.equal(record.body, 'this is not json {{{', 'the raw body is kept verbatim as the body')
  assert.equal(record.rawBody, 'this is not json {{{')

  // A JSON body missing everything the endpoint expects is recorded as-is. The
  // fixture does not validate, because validating here would hide exactly the
  // request a test needs to see in the log.
  await post(provider, '/v1/chat/completions', { body: {} })
  assert.deepEqual(provider.requests[1].body, {})
  assert.equal(provider.requests[1].bodyIsJson, true)

  // An empty body is the same case a client with nothing to say produces.
  await post(provider, '/v1/responses', { body: '' })
  assert.equal(provider.requests[2].bodyIsJson, false)
  assert.equal(provider.requests[2].rawBody, '')
})

test('stop is idempotent, releases the port, and does not hang on a live connection', async (t) => {
  const provider = createFakeProvider()
  await provider.start()
  const taken = provider.port()

  await post(provider, '/v1/chat/completions')

  // Stopped twice, then a third time after the second resolved. A teardown that
  // throws on an already-stopped fixture makes `t.after` unusable, which is how a
  // fixture ends up leaking a socket on exactly the runs that were already failing.
  await provider.stop()
  await provider.stop()
  assert.equal(await isListening(taken), false, 'no socket is listening after stop')

  assert.throws(() => provider.baseUrl(), /not started/, 'a stopped fixture refuses to hand out a URL rather than a stale one')
  assert.equal(provider.requests.length, 1, 'stopping does not discard what was recorded')

  // A second fixture takes a fresh port rather than reusing the first one's.
  const restarted = createFakeProvider()
  await restarted.start()
  t.after(() => restarted.stop())
  assert.notEqual(restarted.port(), taken, 'a restarted fixture does not return the old port')
  assert.equal(await isListening(taken), false, 'the old port stays free')

  // A client that connected and then went quiet is the one way close() can block.
  // The fixture drops it after its grace window, so this resolves rather than
  // pinning the suite open for the server's keep-alive timeout. The port is read
  // before the stop, because a stopped fixture refuses to name its own port --
  // that is the point of the assertion above.
  const restartedPort = restarted.port()
  const stalled = connect(restartedPort, '127.0.0.1')
  await new Promise((resolve, reject) => {
    stalled.once('connect', resolve)
    stalled.once('error', reject)
  })
  const stopped = Date.now()
  await restarted.stop()
  const elapsed = Date.now() - stopped
  assert.equal(await isListening(restartedPort), false)
  assert.ok(elapsed < 2_000, `stop resolved in ${elapsed}ms despite a live connection`)
  stalled.destroy()
})

test('live fixtures never share a port, and none takes a well-known one', async (t) => {
  const first = await withProvider(t)
  const second = await withProvider(t)

  // Port 8000 is held by an unrelated service on this machine. A fixture that
  // bound a fixed port would either fail here or, on a quieter machine, collide
  // with the next run of the suite.
  for (const provider of [first, second]) {
    assert.notEqual(provider.port(), 8000, 'the fixture never takes a fixed, already-taken port')
    assert.notEqual(provider.port(), 8080)
    assert.ok(provider.port() > 1024, 'the kernel handed out an ephemeral port')
  }
  assert.notEqual(first.baseUrl(), second.baseUrl(), 'two live fixtures cannot collide')

  // Both serve at once, which is what makes the collision question worth asking.
  const [a, b] = await Promise.all([
    post(first, '/v1/chat/completions', { body: { tag: 'first' } }),
    post(second, '/v1/responses', { body: { tag: 'second' } }),
  ])
  assert.equal(a.json.object, 'chat.completion')
  assert.equal(b.json.object, 'response')
  assert.equal(first.requests.length, 1, "the first fixture only saw its own request")
  assert.equal(second.requests.length, 1, "the second fixture only saw its own request")

  // Restarting one does not resurrect the other's request log, and `reset` is the
  // only thing that empties it.
  first.reset()
  assert.equal(first.requests.length, 0)
  assert.equal(second.requests.length, 1, 'reset is per-fixture')
  assert.equal(await first.waitForRequest(() => true, 50), null, 'nothing is waiting, so a lookup resolves to null rather than hanging')
})