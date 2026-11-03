// pages/onboarding/upload/upload.js
const { uploadFile, BASE, getDocInfoList, getDictData, saveApplyUserAttachments, getApplyUserDetail, ADMISSION_USER_DETAIL_KEY, ADMISSION_USER_DETAIL_TTL, applyUserDocUrl, sendApplyUserDocEmail } = require('../../../utils/api.js')
const { getOpenId } = require('../../../utils/auth.js')

// 每份材料（每个上传项）允许上传的文件数量上限：1 = 只能上传 1 份
// wxml 里的添加按钮判断（doc.photos.length < 1）与此保持一致
const DOC_MAX = 1

// ── 审批模板下载地址配置 ──────────────────────────────
// 正式环境：将 TEMPLATE_BASE 替换为部署了模板文件的 HTTPS 静态资源目录，
// 并按下方 templates 中 file 字段命名文件（如 …/templates/platform-application.docx）。
// 开发者工具调试下载时，需在「详情 → 本地设置」勾选"不校验合法域名、web-view…"。
const TEMPLATE_BASE = 'https://your-domain.example.com/lab/templates'

Page({
  data: {
    // docType：材料类型（字典 doc_type 的值），保存时提交给后端；默认与 id 一致
    docs: [
      { id: 1, docType: 1, name: '平台使用申请书', desc: '需本人、导师/主任签字，拍摄完整签字页', required: true, photos: [] },
      { id: 2, docType: 2, name: '安全承诺书', desc: '需本人签字，拍摄完整内容及签字部分', required: true, photos: [] },
      { id: 3, docType: 3, name: '知识产权共享承诺书', desc: '需本人签字，院外人员还需导师/合作老师签字', required: true, photos: [] },
      // 第 4 项：院外人员 / 院内「科研组自聘」必传（见 _requiredDocTypes），其余人员可跳过
      { id: 4, docType: 4, name: '合同证明文件', desc: '院外人员、科研组自聘必传，其余人员可跳过', required: false, photos: [] }
    ],
    // 空白模板下载列表（file 为模板文件名，需放置在 TEMPLATE_BASE 指向的目录下）
    templates: [
      { id: 1, name: '平台使用申请书', file: 'platform-application.docx', type: 'docx', fmt: 'DOCX 模板' },
      { id: 2, name: '安全承诺书', file: 'safety-commitment.docx', type: 'docx', fmt: 'DOCX 模板' },
      { id: 3, name: '知识产权共享承诺书', file: 'ip-sharing-commitment.docx', type: 'docx', fmt: 'DOCX 模板' },
      { id: 4, name: '合同证明文件', file: 'contract-proof.docx', type: 'docx', fmt: 'DOCX 模板' }
    ],
    // 申请用户类型：1=院内 / 2=院外（来自 /system/apply_user/detail），决定必传材料范围
    userType: null,
    // 院内身份是否为「科研组自聘」：与院外人员一样，合同证明文件（docType 4）必传
    isSelfEmployed: false,
    // 申请用户（applyUser）id：下载材料时作为 /system/apply_user/downloadDoc 的 id 参数
    applyUserId: ''
  },

  // 回填已暂存的上传材料（从准入总览「继续上传」进入时可见）
  onLoad() {
    this._loadTemplates()
    // 保存 promise：供提交时复用，避免 /system/apply_user/detail 被调两遍
    this._userTypeP = this._loadUserType()
    this._loadIdentity()
    const saved = wx.getStorageSync('admissionUpload')
    if (saved && saved.length) {
      const docs = this.data.docs.map((d) => {
        const s = saved.find((x) => x.id === d.id)
        // 兼容旧数据：早期 photos 元素为字符串，统一规范为 { thumb, origin } 结构
        // docType 以清单固定值为准（字典 doc_type 的值），不采用历史暂存，避免旧值污染
        return s ? { ...d, photos: this._normalizePhotos(s.photos) } : d
      })
      this.setData({ docs })
    }
  },

  // 拉取申请用户信息：GET /system/apply_user/detail
  // type=1（院内）→ docType 1/2/3 必传；type=2（院外）→ docType 1/2/3/4 必传
  // 优先读总览页写入的跨页缓存（同一会话内复用），避免 /apply_user/detail 被调两遍
  // 缓存失效 / 缺失时再走 API；接口失败时回退本地登记缓存 admissionRegister.type，再回退默认（院内）
  async _loadUserType() {
    let type = ''
    let applyUser = null
    // 1. 优先读跨页缓存（总览页 _syncUploadAttachment 写入）
    const cached = wx.getStorageSync(ADMISSION_USER_DETAIL_KEY)
    if (cached && typeof cached === 'object' && (Date.now() - (cached._ts || 0) < ADMISSION_USER_DETAIL_TTL)) {
      applyUser = cached.applyUser || {}
      console.log('[upload] applyUser 命中跨页缓存：', applyUser)
    }
    // 2. 缓存未命中或未拿到 type，再走 API
    if (applyUser && applyUser.type !== undefined && applyUser.type !== null && applyUser.type !== '') {
      type = Number(applyUser.type)
    } else {
      try {
        const detail = await getApplyUserDetail(getOpenId())
        applyUser = detail.applyUser || {}
        console.log('[upload] applyUser 解析结果：', applyUser)
        // 写回缓存供同会话内后续页面复用
        wx.setStorageSync(ADMISSION_USER_DETAIL_KEY, Object.assign({}, detail, { _ts: Date.now() }))
        if (applyUser && applyUser.type !== undefined && applyUser.type !== null && applyUser.type !== '') {
          type = Number(applyUser.type)
        }
      } catch (err) {
        console.warn('[upload] /system/apply_user/detail 获取失败：', err)
      }
    }
    if (type !== 1 && type !== 2) {
      const reg = wx.getStorageSync('admissionRegister') || {}
      const t = (reg.type !== undefined && reg.type !== null && reg.type !== '') ? reg.type
        : (reg.form && reg.form.type)
      if (Number(t) === 2) type = 2
      else if (Number(t) === 1) type = 1
    }
    if (type !== 1 && type !== 2) type = 1  // 未知类型默认按院内（1/2/3 必传）
    this.setData({ userType: type, applyUserId: this._applyUserId(applyUser) })
    this._applyRequired(type)
  },

  // 申请用户（applyUser）id：下载材料模板时作为 id 参数
  // 取值顺序：applyUser.id / userId / applyUserId → 跨页缓存 → 本地申请记录 id
  _applyUserId(applyUser) {
    const pick = (o) => {
      if (!o || typeof o !== 'object') return ''
      const v = o.id !== undefined ? o.id
        : (o.userId !== undefined ? o.userId : (o.applyUserId !== undefined ? o.applyUserId : ''))
      return (v === undefined || v === null || v === '') ? '' : String(v)
    }
    let val = pick(applyUser)
    if (!val) {
      const cached = wx.getStorageSync(ADMISSION_USER_DETAIL_KEY)
      val = pick(cached && cached.applyUser)
    }
    return val || String(this._applyId() || '')
  },

  // 按用户类型刷新必传标记（同步列表「必填/选填」标签）
  _applyRequired(type) {
    const required = this._requiredDocTypes(type)
    const docs = this.data.docs.map((d) => ({
      ...d,
      required: required.indexOf(Number(d.docType)) >= 0
    }))
    this.setData({ docs })
  },

  // 必传材料的 docType 集合：
  //   基础 1/2/3；院外（type=2）或院内「科研组自聘」再加合同证明文件（docType 4）
  _requiredDocTypes(type) {
    const t = (type === undefined || type === null) ? this.data.userType : type
    const list = [1, 2, 3]
    if (t === 2 || this.data.isSelfEmployed) list.push(4)
    return list
  },

  // 身份（identity_type 字典值）→ 是否「科研组自聘」
  //   取值顺序：跨页缓存 applyUser.identity → 本地登记缓存 admissionRegister.form.identity
  //   判定：优先用 identity_type 字典的 dictLabel 匹配「科研组自聘」，字典不可用时按内置值 '3'
  async _loadIdentity() {
    const pickIdentity = (o) => {
      if (!o) return ''
      const v = o.identity !== undefined ? o.identity
        : (o.identity_type !== undefined ? o.identity_type
          : (o.identityType !== undefined ? o.identityType : ''))
      return (v === undefined || v === null) ? '' : v
    }
    let val = ''
    const cached = wx.getStorageSync(ADMISSION_USER_DETAIL_KEY)
    val = pickIdentity(cached && cached.applyUser)
    if (val === '') {
      const reg = wx.getStorageSync('admissionRegister') || {}
      val = pickIdentity(reg.form || reg)
    }
    this._identityLoaded = true
    if (val === '') return

    let isSelf = String(val) === '3'
    try {
      const dict = await getDictData('identity_type')
      const hit = (dict || []).find(d =>
        String(d.dictValue !== undefined ? d.dictValue : d.value) === String(val))
      if (hit) isSelf = String(hit.dictLabel || hit.label || '').indexOf('科研组自聘') >= 0
    } catch (err) {
      console.warn('[upload] 字典 identity_type 获取失败，按内置值判定「科研组自聘」：', err)
    }
    console.log('[upload] 身份 identity =', val, '；科研组自聘：', isSelf)
    this.setData({ isSelfEmployed: isSelf }, () => this._applyRequired(this.data.userType))
  },

  // 规范化照片/文件数组：字符串 → { thumb, origin }；按扩展名识别文档项并补全 fileName/ext
  _normalizePhotos(photos) {
    return (photos || []).map((p) => {
      const item = (typeof p === 'string') ? { thumb: p, origin: p } : p
      const url = item.origin || item.thumb || ''
      if (!item.isFile && this._isDocUrl(url)) {
        item.isFile = true
        item.fileName = item.fileName || this._fileNameFromUrl(url)
        item.ext = item.ext || this._fileExt(item.fileName || url)
      }
      return item
    })
  },

  // 文档扩展名判断（图片以外的常见文档格式）
  _isDocUrl(url) {
    return /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|zip|rar)(\?|$)/i.test(String(url || ''))
  },

  // 从文件地址中解析文件名（去掉查询参数并解码）
  _fileNameFromUrl(url) {
    const raw = String(url || '').split('?')[0].split('/').pop() || ''
    try { return decodeURIComponent(raw) } catch (e) { return raw }
  },

  // 取扩展名（小写、不含点）
  _fileExt(name) {
    const parts = String(name || '').split('?')[0].split('.')
    return parts.length > 1 ? parts.pop().toLowerCase() : ''
  },

  // 拉取模板下载列表：并行请求 /system/doc_info/get 与字典 /system/dict/data/get/sign_up_doc，
  // 用列表项 docType 字段匹配字典值 dictValue，取 dictLabel 作为文档名称渲染。
  // 查询条件 docSource='sign_up_doc'：doc_info 表中按数据来源区分，这里只要准入登记的材料模板，
  // 不带该条件会把其它来源（如培训、仪器等）的文档一起查出来。
  async _loadTemplates() {
    try {
      const [list, dictList] = await Promise.all([
        getDocInfoList({ docSource: 'sign_up_doc' }),
        getDictData('sign_up_doc').catch((err) => {
          console.warn('[upload] 字典 sign_up_doc 获取失败：', err)
          return []
        })
      ])
      if (!list || !list.length) return  // 接口无数据时保留默认模板
      const dictMap = this._toDictMap(dictList)
      this.setData({ templates: this._buildTemplates(list, dictMap) })
    } catch (err) {
      console.warn('[upload] 模板列表获取失败，使用默认模板：', err)
    }
  },

  // 字典数组 → { value: label } 映射，兼容 RuoYi(dictValue/dictLabel) 与常见字段
  _toDictMap(dictList) {
    const map = {}
    ;(dictList || []).forEach((d) => {
      if (!d || typeof d !== 'object') return
      const value = d.dictValue !== undefined ? d.dictValue
        : (d.value !== undefined ? d.value : (d.code !== undefined ? d.code : d.key))
      const label = d.dictLabel || d.label || d.name || d.text
      if (value !== undefined && value !== null && label) map[String(value)] = label
    })
    return map
  },

  // 组装模板列表：docType 命中字典时用 dictLabel 显示，否则回退到接口自带 name 字段
  _buildTemplates(list, dictMap) {
    return (list || []).map((it, i) => {
      const docType = it.docType !== undefined ? it.docType
        : (it.doc_type !== undefined ? it.doc_type
          : (it.dictValue !== undefined ? it.dictValue : it.type))
      const docKey = (docType === undefined || docType === null) ? '' : String(docType)
      const name = dictMap[docKey] || it.name || it.title || it.docName || it.modelName || docKey || '未命名文件'
      // 接口返回的原始文件地址（可能是相对路径），下载时作为 /file/preview 的 url 参数
      const rawUrl = it.url || it.fileUrl || it.filePath || it.path || it.link || ''
      const url = this._toFullUrl(rawUrl)
      const file = it.file || it.fileName || (url ? String(url).split('/').pop() : '')
      const ext = (String(file).split('.').pop() || '').toLowerCase()
      return {
        id: it.id !== undefined ? it.id : (it.modelId !== undefined ? it.modelId : i + 1),
        name,
        docType: docKey,      // 材料类型（字典 doc_type 的值），下载时作为 docType 参数
        rawUrl,
        url,
        file,
        type: ext,
        fmt: (ext ? ext.toUpperCase() : 'FILE') + ' 模板'
      }
    })
  },

  _nowText() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  },

  // 申请记录 id：上传文件时需要提交（来自 /api/register 返回，缓存在 admissionApplyId，回退登记记录）
  _applyId() {
    const cached = wx.getStorageSync('admissionApplyId')
    if (cached !== undefined && cached !== null && cached !== '') return cached
    const reg = wx.getStorageSync('admissionRegister')
    if (!reg) return ''
    if (reg.applyId !== undefined && reg.applyId !== null && reg.applyId !== '') return reg.applyId
    if (reg.res && reg.res.id !== undefined && reg.res.id !== null && reg.res.id !== '') return reg.res.id
    return ''
  },

  // 持久化上传进度：供准入总览「点击上传文件节点」查看
  _persistDocs() {
    wx.setStorageSync('admissionUpload', this.data.docs.map((d) => ({
      id: d.id,
      docType: d.docType,
      name: d.name,
      required: d.required,
      photos: d.photos
    })))
  },

  _findDoc(id) {
    return this.data.docs.find(d => d.id === id)
  },

  // 点击「添加文件」→ 只支持上传文档（PDF/Word 等），不再弹 拍照 / 相册 选项
  showActionSheet(e) {
    const id = e.currentTarget.dataset.docid
    this._pickFile(id)
  },

  // 选择文档：wx.chooseMessageFile 从微信会话中选取（小程序选取本地文档的标准方式）
  // 提示用户可先把文件发到微信「文件传输助手」，再从这里选取
  _pickFile(id) {
    const doc = this._findDoc(id)
    if (!doc) return
    if (doc.photos.length >= DOC_MAX) {
      wx.showToast({
        title: DOC_MAX > 1 ? '每份材料最多上传' + DOC_MAX + '个文件' : '每份材料仅可上传1个文件',
        icon: 'none'
      })
      return
    }
    const remain = DOC_MAX - doc.photos.length
    wx.chooseMessageFile({
      count: remain,
      type: 'file',
      extension: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'],
      success: (res) => {
        const files = (res.tempFiles || []).filter(f => f.path && f.size > 0)
        if (!files.length) return
        this._uploadFiles(id, files)
      },
      fail: () => {}
    })
  },

  // 逐个上传文档到后端 /file/uploadFile，成功后以「文件卡片」形式写入列表
  // 1) 上传前把临时文件复制到「以原文件名结尾」的新路径，让 multipart Content-Disposition 的
  //    filename 等于原始名，后端 getOriginalFilename() 拿到原名
  // 2) 表单里附带 name / fileName / filename 三种 key 的原文件名，兼容 RuoYi 系用表单字段命名
  async _uploadFiles(id, files) {
    wx.showLoading({ title: '上传中...', mask: true })
    const items = []
    let failed = 0
    for (const f of files) {
      const origName = f.name || ''
      try {
        const uploadPath = await this._copyToNamedTempPath(f.path, origName)
        const data = await uploadFile(uploadPath, {
          name: origName,             // 通用字段
          fileName: origName,         // RuoYi 系常见字段
          filename: origName          // 兼容不同后端
        })
        const urls = this._extractUrls(data)
        const url = this._toFullUrl(urls.origin || urls.thumb)
        if (!url) throw new Error('上传返回缺少文件地址')
        items.push({
          thumb: '',                    // 文档无缩略图
          origin: url,                  // 文件地址（点击下载预览）
          isFile: true,
          fileName: origName || this._fileNameFromUrl(url),
          ext: this._fileExt(origName || url)
        })
      } catch (err) {
        failed++
        console.error('[upload] /file/uploadFile 上传失败：', f.path, err)
      }
    }
    wx.hideLoading()
    this._appendItems(id, items, failed, '上传成功')
  },

  // 把 temp 文件复制到「以原文件名结尾」的新临时路径，让 wx.uploadFile 的 multipart filename 段带原名
  // 关键：目标路径的 basename 必须就是原文件名（仅做非法字符清洗），
  // 否则后端读到的 getOriginalFilename() 会带上一堆 「up_<ts>_<rand>_」 之类的垃圾前缀
  // 同文件名前后多次上传通过 writeFileSync 覆盖；失败时回退原路径
  _copyToNamedTempPath(path, origName) {
    if (!path) return Promise.resolve(path)
    const safe = this._sanitizeFileName(origName)
    if (!safe) return Promise.resolve(path)  // 没有原名就不复制，节省 IO
    return new Promise((resolve) => {
      try {
        const fs = wx.getFileSystemManager()
        const dest = `${wx.env.USER_DATA_PATH}/${safe}`
        // 优先用 readFileSync + writeFileSync（覆盖式写入，无时间戳/随机数前缀）
        try {
          const data = fs.readFileSync(path)
          fs.writeFileSync(dest, data)
          resolve(dest)
        } catch (e) {
          // 回退到异步 copyFile
          fs.copyFile({
            srcPath: path,
            destPath: dest,
            success: () => resolve(dest),
            fail: (err) => {
              console.warn('[upload] 复制文件到带原名临时路径失败，使用原路径上传：', err)
              resolve(path)
            }
          })
        }
      } catch (e) {
        console.warn('[upload] 复制文件异常，使用原路径上传：', e)
        resolve(path)
      }
    })
  },

  // 文件名清洗：去掉路径分隔符、保留扩展名，避免 wx.env.USER_DATA_PATH 拼接后出错
  _sanitizeFileName(name) {
    if (!name) return ''
    return String(name).trim().replace(/[\\/:*?"<>|\r\n\t]/g, '_')
  },

  // 下载到本地使用的文件名：「可读名称 + 正确扩展名」
  // wx.downloadFile 不指定 filePath 时会落成随机临时名，openDocument 里转发/保存出去
  // 就是一串无意义字符；指定成 wx.env.USER_DATA_PATH/<可读名> 才能拿到正常文件名
  _localFileName(name, extHint) {
    let base = this._sanitizeFileName(String(name || '').trim())
    let ext = this._fileExt(base)
    if (ext) base = base.slice(0, -(ext.length + 1))
    if (!ext && extHint) ext = String(extHint).replace(/^\./, '').toLowerCase()
    return (base || 'template') + (ext ? '.' + ext : '')
  },

  // 下载文件并落成「可读文件名」
  // 实测：给 wx.downloadFile 传 filePath、以及异步 saveFile/copyFile 在这套环境里都会失败，
  //   失败后只能拿到随机临时名（形如 eJlfX4Xq4T3q…docx），保存/转发出去就是一串字符。
  // 这里改用**同步**文件系统 API（错误可立即捕获，不依赖回调时序），逐级尝试：
  //   saveFileSync → copyFileSync → readFileSync + writeFileSync
  // 入参 names：文件名候选数组，如 ['合同证明文件.docx', 'contract-proof.docx']
  // onOk(filePath, errInfo, persistErrs)：失败时 filePath 为 null；
  //   persistErrs 非空表示下载成功但没落成可读文件名（用于上层提示/定位）
  _downloadTo(url, names, onOk) {
    const list = (Array.isArray(names) ? names : [names]).filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
    wx.downloadFile({
      url,
      success: (res) => {
        console.log('[upload] downloadFile：', url, '→ statusCode =', res.statusCode,
          '，tempFilePath =', res.tempFilePath)
        if (res.statusCode < 200 || res.statusCode >= 300) {
          onOk(null, 'HTTP ' + res.statusCode)
          return
        }
        const tmp = res.tempFilePath
        if (!tmp) {
          onOk(null, 'empty tempFilePath')
          return
        }
        this._persistAs(tmp, list, onOk)
      },
      fail: (err) => {
        console.warn('[upload] downloadFile 失败：', err)
        onOk(null, (err && err.errMsg) || 'network fail')
      }
    })
  },

  // 从路径里取文件名（用于提示/核对实际保存的名字）
  _baseName(path) {
    const s = String(path || '')
    const i = s.lastIndexOf('/')
    return i >= 0 ? s.slice(i + 1) : s
  },

  // 把临时文件落成可读文件名（同步 API，错误直接抛出 → 可收集）
  // 关键：同名文件可能正被 Word/WPS 打开（真机不会，但 PC 开发者工具会映射到磁盘目录），
  //   此时覆盖写会 EBUSY: resource busy or locked —— 所以预备「名称(2).docx」「名称(3).docx」等替补名
  _persistAs(tmp, names, onOk) {
    const fs = wx.getFileSystemManager()
    const errs = []
    const tryWith = (name, fn) => {
      const dest = `${wx.env.USER_DATA_PATH}/${name}`
      try {
        try { fs.unlinkSync(dest) } catch (e) { /* 目标不存在 / 被占用，忽略，交给下面判断 */ }
        fn(dest)
        fs.accessSync(dest)   // 确认文件真的写到了 dest（防个别基础库忽略 filePath）
        console.log('[upload] 落盘成功：', dest)
        onOk(dest, '')
        return true
      } catch (e) {
        const msg = (e && (e.errMsg || e.message)) || String(e)
        errs.push(name + ' → ' + msg)
        console.warn('[upload] 落盘失败：', dest, e)
        return false
      }
    }
    // 候选名扩展：原名 + 「名称(2)…(5)」，被占用时自动换名，名字仍可读
    const list = []
    names.forEach((name) => {
      const ext = this._fileExt(name)
      const base = ext ? name.slice(0, -(ext.length + 1)) : name
      list.push(name)
      for (let i = 2; i <= 5; i++) list.push(`${base}(${i})${ext ? '.' + ext : ''}`)
    })
    // 1) 保存 / 复制（先中文名，再英文名；每个名字都带替补名）
    for (const name of list) {
      if (tryWith(name, dest => fs.saveFileSync(tmp, dest))) return
      if (tryWith(name, dest => fs.copyFileSync(tmp, dest))) return
    }
    // 2) 读写拷贝：绕过 save/copy 的路径校验
    for (const name of list) {
      if (tryWith(name, dest => fs.writeFileSync(dest, fs.readFileSync(tmp)))) return
    }
    console.warn('[upload] 全部落盘方式失败，沿用临时文件：', errs)
    onOk(tmp, '', errs)
  },

  // 上传结果统一落库：写入列表 + 持久化 + 提示（文档）
  _appendItems(id, items, failed, successMsg) {
    if (items.length) {
      const docs = this.data.docs.map(d => {
        if (d.id !== id) return d
        const photos = [...d.photos]
        items.forEach(it => { if (photos.length < DOC_MAX) photos.push(it) })
        return { ...d, photos }
      })
      this.setData({ docs })
      this._persistDocs()
    }
    if (failed && !items.length) {
      wx.showToast({ title: '上传失败，请重试', icon: 'none' })
    } else if (failed) {
      wx.showToast({ title: `${items.length} 个成功 / ${failed} 个失败`, icon: 'none' })
    } else {
      wx.showToast({ title: successMsg, icon: 'none' })
    }
  },

  // 解析上传接口返回的 JSON：取出缩略图（thumb）与原图（origin）
  _extractUrls(data) {
    const thumb = this._findByKeys(data, ['thumb', 'thumbnail', 'thumbUrl', 'small', 'smallUrl', 'preview', 'previewUrl'])
    const origin = this._findByKeys(data, ['origin', 'original', 'origUrl', 'rawUrl', 'source', 'sourceUrl', 'url', 'fullUrl', 'fileUrl', 'imageUrl', 'imgUrl', 'path', 'filePath', 'src', 'link'])
    return {
      thumb: this._toFullUrl(thumb || origin),
      origin: this._toFullUrl(origin || thumb)
    }
  },

  // 递归按字段名查找字符串值，兼容数组与多层嵌套对象
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

  // 相对路径补全为完整地址（如 /upload/xxx.png → BASE + /upload/xxx.png）
  _toFullUrl(url) {
    if (!url) return ''
    if (/^https?:\/\//i.test(url) || url.indexOf('data:') === 0) return url
    return BASE + (url.charAt(0) === '/' ? url : '/' + url)
  },

  // 提交给后端时去掉 IP/域名，仅保留相对地址（如 /upload/xxx.png）
  _relativeUrl(url) {
    if (!url || typeof url !== 'string') return ''
    if (url.indexOf(BASE) === 0) return url.slice(BASE.length)
    const m = url.match(/^https?:\/\/[^/]+(\/.*)?$/i)
    return m ? (m[1] || '') : url
  },

  removePhoto(e) {
    const id = e.currentTarget.dataset.docid
    const idx = e.currentTarget.dataset.pidx
    const docs = this.data.docs.map(d => {
      if (d.id === id) {
        const photos = [...d.photos]
        photos.splice(idx, 1)
        return { ...d, photos }
      }
      return d
    })
    this.setData({ docs })
    this._persistDocs()
  },

  // 点击已上传项：图片 → 预览原图；文档 → 下载后打开
  previewPhoto(e) {
    const id = e.currentTarget.dataset.docid
    const idx = Number(e.currentTarget.dataset.idx)
    const doc = this._findDoc(id)
    const photos = doc ? this._normalizePhotos(doc.photos) : []
    const target = photos[idx]
    if (!target) return
    // 文档：wx.downloadFile 拉取 → wx.openDocument 打开（showMenu 支持转发/保存）
    if (target.isFile) {
      this._openDocument(target.origin || target.thumb, target.fileName)
      return
    }
    // 图片：仅把图片项加入预览列表（文档地址混入会导致 previewImage 失败）
    const urls = photos.filter((p) => !p.isFile).map((p) => p.origin || p.thumb).filter(Boolean)
    const current = (target.origin || target.thumb) || urls[0] || ''
    if (!current) return
    wx.previewImage({ current, urls })
  },

  // 打开已上传文档：走后端 /file/download?url=<相对路径> 下载接口，再交给系统文档预览
  // 与 downloadTemplate 的 /file/preview?url=... 模式一致，保证访问实际文件走授权下载链路
  _openDocument(url, fileName) {
    if (!url) return
    // 无论存储的是带域名的完整 URL（如 http://...:8114/upload/xxx.pdf）还是相对路径，
    // 都先抽出相对部分再走 /file/download，避免直链被鉴权/防盗链拦截
    const relative = this._relativeUrl(url)
    if (!relative) return
    const downloadUrl = BASE + '/file/download?url=' + encodeURIComponent(relative)
    // 同样落到「原文件名」路径，保证转发/保存出去的文件名可读
    const localName = this._localFileName(fileName || this._fileNameFromUrl(url), '')
    // 中文名若落盘受限，退到英文名（仍好于随机字符）
    const altName = this._localFileName(this._fileNameFromUrl(url), '')
    wx.showLoading({ title: '加载中...', mask: true })
    this._downloadTo(downloadUrl, [localName, altName], (filePath, errInfo, persistErrs) => {
      wx.hideLoading()
      if (!filePath) {
        wx.showToast({
          title: errInfo ? `文件下载失败（${errInfo}）` : '文件下载失败，请检查网络',
          icon: 'none'
        })
        return
      }
      const opts = {
        filePath,
        showMenu: true,
        fail: () => wx.showToast({ title: '文件打开失败', icon: 'none' })
      }
      // 扩展名决定 fileType：docx/xlsx/pptx 等要转成微信支持的类型
      const ext = this._fileExt(this._baseName(filePath))
      if (ext) opts.fileType = ext
      const openIt = () => wx.openDocument(opts)
      if (persistErrs && persistErrs.length) {
        wx.showModal({
          title: '文件名保存失败',
          content: persistErrs.slice(0, 3).join('\n'),
          showCancel: false,
          confirmText: '仍然打开',
          complete: openIt
        })
        return
      }
      wx.showToast({ title: '已保存：' + this._baseName(filePath), icon: 'none', duration: 1600 })
      setTimeout(openIt, 600)
    })
  },

  // 点击模板：弹出「下载打开 / 发送到邮箱」两种获取方式
  downloadTemplate(e) {
    const item = this.data.templates[e.currentTarget.dataset.idx]
    if (!item) return
    // 两种方式都按「材料类型 docType」由后端取文件，不再依赖模板静态地址，
    // 所以这里不再校验文件地址（旧逻辑会因地址为空而拦住下载）
    wx.showActionSheet({
      itemList: ['下载并打开', '发送到邮箱'],
      success: (res) => {
        // 下载并打开：GET /system/apply_user/downloadDoc（id + docType）
        // 发送到邮箱：GET /system/apply_user/sendDocEmail（id + docType + email）
        if (res.tapIndex === 0) this._downloadTemplate(item)
        else if (res.tapIndex === 1) this._askEmailThenSend(item)
      }
    })
  },

  // 方式一：GET /system/apply_user/downloadDoc?id=<applyUserId>&docType=<docType> 下载
  //   → wx.openDocument 打开（showMenu 支持转发/保存到手机）
  // 下载时指定 filePath 为「模板名.扩展名」，避免保存/转发出去的文件名是一串随机字符
  async _downloadTemplate(item) {
    // applyUserId 可能还没加载（接口异步）→ 这里补拉一次
    if (!this.data.applyUserId) {
      try { await this._loadUserType() } catch (e) { /* 失败走下方兜底 */ }
    }
    const id = this.data.applyUserId || this._applyUserId()
    if (!id) {
      wx.showToast({ title: '未获取到申请记录，请重新登记', icon: 'none' })
      return
    }
    // docType：模板列表项自带的材料类型（字典 doc_type 的值），缺失时回退列表 id
    const docType = (item && String(item.docType || '').trim() !== '') ? item.docType : (item ? item.id : '')
    const url = applyUserDocUrl(id, docType)
    // 文件名优先用材料清单里写死的中文名（如「平台使用申请书」），
    // 避免后端 /system/doc_info/get 返回的模板名本身是无意义字符串时，文件名也跟着变乱码；
    // 再依次退到接口给的模板名、英文文件名
    const doc = (this.data.docs || []).find(d => String(d.docType) === String(docType))
    const fileName = this._localFileName(
      (doc && doc.name) || (item && (item.name || item.file)) || '', item && item.type)
    const altName = (item && item.file) ? this._localFileName(item.file, item.type) : ''
    console.log('[upload] 模板下载：', url, '→ 保存为', fileName, '（兜底名', altName || '无', '）')
    wx.showLoading({ title: '下载中...', mask: true })
    this._downloadTo(url, [fileName, altName], (filePath, errInfo, persistErrs) => {
      wx.hideLoading()
      if (!filePath) {
        // errInfo 区分「接口返回异常（HTTP 码）」与「网络 / 域名问题（errMsg）」
        wx.showToast({
          title: errInfo ? `下载失败（${errInfo}）` : '模板下载失败，请检查网络',
          icon: 'none'
        })
        return
      }
      const opts = {
        filePath,
        showMenu: true,
        fail: () => wx.showToast({ title: '文件打开失败，请重试', icon: 'none' })
      }
      const ext = this._fileExt(this._baseName(filePath))
      if (item && item.type) opts.fileType = item.type
      else if (ext) opts.fileType = ext
      const openIt = () => wx.openDocument(opts)
      // 落盘失败（文件名只能是随机临时名）：把具体错误弹出来，便于定位
      if (persistErrs && persistErrs.length) {
        wx.showModal({
          title: '文件名保存失败',
          content: persistErrs.slice(0, 3).join('\n'),
          showCancel: false,
          confirmText: '仍然打开',
          complete: openIt
        })
        return
      }
      // 先显示实际保存的文件名（便于核对是不是可读名），再打开
      wx.showToast({ title: '已保存：' + this._baseName(filePath), icon: 'none', duration: 1600 })
      setTimeout(openIt, 600)
    })
  },

  // 方式二：发送到邮箱 —— 先弹出输入框（回填上次用过的邮箱），
  // 确认后调 GET /system/apply_user/sendDocEmail（id + docType + email）
  async _askEmailThenSend(item) {
    // applyUserId 可能还没加载（接口异步）→ 这里补拉一次
    if (!this.data.applyUserId) {
      try { await this._loadUserType() } catch (e) { /* 失败走下方兜底 */ }
    }
    const id = this.data.applyUserId || this._applyUserId()
    if (!id) {
      wx.showToast({ title: '未获取到申请记录，请重新登记', icon: 'none' })
      return
    }
    const lastEmail = wx.getStorageSync('templateEmail') || ''
    wx.showModal({
      title: '发送到邮箱',
      editable: true,
      placeholderText: '请输入接收邮箱地址',
      content: lastEmail,
      confirmText: '发送',
      confirmColor: '#33ADDE',
      success: (res) => {
        if (!res.confirm) return
        const email = String(res.content || '').trim()
        if (!this._isValidEmail(email)) {
          wx.showToast({ title: '邮箱格式不正确', icon: 'none' })
          return
        }
        wx.setStorageSync('templateEmail', email)
        this._sendTemplateToEmail(email, item, id)
      }
    })
  },

  // 邮箱格式校验：常见域名后缀（字母数字开头，至少两级域名）
  _isValidEmail(email) {
    return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(email || ''))
  },

  // 调 GET /system/apply_user/sendDocEmail 让后端把模板作为附件发送到指定邮箱
  // 参数与下载一致：id = 申请用户 id、docType = 材料类型，再加上收件 email
  async _sendTemplateToEmail(email, item, id) {
    const docType = (item && String(item.docType || '').trim() !== '') ? item.docType : (item ? item.id : '')
    wx.showLoading({ title: '发送中...', mask: true })
    try {
      await sendApplyUserDocEmail({ id, docType, email })
      wx.hideLoading()
      wx.showToast({ title: '已发送，请查收邮箱', icon: 'none' })
    } catch (err) {
      wx.hideLoading()
      console.error('[upload] /system/apply_user/sendDocEmail 发送失败：', err)
      wx.showToast({ title: (err && err.message) || '发送失败，请重试', icon: 'none' })
    }
  },

  async submitUpload() {
    // 「保存并返回」需校验必传材料：1/2/3 必传；院外或院内「科研组自聘」再加合同证明文件（docType 4）
    // 身份 / 用户类型若还没加载完，先补加载，避免刚进页面就点保存时漏校验
    if (!this._identityLoaded) {
      try { await this._loadIdentity() } catch (e) { /* 失败按当前值继续校验 */ }
    }
    if (!this.data.userType) {
      try { await this._loadUserType() } catch (e) { /* 失败按当前值继续校验 */ }
    }
    const required = this._requiredDocTypes()
    const missing = this.data.docs.filter(d => required.indexOf(Number(d.docType)) >= 0 && d.photos.length === 0)
    if (missing.length > 0) {
      wx.showToast({ title: '请上传：' + missing[0].name, icon: 'none' })
      return
    }
    wx.showModal({
      title: '保存确认',
      content: '保存后将返回准入总览，您可继续参加安全考试或直接提交审核。保存前请核对材料（照片或文档）是否清晰完整。',
      confirmText: '保存材料',
      confirmColor: '#33ADDE',
      success: (res) => {
        if (res.confirm) this._saveAttachments(true)
      }
    })
  },

  // 组装附件列表：按文档类型分组，每条 { docType, urls: [...] }（applyUserId 单独传递）
  // url 仅保留相对地址（不含 IP/域名）
  _buildAttachmentList() {
    const list = []
    this.data.docs.forEach((doc) => {
      const urls = (doc.photos || [])
        .map((p) => this._relativeUrl((p && (p.origin || p.thumb)) || (typeof p === 'string' ? p : '')))
        .filter((u) => !!u)
      if (!urls.length) return
      const docType = doc.docType !== undefined ? doc.docType : doc.id
      list.push({ docType, urls })
    })
    return list
  },

  // 提交附件：POST /system/apply_user_attachment/saveAll（back=true 表示「保存并返回」，成功后返回准入总览）
  async _saveAttachments(back) {
    // 「保存并返回」（back=true）需校验必传材料；「暂存」（back=false）不校验
    // 校验统一放在保存入口，避免 _loadUserType 异步未完成时院外人员 type=4 漏校验
    if (back) {
      // 保险：若 userType / 身份尚未加载（页面刚打开就点保存的极端场景），同步再拉一次
      if (!this.data.userType) {
        try { await this._loadUserType() } catch (e) { /* 失败用当前值继续校验 */ }
      }
      if (!this._identityLoaded) {
        try { await this._loadIdentity() } catch (e) { /* 失败用当前值继续校验 */ }
      }
      const required = this._requiredDocTypes()
      const missing = this.data.docs.filter(d => required.indexOf(Number(d.docType)) >= 0 && d.photos.length === 0)
      if (missing.length > 0) {
        wx.showToast({ title: '请上传：' + missing[0].name, icon: 'none' })
        return
      }
    }
    const applyId = this._applyId()
    if (applyId === '') {
      wx.showToast({ title: '未获取到申请记录，请重新登记', icon: 'none' })
      return
    }
    const list = this._buildAttachmentList()
    if (!list.length) {
      wx.showToast({ title: '请先上传材料照片', icon: 'none' })
      return
    }
    wx.showLoading({ title: '保存中...', mask: true })
    try {
      await saveApplyUserAttachments(applyId, list)
      wx.hideLoading()
      this._persistDocs()
      wx.setStorageSync('admissionUploadTime', this._nowText())
      wx.showToast({ title: back ? '保存成功' : '已暂存草稿', icon: 'none' })
      if (!back) return
      // 返回准入总览第 2 步「材料提交」（不推进流程步骤）
      setTimeout(() => {
        wx.navigateBack({
          fail: () => wx.navigateTo({ url: '/pages/onboarding/index/index' })
        })
      }, 600)
    } catch (err) {
      wx.hideLoading()
      console.error('[upload] /system/apply_user_attachment/saveAll 保存失败：', err)
      wx.showToast({ title: (err && err.message) || (back ? '保存失败，请重试' : '暂存失败，请重试'), icon: 'none' })
    }
  },

  // 暂存：同样调用 saveAll，但不返回准入总览
  saveDraft() {
    this._saveAttachments(false)
  }
})
