import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/** Local-only bridge: WebSocket binary frames carry unchanged RTU bytes to TCP. */
export function createBridge({ rootDir = resolve(projectRoot, 'docs'), allowedOrigins = [] } = {}) {
  const root = resolve(rootDir);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/') {
        res.writeHead(302, { Location: '/web_mb/' }).end();
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/web_mb\//, '').replace(/^\//, '');
      const file = resolve(root, relative || 'index.html');
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const data = await readFile(file === root ? resolve(root, 'index.html') : file);
      res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('未找到网页文件，请先运行 npm run build。');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let allowed = true;
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        allowed = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || allowedOrigins.includes(parsed.origin);
      } catch { allowed = false; }
    }
    if (!allowed || new URL(req.url || '/', 'http://localhost').pathname !== '/rtu') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    let tcp;
    let connected = false;
    const reportError = (message) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message }));
        ws.close(1011, 'TCP connection failed');
      }
      tcp?.destroy();
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!connected || !tcp) return reportError('TCP 尚未连接');
        tcp.write(data);
        return;
      }
      if (tcp) return reportError('连接已建立，不能重复发送连接设置');
      let command;
      try { command = JSON.parse(data.toString()); } catch { return reportError('连接设置不是合法 JSON'); }
      if (command.type !== 'connect' || typeof command.host !== 'string' || !command.host.trim() || command.host.length > 255 || !Number.isInteger(command.port) || command.port < 1 || command.port > 65535) {
        return reportError('请提供合法的 TCP 主机和端口');
      }
      tcp = net.createConnection({ host: command.host, port: command.port });
      tcp.setTimeout(8000);
      tcp.once('timeout', () => reportError('TCP 连接超时'));
      tcp.once('connect', () => {
        if (ws.readyState !== WebSocket.OPEN) return tcp.destroy();
        connected = true;
        tcp.setTimeout(0);
        tcp.setKeepAlive(true);
        ws.send(JSON.stringify({ type: 'connected' }));
      });
      tcp.on('data', (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
      });
      tcp.on('error', (error) => reportError(`TCP 连接失败：${error.message}`));
      tcp.on('close', () => {
        connected = false;
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'TCP closed');
      });
    });
    ws.on('close', () => tcp?.destroy());
    ws.on('error', () => tcp?.destroy());
  });

  return {
    server,
    async listen(port = 8787) {
      await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
      return server.address();
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((done) => wss.close(done));
      await new Promise((done) => server.close(done));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allowedOrigins = (process.env.BRIDGE_ALLOWED_ORIGINS || 'https://unbelieves.github.io').split(',').filter(Boolean);
  const bridge = createBridge({ allowedOrigins });
  bridge.listen(Number(process.env.BRIDGE_PORT || 8787)).then((address) => {
    console.log(`Modbus TCP 桥接已启动：http://127.0.0.1:${address.port}/web_mb/`);
    console.log(`WebSocket：ws://127.0.0.1:${address.port}/rtu（仅监听本机）`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  const stop = () => bridge.close().finally(() => process.exit());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
