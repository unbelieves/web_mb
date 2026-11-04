export class ModbusError extends Error {
  constructor(message: string, public readonly code: string = 'PROTOCOL') {
    super(message)
    this.name = code === 'CANCELLED' ? 'AbortError' : 'ModbusError'
  }
}

const exceptionNames: Record<number, string> = {
  1: '非法功能', 2: '非法地址', 3: '非法数据值', 4: '从站设备故障',
  5: '已确认，仍在处理', 6: '从站忙', 8: '存储奇偶校验错误',
  10: '网关路径不可用', 11: '网关目标无响应',
}

export class ModbusException extends ModbusError {
  constructor(public readonly functionCode: number, public readonly exceptionCode: number) {
    super(`Modbus 功能码 0x${functionCode.toString(16).padStart(2, '0').toUpperCase()} 返回异常 0x${exceptionCode.toString(16).padStart(2, '0').toUpperCase()}（${exceptionNames[exceptionCode] ?? '未知异常'}）`, 'EXCEPTION')
  }
}

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new ModbusError(`${label}必须为 ${min}..${max} 的整数`, 'VALIDATION')
}

function validateRange(slaveId: number, address: number, count: number): void {
  integer(slaveId, 1, 247, '通信地址')
  integer(address, 0, 65535, '寄存器地址')
  if (address + count > 65536) throw new ModbusError('寄存器范围超出 0..65535', 'VALIDATION')
}

export function computeCrc(data: ArrayLike<number>): number {
  let crc = 0xffff
  for (let index = 0; index < data.length; index++) {
    crc ^= data[index]!
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  return crc
}

export function appendCrc(data: ArrayLike<number>): Uint8Array {
  const result = new Uint8Array(data.length + 2)
  result.set(Array.from(data))
  const crc = computeCrc(data)
  result[data.length] = crc & 255
  result[data.length + 1] = crc >>> 8
  return result
}

export function hasValidCrc(frame: Uint8Array): boolean {
  if (frame.length < 4) return false
  const crc = computeCrc(frame.subarray(0, -2))
  return frame[frame.length - 2] === (crc & 255) && frame[frame.length - 1] === (crc >>> 8)
}

export function buildRead(slaveId: number, address: number, count: number): Uint8Array {
  integer(count, 1, 125, 'FC03 读取数量')
  validateRange(slaveId, address, count)
  return appendCrc([slaveId, 3, address >>> 8, address & 255, count >>> 8, count & 255])
}

export function buildWriteSingle(slaveId: number, address: number, value: number): Uint8Array {
  validateRange(slaveId, address, 1)
  integer(value, 0, 65535, '寄存器值')
  return appendCrc([slaveId, 6, address >>> 8, address & 255, value >>> 8, value & 255])
}

export function buildWriteMultiple(slaveId: number, address: number, values: readonly number[]): Uint8Array {
  integer(values.length, 1, 123, 'FC10 写入数量')
  validateRange(slaveId, address, values.length)
  for (const value of values) integer(value, 0, 65535, '寄存器值')
  const payload = [slaveId, 16, address >>> 8, address & 255, values.length >>> 8, values.length & 255, values.length * 2]
  for (const value of values) payload.push(value >>> 8, value & 255)
  return appendCrc(payload)
}

export interface ResponseExpectation {
  slaveId: number
  functionCode: number
  dataBytes: number
  echo: number[]
}

export function expectationFromRequest(request: Uint8Array): ResponseExpectation {
  if (request.length < 8 || !hasValidCrc(request)) throw new ModbusError('请求不是合法的 Modbus RTU 帧', 'VALIDATION')
  const functionCode = request[1]!
  if (![3, 6, 16].includes(functionCode)) throw new ModbusError('不支持的 Modbus 功能码', 'VALIDATION')
  return { slaveId: request[0]!, functionCode, dataBytes: functionCode === 3 ? (request[4]! * 256 + request[5]!) * 2 : 0, echo: Array.from(request.subarray(2, 6)) }
}

function matches(frame: Uint8Array, expected: ResponseExpectation): boolean {
  if (frame[0] !== expected.slaveId || !hasValidCrc(frame)) return false
  if (frame[1] === (expected.functionCode | 0x80)) return frame.length === 5
  if (frame[1] !== expected.functionCode) return false
  if (expected.functionCode === 3) return frame[2] === expected.dataBytes && frame.length === expected.dataBytes + 5
  return frame.length === 8 && expected.echo.every((value, index) => value === frame[index + 2])
}

/** Mutates buffer, preserving only a possible partial response and all bytes after a matched frame. */
export function extractResponse(buffer: number[], expected: ResponseExpectation): { frame: Uint8Array | null; discarded: number } {
  let incompleteAt = -1
  for (let offset = 0; offset < buffer.length; offset++) {
    if (buffer[offset] !== expected.slaveId) continue
    if (offset + 1 >= buffer.length) { if (incompleteAt < 0) incompleteAt = offset; continue }
    const fn = buffer[offset + 1]!
    const exception = fn === (expected.functionCode | 0x80)
    if (!exception && fn !== expected.functionCode) continue
    let length = exception ? 5 : 8
    if (!exception && fn === 3) {
      if (offset + 2 >= buffer.length) { if (incompleteAt < 0) incompleteAt = offset; continue }
      if (buffer[offset + 2] !== expected.dataBytes) continue
      length = expected.dataBytes + 5
    }
    if (buffer.length - offset < length) { if (incompleteAt < 0) incompleteAt = offset; continue }
    const frame = Uint8Array.from(buffer.slice(offset, offset + length))
    if (!matches(frame, expected)) continue
    buffer.splice(0, offset + length)
    return { frame, discarded: offset }
  }
  const discarded = incompleteAt < 0 ? buffer.length : incompleteAt
  buffer.splice(0, discarded)
  return { frame: null, discarded }
}

export function responseRegisters(frame: Uint8Array): number[] {
  if (frame[1]! & 0x80) throw new ModbusException(frame[1]! & 0x7f, frame[2]!)
  if (frame[1] !== 3) return []
  const values: number[] = []
  for (let index = 3; index < frame.length - 2; index += 2) values.push(frame[index]! * 256 + frame[index + 1]!)
  return values
}
