// pages/duty-admin/index.js —— 值日管理（我的值日周表）
// 数据来源：GET /api/workstation/duty/myWeek?token=xxx
//   days 不传，由后端按默认 7 天返回（需要指定天数时传 { days: N }）
const {
  getWorkstationDutyMyWeek, saveWorkstationDutySign, getApplyUserDetail,
  ADMISSION_USER_DETAIL_KEY, ADMISSION_USER_DETAIL_TTL
} = require('../../utils/api.js')
const { getOpenId } = require('../../utils/auth.js')

const DOW = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

// 一行最多展示几个人（多的折叠为 +N，避免换行）
const MAX_PER_ROW = 3

// 人员字段候选（对象数组）
const MEMBER_ARR_KEYS = ['users', 'userList', 'members', 'dutyUsers', 'dutyUserList',
  'persons', 'personList', 'signUsers', 'userNames', 'names']
// 人员字段候选（字符串，多个姓名用逗号/顿号/斜杠分隔）
const MEMBER_STR_KEYS = ['userNames', 'dutyUser', 'userName', 'members', 'names', 'name']
// 日期字段候选
const DATE_KEYS = ['dutyDate', 'date', 'day', 'dutyDay', 'weekDate', 'workDate', 'scheduleDate']
// 星期字段候选（取不到时按日期推算）
const DOW_KEYS = ['week', 'weekDay', 'weekday', 'dow', 'dayOfWeek', 'weekText', 'weekName']
// 工位 id 字段候选（打卡接口需要）
const WORKSTATION_KEYS = ['workstationId', 'workstation_id', 'stationId', 'seatId', 'wsId']
// 打卡状态字段候选：signState = 1 表示已打卡
const SIGN_KEYS = ['signState', 'sign_state', 'signStatus', 'signFlag', 'state']
// 组长字段候选（字符串或对象）：接口字段为 chargeUserName，其余为兼容兜底
const LEADER_KEYS = ['chargeUserName', 'chargeUser', 'leaderName', 'leader',
  'groupLeader', 'dutyLeader', 'leaderUser']

Page({
  data: {
    loading: true,      // 首次加载 / 刷新中
    error: '',          // 非空 = 请求失败，展示重试
    leader: '',         // 组长姓名（接口没给则不显示组长卡）
    leaderAvatar: '',
    days: [],           // [{ key, dow, dateText, isToday, members: [{ key, name, avatar }] }]
    dayCount: 0,
    canCheckIn: false,  // 今天的值日人员里包含「我」→ 显示底部值日打卡按钮
    checkedToday: false // 今天已打卡
  },

  onLoad() {
    this._load()
  },

  onPullDownRefresh() {
    this._load().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  // 点击「重新加载」
  retry() {
    this._load()
  },

  // 点 +N：该天展开全部 / 收起（默认收起，保证一行最多 3 人不换行）
  toggleMore(e) {
    const i = Number(e.currentTarget.dataset.index)
    const days = this.data.days.slice()
    const d = days[i]
    if (!d) return
    const expanded = !d.expanded
    days[i] = Object.assign({}, d, {
      expanded,
      show: expanded ? d.members : d.members.slice(0, MAX_PER_ROW),
      more: expanded ? 0 : Math.max(0, (d.total || 0) - MAX_PER_ROW)
    })
    this.setData({ days })
  },

  async _load() {
    if (this._loading) return
    this._loading = true
    this.setData({ loading: true, error: '' })
    try {
      // days 不传 → 后端默认 7 天
      const raw = await getWorkstationDutyMyWeek()
      const view = this._normalize(raw)
      // 当前登录用户：用于判断今天的值日人员里有没有「我」
      const self = await this._ensureSelf()
      const today = view.days.find(d => d.isToday) || null
      // 今天的值日人员里有没有「我」
      const me = today ? today.members.find(m => isSelf(m, self)) : null
      const canCheckIn = !!me
      // 已打卡判定：今天这行的 signState=1，或「我」这条记录的 signState=1
      const signed = !!today &&
        (String(today.signState) === '1' || (!!me && String(me.signState) === '1'))
      this.setData({
        loading: false,
        error: '',
        leader: view.leader,
        leaderAvatar: view.leader ? view.leader.charAt(0) : '',
        days: view.days,
        dayCount: view.days.length,
        canCheckIn,
        checkedToday: signed
      })
      this._loadedOnce = true
      console.log('[duty] 值日周表：组长 =', view.leader || '（无）',
        '，共', view.days.length, '天；今天值日 =', !!today,
        '，包含我 =', canCheckIn, '，signState =', today ? today.signState : '-',
        '/ 我的 =', me ? me.signState : '-', '→ 已打卡 =', signed, '｜我 =', self)
    } catch (err) {
      console.warn('[duty] /api/workstation/duty/myWeek 获取失败：', err)
      this.setData({
        loading: false,
        error: (err && (err.message || err.errMsg)) || '值日安排获取失败，请稍后重试'
      })
    } finally {
      this._loading = false
    }
  },

  // 后端结构兼容：
  //   · 数组：[{ dutyDate, users: [...] }, ...]
  //   · 对象：{ leader, list|rows|records|items|data|days|dutyList|schedules: [...] }
  _normalize(raw) {
    let leader = ''
    let list = null
    if (Array.isArray(raw)) {
      list = raw
    } else if (raw && typeof raw === 'object') {
      leader = this._pickLeader(raw)
      const keys = ['list', 'rows', 'records', 'items', 'data', 'days', 'dayList',
        'dutyList', 'dutyDays', 'schedules', 'weekList', 'weekDays']
      for (const k of keys) {
        if (Array.isArray(raw[k])) {
          list = raw[k]
          break
        }
      }
    }
    // 接口可能一天一条记录（每人/每班次一条）→ 按日期合并成一天一行；
    // 同一行最多 3 人（多的折叠成 +N），保证不换行
    const days = withMemberLimit(mergeByDate(
      (Array.isArray(list) ? list : []).map((d, i) => this._toDay(d, i)).filter(Boolean)
    ))
    // 接口没给组长时，退回某一天里的组长字段
    if (!leader) {
      for (let i = 0; i < days.length; i++) {
        if (days[i].leader) {
          leader = days[i].leader
          break
        }
      }
    }
    return { leader, days }
  },

  _toDay(it, i) {
    if (!it || typeof it !== 'object') return null
    const date = String(pick(it, DATE_KEYS) || '').trim().slice(0, 10)
    const dow = String(pick(it, DOW_KEYS) || '').trim() || dowOf(date) || ''
    return {
      key: date || ('d' + i),
      date,                 // 原始日期（用于同一天合并与排序）
      dow: dow || ('第 ' + (i + 1) + ' 天'),
      // 展示用日期：2026-10-29 → 10/29
      dateText: /^\d{4}-\d{2}-\d{2}$/.test(date) ? (date.slice(5, 7) + '/' + date.slice(8, 10)) : date,
      // 今天：有日期按日期比；没日期时按星期比（整行高亮用）
      isToday: date ? (date === todayStr()) : (!!dow && dow === DOW[new Date().getDay()]),
      // 今天这行的工位 id（打卡接口需要）
      workstationId: pick(it, WORKSTATION_KEYS),
      // 打卡状态：signState = 1 表示当天已打卡
      signState: pick(it, SIGN_KEYS),
      members: membersOf(it),
      leader: this._pickLeader(it)
    }
  },

  // 当前登录用户（id + 姓名）：/system/apply_user/detail 的 user，带跨页缓存
  async _ensureSelf() {
    if (this._self) return this._self
    let user = null
    try {
      const cached = wx.getStorageSync(ADMISSION_USER_DETAIL_KEY)
      if (cached && typeof cached === 'object' &&
        (Date.now() - (cached._ts || 0) < ADMISSION_USER_DETAIL_TTL)) {
        user = cached.user || null
      }
    } catch (e) { /* 忽略缓存异常 */ }
    if (!user || typeof user !== 'object') {
      try {
        const detail = await getApplyUserDetail(getOpenId())
        user = (detail && detail.user) || null
      } catch (e) {
        console.warn('[duty] apply_user/detail 获取失败：', e)
      }
    }
    const pickStr = (keys) => {
      if (!user || typeof user !== 'object') return ''
      for (const k of keys) {
        const v = user[k]
        if (v !== undefined && v !== null && v !== '') return String(v)
      }
      return ''
    }
    this._self = {
      id: pickStr(['userId', 'id', 'user_id', 'uid']),
      name: pickStr(['userName', 'nickName', 'realName', 'name', 'loginName'])
    }
    return this._self
  },

  // ── 底部浮动「值日打卡」：扫码 → POST /api/workstation/duty/signJson ──
  // 参数：token（query）、workstationId（今天值日行的工位 id）、dutyDate（YYYY-MM-DD）
  onDutyCheckIn() {
    if (this._signing || this.data.checkedToday) return
    const today = this.data.days.find(d => d.isToday)
    if (!today) return
    const wsId = today.workstationId
    if (!wsId) {
      wx.showToast({ title: '今天的值日记录未关联工位，无法打卡', icon: 'none', duration: 2500 })
      return
    }
    // dutyDate：优先用接口给的今天日期，没有则取本地今天
    const dutyDate = today.date || todayStr()
    wx.scanCode({
      scanType: ['qrCode'],
      onlyFromCamera: false,
      success: (res) => {
        const code = (res.result || '').trim()
        if (!code) {
          wx.showToast({ title: '请扫码正确的二维码', icon: 'none' })
          return
        }
        console.log('[duty] 扫码结果：', code)
        this._saveDutySign(wsId, dutyDate)
      },
      fail: () => {
        wx.showToast({ title: '请扫码正确的二维码', icon: 'none' })
      }
    })
  },

  async _saveDutySign(workstationId, dutyDate) {
    if (this._signing) return
    this._signing = true
    const numId = Number(workstationId)
    wx.showLoading({ title: '打卡中…', mask: true })
    try {
      await saveWorkstationDutySign({
        workstationId: isNaN(numId) ? workstationId : numId,
        dutyDate
      })
      wx.hideLoading()
      this.setData({ checkedToday: true })
      wx.showToast({ title: '打卡成功', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      console.warn('[duty] 值日打卡失败：', err)
      wx.showToast({
        title: (err && (err.message || err.errMsg)) || '打卡失败，请稍后重试',
        icon: 'none',
        duration: 2500
      })
    } finally {
      this._signing = false
    }
  },

  _pickLeader(o) {
    if (!o || typeof o !== 'object') return ''
    for (const k of LEADER_KEYS) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
      if (v && typeof v === 'object') {
        const n = String(v.userName || v.name || v.realName || v.nickName || '').trim()
        if (n) return n
      }
    }
    return ''
  }
})

// 今天（YYYY-MM-DD，本地时区）
function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// 值日人员是不是「我」：优先比 userId，其次比姓名
function isSelf(m, self) {
  if (!m || !self) return false
  if (self.id && m.id && String(m.id) === String(self.id)) return true
  return !!(self.name && m.name && String(m.name) === String(self.name))
}

// 从对象里按候选键取第一个非空值
function pick(o, keys) {
  if (!o || typeof o !== 'object') return ''
  for (const k of keys) {
    const v = o[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

// 每行最多显示 3 人，超出部分折叠为 +N（不换行）
function withMemberLimit(days) {
  return days.map(d => {
    const total = (d.members || []).length
    const show = total > MAX_PER_ROW ? d.members.slice(0, MAX_PER_ROW) : d.members
    return Object.assign({}, d, {
      show, more: total - show.length, total,
      expanded: false        // 默认收起：一行最多 3 人，点 +N 才展开
    })
  })
}

// 同一日期的多条记录合并成一行：
//   · 分组键 = 日期（无日期时按星期分组）
//   · 人员合并并按姓名去重（同名 / 同人多班次只显示一次）
//   · 排序：有日期的按日期升序，无日期的保持原顺序排在后面
function mergeByDate(rows) {
  const order = []
  const map = {}
  rows.forEach((r) => {
    const k = r.date ? r.date : ('__dow_' + r.dow)
    if (!map[k]) {
      map[k] = Object.assign({}, r, { key: k, members: r.members.slice() })
      order.push(k)
    } else {
      const seen = {}
      map[k].members.forEach(m => { seen[m.name] = 1 })
      r.members.forEach(m => {
        if (!seen[m.name]) {
          seen[m.name] = 1
          map[k].members.push(m)
        }
      })
      if (!map[k].leader && r.leader) map[k].leader = r.leader
      if (!map[k].dateText && r.dateText) map[k].dateText = r.dateText
      // 同一天合并时，任一条已打卡（signState=1）就视为当天已打卡
      if (String(map[k].signState) !== '1' && r.signState !== '') map[k].signState = r.signState
    }
  })
  const days = order.map(k => map[k])
  const withDate = days
    .filter(d => d.date)
    .sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)))
  const noDate = days.filter(d => !d.date)
  return withDate.concat(noDate)
}

// 日期 → 星期（2026-10-29 → 星期四）
function dowOf(date) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(date || ''))
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return isNaN(d.getTime()) ? '' : DOW[d.getDay()]
}

// 值日人员：对象数组 → [{ name, avatar }]；字符串按 , ， 、 / 拆分
function membersOf(it) {
  let arr = null
  for (const k of MEMBER_ARR_KEYS) {
    if (Array.isArray(it[k])) {
      arr = it[k]
      break
    }
  }
  if (!arr) {
    const s = String(pick(it, MEMBER_STR_KEYS) || '').trim()
    if (s) arr = s.split(/[,，、\/|\s]+/)
  }
  return (arr || []).map((m, j) => {
    const name = (typeof m === 'string')
      ? m.trim()
      : String((m && (m.userName || m.name || m.realName || m.nickName)) || '').trim()
    if (!name) return null
    // id 用于判断「今天的值日人员里有没有我」
    const id = (m && typeof m === 'object')
      ? String(m.userId || m.id || m.user_id || m.uid || '')
      : ''
    // 个人打卡状态（有些接口把 signState 放在人员这一级）
    const signState = (m && typeof m === 'object') ? pick(m, SIGN_KEYS) : ''
    return { key: name + '-' + j, name, avatar: name.charAt(0), id, signState }
  }).filter(Boolean)
}
