// pages/booking-approval/index.js
// 两个入口共用本页，都调 POST /api/applyList，参数不同：
//   ① 首页「预约审批」→ 不带 deviceId：{ token, state: 1 }
//   ② 仪器详情页「预约记录」→ 带 deviceId：{ token, state: 2, deviceId }
// 点击条目 → 组装成 /api/deviceApplyDetail 等价结构写入缓存 → 跳 pages/booking-detail
const { getApplyList, getDeviceApplyDetail, BOOKING_DETAIL_KEY } = require('../../utils/api.js')
const { mapApplyListItem } = require('../../utils/applyListItem.js')

// 点「审批」时把该条申请单写入缓存，供 pages/booking-approve 读取（键名与该页保持一致）
const APPROVAL_DETAIL_KEY = 'approvalDetailDraft'

// POST /api/applyList 的 state 取值：
//   1 = 待我审批（首页「预约审批」入口）
//   2 = 仪器的预约记录（仪器详情页「预约记录」入口，配合 deviceId 使用）
const STATE_APPROVAL = 1
const STATE_DEVICE_RECORD = 2

// 状态字典：文案 + 配色（对照参考图）
//   key 与 utils/bookingStatus.js 的归一化 key 一致；state 数字用于详情页标签
const STATUS = {
  pending: { text: '待审核', cls: 'ba-st--pending', state: 0 },
  approved: { text: '已通过', cls: 'ba-st--approved', state: 2 },
  active: { text: '已上机', cls: 'ba-st--approved', state: 5 },
  noShow: { text: '爽约', cls: 'ba-st--noshow', state: 6 },
  closed: { text: '已关闭', cls: 'ba-st--expired', state: 4 },
  rejected: { text: '已拒绝', cls: 'ba-st--rejected', state: 3 },
  cancelled: { text: '已取消', cls: 'ba-st--cancelled', state: 1 }
}
const STATUS_UNKNOWN = { text: '未知', cls: 'ba-st--expired', state: 0 }

// ── /api/applyList 原始条目的取值工具 ──
// 按点路径取值（如 'applyUser.userName'），空值返回 ''
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

// 多路径依次尝试，取第一个非空值（兼容驼峰 / 下划线 / apply. / applyUser. 嵌套）
function pickStr(obj, paths) {
  for (let i = 0; i < paths.length; i++) {
    const v = pickPath(obj, paths[i])
    if (v) return v
  }
  return ''
}

function numOf(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.]/g, ''))
  return isNaN(n) ? 0 : n
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

// /api/applyList 原始条目 → 本页卡片字段
// 先复用 mapApplyListItem 做归一化（仪器名 / 时段 / 金额 / 状态 key），
// 再补齐审批列表独有的申请人、联系方式、管理员、备注等字段
function fromApiItem(raw) {
  const m = mapApplyListItem(raw)
  if (!m) return null
  // 原始 state 数字（0=待审核…）：「审批」按钮的显示条件之一，缺字段时按 -1 处理（不显示）
  const stateRaw = pickStr(raw, ['state', 'apply.state', 'status', 'apply.status'])
  const stateNum = /^-?\d+$/.test(stateRaw) ? Number(stateRaw) : -1
  // isAdmin：当前用户是否是该申请单的审批人（1=是），兼容 isAdmin / is_admin 两种命名
  const isAdminRaw = pickStr(raw, ['isAdmin', 'is_admin', 'apply.isAdmin', 'apply.is_admin'])
  const isAdmin = isAdminRaw === '' ? 0 : Number(isAdminRaw)
  return {
    id: m.id,
    status: m.status || 'pending',
    stateNum,
    isAdmin,
    mode: Number(pickStr(raw, ['operateType', 'operate_type', 'mode', 'apply.operateType'])) || 1,
    instName: m.instName,
    model: pickStr(raw, ['model', 'device.model', 'deviceModel', 'device.modelName']),
    user: pickStr(raw, [
      'apply.user.user_name', 'applyUser.user_name', 'user.user_name', 'user_name',
      'userName', 'nickName', 'nick_name', 'realName',
      'applyUser.userName', 'applyUser.name', 'apply.userName', 'apply.user.name',
      'applicant', 'applicantName', 'createBy', 'apply.applyUser.userName'
    ]),
    dept: pickStr(raw, [
      'dept', 'department', 'userDept', 'applyUser.dept', 'apply.dept',
      'organ.name', 'organName', 'company'
    ]),
    applyTime: m.submitTime,
    // 起止时间：日期 + 时刻（mapApplyListItem 已把裸时间戳归一成 'YYYY-MM-DD HH:mm'）
    beginText: [m.dateLabel, m.startText].filter(Boolean).join(' '),
    finishText: [m.endDateLabel, m.endText].filter(Boolean).join(' '),
    // 费用：amount 优先，缺则 price，仍缺时回落 m.costText（形如 '¥600'）
    base: numOf(pickStr(raw, ['amount', 'price', 'cost', 'total', 'apply.amount', 'apply.price']) || m.costText),
    penalty: 0,
    discount: 0,
    lab: m.lab,
    organ: pickStr(raw, ['organ.name', 'organName', 'company', 'device.company']) || m.lab,
    adminName: pickStr(raw, ['admin.userName', 'adminName', 'admin.name', 'apply.adminName']),
    adminPhone: pickStr(raw, [
      'admin.phonenumber', 'admin.phoneNumber', 'admin.phone', 'admin.mobile', 'admin.tel',
      'adminPhone', 'admin_phone', 'apply.adminPhone', 'apply.admin.phonenumber'
    ]),
    memo1: m.purpose,
    memo2: m.contentQty,
    memo3: m.remark
  }
}

// 补齐列表展示字段：图标 / 时段 / 费用算式 / 状态徽标 / 金额
function decorate(x) {
  const total = (x.base || 0) + (x.penalty || 0) - (x.discount || 0)
  const st = STATUS[x.status] || STATUS_UNKNOWN
  const b = String(x.beginText || '')
  const f = String(x.finishText || '')
  const d1 = b.split(' ')[0] || ''
  const d2 = f.split(' ')[0] || ''
  const t1 = (b.split(' ')[1] || '').slice(0, 5)
  const t2 = (f.split(' ')[1] || '').slice(0, 5)
  const dur = durText(b, f)
  return Object.assign({}, x, {
    icon: iconOf(x.instName),
    modeName: Number(x.mode) === 2 ? '委托' : '自助',
    labText: x.lab || '',
    dateLabel: d1,
    // 同一天用「15:45 ~ 16:15」，跨天则显示完整起止
    timeText: d1 && d1 === d2 ? (t1 + ' ~ ' + t2) : (b + ' ~ ' + f),
    durText: dur ? '（' + dur + '）' : '',
    feeLeft: (x.base || 0) + ' + ' + (x.penalty || 0) + '(罚金) - ' + (x.discount || 0) + '(折扣)',
    feeTotal: '= ' + total + '元(预计)',
    amount: total,
    amountText: total + ' 元',
    // 预估价格用的单价 / 数量（审批详情页展示 "单价 × 数量 = 金额"）
    unit: x.unit != null ? x.unit : (x.base || 0),
    qty: x.qty || 1,
    // 申请人：缺姓名显示占位符，缺单位时不带空括号
    userText: (x.user || '—') + (x.dept ? '（' + x.dept + '）' : ''),
    // 「审批」按钮仅在 state=0（待审核）且 isAdmin=1（当前用户是该单审批人）时展示
    // （与参考 LabManagerMini/components/appointment 的 state==0 && is_admin==1 一致）
    canApprove: Number(x.stateNum) === 0 && Number(x.isAdmin) === 1,
    state: st.state,
    tagText: st.text,
    tagCls: st.cls
  })
}

// 列表项 → /api/deviceApplyDetail 等价结构（booking-detail 的 buildDetailFromApplyDetail 按此解析）
function toApplyDetail(it) {
  const sn = 'SN-' + String(it.id).toUpperCase()
  return {
    device: {
      name: it.instName,
      icon: '🔬',
      company: it.lab,
      address: '3 号楼 2 层',
      model: it.model,
      sn: sn,
      serialNo: sn,
      companyNo: 'CN-' + String(it.id).toUpperCase(),
      // 收费三档（所内/所外/院外 × 自助/委托）按基础价填充，避免详情页出现 ¥0 空表
      price1: it.base, price2: it.base, price3: it.base,
      price4: it.base, price5: it.base, price6: it.base
    },
    admin: { userName: it.adminName, phonenumber: it.adminPhone },
    organ: { name: it.organ },
    apply: {
      id: it.id,
      state: it.state,
      beginAt: it.beginText,
      finishAt: it.finishText,
      operateType: it.mode,
      price: it.base,
      amount: it.amount,
      memo1: it.memo1,
      memo2: it.memo2,
      memo3: it.memo3,
      submitTime: it.applyTime
    }
  }
}

Page({
  data: {
    list: [],
    loading: false,
    emptyText: ''
  },

  _seq: 0,          // 加载序列号：防止快速进入 / 并发时旧请求晚回覆盖新数据
  _scopeName: '',   // 仪器名（仪器详情页「预约记录」入口带此参数，用于兜底过滤）
  _scopeDeviceId: '', // 仪器 id（仪器详情页「预约记录」入口带此参数，随 state=2 一起提交）
  _firstShow: true, // 首次 onShow 由 onLoad 触发的加载完成，避免重复请求

  onLoad(options) {
    // 两个入口共用本页：
    //   ① 首页「预约审批」→ 不带 deviceId，state=1 拉待我审批的申请单
    //   ② 仪器详情页「预约记录」→ 带 deviceId，state=2 拉这台仪器的预约记录
    this._scopeName = decodeURIComponent((options && options.name) || '')
    this._scopeDeviceId = decodeURIComponent((options && options.deviceId) || '')
    this._firstShow = true
    this._load()
  },

  onShow() {
    // 从审批详情 / 预约详情返回后刷新：审批通过或拒绝后状态会变
    if (this._firstShow) {
      this._firstShow = false
      return
    }
    this._load()
  },

  reload() {
    this._load()
  },

  // 进入页面 / 返回页面时调用：POST /api/applyList
  //   带 deviceId（仪器详情页入口）→ { token, state: 2, deviceId }
  //   不带 deviceId（首页入口）    → { token, state: 1 }
  _load() {
    const seq = ++this._seq
    const deviceId = this._scopeDeviceId
    const state = deviceId ? STATE_DEVICE_RECORD : STATE_APPROVAL
    this.setData({
      loading: true,
      emptyText: deviceId ? '正在加载该仪器的预约记录…' : '正在加载预约审批列表…'
    })
    getApplyList(state, deviceId ? { deviceId: deviceId } : null)
      .then(items => {
        if (seq !== this._seq) return
        const all = (items || []).map(fromApiItem).filter(Boolean)
        // 有 deviceId 时接口已按仪器过滤，不再按名称二次过滤（避免名称不一致导致误删）；
        // 只有「没有 deviceId 但带了 name」的旧链接才按名称过滤
        const scoped = (!deviceId && this._scopeName)
          ? all.filter(x => x.instName === this._scopeName)
          : all
        const list = scoped.map(decorate)
        this.setData({
          list,
          loading: false,
          emptyText: list.length
            ? ''
            : (deviceId || this._scopeName ? '该仪器暂无预约记录' : '暂无待审批的预约申请')
        })
      })
      .catch(err => {
        if (seq !== this._seq) return
        console.warn('[booking-approval] /api/applyList(state=' + state +
          (deviceId ? ', deviceId=' + deviceId : '') + ') 失败：', err)
        this.setData({ list: [], loading: false, emptyText: '加载失败，请稍后重试' })
      })
  },

  // 待审核条目点「审批」→ 写入申请单缓存 → 进审批详情页（罚金/折扣/通过/拒绝）
  onApprove(e) {
    const id = e.currentTarget.dataset.id
    const it = this.data.list.find(x => x.id === id)
    if (!it) return
    try {
      wx.setStorageSync(APPROVAL_DETAIL_KEY, { ts: Date.now(), data: it })
    } catch (err) {
      console.warn('[booking-approval] 申请单缓存写入失败：', err)
    }
    wx.navigateTo({
      url: '/pages/booking-approve/index?id=' + encodeURIComponent(id),
      fail: err => {
        console.warn('[booking-approval] 跳转审批详情失败：', err)
        wx.showToast({ title: '页面跳转失败', icon: 'none' })
      }
    })
  },

  // 点击条目 → 进预约详情页（与「我的预约」同一个页面）
  // 详情缓存优先用 /api/deviceApplyDetail 的完整数据（管理员姓名与电话由该接口下发）；
  // 接口失败或超时时用列表已有字段组装兜底，保证仍能进入详情
  openDetail(e) {
    const id = e.currentTarget.dataset.id
    const it = this.data.list.find(x => x.id === id)
    if (!it) return
    const writeCache = data => {
      try {
        wx.setStorageSync(BOOKING_DETAIL_KEY, { id, data, ts: Date.now() })
      } catch (err) {
        console.warn('[booking-approval] 详情缓存写入失败：', err)
      }
    }
    const goto = () => {
      wx.navigateTo({
        url: '/pages/booking-detail/index?id=' + encodeURIComponent(id),
        fail: err => {
          console.warn('[booking-approval] 跳转预约详情失败：', err)
          wx.showToast({ title: '页面跳转失败', icon: 'none' })
        }
      })
    }
    let settled = false
    const fallback = () => {
      if (settled) return
      settled = true
      wx.hideLoading()
      writeCache(toApplyDetail(it))
      goto()
    }
    wx.showLoading({ title: '正在加载预约详情…', mask: true })
    const timer = setTimeout(fallback, 5000)
    getDeviceApplyDetail(id)
      .then(data => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        wx.hideLoading()
        writeCache((data && typeof data === 'object') ? data : toApplyDetail(it))
        goto()
      })
      .catch(err => {
        clearTimeout(timer)
        if (settled) return
        console.warn('[booking-approval] /api/deviceApplyDetail 失败，用列表数据兜底：', err)
        fallback()
      })
  }
})
