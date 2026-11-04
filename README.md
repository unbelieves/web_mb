# Modbus 工作台 · Web

Vue 3 + TypeScript + Web Serial 实现的充电桩 Modbus RTU 上位机，复刻原 WPF 程序的设备参数、普通参数和协调控制器三个页面。Windows 与 macOS 使用支持 Web Serial 的桌面浏览器（建议 Chrome / Edge）。

## 启动

需要 Node.js 22.12+ 或 24 LTS。用户访问已部署网页时不需要安装 Node.js 或 .NET。

```powershell
npm ci
npm run dev
```

打开终端显示的本地地址，默认 `http://127.0.0.1:5173/web_mb/`。首次可选择“模拟设备”测试界面和 Worker 通信链路；模拟器不会访问真实设备。

每次连接模拟设备时通信地址从 1 开始；充电桩与协调控制器使用独立的模拟寄存器区，切换页面保留本次模拟连接中的修改。

## 真实串口

1. 设备接入本机，确认操作系统已经识别 USB 转串口设备及其驱动。
2. 关闭其他占用该物理串口的程序，包括原 WPF 上位机、串口助手和 Python 串口桥接器。
3. 使用 HTTPS 网页或本机 localhost/127.0.0.1 地址打开本工具。
4. 选择串口模式、波特率（默认 38400，8N1），点击连接，在浏览器弹窗里选择并授权串口。
5. 填写设备通信地址（1..247），读取当前页。参数写入通过写按钮明确触发；复位/清除/校准需要确认。

## 透明 TCP 转发

TCP 中仍传输带 CRC 的 RTU 帧，不是带 MBAP 头的标准 Modbus TCP。普通网页通过 WebSocket 本地桥接连接原 TCP 转发器。

```powershell
npm run build
npm run bridge
```

打开 `http://127.0.0.1:8787/web_mb/`，选择 TCP 桥接模式，桥接地址为 `ws://127.0.0.1:8787/rtu`，TCP 目标默认为 `127.0.0.1:5002`。原来的 Python 串口→TCP 服务继续独占物理 COM；此 Node.js 桥接器只转换 WebSocket ↔ TCP，不再打开串口。

桥接器默认仅监听本机。建议 TCP 模式使用它提供的本机网页地址；HTTPS 远端网页连接本地 WS 可能受浏览器混合内容或本地网络权限限制。`BRIDGE_PORT` 可修改监听端口；`BRIDGE_ALLOWED_ORIGINS` 是可选的逗号分隔远端网页源列表（默认 `https://unbelieves.github.io`）。

## 多线程与通信行为

- Vue 界面和浏览器串口授权/异步 I/O 在主线程；CRC、响应帧扫描、噪声过滤、超时与请求队列在独立的 Web Worker。
- 同一串口同一时间只发送一个请求。多线程不意味着并发向同一设备发送多条 Modbus 请求。
- 支持 03 读保持寄存器、06 写单寄存器、10 写多个寄存器、异常响应、拆包和粘包。
- 读取通信失败最多重试一次；写入不自动重试，防止复位、清除和校准重复执行。
- 取消或断开会结束挂起请求；失败字段不沿用旧值冒充本次读取成功。
- 字符串使用 GBK/GB2312 兼容编码，支持中文、字节长度校验、零填充与 IP/MAC/时间/浮点转换。
- 参数 0482 使用协议地址 481，写成功后才切换本页的当前通信地址。
- 固件没有有效处理器的地锁地址 186 不发送读写请求，地锁通过端口功能地址 107 的值 2/3 设置。

## 构建、测试与离线

```powershell
npm test
npm run test:bridge
npm run build
npm run preview
```

构建产物输出到 `docs/`，预览地址为 `http://127.0.0.1:4173/web_mb/`。生产构建包含 Service Worker，会完整缓存网页、脚本、样式和协议 Worker；首次在线加载并完成缓存后，可以断网再次打开并连接本机串口。清空站点数据、换浏览器或换电脑后需重新缓存。开发模式不注册离线缓存。

离线缓存更新不会在设备通信中强制刷新页面；新版本在旧页面关闭后接管。所有代码和图标均随应用打包，不依赖外部 CDN。设备密码、密钥不写入浏览器持久化存储。

## GitHub Pages

仓库名默认为 `web_mb`，构建基础路径是 `/web_mb/`。

推荐方式：提交源码和 `package-lock.json`，在 GitHub 仓库 Settings → Pages → Source 选择 **GitHub Actions**。仓库已有 `.github/workflows/pages.yml`，推送到 main 后自动测试、构建与部署。无需设置 Custom domain，默认地址为 `https://unbelieves.github.io/web_mb/`。

也可保留“从分支部署”：本地执行 `npm run build`，将生成的 `docs/` 一并提交，在 Pages 中选择 main + /docs。不要把未经构建的 Vue 源码根目录当作发布页面。

如更换仓库名或使用独立域名，在构建前设置 `VITE_BASE_PATH`（项目站点如 `/new-name/`，独立域名用 `/`）。本地 TCP 桥接静态地址目前固定为 `/web_mb/`，更换基础路径时应同步调整。

## 验证范围

自动化测试覆盖协议帧/噪声/拆粘包/异常/写回显/超时/取消、数据编码和 TCP 桥接。模拟设备用于确认界面和 Worker 的完整读写链路。真实串口和 macOS USB 驱动行为仍需要在对应设备上进行现场验证。
