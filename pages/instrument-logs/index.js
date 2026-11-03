// pages/instrument-logs/index.js —— 使用记录 / 上机记录（统一入口）
// 两个入口共用，都走 POST /api/deviceLogList（token 由接口内部注入）：
//   ① 仪器详情页「上机记录」→ 带 deviceId，查这台仪器的记录
//   ② 我的 →「使用记录与费用」→ 不带 deviceId，只传 token，查当前用户自己的记录
// 卡片样式与「我的预约」(pages/my-booking) 保持一致：仪器图标 + 名称 + 信息行 + 费用区
const { deviceLogList, getApplyUserDetailShared, ADMISSION_USER_DETAIL_KEY } = require('../../utils/api.js')
const { getLoginUser, getOpenId, USER_KEY } = require('../../utils/auth.js')

// 使用人类型 → 标签配色
const DEPT_STYLE = {
  所内: 'il-tag-in',
  所外: 'il-tag-out',
  院外: 'il-tag-ext'
}

// 时长：按分钟取整，输出「x小时y分钟」
function durText(b, f) {
  const bt = new Date(String(b).replace(/-/g, '/')).getTime()
  const ft = new Date(String(f).replace(/-/g, '/')).getTime()
  if (isNaN(bt) || isNaN(ft) || ft <= bt) return ''
  const mins = Math.round((ft - bt) / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (!mins) return '不足1分钟'
  return (h ? h + '小时' : '') + (m ? m + '分钟' : '')
}

// ── /api/deviceLogList 返回值的取值工具 ──
function pickPath(obj, path) {
  if (!obj || typeof obj !== 'object') return ''
  const segs = String(path || '').split('.').filter(Boolean)
  let cur = obj
  for (let i = 0; i < segs.length; i++) {
    if (cur == null || typeof cur !== 'object') return ''
    cur = cur[segs[i]]
  }
  return String(cur == null ? '' : cur).trim()
}

// 多路径依次尝试，取第一个非空值（兼容驼峰 / 下划线）
function pickStr(obj, paths) {
  for (let i = 0; i < paths.length; i++) {
    const v = pickPath(obj, paths[i])
    if (v) return v
  }
  return ''
}

function numOf(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, ''))
  return isNaN(n) ? 0 : n
}

// 从用户对象里取 user_id（兼容 userId / id）
function pickUserId(o) {
  if (!o || typeof o !== 'object') return ''
  const v = (o.user_id !== undefined && o.user_id !== null)
    ? o.user_id
    : (o.userId !== undefined && o.userId !== null ? o.userId : o.id)
  return (v === undefined || v === null) ? '' : String(v).trim()
}

// 本地已有的登录人 user_id：
//   ① 登录态 storage（utils/auth.js，登录时写入）
//   ② 准入用户详情缓存里的 user / applyUser
function localUserId() {
  const v = pickUserId(getLoginUser() || {})
  if (v) return v
  try {
    const c = wx.getStorageSync(ADMISSION_USER_DETAIL_KEY)
    if (c && typeof c === 'object') return pickUserId(c.user) || pickUserId(c.applyUser)
  } catch (e) { /* 忽略缓存异常 */ }
  return ''
}

// 登录人 user_id：本地没有（旧登录缓存）时用 /system/apply_user/detail 补一次，
// 取到后回写登录态，下次直接命中；拿不到（如体验模式无 openId）返回空串
function ensureUserId() {
  const cached = localUserId()
  if (cached) return Promise.resolve(cached)
  const openId = getOpenId()
  if (!openId) {
    console.warn('[instrument-logs] 无 openId，无法获取登录人 user_id')
    return Promise.resolve('')
  }
  return getApplyUserDetailShared(openId)
    .then(detail => {
      const v = pickUserId(detail && detail.user) || pickUserId(detail && detail.applyUser)
      if (v) {
        try {
          wx.setStorageSync(USER_KEY, Object.assign({}, getLoginUser() || {}, { userId: v }))
        } catch (e) { /* 忽略写入异常 */ }
      }
      return v
    })
    .catch(err => {
      console.warn('[instrument-logs] 登录人 user_id 获取失败：', err)
      return ''
    })
}

// 是否可改单：记录的 managerId 里包含登录人的 user_id
// managerId 可能是单个 id，也可能是逗号分隔的多个 id（参考 LabManagerMini 里 device.managerId 的写法）
function canEdit(row, uid, fallbackMgrId) {
  if (!uid) return false
  const raw = row.managerId || fallbackMgrId
  if (!raw) return false
  return String(raw).split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .indexOf(uid) >= 0
}

// 仪器图标：按名称关键字给一个贴切的 emoji
function iconOf(name) {
  const s = String(name || '')
  if (/离心/.test(s)) return '⚙️'
  if (/活体|成像/.test(s)) return '🧫'
  if (/共聚焦|显微镜/.test(s)) return '🔭'
  if (/流式/.test(s)) return '🧪'
  if (/核酸|PCR|测序/.test(s)) return '🧬'
  return '🔬'
}

// /api/deviceLogList 返回的一条记录 → 卡片字段
// 字段对照 LabManagerMini/pages/usingLog 的同接口用法：
//   device_name 仪器 / user_name 使用人 / dept_type 类型 / phonenumber 电话
//   begin_at / finish_at（空 = 未下机）/ price 单价 / count 数量
//   price_up 罚金 / price_down 折扣 / amount 实付
function fromApi(x) {
  const o = (x && typeof x === 'object') ? x : {}
  const pick = function () {
    for (let i = 0; i < arguments.length; i++) {
      const v = pickPath(o, arguments[i])
      if (v) return v
    }
    return ''
  }
  const device = pick('device_name', 'deviceName', 'device.name', 'name')
  return {
    id: pick('id', 'logId', 'log_id'),
    // 该条记录的管理员 id（可能是单个 id，也可能是逗号分隔的多个 id）
    managerId: pick('managerId', 'manager_id'),
    // 使用人 id：改单提交 /api/editDeviceLogDetail 的 userId 用
    userId: pick('user_id', 'userId', 'user.user_id', 'user.userId'),
    icon: iconOf(device),
    device,
    devModel: pick('model', 'device.model', 'deviceModel'),
    user: pick('user_name', 'userName', 'user.user_name', 'nickName'),
    dept: pick('dept_type', 'deptType', 'dept_name', 'dept'),
    phone: pick('phonenumber', 'phone', 'user.phonenumber', 'mobile'),
    begin: pick('begin_at', 'beginAt'),
    finish: pick('finish_at', 'finishAt'),
    unit: numOf(pick('price', 'unitPrice')),
    qty: numOf(pick('count', 'unitCount')) || 1,
    penalty: numOf(pick('price_up', 'priceUp')),
    discount: numOf(pick('price_down', 'priceDown'))
  }
}

Page({
  data: {
    list: [],
    loading: false,
    emptyText: ''
  },

  _seq: 0,
  _name: '',
  _model: '',
  _deviceId: '',

  onLoad(options) {
    // 从仪器详情页进入时带 name / model / deviceId：整页按这台仪器展示
    // 从「我的 → 使用记录与费用」进入时不带 deviceId：每条显示各自的仪器
    this._name = decodeURIComponent((options && options.name) || '')
    this._model = decodeURIComponent((options && options.model) || '')
    this._deviceId = decodeURIComponent((options && options.deviceId) || '')
    // 两个入口都走 /api/deviceLogList：
    //   有 deviceId → 带 deviceId（查这台仪器的记录）
    //   无 deviceId → 只传 token（查当前用户自己的记录）
    this._load()
  },

  reload() {
    this._load()
  },

  _load() {
    const seq = ++this._seq
    this.setData({ loading: true, emptyText: '正在加载使用记录…' })
    const payload = this._deviceId ? { deviceId: this._deviceId } : {}
    // 记录列表与登录人 id 并行获取：改单权限 = 记录的 managerId 与登录人 user_id 一致
    Promise.all([deviceLogList(payload), ensureUserId()])
      .then(res => {
        if (seq !== this._seq) return
        const rows = res[0] || []
        const uid = res[1] || ''
        const topMgrId = (rows.managerId !== undefined && rows.managerId !== null)
          ? String(rows.managerId) : ''
        const first = rows[0]
        console.log('[instrument-logs] 改单判定：登录人 user_id =', uid || '(空)',
          '| 首条记录 managerId =',
          first ? (pickPath(first, 'managerId') || pickPath(first, 'manager_id') || '(空)') : '(无记录)')
        const list = rows.map((x, i) => {
          const r = fromApi(x)
          return this._row(r, this._name, this._model, i, canEdit(r, uid, topMgrId))
        })
        this.setData({
          list,
          loading: false,
          emptyText: list.length ? '' : (this._deviceId ? '该仪器暂无使用记录' : '暂无使用记录')
        })
      })
      .catch(err => {
        if (seq !== this._seq) return
        console.warn('[instrument-logs] /api/deviceLogList 失败：', err)
        this.setData({ list: [], loading: false, emptyText: '加载失败，请稍后重试' })
      })
  },

  // 单条记录 → 视图数据
  _row(x, name, model, idx, editable) {
    const total = Math.round((x.unit * x.qty + x.penalty - x.discount) * 100) / 100
    const dur = durText(x.begin, x.finish)
    return {
      id: x.id || ('log' + (idx == null ? 0 : idx)),
      // 改单按钮：只有当前登录人是这条记录的管理员时才展示
      canEdit: !!editable,
      // 使用人 id：跳转修改页时带给它，改单提交要用
      userId: x.userId || '',
      icon: x.icon,
      devName: name || x.device || '--',
      // 头部副标题：有指定仪器时显示型号，否则显示各自型号
      devSub: name ? model : (x.devModel || ''),
      deptText: x.dept,
      deptCls: DEPT_STYLE[x.dept] || 'il-tag-ext',
      userName: x.user,
      phone: x.phone,
      begin: x.begin,
      finish: x.finish,
      // 没有下机时间 → 仍在使用中，显示「未下机」
      finishText: x.finish ? (dur ? x.finish + '（' + dur + '）' : x.finish) : '未下机',
      // 原始算账字段：修改页回填用
      unit: x.unit,
      qty: x.qty,
      penalty: x.penalty,
      discount: x.discount,
      feeLeft: x.unit + '元 × ' + x.qty + ' + ' + x.penalty + '(罚金) - ' + x.discount + '(折扣)',
      feeRight: '= ' + total + '元(实付)',
      total,
      totalText: total + ' 元'
    }
  },

  // 铅笔按钮 → 修改使用记录页
  onEditFee(e) {
    const id = e.currentTarget.dataset.id
    const it = this.data.list.find(x => x.id === id)
    if (!it) return
    wx.navigateTo({
      url: '/pages/instrument-log-edit/index?id=' + encodeURIComponent(id) +
        '&user=' + encodeURIComponent(it.userName) +
        '&begin=' + encodeURIComponent(it.begin) +
        '&finish=' + encodeURIComponent(it.finish) +
        '&unit=' + it.unit + '&qty=' + it.qty +
        '&penalty=' + it.penalty + '&discount=' + it.discount +
        '&userId=' + encodeURIComponent(it.userId || '')
    })
  },

  // 修改页保存后回写本条记录（由 instrument-log-edit 调用）
  // 修改页支持多行「单价 × 数量」，feeLeft 已是拼好的整段摘要，直接覆盖
  updateRecord(p) {
    if (!p || !p.id) return
    const list = this.data.list.map(x => {
      if (x.id !== p.id) return x
      const total = (p.total != null) ? p.total : x.total
      return Object.assign({}, x, {
        userName: p.userName || x.userName,
        feeLeft: p.feeLeft || x.feeLeft,
        feeRight: p.feeRight || x.feeRight,
        total,
        totalText: (total == null ? x.totalText : total + ' 元')
      })
    })
    this.setData({ list })
  }
})
