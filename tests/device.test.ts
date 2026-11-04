import { describe, expect, it } from 'vitest';
import { commandActions, createDemoRegisters, pages, type FieldDefinition } from '../src/model/device';
import { decodeField, decodeGb2312, encodeField, encodeGb2312 } from '../src/model/codecs';

const fields = pages.flatMap((page) => page.groups.flatMap((group) => group.fields));
function find(key: string): FieldDefinition {
  const result = fields.find((field) => field.key === key);
  if (!result) throw new Error(`Missing field ${key}`);
  return result;
}
const writable = (key: string): FieldDefinition => ({ ...find(key), writable: true });

describe('WPF wire-layout compatibility', () => {
  it('packs uint32 high register first without signed 32-bit overflow', () => {
    expect(decodeField(find('adminPassword'), [0x89ab, 0xcdef])).toBe('2309737967');
    expect(encodeField(find('adminPassword'), '4294967295')).toEqual([0xffff, 0xffff]);
    expect(encodeField(find('adminPassword'), '123456')).toEqual([1, 57920]);
  });

  it('matches FloatToRegisters(value, false, false) used by WPF', () => {
    expect(encodeField(find('tempFactor1'), '1')).toEqual([0x3f80, 0]);
    expect(encodeField(find('tempFactor1'), '108.9')).toEqual([0x42d9, 0xcccd]);
    expect(encodeField(find('tempFactor2'), '-13.3')).toEqual([0xc154, 0xcccd]);
    expect(decodeField(find('tempFactor1'), [0x42d9, 0xcccd])).toBe('108.9000');
    expect(decodeField(find('tempFactor2'), [0xc154, 0xcccd])).toBe('-13.3000');
    expect(decodeField(find('cpVoltage'), [0x4140, 0])).toBe('12.000');
  });

  it('uses compact GB2312 bytes, not UTF-8 or one ASCII character per register', () => {
    expect(Array.from(encodeGb2312('充电桩'))).toEqual([0xb3, 0xe4, 0xb5, 0xe7, 0xd7, 0xae]);
    const field: FieldDefinition = { ...find('pileNumber'), count: 3 };
    expect(encodeField(field, '充电桩')).toEqual([0xb3e4, 0xb5e7, 0xd7ae]);
    expect(decodeField(field, [0xb3e4, 0xb5e7, 0xd7ae])).toBe('充电桩');
    expect(encodeField({ ...field, count: 2 }, '12A')).toEqual([0x3132, 0x4100]);
    expect(decodeField({ ...field, count: 2 }, [0x3132, 0x4100])).toBe('12A');
    expect(decodeField({ ...field, count: 1 }, [0x4142])).toBe('AB');
  });

  it('replaces malformed GB2312 bytes with noise markers', () => {
    expect(decodeGb2312(new Uint8Array([0x81, 0x41, 0xa1, 0x20, 0x42, 0]))).toBe('?A?B');
  });

  it('packs IP and MAC addresses high byte first', () => {
    expect(encodeField(find('serverIp'), '192.168.1.10')).toEqual([0xc0a8, 0x010a]);
    expect(decodeField(find('serverIp'), [0xc0a8, 0x010a])).toBe('192.168.1.10');
    expect(decodeField(find('macAddress'), [0x0011, 0x2233, 0xaabb])).toBe('00:11:22:33:AA:BB');
    expect(encodeField(writable('macAddress'), '00:11:22:33:AA:BB')).toEqual([0x0011, 0x2233, 0xaabb]);
  });

  it('uses binary YY/MM/DD/hh/mm/ss, rather than BCD time', () => {
    const data = [0x1a0b, 0x0409, 0x031c];
    expect(decodeField(find('localTime'), data)).toBe('2026-11-04 09:03:28');
    expect(encodeField(writable('localTime'), '2026-11-04 09:03:28')).toEqual(data);
    expect(decodeField(find('localTime'), [0x1a02, 0x1e09, 0])).toContain('无效时间');
    expect(encodeField(writable('localTime'), '2024-02-29 00:00:00')).toEqual([0x1802, 0x1d00, 0]);
  });

  it('reads the alarm uint16 only; address 98 remains the CP float', () => {
    expect(find('alarmCode').address).toBe(97);
    expect(find('alarmCode').count).toBe(1);
    expect(find('cpVoltage').address).toBe(98);
    expect(decodeField(find('alarmCode'), [0x1001])).toBe('急停、过温');
    expect(decodeField(find('alarmCode'), [0x0200])).toBe('无告警');
    expect(decodeField(find('alarmCode'), [0])).toBe('无告警');
  });

  it('preserves controller scaling and keeps measured power read-only', () => {
    expect(find('outPower').address).toBe(19);
    expect(find('outPower').writable).toBe(false);
    expect(decodeField(find('outPower'), [123])).toBe('12.3');
    expect(find('setPower').address).toBe(22);
    expect(encodeField(find('setPower'), '6553')).toEqual([65530]);
    expect(encodeField(find('setPower'), '6553.5')).toEqual([65535]);
    expect(encodeField(find('setPower'), '7.5')).toEqual([75]);
    expect(decodeField(find('outVoltage'), [2205])).toBe('220');
    expect(encodeField(find('setPower'), '7')).toEqual([70]);
  });

  it('preserves static-IP readback and 06 switch write semantics', () => {
    expect(decodeField(find('useStaticIp'), [0])).toBe('1');
    expect(decodeField(find('useStaticIp'), [1])).toBe('0');
    expect(encodeField(find('useStaticIp'), '1')).toEqual([0xff00]);
    expect(encodeField(find('useStaticIp'), '0')).toEqual([0]);
  });
});

describe('input validation', () => {
  it('rejects bad integer ranges, fractions and non-finite numbers', () => {
    for (const value of ['', '-1', '1.5', '4294967296', 'Infinity', '0x10']) expect(() => encodeField(find('adminPassword'), value)).toThrow();
    for (const value of ['0', '248', '-1', '1.5']) expect(() => encodeField(find('slaveAddress'), value)).toThrow();
    expect(encodeField(find('slaveAddress'), '247')).toEqual([247]);
    for (const value of ['NaN', 'Infinity', '3.5e38', '']) expect(() => encodeField(find('tempFactor1'), value)).toThrow();
    expect(() => decodeField(find('tempFactor1'), [0x7f80, 0])).toThrow('非有限');
  });

  it('rejects invalid enum values and malformed hex keys', () => {
    expect(() => encodeField(find('wifiMode'), '2')).toThrow('有效选项');
    for (const value of ['123', '00112233445Z', '00112233445566']) expect(() => encodeField(find('cardKey'), value)).toThrow();
    expect(encodeField(find('cardKey'), '001122aabbcc')).toEqual([0x0011, 0x22aa, 0xbbcc]);
  });

  it('checks byte capacity rather than string length and never silently truncates text', () => {
    const field: FieldDefinition = { ...find('wifiName'), count: 2 };
    expect(encodeField(field, '中文')).toHaveLength(2);
    expect(() => encodeField(field, '中文字')).toThrow('6 字节');
    expect(() => encodeField(field, '12345')).toThrow('5 字节');
    expect(() => encodeField(field, '😀')).toThrow('GB2312');
    expect(() => encodeField(find('pileNumber'), '   ')).toThrow('不能为空');
    expect(() => encodeGb2312('A\0B')).toThrow('空字符');
  });

  it('rejects malformed IP/MAC/time values and power overflow', () => {
    for (const value of ['256.1.1.1', '1.2.3', '1.2.3.-1', '1.2.3.1e2']) expect(() => encodeField(find('serverIp'), value)).toThrow('IPv4');
    expect(() => encodeField(writable('macAddress'), '00:11:22:33:44')).toThrow('MAC');
    for (const value of ['2025-02-29 12:00:00', '2026-13-01 00:00:00', '2026-01-01 24:00:00', '1999-01-01 00:00:00']) expect(() => encodeField(writable('localTime'), value)).toThrow();
    for (const value of ['6554', '-1', '1.55']) expect(() => encodeField(find('setPower'), value)).toThrow();
    const fractional: FieldDefinition = { ...find('setPower'), integerInput: false, max: 6553.5 };
    expect(encodeField(fractional, '6553.5')).toEqual([65535]);
    expect(() => encodeField(fractional, '7.01')).toThrow('一位小数');
  });

  it('rejects writes to read-only/unsupported fields and malformed receive words', () => {
    expect(() => encodeField(find('outPower'), '5')).toThrow('只读');
    expect(() => encodeField(find('groundDetect'), '0')).toThrow('未实现');
    expect(() => decodeField(find('groundDetect'), [0])).toThrow('未实现');
    expect(() => decodeField(find('adminPassword'), [1])).toThrow('2 个寄存器');
    expect(() => decodeField(find('serverPort'), [-1])).toThrow('0..65535');
    expect(() => decodeField(find('serverPort'), [1.5])).toThrow('0..65535');
  });
});

describe('page and command mapping', () => {
  it('covers all three pages and the firmware address corrections', () => {
    expect(pages.map((page) => page.id)).toEqual(['device', 'parameters', 'controller']);
    // PortFunction is displayed on both pages and deliberately shares its device value.
    expect(new Set(fields.map((field) => field.key)).size).toBe(fields.length - 1);
    const controllerFields = pages.find((page) => page.id === 'controller')!.groups.flatMap((group) => group.fields);
    expect(controllerFields.find((field) => field.key === 'portFunction')?.address).toBe(107);
    expect(find('slaveAddress').address).toBe(481);
    expect(find('slaveAddress').count).toBe(1);
    expect(find('productKey').address).toBe(309);
    expect(find('groundDetect').available).toBe(false);
    expect(find('portFunction').options?.map((option) => option.value)).toEqual([0, 1, 2, 3]);
    expect(fields.length).toBeGreaterThan(65);
  });

  it('models destructive commands as single-register FF00 writes', () => {
    expect(commandActions.map((action) => action.address)).toEqual([103, 106, 181, 403, 404, 405]);
    expect(commandActions.every((action) => action.value === 0xff00 && action.dangerous)).toBe(true);
  });

  it('creates complete synthetic words that every available field can decode', () => {
    const data = createDemoRegisters();
    for (const field of fields.filter((entry) => entry.available !== false)) {
      const words = Array.from({ length: field.count }, (_, index) => data[field.address + index]!);
      expect(() => decodeField(field, words)).not.toThrow();
    }
    expect(data[481]).toBe(1);
    expect(decodeField(find('pileNumber'), Array.from({ length: 16 }, (_, index) => data[10 + index]!))).toBe('DEMO-CHARGER-001');
  });

  it('keeps the overlapping controller demo map independent from charger text fields', () => {
    const data = createDemoRegisters('controller');
    const read = (key: string) => {
      const field = find(key);
      return decodeField(field, Array.from({ length: field.count }, (_, index) => data[field.address + index]!));
    };
    expect(read('controllerNumber')).toBe('CTRL-DEMO');
    expect(read('controllerRatedPower')).toBe('7');
    expect(read('controllerGunStatus')).toBe('2');
    expect(read('outVoltage')).toBe('220');
  });
});
