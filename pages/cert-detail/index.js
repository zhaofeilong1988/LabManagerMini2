// pages/cert-detail/index.js
// 证书详情页：
//   数据源   GET /system/cert_record/detail?id={id}
//   入口     my-certificates 列表 onCardTap 携带 ?id=xxx
//   PDF      底部「查看证书原件」按钮 → wx.downloadFile + wx.openDocument(fileType='pdf')
//   渲染     详细字段映射 + 视觉优化（hero、徽章、有效期对开、技能标签）

const { CERT_RECORD_LIST_KEY, getCertRecordDetail } = require('../../utils/api.js')

// ──────── 枚举映射（与 my-certificates 共享，状态字段集中维护） ────────
const TYPE_LABEL = { 1: '安全证书', 2: '资质证书', 3: '培训证书' }
const STATE_MAP = {
  1: { text: '有效',   cls: 'valid' },
  0: { text: '已失效', cls: 'invalid' },
  2: { text: '审核中', cls: 'reviewing' },
  3: { text: '已过期', cls: 'expired' },
  4: { text: '已撤回', cls: 'invalid' }
}

// ──────── 字段提取工具 ────────
function pick(row, ...keys) {
  for (const k of keys) {
    if (!k) continue
    const parts = k.split('.')
    let v = row
    for (const p of parts) {
      if (v == null) { v = undefined; break }
      v = v[p]
    }
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}
function str(v, dflt) {
  return (v === undefined || v === null) ? (dflt || '') : String(v).trim()
}
function num(v) {
  if (v === '' || v == null) return 0
  const n = Number(v)
  return isNaN(n) ? 0 : n
}

// 日期清洗：YYYY-MM-DD / YYYY-MM-DD HH:mm[:ss] / T 分隔 / unix(秒/毫秒)
function fmtDate(s) {
  if (s === '' || s == null) return ''
  if (typeof s === 'number' || /^\d{9,13}$/.test(String(s).trim())) {
    const raw = String(s).trim()
    const ms = raw.length === 13 ? Number(raw) : Number(raw) * 1000
    const d = new Date(ms)
    if (!isNaN(d.getTime())) {
      const p = (x) => (x < 10 ? '0' + x : '' + x)
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }
  }
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}
// 更「庄重」的日期呈现（点号分隔）：YYYY.MM.DD
function fmtDateElegant(s) {
  const ymd = fmtDate(s)
  return ymd ? ymd.replace(/-/g, '.') : ''
}

// 找附件 URL（兼容多个字段名）
function pickAttachment(row) {
  const url = str(pick(row,
    'certUrl', 'pdfUrl', 'fileUrl', 'attachment', 'attachmentUrl',
    'pdf', 'file', 'file_path', 'path', 'url',
    'cert.fileUrl', 'cert.attachment', 'cert.url'
  ))
  if (!url) return { url: '', kind: 'none' }
  const lower = url.toLowerCase()
  if (/(\.pdf)(\?|$)/.test(lower) || /\/pdf\b/i.test(lower)) return { url, kind: 'pdf' }
  if (/(\.jpg|\.jpeg|\.png|\.webp)(\?|$)/i.test(lower)) return { url, kind: 'image' }
  return { url, kind: 'unknown' }
}

// 把字符串态 state 归一到 STATE_MAP
function resolveState(raw) {
  if (raw === '' || raw == null) return STATE_MAP[1]
  const n = num(raw)
  if (STATE_MAP[n]) return STATE_MAP[n]
  const txt = String(raw).trim()
  if (/有效|通过|success/i.test(txt)) return STATE_MAP[1]
  if (/失效|无效|未通过|fail/i.test(txt)) return STATE_MAP[0]
  if (/审核|review/i.test(txt))         return STATE_MAP[2]
  if (/过期|expired/i.test(txt))        return STATE_MAP[3]
  if (/撤回/i.test(txt))               return STATE_MAP[4]
  return STATE_MAP[1]
}

// 计算「剩余天数」：今天 → expireDate
function daysToExpiry(expireYmd, stateCls) {
  if (!expireYmd || stateCls !== 'valid') return 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(expireYmd + 'T00:00:00')
  if (isNaN(target.getTime())) return 0
  const ms = target.getTime() - today.getTime()
  return Math.max(0, Math.floor(ms / 86400000))
}

// 关联培训数组规整
function pickTrainings(row) {
  let arr = pick(row, 'trainings', 'trainingList', 'courses', 'relatedTrainings')
  if (!Array.isArray(arr)) arr = []
  return arr.map(t => ({
    name: str(pick(t, 'name', 'trainingName', 'courseName', 'title'), '关联培训'),
    score: str(pick(t, 'score', 'examScore'), ''),
    date: fmtDate(pick(t, 'examDate', 'date'))
  }))
}

// 技能/资格标签数组规整
function pickSkills(row) {
  let arr = pick(row, 'skills', 'abilities', 'skillTags', 'tags', 'scope')
  if (Array.isArray(arr)) {
    return arr.map(x => str(x)).filter(Boolean)
  }
  // 也支持字符串：「细胞培养,流式分析,PCR」逗号分隔
  const csv = str(pick(row, 'skillCsv', 'skillsText'))
  if (csv) return csv.split(/[,，;；、\/]/).map(x => x.trim()).filter(Boolean)
  return []
}

// 提取「详情字符串」类字段：兼容字符串或对象 {content, text, summary, desc, ...}
function pickText(row, ...keys) {
  for (const k of keys) {
    if (!k) continue
    const parts = k.split('.')
    let v = row
    for (const p of parts) {
      if (v == null) { v = undefined; break }
      v = v[p]
    }
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'object') {
      const txt = str(v.content || v.text || v.summary || v.desc || v.description || v.body || v.value)
      if (txt) return txt
      // 数组 → 用逗号连接
      if (Array.isArray(v)) return v.map(x => str(x)).filter(Boolean).join('、')
    } else {
      return String(v).trim()
    }
  }
  return ''
}

// 把详情 row → 视图对象
function normalizeCert(row) {
  if (!row || typeof row !== 'object') return null
  const stateRaw = pick(row, 'state', 'status', 'valid', 'isValid')
  const sm = resolveState(stateRaw)
  const typeRaw = pick(row, 'certType', 'type', 'category')
  // 发证日期：业务专用字段 receiveDate 与通用 issueDate 同优先级
  const issueDate = fmtDate(pick(row, 'receiveDate', 'issueDate', 'issue_date', 'validFrom', 'valid_from', 'startTime'))
  const expireDate = fmtDate(pick(row, 'expireDate', 'expire_date', 'expireTime', 'expiryDate', 'validUntil', 'valid_until', 'endTime'))
  const att = pickAttachment(row)
  const daysLeft = daysToExpiry(expireDate, sm.cls)

  return {
    id: str(pick(row, 'id', 'certId', 'cert_id', 'recordId')),
    raw: row,                   // 调试用
    name: str(pick(row, 'certName', 'name', 'certificateName', 'title', 'cert.name')) || '证书',
    typeRaw: str(typeRaw, ''),
    typeLabel: TYPE_LABEL[num(typeRaw)] || (str(typeRaw) || '证书'),
    certNo: str(pick(row, 'certNo', 'cert_no', 'certificateNo', 'no', 'number')),
    // 持证人：业务专用 receiveUser 与通用 holderName 同优先级
    holderName: str(pick(row, 'receiveUser', 'holderName', 'userName', 'realName', 'applicant', 'cert.holderName')),
    // 颁发机构：业务专用 certSource 与通用 issuer 同优先级
    issuer: str(pick(row, 'certSource', 'issuer', 'issuerName', 'organizer', 'issueOrg', 'issueOrgName', 'company', 'org.name')),
    deviceName: str(pick(row, 'deviceName', 'device.name', 'cert.deviceName')),
    trainingName: str(pick(row, 'trainingName', 'training.name', 'courseName', 'course.name', 'cert.trainingName')),
    score: str(pick(row, 'score', 'examScore', 'exam_score'), ''),
    examDate: fmtDate(pick(row, 'examDate', 'exam_date', 'examTime')),
    issueDate,
    expireDate,
    issueDateElegant: fmtDateElegant(issueDate),
    expireDateElegant: fmtDateElegant(expireDate),
    daysLeft,
    isLongTerm: !expireDate,                // 没有失效日期 → 长期有效
    statusText: sm.text,
    statusCls: sm.cls,
    // 证书简介：业务专用 info 字段（兼容字符串或对象）
    brief: pickText(row, 'info', 'brief', 'summary', 'intro', 'outline', 'cert.info', 'cert.brief'),
    // 证书说明：业务专用 detail 字段（兼容字符串或对象）
    description: pickText(row, 'detail', 'desc', 'description', 'memo', 'remark', 'cert.desc', 'cert.detail'),
    trainings: pickTrainings(row),
    skills: pickSkills(row),
    attachmentUrl: att.url,
    attachmentKind: att.kind,
    hasAttachment: !!att.url,
    qrCodeUrl: str(pick(row, 'qrCode', 'qrcodeUrl', 'qr_code_url', 'qrCodeUrl', 'verifyUrl'))
  }
}

Page({
  data: {
    cert: null,
    loading: true,
    loadError: ''
  },

  onLoad(options) {
    const id = (options && options.id) || ''
    if (!id) {
      this.setData({ loading: false, loadError: '缺少证书 id，请从证书列表进入' })
      return
    }
    this._certId = id
    this._fetch(id)
  },

  // GET /system/cert_record/detail?id=xxx
  _fetch(id) {
    this.setData({ loading: true, loadError: '' })
    getCertRecordDetail(id)
      .then(row => {
        const cert = normalizeCert(row)
        if (!cert) {
          this.setData({ loading: false, loadError: '未找到对应证书（可能已被撤销）' })
          return
        }
        this._apply(cert)
      })
      .catch(err => {
        console.warn('[cert-detail] /system/cert_record/detail 失败：', err)
        // 接口失败时仍尝试从列表缓存兜底，避免白屏
        let cached = []
        try { cached = wx.getStorageSync(CERT_RECORD_LIST_KEY) || [] } catch (e) { cached = [] }
        const hit = (Array.isArray(cached) ? cached : []).find(
          x => String((x && (x.id || x.certId || x.cert_id))) === String(id)
        )
        if (hit) {
          const cert = normalizeCert(hit)
          this._apply(cert)
          wx.showToast({
            title: '已用本地缓存渲染（' + ((err && err.message) || '网络异常') + '）',
            icon: 'none',
            duration: 2200
          })
          return
        }
        this.setData({
          loading: false,
          loadError: (err && err.message) || '证书详情加载失败，请稍后重试'
        })
      })
  },

  _apply(cert) {
    this.setData({ cert, loading: false, loadError: '' })
    if (cert && cert.name) wx.setNavigationBarTitle({ title: cert.name })
  },

  // ── 操作 ──
  onCopyCertNo() {
    const no = (this.data.cert && this.data.cert.certNo) || ''
    if (!no) {
      wx.showToast({ title: '证书编号为空', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: no,
      success: () => wx.showToast({ title: '证书编号已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败，请长按选择复制', icon: 'none' })
    })
  },

  // 预览附件：PDF → download + openDocument；图片 → previewImage
  onPreviewAttachment() {
    const cert = this.data.cert
    if (!cert || !cert.attachmentUrl) {
      wx.showToast({ title: '该证书暂无原件可查看', icon: 'none' })
      return
    }
    const url = cert.attachmentUrl
    const kind = cert.attachmentKind
    if (kind === 'image') {
      wx.previewImage({
        current: url,
        urls: [url],
        fail: () => wx.showToast({ title: '图片预览失败', icon: 'none' })
      })
      return
    }
    wx.showLoading({ title: '正在下载证书…', mask: true })
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode === 200 && res.tempFilePath) {
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType: kind === 'pdf' ? 'pdf' : undefined,
            showMenu: true,
            success: () => {
              wx.hideLoading()
              wx.showToast({ title: '已打开证书原件', icon: 'success' })
            },
            fail: (err) => {
              wx.hideLoading()
              wx.showToast({
                title: '打开失败：' + ((err && err.errMsg) || '文件类型不支持'),
                icon: 'none',
                duration: 2200
              })
            }
          })
        } else {
          wx.hideLoading()
          wx.showToast({
            title: '下载失败（HTTP ' + (res.statusCode || '?') + '）',
            icon: 'none',
            duration: 2000
          })
        }
      },
      fail: (err) => {
        wx.hideLoading()
        wx.showToast({
          title: '下载失败：' + ((err && err.errMsg) || '网络异常'),
          icon: 'none',
          duration: 2000
        })
      }
    })
  },

  onBackToList() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/index/index' }) })
  }
})
