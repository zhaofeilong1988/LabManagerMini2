// pages/instrument-book/index.js
// 仪器预约页（重设计版）
// 交互链路：
//   ① 月历选「查看日」→ ② 该日 15 分钟网格展示四种状态（当前预约/已占用/空闲可约/禁用）
//   ③ 点击任一空闲格 = 以该时刻为新「开始」，自动按「推荐时长」向后选段；可再点其它空闲格重选（不做累加）
//   ④ 「已选时间」卡内开始/结束日期与时刻均可手动精调；跨天区间自动校验逐日空闲
// 数据链路：startDs/startMin + endDs/endMin（半开区间 [start, end)）→ 费用 / 逐日占用
const { findInstrument } = require('../../utils/instruments.js')
const { addBooking } = require('../../utils/bookings.js')
const { DEVICE_APPLY_KEY, doDeviceApply, getDeviceApply } = require('../../utils/api.js')
const { getLoginUser } = require('../../utils/auth.js')

const WEEK_TITLES = ['日', '一', '二', '三', '四', '五', '六']
const STEP = 15              // 每档 15 分钟
const CELLS = 24 * 4         // 24h * 4 = 96 档
const MAX_AHEAD = 30         // 可预约展望期（今天起 30 天）
const DAYS_CAP = 7           // 规则未设上限（max:0）时单次预约最长天数
const pad2 = n => (n < 10 ? '0' + n : '' + n)
const toDs = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`

function todayInfo() {
  const t = new Date()
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), h: t.getHours(), min: t.getMinutes() }
}
function dateLabelOf(ds) {
  const p = ds.split('-').map(Number)
  const w = new Date(p[0], p[1] - 1, p[2]).getDay()
  return `${p[1]} 月 ${p[2]} 日 星期${WEEK_TITLES[w]}`
}
// 'YYYY-MM-DD' → 'M月D日'
function shortMdOf(ds) {
  if (!ds) return ''
  const p = ds.split('-').map(Number)
  return p[1] + '月' + p[2] + '日'
}
// 'YYYY-MM-DD' → 'M/D'
function shortDmOf(ds) {
  if (!ds) return ''
  const p = ds.split('-').map(Number)
  return p[1] + '/' + p[2]
}
// 日期 → 距 epoch 的天数（UTC 对齐 dayNumToDs）
function dayNumOf(ds) {
  const p = ds.split('-').map(Number)
  return Math.floor(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000)
}
function dayNumToDs(n) {
  const d = new Date(n * 86400000)
  return toDs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}
function dsAddDays(ds, n) {
  const p = ds.split('-').map(Number)
  const d = new Date(p[0], p[1] - 1, p[2] + n)
  return toDs(d.getFullYear(), d.getMonth() + 1, d.getDate())
}
function fmtMin(min) {
  return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60)
}
// 'HH:MM' → 当日分钟数
function timeToMin(tt) {
  const p = String(tt).split(':')
  return Number(p[0]) * 60 + Number(p[1] || 0)
}
// 手动时间对齐到 15 分钟档；1440 = 次日 00:00 边界
function quant15(min) {
  let v = Math.round(min / STEP) * STEP
  if (v < 0) v = 0
  if (v > 1440) v = 1440
  return v
}
function durTextOf(min) {
  if (!min || min <= 0) return '--'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h >= 24) {
    const d = Math.floor(h / 24)
    const hh = h % 24
    if (hh && m) return d + ' 天 ' + hh + ' 小时 ' + m + ' 分钟'
    if (hh) return d + ' 天 ' + hh + ' 小时'
    if (m) return d + ' 天 ' + m + ' 分钟'
    return d + ' 天'
  }
  if (h && m) return h + ' 小时 ' + m + ' 分钟'
  if (h) return h + ' 小时'
  return m + ' 分钟'
}
// 半开区间 [sAbs, eAbs) 按日拆分 → [{ds, from, to}]
function segsBetween(sAbs, eAbs) {
  const segs = []
  let ds = dayNumToDs(Math.floor(sAbs / 1440))
  let from = sAbs % 1440
  let rem = eAbs - sAbs
  let guard = 0
  while (rem > 0 && guard++ < 40) {
    const to = Math.min(1440, from + rem)
    segs.push({ ds, from, to })
    rem -= to - from
    from = 0
    ds = dsAddDays(ds, 1)
  }
  return segs
}

// ── 占用时段（/api/deviceApply 的 apply）──
// 把一段「绝对分钟」区间按日拆分后写入 occByDs（跨天拆成天头天尾），返回写入的段数
function addOccSeg(occByDs, sAbs, eAbs) {
  if (!(eAbs > sAbs)) return 0
  const segs = segsBetween(sAbs, eAbs)
  segs.forEach(seg => {
    const arr = occByDs[seg.ds] || (occByDs[seg.ds] = [])
    arr.push([seg.from, seg.to])
  })
  return segs.length
}

// apply 集合 → 占用段（写入 occByDs），返回条数
// 字段：{ begin_at: 'YYYY-MM-DD HH:mm:ss', finish_at: … }（秒位忽略，按 15 分钟档对齐）
function ingestApplyOcc(occByDs, applyArr) {
  if (!Array.isArray(applyArr)) return 0
  const ts = (s) => {
    if (s == null) return null
    const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/)
    return m ? { ds: m[1], tt: m[2] } : null
  }
  let n = 0
  applyArr.forEach(row => {
    if (!row || typeof row !== 'object') return
    const a = ts(row.begin_at != null ? row.begin_at : row.beginAt)
    const b = ts(row.finish_at != null ? row.finish_at : row.finishAt)
    if (!a || !b) return
    const sAbs = dayNumOf(a.ds) * 1440 + timeToMin(a.tt)
    const eAbs = dayNumOf(b.ds) * 1440 + timeToMin(b.tt)
    if (addOccSeg(occByDs, sAbs, eAbs)) n++
  })
  return n
}

// ── 禁用时段（/api/deviceApply 的 disableList）──
// 取值：兼容顶层 / device 包裹、驼峰 / 下划线；取第一个非空对象（数组或按日期分组的对象）
function pickDisableSrc(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {}
  const dev = (d.device && typeof d.device === 'object') ? d.device : {}
  return [
    d.disableList, d.disable_list, d.disable, d.disables,
    dev.disableList, dev.disable_list, dev.disable
  ].find(v => v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) || null
}

// 禁用数据 → { map: { 'YYYY-MM-DD': [[fromMin, toMin], …] }, count }
//   形态① 按日期分组：{ '2026-10-27': [ { begin_at, finish_at, disable, … } ] }
//   形态② 扁平数组：  [ { begin_at, finish_at, … } ]（按 begin_at 的日期归组）
//   disable=false 视为该条已取消；跨天的记到起始日并延伸到当天 24:00
function parseDisableSegs(src) {
  const map = {}
  let count = 0
  const ts = (s) => {
    if (s == null) return null
    const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/)
    return m ? { ds: m[1], tt: m[2] } : null
  }
  const pushOne = (dsHint, row) => {
    if (!row || typeof row !== 'object') return
    const flag = row.disable
    if (flag === false || flag === 0 || flag === '0' || flag === 'false') return
    const a = ts(row.begin_at != null ? row.begin_at : row.beginAt)
    const b = ts(row.finish_at != null ? row.finish_at : row.finishAt)
    const ds = dsHint || (a ? a.ds : '')
    if (!ds) return
    const from = a ? timeToMin(a.tt) : 0
    const to = (b && b.ds === ds) ? timeToMin(b.tt) : 1440
    if (to <= from) return
    const arr = map[ds] || (map[ds] = [])
    arr.push([from, to])
    count++
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
  return { map, count }
}

// /api/deviceApply 返回数据 → 预约页 detail 结构
// 字段命名与 /api/deviceList 保持一致：
//   need_appointment（1=需预约）/ need_check（1=需审批）/ power_state（1=开机 0=空闲）/
//   company（所在单位）/ organ_name（机构名称）
// 价格兼容：数组（含 cat/self/entrust）/ selfPrice·entrustPrice 等单值字段
// 时长规则兼容：bookRule/book_rule（min/rec/max/closedHours）或 minDuration 等单值字段
function buildDetailFromApply(id, data) {
  const d = (data && typeof data === 'object') ? data : {}
  // 支持点号路径（如 'device.name'）以兼容后端将字段嵌套在 device 对象下的返回结构；
  // 兼容点号：先在原始 d 上查，再在 d.device 上查（约定：deviceApply 返回 { device: { ... } }）
  const pick = (...keys) => {
    const tryPath = (obj, path) => {
      const segs = String(path || '').split('.').filter(Boolean)
      let cur = obj
      for (let i = 0; i < segs.length; i++) {
        if (cur == null || typeof cur !== 'object') return undefined
        cur = cur[segs[i]]
      }
      return (cur !== undefined && cur !== null && cur !== '') ? cur : undefined
    }
    for (const k of keys) {
      let v = tryPath(d, k)
      if (v === undefined && d.device && typeof d.device === 'object') v = tryPath(d.device, k)
      if (v !== undefined) return v
    }
    return undefined
  }
  const toBool = v => v === true || v === 1 || v === '1' || v === 'true'
  const toInt = (v, def) => {
    const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10)
    return isNaN(n) ? def : n
  }
  const name = String(pick('device.name', 'name', 'deviceName', 'devName') || '').trim() || '未知仪器'
  const company = String(pick('company', 'lab', 'labName') || '').trim()
  const organ = String(pick('organName', 'organ_name') || '').trim()
  const psRaw = pick('power_state', 'powerState')
  const on = psRaw !== undefined && Number(psRaw) === 1
  // 价格
  // 新接口约定：device 一次性返回 6 个价格（price1~price6），对应 所内/所外/院外 × 自助/委托
  //   price1 = 所内自助上机     price2 = 所内平台委托
  //   price3 = 所外自助上机     price4 = 所外平台委托
  //   price5 = 院外自助上机     price6 = 院外平台委托
  // 展示页按当前用户 dept_type 选其中一对展示（两个选项不变：自助 / 委托）
  // 兼容旧接口：仍支持 price 数组 / selfPrice+entrustPrice 等单值字段
  const p1 = toInt(pick('price1', 'price_1'), 0)
  const p2 = toInt(pick('price2', 'price_2'), 0)
  const p3 = toInt(pick('price3', 'price_3'), 0)
  const p4 = toInt(pick('price4', 'price_4'), 0)
  const p5 = toInt(pick('price5', 'price_5'), 0)
  const p6 = toInt(pick('price6', 'price_6'), 0)
  // 兜底：旧字段（用于本地演示数据 / 老接口）
  let selfY = 0
  let entY = 0
  const priceRaw = d.price || d.fee || d.cost
  if (Array.isArray(priceRaw) && priceRaw.length) {
    const row = priceRaw.find(r => r && (r.cat === '院内' || r.category === '院内')) || priceRaw[0] || {}
    selfY = toInt(row.self != null ? row.self : row.selfPrice, 0)
    entY = toInt(row.entrust != null ? row.entrust : row.entrustPrice, 0)
  } else {
    selfY = toInt(pick('selfPrice', 'self_price', 'price'), 0)
    entY = toInt(pick('entrustPrice', 'entrust_price', 'entrustFee', 'entrust_fee'), 0)
  }
  // 6 价兜底：若 price1~6 都拿不到（>0），则回退用 selfY/entY（保留旧逻辑）
  const priceMap = {
    suonei: { self: p1 || selfY, entrust: p2 || entY },  // 所内
    suowai: { self: p3 || selfY, entrust: p4 || entY },  // 所外
    yuanwai: { self: p5 || selfY, entrust: p6 || entY }  // 院外
  }
  // 时长规则（缺省：最短 60 / 推荐 120 / 无上限）
  // 字段顺序：接口新字段（minUsingTime/usingTime/maxUsingTime）优先，向后兼容旧字段
  const br = (d.bookRule && typeof d.bookRule === 'object') ? d.bookRule
    : ((d.book_rule && typeof d.book_rule === 'object') ? d.book_rule : {})
  const rMin = Math.max(STEP, toInt(br.min != null ? br.min : pick('minUsingTime', 'minDuration', 'min_duration'), 60) || 60)
  const rRec = toInt(br.rec != null ? br.rec : pick('usingTime', 'recDuration', 'rec_duration'), 120) || 120
  const rMax = toInt(br.max != null ? br.max : pick('maxUsingTime', 'maxDuration', 'max_duration'), 0)
  const closedHours = Array.isArray(br.closedHours)
    ? br.closedHours.map(Number).filter(h => h >= 0 && h < 24)
    : (Array.isArray(d.closedHours) ? d.closedHours.map(Number) : [])
  // 展示用「原始分钟数」（直接取自接口字段；空值/0 → null，前端 wxml 渲染为「不限」）
  // 注意：此处的 raw* 与上面带默认值的 rMin/rRec/rMax 完全独立，避免默认值覆盖空值语义
  const rawMin = pick('minUsingTime')
  const rawRec = pick('usingTime')
  const rawMax = pick('maxUsingTime')
  const toDisplayNum = (v) => {
    if (v == null || v === '') return null
    const n = parseInt(String(v).replace(/[^\d]/g, ''), 10)
    return (!isNaN(n) && n > 0) ? n : null
  }
  return {
    id: String(id),
    name,
    icon: String(pick('icon', 'emoji') || '').trim() || '🔬',
    lab: company || organ || '--',
    needBook: toBool(pick('need_appointment', 'needAppointment')),
    needApprove: toBool(pick('need_check', 'needCheck')),
    status: on ? 'online' : 'idle',
    statusText: on ? '开机' : '空闲',
    price: [
      { cat: '院内', self: '¥' + selfY, entrust: '¥' + entY },
      { cat: '院外', self: '¥' + selfY, entrust: '¥' + entY },
      { cat: '所外', self: '¥' + selfY, entrust: '¥' + entY }
    ],
    bookRule: { min: rMin, rec: rRec, max: rMax, closedHours },
    // 展示字段：null = 接口未提供 / 0 / 空 → 前端渲染「不限」
    minDurNum: toDisplayNum(rawMin),
    recDurNum: toDisplayNum(rawRec),
    maxDurNum: toDisplayNum(rawMax),
    // 6 价格（按所内/所外/院外 × 自助/委托 索引）；onLoad 根据用户 dept_type 选用
    priceMap
  }
}

Page({
  data: {
    detail: null,
    // ① 月历
    year: 0,
    month: 0,
    canPrev: false,
    canNext: false,
    weekTitles: WEEK_TITLES,
    days: [],
    // 当前查看日
    dateDs: '',
    dateLabel: '',
    // ② 时段网格（当前查看日）
    timeGroups: [],
    // 起止选择（半开区间）
    startDs: '',
    startMin: -1,
    startText: '',
    startVal: '09:00',
    endDs: '',
    endMin: -1,
    endText: '',
    endVal: '09:00',
    durMin: 0,
    durText: '--',
    occDays: 0,
    canSubmit: false,
    selTip: '点击空闲格设定开始时刻',
    selReady: false,
    // 时长规则展示（分钟数值：至少 / 推荐 / 最大）
    ruleMin: 0,
    ruleRec: 0,
    ruleMax: 0,
    // 接口原始时长字段（minUsingTime/usingTime/maxUsingTime，null 时前端展示「不限」）
    minDurNum: null,
    recDurNum: null,
    maxDurNum: null,
    // 计费
    mode: 'self',
    modeName: '自助',
    selfPrice: 0,
    entrustPrice: 0,
    costText: '--',
    costSub: '请先选择预约时段',
    // 当前价格所属用户类别（所内 / 所外 / 院外），按登录用户的 dept_type 计算
    priceCat: '所内',
    // 测试信息（选填）
    purpose: '',
    contentQty: '',
    remark: ''
  },

  onLoad(options) {
    const id = options && options.id
    // 首屏：优先用缓存的 /api/deviceApply 数据渲染（由仪器列表 / 详情入口写入），
    // 无缓存（如旧入口直达）时回退本地演示数据；
    // 无论有没有缓存，页面进来都会再请求一次 /api/deviceApply 拿最新占用与禁用
    let detail = null
    // deviceApplyCache 提到外层作用域，供下方「apply 占用集合」读取使用，
    // 这样既能拿到 deviceApply 数据渲染预约页，又能把它携带的占时段同时画进时段表。
    let deviceApplyCache = null
    try {
      deviceApplyCache = wx.getStorageSync(DEVICE_APPLY_KEY)
      if (deviceApplyCache && String(deviceApplyCache.deviceId) === String(id || '') && deviceApplyCache.data) {
        detail = buildDetailFromApply(id, deviceApplyCache.data)
        console.log('[instrument-book] 使用 /api/deviceApply 数据渲染：', detail)
      }
    } catch (e) { /* 忽略缓存异常 */ }
    if (!detail) detail = findInstrument(id)
    if (!detail) {
      wx.showToast({ title: '未找到该仪器', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 900)
      return
    }
    this.detail = detail
    const t = todayInfo()
    const todayDs = toDs(t.y, t.m, t.d)
    const br = detail.bookRule || {}
    this.closedHours = (br.closedHours || []).map(Number).filter(h => h >= 0 && h < 24)
    this.rMin = Math.max(STEP, br.min || 0)
    this.rRec = br.rec || 0
    const rMaxRaw = br.max || 0
    this.rMaxOpen = rMaxRaw <= 0
    this.rEffMax = this.rMaxOpen ? DAYS_CAP * 1440 : Math.max(this.rMin, rMaxRaw)
    this.nowAbs = dayNumOf(todayDs) * 1440 + t.h * 60 + t.min
    this.maxAbs = dayNumOf(dsAddDays(todayDs, MAX_AHEAD)) * 1440 // 结束不得晚于展望末日 24:00
    // 占用时段（按 ds 分组，每项是一组 [fromMin, toMin] 区间）
    // 唯一来源：/api/deviceApply 的 apply；渲染时进入 cellsOfDay → 'occ'（已占用），不可点选
    this.occByDs = {}
    // 禁用时段（/api/deviceApply.disableList，按 ds 分组）：渲染时标为 'off'（禁用色），不可点选
    this.banByDs = {}
    // apply 集合（他人/系统已占用的时段）
    // 字段约定：每项 { begin_at: 'YYYY-MM-DD HH:mm:ss', finish_at: 'YYYY-MM-DD HH:mm:ss', ... }
    // 兼容存放位置：cached.data.apply（顶层）或 cached.data.device.apply（设备包裹内）
    if (deviceApplyCache && deviceApplyCache.data) {
      const raw = deviceApplyCache.data
      const applyArr = Array.isArray(raw.apply) ? raw.apply
        : (Array.isArray(raw.device && raw.device.apply) ? raw.device.apply : null)
      const _applied = ingestApplyOcc(this.occByDs, applyArr)
      if (_applied > 0) {
        console.log('[instrument-book] 接入 /api/deviceApply.apply 占用：共', _applied, '条')
      }
      // 来源③ disableList：禁用时段（管理员在「预约调整」里设置的）
      // 落到 cellsOfDay → 'off'（禁用色），整天禁用时日历上也标出来
      const disSrc = pickDisableSrc(raw)
      if (disSrc) {
        const parsed = parseDisableSegs(disSrc)
        this.banByDs = parsed.map
        if (parsed.count) {
          console.log('[instrument-book] 接入 /api/deviceApply.disableList 禁用段：共', parsed.count,
            '条 /', Object.keys(this.banByDs).length, '天')
        }
      }
    }
    this.dayCells = {}
    // 进入页面就拉一次最新数据（占用 + 禁用）：缓存只用于首屏，不能因为「有缓存」就不请求，
    // 否则会看到旧数据（表现为「有时候不请求接口」）
    if (detail.id != null && String(detail.id) !== '') {
      this._loadApplyRemote(detail.id)
    }
    // 价格选择：根据用户 dept_type 从 detail.priceMap（所内/所外/院外 × 自助/委托）中选一对
    //   所内（dept_type=1 或 '所内'）→ price1 (self) / price2 (entrust)
    //   所外（dept_type=2 或 '所外'）→ price3 (self) / price4 (entrust)
    //   院外（dept_type=3 或 '院外'）→ price5 (self) / price6 (entrust)
    // dept_type 缺失/未知 → 默认按「所内」展示，避免空价
    const user = getLoginUser() || {}
    const deptType = user.dept_type != null ? user.dept_type : user.deptType
    const dt = (deptType != null) ? String(deptType).trim() : ''
    let priceKey = 'suonei'   // 默认所内
    if (dt === '1' || dt === '所内') priceKey = 'suonei'
    else if (dt === '2' || dt === '所外') priceKey = 'suowai'
    else if (dt === '3' || dt === '院外') priceKey = 'yuanwai'
    // 优先用新接口的 6 价映射；旧接口或本地兜底（detail.priceMap 为空/缺）时回退 detail.price 数组
    const pmap = (detail.priceMap && (detail.priceMap[priceKey] || detail.priceMap.suonei)) || null
    let pickedSelf = 0
    let pickedEntrust = 0
    if (pmap && (pmap.self || pmap.entrust)) {
      pickedSelf = parseInt(String(pmap.self || 0).replace(/[^\d]/g, ''), 10) || 0
      pickedEntrust = parseInt(String(pmap.entrust || 0).replace(/[^\d]/g, ''), 10) || 0
    } else {
      // 旧价格数组兜底：取「院内」行（旧逻辑，可能与新 6 价不完全一致但保证不空）
      const row = (detail.price || []).find(r => r && (r.cat === '院内' || r.category === '院内')) || (detail.price || [])[0] || {}
      pickedSelf = parseInt(String(row.self || 0).replace(/[^\d]/g, ''), 10) || 0
      pickedEntrust = parseInt(String(row.entrust || 0).replace(/[^\d]/g, ''), 10) || 0
    }
    this.selfY = pickedSelf
    this.entY = pickedEntrust
    this.priceKey = priceKey  // 保留供后续 wxml / submit 使用
    this.priceCat = priceKey === 'suonei' ? '所内' : priceKey === 'suowai' ? '所外' : '院外'
    // 查看日默认今天（接近零点则顺延到明天，避免整屏禁用）
    const lateNight = t.h * 60 + t.min >= 23 * 60 + 45
    this.vd = lateNight ? dsAddDays(todayDs, 1) : todayDs
    // 默认查看日若整天被禁用，顺延到之后第一个未禁用的日期（最多往后找 30 天）
    if (this.isDayBanned(this.vd)) {
      for (let i = 1; i <= 30; i++) {
        const cand = dsAddDays(this.vd, i)
        if (cand > dsAddDays(todayDs, MAX_AHEAD)) break
        if (!this.isDayBanned(cand)) { this.vd = cand; break }
      }
    }
    this.sel = { startDs: '', startMin: -1, endDs: '', endMin: -1 }
    const cal = this.buildCal(t.y, t.m)
    this.cal = { y: cal.y, m: cal.m }
    // 展示用「原始分钟数」：API 路径（buildDetailFromApply）已经写入 detail.*DurNum；
    // 本地兜底（findInstrument）没这些字段（undefined）时回退用 bookRule 的值（>0 才用，否则 null → 前端显示「不限」）
    // 关键：必须用 !== undefined 而不是 != null —— API 路径下「字段为空」= null，应保留 null 让前端显示「不限」，
    // 不能回退到 bookRule 的默认值 60，否则会出现「接口未传 minUsingTime 却显示 60 分钟」的错乱。
    const toNumOrNull = (v) => {
      const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10)
      return (!isNaN(n) && n > 0) ? n : null
    }
    const minDurNum = (detail.minDurNum !== undefined) ? detail.minDurNum : toNumOrNull(detail.bookRule && detail.bookRule.min)
    const recDurNum = (detail.recDurNum !== undefined) ? detail.recDurNum : toNumOrNull(detail.bookRule && detail.bookRule.rec)
    const maxDurNum = (detail.maxDurNum !== undefined) ? detail.maxDurNum : toNumOrNull(detail.bookRule && detail.bookRule.max)
    this.setData({
      detail,
      year: cal.y,
      month: cal.m,
      canPrev: cal.canPrev,
      canNext: cal.canNext,
      days: cal.days,
      dateDs: this.vd,
      dateLabel: dateLabelOf(this.vd),
      selfPrice: this.selfY,
      entrustPrice: this.entY,
      ruleMin: this.rMin,
      ruleRec: this.rRec || 0,
      ruleMax: this.rEffMax,
      minDurNum,
      recDurNum,
      maxDurNum,
      // 当前价格所属用户类别（所内/所外/院外），用于 wxml 底部「预估费用 · XX」展示
      priceCat: this.priceCat
    })
    this.applySel(this.sel)
    wx.setNavigationBarTitle({ title: '预约时段' })
  },

  /* ═══════════ 日历 ═══════════ */
  // 某日是否整天被禁用：把当天的禁用段合并后，看是否覆盖 00:00 ~ 24:00
  isDayBanned(ds) {
    const segs = (this.banByDs && this.banByDs[ds]) || []
    if (!segs.length) return false
    const sorted = segs.slice().sort((a, b) => a[0] - b[0])
    let cur = 0
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i][0] > cur) return false
      cur = Math.max(cur, sorted[i][1])
      if (cur >= 1440) return true
    }
    return false
  },

  // 生成 y 年 m 月网格：td 今天 / sel 当前查看日（选中高亮）/ dis 不可约 / ban 整天禁用
  buildCal(y, m) {
    const t = todayInfo()
    const todayDs = toDs(t.y, t.m, t.d)
    const maxDs = dsAddDays(todayDs, MAX_AHEAD)
    const first = new Date(y, m - 1, 1)
    const lead = first.getDay()
    const dim = new Date(y, m, 0).getDate()
    const days = []
    let id = 0
    for (let i = 0; i < lead; i++) days.push({ id: id++, blank: true, d: '' })
    for (let d = 1; d <= dim; d++) {
      const ds = toDs(y, m, d)
      days.push({
        id: id++,
        d,
        ds,
        dis: ds < todayDs || ds > maxDs,
        td: ds === todayDs,
        sel: ds === this.vd,
        // 整天被禁用（disableList 覆盖 00:00~24:00）→ 日历上标出来，且不可选
        ban: this.isDayBanned(ds),
        in: false,
        atStart: false,
        atEnd: false
      })
    }
    while (days.length % 7) days.push({ id: id++, blank: true, d: '' })
    this.markRange(days)
    const canPrev = !(y === t.y && m === t.m)
    const nextFirst = toDs(new Date(y, m, 1).getFullYear(), new Date(y, m, 1).getMonth() + 1, 1)
    const canNext = nextFirst <= maxDs
    return { y, m, days, canPrev, canNext }
  },

  // 区间标记：边界（起/止）与中间整天
  markRange(list) {
    const s = this.sel
    const has = s && s.startMin >= 0 && s.startDs
    if (!has) return
    const sd = dayNumOf(s.startDs)
    const ed = s.endMin >= 0 && s.endDs ? dayNumOf(s.endDs) : sd
    list.forEach(it => {
      if (it.blank || !it.ds) return
      const dn = dayNumOf(it.ds)
      if (dn === sd && dn === ed) { it.atStart = true; it.atEnd = true }
      else if (dn === sd) it.atStart = true
      else if (dn === ed) it.atEnd = true
      else if (dn > sd && dn < ed) it.in = true
    })
  },

  // 渲染日历时序由 sel / vd 变化触发
  renderCal() {
    const cal = this.buildCal(this.cal.y, this.cal.m)
    this.cal = { y: cal.y, m: cal.m }
    this.setData({ year: cal.y, month: cal.m, canPrev: cal.canPrev, canNext: cal.canNext, days: cal.days })
  },

  onPrevMonth() {
    if (!this.data.canPrev) return
    this.cal = { y: this.cal.m === 1 ? this.cal.y - 1 : this.cal.y, m: this.cal.m === 1 ? 12 : this.cal.m - 1 }
    this.renderCal()
  },

  onNextMonth() {
    if (!this.data.canNext) return
    this.cal = { y: this.cal.m === 12 ? this.cal.y + 1 : this.cal.y, m: this.cal.m === 12 ? 1 : this.cal.m + 1 }
    this.renderCal()
  },

  // 点某日 → 仅切换「查看日」，网格展示该日占用形态
  onPickDate(e) {
    const ds = e.currentTarget.dataset.ds
    if (!ds || ds === this.vd) return
    const t = todayInfo()
    const todayDs = toDs(t.y, t.m, t.d)
    const maxDs = dsAddDays(todayDs, MAX_AHEAD)
    if (ds < todayDs || ds > maxDs) {
      wx.showToast({ title: '该日期不可预约', icon: 'none' })
      return
    }
    // 该日期整天被禁用 → 不允许切换过去
    if (this.isDayBanned(ds)) {
      wx.showToast({ title: '该日期已禁用，请选择其它日期', icon: 'none' })
      return
    }
    this.vd = ds
    this.applySel(this.sel)
  },

  /* ═══════════ 档位状态（空闲/禁用/已占用） ═══════════ */
  // 某日 96 档基础状态：idle 可约 / off 禁用（已过·维护）/ occ 已占用
  cellsOfDay(ds) {
    const arr = new Array(CELLS).fill('idle')
    const t = todayInfo()
    const todayDs = toDs(t.y, t.m, t.d)
    if (ds < todayDs) return arr.fill('off')
    if (ds === todayDs) {
      const nowMin = t.h * 60 + t.min
      for (let i = 0; i < CELLS; i++) {
        if (i * STEP < nowMin) arr[i] = 'off'
      }
    }
    ;(this.closedHours || []).forEach(h => {
      const s = h * 4
      const e = s + 4
      for (let i = s; i < e && i < CELLS; i++) arr[i] = 'off'
    })
    ;(this.occByDs[ds] || []).forEach(seg => {
      const ks = Math.floor(seg[0] / STEP)
      const ke = Math.ceil(seg[1] / STEP)
      for (let k = ks; k < ke; k++) {
        if (arr[k] === 'idle') arr[k] = 'occ'
      }
    })
    // 禁用时段（/api/deviceApply.disableList）：落在其中的档位统一显示「禁用」色，
    // 优先级高于「已占用」（禁用是管理员的硬约束，不可预约）
    ;((this.banByDs && this.banByDs[ds]) || []).forEach(seg => {
      const ks = Math.max(0, Math.floor(seg[0] / STEP))
      const ke = Math.min(CELLS, Math.ceil(seg[1] / STEP))
      for (let k = ks; k < ke; k++) arr[k] = 'off'
    })
    return arr
  },

  cellsOf(ds) {
    if (!this.dayCells[ds]) this.dayCells[ds] = this.cellsOfDay(ds)
    return this.dayCells[ds]
  },

  // 拉一次 /api/deviceApply（只读，不写缓存），以接口为准回填占用与禁用
  //   进入页面必调：缓存只用于首屏，接口回来后再覆盖，避免「有缓存就不请求」看到旧数据
  //   占用（apply）与禁用（disableList）都按接口重建，不再依赖任何本地/模拟占用
  _loadApplyRemote(id) {
    if (!id || this._remoteLoading) return
    this._remoteLoading = true
    getDeviceApply(id)
      .then(data => {
        this._remoteLoading = false
        const raw = (data && typeof data === 'object') ? data : {}
        const applyArr = Array.isArray(raw.apply) ? raw.apply
          : (Array.isArray(raw.device && raw.device.apply) ? raw.device.apply : [])
        // 以接口为准：先清空再回填（缓存里的占用不能与接口结果叠加，否则会重复/过期）
        this.occByDs = {}
        const applied = ingestApplyOcc(this.occByDs, applyArr)
        const src = pickDisableSrc(raw)
        const parsed = src ? parseDisableSegs(src) : { map: {}, count: 0 }
        this.banByDs = parsed.map
        console.log('[instrument-book] /api/deviceApply 回填：占用', applied, '条；禁用',
          parsed.count, '条 /', Object.keys(this.banByDs).length, '天')
        // 重算受影响视图：日历（整天禁用标记）+ 当前查看日的时段表
        this.dayCells = {}
        this.renderCal()
        if (this.sel) this.applySel(this.sel)
      })
      .catch(err => {
        this._remoteLoading = false
        console.warn('[instrument-book] /api/deviceApply 失败：', err)
      })
  },

  /* ═══════════ 区间校验与选择 ═══════════ */
  checkRange(sAbs, eAbs) {
    if (eAbs <= sAbs) return { ok: false, msg: '结束时刻需晚于开始时刻' }
    const dur = eAbs - sAbs
    if (dur < this.rMin) return { ok: false, msg: '时长不足，最短 ' + durTextOf(this.rMin).replace(/\s/g, '') }
    if (dur > this.rEffMax) {
      return { ok: false, msg: '单次最长 ' + (this.rMaxOpen ? DAYS_CAP + ' 天' : durTextOf(this.rEffMax).replace(/\s/g, '')) }
    }
    if (sAbs < this.nowAbs) return { ok: false, msg: '开始时刻已过，请选择稍后时段' }
    if (eAbs > this.maxAbs) return { ok: false, msg: '超出可预约范围（' + MAX_AHEAD + ' 天内）' }
    const segs = segsBetween(sAbs, eAbs)
    for (let i = 0; i < segs.length; i++) {
      const cur = this.cellsOf(segs[i].ds)
      const ks = Math.floor(segs[i].from / STEP)
      const ke = Math.ceil(segs[i].to / STEP)
      for (let k = ks; k < ke && k < CELLS; k++) {
        if (cur[k] !== 'idle') return { ok: false, msg: '时段与已占用或禁用时段冲突，请调整' }
      }
    }
    return { ok: true }
  },

  // 从起点向后取「默认推荐时长」的可用终点（撞禁用/占用即回退到边界前）
  autoEnd(sAbs) {
    const want = this.rRec > 0 ? this.rRec : 60
    let cand = sAbs + want
    if (cand > sAbs + this.rEffMax) cand = sAbs + this.rEffMax
    if (cand > this.maxAbs) cand = this.maxAbs
    while (cand > sAbs) {
      if (cand - sAbs >= this.rMin && this.checkRange(sAbs, cand).ok) return cand
      cand -= STEP
    }
    return -1
  },

  // 统一写入选择并刷新全页
  applySel(sel, toast) {
    this.sel = sel
    const sAbs = sel.startMin >= 0 && sel.startDs ? dayNumOf(sel.startDs) * 1440 + sel.startMin : -1
    const eAbs = sel.endMin >= 0 && sel.endDs ? dayNumOf(sel.endDs) * 1440 + sel.endMin : -1
    const dur = eAbs > sAbs ? eAbs - sAbs : 0
    const occDays = eAbs > sAbs ? segsBetween(sAbs, eAbs).length : 0
    const ready = eAbs > sAbs
    let tip = '点击空闲格，自动按推荐时长选中'
    if (sAbs >= 0 && !ready) {
      tip = '起点已设 ' + shortDmOf(sel.startDs) + ' ' + fmtMin(sel.startMin) + ' · 结束时刻请用下方时间调整'
    } else if (ready) {
      tip = '本次占用 ' + occDays + ' 天：' + shortDmOf(sel.startDs) + ' ' + fmtMin(sel.startMin) +
        ' ~ ' + shortDmOf(sel.endDs) + ' ' + fmtMin(sel.endMin)
      if (occDays > 1 && this.vd !== sel.startDs && this.vd !== sel.endDs) {
        tip += ' · 本日整天处于区间内'
      }
    }
    const patch = {
      startDs: sel.startDs,
      startMin: sel.startMin,
      startText: sAbs >= 0 ? fmtMin(sel.startMin) : '',
      startVal: sAbs >= 0 ? fmtMin(sel.startMin) : '09:00',
      endDs: sel.endDs,
      endMin: sel.endMin,
      endText: eAbs >= 0 ? fmtMin(sel.endMin) : '',
      endVal: eAbs >= 0 ? fmtMin(sel.endMin) : '09:00',
      durMin: dur,
      durText: dur > 0 ? durTextOf(dur) : '--',
      occDays,
      canSubmit: ready && this.checkRange(sAbs, eAbs).ok,
      selTip: tip,
      selReady: ready,
      timeGroups: this.gridOf(this.vd),
      dateDs: this.vd,
      dateLabel: dateLabelOf(this.vd)
    }
    this.setData(patch)
    if (toast) wx.showToast({ title: toast, icon: 'none' })
    this.refreshCost(dur)
    // 重建日历，让「当前查看日」高亮（sel）随选择/切日移动
    this.renderCal()
  },

  // 当前查看日网格：base 状态 + 区间高亮（sel 只盖在空闲上，含跨天部分）
  gridOf(ds) {
    const view = this.cellsOf(ds).slice()
    const s = this.sel
    if (s && s.startMin >= 0 && s.startDs) {
      const dAbs0 = dayNumOf(ds) * 1440
      const sAbs = dayNumOf(s.startDs) * 1440 + s.startMin
      const eAbs = s.endMin >= 0 && s.endDs ? dayNumOf(s.endDs) * 1440 + s.endMin : -1
      if (eAbs > dAbs0 && sAbs < dAbs0 + 1440) {
        const a = Math.max(sAbs, dAbs0) - dAbs0
        const b = Math.min(eAbs, dAbs0 + 1440) - dAbs0
        for (let i = 0; i < CELLS; i++) {
          const cs = i * STEP
          if (cs >= a && cs < b && view[i] === 'idle') view[i] = 'sel'
        }
      }
    }
    return this.buildGroups(view)
  },

  buildGroups(view) {
    const groups = []
    for (let g = 0; g < 4; g++) {
      const cols = []
      for (let h = g * 6; h < g * 6 + 6; h++) {
        const quads = []
        for (let q = 0; q < 4; q++) {
          const i = h * 4 + q
          if (i < CELLS) quads.push({ i, state: view[i] })
        }
        cols.push({ h, quads })
      }
      groups.push({ cols, cap: pad2(g * 6) + ':00–' + pad2(g * 6 + 6) + ':00' })
    }
    return groups
  },

  /* ═══════════ 时段点选 ═══════════ */
  // 点任一空闲格 = 以该时刻为新起点，自动按推荐时长选段（结束如需变更，用下方时间手动精调）
  onCell(e) {
    const i = Number(e.currentTarget.dataset.i)
    const cur = this.cellsOf(this.vd)
    const st = cur[i]
    if (st === 'occ') {
      wx.showToast({ title: '该时段已被占用，请另选', icon: 'none' })
      return
    }
    if (st === 'off') {
      // off 有两种来源：接口下发的禁用时段 / 已过或维护时间，提示区分开
      const min = i * STEP
      const banned = ((this.banByDs && this.banByDs[this.vd]) || [])
        .some(seg => min >= seg[0] && min < seg[1])
      wx.showToast({
        title: banned ? '该时段已禁用，请另选' : '该时段不可预约（已过/维护）',
        icon: 'none'
      })
      return
    }
    this.startAt(dayNumOf(this.vd) * 1440 + i * STEP)
  },

  // 以 sAbs 为新起点，向后取「推荐时长」终点（撞禁用/占用自动回退到边界前），覆盖原选择
  startAt(sAbs) {
    const end = this.autoEnd(sAbs)
    if (end < 0) {
      wx.showToast({ title: '该起点后无满足最短时长的连续空闲，请另选', icon: 'none' })
      return
    }
    this.applySel(this.segOf(sAbs, end))
  },

  // 移动起点：终点仍合法则保留，否则按默认时长重排
  moveStart(sAbs) {
    const cur = this.sel
    const eAbs = cur.endMin >= 0 && cur.endDs ? dayNumOf(cur.endDs) * 1440 + cur.endMin : -1
    if (eAbs > sAbs) {
      const chk = this.checkRange(sAbs, eAbs)
      if (chk.ok) {
        this.applySel(this.segOf(sAbs, eAbs))
        return
      }
    }
    const end = this.autoEnd(sAbs)
    if (end < 0) {
      wx.showToast({ title: '调整后无满足最短时长的连续空闲，已保留原选择', icon: 'none' })
      return
    }
    this.applySel(this.segOf(sAbs, end))
  },

  // 起点/终点绝对分钟 → {startDs,startMin,endDs,endMin}
  segOf(sAbs, eAbs) {
    const sd = Math.floor(sAbs / 1440)
    const ed = Math.floor((eAbs - 1) / 1440)
    return {
      startDs: dayNumToDs(sd),
      startMin: sAbs - sd * 1440,
      endDs: dayNumToDs(ed),
      endMin: eAbs - ed * 1440
    }
  },

  onClear() {
    this.sel = { startDs: '', startMin: -1, endDs: '', endMin: -1 }
    this.applySel(this.sel)
  },

  /* ═══════════ 手动调整（日期 / 时刻 picker） ═══════════ */
  // 未选起点时给默认时刻：今天取「现在+15 分钟对齐档」，未来日取 09:00
  defaultTimeOf(ds) {
    const t = todayInfo()
    const todayDs = toDs(t.y, t.m, t.d)
    let min = 9 * 60
    if (ds === todayDs) {
      min = Math.max(min, quant15(this.nowAbs % 1440 + 15))
    }
    return Math.min(min, 1440 - STEP)
  },

  onChangeStartDate(e) {
    const nds = e.detail.value
    const t = todayInfo()
    const todayDs = toDs(t.y, t.m, t.d)
    const maxDs = dsAddDays(todayDs, MAX_AHEAD)
    if (nds < todayDs || nds > maxDs) {
      wx.showToast({ title: '该日期不可预约', icon: 'none' })
      return
    }
    const sMin = this.sel.startMin >= 0 ? this.sel.startMin : this.defaultTimeOf(nds)
    this.vd = nds
    this.moveStart(dayNumOf(nds) * 1440 + sMin)
  },

  onChangeStart(e) {
    const min = quant15(timeToMin(e.detail.value))
    if (this.sel.startMin < 0) {
      this.startAt(dayNumOf(this.vd) * 1440 + min)
      return
    }
    this.moveStart(dayNumOf(this.sel.startDs) * 1440 + min)
  },

  onChangeEndDate(e) {
    if (this.sel.startMin < 0) return
    const nds = e.detail.value
    const t = todayInfo()
    const todayDs = toDs(t.y, t.m, t.d)
    if (nds < todayDs || nds > dsAddDays(todayDs, MAX_AHEAD)) {
      wx.showToast({ title: '该日期不可预约', icon: 'none' })
      return
    }
    const eMin = this.sel.endMin >= 0 ? this.sel.endMin : this.defaultTimeOf(nds)
    this.moveEnd(dayNumOf(nds) * 1440 + eMin)
  },

  onChangeEnd(e) {
    if (this.sel.startMin < 0) return
    const baseDs = this.sel.endDs || this.sel.startDs
    this.moveEnd(dayNumOf(baseDs) * 1440 + quant15(timeToMin(e.detail.value)))
  },

  moveEnd(eAbs) {
    const sAbs = dayNumOf(this.sel.startDs) * 1440 + this.sel.startMin
    const chk = this.checkRange(sAbs, eAbs)
    if (!chk.ok) {
      wx.showToast({ title: chk.msg, icon: 'none' })
      return
    }
    this.applySel(this.segOf(sAbs, eAbs))
  },

  /* ═══════════ 费用 / 计费 / 表单 ═══════════ */
  refreshCost(dur) {
    const unit = this.data.mode === 'self' ? this.selfY : this.entY
    if (dur > 0) {
      const fee = Math.round((unit * dur / 60) * 100) / 100
      this.setData({
        costText: '¥' + fee,
        costSub: durTextOf(dur).replace(/\s/g, '') + ' × ¥' + unit + ' / 小时'
      })
    } else {
      this.setData({ costText: '--', costSub: '请先选择预约时段' })
    }
  },

  onMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.mode) return
    this.setData({ mode, modeName: mode === 'self' ? '自助' : '委托' })
    this.refreshCost(this.data.durMin)
  },

  onPurposeInput(e) { this.setData({ purpose: e.detail.value }) },
  onContentInput(e) { this.setData({ contentQty: e.detail.value }) },
  onRemarkInput(e) { this.setData({ remark: e.detail.value }) },

  onSubmit() {
    const s = this.sel
    if (s.startMin < 0 || s.endMin < 0) {
      wx.showToast({ title: '请先选择开始与结束时段', icon: 'none' })
      return
    }
    const sAbs = dayNumOf(s.startDs) * 1440 + s.startMin
    const eAbs = dayNumOf(s.endDs) * 1440 + s.endMin
    const chk = this.checkRange(sAbs, eAbs)
    if (!chk.ok) {
      wx.showToast({ title: chk.msg, icon: 'none' })
      return
    }
    const d = this.detail
    const { purpose, contentQty, remark } = this.data
    const extra = []
    if (purpose.trim()) extra.push('测试目的：' + purpose.trim())
    if (contentQty.trim()) extra.push('测试内容及数量：' + contentQty.trim())
    if (remark.trim()) extra.push('备注：' + remark.trim())
    const rangeText = shortMdOf(s.startDs) + ' ' + fmtMin(s.startMin) + ' ~ ' + shortMdOf(s.endDs) + ' ' + fmtMin(s.endMin)
    const content =
      '仪器：' + d.name + '\n' +
      '时段：' + rangeText + '\n' +
      '时长：' + durTextOf(eAbs - sAbs) + '\n' +
      '方式：' + this.data.modeName + '\n' +
      '预估费用：' + this.data.costText + '\n' +
      (extra.length ? '\n' + extra.join('\n') + '\n\n' : '\n') +
      (d.needApprove ? '该仪器预约需管理员审批，提交后将等待审核。' : '提交后将自动确认，请按时上机。')
    wx.showModal({
      title: '确认提交预约',
      content,
      cancelText: '再想想',
      confirmText: '确认提交',
      confirmColor: '#0A7BB8',
      success: res => {
        if (!res.confirm) return
        // 构造 /api/doDeviceApply 请求体（按示例 payload 字段一一对应）
        const mode = this.data.mode
        // 当前计费模式的每小时价格（与 wxml 上 selfY/entY 的展示一致）
        const price = (mode === 'self') ? this.selfY : this.entY
        // 总费用 = 当前费用展示（costText 已带 ¥）；此处取纯数字部分，保留 2 位小数
        const amountNum = parseFloat(String(this.data.costText).replace(/[^\d.]/g, ''))
        const amount = isNaN(amountNum) ? 0 : Math.round(amountNum * 100) / 100
        // 时段格式：'YYYY-MM-DD HH:mm:00'（STEP=15 分钟对齐，秒位恒为 0）
        const startAt = s.startDs + ' ' + fmtMin(s.startMin) + ':00'
        const finishAt = s.endDs + ' ' + fmtMin(s.endMin) + ':00'
        // operateType：1=自助，2=委托（与示例 payload 值 2 对应委托模式；自助模式传 1）
        const operateType = (mode === 'self') ? 1 : 2
        const payload = {
          deviceId: d.id,
          startAt,
          finishAt,
          memo1: purpose.trim(),
          memo2: contentQty.trim(),
          memo3: remark.trim(),
          memo4: '',
          operateType,
          price,
          amount,
          unitCount: 1
        }
        wx.showLoading({ title: '提交中…', mask: true })
        doDeviceApply(payload)
          .then(() => {
            wx.hideLoading()
            // 后端提交成功 → 写入本地预约缓存，供「我的预约」列表展示
            addBooking({
              instId: d.id,
              instName: d.name,
              instIcon: d.icon,
              lab: d.lab,
              startDs: s.startDs,
              endDs: s.endDs,
              dateLabel: shortMdOf(s.startDs),
              endDateLabel: s.startDs === s.endDs ? '' : shortMdOf(s.endDs),
              rangeText,
              startText: fmtMin(s.startMin),
              endText: fmtMin(s.endMin),
              durText: durTextOf(eAbs - sAbs),
              modeName: this.data.modeName,
              costText: this.data.costText,
              purpose: purpose.trim(),
              contentQty: contentQty.trim(),
              remark: remark.trim(),
              needApprove: !!d.needApprove,
              status: d.needApprove ? 'pending' : 'confirmed'
            })
            wx.showToast({ title: d.needApprove ? '已提交，等待审批' : '预约成功', icon: 'success' })
            setTimeout(() => {
              wx.redirectTo({ url: '/pages/my-booking/index' })
            }, 900)
          })
          .catch(err => {
            wx.hideLoading()
            console.error('[instrument-book] /api/doDeviceApply 提交失败：', err)
            wx.showModal({
              title: '提交失败',
              content: (err && err.message) ? err.message : '预约提交失败，请稍后重试',
              showCancel: false,
              confirmText: '我知道了',
              confirmColor: '#0A7BB8'
            })
          })
      }
    })
  }
})
