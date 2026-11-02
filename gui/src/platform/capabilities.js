/**
 * Runtime capability detection.
 *
 * Results are cached because each probe creates a canvas and, for WebGL, a real
 * graphics context. The values cannot change within a session.
 */

let webgl2Cache

/**
 * True when the webview can provide a WebGL2 context.
 *
 * `metal-fx` v2 throws during render when WebGL2 is missing, and WebKitGTK
 * disables WebGL outright when its GPU process cannot get a context. Callers
 * must not mount the effect unless this returns true.
 *
 * WebGL1 is probed too, purely for the diagnostic: it distinguishes "this
 * webview has no GL at all" from "it has GL but not GL2", which is the
 * difference between a missing driver and something that `scripts/tauri.sh`
 * can fix.
 */
export function hasWebGL2() {
  if (webgl2Cache !== undefined) return webgl2Cache
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    webgl2Cache = Boolean(gl)
    if (gl) {
      // Release the context immediately; a live one holds GPU memory for the
      // lifetime of the document.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    } else {
      const webgl1 = Boolean(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
      console.warn(
        webgl1
          ? 'metal-fx: this webview reports WebGL1 but not WebGL2, so the send button renders plain. ' +
            'Set LIBGL_ALWAYS_SOFTWARE=1 (scripts/tauri.sh only applies it automatically where there is no GPU) or run `npm install metal-fx@1` for the WebGL1 engine.'
          : 'metal-fx: no WebGL context at all, so the send button renders plain. The webview GPU process is unavailable.',
      )
    }
  } catch (error) {
    webgl2Cache = false
    console.warn('metal-fx: WebGL2 probe threw, so the send button renders plain.', error)
  }
  return webgl2Cache
}

/**
 * `describeGraphics` used to sit here and hand the Settings page a one-line
 * report for a Graphics row. The row is gone: it was never a setting -- nothing
 * wrote to it -- so it could only restate the probe's own result. The warning
 * above is the diagnostic now, and it is the honest one, because it fires from
 * the probe itself and names the platform rather than describing itself.
 */

/** Test seam: forgets cached probes. */
export function resetCapabilityCache() {
  webgl2Cache = undefined
}
