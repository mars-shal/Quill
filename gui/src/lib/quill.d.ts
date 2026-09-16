import type { QuillApi } from '../preload'

declare global {
  interface Window {
    quill: QuillApi
  }
}

export {}
