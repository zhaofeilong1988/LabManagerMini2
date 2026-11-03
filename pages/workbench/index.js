// pages/workbench/index.js —— 实验台（合并页）
// 入口：首页快捷入口「实验台」按钮 / 我的工位页（点申请记录或扫码打卡）
// 行为：根据当前用户最新一条申请记录的状态自适应展示三段视图
//   apply    —— 无记录：申请表单
//   pending  —— 待审核：已提交信息摘要 + 模拟审核通过按钮
//   approved —— 已通过：原扫码详情（信息卡 + 扫码打卡卡 + 本月考勤柱状图 + 打卡记录/附件）
// 数据源：本地存储 workbenchApplies（同 my-station / 旧的 workbench-apply / station-checkin）
const { getInitials, getPinyinKeys, matchInitials } = require('../../utils/pinyin')
const {
  uploadImage, uploadFile, BASE, getWorkstationTeamTree, saveWorkstationApply,
  saveWorkstationSign, getWorkstationApplyDetail, getApplyUserDetail,
  ADMISSION_USER_DETAIL_KEY, ADMISSION_USER_DETAIL_TTL
} = require('../../utils/api.js')
const { getOpenId } = require('../../utils/auth.js')
const { isDevEnv: detectDevEnv, resetWorkbenchData } = require('../../utils/dev-reset.js')

// ── 课题组候选（与准入登记页 register.js 保持一致） ──
function withSearch(item, text) {
  const t = String(text == null ? '' : text)
  return Object.assign({}, item, {
    initials: item.initials || getInitials(t),
    pyKeys: item.pyKeys || getPinyinKeys(t)
  })
}
const GROUPS = [
  ['神经生物学与神经影像研究组', '神经影像实验室'],
  ['免疫细胞分选与功能分析课题组', '免疫学流式分析实验室'],
  ['分子影像与肿瘤微环境课题组', '生物成像与分析实验室'],
  ['纳米材料与生物界面课题组', '电镜中心实验室'],
  ['药物靶点与分子药理课题组', '分子药理学实验室'],
  ['代谢与脂质组学研究组', '转化医学研究所'],
  ['遗传与表观调控课题组', '化学与材料中心'],
  ['动物疾病模型与评价课题组', '神经影像实验室']
].map(([name, dept], i) => withSearch({ id: i + 1, name, dept, searchTxt: name + ' ' + dept }, name + dept))

const MAX_FILES = 3   // 导师签字同意书最多上传文件数

// 头像底色：按序循环（与修改上机记录选人一致）
const AV_BG = ['#0A7BB8', '#33ADDE', '#4CAF50', '#E65100', '#5E35B1', '#00897B']

// 后端 state → 本地 status：0 待审核 / 1 已通过 / 2 已驳回
const STATE_STATUS = { 0: 'pending', 1: 'approved', 2: 'rejected' }
// 待审核时详情查询间隔（毫秒）
const POLL_INTERVAL = 3000

Page({
  data: {
    // 视图模式：apply | pending | approved
    mode: 'apply',

    // ── 申请表单（apply 模式） ──
    form: {
      group: '',        // 课题组名称
      teamId: '',       // 课题组 id（接口 team/tree 第一层）
      seat: '',         // 工位名称（接口 team/tree 的 children）
      seatId: '',       // 工位 id
      startDate: '',
      endDate: '',
      reason: ''
    },
    // 课题组树（/api/workstation/team/tree）：[{ id, name, sub, children: [{ id, name, sub }] }]
    teams: [],
    teamsLoading: false,
    reasonLen: 0,       // 申请理由字数（WXML 不能对表达式取 .length，这里预计算）
    photos: [],
    // mode：team = 选课题组 / seat = 选工位（共用同一个可搜索弹层）
    picker: { show: false, mode: 'team', kw: '', list: [] },
    showConfirm: false,

    // ── 已提交信息摘要（pending / rejected 模式） ──
    submitted: null,    // { group, startDate, endDate, reason, submitTime, attachments }
    rejectReason: '',   // 驳回原因（state = 2 时后端返回的 reason）

    // ── 审核通过详情（approved 模式） ──
    rec: null,
    stationCode: '',
    statusText: '',
    statusCls: '',
    monthDays: [],
    stats: { checked: 0, total: 0, rate: 0 },
    checkIns: [],
    attachments: [],
    // 是否运行在开发版/体验版（用于显隐底部「重置实验台申请数据」按钮）
    isDevEnv: false
  },

  onLoad(options) {
    this._paramId = (options && options.id) || ''
    // 兜底重置：避免页面栈复用 + data 残留时弹层处于 show=true 覆盖整个页面
    // （onShow→_load 也会重置一次，但这里再保一次，覆盖 onShow 因任何原因未触发的极端情况）
    this.setData({
      picker: { show: false, mode: 'team', kw: '', list: [] },
      showConfirm: false,
      isDevEnv: !!detectDevEnv()
    })
    // 课题组 + 工位树不再无条件请求：等 onShow 的最新申请同步完，
    // state=1（已通过，直接看打卡页）就不加载树；其他状态/无数据再按需加载
  },

  onShow() {
    this._load()
    // 首页「实验工位」进入（无 id）：拉一次最新申请，判断状态决定展示哪一屏
    this._syncLatestApply()
  },

  // 离开页面 / 卸载时停止审核状态轮询
  onHide() {
    this._stopPoll()
  },

  onUnload() {
    this._stopPoll()
  },

  // ── 装载：根据存储中的最新记录切换 mode ──
  _load() {
    // 每次装载先停掉旧轮询，避免重复定时器
    this._stopPoll()
    let list = []
    try { list = wx.getStorageSync('workbenchApplies') || [] } catch (e) { /* 忽略缓存异常 */ }
    let r = this._paramId
      ? (Array.isArray(list) ? list.find(x => x && String(x.id) === String(this._paramId)) : null)
      : (Array.isArray(list) && list.length ? list[0] : null)
    // 后端明确返回「没有申请」时，忽略本地旧缓存，直接进申请表单
    if (this._remoteNoData) r = null

    if (!r) {
      // 无记录：申请表单（同时清掉当前记录指针，避免沿用上一条 id）
      this._id = ''
      const draft = wx.getStorageSync('workbenchDraft')
      const patch = {
        mode: 'apply',
        // 重置弹层：避免上次遗留的 picker 模态 / 确认弹窗在重新进入页面时仍处于 show=true，
        // 那样的话 wb-modal-mask (position:fixed, inset:0, z-index:999) 会持续覆盖整个页面，
        // 让「课题组 / 开始时间 / 上传」等所有点击都被遮罩拦截，表现为「点了没反应」。
        picker: { show: false, mode: 'team', kw: '', list: [] },
        showConfirm: false,
        rec: null, submitted: null, stationCode: '', statusText: '', statusCls: '',
        monthDays: [], stats: { checked: 0, total: 0, rate: 0 }, checkIns: [], attachments: []
      }
      if (draft && typeof draft === 'object') {
        patch.form = Object.assign({}, this.data.form, draft.form || {})
        patch.photos = Array.isArray(draft.photos) ? draft.photos : []
      }
      patch.reasonLen = String((patch.form && patch.form.reason) || '').length
      this.setData(patch)
      return
    }

    this._id = r.id
    const STATUS = {
      pending:  { text: '待审核', cls: 'reviewing' },
      approved: { text: '使用中', cls: 'using' },
      rejected: { text: '已驳回', cls: 'rejected' }
    }
    const st = STATUS[r.status] || STATUS.pending
    const checkIns = Array.isArray(r.checkIns) ? r.checkIns : []
    const atts = (Array.isArray(r.attachments) ? r.attachments : [])
      .map((a, j) => ({
        idx: j,
        url: (a && a.url) || '',
        fileName: (a && a.fileName) || ('附件' + (j + 1)),
        isFile: !!(a && a.isFile)
      })).filter(a => a.url)

    // 本月考勤统计
    const now = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const ym = `${now.getFullYear()}-${p(now.getMonth() + 1)}`
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    const daysElapsed = now.getDate()
    const checkedSet = new Set(
      checkIns.filter(ci => ci && ci.time && ci.time.indexOf(ym) === 0)
        .map(ci => String(ci.time).slice(0, 10))
    )
    let seed = 0
    for (let i = 0; i < String(r.id).length; i++) seed = (seed * 31 + String(r.id).charCodeAt(i)) >>> 0
    const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) / 65536 }
    const monthDays = []
    for (let d = 1; d <= daysInMonth; d++) {
      const checked = checkedSet.has(ym + '-' + p(d))
      const h = checked ? Math.round(55 + rand() * 45) : Math.round(20 + rand() * 18)
      // 高度在 JS 侧拼成完整 style 字符串：避免 WXML 内联 style 中 "{{x}}%" 触发 IDE CSS 解析误报
      monthDays.push({ label: String(d), checked, h, hStyle: 'height: ' + h + '%;' })
    }
    const checkedDays = Math.min(checkedSet.size, daysElapsed)
    const rate = daysElapsed ? Math.round((checkedDays / daysElapsed) * 100) : 0

    const stationCode = 'WS-' + String(r.id).replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase()

    const submitted = {
      group: r.group || '--',
      seat: r.seat || '--',
      startDate: r.startDate || '',
      endDate: r.endDate || '',
      reason: r.reason || '',
      submitTime: r.submitTime || '',
      attachments: atts
    }

    const mode = r.status === 'approved' ? 'approved' : (r.status === 'rejected' ? 'rejected' : 'pending')

    this.setData({
      mode,
      // 同上：每次 _load 都清掉残留的弹层状态
      picker: { show: false, mode: 'team', kw: '', list: [] },
      showConfirm: false,
      rejectReason: String(r.rejectReason || ''),
      rec: {
        id: r.id,
        group: r.group || '--',
        seat: r.seat || '--',
        endDate: r.endDate || '--',
        startDate: r.startDate || '',
        reason: r.reason || '',
        submitTime: r.submitTime || ''
      },
      submitted,
      stationCode,
      statusText: st.text,
      statusCls: st.cls,
      monthDays,
      stats: { checked: checkedDays, total: daysElapsed, rate },
      checkIns,
      attachments: atts
    })

    // 待审核 → 每 3 秒查一次详情，state 变 1（通过）/ 2（驳回）即停止
    if (mode === 'pending') this._startPoll(r.id)
  },

  // ── 进入页面：拉「最新一次申请」（不传 id，只带 token） ──
  // 有数据 → 按 state 决定视图（0 待审核 / 1 已通过直达扫码打卡页 / 2 已驳回）
  // 无数据 → 进申请表单；请求失败 → 保留本地记录，不清数据
  // 课题组树（/api/workstation/team/tree）只在需要填表单的场景按需加载：
  //   state=1（打卡页）不请求；待审核 / 驳回 / 无数据 / 同步失败时才请求
  async _syncLatestApply() {
    if (this._paramId) {
      // 从「我的工位」带 id 进来：按本地记录的视图决定是否需要树（表单才需要）
      if (this.data.mode !== 'approved') this._loadTeamTree()
      return
    }
    if (this._syncing) return
    this._syncing = true
    try {
      const data = await getWorkstationApplyDetail('')
      const parts = this._splitDetail(data)
      const item = parts.item
      const prevMode = this.data.mode
      if (!item) {
        this._remoteNoData = true
        this._stopPoll()
        // 已经在填表单时不要重新 _load，避免把正在填的内容/待上传照片冲掉
        if (prevMode !== 'apply') this._load()
        this._loadTeamTree()          // 表单要选课题组/工位
        console.log('[workbench] 最新申请：无数据 → 申请表单')
        return
      }
      const raw = item.state !== undefined ? item.state : item.status
      const state = isNaN(Number(raw)) ? 0 : Number(raw)
      console.log('[workbench] 最新申请 id =', item.id, '，state =', raw,
        '，打卡记录', (parts.signs || []).length, '条')
      this._remoteNoData = false
      this._upsertFromDetail(item, state, parts.signs)
      const status = STATE_STATUS[state] || 'pending'
      // 待审核 / 已驳回都可能要填表单（驳回后重新申请）→ 预载树；已通过不请求
      if (status !== 'approved') this._loadTeamTree()
      this._load()
      if (status === 'approved') {
        // 已通过 → 直接进扫码打卡页（approved 视图，含扫码打卡卡），不请求 team/tree
        this.setData({ mode: 'approved' })
        if (prevMode !== 'approved') {
          wx.showToast({ title: '审核已通过，可扫码打卡', icon: 'none', duration: 2000 })
        }
      }
    } catch (err) {
      console.warn('[workbench] 最新申请获取失败，保留本地记录：', err)
      // 同步失败：本地不是打卡页时预载树（表单可用）
      if (this.data.mode !== 'approved') this._loadTeamTree()
    } finally {
      this._syncing = false
    }
  },

  // 详情响应拆解（新版返回 { apply, signList }）：
  //   · 新版：data.apply 为申请单，data.signList 为打卡记录
  //   · 旧版：单条对象 / 数组 / { list|rows|records|items|data } → 取第一条，无打卡记录
  // 返回 { item, signs }；signs === null 表示返回里没有打卡列表（不能据此清空本地打卡）
  _splitDetail(data) {
    if (data && typeof data === 'object' && data.apply && typeof data.apply === 'object') {
      let signs = null
      if (Array.isArray(data.signList)) signs = data.signList
      else if (Array.isArray(data.signs)) signs = data.signs
      else if (Array.isArray(data.signRecords)) signs = data.signRecords
      return { item: data.apply, signs }
    }
    return { item: this._pickLatestApply(data), signs: null }
  },

  // 详情可能是单条对象 / 数组 / { list|rows|records|items|data } → 统一取第一条
  _pickLatestApply(data) {
    if (!data) return null
    const arr = Array.isArray(data) ? data
      : (Array.isArray(data.list) ? data.list
        : (Array.isArray(data.rows) ? data.rows
          : (Array.isArray(data.records) ? data.records
            : (Array.isArray(data.items) ? data.items
              : (Array.isArray(data.data) ? data.data : null)))))
    if (arr) return arr.length ? arr[0] : null
    // { data: { id, state } } 这种再包一层的结构
    if (data.data && typeof data.data === 'object') return this._pickLatestApply(data.data)
    const isObj = typeof data === 'object'
    return (isObj && (data.id !== undefined || data.state !== undefined || data.status !== undefined))
      ? data
      : null
  },

  // 把后端详情合并进本地记录，并置顶为当前记录
  // item = apply（新版 { apply, signList } 里的申请单）；signs = signList（打卡记录，null 表示没有）
  _upsertFromDetail(item, state, signs) {
    const it = (item && typeof item === 'object') ? item : {}
    const st = STATE_STATUS[state] || 'pending'
    const sid = (it.id !== undefined && it.id !== null && it.id !== '') ? String(it.id) : ''
    let list = []
    try { list = wx.getStorageSync('workbenchApplies') || [] } catch (e) { /* 忽略缓存异常 */ }
    list = Array.isArray(list) ? list : []
    const old = sid ? list.find(r => r && String(r.id) === sid) : null
    // 附件：attachmentUrl 逗号分隔 / attachments 数组 → [{ url, fileName, isFile }]
    let urls = []
    if (Array.isArray(it.attachments)) {
      urls = it.attachments
        .map(a => (typeof a === 'string' ? a : ((a && (a.url || a.path || a.fileName)) || '')))
        .filter(Boolean)
    } else {
      urls = String(it.attachmentUrl || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
    }
    const oldAtts = (old && Array.isArray(old.attachments)) ? old.attachments : []
    const attachments = urls.length
      ? urls.map((u, i) => ({
        // 后端可能给相对路径（如 /profile/upload/...）→ 拼成完整 URL 供预览/下载
        url: this._toFullUrl(u),
        fileName: (oldAtts[i] && oldAtts[i].fileName) || ('附件' + (i + 1)),
        isFile: !/\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(u)
      }))
      : oldAtts
    // 打卡记录：后端 signList → [{ time, code }]（signTime 为 YYYY-MM-DD HH:mm:ss）
    // 返回里带 signList 时以后端为准（可为空数组）；没带时保留本地（旧版兼容）
    let checkIns = (old && Array.isArray(old.checkIns)) ? old.checkIns : []
    if (signs) {
      checkIns = signs.map(s => ({
        time: (s && (s.signTime || s.time || s.createTime)) || '',
        code: (s && (s.remark || s.code)) || '扫码打卡'
      })).filter(c => c.time)
    }
    const record = Object.assign({}, old || {}, {
      id: sid || (old && old.id) || ('wb_' + Date.now()),
      openId: (old && old.openId) || getOpenId() || '',
      group: it.teamName || it.team || (old && old.group) || '',
      teamId: (it.teamId !== undefined && it.teamId !== null) ? String(it.teamId) : ((old && old.teamId) || ''),
      seat: it.workstationName || it.workstation || it.seatName || (old && old.seat) || '',
      seatId: (it.workstationId !== undefined && it.workstationId !== null) ? String(it.workstationId) : ((old && old.seatId) || ''),
      startDate: it.startDate || (old && old.startDate) || '',
      endDate: it.endDate || (old && old.endDate) || '',
      // 申请理由取 remark；it.reason 是驳回原因，不能当理由用
      reason: it.remark || (old && old.reason) || '',
      attachments,
      // 提交时间：新版优先 applyTime，兼容 createTime / submitTime
      submitTime: it.applyTime || it.createTime || it.submitTime || it.updateTime ||
        (old && old.submitTime) || this._nowText(),
      state,
      status: st,
      rejectReason: st === 'rejected' ? String(it.reason || it.rejectReason || '') : '',
      checkIns
    })
    const rest = list.filter(r => !(r && String(r.id) === String(record.id)))
    rest.unshift(record)
    try { wx.setStorageSync('workbenchApplies', rest) } catch (e) {
      console.warn('[workbench] 申请记录写入失败：', e)
    }
    return record
  },

  _saveDraft() {
    wx.setStorageSync('workbenchDraft', { form: this.data.form, photos: this.data.photos })
  },

  // ── 待审核：每 3 秒查一次 /api/workstation/apply/detail?id= ──
  // state 变成 1（通过）/ 2（驳回）后停止；本地演示记录（id 以 wb_ 开头）不轮询
  _startPoll(id) {
    this._stopPoll()
    const sid = id === undefined || id === null ? '' : String(id)
    if (!sid || /^wb_/.test(sid)) return
    this._pollTimer = setInterval(() => this._pollDetail(), POLL_INTERVAL)
    console.log('[workbench] 开始轮询审核状态，id =', sid)
  },

  _stopPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  },

  async _pollDetail() {
    if (this._polling) return
    const id = this._id
    if (!id) {
      this._stopPoll()
      return
    }
    this._polling = true
    try {
      const d = await getWorkstationApplyDetail(id)
      const parts = this._splitDetail(d)
      const raw = parts.item
        ? (parts.item.state !== undefined ? parts.item.state : parts.item.status)
        : ''
      const state = Number(raw)
      console.log('[workbench] 审核状态：', raw, '→', state,
        '，打卡记录', (parts.signs || []).length, '条')
      if (state === 1 || state === 2) {
        this._stopPoll()
        this._applyRemoteState(state, parts)
      }
    } catch (err) {
      console.warn('[workbench] 审核状态查询失败：', err)
    } finally {
      this._polling = false
    }
  },

  // state → 本地记录状态，并用详情字段（含打卡记录）刷新展示内容
  _applyRemoteState(state, parts) {
    const status = STATE_STATUS[state] || 'pending'
    if (status === 'pending') return
    this._upsertFromDetail(parts.item || {}, state, parts.signs)
    this._load()
    wx.showToast({
      title: status === 'approved' ? '审核已通过，可去打卡' : '申请已被驳回',
      icon: 'none',
      duration: 2500
    })
  },

  // ── 已通过 → 去打卡：确保停在打卡视图，并直接拉起扫码 ──
  goCheckIn() {
    if (this.data.mode !== 'approved') this.setData({ mode: 'approved' })
    this.openScan()
  },

  // ── 已驳回 → 重新申请：移除该记录，把上次填写内容作为草稿带回表单 ──
  reapply() {
    const id = this._id || this._paramId
    let list = []
    try { list = wx.getStorageSync('workbenchApplies') || [] } catch (e) { /* 忽略缓存异常 */ }
    const cur = (Array.isArray(list) ? list : []).find(r => r && String(r.id) === String(id))
    if (cur) {
      try {
        wx.setStorageSync('workbenchDraft', {
          form: {
            group: cur.group || '',
            teamId: cur.teamId || '',
            seat: cur.seat || '',
            seatId: cur.seatId || '',
            startDate: cur.startDate || '',
            endDate: cur.endDate || '',
            reason: cur.reason || ''
          },
          photos: (Array.isArray(cur.attachments) ? cur.attachments : [])
            .map(a => ({
              origin: (a && a.url) || '',
              thumb: (a && a.url) || '',
              fileName: (a && a.fileName) || '',
              isFile: !!(a && a.isFile)
            }))
            .filter(p => p.origin)
        })
      } catch (e) { /* 忽略缓存异常 */ }
    }
    list = (Array.isArray(list) ? list : []).filter(r => !(r && String(r.id) === String(id)))
    try { wx.setStorageSync('workbenchApplies', list) } catch (e) { /* 忽略缓存异常 */ }
    this._paramId = ''
    this._id = ''
    this._stopPoll()
    this._load()
    wx.showToast({ title: '请重新填写申请', icon: 'none' })
  },

  _nowText() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  },

  // ── 课题组-工位树：GET /api/workstation/team/tree ──
  // 按需加载（state=1 的打卡页不触发）；已成功加载过 / 请求中则去重，不重复请求
  // 失败时回退本地课题组清单（GROUPS，无工位），保证页面可用
  async _loadTeamTree() {
    if (this._treeLoaded || this._treeLoading) return
    this._treeLoading = true
    this.setData({ teamsLoading: true })
    try {
      const raw = await getWorkstationTeamTree()
      // 诊断：先看接口给的是数组还是对象、对象有哪些键
      console.log('[workbench] tree 原始形态：',
        Array.isArray(raw) ? '数组(' + raw.length + ')' :
          (raw && typeof raw === 'object' ? '对象，键 = ' + Object.keys(raw).join(',') : String(raw)))
      const teams = this._normalizeTeams(raw)
      if (!teams.length) throw new Error('tree 返回为空')
      this._tree = teams
      this._treeLoaded = true
      this._treeFromFallback = false
      this.setData({ teams, teamsLoading: false })
      console.log('[workbench] 课题组-工位：', teams.length, '个课题组，',
        teams.map(t => (t.children || []).length).join('/'), '个工位')
      this._flushPendingPicker()
    } catch (err) {
      console.warn('[workbench] /api/workstation/team/tree 获取失败，回退本地课题组：', err)
      const teams = GROUPS.map(g => withSearch({
        id: g.id, name: g.name, sub: g.dept || '', children: [], searchTxt: g.searchTxt
      }, g.searchTxt))
      this._tree = teams
      this._treeFromFallback = true
      this.setData({ teams, teamsLoading: false })
      this._flushPendingPicker()
    } finally {
      this._treeLoading = false
    }
  },

  // 用户点击时树还没加载好 → 加载完成后自动弹出对应弹层
  _flushPendingPicker() {
    const mode = this._pendingPickerMode
    if (!mode) return
    this._pendingPickerMode = ''
    this._openPicker(mode)
  },

  // 树节点规范化：课题组取第一层，工位取其后代叶子节点
  // 结构兼容：
  //   a) 嵌套 { id, name, children: [{ id, name }] }，也支持 课题组 → 区域 → 工位 三层（自动下钻到叶子）
  //   b) 平铺 [{ id, name, parentId }]，无嵌套时按 parentId 组装
  //   c) 对象形态 { teams: [...], workstations: [...] }（两个平行列表，工位带 teamId）
  //   d) 子节点键名不固定（seats / workstations / seatList / deviceList …），未知时自动识别「元素是对象的数组」
  //   e) 名称字段不固定时兜底取第一个短字符串
  _normalizeTeams(input) {
    let list = input
    let extraSeats = []
    if (!Array.isArray(input) && input && typeof input === 'object') {
      // 平行列表：课题组一个数组、工位一个数组（工位靠 teamId 挂到课题组）
      list = input.teams || input.teamList || input.team_list || input.groups ||
        input.depts || input.rows || input.list || input.children || []
      extraSeats = input.workstations || input.workstationList || input.workstation_list ||
        input.seats || input.seatList || input.seat_list || input.stations ||
        input.stationList || input.station_list || []
      if (!Array.isArray(extraSeats)) extraSeats = []
    }
    const arr = Array.isArray(list) ? list.filter(o => o && typeof o === 'object') : []
    const CHILD_KEYS = ['children', 'kids', 'seats', 'seatList', 'seat_list', 'workstations',
      'workstationList', 'workstation_list', 'stations', 'stationList', 'station_list',
      'positions', 'devices', 'deviceList', 'device_list', 'nodes', 'list', 'items', 'rows']
    const pickId = (o, keys) => {
      for (const k of keys) {
        if (o[k] !== undefined && o[k] !== null && o[k] !== '') return String(o[k])
      }
      return ''
    }
    const pickStr = (o, keys) => {
      for (const k of keys) {
        const v = o[k]
        if (typeof v === 'string' && v.trim()) return v.trim()
        if (typeof v === 'number') return String(v)
      }
      return ''
    }
    // 名称兜底：跳过数组/对象/链接/日期，取第一个短字符串或数字
    const guessStr = (o, prefer) => {
      const v = pickStr(o, prefer)
      if (v) return v
      for (const k of Object.keys(o)) {
        const val = o[k]
        if (typeof val === 'string') {
          const s = val.trim()
          if (s && s.length <= 40 && !/^https?:\/\//i.test(s) && !/^\d{4}-\d{2}-\d{2}/.test(s)) return s
        } else if (typeof val === 'number' && String(val).length <= 12) {
          return String(val)
        }
      }
      return ''
    }
    // 子节点数组：先按常见键名，再扫描任意「元素是对象」的数组
    const kidsOf = (o) => {
      for (const k of CHILD_KEYS) {
        if (Array.isArray(o[k]) && o[k].length) return o[k]
      }
      for (const k of Object.keys(o)) {
        const v = o[k]
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') return v
      }
      return []
    }
    // 取叶子节点（最多下钻 4 层）
    const leavesOf = (nodes, depth) => {
      const out = []
      ;(nodes || []).forEach((n) => {
        if (!n || typeof n !== 'object') return
        const kids = kidsOf(n)
        if (kids.length && depth < 4) out.push(...leavesOf(kids, depth + 1))
        else out.push(n)
      })
      return out
    }
    const TEAM_ID = ['id', 'teamId', 'team_id', 'deptId', 'dept_id']
    const TEAM_NAME = ['name', 'teamName', 'team_name', 'label', 'title', 'deptName', 'dept_name']
    const SEAT_ID = ['id', 'seatId', 'seat_id', 'workstationId', 'workstation_id', 'stationId', 'station_id']
    const SEAT_NAME = ['name', 'seatName', 'seat_name', 'workstationName', 'workstation_name',
      'code', 'seatCode', 'seat_code', 'title', 'label', 'no', 'num']
    const toSeat = (s, tid, j) => {
      if (!s || typeof s !== 'object') return null
      const sName = guessStr(s, SEAT_NAME)
      if (!sName) return null
      const sSub = pickStr(s, ['area', 'zone', 'region', 'floor', 'room', 'status',
        'state', 'type', 'remark', 'desc']) || ''
      return withSearch({
        id: pickId(s, SEAT_ID) || tid + '-' + (j + 1),
        name: sName,
        sub: sSub,
        searchTxt: sName + (sSub ? ' ' + sSub : '')
      }, sName + sSub)
    }
    let teams = arr.map((it, i) => {
      const name = guessStr(it, TEAM_NAME)
      if (!name) return null
      const id = pickId(it, TEAM_ID) || String(i + 1)
      // 副标题：部门 / 负责人 / 备注
      const sub = pickStr(it, ['dept', 'deptName', 'dept_name', 'leader', 'principal',
        'manager', 'remark', 'desc']) || ''
      const children = leavesOf(kidsOf(it), 0).map((s, j) => toSeat(s, id, j)).filter(Boolean)
      return withSearch({ id, name, sub, children, searchTxt: name + (sub ? ' ' + sub : '') }, name + sub)
    }).filter(Boolean)

    // 平行列表：工位数组里带 teamId / groupId → 按该字段挂到课题组
    if (extraSeats.length && teams.length && !teams.some(t => t.children.length)) {
      const REF = ['teamId', 'team_id', 'groupId', 'group_id', 'parentId', 'parent_id', 'deptId', 'dept_id']
      let filled = 0
      teams = teams.map((t) => {
        const kids = extraSeats
          .filter(s => s && typeof s === 'object' &&
            REF.some(k => s[k] !== undefined && s[k] !== null && String(s[k]) === String(t.id)))
          .map((s, j) => toSeat(s, t.id, j)).filter(Boolean)
        if (kids.length) filled++
        return Object.assign({}, t, { children: kids })
      })
      console.log('[workbench] 平行列表挂载：', filled, '/', teams.length, '个课题组有工位')
    }

    // 没有任何嵌套子节点 → 尝试平铺结构（节点靠 parentId 指向父级）
    if (teams.length && !teams.some(t => t.children.length)) {
      const PARENT = ['parentId', 'parent_id', 'pid', 'teamId', 'team_id', 'groupId', 'group_id']
      const pk = PARENT.find(k => arr.some(o => o[k] !== undefined && o[k] !== null && o[k] !== ''))
      if (pk) {
        const idOf = (o) => pickId(o, TEAM_ID) || pickId(o, SEAT_ID)
        let filled = 0
        teams = teams.map((t) => {
          const kids = arr
            .filter(o => String(o[pk]) === String(t.id) && String(idOf(o)) !== String(t.id))
            .map((s, j) => toSeat(s, t.id, j)).filter(Boolean)
          if (kids.length) filled++
          return Object.assign({}, t, { children: kids })
        })
        console.log('[workbench] 平铺结构按 ' + pk + ' 组装：', filled, '个课题组有工位')
      }
    }

    // 诊断：无工位时把原始结构打印出来，便于按实际字段调整
    console.log('[workbench] tree 样本：根节点键 =', arr[0] ? Object.keys(arr[0]).join(',') : '无')
    if (teams[0]) {
      console.log('[workbench] 规范化后第 1 个课题组：', teams[0].name,
        '，工位', (teams[0].children || []).length, '个')
      if ((teams[0].children || []).length) {
        console.log('[workbench] 第 1 个工位：', teams[0].children[0].name)
      }
    }
    return teams
  },

  // ── 课题组 / 工位 级联选择（共用可搜索弹层，picker.mode 区分） ──
  openGroupPicker() {
    this._openPicker('team')
  },

  // 工位：必须先选课题组，候选为该课题组下的 children
  openSeatPicker() {
    const f = this.data.form
    if (!f.teamId && !f.group) {
      wx.showToast({ title: '请先选择课题组', icon: 'none' })
      return
    }
    const team = (this._tree || this.data.teams || [])
      .find(t => String(t.id) === String(f.teamId) || t.name === f.group)
    if (!team) {
      wx.showToast({ title: '课题组数据未就绪，请重新选择课题组', icon: 'none' })
      return
    }
    if (!(team.children || []).length) {
      // 树是本地回退数据 → 说明接口没解析出工位，与「课题组真没工位」区分开
      wx.showToast({
        title: this._treeFromFallback ? '工位数据未取到，请稍后重试' : '该课题组暂无可用工位',
        icon: 'none',
        duration: 2200
      })
      return
    }
    this._openPicker('seat', team.children)
  },

  _openPicker(mode, src) {
    this._pickerSrc = src || this._tree || this.data.teams || []
    if (!this._pickerSrc.length && mode === 'team') {
      // 树还没到：标记待打开，加载完成后自动弹出，用户不用再点一次
      this._pendingPickerMode = mode
      wx.showToast({ title: '课题组加载中…', icon: 'none' })
      if (!this.data.teamsLoading) this._loadTeamTree()
      return
    }
    this.setData({
      picker: { show: true, mode, kw: '', list: this._pickList('', this._pickerSrc, mode) }
    })
  },

  closePicker() {
    this.setData({ 'picker.show': false })
  },

  onPickerKw(e) {
    const kw = e.detail.value
    this.setData({ 'picker.kw': kw, 'picker.list': this._pickList(kw, this._pickerSrc) })
  },

  // 选中：按 mode 回填课题组 / 工位；换课题组时清掉不属于它的工位
  onPickerItem(e) {
    const o = (this._pickerSrc || [])[e.currentTarget.dataset.index]
    if (!o) return
    const patch = { 'picker.show': false }
    if (this.data.picker.mode === 'seat') {
      patch['form.seat'] = o.name
      patch['form.seatId'] = o.id || ''
    } else {
      patch['form.group'] = o.name
      patch['form.teamId'] = o.id || ''
      // 已选工位不在新课题组下 → 清空
      const f = this.data.form
      if (f.seatId && !(o.children || []).some(s => String(s.id) === String(f.seatId))) {
        patch['form.seat'] = ''
        patch['form.seatId'] = ''
      }
    }
    this.setData(patch)
    this._saveDraft()
  },

  // 候选过滤：支持中文/英文模糊、拼音首字母连续与跳字；输出项带头像/底色/是否已选
  _pickList(kw, src, mode) {
    const list = src || this._tree || []
    const token = String(kw == null ? '' : kw).trim().toLowerCase()
    // 已选项：选工位时比 seatId，选课题组时比 teamId（打开瞬间 this.data.picker.mode 还是旧值，需外部传入）
    const m = mode || this.data.picker.mode
    const curId = String((m === 'seat' ? this.data.form.seatId : this.data.form.teamId) || '')
    const view = (o, idx) => ({
      idx,
      id: String(o.id || ''),
      name: o.name,
      sub: o.sub || '',
      avatar: String(o.name || '').charAt(0),
      bg: AV_BG[idx % AV_BG.length],
      checked: !!curId && String(o.id || '') === curId
    })
    if (!token) return list.map((o, idx) => view(o, idx))
    const res = []
    list.forEach((o, idx) => {
      const text = (o.searchTxt || '').toLowerCase()
      let score = -1
      if (text && text.indexOf(token) >= 0) score = 0
      else if (o.initials && o.initials.indexOf(token) >= 0) score = 1
      else if (/^[a-z0-9]+$/.test(token)) {
        const keys = (o.pyKeys || []).filter(k => k && k !== o.initials)
        if (keys.some(k => k.indexOf(token) >= 0)) score = 2
        else if (token.length >= 2 && matchInitials(token, o.initials)) score = 3
        else if (token.length >= 2 && keys.some(k => matchInitials(token, k))) score = 4
      }
      if (score >= 0) res.push({ idx, score })
    })
    res.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.idx - b.idx))
    return res.map(it => view(list[it.idx], it.idx))
  },

  // ── 使用期限 ──
  onStartDate(e) {
    const startDate = e.detail.value
    const patch = { 'form.startDate': startDate }
    if (this.data.form.endDate && this.data.form.endDate < startDate) patch['form.endDate'] = ''
    this.setData(patch)
    this._saveDraft()
  },
  onEndDate(e) {
    this.setData({ 'form.endDate': e.detail.value })
    this._saveDraft()
  },

  // ── 申请理由 ──
  onReasonInput(e) {
    const reason = e.detail.value
    this.setData({ 'form.reason': reason, reasonLen: String(reason || '').length })
    this._saveDraft()
  },

  // ── 上传导师签字同意书（与准入材料上传同款） ──
  showActionSheet() {
    if (this.data.photos.length >= MAX_FILES) {
      wx.showToast({ title: '最多上传' + MAX_FILES + '个文件', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择', '选择文档（PDF/Word 等）'],
      success: (res) => {
        if (res.tapIndex === 0) this._pick('camera')
        else if (res.tapIndex === 1) this._pick('album')
        else if (res.tapIndex === 2) this._pickFile()
      }
    })
  },
  _pick(source) {
    const remain = MAX_FILES - this.data.photos.length
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: [source],
      camera: 'back',
      success: (res) => {
        const paths = (res.tempFiles || []).map(f => f.tempFilePath)
        if (paths.length) this._uploadPhotos(paths, source)
      }
    })
  },
  _pickFile() {
    const remain = MAX_FILES - this.data.photos.length
    wx.chooseMessageFile({
      count: remain,
      type: 'file',
      extension: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'],
      success: (res) => {
        const files = (res.tempFiles || []).filter(f => f.path && f.size > 0)
        if (files.length) this._uploadFiles(files)
      },
      fail: () => {}
    })
  },
  async _uploadPhotos(paths, source) {
    wx.showLoading({ title: '上传中...', mask: true })
    const items = []
    let failed = 0
    for (const path of paths) {
      const origName = this._guessImageName(path)
      try {
        const uploadPath = await this._copyToNamedTempPath(path, origName)
        const data = await uploadImage(uploadPath)
        const urls = this._extractUrls(data)
        items.push({ thumb: urls.thumb || path, origin: urls.origin || urls.thumb || path })
      } catch (err) {
        failed++
        console.error('[workbench] /file/uploadImage 上传失败：', path, err)
      }
    }
    wx.hideLoading()
    this._appendItems(items, failed, source === 'camera' ? '拍照上传成功' : '上传成功')
  },
  async _uploadFiles(files) {
    wx.showLoading({ title: '上传中...', mask: true })
    const items = []
    let failed = 0
    for (const f of files) {
      const origName = f.name || ''
      try {
        const uploadPath = await this._copyToNamedTempPath(f.path, origName)
        const data = await uploadFile(uploadPath, { name: origName, fileName: origName, filename: origName })
        const urls = this._extractUrls(data)
        const url = this._toFullUrl(urls.origin || urls.thumb)
        if (!url) throw new Error('上传返回缺少文件地址')
        items.push({
          thumb: '',
          origin: url,
          isFile: true,
          fileName: origName || this._fileNameFromUrl(url),
          ext: this._fileExt(origName || url)
        })
      } catch (err) {
        failed++
        console.error('[workbench] /file/uploadFile 上传失败：', f.path, err)
      }
    }
    wx.hideLoading()
    this._appendItems(items, failed, '上传成功')
  },
  _appendItems(items, failed, successMsg) {
    if (items.length) {
      const photos = [...this.data.photos]
      items.forEach(it => { if (photos.length < MAX_FILES) photos.push(it) })
      this.setData({ photos })
      this._saveDraft()
    }
    if (failed && !items.length) {
      wx.showToast({ title: '上传失败，请重试', icon: 'none' })
    } else if (failed) {
      wx.showToast({ title: `${items.length} 个成功 / ${failed} 个失败`, icon: 'none' })
    } else {
      wx.showToast({ title: successMsg, icon: 'none' })
    }
  },
  removePhoto(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const photos = [...this.data.photos]
    photos.splice(idx, 1)
    this.setData({ photos })
    this._saveDraft()
  },
  previewPhoto(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const target = this.data.photos[idx]
    if (!target) return
    if (target.isFile) {
      this._openDocument(target.origin, target.fileName)
      return
    }
    const urls = this.data.photos.filter(p => !p.isFile).map(p => p.origin || p.thumb)
    wx.previewImage({ current: target.origin || target.thumb, urls })
  },
  _openDocument(url, fileName) {
    if (!url) return
    wx.showLoading({ title: '打开中...', mask: true })
    wx.downloadFile({
      url,
      success: (res) => {
        wx.hideLoading()
        wx.openDocument({
          filePath: res.tempFilePath,
          fileName: fileName || '',
          showMenu: true,
          fail: () => wx.showToast({ title: '该文件类型暂不支持预览', icon: 'none' })
        })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '文件下载失败', icon: 'none' })
      }
    })
  },

  // ── 上传辅助 ──
  _copyToNamedTempPath(path, origName) {
    if (!path) return Promise.resolve(path)
    const safe = this._sanitizeFileName(origName)
    if (!safe) return Promise.resolve(path)
    return new Promise((resolve) => {
      try {
        const fs = wx.getFileSystemManager()
        const dest = `${wx.env.USER_DATA_PATH}/${safe}`
        try {
          const data = fs.readFileSync(path)
          fs.writeFileSync(dest, data)
          resolve(dest)
        } catch (e) {
          fs.copyFile({
            srcPath: path,
            destPath: dest,
            success: () => resolve(dest),
            fail: () => resolve(path)
          })
        }
      } catch (e) {
        resolve(path)
      }
    })
  },
  _sanitizeFileName(name) {
    if (!name) return ''
    return String(name).trim().replace(/[\\/:*?"<>|\r\n\t]/g, '_')
  },
  _guessImageName(path) {
    if (!path) return ''
    const raw = String(path).split('?')[0].split('/').pop() || ''
    if (/\.(jpg|jpeg|png|gif|bmp|webp|heic)$/i.test(raw)) return raw
    return ''
  },
  _fileNameFromUrl(url) {
    const raw = String(url || '').split('?')[0].split('/').pop() || ''
    try { return decodeURIComponent(raw) } catch (e) { return raw }
  },
  _fileExt(name) {
    const parts = String(name || '').split('?')[0].split('.')
    return parts.length > 1 ? parts.pop().toLowerCase() : ''
  },
  _extractUrls(data) {
    const thumb = this._findByKeys(data, ['thumb', 'thumbnail', 'thumbUrl', 'small', 'smallUrl', 'preview', 'previewUrl'])
    const origin = this._findByKeys(data, ['origin', 'original', 'origUrl', 'rawUrl', 'source', 'sourceUrl', 'url', 'fullUrl', 'fileUrl', 'imageUrl', 'imgUrl', 'path', 'filePath', 'src', 'link'])
    return {
      thumb: this._toFullUrl(thumb || origin),
      origin: this._toFullUrl(origin || thumb)
    }
  },
  _findByKeys(data, keys) {
    if (!data) return ''
    if (Array.isArray(data)) {
      for (const item of data) {
        const v = this._findByKeys(item, keys)
        if (v) return v
      }
      return ''
    }
    if (typeof data !== 'object') return ''
    for (const k of keys) {
      if (typeof data[k] === 'string' && data[k].trim()) return data[k].trim()
    }
    const nestedKeys = ['data', 'result', 'list', 'files', 'file', 'rows', 'items', 'records']
    for (const k of nestedKeys) {
      if (data[k] !== undefined && data[k] !== null) {
        const v = this._findByKeys(data[k], keys)
        if (v) return v
      }
    }
    return ''
  },
  _toFullUrl(url) {
    if (!url) return ''
    if (/^https?:\/\//i.test(url) || url.indexOf('data:') === 0) return url
    return BASE + (url.charAt(0) === '/' ? url : '/' + url)
  },

  // ── 提交申请（apply → pending） ──
  submitApply() {
    const f = this.data.form
    // 必填：课题组 / 开始时间 / 结束时间 / 申请理由 / 导师签字同意书；工位为选填
    if (!f.group) { wx.showToast({ title: '请选择课题组', icon: 'none' }); return }
    if (!f.startDate) { wx.showToast({ title: '请选择开始时间', icon: 'none' }); return }
    if (!f.endDate) { wx.showToast({ title: '请选择结束时间', icon: 'none' }); return }
    if (f.endDate < f.startDate) { wx.showToast({ title: '结束时间不能早于开始时间', icon: 'none' }); return }
    if (!String(f.reason).trim()) { wx.showToast({ title: '请填写申请理由', icon: 'none' }); return }
    if (!this.data.photos.length) { wx.showToast({ title: '请上传导师签字同意书', icon: 'none' }); return }
    this.setData({ showConfirm: true })
  },
  cancelConfirm() {
    this.setData({ showConfirm: false })
  },
  // ── 提交申请：POST /api/workstation/apply/saveJson ──
  // 参数：{ teamId, workstationId, applyUserId, applyUser, startDate, endDate }
  //   workstationId 来自所选工位（选填字段，未选则不传）
  //   applyUserId / applyUser 来自准入登记（/system/apply_user/detail 的 applyUser）
  async confirmSubmit() {
    this.setData({ showConfirm: false })
    if (this._submitting) return
    const f = this.data.form
    this._submitting = true
    wx.showLoading({ title: '提交中…', mask: true })
    try {
      const au = await this._ensureApplyUser()
      if (!au.id) {
        wx.hideLoading()
        wx.showModal({
          title: '无法提交',
          content: '未获取到申请用户信息，请先完成准入登记后再提交工位申请。',
          showCancel: false
        })
        return
      }
      // 数字型 id 传数字（与接口样例一致），非数字原样传
      const toNum = (v) => {
        const n = Number(v)
        return (v === '' || v === null || v === undefined || isNaN(n)) ? v : n
      }
      const body = {
        teamId: toNum(f.teamId),
        applyUserId: toNum(au.id),
        applyUser: au.name || '',
        startDate: f.startDate,
        endDate: f.endDate,
        // 申请理由
        remark: String(f.reason).trim()
      }
      if (f.seatId) body.workstationId = toNum(f.seatId)
      // 导师签字同意书地址：多个用英文逗号拼接
      const attachUrls = this.data.photos.map(p => p.origin || p.thumb || '').filter(Boolean)
      if (attachUrls.length) body.attachmentUrl = attachUrls.join(',')
      const res = await saveWorkstationApply(body)
      wx.hideLoading()

      // 记录 id 优先用后端返回的（兼容 id / applyId / data 为纯数字）
      const remoteId = res && typeof res === 'object'
        ? (res.id !== undefined && res.id !== null ? res.id
          : (res.applyId !== undefined && res.applyId !== null ? res.applyId : ''))
        : (typeof res === 'number' || (typeof res === 'string' && res) ? res : '')
      const localId = 'wb_' + Date.now()
      const id = remoteId === '' || remoteId === undefined ? localId : String(remoteId)

      // 后端 state：0 待审核 / 1 已通过 / 2 已驳回（未返回时按待审核处理）
      const rawState = res && typeof res === 'object'
        ? (res.state !== undefined ? res.state : res.status)
        : undefined
      const state = (rawState === undefined || rawState === null || rawState === '') ? 0 : Number(rawState)
      const status = STATE_STATUS[state] || 'pending'

      // 刚提交成功：后端已有记录，取消「无数据」标记，避免 _load 又回到表单
      this._remoteNoData = false

      const record = {
        id,
        openId: getOpenId() || '',
        group: f.group,
        teamId: f.teamId,
        seat: f.seat,
        seatId: f.seatId,
        startDate: f.startDate,
        endDate: f.endDate,
        reason: String(f.reason).trim(),
        attachments: this.data.photos.map(p => ({
          url: p.origin || p.thumb,
          fileName: p.fileName || '',
          isFile: !!p.isFile
        })),
        submitTime: this._nowText(),
        state,
        status,
        rejectReason: status === 'rejected'
          ? String((res && (res.reason || res.rejectReason)) || '')
          : '',
        checkIns: []
      }
      try {
        const list = wx.getStorageSync('workbenchApplies') || []
        list.unshift(record)
        wx.setStorageSync('workbenchApplies', list)
        wx.removeStorageSync('workbenchDraft')
      } catch (err) {
        console.warn('[workbench] 申请记录本地保存失败：', err)
      }
      this._paramId = id
      this._load()
      wx.showToast({ title: '已提交，等待审核', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      console.warn('[workbench] 工位申请提交失败：', err)
      wx.showToast({
        title: (err && (err.message || err.errMsg)) || '提交失败，请稍后重试',
        icon: 'none',
        duration: 2500
      })
    } finally {
      this._submitting = false
    }
  },

  // 申请用户信息（applyUserId + applyUser）：
  // 取 /system/apply_user/detail 返回的 user（登录账号），不用 applyUser（申请单主体）
  async _ensureApplyUser() {
    if (this._applyUser && this._applyUser.id) return this._applyUser
    // 1) detail 里的 user：先读跨页缓存，未命中再请求接口
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
        console.warn('[workbench] apply_user/detail 获取失败：', e)
      }
    }
    // 2) 从 user 里取 id / 姓名（字段名多路兼容）
    const pick = (keys) => {
      if (!user || typeof user !== 'object') return ''
      for (const k of keys) {
        const v = user[k]
        if (v !== undefined && v !== null && v !== '') return String(v)
      }
      return ''
    }
    let id = pick(['userId', 'id', 'user_id', 'uid'])
    const name = pick(['userName', 'nickName', 'realName', 'name', 'nick_name', 'real_name', 'loginName'])
    // 3) user 里没有 id 时，退回准入登记的 applyUserId，避免直接发不出请求
    if (!id) {
      try {
        const c = wx.getStorageSync('admissionApplyId')
        if (c !== undefined && c !== null && c !== '') id = String(c)
      } catch (e) { /* 忽略缓存异常 */ }
    }
    if (!id) {
      try {
        const reg = wx.getStorageSync('admissionRegister')
        if (reg) {
          const v = reg.applyId !== undefined && reg.applyId !== null ? reg.applyId
            : (reg.res && reg.res.id)
          if (v !== undefined && v !== null && v !== '') id = String(v)
        }
      } catch (e) { /* 忽略缓存异常 */ }
    }
    this._applyUser = { id: id || '', name: String(name || '') }
    console.log('[workbench] 申请用户（detail.user）：', this._applyUser, '｜user 原始：', user)
    return this._applyUser
  },

  // ── 模拟审核通过（pending → approved） ──
  mockApprove() {
    if (!this._id) return
    let list = []
    try { list = wx.getStorageSync('workbenchApplies') || [] } catch (e) { /* 忽略缓存异常 */ }
    list = (Array.isArray(list) ? list : []).map(r =>
      (r && String(r.id) === String(this._id))
        ? Object.assign({}, r, { status: 'approved' })
        : r
    )
    try { wx.setStorageSync('workbenchApplies', list) } catch (e) { /* 忽略缓存异常 */ }
    wx.showToast({ title: '已审核通过', icon: 'success' })
    this._load()
  },

  // ── 扫码打卡（approved 模式） ──
  // 扫到二维码 → POST /api/workstation/sign/saveJson?token=  { workstationId, remark }
  //   成功后写入本地打卡记录，本月考勤柱状图与打卡记录列表同步显示当天
  // 扫到空内容 / 取消 / 失败 → 提示"请扫码正确的二维码"
  openScan() {
    if (!this._id || this._signing) return
    // workstationId：当前申请所分配的工位（选填工位场景下可能为空）
    let list = []
    try { list = wx.getStorageSync('workbenchApplies') || [] } catch (e) { /* 忽略缓存异常 */ }
    const cur = (Array.isArray(list) ? list : [])
      .find(r => r && String(r.id) === String(this._id))
    const workstationId = cur ? (cur.seatId || cur.workstationId || '') : ''
    if (!workstationId) {
      wx.showToast({ title: '当前申请未绑定工位，无法打卡', icon: 'none', duration: 2200 })
      return
    }
    wx.scanCode({
      scanType: ['qrCode'],
      onlyFromCamera: false,
      success: (res) => {
        const code = (res.result || '').trim()
        if (!code) {
          wx.showToast({ title: '请扫码正确的二维码', icon: 'none' })
          return
        }
        this._saveSign(workstationId, code)
      },
      fail: () => {
        wx.showToast({ title: '请扫码正确的二维码', icon: 'none' })
      }
    })
  },

  // 调用打卡接口并落地本地记录（接口失败不写本地，避免本地与后端不一致）
  async _saveSign(workstationId, code) {
    if (this._signing) return
    this._signing = true
    const now = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const time = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`
    const numId = Number(workstationId)
    wx.showLoading({ title: '打卡中…', mask: true })
    try {
      await saveWorkstationSign({
        workstationId: isNaN(numId) ? workstationId : numId,
        // remark：二维码内容（后端据此校验）；扫码内容为空时给个默认文案
        remark: code || '扫码打卡'
      })
      wx.hideLoading()
      let list = []
      try { list = wx.getStorageSync('workbenchApplies') || [] } catch (e) { /* 忽略缓存异常 */ }
      list = (Array.isArray(list) ? list : []).map((r) =>
        (r && String(r.id) === String(this._id))
          ? Object.assign({}, r, {
              checkInTime: time,
              checkIns: [{ time, code }, ...((r && Array.isArray(r.checkIns)) ? r.checkIns : [])]
            })
          : r
      )
      try { wx.setStorageSync('workbenchApplies', list) } catch (e) { /* 忽略缓存异常 */ }
      wx.showToast({ title: '打卡成功', icon: 'success' })
      this._load()
    } catch (err) {
      wx.hideLoading()
      console.warn('[workbench] 打卡失败：', err)
      wx.showToast({
        title: (err && (err.message || err.errMsg)) || '打卡失败，请稍后重试',
        icon: 'none',
        duration: 2500
      })
    } finally {
      this._signing = false
    }
  },

  // 点击附件
  previewAttachment(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const target = this.data.attachments[idx]
    if (!target || !target.url) return
    if (target.isFile) {
      this._openDocument(target.url, target.fileName)
      return
    }
    const urls = this.data.attachments.filter(a => !a.isFile).map(a => a.url)
    wx.previewImage({ current: target.url, urls })
  },

  // ── 开发版/体验版专属：重置实验工位 ──
  // 清空 workbenchApplies + workbenchDraft，下次进入实验工位从第一步（申请）开始。
  // 按钮已用 isDevEnv 条件渲染兜底；resetWorkbenchData() 内部还会做一次环境校验，双重保险。
  onResetWorkbench() {
    if (!this.data.isDevEnv) return
    wx.showModal({
      title: '重置实验工位数据？',
      content: '将清空实验工位申请记录与表单草稿，下次进入实验工位将从第一步（申请）开始。',
      confirmText: '重置',
      cancelText: '取消',
      confirmColor: '#BA1A1A',
      success: (res) => {
        if (!res || !res.confirm) return
        const r = resetWorkbenchData()
        if (r.ok) {
          wx.showToast({ title: '已重置，实验工位将重新申请', icon: 'success' })
          // 重置后立即刷新一次（_load 会取到空记录 → mode=apply）
          setTimeout(() => this._load(), 600)
        } else {
          wx.showToast({ title: r.error || '重置失败', icon: 'none' })
        }
      }
    })
  },

  // 弹层内容区 catchtap 占位（避免 catchtap="" 在新版基础库报"事件处理函数名为空"）
  noop() {}
})
