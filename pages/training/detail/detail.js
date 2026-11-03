// pages/training/detail/detail.js
const { getSafetyTrainingDetail, getDictData, BASE } = require('../../../utils/api.js')

// ── 培训学习资料在线阅读配置 ──────────────────────────────
// 学习资料以「在线阅读」方式打开：wx.downloadFile 拉取 PDF → wx.openDocument 调起微信内置阅读器。
// 正式环境：将 DOC_BASE 替换为实际部署培训文档的 HTTPS 静态资源目录，
// 并保证下方 docs 中各 file 字段对应的文件可直接访问（如 …/training/docs/instrument-booking-manual-v1.16.pdf）。
// 开发者工具调试时，需在「详情 → 本地设置」勾选"不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书"。
const DOC_BASE = 'https://your-domain.example.com/lab/training/docs'

// ── 视频播放地址是否「直连原始地址」（不走后端 /file/download 转发）──────────────
// 现状：后端 /file/download 已支持 HTTP Range（带 Range 请求返回 206 + Content-Range），
//   走转发接口的远程流即可被播放器任意拖动定位，保持 false 即可正常定位。
// 若希望省去一层转发（降低后端带宽 / 延迟），且 videoList 里的 url 本身可直接访问
//   （如 COS/OSS 公网地址、后端静态文件地址），可改为 true —— 对象存储默认也支持 Range。
// 注意：正式环境若原始地址不可直连（需鉴权/未配置合法域名），请保持 false。
const VIDEO_PLAY_DIRECT = false

// 解析资料的可访问地址：与视频一致，走后端 /file/download?url=<原始地址> 转发下载；
// 原始地址需 URL 编码。若已是带 /file/download?url= 的完整地址则原样返回，避免重复包装。
function docUrl(doc) {
  if (!doc) return ''
  const raw = doc.url || (doc.file ? DOC_BASE.replace(/\/+$/, '') + '/' + doc.file : '')
  if (!raw) return ''
  if (/file\/download\?url=/.test(raw)) return raw
  return BASE.replace(/\/+$/, '') + '/file/download?url=' + encodeURIComponent(raw)
}

// 培训类别（training_type 字典的 dictLabel）→ 头部标签 CSS 类型映射
const TAG_TYPE_BY_LABEL = {
  '安全培训': 'safety',
  '专项培训': 'special',
  '计划培训': 'plan'
}

const DETAILS = {
  1: {
    title: '流式细胞仪专项培训',
    categoryText: '专项培训',
    tagType: 'special',
    instrument: 'BD FACSCanto II',
    status: 'open',
    statusText: '可报名',
    date: '2026-06-20 14:00',
    enrolledText: '6/10 人',
    description: '面向已取得准入资格用户开设的流式细胞仪专项培训，系统讲解 BD FACSCanto II 的原理与构造、开机与质控校准、样本制备流程以及日常上机操作规范。完成学习并通过考核后即可预约该仪器。',
    docs: [
      { name: 'BD FACSCanto II 上机操作指南.pdf', size: '4.2 MB' },
      { name: '流式细胞仪日常维护规范.pdf', size: '1.9 MB' }
    ],
    videos: [
      { name: '流式细胞仪开机与质控演示', duration: '08:42' }
    ],
    hasOnlineExam: false,
    examText: '本次培训考核由实验室统一组织线下实操考核，请留意站内通知，考核通过后颁发专项培训证书。'
  },
  2: {
    title: '激光共聚焦显微镜操作',
    categoryText: '计划培训',
    tagType: 'plan',
    instrument: 'Zeiss LSM 900',
    status: 'enrolled',
    statusText: '已报名',
    date: '2026-06-25 09:00',
    enrolledText: '8/8 人',
    description: '面向神经影像方向研究生的激光共聚焦显微镜操作培训，讲解 Zeiss LSM 900 的基本原理、样品制备、多通道荧光采集参数与三维重建方法，帮助用户独立完成常规共聚焦成像实验。',
    docs: [
      { name: 'Zeiss LSM 900 操作手册.pdf', size: '6.1 MB' },
      { name: '多通道荧光采集参数设置指南.pdf', size: '2.4 MB' }
    ],
    videos: [
      { name: '共聚焦显微镜上机演示', duration: '12:30' }
    ],
    hasOnlineExam: false,
    examText: '本次培训考核由带教老师统一组织实操考核，请按培训通知准时参加。'
  },
  3: {
    title: '透射电子显微镜培训',
    categoryText: '专项培训',
    tagType: 'special',
    instrument: 'FEI Tecnai G2',
    status: 'full',
    statusText: '名额已满',
    date: '2026-07-05 10:00',
    enrolledText: '12/12 人',
    description: '透射电子显微镜操作进阶培训，覆盖 FEI Tecnai G2 的制样流程、装载与观察操作、常用模式切换及数据记录规范。',
    docs: [
      { name: 'FEI Tecnai G2 安全操作须知.pdf', size: '1.5 MB' }
    ],
    videos: [],
    hasOnlineExam: false,
    examText: '该场培训名额已满，考核安排请留意后续场次通知。'
  },
  4: {
    title: '实验室安全规范培训',
    categoryText: '安全培训',
    tagType: 'safety',
    instrument: '全平台通用',
    status: 'ended',
    statusText: '已结束',
    date: '2026-05-01 09:00',
    enrolledText: '30/30 人',
    description: '面向全体用户的实验室安全规范培训，涵盖实验室准入制度、危化品管理、应急处置等内容，帮助用户树立安全操作意识。',
    docs: [
      { name: '仪器预约小程序操作手册 V1.16 - 使用者篇.pdf', size: '3.8 MB', file: 'instrument-booking-manual-v1.16.pdf' },
      { name: '实验室准入安全手册.pdf', size: '5.6 MB' }
    ],
    videos: [],
    hasOnlineExam: false,
    examText: '该场培训已结束，暂不可参加考试，请关注新一期的安全培训场次。'
  },
  5: {
    title: '安全培训',
    categoryText: '安全培训',
    tagType: 'safety',
    instrument: '实验室安全规范 · 全平台通用',
    status: 'open',
    statusText: '可报名',
    date: '2026-09-10 14:00',
    unlimited: true,
    description: '面向全体实验室用户的基础安全培训，内容涵盖实验室安全管理制度、危险化学品使用规范、仪器设备操作安全及常见事故应急处置流程。完成本培训并通过考核，是获得平台准入资格的必要条件。',
    docs: [
      { name: '仪器预约小程序操作手册 V1.16 - 使用者篇.pdf', size: '3.8 MB', file: 'instrument-booking-manual-v1.16.pdf' },
      { name: '实验室准入安全手册.pdf', size: '5.6 MB' },
      { name: '危险化学品安全使用规范.pdf', size: '3.4 MB' }
    ],
    videos: [
      { name: '实验室安全规范操作演示视频', duration: '06:30' }
    ],
    hasOnlineExam: true,
    exam: {
      title: '安全培训考试',
      duration: '30 分钟',
      questions: 5,
      eachScore: 20,
      passLine: '60 分'
    },
    examNote: '本场考试与平台准入环节的安全考试为同一场考试，成绩互通；考试通过即视为完成准入安全考核，可获得安全培训证书。'
  }
}

Page({
  data: {
    training: null,
    admissionMode: false,
    canExam: false,
    examCtaHint: '',
    examRecord: null,
    typeDict: [],
    // 倍速可选项：VideoContext.playbackRate 官方仅支持这些档位
    // （0.5/0.8/1.0/1.25/1.5 自基础库 1.4.0，2.0 自 2.6.3）
    rateOptions: [
      { rate: 0.5, text: '0.5x' },
      { rate: 0.8, text: '0.8x' },
      { rate: 1.0, text: '1.0x' },
      { rate: 1.25, text: '1.25x' },
      { rate: 1.5, text: '1.5x' },
      { rate: 2.0, text: '2.0x' }
    ],
    // 内嵌播放器：仅在播放器超出可视区域时微调滚动位置（scroll-view 的 scroll-top）
    scrollTop: 0,
    // 自定义导航栏尺寸（本页 navigationStyle=custom）：
    // 状态栏高度 + 44px 导航条 = 内容需要避让的总高度（onLoad 里按真机重新计算）
    statusBarHeight: 20,
    navBarHeight: 44,
    navTotalHeight: 64,
    // 内嵌视频播放器状态（就地展开在被点击的视频卡片内，非弹框、非顶部固定区）
    videoPlayer: {
      visible: false,
      // 正在播放的视频在 training.videos 中的下标（-1 表示无）
      activeIndex: -1,
      src: '',
      name: '',
      sessionText: '00:00',
      initialTime: 0,
      // 自定义控件：playing / currentText / durationText / playedPercent / controlsVisible
      playing: false,
      currentTime: 0,
      duration: 0,
      currentText: '00:00',
      durationText: '00:00',
      playedPercent: 0,
      controlsVisible: true,
      // 全屏状态：用于调整自定义控件在全屏下的样式
      fullscreen: false,
      // 非空时在舞台中央显示加载提示（拖动定位兜底：转本地文件播放时使用）
      loadingText: '',
      // 正在「切换视频源（远程 → 本地文件）并定位」的过渡态：
      // 期间用遮罩盖住舞台，避免用户看到「回到原点 → 闪一下暂停 → 再跳到目标」的中间画面
      switching: false,
      // ── 画面手势定位（在画面上左右拖动快进 / 快退，不必非得拖时间轴）──────────
      // 拖动中只做「预览」（更新时间 / 进度条 + 显示提示），松手后才真正 seek，
      // 避免远程流被高频 seek 导致卡顿。
      swipeSeeking: false,     // 是否正在「画面拖动定位」
      swipeDeltaText: '',      // 拖动中的增量文案，如「快进 +45s」/「快退 30s」
      swipeForward: true,      // 增量方向（true = 快进），用于提示样式
      // ── 倍速播放 ─────────────────────────────────────────────────────────
      // <video> 没有倍速属性，只能通过 VideoContext.playbackRate() 下发；
      // rate 记录在 data 里用于选项高亮，真正的下发值存在 _rate（跨视频保留用户选择）。
      rate: 1,                 // 当前倍速（1 = 正常速度）
      rateText: '1.0x',        // 按钮上显示的倍速文案
      rateVisible: false       // 倍速选项条是否展开
    }
  },

  // 远程获取的安全培训详情（含 trainingInfo / docList / videoList）
  _remoteDetail: null,
  // 视频播放会话：当前视频名 / 上一帧时间 / 内存累积缓冲 / 上次落盘时间
  _currentVideoName: '',
  _lastVideoTime: null,
  _watchBuffer: null,
  _lastFlush: 0,
  // 断点续播：上次保存位置的时间戳 / 最近一次落盘的位置（用于节流去重）
  _lastPositionSave: 0,
  _lastSavedPosition: 0,
  // 断点续播兜底：本次打开视频后是否已主动 seek 过初始位置（避免暂停恢复时再 seek）
  _hasInitialSeek: false,
  // 断点续播关键状态：seek 还未完成时为 true，期间禁止任何 position 写入 storage，
  // 否则 autoplay 的 currentTime=0 帧会在 timeupdate 中把上次保存的位置覆盖成 0。
  _seekPending: false,
  // 自定义控件：自动隐藏定时器 / 用户是否正在拖动进度条
  _hideControlsTimer: null,
  _isSeeking: false,
  // 画面手势定位：本次拖动的会话状态 / 上一次手势结束时间（用于吞掉随后的误触 tap）
  _swipe: null,
  _swipeEndAt: 0,
  // 本次触摸的起点与是否发生过明显位移：用于区分「轻点画面（切换控件显隐）」与「拖动（快进/快退）」
  _tap: null,
  // 上一次切换控件显隐的时间：给「touchend + tap」两条触发路径去抖，保证一次轻点只切换一次
  _lastToggleAt: 0,
  // 倍速：用户当前选择的播放速率（跨视频保留，换视频后由 _applyRate 重新下发）
  _rate: 1,
  // 拖动期间显示的"预览位置"，松开后用真实 currentTime 同步回
  _seekPreview: -1,
  // 最近一次手动定位的目标位置 + 发起时间：播放器跳到目标前会继续上报旧位置（常见是 0），
  // 用它在这个短窗口内把旧上报丢掉，避免进度条/时间被"拉回起点"
  _seekTarget: null,
  _seekTargetAt: 0,
  // 上一次真正下发 seek 的目标 + 时间：用于给「touchend + tap」的重复点击去重
  _lastSeekTarget: null,
  _lastSeekAt: 0,
  // ── 拖动定位兜底：视频转「本地文件」播放（历史遗留，现已不再触发）──────────
  // 后端 /file/download 已支持 HTTP Range（206），远程流可直接拖动定位，
  // 这套「下载本地文件再播放」的兜底已无触发路径，仅保留状态字段与清理逻辑。
  _seekWatchdog: null,            // 定位确认定时器：超时未跳到目标即判定为「不支持拖动定位」
  _seekWatchdogTarget: null,      // 定时器等待确认的目标秒数
  _localCacheMap: null,           // src → 已下载好的本地临时文件路径（页面级缓存，重开同一视频免二次下载）
  _localPath: '',                 // 当前播放视频对应的本地文件路径（未就绪时为空）
  _localPathFor: '',              // 上面这个本地文件对应的原始播放地址
  _localDownloading: false,       // 是否正在下载
  _localAttempted: false,         // 本次打开视频是否已尝试过下载（失败后不重复尝试，避免反复弹加载）
  _localTask: null,               // wx.downloadFile 返回的任务（关闭播放器时用于 abort）
  _pendingLocalTarget: null,      // 下载期间用户已点击的目标位置（下载完成后直接定位到这里）
  _localSeekAfterLoad: null,      // 切换到本地文件后待执行的定位（本地文件忽略 initial-time 时的兜底）
  _switchTimer: null,             // 「切换视频源」过渡态的兜底解除定时器（防止遮罩永久不消失）
  _seekPendingTimer: null,        // 「定位等待」兜底解除定时器（防止位置永不落盘）
  _playPos: 0,                    // 本次打开视频的续播位置（加载完成后据此定位）
  _usingRemote: false,            // 当前播放源是否为远程流（本地文件下载失败时的退回方案）
  // ── 断点续播（关闭再打开时回到关闭前的位置）────────────────────────────
  _resumeTarget: null,            // 本次打开要续播到的秒数（非空表示「续播定位尚未落地」）
  _resumeTries: 0,                // 已下发次数（用于有限重试）
  _resumeTimer: null,             // 重试定时器
  // 进度条宽度缓存（用于点击/拖动时计算目标秒数）
  _trackWidthCache: 0,
  // Track 几何信息缓存（left/right/width），用于触摸坐标换算：
  // 通过 pageX - trackRect.left 得到精确的 localX，避免 t.x 在某些场景下为 0/无效 导致视频回到开始位置
  _trackRect: null,
  // 本次打开后的累计观看（用于播放覆盖层显示）
  _sessionSeconds: 0,

  onLoad(options) {
    this._initNavSize()
    this._id = Number(options && options.id) || 5
    // from=admission：由平台准入「材料提交 → 安全考试」进入，完成学习即可考试（无需先在培训模块报名）
    this._fromAdmission = !!(options && options.from === 'admission')
    // id === 5：先加载远程安全培训详情与 training_type 字典，再渲染页面
    if (this._id === 5) {
      this._loadSafetyDetail()
    } else {
      this._refresh()
    }
  },

  // 加载远程安全培训详情 + training_type 字典
  async _loadSafetyDetail() {
    try {
      const [detail, typeDict] = await Promise.all([
        getSafetyTrainingDetail().catch(err => {
          console.warn('[safetyDetail] 接口请求失败：', err)
          return null
        }),
        getDictData('training_type').catch(err => {
          console.warn('[dict] training_type 字典获取失败：', err)
          return []
        })
      ])
      this._remoteDetail = detail
      this.setData({ typeDict: typeDict || [] })
    } catch (err) {
      console.warn('[safetyDetail] 加载异常：', err)
    }
    this._refresh()
  },

  // 根据 training_type 字典把数字 type 转成 categoryText + tagType
  _resolveCategory(typeValue) {
    const dict = this.data.typeDict || []
    const matched = dict.find(d => String(d.dictValue) === String(typeValue))
    const label = matched ? matched.dictLabel : '安全培训'
    return {
      categoryText: label,
      tagType: TAG_TYPE_BY_LABEL[label] || 'safety'
    }
  },

  // 把 ISO 时间字符串截到分钟：YYYY-MM-DD HH:mm
  _formatStartTime(s) {
    if (!s) return ''
    return String(s).replace(/T/, ' ').substring(0, 16)
  },

  // 把后端 trainingInfo 上的考试字段映射为页面渲染用的 exam 对象。
  // 入参：info = 接口返回的 trainingInfo（可能包含 examName/examMinute/examTitleInfo/examScore），
  //       fallback = 本地兜底 exam（兼容历史培训数据，新接口缺字段时不会渲染空白）。
  // 返回：{ title, duration, questions, passLine }
  //   · title     ← info.examName（String）
  //   · duration  ← info.examMinute（Integer，分钟），自动追加「 分钟」单位
  //   · questions ← info.examTitleInfo（String，由后端决定「5」或「5 道」等文案，原样展示）
  //   · passLine  ← info.examScore（BigDecimal），Number 化后去除无意义的尾随零再追加「 分」
  _buildExamFromInfo(info, fallback) {
    const pickStr = (v, alt) => (v != null && v !== '') ? String(v) : (alt != null && alt !== '' ? String(alt) : '')
    const minute = info && info.examMinute
    const titleInfo = info && info.examTitleInfo
    const score = info && info.examScore
    // BigDecimal 可能以 number / 数字字符串两种形式到达：先 Number 化，去掉尾随零（如 "60.0" → "60"）
    let passLine = ''
    if (score != null && score !== '') {
      const num = Number(score)
      passLine = (isFinite(num) ? num.toString() : String(score)) + ' 分'
    } else if (fallback && fallback.passLine) {
      passLine = fallback.passLine
    }
    let duration = ''
    if (minute != null && minute !== '') {
      const num = Number(minute)
      duration = (isFinite(num) ? num.toString() : String(minute)) + ' 分钟'
    } else if (fallback && fallback.duration) {
      duration = fallback.duration
    }
    return {
      title: pickStr(info && info.examName, fallback && fallback.title),
      duration,
      questions: pickStr(titleInfo, fallback && fallback.questions),
      passLine
    }
  },

  // 把考试记录归一为页面渲染结构（远程 ExamRecord / 本地缓存记录通用）：
  //   state：0 已交卷待评卷 / 1 考试通过 / 2 考试未通过
  //   空对象 / null / 数组视为「尚未考过」，返回 null（页面不渲染该区块）
  _buildExamRecord(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (!Object.keys(raw).length) return null
    let state = Number(raw.state)
    if (!(state === 0 || state === 1 || state === 2)) {
      // 本地缓存记录（safetyTrainingExam）无 state 字段，按 status / passed 推导
      if (raw.status === 'grading') state = 0
      else if (raw.passed === true) state = 1
      else if (raw.passed === false) state = 2
      else return null
    }
    const STATE_TEXT = { 0: '已交卷，待评卷', 1: '考试通过', 2: '考试未通过' }
    const STATE_TYPE = { 0: 'pending', 1: 'passed', 2: 'failed' }
    // 待评卷（state=0）不出分；其余状态有分数才展示
    const scoreNum = Number(raw.score)
    const hasScore = state !== 0 && raw.score != null && raw.score !== '' && isFinite(scoreNum)
    return {
      state,
      stateText: STATE_TEXT[state],
      stateType: STATE_TYPE[state],
      scoreText: hasScore ? (scoreNum + ' 分') : '',
      time: this._formatStartTime(raw.createTime || raw.time) || ''
    }
  },

  // 把接口返回的 docList 单项映射为页面结构
  _mapDoc(d, idx) {
    if (!d) return null
    const url = d.url || ''
    let name = (d.name || '').toString().trim()
    if (!name && url) {
      const last = url.split('/').pop() || ''
      const cleaned = last.split('?')[0].split('#')[0]
      try { name = decodeURIComponent(cleaned) } catch (e) { name = cleaned }
    }
    if (!name) name = '学习资料' + (idx + 1)
    return {
      id: d.id != null ? d.id : idx,
      name,
      url,
      size: d.size || '',
      state: d.state,
      learned: false
    }
  },

  // 把接口返回的 videoList 单项映射为页面结构
  _mapVideo(v, idx) {
    if (!v) return null
    const url = v.url || ''
    // 优先使用接口返回的 name；缺失时从 URL 末段提取并解码（处理查询串与中文编码）
    let name = (v.name || '').toString().trim()
    if (!name && url) {
      const last = url.split('/').pop() || ''
      const cleaned = last.split('?')[0].split('#')[0]
      try { name = decodeURIComponent(cleaned) } catch (e) { name = cleaned }
    }
    if (!name) name = '学习视频' + (idx + 1)
    return {
      id: v.id != null ? v.id : idx,
      name,
      url,
      // 可直接访问（走后端转发）的地址：卡片封面用它渲染「视频首帧」，点击播放时也用它
      src: this._resolveVideoUrl(v),
      duration: v.duration || '',
      state: v.state,
      learned: false
    }
  },

  onShow() {
    // 重新展示时若仍处于全屏，恢复手机姿态监听
    //（原先这里有两个 onShow，对象字面量后写覆盖先写，此逻辑一直没执行，现合并进来）
    if (this.data.videoPlayer.fullscreen) this._startOrientationWatch()
    // 首次 onShow 只做本地刷新；之后每次返回本页（如从考试页交卷回来）
    // 都重新拉取远程安全培训详情，让最新考试记录（ExamRecord）及时刷新
    if (this._shownOnce) {
      if (this._id === 5) {
        this._loadSafetyDetail()
        return
      }
    } else {
      this._shownOnce = true
    }
    if (this._id) this._refresh()
  },

  _learnKey() {
    return 'trainingLearn_' + this._id
  },

  // 根据当前报名 / 学习 / 考试状态刷新页面
  _refresh() {
    const local = DETAILS[this._id] || DETAILS[5]
    const fromAdmission = this._fromAdmission && this._id === 5

    // id === 5：优先用远程 /system/training_info/safetyDetail 数据，失败时回退到本地 DETAILS[5]
    let base
    if (this._id === 5 && this._remoteDetail && this._remoteDetail.trainingInfo) {
      const info = this._remoteDetail.trainingInfo
      const stateMap = { 1: 'open', 2: 'ended' }
      const status = stateMap[info.state] || 'open'
      const statusText = status === 'open' ? '可报名' : (status === 'ended' ? '已结束' : '可报名')
      const { categoryText, tagType } = this._resolveCategory(info.type)
      const docList = (this._remoteDetail.docList || []).map((d, i) => this._mapDoc(d, i)).filter(Boolean)
      const videoList = (this._remoteDetail.videoList || []).map((v, i) => this._mapVideo(v, i)).filter(Boolean)
      // maxCount > 10000 视为「人数不限」，否则按 signUp/maxCount 显示
      const isUnlimited = info.maxCount != null && Number(info.maxCount) > 10000
      let enrolledText = ''
      if (!isUnlimited && info.signUp != null && info.maxCount != null) {
        enrolledText = info.signUp + '/' + info.maxCount + ' 人'
      } else if (isUnlimited && info.signUp != null) {
        enrolledText = info.signUp + ' 人已报名'
      }
      base = {
        title: info.name || local.title,
        categoryText,
        tagType,
        instrument: info.scene || local.instrument,
        status,
        statusText,
        date: this._formatStartTime(info.endTime) || local.date,
        unlimited: isUnlimited,
        enrolledText,
        description: info.detail || info.info || local.description,
        info: info.info || '',
        docs: docList,
        videos: videoList,
        hasOnlineExam: info.exam === 1,
        // 考试信息取自后端新接口字段：examName（考试名称，String）/ examMinute（考试时长，分钟，Integer）/
        // examTitleInfo（题目数量，String）/ examScore（及格分数，BigDecimal）。
        // 缺字段时回退到本地默认 exam（兼容历史培训数据）。
        exam: this._buildExamFromInfo(info, local.exam || {}),
        examNote: info.examInfo || local.examNote
      }
    } else {
      base = local
    }

    const enrolled = this._id === 5 && wx.getStorageSync('safetyTrainingEnrolled') === true
    const status = enrolled ? 'enrolled' : base.status
    const learnMap = wx.getStorageSync(this._learnKey()) || {}
    const watchedMap = this._getWatchedMap()

    const docs = (base.docs || []).map(d => ({
      ...d,
      learned: (learnMap.docs || []).indexOf(d.name) >= 0
    }))
    const videos = (base.videos || []).map(v => {
      // 总时长口径必须与「封顶已观看时长 / 判定已学完」完全一致，统一走 _videoTotalSeconds：
      // 它优先用播放器上报过的真实时长，其次才是接口元数据 —— 只信元数据会出现
      // 「视频已播完（已观看 = 真实时长）但状态仍是学习中」。
      const durSec = this._videoTotalSeconds(v.name, watchedMap)
      const watchedRaw = (watchedMap[v.name] && watchedMap[v.name].seconds) || 0
      // 已观看时长不超过视频总时长：重复观看会不断累加，这里统一截断，
      // 保证界面上永远是「已观看 ≤ 总时长」（总时长未知时不截断）
      const watched = durSec > 0 ? Math.min(watchedRaw, durSec) : watchedRaw
      // 有时长时计算观看百分比（0~100）；无时长则进度条/百分比不渲染
      const progress = durSec > 0 ? Math.min(100, Math.round((watched / durSec) * 100)) : 0
      // 总时长文本：有 durSec 用统一 MM:SS 格式，否则保留原始字符串（如 "未知"）
      const durationText = durSec > 0 ? this._formatSeconds(durSec) : (v.duration || '')
      // 学习状态：未观看 = 未学习；观看时长达到总时长 95% = 已学完；其余 = 学习中。
      // 总时长未知时无法判断完成度，只要有观看时长就按「学习中」处理，不误判成已学完。
      const finished = durSec > 0 && watched / durSec >= 0.95
      const statusType = finished ? 'done' : (watched > 0 ? 'doing' : 'none')
      const statusText = finished ? '已学完' : (watched > 0 ? '学习中' : '未学习')
      return {
        ...v,
        learned: (learnMap.videos || []).indexOf(v.name) >= 0,
        watchedSeconds: watched,
        watchedText: this._formatSeconds(watched),
        durationText,
        progress,
        progressPercentText: durSec > 0 ? (progress + '%') : '',
        finished,
        statusType,
        statusText
      }
    })
    const learned = docs.every(d => d.learned) && videos.every(v => v.learned)

    // 准入入口进入安全培训：完成学习即可考试，无需先在培训模块报名
    let statusText = base.statusText
    if (enrolled) statusText = '已报名'
    else if (fromAdmission) statusText = learned ? '可参加考试' : '学习中'

    const training = {
      ...base,
      status,
      statusText,
      docs,
      videos,
      learnedDocs: docs.filter(d => d.learned).length,
      learnedVideos: videos.filter(v => v.learned).length
    }

    let canExam = false
    let examCtaHint = ''
    if (status === 'full') {
      examCtaHint = '该培训名额已满，无法参加考试'
    } else if (status === 'ended') {
      examCtaHint = '该培训已结束，无法参加考试'
    } else if (!base.hasOnlineExam) {
      examCtaHint = '该培训考核由实验室统一组织，暂不支持在线考试'
    } else if (fromAdmission) {
      // 准入安全考试：先学完全部资料与视频才可开考
      if (!learned) examCtaHint = '请先完成上方全部学习资料与视频，方可参加准入安全考试'
      else canExam = true
    } else if (status === 'open') {
      examCtaHint = '请先报名，报名成功后方可参加考试'
    } else if (!learned) {
      examCtaHint = '请先完成全部学习资料与视频，即可参加考试'
    } else {
      canExam = true
    }

    // 最新考试记录：安全培训（id=5）优先取远程详情的 ExamRecord（空 = 尚未考过），
    // 远程详情未加载（接口失败）时回退本地缓存记录；其余培训不展示
    let examRecord = null
    if (this._id === 5) {
      if (this._remoteDetail) {
        examRecord = this._buildExamRecord(this._remoteDetail.ExamRecord || this._remoteDetail.examRecord)
      } else {
        examRecord = this._buildExamRecord(wx.getStorageSync('safetyTrainingExam'))
      }
    }

    this.setData({
      admissionMode: fromAdmission,
      training,
      canExam,
      examCtaHint,
      examRecord
    })
  },

  // 标记单个资料 / 视频为已学习
  _markLearned(type, name) {
    if (!this.data.training) return
    const training = this.data.training
    // 已经标记过（已看完 / 已学过）的条目：不再重复弹提示
    // （重复点开已看完的视频时不再提示"已看完该视频"），其余逻辑保持不变
    const current = (training[type] || []).filter(it => it.name === name)[0]
    const alreadyLearned = !!(current && current.learned)
    const list = training[type].map(it =>
      it.name === name ? { ...it, learned: true } : it
    )
    const learnMap = wx.getStorageSync(this._learnKey()) || {}
    learnMap[type] = learnMap[type] || []
    if (learnMap[type].indexOf(name) === -1) learnMap[type].push(name)
    wx.setStorageSync(this._learnKey(), learnMap)

    const next = {
      ...training,
      [type]: list,
      learnedDocs: type === 'docs' ? list.filter(d => d.learned).length : training.learnedDocs,
      learnedVideos: type === 'videos' ? list.filter(v => v.learned).length : training.learnedVideos
    }
    this.setData({ training: next })

    // 学习全部完成后自动解锁考试按钮（准入入口无需报名；模块入口需已报名）
    const learned = next.docs.every(d => d.learned) && next.videos.every(v => v.learned)
    if (learned && next.hasOnlineExam && (next.status === 'enrolled' || this.data.admissionMode)) {
      const extra = this.data.admissionMode ? { 'training.statusText': '可参加考试' } : {}
      this.setData({ canExam: true, examCtaHint: '', ...extra })
    }
    if (alreadyLearned) return
    wx.showToast({ title: type === 'docs' ? '已完成该资料学习' : '已看完该视频', icon: 'success' })
  },

  // 学习资料：在线阅读（下载 PDF → 调起微信内置阅读器），并同步标记已学
  openDoc(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const doc = this.data.training && this.data.training.docs[idx]
    if (!doc) return
    // 保留原有「标记已学」逻辑，确保学习进度与考试解锁不受网络影响
    this._markLearned('docs', doc.name)
    const url = docUrl(doc)
    if (!url) return
    wx.showLoading({ title: '正在打开资料…', mask: true })
    wx.downloadFile({
      url,
      timeout: 30000,
      success: res => {
        if ((res.statusCode || 0) !== 200) {
          wx.hideLoading()
          wx.showToast({ title: '资料暂未开放，请联系管理员', icon: 'none' })
          return
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          fileType: 'pdf',
          showMenu: true,
          success: () => wx.hideLoading(),
          fail: () => {
            wx.hideLoading()
            wx.showToast({ title: '文件打开失败，请重试', icon: 'none' })
          }
        })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '资料加载失败，请检查网络', icon: 'none' })
      }
    })
  },

  playVideo(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const video = this.data.training && this.data.training.videos[idx]
    if (!video) return
    // 无可播放地址：提示并保留原「标记已看」行为，避免阻塞后续学习进度
    const url = this._resolveVideoUrl(video)
    console.log('[video] 原始 url:', video.url, '→ 解析后:', url, '| BASE:', BASE)
    if (!url) {
      wx.showToast({ title: '视频地址无效', icon: 'none' })
      this._markLearned('videos', video.name)
      return
    }
    // 断点续播：读取上次保存的播放位置
    const watchedMap = this._getWatchedMap()
    const savedPos = (watchedMap[video.name] && watchedMap[video.name].position) || 0
    console.log('[video] 打开视频：', video.name, '| savedPos=', savedPos, 's')
    // 就在被点击的这张卡片内展开播放器（不跳页、不弹框、卡片位置不变）
    this._currentVideoName = video.name || ''
    this._lastVideoTime = null
    this._sessionSeconds = 0
    this._watchBuffer = null
    this._lastFlush = 0
    this._lastPositionSave = 0
    this._lastSavedPosition = savedPos
    this._hasInitialSeek = false   // 重置续播标志，本次打开视频允许 seek
    // 仅当存在历史断点时进入「seek 等待」状态，禁用 position 写入；否则直接放开
    this._seekPending = savedPos > 0
    this._isSeeking = false
    this._seekPreview = -1
    // 清掉上一次的手动定位状态
    this._seekTarget = null
    this._seekTargetAt = 0
    this._clearSeekWatchdog()
    this._clearResumeSeek()
    this._swipe = null
    this._swipeEndAt = 0
    this._tap = null
    this._lastToggleAt = 0
    this._videoEnded = false
    // 记住本次要续播的位置（加载完成后据此定位）
    this._playPos = savedPos
    // 重置播放状态
    this._localPath = ''
    this._localPathFor = ''
    this._localDownloading = false
    this._localTask = null
    this._usingRemote = false
    this._clearHideTimer()
    this.setData({
      'videoPlayer.visible': true,
      // 记录播放的是哪一张卡片：播放器会在该卡片原位展开
      'videoPlayer.activeIndex': idx,
      // 直接挂远程地址播放：后端 /file/download 已支持 HTTP Range（返回 206），
      // 远程流同样能任意拖动定位（ctx.seek 生效），无需再「先下载成本地文件再播放」
      'videoPlayer.src': url,
      'videoPlayer.name': video.name || '',
      'videoPlayer.sessionText': '00:00',
      'videoPlayer.initialTime': savedPos,
      // 自定义控件初始：显示控件，playing 待 onPlay 触发后刷新
      'videoPlayer.playing': false,
      'videoPlayer.currentTime': savedPos,
      'videoPlayer.duration': 0,
      'videoPlayer.currentText': this._formatSeconds(savedPos),
      'videoPlayer.durationText': '00:00',
      'videoPlayer.playedPercent': 0,
      'videoPlayer.controlsVisible': true,
      'videoPlayer.fullscreen': false,
      'videoPlayer.loadingText': '',
      'videoPlayer.switching': false,
      'videoPlayer.swipeSeeking': false,
      'videoPlayer.rateVisible': false,
      // 倍速跨视频保留：沿用上次选择的倍速（真正生效由 onVideoPlay 里 _applyRate 下发）
      'videoPlayer.rate': this._rate,
      'videoPlayer.rateText': this._formatRate(this._rate)
    })
    // 播放器已就地展开，页面滚动位置保持不变；
    // 仅当播放器超出可视区域底部时，向下微调滚动刚好露出它（不再把播放区滚到页面顶部）。
    setTimeout(() => this._nudgePlayerIntoView(), 150)
    // 预热 track 几何信息缓存（用于触摸坐标换算），等下一帧布局完成再测量
    this._trackRect = null
    this._trackWidthCache = 0
    setTimeout(() => this._measureTrackRect(), 150)
    // 直接挂远程地址播放（后端已支持 Range），秒开且可任意拖动定位
    this._prepareAndPlay(url)
    // 默认 3 秒后自动隐藏控件（仅在播放时计时）
    this._scheduleHideControls()
    // 保留原行为：点击即视为已看过（用于准入/考试解锁）
    this._markLearned('videos', video.name)
  },

  // 关闭视频播放覆盖层，刷新页面以更新「已观看」时长与进度条
  closeVideoPlayer() {
    // 关闭前把内存中的累计缓冲与最近一次播放位置落盘
    this._flushWatchBuffer()
    if (this._currentVideoName) {
      // 关键：seek 未完成时 _lastVideoTime 仍是 autoplay 起步的 0，必须保留 savedPos，
      // 否则会把刚打开视频时还没定位到的"旧位置"误覆盖成 0，破坏下次续播。
      const savedPos = (this._getWatchedMap()[this._currentVideoName] && this._getWatchedMap()[this._currentVideoName].position) || 0
      const p = (!this._seekPending && this._lastVideoTime != null) ? Math.floor(this._lastVideoTime) : savedPos
      this._saveVideoPosition(this._currentVideoName, p)
      this._lastSavedPosition = p
    }
    // 关闭播放器即离开全屏，同步停止手机姿态监听
    this._stopOrientationWatch()
    this.setData({
      'videoPlayer.visible': false,
      'videoPlayer.activeIndex': -1,
      // 关闭播放器时同步退出全屏，避免舞台停留在全屏样式
      'videoPlayer.fullscreen': false,
      'videoPlayer.loadingText': '',
      'videoPlayer.switching': false,
      'videoPlayer.swipeSeeking': false,
      'videoPlayer.rateVisible': false
    })
    this._currentVideoName = ''
    this._lastVideoTime = null
    this._sessionSeconds = 0
    this._watchBuffer = null
    this._lastFlush = 0
    this._lastPositionSave = 0
    this._hasInitialSeek = false
    this._seekPending = false
    this._isSeeking = false
    this._swipe = null
    this._tap = null
    this._videoEnded = false
    this._seekPreview = -1
    this._trackRect = null
    this._trackWidthCache = 0
    this._seekTarget = null
    this._seekTargetAt = 0
    // 拖动定位兜底：中止下载任务并清理本次会话状态（已下载好的本地缓存保留，重开免二次下载）
    this._clearSeekWatchdog()
    if (this._localTask && typeof this._localTask.abort === 'function') {
      try { this._localTask.abort() } catch (e) { /* 忽略：任务可能已结束 */ }
    }
    this._localTask = null
    this._localDownloading = false
    this._localPath = ''
    this._localPathFor = ''
    this._pendingLocalTarget = null
    this._localSeekAfterLoad = null
    this._clearSwitching()
    this._clearSeekPendingSafety()
    this._clearResumeSeek()
    this._clearHideTimer()
    this._refresh()
  },

  // 视频开始播放：更新 playing 状态、重置时间锚点（处理暂停→恢复的场景），
  // 同时再做一次续播定位兜底（若 loadedmetadata 因网络慢于 play 触发）
  onVideoPlay() {
    this._lastVideoTime = null
    this.setData({ 'videoPlayer.playing': true })
    // 播放开始时调度 3 秒后隐藏控件
    this._scheduleHideControls()
    // 重新下发倍速：换视频 / 暂停后再 play，部分机型会退回 1 倍速
    this._applyRate()
    // 首次播放：若存在断点续播位置，主动定位过去（本地文件一定生效）
    this._maybeSeekToInitial()
  },

  // 视频暂停：把内存缓冲与当前位置落盘；seek 等待期间不写，避免 0 覆盖
  onVideoPause(e) {
    this._flushWatchBuffer()
    this.setData({ 'videoPlayer.playing': false })
    // 暂停时保持控件显示（不清除定时器，但 scheduleHideControls 重置计时）
    this._scheduleHideControls()
    if (this._seekPending) return
    const cur = e && e.detail && e.detail.currentTime
    if (this._currentVideoName && typeof cur === 'number') {
      const p = Math.floor(cur)
      this._saveVideoPosition(this._currentVideoName, p)
      this._lastSavedPosition = p
    }
  },

  // 视频自然结束：把内存缓冲落盘 + 清零位置（下次从头开始，避免下次打开就结束）
  onVideoEnded() {
    this._flushWatchBuffer()
    if (this._currentVideoName) {
      this._saveVideoPosition(this._currentVideoName, 0)
      this._lastSavedPosition = 0
    }
    this._lastVideoTime = null
    this._seekPending = false
    // 记住「已播完」：再次点播放按钮时据此回到开头重播（见 onVideoTogglePlay）
    this._videoEnded = true
    // 视频结束：标记为暂停、显示控件（让用户可重播或关闭）
    this.setData({
      'videoPlayer.playing': false,
      'videoPlayer.playedPercent': 100,
      'videoPlayer.currentTime': this.data.videoPlayer.duration,
      'videoPlayer.currentText': this.data.videoPlayer.durationText,
      'videoPlayer.controlsVisible': true
    })
    this._clearHideTimer()
  },

  // 视频加载元数据：执行断点续播兜底定位 + 读取真实 duration 写入自定义控件
  onVideoLoadedMeta(e) {
    const dur = e && e.detail && typeof e.detail.duration === 'number' ? e.detail.duration : 0
    // 注意：部分流式视频源会报 Infinity / NaN，这类时长不可用于定位（会让播放器回到开头），直接忽略
    if (isFinite(dur) && dur > 0) {
      const initial = Number(this.data.videoPlayer.initialTime) || 0
      this.setData({
        'videoPlayer.duration': dur,
        'videoPlayer.durationText': this._formatSeconds(dur),
        'videoPlayer.currentTime': initial,
        'videoPlayer.currentText': this._formatSeconds(initial),
        'videoPlayer.playedPercent': dur > 0 ? Math.min(100, (initial / dur) * 100) : 0
      })
      console.log('[video] 元数据加载完成，duration=' + dur + 's')
      // 落盘真实时长：接口元数据缺失/不准时，卡片状态与进度都以它为准
      this._saveVideoDuration(this._currentVideoName, dur)
    }
    // 数据已就绪：此时 seek 一定能生效，续播定位可放心补发
    this._maybeSeekToInitial(true)
  },

  // 视频播放错误
  onVideoError(e) {
    // 正在准备（下载本地文件阶段，src 可能还是空的）时的报错直接忽略，避免误弹提示
    if (this.data.videoPlayer.loadingText) return
    console.warn('[video] 播放失败：', e && e.detail)
    wx.showToast({ title: '视频播放失败，请检查网络', icon: 'none' })
  },

  // 封面（视频首帧）加载失败：隐藏该卡片的封面 video，露出下层深色渐变占位（静默兜底，不影响点击播放）
  onCoverError(e) {
    const idx = Number(e.currentTarget.dataset.index)
    if (!this.data.training || !this.data.training.videos[idx]) return
    this.setData({ ['training.videos[' + idx + '].coverError']: true })
  },

  // ── 自定义控件：舞台、播放/暂停、进度条、全屏 ──────────────────────────────

  // 点击视频舞台：切换控件显示/隐藏（3 秒后自动隐藏，模拟主流视频 App）
  onVideoStageTap() {
    // 刚结束一次「画面拖动定位」：忽略随之而来的 tap，避免松手后又把控件切走
    if (this._swipeEndAt && Date.now() - this._swipeEndAt < 300) return
    this._toggleControls()
  },

  // 切换控件显隐（真正的实现）。为什么要去抖：
  //   轻点画面会先后产生两次「切换控件」的调用机会 —— 手势层 touchend（onVideoSwipeEnd）
  //   与随后冒泡的 tap（本方法），两条路径都走这里，去抖保证一次轻点只切换一次，
  //   否则会出现「显示又立刻被收起」或「收起又立刻显示」。
  _toggleControls() {
    const now = Date.now()
    if (now - this._lastToggleAt < 250) return
    this._lastToggleAt = now
    const visible = !this.data.videoPlayer.controlsVisible
    // 收起控件时连倍速选项条一起收起
    this.setData({
      'videoPlayer.controlsVisible': visible,
      'videoPlayer.rateVisible': visible ? this.data.videoPlayer.rateVisible : false
    })
    if (visible && this.data.videoPlayer.playing) this._scheduleHideControls()
    else this._clearHideTimer()
  },

  // 显示控件（拖动进度条、切换播放/暂停时调用）
  _showControls(visible) {
    if (visible) {
      this.setData({ 'videoPlayer.controlsVisible': true })
    } else {
      // 控件隐藏时倍速选项条必须一并收起，否则会留在画面上无主可关
      this.setData({ 'videoPlayer.controlsVisible': false, 'videoPlayer.rateVisible': false })
    }
    if (visible && this.data.videoPlayer.playing) this._scheduleHideControls()
    else this._clearHideTimer()
  },

  _scheduleHideControls() {
    this._clearHideTimer()
    this._hideControlsTimer = setTimeout(() => {
      if (this.data.videoPlayer.playing) {
        this.setData({ 'videoPlayer.controlsVisible': false, 'videoPlayer.rateVisible': false })
      }
      this._hideControlsTimer = null
    }, 3000)
  },

  _clearHideTimer() {
    if (this._hideControlsTimer) {
      clearTimeout(this._hideControlsTimer)
      this._hideControlsTimer = null
    }
  },

  // 切换播放/暂停
  onVideoTogglePlay() {
    const ctx = wx.createVideoContext('td-vp-video', this)
    if (!ctx) return
    const vp = this.data.videoPlayer
    if (vp.playing) {
      if (typeof ctx.pause === 'function') ctx.pause()
    } else {
      // 已播放完：点播放按钮 = 从头重播。
      // 不能只调 play()：播放结束后 play() 在多数机型上会停在结尾不动（各端行为不一致），
      // 因此先 seek(0) 回到开头，再 play。
      const dur = Number(vp.duration) || 0
      const cur = Number(vp.currentTime) || 0
      const atEnd = this._videoEnded || (dur > 0 && cur >= dur - 0.3)
      if (atEnd) {
        this._videoEnded = false
        this._seekPending = false
        this._lastVideoTime = null
        if (typeof ctx.seek === 'function') ctx.seek(0)
        // 立即把进度条 / 时间刷回 00:00（不等 seeked，避免按钮点下去还停在结尾）
        this.setData({
          'videoPlayer.currentTime': 0,
          'videoPlayer.currentText': '00:00',
          'videoPlayer.playedPercent': 0
        })
      }
      if (typeof ctx.play === 'function') ctx.play()
    }
    this._showControls(true)
  },

  // 倍速：展开 / 收起倍速选项条（展开期间保持控件可见，避免 3 秒后连选项一起隐藏）
  onVideoToggleRate() {
    const next = !this.data.videoPlayer.rateVisible
    this.setData({ 'videoPlayer.rateVisible': next })
    this._showControls(true)
  },

  // 选择倍速：记录到 _rate 并立即下发（换视频后由 onVideoPlay 重新下发）
  onVideoPickRate(e) {
    const rate = Number(e.currentTarget.dataset.rate)
    if (!(rate > 0)) return
    this._rate = rate
    this.setData({
      'videoPlayer.rate': rate,
      'videoPlayer.rateText': this._formatRate(rate),
      'videoPlayer.rateVisible': false
    })
    this._applyRate()
    this._showControls(true)
    console.log('[video] 切换倍速：' + this._formatRate(rate))
  },

  // 下发倍速。为什么需要反复调用：
  //   · <video> 只有 VideoContext.playbackRate() 一个入口，没有声明式属性；
  //   · 部分机型在「暂停状态下发」或「seek / 重新 play 之后」会退回 1 倍速，
  //     所以在 play / loadedmetadata / seeked 这几个时机都补发一次（调用开销极小）。
  _applyRate() {
    const rate = this._rate
    if (!(typeof rate === 'number' && isFinite(rate) && rate > 0)) return
    // 注意：1.0 也必须下发 —— 否则从 2.0x 切回 1.0x 时播放器仍会保持 2 倍速
    const ctx = wx.createVideoContext('td-vp-video', this)
    if (ctx && typeof ctx.playbackRate === 'function') ctx.playbackRate(rate)
  },

  // 倍速文案：1 → 1.0x，1.25 → 1.25x
  _formatRate(rate) {
    const r = Number(rate) || 1
    return (r === Math.floor(r) ? r.toFixed(1) : String(r)) + 'x'
  },

  // 点击进度条跳转到指定位置（e.detail.x 是相对 track 左上角的 x）
  onVideoTrackTap(e) {
    this._applyTrackTouch(e, /*final=*/true)
  },

  // 开始拖动进度条
  onVideoSeekStart(e) {
    this._isSeeking = true
    this._clearHideTimer()
    // 触发测量（如果还未测量），让本次及后续 touchmove 有可靠 rect
    if (!this._trackRect || this._trackRect.width <= 0) {
      this._measureTrackRect()
    }
    this._applyTrackTouch(e, /*final=*/false)
  },

  // 拖动进度条中
  onVideoSeekMove(e) {
    if (!this._isSeeking) return
    this._applyTrackTouch(e, /*final=*/false)
  },

  // 拖动结束：调用 ctx.seek 定位
  onVideoSeekEnd(e) {
    if (!this._isSeeking) return
    this._isSeeking = false
    this._applyTrackTouch(e, /*final=*/true)
    if (this.data.videoPlayer.playing) this._scheduleHideControls()
  },

  // 计算点击 / 拖动位置对应的目标秒数，更新预览并 seek
  // 坐标换算说明：
  //   1. track 子元素加 pointer-events: none，避免绝对定位子元素吞掉触摸事件
  //   2. boundingClientRect() 返回「相对显示区域」坐标，因此优先用 clientX 与之配对；
  //      pageX 是相对文档的坐标，页面滚动后会与 rect.left 错位，仅作兜底
  //   3. 再 fallback 到 t.x / e.detail.x
  //   4. 最终兜底：用窗口宽度 + 固定布局常量同步估算 track 位置，绝不会算成 0
  _applyTrackTouch(e, final) {
    // 时长必须是「有限正数」：某些视频源（无 Content-Length 的流）会报 0 / NaN / Infinity，
    // 用它算出的目标位置（NaN / Infinity）会让播放器直接回到开头，这里先挡掉
    const dur = this.data.videoPlayer.duration
    if (typeof dur !== 'number' || !isFinite(dur) || dur <= 0) return
    // 每次触摸都重新测量一次（几何信息变化时不会用到过期值）：异步测量，供本次及后续事件使用
    this._measureTrackRect()
    const touches = e.changedTouches || e.touches || []
    const t = touches[0] || {}
    const tClientX = (typeof t.clientX === 'number') ? t.clientX : null
    const tPageX = (typeof t.pageX === 'number') ? t.pageX : null
    // 触摸点相对屏幕的横坐标（优先 clientX，与 boundingClientRect 坐标系一致）
    const touchX = tClientX !== null ? tClientX : tPageX
    let localX = -1
    // 方法 1：touchX - trackRect.left（最可靠，前提是 rect 已测量）
    if (touchX !== null && this._trackRect && this._trackRect.width > 0) {
      localX = touchX - this._trackRect.left
    }
    // 方法 2：t.x（部分 WeChat 版本可用）
    if (localX < 0 && typeof t.x === 'number' && t.x >= 0 && isFinite(t.x)) {
      localX = t.x
    }
    // 方法 3：e.detail.x（tap 事件）。注意微信给的是「相对文档左上角」的坐标，
    // 页面只有纵向滚动时与 clientX 等价 —— 必须同样减去轨道 left，不能直接当 localX 用
    if (localX < 0 && e.detail && typeof e.detail.x === 'number' && isFinite(e.detail.x) && e.detail.x >= 0) {
      const est3 = this._getTrackEstimate(this._getWinWidth())
      const left3 = (this._trackRect && this._trackRect.width > 0) ? this._trackRect.left : est3.left
      const guess = e.detail.x - left3
      // 兼容「相对节点」实现：相减为负说明 detail.x 本身可能已是节点内偏移
      localX = guess >= 0 ? guess : e.detail.x
    }
    // 方法 4：同步兜底估算（绝不会是 0，除非用户真的点在屏幕最左）
    if (localX < 0 && touchX !== null) {
      const winWidth = this._getWinWidth()
      const est = this._getTrackEstimate(winWidth)
      localX = touchX - est.left
      if (localX < 0) localX = 0
      if (localX > est.width) localX = est.width
    }
    if (localX < 0) return
    // 计算宽度：优先用 _trackRect.width，否则用 _getTrackWidth / 同步估算
    const rect = this._trackRect
    let width
    if (rect && rect.width > 0) {
      width = rect.width
    } else {
      width = this._getTrackWidth()
      if (width <= 0) {
        width = this._getTrackEstimate(this._getWinWidth()).width
      }
    }
    if (width <= 0) return
    let ratio = localX / width
    if (ratio < 0) ratio = 0
    if (ratio > 1) ratio = 1
    const target = ratio * dur
    if (!isFinite(target)) return
    // 拖动期间显示预览位置；松开/点击时实际 seek
    this._seekPreview = target
    this.setData({
      'videoPlayer.playedPercent': ratio * 100,
      'videoPlayer.currentTime': target,
      'videoPlayer.currentText': this._formatSeconds(target)
    })
    if (final) {
      // 一次点击会同时触发 touchend 与 tap，这里对「极短时间内相同目标」去重，只 seek 一次
      const now = Date.now()
      const duplicated = this._lastSeekTarget != null &&
        Math.abs(target - this._lastSeekTarget) < 0.5 && now - this._lastSeekAt < 300
      this._lastSeekTarget = target
      this._lastSeekAt = now
      if (duplicated) return
      console.log('[video] 进度条定位：触摸点=' + (touchX === null ? '未取到' : touchX.toFixed(1)) +
        'px，轨道 left=' + (this._trackRect ? this._trackRect.left.toFixed(1) : '未测量') +
        'px，轨道宽=' + width.toFixed(1) + 'px，localX=' + localX.toFixed(1) +
        'px，目标=' + target.toFixed(1) + 's / 总时长 ' + dur.toFixed(1) + 's')
      // 统一走 _seekNow：记录目标位置（丢弃旧上报）+ 下发 seek + 启动「定位是否成功」的兜底判定
      this._seekNow(target)
    }
  },

  // 下发一次定位。播放源已支持 HTTP Range（206），ctx.seek 会立即生效。
  // _seekTarget 只用于在定位刚下发的极短窗口内冻结显示，避免进度条先闪回旧位置；
  // 该窗口很短（≤0.8s）且有超时兜底，绝不会出现「时间轴僵住不动」。
  _seekNow(target) {
    if (typeof target !== 'number' || !isFinite(target) || target < 0) return
    // 用户主动定位（进度条 / 画面拖动）：退出「已播完」状态，
    // 否则播完后拖到中间再点播放会被强行拉回开头
    this._videoEnded = false
    this._hasInitialSeek = true
    this._seekPending = true
    this._seekTarget = target
    this._seekTargetAt = Date.now()
    // 用户主动定位 = 放弃尚未落地的断点续播重试，否则会被重试逻辑拉回断点位置
    this._clearResumeSeek()
    this._armSeekPendingSafety()
    const ctx = wx.createVideoContext('td-vp-video', this)
    if (ctx && typeof ctx.seek === 'function') ctx.seek(target)
  },

  // ── 画面手势定位：在视频画面上横向拖动即可快进 / 快退 ──────────────────────
  // 交互：按住画面横向拖动 → 中央提示「快进 +45s / 目标 02:35」，进度条同步预览；
  //       松手后一次性 seek 到目标位置（拖动过程中不 seek，避免远程流反复跳转卡顿）。
  // 换算：整屏宽度 ≈ min(时长, 300s)。设 300s 上限是为了长视频不至于「手指挪一点就跳几分钟」。
  // 全屏说明：全屏是「舞台旋转 90°」实现的，手指在屏幕上的纵向滑动对应画面的横向，
  //          因此全屏下改用纵向位移计算，手感与非全屏一致。
  onVideoSwipeStart(e) {
    const t = (e.touches && e.touches[0]) || {}
    const hasPoint = (typeof t.clientX === 'number' || typeof t.clientY === 'number')
    // 先记录触摸起点：用于在 touchend 时判断这次是「轻点画面」还是「拖动快进」。
    // 必须在时长判断之前记录 —— 时长还没就绪时，轻点画面同样应该能唤出控制条。
    this._tap = hasPoint
      ? { x0: Number(t.clientX) || 0, y0: Number(t.clientY) || 0, moved: false }
      : null
    const dur = this.data.videoPlayer.duration
    if (typeof dur !== 'number' || !isFinite(dur) || dur <= 0) return
    if (!hasPoint) return
    this._swipe = {
      x0: Number(t.clientX) || 0,
      y0: Number(t.clientY) || 0,
      base: Number(this.data.videoPlayer.currentTime) || 0,
      dur: dur,
      // 整屏滑动对应的秒数
      span: Math.min(dur, 300),
      // 参考长度：手势方向上的屏幕尺寸（全屏时纵向滑动，参考屏幕高度）
      ref: this.data.videoPlayer.fullscreen ? this._getWinHeight() : this._getWinWidth(),
      fullscreen: !!this.data.videoPlayer.fullscreen,
      decided: false,
      active: false,
      target: null
    }
    // 用户主动拖动 = 放弃尚未落地的断点续播重试，否则松手后会被拉回断点
    this._clearResumeSeek()
    this._clearHideTimer()
  },

  onVideoSwipeMove(e) {
    // 位移超过 10px 就不再视为「轻点画面」（用 touch 判定轻点，比 tap 可靠：
    // 容器上绑了 catchtouchmove，轻点时手指若有微小抖动，部分环境会判为拖动而不再派发 tap）
    if (this._tap) {
      const t0 = (e.touches && e.touches[0]) || {}
      const mx = (Number(t0.clientX) || 0) - this._tap.x0
      const my = (Number(t0.clientY) || 0) - this._tap.y0
      if (Math.abs(mx) > 10 || Math.abs(my) > 10) this._tap.moved = true
    }
    const s = this._swipe
    if (!s) return
    const t = (e.touches && e.touches[0]) || {}
    if (typeof t.clientX !== 'number' && typeof t.clientY !== 'number') return
    const dx = (Number(t.clientX) || 0) - s.x0
    const dy = (Number(t.clientY) || 0) - s.y0
    // 全屏下舞台旋转 90°：画面的横向 = 屏幕的纵向
    const main = s.fullscreen ? dy : dx
    const cross = s.fullscreen ? dx : dy
    // 首次移动先判定方向：主轴位移不足就继续等；十字位移更大说明不是「快进」手势，本次放弃
    if (!s.decided) {
      if (Math.abs(main) < 8 && Math.abs(cross) < 8) return
      if (Math.abs(cross) > Math.abs(main)) {
        this._swipe = null
        return
      }
      s.decided = true
      s.active = true
      // 冻结 timeupdate 对时间 / 进度条的刷新，全程显示拖动的预览位置
      this._isSeeking = true
      this._showControls(true)
      this.setData({ 'videoPlayer.swipeSeeking': true })
    }
    if (!s.active) return
    let target = s.base + (main / Math.max(1, s.ref)) * s.span
    if (target < 0) target = 0
    if (target > s.dur) target = s.dur
    s.target = target
    this._applySwipePreview(target)
  },

  onVideoSwipeEnd() {
    const s = this._swipe
    const tap = this._tap
    this._swipe = null
    this._tap = null
    this._isSeeking = false
    if (this.data.videoPlayer.swipeSeeking) this.setData({ 'videoPlayer.swipeSeeking': false })
    // ① 形成了快进 / 快退手势：定位到目标位置
    if (s && s.active && s.target != null) {
      // 记录结束时间：吞掉随之而来的 tap，避免松手后又把控件切走
      this._swipeEndAt = Date.now()
      const target = s.target
      const delta = Math.round(target - s.base)
      console.log('[video] 画面拖动定位：' + (delta >= 0 ? '快进 +' : '快退 ') + Math.abs(delta) +
        's，目标=' + target.toFixed(1) + 's / 总时长 ' + s.dur.toFixed(1) + 's')
      this._seekNow(target)
      this._showControls(true)
      return
    }
    // ② 未形成手势（轻点 / 纵向滑动 / 时长未知）：
    //     · 几乎没位移 → 视为「轻点画面」，切换控件显隐（不再依赖 tap，见 onVideoSwipeMove 注释）
    //     · 有明显位移 → 用户是想滚动页面或误触，不做任何切换
    if (tap && !tap.moved) this._toggleControls()
  },

  // 触摸被打断（来电、系统手势、手指滑出等）：只清状态，绝不改变控件显隐
  onVideoSwipeCancel() {
    this._swipe = null
    this._tap = null
    this._isSeeking = false
    if (this.data.videoPlayer.swipeSeeking) this.setData({ 'videoPlayer.swipeSeeking': false })
  },

  // 手势拖动中的预览：更新时间 / 进度条 / 中央增量提示（不 seek）
  _applySwipePreview(target) {
    const s = this._swipe
    const dur = this.data.videoPlayer.duration
    const ratio = dur > 0 ? target / dur : 0
    const delta = s ? Math.round(target - s.base) : 0
    this.setData({
      'videoPlayer.playedPercent': Math.max(0, Math.min(100, ratio * 100)),
      'videoPlayer.currentTime': target,
      'videoPlayer.currentText': this._formatSeconds(target),
      'videoPlayer.swipeDeltaText': (delta >= 0 ? '快进 +' : '快退 ') + Math.abs(delta) + 's',
      'videoPlayer.swipeForward': delta >= 0
    })
  },

  // 「定位等待」保护：正常由 bindseeked 解除；极端情况下（seeked 未回调）用定时器兜底解除，
  // 避免 _seekPending 永远为 true 导致观看位置再也不落盘。
  _armSeekPendingSafety() {
    if (this._seekPendingTimer) clearTimeout(this._seekPendingTimer)
    this._seekPendingTimer = setTimeout(() => {
      this._seekPendingTimer = null
      this._seekPending = false
    }, 1500)
  },

  _clearSeekPendingSafety() {
    if (this._seekPendingTimer) {
      clearTimeout(this._seekPendingTimer)
      this._seekPendingTimer = null
    }
  },

  _clearSeekWatchdog() {
    if (this._seekWatchdog) {
      clearTimeout(this._seekWatchdog)
      this._seekWatchdog = null
    }
    this._seekWatchdogTarget = null
  },

  // 当前播放地址是否已是「本地临时文件」。
  // 重要：只能用「我们自己记录过的本地路径」来判断，绝不能用 http://127.0.0.1 这类前缀！
  //   · 后端地址就是 http://127.0.0.1:8114（见 utils/api.js 的 BASE），
  //     远程视频地址 http://127.0.0.1:8114/file/download?url=… 同样以它开头，
  //     一旦按前缀误判为本地文件，整条「拖动定位兜底」会被跳过 —— 表现为点进度条永远回到开头。
  _isLocalSrc(src) {
    if (!src) return false
    // 明确就等于当前/已缓存的本地文件路径
    if (this._localPath && src === this._localPath) return true
    const cache = this._localCacheMap
    if (cache) {
      for (const key in cache) {
        if (cache[key] === src) return true
      }
    }
    // 微信临时文件路径形态兜底：真机 wxfile://…，开发者工具 http://tmp/…、http://usr/…
    // 注意这里不带 127.0.0.1：它同时也是后端地址前缀，会造成误判。
    return /^(wxfile:|http:\/\/tmp\/|http:\/\/usr\/)/i.test(src)
  },

  // 打开视频时的准备：直接挂远程地址播放。
  // 后端 /file/download 已支持 HTTP Range（带 Range 请求返回 206 + Content-Range），
  // 远程流即可被播放器任意拖动定位，因此不再需要「先下载成本地文件再播放」这一层。
  _prepareAndPlay(url) {
    this._playSource(url, false, url)
  },

  // 真正挂载播放源并开始播放（pos = 断点续播位置）
  _playSource(src, isLocal, originalUrl) {
    const pos = Math.max(0, Math.floor(Number(this._playPos) || 0))
    this._localPath = isLocal ? src : ''
    this._localPathFor = originalUrl || ''
    this._usingRemote = !isLocal
    this._hasInitialSeek = false
    this._seekPending = pos > 0
    this._seekTarget = null
    this._seekTargetAt = 0
    this._isSeeking = false
    this._lastVideoTime = null
    console.log('[video] 开始播放' + (isLocal ? '（本地文件）' : '（远程流）') + '，续播位置 ' + pos + 's')
    this.setData({
      'videoPlayer.src': src,
      'videoPlayer.initialTime': pos,
      'videoPlayer.currentTime': pos,
      'videoPlayer.currentText': this._formatSeconds(pos),
      'videoPlayer.playedPercent': 0,
      'videoPlayer.loadingText': '',
      'videoPlayer.switching': false,
      'videoPlayer.playing': false
    })
  },

  // 退出「切换源」过渡态（保留兼容）
  _clearSwitching() {
    if (this._switchTimer) {
      clearTimeout(this._switchTimer)
      this._switchTimer = null
    }
    if (this.data.videoPlayer.switching) this.setData({ 'videoPlayer.switching': false })
  },

  // 同步获取窗口宽度（避免重复调用系统 API）
  _getWinWidth() {
    let winWidth = 375
    try {
      if (typeof wx.getWindowInfo === 'function') {
        const w = wx.getWindowInfo().windowWidth
        if (w) winWidth = w
      }
    } catch (e) { /* 兼容低基础库：忽略 */ }
    if (winWidth === 375 && typeof wx.getSystemInfoSync === 'function') {
      try {
        const w = wx.getSystemInfoSync().windowWidth
        if (w) winWidth = w
      } catch (e) {}
    }
    return winWidth
  },

  // 同步获取窗口高度（全屏下舞台旋转 90°，手势方向为纵向，需要屏幕高度作换算参考）
  _getWinHeight() {
    let winHeight = 667
    try {
      if (typeof wx.getWindowInfo === 'function') {
        const h = wx.getWindowInfo().windowHeight
        if (h) winHeight = h
      }
    } catch (e) { /* 兼容低基础库：忽略 */ }
    if (winHeight === 667 && typeof wx.getSystemInfoSync === 'function') {
      try {
        const h = wx.getSystemInfoSync().windowHeight
        if (h) winHeight = h
      } catch (e) {}
    }
    return winHeight
  },

  // 同步估算 track 的 left 和 width（基于内嵌播放器的固定布局常量，单位 rpx）：
  // 舞台左边 = 页面padding(24) + 卡片padding(28) = 52rpx
  // track 左边 = 52 + 控件条paddingLeft(16) + playBtn(48) + gap(10) + time(64) + gap(10) = 200rpx
  // 舞台宽 = 750 - 24*2 - 28*2 = 646rpx
  // track 宽 = 646 - 16*2 - (play48 + time64 + time64 + rate60 + full48) - 5*10 = 280rpx
  _getTrackEstimate(winWidth) {
    const rpxToPx = winWidth / 750
    return {
      left: 200 * rpxToPx,
      width: 280 * rpxToPx
    }
  },

  // 异步测量 track 几何信息（left/right/width），缓存到 _trackRect / _trackWidthCache。
  // 调用时机：视频覆盖层打开后、全屏切换后；下一次事件循环再调用，避免布局未完成返回 0。
  _measureTrackRect() {
    if (typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function') return
    const query = wx.createSelectorQuery().in(this)
    query.select('.td-vp-bottom__track').boundingClientRect()
    query.exec(res => {
      const rect = res && res[0]
      if (rect && rect.width > 0) {
        this._trackRect = { left: rect.left, width: rect.width, right: rect.right }
        this._trackWidthCache = rect.width
      }
    })
  },

  // 播放器在被点击的卡片内就地展开后，正常情况下滚动位置完全不变；
  // 只有当播放器底部超出可视区域（点的是屏幕靠下的卡片）时，
  // 向下滚动「刚好露出播放器」的这一点距离，避免它被挡住又不破坏「在原地播放」的观感。
  _nudgePlayerIntoView(retried) {
    if (typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function') return
    const query = wx.createSelectorQuery().in(this)
    query.select('.td-scroll').boundingClientRect()
    query.select('.td-scroll').scrollOffset()
    query.select('#td-video-player').boundingClientRect()
    query.exec(res => {
      const viewRect = res && res[0]
      const offset = res && res[1]
      const playerRect = res && res[2]
      // 布局尚未完成（刚 setData，节点可能还没渲染出来）：最多再重试一次
      if (!viewRect || !offset || !playerRect || !playerRect.height) {
        if (!retried) setTimeout(() => this._nudgePlayerIntoView(true), 200)
        return
      }
      const overflow = (playerRect.bottom + 24) - viewRect.bottom
      if (overflow <= 0) return   // 已完整可见：保持当前位置不动
      const from = offset.scrollTop || 0
      // 先同步回真实偏移量，再设为目标值，确保 scroll-top 一定发生变化从而触发滚动
      this.setData({ scrollTop: from }, () => {
        this.setData({ scrollTop: from + overflow })
      })
    })
  },

  // 通过 _trackRect 拿到 track 宽度；若未测量则用窗口宽度兜底估算
  _getTrackWidth() {
    if (this._trackRect && this._trackRect.width > 0) return this._trackRect.width
    if (this._trackWidthCache > 0) return this._trackWidthCache
    // 兜底：按固定布局常量估算（与 _getTrackEstimate 共用同一份常量，避免两处不同步）
    return Math.max(1, this._getTrackEstimate(this._getWinWidth()).width)
  },

  // 切换全屏：页面内自定义全屏（不调用原生 requestFullScreen）。
  // 舞台固定成「手机屏幕」尺寸（宽=100vh、高=100vw）并旋转 90°，
  // 于是横向铺满手机屏幕；因为是页面内布局，开发者工具里也只在手机模拟器内全屏，
  // 不会像原生全屏那样铺满整个电脑屏幕。
  onVideoToggleFullscreen() {
    const next = !this.data.videoPlayer.fullscreen
    this.setData({ 'videoPlayer.fullscreen': next })
    // 全屏时开始监听手机姿态（竖持即自动恢复非全屏），退出时停止监听
    if (next) this._startOrientationWatch()
    else this._stopOrientationWatch()
    this._showControls(true)
    // 舞台尺寸变化后 track 几何信息失效，重新测量（用于进度条触摸坐标换算）
    this._trackRect = null
    this._trackWidthCache = 0
    setTimeout(() => this._measureTrackRect(), 120)
  },

  // 全屏下点「关闭」：退出全屏，恢复到卡片内的原位播放状态（不关闭播放器本身）
  onVideoExitFullscreen() {
    if (!this.data.videoPlayer.fullscreen) return
    this.setData({ 'videoPlayer.fullscreen': false })
    this._stopOrientationWatch()
    this._showControls(true)
    this._trackRect = null
    this._trackWidthCache = 0
    setTimeout(() => this._measureTrackRect(), 120)
  },

  // 全屏状态变化
  onVideoFullscreenChange(e) {
    const fs = !!(e && e.detail && e.detail.fullScreen)
    this.setData({ 'videoPlayer.fullscreen': fs })
    if (fs) this._startOrientationWatch()
    else this._stopOrientationWatch()
    this._showControls(true)
    // 全屏切换后 track 几何信息会变化，重新测量（用于触摸坐标换算）
    this._trackRect = null
    this._trackWidthCache = 0
    setTimeout(() => this._measureTrackRect(), 100)
  },

  // ── 全屏时的手机姿态监听 ────────────────────────────────────────────────
  // 需求：全屏只有两种退出方式 —— 点「关闭」，或把手机竖回竖屏（自动恢复卡片内播放）。
  // 全屏是「舞台旋转 90°」实现的（页面本身锁定竖屏，系统不会自动转屏），
  // 因此用加速度计判断手机实际是横持还是竖持：
  //   · 竖持：重力主要落在 y 轴（|y| 大、|x| 小）
  //   · 横持：重力主要落在 x 轴
  // 注意：横持过（进入全屏后先横过来看）才启用「竖持即退出」，
  // 否则一进全屏就还握着竖屏会被立刻弹出去。
  _startOrientationWatch() {
    if (this._orientationOn) return
    this._orientationOn = true
    this._sawLandscape = false
    this._portraitTicks = 0
    this._onAccel = (res) => {
      if (!this.data.videoPlayer.fullscreen) return
      const x = Math.abs(Number(res && res.x) || 0)
      const y = Math.abs(Number(res && res.y) || 0)
      // 尚未观察到横持：先等用户把手机转成横向，避免刚进全屏就被判为竖持而退出
      if (!this._sawLandscape) {
        if (x > 0.55) this._sawLandscape = true
        return
      }
      // 连续两次（约 0.4s）判定为竖持才退出，避免抬手抖动误触
      if (x < 0.5 && y > 0.5) {
        this._portraitTicks += 1
        if (this._portraitTicks >= 2) {
          this._portraitTicks = 0
          console.log('[video] 检测到手机已竖持，自动退出全屏')
          this.onVideoExitFullscreen()
        }
      } else {
        this._portraitTicks = 0
      }
    }
    wx.onAccelerometerChange(this._onAccel)
    wx.startAccelerometer({ interval: 'normal', fail: () => { /* 不支持则忽略，仍可用关闭按钮退出 */ } })
  },

  _stopOrientationWatch() {
    this._orientationOn = false
    this._sawLandscape = false
    this._portraitTicks = 0
    if (this._onAccel) {
      if (typeof wx.offAccelerometerChange === 'function') wx.offAccelerometerChange(this._onAccel)
      this._onAccel = null
    }
    try { wx.stopAccelerometer({}) } catch (e) { /* 兼容低基础库：忽略 */ }
  },

  // 计算自定义导航栏尺寸：状态栏高度 + 44px 导航条（与系统导航栏一致的高度）
  _initNavSize() {
    let statusBarHeight = 20
    try {
      const info = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (info && info.statusBarHeight) statusBarHeight = info.statusBarHeight
    } catch (e) { /* 兼容低基础库：用默认值 */ }
    const navBarHeight = 44
    this.setData({
      statusBarHeight,
      navBarHeight,
      navTotalHeight: statusBarHeight + navBarHeight
    })
  },

  // 自定义导航栏返回
  goBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1 })
    } else {
      wx.reLaunch({ url: '/pages/index/index' })
    }
  },

  // 周期性时间更新：累计观看时长（只统计正常播放的正向增量，跳过拖拽），
  // 并节流保存当前播放位置用于断点续播（每 2s 一次）。
  // 关键：_seekPending=true 期间只更新内存，不写 storage，避免 autoplay 起步的 0 帧覆盖 savedPos。
  // 同时刷新自定义控件：currentTime / currentText / playedPercent（拖动期间不刷新，使用预览值）。
  onVideoTimeUpdate(e) {
    const cur = e && e.detail && e.detail.currentTime
    const dur = e && e.detail && e.detail.duration
    if (typeof cur !== 'number') return
    if (this._lastVideoTime == null) {
      this._lastVideoTime = cur
    } else {
      const delta = cur - this._lastVideoTime
      this._lastVideoTime = cur
      // 增量上限随倍速放大（2 倍速下单位时间内前进的秒数也是 2 倍），
      // 既不会在高倍速下漏计观看时长，也依然能滤掉拖动定位造成的大跳变。
      const maxDelta = 2 * (this._rate > 0 ? this._rate : 1)
      if (delta > 0 && delta <= maxDelta) {
        // 「本次累计观看」同样封顶在视频总时长：到达总时长后不再往上加（总时长未知时不限制）
        const total = this._videoTotalSeconds(this._currentVideoName)
        const capped = total > 0 && this._sessionSeconds >= total
        if (!capped) {
          this._sessionSeconds += delta
          if (total > 0 && this._sessionSeconds > total) this._sessionSeconds = total
          this.setData({ 'videoPlayer.sessionText': this._formatSeconds(this._sessionSeconds) })
        }
        this._addWatchedSeconds(this._currentVideoName, delta)
      }
    }
    // 同步自定义控件的当前时间 / 进度（拖动期间冻结显示）
    if (!this._isSeeking) {
      // 定位刚下发的极短窗口内冻结显示，避免进度条先闪回旧位置；
      // 窗口结束仍未落到目标（极少见）就如实显示真实位置 —— 绝不会长期冻结不动。
      let holdDisplay = false
      if (this._seekTarget != null) {
        const target = this._seekTarget
        if (Math.abs(cur - target) <= 2) {
          this._seekTarget = null
        } else if (Date.now() - this._seekTargetAt < 800) {
          holdDisplay = true
        } else {
          this._seekTarget = null
        }
      }
      // 断点续播定位落地前：同样把时间/进度保持显示在断点位置，避免闪回 00:00
      if (this._resumeTarget != null) holdDisplay = true
      if (!holdDisplay) {
        const d = typeof dur === 'number' && dur > 0 ? dur : (this.data.videoPlayer.duration || 0)
        const percent = d > 0 ? Math.min(100, (cur / d) * 100) : 0
        this.setData({
          'videoPlayer.currentTime': cur,
          'videoPlayer.currentText': this._formatSeconds(cur),
          'videoPlayer.playedPercent': percent
        })
      }
      // duration 可能后于 loadedmetadata 拿到，这里补一次
      if (typeof dur === 'number' && isFinite(dur) && dur > 0 && this.data.videoPlayer.duration !== dur) {
        this.setData({ 'videoPlayer.duration': dur, 'videoPlayer.durationText': this._formatSeconds(dur) })
        // loadedmetadata 未给出可用时长时（部分流式源报 Infinity/NaN），这里补记一次真实时长
        this._saveVideoDuration(this._currentVideoName, dur)
      }
    }
    // seek 等待 / 断点续播定位期间禁止写入 position（避免 currentTime=0 帧覆盖断点）
    if (this._seekPending || this._resumeTarget != null) return
    // 节流保存播放位置（≥2s 间隔且位置发生变化时落盘）；临近末尾（≥95%）置零，避免下次打开即结束
    let posToSave = Math.floor(cur)
    if (typeof dur === 'number' && dur > 0 && cur / dur >= 0.95) posToSave = 0
    const now = Date.now()
    if (posToSave !== this._lastSavedPosition && (!this._lastPositionSave || now - this._lastPositionSave >= 2000)) {
      this._saveVideoPosition(this._currentVideoName, posToSave)
      this._lastSavedPosition = posToSave
      this._lastPositionSave = now
    }
  },

  // 页面隐藏时把内存缓冲与播放位置落盘，避免丢数据；
  // 同时停止手机姿态监听（原先重复定义的 onHide 被覆盖导致漏掉，后台空耗电量）
  onHide() {
    this._stopOrientationWatch()
    this._flushWatchBuffer()
    if (this._currentVideoName) {
      const savedPos = (this._getWatchedMap()[this._currentVideoName] && this._getWatchedMap()[this._currentVideoName].position) || 0
      const p = (!this._seekPending && this._lastVideoTime != null) ? Math.floor(this._lastVideoTime) : savedPos
      this._saveVideoPosition(this._currentVideoName, p)
      this._lastSavedPosition = p
    }
  },

  onUnload() {
    // 停止手机姿态监听（原先重复定义的 onUnload 被覆盖导致漏掉，这里补上）
    this._stopOrientationWatch()
    // 中止「下载本地文件」任务与相关定时器
    this._clearSeekWatchdog()
    this._clearSwitching()
    this._clearSeekPendingSafety()
    this._clearResumeSeek()
    this._swipe = null
    if (this._localTask && typeof this._localTask.abort === 'function') {
      try { this._localTask.abort() } catch (e) { /* 忽略：任务可能已结束 */ }
    }
    this._localTask = null
    this._flushWatchBuffer()
    if (this._currentVideoName) {
      const savedPos = (this._getWatchedMap()[this._currentVideoName] && this._getWatchedMap()[this._currentVideoName].position) || 0
      const p = (!this._seekPending && this._lastVideoTime != null) ? Math.floor(this._lastVideoTime) : savedPos
      this._saveVideoPosition(this._currentVideoName, p)
      this._lastSavedPosition = p
    }
  },

  // ── 观看时长存储辅助 ──────────────────────────────
  _videoWatchKey() {
    return 'trainingVideoWatch_' + this._id
  },

  _getWatchedMap() {
    return wx.getStorageSync(this._videoWatchKey()) || {}
  },

  _saveWatchedMap(map) {
    wx.setStorageSync(this._videoWatchKey(), map || {})
  },

  // 保存单个视频的最近播放位置（用于断点续播）；同值不写以减少 storage 抖动
  _saveVideoPosition(name, position) {
    if (!name) return
    const p = Math.max(0, Math.floor(Number(position) || 0))
    const map = this._getWatchedMap()
    if (!map[name]) map[name] = { seconds: 0 }
    if (map[name].position === p) return
    map[name].position = p
    this._saveWatchedMap(map)
    console.log('[video] 保存播放位置：', name, '→', p, 's')
  },

  // 断点续播：关闭播放器时已把位置写入 storage，重开时定位回该位置。
  // 关键：<video initial-time> 在部分机型 / 远程流上不生效（尤其与 autoplay 同时使用时），
  // 而 seek 下发过早（数据未就绪）会被播放器静默丢弃 —— 只下发一次就可能永远续播不上。
  // 因此这里用「下发 → 校验 → 未落到断点就重试」兜底（最多 5 次，loadedmetadata 时重置预算），
  // 确保一定能回到关闭前的位置。定位落地前保持 _seekPending=true，
  // 期间 timeupdate / pause / close 都不会把起步的 0 写回 storage。
  _maybeSeekToInitial(ready) {
    // 续播定位尚未落地：只有在「数据就绪」信号（loadedmetadata）到来时才再补发一次，
    // 并重置重试预算 —— 避免网络慢导致几次重试全部落在数据就绪之前而失败。
    if (this._resumeTarget != null) {
      if (ready) {
        this._resumeTries = 0
        this._armSeekPendingSafety()
        this._applyResumeSeek()
      }
      return
    }
    if (this._hasInitialSeek) return
    this._hasInitialSeek = true
    const target = Number(this.data.videoPlayer.initialTime) || 0
    if (target <= 0) {
      this._seekPending = false
      return
    }
    this._seekPending = true   // 进入"seek 等待"，期间禁止 position 写入
    this._armSeekPendingSafety()
    this._resumeTarget = target
    this._resumeTries = 0
    this._applyResumeSeek()
  },

  // 下发一次断点续播定位，稍后校验是否真的落到断点；未落到则重试
  _applyResumeSeek() {
    const target = this._resumeTarget
    if (target == null) return
    const ctx = wx.createVideoContext('td-vp-video', this)
    if (!ctx) {
      console.warn('[video] 创建 VideoContext 失败，跳过断点续播定位')
      this._finishResumeSeek()
      this._clearSeekPendingSafety()
      this._seekPending = false
      return
    }
    const lastTry = this._resumeTries >= 4        // 共 5 次
    this._resumeTries++
    console.log('[video] 断点续播：seek 到 ' + target + 's（第 ' + this._resumeTries + ' 次' +
      (lastTry ? '，最后一次' : '') + '）')
    if (typeof ctx.seek === 'function') ctx.seek(target)
    // 仅在未播放时补一次 play（避免与用户手动暂停打架）
    if (!this.data.videoPlayer.playing && typeof ctx.play === 'function') ctx.play()
    if (lastTry) {
      this._finishResumeSeek()
      return
    }
    if (this._resumeTimer) clearTimeout(this._resumeTimer)
    this._resumeTimer = setTimeout(() => {
      this._resumeTimer = null
      if (this._resumeTarget == null) return
      const cur = Number(this.data.videoPlayer.currentTime)
      if (isFinite(cur) && Math.abs(cur - target) <= 3) this._finishResumeSeek()
      else this._applyResumeSeek()
    }, 400)
  },

  // 结束断点续播定位（已落到断点 / 重试次数用尽）
  _finishResumeSeek() {
    this._resumeTarget = null
    if (this._resumeTimer) {
      clearTimeout(this._resumeTimer)
      this._resumeTimer = null
    }
  },

  // 清空断点续播状态（关闭/卸载/重新打开时调用）
  _clearResumeSeek() {
    this._resumeTarget = null
    this._resumeTries = 0
    if (this._resumeTimer) {
      clearTimeout(this._resumeTimer)
      this._resumeTimer = null
    }
  },

  // 视频 seek 完成（定位到目标位置完成）：解除"seek 等待"，允许后续落盘
  onVideoSeeked(e) {
    const cur = e && e.detail && e.detail.currentTime
    // seek 后部分机型会把倍速重置为 1，这里补发一次（在 return 分支之前，保证一定执行）
    this._applyRate()
    // 断点续播重试期间：只有真正落到断点附近才算完成。
    // 若这次 seek 被丢弃（事件回报 0 或旧位置），保持等待并交给 _applyResumeSeek 重试，
    // 绝不让 0 覆盖掉已保存的断点。
    if (this._resumeTarget != null) {
      if (typeof cur === 'number' && Math.abs(cur - this._resumeTarget) <= 3) {
        this._finishResumeSeek()
      } else {
        return
      }
    }
    // 定位落到目标附近：解除「短冻结」，让进度条继续跟随真实播放位置
    if (this._seekTarget != null && typeof cur === 'number' &&
        Math.abs(cur - this._seekTarget) <= 3) {
      this._seekTarget = null
    }
    if (!this._seekPending) return
    this._clearSeekPendingSafety()
    this._seekPending = false
    if (this._currentVideoName && typeof cur === 'number') {
      const p = Math.floor(cur)
      this._lastVideoTime = cur
      // 立即按当前位置落盘，确保 storage 与播放进度一致（避免后续 timeupdate 节流期间异常退出导致丢失）
      this._saveVideoPosition(this._currentVideoName, p)
      this._lastSavedPosition = p
      this._lastPositionSave = Date.now()
      console.log('[video] seek 完成，落盘位置 →', p, 's')
    }
  },

  // 把 delta 累积到内存缓冲；超过 5s 或显式调用 _flushWatchBuffer 时落盘到 storage
  _addWatchedSeconds(name, delta) {
    if (!name || !delta || delta <= 0) return
    if (!this._watchBuffer) this._watchBuffer = {}
    this._watchBuffer[name] = (this._watchBuffer[name] || 0) + delta
    const now = Date.now()
    if (!this._lastFlush || now - this._lastFlush >= 5000) {
      this._flushWatchBuffer()
      this._lastFlush = now
    }
  },

  // 立即把内存缓冲写入 storage
  _flushWatchBuffer() {
    if (!this._watchBuffer) return
    const map = this._getWatchedMap()
    let changed = false
    Object.keys(this._watchBuffer).forEach((name) => {
      const delta = this._watchBuffer[name]
      if (!delta) return
      if (!map[name]) map[name] = { seconds: 0 }
      let total = (map[name].seconds || 0) + delta
      // 已观看时长不超过视频总时长：达到总时长后不再累加（总时长未知时不限制）
      const durSec = this._videoTotalSeconds(name, map)
      if (durSec > 0 && total > durSec) total = durSec
      map[name].seconds = total
      changed = true
    })
    if (changed) this._saveWatchedMap(map)
    this._watchBuffer = {}
  },

  // 清空单个视频的观看缓存（已观看时长 + 上次播放位置），用于测试断点续播与重置进度
  resetWatched(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const video = this.data.training && this.data.training.videos[idx]
    if (!video || !video.name) return
    const map = this._getWatchedMap()
    if (!map[video.name]) {
      wx.showToast({ title: '该视频暂无观看记录', icon: 'none' })
      return
    }
    delete map[video.name]
    this._saveWatchedMap(map)
    // 如果当前正在播放该视频，重置内存中累积缓冲与续播标志，避免立即又写回去
    if (this._currentVideoName === video.name) {
      this._watchBuffer = null
      this._lastFlush = 0
      this._lastPositionSave = 0
      this._lastSavedPosition = 0
      this._seekPending = false
      this._clearResumeSeek()
    }
    wx.showToast({ title: '已重置观看时长', icon: 'success' })
    this._refresh()
  },

  // 视频总时长（秒）——「已观看 ≤ 总时长」封顶与「已学完」判定的唯一口径。
  // 优先级：① 播放器上报过并已落盘的真实时长（最可靠）
  //         ② 当前播放器实时上报的时长
  //         ③ 培训视频列表里的接口元数据时长
  // 为什么播放器真实时长优先于元数据：元数据可能缺失，也可能与实际文件不一致
  //   （如元数据 10:00、实际 08:42）。若判定只用元数据，就会出现
  //   「已观看已等于视频真实时长，状态却还是学习中」。
  // 三者都拿不到（时长未知）返回 0，调用方据此跳过封顶与完成度判定。
  _videoTotalSeconds(name, watchedMap) {
    if (!name) return 0
    // ① 已记录的真实时长（可选传入 watchedMap，避免循环里反复读 storage）
    const map = watchedMap || this._getWatchedMap()
    const known = Number((map[name] || {}).duration)
    if (isFinite(known) && known > 0) return Math.floor(known)
    // ② 正在播放该视频：直接取播放器上报的真实时长
    if (name === this._currentVideoName) {
      const d = Number(this.data.videoPlayer.duration)
      if (isFinite(d) && d > 0) return Math.floor(d)
    }
    // ③ 退到接口元数据
    const videos = (this.data.training && this.data.training.videos) || []
    for (let i = 0; i < videos.length; i++) {
      if (videos[i].name === name) {
        const d = this._parseDuration(videos[i].duration)
        if (d > 0) return d
        break
      }
    }
    return 0
  },

  // 记录播放器上报的真实时长并落盘：接口元数据缺失/不准时，卡片的状态与进度都依赖它。
  // 同值不写，避免 storage 抖动。
  _saveVideoDuration(name, dur) {
    const d = Math.floor(Number(dur) || 0)
    if (!name || !(d > 0)) return
    const map = this._getWatchedMap()
    if (!map[name]) map[name] = { seconds: 0 }
    if (map[name].duration === d) return
    map[name].duration = d
    this._saveWatchedMap(map)
    console.log('[video] 记录真实时长：', name, '→', d, 's')
  },

  // 把秒数格式化为 MM:SS
  _formatSeconds(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0))
    const m = Math.floor(s / 60)
    const r = s % 60
    return (m < 10 ? '0' + m : '' + m) + ':' + (r < 10 ? '0' + r : '' + r)
  },

  // 解析时长字符串为秒：支持 "HH:MM:SS" / "MM:SS" / 纯秒数；解析失败返回 0
  _parseDuration(s) {
    if (s == null) return 0
    const str = String(s).trim()
    if (!str) return 0
    const parts = str.split(':').map(p => parseInt(p, 10))
    if (parts.length === 0 || parts.some(n => Number.isNaN(n))) return 0
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    if (parts.length === 1) return parts[0]
    return 0
  },

  // 解析视频可访问地址：后端文件统一通过 /file/download?url=<原始地址> 转发下载，
  // 原始地址需 URL 编码（含 /、?、&、: 等保留字符）。
  // 若已是带 /file/download?url= 的完整地址则原样返回，避免重复包装。
  _resolveVideoUrl(video) {
    if (!video || !video.url) return ''
    let url = String(video.url).trim()
    if (!url) return ''
    if (/file\/download\?url=/.test(url)) return url
    // 直连模式（见 VIDEO_PLAY_DIRECT）：原始地址本身可访问时直接播放，才能拖动定位
    if (VIDEO_PLAY_DIRECT && /^https?:\/\//i.test(url)) return url
    const base = BASE.replace(/\/+$/, '')
    return base + '/file/download?url=' + encodeURIComponent(url)
  },

  // 从培训详情数据中解析考试信息 id（examInfoId）：用于考试页调用 /system/exam_info/detail/{id} 拉取题目。
  // 兼容字段挂在 trainingInfo 内或响应顶层；都取不到时在 _remoteDetail 内浅层搜索同名字段。
  // 缺失时返回空串（考试页回退本地题库）。
  _pickExamId() {
    const root = this._remoteDetail
    if (!root) return ''
    const info = root.trainingInfo
    const direct = (info && info.examInfoId) || root.examInfoId
    if (direct != null && direct !== '') return direct
    return this._findKeyDeep(root, 'examInfoId', 0)
  },

  // 在对象内部（深度 ≤ 3）查找名为 key 且非空的字段值
  _findKeyDeep(obj, key, depth) {
    if (!obj || typeof obj !== 'object' || depth > 3) return ''
    if (!Array.isArray(obj) && obj[key] != null && obj[key] !== '') return obj[key]
    const names = Object.keys(obj)
    for (let i = 0; i < names.length; i++) {
      const child = obj[names[i]]
      if (child && typeof child === 'object') {
        const found = this._findKeyDeep(child, key, depth + 1)
        if (found !== '' && found != null) return found
      }
    }
    return ''
  },

  // 去考试（与平台准入安全考试为同一场）
  goExam() {
    if (!this.data.canExam) return
    // 远程培训详情尚未就绪：先补拉（拿到 examInfoId 再跳转）。仅重试一次，避免请求失败时反复弹 loading。
    if (!this._remoteDetail && !this._examLoadTried) {
      this._examLoadTried = true
      wx.showLoading({ title: '加载中', mask: true })
      this._loadSafetyDetail().then(() => {
        wx.hideLoading()
        this.goExam()
      })
      return
    }
    const info = this._remoteDetail && this._remoteDetail.trainingInfo
    // 考试时长以详情接口 examMinute（单位：分钟）为准，通过 URL 传给考试页。
    // 缺字段时不再带 minute，交给考试页走默认 30 分钟（保持旧行为）
    const minute = info && info.examMinute
    const minuteQS = (minute != null && minute !== '') ? ('&minute=' + encodeURIComponent(minute)) : ''
    // 考试 id 透传给考试页，由考试页请求 /system/exam_info/detail/{id} 渲染题目
    const examId = this._pickExamId()
    const examIdQS = examId !== '' ? ('&examId=' + encodeURIComponent(examId)) : ''
    console.log('[goExam] examInfoId =', examId || '(空)', '| trainingInfo 字段 =', info ? Object.keys(info) : '(远程详情未加载)')
    const doGo = () => wx.navigateTo({ url: '/pages/onboarding/exam/exam?from=training' + minuteQS + examIdQS })
    // 已通过考试（最新考试记录 state=1）：再次进入需二次确认
    const rec = this.data.examRecord
    if (rec && rec.state === 1) {
      wx.showModal({
        title: '重新参加考试',
        content: `您已通过本场考试${rec.scoreText ? '（' + rec.scoreText + '）' : ''}，确认需要重新考试吗？`,
        confirmText: '重新考试',
        cancelText: '取消',
        confirmColor: '#33ADDE',
        success: (res) => { if (res.confirm) doGo() }
      })
      return
    }
    doGo()
  }
})
