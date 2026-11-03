// components/home/home.js
const { findInstrumentByNo } = require('../../utils/instruments.js')
// getApplyUserDetailShared：带 5 秒跨页缓存 + 并发去重的 detail 请求。
// 首页查准入状态、点横幅分流、进入总览页后总览页再校正节点，这三处共用同一份结果，
// 一次操作只发一个请求（状态变更时先 clearApplyUserDetailCache 再拉，避免读到旧值）。
const { getDeviceDetail, SCAN_DETAIL_KEY, getApplyUserDetailShared, clearApplyUserDetailCache, getApplyList, getPermsCache, getTodoList } = require('../../utils/api.js')
const { getOpenId } = require('../../utils/auth.js')
// /api/applyList 原始条目 → 列表项归一化（与「我的预约」共用）
const { mapApplyListItem } = require('../../utils/applyListItem.js')
// 状态字段视图标签
const { LIST_TAG: APPT_TAG } = require('../../utils/bookingStatus.js')
// 准入 state → 流程节点统一映射（与「我的」/ 准入总览页共用同一份，避免各入口落点不一致）
const { stateToNode, pickState, isAdmitted } = require('../../utils/admissionState.js')

// /api/applyList 的 state 字段约定：与「我的预约」保持一致（4=进行中）
const HOME_STATE_ACTIVE = 4

// 近期预约最多展示条数
const HOME_APPT_MAX = 2

// 今日待办最多展示条数
const HOME_TODO_MAX = 5

// 是否展示已完成（finished = true）的待办：false = 只显示未完成
const SHOW_FINISHED_TODO = false

// 待办列表字段候选：后端可能给数组或 { list|rows|records|items|data }
const TODO_LIST_KEYS = ['list', 'rows', 'records', 'items', 'data', 'todos', 'todoList']
// 待办标题字段候选：接口字段为 label，其余为兼容兜底
const TITLE_KEYS = ['label', 'title', 'todoTitle', 'name', 'todoName', 'taskName', 'taskTitle',
  'subject', 'matter', 'todoContent', 'content', 'summary', 'remark']

// label（待办名称）→ 说明文案：显示在标题下方的小字（"需要干的事情"）
const TODO_TIP = {
  '扫码打卡': '前往实验工位，扫工位二维码完成今日打卡',
  '值日打卡': '前往值日管理，扫工位二维码完成今日打卡',
  '今日打卡': '前往值日管理，扫工位二维码完成今日打卡',
  '仪器预约': '选择仪器与时段，提交预约申请',
  '预约审批': '有待审批的仪器预约，请及时审核',
  '待我审批': '有待审批事项，请尽快处理',
  '设备报修': '登记故障设备与现象，提交报修单',
  '培训考核': '完成培训课程并通过考核',
  '安全培训': '完成培训课程并通过考核',
  '准入申请': '提交准入材料，等待审核通过',
  '准入审批': '有待准入申请待审批，请前往处理',
  '材料提交': '补充并提交准入所需材料'
}

// 上面没命中时，按类型给文案
const TYPE_TIP = {
  daily_sign: '前往实验工位，扫工位二维码完成今日打卡',
  duty: '前往值日管理，扫工位二维码完成今日打卡',
  device_audit: '有待审批的仪器预约，请及时审核',
  device_booking: '查看你的仪器预约记录与状态',
  booking: '选择仪器与时段，提交预约申请',
  approval: '有待审批事项，请尽快完成审批',
  repair: '登记故障设备与现象，提交报修单',
  training: '完成培训课程并通过考核',
  admit: '提交准入材料，等待审核通过',
  admission: '有待准入申请待审批，请前往处理',
  other: ''
}

// 待办名称 → 说明文案：精确匹配 → 关键字匹配 → 按类型 → 空（调用方再兜底）
function todoTipOf(label, typeKey) {
  const t = String(label || '').trim()
  if (TODO_TIP[t]) return TODO_TIP[t]
  if (/打卡|签到/.test(t)) return TYPE_TIP.duty
  if (/预约/.test(t)) return TYPE_TIP.booking
  if (/审批|审核/.test(t)) return TYPE_TIP.approval
  if (/报修|维修|故障/.test(t)) return TYPE_TIP.repair
  if (/培训|考核|考试/.test(t)) return TYPE_TIP.training
  if (/准入|登记|材料/.test(t)) return TYPE_TIP.admit
  return TYPE_TIP[typeKey] || ''
}

// 待办是否已完成：finished = true → 已完成（首页只展示未完成）
// 兼容 true / 'true' / 1 / '1'；字段缺失或 false 都算未完成
function isFinished(o) {
  if (!o || typeof o !== 'object') return false
  const v = o.finished
  if (v === undefined || v === null || v === '') return false
  if (v === true || v === 1 || v === '1') return true
  return String(v).trim().toLowerCase() === 'true'
}

// 待办待处理数量字段候选（pendingCount：0 不显示 / 1 小红点 / >1 红点内显示数字）
const PENDING_KEYS = ['pendingCount', 'pending_count', 'pendingNum', 'count', 'todoCount', 'num']

// 从对象里按候选键取第一个有效数字（取不到返回 0）
function pickNum(o, keys) {
  if (!o || typeof o !== 'object') return 0
  for (const k of keys) {
    const v = o[k]
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v)
      if (!isNaN(n)) return n
    }
  }
  return 0
}

// 从对象里按候选键取第一个非空字符串
function pickStr(o, keys) {
  if (!o || typeof o !== 'object') return ''
  for (const k of keys) {
    const v = o[k]
    if (v !== undefined && v !== null && v !== '') return String(v).trim()
  }
  return ''
}

// ── 今日待办：type → 展示配置（图标 / 图标底色 class / 右侧标签色）──
// 颜色定义在 home.wxss 的 .todo-icon--*（整体亮色暖黄调）；未知类型统一走 other（亮黄）
// 接口实际使用的 type：daily_sign（工位打卡）/ duty（值日）/ device_audit（预约审批）/ device_booking（仪器预约）
// 其余为兼容兜底（中文别名会映射到 booking / approval 等）
const TODO_TYPE = {
  daily_sign:     { key: 'daily_sign',     text: '打卡', icon: 'scan',         iconCls: 'todo-icon--daily-sign',     tagType: 'warning' },
  duty:           { key: 'duty',           text: '值日', icon: 'clock-o',       iconCls: 'todo-icon--duty',           tagType: 'warning' },
  device_audit:   { key: 'device_audit',   text: '审批', icon: 'todo-list-o',   iconCls: 'todo-icon--device-audit',   tagType: 'danger'  },
  device_booking: { key: 'device_booking', text: '预约', icon: 'calendar-o',    iconCls: 'todo-icon--device-booking', tagType: 'primary' },
  booking:        { key: 'booking',        text: '预约', icon: 'calendar-o',    iconCls: 'todo-icon--device-booking', tagType: 'primary' },
  approval:       { key: 'approval',       text: '审批', icon: 'todo-list-o',   iconCls: 'todo-icon--device-audit',   tagType: 'danger'  },
  repair:         { key: 'repair',         text: '报修', icon: 'warning-o',     iconCls: 'todo-icon--repair',         tagType: 'danger'  },
  training:       { key: 'training',       text: '培训', icon: 'certificate',   iconCls: 'todo-icon--training',       tagType: 'warning' },
  // 准入审批：跳准入审批列表页（接口实际 type = access_audit）
  access_audit:  { key: 'admission',     text: '准入', icon: 'records-o',     iconCls: 'todo-icon--admit',          tagType: 'success' },
  admission:     { key: 'admission',     text: '准入', icon: 'records-o',     iconCls: 'todo-icon--admit',          tagType: 'success' },
  admit:         { key: 'admission',     text: '准入', icon: 'records-o',     iconCls: 'todo-icon--admit',          tagType: 'success' },
  other:         { key: 'other',          text: '待办', icon: 'notes-o',       iconCls: 'todo-icon--other',          tagType: 'warning' }
}

// type → 点击后跳转的页面（点整行任意位置都生效）
const TODO_PATH = {
  daily_sign: '/pages/workbench/index',        // 实验工位打卡页
  duty: '/pages/duty-admin/index',             // 值日管理页
  device_audit: '/pages/booking-approval/index', // 预约审批页
  device_booking: '/pages/my-booking/index',   // 我的预约列表页
  admission: '/pages/approval/index'           // 准入审批列表页
}

// 中文 / 数字编码 → 类型键（后端可能直接返回中文或数字）
const TODO_TYPE_ALIAS = {
  '值日': 'duty', '打卡': 'duty', '值班': 'duty',
  '预约': 'booking', '仪器预约': 'booking', '上机': 'booking',
  '审批': 'approval', '审核': 'approval', '待审批': 'approval',
  '报修': 'repair', '维修': 'repair', '故障': 'repair',
  '培训': 'training', '考核': 'training', '考试': 'training',
  '准入': 'admission', '登记': 'admission',
  '准入审批': 'admission', '准入审核': 'admission', '审批准入': 'admission',
  'apply_audit': 'admission', 'user_audit': 'admission', 'admission_audit': 'admission',
  'access_audit': 'admission', 'access': 'admission',
  '1': 'duty', '2': 'booking', '3': 'approval', '4': 'repair', '5': 'training',
  '6': 'admission', '7': 'admission'
}

// type 任意写法 → 展示配置，永远有返回值（兜底 other）
function todoTypeOf(raw) {
  const v = (raw === undefined || raw === null) ? '' : String(raw).trim()
  if (!v) return TODO_TYPE.other
  const lower = v.toLowerCase()
  if (TODO_TYPE[lower]) return TODO_TYPE[lower]
  const key = TODO_TYPE_ALIAS[v] || TODO_TYPE_ALIAS[lower]
  return TODO_TYPE[key] || TODO_TYPE.other
}

// ── 准入状态缓存（模块级，跨组件实例存活）──
// home 组件在自定义 tab（wx:elif）架构下每次切回首页都会重新 attached，
// 用带 TTL 的缓存避免短时间内反复请求 /system/apply_user/detail
const ACCESS_CACHE_TTL = 60 * 1000   // 缓存有效期：60 秒（准入状态变更不频繁，缓存时间不宜过长）
let _accessCache = { ts: 0, openId: '', state: null, admitted: false, name: '', group: '' }

// 准入审批权限码（满足其一即视为有审批权限）
//   system:apply_user:init  → 可初审（state=0）
//   system:apply_user:audit → 可终审（state=4）
const PERM_APPROVE_LIST = ['system:apply_user:init', 'system:apply_user:audit']

// 权限集合里是否含审批权限：兼容数组与逗号分隔字符串
function hasApprovePerm(perms) {
  const list = Array.isArray(perms)
    ? perms.map(p => String(p).trim())
    : (typeof perms === 'string' ? perms.split(',').map(p => p.trim()) : [])
  if (!list.length) return false
  for (let i = 0; i < PERM_APPROVE_LIST.length; i++) {
    if (list.indexOf(PERM_APPROVE_LIST[i]) >= 0) return true
  }
  return false
}

// 最近一次「进入准入流程页」（登记 / 总览 / 上传 / 考试）的时间戳，由各准入页写入本地存储。
// 用途：审核通过后返回首页时，60s 缓存里还是旧的待审核状态，横幅会错误地继续展示；
// 只要缓存早于最近一次进入流程的时间，就判定缓存失效、重新拉取。
const ADMISSION_FLOW_KEY = 'admissionFlowAt'

Component({
  properties: {},

  data: {
    userInfo: {
      name: '张三',
      group: '李教授 · 神经生物学组',
      initial: '张'
    },
    notice: '本周六将进行主要楼层停电检修，请提前安排实验计划',
    dutyStatus: {
      done: false,
      scheduleSet: false
    },
    // 今日待办：GET /api/todo/list
    //   todosLoading=true 表示正在拉接口（骨架占位，避免空态闪现）
    //   todosError=true   表示接口失败，走「点击重试」而非空态
    todos: [],
    todosLoading: true,
    todosError: false,
    // 近期预约：从 /api/applyList(state=4) 拉取，最多展示 HOME_APPT_MAX 条
    //   appointmentsLoading=true 表示正在拉接口、避免空态闪现
    //   appointmentsError=true   表示接口失败、走错误态而非空态
    appointments: [],
    appointmentsLoading: true,
    appointmentsError: false,
    // 准入状态（来自 /system/apply_user/detail 的 applyUser.state）：
    //   null = 无申请记录 / 未查询（未登录、接口失败）→ 点横幅进「申请登记」
    //   -1 / 0 = 已登记未提交材料                    → 点横幅进总览页，定位「材料提交」
    //   4     = 已提交准入申请，待审核                → 点横幅进总览页，定位「等待审核」
    //   2     = 已准入                               → 横幅隐藏
    //   1 / 3 = 已取消 / 已驳回                      → 点横幅进「申请登记」
    accessState: null,
    // 「准入审批」入口是否可用：权限含 system:apply_user:init 或 system:apply_user:audit 时亮起，
    // 否则置灰（置灰点击只提示、不跳转也不请求接口）。权限未知时先置灰，拿到 perms 后更新。
    canApprove: false,
    // 「设备报修」入口已恢复显示；置 false 可再次隐藏，无需改 wxml 结构
    showRepairEntry: true,
    // 「仪器预约」入口暂时隐藏（原位置改为「预约审批」）；置 true 即可恢复
    showBookEntry: false,
    trainings: [
      { id: 1, name: '流式细胞仪专项培训', done: 3, total: 5 },
      { id: 2, name: '激光共聚焦显微镜操作', done: 1, total: 4 }
    ]
  },

  lifetimes: {
    attached() {
      this._loadAppointments()
      this._loadTodos()
      // 先用全局权限缓存渲染「准入审批」入口（避免等接口返回才亮起/置灰）
      this.setData({ canApprove: hasApprovePerm(getPermsCache(getOpenId())) })
      this._loadAccessState()
      // 订阅准入状态变更：提交审核 / 管理员审核通过等场景由变更方主动通知，
      // 收到后立即丢弃缓存重拉，避免首页横幅停在旧状态（如已准入仍显示入口）
      this._onAdmissionChanged = () => {
        // 状态已变更：先丢弃跨页缓存，避免命中变更前的旧值
        clearApplyUserDetailCache()
        this._loadAccessState(true)
      }
      getApp().on('admission:changed', this._onAdmissionChanged)
    },
    detached() {
      // 组件销毁（切走 tab / 页面卸载）时取消订阅，避免重复回调
      if (this._onAdmissionChanged) {
        getApp().off('admission:changed', this._onAdmissionChanged)
        this._onAdmissionChanged = null
      }
    }
  },

  // 注意：不要在这里加 pageLifetimes.show —— 自定义 tab（wx:elif）架构下组件
  // 每次「切到首页 tab」都会重新 attached，pageLifetimes.show 与 attached 接连触发
  // 会导致 /system/apply_user/access 等接口被调用两次；从准入流程返回时由 cache TTL
  // 失效 + attached 重新发起即可（60s 内命中缓存不发请求）

  methods: {
    // 页面层刷新入口（index 页 onShow / 从子页返回时调用）：
    // 强制刷新准入状态（跳过 60s 缓存）。若 5s 内已有 /system/apply_user/detail 结果
    // （跨页缓存命中），则复用结果、不会真的再发一次请求。
    onPageRefresh() {
      this._loadAccessState(true)
      // 从打卡 / 审批 / 值日等页面返回首页时重新拉今日待办（pendingCount、已完成状态都会更新）。
      // 首次进入时 attached 刚拉过（间隔 < 1s），跳过以免连发两次。
      const now = Date.now()
      if (this._todoLoadedAt && now - this._todoLoadedAt < 1000) return
      this._loadTodos()
    },

    // 读取近期预约：GET /api/applyList(state=4) → 归一化 → 取前 HOME_APPT_MAX 条
    // 与「我的预约」共用 mapApplyListItem，保证字段格式与状态文案一致
    _loadAppointments() {
      // 序列号：组件实例可能在请求返回前被销毁（切走 tab），seq 校验丢弃过期响应
      if (this._apptSeq == null) this._apptSeq = 0
      const seq = ++this._apptSeq
      this.setData({ appointmentsLoading: true, appointmentsError: false })
      getApplyList(HOME_STATE_ACTIVE)
        .then(items => {
          if (seq !== this._apptSeq) return  // 过期响应丢弃
          const list = (items || [])
            .map(mapApplyListItem)
            .filter(Boolean)
            // 过滤掉非「近期」状态：已取消 / 已拒绝 / 已关闭 / 爽约
            .filter(b => !['cancelled', 'rejected', 'closed', 'noShow'].includes(b.status))
            // 按起始时间升序：即将到来的排前面
            .sort((a, b) => {
              const ax = (a.dateLabel || '') + ' ' + (a.startText || '')
              const bx = (b.dateLabel || '') + ' ' + (b.startText || '')
              return ax.localeCompare(bx)
            })
            .slice(0, HOME_APPT_MAX)
            .map(b => ({
              id: b.id,
              name: b.instName,
              date: b.dateLabel,
              timeSlot: (b.startText || '') + ' - ' + (b.endText || ''),
              status: b.status,
              statusText: (APPT_TAG[b.status] && APPT_TAG[b.status].text) || '已确认'
            }))
          this.setData({
            appointments: list,
            appointmentsLoading: false,
            appointmentsError: false
          })
        })
        .catch(err => {
          if (seq !== this._apptSeq) return
          console.warn('[home] /api/applyList 失败：', err)
          this.setData({
            appointments: [],
            appointmentsLoading: false,
            appointmentsError: true
          })
        })
    },
    // 今日待办：GET /api/todo/list → 只保留未完成（finished = false）→ 取前 HOME_TODO_MAX 条
    // 触发时机：① attached（切到首页 tab）② onPageRefresh（从打卡/审批等子页返回首页）
    // 每条按 type 映射颜色（图标底色 + 右侧标签），类型未知走 other（灰蓝）
    _loadTodos() {
      // 序列号：组件可能在请求返回前被销毁（切走 tab），seq 校验丢弃过期响应
      if (this._todoSeq == null) this._todoSeq = 0
      const seq = ++this._todoSeq
      this._todoLoadedAt = Date.now()   // 供 onPageRefresh 判断是否刚拉过
      this.setData({ todosLoading: true, todosError: false })
      getTodoList()
        .then(data => {
          if (seq !== this._todoSeq) return  // 过期响应丢弃
          // 诊断：打印返回形态，便于核对字段（取不到数据时先看这行）
          console.log('[home] todo/list 解包后：',
            Array.isArray(data) ? ('数组(' + data.length + ')')
              : (data && typeof data === 'object'
                ? ('对象，键 = ' + Object.keys(data).join(','))
                : String(data)))
          const all = this._pickTodoList(data)
          // 只展示未完成：finished = true 视为已完成被过滤；false / 没给该字段都算未完成
          // SHOW_FINISHED_TODO 置 true 可临时放开显示全部（调试用）
          const rows = SHOW_FINISHED_TODO ? all : all.filter(r => !isFinished(r))
          const list = rows
            .map(t => this._toTodoItem(t))
            .filter(Boolean)
            .slice(0, HOME_TODO_MAX)
          this.setData({ todos: list, todosLoading: false, todosError: false })
          console.log('[home] 今日待办：共', all.length, '条，未完成', rows.length,
            '条 → 渲染', list.length, '条')
          list.forEach(t => {
            console.log('[home]  ·', t.title, '｜type =', t.typeText,
              '｜红点 =', t.dot ? (t.badge || '小点') : '无',
              '｜pendingCount =', t.pendingCount)
          })
          if (rows.length && !list.length) console.warn('[home] 待办有数据但全部未通过解析：', rows[0])
          // 一条红点都没有：打印首条字段名，核对 pendingCount 是否真的在返回里
          if (list.length && !list.some(t => t.dot) && rows[0] && typeof rows[0] === 'object') {
            console.warn('[home] 待办均无待处理数（无红点），首条字段：',
              Object.keys(rows[0]).join(', '))
          }
        })
        .catch(err => {
          if (seq !== this._todoSeq) return
          console.warn('[home] /api/todo/list 失败：', err)
          this.setData({ todos: [], todosLoading: false, todosError: true })
        })
    },

    // 返回可能是数组 / { list|rows|records|items|data|todos|todoList } / 自定义键 → 统一取数组
    _pickTodoList(data) {
      if (Array.isArray(data)) return data
      if (!data || typeof data !== 'object') return []
      // ① 约定键
      for (const k of TODO_LIST_KEYS) {
        if (Array.isArray(data[k])) return data[k]
      }
      // ② 约定键都没命中：扫一层，取第一个非空数组（兼容 unfinish / finish / pending 等自定义键）
      for (const k of Object.keys(data)) {
        const v = data[k]
        if (Array.isArray(v) && v.length) return v
      }
      // ③ 单条对象（后端只返回一条待办时）
      if (data.title || data.todoTitle || data.todoName || data.name || data.content) return [data]
      console.warn('[home] /api/todo/list 返回结构未识别：', data)
      return []
    },

    // 单条待办 → 视图项（id / 标题 / 描述 / 类型颜色 / 跳转路径）
    _toTodoItem(t) {
      // 数组元素可能是纯字符串（直接就是待办标题）
      if (typeof t === 'string') {
        const s = t.trim()
        if (!s) return null
        const type = todoTypeOf('')
        return {
          id: s, title: s, desc: todoTipOf(s, type.key) || '点击查看详情',
          typeText: type.text, icon: type.icon, iconCls: type.iconCls, tagType: type.tagType,
          path: '', dot: false, badge: '', pendingCount: 0
        }
      }
      if (!t || typeof t !== 'object') return null
      const rawTitle = pickStr(t, TITLE_KEYS)
      // 标题取不到时不丢弃这条（否则有数据也会显示空态），用占位文案并打印原始项便于补字段
      if (!rawTitle) console.warn('[home] 待办项缺少标题字段，原始项：', t)
      const title = rawTitle || '待办事项'
      const rawType = t.type !== undefined ? t.type : (t.todoType || t.category)
      const type = todoTypeOf(rawType)
      // 类型走到兜底 other：打印原始 type，方便补映射（未识别的类型不会跳转）
      if (type.key === 'other' && String(rawType || '').trim() !== '') {
        console.warn('[home] 待办 type 未识别（不会跳转）：', rawType, '｜待办：', title)
      }
      // 说明文案（标题下方小字）：接口给了描述就用接口的，否则按 label 生成，再其次是时间
      const time = pickStr(t, ['time', 'todoTime', 'deadline', 'planTime', 'createTime'])
      const desc = pickStr(t, ['desc', 'description', 'remark', 'subTitle', 'detail'])
      const tip = todoTipOf(title, type.key)
      // 待处理数：<=0 不显示；=1 显示小红点；>1 显示大红点并在红点内显示数量（>99 显示 99+）
      const pending = pickNum(t, PENDING_KEYS)
      return {
        id: (t.id !== undefined && t.id !== null && t.id !== '') ? String(t.id) : title,
        title,
        desc: desc || tip || time || '点击查看详情',
        typeText: type.text,
        icon: type.icon,
        iconCls: type.iconCls,
        tagType: type.tagType,
        dot: pending > 0,
        badge: pending > 1 ? (pending > 99 ? '99+' : String(pending)) : '',
        pendingCount: pending,
        // 跳转：优先按 type 映射页面（接口自带 path 作为兜底）
        path: TODO_PATH[type.key] || String(t.path || t.url || t.page || '').trim()
      }
    },

    // 点待办项：带 path 就跳转，否则只提示标题（后端没给落点时不会乱跳）
    onTodoTap(e) {
      const i = Number(e.currentTarget.dataset.idx)
      const item = this.data.todos[i]
      if (!item) return
      if (item.path && /^\//.test(item.path)) {
        wx.navigateTo({
          url: item.path,
          fail: () => wx.showToast({ title: '页面不存在', icon: 'none' })
        })
        return
      }
      wx.showToast({ title: item.title, icon: 'none' })
    },

    // 准入入口显隐 + 首页 Header 用户信息：GET /system/apply_user/detail?openId={openId}
    // 数据全部取自返回的 applyUser（原 /system/apply_user/access 已移除）：
    //   applyUser 为空        → 无申请记录（未登记），显示准入入口
    //   applyUser.state = 2   → 已准入，隐藏横幅
    //   其它 state（含新增 4=已提交待审核、1/3=取消/驳回）→ 显示横幅
    // 触发源：① attached（切到首页 tab）② admission:changed 事件（force=true）。
    // 带 60s 模块级缓存：
    //   ① 缓存命中（同 openId、60s 内、且晚于最近一次进入准入流程的时间）→ 直接用缓存渲染，不发请求
    //   ② 请求进行中直接跳过
    // force=true（状态变更事件）/ 缓存早于最近一次进入准入流程 → 跳过缓存强制重拉
    _loadAccessState(force) {
      const openId = getOpenId()
      if (!openId) {
        // 未登录/无 openid（如体验账号）：查不到准入状态，默认显示入口
        this.setData({ 'userInfo.admitted': false, accessState: null })
        return
      }
      const now = Date.now()
      // 最近一次进入准入流程页的时间：缓存早于它就说明状态可能已变（如审核通过），缓存作废
      let flowAt = 0
      try { flowAt = Number(wx.getStorageSync(ADMISSION_FLOW_KEY)) || 0 } catch (e) { /* 忽略缓存异常 */ }
      const staleByFlow = flowAt > 0 && _accessCache.ts < flowAt
      if (!force && !staleByFlow &&
        _accessCache.openId === openId && _accessCache.ts && now - _accessCache.ts < ACCESS_CACHE_TTL) {
        console.log('[home] 准入状态缓存命中，剩余 ' + Math.round((ACCESS_CACHE_TTL - (now - _accessCache.ts)) / 1000) + 's，不发请求')
        this.setData({
          'userInfo.admitted': _accessCache.admitted,
          accessState: _accessCache.state
        })
        if (_accessCache.name) {
          this.setData({
            'userInfo.name': _accessCache.name,
            'userInfo.initial': (_accessCache.name || '').charAt(0)
          })
        }
        if (_accessCache.group) this.setData({ 'userInfo.group': _accessCache.group })
        return
      }
      if (this._accessLoading) return
      this._accessLoading = true
      console.log('[detail] 发起请求，openId =', openId)
      getApplyUserDetailShared(openId)
        .then(({ applyUser, perms }) => {
          const hasUser = !!(applyUser && typeof applyUser === 'object' && Object.keys(applyUser).length > 0)
          // 状态取 applyUser.state：无申请记录时为 null（沿用「无数据」语义）
          const st = pickState(applyUser)
          // 「准入审批」入口：按权限（init / audit）亮起或置灰
          const canApprove = hasApprovePerm(perms)
          console.log('[home] perms =', perms || [], '→ canApprove =', canApprove)
          this.setData({
            'userInfo.admitted': isAdmitted(st),
            accessState: st,
            canApprove
          })
          _accessCache = {
            ts: Date.now(),
            openId,
            state: st,
            admitted: isAdmitted(st),
            name: '',
            group: ''
          }
          // 用同一份返回的 applyUser 渲染 Header（姓名 + 课题组/部门），不再二次请求
          if (hasUser) this._fillUserInfo(openId, applyUser)
        })
        .catch(err => {
          // 接口异常不阻塞首页，按「未准入」展示入口
          console.warn('[home] /system/apply_user/detail 查询失败：', err)
          this.setData({ 'userInfo.admitted': false, accessState: null })
        })
        .then(() => { this._accessLoading = false })
    },
    // 用 applyUser 更新首页 Header 的真实姓名与课题组/部门，并回写模块缓存
    _fillUserInfo(openId, applyUser) {
      const name = String((applyUser && (applyUser.name || applyUser.userName)) || '').trim()
      if (!name) return
      const patch = {
        'userInfo.name': name,
        'userInfo.initial': name.charAt(0)
      }
      const group = String((applyUser && (applyUser.teamName || applyUser.team_name)) || '').trim()
      const dept = String((applyUser && (applyUser.deptName || applyUser.dept_name)) || '').trim()
      if (group || dept) patch['userInfo.group'] = group || dept
      this.setData(patch)
      // 同步更新缓存：下次切回首页可直接从缓存拿到姓名/课题组
      if (_accessCache.openId === openId) {
        _accessCache.name = name
        _accessCache.group = patch['userInfo.group'] || _accessCache.group
      }
    },
    // ── 今日待办 ──
    goToDuty() {
      wx.showToast({ title: '今日值日 · 记得按时打卡', icon: 'none' });
    },
    goToDutySchedule() {
      wx.showToast({ title: '值日表未设置', icon: 'none' });
    },
    goToDutyAdmin() {
      wx.navigateTo({ url: '/pages/duty-admin/index' });
    },

    // ── 快捷入口 ──
    // 仪器扫码（第一项）：扫码得到 deviceId → 调后端 /api/getDeviceDetail → 进详情页展示返回数据
    // 扫码成功后立即进入加载过渡：查询期间全屏 loading，跳转完成才收起（至少展示 MIN_LOADING_MS，避免一闪而过）
    goToScanInstrument() {
      wx.scanCode({
        scanType: ['qrCode'],
        onlyFromCamera: false,
        success: res => {
          const deviceId = (res.result || '').trim()
          if (!deviceId) return
          this._openDeviceDetail(deviceId)
        }
      })
    },
    // 扫码 → 详情页的统一过渡：loading 覆盖「查询中 → 跳转完成」，失败/成功均收敛
    _openDeviceDetail(deviceId) {
      const MIN_LOADING_MS = 600 // loading 最小可见时长，防止接口秒回时无感知
      const t0 = Date.now()
      const done = () => {
        const left = MIN_LOADING_MS - (Date.now() - t0)
        setTimeout(() => wx.hideLoading(), left > 0 ? left : 0)
      }
      wx.showLoading({ title: '正在查询设备详情…', mask: true })
      getDeviceDetail(deviceId)
        .then(data => {
          try { wx.setStorageSync(SCAN_DETAIL_KEY, { deviceId, data, ts: Date.now() }) } catch (e) { /* 忽略缓存异常 */ }
          // 跳转完成后再收起 loading，由详情页自身内容（或页内 loading）无缝衔接
          wx.navigateTo({
            url: '/pages/scan-detail/index?deviceId=' + encodeURIComponent(deviceId),
            complete: done
          })
        })
        .catch(() => {
          done()
          wx.showModal({
            title: '查询失败',
            content: '未获取到设备详情，请确认后端服务已启动且该二维码为本平台设备编码。',
            showCancel: false,
            confirmColor: '#0A7BB8'
          })
        })
    },
    // 原"扫码签到"入口（本地演示）：二维码内容为设备编号 → 识别后进入 scan-device
    goToScan() {
      wx.scanCode({
        scanType: ['qrCode'],
        onlyFromCamera: false,
        success: res => {
          const no = (res.result || '').trim()
          if (!no) return
          if (!findInstrumentByNo(no)) {
            wx.showModal({
              title: '未识别到设备',
              content: '该二维码不是本平台设备的编号，请扫描设备机身上贴的设备编号二维码。',
              showCancel: false,
              confirmColor: '#0A7BB8'
            })
            return
          }
          wx.navigateTo({ url: '/pages/scan-device/index?no=' + encodeURIComponent(no) })
        }
      })
    },
    goToInstrument() {
      this.triggerEvent('switchTab', { page: 'instrument' });
    },
    goToTraining() {
      this.triggerEvent('switchTab', { page: 'training' });
    },
    goToWorkbench() {
      wx.navigateTo({ url: '/pages/workbench/index' });
    },
    goToRepair() {
      wx.showToast({ title: '设备报修', icon: 'none' });
    },
    // 预约审批：查看需要我审批的仪器预约记录（pages/booking-approval，只读列表）
    goToBookingApproval() {
      wx.navigateTo({ url: '/pages/booking-approval/index' });
    },
    // 准入审批：有权限（system:apply_user:init / system:apply_user:audit）才进入审批页；
    // 无权限时入口置灰，点击只提示、不跳转（因此不会请求审批列表接口）
    goToApproval() {
      if (!this.data.canApprove) {
        wx.showToast({ title: '您没有审批权限', icon: 'none' });
        return;
      }
      wx.navigateTo({ url: '/pages/approval/index' });
    },
    goToMentor() {
      wx.showToast({ title: '方法学门诊', icon: 'none' });
    },

    // ── 准入横幅（点击入口 → GET /system/apply_user/detail?openId={openId} 分流）──
    // 以接口返回的 applyUser.state 为准，节点落点统一取 utils/admissionState.js：
    //   applyUser 为空（后端无该用户的申请记录）→ 申请登记填写页
    //   -1         → 总览页「材料提交」（step=1）
    //   0 / 4      → 总览页「等待审核」（step=2）   ← 后端当前下发的待审核值为 4
    //   2          → 总览页「准入成功」（step=3）
    //   1 / 3      → 申请登记填写页（已取消 / 已驳回，需重新登记）
    //   无 openId / 接口失败                       → 兜底按首页已缓存的 accessState 跳转
    goToOnboarding() {
      const openId = getOpenId()
      if (!openId) {
        // 无 openId 无法查询申请记录，直接引导登记
        wx.navigateTo({ url: '/pages/onboarding/register/register' });
        return;
      }
      if (this._onboardingLoading) return   // 防重复点击
      this._onboardingLoading = true
      console.log('[home] 点击准入入口，查询 /system/apply_user/detail，openId =', openId)
      wx.showLoading({ title: '正在查询…', mask: true })
      getApplyUserDetailShared(openId)
        .then(({ applyUser }) => {
          wx.hideLoading()
          // applyUser 为空对象 / null 均视为「无申请记录」
          const hasUser = !!(applyUser && typeof applyUser === 'object' && Object.keys(applyUser).length > 0)
          if (!hasUser) {
            console.log('[home] applyUser 为空 → 申请登记填写页')
            wx.navigateTo({ url: '/pages/onboarding/register/register' });
            return;
          }
          const st = pickState(applyUser)
          console.log('[home] applyUser 非空，state =', applyUser.state, '→ 节点', stateToNode(st))
          // state 缺失时回退首页已缓存的状态（accessState）
          this._goToOnboardingByState(st == null ? this.data.accessState : st)
        })
        .catch(err => {
          wx.hideLoading()
          console.warn('[home] /system/apply_user/detail 查询失败：', err)
          this._goToOnboardingByState(this.data.accessState)
        })
        .then(() => { this._onboardingLoading = false })
    },
    // 按状态定位跳转（节点映射见 utils/admissionState.js，与「我的」/ 总览页完全一致）：
    //   节点 0：无数据 / 1（已取消）/ 3（已驳回）→ 申请登记页（需重新登记）
    //   节点 1：-1（已登记未提交材料）          → 总览页「材料提交」
    //   节点 2：0 / 4（已提交待审核）            → 总览页「等待审核」
    //   节点 3：2（已准入）                      → 总览页「准入成功」
    _goToOnboardingByState(st) {
      const node = stateToNode(st)
      if (node === 0) {
        wx.navigateTo({ url: '/pages/onboarding/register/register' });
        return;
      }
      wx.navigateTo({ url: '/pages/onboarding/index/index?step=' + node });
    },

    // ── 近期预约 / 培训进度 ──
    // 点击某条预约 → 进入「我的预约」页（该预约的记录详情所在）
    goToAppointmentDetail() {
      wx.navigateTo({ url: '/pages/my-booking/index' });
    },
    // 点击某条培训 → 进入该培训的详情页
    goToTrainingDetail(e) {
      const id = e.currentTarget.dataset.id;
      if (id == null) return;
      wx.navigateTo({ url: '/pages/training/detail/detail?id=' + id });
    }
  }
});
