/// <reference lib="webworker" />
import { ModbusError } from '../protocol/rtu'
import { RtuSession } from '../protocol/session'
import type { FromWorker, ToWorker } from '../communication/messages'

const worker = self as unknown as DedicatedWorkerGlobalScope
let session: RtuSession | undefined
let nextTxId = 0
let timeoutMs = 5000
let epoch = 0
const acknowledgements = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const decoder = new TextDecoder('gb18030')

function post(message: FromWorker, transfer: Transferable[] = []): void { worker.postMessage(message, transfer) }
function clearAcknowledgements(): void {
  for (const ack of acknowledgements.values()) { clearTimeout(ack.timer); ack.reject(new ModbusError('通信操作已结束', 'CANCELLED')) }
  acknowledgements.clear()
}

worker.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data
  if (message.type === 'configure') {
    session?.close('通信连接已重建')
    clearAcknowledgements()
    timeoutMs = message.timeoutMs
    epoch = message.epoch
    try {
      session = new RtuSession({
        timeoutMs,
        send(frame) {
          const txId = ++nextTxId
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { acknowledgements.delete(txId); reject(new ModbusError('串口或桥接发送超时', 'TRANSPORT')) }, timeoutMs)
            acknowledgements.set(txId, { resolve, reject, timer })
            const bytes = frame.slice().buffer
            post({ type: 'tx', txId, bytes, epoch }, [bytes])
          })
        },
        onNoise(bytes, total) { post({ type: 'noise', total, text: decoder.decode(bytes).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim() }) },
        onRetry() { post({ type: 'retry' }) },
      })
      post({ type: 'result', id: message.id, values: [] })
    } catch (error) { post({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error), code: 'VALIDATION' }) }
  } else if (message.type === 'rx') session?.receive(new Uint8Array(message.bytes))
  else if (message.type === 'txAck') {
    const ack = acknowledgements.get(message.txId)
    if (ack) { clearTimeout(ack.timer); acknowledgements.delete(message.txId); message.error ? ack.reject(new Error(message.error)) : ack.resolve() }
  } else if (message.type === 'cancel') { epoch = message.epoch; session?.cancelAll(); clearAcknowledgements() }
  else if (message.type === 'disconnect') { epoch = message.epoch; session?.close(message.reason); session = undefined; clearAcknowledgements() }
  else if (message.type === 'request') {
    if (!session) { post({ type: 'error', id: message.id, message: '通信连接尚未建立', code: 'DISCONNECTED' }); return }
    session.execute(message.request).then(
      values => post({ type: 'result', id: message.id, values }),
      (error: unknown) => post({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error), code: error instanceof ModbusError ? error.code : 'PROTOCOL' }),
    )
  }
}
