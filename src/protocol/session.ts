import { buildRead, buildWriteMultiple, buildWriteSingle, expectationFromRequest, extractResponse, ModbusError, responseRegisters, type ResponseExpectation } from './rtu'

export type ProtocolOperation =
  | { operation: 'read'; slaveId: number; address: number; count: number }
  | { operation: 'writeSingle'; slaveId: number; address: number; value: number }
  | { operation: 'writeMultiple'; slaveId: number; address: number; values: number[] }

interface Job {
  operation: ProtocolOperation
  resolve: (values: number[]) => void
  reject: (error: Error) => void
}

interface Pending {
  expectation: ResponseExpectation
  resolve: (frame: Uint8Array) => void
  reject: (error: Error) => void
}

export interface SessionOptions {
  timeoutMs: number
  send: (frame: Uint8Array) => void | Promise<void>
  onNoise?: (bytes: Uint8Array, total: number) => void
  onRetry?: () => void
}

/** Exactly one request may be in flight. Read retries stay inside the same queue job. */
export class RtuSession {
  private readonly queue: Job[] = []
  private readonly receiveBuffer: number[] = []
  private active: Job | undefined
  private pending: Pending | undefined
  private epoch = 0
  private closed = false
  private noiseBytes = 0

  constructor(private readonly options: SessionOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10 || options.timeoutMs > 60000) throw new ModbusError('请求超时必须为 10..60000 ms', 'VALIDATION')
  }

  get ignoredNoiseBytes(): number { return this.noiseBytes }

  execute(operation: ProtocolOperation): Promise<number[]> {
    if (this.closed) return Promise.reject(new ModbusError('通信连接已断开', 'DISCONNECTED'))
    // Validate before queueing: malformed writes must never be transmitted.
    try { this.build(operation) } catch (error) { return Promise.reject(error) }
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject })
      void this.pump()
    })
  }

  receive(bytes: Uint8Array): void {
    if (this.closed || bytes.length === 0) return
    // WebSocket chunks can exceed the JavaScript function argument limit.
    for (const byte of bytes) this.receiveBuffer.push(byte)
    const pending = this.pending
    if (!pending) { this.discard(this.receiveBuffer.splice(0)); return }
    const before = this.receiveBuffer.slice()
    const result = extractResponse(this.receiveBuffer, pending.expectation)
    this.discard(before.slice(0, result.discarded))
    if (!result.frame) return
    this.pending = undefined
    this.discard(this.receiveBuffer.splice(0))
    pending.resolve(result.frame)
  }

  cancelAll(reason = '操作已取消'): void {
    this.epoch++
    const error = new ModbusError(reason, 'CANCELLED')
    this.rejectAll(error)
  }

  close(reason = '通信连接已断开'): void {
    if (this.closed) return
    this.closed = true
    this.epoch++
    this.rejectAll(new ModbusError(reason, 'DISCONNECTED'))
  }

  private rejectAll(error: ModbusError): void {
    const pending = this.pending
    this.pending = undefined
    pending?.reject(error)
    this.active?.reject(error)
    for (const queued of this.queue.splice(0)) queued.reject(error)
    this.discard(this.receiveBuffer.splice(0))
  }

  private build(operation: ProtocolOperation): Uint8Array {
    if (operation.operation === 'read') return buildRead(operation.slaveId, operation.address, operation.count)
    if (operation.operation === 'writeSingle') return buildWriteSingle(operation.slaveId, operation.address, operation.value)
    return buildWriteMultiple(operation.slaveId, operation.address, operation.values)
  }

  private async pump(): Promise<void> {
    if (this.active || this.closed) return
    const job = this.queue.shift()
    if (!job) return
    this.active = job
    const epoch = this.epoch
    try {
      const request = this.build(job.operation)
      let values: number[] = []
      for (let attempt = 0; ; attempt++) {
        if (this.closed || epoch !== this.epoch) throw new ModbusError('操作已取消', 'CANCELLED')
        try {
          values = responseRegisters(await this.exchange(request))
          break
        } catch (error) {
          const retryable = error instanceof ModbusError && ['TIMEOUT', 'TRANSPORT'].includes(error.code)
          if (job.operation.operation !== 'read' || attempt !== 0 || !retryable || this.closed || epoch !== this.epoch) throw error
          this.options.onRetry?.()
        }
      }
      if (epoch === this.epoch && !this.closed) job.resolve(values)
    } catch (error) {
      job.reject(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.active = undefined
      void this.pump()
    }
  }

  private exchange(request: Uint8Array): Promise<Uint8Array> {
    this.discard(this.receiveBuffer.splice(0))
    let timeout: ReturnType<typeof setTimeout>
    let pending: Pending
    const response = new Promise<Uint8Array>((resolve, reject) => {
      pending = { expectation: expectationFromRequest(request), resolve, reject }
      this.pending = pending
      timeout = setTimeout(() => {
        if (this.pending === pending) this.pending = undefined
        reject(new ModbusError(`等待设备响应超时（${this.options.timeoutMs} ms）`, 'TIMEOUT'))
      }, this.options.timeoutMs)
      Promise.resolve().then(() => this.options.send(request)).catch((error: unknown) => {
        if (this.pending !== pending) return
        this.pending = undefined
        reject(new ModbusError(error instanceof Error ? error.message : String(error), 'TRANSPORT'))
      })
    })
    return response.finally(() => {
      clearTimeout(timeout!)
      if (this.pending === pending) this.pending = undefined
      this.discard(this.receiveBuffer.splice(0))
    })
  }

  private discard(bytes: number[]): void {
    if (!bytes.length) return
    this.noiseBytes += bytes.length
    this.options.onNoise?.(Uint8Array.from(bytes), this.noiseBytes)
  }
}
