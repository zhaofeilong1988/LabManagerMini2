// pages/scan-detail/index.js —— 仪器扫码详情页
// 首页「仪器扫码」扫码得到 deviceId → 调后端 /api/getDeviceDetail → 本页展示
//
// 展示字段（需求口径，顺序固定）：
//   仪器名称 / 管理员 / 手机号 / 设备预约 / 最近预约时间 / 控制方式 / 设备编号 / 当前状态 / 开机时间
//
// 字段取值优先级：接口返回值 → 本地演示数据（instruments / bookings / device）兜底
//   · 仪器名称：接口返回值 data.device.name（页面联调打印的原始展开路径为 data.data.device.name）
//   · 管理员 = admin_name，手机号 = admin_phone（响应体 data 下，兼容 device 对象内写法）
//   · 具体接口路径可在 P 常量中按实际返回结构调整
const { getDeviceDetail, deviceOperate, logUpload, SCAN_DETAIL_KEY } = require('../../utils/api.js')
const { findInstrumentByNo } = require('../../utils/instruments.js')
const { listBookings } = require('../../utils/bookings.js')
const { queryDevice } = require('../../utils/device.js')
const { getOpenId } = require('../../utils/auth.js')
// 「物联蓝牙授权控制器」的厂商协议实现（移植自参考项目 LabManagerMini / utils/BLEDevice.js）：
// 开适配器 → 搜索 → 广播名 ECOB + 广播数据 SN 两级匹配 → 建连 → 取服务/特征 →
// 订阅通知 → 两次握手 → 下发开关机指令 → completeCallback 回传 { success, operation }
const BLEDevice = require('../../utils/BLEDevice.js')

// 读取嵌套路径：兼容「原始联调路径 data.data.device.name」与「响应体相对路径 data.device.name」两种写法
function pick(obj, path) {
  let segs = String(path || '').split('.').filter(Boolean)
  if (segs.length > 1 && segs[0] === 'data' && segs[1] === 'data') segs = segs.slice(1)
  let cur = obj
  for (let i = 0; i < segs.length; i++) {
    if (cur == null) return undefined
    cur = cur[segs[i]]
  }
  return cur
}

// 按候选路径依次取值，命中第一个非空值即返回
function firstOf(obj, paths) {
  for (let i = 0; i < paths.length; i++) {
    const v = pick(obj, paths[i])
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

// 空值格式化
function fmt(x) {
  if (x === undefined || x === null || x === '') return '--'
  return String(x)
}

// 控制方式：control_type 数字枚举 → 中文文案
//   1 = 蓝牙电源，2 = 二维码，3 = 蓝牙锁
//   兼容数字 / 数字字符串；非数字文本（后端直接给中文）原样透传；空值返回 ''
const CONTROL_TYPE = { 1: '蓝牙电源', 2: '二维码', 3: '蓝牙锁' }
// 走蓝牙协议控制的设备类型（参考项目 components/scan/scan.js 开机分支：
// control_type 为 1 或 3 时都由 BLEDevice.BLEOperation 真实控制设备）
const BLUETOOTH_CONTROL_TYPES = [1, 3]
function controlTextOf(v) {
  if (v === undefined || v === null || v === '') return ''
  const n = Number(v)
  if (!isNaN(n) && CONTROL_TYPE[n]) return CONTROL_TYPE[n]
  return String(v)
}

// 设备预约：need_appointment 数字枚举 → 中文文案
//   1 = 需要预约，0 = 无需预约
//   兼容数字 / 数字字符串（'1' / '0'）；布尔值直接判断；非数字文本原样透传；空值返回 undefined
function needBookTextOf(v) {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (!isNaN(n)) return n === 1 ? '需要预约' : '无需预约'
  if (typeof v === 'boolean') return v ? '需要预约' : '无需预约'
  return String(v)
}

// 设备状态：power_state 数字枚举 → 是否开机
//   1 = 已开机，0 = 已关机
//   兼容数字 / 数字字符串（'1' / '0'，避免字符串 '0' 被 truthy 误判为开机）；布尔值直接判断；空值返回 undefined
function powerStateOf(v) {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (!isNaN(n)) return n === 1
  if (typeof v === 'boolean') return v
  return !!v
}

// 该设备最近一次预约（未取消）的时段文案（本地演示数据）
function latestBookingText(instId) {
  if (instId == null) return ''
  const hit = listBookings()
    .filter(b => b.instId === instId && b.status !== 'cancelled')
    .sort((a, b) =>
      (b.dateLabel + ' ' + (b.startText || '')).localeCompare(a.dateLabel + ' ' + (a.startText || ''))
    )[0]
  if (!hit) return ''
  return hit.rangeText || (hit.dateLabel + ' ' + hit.startText + ' - ' + hit.endText)
}

// 预约记录时段文案：apply.begin_at ~ apply.finish_at
//   为避免一行放不下换行，做压缩显示：
//     · 去掉秒（09:00:00 → 09:00）
//     · 同年 → 省去年份（10-13 09:00 ~ 10-14 18:00）
//     · 同月同日 → 再省去重复日期（10-13 09:00 ~ 11:00）
//   兼容 beginAt / finishAt 驼峰写法；只有一头时单独返回；都缺失返回 ''
function pad2s(s) {
  return String(s).length < 2 ? '0' + s : String(s)
}

// 当前时间文案：'YYYY-MM-DD HH:mm'
// 用途：开关机接口未返回 powerOnTime 时，用本地当前时间作为「开机时间」，
// 与页面其它时间显示保持同一格式（不带秒）
function nowText() {
  const d = new Date()
  return d.getFullYear() + '-' + pad2s(d.getMonth() + 1) + '-' + pad2s(d.getDate()) +
    ' ' + pad2s(d.getHours()) + ':' + pad2s(d.getMinutes())
}

// 解析常见时间串：'2026-10-13 09:00:00' / '2026-10-13T09:00' → { y, md, hm }
function parseDT(s) {
  const m = String(s || '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s]+(\d{1,2}):(\d{2})/)
  if (!m) return null
  return { y: m[1], md: pad2s(m[2]) + '-' + pad2s(m[3]), hm: pad2s(m[4]) + ':' + m[5] }
}

function applyRangeOf(apply) {
  if (!apply || typeof apply !== 'object') return ''
  const b = apply.begin_at || apply.beginAt || ''
  const f = apply.finish_at || apply.finishAt || apply.end_at || ''
  if (!b && !f) return ''
  if (!b || !f) return b || f
  const pb = parseDT(b)
  const pf = parseDT(f)
  if (!pb || !pf) return b + ' ~ ' + f // 非常规格式：原样拼接
  if (pb.y === pf.y && pb.md === pf.md) return pb.md + ' ' + pb.hm + ' ~ ' + pf.hm
  if (pb.y === pf.y) return pb.md + ' ' + pb.hm + ' ~ ' + pf.md + ' ' + pf.hm
  return b + ' ~ ' + f // 跨年：保留完整时间，避免歧义
}

// 各字段在接口返回体中的候选路径（按序尝试；取不到才走本地演示数据兜底）
// 管理员 = data.admin_name（设备对象内 device.admin_name），手机号 = data.admin_phone
const P = {
  name: ['data.device.name', 'device.name'],
  manager: ['data.admin_name', 'data.device.admin_name', 'device.admin_name'],
  phone: ['data.admin_phone', 'data.device.admin_phone', 'device.admin_phone'],
  needBook: [
    'data.device.need_appointment', 'data.device.needAppointment', 'data.device.needBook', 'data.device.needReserve',
    'device.need_appointment', 'device.needAppointment', 'device.needBook',
    'data.need_appointment', 'data.needAppointment', 'data.needBook'
  ],
  control: [
    'data.device.control_type', 'data.device.controlType', 'data.device.control', 'data.device.controlWay',
    'device.control_type', 'device.controlType', 'device.control',
    'data.control_type', 'data.controlType', 'data.control'
  ],
  // apply 有值即存在预约记录，最近预约时间取 apply.begin_at ~ apply.finish_at
  // （参考项目 Components/scan/scan.js：apply = response.data.data.apply）
  apply: ['data.apply', 'apply', 'data.nextApply', 'nextApply', 'data.device.apply', 'device.apply'],
  // 预约记录 id 的候选字段名（在 apply 对象内），按序取第一个非空值
  applyId: ['id', 'apply_id', 'applyId', 'applyID', 'booking_id', 'bookingId', 'reservation_id'],
  lastBook: ['data.device.lastBookTime', 'data.device.recentBookText', 'data.device.lastBookingTime'],
  deviceNo: ['data.device.deviceNo', 'data.device.no', 'data.device.sn', 'data.device.assetNo'],
  poweredOn: [
    // power_state 优先：后端约定的状态枚举，0=已关机 / 1=已开机
    'data.device.power_state', 'data.device.powerState', 'data.device.state',
    // 兼容旧字段：布尔型 poweredOn / isPoweredOn
    'data.device.poweredOn', 'data.device.isPoweredOn'
  ],
  powerOnTime: ['data.device.powerOnTime', 'data.device.openTime']
}

// 字段展示清单（label 顺序即页面行顺序）
const FIELD_DEFS = [
  { key: 'name', label: '仪器名称', strong: true },
  { key: 'manager', label: '管理员' },
  { key: 'phone', label: '手机号', callable: true },
  { key: 'needBookText', label: '设备预约' },
  { key: 'lastBookText', label: '最近预约时间' },
  { key: 'controlText', label: '控制方式' },
  { key: 'deviceNo', label: '设备编号', mono: true },
  { key: 'stateText', label: '当前状态', state: true },
  { key: 'powerOnText', label: '开机时间' }
]

Page({
  data: {
    deviceId: '',
    loading: true,
    error: false,
    errMsg: '',
    heroIcon: '🔬',
    heroName: '',
    rows: [],
    // 控制方式是否为蓝牙电源（control_type = 1），决定开关机走蓝牙控制还是直接调后端
    controlIsBt: false,
    // 开关机：按钮文案随当前状态切换
    poweredOn: false,
    powerBtnText: '开机',
    powerBusy: false,
    // 设备类型数字：1 = 蓝牙电源，2 = 二维码，3 = 蓝牙锁（蓝牙锁关机不走蓝牙）
    controlType: null,
    // 蓝牙操作进度提示（搜索设备 / 握手 / 下发指令等阶段性文案）
    bleMsg: ''
  },

  onLoad(options) {
    // 进入页面即收起首页扫码时的全局 loading，避免残留遮罩
    wx.hideLoading()
    // 扫码内容即设备 SN（参考项目同规则：二维码内容 = SN = 接口 deviceId 参数）
    const deviceId = decodeURIComponent(String((options && options.deviceId) || '')).trim()
    this.setData({ deviceId })
    // 优先读取首页扫码后写入的缓存数据，避免重复请求（缓存 60s 内有效）
    let cached = null
    try { cached = wx.getStorageSync(SCAN_DETAIL_KEY) } catch (e) { /* 忽略缓存异常 */ }
    if (cached && cached.deviceId === deviceId && cached.data &&
      Date.now() - (cached.ts || 0) < 60 * 1000) {
      this._render(cached.data)
      return
    }
    this._fetch()
  },

  // 发起查询
  _fetch() {
    this._powerOverride = null
    if (!this.data.deviceId) {
      this.setData({ loading: false, error: true, errMsg: '缺少设备编号，请返回重新扫码' })
      return
    }
    this.setData({ loading: true, error: false })
    getDeviceDetail(this.data.deviceId)
      .then(data => this._render(data))
      .catch(err => {
        console.error('[scan-detail] 查询失败：', err)
        this.setData({
          loading: false,
          error: true,
          errMsg: (err && err.message) || '查询失败，请确认后端服务已启动'
        })
      })
  },

  // 按 9 个业务字段组装视图数据
  // body：/api/getDeviceDetail 的响应体（console 已打印原生展开路径便于联调）
  _buildRows(body) {
    body = body || {}
    const deviceId = this.data.deviceId
    const local = findInstrumentByNo(deviceId) // 本地演示数据（接口缺失字段用它兜底）
    const state = this._state || { poweredOn: false, powerOnTime: '' } // 设备状态（模拟接口）

    const ivPower = firstOf(body, P.poweredOn)
    const ivTime = firstOf(body, P.powerOnTime)
    // 页面内手动开关机后以本地状态为准，避免接口返回值覆盖最新状态
    const poweredOn = this._powerOverride != null
      ? !!this._powerOverride
      : (ivPower !== undefined ? powerStateOf(ivPower) : (ivTime ? true : !!state.poweredOn))
    const powerOnTime = fmt(ivTime || state.powerOnTime)

    const ivNeed = firstOf(body, P.needBook)
    let needBookText = '--'
    if (ivNeed !== undefined) needBookText = needBookTextOf(ivNeed)
    else if (local) needBookText = local.needBook ? '需要预约' : '无需预约'

    const name = fmt(firstOf(body, P.name) || (local && local.name))
    // 最近预约时间：接口 apply 有值（存在预约记录）→ begin_at ~ finish_at；
    //   否则按旧逻辑走 device.lastBookTime 等字段，再兜底本地演示数据
    const ivApply = firstOf(body, P.apply)
    let lastBookText
    if (ivApply !== undefined) {
      lastBookText = fmt(applyRangeOf(ivApply))
    } else if (firstOf(body, P.lastBook)) {
      lastBookText = fmt(firstOf(body, P.lastBook))
    } else {
      lastBookText = latestBookingText(local && local.id) || '暂无预约记录'
    }

    const ivControl = firstOf(body, P.control)
    const controlRaw = ivControl !== undefined ? ivControl : (local && local.control)
    // 设备类型数字：1 = 蓝牙电源，2 = 二维码，3 = 蓝牙锁（用于区分蓝牙控制 + 开机/关机策略）
    const controlTypeNum = Number(controlRaw)
    // 是否走蓝牙协议控制：control_type 为 1（蓝牙电源）或 3（蓝牙锁），
    // 或后端直接返回含「蓝牙」的文案（如「蓝牙电源」）
    const controlIsBt = BLUETOOTH_CONTROL_TYPES.indexOf(controlTypeNum) >= 0 ||
      (isNaN(controlTypeNum) && /蓝牙/.test(String(controlRaw || '')))

    const view = {
      name,
      manager: fmt(firstOf(body, P.manager) || (local && local.manager)),
      phone: fmt(firstOf(body, P.phone) || (local && local.contactPhone)),
      needBookText,
      lastBookText,
      controlText: fmt(controlTextOf(controlRaw)),
      deviceNo: fmt(firstOf(body, P.deviceNo) || deviceId),
      stateText: poweredOn ? '已开机' : '未开机',
      powerOnText: poweredOn ? powerOnTime : '--'
    }

    const rows = FIELD_DEFS.map(def => {
      const v = view[def.key]
      const row = { label: def.label, v, cls: '' }
      if (def.strong) row.cls = 'sd2-v--strong'
      if (def.mono) row.cls = 'sd2-v--mono'
      if (def.state) row.cls = v === '已开机' ? 'sd2-v--ok' : 'sd2-v--off'
      if (def.callable && v && v !== '--') {
        row.callable = true
        row.phone = String(v).replace(/[- ]/g, '')
      }
      return row
    })

    return {
      rows,
      heroName: name,
      heroIcon: (local && local.icon) || '🔬',
      poweredOn,
      controlIsBt,
      // 蓝牙锁（3）内部再用：关机为虚拟控制，不需要连蓝牙
      controlType: isNaN(controlTypeNum) ? null : controlTypeNum
    }
  },

  // 展示返回数据（同时 console.log 打印便于联调）
  _render(body) {
    console.log('[scan-detail] getDeviceDetail 返回：', body)
    this._body = body
    // 用户 id：/api/logUpload 上报用（userId 与 module 尾部拼接同一值）；
    // 接口响应里的 data.user.user_id 优先，取不到兜底本地登录态 openid
    const uid = firstOf(body, ['data.user.user_id', 'user.user_id', 'data.user.userId', 'user.userId'])
    this._userId = uid != null && uid !== '' ? String(uid) : getOpenId()
    // 预约记录 id：/api/deviceOperate 的 applyId 字段（后端校验「已预约」）+ /api/logUpload 的 message
    // （同参考项目 logger.info("deviceOperate " + user_id, opName, applyId) 的第三参）；
    // 取不到时为 null —— 后端按约定接收 null，不能省略字段
    const apply = firstOf(body, P.apply)
    const applyIdRaw = apply && typeof apply === 'object'
      ? firstOf(apply, P.applyId)
      : undefined
    this._applyId = applyIdRaw != null && applyIdRaw !== '' ? applyIdRaw : null
    // 诊断日志：确认响应里 apply 的实际结构与 id 字段名
    console.log('[scan-detail] apply 原始值：', apply,
      '| 候选取值：', apply && typeof apply === 'object' ? P.applyId.map(k => k + '=' + apply[k]) : '(非对象)',
      '| applyId =', this._applyId)
    const built = this._buildRows(body)
    this.setData(Object.assign({
      loading: false,
      error: false,
      powerBtnText: built.poweredOn ? '关机' : '开机'
    }, built))
    // 当前状态 / 开机时间：实时查询设备状态（接口无状态字段时兜底刷新）
    queryDevice(this.data.deviceId).then(st => {
      this._state = { poweredOn: !!st.poweredOn, powerOnTime: st.powerOnTime || '' }
      this._repaint()
    })
  },

  // 用当前设备数据 + 本地状态重绘字段与按钮
  _repaint() {
    if (!this._body) return
    const built = this._buildRows(this._body)
    this.setData({
      rows: built.rows,
      poweredOn: built.poweredOn,
      powerBtnText: built.poweredOn ? '关机' : '开机',
      controlIsBt: built.controlIsBt,
      controlType: built.controlType
    })
  },

  // 开机 / 关机：按钮文案由当前状态决定（已开机 → 关机；未开机 → 开机）
  onTogglePower() {
    if (this.data.powerBusy) return
    const turnOn = !this.data.poweredOn
    // 蓝牙控制类设备（蓝牙电源 / 蓝牙锁）：走厂商协议真实控制设备
    // （搜索 → 两级匹配 → 建连 → 握手 → 下发指令），
    // completeCallback 收到 { success: true, operation } 才向服务端上报
    if (this.data.controlIsBt) {
      // 蓝牙锁关机为「虚拟控制」：不需要连蓝牙，直接上报服务端
      // （参考项目 components/scan/scan.js 关机分支：control_type = 3 直接 deviceOperate(0)）
      if (!turnOn && this.data.controlType === 3) {
        this._doTogglePower(0)
        return
      }
      this._bleOperate(turnOn ? 1 : 0)
      return
    }
    this._doTogglePower(turnOn ? 1 : 0)
  },

  // ── 蓝牙控制（移植自参考项目 LabManagerMini components/scan/scan.js 的调用方式）──
  // operation：1 = 开机，0 = 关机
  // 流程：搜索 → 匹配 → 建连 → 第一次握手 →【暂停：调 /api/deviceOperate 上报】
  //       → 上报成功 → 第二次握手 → 下发开关机指令
  // progressCallback：阶段性进度文案（显示到按钮下方 + 控制台）
  // completeCallback：{ success, operation, msg }
  _bleOperate(operation) {
    const that = this
    const turnOn = operation === 1
    this.setData({ powerBusy: true, bleMsg: '正在初始化蓝牙…' })

    // 看门狗：系统蓝牙无响应等极端情况下回调可能丢失，
    // 兜底复位按钮状态，避免页面永久卡在「加载中」
    this._clearBleWatchdog()
    this._bleWatchdog = setTimeout(() => {
      that._bleWatchdog = null
      that.setData({ powerBusy: false, bleMsg: '' })
      wx.showToast({ title: '蓝牙操作超时，请重试', icon: 'none' })
      try { BLEDevice.cleanup() } catch (e) { /* 忽略清理异常 */ }
    }, 20000)

    // 第一次握手成功后的暂停点：先向服务端上报，接口成功后再继续第二次握手
    // （BLEDevice 内部会停掉步骤超时，等这里的回包；abort 时清理连接并回调失败）
    const afterFirstHandshake = (h) => {
      that.setData({ bleMsg: '第一次握手成功，正在同步服务器…' })
      that._doTogglePower(operation, {
        onSuccess: () => {
          that.setData({ bleMsg: '服务器已响应，继续第二次握手…' })
          h.proceed()
        },
        onFail: (msg) => {
          that.setData({ bleMsg: '' })
          h.abort(msg || '服务器同步失败')
        }
      })
    }

    const progressCallback = (msg) => {
      console.log('[scan-detail][BLE]', msg)
      that.setData({ bleMsg: msg || '' })
    }

    const completeCallback = (result) => {
      console.log('[scan-detail][BLE] 完成：', result)
      that._clearBleWatchdog()
      that.setData({ powerBusy: false, bleMsg: '' })
      if (result && result.success && Number(result.operation) === operation) {
        // 第二次握手 + 指令下发成功：设备已真实开/关机（服务端已在第一次握手后上报）
        wx.showToast({ title: turnOn ? '已开机' : '已关机', icon: 'none' })
        return
      }
      // 失败：toast 提示原因（BLEDevice 内部已清理连接）
      wx.showToast({ title: (result && result.msg) || '设备操作失败，请重试', icon: 'none' })
    }

    // SN = 扫码内容（deviceId），BLEDevice 用它做两级匹配的第二级精确比对
    BLEDevice.sn = this.data.deviceId
    BLEDevice.BLEOperation(operation, progressCallback, completeCallback, {
      afterFirstHandshake: afterFirstHandshake
    })
  },

  // 实际执行开关机上报（非蓝牙设备直接调用 / 蓝牙流程第一次握手成功后调用）
  // 调用后端 /api/deviceOperate，POST 提交 { deviceId, operate, token, applyId }
  //   operate: 1=开机，0=关机
  //   token  由 api 层 deviceOperate 内部注入
  // next 可选：{ onSuccess, onFail(msg) } —— 传入后由调用方接管后续流程与提示
  //   （蓝牙流程：上报成功后继续第二次握手），此时本方法不弹 loading、不 toast、不复位 busy
  _doTogglePower(operate, next) {
    const turnOn = operate != null ? operate === 1 : !this.data.poweredOn
    const chained = !!(next && (next.onSuccess || next.onFail))
    this.setData({ powerBusy: true })
    if (!chained) wx.showLoading({ title: turnOn ? '正在开机…' : '正在关机…', mask: true })
    deviceOperate({
      deviceId: this.data.deviceId,
      operate: turnOn ? 1 : 0,
      // 预约记录 id：后端据此校验「已预约」，缺失会返回「这台设备需要预约后才能使用」；
      // 关机时后端不校验预约场景，按参考项目传 null
      applyId: turnOn ? (this._applyId != null ? this._applyId : null) : null
    }).then(
      st => {
        if (!chained) wx.hideLoading()
        // /api/deviceOperate 成功后上报操作日志：POST /api/logUpload
        // 提交体 { appId: '仪器预约', userId, logs: [{ level: 'info',
        //   module: 'deviceOperate {userId}', action: '上报服务器：开机/关机',
        //   message: applyId, data: {}, timestamp }] }。上报失败不影响主流程
        const uid = this._userId || ''
        logUpload({
          userId: uid,
          level: 'info',
          module: 'deviceOperate ' + uid,
          action: turnOn ? '上报服务器：开机' : '上报服务器：关机',
          message: this._applyId,
          data: {}
        }).catch(err => {
          console.warn('[scan-detail] /api/logUpload 上报失败：', err && (err.message || err))
        })
        // 响应里若带 poweredOn / powerOnTime 则采纳；否则按本次操作推断状态
        const powered = st && (st.poweredOn != null ? !!st.poweredOn : turnOn)
        // 开机时间：后端返回则采纳；已开机但后端没给时，用操作成功的当前时间兜底
        // （关机后为空，页面显示 '--'）
        let time = st && st.powerOnTime ? st.powerOnTime : ''
        if (powered && !time) time = nowText()
        this._state = { poweredOn: powered, powerOnTime: time }
        this._powerOverride = powered
        this._repaint()
        if (chained) {
          // 蓝牙流程：上报成功，交回调用方继续第二次握手（busy 保持 true）
          next.onSuccess && next.onSuccess()
          return
        }
        this.setData({ powerBusy: false, bleMsg: '' })
        wx.showToast({ title: turnOn ? '已开机' : '已关机', icon: 'none' })
      },
      err => {
        if (!chained) wx.hideLoading()
        const msg = (err && err.message) || (turnOn ? '开机失败' : '关机失败')
        // 失败补一条 error 级别日志（message = 错误信息），便于服务端留痕排查
        const uid = this._userId || ''
        logUpload({
          userId: uid,
          level: 'error',
          module: 'deviceOperate ' + uid,
          action: turnOn ? '上报服务器：开机' : '上报服务器：关机',
          message: msg,
          data: {}
        }).catch(() => { /* 日志上报失败不影响错误提示 */ })
        if (chained) {
          // 蓝牙流程：上报失败 → 由调用方终止握手并提示（服务端未记录，设备保持原状态）
          next.onFail && next.onFail(msg)
          return
        }
        this.setData({ powerBusy: false, bleMsg: '' })
        wx.showToast({ title: msg, icon: 'none' })
      }
    )
  },

  // 失败重试
  onRetry() {
    this._fetch()
  },

  // 清除蓝牙看门狗定时器
  _clearBleWatchdog() {
    if (this._bleWatchdog) {
      clearTimeout(this._bleWatchdog)
      this._bleWatchdog = null
    }
  },

  // 页面卸载：清理蓝牙连接与监听（BLEDevice.cleanup 内部会断连、停扫描、清回调）
  onUnload() {
    this._clearBleWatchdog()
    try { BLEDevice.cleanup() } catch (e) { /* 忽略清理异常 */ }
  },

  // 点击手机号 → 呼出电话
  onCallPhone(e) {
    const phone = String(e.currentTarget.dataset.phone || '').trim()
    if (!phone) return
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => { /* 用户取消或环境不支持时静默 */ }
    })
  },

  goBack() {
    wx.navigateBack()
  }
})
