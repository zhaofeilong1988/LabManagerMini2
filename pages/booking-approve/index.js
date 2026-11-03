// pages/booking-approve/index.js —— 预约审批详情
// 进入页面时 POST /api/applyDetail（参数：id = 审批单 id、token）拉取审批单并渲染
// 数据兜底顺序：接口 → 列表点「审批」时写入的 APPROVAL_DETAIL_KEY 缓存 → 本地演示数据
// 结构对照参考图：申请信息卡 → 罚金 / 折扣 → 实际价格 → 备注 → 通过 / 拒绝 / 关闭
const { getApplyDetail, doApplyCheck } = require('../../utils/api.js')

const APPROVAL_DETAIL_KEY = 'approvalDetailDraft'

function durOf(b, f) {
  const bt = new Date(String(b).replace(/-/g, '/')).getTime()
  const ft = new Date(String(f).replace(/-/g, '/')).getTime()
  if (isNaN(bt) || isNaN(ft) || ft <= bt) return ''
  const mins = Math.round((ft - bt) / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h && m) return h + '小时' + m + '分钟'
  if (h) return h + '小时'
  return m + '分钟'
}

// 兜底演示数据：接口失败且缓存失效 / 直接通过链接进入时也能打开页面
const FALLBACK = {
  id: 'demo-1', status: 'pending', mode: 1,
  instName: '全自动核酸纯化检测系统', model: 'QIAGEN: QIAcube',
  user: '王英', dept: '所外', phone: '15811110032',
  adminPhone: '13800138001', organ: '生物医学实验平台',
  beginText: '2026-10-24 15:45:00', finishText: '2026-10-24 16:15:00',
  base: 0, unit: 0, qty: 1,
  memo1: '样本核酸纯化', memo2: '样本 12 例', memo3: '需提前开机自检'
}

function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, ''))
  return isNaN(n) ? 0 : Math.round(n * 100) / 100
}

// ── /api/applyDetail 返回值的取值工具 ──
// 按点路径取值（如 'apply.begin_at'），空值返回 ''
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

function numOf(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, ''))
  return isNaN(n) ? 0 : n
}

// 收费标准：device.price_method（1 计时 / 2 计件 / 3 协议收费），计时时带 price_method_unit（分钟）
function priceTypeOf(method, unit) {
  const m = Number(method)
  if (m === 1) return '计时' + (unit ? '(' + unit + '分钟)' : '')
  if (m === 2) return '计件'
  return '协议收费'
}

// /api/applyDetail 返回 → 页面字段
// 后端结构（对照 LabManagerMini/pages/applyCheck 的同接口用法）：
//   {
//     device: { name, model, dept_name, dept_type, price_method, price_method_unit },
//     apply:  { id, begin_at, finish_at, operate_type, price, count, amount, memo1..3,
//               user: { user_name, login_name, phonenumber } },
//     admin / organ 等可选子对象
//   }
// 同时兼容平铺返回与驼峰命名，避免字段名不一致时整块信息为空
function fromApiData(d) {
  const x = (d && typeof d === 'object') ? d : {}
  const pick = function () {
    for (let i = 0; i < arguments.length; i++) {
      const v = pickPath(x, arguments[i])
      if (v) return v
    }
    return ''
  }
  // 预约人：姓名（+登录名，形如「王英(zhangsan)」）与手机号都在 apply.user 下
  const userName = pick(
    'apply.user.user_name', 'applyUser.user_name', 'user.user_name', 'user_name',
    'apply.userName', 'apply.user.name', 'userName', 'nickName', 'nick_name', 'realName'
  )
  const loginName = pick(
    'apply.user.login_name', 'applyUser.login_name', 'user.login_name', 'login_name', 'loginName'
  )
  const price = numOf(pick('apply.price', 'price', 'apply.amount', 'amount'))
  const count = numOf(pick('apply.count', 'count', 'unitCount', 'unit_count', 'qty'))
  return {
    id: pick('apply.id', 'id', 'applyId', 'apply_id'),
    instName: pick('device.name', 'device_name', 'deviceName', 'name'),
    model: pick('device.model', 'model', 'deviceModel'),
    organ: pick('device.dept_name', 'organ.name', 'organName', 'organ_name', 'company', 'device.company'),
    // 机构类型（所内 / 所外 / 院外），与机构名拼成「生物医学实验平台(所外)」
    dept: pick('device.dept_type', 'dept_type', 'deptType', 'dept', 'department'),
    user: userName + (loginName ? '(' + loginName + ')' : ''),
    phone: pick(
      'apply.user.phonenumber', 'apply.user.phone', 'applyUser.phonenumber', 'user.phonenumber',
      'phonenumber', 'phone', 'mobile', 'apply.user.mobile'
    ),
    adminPhone: pick('admin.phonenumber', 'admin.phone', 'adminPhone', 'admin_phone', 'device.admin_phone'),
    mode: Number(pick('apply.operate_type', 'operateType', 'operate_type', 'mode')) || 1,
    beginText: pick('apply.begin_at', 'begin_at', 'beginAt', 'apply.beginAt', 'startAt'),
    finishText: pick('apply.finish_at', 'finish_at', 'finishAt', 'apply.finishAt', 'endAt'),
    base: numOf(pick('apply.amount', 'amount')) || Math.round(price * (count > 0 ? count : 1) * 100) / 100,
    unit: price,
    qty: count > 0 ? count : 1,
    memo1: pick('apply.memo1', 'memo1'),
    memo2: pick('apply.memo2', 'memo2'),
    memo3: pick('apply.memo3', 'memo3'),
    priceType: priceTypeOf(
      pick('device.price_method', 'price_method', 'priceMethod'),
      pick('device.price_method_unit', 'price_method_unit', 'priceMethodUnit')
    )
  }
}

Page({
  data: {
    id: '',
    instName: '',
    model: '',
    organText: '',
    user: '',
    phone: '',
    adminPhone: '',
    modeText: '',
    memo1: '',
    memo2: '',
    memo3: '',
    priceType: '协议收费',
    unit: 0,
    qty: 1,
    base: 0,
    begin: '',
    finish: '',
    durText: '',
    penalty: '0',
    discount: '0',
    total: 0,
    remark: ''
  },

  onLoad(options) {
    const id = String((options && options.id) || '')
    // 列表点「审批」时写入的缓存：先渲染，避免接口返回前白屏
    const cached = this._readCache(id)
    if (cached) this._render(cached)

    if (!id) {
      // 没有审批单 id 无法请求接口：只用缓存，缓存也没有时兜底
      if (!cached) {
        console.warn('[booking-approve] 缺少审批单 id，且无缓存，使用兜底数据')
        wx.showToast({ title: '演示数据（缺少审批单 id）', icon: 'none' })
        this._render(FALLBACK)
      }
      return
    }

    wx.showLoading({ title: '正在加载审批单…', mask: true })
    getApplyDetail(id)
      .then(data => {
        wx.hideLoading()
        this._render(fromApiData(data))
      })
      .catch(err => {
        wx.hideLoading()
        console.warn('[booking-approve] /api/applyDetail 失败：', err)
        // 已用缓存渲染过就保持现状，否则兜底演示数据并提示
        if (!cached) {
          wx.showToast({ title: '加载失败，使用本地数据', icon: 'none' })
          this._render(FALLBACK)
        }
      })
  },

  // 读取列表写入的申请单缓存（id 缺失时不校验来源，避免只有一条数据时误判）
  _readCache(id) {
    try {
      const cached = wx.getStorageSync(APPROVAL_DETAIL_KEY)
      if (!cached || !cached.data) return null
      const it = cached.data
      if (!id || !it.id || String(it.id) === id) return it
    } catch (e) {
      console.warn('[booking-approve] 申请单缓存读取失败：', e)
    }
    return null
  },

  _render(it) {
    const unit = it.unit != null ? it.unit : (it.base || 0)
    const qty = it.qty || 1
    this.setData({
      id: it.id || '',
      instName: it.instName || '未知仪器',
      model: it.model || '',
      organText: (it.organ || '') + (it.dept ? '(' + it.dept + ')' : ''),
      user: it.user || '',
      phone: it.phone || '',
      adminPhone: it.adminPhone || '',
      modeText: it.mode === 2 ? '委托' : '自助',
      memo1: it.memo1 || '',
      memo2: it.memo2 || '',
      memo3: it.memo3 || '',
      priceType: it.priceType || '协议收费',
      unit,
      qty,
      // 金额优先用接口给的 amount，缺失时才按「单价 × 数量」算
      base: (it.base != null && it.base !== '') ? num(it.base) : Math.round(unit * qty * 100) / 100,
      begin: it.beginText || '',
      finish: it.finishText || '',
      durText: durOf(it.beginText, it.finishText)
    })
    this._recalc()
  },

  _recalc() {
    const { base, penalty, discount } = this.data
    const total = Math.round((base + num(penalty) - num(discount)) * 100) / 100
    this.setData({ total })
  },

  // 点击手机号 → 呼出电话（号码里的分隔符先去掉）
  onCallPhone(e) {
    const phone = String(e.currentTarget.dataset.phone || '').replace(/[- ]/g, '')
    if (!phone) return
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => { /* 用户取消或环境不支持时静默 */ }
    })
  },

  onPenalty(e) { this.setData({ penalty: e.detail.value }, () => this._recalc()) },
  onDiscount(e) { this.setData({ discount: e.detail.value }, () => this._recalc()) },
  onRemark(e) { this.setData({ remark: e.detail.value }) },

  // 通过：先二次确认，确认后 POST /api/doApplyCheck（state = 2 通过）
  onPass() {
    if (this._submitting) return
    wx.showModal({
      title: '预约审批',
      content: '确认通过审批！',
      confirmColor: '#0A7BB8',
      success: res => {
        if (res.confirm) this._submitCheck(2, '审批通过！')
      }
    })
  },

  // 拒绝：先二次确认，确认后 POST /api/doApplyCheck（state = 3 拒绝）
  onReject() {
    if (this._submitting) return
    wx.showModal({
      title: '预约审批',
      content: '确认拒绝通过！',
      confirmColor: '#0A7BB8',
      success: res => {
        if (res.confirm) this._submitCheck(3, '审批拒绝！', 'none')
      }
    })
  },

  // 提交审批结果：state 2 = 通过 / 3 = 拒绝
  _submitCheck(state, okMsg, icon) {
    const { id, penalty, discount, total, remark } = this.data
    if (!id) {
      wx.showToast({ title: '缺少审批单 id', icon: 'none' })
      return
    }
    // 拒绝（state=3）按接口约定只提交 id / realPrice / remark，不带罚金与折扣
    const payload = { id, state, realPrice: num(total), remark: String(remark || '') }
    if (state === 2) {
      payload.priceUp = num(penalty)
      payload.priceDown = num(discount)
    }
    this._submitting = true
    wx.showLoading({ title: '提交中…', mask: true })
    doApplyCheck(payload)
      .then(() => {
        wx.hideLoading()
        this._submitting = false
        wx.showToast({ title: okMsg, icon: icon || 'success', duration: 1500 })
        setTimeout(() => wx.navigateBack(), 700)
      })
      .catch(err => {
        wx.hideLoading()
        this._submitting = false
        console.warn('[booking-approve] /api/doApplyCheck 失败：', err)
        wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' })
      })
  },



  onClose() {
    wx.navigateBack()
  }
})
