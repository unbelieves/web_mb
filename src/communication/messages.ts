import type { ProtocolOperation } from '../protocol/session'

export type ToWorker =
  | { type: 'configure'; id: number; timeoutMs: number; epoch: number }
  | { type: 'request'; id: number; request: ProtocolOperation }
  | { type: 'rx'; bytes: ArrayBuffer }
  | { type: 'txAck'; txId: number; error?: string }
  | { type: 'cancel'; epoch: number }
  | { type: 'disconnect'; epoch: number; reason?: string }

export type FromWorker =
  | { type: 'result'; id: number; values: number[] }
  | { type: 'error'; id: number; message: string; code: string }
  | { type: 'tx'; txId: number; bytes: ArrayBuffer; epoch: number }
  | { type: 'noise'; total: number; text: string }
  | { type: 'retry' }
