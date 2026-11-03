// pages/instrument-detail/index.js
const { findInstrument } = require('../../utils/instruments.js')
const { DEVICE_APPLY_KEY } = require('../../utils/api.js')

// /api/deviceApply 返回数据 → 详情页 detail 结构
// 字段命名与 /api/deviceList 保持一致：
//   need_appointment（1=需预约）/ need_check（1=需审批）/ power_state（1=开机 0=空闲）/
//   company（所在单位）/ organ_name（机构名称）
// 价格兼容数组（cat/self/entrust）与 selfPrice·entrustPrice 等单值字段
// 后端真实响应通常把设备字段嵌套在 device 对象下：{ device: { name, gallery, price, ... } }
// 这里参考 instrument-book 中的 pick 实现：支持点号路径 + 自动回退到 d.device
function buildDetailFromApply(id, data) {
  const d = (data && typeof data === 'object') ? data : {}
  // pick：支持点号路径（如 'device.name' 会沿 d → d.device.name 解析）；
  // 若 d.device 存在，任何非点的 key 也会在 d.device.{key} 上再试一次（向后兼容旧接口字段在顶层）
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
      if (v === undefined && d.device && typeof d.device === 'object') v = tryPath(d.device, k)
      if (v !== undefined) return v
    }
    return undefined
  }
  const toBool = v => v === true || v === 1 || v === '1' || v === 'true'
  const str = (v, def) => {
    const s = String(v == null ? '' : v).trim()
    return s || def
  }
  const toYuan = v => {
    const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10)
    return '¥' + (isNaN(n) ? 0 : n)
  }
  // 解析金额（不带 ¥ 前缀，返回数字）
  const toInt = (v) => {
    const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10)
    return isNaN(n) ? 0 : n
  }
  const name = str(pick('device.name', 'name', 'deviceName', 'devName'), '未知仪器')
  // 开关机状态：power_state 1=开机 0=空闲；无值时回退 status/state
  let status = ''
  let statusText = ''
  const psRaw = pick('power_state', 'powerState')
  if (psRaw !== undefined && psRaw !== null) {
    if (Number(psRaw) === 1) { status = 'online'; statusText = '开机' }
    else if (Number(psRaw) === 0) { status = 'idle'; statusText = '空闲' }
  }
  if (!statusText) {
    const sRaw = String(pick('status', 'state') || '').toLowerCase()
    status = (sRaw === 'online' || sRaw === 'on' || sRaw === 'busy' || sRaw === 'running') ? 'online' : 'idle'
    statusText = status === 'online' ? '开机' : '空闲'
  }
  // 轮播图：gallery/imgList 数组优先，其次 image 等单图字段；无图时用空串触发图标占位
  // 这里同样走 pick，既能取到顶层的 gallery，也能取到 device.gallery
  let gallery = []
  const gRaw = pick('gallery', 'imgList', 'images', 'device.gallery', 'device.imgList')
  if (Array.isArray(gRaw) && gRaw.length) gallery = gRaw.map(String)
  if (!gallery.length) {
    const img = str(pick('image', 'imageUrl', 'img', 'imgUrl', 'cover', 'coverUrl', 'photo',
      'device.image', 'device.cover'), '')
    gallery = img ? [img] : ['']
  }
  // 收费标准：按以下顺序兼容三种数据形态
  //   ① 数组 price=[{cat, self, entrust}, ...]   旧/通用结构（直接展示）
  //   ② 6 个分项 price1~price6（所内/所外/院外 × 自助/委托）新接口
  //      price1=所内自助 / price2=所内委托
  //      price3=所外自助 / price4=所外委托
  //      price5=院外自助 / price6=院外委托
  //      → 按 wxml 现有 cat 行顺序（院内/院外/所外）映射：
  //         院内（≈所内）← price1 / price2
  //         院外          ← price5 / price6
  //         所外          ← price3 / price4
  //   ③ 单值 selfPrice / entrustPrice  老字段兜底（三档共用）
  let price = []
  const pRaw = pick('price', 'fee', 'device.price', 'device.fee')
  if (Array.isArray(pRaw) && pRaw.length) {
    price = pRaw.map(r => ({
      cat: str(r && (r.cat || r.category), '标准'),
      self: toYuan(r && (r.self != null ? r.self : r.selfPrice)),
      entrust: toYuan(r && (r.entrust != null ? r.entrust : r.entrustPrice))
    }))
  } else {
    const p1 = toInt(pick('price1', 'device.price1'))
    const p2 = toInt(pick('price2', 'device.price2'))
    const p3 = toInt(pick('price3', 'device.price3'))
    const p4 = toInt(pick('price4', 'device.price4'))
    const p5 = toInt(pick('price5', 'device.price5'))
    const p6 = toInt(pick('price6', 'device.price6'))
    if (p1 || p2 || p3 || p4 || p5 || p6) {
      // ② 新接口 6 价 → 按 wxml 顺序（所内/所外/院外）生成三档
      price = [
        { cat: '所内', self: '¥' + p1, entrust: '¥' + p2 },  // 所内：price1 / price2
        { cat: '所外', self: '¥' + p3, entrust: '¥' + p4 },  // 所外：price3 / price4
        { cat: '院外', self: '¥' + p5, entrust: '¥' + p6 }   // 院外：price5 / price6
      ]
    } else {
      // ③ 老接口单值字段兜底：三档共用
      const selfY = pick('selfPrice', 'self_price', 'price', 'device.selfPrice')
      const entY = pick('entrustPrice', 'entrust_price', 'entrustFee', 'entrust_fee', 'device.entrustPrice')
      price = [
        { cat: '所内', self: toYuan(selfY), entrust: toYuan(entY) },
        { cat: '所外', self: toYuan(selfY), entrust: toYuan(entY) },
        { cat: '院外', self: toYuan(selfY), entrust: toYuan(entY) }
      ]
    }
  }
  return {
    id: String(id),
    name,
    icon: str(pick('icon', 'emoji', 'device.icon'), '🔬'),
    status,
    statusText,
    needBook: toBool(pick('need_appointment', 'needAppointment')),
    needApprove: toBool(pick('need_check', 'needCheck')),
    lab: str(pick('company', 'device.company'), '--'),
    // 平台（机构名）：优先从 organ.name 读取（仪器所属在 organ 对象下），与 organ 字段一并解析
    platform: str(pick('organ.name', 'organName', 'organ_name', 'device.organName', 'device.organ.name'), '--'),
    gallery,
    price,
    // 「资产与位置说明」字段映射（按 /api/deviceApply 返回结构，管理员在 admin 对象内，
    // 仪器字段在 device 对象内，仪器所属在 organ 对象内）
    manager: str(pick('admin.userName', 'manager', 'device.manager', 'device.admin.userName'), '--'),
    contact: str(pick('admin.userName', 'contact', 'contactName', 'device.contact'), '--'),
    contactPhone: str(pick('admin.phonenumber', 'contactPhone', 'contact_phone', 'phone', 'device.contactPhone', 'device.admin.phonenumber'), ''),
    address: str(pick('address', 'location', 'room', 'device.address'), '--'),
    sn: str(pick('sn', 'deviceSn', 'device.sn'), '--'),
    // 固定资产编号 → device.serialNo；所资产编号 → device.companyNo
    assetNo: str(pick('device.serialNo', 'serialNo', 'assetNo', 'asset_no', 'no', 'device.assetNo'), '--'),
    instAssetNo: str(pick('device.companyNo', 'companyNo', 'instAssetNo', 'inst_asset_no', 'device.instAssetNo'), '--'),
    // 型号 / 规格 / 厂家 / 成本价 / 购置日期 / 经费来源 → 从 device 子对象上读
    model: str(pick('device.model', 'model', 'deviceModel'), '--'),
    spec: str(pick('device.modelType', 'modelType', 'spec', 'specification', 'device.spec'), '--'),
    manufacturer: str(pick('device.factory', 'factory', 'manufacturer', 'vendor', 'brand', 'device.manufacturer'), '--'),
    costPrice: str(pick('device.factoryPrice', 'factoryPrice', 'costPrice', 'cost_price', 'device.costPrice'), '--'),
    purchaseDate: str(pick('device.buyAt', 'buyAt', 'purchaseDate', 'purchase_date', 'device.purchaseDate'), '--'),
    fundSource: str(pick('device.fundsFrom', 'fundsFrom', 'fundSource', 'fund_source', 'device.fundSource'), '--'),
    // 仪器所属 → organ 对象下的 name
    ownership: str(pick('organ.name', 'organName', 'organ_name', 'ownership', 'owner', 'device.organName'), '--'),
    description: str(pick('description', 'remark', 'intro', 'device.description'), ''),
    // 管理功能可见性：device.admin.userId 与 user.userId 一致才展示（当前用户是该仪器的管理员）
    canManage: isAdminOfDevice(d)
  }
}

// 判断当前用户是否是这台仪器的管理员
// /api/deviceApply 返回 data 中有两处 userId：
//   device.admin.userId（仪器管理员）与 user.userId（当前登录用户）
// 两者都存在且相等 → 有管理权限；缺失或不相等 → 不展示管理功能
function isAdminOfDevice(d) {
  const getter = (obj, path) => {
    const segs = String(path).split('.').filter(Boolean)
    let cur = obj
    for (let i = 0; i < segs.length; i++) {
      if (!cur || typeof cur !== 'object') return undefined
      cur = cur[segs[i]]
    }
    return (cur === undefined || cur === null || cur === '') ? undefined : cur
  }
  const pickId = paths => {
    for (let i = 0; i < paths.length; i++) {
      const v = getter(d, paths[i])
      if (v !== undefined) return v
    }
    return undefined
  }
  // 管理员 id：data.device.admin.userId（兼容 device.admin.id / admin.userId 等写法）
  const adminId = pickId(['device.admin.userId', 'device.admin.user_id', 'device.admin.id',
    'admin.userId', 'admin.user_id', 'admin.id'])
  // 当前用户 id：data.user.userId
  const userId = pickId(['user.userId', 'user.user_id', 'user.id', 'userId', 'user_id'])
  if (adminId === undefined || userId === undefined) return false
  return String(adminId).trim() === String(userId).trim()
}

Page({
  data: {
    detail: null,
    // 轮播图加载失败标记（idx 数组）
    imgErrIdx: []
  },

  onLoad(options) {
    const id = options && options.id
    // 优先使用 /api/deviceApply 返回数据渲染（由仪器列表点击卡片入口校验通过后写入缓存），
    // 无缓存（如旧入口直达）时回退本地演示数据
    let detail = null
    let fromApi = false
    try {
      const cached = wx.getStorageSync(DEVICE_APPLY_KEY)
      if (cached && String(cached.deviceId) === String(id || '') && cached.data) {
        detail = buildDetailFromApply(id, cached.data)
        fromApi = true
        console.log('[instrument-detail] 使用 /api/deviceApply 数据渲染：', detail)
      }
    } catch (e) { /* 忽略缓存异常 */ }
    if (!detail) detail = findInstrument(id)
    // 本地演示数据里没有 user / admin，无从判断身份 → 沿用原有展示，不隐藏管理功能
    if (!fromApi && detail && detail.canManage === undefined) {
      detail = Object.assign({}, detail, { canManage: true })
    }
    if (!detail) {
      wx.showToast({ title: '未找到该仪器', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 900)
      return
    }
    this.setData({ detail })
    wx.setNavigationBarTitle({ title: detail.name })
  },

  onImgErr(e) {
    const idx = e.currentTarget.dataset.idx
    if (this.data.imgErrIdx.indexOf(idx) >= 0) return
    this.setData({ imgErrIdx: [...this.data.imgErrIdx, idx] })
  },

  // 进入预约页：选择日期时段与计费方式
  goBook() {
    const d = this.data.detail
    if (!d) return
    wx.navigateTo({ url: '/pages/instrument-book/index?id=' + d.id })
  },

  // ── 管理功能：预约调整 / 预约记录 / 上机记录 ──
  // ① 预约调整：日历 + 时段表（与仪器预约页同一套样式）
  // 带 deviceId → 调整页用它调 /api/deviceApply 拉这台仪器的预约数据
  onAdjust() {
    const d = this.data.detail
    if (!d) return
    wx.navigateTo({
      url: '/pages/booking-adjust/index?name=' + encodeURIComponent(d.name) +
        '&deviceId=' + encodeURIComponent(d.id || '')
    })
  },

  // ② 预约记录：与首页「预约审批」共用同一个列表页 pages/booking-approval
  // 带 deviceId（+ name）→ 列表页按 state=2 + deviceId 调 /api/applyList，只显示这台仪器的预约单
  onBookingRecords() {
    const d = this.data.detail
    if (!d) return
    wx.navigateTo({
      url: '/pages/booking-approval/index?name=' + encodeURIComponent(d.name) +
        '&deviceId=' + encodeURIComponent(d.id || ''),
      fail: err => console.error('[instrument-detail] 跳转预约记录失败：', err)
    })
  },

  // ③ 上机记录：该仪器的使用记录（演示数据页）
  onDeviceLog() {
    const d = this.data.detail
    if (!d) return
    wx.navigateTo({
      url: '/pages/instrument-logs/index?name=' + encodeURIComponent(d.name) +
        '&model=' + encodeURIComponent(d.model || '') +
        '&deviceId=' + encodeURIComponent(d.id || '')
    })
  },

  // 点击联系电话 → 呼出电话
  onCallPhone(e) {
    const phone = String(e.currentTarget.dataset.phone || '').replace(/[- ]/g, '')
    if (!phone) return
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => { /* 用户取消或环境不支持时静默 */ }
    })
  }
})
