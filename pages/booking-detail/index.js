// pages/booking-detail/index.js
// 预约详情页：通过 /api/deviceApplyDetail 获取一条预约记录的完整信息
// 主要展示分区：① 顶部预约单头（编号 + 状态）② 预约信息 ③ 测试信息 ④ 收费标准 ⑤ 管理员信息 ⑥ 资产与位置说明（精简）
// 数据来源：
//   ① /api/deviceApplyDetail 返回 BOOKING_DETAIL_KEY（首选，能拿到 memos/价格/管理员/资产等完整字段）
//   ② 本地 listBookings() 兜底（API 不可用或未实现时，至少能展示本地已有字段——仪器/时间/方式/费用/memos 映射）
const { BOOKING_DETAIL_KEY } = require('../../utils/api.js')
const { listBookings } = require('../../utils/bookings.js')
// 详情页状态映射：与「我的预约」共用一套数字枚举，标签文本与样式集中在 utils/bookingStatus.js
const { DETAIL_TAG, keyFromState } = require('../../utils/bookingStatus.js')

// 时长文案：把秒数转成「X 小时 Y 分钟」之类可读形式
function durOfSecs(sec) {
  const n = Number(sec)
  if (!isFinite(n) || n <= 0) return ''
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  if (h && m) return h + ' 小时 ' + m + ' 分钟'
  if (h) return h + ' 小时'
  return m + ' 分钟'
}

// 自动算时长：解析 'YYYY-MM-DD HH:mm:ss' 起止时间（兼容 'YYYY-MM-DDTHH:mm:ss' 或无秒） → 'X 小时 Y 分钟' / 'X 小时'
// 默认时段表按分钟对齐，没有秒信息也能稳算
function durOfTs(sTs, eTs) {
  if (!sTs || !eTs) return ''
  const parse = (s) => {
    const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/)
    if (!m) return null
    return {
      ds: m[1],
      h: Number(m[2]),
      mi: Number(m[3]),
      sec: Number(m[4] || 0)
    }
  }
  const a = parse(sTs), b = parse(eTs)
  if (!a || !b) return ''
  const toSec = (d) => dayNumOf(d.ds) * 86400 + d.h * 3600 + d.mi * 60 + d.sec
  const diff = toSec(b) - toSec(a)
  return diff > 0 ? durOfSecs(diff) : ''
}

// 内部工具：把日期串折算成绝对天数（与其它页面共用约定）
function dayNumOf(ds) {
  const m = String(ds || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return 0
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  // 与 instrument-book 保持一致的简化换算（UTC 偏移不影响日期级差值）
  return Math.floor((Date.UTC(y, mo - 1, d) - Date.UTC(1970, 0, 1)) / 86400000)
}

// 操作方式：1 自助 / 2 委托
const OPERATE_NAME = { 1: '自助', 2: '委托' }

// 把字符串格式化为金额字符串：6 → '¥6'；6.5 → '¥6.5'
function toYuan(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.]/g, ''))
  if (isNaN(n)) return ''
  return '¥' + (Math.round(n * 100) / 100)
}

Page({
  data: {
    detail: null,
    loading: true,
    errMsg: ''
  },

  onLoad(options) {
    const id = options && options.id
    // 优先使用 /api/deviceApplyDetail 写入缓存渲染（由「我的预约」列表点击触发）
    // 缓存失效时也保留接口，供将来直接通过链接进入（比如通知中心推送）使用
    if (!id) {
      this.setData({ loading: false, errMsg: '缺少预约编号' })
      return
    }
    let detail = null
    try {
      const cached = wx.getStorageSync(BOOKING_DETAIL_KEY)
      if (cached && String(cached.id) === String(id) && cached.data) {
        detail = buildDetailFromApplyDetail(id, cached.data)
        console.log('[booking-detail] 使用 /api/deviceApplyDetail 数据渲染：', detail)
      }
    } catch (e) { /* 忽略缓存异常 */ }
    // 兜底①：API 未命中缓存时，本地预约记录仍在 → 由 listBookings() 提供基础字段
    // 兜底②：API 入口调用失败时（onDetail 显式带上 ?local=1），主动走本地路径
    if (!detail) {
      try {
        const all = listBookings()
        const it = all.find(b => String(b.id) === String(id))
        if (it) {
          detail = buildDetailFromLocalBooking(id, it)
          console.log('[booking-detail] 使用本地 listBookings() 兜底渲染：', detail)
        }
      } catch (e) { /* 忽略本地读取异常 */ }
    }
    if (!detail) {
      this.setData({ loading: false, errMsg: '未找到该预约记录，可能已失效' })
      return
    }
    this.setData({ detail, loading: false, errMsg: '' })
    // 顶部标题直接走 index.json 的 navigationBarTitleText「预约详情」，
    // 不再用设备名覆盖（避免顶部 title 与页面卡片里的仪器名重复且喧宾夺主）
  },

  // 点击联系电话 → 呼出电话
  onCallPhone(e) {
    const phone = String(e.currentTarget.dataset.phone || '').replace(/[- ]/g, '')
    if (!phone) return
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => { /* 用户取消或环境不支持时静默 */ }
    })
  },

  // 预约时间调整：仅「待审核」可用 → 进入 pages/booking-adjust（带上仪器名，调整这台仪器的时段）
  onAdjustTime() {
    const d = this.data.detail
    if (!d) return
    const name = (d.device && d.device.name) || ''
    wx.navigateTo({
      url: '/pages/booking-adjust/index?name=' + encodeURIComponent(name),
      fail: err => console.error('[booking-detail] 跳转 /pages/booking-adjust/index 失败：', err)
    })
  }
})

// /api/deviceApplyDetail 返回数据 → 详情页 detail 结构
// 后端实际响应通常把字段嵌套在 device / admin / organ / apply 等子对象下：
//   {
//     device: { name, gallery, price1..price6, model, modelType, factory, factoryPrice,
//               buyAt, fundsFrom, serialNo, companyNo, address, ... },
//     admin:  { userName, phonenumber },
//     organ:  { name },
//     apply:  { id, status, begin_at, finish_at, operateType, price, amount, unitCount,
//               memo1, memo2, memo3, memo4, submitTime, ... }
//   }
// 这里参考 instrument-detail 中的 pick 实现：支持点号路径 + 自动回退到顶层对象
function buildDetailFromApplyDetail(id, data) {
  const d = (data && typeof data === 'object') ? data : {}
  const pick = (...keys) => {
    const tryPath = (obj, path) => {
      if (!obj || typeof obj !== 'object') return undefined
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
      // 兜底 1：若 d.device / d.admin / d.apply / d.organ 存在，再分别在它的子对象里找一次
      if (v === undefined && d.device && typeof d.device === 'object') v = tryPath(d.device, k)
      if (v === undefined && d.admin && typeof d.admin === 'object') v = tryPath(d.admin, k)
      if (v === undefined && d.apply && typeof d.apply === 'object') v = tryPath(d.apply, k)
      if (v === undefined && d.organ && typeof d.organ === 'object') v = tryPath(d.organ, k)
      if (v !== undefined) return v
    }
    return undefined
  }
  const str = (v, def) => {
    const s = String(v == null ? '' : v).trim()
    return s || def
  }
  const toInt = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.]/g, ''))
    return isNaN(n) ? 0 : n
  }

  // —— 预约记录主信息（apply 子对象）—— //
  const bookId = str(pick('apply.id', 'id', 'apply.applyId'), String(id || ''))
  // 状态归一化：按后端约定的数字枚举 (0~6) 映射到 key
  //   优先 apply.state；再退到顶层 state；最后兼容 status / applyStatus 字符串 key
  const applyStatusRaw = pick('apply.state', 'state', 'apply.status', 'status', 'applyStatus')
  const statusKey = keyFromState(applyStatusRaw)
  const statusInfo = DETAIL_TAG[statusKey] || DETAIL_TAG.default
  // 时间：按用户约定优先读 apply.beginAt / apply.finishAt（驼峰命名）
  //   兼容兜底：begin_at / finish_at（下划线命名，老接口）、顶层 startAt / finishAt
  const startAt = str(pick('apply.beginAt', 'beginAt', 'apply.begin_at', 'begin_at', 'startAt', 'apply.startAt'), '')
  const finishAt = str(pick('apply.finishAt', 'finishAt', 'apply.finish_at', 'finish_at', 'endAt', 'apply.finishAt', 'apply.endAt'), '')
  const durText = str(pick('apply.duration', 'apply.durText'), '') || durOfTs(startAt, finishAt)
  // 方式：1=自助 / 2=委托（字符串或数字都接受）
  // 字段名兼容（与「我的预约」/applyListItem 保持一致）：驼峰 + 下划线 + apply. 嵌套
  const opRaw = pick('apply.operateType', 'operateType', 'apply.operate_type', 'operate_type', 'apply.mode', 'mode')
  const opNum = Number(opRaw)
  const opKey = String(opRaw || '').toLowerCase()
  // 数字 key 与英文 key 都映射成中文（兼容老接口 / 第三方返回 'self'/'entrust'）
  const MODE_MAP = Object.assign({}, OPERATE_NAME, { self: '自助', entrust: '委托', entrusted: '委托' })
  let operateName = MODE_MAP[opNum] || MODE_MAP[opKey] || ''
  if (!operateName) {
    // 最后兜底：直接读后端给的中文 / 英文文本字段
    const textRaw = str(pick('apply.modeName', 'modeName', 'apply.operateTypeName', 'operateTypeName', 'apply.modeText', 'modeText'), '')
    if (textRaw) {
      // 中文直接透传，英文做一次归一化
      const tk = textRaw.toLowerCase()
      operateName = MODE_MAP[tk] || textRaw
    }
  }
  const price = toInt(pick('apply.price', 'price', 'apply.price'))
  const amount = toInt(pick('apply.amount', 'amount', 'apply.amount'))
  // 价格类字段兜底：空 / 0 都展示 ¥0，避免整行被 wx:if 隐掉导致空白
  const priceText = toYuan(price) || '¥0'
  const amountText = toYuan(amount) || '¥0'
  // 测试信息 memos
  const memo1 = str(pick('apply.memo1', 'memo1'), '')
  const memo2 = str(pick('apply.memo2', 'memo2'), '')
  const memo3 = str(pick('apply.memo3', 'memo3'), '')
  const memo4 = str(pick('apply.memo4', 'memo4'), '')
  // 提交时间（列表与详情都给一个一致展示）
  const submitTime = str(pick('apply.submitTime', 'submitTime', 'apply.createTime', 'createTime'), '')

  // —— 仪器字段（device 子对象）—— //
  const device = {
    name: str(pick('device.name', 'name', 'deviceName', 'devName'), '未知仪器'),
    icon: str(pick('device.icon', 'icon', 'emoji'), '🔬'),
    lab: str(pick('device.company', 'company', 'device.company'), '--'),
    // 收费三档：复用 detail 页的 price1..price6 → 所内/所外/院外 映射
    priceRows: buildPriceRows(pick),
    // 资产与位置（精简）：只保留关键字段，避开详情页里罗列过的 13 行
    address: str(pick('device.address', 'address', 'location', 'room'), '--'),
    sn: str(pick('device.sn', 'sn', 'deviceSn'), '--'),
    serialNo: str(pick('device.serialNo', 'serialNo'), '--'),
    companyNo: str(pick('device.companyNo', 'companyNo'), '--'),
    model: str(pick('device.model', 'model', 'deviceModel'), '--'),
    ownership: str(pick('organ.name', 'organName', 'organ_name', 'device.organName'), '--')
  }

  // —— 管理员信息（admin 子对象）—— //
  const admin = {
    userName: str(pick(
      'admin.userName', 'admin.name', 'admin.nickName', 'admin.realName',
      'adminName', 'admin_name', 'userName', 'name'
    ), '--'),
    // 联系电话：服务端命名不统一，这里把 admin 内部与顶层常见写法都列上
    //   （phonenumber / phoneNumber / phone / mobile / contactPhone / admin_phone 等）
    phonenumber: str(pick(
      'admin.phonenumber', 'admin.phoneNumber', 'admin.phone', 'admin.mobile', 'admin.tel',
      'admin.userPhone', 'admin.contactPhone', 'admin.admin_phone',
      'phonenumber', 'phoneNumber', 'contactPhone', 'contact_phone', 'adminPhone', 'admin_phone',
      'phone', 'mobile'
    ), '')
  }

  return {
    bookId,
    status: statusKey || 'default',
    statusText: statusInfo.text,
    statusCls: statusInfo.cls,
    submitTime,
    // 预约信息区
    startAt: prettyTs(startAt),
    finishAt: prettyTs(finishAt),
    range: (startAt && finishAt) ? (prettyTs(startAt) + ' ~ ' + prettyTs(finishAt)) : '',
    durText,
    operateName,
    priceText,
    amountText,
    // 测试信息区
    memo1, memo2, memo3, memo4,
    // 仪器 / 管理员（详情页渲染时直接读）
    device,
    admin
  }
}

// 把后台时间戳格式化为 'YYYY-MM-DD HH:mm'：秒位忽略（界面只展示到分钟）
// 兼容 'YYYY-MM-DD HH:mm:ss'、'YYYY-MM-DDTHH:mm:ss'、'YYYY-MM-DD' 三种形态
function prettyTs(s) {
  if (!s) return ''
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/)
  if (!m) return ''
  return m[1] + (m[2] ? ' ' + m[2] : '')
}

// 本地预约记录（listBookings() 单条）→ 详情页 detail 结构
// 用于 /api/deviceApplyDetail 拿不到数据时兜底渲染
// 与 buildDetailFromApplyDetail 字段命名保持一致，wxml 不需要任何分支判断
// 数据缺位时一律走 '--'，避免空字段带来 UI 错位
// 本地预约字段（utils/bookings.js addBooking）：
//   id / instId / instName / instIcon / lab / dateLabel / endDateLabel
//   startText / endText / durText / modeName / costText
//   purpose / contentQty / remark / needApprove / status / submitTime
function buildDetailFromLocalBooking(id, it) {
  // 时间字段：本地仅 dateLabel + startText（HH:mm），拼成 'YYYY-MM-DD HH:mm:00'
  const ds = it.dateLabel || ''
  const eDs = it.endDateLabel || ds
  const startAt = ds ? (ds + ' ' + (it.startText || '00:00') + ':00') : ''
  const finishAt = eDs ? (eDs + ' ' + (it.endText || '00:00') + ':00') : ''
  // 操作方式：modeName 是 '自助' / '委托' 文本，反推 operateType
  const opNum = (it.modeName === '自助') ? 1 : (it.modeName === '委托' ? 2 : 0)
  const opName = it.modeName || ''
  // 费用：从 '¥18' / '¥18.5' 这样的文案里反解析数字
  const toNum = (txt) => {
    const n = parseFloat(String(txt == null ? '' : txt).replace(/[^\d.]/g, ''))
    return isNaN(n) ? 0 : n
  }
  const costNum = toNum(it.costText)
  // 状态：本地记录可能仍是 'pending' / 'cancelled' 等字符串 key，统一走 keyFromState 兼容
  const statusKey = keyFromState(it.status)
  const statusInfo = DETAIL_TAG[statusKey] || DETAIL_TAG.default
  return {
    bookId: String(it.id || id || ''),
    status: statusKey || 'default',
    statusText: statusInfo.text,
    statusCls: statusInfo.cls,
    submitTime: it.submitTime || '',
    // 预约信息区
    startAt: prettyTs(startAt),
    finishAt: prettyTs(finishAt),
    range: (startAt && finishAt) ? (prettyTs(startAt) + ' ~ ' + prettyTs(finishAt)) : '',
    durText: it.durText || '',
    operateName: opName || '--',
    priceText: '',
    amountText: costNum ? toYuan(costNum) : '',
    unitCount: '',
    // 测试信息区：本地字段 purpose → memo1 / contentQty → memo2 / remark → memo3
    memo1: it.purpose || '',
    memo2: it.contentQty || '',
    memo3: it.remark || '',
    memo4: '',
    // 仪器 / 管理员（API 未拉到时只填本地点有的，其它留给 '--'）
    device: {
      name: it.instName || '未知仪器',
      icon: it.instIcon || '🔬',
      lab: it.lab || '--',
      // 收费标准：本地没有价格表，三档统一回退到 costText（保留 ¥/数字）
      priceRows: [
        { cat: '所内', self: toYuan(costNum), entrust: toYuan(costNum) },
        { cat: '所外', self: toYuan(costNum), entrust: toYuan(costNum) },
        { cat: '院外', self: toYuan(costNum), entrust: toYuan(costNum) }
      ],
      // 资产与位置说明（精简版）：本地记录无这些字段，全部走 '--'
      address: '--',
      sn: '--',
      serialNo: '--',
      companyNo: '--',
      model: '--',
      ownership: '--'
    },
    admin: {
      userName: '--',
      phonenumber: ''
    },
    // 兼容 operateType 消费者
    _operateType: opNum
  }
}

// 收费标准三档：复用 detail 页的 price1~price6 → 所内/所外/院外 映射，保证两处一致
// pick 函数由 buildDetailFromApplyDetail 闭包注入（它已经处理 device.x 兜底与点号路径）
function buildPriceRows(pick) {
  // 价格兜底：空 / 0 都规范成 '¥0'，避免单元格留空或显示 '--'
  const normPrice = (v) => {
    if (v === '' || v == null) return '¥0'
    if (Number(v) === 0) return '¥0'
    return v
  }
  // 数组形态（price=[{cat, self, entrust}, ...]）优先
  const arrRaw = pick('price', 'fee', 'device.price', 'device.fee')
  if (Array.isArray(arrRaw) && arrRaw.length) {
    return arrRaw.map(r => ({
      cat: str((r && (r.cat || r.category)), '标准'),
      self: normPrice(r && (r.self != null ? r.self : r.selfPrice)),
      entrust: normPrice(r && (r.entrust != null ? r.entrust : r.entrustPrice))
    }))
  }
  const p1 = toIntLocal(pick('price1', 'device.price1'))
  const p2 = toIntLocal(pick('price2', 'device.price2'))
  const p3 = toIntLocal(pick('price3', 'device.price3'))
  const p4 = toIntLocal(pick('price4', 'device.price4'))
  const p5 = toIntLocal(pick('price5', 'device.price5'))
  const p6 = toIntLocal(pick('price6', 'device.price6'))
  if (p1 || p2 || p3 || p4 || p5 || p6) {
    return [
      { cat: '所内', self: '¥' + p1, entrust: '¥' + p2 },
      { cat: '所外', self: '¥' + p3, entrust: '¥' + p4 },
      { cat: '院外', self: '¥' + p5, entrust: '¥' + p6 }
    ]
  }
  // 兜底：三档共用同一值（同样走 normPrice，空 / 0 → '¥0'）
  const selfY = normPrice(pick('selfPrice', 'self_price', 'device.selfPrice'))
  const entY = normPrice(pick('entrustPrice', 'entrust_price', 'device.entrustPrice'))
  return [
    { cat: '所内', self: selfY, entrust: entY },
    { cat: '所外', self: selfY, entrust: entY },
    { cat: '院外', self: selfY, entrust: entY }
  ]
}

// 局部工具：与下方 buildDetailFromApplyDetail 内同名 toInt 不冲突，单独放一份
function toIntLocal(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.]/g, ''))
  return isNaN(n) ? 0 : n
}

function str(v, def) {
  const s = String(v == null ? '' : v).trim()
  return s || def
}
