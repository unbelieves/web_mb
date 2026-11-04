import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendCrc, buildRead, buildWriteMultiple, buildWriteSingle, expectationFromRequest, extractResponse, hasValidCrc, responseRegisters } from '../src/protocol/rtu'
import { RtuSession } from '../src/protocol/session'
import { DemoDevice } from '../src/communication/demo'

afterEach(() => vi.useRealTimers())
const readResponse = (...values: number[]): Uint8Array => appendCrc([1, 3, values.length * 2, ...values.flatMap(value => [value >>> 8, value & 255])])
const tick = async (): Promise<void> => { for (let index = 0; index < 8; index++) await Promise.resolve() }

describe('RTU frames and stream scanning', () => {
  it('uses the standard FC03 CRC vector and validates legal ranges before transmission', () => {
    expect(Array.from(buildRead(1, 0, 10))).toEqual([1, 3, 0, 0, 0, 10, 0xc5, 0xcd])
    expect(() => buildRead(0, 0, 1)).toThrow('通信地址')
    expect(() => buildRead(1, 65535, 2)).toThrow('范围')
    expect(() => buildRead(1, 0, 126)).toThrow('读取数量')
    expect(() => buildWriteSingle(1, 0, -1)).toThrow('寄存器值')
    expect(() => buildWriteMultiple(1, 0, [])).toThrow('写入数量')
  })

  it('builds FC10 big-endian words with the correct byte count', () => {
    const frame = buildWriteMultiple(7, 0x1234, [0xabcd, 0x0102])
    expect(Array.from(frame.subarray(0, -2))).toEqual([7, 16, 0x12, 0x34, 0, 2, 4, 0xab, 0xcd, 1, 2])
    expect(hasValidCrc(frame)).toBe(true)
  })

  it('filters a log prefix and preserves a split response until complete', () => {
    const expected = expectationFromRequest(buildRead(1, 6, 2))
    const response = readResponse(1, 2)
    const log = new TextEncoder().encode('boot ok\r\n')
    const buffer = [...log, ...response.subarray(0, 3)]
    expect(extractResponse(buffer, expected)).toEqual({ frame: null, discarded: log.length })
    expect(buffer).toEqual(Array.from(response.subarray(0, 3)))
    buffer.push(...response.subarray(3))
    expect(extractResponse(buffer, expected).frame).toEqual(response)
    expect(buffer).toHaveLength(0)
  })

  it('accepts byte-by-byte input and leaves concatenated trailing log bytes', () => {
    const expected = expectationFromRequest(buildRead(1, 6, 2))
    const frame = readResponse(0x1122, 0x3344)
    const buffer: number[] = []
    for (const byte of frame.subarray(0, -1)) { buffer.push(byte); expect(extractResponse(buffer, expected).frame).toBeNull() }
    buffer.push(frame[frame.length - 1]!, 76, 79, 71)
    expect(extractResponse(buffer, expected).frame).toEqual(frame)
    expect(buffer).toEqual([76, 79, 71])
  })

  it('resynchronizes after a bad CRC, wrong station, wrong function and wrong data length', () => {
    const expected = expectationFromRequest(buildRead(1, 6, 1))
    const good = readResponse(9)
    const bad = good.slice(); bad[bad.length - 1] ^= 255
    const wrongStation = appendCrc([2, 3, 2, 0, 1])
    const wrongFunction = appendCrc([1, 4, 2, 0, 1])
    const wrongCount = readResponse(7, 8)
    const noise = [...bad, ...wrongStation, ...wrongFunction, ...wrongCount]
    const buffer = [...noise, ...good]
    const result = extractResponse(buffer, expected)
    expect(result.discarded).toBe(noise.length)
    expect(result.frame).toEqual(good)
  })

  it('requires matching write echoes for FC06 and FC10', () => {
    const request = buildWriteSingle(1, 0x102, 0xabcd)
    const wrong = buildWriteSingle(1, 0x102, 0xabce)
    expect(extractResponse([...wrong], expectationFromRequest(request)).frame).toBeNull()
    expect(extractResponse([...request], expectationFromRequest(request)).frame).toEqual(request)
    const multi = buildWriteMultiple(1, 9, [3, 4])
    const echo = appendCrc([1, 16, 0, 9, 0, 2])
    expect(extractResponse([...echo], expectationFromRequest(multi)).frame).toEqual(echo)
    expect(extractResponse([...appendCrc([1, 16, 0, 9, 0, 1])], expectationFromRequest(multi)).frame).toBeNull()
  })

  it('rejects a response with device logs inserted inside the RTU frame', () => {
    const response = readResponse(1, 2)
    const corrupt = [...response.subarray(0, 5), 68, 66, 71, ...response.subarray(5)]
    expect(extractResponse(corrupt, expectationFromRequest(buildRead(1, 6, 2))).frame).toBeNull()
  })

  it('finds a complete exception behind a false incomplete prefix and exposes the device error', () => {
    const exception = appendCrc([1, 0x83, 2])
    const buffer = [1, 3, 20, ...exception]
    const result = extractResponse(buffer, expectationFromRequest(buildRead(1, 0, 10)))
    expect(result.frame).toEqual(exception)
    expect(() => responseRegisters(exception)).toThrow('非法地址')
  })
})

describe('one request queue and cancellation', () => {
  it('discards 256 KiB log chunks safely while idle and before a valid response', async () => {
    const noise = new Uint8Array(256 * 1024).fill(76)
    const session = new RtuSession({ timeoutMs: 1000, send: () => {} })
    session.receive(noise)
    expect(session.ignoredNoiseBytes).toBe(noise.length)
    const first = session.execute({ operation: 'read', slaveId: 1, address: 0, count: 1 })
    await tick()
    const response = readResponse(42)
    const chunk = new Uint8Array(noise.length + response.length + 2)
    chunk.set(noise)
    chunk.set(response, noise.length)
    chunk.set([13, 10], noise.length + response.length)
    session.receive(chunk)
    await expect(first).resolves.toEqual([42])
    expect(session.ignoredNoiseBytes).toBe(noise.length * 2 + 2)
    // A following request sees no bytes left over from either large chunk.
    const second = session.execute({ operation: 'read', slaveId: 1, address: 1, count: 1 })
    await tick()
    session.receive(readResponse(17))
    await expect(second).resolves.toEqual([17])
    expect(session.ignoredNoiseBytes).toBe(noise.length * 2 + 2)
    session.close()
  })

  it('times out even when send never resolves, with one read retry and no write retry', async () => {
    vi.useFakeTimers()
    const send = vi.fn(() => new Promise<void>(() => {}))
    const session = new RtuSession({ timeoutMs: 100, send })
    const write = session.execute({ operation: 'writeSingle', slaveId: 1, address: 7, value: 1 })
    const writeResult = expect(write).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(100)
    await writeResult
    expect(send).toHaveBeenCalledTimes(1)
    const read = session.execute({ operation: 'read', slaveId: 1, address: 0, count: 1 })
    const readResult = expect(read).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(200)
    await readResult
    expect(send).toHaveBeenCalledTimes(3)
    session.close()
  })

  it('does not overlap requests and counts noise bytes around valid frames', async () => {
    const sent: Uint8Array[] = []
    const session = new RtuSession({ timeoutMs: 1000, send: frame => { sent.push(frame) } })
    const first = session.execute({ operation: 'read', slaveId: 1, address: 6, count: 1 })
    const second = session.execute({ operation: 'writeSingle', slaveId: 1, address: 7, value: 19 })
    await tick()
    expect(sent).toHaveLength(1)
    session.receive(Uint8Array.from([76, 79, 71, ...readResponse(42), 13, 10]))
    await expect(first).resolves.toEqual([42])
    await tick()
    expect(sent).toHaveLength(2)
    session.receive(sent[1]!)
    await expect(second).resolves.toEqual([])
    expect(session.ignoredNoiseBytes).toBe(5)
    session.close()
  })

  it('retries one timed-out read before advancing to the queued operation', async () => {
    vi.useFakeTimers()
    const sent: Uint8Array[] = []
    const onRetry = vi.fn()
    const session = new RtuSession({ timeoutMs: 100, send: frame => { sent.push(frame) }, onRetry })
    const read = session.execute({ operation: 'read', slaveId: 1, address: 1, count: 1 })
    await tick()
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toHaveLength(2)
    expect(onRetry).toHaveBeenCalledOnce()
    session.receive(readResponse(23))
    await expect(read).resolves.toEqual([23])
    session.close()
  })

  it('never retries a write and never retries a Modbus exception', async () => {
    vi.useFakeTimers()
    const sent: Uint8Array[] = []
    const session = new RtuSession({ timeoutMs: 100, send: frame => { sent.push(frame) } })
    const write = session.execute({ operation: 'writeSingle', slaveId: 1, address: 103, value: 1 })
    const writeResult = expect(write).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(100)
    await writeResult
    expect(sent).toHaveLength(1)
    const read = session.execute({ operation: 'read', slaveId: 1, address: 186, count: 1 })
    const readResult = expect(read).rejects.toMatchObject({ code: 'EXCEPTION' })
    await tick()
    session.receive(appendCrc([1, 0x83, 2]))
    await readResult
    expect(sent).toHaveLength(2)
    session.close()
  })

  it('rejects an active request and every queued request when cancelled, and can be used again', async () => {
    const sent: Uint8Array[] = []
    const session = new RtuSession({ timeoutMs: 1000, send: frame => { sent.push(frame) } })
    const first = session.execute({ operation: 'read', slaveId: 1, address: 0, count: 1 })
    const second = session.execute({ operation: 'read', slaveId: 1, address: 1, count: 1 })
    const results = Promise.allSettled([first, second])
    await tick()
    session.cancelAll()
    expect((await results).every(result => result.status === 'rejected' && result.reason.code === 'CANCELLED')).toBe(true)
    expect(sent).toHaveLength(1)
    session.receive(readResponse(99))
    await tick()
    const third = session.execute({ operation: 'read', slaveId: 1, address: 2, count: 1 })
    await tick()
    session.receive(readResponse(17))
    await expect(third).resolves.toEqual([17])
    session.close()
  })

  it('stops a retry and all later requests on disconnect', async () => {
    vi.useFakeTimers()
    const sent: Uint8Array[] = []
    const session = new RtuSession({ timeoutMs: 100, send: frame => { sent.push(frame) } })
    const first = session.execute({ operation: 'read', slaveId: 1, address: 0, count: 1 })
    const second = session.execute({ operation: 'read', slaveId: 1, address: 1, count: 1 })
    const results = Promise.allSettled([first, second])
    await tick()
    session.close('设备已拔出')
    expect((await results).every(result => result.status === 'rejected' && result.reason.code === 'DISCONNECTED')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(1)
    await expect(session.execute({ operation: 'read', slaveId: 1, address: 2, count: 1 })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })

  it('round-trips the split, noisy demo RTU stream and updates the simulated slave address', async () => {
    vi.useFakeTimers()
    let session: RtuSession
    const demo = new DemoDevice({ 92: 0x1234, 481: 1 }, bytes => session.receive(bytes))
    session = new RtuSession({ timeoutMs: 100, send: frame => demo.send(frame) })
    const first = session.execute({ operation: 'read', slaveId: 1, address: 92, count: 1 })
    await vi.advanceTimersByTimeAsync(30)
    await expect(first).resolves.toEqual([0x1234])
    const change = session.execute({ operation: 'writeSingle', slaveId: 1, address: 481, value: 9 })
    await vi.advanceTimersByTimeAsync(30)
    await expect(change).resolves.toEqual([])
    const readAtNewId = session.execute({ operation: 'read', slaveId: 9, address: 481, count: 1 })
    await vi.advanceTimersByTimeAsync(30)
    await expect(readAtNewId).resolves.toEqual([9])
    session.close()
    demo.close()
  })

  it('preserves edits across demo firmware profiles and keeps the active slave address', async () => {
    vi.useFakeTimers()
    let session: RtuSession
    const demo = new DemoDevice({ 10: 123, 481: 1 }, bytes => session.receive(bytes), { 10: 456, 481: 1 })
    session = new RtuSession({ timeoutMs: 100, send: frame => demo.send(frame) })
    const write = session.execute({ operation: 'writeSingle', slaveId: 1, address: 10, value: 789 })
    await vi.advanceTimersByTimeAsync(30)
    await write
    const change = session.execute({ operation: 'writeSingle', slaveId: 1, address: 481, value: 4 })
    await vi.advanceTimersByTimeAsync(30)
    await change
    demo.setProfile(true)
    const controllerRead = session.execute({ operation: 'read', slaveId: 4, address: 10, count: 1 })
    await vi.advanceTimersByTimeAsync(30)
    await expect(controllerRead).resolves.toEqual([456])
    demo.setProfile(false)
    const chargerRead = session.execute({ operation: 'read', slaveId: 4, address: 10, count: 1 })
    await vi.advanceTimersByTimeAsync(30)
    await expect(chargerRead).resolves.toEqual([789])
    session.close()
    demo.close()
  })

  it('simulates static-IP readback and clear-order commands rather than storing their trigger values', async () => {
    vi.useFakeTimers()
    let session: RtuSession
    const demo = new DemoDevice({ 181: 12, 265: 1 }, bytes => session.receive(bytes))
    session = new RtuSession({ timeoutMs: 100, send: frame => demo.send(frame) })
    for (const [address, expected] of [[265, 0], [181, 0]]) {
      const write = session.execute({ operation: 'writeSingle', slaveId: 1, address: address!, value: 0xff00 })
      await vi.advanceTimersByTimeAsync(30)
      await write
      const read = session.execute({ operation: 'read', slaveId: 1, address: address!, count: 1 })
      await vi.advanceTimersByTimeAsync(30)
      await expect(read).resolves.toEqual([expected])
    }
    session.close()
    demo.close()
  })
})
