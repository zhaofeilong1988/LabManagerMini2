// pages/onboarding/exam/exam.js
const { getExamInfoDetail, submitExamRecord } = require('../../../utils/api.js')
const { getOpenId } = require('../../../utils/auth.js')

const QUESTIONS = [
  { q: '进入实验室开展实验前，下列哪项是必须完成的前提？', options: ['通过安全培训与准入考核', '自备实验服即可', '向同学口头报备', '随意进入'], answer: 0 },
  { q: '使用易挥发、有毒有害试剂时，应在哪个区域操作？', options: ['普通实验台上', '通风橱内', '走廊上', '试剂架上'], answer: 1 },
  { q: '发现仪器设备出现异常或故障时，正确的做法是？', options: ['继续使用', '自行拆卸维修', '立即停用并报修', '隐瞒不报'], answer: 2 },
  { q: '实验产生的化学废液应如何处理？', options: ['直接倒入下水道', '分类收集至指定废液桶', '倒入生活垃圾', '暂存于通风橱内'], answer: 1 },
  { q: '实验室内发生火灾，第一时间应如何处置？', options: ['乘坐电梯撤离', '报警后从安全出口撤离', '收拾个人物品', '返回取贵重物品'], answer: 1 }
]

// —— /system/exam_info/detail/{id} 返回结构映射 ——
// data.examInfo    ：考试信息（examName 名称 / examScore 及格分 / examMinute 时长 / examTitleInfo 题量文案）
// data.questionList：题目数组（name 题干 / option1~option6 选项 / realAnswer 正确答案 1 基序号 / examType 题型）

// 题型：1 单选题 / 2 多选题 / 3 判断题 / 4 简答题
const TYPE_TEXT = { 1: '单选题', 2: '多选题', 3: '判断题', 4: '简答题' }

// 选项字段：后端固定返回 option1 ~ option6，空串视为无效选项
const OPTION_KEYS = ['option1', 'option2', 'option3', 'option4', 'option5', 'option6']

// 判断题文字答案归一：对/正确/是/√/T/true → 0；错/错误/否/×/F/false → 1
const TRUE_WORDS = ['对', '正确', '是', '√', 't', 'true', 'yes']
const FALSE_WORDS = ['错', '错误', '否', '×', 'x', 'f', 'false', 'no']

// 单选 / 判断题答案：realAnswer（1 基序号，或 A/B/C 字母，或选项原文）→ options 下标；-1 无解
function resolveSingleAnswer(real, options, srcIndex) {
  const s = String(real == null ? '' : real).trim()
  if (!s) return -1
  if (/^\d+$/.test(s)) {
    const pos = srcIndex.indexOf(Number(s) - 1) // realAnswer 为 1 基序号
    if (pos >= 0) return pos
    const n = Number(s)
    return (n >= 0 && n < options.length) ? n : -1 // 兼容 0 基
  }
  if (/^[A-Za-z]$/.test(s)) {
    const i = s.toUpperCase().charCodeAt(0) - 65
    return (i >= 0 && i < options.length) ? i : -1
  }
  const byText = options.findIndex((o) => o === s)
  if (byText >= 0) return byText
  if (TRUE_WORDS.indexOf(s.toLowerCase()) >= 0) return 0
  if (FALSE_WORDS.indexOf(s.toLowerCase()) >= 0) return options.length > 1 ? 1 : -1
  return -1
}

// 多选答案：realAnswer 为英文逗号分隔的 1 基序号（形如 "1,2" / "1,3,4"）
// 兼容中文逗号、顿号、空格以及 A/B 字母写法
function resolveMultiAnswer(real, srcIndex) {
  const s = String(real == null ? '' : real).trim()
  if (!s) return []
  let parts
  if (/[^0-9A-Za-z]/.test(s)) {
    parts = s.split(/[^0-9A-Za-z]+/).filter((p) => p !== '') // 英文/中文逗号、顿号、空格等
  } else if (s.length > 1 && /^[0-9]+$/.test(s)) {
    parts = s.split('') // 无分隔纯数字："12" → 1、2
  } else {
    parts = [s]
  }
  const idx = []
  parts.forEach((p) => {
    if (/^[A-Za-z]$/.test(p)) {
      const i = p.toUpperCase().charCodeAt(0) - 65
      if (i >= 0 && i < srcIndex.length) idx.push(i)
    } else if (/^\d+$/.test(p)) {
      const pos = srcIndex.indexOf(Number(p) - 1)
      if (pos >= 0) idx.push(pos)
    }
  })
  return Array.from(new Set(idx)).sort((a, b) => a - b)
}

// 单题归一化 → { id, q, type, options:[text], answer:Number|Number[], answerText }
//   · 单选 / 判断：answer 为 options 下标（-1 无解）
//   · 多选：answer 为 options 下标升序数组
//   · 简答：options 为空，answerText 为参考答案
function mapExamQuestion(item) {
  if (!item || typeof item !== 'object') return null
  const q = String(item.name || '').trim()
  if (!q) return null
  const type = Number(item.examType) || 1
  const raw = OPTION_KEYS.map((k) => (item[k] == null ? '' : String(item[k]).trim()))
  const options = []
  const srcIndex = [] // 有效选项在 option1~option6 中的原始位置，用于换算 realAnswer
  raw.forEach((text, i) => {
    if (text !== '') {
      options.push(text)
      srcIndex.push(i)
    }
  })
  const real = item.realAnswer == null ? '' : String(item.realAnswer).trim()
  // 保留题目原 id（提交答卷时作为 examBaseId；空字符串用于本地兜底题库）
  const baseId = (item.id === undefined || item.id === null || item.id === '') ? '' : item.id

  if (type === 4) {
    return { id: baseId, q, type, options: [], answer: -1, answerText: real }
  }
  // 判断题：后端未给选项时兜底「正确 / 错误」
  if (options.length === 0 && type === 3) {
    options.push('正确', '错误')
    srcIndex.push(0, 1)
  }
  if (options.length === 0) return null

  if (type === 2) {
    return { id: baseId, q, type, options, answer: resolveMultiAnswer(real, srcIndex), answerText: '' }
  }
  return { id: baseId, q, type, options, answer: resolveSingleAnswer(real, options, srcIndex), answerText: '' }
}

// 详情返回体归一化 → { title, passScore, minute, titleInfo, questions:[...] }
function normalizeExamDetail(detail) {
  const result = { title: '', passScore: null, minute: null, titleInfo: '', questions: [] }
  if (!detail || typeof detail !== 'object') return result
  const info = detail.examInfo || {}
  result.title = String(info.examName || '').trim()
  result.titleInfo = String(info.examTitleInfo || '').trim()
  const pass = Number(info.examScore)
  if (info.examScore != null && info.examScore !== '' && isFinite(pass)) result.passScore = pass
  const minute = Number(info.examMinute)
  if (info.examMinute != null && info.examMinute !== '' && isFinite(minute) && minute > 0) result.minute = minute
  const list = Array.isArray(detail.questionList) ? detail.questionList : []
  result.questions = list.map(mapExamQuestion).filter(Boolean)
  return result
}

Page({
  data: {
    loading: false,
    examTitle: '安全培训考试',
    total: 5,
    index: 0,
    timer: 1800,
    timerText: '30:00',
    timerWarning: false,
    progressPercent: 20,
    answeredCount: 0,
    currentQuestion: null,
    answers: {}
  },

  onLoad(options) {
    const opts = options || {}
    this._fromTraining = opts.from === 'training'
    // 本地兜底题库：未传 examId 或接口无有效题目时使用
    this._questions = QUESTIONS
    this._examPassScore = 60
    // 考试 id：由培训详情页透传，命中后请求 /system/exam_info/detail/{id} 渲染远程题目
    this._examId = (opts.examId != null && opts.examId !== '') ? String(opts.examId) : ''
    console.log('[exam] onLoad options =', opts, '| examId =', this._examId || '(空，将使用本地题库)')
    // 考试时长以培训详情接口传入的 minute 为准（来自 examMinute，单位：分钟）；
    // 缺省 / 非法值（空串、非数字、≤0）时沿用原默认 30 分钟，避免异常导致计时直接归零
    const minuteRaw = opts.minute
    const minute = Number(minuteRaw)
    const totalSec = (minuteRaw != null && minuteRaw !== '' && isFinite(minute) && minute > 0)
      ? Math.floor(minute * 60)
      : 1800
    this.setData({
      timer: totalSec,
      timerText: this._formatTimer(totalSec),
      timerWarning: totalSec < 300,
      currentQuestion: this._buildQuestion(0)
    })
    this._startTimer()
    if (this._examId) this._loadQuestions(this._examId)
  },

  // 拉取远程考试题目并渲染：GET /system/exam_info/detail/{id}
  _loadQuestions(id) {
    this.setData({ loading: true })
    getExamInfoDetail(id).then((detail) => {
      const parsed = normalizeExamDetail(detail)
      if (!parsed.questions.length) {
        // 接口无有效题目：保留本地兜底题库，不打断考试
        this.setData({ loading: false })
        return
      }
      this._questions = parsed.questions
      if (parsed.passScore != null && isFinite(parsed.passScore)) this._examPassScore = parsed.passScore
      const total = parsed.questions.length
      const patch = {
        loading: false,
        total,
        index: 0,
        answers: {},
        answeredCount: 0,
        progressPercent: Math.round(1 / total * 100),
        currentQuestion: this._buildQuestion(0)
      }
      if (parsed.title) patch.examTitle = parsed.title
      // 考试时长以后端 examMinute 为准（URL 传入时二者一致），仅在接口返回时重置计时
      if (parsed.minute != null) {
        const sec = Math.floor(parsed.minute * 60)
        patch.timer = sec
        patch.timerText = this._formatTimer(sec)
        patch.timerWarning = sec < 300
      }
      this.setData(patch)
      if (parsed.minute != null) this._startTimer()
    }).catch((err) => {
      console.warn('[examInfo] 考试题目加载失败：', err)
      this.setData({ loading: false })
    })
  },

  onUnload() {
    this._stopTimer()
  },

  _buildQuestion(i) {
    const q = (this._questions || QUESTIONS)[i]
    if (!q) return null
    const type = q.type || 1
    const sel = this.data.answers[i]
    const multi = type === 2
    const options = (q.options || []).map((text, idx) => ({
      letter: String.fromCharCode(65 + idx),
      text,
      selected: multi ? (Array.isArray(sel) && sel.indexOf(idx) >= 0) : sel === idx
    }))
    return {
      q: q.q,
      type,
      typeText: TYPE_TEXT[type] || '单选题',
      multi,
      options,
      textAnswer: (type === 4 && typeof sel === 'string') ? sel : ''
    }
  },

  _startTimer() {
    this._stopTimer()
    this._timerHandle = setInterval(() => {
      const timer = this.data.timer - 1
      if (timer <= 0) {
        this._stopTimer()
        this._grade()
        return
      }
      this.setData({ timer, timerText: this._formatTimer(timer), timerWarning: timer < 300 })
    }, 1000)
  },

  // 把秒数格式化为 MM:SS（小于 10 的分秒补 0）；非法值按 0 处理
  _formatTimer(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0))
    const mm = String(Math.floor(s / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    return mm + ':' + ss
  },

  _stopTimer() {
    if (this._timerHandle) {
      clearInterval(this._timerHandle)
      this._timerHandle = null
    }
  },

  // 把作答格式化为接口 studentAnswer 字符串
  //   · 单选 / 判断：选项字母（"A" / "B" / "C"…），选项下标 0→A、1→B 依次类推
  //   · 多选：选项字母按英文逗号拼接（"A,B,C"）
  //   · 简答：原文文本
  _formatStudentAnswer(q, sel) {
    const type = q.type || 1
    if (type === 4) return sel == null ? '' : String(sel)
    const idxList = Array.isArray(sel) ? sel : (sel == null ? [] : [sel])
    return idxList
      .map((i) => {
        const n = Number(i)
        // 下标 → 字母：0→A、1→B…超出 A~Z 范围则丢弃该项
        return (n >= 0 && n < 26) ? String.fromCharCode(65 + n) : ''
      })
      .filter(Boolean)
      .join(',')
  },

  // 组装交卷请求体：{ examRecord, examRecordBaseList }
  // examRecord 取当前登录 openid、远程 examId/examName、准入登记缓存中的姓名/手机号；
  // 性别直接采用登记表口径：0.男 1.女（未填写时传空串）
  _buildSubmitPayload(questions, answers) {
    const register = wx.getStorageSync('admissionRegister') || {}
    const form = register.form || {}
    const sex = (form.sex === 0 || form.sex === 1) ? form.sex : ''
    const list = (questions || []).map((q, i) => ({
      // 题目 id 为数字时按数字提交；空（本地兜底题库）时传空字符串，避免后端按类型强转报错
      examBaseId: (q.id === '' || q.id == null) ? '' : Number(q.id),
      studentAnswer: this._formatStudentAnswer(q, answers[i])
    }))
    return {
      examRecord: {
        openId: getOpenId() || '',
        examId: this._examId || '',
        examName: this.data.examTitle || '',
        studentId: '',
        studentName: (form.name || '').trim(),
        sex,
        phone: (form.phone || '').trim()
      },
      examRecordBaseList: list
    }
  },

  // 调 /system/exam_record/submit：接口失败不影响本地判卷流程
  async _submitExamRecord(questions, answers) {
    const payload = this._buildSubmitPayload(questions, answers)
    console.log('[exam] POST /system/exam_record/submit payload =', JSON.stringify(payload))
    return await submitExamRecord(payload)
  },

  _renderQuestion() {
    const { index, total, answers } = this.data
    this.setData({
      currentQuestion: this._buildQuestion(index),
      progressPercent: Math.round((index + 1) / total * 100),
      answeredCount: Object.keys(answers).length
    })
  },

  selectOption(e) {
    const optIdx = e.currentTarget.dataset.index
    const item = (this._questions || QUESTIONS)[this.data.index]
    const type = (item && item.type) || 1
    const key = this.data.index
    const answers = { ...this.data.answers }
    if (type === 2) {
      // 多选：点击切换选中，允许多选
      const cur = Array.isArray(answers[key]) ? answers[key].slice() : []
      const pos = cur.indexOf(optIdx)
      if (pos >= 0) cur.splice(pos, 1)
      else cur.push(optIdx)
      if (cur.length) answers[key] = cur.sort((a, b) => a - b)
      else delete answers[key]
    } else {
      answers[key] = optIdx
    }
    this.setData({ answers })
    this._renderQuestion()
  },

  // 简答题输入：内容非空则记入作答，实时更新已答数
  onShortAnswerInput(e) {
    const val = e.detail.value
    const key = this.data.index
    const answers = { ...this.data.answers }
    if (val != null && String(val).trim() !== '') answers[key] = val
    else delete answers[key]
    this.setData({ answers, answeredCount: Object.keys(answers).length })
  },

  nextQuestion() {
    if (this.data.index < this.data.total - 1) {
      this.setData({ index: this.data.index + 1 })
      this._renderQuestion()
    }
  },

  prevQuestion() {
    if (this.data.index > 0) {
      this.setData({ index: this.data.index - 1 })
      this._renderQuestion()
    }
  },

  _nowText() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  },

  submitExam() {
    const total = this.data.total
    const done = Object.keys(this.data.answers).length
    const undone = total - done
    wx.showModal({
      title: '确认交卷',
      content: `已完成 ${done} 题，未完成 ${undone} 题，确实要提交吗？`,
      confirmText: '确认交卷',
      cancelText: '继续答题',
      confirmColor: '#33ADDE',
      success: (res) => {
        if (res.confirm) this._grade()
      }
    })
  },

  // 单题判分：按题型分别比较
  _isCorrect(q, sel) {
    const type = q.type || 1
    if (type === 4) {
      // 简答题：有参考答案时忽略空白做全等比较，否则答了即算对
      const std = q.answerText
      if (!std) return typeof sel === 'string' && sel.trim() !== ''
      return String(sel || '').replace(/\s+/g, '') === String(std).replace(/\s+/g, '')
    }
    if (type === 2) {
      const ans = Array.isArray(q.answer) ? q.answer : []
      if (!Array.isArray(sel) || sel.length === 0 || ans.length === 0) return false
      if (sel.length !== ans.length) return false
      const picked = sel.slice().sort((a, b) => a - b)
      for (let i = 0; i < ans.length; i++) {
        if (picked[i] !== ans[i]) return false
      }
      return true
    }
    return sel != null && q.answer >= 0 && sel === q.answer
  },

  async _grade() {
    this._stopTimer()
    const questions = this._questions || QUESTIONS
    const total = questions.length || 1
    const answers = this.data.answers
    // 是否含简答题：含则无法本地出分，交卷后进入「判卷中」（需人工批阅）
    const hasShortAnswer = questions.some((q) => (q.type || 1) === 4)

    // 交卷时先调后端接口提交答卷，失败不影响本地判卷
    wx.showLoading({ title: '交卷中…', mask: true })
    try {
      await this._submitExamRecord(questions, answers)
    } catch (err) {
      console.warn('[exam] 考试答卷提交失败（不影响本地判卷）：', err)
      wx.showToast({ title: '网络异常，成绩仅本地保存', icon: 'none' })
    }
    wx.hideLoading()

    if (hasShortAnswer) {
      const pending = {
        score: null,
        correct: null,
        total,
        passed: null,
        status: 'grading',
        time: this._nowText()
      }
      // 持久化判卷中状态：供准入总览「点击安全考试节点」查看
      wx.setStorageSync('admissionExam', pending)
      if (this._fromTraining) wx.setStorageSync('safetyTrainingExam', pending)
      wx.showToast({ title: '交卷成功，判卷中…', icon: 'none', duration: 2000 })
      if (this._fromTraining) {
        // 培训学习入口：返回培训详情页等待批阅结果
        setTimeout(() => wx.navigateBack({ delta: 1 }), 800)
        return
      }
      wx.redirectTo({
        url: `/pages/onboarding/result/result?type=exam&status=grading&total=${total}`
      })
      return
    }

    // 不含简答题：本地直接判分并给出成绩
    let correct = 0
    questions.forEach((q, i) => {
      if (this._isCorrect(q, answers[i])) correct++
    })
    // 百分制：按答对题数占比折算，兼容本地 5 题（每题 20 分）与远程任意题量
    const score = Math.round(correct / total * 100)
    const passScore = (this._examPassScore != null && isFinite(this._examPassScore)) ? this._examPassScore : 60
    const record = {
      score,
      correct,
      total,
      passed: score >= passScore,
      status: 'done',
      time: this._nowText()
    }
    // 持久化考试成绩：供准入总览「点击安全考试节点」查看
    wx.setStorageSync('admissionExam', record)
    if (this._fromTraining) {
      // 培训学习入口：与准入安全考试为同一场，结果写入培训记录并返回详情页
      wx.setStorageSync('safetyTrainingExam', record)
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.redirectTo({
      url: `/pages/onboarding/result/result?type=exam&score=${score}&correct=${correct}&total=${total}`
    })
  }
})
