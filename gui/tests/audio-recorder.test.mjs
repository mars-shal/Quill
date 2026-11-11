import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav } from '../src/library/audioRecorder.js'

test('the WAV fallback writes a valid mono 16-bit header and samples', async () => {
  const blob = encodeWav(new Float32Array([0, 0.5, -0.5]), 16000)
  const bytes = Buffer.from(await blob.arrayBuffer())
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
  assert.equal(bytes.readUInt16LE(20), 1, 'PCM format')
  assert.equal(bytes.readUInt16LE(22), 1, 'mono')
  assert.equal(bytes.readUInt32LE(24), 16000, 'sample rate')
  assert.equal(bytes.length, 44 + 3 * 2, 'header plus three 16-bit samples')
})
