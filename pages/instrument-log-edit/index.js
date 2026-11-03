// pages/instrument-log-edit/index.js —— 修改上机记录
// 结构对照图示：上机用户(可改，底部弹起选人) / 开始时间 / 结束时间(附时长) /
//               金额明细(可添加多行 单价 × 数量) / 实际支付 / 底部取消·修改
// 点「修改」→ POST /api/editDeviceLogDetail（参数口径见 utils/api.js 的同名封装）

// 可选上机用户（演示数据）：姓名 + 登录号
// 登录号沿用预约调整页 MOCK_BOOKINGS 的 wx 号，其余按同一规则补齐
const MOCK_USERS = [
  { name: '王英', login: 'wx002133' },
  { name: '李文博', login: 'wx001872' },
  { name: '陈静', login: 'wx002041' },
  { name: '张岩', login: 'wx002265' },
  { name: '孙立', login: 'wx003015' },
  { name: '赵启明', login: 'wx003147' },
  { name: '王敏', login: 'wx003268' },
  { name: '周倩', login: 'wx003401' },
  { name: '刘思远', login: 'wx003592' },
  { name: '郝铭', login: 'wx003646' },
  { name: '钱菲', login: 'wx003719' },
  { name: '吴楠', login: 'wx003880' },
  { name: '郑舒', login: 'wx003954' }
]

const { editDeviceLogDetail, getDeviceLogDetail } = require('../../utils/api.js')

// 头像底色：按序循环，避免每人同色
const AV_BG = ['#0A7BB8', '#33ADDE', '#4CAF50', '#E65100', '#5E35B1', '#00897B']

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

// 从对象里按多条路径取值（兼容驼峰 / 下划线），取不到返回 ''
function pickOf(o, paths) {
  for (let i = 0; i < paths.length; i++) {
    const segs = String(paths[i]).split('.')
    let cur = o
    let ok = true
    for (let k = 0; k < segs.length; k++) {
      if (!cur || typeof cur !== 'object') { ok = false; break }
      cur = cur[segs[k]]
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur
  }
  return ''
}

// 金额统一保留两位有效小数，避免 0.1+0.2 之类的浮点尾巴
function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, ''))
  if (isNaN(n)) return 0
  return Math.round(n * 100) / 100
}

Page({
  data: {
    id: '',
    userName: '',
    // 这条记录的使用人 id（列表页带过来；改单提交 /api/editDeviceLogDetail 的 userId）
    userId: '',
    begin: '',
    finish: '',
    durText: '',
    // 金额明细：单价 × 数量 = 金额，可添加多行（key 用于 wx:for 稳定复用）
    items: [{ key: 1, unit: '0', qty: '1', amount: 0 }],
    penalty: '0',
    discount: '0',
    base: 0,          // 各行金额之和
    total: 0,         // 实际支付
    formula: '',      // 实际支付算式（不含总计）
    users: [],        // 底部选人弹层的人员列表
    showUserPicker: false
  },

  // 新增行的 key 自增源
  _seqKey: 1,

  onLoad(options) {
    const userName = decodeURIComponent(options.user || '')
    const begin = decodeURIComponent(options.begin || '')
    const finish = decodeURIComponent(options.finish || '')
    this.setData({
      id: options.id || '',
      userName,
      userId: decodeURIComponent((options && options.userId) || ''),
      begin,
      finish,
      durText: durOf(begin, finish),
      // 从记录列表带过来的单价 / 数量作为第一行
      items: [{
        key: 1,
        unit: String(options.unit != null ? options.unit : '0'),
        qty: String(options.qty != null ? options.qty : '1'),
        amount: 0
      }],
      penalty: String(options.penalty != null ? options.penalty : '0'),
      discount: String(options.discount != null ? options.discount : '0')
    })
    this._recalc()
    // 有记录 id → 拉详情：拿到带 user_id 的上机用户列表，改人后才能提交新的 userId
    if (this.data.id) this._loadDetail()
  },

  // POST /api/deviceLogDetail：{ id, token }
  // 返回 deviceLog（当前记录）+ users（可改成的上机用户，含 user_id）
  _loadDetail() {
    getDeviceLogDetail(this.data.id)
      .then(data => {
        const x = (data && typeof data === 'object') ? data : {}
        const log = (x.deviceLog && typeof x.deviceLog === 'object') ? x.deviceLog
          : ((x.log && typeof x.log === 'object') ? x.log : x)
        const rawUsers = Array.isArray(x.users) ? x.users
          : (Array.isArray(x.userList) ? x.userList : [])
        const users = rawUsers.map(u => ({
          name: String(pickOf(u, ['user_name', 'userName', 'name'])),
          login: String(pickOf(u, ['login_name', 'loginName', 'login'])),
          userId: String(pickOf(u, ['user_id', 'userId', 'id']))
        })).filter(u => u.name)
        const patch = {}
        // 使用人：id 与姓名都以接口为准（改单提交 userId 用）
        const uid = String(pickOf(log, ['user_id', 'userId']))
        const uname = String(pickOf(log, ['user_name', 'userName']))
        if (uid) patch.userId = uid
        if (uname) patch.userName = uname
        if (users.length) patch.users = users
        const price = pickOf(log, ['price'])
        const count = pickOf(log, ['count', 'num'])
        const priceUp = pickOf(log, ['price_up', 'priceUp'])
        const priceDown = pickOf(log, ['price_down', 'priceDown'])
        if (price !== '') {
          patch.items = [{ key: 1, unit: String(price), qty: String(count || 1), amount: 0 }]
        }
        if (priceUp !== '') patch.penalty = String(priceUp)
        if (priceDown !== '') patch.discount = String(priceDown)
        this.setData(patch, () => this._recalc())
      })
      .catch(err => {
        // 详情拿不到时沿用列表页带过来的参数（此时选人列表是演示数据，改人后无真实 id）
        console.warn('[instrument-log-edit] /api/deviceLogDetail 失败：', err)
      })
  },

  // 添加一行「单价 × 数量」：默认值留空，靠 placeholder 提示「单价 / 数量」，
  // 不预填 0 / 1（空值参与计算时按 0 处理，不影响合计）
  onAddItem() {
    this._seqKey += 1
    const items = this.data.items.concat([{ key: this._seqKey, unit: '', qty: '', amount: 0 }])
    this.setData({ items }, () => this._recalc())
  },

  // 删除某一行（至少保留一行）
  onRemoveItem(e) {
    if (this.data.items.length <= 1) return
    const i = Number(e.currentTarget.dataset.i)
    const items = this.data.items.filter((x, k) => k !== i)
    this.setData({ items }, () => this._recalc())
  },

  onUnitInput(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({ ['items[' + i + '].unit']: e.detail.value }, () => this._recalc())
  },

  onQtyInput(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({ ['items[' + i + '].qty']: e.detail.value }, () => this._recalc())
  },

  // 重算：Σ(单价 × 数量) + 罚金 - 折扣 = 实际支付
  _recalc() {
    const items = (this.data.items || []).map(x => Object.assign({}, x, {
      amount: Math.round(num(x.unit) * num(x.qty) * 100) / 100
    }))
    const penalty = num(this.data.penalty)
    const discount = num(this.data.discount)
    const base = Math.round(items.reduce((s, x) => s + x.amount, 0) * 100) / 100
    const total = Math.round((base + penalty - discount) * 100) / 100
    // 算式：1(单价) × 1(数量) + 2(单价) × 3(数量) + 7(罚金) - 4(折扣) = …
    const parts = items.map(x => num(x.unit) + '(单价) × ' + num(x.qty) + '(数量)')
    const formula = parts.join(' + ') + ' + ' + penalty + '(罚金) - ' + discount + '(折扣) = '
    this.setData({ items, base, total, formula })
  },

  onPenalty(e) { this.setData({ penalty: e.detail.value }, () => this._recalc()) },
  onDiscount(e) { this.setData({ discount: e.detail.value }, () => this._recalc()) },

  // 人员列表 → 视图数据：头像取姓氏首字，当前用户默认打勾
  // 优先用 /api/deviceLogDetail 返回的真实用户（带 user_id）；没有时回退演示数据（id 用序号）
  _buildUsers() {
    const src = (this.data.users && this.data.users.length) ? this.data.users : MOCK_USERS
    return src.map((u, i) => ({
      name: u.name,
      login: u.login,
      userId: String(pickOf(u, ['userId', 'user_id', 'id']) || (i + 1)),
      avatar: u.name.charAt(0),
      bg: AV_BG[i % AV_BG.length],
      checked: u.name === this.data.userName
    }))
  },

  // 修改上机用户：底部弹起选择人员（姓名 + 登录号）
  onOpenUserPicker() {
    this.setData({ users: this._buildUsers(), showUserPicker: true })
  },

  onCloseUserPicker() {
    this.setData({ showUserPicker: false })
  },

  onSelectUser(e) {
    const i = Number(e.currentTarget.dataset.i)
    const picked = this.data.users[i]
    if (!picked) return
    const users = this.data.users.map((u, k) => Object.assign({}, u, { checked: k === i }))
    // 改了上机用户 → userId 一起换成新用户的 id，改单提交时带的就是这个值
    this.setData({ userName: picked.name, userId: picked.userId, users, showUserPicker: false })
  },

  onCancel() {
    wx.navigateBack()
  },

  onSave() {
    if (this._saving) return
    const d = this.data
    if (!d.id) {
      wx.showToast({ title: '缺少记录 id', icon: 'none' })
      return
    }
    const items = d.items || []
    const first = items[0] || { unit: '', qty: '' }
    // 第一行之外其余行的金额之和（对应接口的 itemCount）
    const itemCount = Math.round(items.slice(1)
      .reduce((s, x) => s + num(x.unit) * num(x.qty), 0) * 100) / 100
    const total = num(d.total)
    // userId：这条记录的上机用户 id；在弹层里改过人就是新用户 id
    const uid = d.userId
    const payload = {
      id: String(d.id),
      price: String(num(first.unit)),
      num: num(first.qty),
      priceUp: String(num(d.penalty)),
      priceDown: String(num(d.discount)),
      itemCount,
      amount: total.toFixed(2),
      userId: Number(uid) || 0
    }

    this._saving = true
    wx.showLoading({ title: '提交中…', mask: true })
    editDeviceLogDetail(payload)
      .then(() => {
        wx.hideLoading()
        this._saving = false
        // 多行明细拼成一行摘要：200元 × 2 + 150元 × 1 + 7(罚金) - 4(折扣)
        const parts = items.map(x => num(x.unit) + '元 × ' + num(x.qty))
        const feeLeft = parts.join(' + ') + ' + ' + num(d.penalty) + '(罚金) - ' + num(d.discount) + '(折扣)'
        const feeRight = '= ' + total + '元(实付)'
        // 回写上一页（上机记录列表）即时展示，再让它重新拉一次接口保证数据一致
        const pages = getCurrentPages()
        const prev = pages[pages.length - 2]
        if (prev && typeof prev.updateRecord === 'function') {
          prev.updateRecord({ id: d.id, userName: d.userName, feeLeft, feeRight, total })
        }
        if (prev && typeof prev.reload === 'function') prev.reload()
        wx.showToast({ title: '修改成功', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch(err => {
        wx.hideLoading()
        this._saving = false
        console.warn('[instrument-log-edit] /api/editDeviceLogDetail 失败：', err)
        wx.showToast({ title: (err && err.message) || '修改失败', icon: 'none' })
      })
  }
})
