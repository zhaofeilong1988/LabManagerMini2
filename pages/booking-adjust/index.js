// pages/booking-adjust/index.js
// 预约调整（仪器维度）：审批人管理该仪器下的预约单 + 维护禁用时段
//   ① 日历选日期（spot 标出有预约 / 有禁用） ② 时段表 ③ 禁用操作
//   ④ 预约单列表：逐条修改开始、结束时间
// 禁用部分按 LabManagerMini/pages/appointChange 的实现方式：
//   disableList 按日期存「禁用记录」，取消禁用走范围选择 + 二次确认，
//   新增禁用时段先进编辑态、保存后生效，禁用全天直接生效；每条支持修改/删除/批量复制
//   禁用时段：新增 / 修改 / 禁用全天提交 /api/editDisable，数据回填自 deviceApply.disableList
//
// 数据来源：进入时 POST /api/deviceApply（{ token, id: deviceId }）
//   data.apply       该仪器已占用的预约段，每项 { begin_at, finish_at, … }
//                    → ① 渲染成下方「预约单列表」② 按日期拆成分钟段，画进时段表
//   data.disableList 禁用时段 → 禁用时段区域 + 时段表禁用档
// 不再有演示 / 模拟的占用与预约单：没有 deviceId 或接口失败时列表为空、时段表全空闲
const { getDeviceApply, editDisable, cancelDisable } = require('../../utils/api.js')
const { getLoginUser } = require('../../utils/auth.js')

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const CELLS = 96          // 24 小时 × 4 档（每档 15 分钟）
const DEFAULT_QUADS = 4   // 默认选 1 小时

// 「取消禁用」可选范围 —— 参考 LabManagerMini/pages/appointChange data.cancelDayList
// type 就是本数组的下标（/api/cancelDisable 的 type）：一天=0、三天=1、一周=2 … 一年=8
const CANCEL_DAYS = [
  { label: '一天', days: 1, type: '0' },
  { label: '三天', days: 3, type: '1' },
  { label: '一周', days: 7, type: '2' },
  { label: '两周', days: 14, type: '3' },
  { label: '一个月', days: 30, type: '4' },
  { label: '两个月', days: 60, type: '5' },
  { label: '三个月', days: 90, type: '6' },
  { label: '半年', days: 180, type: '7' },
  { label: '一年', days: 365, type: '8' }
]

// 禁用时长（分钟）—— 参考 appointChange data.timeList
const TIME_MINUTES = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 1440]

// 「批量复制」双列：未来时长 + 重复模式 —— 参考 appointChange data.dayList
const COPY_SPANS = ['一个月', '两个月', '三个月', '半年', '一年']
const COPY_SPANS_DAYS = [30, 60, 90, 180, 365]
const COPY_WEEKS = ['每天', '每周六、日', '每周日', '每周一', '每周二', '每周三', '每周四', '每周五', '每周六']
// 与 COPY_WEEKS 一一对应：每周几生效（每天为全部）
const COPY_WEEK_RULE = [-1, -2, 0, 1, 2, 3, 4, 5, 6]

// ── /api/deviceApply.apply → 本页数据 ──
// 按多条路径取值，兼容驼峰 / 下划线
function pickOf(o, paths) {
  for (let i = 0; i < paths.length; i++) {
    let cur = o
    let ok = true
    const segs = String(paths[i]).split('.')
    for (let k = 0; k < segs.length; k++) {
      if (!cur || typeof cur !== 'object') { ok = false; break }
      cur = cur[segs[k]]
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur
  }
  return ''
}

// 'YYYY-MM-DD HH:mm:ss' → { ds: 'YYYY-MM-DD', tt: 'HH:mm' }
function parseTs(s) {
  if (s == null) return null
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/)
  return m ? { ds: m[1], tt: (m[2].length === 4 ? '0' + m[2] : m[2]) } : null
}

// 'HH:mm' → 分钟
function minOfTt(tt) {
  const p = String(tt || '').split(':')
  return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0)
}

// dept_type：1=所内 / 2=所外 / 3=院外（与项目其它页面一致）；字符串原样返回
function deptText(v) {
  const s = String(v == null ? '' : v).trim()
  if (s === '1') return '所内'
  if (s === '2') return '所外'
  if (s === '3') return '院外'
  return s
}

// operate_type：1=自助 / 2=委托
function modeText(v) {
  const s = String(v == null ? '' : v).trim()
  if (s === '1') return '自助'
  if (s === '2') return '委托'
  return s
}

// apply 数组 → 预约单列表（字段与本页原演示数据一致）
function bookingsFromApply(arr) {
  return (Array.isArray(arr) ? arr : []).map((row, i) => {
    if (!row || typeof row !== 'object') return null
    const a = parseTs(pickOf(row, ['begin_at', 'beginAt']))
    const b = parseTs(pickOf(row, ['finish_at', 'finishAt']))
    if (!a) return null
    return {
      id: String(pickOf(row, ['id', 'applyId']) || ('bk' + i)),
      lab: String(pickOf(row, ['dept_name', 'deptName', 'lab'])),
      dept: deptText(pickOf(row, ['dept_type', 'deptType'])),
      mode: modeText(pickOf(row, ['operate_type', 'operateType'])),
      // 预约人 / 登录名 / 手机号：接口可能把用户信息放在 row.user / row.applyUser 里，逐层兼容
      user: String(pickOf(row, [
        'user.user_name', 'user.userName', 'applyUser.user_name', 'applyUser.userName',
        'user_name', 'userName', 'name'
      ])),
      wx: String(pickOf(row, [
        'user.login_name', 'user.loginName', 'applyUser.login_name',
        'login_name', 'loginName', 'wx'
      ])),
      phone: String(pickOf(row, [
        'user.phonenumber', 'user.phoneNumber', 'user.phone', 'user.mobile', 'user.tel',
        'user.userPhone', 'user.user_phone',
        'applyUser.phonenumber', 'applyUser.phoneNumber', 'applyUser.phone', 'applyUser.mobile',
        'applicant.phonenumber', 'applicant.phone',
        'phonenumber', 'phoneNumber', 'phone_number', 'phone', 'mobile', 'tel',
        'contactPhone', 'contact_phone', 'userPhone', 'user_phone'
      ])),
      beginDate: a.ds,
      beginTime: a.tt,
      endDate: (b || a).ds,
      endTime: (b || a).tt
    }
  }).filter(Boolean)
}

// apply 数组 → { 'YYYY-MM-DD': [[起分钟, 止分钟], …] }（跨天按天头天尾拆分）
function occByDsFromApply(arr) {
  const map = {}
  ;(Array.isArray(arr) ? arr : []).forEach(row => {
    if (!row || typeof row !== 'object') return
    const a = parseTs(pickOf(row, ['begin_at', 'beginAt']))
    const b = parseTs(pickOf(row, ['finish_at', 'finishAt']))
    if (!a || !b) return
    let ds = a.ds
    let guard = 0
    while (ds <= b.ds && guard++ < 400) {
      const sMin = (ds === a.ds) ? minOfTt(a.tt) : 0
      const eMin = (ds === b.ds) ? minOfTt(b.tt) : 1440
      if (eMin > sMin) {
        if (!map[ds]) map[ds] = []
        map[ds].push([sMin, eMin])
      }
      ds = shiftDs(ds, 1)
    }
  })
  return map
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

// 当前时间 → 'YYYY-MM-DD HH:mm:ss'（/api/editDisable 的 create_time）
function nowStr() {
  const t = new Date()
  return dsOf(t.getFullYear(), t.getMonth() + 1, t.getDate()) + ' ' +
    pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds())
}

// 登录人 user_id（登录时写入登录态）：/api/editDisable 的 create_by
function loginUserId() {
  const u = getLoginUser() || {}
  const v = (u.user_id !== undefined && u.user_id !== null)
    ? u.user_id
    : (u.userId !== undefined && u.userId !== null ? u.userId : u.id)
  return (v === undefined || v === null) ? '' : v
}

function dsOf(y, m, d) {
  return y + '-' + pad2(m) + '-' + pad2(d)
}

function todayDs() {
  const t = new Date()
  return dsOf(t.getFullYear(), t.getMonth() + 1, t.getDate())
}

// 分钟 → 文案（参考 appointChange 的 timeList 展示）
function minText(m) {
  if (m < 60) return m + '分钟'
  const h = m / 60
  return (m % 60 === 0 ? h : h.toFixed(1)) + '小时'
}

// 日期 ±n 天 → 'YYYY-MM-DD'
function shiftDs(ds, n) {
  const p = ds.split('-')
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
  d.setDate(d.getDate() + n)
  return dsOf(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

Page({
  data: {
    name: '',
    year: 0,
    month: 0,
    weekTitles: WEEK,
    days: [],
    canPrev: false,
    canNext: true,
    curDs: '',
    dateLabel: '',
    timeGroups: [],
    selStart: -1,
    selEnd: -1,
    selText: '',
    durText: '',
    hasSel: false,
    bookings: [],
    bookingCount: 0,
    loading: false,       // 正在拉 /api/deviceApply
    editingId: '',
    // ── 禁用时段（参考 appointChange）──
    cancelDayList: CANCEL_DAYS.map(x => x.label),   // 取消禁用的范围选项
    timeList: TIME_MINUTES.map(minText),            // 禁用时长选项
    dayList: [COPY_SPANS, COPY_WEEKS],              // 批量复制：未来时长 + 重复模式
    disableList: {},                                // { '2026-10-23': [{ id, bIdx, eIdx, edited }] }
    disableRows: [],                                // 当前日期的展示行
    banHint: ''                                     // 当前日期无禁用、其它日期有时的一句提示
  },

  onLoad(options) {
    const name = decodeURIComponent(options.name || '') || '该仪器'
    const t = new Date()
    this._base = []          // 96 档基础状态：idle / occ / off
    this._seq = 0            // 禁用记录自增 id
    this._applySeq = 0       // /api/deviceApply 请求序号（防止旧请求晚回覆盖新数据）
    this._occByDs = {}       // 接口下发的占用段（按日期分组）；空对象 = 没有任何占用
    this._deviceId = decodeURIComponent((options && options.deviceId) || '')
    this.setData({
      name,
      year: t.getFullYear(),
      month: t.getMonth() + 1,
      curDs: todayDs(),
      // 预约单只来自 /api/deviceApply，不再预置演示数据
      bookings: [],
      bookingCount: 0,
      loading: !!this._deviceId
    })
    this._buildCal()
    this._syncDisable()
    if (this._deviceId) this._loadApply()
  },

  // POST /api/deviceApply（{ token, id: deviceId }）→ 这台仪器的预约数据
  // data.apply       用于：① 下方预约单列表 ② 时段表的占用档位
  // data.disableList 用于：禁用时段区域（按日期分组渲染）
  _loadApply() {
    const seq = ++this._applySeq
    getDeviceApply(this._deviceId)
      .then(data => {
        if (seq !== this._applySeq) return
        const raw = (data && typeof data === 'object') ? data : {}
        const arr = Array.isArray(raw.apply) ? raw.apply
          : (Array.isArray(raw.device && raw.device.apply) ? raw.device.apply : [])
        const bookings = bookingsFromApply(arr)
        this._occByDs = occByDsFromApply(arr)
        // 排查用：首条原始字段（确认手机号等用户信息的实际字段名 / 所在层级）
        if (arr.length) console.log('[booking-adjust] apply 首条原始字段：', arr[0])
        // 禁用时段：取值顺序 disableList / disable_list / disable / disables（顶层），
        // 再退到 device 包裹内；值可能是「按日期分组的对象」（参考项目就是这种）也可能是扁平数组
        const dev = (raw.device && typeof raw.device === 'object') ? raw.device : {}
        const rawDis = [raw.disableList, raw.disable_list, raw.disable, raw.disables,
          dev.disableList, dev.disable_list, dev.disable]
          .find(v => v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length))
          || null
        const disableList = rawDis ? this._disableMapFromApi(rawDis) : null
        const disCount = disableList
          ? Object.keys(disableList).reduce((s, k) => s + disableList[k].length, 0)
          : 0
        console.log('[booking-adjust] /api/deviceApply 预约单：共', bookings.length, '条',
          '；禁用时段：', disableList ? disCount + ' 条 / ' + Object.keys(disableList).length + ' 天' : '接口未返回',
          '；原始 disableList：', rawDis)
        const patch = { bookings, bookingCount: bookings.length, loading: false }
        // 接口有 disableList 就以接口为准覆盖本地（没有该字段时保留本地状态）
        if (disableList) patch.disableList = disableList
        this.setData(patch, () => this._syncDisable())
      })
      .catch(err => {
        if (seq !== this._applySeq) return
        console.warn('[booking-adjust] /api/deviceApply 失败：', err)
        wx.showToast({ title: (err && err.message) || '预约数据加载失败', icon: 'none' })
        this.setData({ loading: false, bookings: [], bookingCount: 0 })
      })
  },

  // /api/deviceApply 的 disableList → 本页按日期分组的禁用记录
  //   接口有两种形态，都支持（参考项目 appointChange 用的是 ①）：
  //     ① 已按日期分组：{ '2026-10-27': [ { id, begin_at, finish_at, … } ] }
  //     ② 扁平数组：   [ { id, begin_at, finish_at, … } ]（按 begin_at 的日期归组）
  //   接口项：{ id, device_id, begin_at, finish_at, disable, edited, create_by, create_time }
  //   本页项：{ id, serverId, bIdx, eIdx, edited: false, saved: true, createBy, createTime }
  //   档位换算：起 = floor(分钟/15)，止 = ceil(分钟/15)；
  //   23:59:59 → 96 档；跨天的记到起始日并延伸到当天 24:00
  _disableMapFromApi(src) {
    const map = {}
    const pushOne = (dsHint, row) => {
      if (!row || typeof row !== 'object') return
      // disable=false 表示该条已取消禁用，不渲染
      const flag = pickOf(row, ['disable'])
      if (flag === false || flag === 0 || flag === '0' || flag === 'false') return
      const a = parseTs(pickOf(row, ['begin_at', 'beginAt']))
      const b = parseTs(pickOf(row, ['finish_at', 'finishAt']))
      const ds = dsHint || (a ? a.ds : '')
      if (!ds) return
      let bIdx = a ? Math.floor(minOfTt(a.tt) / 15) : 0
      let eIdx = (b && b.ds === ds) ? Math.ceil(minOfTt(b.tt) / 15) : CELLS
      if (bIdx < 0) bIdx = 0
      if (bIdx > CELLS - 1) bIdx = CELLS - 1
      if (eIdx > CELLS) eIdx = CELLS
      if (eIdx <= bIdx) eIdx = Math.min(CELLS, bIdx + 1)

      this._seq += 1
      const item = { id: 'ban' + this._seq, bIdx, eIdx, edited: false, saved: true }
      // 后端 id：后续「修改 / 保存」提交 /api/editDisable 时要带上
      const sid = pickOf(row, ['id', 'disable_id'])
      if (sid !== '') item.serverId = sid
      const cb = pickOf(row, ['create_by', 'createBy'])
      if (cb !== '') item.createBy = cb
      const ct = pickOf(row, ['create_time', 'createTime'])
      if (ct !== '') item.createTime = ct

      if (!map[ds]) map[ds] = []
      map[ds].push(item)
    }

    if (Array.isArray(src)) {
      src.forEach(row => pushOne('', row))
    } else if (src && typeof src === 'object') {
      Object.keys(src).forEach(k => {
        const v = src[k]
        const arr = Array.isArray(v) ? v : ((v && typeof v === 'object') ? [v] : [])
        const dsHint = /^\d{4}-\d{1,2}-\d{1,2}$/.test(k) ? k : ''
        arr.forEach(row => pushOne(dsHint, row))
      })
    }
    Object.keys(map).forEach(ds => map[ds].sort((x, y) => x.bIdx - y.bIdx))
    return map
  },

  // ── 日历 ──
  // hasBook / hasBan：对应参考项目 calendar 组件的 spot 标记（有预约 / 有禁用）
  _buildCal() {
    const { year, month, curDs, disableList } = this.data
    const today = todayDs()
    const firstDay = new Date(year, month - 1, 1).getDay()
    const total = new Date(year, month, 0).getDate()
    const days = []
    for (let i = 0; i < firstDay; i++) days.push({ id: 'blank' + i, blank: true })
    for (let d = 1; d <= total; d++) {
      const ds = dsOf(year, month, d)
      days.push({
        id: ds,
        d,
        ds,
        td: ds === today,
        dis: ds < today,
        sel: ds === curDs,
        hasBook: this.data.bookings.some(b => b.beginDate === ds),
        hasBan: !!(disableList[ds] && disableList[ds].length)
      })
    }
    const t = new Date()
    const idx = year * 12 + (month - 1)
    const minIdx = t.getFullYear() * 12 + t.getMonth()
    this.setData({
      days,
      dateLabel: curDs,
      canPrev: idx > minIdx,
      canNext: idx < minIdx + 12
    })
  },

  onPrevMonth() {
    if (!this.data.canPrev) return
    let y = this.data.year, m = this.data.month - 1
    if (m < 1) { m = 12; y -= 1 }
    this.setData({ year: y, month: m })
    this._buildCal()
  },

  onNextMonth() {
    if (!this.data.canNext) return
    let y = this.data.year, m = this.data.month + 1
    if (m > 12) { m = 1; y += 1 }
    this.setData({ year: y, month: m })
    this._buildCal()
  },

  // 换日期：清空已选时段
  onPickDate(e) {
    const ds = e.currentTarget.dataset.ds
    if (!ds || ds < todayDs()) return
    this.setData({ curDs: ds, selStart: -1, selEnd: -1, selText: '', durText: '', hasSel: false })
    this._buildCal()
    this._syncDisable()
  },

  // ── 时段表：占用规则（占用只看 /api/deviceApply 的 apply，无模拟数据） ──
  _baseState(ds, i) {
    // 今天已过去的档位不可约
    if (ds === todayDs()) {
      const t = new Date()
      if (i < t.getHours() * 4 + Math.floor(t.getMinutes() / 15)) return 'off'
    }
    // 接口下发的占用段（档位 i 对应 i × 15 分钟）；没有数据即空闲
    const segs = (this._occByDs && this._occByDs[ds]) || []
    const m = i * 15
    for (let k = 0; k < segs.length; k++) {
      if (m >= segs[k][0] && m < segs[k][1]) return 'occ'
    }
    return 'idle'
  },

  _buildSlots() {
    const ds = this.data.curDs
    const { selStart, selEnd } = this.data
    const ban = this._banFlags(ds)
    const base = []
    for (let i = 0; i < CELLS; i++) {
      // 落在禁用记录内的档位按「禁用」处理，与不可预约共用 off 状态
      base.push(ban[i] ? 'off' : this._baseState(ds, i))
    }
    this._base = base

    const groups = []
    for (let g = 0; g < 4; g++) {
      const cols = []
      for (let h = g * 6; h < g * 6 + 6; h++) {
        const quads = []
        for (let q = 0; q < 4; q++) {
          const i = h * 4 + q
          let st = base[i]
          if (selStart >= 0 && i >= selStart && i <= selEnd && st === 'idle') st = 'sel'
          quads.push({ i, state: st })
        }
        cols.push({ h, quads })
      }
      groups.push({ g, cols })
    }
    this.setData({ timeGroups: groups })
  },

  _hm(i) {
    return pad2(Math.floor(i / 4)) + ':' + pad2((i % 4) * 15)
  },

  // 点档位：空闲 → 以该档为开始自动选 1 小时；点已选区间 → 清空重选
  onCell(e) {
    const i = Number(e.currentTarget.dataset.i)
    const st = this._base[i]
    if (st === 'occ') { wx.showToast({ title: '该时段已被占用', icon: 'none' }); return }
    if (st === 'off') { wx.showToast({ title: '该时段不可预约', icon: 'none' }); return }

    const { selStart, selEnd } = this.data
    if (selStart >= 0 && i >= selStart && i <= selEnd) {
      this.setData({ selStart: -1, selEnd: -1, selText: '', durText: '', hasSel: false })
      this._buildSlots()
      return
    }
    let end = i + DEFAULT_QUADS - 1
    if (end > CELLS - 1) end = CELLS - 1
    for (let k = i; k <= end; k++) {
      if (this._base[k] !== 'idle') {
        wx.showToast({ title: '所选区间含占用时段，请重新选择', icon: 'none' })
        return
      }
    }
    const mins = (end - i + 1) * 15
    this.setData({
      selStart: i,
      selEnd: end,
      selText: this._hm(i) + ' - ' + this._hm(end + 1),
      durText: mins >= 60 ? (mins / 60) + ' 小时' : mins + ' 分钟',
      hasSel: true
    })
    this._buildSlots()
  },

  onClear() {
    this.setData({ selStart: -1, selEnd: -1, selText: '', durText: '', hasSel: false })
    this._buildSlots()
  },

  // ── 禁用时段（实现方式参考 LabManagerMini/pages/appointChange）──
  _clearSel() {
    this.setData({ selStart: -1, selEnd: -1, selText: '', durText: '', hasSel: false })
  },

  // 当前日期被禁用的档位标记（由禁用记录换算，参考 getDaySelected）
  _banFlags(ds) {
    const list = this.data.disableList[ds] || []
    const flags = []
    for (let i = 0; i < CELLS; i++) {
      let ban = false
      for (let k = 0; k < list.length; k++) {
        if (i >= list[k].bIdx && i < list[k].eIdx) { ban = true; break }
      }
      flags.push(ban)
    }
    return flags
  },

  // 禁用记录 → 展示行 + 刷新时段表与日历 mark
  _syncDisable() {
    const ds = this.data.curDs
    const all = this.data.disableList || {}
    const list = (all[ds] || []).slice().sort((a, b) => a.bIdx - b.bIdx)
    const rows = list.map((x, k) => ({
      k,
      begin: this._hm(x.bIdx),
      end: this._hm(x.eIdx),
      dur: minText((x.eIdx - x.bIdx) * 15),
      edited: !!x.edited
    }))
    // 当前日期没有禁用、但别的日期有 → 给一句提示（否则看着像「没拿到数据」）
    let total = 0
    Object.keys(all).forEach(d => { total += (all[d] || []).length })
    const banHint = (rows.length || !total)
      ? ''
      : '该日期暂无禁用时段，日历上带灰点的日期有禁用（共 ' + total + ' 条）'
    this.setData({ disableRows: rows, banHint })
    this._buildSlots()
    this._buildCal()
  },

  _updateBan(k, fn) {
    const ds = this.data.curDs
    const all = Object.assign({}, this.data.disableList)
    const arr = (all[ds] || []).slice()
    if (!arr[k]) return
    arr[k] = fn(arr[k]) || arr[k]
    all[ds] = arr
    this.setData({ disableList: all })
    this._syncDisable()
  },

  // ① 取消禁用：picker 选择范围 → 二次确认 → 按日期 POST /api/cancelDisable（参考 removeDisable）
  onRemoveDisable(e) {
    const idx = Number(e.detail.value)
    const item = CANCEL_DAYS[idx]
    if (!item) return
    wx.showModal({
      title: '您确定要取消未来' + item.label + '的禁用吗？',
      showCancel: true,
      success: res => {
        if (!res.confirm) return
        this._cancelDisableRange(item.days, item.type)
      }
    })
  },

  // 取消禁用：整个操作只调一次接口
  //   { date: 所选日期（日历上当前选中的那天）, id: 仪器 id, type: 所选范围 }
  //   type：一天='0'、三天='1'、一周='2' … 一年='8'（见 CANCEL_DAYS）
  //   范围由后端按 type 展开，前端不再逐日发请求
  // 成功后才清除本地（所选日期起 days 天内的禁用记录）；失败保留并提示
  _cancelDisableRange(days, type) {
    const from = this.data.curDs || todayDs()
    const to = shiftDs(from, days)
    const all = this.data.disableList || {}
    // 本地要清除的条目：所选日期起 days 天内（按 日期 + 本地记录 id 精确匹配）
    const jobs = []
    Object.keys(all).forEach(ds => {
      if (!(ds >= from && ds <= to)) return
      ;(all[ds] || []).forEach(x => jobs.push({ ds, key: x.id }))
    })
    const dropLocal = () => this._dropDisableJobs(jobs)
    console.log('[booking-adjust] 取消禁用：date=' + from, 'type=' + type,
      '；本地命中', jobs.length, '条')

    // 没有 deviceId（旧入口 / 演示）→ 不发请求，但要说明，避免误以为已线上取消
    if (!this._deviceId) {
      dropLocal()
      wx.showToast({ title: '未获取到仪器，仅清除本地显示', icon: 'none' })
      return
    }

    wx.showLoading({ title: '取消中…', mask: true })
    cancelDisable({ date: from, id: this._deviceId, type: type == null ? '0' : String(type) })
      .then(() => {
        wx.hideLoading()
        dropLocal()
        wx.showToast({ title: '取消成功！', icon: 'success' })
      })
      .catch(err => {
        wx.hideLoading()
        console.warn('[booking-adjust] /api/cancelDisable 失败：date=' + from +
          ' deviceId=' + this._deviceId + ' type=' + type, err)
        wx.showToast({ title: (err && err.message) || '取消失败，请重试', icon: 'none' })
      })
  },

  // 从 disableList 里移除指定条目（按 日期 + 本地记录 id 精确匹配）
  _dropDisableJobs(jobs) {
    if (!jobs || !jobs.length) return
    const all = Object.assign({}, this.data.disableList)
    jobs.forEach(j => {
      const arr = all[j.ds]
      if (!arr) return
      const left = arr.filter(x => x.id !== j.key)
      if (left.length) all[j.ds] = left
      else delete all[j.ds]
    })
    this.setData({ disableList: all })
    this._syncDisable()
  },

  // ② 新增禁用时段：追加一条记录并进入编辑态，保存后才生效（参考 addDisable）
  // 时段表里已选区间 → 按该区间新增；没选 → 默认下一整点起 1 小时
  onAddDisable() {
    const ds = this.data.curDs
    const list = this.data.disableList[ds] || []
    // 参考：存在未保存的记录时先提示
    for (let i = 0; i < list.length; i++) {
      if (list[i].edited) {
        wx.showToast({ title: '请先保存当前的修改！', icon: 'none' })
        return
      }
    }

    const { selStart, selEnd, hasSel } = this.data
    let bIdx = 0
    let eIdx = 0
    if (hasSel && selStart >= 0 && selEnd >= selStart) {
      // 已选区间：起 = 第一档，止 = 最后一档 + 1（selEnd 是含端点的档位）
      bIdx = selStart
      eIdx = Math.min(CELLS, selEnd + 1)
    } else {
      // 参考：默认从下一整点起 1 小时
      bIdx = Math.min((new Date().getHours() + 1) * 4, CELLS - DEFAULT_QUADS)
      for (let i = 0; i < list.length; i++) {
        // 起点若落在旧区间之内则顺延到其后
        if (bIdx >= list[i].bIdx && bIdx < list[i].eIdx) bIdx = list[i].eIdx
      }
      if (bIdx > CELLS - DEFAULT_QUADS) bIdx = CELLS - DEFAULT_QUADS
      eIdx = bIdx + DEFAULT_QUADS
    }

    // 与已有禁用区间重叠 → 提示（同一段只需一条禁用，避免重复提交）
    for (let i = 0; i < list.length; i++) {
      if (bIdx < list[i].eIdx && eIdx > list[i].bIdx) {
        wx.showToast({ title: '所选时段已在禁用范围内', icon: 'none' })
        return
      }
    }

    this._seq += 1
    const all = Object.assign({}, this.data.disableList)
    const arr = (all[ds] || []).concat([{
      id: 'ban' + this._seq, bIdx, eIdx, edited: true, saved: false
    }])
    arr.sort((a, b) => a.bIdx - b.bIdx)
    all[ds] = arr
    // 该区间已被这条禁用覆盖：清掉时段表里的选择，避免重复添加
    this.setData({
      disableList: all,
      selStart: -1,
      selEnd: -1,
      selText: '',
      durText: '',
      hasSel: false
    })
    this._syncDisable()
  },

  // ③ 禁用全天：当天 00:00 ~ 24:00 整体禁用，直接生效（参考 addDisableAllDay）
  // 参考实现同样调 /api/editDisable 提交这条全天禁用
  onAddDisableAllDay() {
    const ds = this.data.curDs
    this._seq += 1
    const item = { id: 'ban' + this._seq, bIdx: 0, eIdx: CELLS, edited: false, saved: true }
    const all = Object.assign({}, this.data.disableList)
    all[ds] = [item]
    this.setData({ disableList: all })
    this._syncDisable()
    this._saveDisableRemote(0, ds, item, '修改成功！')
  },

  // ── 禁用行操作：修改 / 取消 / 保存 / 删除 / 批量复制 ──
  onEditDisable(e) {
    const k = Number(e.currentTarget.dataset.k)
    this._updateBan(k, x => Object.assign({}, x, { edited: true }))
  },

  // 取消：新记录未保存则直接丢弃，已保存记录仅退出编辑态（参考 cancelDisable）
  onCancelDisable(e) {
    const k = Number(e.currentTarget.dataset.k)
    const ds = this.data.curDs
    const all = Object.assign({}, this.data.disableList)
    const arr = (all[ds] || []).slice()
    if (!arr[k]) return
    if (!arr[k].saved) arr.splice(k, 1)
    else arr[k] = Object.assign({}, arr[k], { edited: false })
    all[ds] = arr
    this.setData({ disableList: all })
    this._syncDisable()
  },

  // 保存：二次确认 → POST /api/editDisable（参考 saveDisable）
  onSaveDisable(e) {
    const k = Number(e.currentTarget.dataset.k)
    const ds = this.data.curDs
    const cur = (this.data.disableList[ds] || [])[k]
    if (!cur) return
    wx.showModal({
      title: '您确定要禁止此时间段的预约吗？',
      content: ds + ' ' + this._hm(cur.bIdx) + ' ~ ' + this._hm(cur.eIdx),
      showCancel: true,
      success: res => {
        if (!res.confirm) return
        this._saveDisableRemote(k, ds, cur, '修改成功！')
      }
    })
  },

  // 该条禁用 → /api/editDisable 的 disable 对象
  //   { id?, device_id, begin_at, finish_at, disable: true, edited: false, create_by, create_time }
  //   eIdx 为 96（24:00）时结束时间按当天 23:59:59 提交（同参考实现的「禁用全天」）
  _disableBody(cur, ds) {
    const end = (cur.eIdx >= CELLS) ? '23:59:59' : (this._hm(cur.eIdx) + ':00')
    const body = {
      device_id: this._deviceId,
      begin_at: ds + ' ' + this._hm(cur.bIdx) + ':00',
      finish_at: ds + ' ' + end,
      disable: true,
      edited: false,
      create_by: cur.createBy || loginUserId(),
      create_time: cur.createTime || nowStr()
    }
    // 已保存过的记录带后端 id；新增的不传，由后端生成
    if (cur.serverId != null && String(cur.serverId).trim() !== '') body.id = cur.serverId
    return body
  },

  // 提交禁用时段：成功后写回 id / saved 并退出编辑态；失败保留编辑态并提示
  // deviceId 缺失（旧入口 / 演示数据）时只更新本地状态，不调接口
  _saveDisableRemote(k, ds, cur, okText) {
    if (!this._deviceId) {
      this._markDisableSaved(k, ds, null)
      wx.showToast({ title: okText || '修改成功！', icon: 'success' })
      return
    }
    wx.showLoading({ title: '保存中…', mask: true })
    editDisable(this._disableBody(cur, ds))
      .then(data => {
        wx.hideLoading()
        const sid = pickOf(data || {}, ['id', 'disableId', 'disable.id', 'disable.disable_id'])
        this._markDisableSaved(k, ds, sid)
        wx.showToast({ title: okText || '修改成功！', icon: 'success' })
      })
      .catch(err => {
        wx.hideLoading()
        console.warn('[booking-adjust] /api/editDisable 失败：', err)
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' })
      })
  },

  _markDisableSaved(k, ds, serverId) {
    const all = Object.assign({}, this.data.disableList)
    const arr = (all[ds] || []).slice()
    if (!arr[k]) return
    const patch = {
      edited: false,
      saved: true,
      // create_by / create_time 首次保存后固定下来，后续编辑沿用
      createBy: arr[k].createBy || loginUserId(),
      createTime: arr[k].createTime || nowStr()
    }
    if (serverId != null && String(serverId).trim() !== '') patch.serverId = serverId
    arr[k] = Object.assign({}, arr[k], patch)
    all[ds] = arr
    this.setData({ disableList: all })
    this._syncDisable()
  },

  // 删除：二次确认（参考 delDisable）
  onDelDisable(e) {
    const k = Number(e.currentTarget.dataset.k)
    const ds = this.data.curDs
    const cur = (this.data.disableList[ds] || [])[k]
    if (!cur) return
    wx.showModal({
      title: '您确定要取消禁止吗？',
      content: ds + ' ' + this._hm(cur.bIdx) + ' ~ ' + this._hm(cur.eIdx),
      showCancel: true,
      success: res => {
        if (!res.confirm) return
        const all = Object.assign({}, this.data.disableList)
        const arr = (all[ds] || []).slice()
        arr.splice(k, 1)
        all[ds] = arr
        this.setData({ disableList: all })
        this._syncDisable()
        wx.showToast({ title: '删除成功！', icon: 'success' })
      }
    })
  },

  // 批量复制：把该时段复制到未来一段时间内的指定星期（参考 batchDisable）
  onBatchDisable(e) {
    const k = Number(e.currentTarget.dataset.k)
    const vi = e.detail.value || []
    const spanIdx = Number(vi[0])
    const weekIdx = Number(vi[1])
    const rule = COPY_WEEK_RULE[weekIdx]
    const spanDays = COPY_SPANS_DAYS[spanIdx]
    if (rule === undefined || !spanDays) return
    const ds = this.data.curDs
    const cur = (this.data.disableList[ds] || [])[k]
    if (!cur) return
    const range = this._hm(cur.bIdx) + '~' + this._hm(cur.eIdx)
    wx.showModal({
      title: '您确定要禁用未来' + COPY_SPANS[spanIdx] + '，' + COPY_WEEKS[weekIdx] + '的' + range + '吗？',
      showCancel: true,
      success: res => {
        if (!res.confirm) return
        const all = Object.assign({}, this.data.disableList)
        const from = todayDs()
        let count = 0
        for (let n = 1; n <= spanDays; n++) {
          const target = shiftDs(from, n)
          const wd = (() => {
            const p = target.split('-')
            return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay()
          })()
          const hit = rule === -1 ? true : rule === -2 ? (wd === 0 || wd === 6) : wd === rule
          if (!hit) continue
          const arr = (all[target] || []).slice()
          if (arr.some(x => x.bIdx === cur.bIdx && x.eIdx === cur.eIdx)) continue
          this._seq += 1
          arr.push({ id: 'ban' + this._seq, bIdx: cur.bIdx, eIdx: cur.eIdx, edited: false, saved: true })
          arr.sort((a, b) => a.bIdx - b.bIdx)
          all[target] = arr
          count++
        }
        this.setData({ disableList: all })
        this._syncDisable()
        wx.showToast({ title: count ? '设置成功！' : '该范围内无需复制', icon: count ? 'success' : 'none' })
      }
    })
  },

  // 禁用行的开始时间（picker mode=time）
  onPickBanBegin(e) {
    const k = Number(e.currentTarget.dataset.k)
    const v = String(e.detail.value || '')
    const p = v.split(':')
    if (p.length < 2) return
    let bIdx = Number(p[0]) * 4 + Math.floor(Number(p[1]) / 15)
    this._updateBan(k, x => {
      const durQ = x.eIdx - x.bIdx
      let b = bIdx
      if (b + durQ > CELLS) b = CELLS - durQ
      if (b < 0) b = 0
      return Object.assign({}, x, { bIdx: b, eIdx: b + durQ })
    })
  },

  // 禁用行的时长（picker mode=selector）
  onPickBanDur(e) {
    const k = Number(e.currentTarget.dataset.k)
    const minutes = TIME_MINUTES[Number(e.detail.value)]
    if (!minutes) return
    this._updateBan(k, x => {
      let b = x.bIdx
      const q = Math.round(minutes / 15)
      if (b + q > CELLS) b = CELLS - q
      return Object.assign({}, x, { bIdx: b, eIdx: b + q })
    })
  },

  // ── 预约单：逐条修改预约时间 ──
  // 点「修改」进入该条的编辑态（日期时间可点选），再点「保存」退出
  onToggleEdit(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.editingId === id) {
      this.setData({ editingId: '' })
      wx.showToast({ title: '预约时间已保存', icon: 'success' })
      return
    }
    this.setData({ editingId: id })
  },

  // 日期 / 时间选择（picker）
  onPickDT(e) {
    const { id, field } = e.currentTarget.dataset
    const value = e.detail.value
    const bookings = this.data.bookings.map(x => {
      if (x.id !== id) return x
      const next = Object.assign({}, x)
      next[field] = value
      return next
    })
    this.setData({ bookings })
  }
})
