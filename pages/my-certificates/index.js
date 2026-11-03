// pages/my-certificates/index.js
// 我的证书列表页：
//   入口  profile.js → POST /system/cert_record/getList { openId }
//        成功时写入 wx.storage(CERT_RECORD_LIST_KEY) → 跳到此页
//   本页  onLoad 先读缓存渲染，再独立实时刷新；下拉刷新重新请求
//        若缓存缺失（例如直接通过首页入口跳转），会用 openId 重新拉一次
//   字段  兼容驼峰 / 下划线 / 嵌套结构，归一化后渲染

const { CERT_RECORD_LIST_KEY, getCertRecordList } = require('../../utils/api.js')
const { getOpenId } = require('../../utils/auth.js')

// 类型 / 状态 → 中文与样式（猜测值，可在接入实际接口后微调）
const TYPE_LABEL = {
  1: '安全证书',
  2: '资质证书',
  3: '培训证书'
}
// 状态枚举：与 bookingStatus.js 同种思路，state 数字 → {text, cls}
//   1=有效 · 0=已失效/未通过 · 2=审核中 · 3=已过期 · 4=已撤回
const STATE_MAP = {
  1: { text: '有效',   cls: 'valid' },
  0: { text: '已失效', cls: 'invalid' },
  2: { text: '审核中', cls: 'reviewing' },
  3: { text: '已过期', cls: 'expired' },
  4: { text: '已撤回', cls: 'invalid' }
}

// 日期清洗：兼容 'YYYY-MM-DD'、'YYYY-MM-DD HH:mm:ss'、unix(秒/毫秒) → 'YYYY-MM-DD'
function fmtDate(s) {
  if (s === '' || s == null) return ''
  if (typeof s === 'number' || /^\d{9,13}$/.test(String(s).trim())) {
    const raw = String(s).trim()
    const ms = raw.length === 13 ? Number(raw) : Number(raw) * 1000
    const d = new Date(ms)
    if (!isNaN(d.getTime())) {
      const p = (x) => (x < 10 ? '0' + x : '' + x)
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }
  }
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}

// 从 row 中按优先级数组拿第一个有值字段；支持点号路径（cert.name）
function pick(row, ...keys) {
  for (const k of keys) {
    if (!k) continue
    const parts = k.split('.')
    let v = row
    for (const p of parts) {
      if (v == null) { v = undefined; break }
      v = v[p]
    }
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

// 归一化：把后端返回的任意形态 row → wxml 直接可绑定的 cert
function normalizeCert(row) {
  const str = (v, dflt) => (v === undefined || v === null) ? (dflt || '') : String(v).trim()
  const num = (v) => {
    if (v === '' || v == null) return 0
    const n = Number(v)
    return isNaN(n) ? 0 : n
  }

  const typeRaw = pick(row, 'certType', 'type', 'category')
  const typeLabel = TYPE_LABEL[num(typeRaw)] || (str(typeRaw) || '证书')

  const stateRaw = pick(row, 'state', 'status', 'valid', 'isValid')
  let statusText = '有效'
  let statusCls = 'valid'
  if (stateRaw !== '' && stateRaw != null) {
    const n = num(stateRaw)
    if (STATE_MAP[n] || STATE_MAP[String(n)]) {
      const m = STATE_MAP[n] || STATE_MAP[String(n)]
      statusText = m.text
      statusCls = m.cls
    } else {
      // 字符串型（如 'valid' / 'expired' / 'invalid' 等）
      const txt = String(stateRaw).trim()
      if (/有效|通过|success/i.test(txt)) { statusText = '有效'; statusCls = 'valid' }
      else if (/失效|无效|未通过|fail/i.test(txt)) { statusText = '已失效'; statusCls = 'invalid' }
      else if (/审核|review/i.test(txt)) { statusText = '审核中'; statusCls = 'reviewing' }
      else if (/过期|expired/i.test(txt)) { statusText = '已过期'; statusCls = 'expired' }
      else { statusText = txt || '有效'; statusCls = 'valid' }
    }
  }

  const issueDate = fmtDate(pick(row, 'issueDate', 'issue_date', 'validFrom', 'valid_from', 'startTime'))
  const expireDate = fmtDate(pick(row, 'expireDate', 'expire_date', 'expireTime', 'expiryDate', 'validUntil', 'valid_until', 'endTime'))
  const validPeriod = (issueDate && expireDate)
    ? (issueDate + ' ~ ' + expireDate)
    : (issueDate ? (issueDate + ' 起')
    : (expireDate ? ('至 ' + expireDate) : ''))

  return {
    id: str(pick(row, 'id', 'certId', 'cert_id', 'recordId')),
    name: str(pick(row, 'certName', 'name', 'certificateName', 'title', 'cert.name')) || '证书',
    typeRaw: str(typeRaw, ''),
    typeLabel,
    certNo: str(pick(row, 'certNo', 'cert_no', 'certificateNo', 'no', 'number')),
    deviceName: str(pick(row, 'deviceName', 'trainingName', 'training.name', 'device.name', 'cert.deviceName')),
    score: str(pick(row, 'score', 'examScore', 'exam_score'), ''),
    issueDate,
    expireDate,
    validPeriod,
    statusText,
    statusCls
  }
}

Page({
  data: {
    list: [],
    loading: true,           // 顶部 loading 条
    loadingText: '正在加载证书…',
    showEmpty: false,
    emptyText: '暂未获得任何证书',
    openId: ''
  },

  onLoad() {
    const openId = getOpenId() || ''
    this.setData({ openId })

    // 先读缓存渲染（profile.js 跳过来已写入）→ 命中时跳过 loading
    let cached = []
    try { cached = wx.getStorageSync(CERT_RECORD_LIST_KEY) || [] } catch (e) { cached = [] }
    if (Array.isArray(cached) && cached.length) {
      this._render(cached, false)
      this.setData({ loading: false })
    }

    if (openId) {
      this._refresh(openId, false)
    } else {
      this.setData({
        loading: false,
        showEmpty: !cached.length,
        emptyText: cached.length ? '' : '请先登录后再查看证书'
      })
    }
  },

  // 下拉刷新：拉最新数据，回到老列表仍保留，避免空白闪烁
  onPullDownRefresh() {
    if (!this.data.openId) {
      wx.stopPullDownRefresh()
      return
    }
    this._refresh(this.data.openId, true)
  },

  // 跳到证书详情页（pages/cert-detail）：传 id，新页 onLoad 内会从缓存 / 接口找原 row
  onCardTap(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || ''
    if (!id) {
      wx.showToast({ title: '证书 id 缺失', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/cert-detail/index?id=' + encodeURIComponent(id) })
  },

  // 请求列表 → 落缓存 → 渲染
  _refresh(openId, fromPullDown) {
    if (!fromPullDown) this.setData({ loading: true, loadingText: '正在加载证书…' })

    getCertRecordList(openId)
      .then(list => {
        try { wx.setStorageSync(CERT_RECORD_LIST_KEY, list || []) } catch (e) { /* 忽略缓存异常 */ }
        this._render(list || [], false)
        this.setData({ loading: false })
      })
      .catch(err => {
        console.warn('[my-certificates] /system/cert_record/getList 失败：', err)
        // 已有缓存：只 toast，不清空列表
        if (this.data.list && this.data.list.length) {
          this.setData({ loading: false })
          wx.showToast({
            title: '刷新失败：' + ((err && err.message) || '网络异常'),
            icon: 'none',
            duration: 1800
          })
        } else {
          this.setData({
            loading: false,
            showEmpty: true,
            emptyText: (err && err.message) || '证书列表加载失败，请稍后重试'
          })
        }
      })
      .finally(() => {
        if (fromPullDown) wx.stopPullDownRefresh()
      })
  },

  _render(rawList, keepLoading) {
    const list = (Array.isArray(rawList) ? rawList : []).map(normalizeCert)
    this.setData({
      list,
      loading: !!keepLoading,
      showEmpty: list.length === 0,
      emptyText: list.length === 0 ? '暂未获得任何证书' : ''
    })
  }
})
