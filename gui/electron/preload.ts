import { contextBridge, ipcRenderer } from 'electron'

const api = {
  /** Base URL of the Python sidecar (http://127.0.0.1:<port>). */
  serverUrl: (): Promise<string> => ipcRenderer.invoke('server:url'),
  serverReady: (): Promise<boolean> => ipcRenderer.invoke('server:ready'),
  /** Native open-file dialog; resolves null when cancelled. */
  pickSourceFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-file'),
  /** Native save dialog for exports; resolves the chosen path or null. */
  pickSaveFile: (defaultName: string, fmt: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:save-file', defaultName, fmt),
  /** OS documents folder (auto-save destination). */
  documentsDir: (): Promise<string> => ipcRenderer.invoke('app:documents-dir'),
  /** Google Fonts API key from the runtime environment; '' when unset. */
  googleFontsKey: (): Promise<string> => ipcRenderer.invoke('app:google-fonts-key'),
  /** Menu → "Open Source File…" fired from the main process. */
  onOpenFile: (callback: () => void): void => {
    ipcRenderer.on('menu:open-file', callback)
  },
  onNewDoc: (callback: () => void): void => {
    ipcRenderer.on('menu:new-doc', callback)
  },
  /** Sidecar failed to start/answer health checks. */
  onSidecarFailed: (callback: () => void): void => {
    ipcRenderer.on('sidecar:failed', callback)
  }
}

export type QuillApi = typeof api

contextBridge.exposeInMainWorld('quill', api)
