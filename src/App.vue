<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import DeviceField from './components/DeviceField.vue';
import { ModbusClient, type ClientEvent } from './communication/client';
import { commandActions, createDemoRegisters, pages, type CommandAction, type FieldDefinition, type GroupDefinition, type PageDefinition } from './model/device';
import { decodeField, encodeField } from './model/codecs';

type Mode = 'serial' | 'tcp' | 'demo';
type Tone = 'info' | 'success' | 'warn' | 'error';
type FieldStatus = 'unread' | 'reading' | 'read' | 'written' | 'edited' | 'error' | 'unavailable';
type LogKind = 'TX' | 'RX' | 'INFO' | 'WARN' | 'ERROR';
type Operation = { id: number; kind: 'read' | 'write'; cancelled: boolean };
type LogEntry = { id: number; time: string; kind: LogKind; message: string };

const STORAGE_KEY = 'web-mb-connection-v1';
let saved: Record<string, unknown> = {};
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { /* Optional connection preferences. */ }
const config = reactive({
  mode: (['serial', 'tcp', 'demo'].includes(String(saved.mode)) ? saved.mode : 'serial') as Mode,
  baudRate: Number(saved.baudRate) || 38400,
  slaveId: Number(saved.slaveId) || 1,
  timeoutMs: Number(saved.timeoutMs) || 2000,
  bridgeUrl: typeof saved.bridgeUrl === 'string' ? saved.bridgeUrl : 'ws://127.0.0.1:8787/rtu',
  tcpHost: typeof saved.tcpHost === 'string' ? saved.tcpHost : '127.0.0.1',
  tcpPort: Number(saved.tcpPort) || 5002,
});
watch(config, value => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Operation is available without persistent settings. */ }
}, { deep: true });

const currentPageId = ref<PageDefinition['id']>('device');
const currentPage = computed(() => pages.find(page => page.id === currentPageId.value) ?? pages[0]!);
const fields = pages.flatMap(page => page.groups.flatMap(group => group.fields));
const uniqueFields = [...new Map(fields.map(field => [field.key, field])).values()];
const currentActions = computed(() => commandActions.filter(action => action.pageId === currentPageId.value));
const values = reactive<Record<string, string>>({});
const statuses = reactive<Record<string, FieldStatus>>({});
const fieldErrors = reactive<Record<string, string>>({});
const updatedAt = reactive<Record<string, number>>({});
const connectionState = ref<'disconnected' | 'connecting' | 'connected'>('disconnected');
const connectionDescription = ref('尚未连接设备');
const connectedMode = ref<Mode>('serial');
const result = ref('选择连接方式，再连接设备。也可以使用模拟设备预览全部功能。');
const resultTone = ref<Tone>('info');
const operation = ref<Operation | null>(null);
const progress = reactive({ completed: 0, total: 0, failed: 0, label: '' });
const logs = ref<LogEntry[]>([]);
const logFilter = ref<'all' | 'traffic' | 'message'>('all');
const logsOpen = ref(false);
const sentBytes = ref(0);
const receivedBytes = ref(0);
const ignoredNoiseBytes = ref(0);
const factorySerial = ref('');
const clock = ref(new Date());
const offlineReady = ref(!!navigator.serviceWorker?.controller);
const updateReady = ref(false);
const online = ref(navigator.onLine);
const confirmDialog = ref<HTMLDialogElement>();
const pendingAction = ref<CommandAction | null>(null);
const pendingSlaveId = ref(1);
let sequence = 0;
let logSequence = 0;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let client: ModbusClient | undefined;

const secureContext = window.isSecureContext;
const serialSupported = 'serial' in navigator;
const connected = computed(() => connectionState.value === 'connected');
const busy = computed(() => operation.value !== null);
const connecting = computed(() => connectionState.value === 'connecting');
const controlsDisabled = computed(() => !connected.value || busy.value);
const currentFields = computed(() => currentPage.value.groups.flatMap(group => group.fields));
const currentReadCount = computed(() => currentFields.value.filter(field => statuses[field.key] === 'read' || statuses[field.key] === 'written').length);
const visibleLogs = computed(() => logs.value.filter(entry => logFilter.value === 'all' || (logFilter.value === 'traffic' ? entry.kind === 'TX' || entry.kind === 'RX' : entry.kind !== 'TX' && entry.kind !== 'RX')));
const lastRead = computed(() => Math.max(0, ...currentFields.value.map(field => updatedAt[field.key] ?? 0)));
const connectionLabel = computed(() => connected.value ? (connectedMode.value === 'demo' ? '模拟设备已连接' : '设备已连接') : connecting.value ? '正在连接' : '未连接');
const busyLabel = computed(() => operation.value?.kind === 'read' ? '正在读取' : operation.value?.kind === 'write' ? '正在写入' : '通信空闲');

function resetFields() {
  for (const field of uniqueFields) {
    values[field.key] = field.address === 481 ? String(config.slaveId) : field.kind === 'bool' ? '0' : '';
    statuses[field.key] = field.available === false ? 'unavailable' : 'unread';
    fieldErrors[field.key] = '';
    updatedAt[field.key] = 0;
  }
}
resetFields();

function timeText(date: Date) {
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}
function dateText(date: Date) {
  return date.toLocaleString('zh-CN', { hour12: false });
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function addLog(kind: LogKind, text: string) {
  logs.value.push({ id: ++logSequence, time: timeText(new Date()), kind, message: text });
  if (logs.value.length > 600) logs.value.splice(0, logs.value.length - 600);
}
function setResult(text: string, tone: Tone = 'info') {
  result.value = text;
  resultTone.value = tone;
  addLog(tone === 'error' ? 'ERROR' : tone === 'warn' ? 'WARN' : 'INFO', text);
}
function onClientEvent(event: ClientEvent) {
  if (event.type === 'state' && event.state) {
    connectionState.value = event.state;
    if (event.mode) connectedMode.value = event.mode;
    if (event.description) connectionDescription.value = event.description;
    if (event.state === 'disconnected') {
      if (operation.value) operation.value.cancelled = true;
      closeConfirm();
    }
  } else if (event.type === 'traffic') {
    const bytes = event.bytes ?? [];
    const direction = event.direction ?? 'RX';
    if (direction === 'TX') sentBytes.value += bytes.length;
    else receivedBytes.value += bytes.length;
    const hex = bytes.slice(0, 512).map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    addLog(direction, hex + (bytes.length > 512 ? ` …（日志显示已省略 ${bytes.length - 512} 字节，通信处理保留完整数据）` : ''));
  } else if (event.type === 'noise') {
    ignoredNoiseBytes.value = event.ignoredNoiseBytes ?? ignoredNoiseBytes.value;
  } else if (event.type === 'log' && event.message) {
    addLog(event.level === 'error' ? 'ERROR' : event.level === 'warn' ? 'WARN' : 'INFO', event.message);
  }
}
try { client = new ModbusClient(onClientEvent); }
catch (error) { setResult(`协议 Worker 无法启动：${message(error)}`, 'error'); }

function checkedClient() {
  if (!client) throw new Error('协议 Worker 尚未就绪，请使用较新版本的桌面浏览器。');
  return client;
}
function slaveId() {
  const value = Number(config.slaveId);
  if (!Number.isInteger(value) || value < 1 || value > 247) throw new Error('通信地址必须是 1～247 的整数。');
  return value;
}
function checkedTimeout() {
  const value = Number(config.timeoutMs);
  if (!Number.isInteger(value) || value < 200 || value > 30000) throw new Error('请求超时必须在 200～30000 毫秒之间。');
  return value;
}
function beginOperation(kind: Operation['kind']) {
  if (!connected.value) throw new Error('请先连接设备。');
  if (busy.value) throw new Error('请等待当前操作完成。');
  const item: Operation = { id: ++sequence, kind, cancelled: false };
  operation.value = item;
  return item;
}
function endOperation(item: Operation) {
  if (operation.value?.id === item.id) operation.value = null;
}

async function connect() {
  if (connectionState.value !== 'disconnected' || busy.value) return;
  const mode = config.mode;
  try {
    const session = checkedClient();
    if (mode === 'demo') config.slaveId = 1;
    slaveId();
    const timeout = checkedTimeout();
    if (mode === 'serial' && (!secureContext || !serialSupported)) throw new Error(!secureContext ? '串口直连需要 HTTPS 或 localhost 安全环境。' : '当前浏览器不支持 Web Serial，请使用 Windows 或 Mac 上的 Chrome / Edge。');
    if (mode === 'tcp') {
      const url = new URL(config.bridgeUrl);
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('桥接地址必须以 ws:// 或 wss:// 开头。');
      if (!config.tcpHost.trim()) throw new Error('请填写 TCP 目标地址。');
      if (!Number.isInteger(Number(config.tcpPort)) || Number(config.tcpPort) < 1 || Number(config.tcpPort) > 65535) throw new Error('TCP 端口必须是 1～65535 的整数。');
    }
    connectionState.value = 'connecting';
    resetFields();
    sentBytes.value = 0;
    receivedBytes.value = 0;
    ignoredNoiseBytes.value = 0;
    // Call requestPort within the click handler, before any asynchronous preparation.
    const pending = mode === 'serial'
      ? session.connectSerial(Number(config.baudRate), timeout)
      : mode === 'tcp'
        ? session.connectTcp(config.bridgeUrl.trim(), config.tcpHost.trim(), Number(config.tcpPort), timeout)
        : session.connectDemo(timeout, createDemoRegisters(), createDemoRegisters('controller'));
    await pending;
    connectionState.value = 'connected';
    connectedMode.value = mode;
    setResult(mode === 'demo' ? '模拟设备已连接。以下读写仅操作模拟寄存器，不会连接物理设备。' : `连接成功，当前通信地址 ${config.slaveId}。请点击读取。`, 'success');
    if (mode === 'demo') await readCurrentPage();
  } catch (error) {
    connectionState.value = 'disconnected';
    const cancelled = error instanceof DOMException && ['NotFoundError', 'AbortError'].includes(error.name);
    setResult(cancelled ? '已取消串口选择。' : `连接失败：${message(error)}`, cancelled ? 'info' : 'error');
  }
}
function connectDemo() {
  config.mode = 'demo';
  void connect();
}
async function disconnect() {
  if (operation.value) operation.value.cancelled = true;
  client?.cancelPending();
  try {
    await client?.disconnect();
    connectionState.value = 'disconnected';
    connectionDescription.value = '尚未连接设备';
    setResult('连接已断开。');
  } catch (error) { setResult(`断开时发生错误：${message(error)}`, 'error'); }
}
function editField(field: FieldDefinition, value: string) {
  values[field.key] = value;
  statuses[field.key] = 'edited';
  fieldErrors[field.key] = '';
}
function updateFromRegisters(field: FieldDefinition, registers: number[], status: FieldStatus) {
  const stamp = Date.now();
  for (const sibling of uniqueFields) {
    if (sibling.address === field.address && sibling.count === field.count && sibling.available !== false) {
      // This firmware reads zero as enabled, but accepts FF00 when enabling.
      // A write acknowledgement confirms the command, not the readback encoding.
      if (!(status === 'written' && sibling.key === 'useStaticIp')) {
        values[sibling.key] = decodeField(sibling, registers);
      }
      statuses[sibling.key] = status;
      fieldErrors[sibling.key] = '';
      updatedAt[sibling.key] = stamp;
    }
  }
}
async function readFields(list: FieldDefinition[], label: string) {
  let active: Operation | undefined;
  try {
    const session = checkedClient();
    const address = slaveId();
    active = beginOperation('read');
    session.setDemoProfile(currentPageId.value === 'controller');
    const candidates = [...new Map(list.filter(field => field.available !== false).map(field => [field.key, field])).values()];
    Object.assign(progress, { completed: 0, total: candidates.length, failed: 0, label });
    for (const field of candidates) {
      values[field.key] = field.kind === 'bool' ? '0' : '';
      statuses[field.key] = 'reading';
      fieldErrors[field.key] = '';
    }
    setResult(`正在读取${label}，共 ${candidates.length} 个字段…`);
    for (const field of candidates) {
      if (active.cancelled || !connected.value) break;
      try {
        const registers = await session.readRegisters(address, field.address, field.count);
        if (active.cancelled) break;
        updateFromRegisters(field, registers, 'read');
      } catch (error) {
        if (active.cancelled) break;
        values[field.key] = '';
        statuses[field.key] = 'error';
        fieldErrors[field.key] = message(error);
        progress.failed += 1;
        addLog('ERROR', `${field.label}读取失败：${message(error)}`);
      }
      progress.completed += 1;
    }
    if (active.cancelled || !connected.value) setResult(`已停止读取${label}，完成 ${progress.completed}/${progress.total} 个字段。`, 'warn');
    else if (progress.failed) setResult(`${label}读取结束：${progress.completed - progress.failed} 项成功，${progress.failed} 项失败。失败字段已单独标出。`, 'warn');
    else setResult(`${label}读取完成，${progress.completed} 个字段全部成功。`, 'success');
  } catch (error) { setResult(`读取失败：${message(error)}`, 'error'); }
  finally {
    for (const field of list) if (statuses[field.key] === 'reading') statuses[field.key] = 'unread';
    if (active) endOperation(active);
  }
}
function readCurrentPage() {
  return readFields(currentFields.value, currentPage.value.title);
}
function readGroup(group: GroupDefinition) {
  return readFields(group.fields, group.title);
}
function readField(field: FieldDefinition) {
  return readFields([field], field.label);
}
function cancelReading() {
  if (operation.value?.kind !== 'read') return;
  operation.value.cancelled = true;
  client?.cancelPending();
}
function writableFields(group: GroupDefinition) {
  return group.fields.filter(field => field.writable && field.available !== false && field.address !== 481);
}
function groupHasReadableFields(group: GroupDefinition) {
  return group.fields.some(field => field.available !== false);
}
async function writeFields(list: FieldDefinition[], label: string) {
  let active: Operation | undefined;
  let completed = 0;
  try {
    const session = checkedClient();
    const address = slaveId();
    if (!connected.value || busy.value) throw new Error('请先连接设备，并等待当前操作完成。');
    let invalid = false;
    const prepared: { field: FieldDefinition; registers: number[] }[] = [];
    for (const field of list) {
      fieldErrors[field.key] = '';
      try {
        const value = values[field.key] ?? '';
        if (field.address === 481 && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 247)) throw new Error('从机地址必须是 1～247 的整数。');
        prepared.push({ field, registers: encodeField(field, value) });
      } catch (error) { invalid = true; fieldErrors[field.key] = message(error); }
    }
    if (invalid) throw new Error('请修正标出的输入项；本次尚未发送任何写入。');
    if (!prepared.length) return;
    active = beginOperation('write');
    session.setDemoProfile(currentPageId.value === 'controller');
    setResult(`正在写入${label}…`);
    let readbackWarning = '';
    for (const { field, registers } of prepared) {
      if (active.cancelled) throw new Error('操作已取消。');
      if (registers.length === 1) await session.writeRegister(address, field.address, registers[0]!);
      else await session.writeRegisters(address, field.address, registers);
      completed += 1;
      updateFromRegisters(field, registers, 'written');
      if (field.address === 481) {
        config.slaveId = Number(registers[0]);
        setResult(`从机地址写入成功：${address} → ${config.slaveId}，通信地址已更新。`, 'success');
      } else if (field.address === 22) {
        try { updateFromRegisters(field, await session.readRegisters(address, field.address, field.count), 'read'); }
        catch (error) { readbackWarning = `设备已确认写入，功率回读失败：${message(error)}`; addLog('WARN', readbackWarning); }
      }
    }
    if (!prepared.some(item => item.field.address === 481)) setResult(readbackWarning || `${label}写入成功，${completed} 项均已收到设备应答。`, readbackWarning ? 'warn' : 'success');
  } catch (error) {
    setResult(`${label}写入失败${completed ? `（已完成 ${completed} 项，其余未继续写入）` : ''}：${message(error)}`, 'error');
  } finally { if (active) endOperation(active); }
}
function writeGroup(group: GroupDefinition) {
  return writeFields(writableFields(group), group.title);
}
function writeField(field: FieldDefinition) {
  return writeFields([field], field.label);
}
async function requestAction(action: CommandAction) {
  if (controlsDisabled.value) return;
  try {
    pendingSlaveId.value = slaveId();
    if (!action.dangerous) { await executeAction(action, pendingSlaveId.value); return; }
    pendingAction.value = action;
    await nextTick();
    confirmDialog.value?.showModal();
  } catch (error) { setResult(message(error), 'error'); }
}
function closeConfirm() {
  confirmDialog.value?.close();
  pendingAction.value = null;
}
function confirmAction() {
  const action = pendingAction.value;
  const target = pendingSlaveId.value;
  closeConfirm();
  if (action) void executeAction(action, target);
}
async function executeAction(action: CommandAction, target: number) {
  let active: Operation | undefined;
  try {
    active = beginOperation('write');
    checkedClient().setDemoProfile(false);
    await checkedClient().writeRegister(target, action.address, action.value);
    setResult(`${action.label}指令已收到设备应答。`, 'success');
  } catch (error) { setResult(`${action.label}失败：${message(error)}`, 'error'); }
  finally { if (active) endOperation(active); }
}
function download(text: string, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function filenameStamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }
function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
function exportDtu() {
  const fsn = factorySerial.value.trim().toUpperCase();
  const pile = values.pileNumber?.trim();
  if (!fsn || fsn === '0') { setResult('请填写有效的出厂编码，再下载 DTU 记录。', 'warn'); return; }
  if (!pile || pile === '0' || !['read', 'written'].includes(statuses.pileNumber ?? '')) { setResult('请先在设备参数页读取有效桩号，再下载 DTU 记录。', 'warn'); return; }
  const get = (key: string) => ['read', 'written'].includes(statuses[key] ?? '') ? values[key] ?? '' : '';
  const operatorField = uniqueFields.find(field => field.key === 'operator');
  const operatorValue = get('operator');
  const operatorName = operatorField?.options?.find(option => String(option.value) === operatorValue)?.label ?? operatorValue;
  const row = [dateText(new Date()), fsn, pile, get('codeName'), get('softwareVersion'), get('dtuVersion'), operatorName, get('imei'), get('simId'), connectedMode.value === 'demo' ? '模拟设备数据' : 'Modbus读取'];
  const header = ['记录时间', '出厂编码', '桩号', '软件编号', '软件版本号', 'DTU版本', '运营商', 'IMEI', 'ICCID', '备注'];
  download('\uFEFF' + [header, row].map(cells => cells.map(csvCell).join(',')).join('\r\n') + '\r\n', `modbus-dtu-${filenameStamp()}.csv`, 'text/csv;charset=utf-8');
  setResult('DTU 设备记录 CSV 已下载。', 'success');
}
function exportLogs() {
  download(logs.value.map(entry => `[${entry.time}] ${entry.kind.padEnd(5)} ${entry.message}`).join('\n'), `modbus-log-${filenameStamp()}.txt`, 'text/plain;charset=utf-8');
}
function onOfflineReady() { offlineReady.value = true; }
function onUpdateReady() { updateReady.value = true; }
function onOnline() { online.value = navigator.onLine; }
onMounted(() => {
  clockTimer = setInterval(() => { clock.value = new Date(); }, 1000);
  window.addEventListener('offline-ready', onOfflineReady);
  window.addEventListener('update-ready', onUpdateReady);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOnline);
});
onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
  window.removeEventListener('offline-ready', onOfflineReady);
  window.removeEventListener('update-ready', onUpdateReady);
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOnline);
  client?.dispose();
});
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand-mark" aria-hidden="true">MB<span></span></div>
      <div class="brand-copy"><p class="eyebrow">DEVICE WORKSPACE</p><h1>Modbus 设备调试台</h1><p>充电桩参数配置与通信诊断</p></div>
      <div class="header-badges"><span class="badge badge-worker"><span class="tiny-dot"></span>协议 Worker</span><span class="badge" :class="{ 'badge-offline': offlineReady }">{{ offlineReady ? '离线缓存就绪' : '浏览器运行' }}</span></div>
    </header>

    <section class="connection-panel panel" aria-labelledby="connection-title">
      <div class="panel-heading connection-heading"><div><h2 id="connection-title">连接设备</h2><p>选择通信通道，配置当前设备地址。</p></div><div class="connection-status" :class="`connection-status-${connectionState}`"><span class="status-dot"></span>{{ connectionLabel }}</div></div>
      <div class="mode-selector" role="group" aria-label="连接方式">
        <button type="button" :class="{ selected: config.mode === 'serial' }" :disabled="connectionState !== 'disconnected' || busy" :aria-pressed="config.mode === 'serial'" @click="config.mode = 'serial'"><span aria-hidden="true">↔</span> 串口直连</button>
        <button type="button" :class="{ selected: config.mode === 'tcp' }" :disabled="connectionState !== 'disconnected' || busy" :aria-pressed="config.mode === 'tcp'" @click="config.mode = 'tcp'"><span aria-hidden="true">⌁</span> TCP 桥接</button>
        <button type="button" :class="{ selected: config.mode === 'demo' }" :disabled="connectionState !== 'disconnected' || busy" :aria-pressed="config.mode === 'demo'" @click="config.mode = 'demo'"><span aria-hidden="true">◇</span> 模拟设备</button>
      </div>
      <div v-if="config.mode === 'serial'" class="connection-fields">
        <label class="connection-field serial-device"><span>设备串口</span><div class="port-placeholder">{{ connected && connectedMode === 'serial' ? connectionDescription : '连接时由浏览器选择串口' }}</div></label>
        <label class="connection-field"><span>波特率</span><select v-model.number="config.baudRate" :disabled="connectionState !== 'disconnected' || busy"><option :value="9600">9600</option><option :value="38400">38400</option><option :value="115200">115200</option></select></label>
        <div class="connection-field serial-format"><span>数据格式</span><div class="port-placeholder">8 数据位 · 无校验 · 1 停止位</div></div>
      </div>
      <div v-else-if="config.mode === 'tcp'" class="connection-fields tcp-fields">
        <label class="connection-field bridge-address"><span>WebSocket 桥接地址</span><input v-model="config.bridgeUrl" type="text" :disabled="connectionState !== 'disconnected' || busy" placeholder="ws://127.0.0.1:8787/rtu" spellcheck="false" /></label>
        <label class="connection-field"><span>TCP 目标地址</span><input v-model="config.tcpHost" type="text" :disabled="connectionState !== 'disconnected' || busy" spellcheck="false" /></label>
        <label class="connection-field"><span>TCP 端口</span><input v-model.number="config.tcpPort" type="number" min="1" max="65535" :disabled="connectionState !== 'disconnected' || busy" /></label>
      </div>
      <div v-else class="demo-introduction"><span class="demo-icon" aria-hidden="true">◇</span><div><strong>内置模拟设备</strong><p>体验全部页面、读取和写入。模拟模式不会连接或修改物理设备。</p></div></div>
      <div class="connection-bottom">
        <label class="connection-field slave-field"><span>通信地址</span><input v-model.number="config.slaveId" aria-label="通信地址" type="number" min="1" max="247" :disabled="busy || connecting" /></label>
        <label class="connection-field timeout-field"><span>请求超时</span><select v-model.number="config.timeoutMs" :disabled="connectionState !== 'disconnected' || busy"><option :value="1000">1 秒</option><option :value="2000">2 秒</option><option :value="3000">3 秒</option><option :value="5000">5 秒</option></select></label>
        <div class="connection-actions">
          <button type="button" class="button button-primary" data-testid="connect" :disabled="connectionState !== 'disconnected' || busy || (config.mode === 'serial' && (!secureContext || !serialSupported))" @click="connect">{{ connecting ? '正在连接…' : config.mode === 'demo' ? '连接模拟设备' : '连接设备' }}</button>
          <button type="button" class="button button-secondary" :disabled="connectionState === 'disconnected'" @click="disconnect">断开</button>
          <button v-if="connectionState === 'disconnected' && config.mode !== 'demo'" type="button" class="button button-link" data-testid="demo-connect" @click="connectDemo">没有设备？体验模拟模式 →</button>
        </div>
      </div>
      <p v-if="config.mode === 'serial' && !secureContext" class="capability-note capability-note-warning">串口直连需要 HTTPS 或 localhost 安全环境。请通过已部署的 HTTPS 地址或本地开发服务打开。</p>
      <p v-else-if="config.mode === 'serial' && !serialSupported" class="capability-note capability-note-warning">当前浏览器不支持 Web Serial。请使用 Windows / macOS 上的 Chrome 或 Edge；也可以先体验模拟模式。</p>
      <p v-else-if="config.mode === 'serial'" class="capability-note">浏览器会请求你授权一个串口。连接前请关闭占用同一串口的其他程序。</p>
      <p v-if="config.mode === 'tcp'" class="capability-note">TCP 模式需要本地桥接服务，载荷仍是带 CRC 的 Modbus RTU 帧。<a href="http://127.0.0.1:8787/web_mb/" target="_blank" rel="noopener">打开本地桥接入口 ↗</a></p>
    </section>

    <div v-if="connected && connectedMode === 'demo'" class="notice demo-notice" role="status"><span class="notice-symbol" aria-hidden="true">◇</span><div><strong>当前为模拟设备</strong><span>所有读写仅操作本地模拟寄存器。连接真实设备前请先断开并切换通信方式。</span></div></div>
    <div v-if="updateReady" class="notice update-notice" role="status"><span class="notice-symbol" aria-hidden="true">↻</span><div><strong>网页更新已准备好</strong><span>请在当前通信结束后重新打开网页，避免中断设备操作。</span></div></div>

    <main class="workspace">
      <nav class="page-tabs" aria-label="参数页面"><button v-for="(page, index) in pages" :key="page.id" type="button" :class="{ active: currentPageId === page.id }" :aria-current="currentPageId === page.id ? 'page' : undefined" :data-testid="`page-${page.id}`" @click="currentPageId = page.id"><span class="tab-number">0{{ index + 1 }}</span>{{ page.title }}</button></nav>
      <div class="workspace-toolbar"><div><p class="eyebrow">{{ currentPage.id === 'controller' ? 'CONTROLLER' : currentPage.id === 'parameters' ? 'PARAMETERS' : 'DEVICE OVERVIEW' }}</p><h2>{{ currentPage.title }}</h2><p>{{ currentPage.subtitle }}</p></div><div class="page-actions"><span class="read-count">{{ currentReadCount }}/{{ currentFields.filter(field => field.available !== false).length }} 项已读取</span><button v-if="operation?.kind === 'read'" type="button" class="button button-secondary" data-testid="cancel-read" @click="cancelReading">取消读取</button><button type="button" class="button button-primary" data-testid="read-page" :disabled="controlsDisabled" @click="readCurrentPage"><span class="read-icon" aria-hidden="true">↻</span>{{ operation?.kind === 'read' ? '正在读取…' : '读取当前页' }}</button></div></div>
      <div class="result-bar" :class="`result-${resultTone}`" role="status" aria-live="polite"><span class="result-indicator" aria-hidden="true"></span><p>{{ result }}</p><span v-if="lastRead" class="last-updated">更新于 {{ timeText(new Date(lastRead)) }}</span></div>
      <div v-if="operation?.kind === 'read'" class="read-progress" :aria-label="`${progress.label}读取进度`"><div :style="{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }"></div><span>{{ progress.label }} · {{ progress.completed }} / {{ progress.total }}</span></div>

      <div class="parameter-grid">
        <section v-for="group in currentPage.groups" :key="group.id" class="parameter-card panel" :class="{ 'wide-card': group.fields.length > 4 || group.id === 'identity' || group.id === 'backup' }" :aria-labelledby="`group-${group.id}`">
          <header class="card-heading"><h3 :id="`group-${group.id}`">{{ group.title }}</h3><div class="card-actions"><button v-if="groupHasReadableFields(group)" type="button" class="button button-small button-ghost" :disabled="controlsDisabled" :aria-label="`读取${group.title}`" @click="readGroup(group)">读取本组</button><button v-if="writableFields(group).length" type="button" class="button button-small button-secondary" :disabled="controlsDisabled" :aria-label="`写入${group.title}`" @click="writeGroup(group)">{{ group.writeLabel || '写入本组' }}</button></div></header>
          <div class="card-fields" :class="{ 'card-fields-multi': group.fields.length > 1 }"><DeviceField v-for="field in group.fields" :key="field.key" :field="field" :model-value="values[field.key] ?? ''" :status="statuses[field.key] ?? 'unread'" :error="fieldErrors[field.key]" :disabled="controlsDisabled" :allow-write="field.address === 481" @update:model-value="editField(field, $event)" @read="readField" @write="writeField" /></div>
        </section>

        <section v-if="currentPageId === 'controller'" class="parameter-card panel dtu-export-card wide-card" aria-labelledby="dtu-export-title"><header class="card-heading"><div><h3 id="dtu-export-title">DTU 设备记录</h3><p>读取设备参数后，将当前身份信息下载为 CSV。</p></div><span class="badge">UTF-8 CSV</span></header><div class="dtu-export-content"><label class="connection-field"><span>出厂编码（FSN / PSN / MSN）</span><input v-model="factorySerial" type="text" maxlength="30" placeholder="输入或扫描出厂编码" autocomplete="off" spellcheck="false" class="factory-serial" /></label><dl class="dtu-summary"><div><dt>桩号</dt><dd>{{ values.pileNumber || '未读取' }}</dd></div><div><dt>软件版本</dt><dd>{{ values.softwareVersion || '未读取' }}</dd></div><div><dt>DTU 版本</dt><dd>{{ values.dtuVersion || '未读取' }}</dd></div><div><dt>IMEI</dt><dd>{{ values.imei || '未读取' }}</dd></div></dl><button type="button" class="button button-primary" data-testid="export-dtu" :disabled="busy" @click="exportDtu">下载 DTU 记录</button></div></section>

        <section v-if="currentActions.length" class="parameter-card panel command-card wide-card" aria-labelledby="command-title"><header class="card-heading"><div><h3 id="command-title">设备操作</h3><p>复位、清除与校准操作发送前需要再次确认。</p></div></header><div class="command-actions"><button v-for="action in currentActions" :key="action.id" type="button" class="button button-danger-outline" :disabled="controlsDisabled" :title="action.description" :data-testid="`command-${action.id}`" @click="requestAction(action)">{{ action.label }}</button></div></section>
      </div>
      <div class="page-navigation"><button type="button" class="button button-ghost" :disabled="currentPageId === pages[0]?.id" @click="currentPageId = pages[Math.max(0, pages.findIndex(page => page.id === currentPageId) - 1)]!.id">← 上一页</button><span>{{ pages.findIndex(page => page.id === currentPageId) + 1 }} / {{ pages.length }}</span><button type="button" class="button button-ghost" :disabled="currentPageId === pages[pages.length - 1]?.id" @click="currentPageId = pages[Math.min(pages.length - 1, pages.findIndex(page => page.id === currentPageId) + 1)]!.id">下一页 →</button></div>
    </main>

    <section class="communication-panel panel" :class="{ expanded: logsOpen }" aria-labelledby="log-title"><div class="log-heading"><button type="button" class="log-toggle" :aria-expanded="logsOpen" aria-controls="communication-log" @click="logsOpen = !logsOpen"><span class="log-chevron" :class="{ expanded: logsOpen }" aria-hidden="true">›</span><h2 id="log-title">通信日志</h2><span class="log-count">{{ logs.length }}</span></button><div class="traffic-stats"><span><i class="stat-tx"></i>TX <strong>{{ sentBytes }}</strong> B</span><span><i class="stat-rx"></i>RX <strong>{{ receivedBytes }}</strong> B</span><span>过滤噪声 <strong>{{ ignoredNoiseBytes }}</strong> B</span></div></div><div v-show="logsOpen" id="communication-log" class="log-body"><div class="log-toolbar"><div class="log-filter" role="group" aria-label="日志筛选"><button type="button" :class="{ selected: logFilter === 'all' }" @click="logFilter = 'all'">全部</button><button type="button" :class="{ selected: logFilter === 'traffic' }" @click="logFilter = 'traffic'">HEX 收发</button><button type="button" :class="{ selected: logFilter === 'message' }" @click="logFilter = 'message'">操作信息</button></div><div><button type="button" class="button button-small button-ghost" :disabled="!logs.length" @click="exportLogs">导出日志</button><button type="button" class="button button-small button-ghost" :disabled="!logs.length" @click="logs = []">清空</button></div></div><div class="log-entries" tabindex="0" aria-label="通信日志内容"><div v-if="!visibleLogs.length" class="log-empty">等待通信记录。选择设备连接后，HEX 收发与操作结果会显示在这里。</div><div v-for="entry in visibleLogs" :key="entry.id" class="log-entry" :class="`log-${entry.kind.toLowerCase()}`"><time>{{ entry.time }}</time><span class="log-kind">{{ entry.kind }}</span><pre>{{ entry.message }}</pre></div></div><p class="log-footnote">协议请求按顺序发送；读取通信失败可重试一次，写入不会自动重试。最近保留 600 条记录。</p></div></section>

    <footer class="app-footer"><span><span class="tiny-dot" :class="{ 'dot-active': busy }"></span>{{ busyLabel }}<span class="footer-divider">/</span>界面与协议分线程处理</span><span>{{ !online ? '当前离线 · ' : '' }}{{ offlineReady ? '资源已缓存' : '等待离线缓存' }}<span class="footer-divider">/</span>{{ dateText(clock) }}</span></footer>
    <dialog ref="confirmDialog" class="confirm-dialog" @cancel="closeConfirm"><template v-if="pendingAction"><div class="dialog-warning-icon" aria-hidden="true">!</div><h2>{{ pendingAction.label }}</h2><p>{{ pendingAction.description }}</p><div class="dialog-device"><span>{{ connectedMode === 'demo' ? '模拟设备' : '目标设备' }}</span><strong>通信地址 {{ pendingSlaveId }}</strong><small>参数 {{ String(pendingAction.address + 1).padStart(4, '0') }} · 地址 {{ pendingAction.address }}</small></div><p class="dialog-warning">请核对目标设备。指令发送后不能通过本页面撤销。</p><div class="dialog-actions"><button type="button" class="button button-secondary" autofocus @click="closeConfirm">取消</button><button type="button" class="button button-danger" data-testid="confirm-command" :disabled="!connected || busy" @click="confirmAction">确认执行</button></div></template></dialog>
  </div>
</template>
