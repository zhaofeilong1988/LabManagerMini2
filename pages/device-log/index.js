// pages/device-log/index.js —— 使用记录与费用
// 进入页面：POST /api/deviceLogList，参数 { token, deviceId }
// 渲染：列表样式与「上机记录」页 (pages/instrument-logs) 完全一致
//   ① 仪器名称（型号） ② 使用人（所内/所外/院外）电话 ③ 上机时间段 ④ 金额算式 = 合计(实付) + 铅笔改单
const { deviceLogList } = require('../../utils/api.js')

// 从多个候选字段里取第一个非空值
function first() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

// 数字化：非法值按 0 处理
function toNumber(v) {
  if (v === undefined || v === null || v === '') return 0
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

// 格式化日期：统一输出 yyyy-MM-dd HH:mm:ss（含秒）；无法解析时回退原字符串
function pad2(s) { return String(s).length < 2 ? '0' + s : String(s) }
function fmtTime(s) {
  if (!s) return ''
  const m = String(s).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{1,2}))?/)
  if (!m) return String(s)
  return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) + ' ' + pad2(m[4]) + ':' + pad2(m[5]) + ':' + pad2(m[6] || '00')
}

// 金额：去掉非数字，按分→元处理（整数 / 浮点都兼容）
function toYuan(v) {
  if (v === undefined || v === null || v === '') return ''
  const s = String(v).replace(/[^\d.]/g, '')
  if (!s) return ''
  const n = parseFloat(s)
  if (isNaN(n)) return ''
  // 如果是大整数（如 12500），按"分"处理：÷100，保留两位小数（去掉末尾 0）
  // 否则按"元"处理
  const yuan = n > 10000 ? n / 100 : n
  return (Math.round(yuan * 100) / 100).toString()
}

// 使用人类型：兼容数字与文本，映射到「所内 / 所外 / 院外」
//   1 / 所内 / 院内    → 所内
//   2 / 所外 / 院外    → 所外
//   3 / 第三方 / 校外  → 院外
//   其它文本原样透传
function deptTypeOf(v) {
  if (v === undefined || v === null || v === '') return ''
  const n = Number(v)
  if (!isNaN(n)) {
    if (n === 1) return '所内'
    if (n === 2) return '所外'
    if (n === 3) return '院外'
  }
  const s = String(v).trim()
  if (/所内|院内|内部/i.test(s)) return '所内'
  if (/所外|院外|外部/i.test(s)) return '所外'
  return s
}

// 把接口原始记录条目转成视图数据（字段与 pages/instrument-logs 一致）
// 金额算式：单价元 × 数量 + 罚金 - 折扣 = 合计元(实付)
// 接口若只给总费用，则按「总额 × 1」展示，保证算式结构完整
function buildRow(it) {
  if (!it || typeof it !== 'object') return null
  const b = first(it.begin_at, it.beginAt, it.start_at, it.startTime, it.start, it.begin_time)
  const f = first(it.finish_at, it.finishAt, it.end_at, it.endTime, it.end, it.finish_time)

  const feeYuan = toNumber(toYuan(first(it.fee, it.cost, it.amount, it.price)))
  const penalty = toNumber(toYuan(first(it.penalty, it.fine)))
  const discount = toNumber(toYuan(first(it.discount)))
  let unit = toNumber(toYuan(first(it.unit, it.unit_price, it.unitPrice)))
  let qty = toNumber(first(it.qty, it.count, it.num))
  if (!unit) unit = feeYuan
  if (!qty) qty = 1
  const total = Math.round((unit * qty + penalty - discount) * 100) / 100

  return {
    id: String(first(it.id, it.logId, it.recordId, (b + '_' + f))),
    devName: first(it.device_name, it.deviceName, it.device) || '--',
    devModel: first(it.model, it.device_model, it.deviceModel),
    userName: first(it.userName, it.user_name, it.user, it.operator) || '--',
    deptText: deptTypeOf(first(it.dept_type, it.deptType, it.dept)) || '--',
    phone: first(it.phone, it.userPhone, it.mobile, it.tel),
    begin: fmtTime(b),
    finish: fmtTime(f),
    // 原始算账字段：修改页回填用
    unit,
    qty,
    penalty,
    discount,
    feeLeft: unit + '元 × ' + qty + ' + ' + penalty + '(罚金) - ' + discount + '(折扣)',
    feeRight: '= ' + total + '元(实付)'
  }
}

Page({
  data: {
    deviceId: '',
    loading: true,
    error: false,
    errMsg: '',
    logs: []
  },

  onLoad(options) {
    const deviceId = String((options && options.id) || '').trim()
    console.log('[device-log] onLoad 进入页面，options =', options, 'deviceId =', deviceId)
    this.setData({ deviceId })
    this._fetch()
  },

  // 显示层：每次页面展示都重新拉一次，保证从「我的」返回再进时数据最新
  onShow() {
    if (this._fetched) {
      console.log('[device-log] onShow 已加载过，重新刷新 /api/deviceLogList')
      this._fetch()
    }
    this._fetched = true
  },

  _fetch() {
    console.log('[device-log] _fetch 触发，准备调用 /api/deviceLogList，deviceId =', this.data.deviceId)
    this.setData({ loading: true, error: false })
    deviceLogList(this.data.deviceId ? { deviceId: this.data.deviceId } : {})
      .then(arr => {
        console.log('[device-log] /api/deviceLogList 返回，记录数 =', (arr || []).length)
        this._render(arr || [])
      })
      .catch(err => {
        console.error('[device-log] /api/deviceLogList 失败：', err)
        this.setData({
          loading: false,
          error: true,
          errMsg: (err && err.message) || '使用记录加载失败，请稍后重试'
        })
      })
  },

  _render(arr) {
    const rows = arr.map(buildRow).filter(Boolean)
    this.setData({
      loading: false,
      error: false,
      logs: rows
    })
  },

  // 失败重试
  onRetry() {
    this._fetch()
  },

  // 铅笔按钮 → 修改使用记录页（与「上机记录」页同一个修改页）
  onEditFee(e) {
    const id = e.currentTarget.dataset.id
    const it = this.data.logs.find(x => x.id === id)
    if (!it) return
    wx.navigateTo({
      url: '/pages/instrument-log-edit/index?id=' + encodeURIComponent(id) +
        '&user=' + encodeURIComponent(it.userName) +
        '&begin=' + encodeURIComponent(it.begin) +
        '&finish=' + encodeURIComponent(it.finish) +
        '&unit=' + it.unit + '&qty=' + it.qty +
        '&penalty=' + it.penalty + '&discount=' + it.discount
    })
  },

  // 修改页保存后回写本条记录（由 instrument-log-edit 调用）
  updateRecord(p) {
    if (!p || !p.id) return
    const logs = this.data.logs.map(x => x.id === p.id
      ? Object.assign({}, x, { userName: p.userName, feeLeft: p.feeLeft, feeRight: p.feeRight })
      : x)
    this.setData({ logs })
  }
})
