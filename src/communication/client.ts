import { ModbusError } from '../protocol/rtu'
import type { ProtocolOperation } from '../protocol/session'
import type { FromWorker, ToWorker } from './messages'
import { DemoDevice } from './demo'

export type ConnectionMode = 'serial' | 'tcp' | 'demo'
export interface ClientEvent {
  type: 'state' | 'traffic' | 'log' | 'noise'
  state?: 'disconnected' | 'connecting' | 'connected'
  mode?: ConnectionMode
  description?: string
  direction?: 'TX' | 'RX'
  bytes?: number[]
  message?: string
  level?: 'info' | 'warn' | 'error'
  ignoredNoiseBytes?: number
}

interface SerialHandle {
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  open(options: { baudRate: number; dataBits: 8; stopBits: 1; parity: 'none'; flowControl: 'none' }): Promise<void>
  close(): Promise<void>
  setSignals?(signals: { dataTerminalReady: boolean; requestToSend: boolean }): Promise<void>
  getInfo(): { usbVendorId?: number; usbProductId?: number }
}

interface SerialApi { requestPort(): Promise<SerialHandle> }
interface Rpc { resolve: (values: number[]) => void; reject: (error: Error) => void }

export class ModbusClient {
  private readonly worker: Worker
  private nextId = 0
  private readonly pending = new Map<number, Rpc>()
  private generation = 0
  private wireEpoch = 0
  private connected = false
  private mode: ConnectionMode = 'serial'
  private description = '尚未连接'
  private serialPort: SerialHandle | undefined
  private serialReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private serialWriter: WritableStreamDefaultWriter<Uint8Array> | undefined
  private receiveTask: Promise<void> | undefined
  private socket: WebSocket | undefined
  private demo: DemoDevice | undefined
  private disposed = false

  constructor(private readonly onEvent: (event: ClientEvent) => void) {
    this.worker = new Worker(new URL('../workers/modbus.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.handleWorker(event.data)
    this.worker.onerror = () => { this.log('协议 Worker 发生错误，请刷新页面后重试', 'error'); void this.disconnect() }
  }

  /** requestPort is called synchronously in the click handler to preserve user activation. */
  connectSerial(baudRate: number, timeoutMs: number): Promise<void> {
    const serial = (navigator as Navigator & { serial?: SerialApi }).serial
    if (!window.isSecureContext) return Promise.reject(new ModbusError('Web Serial 需要 HTTPS 或 localhost 安全环境', 'UNSUPPORTED'))
    if (!serial) return Promise.reject(new ModbusError('此浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge', 'UNSUPPORTED'))
    if (!Number.isInteger(baudRate) || baudRate < 1 || baudRate > 4000000) return Promise.reject(new ModbusError('波特率不合法', 'VALIDATION'))
    const requested = serial.requestPort()
    // A chooser can reject while the previous channel is still closing.
    void requested.catch(() => {})
    return this.openSerial(requested, baudRate, timeoutMs)
  }

  async connectTcp(url: string, host: string, port: number, timeoutMs: number): Promise<void> {
    const parsed = new URL(url)
    if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new ModbusError('桥接地址需要以 ws:// 或 wss:// 开头', 'VALIDATION')
    if (!host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) throw new ModbusError('TCP IP/主机名或端口不合法', 'VALIDATION')
    await this.disconnect()
    this.assertUsable()
    const generation = ++this.generation
    this.mode = 'tcp'
    this.description = `${host}:${port} · RTU over TCP`
    this.emitState('connecting')
    try {
      const socket = new WebSocket(parsed.href)
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      await new Promise<void>((resolve, reject) => {
        let established = false
        const timer = setTimeout(() => reject(new ModbusError('连接 WebSocket 桥接服务超时，请确认桥接服务已启动', 'TIMEOUT')), Math.max(5000, timeoutMs))
        const fail = (error: Error): void => { clearTimeout(timer); reject(error) }
        socket.onopen = () => socket.send(JSON.stringify({ type: 'connect', host: host.trim(), port }))
        socket.onmessage = (event: MessageEvent) => {
          if (generation !== this.generation) return
          if (typeof event.data === 'string') {
            let message: { type?: string; message?: string }
            try { message = JSON.parse(event.data) as typeof message } catch { return }
            if (message.type === 'connected') { established = true; clearTimeout(timer); resolve() }
            else if (message.type === 'error') {
              const error = new ModbusError(message.message || 'TCP 桥接连接失败', 'TRANSPORT')
              if (!established) fail(error)
              else this.transportFailed(generation, error)
            }
          } else if (event.data instanceof ArrayBuffer) this.receiveBytes(new Uint8Array(event.data), generation)
        }
        socket.onerror = () => {
          const error = new ModbusError('无法连接桥接服务，请检查地址、服务状态及浏览器本地网络权限', 'TRANSPORT')
          if (!established) fail(error)
          else this.transportFailed(generation, error)
        }
        socket.onclose = () => {
          const error = new ModbusError('TCP 桥接连接已关闭', 'DISCONNECTED')
          if (!established) fail(error)
          else this.transportFailed(generation, error)
        }
      })
      this.checkGeneration(generation)
      await this.configure(timeoutMs)
      this.checkGeneration(generation)
      this.connected = true
      this.emitState('connected')
    } catch (error) { await this.failedConnect(generation); throw error }
  }

  async connectDemo(timeoutMs: number, registers: Record<number, number> = {}, controllerRegisters?: Record<number, number>): Promise<void> {
    await this.disconnect()
    this.assertUsable()
    const generation = ++this.generation
    this.mode = 'demo'
    this.description = '演示设备 · 不连接真实串口'
    this.emitState('connecting')
    this.demo = new DemoDevice(registers, bytes => this.receiveBytes(bytes, generation), controllerRegisters)
    try {
      await this.configure(timeoutMs)
      this.checkGeneration(generation)
      this.connected = true
      this.emitState('connected')
      this.log('当前为本地演示设备，所有读写仅影响模拟寄存器。')
    } catch (error) { await this.failedConnect(generation); throw error }
  }

  setDemoProfile(controller: boolean): void { this.demo?.setProfile(controller) }

  readRegisters(slaveId: number, address: number, count: number): Promise<number[]> {
    return this.request({ operation: 'read', slaveId, address, count })
  }

  async writeRegister(slaveId: number, address: number, value: number): Promise<void> {
    await this.request({ operation: 'writeSingle', slaveId, address, value })
  }

  async writeRegisters(slaveId: number, address: number, values: number[]): Promise<void> {
    await this.request({ operation: 'writeMultiple', slaveId, address, values })
  }

  cancelPending(): void {
    this.sendWorker({ type: 'cancel', epoch: ++this.wireEpoch })
    this.rejectPending(new ModbusError('操作已取消', 'CANCELLED'))
    this.log('当前及排队中的请求已取消。')
  }

  async disconnect(): Promise<void> {
    const generation = ++this.generation
    this.connected = false
    if (!this.disposed) this.sendWorker({ type: 'disconnect', epoch: ++this.wireEpoch })
    this.rejectPending(new ModbusError('通信连接已断开', 'DISCONNECTED'))
    const reader = this.serialReader
    const writer = this.serialWriter
    const port = this.serialPort
    const receiveTask = this.receiveTask
    this.serialReader = undefined
    this.serialWriter = undefined
    this.serialPort = undefined
    this.receiveTask = undefined
    this.demo?.close()
    this.demo = undefined
    this.socket?.close()
    this.socket = undefined
    try { await reader?.cancel() } catch { /* unplugged serial devices may already be closed */ }
    try { await receiveTask } catch { /* receive failure is reported once by transportFailed */ }
    try { writer?.releaseLock() } catch { /* a failed writer can already be unlocked */ }
    try { await port?.close() } catch { /* removal already closed the hardware port */ }
    if (generation === this.generation) {
      this.description = '尚未连接'
      this.emitState('disconnected')
    }
  }

  dispose(): void {
    void this.disconnect()
    this.disposed = true
    this.worker.terminate()
  }

  private async openSerial(requested: Promise<SerialHandle>, baudRate: number, timeoutMs: number): Promise<void> {
    await this.disconnect()
    this.assertUsable()
    const generation = ++this.generation
    this.mode = 'serial'
    this.description = `串口 · ${baudRate} / 8N1`
    this.emitState('connecting')
    let selected: SerialHandle | undefined
    try {
      selected = await requested
      this.checkGeneration(generation)
      await selected.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' })
      if (generation !== this.generation) { await selected.close(); throw new ModbusError('连接操作已取消', 'CANCELLED') }
      this.serialPort = selected
      if (!selected.readable || !selected.writable) throw new ModbusError('串口未提供可读写的数据流', 'TRANSPORT')
      try { await selected.setSignals?.({ dataTerminalReady: false, requestToSend: false }) } catch { this.log('此设备不支持设置 DTR/RTS，使用驱动默认状态。', 'warn') }
      this.checkGeneration(generation)
      this.serialWriter = selected.writable.getWriter()
      this.serialReader = selected.readable.getReader()
      const info = selected.getInfo()
      const usb = info.usbVendorId === undefined ? '' : ` · USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`
      this.description += usb
      await this.configure(timeoutMs)
      this.checkGeneration(generation)
      this.connected = true
      const reader = this.serialReader
      this.receiveTask = this.pumpSerial(reader, generation)
      this.emitState('connected')
    } catch (error) {
      await this.failedConnect(generation)
      if (error instanceof DOMException && error.name === 'NotFoundError') throw new ModbusError('已取消串口选择', 'CANCELLED')
      throw error
    }
  }

  private async pumpSerial(reader: ReadableStreamDefaultReader<Uint8Array>, generation: number): Promise<void> {
    let failure: unknown
    try {
      while (generation === this.generation) {
        const result = await reader.read()
        if (result.done) { if (generation === this.generation) failure = new Error('串口数据流已关闭'); break }
        if (result.value) this.receiveBytes(result.value, generation)
      }
    } catch (error) { failure = error }
    finally { try { reader.releaseLock() } catch { /* cancelled reader */ } }
    // Do not await disconnect here: disconnect waits for receiveTask to settle.
    if (failure && generation === this.generation) this.transportFailed(generation, failure)
  }

  private configure(timeoutMs: number): Promise<number[]> {
    const id = ++this.nextId
    return this.rpc(id, { type: 'configure', id, timeoutMs, epoch: ++this.wireEpoch })
  }

  private request(request: ProtocolOperation): Promise<number[]> {
    if (!this.connected || this.disposed) return Promise.reject(new ModbusError('通信连接尚未建立', 'DISCONNECTED'))
    const id = ++this.nextId
    return this.rpc(id, { type: 'request', id, request })
  }

  private rpc(id: number, message: ToWorker): Promise<number[]> {
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.sendWorker(message) })
  }

  private sendWorker(message: ToWorker, transfer: Transferable[] = []): void {
    if (!this.disposed) this.worker.postMessage(message, transfer)
  }

  private handleWorker(message: FromWorker): void {
    if (message.type === 'result' || message.type === 'error') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.type === 'result') pending.resolve(message.values)
      else pending.reject(new ModbusError(message.message, message.code))
    } else if (message.type === 'tx') {
      if (message.epoch !== this.wireEpoch || !this.connected) {
        this.sendWorker({ type: 'txAck', txId: message.txId, error: '请求已取消或连接已关闭' })
        return
      }
      const bytes = new Uint8Array(message.bytes)
      const generation = this.generation
      this.onEvent({ type: 'traffic', direction: 'TX', bytes: Array.from(bytes) })
      this.writeBytes(bytes).then(
        () => this.sendWorker({ type: 'txAck', txId: message.txId }),
        (error: unknown) => {
          this.sendWorker({ type: 'txAck', txId: message.txId, error: error instanceof Error ? error.message : String(error) })
          this.transportFailed(generation, error)
        },
      )
    } else if (message.type === 'noise') {
      this.onEvent({ type: 'noise', ignoredNoiseBytes: message.total })
      if (message.text) this.log(`设备日志 / 已过滤：${message.text.slice(0, 500)}`)
    } else if (message.type === 'retry') this.log('读取响应超时或发送失败，重试一次；写操作不会重试。', 'warn')
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    if (this.demo) { this.demo.send(bytes); return }
    if (this.serialWriter) { await this.serialWriter.write(bytes); return }
    if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(bytes); return }
    throw new ModbusError('通信连接已断开', 'DISCONNECTED')
  }

  private receiveBytes(bytes: Uint8Array, generation: number): void {
    if (generation !== this.generation) return
    this.onEvent({ type: 'traffic', direction: 'RX', bytes: Array.from(bytes) })
    const buffer = Uint8Array.from(bytes).buffer
    this.sendWorker({ type: 'rx', bytes: buffer }, [buffer])
  }

  private rejectPending(error: ModbusError): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() }
  private emitState(state: 'disconnected' | 'connecting' | 'connected'): void { this.onEvent({ type: 'state', state, mode: this.mode, description: this.description }) }
  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void { this.onEvent({ type: 'log', message, level }) }
  private assertUsable(): void { if (this.disposed) throw new ModbusError('通信客户端已释放，请刷新页面', 'DISCONNECTED') }
  private checkGeneration(generation: number): void { if (generation !== this.generation) throw new ModbusError('连接操作已取消', 'CANCELLED') }
  private async failedConnect(generation: number): Promise<void> { if (generation === this.generation) await this.disconnect() }
  private transportFailed(generation: number, error: unknown): void {
    if (generation !== this.generation) return
    this.log(error instanceof Error ? error.message : String(error), 'error')
    void this.disconnect()
  }
}
