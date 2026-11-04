import { encodeField } from './codecs';

export type FieldKind = 'u16' | 'u32' | 'float' | 'text' | 'hex' | 'ip' | 'mac' | 'time' | 'enum' | 'bool' | 'alarms' | 'scaled10';

export interface FieldDefinition {
  key: string;
  label: string;
  /** Zero-based protocol address; the printed parameter number is address + 1. */
  address: number;
  count: number;
  kind: FieldKind;
  writable: boolean;
  options?: { value: number; label: string }[];
  unit?: string;
  note?: string;
  /** False means this firmware does not implement the register. Never request it. */
  available?: boolean;
  min?: number;
  max?: number;
  decimals?: number;
  integerDisplay?: boolean;
  integerInput?: boolean;
}

export interface GroupDefinition {
  id: string;
  title: string;
  fields: FieldDefinition[];
  writeLabel?: string;
}

export interface PageDefinition {
  id: 'device' | 'parameters' | 'controller';
  title: string;
  subtitle: string;
  groups: GroupDefinition[];
}

export interface CommandAction {
  id: string;
  label: string;
  pageId: PageDefinition['id'];
  address: number;
  value: number;
  dangerous: boolean;
  description: string;
}

const field = (key: string, label: string, address: number, count: number, kind: FieldKind, writable = false, extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ key, label, address, count, kind, writable, ...extra });
const choices = (...labels: string[]) => labels.map((label, value) => ({ value, label }));
const group = (id: string, title: string, fields: FieldDefinition[], writeLabel?: string): GroupDefinition =>
  ({ id, title, fields, ...(writeLabel ? { writeLabel } : {}) });

/** Address mapping copied from the WPF Reg class, not the printed pXXXX number. */
export const registers = {
  softwareVersion: 92, codeName: 183, adminPassword: 6, userPassword: 8,
  cardKey: 220, ratedPower: 28, ratedCurrent: 30, gunCount: 32, pileType: 26,
  maxOutputPower: 304, pileNumber: 10, rate: 82, serviceFee: 84,
  wifiName: 108, wifiPassword: 124, serverIp: 40, serverPort: 42,
  domainName: 188, enableMode: 187, rssi: 55, netDeviceStatus: 56,
  protocolConnStatus: 57, dtuVersion: 411, imei: 427, simId: 443, operator: 459,
  localIp: 256, gateway: 258, subnetMask: 260, macAddress: 262, useStaticIp: 265,
  qrCodePrefix: 266, inputVoltage: 65, inputCurrent: 67, localTime: 177,
  alarmCode: 97, cpVoltage: 98, cpDuty: 180, wifiMode: 184, workMode: 182,
  orderCount: 181, groundDetect: 186, productKey: 309, deviceName: 320,
  deviceSecret: 337, regCode: 370, portFunction: 107, slaveAddress: 481,
  temperature: 406, tempFactor1: 407, tempFactor2: 409,
  offlineCardSwitch: 460, offlineCardMode: 461, backupPileNumber: 462,
  backupIp: 478, backupPort: 480, controllerType: 0, controllerGunCount: 1,
  controllerGunType: 2, controllerNumber: 3, controllerRatedPower: 13,
  controllerGunStatus: 14, outVoltage: 15, outCurrent: 16, outPower: 19, setPower: 22,
} as const;

export const readBlocks: [number, number][] = [
  [6, 94], [107, 33], [177, 46], [256, 42], [304, 99], [411, 70],
];

export const pages: PageDefinition[] = [
  {
    id: 'device', title: '设备参数', subtitle: '身份信息、联网配置与充电桩参数',
    groups: [
      group('version', '版本信息', [
        field('softwareVersion', '软件版本号', 92, 1, 'u16'),
        field('codeName', '代码编号', 183, 1, 'u16'),
      ]),
      group('passwords', '密码与卡密钥', [
        field('adminPassword', '管理员密码', 6, 2, 'u32', true),
        field('userPassword', '用户密码', 8, 2, 'u32', true),
        field('cardKey', '充电桩卡密钥', 220, 3, 'hex', true, { note: '12 位十六进制字符' }),
      ], '写入密码与密钥'),
      group('pile', '充电桩参数', [
        field('ratedPower', '充电桩功率', 28, 2, 'u32'),
        field('ratedCurrent', '充电桩电流', 30, 2, 'u32'),
        field('gunCount', '充电枪个数', 32, 2, 'u32'),
        field('pileType', '充电桩类型', 26, 2, 'enum', false, { options: choices('保留', '单相电流', '三相电流', '直流') }),
        field('maxOutputPower', '最大输出功率', 304, 2, 'u32', true, { unit: 'W' }),
        field('pileNumber', '充电桩桩号', 10, 16, 'text', true, { note: '最多 32 字节 GB2312 编码' }),
      ], '写入桩参数'),
      group('billing', '计费参数', [
        field('rate', '费率', 82, 2, 'u32'),
        field('serviceFee', '服务费', 84, 2, 'u32'),
      ]),
      group('wifi', 'Wi-Fi 配置', [
        field('wifiName', 'Wi-Fi 名称', 108, 16, 'text', true),
        field('wifiPassword', 'Wi-Fi 密码', 124, 16, 'text', true),
      ], '写入 Wi-Fi'),
      group('server', '服务器配置', [
        field('serverIp', '服务器 IP', 40, 2, 'ip', true),
        field('serverPort', '服务器端口', 42, 1, 'u16', true),
        field('domainName', '服务器域名', 188, 32, 'text', true),
        field('enableMode', '启用模式', 187, 1, 'enum', false, { options: choices('IP', '域名'), note: '沿用原上位机，此项只读取' }),
      ], '写入服务器'),
      group('networkStatus', '网络状态', [
        field('rssi', 'RSSI', 55, 1, 'u16'),
        field('netDeviceStatus', '网络设备状态', 56, 1, 'enum', false, { options: [{ value: 0, label: '未知类型' }, { value: 1, label: '打开中' }, { value: 2, label: '已连接' }] }),
        field('protocolConnStatus', '协议连接状态', 57, 1, 'enum', false, { options: [{ value: 0, label: '初始化' }, { value: 1, label: '打开中' }, { value: 2, label: '已连接' }, { value: 4, label: '已关闭' }] }),
      ]),
      group('dtu', 'DTU 身份信息', [
        field('dtuVersion', 'DTU 版本', 411, 16, 'text'),
        field('imei', 'IMEI', 427, 16, 'text'),
        field('simId', 'SIM ID / ICCID', 443, 16, 'text'),
        field('operator', '运营商', 459, 1, 'enum', false, { options: choices('None', '电信', '联通', '移动', '未知') }),
      ]),
      group('ethernet', '网口配置', [
        field('localIp', '本地 IP', 256, 2, 'ip', true),
        field('gateway', '默认网关', 258, 2, 'ip', true),
        field('subnetMask', '子网掩码', 260, 2, 'ip', true),
        field('macAddress', 'MAC 地址', 262, 3, 'mac'),
      ], '写入网口'),
      group('staticIp', '静态 IP 开关', [
        field('useStaticIp', '使用静态 IP', 265, 1, 'bool', true, { note: '按原程序开关协议写入，修改后可重新读取状态' }),
      ], '写入静态 IP 开关'),
      group('qr', '二维码配置', [
        field('qrCodePrefix', '二维码前缀', 266, 32, 'text', true),
      ], '写入二维码前缀'),
    ],
  },
  {
    id: 'parameters', title: '普通参数', subtitle: '实时状态、模式、告警与温度校准',
    groups: [
      group('realtime', '实时状态与告警', [
        field('inputVoltage', '进线电压', 65, 2, 'float', false, { unit: 'V', decimals: 1 }),
        field('inputCurrent', '进线电流', 67, 2, 'float', false, { unit: 'A', decimals: 1 }),
        field('localTime', '设备时间', 177, 3, 'time'),
        field('alarmCode', '当前故障', 97, 1, 'alarms'),
      ]),
      group('cp', 'CP 参数', [
        field('cpVoltage', 'CP 电压', 98, 2, 'float', false, { unit: 'V', decimals: 3 }),
        field('cpDuty', 'CP 占空比', 180, 1, 'u16', true, { unit: '%' }),
      ], '写入 CP 参数'),
      group('modes', '桩模式', [
        field('wifiMode', 'Wi-Fi / 蓝牙', 184, 1, 'enum', true, { options: choices('Wi-Fi', '蓝牙') }),
        field('workMode', '工作模式', 182, 1, 'enum', true, { options: choices('正常模式', '即插即充模式') }),
        field('orderCount', '订单总数', 181, 1, 'u16'),
        field('groundDetect', '接地检测', 186, 1, 'enum', false, { available: false, options: choices('Open', 'Close'), note: '固件没有此寄存器的处理程序；地锁请使用端口功能的启用/禁用地锁选项' }),
      ], '写入桩模式'),
      group('identity', '设备三元组', [
        field('productKey', '标识字符串 ProductKey', 309, 11, 'text'),
        field('deviceName', '资产码 DeviceName', 320, 17, 'text'),
        field('deviceSecret', '设备密钥 DeviceSecret', 337, 33, 'text'),
      ]),
      group('registration', '设备注册码', [
        field('regCode', '注册码', 370, 33, 'text', true),
      ], '写入注册码'),
      group('portFunction', '端口功能', [
        field('portFunction', '端口功能', 107, 1, 'enum', true, { options: choices('上位机', '协调控制器', '启用地锁', '禁用地锁') }),
      ], '写入端口功能'),
      group('slaveAddress', '从机地址', [
        field('slaveAddress', '从机地址', 481, 1, 'u16', true, { min: 1, max: 247, note: '参数 0482；成功应答后同步更新当前通信地址' }),
      ], '写入从机地址'),
      group('temperature', '枪温读取', [
        field('temperature', '当前温度', 406, 1, 'u16', false, { unit: '℃' }),
      ]),
      group('temperatureFactors', '温度校准系数', [
        field('tempFactor1', '温度系数 1', 407, 2, 'float', true, { decimals: 4, note: '原始参考值 108.9' }),
        field('tempFactor2', '温度系数 2', 409, 2, 'float', true, { decimals: 4, note: '原始参考值 -13.3' }),
      ], '写入温度系数'),
      group('offlineCard', '离线卡', [
        field('offlineCardMode', '离线卡启用模式', 461, 1, 'enum', true, { options: choices('离线启用', '在线启用') }),
        field('offlineCardSwitch', '离线卡开关', 460, 1, 'enum', true, { options: choices('Close', 'Open') }),
      ], '写入离线卡设置'),
      group('backup', '双 DTU 备份协议', [
        field('backupPileNumber', '备份协议桩号', 462, 16, 'text', true),
        field('backupIp', '备份协议 IP', 478, 2, 'ip', true),
        field('backupPort', '备份协议端口', 480, 1, 'u16', true),
      ], '写入备份协议'),
    ],
  },
  {
    id: 'controller', title: '协调控制器', subtitle: '枪状态、实测功率与功率设定',
    groups: [
      group('controllerIdentity', '控制器信息', [
        field('controllerType', '机型类型', 0, 1, 'enum', false, { options: choices('直流', '交流') }),
        field('controllerGunCount', '枪总数', 1, 1, 'u16'),
        field('controllerGunType', '枪类型', 2, 1, 'enum', false, { options: choices('单枪', '双枪') }),
        field('controllerNumber', '充电桩编号', 3, 8, 'text'),
        field('controllerRatedPower', '额定功率', 13, 1, 'scaled10', false, { unit: 'kW', integerDisplay: true }),
        field('portFunction', '端口功能', 107, 1, 'enum', false, { options: choices('上位机', '协调控制器', '启用地锁', '禁用地锁') }),
      ]),
      group('controllerLive', '枪实时状态', [
        field('controllerGunStatus', '枪当前状态', 14, 1, 'enum', false, { options: choices('空闲', '插枪', '充电中', '故障') }),
        field('outVoltage', '枪输出电压', 15, 1, 'scaled10', false, { unit: 'V', integerDisplay: true }),
        field('outCurrent', '枪输出电流', 16, 1, 'scaled10', false, { unit: 'A', integerDisplay: true }),
        field('outPower', '枪实测输出功率', 19, 1, 'scaled10', false, { unit: 'kW', decimals: 1, note: '实测功率寄存器只读，功率设定使用下面的设定值' }),
      ]),
      group('controllerPower', '枪有功功率设定', [
        field('setPower', '枪设定有功功率', 22, 1, 'scaled10', true, { min: 0, max: 6553.5, unit: 'kW', decimals: 1, note: '范围 0..6553.5 kW，分辨率 0.1 kW；合并原程序的两个功率设定入口' }),
      ], '写入设定功率'),
    ],
  },
];

export const commandActions: CommandAction[] = [
  { id: 'factoryReset', label: '恢复出厂设置', pageId: 'parameters', address: 103, value: 0xff00, dangerous: true, description: '恢复设备的出厂参数，发送后不能撤销。' },
  { id: 'softwareReset', label: '软件复位', pageId: 'parameters', address: 106, value: 0xff00, dangerous: true, description: '重启设备，当前通信连接可能断开。' },
  { id: 'clearOrders', label: '清除所有订单', pageId: 'parameters', address: 181, value: 0xff00, dangerous: true, description: '清除设备保存的订单，发送后不能撤销。' },
  { id: 'clearTriple', label: '清空三元组', pageId: 'parameters', address: 403, value: 0xff00, dangerous: true, description: '清除 ProductKey、DeviceName 和 DeviceSecret，发送后不能撤销。' },
  { id: 'temp1KCalib', label: '1K-85℃ 校准', pageId: 'parameters', address: 404, value: 0xff00, dangerous: true, description: '请先按设备要求接好 1K 校准电阻；此命令会改变校准数据。' },
  { id: 'temp10KCalib', label: '10K-25℃ 校准', pageId: 'parameters', address: 405, value: 0xff00, dangerous: true, description: '请先按设备要求接好 10K 校准电阻；此命令会改变校准数据。' },
];

/** Deliberately synthetic fixture for the clearly labelled demo connection. */
export function createDemoRegisters(profile: 'charger' | 'controller' = 'charger'): Record<number, number> {
  const result: Record<number, number> = {};
  for (let address = 0; address < 550; address++) result[address] = 0;
  const examples: Record<string, string> = {
    softwareVersion: '200', codeName: '2026', adminPassword: '123456', userPassword: '123456',
    cardKey: '112233445566', ratedPower: '7', ratedCurrent: '32', gunCount: '1', pileType: '1',
    maxOutputPower: '7000', pileNumber: 'DEMO-CHARGER-001', rate: '100', serviceFee: '20',
    wifiName: 'Modbus-Demo', wifiPassword: 'demo-password', serverIp: '192.168.1.100',
    serverPort: '5002', domainName: 'example.com', enableMode: '0', rssi: '25',
    netDeviceStatus: '2', protocolConnStatus: '2', dtuVersion: 'DEMO-DTU-2.0',
    imei: '860000000000001', simId: '89860000000000000001', operator: '3',
    localIp: '192.168.1.20', gateway: '192.168.1.1', subnetMask: '255.255.255.0',
    macAddress: '02:00:00:00:00:01', qrCodePrefix: 'https://example.com/demo/',
    inputVoltage: '220.5', inputCurrent: '16.2', localTime: '2026-11-04 12:00:00',
    cpVoltage: '12.000', cpDuty: '53', wifiMode: '0', workMode: '0', orderCount: '12',
    productKey: 'DEMO-PRODUCT', deviceName: 'DEMO-ASSET-001', deviceSecret: 'DEMO-NOT-A-REAL-SECRET',
    regCode: 'DEMO-REGISTRATION', portFunction: '0', slaveAddress: '1', temperature: '25',
    tempFactor1: '108.9', tempFactor2: '-13.3', offlineCardMode: '0', offlineCardSwitch: '1',
    backupPileNumber: 'DEMO-BACKUP-001', backupIp: '192.168.1.101', backupPort: '5002',
    controllerType: '1', controllerGunCount: '1', controllerGunType: '0', controllerNumber: 'CTRL-DEMO',
    controllerRatedPower: '7', controllerGunStatus: '2', outVoltage: '220', outCurrent: '16',
    outPower: '3.5', setPower: '7',
  };
  // These firmware maps overlap: keep independent banks so demo edits cannot corrupt
  // the other device's identity or measured values.
  const orderedPages = profile === 'controller' ? [pages[2]!] : [pages[1]!, pages[0]!];
  for (const page of orderedPages) {
    for (const definition of page.groups.flatMap((entry) => entry.fields)) {
      const value = examples[definition.key];
      if (value === undefined || definition.available === false) continue;
      const data = encodeField({ ...definition, writable: true }, value);
      data.forEach((word, offset) => { result[definition.address + offset] = word; });
    }
  }
  // Readback convention in the existing firmware/UI: zero means checked.
  result[265] = 0;
  result[481] = 1;
  return result;
}
