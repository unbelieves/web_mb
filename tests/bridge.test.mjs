import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createBridge } from '../bridge/server.mjs';

test('透明 TCP 桥接保留 RTU 原始字节，并在网页断开时释放 TCP', async () => {
  const tcpServer = net.createServer();
  tcpServer.listen(0, '127.0.0.1');
  await once(tcpServer, 'listening');
  const bridge = createBridge();
  const address = await bridge.listen(0);
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/rtu`, { origin: 'http://localhost:5173' });
  let tcp;
  try {
    await once(ws, 'open');
    const accepted = once(tcpServer, 'connection');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: tcpServer.address().port }));
    [tcp] = await accepted;
    assert.equal(JSON.parse((await ready)[0].toString()).type, 'connected');
    const frame = Buffer.from([1, 3, 0, 0, 0, 1, 0x84, 0x0a]);
    const tcpBytes = once(tcp, 'data');
    ws.send(frame);
    assert.deepEqual((await tcpBytes)[0], frame);
    const response = Buffer.from([0x64, 0x62, 0x67, 1, 3, 2, 0, 7, 0xf9, 0x86]);
    const received = once(ws, 'message');
    tcp.write(response);
    const [bytes, isBinary] = await received;
    assert.equal(isBinary, true);
    assert.deepEqual(Buffer.from(bytes), response);
    const closed = once(tcp, 'close');
    ws.close();
    await closed;
  } finally {
    ws.terminate();
    tcp?.destroy();
    await bridge.close();
    await new Promise((done) => tcpServer.close(done));
  }
});

test('TCP 连接失败可报告原因，不发送假连接成功', async () => {
  const unused = net.createServer();
  unused.listen(0, '127.0.0.1');
  await once(unused, 'listening');
  const port = unused.address().port;
  await new Promise((done) => unused.close(done));
  const bridge = createBridge();
  const address = await bridge.listen(0);
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/rtu`);
  try {
    await once(ws, 'open');
    const message = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port }));
    const result = JSON.parse((await message)[0].toString());
    assert.equal(result.type, 'error');
    assert.match(result.message, /TCP/);
  } finally {
    ws.terminate();
    await bridge.close();
  }
});
