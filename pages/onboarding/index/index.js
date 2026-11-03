// pages/onboarding/index/index.js
const { getApplyUserDetail, getApplyUserDetailShared, checkCertRecordValid, checkAttachments, BASE, ADMISSION_USER_DETAIL_KEY, changeApplyUserState, clearApplyUserDetailCache } = require('../../../utils/api.js')
const { getOpenId } = require('../../../utils/auth.js')
// 准入 state → 本页节点（0-3）统一映射，与首页横幅 / 「我的」共用同一份
const { stateToNode, pickState } = require('../../../utils/admissionState.js')

// 材料清单（上传节点「查看」用）
const DOCS = [
  { id: 1, name: '平台使用申请书', required: true },
  { id: 2, name: '安全承诺书', required: true },
  { id: 3, name: '知识产权共享承诺书', required: true },
  { id: 4, name: '合作证明文件', required: false }
]

Page({
  data: {
    currentStep: 0,   // 0-3，默认第 0 步；实际进度以 storage「admissionStep」为准（onLoad/onShow 会覆盖）
    submitTime: '2026-09-02 10:00',
    steps: [
      { id: 0, label: '申请登记',   status: 'active' },
      { id: 1, label: '材料提交',   status: 'pending' },
      { id: 2, label: '等待审核',   status: 'pending' },
      { id: 3, label: '准入成功',   status: 'pending' },
    ],
    btnText: '开始填写',
    // 第 2 步「材料提交」下两项子任务状态（上传文件 + 安全考试）
    uploadDone: false,
    uploadText: '材料尚未上传，请前往上传',
    // 上传任务样式类型：none（未上传）/ partial（部分上传）/ done（全部上传）
    uploadStateType: 'none',
    // 远程材料上传状态校验结果（GET /system/apply_user_attachment/checkAttachments）
    attachmentFlag: null,   // 1 上传成功 / 2 部分上传 / 3 未上传
    attachmentLoading: false,
    // 提交审核按钮是否亮起可点击：attachmentFlag=1 且 hasValid=true 才为 true
    canSubmit: false,
    examDone: false,
    examText: '完成安全培训学习后参加',
    // 远程证书校验结果（GET /system/cert_record/checkValid）
    hasValidCert: false,
    certExamRecord: null,
    certLoading: false,
    // 考试任务样式类型：pending（未参加）/ passed（通过/有证）/ failed（未通过）/ grading（评卷中）
    examStateType: 'pending',
    // 节点详情弹层（点击步骤节点查看对应信息）
    nodePop: {
      show: false,
      stepId: 0,
      title: '',
      rows: [],
      empty: '',
      actionText: ''
    },
    // 提交审核 / 重新开始 / 撤回 二次确认弹窗（自绘 modal：系统 wx.showModal 在本环境不弹出）
    resetModal: {
      show: false,
      mode: '',         // submit | restart | withdraw
      title: '',
      content: '',
      confirmText: ''
    }
  },

  onLoad(options) {
    // 支持外部带 step 定位节点（首页准入横幅分流进入）：
    //   ?step=1 → 材料提交节点；?step=2 → 等待审核节点
    // 以远程状态为准写入本地进度缓存后，再走 _syncFromStorage 同步渲染
    const s = Number(options && options.step)
    if (options && options.step !== undefined && s >= 0 && s <= 3) {
      wx.setStorageSync('admissionStep', s)
    }
    this._syncFromStorage()
    // 进入页面时拉取远程状态：材料上传状态 + 安全证书状态，用于渲染两项子任务
    this._checkAttachments()
    this._checkCertRecord()
    // 注意：这里不再调 _syncStepFromDetail —— 首次进入的生命周期顺序是
    // onLoad → onShow，onShow 里已会校正节点；若 onLoad 也调，首次进入会
    // 连发两次 /system/apply_user/detail。onShow 覆盖「首次进入 + 返回本页」全部场景。
  },

  onShow() {
    // 从「培训详情」（navigationStyle: custom）返回时，微信在「自定义导航栏页 ↔ 普通页」
    // 混用页面栈时存在已知渲染缺陷：本页原生导航栏（状态栏区域）会被刷成白框。
    // onShow 里强制重刷一次导航栏颜色即可恢复。
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: '#0A7BB8',
      fail: () => {}
    })
    this._syncFromStorage()
    // 记录「进入过准入流程页」的时间戳：首页用它判断 60s 准入缓存是否已失效
    // （审核通过后返回首页时，若命中旧缓存会继续错误地展示准入横幅）
    try { wx.setStorageSync('admissionFlowAt', Date.now()) } catch (e) { /* 忽略缓存异常 */ }
    // 从培训/考试/上传页返回时也重新拉一次远程状态（覆盖 data.attachmentFlag / hasValidCert 等）
    this._checkAttachments()
    this._checkCertRecord()
    // 后端状态可能在离开期间变化（管理员审批通过/驳回/取消），返回时以 detail 接口校正节点
    this._syncStepFromDetail()
  },

  // 从跨页存储同步准入进度与提交时间（返回本页/重新进入时刷新）
  _syncFromStorage() {
    const step = wx.getStorageSync('admissionStep')
    const st = wx.getStorageSync('admissionSubmitTime')
    const patch = {}
    if (typeof step === 'number' && step >= 0 && step <= 3) patch.currentStep = step
    if (st) patch.submitTime = st
    this.setData(patch)
    this._refreshSteps()
  },

  // 以 /system/apply_user/detail 的 applyUser.state 校正当前节点（远程为准，避免与后端状态不一致）
  //   场景：管理员在后台审批通过（state=2）/ 驳回（state=3）/ 取消（state=1）后，
  //   本地缓存 admissionStep 仍是旧值；此处查询后覆盖本地并重渲染。
  //   state=4（已提交待审核）→ 节点 2「等待审核」，与首页 / 「我的」落点一致。
  //   接口失败 / 无 openId / 无申请记录时不改动本地进度。
  _syncStepFromDetail() {
    const openId = getOpenId()
    if (!openId) return
    // 防重入：页面 onLoad+onShow 或快速重复进入时只发一次请求
    if (this._detailSyncing) return
    this._detailSyncing = true
    // 用共享版：从首页 / 「我的」进入本页时入口页刚查过一次 detail，5 秒内直接复用，避免重复请求
    getApplyUserDetailShared(openId)
      .then(({ applyUser }) => {
        const state = pickState(applyUser)
        if (state == null) return   // 无申请记录：保持本地（默认第 0 步）
        const node = stateToNode(state)
        if (this.data.currentStep !== node) {
          console.log('[onboarding] detail 校正节点：state =', state, '→ 节点', node, '（原', this.data.currentStep, '）')
          wx.setStorageSync('admissionStep', node)
          this.setData({ currentStep: node })
          this._refreshSteps()
        }
        // 远程状态与上次不一致（如管理员审核通过 4 → 2）→ 主动通知首页 / 「我的」刷新。
        // 不通知的话，返回首页时组件不会重新 attached，会命中 60s 旧缓存继续展示准入横幅。
        if (this._lastState !== state) {
          this._lastState = state
          // 远程状态已变：丢弃 detail 跨页缓存，避免首页 / 「我的」读回变更前的值
          clearApplyUserDetailCache()
          getApp().emit('admission:changed', { state })
        }
      })
      .catch(err => {
        console.warn('[onboarding] detail 状态校正失败：', err)
      })
      .then(() => { this._detailSyncing = false })
  },

  _nowText() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  },

  _refreshSteps() {
    const { currentStep, steps } = this.data
    const updated = steps.map((s, i) => ({
      ...s,
      status: i < currentStep ? 'done' : i === currentStep ? 'active' : 'pending'
    }))
    const btnMap = ['开始填写', '', '已提交，等待审核', '返回首页']
    this.setData({ steps: updated, btnText: btnMap[currentStep] })
    this._refreshTaskState()
  },

  // ── 第 2 步「材料提交」子任务状态（必传材料是否齐全 / 考试是否通过） ──
  // 上传状态：优先用远程 attachmentFlag（1 上传成功 / 2 部分上传 / 3 未上传），未加载时回退本地缓存
  _getUploadState() {
    const flag = this.data.attachmentFlag
    if (flag === 1) return { done: true, stateType: 'done', text: '必填材料已全部上传' }
    if (flag === 2) return { done: false, stateType: 'partial', text: '部分材料已上传，请补全剩余材料' }
    if (flag === 3) return { done: false, stateType: 'none', text: '材料尚未上传，请前往上传' }
    // 远程未加载 / 无结果：回退本地缓存（旧逻辑）
    const savedMap = {}
    ;(wx.getStorageSync('admissionUpload') || []).forEach((d) => { savedMap[d.id] = d })
    const required = DOCS.filter((d) => d.required)
    const done = required.filter((d) => {
      const s = savedMap[d.id]
      return s && s.photos && s.photos.length > 0
    }).length
    const all = done >= required.length
    return {
      done: all,
      stateType: all ? 'done' : (done > 0 ? 'partial' : 'none'),
      text: all ? '必填材料已全部上传' : `还需上传 ${required.length - done} 份必填材料`
    }
  },

  _getExamState() {
    const hasValid = !!this.data.hasValidCert
    const rec = this.data.certExamRecord
    const remoteState = (rec && typeof rec.state === 'number') ? rec.state : null
    const remoteScore = (rec && rec.score != null && rec.score !== '' && isFinite(Number(rec.score))) ? Number(rec.score) : null

    // ── 状态判定规则（与 /system/cert_record/checkValid 返回字段对齐）──────────────
    //   1. hasValid=true 且 state=1 → passed（考试通过 + 已发证，最完整通过态）
    //   2. hasValid=false 且 state=0 → grading（评卷中）
    //   3. hasValid=false 且 state=2 → failed（未通过，可重新考试）
    //   4. 其它（未考试 / 远程未加载 / state 缺失） → pending（需先通过安全考试）

    // 1. hasValid=true 且 state=1：考试通过 + 有安全证书（最完整通过态）
    if (hasValid && remoteState === 1) {
      return {
        done: true,
        stateType: 'passed',
        text: remoteScore != null ? `已通过 · ${remoteScore} 分 · 有安全证书` : '已通过 · 有安全证书'
      }
    }
    // 兜底：hasValid=true 但 state 字段异常（理论上不会出现），仍视为通过——证书是最权威证明
    if (hasValid) {
      return {
        done: true,
        stateType: 'passed',
        text: remoteScore != null ? `已通过 · ${remoteScore} 分 · 有安全证书` : '已通过 · 有安全证书'
      }
    }
    // 2. hasValid=false 且 state=0：评卷中
    if (!hasValid && remoteState === 0) {
      return { done: false, stateType: 'grading', text: '评卷中 · 请稍候' }
    }
    // 3. hasValid=false 且 state=2：未通过，可重新考试
    if (!hasValid && remoteState === 2) {
      return {
        done: false,
        stateType: 'failed',
        text: remoteScore != null ? `未通过 · ${remoteScore} 分，可重新考试` : '未通过，可重新考试'
      }
    }
    // 兜底：hasValid=false 但 state=1（通过但暂未发证）→ 视为通过
    if (!hasValid && remoteState === 1) {
      return {
        done: true,
        stateType: 'passed',
        text: remoteScore != null ? `已通过 · ${remoteScore} 分` : '已通过'
      }
    }
    // 4. 其它情况：未考试 / 远程未加载 / state 字段缺失 → 需要通过安全考试
    return { done: false, stateType: 'pending', text: '需先通过安全考试' }
  },

  // 「材料提交」节点里「安全考试」部分的展示行：
  // 数据源以 /system/cert_record/checkValid 的 hasValid + examRecord.state 为准
  // 字段解析逻辑与 _getExamState 保持一致，避免任务卡片与详情面板文案对不上
  _buildExamRows() {
    const hasValid = !!this.data.hasValidCert
    const rec = (this.data.certExamRecord && typeof this.data.certExamRecord === 'object') ? this.data.certExamRecord : {}
    const state = (typeof rec.state === 'number') ? rec.state : null
    const score = (rec.score !== undefined && rec.score !== null && rec.score !== '' && isFinite(Number(rec.score))) ? Number(rec.score) : null
    // 考试时间：远程字段多源（examTime/createTime/submitTime），缺失时回退本地 admissionExam.time
    const examTime = rec.examTime || rec.createTime || rec.submitTime || rec.time
      || (wx.getStorageSync('admissionExam') && wx.getStorageSync('admissionExam').time)
      || ''
    const localExam = wx.getStorageSync('admissionExam') || null

    const rows = []

    // ── 1. 考试结果（始终显示，作为主状态行） ──
    let resultText = ''
    let resultAccent = false
    if (hasValid && state === 1) {
      // 通过 + 已发证（最完整通过态）
      resultText = '已通过 · 有安全证书'
      resultAccent = true
    } else if (hasValid) {
      // hasValid=true 但 state 字段异常，证书优先
      resultText = '已通过 · 有安全证书'
      resultAccent = true
    } else if (!hasValid && state === 0) {
      // 评卷中
      resultText = '评卷中 · 请稍候'
    } else if (!hasValid && state === 1) {
      // 通过但暂未签发证书
      resultText = '已通过 · 证书签发中'
      resultAccent = true
    } else if (!hasValid && state === 2) {
      // 未通过：可重新考试
      resultText = score != null ? `未通过 · ${score} 分，可重新考试` : '未通过 · 可重新考试'
    } else {
      // pending：远程未加载 / state 缺失 / 还未考试
      if (localExam && localExam.passed) {
        resultText = score != null ? `已通过 · ${score} 分（待远程确认）` : '已通过（待远程确认）'
        resultAccent = true
      } else {
        resultText = '尚未参加'
      }
    }
    rows.push({ label: '考试结果', value: resultText, accent: resultAccent })

    // ── 2. 考试成绩（仅当有分数时显示） ──
    if (score != null) {
      rows.push({ label: '考试成绩', value: `${score} 分`, accent: resultAccent })
    }

    // ── 3. 考试时间（仅当有时间记录时显示） ──
    if (examTime) {
      rows.push({ label: '考试时间', value: examTime })
    }

    return rows
  },

  // 进入页面 / 返回时调：按当前 openId 查询安全证书状态，写入 data 后刷新任务态
  async _checkCertRecord() {
    if (this.data.certLoading) return
    const openId = getOpenId()
    if (!openId) {
      // 未登录：静默跳过，不阻塞页面渲染（本地缓存仍可兜底）
      this._refreshTaskState()
      return
    }
    this.setData({ certLoading: true })
    try {
      const result = await checkCertRecordValid(openId)
      const rec = (result && result.examRecord) || null
      this.setData({
        hasValidCert: !!(result && result.hasValid),
        certExamRecord: rec
      })
    } catch (err) {
      console.warn('[onboarding] /system/cert_record/checkValid 失败：', err)
    } finally {
      this.setData({ certLoading: false })
      this._refreshTaskState()
    }
  },

  // 进入页面 / 返回时调：按当前 openId 查询材料上传状态（attachmentFlag）后刷新任务态
  async _checkAttachments() {
    if (this.data.attachmentLoading) return
    const openId = getOpenId()
    if (!openId) {
      // 未登录：静默跳过，不阻塞页面渲染（本地缓存仍可兜底）
      this._refreshTaskState()
      return
    }
    this.setData({ attachmentLoading: true })
    try {
      const result = await checkAttachments(openId)
      this.setData({ attachmentFlag: (result && result.attachmentFlag) || null })
    } catch (err) {
      console.warn('[onboarding] /system/apply_user_attachment/checkAttachments 失败：', err)
    } finally {
      this.setData({ attachmentLoading: false })
      this._refreshTaskState()
    }
  },

  _refreshTaskState() {
    const u = this._getUploadState()
    const e = this._getExamState()
    // 提交审核按钮亮起条件：材料全部上传（attachmentFlag=1）且已获有效安全证书（hasValid=true）
    const canSubmit = this.data.attachmentFlag === 1 && !!this.data.hasValidCert
    this.setData({
      uploadDone: u.done,
      uploadText: u.text,
      uploadStateType: u.stateType,
      examDone: e.done,
      examText: e.text,
      examStateType: e.stateType,
      canSubmit: canSubmit
    })
  },

  // ── 点击步骤节点：查看对应信息（未开始的步骤给出提示） ──
  openStepInfo(e) {
    const id = Number(e.currentTarget.dataset.id)
    if (id > this.data.currentStep) {
      wx.showToast({ title: '该步骤尚未开始', icon: 'none' })
      return
    }
    const info = this._buildNodeInfo(id)
    this.setData({ nodePop: { show: true, ...info } })
  },

  // 生成节点详情：title / rows / empty / actionText / actionMode
  _buildNodeInfo(id) {
    const titles = ['申请登记', '材料提交', '等待审核', '准入成功']
    const base = { stepId: id, title: titles[id] || '', rows: [], empty: '', actionText: '', actionMode: '' }
    const cs = this.data.currentStep

    if (id === 0) {
      // 查看之前填写的登记内容
      const reg = wx.getStorageSync('admissionRegister')
      if (!reg || !reg.form) {
        return {
          ...base,
          empty: '尚未填写申请登记信息',
          actionText: cs === 0 ? '开始填写' : '',
          actionMode: cs === 0 ? 'register' : ''
        }
      }
      const inside = reg.identity !== 'outside'
      const f = reg.form
      const src = [
        ['人员身份', inside ? ('院内人员 · ' + (f.scope || '--')) : '院外人员'],
        ['姓名', f.name],
        ['学号/工号', f.idNo],
        ['手机号', f.phone],
        ['邮箱', f.email],
        ['导师姓名', f.supervisor],
        ['导师手机号', f.superphone],
        ['课题组', f.group],
        [inside ? '部门' : '所在单位', inside ? f.dept : f.org],
        ['合作项目', f.project],
        ['实验内容', f.purpose]
      ]
      // 已填写字段 → 蓝色加粗（与材料提交里「已上传 / 已通过」一致的高亮样式）；
      // 未填写字段 → 默认灰色「未填写」，未完成项以弱化形式呈现，与材料提交里「未上传」一致
      const isFilled = (v) => v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '--'
      const rows = src.map(([label, value]) => ({
        label,
        value: isFilled(value) ? value : '未填写',
        accent: isFilled(value)
      }))
      // 顶部进度汇总：已填写 N / 共 M 项，对齐材料提交里「已上传 N 张」的呈现形式
      const filledCount = src.filter(([, v]) => isFilled(v)).length
      rows.unshift({ label: '填写进度', value: `已填写 ${filledCount} / ${src.length} 项`, accent: filledCount === src.length })
      if (reg.submitTime) rows.push({ label: '提交时间', value: reg.submitTime, accent: true })
      return {
        ...base,
        rows,
        actionText: cs === 0 ? '修改信息' : '',
        actionMode: cs === 0 ? 'register' : ''
      }
    }

    if (id === 1) {
      // 「材料提交」= 上传文件 + 安全考试 两项子任务完成情况
      const savedMap = {}
      ;(wx.getStorageSync('admissionUpload') || []).forEach((d) => { savedMap[d.id] = d })
      const uploadRows = DOCS.map((doc) => {
        const d = savedMap[doc.id]
        const n = d && d.photos ? d.photos.length : 0
        if (n > 0) {
          return { label: doc.name, value: `已上传 ${n} 份`, accent: true }
        }
        // 条件必填：服务器判定 attachmentFlag=2（部分上传）时，doc 4（合同证明文件）也按必传项显示
        // 院外人员的 doc 4 本就必传，已通过 getApplyUserDetail 写入 attachmentList；此处仅兜底「远程未加载 + 院内用户」场景
        const conditionallyRequired = this.data.attachmentFlag === 2 && doc.id === 4
        const required = !!doc.required || conditionallyRequired
        return {
          label: doc.name,
          // 区分两种文案：一直必填 →「未上传」；条件必填（部分上传时）→「未上传（必填）」提示用户补传
          value: required ? (conditionallyRequired ? '未上传（必填）' : '未上传') : '未上传（选填）',
          accent: false
        }
      })
      const examRows = this._buildExamRows()
      const rows = [...uploadRows, ...examRows]
      if (cs === 1) {
        const u = this._getUploadState()
        if (!u.done) {
          return { ...base, rows, actionText: '去上传材料', actionMode: 'upload' }
        }
        // 与提交按钮置灰条件保持一致：材料齐全后仍需 hasValid=true 才可提交
        if (!this.data.canSubmit) {
          return { ...base, rows, actionText: '去参加考试', actionMode: 'exam' }
        }
        return { ...base, rows, actionText: '提交审核', actionMode: 'submit' }
      }
      return { ...base, rows }
    }

    if (id === 2) {
      // 查看审核进度
      return {
        ...base,
        rows: [
          { label: '提交时间', value: wx.getStorageSync('admissionSubmitTime') || this.data.submitTime },
          { label: '预计时长', value: '1-3 个工作日' },
          { label: '审批节点', value: '科室主任 → 平台管理员' },
          {
            label: '当前状态',
            value: cs > 2 ? '审批已通过' : '审核中，请耐心等待',
            accent: cs > 2
          }
        ]
      }
    }

    // id === 3 准入成功
    return {
      ...base,
      rows: [
        { label: '准入状态', value: '已准入', accent: true },
        { label: '生效方式', value: '审批通过后即时生效' },
        { label: '可用功能', value: '仪器预约 · 安全工位申请 · 培训课程' },
        { label: '使用说明', value: '请遵守实验平台使用规则与安全规定' }
      ],
      actionText: cs === 3 ? '返回首页' : '',
      actionMode: cs === 3 ? 'home' : ''
    }
  },

  closeNodePop() {
    this.setData({ 'nodePop.show': false })
  },

  // 弹层遮罩拦截滚动
  noop() {},

  _nav(url) {
    wx.navigateTo({
      url,
      fail: () => wx.showToast({ title: '跳转失败，请确认页面已注册', icon: 'none' })
    })
  },

  // 弹层底部动作：进入对应子页继续完善 / 提交审核 / 返回首页
  nodePopAction() {
    const { actionMode } = this.data.nodePop
    this.closeNodePop()
    if (actionMode === 'submit') {
      this.openSubmitReview()
      return
    }
    if (actionMode === 'home') {
      this.goHome()
      return
    }
    if (actionMode === 'upload') {
      this.goUpload()
      return
    }
    const routeMap = {
      register: '/pages/onboarding/register/register',
      exam: '/pages/training/detail/detail?id=5&from=admission'
    }
    const route = routeMap[actionMode]
    if (route) this._nav(route)
  },

  // 第 2 步「上传文件」：先按申请记录 id 查询已提交材料并回填本地暂存，再进入上传页
  async goUpload() {
    await this._syncUploadAttachment()
    this._nav('/pages/onboarding/upload/upload')
  },

  // 读取登记返回的申请记录 id（优先独立缓存，回退登记记录中的 applyId / res.id）
  _applyId() {
    const cached = wx.getStorageSync('admissionApplyId')
    if (cached !== undefined && cached !== null && cached !== '') return cached
    const reg = wx.getStorageSync('admissionRegister')
    if (!reg) return ''
    if (reg.applyId !== undefined && reg.applyId !== null && reg.applyId !== '') return reg.applyId
    if (reg.res && reg.res.id !== undefined && reg.res.id !== null && reg.res.id !== '') return reg.res.id
    return ''
  },

  // 点击「上传文件」时：GET /system/apply_user/detail，按返回数据中的 attachmentList 把已提交材料回填到本地暂存
  async _syncUploadAttachment() {
    const openId = getOpenId()
    if (!openId) {
      console.warn('[onboarding] 未找到 openId，跳过已提交材料查询')
      return
    }
    wx.showLoading({ title: '加载中...', mask: true })
    try {
      const detail = await getApplyUserDetail(openId)
      // 写入跨页缓存，供上传页 _loadUserType 复用，避免 /apply_user/detail 被重复请求
      // _openId 一并写入：shared 版读取时会校验 openId，避免不同用户之间串数据
      wx.setStorageSync(ADMISSION_USER_DETAIL_KEY, Object.assign({}, detail, { _ts: Date.now(), _openId: openId }))
      this._restoreUploadFromAttachments(detail.attachmentList || [])
    } catch (err) {
      console.warn('[onboarding] /system/apply_user/detail 加载附件失败：', err)
    } finally {
      wx.hideLoading()
    }
  },

  // 相对路径补全为完整地址（与上传页保持一致）
  _toFullUrl(url) {
    if (!url) return ''
    if (/^https?:\/\//i.test(url) || url.indexOf('data:') === 0) return url
    return BASE + (url.charAt(0) === '/' ? url : '/' + url)
  },

  // 已提交材料 → 上传页数据结构（按 docType 匹配清单项），合并写入本地暂存供上传页回填
  _restoreUploadFromAttachments(list) {
    if (!list || !list.length) return
    const savedMap = {}
    ;(wx.getStorageSync('admissionUpload') || []).forEach((d) => { savedMap[d.id] = d })
    list.forEach((it) => {
      const docType = it.docType !== undefined ? it.docType
        : (it.doc_type !== undefined ? it.doc_type : (it.type !== undefined ? it.type : ''))
      const doc = DOCS.find((d) => String(d.id) === String(docType))
      if (!doc) return
      const url = it.thumb || it.thumbnail || it.thumbUrl || it.url || it.fileUrl || it.filePath || it.path || it.link || ''
      if (!url) return
      const full = this._toFullUrl(url)
      const prev = savedMap[doc.id] || { photos: [] }
      const photos = (prev.photos || []).map((p) => (typeof p === 'string' ? { thumb: p, origin: p } : p))
      if (!photos.some((p) => (p.origin || p.thumb) === full)) photos.push({ thumb: full, origin: full })
      savedMap[doc.id] = { id: doc.id, name: doc.name, required: doc.required, photos }
    })
    const merged = DOCS.map((d) => {
      const e = savedMap[d.id]
      return { id: d.id, name: d.name, required: d.required, photos: (e && e.photos) || [] }
    })
    wx.setStorageSync('admissionUpload', merged)
  },

  // 点击「安全考试」→ 先进安全培训详情页，学完全部资料后方可参加考试
  goExam() {
    this._nav('/pages/training/detail/detail?id=5&from=admission')
  },

  // 第 2 步「提交审核」：与按钮置灰条件保持一致（attachmentFlag=1 且 hasValid=true 才允许提交）
  openSubmitReview() {
    if (!this.data.canSubmit) {
      this._refreshTaskState()
      const u = this._getUploadState()
      const msg = !u.done ? '请先上传全部必填材料' : '请先完成安全培训学习并通过考试'
      wx.showToast({ title: msg, icon: 'none' })
      return
    }
    this.setData({
      resetModal: {
        show: true,
        mode: 'submit',
        title: '提交审核',
        content: '材料上传与安全考试均已通过校验。提交后将连同审批材料一起交给科室主任及平台管理员审核，是否确认提交？',
        confirmText: '确认提交'
      }
    })
  },

  // 提交审核：调 /system/apply_user/changeState?openId={openId}&state=0，成功后再切换到「等待审核」
  async _confirmSubmitReview() {
    const openId = getOpenId()
    if (!openId) {
      wx.showToast({ title: '未获取到登录信息，请重新登录', icon: 'none' })
      return
    }
    wx.showLoading({ title: '提交中...', mask: true })
    try {
      await changeApplyUserState(openId, 0)
      wx.hideLoading()
      wx.setStorageSync('admissionSubmitTime', this._nowText())
      wx.setStorageSync('admissionStep', 2)
      this.setData({ currentStep: 2 })
      wx.showToast({ title: '已提交审核', icon: 'none' })
      this._refreshSteps()
      // 提交后后端 state 已变：丢弃 detail 跨页缓存，再通知首页 / 「我的」刷新
      clearApplyUserDetailCache()
      getApp().emit('admission:changed', { state: 0 })
    } catch (err) {
      wx.hideLoading()
      console.error('[onboarding] /system/apply_user/changeState 提交失败：', err)
      wx.showToast({ title: (err && err.message) || '提交失败，请重试', icon: 'none' })
    }
  },

  goNextStep() {
    const { currentStep } = this.data
    if (currentStep === 0) {
      this._nav('/pages/onboarding/register/register')
      return
    }
    if (currentStep === 2) {
      wx.showToast({ title: '已提交，等待审核', icon: 'none' })
      return
    }
    if (currentStep === 3) this.goHome()
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  // 演示：模拟管理员审批通过 → 查看准入结果
  goToResult() {
    wx.navigateTo({ url: '/pages/onboarding/result/result?type=admission' })
  },

  // 回到第一步 / 撤回：弹出自绘确认弹窗（系统 wx.showModal 在本环境不弹出，故自绘）
  openResetModal(e) {
    const mode = e.currentTarget.dataset.mode
    const map = {
      restart: {
        title: '返回第一步',
        content: '将回到第一步「申请登记」，已填写的登记信息与上传材料会保留，方便您直接修改，是否继续？',
        confirmText: '返回修改'
      },
      withdraw: {
        title: '确认撤回',
        content: '撤回后需重新提交所有材料，已填写的内容会保留以便修改，是否继续？',
        confirmText: '确认撤回'
      },
      backRegister: {
        title: '回退到申请登记',
        content: '回退后准入状态将解除，需重新走一遍申请流程并再次提交审核。已填写的登记信息与上传材料会保留以便修改，是否继续？',
        confirmText: '确认回退'
      }
    }
    const m = map[mode]
    if (!m) return
    this.setData({ resetModal: { show: true, mode, ...m } })
  },

  closeResetModal() {
    this.setData({ 'resetModal.show': false })
  },

  // 弹窗「确认」：按模式执行（提交审核 / 返回修改 / 撤回）
  confirmReset() {
    const { mode } = this.data.resetModal
    this.closeResetModal()

    if (mode === 'submit') {
      // 提交审核：调 /system/apply_user/changeState?openId={openId}&state=0，成功后进入「等待审核」
      // 接口失败则不更新本地步骤，避免假提交
      this._confirmSubmitReview()
      return
    }

    // restart / backRegister / withdraw：均保留已填写的登记信息与上传材料，回到第一步供修改
    wx.setStorageSync('admissionStep', 0)

    // 直接打开「申请登记」填写页（不经过总览页的步骤说明卡片；storage 保留，表单自动回填）。
    // 状态更新放在跳转之后，避免先渲染出总览页的「申请登记」说明卡片。
    wx.navigateTo({
      url: '/pages/onboarding/register/register',
      success: () => {
        this.setData({ currentStep: 0 })
        this._refreshSteps()
      },
      fail: () => {
        // 页面栈超限等异常：退回总览页第一步并提示用户点击进入
        this.setData({ currentStep: 0 })
        this._refreshSteps()
        wx.showToast({ title: '已回到第一步，点击「开始填写」进入', icon: 'none' })
      }
    })
  }
})
