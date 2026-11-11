/**
 * A minimal WAV recorder for webviews without MediaRecorder.
 *
 * WebKitGTK can expose getUserMedia and Web Audio while leaving MediaRecorder
 * undefined. Capturing PCM through a ScriptProcessor and encoding a mono
 * 16-bit WAV is enough for a short voice note and keeps the same upload path.
 */

export function encodeWav(samples, sampleRate) {
  const length = samples.length
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const writeString = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, length * 2, true)

  let offset = 44
  for (let index = 0; index < length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * Start a PCM capture. Returns `{ stop }`; `stop` resolves to a WAV Blob.
 */
export function startWavRecording(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) {
    throw new Error('This webview has no audio context for recording.')
  }
  const context = new AudioContextClass()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks = []
  const sampleRate = context.sampleRate

  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  }
  source.connect(processor)
  // A ScriptProcessor only runs while connected to a destination. It outputs
  // silence, because we never copy the input into the output buffer.
  processor.connect(context.destination)
  context.resume?.().catch(() => {})

  return {
    async stop() {
      processor.onaudioprocess = null
      try { source.disconnect() } catch { /* already gone */ }
      try { processor.disconnect() } catch { /* already gone */ }
      await context.close?.().catch(() => {})
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const samples = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        samples.set(chunk, offset)
        offset += chunk.length
      }
      return encodeWav(samples, sampleRate)
    },
  }
}
