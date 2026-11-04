import { appendCrc, hasValidCrc } from '../protocol/rtu'

/** Local test device: passes through the same RTU encoder, Worker queue and scanner as hardware. */
export class DemoDevice {
  private registers = new Map<number, number>()
  private readonly chargerRegisters: Map<number, number>
  private readonly controllerRegisters: Map<number, number>
  private slaveId = 1
  private closed = false
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(seed: Record<number, number>, private readonly receive: (bytes: Uint8Array) => void, controllerSeed: Record<number, number> = seed) {
    for (const [address, value] of Object.entries(seed)) this.registers.set(Number(address), value & 65535)
    this.chargerRegisters = this.registers
    this.controllerRegisters = new Map(Object.entries(controllerSeed).map(([address, value]) => [Number(address), value & 65535]))
    this.slaveId = this.registers.get(481) || 1
  }

  setProfile(controller: boolean): void {
    this.registers = controller ? this.controllerRegisters : this.chargerRegisters
  }

  send(request: Uint8Array): void {
    if (this.closed) throw new Error('演示连接已关闭')
    if (!hasValidCrc(request) || request[0] !== this.slaveId) return
    const address = request[2]! * 256 + request[3]!
    const value = request[4]! * 256 + request[5]!
    let response: Uint8Array
    if (request[1] === 3) {
      const bytes = [request[0]!, 3, value * 2]
      for (let offset = 0; offset < value; offset++) {
        const word = this.registers.get(address + offset) ?? 0
        bytes.push(word >>> 8, word & 255)
      }
      response = appendCrc(bytes)
    } else if (request[1] === 6) {
      this.registers.set(address, value)
      response = request.slice()
      if (address === 481 && value >= 1 && value <= 247) {
        this.slaveId = value
        this.chargerRegisters.set(481, value)
        this.controllerRegisters.set(481, value)
      }
      if (address === 265) this.registers.set(265, value === 0xff00 ? 0 : 1)
      if (address === 181 && value === 0xff00) this.registers.set(181, 0)
    } else if (request[1] === 16) {
      for (let offset = 0; offset < value; offset++) this.registers.set(address + offset, request[7 + offset * 2]! * 256 + request[8 + offset * 2]!)
      response = appendCrc(request.subarray(0, 6))
    } else response = appendCrc([request[0]!, request[1]! | 0x80, 1])
    const noise = new TextEncoder().encode('[DEMO] RTU response\r\n')
    const first = new Uint8Array(noise.length + 3)
    first.set(noise)
    first.set(response.subarray(0, 3), noise.length)
    this.later(() => this.receive(first), 18)
    this.later(() => this.receive(response.subarray(3)), 28)
  }

  close(): void {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  private later(action: () => void, delay: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.closed) action() }, delay)
    this.timers.add(timer)
  }
}
