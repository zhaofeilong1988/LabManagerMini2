// pages/approval/index.js —— 准入审批
//   待审核 tab：POST /system/apply_user/api/list?pageNum=&pageSize=  body { stateList: [0, 4] }
//     stateList 固定为 [0（待初审）, 4（已初审待终审）]，不再依赖 /system/apply_user/detail 的 perms；
//     后端按登录人 token 过滤其有权限的数据，前端少一次请求
//     每条记录的状态取行内 state
//   待审核详情：GET /system/apply_user/apply/detail?id={id}（点击列表时才发起）
//   审批记录 tab：GET /system/approval/myList?businessType=1&token={登录人 token}
const {
  getApprovalList, getMyApprovalList, getApplyDetailByIdKeepToken, getAuditStateList,
  getAuditStatesFromCache,
  auditApplyUser, initApplyUser, clearApplyUserDetailCache, BASE, APPROVAL_PAGE_SIZE, uploadFile
} = require('../../utils/api.js')
const { getOpenId } = require('../../utils/auth.js')

// 准入类型映射：与登记页一致（1=院内，2=院外）
function typeTextOf(t) {
  const n = Number(t)
  if (n === 1) return '院内人员'
  if (n === 2) return '院外人员'
  if (n === 3) return '校外人员'
  return t == null || t === '' ? '' : String(t)
}

// 时间格式化：后端常见返回 createTime/create_time 等，统一转 yyyy-MM-dd HH:mm
function fmtTime(s) {
  if (!s) return ''
  const m = String(s).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{1,2}))?/)
  if (!m) return String(s)
  return m[1] + '-' + (m[2].length < 2 ? '0' + m[2] : m[2]) + '-' + (m[3].length < 2 ? '0' + m[3] : m[3]) +
    ' ' + (m[4].length < 2 ? '0' + m[4] : m[4]) + ':' + (m[5].length < 2 ? '0' + m[5] : m[5])
}

// 取对象里多候选字段中的第一个非空值
function pick(it, keys) {
  if (!it || typeof it !== 'object') return ''
  for (let i = 0; i < keys.length; i++) {
    const v = it[keys[i]]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

// 待审核列表里申请单的状态标签：
//   state=0（已提交，待初审）→ 待审核
//   state=4（已初审，待终审）→ 已初审
const PENDING_TAG = {
  '0': { text: '待审核', cls: 'tag-warning' },
  '1': { text: '待审核', cls: 'tag-warning' },
  '2': { text: '已通过', cls: 'tag-success' },
  '3': { text: '已驳回', cls: 'tag-danger' },
  '4': { text: '已初审', cls: 'tag-info' }
}

// 待审核列表查询的 state 集合（body 里的 stateList）：
//   0 = 待初审（需 system:apply_user:init） / 4 = 已初审待终审（需 system:apply_user:audit）
// 是否按权限计算 stateList：
//   true（默认）= 用权限换算：只有 init → [0]；只有 audit → [4]；两者都有 → [0, 4]
//     权限取全局缓存（每次 /system/apply_user/detail 调用都会刷新），命中缓存不额外发请求；
//     仅当缓存为空（冷启动、还没查过权限）时才补拉一次，并写入全局缓存供后续复用
//   false      = 固定 [0, 4]，完全不看权限
const PENDING_STATE_BY_PERM = true

// 权限取不到时的兜底 state 集合（0 = 待初审 / 4 = 已初审待终审）
const PENDING_STATE_LIST = [0, 4]

// 详情底部「驳回 / 通过」按钮是否严格按权限码显示：
//   true（当前生效）= 按权限码校验：打开详情时按需查一次 /system/apply_user/detail 取 perms，
//                   init → 可审 state=0；audit → 可审 state=4（有权限才能在详情里做终审）
//                   待审核「列表」仍不请求该接口，只在进入详情时才查（结果缓存在 _auditStates）
//   false         = 只按状态判定（state=0 待初审 / state=4 已初审 → 显示按钮，由后端按 token 鉴权），
//                   全流程不再请求 /system/apply_user/detail
const AUDIT_BTN_BY_PERM = true

// 详情页「申请状态」一行的文字颜色类：已通过绿色 / 已驳回红色 / 已初审蓝色 / 待审核橙色
const STATUS_VAL_CLS = {
  'tag-warning': 'st-warn',
  'tag-success': 'st-pass',
  'tag-danger': 'st-reject',
  'tag-info': 'st-info'
}

// 取申请单状态：只认 state / applyState / apply_state，不取 status
// （status 在 RuoYi 里是「记录状态 0正常/1停用」，会污染审批状态判定）
// 取不到返回 null
function pickApplyState() {
  for (let i = 0; i < arguments.length; i++) {
    const src = arguments[i]
    if (!src || typeof src !== 'object') continue
    const v = pick(src, ['state', 'applyState', 'apply_state'])
    if (v !== '') {
      const n = Number(v)
      if (!isNaN(n)) return n
    }
  }
  return null
}

// 默认材料模板（字典 / 文档模板接口失败时兜底）
const DEFAULT_DOCS = [
  { docType: 1, name: '平台使用申请书', desc: '需本人、导师/主任签字，拍摄完整签字页', required: true },
  { docType: 2, name: '安全承诺书', desc: '需本人签字，拍摄完整内容及签字部分', required: true },
  { docType: 3, name: '知识产权共享承诺书', desc: '需本人签字，院外人员还需导师/合作老师签字', required: true },
  { docType: 4, name: '合作证明文件', desc: '仅院外人员必传，院内人员可跳过', required: false }
]

// 字典数组 → { value: label } 映射，兼容 RuoYi(dictValue/dictLabel) 与常见字段
function toDictMap(dictList) {
  const map = {}
  ;(dictList || []).forEach((d) => {
    if (!d || typeof d !== 'object') return
    const value = d.dictValue !== undefined ? d.dictValue
      : (d.value !== undefined ? d.value : (d.code !== undefined ? d.code : d.key))
    const label = d.dictLabel || d.label || d.name || d.text
    if (value !== undefined && value !== null && label) map[String(value)] = label
  })
  return map
}

// 文档扩展名判断（图片以外的常见文档格式）
function isDocUrl(url) {
  return /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|zip|rar)(\?|$)/i.test(String(url || ''))
}

// 从文件地址中解析文件名（去掉查询参数并解码）
function fileNameFromUrl(url) {
  const raw = String(url || '').split('?')[0].split('/').pop() || ''
  try { return decodeURIComponent(raw) } catch (e) { return raw }
}

// 取扩展名（小写、不含点）
function fileExt(name) {
  const parts = String(name || '').split('?')[0].split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

// 相对路径补全为完整地址
function toFullUrl(url) {
  if (!url) return ''
  if (/^https?:\/\//i.test(url) || url.indexOf('data:') === 0) return url
  return BASE + (url.charAt(0) === '/' ? url : '/' + url)
}

// 把单个附件地址统一规范成视图对象
function normalizeFile(url) {
  if (typeof url === 'string') {
    const full = toFullUrl(url)
    const isFile = isDocUrl(url)
    return {
      origin: full,
      thumb: full,
      isImage: !isFile,
      isFile,
      fileName: fileNameFromUrl(url),
      ext: fileExt(url)
    }
  }
  const u = url || {}
  const origin = toFullUrl(u.origin || u.url || u.fileUrl || u.path || u.thumb || '')
  const thumb = toFullUrl(u.thumb || u.preview || origin)
  const isFile = u.isFile || isDocUrl(origin)
  const fileName = u.fileName || fileNameFromUrl(origin)
  return {
    origin,
    thumb,
    isImage: !isFile,
    isFile,
    fileName,
    ext: u.ext || fileExt(fileName)
  }
}

// 把接口原始条目转成视图行：兼容 applyUser 平铺 与 { applyUser: {...} } 包裹 两种结构
function buildRow(it) {
  if (!it || typeof it !== 'object') return null
  const body = (it.applyUser && typeof it.applyUser === 'object') ? it.applyUser : it
  const id = pick(it, ['id', 'applyId', 'apply_id', 'userId', 'user_id'])
    || pick(body, ['id', 'userId', 'user_id'])
  // openId 单独取：列表里可能与 id 不同，仅用于展示/兜底，详情已改为按 id 查询
  const openId = pick(it, ['openId', 'openid', 'open_id'])
    || pick(body, ['openId', 'openid', 'open_id'])
  const name = pick(body, ['name', 'userName', 'user_name', 'nickname', 'nickName'])
  const typeRaw = pick(body, ['type', 'userType', 'user_type'])
  const dept = pick(body, ['deptName', 'dept_name', 'teamName', 'team_name', 'department'])
  const team = pick(body, ['teamName', 'team_name'])
  const company = pick(body, ['company', 'unit', 'workUnit', 'work_unit'])
  const supervisor = pick(body, ['teacherName', 'teacher_name', 'supervisor', 'teacher', 'tutorName', 'tutor_name'])
  const createTime = pick(it, ['createTime', 'create_time', 'applyTime', 'apply_time', 'submitTime', 'submit_time'])
    || pick(body, ['createTime', 'create_time', 'applyTime', 'apply_time'])
  const score = pick(it, ['score', 'examScore', 'exam_score', 'safetyScore'])
    || pick(body, ['score', 'examScore', 'exam_score'])
  // 申请单当前状态（0=待初审 / 4=已初审待终审 …）：决定审批接口与状态标签
  // 一次查询可能同时包含 state 0 与 4，状态一律以行内 state 为准；取不到为 null（渲染兜底「待审核」）
  const rowState = pickApplyState(it, body)
  const tag = PENDING_TAG[String(rowState)] || { text: '待审核', cls: 'tag-warning' }
  // 类型行：「院外人员 · XX大学」形式，有 company 就拼，没有就只显示类型
  const t = typeTextOf(typeRaw)
  const org = team || dept || company
  const typeLine = t ? (org ? (t + ' · ' + org) : t) : (org || '')
  // meta：申请时间 + 安全考试分数（若有）
  const timeText = fmtTime(createTime)
  const metaParts = []
  if (timeText) metaParts.push('申请时间：' + timeText)
  if (score !== '' && score != null) {
    metaParts.push('安全考试 ' + score + ' 分')
  }
  // 详情字段（点击进入详情时使用）
  return {
    id: String(id || openId || (name + '_' + (createTime || Math.random()))),
    openId: openId || '',
    state: rowState,
    name: name || '--',
    statusText: tag.text,
    statusClass: tag.cls,
    typeText: typeLine,
    meta: metaParts.join(' · ') || '申请已提交，等待审批',
    identity: t,
    unit: org || '--',
    supervisor: supervisor || '--',
    time: timeText || '--',
    score: score === '' || score == null ? null : Number(score),
    materials: []
  }
}

// 审批记录状态 → 标签：兼容数字（2通过 / 3驳回 / 4已初审 / 0、1待审核）与文字两种返回
function recordStatusOf(v) {
  const s = String(v == null ? '' : v).trim()
  if (s === '2' || s === 'pass' || s === 'approved' || s === 'agree' || s.indexOf('通过') >= 0) {
    return { text: '已通过', cls: 'tag-success' }
  }
  if (s === '3' || s === 'reject' || s === 'rejected' || s.indexOf('驳回') >= 0) {
    return { text: '已驳回', cls: 'tag-danger' }
  }
  if (s === '4' || s.indexOf('初审') >= 0) return { text: '已初审', cls: 'tag-info' }
  if (s === '0' || s === '1' || s.indexOf('待') >= 0) return { text: '待审核', cls: 'tag-warning' }
  return { text: s || '已处理', cls: 'tag-info' }
}

// 把 /system/approval/myList 返回的单条审批记录转成列表视图行
// 结构未知，字段名按常见候选兼容取；状态优先取审批结果字段
function buildRecordRow(it) {
  if (!it || typeof it !== 'object') return null
  const body = (it.applyUser && typeof it.applyUser === 'object') ? it.applyUser : it
  // 「审批记录」列表里需要进一步进入申请单详情时，是按申请单 id 调 /system/apply_user/apply/detail；
  // 而 myList 返回的顶层 id 是「审批操作记录 id」，与申请单 id 并不相同。
  // 因此必须优先取 applyUser.id（申请单 id），仅在 applyUser 缺失等兜底场景才回退到顶层 id。
  const id = pick(body, ['id', 'applyId', 'apply_id'])
    || pick(it, ['applyId', 'apply_id', 'businessId', 'business_id', 'userId', 'user_id'])
  const openId = pick(it, ['openId', 'openid', 'open_id']) || pick(body, ['openId', 'openid', 'open_id'])
  const name = pick(it, ['name', 'userName', 'user_name', 'applyUserName', 'applicantName', 'nickname'])
    || pick(body, ['name', 'userName', 'user_name', 'nickname'])
  const typeRaw = pick(it, ['type', 'userType', 'user_type']) || pick(body, ['type', 'userType', 'user_type'])
  const org = pick(it, ['deptName', 'dept_name', 'teamName', 'team_name', 'company', 'unit'])
    || pick(body, ['deptName', 'dept_name', 'teamName', 'team_name', 'company', 'unit'])
  // 状态：取返回数据里 applyUser.state（与待审核列表同一套语义）
  //   0=待初审 / 4=已初审 / 2=已通过 / 3=已驳回；applyUser 里取不到再回退顶层同名字段
  const stateRaw = pickApplyState(body, it)
  const status = recordStatusOf(stateRaw)
  const time = fmtTime(pick(it, ['approveTime', 'approve_time', 'auditTime', 'audit_time',
    'updateTime', 'update_time', 'createTime', 'create_time']))
  const remark = pick(it, ['remark', 'reason', 'auditRemark', 'audit_remark', 'comment'])
  const t = typeTextOf(typeRaw)
  const typeLine = t ? (org ? (t + ' · ' + org) : t) : (org || '')
  const metaParts = []
  if (time) metaParts.push(time)
  if (remark) metaParts.push(remark)
  return {
    id: String(id || openId || (name + '_' + (time || Math.random()))),
    openId: openId || '',
    state: stateRaw,
    name: name || '--',
    statusText: status.text,
    statusClass: status.cls,
    typeText: typeLine,
    meta: metaParts.join(' · ') || '审批已处理',
    identity: t,
    unit: org || '--',
    time: time || '--',
    score: null,
    materials: []
  }
}

// 把 GET /system/apply_user/apply/detail 返回的 { applyUser, attachmentList, raw } 拼装成详情视图模型
// 材料分组的名称直接用内置模板 DEFAULT_DOCS（不再请求 doc_info / 字典，减少列表页请求）
function buildDetailFromApi(applyUser, attachmentList, raw, fallbackItem, canAudit) {
  const a = (applyUser && typeof applyUser === 'object') ? applyUser : {}
  const name = pick(a, ['name', 'userName', 'user_name', 'nickname', 'nickName'])
    || (fallbackItem && fallbackItem.name) || '--'
  const typeRaw = pick(a, ['type', 'userType', 'user_type'])
  const userType = Number(typeRaw)
  const identity = typeTextOf(typeRaw)
    || (fallbackItem && fallbackItem.identity) || '--'
  const dept = pick(a, ['deptName', 'dept_name', 'teamName', 'team_name', 'department'])
  const team = pick(a, ['teamName', 'team_name'])
  const company = pick(a, ['company', 'unit', 'workUnit', 'work_unit'])
  const unit = dept || team || company || (fallbackItem && fallbackItem.unit) || '--'
  const supervisor = pick(a, ['teacherName', 'teacher_name', 'supervisor', 'teacher', 'tutorName', 'tutor_name'])
    || (fallbackItem && fallbackItem.supervisor) || '--'
  const phone = pick(a, ['phone', 'phonenumber', 'phoneNumber', 'mobile'])
  const teacherPhone = pick(a, ['teacherPhone', 'teacher_phone', 'teacherMobile'])
  const email = pick(a, ['email', 'mail'])
  const sex = pick(a, ['sex', 'gender'])
  const technicalTitle = pick(a, ['technicalTitle', 'technical_title', 'title'])
  const userNo = pick(a, ['user_no', 'userNo', 'workNo', 'work_no'])
  const profession = pick(a, ['profession', 'major'])
  const projectName = pick(a, ['projectName', 'project_name'])
  const researchDir = pick(a, ['researchDirection', 'research_direction', 'direction'])
  const time = fmtTime(pick(a, ['createTime', 'create_time', 'applyTime', 'apply_time']))
    || (fallbackItem && fallbackItem.time) || '--'

  // ── 审批材料：按 docType 归类（名称/说明/必填取自内置 DEFAULT_DOCS 模板）──
  // docType 与字典 dictValue 均按字符串匹配：attachmentList.docType ↔ docMetaMap key
  // dictMap 保留结构：后续若重新接入 sign_up_doc 字典，把 { 值: 标签 } 填进来即可
  const dictMap = {}

  // 把任意 docType 规范成字符串（兼容数字 / 字符串 / 前后空格）
  const normDt = (v) => {
    if (v === undefined || v === null) return ''
    return String(v).trim()
  }

  // 材料模板全部来自内置 DEFAULT_DOCS（不再请求字典 / doc_info）
  const docMetaMap = new Map()
  DEFAULT_DOCS.forEach(d => docMetaMap.set(normDt(d.docType), { ...d, docType: normDt(d.docType) }))
  Object.keys(dictMap).forEach(key => {
    if (!key) return
    const existing = docMetaMap.get(key) || { docType: key, name: '', desc: '', required: false }
    docMetaMap.set(key, { ...existing, docType: key, name: dictMap[key] })
  })

  // 按用户类型决定必传 docType（字符串形式）：1=院内（1/2/3），2=院外（1/2/3/4）
  const requiredTypes = userType === 2 ? ['1', '2', '3', '4'] : ['1', '2', '3']

  // 把 attachmentList 按 docType 字符串分组
  const groups = {}
  ;(attachmentList || []).filter(it => it && typeof it === 'object').forEach(it => {
    const dt = normDt(it.docType !== undefined ? it.docType : (it.doc_type !== undefined ? it.doc_type : it.type))
    if (!dt) return
    const urls = Array.isArray(it.urls) ? it.urls
      : (Array.isArray(it.files) ? it.files : (it.url ? [it.url] : []))
    if (!groups[dt]) groups[dt] = []
    urls.forEach(u => {
      if (typeof u === 'string') groups[dt].push(u)
      else if (u && typeof u === 'object') groups[dt].push(u)
    })
  })

  // 组装展示分组：已定义的材料模板在前，未定义的附件分组补充在后
  const materialGroups = []
  docMetaMap.forEach((metaItem, dt) => {
    const files = (groups[dt] || []).map(normalizeFile)
    materialGroups.push({
      docType: dt,
      name: metaItem.name,
      required: requiredTypes.indexOf(dt) >= 0,
      desc: metaItem.desc,
      countText: files.length + '/3 份',
      files
    })
  })
  Object.keys(groups).forEach(key => {
    if (docMetaMap.has(key)) return
    const files = groups[key].map(normalizeFile)
    materialGroups.push({
      docType: key,
      name: dictMap[key] || ('材料-' + key),
      required: requiredTypes.indexOf(key) >= 0,
      desc: '',
      countText: files.length + '/3 份',
      files
    })
  })
  // 排序：docType 是数字字符串时按数字升序，否则按字符串序
  materialGroups.sort((a, b) => {
    const na = Number(a.docType), nb = Number(b.docType)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return String(a.docType).localeCompare(String(b.docType))
  })

  // 考试记录：从 raw / applyUser 兼容位置取 validExam / examRecord / exam_record / safetyExam
  // 字段：markingTime（通过时间）、totalScore（总分）、score（考生得分）、hasValid（是否获得证书）
  // 兼容嵌套：{ validExam: { examRecord: { ... } } } 或 { validExam: { markingTime, totalScore, ... } }
  const examOuter = (raw && (raw.validExam || raw.examRecord || raw.exam_record || raw.safetyExam))
    || a.validExam || a.examRecord || a.exam_record || a.safetyExam
  const examRaw = (examOuter && examOuter.examRecord && typeof examOuter.examRecord === 'object')
    ? examOuter.examRecord
    : examOuter
  let examRecord = null
  if (examRaw && typeof examRaw === 'object') {
    const markingTime = fmtTime(pick(examRaw,
      ['markingTime', 'marking_time', 'passTime', 'pass_time', 'reviewTime', 'review_time',
       'createTime', 'create_time', 'submitTime', 'submit_time', 'endTime', 'end_time']))
    const totalScoreRaw = pick(examRaw, ['totalScore', 'total_score', 'fullScore', 'full_score', 'maxScore', 'max_score'])
    const totalScore = totalScoreRaw !== '' && totalScoreRaw != null ? Number(totalScoreRaw) : null
    const scoreRaw = pick(examRaw, ['score', 'examScore', 'exam_score', 'userScore', 'user_score'])
    const scoreVal = scoreRaw !== '' && scoreRaw != null ? Number(scoreRaw) : null
    const hasValidRaw = pick(examRaw, ['hasValid', 'has_valid', 'isValid', 'valid', 'passed', 'pass', 'isPass', 'is_pass', 'qualified'])
    const hasValid = hasValidRaw === true
      || hasValidRaw === 'true' || hasValidRaw === 1 || hasValidRaw === '1'
      || hasValidRaw === 'pass' || hasValidRaw === 'passed'
      || (hasValidRaw === false || hasValidRaw === 'false' || hasValidRaw === 0 || hasValidRaw === '0' ? false : null)
    examRecord = {
      markingTime: markingTime || '',
      totalScore: (totalScore !== null && !isNaN(totalScore)) ? totalScore : null,
      score: (scoreVal !== null && !isNaN(scoreVal)) ? scoreVal : null,
      hasValid: hasValid === null
        // 没显式给出时，按「有分数且分数>0」推断
        ? ((scoreVal !== null && !isNaN(scoreVal) && scoreVal > 0) ? true : null)
        : hasValid
    }
  } else {
    // 无 examRecord 对象，尝试从根 / applyUser 直接拿顶层字段
    const scoreRaw = pick(a, ['score', 'examScore', 'exam_score', 'safetyScore'])
    const scoreVal = scoreRaw !== '' && scoreRaw != null ? Number(scoreRaw) : null
    const hasValidRaw = pick(a, ['hasValid', 'has_valid', 'isValid', 'valid'])
    const hasValid = (hasValidRaw === true || hasValidRaw === 'true' || hasValidRaw === 1 || hasValidRaw === '1')
    if (scoreVal !== null || hasValid) {
      examRecord = {
        markingTime: '',
        totalScore: null,
        score: scoreVal,
        hasValid: hasValid || ((scoreVal !== null && scoreVal > 0) ? true : null)
      }
    }
  }

  // 兜底：fallbackItem 里有 score 时也补一份
  if (!examRecord && fallbackItem && fallbackItem.score != null) {
    examRecord = {
      markingTime: '',
      totalScore: null,
      score: Number(fallbackItem.score) || null,
      hasValid: null
    }
  }

  // 调用 /system/apply_user/api/audit 时需要的字段，直接挂在 detail 上供按钮回调使用
  const auditParams = {
    id: pick(a, ['id', 'applyId', 'apply_id']) || (fallbackItem && fallbackItem.id) || '',
    deptId: pick(a, ['deptId', 'dept_id']),
    deptName: pick(a, ['deptName', 'dept_name', 'department']),
    type: pick(a, ['type', 'applyType', 'apply_type']),
    userType: pick(a, ['userType', 'user_type'])
  }

  // 申请单当前状态：先取详情里的 state，没有则沿用列表行里的（决定审批接口与 state 取值）
  const curState = (pickApplyState(a) != null)
    ? pickApplyState(a)
    : ((fallbackItem && fallbackItem.state) != null ? fallbackItem.state : null)

  const tag = PENDING_TAG[String(curState)] || { text: '待审核', cls: 'tag-warning' }

  return {
    id: (fallbackItem && fallbackItem.id) || '',
    openId: pick(a, ['openId', 'openid', 'open_id']) || (fallbackItem && fallbackItem.openId) || '',
    state: curState,
    statusText: tag.text,
    statusClass: tag.cls,
    statusValClass: STATUS_VAL_CLS[tag.cls] || 'st-warn',
    name,
    identity,
    unit,
    supervisor,
    phone,
    teacherPhone,
    email,
    sex,
    technicalTitle,
    userNo,
    profession,
    projectName,
    researchDir,
    time,
    materialGroups,
    examRecord,
    score: examRecord ? examRecord.score : null,
    auditParams,
    // 是否展示「通过 / 驳回」按钮：
    //   state=2 已通过 / state=3 已驳回 → 已是终态，不可再审批
    //   审批记录 tab 进来的详情（canAudit=false）→ 只查看
    canAudit: canAudit !== false && curState !== 2 && curState !== 3
  }
}

Page({
  data: {
    view: 'list',          // list | detail
    tab: 'pending',        // pending | done
    pendingList: [],       // 待审核：接口拉取
    pendingLoading: true,  // 接口请求中
    pendingError: false,   // 接口失败
    pendingErrorMsg: '',
    // ── 待审核分页（POST /system/apply_user/api/list?pageNum=&pageSize=）──
    pendingPageNum: 1,                        // 当前页码
    pendingPageSize: APPROVAL_PAGE_SIZE || 10, // 每页条数
    pendingTotal: 0,                          // 总条数
    pendingHasMore: false,                    // 是否还有下一页
    pendingLoadingMore: false,                // 正在加载下一页（底部展示「加载中…」）
    doneList: [],          // 审批记录：/system/approval/myList 拉取
    doneLoading: false,    // 审批记录请求中
    doneError: false,      // 审批记录接口失败
    doneErrorMsg: '',
    // ── 审批记录分页（GET /system/approval/myList?businessType=1&pageNum=&pageSize=）──
    donePageNum: 1,                           // 当前页码
    donePageSize: APPROVAL_PAGE_SIZE || 10,   // 每页条数
    doneTotal: 0,                             // 总条数
    doneHasMore: false,                       // 是否还有下一页
    doneLoadingMore: false,                   // 正在加载下一页
    list: [],              // 当前 tab 渲染的列表（由 setTabData 计算后塞入）
    detail: {},
    detailLoading: false,  // 详情接口请求中
    detailError: false,    // 详情接口失败
    detailErrorMsg: '',
    docInfoList: [],       // /system/doc_info/get 返回的准入材料模板
    materialDict: [],      // sign_up_doc 字典原始数组
    materialMetaLoaded: false,
    // ── 自定义驳回弹窗（基于 van-dialog + textarea） ──
    // focus       控制 textarea 聚焦（弹窗第一次 show 时延时打开软键盘）
    // placeholderVisible 提示文案是否显示：focus / 有值 时隐藏，blur 且空值时恢复
    rejectDialog: {
      show: false,
      focus: false,
      reason: '',
      placeholderVisible: true
    },
    // ── 终审签字弹层（手写签名 → 上传图片 → audit 接口 signPic） ──
    //   show    弹层显隐 / hasInk 是否已落笔（未落笔不允许确认）/ saving 上传提交中
    sign: {
      show: false,
      hasInk: false,
      saving: false
    }
  },

  // 审批记录：GET /system/approval/myList?businessType=1&token={token}&pageNum={pn}&pageSize={size}
  // 首次切到该 tab 时拉取一次；审批提交成功后置 _doneDirty，下次进入该 tab 重新拉取
  // 分页：pageNum=1 → 重置列表；pageNum>1 → 追加（上拉加载更多）
  _loadDone(pageNum) {
    const pn = Number(pageNum) > 0 ? Number(pageNum) : 1
    const isFirst = pn === 1
    if (isFirst) {
      this.setData({ doneLoading: true, doneError: false, doneErrorMsg: '' })
    } else {
      this.setData({ doneLoadingMore: true })
    }
    console.log('[approval] 发起 /system/approval/myList，pageNum =', pn, ', pageSize =', this.data.donePageSize)
    return getMyApprovalList({ pageNum: pn, pageSize: this.data.donePageSize })
      .then(res => {
        const page = res || { rows: [], total: 0, hasMore: false }
        const rows = (page.rows || []).map(it => buildRecordRow(it)).filter(Boolean)
        console.log('[approval] /system/approval/myList 返回，本页 =', rows.length,
          ', total =', page.total, ', hasMore =', page.hasMore)
        // 第一页覆盖，后续页追加
        this.doneList = isFirst ? rows : (this.doneList || []).concat(rows)
        this._doneLoaded = true
        this._doneDirty = false
        const patch = {
          donePageNum: pn,
          doneTotal: page.total || 0,
          doneHasMore: !!page.hasMore,
          doneLoading: false,
          doneLoadingMore: false,
          doneError: false
        }
        if (this.data.tab === 'done' && this.data.view === 'list') patch.list = this.doneList
        this.setData(patch)
      })
      .catch(err => {
        console.error('[approval] /system/approval/myList 失败：', err)
        // 加载更多失败：保留已加载数据；首页失败才清空
        if (isFirst) this.doneList = []
        this._doneLoaded = true
        this._doneDirty = false
        const msg = (err && err.message) || '审批记录加载失败，请稍后重试'
        const patch = {
          doneLoading: false,
          doneLoadingMore: false,
          doneError: true,
          doneErrorMsg: msg
        }
        if (isFirst && this.data.tab === 'done' && this.data.view === 'list') patch.list = []
        this.setData(patch)
      })
      // 无论成功 / 失败都收起下拉刷新动画
      .then(() => this._endPullRefresh())
  },

  // ── 下拉刷新 ──
  // 「待审核」「审批记录」两个 tab 都支持：下拉时重新拉当前 tab 的列表
  onPullDownRefresh() {
    this._pulling = true
    // 详情态下拉不刷新列表，直接收起（避免打断当前详情阅读）
    if (this.data.view !== 'list') {
      this._endPullRefresh()
      return
    }
    if (this.data.tab === 'done') {
      // 审批记录：强制重新拉取（下拉是用户主动刷新，跳过 _doneDirty 的按需策略）
      this._doneLoaded = false
      this._loadDone()
      return
    }
    this._loadPending()
  },

  // 收起下拉刷新动画（重复调用安全）
  _endPullRefresh() {
    if (!this._pulling) return
    this._pulling = false
    wx.stopPullDownRefresh()
  },

  onLoad() {
    // 默认渲染「待审核」并发起接口请求（本页只调 /system/apply_user/api/list）
    this.setData({ tab: 'pending' })
    // 首次进入由 onLoad 拉取；onShow 紧跟其后触发，这里打标记避免同一轮重复请求
    this._firstShow = true
    this._loadPending()
  },

  onShow() {
    // 首次 show 紧跟 onLoad：列表已在 onLoad 里请求过，跳过这一次
    if (this._firstShow) {
      this._firstShow = false
      return
    }
    // 从详情返回时保持当前 tab；如果是待审核 tab，刷新一次保证最新
    if (this.data.tab === 'pending' && this.data.view === 'list') {
      this._loadPending()
    } else if (this.data.tab === 'done' && this.data.view === 'list') {
      // 审批记录：提交过审批（_doneDirty）或还没拉过才请求，避免每次返回都打接口
      if (this._doneDirty || !this._doneLoaded) this._loadDone()
      else this.setTabData('done')
    } else {
      this.setTabData(this.data.tab)
    }
  },

  // 拉取待审核列表：直接调
  //   POST /system/apply_user/api/list?pageNum={pn}&pageSize={size}，body { stateList: [0, 4] }
  // 这里不再先查 /system/apply_user/detail 拿 perms 换算 stateList：
  //   待审核列表固定按「全部待处理状态」查询（0=待初审 / 4=已初审待终审），
  //   后端按登录人 token 自行过滤其有权限的数据，前端省掉一次请求。
  // 每条记录的当前 state 由接口自带，列表按行里的 state 渲染状态标签
  // 分页：pageNum=1 → 重置列表（首次加载 / 下拉刷新）；pageNum>1 → 追加（上拉加载更多）
  _loadPending(pageNum) {
    const pn = Number(pageNum) > 0 ? Number(pageNum) : 1
    const isFirst = pn === 1
    if (isFirst) {
      this.setData({ pendingLoading: true, pendingError: false, pendingErrorMsg: '' })
    } else {
      this.setData({ pendingLoadingMore: true })
    }
    return this._resolveStateList()
      .then(stateList => {
        console.log('[approval] 发起 /system/apply_user/api/list，stateList =', stateList,
          ', pageNum =', pn, ', pageSize =', this.data.pendingPageSize)
        return getApprovalList(stateList, { pageNum: pn, pageSize: this.data.pendingPageSize })
      })
      .then(res => {
        const page = res || { rows: [], total: 0, hasMore: false }
        const rows = (page.rows || []).map(it => buildRow(it)).filter(Boolean)
        console.log('[approval] /system/apply_user/api/list 返回，本页 =', rows.length,
          ', total =', page.total, ', hasMore =', page.hasMore)
        // 第一页覆盖，后续页追加
        this.pendingList = isFirst ? rows : (this.pendingList || []).concat(rows)
        const patch = {
          pendingPageNum: pn,
          pendingTotal: page.total || 0,
          pendingHasMore: !!page.hasMore,
          pendingLoading: false,
          pendingLoadingMore: false,
          pendingError: false
        }
        // 若当前仍在待审核 tab 且处于列表态，更新渲染用的 list
        if (this.data.tab === 'pending' && this.data.view === 'list') patch.list = this.pendingList
        this.setData(patch)
      })
      .catch(err => {
        console.error('[approval] /system/apply_user/api/list 失败：', err)
        // 加载更多失败：保留已加载数据；首页失败才清空
        if (isFirst) this.pendingList = []
        const patch = {
          pendingLoading: false,
          pendingLoadingMore: false,
          pendingError: true,
          pendingErrorMsg: (err && err.message) || '审批列表加载失败，请稍后重试'
        }
        if (isFirst && this.data.tab === 'pending' && this.data.view === 'list') patch.list = []
        this.setData(patch)
      })
      // 无论成功 / 失败都收起下拉刷新动画
      .then(() => this._endPullRefresh())
  },

  // 待审核列表的 stateList：按当前用户权限换算（init→[0]，audit→[4]，两者都有→[0, 4]）
  // 权限优先读全局缓存（由每次 /system/apply_user/detail 刷新），命中就不再发请求；
  // 缓存为空时才补拉一次并写入全局缓存，后续进入列表 / 打开详情都直接命中缓存
  _resolveStateList() {
    if (!PENDING_STATE_BY_PERM) return Promise.resolve(PENDING_STATE_LIST)
    const openId = getOpenId()
    const cached = getAuditStatesFromCache(openId)
    if (cached.length) {
      this._auditStates = cached
      console.log('[approval] 命中全局权限缓存，stateList =', cached)
      return Promise.resolve(cached)
    }
    return getAuditStateList(openId)
      .then(list => {
        this._auditStates = list || []
        const states = this._auditStates.length ? this._auditStates : PENDING_STATE_LIST
        console.log('[approval] 权限缓存为空，补拉一次得到 stateList =', states)
        return states
      })
      .catch(() => PENDING_STATE_LIST)
  },

  // 上拉触底：待审核 / 审批记录两个列表都分页加载下一页
  onReachBottom() {
    if (this.data.view !== 'list') return
    if (this.data.tab === 'pending') {
      if (this.data.pendingLoading || this.data.pendingLoadingMore) return
      if (!this.data.pendingHasMore) return
      this._loadPending(this.data.pendingPageNum + 1)
      return
    }
    if (this.data.tab === 'done') {
      if (this.data.doneLoading || this.data.doneLoadingMore) return
      if (!this.data.doneHasMore) return
      this._loadDone(this.data.donePageNum + 1)
    }
  },

  // 切换 tab 时把对应列表塞到渲染用的 list 上
  setTabData(tab) {
    if (tab === 'pending') {
      // 如果还在加载中，list 暂用空数组 + loading 由 wxml 控制显示
      const list = this.pendingList || []
      this.setData({ tab, list })
    } else {
      const list = this.doneList || []
      this.setData({ tab, list })
    }
  },

  setTab(e) {
    const t = e.currentTarget.dataset.t
    if (!t) return
    if (t === 'pending' && this.data.pendingLoading) {
      // 还在加载中，也允许切换；list 保持空，由 wxml 的 loading 态展示
    }
    if (t === 'pending' && this.data.pendingError && (!this.pendingList || !this.pendingList.length)) {
      // 之前加载失败：切换时自动重试一次
      this._loadPending()
    }
    if (t === 'done' && (!this._doneLoaded || this._doneDirty)) {
      // 审批记录：首次进入或审批提交后重新拉取
      this._loadDone()
    }
    this.setTabData(t)
  },

  // 待审核：点击重试（错误态）
  onRetry() {
    this._loadPending()
  },

  // 审批记录：点击重试（错误态）
  onRetryDone() {
    this._loadDone()
  },

  // 当前登录人对某个申请单状态是否可审批：
  //   2（已通过）/ 3（已驳回）→ 终态，不可再审批
  //   审批记录 tab 进入的详情 → 只读
  //   0（待初审）/ 4（已初审待终审）→ 待处理：
  //     AUDIT_BTN_BY_PERM = false 时直接可审（不再查权限，后端按 token 鉴权）
  //     AUDIT_BTN_BY_PERM = true  时按权限码：state=0 需 init，state=4 需 audit
  _canAuditByState(state) {
    const n = Number(state)
    if (n !== 0 && n !== 4) return false
    if (this.data.tab === 'done') return false
    if (!AUDIT_BTN_BY_PERM) return true
    // 优先用全局权限缓存（/system/apply_user/detail 每次调用都会刷新它），
    // 列表流程不发请求，只在打开详情时才可能补拉一次
    const list = (Array.isArray(this._auditStates) && this._auditStates.length)
      ? this._auditStates
      : getAuditStatesFromCache(getOpenId())
    // 缓存为空（尚未查询过权限）时兜底可审，实际提交由后端按 token 拦截
    if (!Array.isArray(list) || !list.length) return true
    return list.indexOf(n) >= 0
  },

  // 确保权限集合已加载：进入详情前调用
  //   ① AUDIT_BTN_BY_PERM = false → 直接跳过，不发 /system/apply_user/detail
  //   ② 命中全局权限缓存 → 立即 resolve，不发请求
  //   ③ 缓存为空 → 查一次并写回全局缓存（同一会话内后续校验都走缓存）
  _ensureAuditStates() {
    if (!AUDIT_BTN_BY_PERM) return Promise.resolve(this._auditStates || [])
    const openId = getOpenId()
    const cached = getAuditStatesFromCache(openId)
    if (cached.length) {
      this._auditStates = cached
      return Promise.resolve(cached)
    }
    if (Array.isArray(this._auditStates) && this._auditStates.length) {
      return Promise.resolve(this._auditStates)
    }
    return getAuditStateList(openId)
      .then(list => {
        this._auditStates = list || []
        return this._auditStates
      })
      .catch(() => {
        this._auditStates = []
        return []
      })
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(x => x.id === id)
    if (!item) return
    // 待审核与审批记录的条目都可进入申请单详情；
    // 审批记录（tab=done）只用于查看，详情页不显示「驳回 / 通过」按钮
    // 先进入详情页（带过渡骨架），同时发起 /system/apply_user/apply/detail 请求
    // 列表点击时只用申请单 id 查询，不再传 openId
    const applyId = String(item.id || '').trim()
    // 占位详情（用列表里已有的基本信息填充，避免空白闪烁）
    const placeholder = {
      id: applyId,
      openId: item.openId || '',
      state: item.state != null ? item.state : null,
      // 沿用列表行的状态标签（state=4 → 已初审）
      statusText: item.statusText || '待审核',
      statusClass: item.statusClass || 'tag-warning',
      statusValClass: STATUS_VAL_CLS[item.statusClass] || 'st-warn',
      name: item.name,
      identity: item.identity,
      unit: item.unit,
      supervisor: item.supervisor,
      time: item.time,
      materialGroups: [],
      score: item.score,
      // 骨架占位：终态（2 已通过 / 3 已驳回）不显示审批按钮；其余按「状态 + 权限」判定
      canAudit: this._canAuditByState(item.state)
    }
    this.setData({
      view: 'detail',
      detail: placeholder,
      detailLoading: true,
      detailError: false,
      detailErrorMsg: ''
    })
    if (!applyId) {
      console.warn('[approval] 列表项缺少 id，无法请求 /system/apply_user/apply/detail，item =', item)
      this.setData({
        detailLoading: false,
        detailError: true,
        detailErrorMsg: '该记录缺少申请单 id，无法加载详情'
      })
      return
    }
    console.log('[approval] 发起 /system/apply_user/apply/detail，id =', applyId)
    // 用 KeepToken 版：详情接口下发的 token 只保存在 _detailToken，
    // 不写入全局，避免管理员自己的 token 被被审批人覆盖（终审 /api/audit 要用管理员 token）
    // 同时确保权限集合已就绪：详情渲染完要按「状态 + 权限」决定按钮显隐
    Promise.all([getApplyDetailByIdKeepToken(applyId), this._ensureAuditStates()])
      .then(([detailRes, states]) => {
        this._auditStates = states || []
        const { applyUser, attachmentList, raw } = detailRes
        // 响应里的 token 属于被审批人，提交审批时不能用（init / audit 要用登录人的 token）
        console.log('[approval] /system/apply_user/apply/detail 返回，applyUser =', applyUser,
          'attachmentList.length =', (attachmentList || []).length)
        // canAudit 由「申请单状态 + 当前用户权限」决定：
        //   2 已通过 / 3 已驳回 → 终态，任何权限都只读
        //   0 待初审 → 需 init 权限；4 已初审 → 需 audit 权限（有权限即可在此做终审）
        const detail = buildDetailFromApi(applyUser, attachmentList, raw, item, true)
        detail.canAudit = this._canAuditByState(detail.state)
        this.setData({
          detail,
          detailLoading: false,
          detailError: false
        })
      })
      .catch(err => {
        console.error('[approval] /system/apply_user/apply/detail 失败：', err)
        this.setData({
          detailLoading: false,
          detailError: true,
          detailErrorMsg: (err && err.message) || '详情加载失败，请稍后重试'
        })
      })
  },

  // 详情加载失败：点错误区重试
  onRetryDetail() {
    const item = this.data.detail || {}
    const applyId = String(item.id || '').trim()
    if (!applyId) {
      this.setData({
        detailLoading: false,
        detailError: true,
        detailErrorMsg: '缺少申请单 id，无法重新加载'
      })
      return
    }
    this.setData({ detailLoading: true, detailError: false, detailErrorMsg: '' })
    // 与首次进入详情保持一致：一用申请单 id 查 /system/apply_user/apply/detail，二不污染全局 token
    getApplyDetailByIdKeepToken(applyId)
      .then(detailRes => {
        const { applyUser, attachmentList, raw } = detailRes
        // canAudit 由「申请单状态 + 当前用户权限」决定：
        //   2 已通过 / 3 已驳回 → 终态，任何权限都只读
        //   0 待初审 → 需 init 权限；4 已初审 → 需 audit 权限（有权限即可在此做终审）
        const detail = buildDetailFromApi(applyUser, attachmentList, raw, item, true)
        detail.canAudit = this._canAuditByState(detail.state)
        this.setData({
          detail,
          detailLoading: false,
          detailError: false
        })
      })
      .catch(err => {
        console.error('[approval] /system/apply_user/apply/detail 失败：', err)
        this.setData({
          detailLoading: false,
          detailError: true,
          detailErrorMsg: (err && err.message) || '详情加载失败，请稍后重试'
        })
      })
  },

  backToList() {
    this.setData({
      view: 'list',
      detailLoading: false,
      detailError: false,
      detailErrorMsg: ''
    })
    this.setTabData(this.data.tab)
  },

  previewFile(e) {
    const gIdx = Number(e.currentTarget.dataset.gidx)
    const fIdx = Number(e.currentTarget.dataset.fidx)
    const group = (this.data.detail.materialGroups || [])[gIdx]
    const file = group && group.files[fIdx]
    if (!file) return
    if (file.isImage) {
      const urls = group.files.filter(f => f.isImage).map(f => f.origin).filter(Boolean)
      const current = file.origin || urls[0] || ''
      if (!current) return
      wx.previewImage({ current, urls })
      return
    }
    this._openDocument(file.origin, file.fileName)
  },

  _openDocument(url, fileName) {
    if (!url) return
    const relative = this._relativeUrl(url)
    if (!relative) {
      wx.showToast({ title: '文件地址异常，无法打开', icon: 'none' })
      return
    }
    const downloadUrl = BASE + '/file/download?url=' + encodeURIComponent(relative)
    wx.showLoading({ title: '加载中...', mask: true })
    wx.downloadFile({
      url: downloadUrl,
      success: (res) => {
        wx.hideLoading()
        if (res.statusCode !== 200) {
          wx.showToast({ title: '文件加载失败，请重试', icon: 'none' })
          return
        }
        const opts = {
          filePath: res.tempFilePath,
          showMenu: true,
          fail: () => wx.showToast({ title: '文件打开失败', icon: 'none' })
        }
        const ext = fileExt(fileName || url)
        if (ext) opts.fileType = ext
        wx.openDocument(opts)
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '文件下载失败，请检查网络', icon: 'none' })
      }
    })
  },

  _relativeUrl(url) {
    if (!url || typeof url !== 'string') return ''
    if (url.indexOf(BASE) === 0) return url.slice(BASE.length)
    const m = url.match(/^https?:\/\/[^/]+(\/.*)?$/i)
    return m ? (m[1] || '') : url
  },

  rejectApp() {
    // 终态（已通过 / 已驳回）或审批记录进入的只读详情：按钮不展示，这里再兜底拦截
    if (this.data.detail && this.data.detail.canAudit === false) return
    // 打开自定义驳回弹窗：重置状态 + 延时聚焦（等 van-dialog 完成挂载）
    this.setData({
      'rejectDialog.show': true,
      'rejectDialog.reason': '',
      'rejectDialog.placeholderVisible': true,
      'rejectDialog.focus': false
    })
    setTimeout(() => {
      this.setData({ 'rejectDialog.focus': true })
    }, 120)
  },

  // 驳回弹窗：textarea 内容变化
  onRejectInput(e) {
    this.setData({ 'rejectDialog.reason': e.detail.value || '' })
  },

  // 驳回弹窗：textarea 获得焦点 → 隐藏提示文案（用户要求光标落在输入框时清空提示）
  onRejectFocus() {
    this.setData({ 'rejectDialog.placeholderVisible': false })
  },

  // 驳回弹窗：textarea 失焦 → 若仍空则恢复提示文案显示
  onRejectBlur(e) {
    const reason = (e.detail && e.detail.value) || ''
    this.setData({ 'rejectDialog.placeholderVisible': !String(reason).trim() })
  },

  // 驳回弹窗：取消 / 关闭回调
  onRejectDialogClose() {
    this.setData({
      'rejectDialog.show': false,
      'rejectDialog.focus': false
    })
  },

  // 驳回弹窗：确认按钮回调：取文本，空时兜底为「材料不符合要求」
  onRejectDialogConfirm() {
    const reason = (this.data.rejectDialog.reason || '').trim() || '材料不符合要求'
    const detail = this.data.detail
    this.setData({
      'rejectDialog.show': false,
      'rejectDialog.focus': false
    })
    this._doAudit(detail, 3, reason, () => {
      this.moveToDone(detail, '已驳回', 'tag-danger', `驳回原因：${reason}`)
      wx.showToast({ title: '已驳回，已通知申请人', icon: 'none' })
    })
  },

  // ══════════════════ 终审签字：手写签名 → 导出图片 → 上传 → signPic ══════════════════

  // 打开签名弹层（终审「通过」前必须签字）
  openSignPad() {
    this.setData({ 'sign.show': true, 'sign.hasInk': false, 'sign.saving': false })
    // 弹层节点渲染完成后再初始化 Canvas 2D
    setTimeout(() => this._initSignCanvas(), 80)
  },

  closeSignPad() {
    if (this.data.sign.saving) return
    this._pendingApprove = null
    this.setData({ 'sign.show': false })
  },

  // 初始化 Canvas 2D：按设备像素比放大避免发虚，并铺白底（PNG 透明底部分场景会变黑）
  _initSignCanvas() {
    wx.createSelectorQuery().in(this)
      .select('#signCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const hit = res && res[0]
        if (!hit || !hit.node) return
        const canvas = hit.node
        const ctx = canvas.getContext('2d')
        let dpr = 2
        try {
          const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          dpr = info.pixelRatio || 2
        } catch (e) { /* 取不到按 2 倍处理 */ }
        canvas.width = hit.width * dpr
        canvas.height = hit.height * dpr
        ctx.scale(dpr, dpr)
        ctx.lineWidth = 3
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.strokeStyle = '#1B2A33'
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, hit.width, hit.height)
        this._signCanvas = canvas
        this._signCtx = ctx
        this._signSize = { w: hit.width, h: hit.height }
        this._signLast = null
        this._signDrawing = false
      })
  },

  // 触点坐标：canvas 组件的 touch 事件直接给出相对画布的 x / y
  _signPoint(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return null
    const x = (t.x != null) ? t.x : t.clientX
    const y = (t.y != null) ? t.y : t.clientY
    return { x: Number(x) || 0, y: Number(y) || 0 }
  },

  onSignStart(e) {
    if (!this._signCtx) return
    const p = this._signPoint(e)
    if (!p) return
    this._signDrawing = true
    this._signLast = p
    // 落笔即画一个点，保证点按 / 短划也有墨迹
    const ctx = this._signCtx
    ctx.beginPath()
    ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2)
    ctx.fillStyle = '#1B2A33'
    ctx.fill()
    if (!this.data.sign.hasInk) this.setData({ 'sign.hasInk': true })
  },

  onSignMove(e) {
    if (!this._signDrawing || !this._signCtx) return
    const p = this._signPoint(e)
    if (!p || !this._signLast) return
    const ctx = this._signCtx
    const from = this._signLast
    // 二次贝塞尔取中点，线条更顺滑
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.quadraticCurveTo(from.x, from.y, (from.x + p.x) / 2, (from.y + p.y) / 2)
    ctx.stroke()
    this._signLast = p
  },

  onSignEnd() {
    this._signDrawing = false
    this._signLast = null
  },

  // 清除签名：铺白底重置画布
  onSignClear() {
    if (this._signCtx && this._signSize) {
      this._signCtx.fillStyle = '#FFFFFF'
      this._signCtx.fillRect(0, 0, this._signSize.w, this._signSize.h)
    }
    this.setData({ 'sign.hasInk': false })
  },

  // 确认签字：导出图片 → 上传 → 取 URL → 带 signPic 提交终审
  confirmSign() {
    if (this.data.sign.saving) return
    if (!this.data.sign.hasInk) {
      wx.showToast({ title: '请先手写签名', icon: 'none' })
      return
    }
    if (!this._signCanvas) {
      wx.showToast({ title: '签名板未就绪，请重新打开', icon: 'none' })
      return
    }
    this.setData({ 'sign.saving': true })
    wx.canvasToTempFilePath({
      canvas: this._signCanvas,
      fileType: 'png',
      success: (res) => {
        wx.showLoading({ title: '上传签名…', mask: true })
        uploadFile(res.tempFilePath, { name: 'sign.png', fileName: 'sign.png' })
          .then((data) => {
            const url = this._relativeUrl(this._extractUploadedUrl(data))
            if (!url) throw new Error('签名图片上传后未取到地址')
            console.log('[approval] 终审签名上传成功，signPic =', url)
            wx.hideLoading()
            this.setData({ 'sign.saving': false, 'sign.show': false })
            const pending = this._pendingApprove
            this._pendingApprove = null
            if (pending) this._doAudit(pending.detail, 2, '', pending.onOk, url)
          })
          .catch((err) => {
            wx.hideLoading()
            this.setData({ 'sign.saving': false })
            wx.showModal({
              title: '签名上传失败',
              content: (err && (err.message || err.errMsg)) || '请检查网络后重试',
              showCancel: false,
              confirmText: '知道了'
            })
          })
      },
      fail: (err) => {
        console.error('[approval] canvasToTempFilePath 失败：', err)
        this.setData({ 'sign.saving': false })
        wx.showToast({ title: '签名图片生成失败，请重试', icon: 'none' })
      }
    })
  },

  // 上传返回结构兼容：字符串 / { url } / { origin } / 数组 / 嵌套对象
  _extractUploadedUrl(data) {
    if (!data) return ''
    if (typeof data === 'string') return data
    if (Array.isArray(data)) {
      for (const it of data) {
        const u = this._extractUploadedUrl(it)
        if (u) return u
      }
      return ''
    }
    if (typeof data !== 'object') return ''
    const keys = ['origin', 'url', 'fileUrl', 'fullUrl', 'filePath', 'path', 'src', 'link']
    for (const k of keys) {
      const v = data[k]
      if (typeof v === 'string' && v) return v
    }
    const hit = Object.keys(data).map(k => this._extractUploadedUrl(data[k])).find(Boolean)
    return hit || ''
  },

  noop() {},

  approveApp() {
    // 终态（已通过 / 已驳回）或审批记录进入的只读详情：按钮不展示，这里再兜底拦截
    if (this.data.detail && this.data.detail.canAudit === false) return
    const detail = this.data.detail
    // 是否初审：直接看申请单自身 state（列表已不再请求权限/字典，无法从 tab 推断）
    const isInit = this._isInitState(detail)
    wx.showModal({
      title: '确认通过',
      content: isInit
        ? '初审通过后将提交终审审核，并发送消息通知。'
        : '通过后将为申请人开通仪器预约权限，并发送消息通知。',
      cancelText: '取消',
      confirmText: '确认通过',
      confirmColor: '#0A7BB8',
      success: (res) => {
        if (!res.confirm) return
        // 初审（当前申请单 state=0）通过后只是进入终审，无需签字
        if (isInit) {
          this._doAudit(detail, 2, '', () => {
            this.moveToDone(detail, '已初审通过', 'tag-success', '审批时间：' + this.now())
            wx.showToast({ title: '已初审通过，已提交终审', icon: 'success' })
          })
          return
        }
        // 终审通过：必须先手写签字，签名图上传后把 URL 用 signPic 一起提交
        this._pendingApprove = {
          detail,
          onOk: () => {
            this.moveToDone(detail, '已通过', 'tag-success', '审批时间：' + this.now())
            wx.showToast({ title: '已通过，已开通权限', icon: 'success' })
          }
        }
        this.openSignPad()
      }
    })
  },

  // 是否走「初审」流程：申请单当前 state=0（待初审）→ /api/init；其它 → /api/audit
  _isInitState(detail) {
    const st = (detail && detail.state != null) ? Number(detail.state) : null
    return st === 0
  },

  // 提交审批结果，按申请单当前 state 走不同接口：
  //   当前 state=0（待初审）→ POST /system/apply_user/api/init，body { id, state, remark, token }
  //       通过 state=4（进入待终审）/ 驳回 state=3（已驳回）
  //   其它 state（如 4 待终审）→ POST /system/apply_user/api/audit（通过 2 / 驳回 3）
  //   两个接口的驳回 state 一致，都是 3
  // 入参：detail 当前详情；actState 业务值（2=通过 / 3=驳回）；remark 驳回原因；onOk 成功回调；
  //       signPic 终审签字的图片 URL（仅终审通过时由签名弹层上传后传入）
  _doAudit(detail, actState, remark, onOk, signPic) {
    const params = (detail && detail.auditParams) || {}
    const id = params.id
    if (!id) {
      wx.showToast({ title: '缺少申请记录 id，无法提交', icon: 'none' })
      return
    }
    const isReject = actState === 3
    // 申请单当前 state 取自详情/列表行本身（列表不再传 state 查询，没有 tab 级 state 可依据）
    const rowState = (detail && detail.state != null) ? Number(detail.state) : null
    const curState = rowState
    const useInit = curState === 0
    // token 规则：init 与 audit 一律用「登录人（当前管理员）」的 token
    //   两个接口都不显式传 token，由 api.js 统一注入全局 TOKEN（登录后写入、随接口轮换刷新）
    //   注意：不能用 /system/apply_user/apply/detail 下发的 token —— 那是被审批人的身份
    const payload = useInit
      ? { id, state: isReject ? 3 : 4, remark: remark || '' }
      : {
        id,
        state: actState,
        deptId: params.deptId,
        deptName: params.deptName,
        type: params.type,
        userType: params.userType,
        remark: remark || ''
      }
    // 终审通过：带上签字图片地址（字段 signPic，值为上传后的图片 URL）
    // 仅 /system/apply_user/api/audit（终审）支持，初审 /api/init 与驳回都不传
    if (!useInit && !isReject && signPic) payload.signPic = signPic
    const api = useInit ? initApplyUser : auditApplyUser
    console.log('[approval] 审批提交：申请单 state =', rowState,
      '→ 采用 state =', curState, '→', useInit ? '/system/apply_user/api/init' : '/system/apply_user/api/audit', payload)
    wx.showLoading({ title: isReject ? '驳回中…' : '通过中…', mask: true })
    api(payload).then(() => {
      wx.hideLoading()
      // 审批结果已写入后端：丢弃 detail 跨页缓存并通知首页 / 「我的」刷新
      // （审核通过后首页需隐藏准入横幅，否则会命中旧缓存继续展示）
      clearApplyUserDetailCache()
      // 通知外部刷新的是「操作后的 state」：初审通过 4 / 驳回 3，终审沿用 2 / 3
      getApp().emit('admission:changed', { state: useInit ? (isReject ? 3 : 4) : actState })
      if (typeof onOk === 'function') onOk()
    }).catch(err => {
      wx.hideLoading()
      wx.showModal({
        title: isReject ? '驳回失败' : '通过失败',
        content: (err && (err.message || err.errMsg || err.msg)) || '审批接口调用失败，请稍后重试',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  // 审批提交成功后：把该条从待审核移除，并标记审批记录需在下次进入 tab 时重新拉取
  moveToDone(detail) {
    this.pendingList = (this.pendingList || []).filter(x => x.id !== detail.id)
    this._doneDirty = true
    this.setData({ view: 'list', tab: 'pending' })
    this.setTabData('pending')
    this._loadPending()
  },

  now() {
    const d = new Date()
    const pad = n => (n < 10 ? '0' + n : '' + n)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
})
