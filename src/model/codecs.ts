import type { FieldDefinition } from './device';

const alarmLabels: Record<number, string> = {
  0: '急停', 1: '电表', 2: '射频', 3: '网关', 4: 'CP', 5: '漏电',
  6: '欠压', 7: '过压', 8: '过流', 11: '接地', 12: '过温',
};
let gb2312Encoder: Map<string, number[]> | undefined;

function decoder(): TextDecoder {
  try { return new TextDecoder('gbk', { fatal: true }); }
  catch { throw new Error('当前浏览器不支持 GB2312 / GBK 字符编码'); }
}

/** Build the reverse table from the browser's encoding index; never substitute UTF-8. */
export function encodeGb2312(value: string): Uint8Array {
  if (!gb2312Encoder) {
    const table = new Map<string, number[]>();
    for (let byte = 1; byte < 128; byte++) table.set(String.fromCharCode(byte), [byte]);
    const gbk = decoder();
    for (let lead = 0xa1; lead <= 0xf7; lead++) {
      for (let trail = 0xa1; trail <= 0xfe; trail++) {
        try {
          const character = gbk.decode(new Uint8Array([lead, trail]));
          if (character.length === 1 && character !== '\ufffd' && !table.has(character)) table.set(character, [lead, trail]);
        } catch { /* Unassigned code point in the GB2312 byte range. */ }
      }
    }
    gb2312Encoder = table;
  }
  const output: number[] = [];
  for (const character of value) {
    const encoded = gb2312Encoder.get(character);
    if (!encoded) throw new Error(`字符“${character === '\0' ? '空字符' : character}”不能使用 GB2312 编码`);
    output.push(...encoded);
  }
  return new Uint8Array(output);
}

/** Match the WPF reader's GB2312 range and noise replacement, preserving final ASCII. */
export function decodeGb2312(bytes: Uint8Array): string {
  const gbk = decoder();
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const lead = bytes[index]!;
    if (lead <= 0x7f) {
      if (lead !== 0) result += String.fromCharCode(lead);
      index++;
    } else if (lead >= 0xa1 && lead <= 0xf7) {
      const trail = bytes[index + 1];
      if (trail !== undefined && trail >= 0xa1 && trail <= 0xfe) {
        try { result += gbk.decode(bytes.subarray(index, index + 2)); }
        catch { result += '?'; }
      } else result += '?';
      index += 2;
    } else {
      result += '?';
      index++;
    }
  }
  return result;
}

function assertRegisters(field: FieldDefinition, words: number[]): void {
  if (field.available === false) throw new Error(`${field.label}：当前固件未实现此寄存器`);
  if (words.length !== field.count) throw new Error(`${field.label}：需要 ${field.count} 个寄存器，收到 ${words.length} 个`);
  if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) throw new Error(`${field.label}：寄存器值必须是 0..65535 的整数`);
}

function toBytes(words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 2);
  words.forEach((word, index) => { bytes[index * 2] = word >>> 8; bytes[index * 2 + 1] = word & 0xff; });
  return bytes;
}

function fromBytes(bytes: Uint8Array): number[] {
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index += 2) words.push((bytes[index]! << 8) | bytes[index + 1]!);
  return words;
}

function numberValue(field: FieldDefinition, text: string, integer: boolean, min: number, max: number): number {
  if (!text.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) throw new Error(`${field.label}：请输入有效数字`);
  const value = Number(text);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) throw new Error(`${field.label}：请输入${integer ? '整数' : '有限数值'}`);
  if (value < min || value > max) throw new Error(`${field.label}：范围为 ${min}..${max}`);
  return value;
}

function parseTime(text: string): number[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) throw new Error('时间格式应为 YYYY-MM-DD HH:mm:ss');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 2000 || year > 2255 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw new Error('设备时间无效，年份范围为 2000..2255');
  return [((year - 2000) << 8) | month, (day << 8) | hour, (minute << 8) | second];
}

export function decodeField(field: FieldDefinition, words: number[]): string {
  assertRegisters(field, words);
  const first = words[0]!;
  switch (field.kind) {
    case 'u16': return String(first);
    case 'u32': return String(first * 65536 + words[1]!);
    case 'enum': return String(words.length === 2 ? first * 65536 + words[1]! : first);
    case 'bool': return field.key === 'useStaticIp' ? (first === 0 ? '1' : '0') : (first === 0 ? '0' : '1');
    case 'float': {
      const bytes = toBytes(words);
      const value = new DataView(bytes.buffer).getFloat32(0, false);
      if (!Number.isFinite(value)) throw new Error(`${field.label}：设备返回非有限浮点数`);
      return field.decimals === undefined ? String(value) : value.toFixed(field.decimals);
    }
    case 'scaled10': {
      const value = first / 10;
      if (field.integerDisplay) return String(Math.trunc(value));
      return field.decimals === undefined ? String(value) : value.toFixed(field.decimals);
    }
    case 'text': return decodeGb2312(toBytes(words));
    case 'hex': return words.map((word) => word.toString(16).padStart(4, '0')).join('').toUpperCase();
    case 'ip': return Array.from(toBytes(words)).join('.');
    case 'mac': return Array.from(toBytes(words), (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
    case 'time': {
      const bytes = toBytes(words);
      const [yy, month, day, hour, minute, second] = Array.from(bytes) as [number, number, number, number, number, number];
      const text = `${2000 + yy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
      try { parseTime(text); return text; } catch { return `无效时间：${text}`; }
    }
    case 'alarms': {
      const active = Object.entries(alarmLabels).filter(([bit]) => (first & (1 << Number(bit))) !== 0).map(([, label]) => label);
      return active.length ? active.join('、') : '无告警';
    }
  }
}

export function encodeField(field: FieldDefinition, text: string): number[] {
  if (field.available === false) throw new Error(`${field.label}：当前固件未实现此寄存器`);
  if (!field.writable) throw new Error(`${field.label}为只读字段`);
  let words: number[];
  switch (field.kind) {
    case 'u16': {
      const min = field.key === 'slaveAddress' ? 1 : (field.min ?? 0);
      const max = field.key === 'slaveAddress' ? 247 : (field.max ?? 65535);
      words = [numberValue(field, text, true, min, max)]; break;
    }
    case 'u32': {
      const value = numberValue(field, text, true, field.min ?? 0, field.max ?? 0xffffffff);
      words = [Math.floor(value / 65536), value % 65536]; break;
    }
    case 'enum': {
      const value = numberValue(field, text, true, 0, field.count === 2 ? 0xffffffff : 65535);
      if (field.options && !field.options.some((option) => option.value === value)) throw new Error(`${field.label}：请选择有效选项`);
      words = field.count === 2 ? [Math.floor(value / 65536), value % 65536] : [value]; break;
    }
    case 'bool':
      if (text !== '0' && text !== '1') throw new Error(`${field.label}：开关值只能是 0 或 1`);
      words = [text === '1' ? 0xff00 : 0]; break;
    case 'float': {
      const value = numberValue(field, text, false, field.min ?? -3.4028234663852886e38, field.max ?? 3.4028234663852886e38);
      const bytes = new Uint8Array(4);
      const view = new DataView(bytes.buffer);
      view.setFloat32(0, value, false);
      if (!Number.isFinite(view.getFloat32(0, false))) throw new Error(`${field.label}：超过 32 位浮点数范围`);
      words = fromBytes(bytes); break;
    }
    case 'scaled10': {
      const value = numberValue(field, text, field.integerInput ?? false, field.min ?? 0, field.max ?? 6553.5);
      const scaled = value * 10;
      if (Math.abs(Math.round(scaled) - scaled) > 0.0000001 || scaled < 0 || scaled > 65535) throw new Error(`${field.label}：最多保留一位小数，范围为 0..6553.5`);
      words = [Math.round(scaled)]; break;
    }
    case 'text': {
      if (field.key === 'pileNumber' && !text.trim()) throw new Error('充电桩桩号不能为空');
      const encoded = encodeGb2312(text);
      if (encoded.length > field.count * 2) throw new Error(`${field.label}：GB2312 编码为 ${encoded.length} 字节，最多 ${field.count * 2} 字节`);
      const bytes = new Uint8Array(field.count * 2);
      bytes.set(encoded);
      words = fromBytes(bytes); break;
    }
    case 'hex': {
      const value = text.trim();
      if (!new RegExp(`^[0-9a-f]{${field.count * 4}}$`, 'i').test(value)) throw new Error(`${field.label}：必须正好是 ${field.count * 4} 位十六进制字符`);
      words = value.match(/.{4}/g)!.map((word) => parseInt(word, 16)); break;
    }
    case 'ip': {
      const parts = text.trim().split('.');
      if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) throw new Error(`${field.label}：请输入有效 IPv4 地址`);
      words = fromBytes(new Uint8Array(parts.map(Number))); break;
    }
    case 'mac': {
      const value = text.trim();
      if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) throw new Error(`${field.label}：MAC 格式应为 00:11:22:33:44:55`);
      words = fromBytes(new Uint8Array(value.split(':').map((byte) => parseInt(byte, 16)))); break;
    }
    case 'time': words = parseTime(text); break;
    case 'alarms': throw new Error('告警位域为只读数据');
  }
  assertRegisters(field, words);
  return words;
}
