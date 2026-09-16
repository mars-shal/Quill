/** Reconnecting WebSocket client for sidecar events. */

export type WsHandler = (event: Record<string, unknown>) => void

export class WsClient {
  private socket: WebSocket | null = null
  private retry = 0
  private closed = false

  constructor(
    private readonly url: string,
    private readonly handler: WsHandler,
    private readonly onStatus?: (connected: boolean) => void
  ) {}

  connect(): void {
    if (this.closed) return
    this.socket = new WebSocket(this.url)
    this.socket.onopen = () => {
      this.retry = 0
      this.onStatus?.(true)
    }
    this.socket.onmessage = (message) => {
      try {
        this.handler(JSON.parse(message.data))
      } catch (error) {
        console.error('bad ws event', error)
      }
    }
    this.socket.onclose = () => {
      this.onStatus?.(false)
      if (this.closed) return
      const delay = Math.min(8000, 500 * 2 ** this.retry++)
      setTimeout(() => this.connect(), delay)
    }
    this.socket.onerror = () => this.socket?.close()
  }

  close(): void {
    this.closed = true
    this.socket?.close()
  }
}
