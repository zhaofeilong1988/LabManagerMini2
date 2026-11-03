// pages/onboarding/register/register.js
const { getInitials, getPinyinKeys, matchInitials, getUnknownChars } = require('../../../utils/pinyin')
const { getLoginUser, getOpenId } = require('../../../utils/auth.js')
const { registerAdmission, getDeptList, getDictData } = require('../../../utils/api.js')

// 为候选项附加搜索字段：
//  - initials：名称的完整拼音首字母串（字表未收录的汉字为通配符 '*'）
//  - pyKeys：分词首字母串（按空格/标点/“与和及”等切分），便于按词搜索
function withSearch(item, text) {
  const t = String(text == null ? '' : text)
  return Object.assign({}, item, {
    initials: item.initials || getInitials(t),
    pyKeys: item.pyKeys || getPinyinKeys(t)
  })
}

// ── 可搜索下拉候选数据（导师/课题组为演示内置；部门由 /system/dept/get 接口返回） ──
// 部门兜底数据：接口无返回或请求失败时使用
const FALLBACK_DEPT_NAMES = ['生物成像与分析实验室', '免疫学流式分析实验室', '神经影像实验室', '电镜中心实验室', '分子药理学实验室', '生物信息学与系统生物学平台', '化学与材料中心', '转化医学研究所']
const DEPTS = FALLBACK_DEPT_NAMES
  .map((name, i) => withSearch({ id: i + 1, name, searchTxt: name }, name))
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
const SUPERVISORS = [
  ['王强', '教授', '生物成像与分析实验室', '分子影像与肿瘤微环境课题组', '13800001201'],
  ['刘敏', '研究员', '免疫学流式分析实验室', '免疫细胞分选与功能分析课题组', '13800003305'],
  ['陈刚', '教授', '神经影像实验室', '神经生物学与神经影像研究组', '13800007072'],
  ['赵文博', '教授', '电镜中心实验室', '纳米材料与生物界面课题组', '13800007101'],
  ['李静', '副教授', '分子药理学实验室', '药物靶点与分子药理课题组', '13800009123'],
  ['吴敏', '研究员', '转化医学研究所', '代谢与脂质组学研究组', '13800001890'],
  ['孙浩', '教授', '化学与材料中心', '遗传与表观调控课题组', '13800006347'],
  ['周倩', '副教授', '神经影像实验室', '动物疾病模型与评价课题组', '13800005612']
].map(([name, title, dept, group, phone], i) => withSearch({ id: i + 1, name, title, dept, group, phone, searchTxt: name + ' ' + title + ' ' + dept + ' ' + group }, name + title + dept + group))
const SCOPE_OPTS = ['所内', '所外'].map((name) => withSearch({ name, searchTxt: name }, name))
// 身份（院内人员）字典：GET /system/dict/data/get/identity_type
// 接口失败 / 无数据时用这组兜底值（学生=1 职工=2 科研组自聘=3）
const FALLBACK_IDENTITY = [
  { value: '1', label: '学生' },
  { value: '2', label: '职工' },
  { value: '3', label: '科研组自聘' }
]
// 准入期限：结束时间必须在开始时间起 6 年范围内
const MAX_YEARS = 6

// 今天（YYYY-MM-DD）
function todayDs() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 日期 + N 年（同月同日；2 月 29 日在平年回退到 28 日）
function addYearsDs(ds, years) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ds || ''))
  if (!m) return ''
  const y = Number(m[1]) + Number(years)
  const mo = Number(m[2])
  const day = Number(m[3])
  const last = new Date(y, mo, 0).getDate()   // 该月最后一天
  const p = (n) => String(n).padStart(2, '0')
  return `${y}-${p(mo)}-${p(Math.min(day, last))}`
}

const PICKER_META = {
  supervisor: ['导师姓名', SUPERVISORS],
  group: ['课题组', GROUPS],
  dept: ['部门', DEPTS],
  scope: ['人员类型', SCOPE_OPTS]
}

// 名称 → ID 反查（候选数据均带 id，用于提交时回填 deptId / teamId）
const teamIdOf = (name) => {
  const g = GROUPS.find((x) => x.name === name)
  return g ? g.id : ''
}

Page({
  data: {
    identity: 'inside',   // inside | outside
    agreed: false,
    showConfirm: false,   // 提交二次确认弹窗（参照 prototype.html 的自定义 modal）
    picker: { show: false, type: '', label: '', kw: '', list: [] },
    depts: DEPTS,         // 部门下拉候选（由 /system/dept/get 接口渲染）
    identityOpts: FALLBACK_IDENTITY,  // 身份单选候选（由 identity_type 字典渲染）
    form: {
      name: '',
      sex: '',         // 性别：0.男 1.女（单选）
      idNo: '',
      phone: '',
      email: '',
      major: '',       // 院外人员：所学专业（选填）
      supervisor: '',
      superphone: '',
      group: '',
      dept: '',
      deptId: '',      // 部门ID（下拉选择时回填）
      teacherId: '',   // 导师ID（下拉选择时回填）
      teamId: '',      // 课题组ID（下拉选择时回填）
      org: '',
      project: '',
      purpose: '',
      scope: '',        // 院内人员：所内 | 所外（单选）
      identity: '',     // 院内人员身份：identity_type 字典值（单选，提交字段 identity）
      start_date: '',    // 准入开始时间（YYYY-MM-DD）
      end_date: ''       // 准入结束时间（YYYY-MM-DD，须在开始时间起 6 年内）
    },
    hideIdNo: false,      // 身份为「科研组自聘」时隐藏「学号/工号」
    startMin: todayDs(), // 开始时间最早：今天
    endMin: todayDs(),   // 结束时间最早：开始时间（未选开始时间时为今天）
    endMax: ''           // 结束时间最晚：开始时间 + 6 年
  },

  // 回填已保存的登记内容（从准入总览「查看/修改」进入时延续之前填写）
  onLoad() {
    this._loadDepts()
    this._loadIdentityDict()
    const saved = wx.getStorageSync('admissionRegister')
    const form = Object.assign({}, this.data.form, (saved && saved.form) || {})
    // 基本信息手机号：默认以「手机号授权登录」结果填充，用户仍可手动修改
    const user = getLoginUser()
    if (!form.phone && user && user.phone) form.phone = String(user.phone)
    this.setData({
      identity: saved && saved.identity === 'outside' ? 'outside' : 'inside',
      agreed: !!(saved && saved.agreed),
      form
    }, () => {
      this._syncHideIdNo()
      this._syncDateRange()
    })
  },

  // 结束时间的可选范围：开始时间 ~ 开始时间 + 6 年（未选开始时间时最早为今天）
  _syncDateRange() {
    const s = this.data.form.start_date
    this.setData({
      endMin: s || todayDs(),
      endMax: s ? addYearsDs(s, MAX_YEARS) : ''
    })
  },

  // 准入期限（开始/结束时间）：原生 picker mode="date"
  //   改开始时间时同步收紧结束时间的范围；已选结束时间超出新范围则清空，避免残留非法值
  onDateChange(e) {
    const key = e.currentTarget.dataset.key
    const val = e.detail.value || ''
    const patch = { ['form.' + key]: val }
    if (key === 'start_date') {
      patch.endMin = val || todayDs()
      patch.endMax = val ? addYearsDs(val, MAX_YEARS) : ''
      const ed = this.data.form.end_date
      if (ed && patch.endMax && ed > patch.endMax) patch['form.end_date'] = ''
      if (ed && val && ed < val) patch['form.end_date'] = ''
    }
    this.setData(patch)
  },

  // 拉取部门列表：POST /system/dept/get，渲染到部门下拉候选
  async _loadDepts() {
    try {
      const list = await getDeptList()
      const depts = this._normalizeDepts(list)
      if (depts.length) this.setData({ depts })
    } catch (err) {
      console.warn('[register] /system/dept/get 获取失败，使用默认部门数据：', err)
    }
  },

  // 身份选项：GET /system/dict/data/get/identity_type
  // 字典项 { dictValue, dictLabel } → { value, label }，单选按钮直接用字典值提交；
  // 接口失败 / 返回为空时保留内置兜底选项（学生=1 职工=2 科研组自聘=3）
  async _loadIdentityDict() {
    try {
      const list = await getDictData('identity_type')
      const opts = (list || []).map(d => ({
        value: String(d.dictValue != null ? d.dictValue : (d.value != null ? d.value : '')),
        label: String(d.dictLabel || d.label || d.name || d.text || '')
      })).filter(x => x.value !== '' && x.label !== '')
      if (!opts.length) {
        console.warn('[register] 字典 identity_type 为空，使用内置身份选项')
        return
      }
      // 字典换掉后重算一次「学号/工号」显隐（草稿回填的身份值可能对应新字典项）
      this.setData({ identityOpts: opts }, () => this._syncHideIdNo())
      console.log('[register] 身份字典 identity_type：', opts)
    } catch (err) {
      console.warn('[register] 字典 identity_type 获取失败，使用内置身份选项：', err)
    }
  },

  // 接口部门数据 → 下拉候选结构 { id, name, sub, searchTxt, initials, pyKeys }
  // 兼容 RuoYi(deptId/deptName) 与常见字段（id/name/label/title），并递归展平 children 树
  _normalizeDepts(list) {
    const out = []
    const walk = (arr, parentName) => {
      (arr || []).forEach((it) => {
        if (!it || typeof it !== 'object') return
        const id = it.deptId !== undefined ? it.deptId
          : (it.id !== undefined ? it.id : out.length + 1)
        const name = it.deptName || it.name || it.label || it.title || it.dept_name || ''
        if (name) {
          const searchTxt = parentName ? name + ' ' + parentName : name
          out.push(withSearch({ id, name, sub: parentName || '', searchTxt }, searchTxt))
        }
        const children = it.children || it.childList || it.childrenList || it.subDepts
        if (Array.isArray(children) && children.length) walk(children, name || parentName)
      })
    }
    walk(list, '')
    // 诊断：打印字表未收录的汉字（这些字在首字母串里为 '*'，会走容错匹配）
    const unknown = []
    out.forEach((d) => getUnknownChars(d.name).forEach((c) => {
      if (unknown.indexOf(c) < 0) unknown.push(c)
    }))
    if (unknown.length) console.warn('[register] 拼音字表未收录的汉字（建议补充 utils/pinyin.js）：', unknown.join(''))
    return out
  },

  // 部门名称 → 部门ID 反查（数据来源为接口渲染的部门列表）
  _deptIdOf(name) {
    const d = (this.data.depts || []).find((x) => x.name === name)
    return d ? d.id : ''
  },

  // 下拉候选数据源：部门取接口渲染的 depts，其余取内置静态数据
  _pickerSource(type) {
    if (type === 'dept') return this.data.depts || []
    const meta = PICKER_META[type]
    return (meta && meta[1]) || []
  },

  _nowText() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  },

  // 从登记接口返回中解析申请记录 id（兼容 { id } 与 { data: { id } } / { result: { id } } 等结构）
  _pickApplyId(res) {
    const pick = (o) => {
      if (!o || typeof o !== 'object') return ''
      const v = o.id !== undefined ? o.id
        : (o.applyId !== undefined ? o.applyId
          : (o.apply_id !== undefined ? o.apply_id
            : (o.applyUserId !== undefined ? o.applyUserId : o.apply_user_id)))
      return (v === undefined || v === null || v === '') ? '' : v
    }
    return pick(res) || pick(res && res.data) || pick(res && res.result) || ''
  },

  switchIdentity(e) {
    this.setData({ identity: e.currentTarget.dataset.val }, () => this._syncHideIdNo())
  },

  // 身份为「科研组自聘」时：不展示「学号/工号」，该项也不必填
  // 判定：先按 identity_type 字典项的标签匹配（字典值可能不是 3），匹配不到再按内置值 '3'
  _isSelfEmployed() {
    if (this.data.identity !== 'inside') return false
    const val = this.data.form.identity
    if (val === '' || val == null) return false
    const opt = (this.data.identityOpts || [])
      .find(x => String(x.value) === String(val))
    if (opt) return String(opt.label || '').indexOf('科研组自聘') >= 0
    return String(val) === '3'
  },

  // 同步「学号/工号」的显隐；隐藏时清空已填内容，避免残留值被提交
  _syncHideIdNo() {
    const hide = this._isSelfEmployed()
    const patch = { hideIdNo: hide }
    if (hide && this.data.form.idNo) patch['form.idNo'] = ''
    this.setData(patch)
  },

  // ── 可搜索下拉（人员类型 / 导师姓名 / 课题组 / 部门） ──
  openPicker(e) {
    const type = e.currentTarget.dataset.pickerKey
    const meta = PICKER_META[type]
    if (!meta) return
    this.setData({
      picker: { show: true, type, label: meta[0], kw: '', list: this._pickList(this._pickerSource(type), '') }
    })
  },
  closePicker() {
    this.setData({ 'picker.show': false })
  },
  onPickerKw(e) {
    const type = this.data.picker.type
    if (!PICKER_META[type]) return
    const kw = e.detail.value
    this.setData({ 'picker.kw': kw, 'picker.list': this._pickList(this._pickerSource(type), kw) })
  },
  // 下拉搜索：支持
  //  - 中文/英文模糊（名称、副标题包含关键字）
  //  - 拼音首字母：连续（swcx）、跳字（swcxsys）、按词（fx / fxsys）
  //  - 表外汉字容错：字表没收录的汉字在首字母串里是 '*'，可吃掉查询词中的一个字母
  //    （如“后勤保障部” → h*b*b，输入 hqbzb 仍能命中）
  //  - 多关键词：空格分隔，需全部命中（如 “生物 成像”）；精确命中的排在前面
  _pickList(src, kw) {
    const tokens = String(kw == null ? '' : kw).trim().toLowerCase()
      .split(/[\s,，]+/).filter(Boolean)
    const res = []
    src.forEach((o, idx) => {
      if (!tokens.length) {
        res.push({ idx, name: o.name, sub: o.sub || '', score: 0 })
        return
      }
      let score = 0
      for (let i = 0; i < tokens.length; i++) {
        const s = this._scoreItem(o, tokens[i])
        if (s < 0) return                    // 任一关键词未命中则整项排除
        score += s
      }
      res.push({ idx, name: o.name, sub: o.sub || '', score })
    })
    // 精确度高的（文本包含 > 首字母包含 > 按词 > 容错匹配）排前面，同分保持原顺序
    res.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.idx - b.idx))
    return res.map((it) => ({ idx: it.idx, name: it.name, sub: it.sub }))
  },

  // 单个关键词打分：-1 未命中；0 文本包含；1 首字母包含；2 分词包含；3 首字母容错；4 分词容错
  _scoreItem(o, token) {
    const text = (o.searchTxt || '').toLowerCase()
    if (text && text.indexOf(token) >= 0) return 0
    const initials = o.initials || ''
    if (!initials) return -1
    if (initials.indexOf(token) >= 0) return 1
    if (!/^[a-z0-9]+$/.test(token)) return -1
    const keys = (o.pyKeys || []).filter((k) => k && k !== initials)
    if (keys.some((k) => k.indexOf(token) >= 0)) return 2
    if (token.length < 2) return -1        // 单字母不做容错匹配，避免结果发散
    if (matchInitials(token, initials)) return 3
    if (keys.some((k) => matchInitials(token, k))) return 4
    return -1
  },
  // 选择某项：回填字段；选择导师时自动带出手机号/课题组/部门（未填时）
  onPickerItem(e) {
    const type = this.data.picker.type
    if (!PICKER_META[type]) return
    const o = this._pickerSource(type)[e.currentTarget.dataset.index]
    if (!o) return
    const f = this.data.form
    const patch = {}
    if (type === 'supervisor') {
      patch['form.supervisor'] = o.name
      patch['form.teacherId'] = o.id || ''
      if (!f.superphone && o.phone) patch['form.superphone'] = o.phone
      if (!f.group && o.group) {
        patch['form.group'] = o.group
        patch['form.teamId'] = teamIdOf(o.group)
      }
      if (!f.dept && o.dept) {
        patch['form.dept'] = o.dept
        patch['form.deptId'] = this._deptIdOf(o.dept)
      }
    } else if (type === 'group') {
      patch['form.group'] = o.name
      patch['form.teamId'] = o.id || ''
      if (!f.dept && o.dept) {
        patch['form.dept'] = o.dept
        patch['form.deptId'] = this._deptIdOf(o.dept)
      }
    } else if (type === 'dept') {
      patch['form.dept'] = o.name
      patch['form.deptId'] = o.id || ''
    } else {
      patch['form.' + type] = o.name
    }
    patch['picker.show'] = false
    this.setData(patch)
  },

  onFieldChange(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ [`form.${key}`]: e.detail.value })
  },

  // 性别单选：0.男 1.女（radio 返回字符串，统一转为数字）
  onSexChange(e) {
    this.setData({ 'form.sex': Number(e.detail.value) })
  },

  // 人员类型单选（院内人员）：所内 | 所外
  onScopeChange(e) {
    this.setData({ 'form.scope': e.detail.value })
  },

  // 身份单选（院内人员）：值取 identity_type 字典的 dictValue
  // 选到「科研组自聘」时同步隐藏并清空「学号/工号」
  onIdentityChange(e) {
    this.setData({ 'form.identity': e.detail.value }, () => this._syncHideIdNo())
  },

  // 声明勾选：原生 view 点击，直接翻转状态（glass-easel 下 100% 可靠）
  toggleAgree() {
    this.setData({ agreed: !this.data.agreed })
  },

  // 自动关联导师手机号（已选导师则取其手机号，否则用演示占位号）
  linkSuperPhone() {
    const sup = SUPERVISORS.find((o) => o.name === this.data.form.supervisor)
    const phone = sup ? sup.phone : '13800000000'
    const patch = { 'form.superphone': phone }
    if (sup && !this.data.form.teacherId) patch['form.teacherId'] = sup.id
    this.setData(patch)
    wx.showToast({ title: sup ? `已自动关联：${phone}` : '已自动关联导师手机号', icon: 'none' })
  },

  // 提交后端的登记字段（字段名对齐接口约定）
  buildPayload() {
    const f = this.data.form
    const inside = this.data.identity === 'inside'
    return {
      open_id: getOpenId(),                                  // 授权手机号登录返回并缓存的 openid（后端字段名为 open_id）
      type: inside ? 1 : 2,                                  // 1.院内 2.院外
      name: (f.name || '').trim(),                           // 姓名
      sex: f.sex === 0 || f.sex === 1 ? f.sex : '',          // 性别：0.男 1.女
      user_no: this.data.hideIdNo ? '' : (f.idNo || '').trim(),  // 学号/工号（科研组自聘无此项）
      phone: (f.phone || '').trim(),                         // 手机号
      dept_id: f.deptId || '',                               // 部门ID
      dept_name: f.dept || '',                               // 部门名称
      user_type: inside ? (f.scope === '所外' ? 2 : 1) : 2,  // 人员类型：1.所内 2.所外
      identity: inside ? (f.identity || '') : '',           // 院内身份：取 identity_type 字典值（如 '1' 学生）
      email: (f.email || '').trim(),                         // 邮箱
      technical_title: f.supervisor || '',                   // 后端字段名约定为 technical_title，仍传导师姓名
      teacher_id: f.teacherId || '',                         // 导师ID
      teacher_phone: (f.superphone || '').trim(),            // 导师手机号
      team_id: f.teamId || '',                               // 课题组ID
      team_name: f.group || '',                              // 课题组
      profession: f.major || '',                             // 专业
      company: f.org || '',                                  // 所在单位
      project_name: f.project || '',                         // 合作项目
      research_direction: f.purpose || '',                   // 实验内容
      start_date: f.start_date || '',                          // 准入开始时间（YYYY-MM-DD）
      end_date: f.end_date || ''                               // 准入结束时间（YYYY-MM-DD）
    }
  },

  submitRegister() {
    console.log('[register] submit → form =', JSON.stringify(this.data.form), '| agreed =', this.data.agreed)
    const f = this.data.form

    // 未勾选同意声明时给出明确提示（按钮不再静默禁用）
    if (!this.data.agreed) {
      wx.showToast({ title: '请先勾选同意声明', icon: 'none' })
      return
    }

    const inside = this.data.identity === 'inside'
    if (inside && !f.scope) {
      wx.showToast({ title: '请选择「人员类型」（所内/所外）', icon: 'none' })
      return
    }
    if (inside && !f.identity) {
      wx.showToast({ title: '请选择「身份」（学生/职工/科研组自聘）', icon: 'none' })
      return
    }
    // 「科研组自聘」没有学号/工号：隐藏该项，也不参与必填校验
    const required = [
      ['name', '姓名'],
      ...(this.data.hideIdNo ? [] : [['idNo', '学号/工号']]),
      ['phone', '手机号'],
      ['supervisor', '导师姓名'],
      ['superphone', '导师手机号'],
      ['group', '课题组'],
      [inside ? 'dept' : 'org', inside ? '部门' : '所在单位'],
      ['purpose', '实验内容'],
      ['start_date', '开始时间'],      // 院内 / 院外都必填
      ['end_date', '结束时间']
    ]

    for (const [key, label] of required) {
      if (!f[key] || !String(f[key]).trim()) {
        wx.showToast({ title: `请填写「${label}」`, icon: 'none' })
        return
      }
    }

    // 准入期限：结束须晚于开始，且不超过开始时间起 6 年
    if (String(f.end_date) <= String(f.start_date)) {
      wx.showToast({ title: '结束时间需晚于开始时间', icon: 'none' })
      return
    }
    const limit = addYearsDs(f.start_date, MAX_YEARS)
    if (limit && String(f.end_date) > limit) {
      wx.showToast({ title: `结束时间需在开始时间起 ${MAX_YEARS} 年内`, icon: 'none' })
      return
    }

    if (f.sex !== 0 && f.sex !== 1) {
      wx.showToast({ title: '请选择「性别」', icon: 'none' })
      return
    }
    if (!/^1\d{10}$/.test(String(f.phone).trim())) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }

    // 校验通过 → 弹出二次确认（自定义弹窗，对齐 prototype.html）
    this.setData({ showConfirm: true })
  },

  // 弹窗遮罩拦截滚动（无实际逻辑）
  noop() {},

  // 「再检查一下」：关闭弹窗，留在本页继续修改
  cancelConfirm() {
    this.setData({ showConfirm: false })
  },

  // 「确认提交」：调用 POST /api/register 提交登记 → 成功跳转材料上传
  async confirmSubmit() {
    if (this._submitting) return
    this.setData({ showConfirm: false })
    // 按后端字段约定组装登记数据（JSON 提交）
    const payload = this.buildPayload()
    console.log('[register] POST /api/register payload =', JSON.stringify(payload))
    if (!payload.open_id) {
      console.warn('[register] openid 为空：lab_openid =', wx.getStorageSync('lab_openid') || '(空)',
        '| lab_user =', JSON.stringify(getLoginUser() || null))
    }
    this._submitting = true
    wx.showLoading({ title: '提交中...', mask: true })
    try {
      const res = await registerAdmission(payload)
      wx.hideLoading()
      this._submitting = false
      // 登记返回的申请记录 id：上传材料时需携带（/system/apply_user_attachment/get/{id}），单独缓存便于上传页读取
      const applyId = this._pickApplyId(res)
      if (applyId !== '') wx.setStorageSync('admissionApplyId', applyId)
      else console.warn('[register] /api/register 返回中未解析到 id，原始返回：', res)
      // 持久化登记内容：供准入总览「点击申请登记节点」查看之前填写的信息
      wx.setStorageSync('admissionRegister', {
        identity: this.data.identity,
        agreed: this.data.agreed,
        form: this.data.form,
        payload,
        res,
        applyId,
        submitTime: this._nowText()
      })
      wx.setStorageSync('admissionStep', 1)
      wx.showToast({ title: '登记成功', icon: 'success' })
      setTimeout(() => {
        // 登记完成 → 回到准入总览第 2 步「材料提交」，可选择上传文件 / 安全考试 / 提交审核
        wx.redirectTo({
          url: '/pages/onboarding/index/index',
          fail: () => wx.showToast({ title: '跳转失败，请重试', icon: 'none' })
        })
      }, 400)
    } catch (err) {
      wx.hideLoading()
      this._submitting = false
      console.error('[register] /api/register 调用失败：', err)
      wx.showToast({ title: (err && err.message) || '登记提交失败，请重试', icon: 'none' })
    }
  }
})
