// utils/api.js —— 后端接口统一封装（仪器扫码 → 设备详情查询）

// ─────────────────────────────────────────────────────────────────────────────
// 后端地址配置
//   BASE = 后端服务域名（统一通过该地址访问所有接口）
//
// 部署/调试说明：
//   1. 后端服务部署在 http://devicedemo.xbioware.com
//   2. 微信开发者工具 → 详情 → 本地设置 → 勾选
//      「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」
//      否则线上域名会被拦截（仅开发期间临时绕过；正式上线需在公众平台配置合法域名）
//   3. 手机上若请求失败：点小程序右上角「···」→ 打开调试
// ─────────────────────────────────────────────────────────────────────────────
// const BASE = 'https://devicedemo.xbioware.com'
const BASE = 'http://127.0.0.1:8115'
// token 统一由 utils/token.js 持有（内存 + 本地持久化）：
// 接口层注入、登录态保存/清除、接口响应轮换，都读写同一份，不再各存一份互相不同步。
const tokenStore = require('./token.js')

// 读取当前生效的 token：始终取最新值，不用模块内变量快照
function curToken() { return tokenStore.getToken() }
const TIMEOUT = 10000

// 首页扫码 → 详情页数据传递的缓存键（navigateTo 不便携带复杂对象，用本地缓存中转）
const SCAN_DETAIL_KEY = 'scan_detail_cache'
// 仪器「预约」→ 预约页数据传递的缓存键（checkAppointment 通过后由 /api/deviceApply 写入）
const DEVICE_APPLY_KEY = 'device_apply_cache'
// 预约详情页数据传递的缓存键（由 /api/deviceApplyDetail 写入，booking-detail 页面读取渲染）
const BOOKING_DETAIL_KEY = 'booking_detail_cache'
// 准入流程「申请用户详情」跨页缓存（同一会话 5 分钟内复用，减少 index → upload 间的重复请求）
const ADMISSION_USER_DETAIL_KEY = 'admissionUserDetailCache'
// 准入用户详情缓存有效期（毫秒）：5 秒（状态变更频繁时避免读到过期数据；
// 仅用于「总览 → 上传」这类短跳转链的重复请求合并，不再做长时间缓存）
const ADMISSION_USER_DETAIL_TTL = 5 * 1000
// 证书列表跨页缓存（profile → my-certificates 跳转时携带，避免接口二次请求）
const CERT_RECORD_LIST_KEY = 'cert_record_list_cache'
// 准入审批列表（/system/apply_user/api/list）默认每页条数
const APPROVAL_PAGE_SIZE = 10

// 更新 token（/api/login 成功后调用）：写入统一来源（内存 + 本地持久化），
// 后续接口自动使用新值；传空值则回退默认调试 token 并清掉持久化
function setToken(token) {
  const old = tokenStore.getToken()
  const now = tokenStore.setToken(token)
  if (now !== old) {
    // 刚写入的就是最新的：刷新时间一并更新，避免紧接着又被判定为过期而重复换 token
    TOKEN_TS = Date.now()
    console.log('[api] token 已更新（写入统一来源）')
  }
  return now
}

// 读取当前生效的 token
function getToken() {
  return tokenStore.getToken()
}

// ── 最新 token 保障 ──
// token 上一次成功刷新的时间（0 = 从未刷新过）
let TOKEN_TS = 0
// token 有效期：超过这个时长，用之前先重新换取一次（毫秒）
const TOKEN_TTL = 5 * 60 * 1000
// 刷新在途标记：并发调用时共用同一个刷新请求，避免重复调 /api/login
let _tokenRefreshTask = null

// wx.login 获取临时 code
function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: res => ((res && res.code) ? resolve(res.code) : reject(new Error('wx.login 获取 code 失败'))),
      fail: err => reject(err || new Error('wx.login 失败'))
    })
  })
}

// 确保 token 是最新：过期（或从未刷新）时先 wx.login → /api/login 换取新 token
// 成功：返回新 token（已写入 TOKEN 与本地缓存）；失败：不阻塞，返回当前 token
function ensureToken(force) {
  // token 由 utils/token.js 统一持有，内存值即最新值，无需再与本地缓存对齐
  const fresh = TOKEN_TS && (Date.now() - TOKEN_TS < TOKEN_TTL)
  if (!force && fresh) return Promise.resolve(curToken())
  if (_tokenRefreshTask) return _tokenRefreshTask
  console.log('[api] token 已过期/未刷新，先调用 /api/login 换取最新 token')
  const task = wxLoginCode()
    .then(code => loginByPhone(code, ''))
    .then(() => {
      TOKEN_TS = Date.now()
      console.log('[api] /api/login 刷新成功，token 已更新')
      return curToken()
    })
    .catch(err => {
      // 后端/网络异常时沿用现有 token，不影响本次业务请求
      console.warn('[api] /api/login 刷新 token 失败，沿用当前 token：', err && (err.message || err))
      return curToken()
    })
    .then(v => {
      if (_tokenRefreshTask === task) _tokenRefreshTask = null
      return v
    })
  _tokenRefreshTask = task
  return task
}

// 小程序启动 / 重新加载时的会话初始化：先 /api/login，再 /system/apply_user/detail
//   ① wx.login 取 code → POST /api/login 换取 token（loginByPhone 内部已写入全局 TOKEN 与本地缓存）
//   ② 用 ① 返回的 openid 调 GET /system/apply_user/detail，再用该接口响应体的 token 刷新一次
//      （后端会随 /system/apply_user/detail 下发新 token，避免后续 /api/xxx 鉴权失败）
// 返回 { token, openid, phone, name, applyUser }；任一步失败都不阻塞小程序启动（返回 null）
function initSession() {
  console.log('[api] 会话初始化：① /api/login')
  return wxLoginCode()
    .then(code => loginByPhone(code, ''))
    .then(res => {
      TOKEN_TS = Date.now()
      const openid = res.openid || ''
      if (!openid) {
        console.warn('[api] /api/login 未返回 openid，跳过 /system/apply_user/detail')
        return Object.assign({}, res, { applyUser: null })
      }
      console.log('[api] 会话初始化：② /system/apply_user/detail，openId =', openid)
      return getApplyUserDetail(openid)
        .then(detail => Object.assign({}, res, { applyUser: (detail && detail.applyUser) || null }))
        .catch(err => {
          console.warn('[api] /system/apply_user/detail 失败，沿用 /api/login 的 token：', err && (err.message || err))
          return Object.assign({}, res, { applyUser: null })
        })
    })
    .catch(err => {
      console.warn('[api] 会话初始化失败，沿用当前 token：', err && (err.message || err))
      return null
    })
}

// 通用 POST 请求：超时中断、非 2xx 视为失败
function request(url, data) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('请求超时'))
    }, TIMEOUT)
    wx.request({
      url,
      method: 'POST',
      data,
      header: { 'content-type': 'application/json' },
      timeout: TIMEOUT,
      success(res) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const code = res.statusCode || 0
        if (code >= 200 && code < 300) {
          resolve(res.data)
        } else {
          reject(new Error('服务返回异常（HTTP ' + code + '）'))
        }
      },
      fail(err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err || new Error('网络请求失败'))
      }
    })
  })
}

// 通用 GET 请求：超时中断、非 2xx 视为失败
function getRequest(url, params) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('请求超时'))
    }, TIMEOUT)
    let finalUrl = url
    if (params && typeof params === 'object') {
      const qs = Object.keys(params)
        .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
        .join('&')
      if (qs) finalUrl += (url.indexOf('?') >= 0 ? '&' : '?') + qs
    }
    wx.request({
      url: finalUrl,
      method: 'GET',
      timeout: TIMEOUT,
      success(res) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const code = res.statusCode || 0
        if (code >= 200 && code < 300) {
          resolve(res.data)
        } else {
          reject(new Error('服务返回异常（HTTP ' + code + '）'))
        }
      },
      fail(err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err || new Error('网络请求失败'))
      }
    })
  })
}

// 获取设备详情：POST /api/getDeviceDetail，字段 { deviceId, token }
function getDeviceDetail(deviceId) {
  return request(BASE + '/api/getDeviceDetail', {
    deviceId: String(deviceId || '').trim(),
    token: curToken()
  })
}

// 仪器列表：POST /api/deviceList
// 返回解包后的设备数组，兼容 { code, msg, data: [...] } / 直接返回数组 /
// { rows } / { list } / { records } / { items } 等常见分页结构
function getDeviceList(params) {
  console.log('[deviceList] 小程序发起 /api/deviceList 请求')
  // token 兜底注入：与同文件其他 /api/* 接口保持一致（调用方显式传了则用调用方的）
  return request(BASE + '/api/deviceList', Object.assign({ token: curToken() }, params || {})).then(res => {
    console.log('[deviceList] /api/deviceList 原始返回：', res)
    const data = unwrap(res, '仪器列表获取失败')
    if (!data) return []
    if (Array.isArray(data)) return data
    const inner = data.rows || data.list || data.records || data.items ||
      (data.data && Array.isArray(data.data) ? data.data : null)
    return Array.isArray(inner) ? inner : []
  })
}

// 预约权限校验：POST /api/checkAppointment，字段 { token, deviceId }
// 业务失败（code 非 0/200，如「无预约权限」）时抛出后端 msg；成功返回解包后的业务数据
function checkAppointment(deviceId) {
  return request(BASE + '/api/checkAppointment', {
    token: curToken(),
    deviceId: String(deviceId || '').trim()
  }).then(res => {
    console.log('[checkAppointment] /api/checkAppointment 原始返回：', res)
    return unwrap(res, '预约权限校验失败')
  })
}

// 预约页数据获取：POST /api/deviceApply，字段 { token, deviceId }
// checkAppointment 校验通过（code=0 有预约权限）后调用；返回预约页渲染所需的设备申请数据
function getDeviceApply(deviceId) {
  // 兜底：id 为空直接拒绝，绝不向后端发出空参数的请求
  // （无论上层何处误调用，这里都是最后一道防线）
  if (deviceId == null || String(deviceId).trim() === '') {
    console.warn('[deviceApply] id 为空，已拦截本次请求')
    return Promise.reject(new Error('id 不能为空'))
  }
  // 参数名为 id（数值与 deviceId 一致），用数字类型提交（后端要求）
  const numId = Number(deviceId)
  console.log('[deviceApply] 发起请求，id =', isNaN(numId) ? deviceId : numId)
  return request(BASE + '/api/deviceApply', {
    token: curToken(),
    id: isNaN(numId) ? deviceId : numId
  }).then(res => {
    console.log('[deviceApply] /api/deviceApply 原始返回：', res)
    return unwrap(res, '预约数据获取失败')
  })
}

// 提交仪器预约：POST /api/doDeviceApply
// 入参 payload 字段：
//   deviceId     仪器 id（数字字符串或数值，按后端约定透传）
//   startAt      'YYYY-MM-DD HH:mm:ss' 起始时间
//   finishAt     'YYYY-MM-DD HH:mm:ss' 结束时间
//   operateType  1=自助 / 2=委托（按当前计费模式映射）
//   price        当前模式的每小时价格（与界面上展示的 selfY/entY 一致）
//   amount       总费用 = price × unitCount（这里默认 1 → 与 price 数值相等，便于后端校验）
//   unitCount    计费单位数量（默认 1，与示例 payload 保持一致）
//   memo1        测试目的
//   memo2        测试内容
//   memo3        备注
//   memo4        备用 memo（默认空字符串，按示例 payload 透传）
// token 由本函数内部从全局 TOKEN 注入（与项目其它接口一致），调用方无需重复传
// 返回：解包后的业务数据
function doDeviceApply(payload) {
  const p = Object.assign({ token: curToken() }, payload || {})
  // 后端期望 deviceId 为数字；空字符串、null/undefined 兜底：设备 id 缺失时直接拒绝请求
  if (p.deviceId == null || String(p.deviceId).trim() === '') {
    return Promise.reject(new Error('deviceId 不能为空'))
  }
  const numId = Number(p.deviceId)
  p.deviceId = isNaN(numId) ? p.deviceId : numId
  // memo4 缺省时显式补成空串，与示例 payload 字段一致
  if (p.memo4 === undefined || p.memo4 === null) p.memo4 = ''
  // unitCount 缺省时显式补 1（与示例 payload 保持一致）
  if (p.unitCount == null || p.unitCount === '') p.unitCount = 1
  console.log('[doDeviceApply] /api/doDeviceApply 提交：', p)
  return request(BASE + '/api/doDeviceApply', p).then(res => {
    console.log('[doDeviceApply] /api/doDeviceApply 原始返回：', res)
    return unwrap(res, '提交预约失败')
  })
}

// 新增 / 修改仪器禁用时段：POST /api/editDisable
// 入参 payload 字段（对照 LabManagerMini/pages/appointChange 的 saveDisable / addDisableAllDay）：
//   disable  {
//     id          禁用记录 id（新增时不传，后端生成；修改时传该条 id）
//     device_id   仪器 id
//     begin_at    'YYYY-MM-DD HH:mm:ss' 起始
//     finish_at   'YYYY-MM-DD HH:mm:ss' 结束
//     disable     true = 禁用
//     edited      false（提交的是已保存态）
//     create_by   创建人 user_id
//     create_time 'YYYY-MM-DD HH:mm:ss' 创建时间
//   }
//   token    由本函数内部从全局注入
// 返回：解包后的业务数据（可能含后端生成的 disable id）
function editDisable(disable) {
  if (!disable || typeof disable !== 'object') {
    return Promise.reject(new Error('disable 不能为空'))
  }
  const d = Object.assign({}, disable)
  if (d.device_id == null || String(d.device_id).trim() === '') {
    return Promise.reject(new Error('device_id 不能为空'))
  }
  // device_id / id 后端按数字处理，能转数字就转（与 doDeviceApply 的口径一致）
  const numDev = Number(d.device_id)
  if (!isNaN(numDev)) d.device_id = numDev
  if (d.id != null && String(d.id).trim() !== '') {
    const numId = Number(d.id)
    d.id = isNaN(numId) ? String(d.id) : numId
  } else {
    delete d.id
  }
  d.disable = d.disable === undefined ? true : !!d.disable
  d.edited = !!d.edited
  // 先换取最新 token，避免用旧 token 提交失败
  return ensureToken().then(() => {
    const payload = { token: curToken(), disable: d }
    console.log('[editDisable] /api/editDisable 提交：', payload)
    return request(BASE + '/api/editDisable', payload).then(res => {
      console.log('[editDisable] /api/editDisable 原始返回：', res)
      return unwrap(res, '禁用时段保存失败')
    })
  })
}

// 取消禁用：POST /api/cancelDisable
// 入参 payload 字段（一次取消「一台仪器在某一天」的禁用）：
//   date   'YYYY-MM-DD' 要取消禁用的日期
//   id     仪器 id（device_id，不是禁用记录 id）
//   type   取消范围（字符串）：一天='0'、三天='1'、一周='2'、两周='3'、一个月='4'、
//          两个月='5'、三个月='6'、半年='7'、一年='8'（缺省 '0'）
//   token  由本函数内部从全局注入
// 返回：解包后的业务数据
function cancelDisable(params) {
  const p = params || {}
  if (p.date == null || String(p.date).trim() === '') {
    return Promise.reject(new Error('date 不能为空'))
  }
  if (p.id == null || String(p.id).trim() === '') {
    return Promise.reject(new Error('仪器 id 不能为空'))
  }
  // id 是仪器 id：能转数字就转（与 editDisable 的 device_id 口径一致），type 固定字符串
  const idNum = Number(p.id)
  // 先换取最新 token，避免用旧 token 提交失败
  return ensureToken().then(() => {
    const payload = {
      token: curToken(),
      date: String(p.date),
      id: isNaN(idNum) ? p.id : idNum,
      type: p.type == null ? '0' : String(p.type)
    }
    console.log('[cancelDisable] /api/cancelDisable 提交：', payload)
    return request(BASE + '/api/cancelDisable', payload).then(res => {
      console.log('[cancelDisable] /api/cancelDisable 原始返回：', res)
      return unwrap(res, '取消禁用失败')
    })
  })
}

// 预约详情：POST /api/deviceApplyDetail
// 入参 payload 字段：
//   id     预约记录 id（与本地预约号保持一致，字符串透传）
//   token  由本函数内部从全局 TOKEN 注入（与项目其它接口一致）
// 返回：解包后的业务数据，包含 device / admin / organ / apply 等子对象
function getDeviceApplyDetail(id) {
  if (id == null || String(id).trim() === '') {
    return Promise.reject(new Error('id 不能为空'))
  }
  const payload = { token: curToken(), id: String(id) }
  console.log('[deviceApplyDetail] /api/deviceApplyDetail 提交：', payload)
  return request(BASE + '/api/deviceApplyDetail', payload).then(res => {
    console.log('[deviceApplyDetail] /api/deviceApplyDetail 原始返回：', res)
    return unwrap(res, '预约详情获取失败')
  })
}

// 预约列表：POST /api/applyList
// 入参 payload 字段：
//   state     状态筛选：1=待我审批 / 2=仪器的预约记录 / 3=进行中（缺省 3）
//   deviceId  仪器 id（可选）：仪器详情页「预约记录」按这台仪器过滤，只在该入口传
//   token     由本函数内部从全局 TOKEN 注入（与项目其它接口一致）
// 返回：解包后的预约条目数组（兼容 数组 / {list} / {rows} / {records} / {items} / {data:[]} 等多种分页形态）
function getApplyList(state, params) {
  const st = state == null ? 3 : state
  // 先确保 token 为最新（必要时走 /api/login 换取），再用新 token 发请求，
  // 避免沿用上一次会话/默认调试 token 导致后端按旧身份返回数据
  return ensureToken().then(() => {
    const payload = Object.assign({ token: curToken(), state: st }, params || {})
    // deviceId 统一成字符串提交（与其它接口的 deviceId 口径一致）
    if (payload.deviceId != null) payload.deviceId = String(payload.deviceId)
    console.log('[applyList] /api/applyList 提交：', payload)
    return request(BASE + '/api/applyList', payload)
  }).then(res => {
    console.log('[applyList] /api/applyList 原始返回：', res)
    // 响应里若下发新 token，同步刷新，保持后续接口用最新值
    refreshToken(res)
    const data = unwrap(res, '预约列表获取失败')
    if (Array.isArray(data)) return data
    if (data && typeof data === 'object') {
      const arr = data.list || data.rows || data.records || data.items ||
        (Array.isArray(data.data) ? data.data : null)
      if (Array.isArray(arr)) return arr
    }
    return []
  })
}

// 预约审批结果提交（通过 / 拒绝）：POST /api/doApplyCheck
// 入参 payload 字段（对照 LabManagerMini/pages/applyCheck 的 accept / deny）：
//   id         审批单 id（与 /api/applyDetail、/api/applyList 的 id 一致，字符串透传）
//   state      审批结果：2 = 通过，3 = 拒绝
//   priceUp    罚金
//   priceDown  折扣
//   realPrice  实际金额 = 预估金额 + 罚金 - 折扣
//   remark     审批备注
//   token      由本函数内部从全局 TOKEN 注入（与项目其它接口一致）
function doApplyCheck(payload) {
  const p = Object.assign({}, payload || {})
  if (p.id == null || String(p.id).trim() === '') {
    return Promise.reject(new Error('id 不能为空'))
  }
  p.id = String(p.id)
  p.token = curToken()
  console.log('[doApplyCheck] /api/doApplyCheck 提交：', p)
  return request(BASE + '/api/doApplyCheck', p).then(res => {
    console.log('[doApplyCheck] /api/doApplyCheck 原始返回：', res)
    return unwrap(res, '审批提交失败')
  })
}

// 审批单详情：POST /api/applyDetail
// 入参 payload 字段：
//   id     审批单 id（预约记录 id，与 /api/applyList 返回的 id 一致，字符串透传）
//   token  由本函数内部从全局 TOKEN 注入（与项目其它接口一致）
// 返回：解包后的审批单详情（兼容 device / admin / organ / apply 等子对象，也可能直接平铺）
function getApplyDetail(id) {
  if (id == null || String(id).trim() === '') {
    return Promise.reject(new Error('id 不能为空'))
  }
  const payload = { token: curToken(), id: String(id) }
  console.log('[applyDetail] /api/applyDetail 提交：', payload)
  return request(BASE + '/api/applyDetail', payload).then(res => {
    console.log('[applyDetail] /api/applyDetail 原始返回：', res)
    return unwrap(res, '审批单详情获取失败')
  })
}

// 使用记录详情（改单页用）：POST /api/deviceLogDetail
// 入参：{ id, token }；返回 data 内主要两块（对照 LabManagerMini/pages/changeUsingLog）：
//   deviceLog: { id, user_id, user_name, price, count, price_up, price_down, amount, begin_at, finish_at }
//   users:     [{ user_id, user_name, login_name }] 可改成的上机用户列表
function getDeviceLogDetail(id) {
  if (id == null || String(id).trim() === '') {
    return Promise.reject(new Error('id 不能为空'))
  }
  // 同 deviceLogList：请求前先换取最新 token
  return ensureToken().then(() => {
    const payload = { token: curToken(), id: String(id) }
    console.log('[deviceLogDetail] /api/deviceLogDetail 提交：', payload)
    return request(BASE + '/api/deviceLogDetail', payload).then(res => {
      console.log('[deviceLogDetail] /api/deviceLogDetail 原始返回：', res)
      return unwrap(res, '使用记录详情获取失败')
    })
  })
}

// 修改使用记录（改单）：POST /api/editDeviceLogDetail
// 参数口径对照 LabManagerMini/pages/changeUsingLog 的 save()：
//   id         记录 id
//   price      第一行的单价
//   num        第一行的数量
//   priceUp    罚金
//   priceDown  折扣
//   itemCount  第一行之外，其余各行 Σ(单价 × 数量)
//   amount     实付金额 = 首行(price × num) + priceUp - priceDown + itemCount（两位小数字符串）
//   userId     这条记录的使用人 id（改了上机用户时传新用户 id）
//   token      由本函数内部从全局 TOKEN 注入
function editDeviceLogDetail(payload) {
  const p = Object.assign({}, payload || {})
  if (p.id == null || String(p.id).trim() === '') {
    return Promise.reject(new Error('id 不能为空'))
  }
  p.id = String(p.id)
  // 同 deviceLogList：提交前先换取最新 token，避免用旧 token 提交失败
  return ensureToken().then(() => {
    p.token = curToken()
    console.log('[editDeviceLogDetail] /api/editDeviceLogDetail 提交：', p)
    return request(BASE + '/api/editDeviceLogDetail', p).then(res => {
      console.log('[editDeviceLogDetail] /api/editDeviceLogDetail 原始返回：', res)
      return unwrap(res, '修改失败')
    })
  })
}

// 设备使用记录列表：POST /api/deviceLogList
// 入参 payload 字段：
//   token     由本函数内部从全局 TOKEN 注入
//   deviceId  仪器 id（与 /api/getDeviceDetail 的 deviceId 一致，用于按仪器过滤）
// 返回：解包后的使用记录数组（兼容 数组 / {list} / {rows} / {records} / {items} / {data:[]} 等多种分页形态）
function deviceLogList(params) {
  const q = Object.assign({}, params || {})
  if (q.deviceId != null) q.deviceId = String(q.deviceId)
  // 发请求前先确保 token 是最新（TTL 内直接返回，不会额外发请求）：
  // 全局 TOKEN 可能是上一次会话残留 / 换账号前的旧值，直接拿来用会鉴权失败或拉到别的账号的数据
  return ensureToken().then(() => {
    const p = Object.assign({ token: curToken() }, q)
    console.log('[deviceLogList] /api/deviceLogList 提交：', p)
    return request(BASE + '/api/deviceLogList', p).then(res => {
      console.log('[deviceLogList] /api/deviceLogList 原始返回：', res)
      const data = unwrap(res, '使用记录获取失败')
      let arr = null
      if (Array.isArray(data)) arr = data
      else if (data && typeof data === 'object') {
        const inner = data.list || data.rows || data.records || data.items ||
          (Array.isArray(data.data) ? data.data : null)
        if (Array.isArray(inner)) arr = inner
      }
      if (!arr) return []
      // 部分接口把 managerId 放在 data 上而不是每条记录里 → 挂到返回数组上，
      // 供调用方在记录级缺失时兜底（wx:for 只遍历下标，附加属性不影响渲染）
      const mgr = (data && typeof data === 'object')
        ? (data.managerId !== undefined && data.managerId !== null ? data.managerId : data.manager_id)
        : undefined
      if (mgr !== undefined && mgr !== null && mgr !== '') arr.managerId = mgr
      return arr
    })
  })
}

// 设备开关机操作：POST /api/deviceOperate
// 入参 payload 字段：
//   token     由本函数内部从全局 TOKEN 注入（与项目其它接口一致）
//   deviceId  仪器 id（与 /api/getDeviceDetail 的 deviceId 一致）
//   operate   1=开机，0=关机
// 提交体只含后端约定的三个字段：{ deviceId, operate, token }
// 返回：解包后的业务数据
function deviceOperate(payload) {
  const p = Object.assign({ token: curToken() }, payload || {})
  if (p.deviceId == null || String(p.deviceId).trim() === '') {
    return Promise.reject(new Error('deviceId 不能为空'))
  }
  if (p.operate == null || (p.operate !== 0 && p.operate !== 1 && p.operate !== '0' && p.operate !== '1')) {
    return Promise.reject(new Error('operate 必须为 1（开机）或 0（关机）'))
  }
  // 统一成数字提交；透传 deviceId / operate / token，以及预约记录 id applyId。
  // applyId 是后端校验「是否已预约」的依据（缺失会返回「这台设备需要预约后才能使用」），
  // 且按约定该字段必须带上：取不到值时提交 null，而不是省略字段
  const body = {
    deviceId: p.deviceId,
    operate: Number(p.operate),
    token: p.token,
    applyId: p.applyId != null ? p.applyId : null
  }
  console.log('[deviceOperate] /api/deviceOperate 提交：', body)
  return request(BASE + '/api/deviceOperate', body).then(res => {
    console.log('[deviceOperate] /api/deviceOperate 原始返回：', res)
    return unwrap(res, '设备操作失败')
  })
}

// 日志内容序列化：后端 /api/uploadLog 的 log 字段为 String 类型，
// 直接提交对象会触发类型转换失败（code 500 没有找到合适的类型转换器），
// 因此对象 / 数组统一 JSON.stringify 成字符串再提交；字符串原样透传。
// 序列化失败（如循环引用）时退化为 String(log)，避免因上报逻辑本身抛错影响主流程。
function toLogString(log) {
  if (log == null) return ''
  if (typeof log === 'string') return log
  // Error 的 message / stack 不可枚举，JSON.stringify 会得到 '{}'，这里直接转 'Error: message'
  if (log instanceof Error) return String(log)
  try {
    const s = JSON.stringify(log)
    return s === undefined ? String(log) : s
  } catch (e) {
    return String(log)
  }
}

// 上传日志：POST /api/uploadLog
// 入参：
//   log    日志内容（对象 / 数组 / 字符串均可；对象会自动序列化为 JSON 字符串，
//          如 { errno, errCode, errMsg } → '{"errno":0,"errCode":0,"errMsg":"success"}'）
//   type   日志类型（业务枚举；4 = 设备开关机操作日志）
// 提交体：{ log, token, type }，token 由本函数内部从全局 TOKEN 注入
// 返回：解包后的业务数据；失败抛错（调用方自行决定是否静默）
function uploadLog(log, type) {
  const payload = { log: toLogString(log), token: curToken(), type: type }
  console.log('[uploadLog] /api/uploadLog 提交：', payload)
  return request(BASE + '/api/uploadLog', payload).then(res => {
    console.log('[uploadLog] /api/uploadLog 原始返回：', res)
    return unwrap(res, '日志上传失败')
  })
}

// 操作日志上报：POST /api/logUpload
// 入参 payload 字段：
//   userId  用户 id（必传；module 里也会拼同一值）
//   level   日志级别：'info'（信息）/ 'error'（错误）
//   module  模块标识，约定 'deviceOperate {userId}'
//   action  操作说明文字（如「上报服务器：开机」/「上报服务器：关机」）
//   message 错误信息（level=error 时填写；信息级别可为空）
//   data    附加数据，缺省 {}（按约定写死空对象）
// 提交体：{ appId: '仪器预约', userId, logs: [{ level, module, action, message, data, timestamp }] }
//   appId 固定「仪器预约」；timestamp 取当前毫秒时间戳；接口不带 token（同参考实现）
// 返回：解包后的业务数据；失败抛错（调用方自行决定是否静默）
function logUpload(p) {
  p = p || {}
  const payload = {
    appId: '仪器预约',
    userId: p.userId != null ? p.userId : '',
    logs: [{
      level: p.level === 'error' ? 'error' : 'info',
      module: p.module || '',
      action: p.action || '',
      message: p.message != null ? p.message : '',
      data: p.data || {},
      timestamp: Date.now()
    }]
  }
  console.log('[logUpload] /api/logUpload 提交：', payload)
  return request(BASE + '/api/logUpload', payload).then(res => {
    console.log('[logUpload] /api/logUpload 原始返回：', res)
    return unwrap(res, '操作日志上传失败')
  })
}

// 取消预约：POST /api/deviceApplyCancel
// 入参 payload 字段：
//   id     预约记录 id（与 /api/applyList 返回的 id 一致，字符串透传）
//   token  由本函数内部从全局 TOKEN 注入（与项目其它接口一致）
// 返回：解包后的业务数据（后端可能直接返 ok 或 { code, msg, data }）
function deviceApplyCancel(id) {
  if (id == null || String(id).trim() === '') {
    return Promise.reject(new Error('id 不能为空'))
  }
  const payload = { token: curToken(), id: String(id) }
  console.log('[deviceApplyCancel] /api/deviceApplyCancel 提交：', payload)
  return request(BASE + '/api/deviceApplyCancel', payload).then(res => {
    console.log('[deviceApplyCancel] /api/deviceApplyCancel 原始返回：', res)
    return unwrap(res, '取消预约失败')
  })
}

// 业务响应解包：兼容 { code, msg, data } 与「直接返回数据体」两种结构。
// 成功码兼容 0 / 200（数字与字符串），无 code 字段视为成功；失败时抛出 msg。
function unwrap(res, failMsg) {
  const body = (res && typeof res === 'object') ? res : {}
  const code = body.code
  if (code !== undefined && code !== null && code !== '') {
    const ok = Number(code) === 0 || Number(code) === 200 ||
      code === true || code === 'success' || code === 'ok'
    if (!ok) throw new Error(body.msg || body.message || failMsg || '请求失败')
  }
  return (body.data !== undefined && body.data !== null) ? body.data : body
}

// 从响应体中抽取 token：按层级广度遍历（顶层 → data / applyUser / user / userInfo 内层），
// 兼容后端把 token 放在不同层级的情况；找不到返回空串
function pickToken(body) {
  const queue = [body]
  let guard = 0
  while (queue.length && guard++ < 10) {
    const cur = queue.shift()
    if (!cur || typeof cur !== 'object') continue
    if (cur.token != null && String(cur.token).trim() !== '') return String(cur.token).trim()
    ;['data', 'applyUser', 'applyUserVO', 'user', 'userInfo'].forEach(k => {
      if (cur[k] && typeof cur[k] === 'object') queue.push(cur[k])
    })
  }
  return ''
}

// 用接口响应里的 token 刷新全局 token（内存 + 本地持久化），后续接口自动带上新值
// 无 token / 与当前值相同时不写（setToken 内部已做去重）
function refreshToken(res) {
  const t = pickToken(res)
  if (!t) return ''
  const old = curToken()
  setToken(t)
  if (t !== old) console.log('[api] token 已更新（来自响应体）')
  return t
}

// 用 apply_user 相关接口响应刷新全局 token（历史命名，与 refreshToken 等价）
// 保留该名字以兼容 module.exports 的导出约定（外部若有引用不应报错）
function refreshApplyUserToken(res) {
  return refreshToken(res)
}

// 手机号授权登录：POST /api/login
// 入参：{ code: wx.login 临时凭证, phoneCode: 手机号授权返回的 code }
// 后端期望返回（直接返回或包裹于 data）：{ token, openid, phone, name? }
function loginByPhone(code, phoneCode) {
  return request(BASE + '/api/login', {
    code: code || '',
    phoneCode: phoneCode || ''
  }).then(res => {
    console.log('[login] /api/login 原始返回：', res)
    let data = unwrap(res, '登录失败')
    // 兼容数据体再包一层（data / user / userInfo 内层）的返回结构
    if (data && typeof data === 'object' && !data.phone && !data.openid && !data.openId) {
      const inner = data.data || data.user || data.userInfo || data.userinfo
      if (inner && typeof inner === 'object') data = inner
    }
    if (!data || typeof data !== 'object') {
      throw new Error('登录接口返回数据异常')
    }
    // 登录人 id：后续「改单权限 = managerId 与登录人 user_id 一致」这类判断要用
    const loginId = data.user_id !== undefined && data.user_id !== null
      ? data.user_id
      : (data.userId !== undefined && data.userId !== null ? data.userId : data.id)
    const result = {
      token: data.token || '',
      openid: data.openid || data.openId || data.open_id || '',   // 后端字段名为 openid
      phone: data.phone ? String(data.phone) : String(data.phoneNumber || data.mobile || ''),
      name: data.name || data.nickName || data.nickname || '',
      // 三个取值路径都取不到时留空（上层按空值处理，不做猜测）
      userId: (loginId === undefined || loginId === null) ? '' : String(loginId).trim()
    }
    if (!result.openid) {
      console.warn('[login] 未从 /api/login 返回中解析到 openid，原始返回：', res)
    }
    console.log('[login] openid =', result.openid || '(空)', '| phone =', result.phone || '(空)')
    // 登录成功：用返回的 token 更新全局 token（getDeviceDetail / checkAppointment 等后续接口即生效）
    if (result.token) setToken(result.token)
    return result
  })
}

// 修改 web 端登录密码：POST /api/changePassword，body { token, password }
// 入参：password 新密码（原「修改密码」弹窗只保留一个输入框，提交的就是最终密码）
// token 由本函数内部从全局 TOKEN 注入；提交前先 ensureToken 换取最新 token，避免鉴权失败
// 返回：解包后的业务数据
function changePassword(password) {
  const pwd = String(password == null ? '' : password)
  if (!pwd) return Promise.reject(new Error('password 不能为空'))
  return ensureToken().then(() => {
    const payload = { token: curToken(), password: pwd }
    console.log('[changePassword] /api/changePassword 提交：', payload)
    return request(BASE + '/api/changePassword', payload)
  }).then(res => {
    console.log('[changePassword] /api/changePassword 原始返回：', res)
    return unwrap(res, '密码修改失败')
  })
}

// 申请登记：POST /api/register，JSON 提交登记字段（登录态由后端按 open_id 识别，不传 token）
// 入参：payload（open_id/type/name/sex/user_no/phone/dept_id/dept_name/user_type/email/technical_title/teacher_id/teacher_phone/team_id/team_name/profession/company/project_name/research_direction）
// 返回：后端业务数据（兼容 { code, msg, data } 与直接返回两种结构）
function registerAdmission(payload) {
  return request(BASE + '/api/register', Object.assign({}, payload)).then(res => {
    console.log('[register] /api/register 原始返回：', res)
    return unwrap(res, '登记提交失败')
  })
}

// 申请材料文档模板列表：GET /system/doc_info/get
// 入参：可选查询参数；返回模板数组（每项含 docType 等字段）
// 返回：解包后的列表数据，兼容 数组 / { rows } / { data } / { list } / { records } 结构
function getDocInfoList(params) {
  return getRequest(BASE + '/system/doc_info/get', params)
    .then(res => {
      console.log('[docInfo] /system/doc_info/get 原始返回：', res)
      const data = unwrap(res, '模板列表获取失败')
      if (!data) return []
      if (Array.isArray(data)) return data
      const inner = data.rows || data.data || data.list || data.records || data.items
      return Array.isArray(inner) ? inner : []
    })
}

// 审批材料模板 / 文档下载：GET /system/apply_user/downloadDoc
// 入参：id = 申请用户（applyUser）id、docType = 材料类型（字典 doc_type 的值）
// 返回：带查询参数的完整下载地址；文件下载交给 wx.downloadFile（GET），
//       wx.request 只能拿到二进制文本，无法直接落盘打开
function applyUserDocUrl(id, docType) {
  const qs = []
  if (id !== undefined && id !== null && String(id) !== '') qs.push('id=' + encodeURIComponent(String(id)))
  if (docType !== undefined && docType !== null && String(docType) !== '') {
    qs.push('docType=' + encodeURIComponent(String(docType)))
  }
  return BASE + '/system/apply_user/downloadDoc' + (qs.length ? '?' + qs.join('&') : '')
}

// 审批材料模板发送到邮箱：GET /system/apply_user/sendDocEmail
// 入参：{ id 申请用户（applyUser）id, docType 材料类型（字典 doc_type 的值）, email 收件邮箱 }
// 与 /system/apply_user/downloadDoc 同系列，由后端把对应材料模板作为附件发到指定邮箱
function sendApplyUserDocEmail(params) {
  const p = params || {}
  if (p.email == null || String(p.email).trim() === '') return Promise.reject(new Error('收件邮箱不能为空'))
  return getRequest(BASE + '/system/apply_user/sendDocEmail', {
    id: p.id === undefined || p.id === null ? '' : p.id,
    docType: p.docType === undefined || p.docType === null ? '' : p.docType,
    email: String(p.email).trim()
  }).then(res => {
    console.log('[sendDocEmail] /system/apply_user/sendDocEmail 原始返回：', res)
    return unwrap(res, '邮件发送失败')
  })
}

// 数据字典查询：GET /system/dict/data/get/{dictType}
// 入参：dictType 字典类型编码（如 doc_type）
// 返回：字典项数组 [{ dictLabel, dictValue }]，兼容 数组 / { rows } / { data } / { list } 结构
function getDictData(dictType) {
  return getRequest(BASE + '/system/dict/data/get/' + encodeURIComponent(dictType))
    .then(res => {
      console.log('[dict] /system/dict/data/get/' + dictType + ' 原始返回：', res)
      const data = unwrap(res, '字典获取失败')
      if (!data) return []
      if (Array.isArray(data)) return data
      const inner = data.rows || data.data || data.list || data.records || data.items
      return Array.isArray(inner) ? inner : []
    })
}

// 部门列表：POST /system/dept/get
// 入参：可选查询条件；返回部门数组（每项含 deptId / deptName 等字段）
// 返回：解包后的列表数据，兼容 数组 / { rows } / { data } / { list } / { records } 结构
function getDeptList(params) {
  return request(BASE + '/system/dept/get', Object.assign({}, params || {}))
    .then(res => {
      console.log('[dept] /system/dept/get 原始返回：', res)
      const data = unwrap(res, '部门列表获取失败')
      if (!data) return []
      if (Array.isArray(data)) return data
      const inner = data.rows || data.data || data.list || data.records || data.items
      return Array.isArray(inner) ? inner : []
    })
}

// 课题组-工位级联树：GET /api/workstation/team/tree
// 返回：解包后的树数组，每项形如 { id, name, children: [{ id, name, ... }] }
// 兼容 数组 / { rows } / { list } / { records } / { items } / { data } / { tree } 结构
function getWorkstationTeamTree(params) {
  return getRequest(BASE + '/api/workstation/team/tree', Object.assign({}, params || {}))
    .then(res => {
      console.log('[workstation] /api/workstation/team/tree 原始返回：', res)
      const data = unwrap(res, '课题组工位获取失败')
      if (!data) return []
      if (Array.isArray(data)) return data
      const inner = data.rows || data.list || data.records || data.items || data.data || data.tree
      if (Array.isArray(inner)) return inner
      // 对象形态（可能是 { teams, workstations } 两个平行列表）原样交给页面归一化
      return data
    })
}

// 实验工位提交申请：POST /api/workstation/apply/saveJson
// 请求体：{ teamId, workstationId, applyUserId, applyUser, startDate, endDate, remark, attachmentUrl }
//   teamId 课题组 id / workstationId 工位 id（选填）/ applyUserId 申请用户 id
//   applyUser 申请用户姓名 / startDate、endDate 为 YYYY-MM-DD
//   remark 申请理由 / attachmentUrl 导师签字同意书地址（多个用英文逗号拼接）
function saveWorkstationApply(payload) {
  const body = Object.assign({ token: curToken() }, payload || {})
  console.log('[workstation] apply/saveJson 请求：', body)
  return request(BASE + '/api/workstation/apply/saveJson', body).then(res => {
    console.log('[workstation] apply/saveJson 返回：', res)
    return unwrap(res, '实验工位申请提交失败')
  })
}

// 工位扫码打卡：POST /api/workstation/sign/saveJson?token=xxxx
// 请求体：{ workstationId, remark }（remark 传二维码内容，空时传「扫码打卡」）
function saveWorkstationSign(payload) {
  const body = Object.assign({}, payload || {})
  const url = BASE + '/api/workstation/sign/saveJson?token=' + encodeURIComponent(curToken() || '')
  console.log('[workstation] sign/saveJson 请求：', body)
  return request(url, body).then(res => {
    console.log('[workstation] sign/saveJson 返回：', res)
    return unwrap(res, '打卡失败')
  })
}

// 值日打卡：POST /api/workstation/duty/signJson?token=xxxx
// 请求体：{ workstationId, dutyDate }（workstationId 工位 id / dutyDate 值日日期 YYYY-MM-DD）
function saveWorkstationDutySign(payload) {
  const body = Object.assign({}, payload || {})
  const url = BASE + '/api/workstation/duty/signJson?token=' + encodeURIComponent(curToken() || '')
  console.log('[workstation] duty/signJson 请求：', body)
  return request(url, body).then(res => {
    console.log('[workstation] duty/signJson 返回：', res)
    return unwrap(res, '值日打卡失败')
  })
}

// 首页今日待办：GET /api/todo/list
// 参数：token（必填）
// 返回：解包后的业务数据（数组 / { list|rows|records|items|data }，由调用方归一化）
function getTodoList(params) {
  const p = Object.assign({ token: curToken() }, params || {})
  console.log('[todo] list 请求：', p)
  return getRequest(BASE + '/api/todo/list', p).then(res => {
    console.log('[todo] list 返回：', res)
    return unwrap(res, '待办获取失败')
  })
}

// 值日管理-我的值日周表：GET /api/workstation/duty/myWeek
// 参数：token（必填）、days（可选，不传后端默认 7 天）
// 返回：解包后的业务数据（数组 / { list|rows|data|days… } / { leader, list }，由页面归一化）
function getWorkstationDutyMyWeek(params) {
  const p = Object.assign({ token: curToken() }, params || {})
  console.log('[workstation] duty/myWeek 请求：', p)
  return getRequest(BASE + '/api/workstation/duty/myWeek', p).then(res => {
    console.log('[workstation] duty/myWeek 返回：', res)
    return unwrap(res, '值日安排获取失败')
  })
}

// 实验工位申请详情：GET /api/workstation/apply/detail
//   · 传 id：查该条申请
//   · 不传 id（只带 token）：后端返回该用户最新一次申请，无数据时返回空
// 返回：{ id, state, reason, ... }，state 0 待审核 / 1 已通过 / 2 已驳回（驳回原因在 reason）
function getWorkstationApplyDetail(id) {
  const sid = id === undefined || id === null ? '' : String(id).trim()
  const params = { token: curToken() }
  if (sid) params.id = sid
  return getRequest(BASE + '/api/workstation/apply/detail', params).then(res => {
    console.log('[workstation] apply/detail 返回（' + (sid ? 'id=' + sid : '最新一条') + '）：', res)
    return unwrap(res, '申请详情获取失败')
  })
}

// 安全培训详情：GET /system/training_info/safetyDetail
// 返回：解包后的业务数据（含 trainingInfo / docList / videoList）
function getSafetyTrainingDetail() {
  return getRequest(BASE + '/system/training_info/safetyDetail')
    .then(res => {
      console.log('[safetyDetail] /system/training_info/safetyDetail 原始返回：', res)
      return unwrap(res, '安全培训详情获取失败')
    })
}

// 考试详情（题目）：GET /system/exam_info/detail/{id}
// 入参：id 考试信息 id（由培训详情接口 trainingInfo 透传）
// 返回：解包后的业务数据（含考试信息 examName/examScore 与题目列表 questionList 等）
function getExamInfoDetail(id) {
  return getRequest(BASE + '/system/exam_info/detail/' + encodeURIComponent(id))
    .then(res => {
      console.log('[examInfo] /system/exam_info/detail/' + id + ' 原始返回：', res)
      return unwrap(res, '考试详情获取失败')
    })
}

// 提交考试答卷：POST /system/exam_record/submit
// 入参：{ examRecord, examRecordBaseList }（由考试页组装，字段对齐后端约定）
// 返回：解包后的业务数据
function submitExamRecord(payload) {
  return request(BASE + '/system/exam_record/submit', Object.assign({}, payload || {}))
    .then(res => {
      console.log('[examRecord] /system/exam_record/submit 原始返回：', res)
      return unwrap(res, '考试提交失败')
    })
}

// 校验安全证书是否有效：GET /system/cert_record/checkValid?openId={openId}&certType=1
// 入参：openId
// 返回：解包后的 { hasValid, examRecord }（examRecord 内含 state=1通过/2未通过/0评卷中、score 等）
// 备注：certType=1（安全证书类型）按业务约定写死传入
function checkCertRecordValid(openId) {
  return getRequest(BASE + '/system/cert_record/checkValid', { openId: openId || '', certType: 1 })
    .then(res => {
      console.log('[certCheck] /system/cert_record/checkValid 原始返回：', res)
      const data = unwrap(res, '安全证书校验失败')
      if (!data || typeof data !== 'object') return { hasValid: false, examRecord: null }
      return {
        hasValid: !!data.hasValid,
        examRecord: (data.examRecord && typeof data.examRecord === 'object') ? data.examRecord : null
      }
    })
}

// 我的证书列表：POST /system/cert_record/getList，body { openId }
// 入参：openId（当前登录用户 openid）
// 返回：解包后的证书条目数组（兼容 数组 / {rows} / {list} / {records} / {items} / {data:[]} 等多种分页形态）
function getCertRecordList(openId) {
  const payload = { openId: openId || '' }
  console.log('[certRecordList] /system/cert_record/getList 提交：', payload)
  return request(BASE + '/system/cert_record/getList', payload)
    .then(res => {
      console.log('[certRecordList] /system/cert_record/getList 原始返回：', res)
      const data = unwrap(res, '证书列表获取失败')
      if (Array.isArray(data)) return data
      if (data && typeof data === 'object') {
        const arr = data.rows || data.list || data.records || data.items ||
          (Array.isArray(data.data) ? data.data : null)
        if (Array.isArray(arr)) return arr
      }
      return []
    })
}

// 证书详情：GET /system/cert_record/detail?id={id}
// 入参：id（证书记录 id）
// 返回：解包后的证书详情对象（兼容 {data} / {record} / {cert} / {certRecord} / 直接对象 等多种返回形态）
function getCertRecordDetail(id) {
  if (id == null || String(id).trim() === '') {
    return Promise.reject(new Error('id 不能为空'))
  }
  const params = { id: String(id) }
  console.log('[certDetail] /system/cert_record/detail 提交：', params)
  return getRequest(BASE + '/system/cert_record/detail', params)
    .then(res => {
      console.log('[certDetail] /system/cert_record/detail 原始返回：', res)
      const data = unwrap(res, '证书详情获取失败')
      // 兼容嵌套：{ data: {...} } / { record: {...} } / { cert: {...} } / { certRecord: {...} } / 直接对象
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data.data || data.record || data.cert || data.certRecord || data
      }
      return data || null
    })
}

// 校验申请材料附件上传状态：GET /system/apply_user_attachment/checkAttachments?openId={openId}
// 入参：openId
// 返回：解包后的 { attachmentFlag, raw }；attachmentFlag 取值意义：
//   1 = 上传文件成功  2 = 部分上传  3 = 未上传
function checkAttachments(openId) {
  return getRequest(BASE + '/system/apply_user_attachment/checkAttachments', { openId: openId || '' })
    .then(res => {
      console.log('[checkAttachments] /system/apply_user_attachment/checkAttachments 原始返回：', res)
      const data = unwrap(res, '材料上传状态校验失败')
      const raw = (data && typeof data === 'object') ? data : null
      const n = raw && raw.attachmentFlag != null ? Number(raw.attachmentFlag) : NaN
      return {
        attachmentFlag: (n === 1 || n === 2 || n === 3) ? n : null,
        raw: raw
      }
    })
}

// 申请材料附件保存：POST /system/apply_user_attachment/saveAll
// 入参：applyUserId 申请记录 id；list 按文档类型分组，每项 { docType, urls: [文件地址...] }
//      signUserId 签字人员 id（选填，未选时不传）
// 请求体：{ applyUserId, list: [{ docType, urls: [] }], signUserId }
function saveApplyUserAttachments(applyUserId, list, signUserId) {
  const body = { applyUserId: applyUserId, list: list || [] }
  if (signUserId !== undefined && signUserId !== null && String(signUserId) !== '') {
    body.signUserId = signUserId
  }
  return request(BASE + '/system/apply_user_attachment/saveAll', body)
    .then(res => {
      console.log('[applyUserAttachment] /system/apply_user_attachment/saveAll 原始返回：', res)
      return unwrap(res, '材料保存失败')
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 权限（perms）全局缓存
//   每次调用 /system/apply_user/detail 都按 openId 刷新缓存，
//   供「准入审批」等页面做权限校验时直接复用，避免每个页面/每次进入都重复请求该接口。
//   仅 getApplyUserDetail（按 openId 查询）写入：管理员按申请单 id 查别人详情
//   （/system/apply_user/apply/detail）的响应不带登录人权限，不写入，避免污染缓存。
// ─────────────────────────────────────────────────────────────────────────────
let _permsCacheOpenId = ''
let _permsCache = []

// 写入缓存：openId 为空时忽略；perms 兼容数组与逗号分隔字符串
function setPermsCache(openId, perms) {
  const oid = String(openId || '').trim()
  if (!oid) return []
  const list = Array.isArray(perms)
    ? perms.map(p => String(p).trim()).filter(Boolean)
    : (typeof perms === 'string' ? perms.split(',').map(p => p.trim()).filter(Boolean) : [])
  _permsCacheOpenId = oid
  _permsCache = list
  console.log('[permsCache] 已刷新全局权限缓存，openId =', oid, '，perms =', list)
  return _permsCache
}

// 读取缓存：openId 与缓存不一致（换账号）时返回空数组
function getPermsCache(openId) {
  const oid = String(openId || '').trim()
  if (!oid || oid !== _permsCacheOpenId) return []
  return _permsCache
}

// 清缓存（换账号 / 重新登录时调用）
function clearPermsCache() {
  _permsCacheOpenId = ''
  _permsCache = []
  return true
}

// 缓存版「待审核 state 集合」：把缓存里的 perms 换算成 [0] / [4] / [0, 4]
// 缓存为空（未查询过 / 换账号）时返回空数组，调用方自行决定是否发起请求
function getAuditStatesFromCache(openId) {
  const perms = getPermsCache(openId)
  if (!perms.length) return []
  return permsToStateList(perms)
}

// 获取申请用户信息：GET /system/apply_user/detail?openId={openId}
// 后端约定：响应体里 `type` 位于 `applyUser` 节点（1=院内 / 2=院外），用于判断上传材料必传项
// 同时响应体里 `attachmentList` 是该用户已上传的材料附件数组（结构与原 /system/apply_user_attachment/get/{id} 一致），
// 可直接用于「已上传材料回填」，避免额外再发一次 /apply_user_attachment/get。
// 兼容结构：
//   ① { code, msg, data: { applyUser: { type, ... }, attachmentList: [...] } }
//   ② { code, msg, data: { type, ... } }                       （数据体即申请用户）
//   ③ 直接是 applyUser 体本身
// 入参：openId 必填；id 可选（准入审批从列表进详情时传申请单 id，精确定位某一条申请记录）
// 返回 { applyUser, attachmentList, raw, perms }；无法识别时 applyUser = {}、attachmentList = []
function getApplyUserDetail(openId, id) {
  const params = { openId: openId || '' }
  const sid = (id === undefined || id === null) ? '' : String(id).trim()
  if (sid) params.id = sid
  return getRequest(BASE + '/system/apply_user/detail', params)
    .then(res => {
      console.log('[applyUser] /system/apply_user/detail 原始返回：', res)
      // 每次调用本接口都用响应体里的 token 刷新全局 token（后端随接口下发新 token，
      // 避免沿用过期 token 导致后续 /api/xxx 接口鉴权失败）
      refreshToken(res)
      const detail = parseApplyUserDetail(res)
      // 每次调用本接口都刷新全局权限缓存（按 openId），供审批页权限校验直接复用
      setPermsCache(openId, detail && detail.perms)
      return detail
    })
}

// 准入审批专用「申请单详情」：GET /system/apply_user/apply/detail?id={id}
//   与 /system/apply_user/detail（按 openId 查「我的」申请）不同，这里只用申请单 id 定位某一条申请记录，
//   管理员从审批列表点进来时用。
// 注意：这里刻意不做 refreshToken —— 响应里的 token 属于被审批人，写成全局会让管理员后续
//       /api/audit 带上错误身份（初审判调用方从返回值里拿 token 使用）。
// 返回结构与 getApplyUserDetail 一致：{ applyUser, attachmentList, raw, perms, token }
function getApplyDetailById(id) {
  const sid = (id === undefined || id === null) ? '' : String(id).trim()
  if (!sid) return Promise.reject(new Error('id 不能为空'))
  console.log('[applyUser] 发起 /system/apply_user/apply/detail，id =', sid)
  return getRequest(BASE + '/system/apply_user/apply/detail', { id: sid })
    .then(res => {
      console.log('[applyUser] /system/apply_user/apply/detail 原始返回：', res)
      return parseApplyUserDetail(res)
    })
}

// 申请详情响应解析（/system/apply_user/detail 与 /system/apply_user/apply/detail 共用）
// 返回 { applyUser, attachmentList, raw, perms, token }
function parseApplyUserDetail(res) {
  const data = unwrap(res, '申请用户信息获取失败')
  let applyUser = null
  if (data && typeof data === 'object') {
    if (data.applyUser && typeof data.applyUser === 'object') {
      applyUser = data.applyUser
    } else if (data.type !== undefined || data.id !== undefined || data.openId !== undefined || data.openid !== undefined) {
      // 数据体本身已是申请用户（无 applyUser 包裹）
      applyUser = data
    } else if (data.data && typeof data.data === 'object') {
      if (data.data.applyUser && typeof data.data.applyUser === 'object') applyUser = data.data.applyUser
      else if (data.data.type !== undefined || data.data.id !== undefined) applyUser = data.data
    }
  }
  // 提取附件列表：标准是顶层 attachmentList；兼容 { rows } / { data } / { list } 内层或再包一层
  let attachmentList = []
  if (data && typeof data === 'object') {
    if (Array.isArray(data.attachmentList)) attachmentList = data.attachmentList
    else if (data.attachmentList && typeof data.attachmentList === 'object') {
      const inner = data.attachmentList.rows || data.attachmentList.data || data.attachmentList.list || data.attachmentList.records || data.attachmentList.items
      attachmentList = Array.isArray(inner) ? inner : []
    } else {
      const inner = data.rows || data.list || data.records || data.items
      if (Array.isArray(inner)) attachmentList = inner
      else if (data.data && typeof data.data === 'object') {
        const dInner = data.data.attachmentList || data.data.rows || data.data.list
        attachmentList = Array.isArray(dInner) ? dInner : []
      }
    }
  }
  attachmentList = (attachmentList || []).filter((it) => it && typeof it === 'object')
  // 提取签字人员列表：标准是顶层 allUsers；兼容 { data: { allUsers } } / users / userList
  // 以及 { rows } / { list } / { records } / { items } 内层包裹
  // 若 allUsers 与 data 平级（unwarp 只取了 data 会丢），再从原始响应 res 里找一次
  let allUsers = []
  let cand = null
  if (data && typeof data === 'object') {
    cand = data.allUsers ||
      (data.data && typeof data.data === 'object' ? data.data.allUsers : null) ||
      data.users || data.userList
  }
  if (!cand && res && typeof res === 'object') {
    cand = res.allUsers ||
      (res.data && typeof res.data === 'object' ? res.data.allUsers : null)
  }
  if (Array.isArray(cand)) allUsers = cand
  else if (cand && typeof cand === 'object') {
    const inner = cand.rows || cand.list || cand.records || cand.items
    allUsers = Array.isArray(inner) ? inner : []
  }
  allUsers = (allUsers || []).filter((it) => it && typeof it === 'object')
  console.log('[applyUser] allUsers：', allUsers.length,
    allUsers.length ? JSON.stringify(allUsers[0]).slice(0, 200) : '')
  // 提取账号信息：标准是顶层 user（内含 loginName 登录名）；兼容 { data: { user } } / userInfo / sysUser
  // 取不到或不是对象时返回 null，调用方需判空
  let user = null
  if (data && typeof data === 'object') {
    const cand = data.user ||
      (data.data && typeof data.data === 'object' ? data.data.user : null) ||
      data.userInfo || data.sysUser
    if (cand && typeof cand === 'object' && !Array.isArray(cand)) user = cand
  }
  // token 一并回传：管理员审批时要用「被审批人详情里下发的 token」，不是管理员自己的
  return {
    applyUser: applyUser || {},
    attachmentList,
    allUsers,
    user,
    raw: data,
    perms: pickPerms(res, data),
    token: pickToken(res)
  }
}

// 管理员审批场景专用：调用详情接口但不把响应里的 token 写成全局 token。
// 普通 getApplyUserDetail 内部会 refreshToken，把全局 TOKEN 换成「被查询人」的 token；
// 管理员查看别人详情时若被覆盖，后续 /api/audit（要求用管理员自己的 token）就会传错。
// 实现：记下调用前的 TOKEN，请求结束后无论成功失败都恢复回去。
// 返回值里的 token 字段仍是接口下发的 token（初审 /api/init 要用）
function getApplyUserDetailKeepToken(openId, id) {
  return keepGlobalToken(getApplyUserDetail(openId, id))
}

// 同 getApplyUserDetailKeepToken：按申请单 id 查 /system/apply_user/apply/detail
function getApplyDetailByIdKeepToken(id) {
  return keepGlobalToken(getApplyDetailById(id))
}

// 包装任意 Promise：确保执行前后全局 TOKEN 不被请求意外刷新覆盖
function keepGlobalToken(task) {
  const prev = curToken()
  const restore = () => { if (curToken() !== prev) setToken(prev) }
  return Promise.resolve(task).then(
    detail => { restore(); return detail },
    err => { restore(); throw err }
  )
}

// 从响应体中抽取权限码数组
// 取值优先级：先「根级」再「嵌套」，同层内 data 优先于顶层 body
//   data.perms / data.permissions
//   → body.perms / body.permissions
//   → data.applyUser.perms / data.user.perms / data.userInfo.perms
// 背景：后端曾在顶层与 data 内同时下发 perms（顶层为旧值），导致权限改了仍读到旧的 audit。
// 兼容字符串数组与逗号分隔字符串两种形态（找不到返回空数组）
function pickPerms(body, data) {
  const norm = (rawList) => {
    if (rawList == null) return null
    if (Array.isArray(rawList)) return rawList.map(p => String(p).trim()).filter(Boolean)
    if (typeof rawList === 'string') return rawList.split(',').map(p => p.trim()).filter(Boolean)
    return null
  }
  const nodes = [
    ['data.perms', data && data.perms],
    ['data.permissions', data && data.permissions],
    ['body.perms', body && body.perms],
    ['body.permissions', body && body.permissions],
    ['data.applyUser.perms', data && data.applyUser && data.applyUser.perms],
    ['data.user.perms', data && data.user && data.user.perms],
    ['data.userInfo.perms', data && data.userInfo && data.userInfo.perms]
  ]
  const found = []
  for (let i = 0; i < nodes.length; i++) {
    const v = norm(nodes[i][1])
    if (v && v.length) found.push({ from: nodes[i][0], perms: v })
  }
  if (!found.length) {
    console.log('[pickPerms] 响应中未找到 perms 字段')
    return []
  }
  console.log('[pickPerms] 响应中各节点 perms：',
    found.map(f => f.from + ' → ' + JSON.stringify(f.perms)).join(' | '))
  if (found.length > 1) {
    console.warn('[pickPerms] 多个节点都带 perms，按优先级取：' + found[0].from)
  }
  return found[0].perms
}

// 权限码 → 准入审批「待审核」要查询的 state
//   system:apply_user:init  → state=0（待初审：申请人刚提交，尚未登记/初审）
//   system:apply_user:audit → state=4（待复审：已初审通过，等待准入终审）
// 两者同时具备时按流程先后取 init（state=0）；都不具备返回 null
const PERM_APPLY_INIT = 'system:apply_user:init'
const PERM_APPLY_AUDIT = 'system:apply_user:audit'

function permsToPendingState(perms) {
  const list = Array.isArray(perms) ? perms.map(p => String(p).trim()) : []
  if (list.indexOf(PERM_APPLY_INIT) >= 0) return 0
  if (list.indexOf(PERM_APPLY_AUDIT) >= 0) return 4
  return null
}

// 权限码 → /system/apply_user/api/list 要查的 state 集合
//   system:apply_user:init  → [0]（待初审）
//   system:apply_user:audit → [4]（已初审待终审）
//   两个都有                 → [0, 4]
//   解析不到任何权限        → 兜底 [0]
function permsToStateList(perms) {
  const list = Array.isArray(perms) ? perms.map(p => String(p).trim()) : []
  const states = []
  if (list.indexOf(PERM_APPLY_INIT) >= 0) states.push(0)
  if (list.indexOf(PERM_APPLY_AUDIT) >= 0) states.push(4)
  return states.length ? states : [0]
}

// 当前用户的审批权限来自 GET /system/apply_user/detail 响应里的 perms
// ⚠ 这里刻意「不做结果缓存」：权限可能在后台调整（例如 audit → init），
//   一旦缓存，调整后仍会拿旧值发请求（表现为「后端已改，前端还传 [4]」）。
//   只保留「并发去重」：同一 openId 的并发调用共用同一个在途请求，避免重复打接口。
let _auditStateListTask = null
let _auditStateListTaskOpenId = ''

// 取当前用户待审核查询用的 state 集合：Promise<number[]>
// openId 为空 / 接口失败 → 兜底 [0]
function getAuditStateList(openId) {
  const oid = String(openId || '').trim()
  if (!oid) {
    console.warn('[approval] openId 为空，无法判定权限，stateList 兜底 [0]')
    return Promise.resolve([0])
  }
  if (_auditStateListTask && _auditStateListTaskOpenId === oid) return _auditStateListTask
  // 命中全局权限缓存时直接返回，不再请求 /system/apply_user/detail
  // （缓存由每次 /system/apply_user/detail 调用刷新，见 setPermsCache）
  const cached = getAuditStatesFromCache(oid)
  if (cached.length) {
    console.log('[approval] 命中全局权限缓存，stateList =', cached)
    return Promise.resolve(cached)
  }
  // KeepToken 版：避免把详情里属于被审批人的 token 写成管理员的全局 token
  const task = getApplyUserDetailKeepToken(oid)
    .then(detail => {
      const perms = (detail && detail.perms) || []
      // 写回缓存（getApplyUserDetail 内部已写，这里兜底，保证后续校验命中）
      setPermsCache(oid, perms)
      const list = permsToStateList(perms)
      console.log('[approval] openId =', oid, ', perms =', perms, '→ stateList =', list)
      return list
    })
    .catch(err => {
      console.warn('[approval] perms 查询失败，stateList 兜底 [0]：', err && (err.message || err))
      return [0]
    })
    .then(v => {
      if (_auditStateListTask === task) {
        _auditStateListTask = null
        _auditStateListTaskOpenId = ''
      }
      return v
    })
  _auditStateListTask = task
  _auditStateListTaskOpenId = oid
  return task
}

// 换账号 / 重新登录时清掉在途请求标记，下次重新按权限判定
function clearAuditStateListCache() {
  _auditStateListTask = null
  _auditStateListTaskOpenId = ''
  return true
}

// 查当前用户的待审核 state：GET /system/apply_user/detail?openId={openId}，据响应里的 perms 判定
// 返回 Promise<number|null>：0 / 4；无权限码、无 openId 或接口失败 → null（调用方自行兜底）
function getPendingAuditState(openId) {
  const oid = String(openId || '').trim()
  if (!oid) return Promise.resolve(null)
  return getApplyUserDetail(oid)
    .then(detail => {
      const state = permsToPendingState(detail && detail.perms)
      console.log('[approval] perms =', (detail && detail.perms) || [], '→ 待审核 state =', state)
      return state
    })
    .catch(err => {
      console.warn('[approval] perms 查询失败，待审核 state 交调用方兜底：', err)
      return null
    })
}

// 申请用户详情「共享版」：GET /system/apply_user/detail，带跨页缓存 + 并发去重
//   ① 命中未过期缓存（ADMISSION_USER_DETAIL_KEY，TTL=ADMISSION_USER_DETAIL_TTL）→ 直接返回，不发请求
//   ② 已有在途请求 → 复用同一个 Promise，避免并发重复请求
//   ③ 否则发请求，成功后写入缓存（缓存结构与 onboarding/index、upload 页保持一致：{ ...detail, _ts }）
// 返回结构与 getApplyUserDetail 相同：{ applyUser, attachmentList, raw }
// 在途请求去重标记（同一 openId + id 的并发调用共用同一请求）
// 必须区分 openId / id：管理员审批页会查询别的用户、别的申请单，不能复用当前用户的在途请求/缓存
let _applyUserDetailTask = null
let _applyUserDetailTaskOpenId = ''
let _applyUserDetailTaskId = ''

function getApplyUserDetailShared(openId, id) {
  const oid = String(openId || '').trim()
  const sid = (id === undefined || id === null) ? '' : String(id).trim()
  if (!oid) return Promise.reject(new Error('openId 不能为空'))
  // ① 缓存命中：未过期、含 applyUser、且是同一个 openId + id 时直接复用
  try {
    const cached = wx.getStorageSync(ADMISSION_USER_DETAIL_KEY)
    if (cached && typeof cached === 'object' && cached.applyUser &&
      cached._openId === oid && String(cached._id || '') === sid &&
      (Date.now() - (cached._ts || 0) < ADMISSION_USER_DETAIL_TTL)) {
      console.log('[applyUser] detail 命中跨页缓存，openId =', oid, ', id =', sid)
      return Promise.resolve(cached)
    }
  } catch (e) { /* 忽略缓存异常 */ }
  // ② 在途请求复用（同一 openId + id）
  if (_applyUserDetailTask && _applyUserDetailTaskOpenId === oid && _applyUserDetailTaskId === sid) {
    return _applyUserDetailTask
  }
  // ③ 发起请求并写回缓存（带上 openId / id，避免不同用户、不同申请单之间串数据）
  const task = getApplyUserDetail(oid, sid)
    .then(detail => {
      try {
        wx.setStorageSync(ADMISSION_USER_DETAIL_KEY,
          Object.assign({}, detail, { _ts: Date.now(), _openId: oid, _id: sid }))
      } catch (e) { /* 忽略缓存异常 */ }
      return detail
    })
    .then(v => {
      if (_applyUserDetailTask === task) {
        _applyUserDetailTask = null
        _applyUserDetailTaskOpenId = ''
        _applyUserDetailTaskId = ''
      }
      return v
    }, err => {
      if (_applyUserDetailTask === task) {
        _applyUserDetailTask = null
        _applyUserDetailTaskOpenId = ''
        _applyUserDetailTaskId = ''
      }
      throw err
    })
  _applyUserDetailTask = task
  _applyUserDetailTaskOpenId = oid
  _applyUserDetailTaskId = sid
  return task
}

// 清除申请用户详情跨页缓存（提交 / 审批等状态变更后调用，避免读到过期数据）
function clearApplyUserDetailCache() {
  _applyUserDetailTask = null
  _applyUserDetailTaskOpenId = ''
  _applyUserDetailTaskId = ''
  try { wx.removeStorageSync(ADMISSION_USER_DETAIL_KEY) } catch (e) { /* 忽略缓存异常 */ }
  return true
}

// 修改申请用户状态：GET /system/apply_user/changeState?openId={openId}&state={state}
// 入参：openId、state（业务约定：0=提交审核 / 其它值见后端字典）
// 返回：解包后的业务数据
function changeApplyUserState(openId, state) {
  return getRequest(BASE + '/system/apply_user/changeState', { openId: openId || '', state: state })
    .then(res => {
      console.log('[applyUser] /system/apply_user/changeState 原始返回：', res)
      return unwrap(res, '提交审核失败')
    })
}

// 准入申请列表（管理员审批用，支持分页）：
//   POST /system/apply_user/api/list?pageNum={pageNum}&pageSize={pageSize}
//   Content-Type: application/json        body: { "stateList": [0, 4] }
// 入参：
//   stateList 状态数组，按当前管理员权限决定
//     system:apply_user:init  → [0]（待初审）
//     system:apply_user:audit → [4]（已初审待终审）
//     两个权限都有            → [0, 4]
//     传空 / 解析不出有效值   → 兜底 [0]
//   page 可选分页参数 { pageNum = 1, pageSize = APPROVAL_PAGE_SIZE }（分页走 query，body 只放 stateList）
// 返回：{ rows, total, pageNum, pageSize, hasMore }
//   rows     当页数据数组
//   total    总条数（后端未返回时用当页长度兜底）
//   hasMore  是否还有下一页（total 已知时按页码推算，否则按「当页是否满页」判定）
function getApprovalList(stateList, page) {
  let list = []
  if (Array.isArray(stateList)) list = stateList
  else if (stateList !== undefined && stateList !== null && stateList !== '') list = [stateList]
  const arr = list.map(v => Number(v)).filter(v => !isNaN(v))
  const payload = { stateList: arr.length ? arr : [0] }
  const pageNum = (page && Number(page.pageNum) > 0) ? Number(page.pageNum) : 1
  const pageSize = (page && Number(page.pageSize) > 0) ? Number(page.pageSize) : APPROVAL_PAGE_SIZE
  const url = BASE + '/system/apply_user/api/list?pageNum=' + pageNum + '&pageSize=' + pageSize
  console.log('[approvalList] /system/apply_user/api/list 提交：', url, payload)
  return request(url, payload)
    .then(res => {
      console.log('[approvalList] /system/apply_user/api/list 原始返回：', res)
      const data = unwrap(res, '准入审批列表获取失败')
      return parsePagedList(data, pageNum, pageSize)
    })
}

// 分页响应解析：把后端返回统一成 { rows, total, pageNum, pageSize, hasMore }
// 兼容形态：数组 / { rows|list|records|items, total } / { data: { rows, total } } / { data: [...] }
function parsePagedList(data, pageNum, pageSize) {
  let rows = null
  let total = null
  if (Array.isArray(data)) {
    rows = data
  } else if (data && typeof data === 'object') {
    // 数据体可能再包一层 data（{ code, msg, data: { rows, total } }）
    let body = data
    if (data.data && typeof data.data === 'object') {
      if (Array.isArray(data.data)) rows = data.data
      else if (data.data.rows || data.data.list || data.data.records || data.data.items || data.data.total != null) body = data.data
    }
    if (!Array.isArray(rows)) {
      rows = body.rows || body.list || body.records || body.items ||
        (Array.isArray(body.data) ? body.data : null)
    }
    // 总数：优先取数据体里的 total / totalCount / count，取不到再回退外层
    const pickTotal = (o) => (o && (o.total != null ? o.total : (o.totalCount != null ? o.totalCount : (o.count != null ? o.count : null))))
    let t = pickTotal(body)
    if (t == null && body !== data) t = pickTotal(data)
    if (t != null) total = Number(t)
  }
  if (!Array.isArray(rows)) rows = []
  const totalNum = (total != null && !isNaN(total)) ? total : rows.length
  const hasMore = (total != null && !isNaN(total))
    ? (pageNum * pageSize < totalNum)
    : (rows.length >= pageSize)
  return {
    rows,
    total: totalNum,
    pageNum,
    pageSize,
    hasMore: !!hasMore
  }
}

// 我的审批记录（管理员已处理过的，支持分页）：
//   GET /system/approval/myList?businessType=1&token={token}&pageNum={pageNum}&pageSize={pageSize}
//   businessType：1 = 准入申请（按业务约定写死）
//   token：登录人自己的 token，由本函数从全局 TOKEN 注入（不用被审批人的 token）
// 入参：page 可选分页参数 { pageNum = 1, pageSize = APPROVAL_PAGE_SIZE }
// 返回：{ rows, total, pageNum, pageSize, hasMore }（解析规则同 getApprovalList）
function getMyApprovalList(page) {
  const pageNum = (page && Number(page.pageNum) > 0) ? Number(page.pageNum) : 1
  const pageSize = (page && Number(page.pageSize) > 0) ? Number(page.pageSize) : APPROVAL_PAGE_SIZE
  const params = { businessType: 1, token: curToken(), pageNum, pageSize }
  console.log('[myApproval] /system/approval/myList 提交：', params)
  return getRequest(BASE + '/system/approval/myList', params)
    .then(res => {
      console.log('[myApproval] /system/approval/myList 原始返回：', res)
      const data = unwrap(res, '审批记录获取失败')
      return parsePagedList(data, pageNum, pageSize)
    })
}

// 准入审批审核（通过 / 驳回）：POST /system/apply_user/api/audit
// 入参 payload 字段：
//   id        Long 申请记录 id（来自 /system/apply_user/detail 返回的 applyUser.id 等）
//   state     业务约定：2=通过 / 3=驳回
//   deptId    部门 id（来自 applyUser.deptId / dept_id 等字段）
//   deptName  部门名称（来自 applyUser.deptName / dept_name 等字段）
//   type      申请类型（来自 applyUser.type / applyType 等字段）
//   userType  用户类型（来自 applyUser.userType / user_type 等字段）
//   remark    驳回原因（驳回时由用户输入，通过时传空字符串）
// token 由本函数内部从全局 TOKEN 注入
// 返回：解包后的业务数据
function auditApplyUser(payload) {
  // token：优先用调用方显式传入的（审批场景传的是被审批人详情里下发的 token），否则用全局 TOKEN
  const p = Object.assign({}, payload || {})
  p.token = (p.token != null && String(p.token).trim() !== '') ? String(p.token).trim() : curToken()
  if (p.id == null || String(p.id).trim() === '') {
    return Promise.reject(new Error('id 不能为空'))
  }
  if (p.state == null || String(p.state).trim() === '') {
    return Promise.reject(new Error('state 不能为空'))
  }
  // id 强转 Long；state 强转 int
  const numId = Number(p.id)
  p.id = isNaN(numId) ? p.id : numId
  const numState = Number(p.state)
  p.state = isNaN(numState) ? p.state : numState
  // remark 缺省补空串
  if (p.remark == null) p.remark = ''
  console.log('[audit] /system/apply_user/api/audit 提交：', p)
  return request(BASE + '/system/apply_user/api/audit', p).then(res => {
    console.log('[audit] /system/apply_user/api/audit 原始返回：', res)
    return unwrap(res, '审批操作失败')
  })
}

// 准入审批「初审」：POST /system/apply_user/api/init，body { id, state, remark, token }
//   适用：申请单当前 state=0（刚提交、待初审）
//   state 取值：通过 → 4（进入待终审）；驳回 → 3（已驳回，与 /api/audit 一致）
//   token 必须是「登录人」的：调用方不要传被审批人详情里下发的 token，缺省即注入全局 TOKEN
// 返回：解包后的业务数据
function initApplyUser(payload) {
  // token：调用方显式传入优先，否则用全局 TOKEN（登录人的最新 token）
  // 审批页不再传入被审批人的 token，两个审批接口因此都用登录人身份提交
  const p = Object.assign({}, payload || {})
  p.token = (p.token != null && String(p.token).trim() !== '') ? String(p.token).trim() : curToken()
  if (p.id == null || String(p.id).trim() === '') {
    return Promise.reject(new Error('id 不能为空'))
  }
  if (p.state == null || String(p.state).trim() === '') {
    return Promise.reject(new Error('state 不能为空'))
  }
  // id 强转 Long；state 强转 int
  const numId = Number(p.id)
  p.id = isNaN(numId) ? p.id : numId
  const numState = Number(p.state)
  p.state = isNaN(numState) ? p.state : numState
  // remark 缺省补空串
  if (p.remark == null) p.remark = ''
  console.log('[init] /system/apply_user/api/init 提交：', p)
  return request(BASE + '/system/apply_user/api/init', p).then(res => {
    console.log('[init] /system/apply_user/api/init 原始返回：', res)
    return unwrap(res, '初审操作失败')
  })
}

// 首页准入入口显隐：GET /system/apply_user/access?openId={openId}
// 返回数据中 state：2 = 已完成准入（首页隐藏准入横幅），其它情况显示
// 返回：{ state, hasData, raw }
//   state   解析出的状态数字；解析失败为 null
//   hasData 返回数据是否非空（false=数据为空，如未提交过申请）
function getAccessState(openId) {
  return getRequest(BASE + '/system/apply_user/access', { openId: openId || '' })
    .then(res => {
      console.log('[access] /system/apply_user/access 原始返回：', res)
      const data = unwrap(res, '准入状态获取失败')
      // 数据是否为空（null / 空串 / 空对象均视为无数据）
      const hasData = !(data == null || data === '' ||
        (typeof data === 'object' && !Array.isArray(data) && !Object.keys(data).length))
      // 兼容 { state } / { applyUser: { state } } / data 直接为数字三种结构
      let st = null
      if (data && typeof data === 'object') {
        const body = (data.applyUser && typeof data.applyUser === 'object') ? data.applyUser : data
        st = body.state != null ? Number(body.state) : null
      } else if (data != null && data !== '') {
        st = Number(data)
      }
      return { state: isNaN(st) ? null : st, hasData, raw: data }
    })
}

// 上传图片：POST /file/uploadImage（multipart/form-data）
// 文件字段名为 files[]；表单字段 function=upload
// 入参：filePath 本地图片临时路径；extra 额外表单字段
// 返回：解包后的业务数据（通常含图片地址 url），兼容 { code, msg, data } 与直接返回字符串
function uploadImage(filePath, extra) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: BASE + '/file/uploadImage',
      filePath,
      name: 'files[]',
      formData: Object.assign({ function: 'upload' }, extra || {}),
      timeout: TIMEOUT,
      success(res) {
        const code = res.statusCode || 0
        if (code < 200 || code >= 300) {
          reject(new Error('服务返回异常（HTTP ' + code + '）'))
          return
        }
        let body = res.data
        try {
          body = JSON.parse(res.data)
        } catch (e) { /* 非 JSON：保留原始字符串 */ }
        if (typeof body === 'string') {
          resolve(body)
          return
        }
        try {
          resolve(unwrap(body, '图片上传失败'))
        } catch (err) {
          reject(err)
        }
      },
      fail(err) {
        reject(err || new Error('网络请求失败'))
      }
    })
  })
}

// 上传文档（PDF/Word 等非图片文件）：POST /file/uploadFile（multipart/form-data）
// 文件字段与 uploadImage 保持一致（files[] + function=upload）。
function uploadFile(filePath, extra) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: BASE + '/file/uploadFile',
      filePath,
      name: 'files[]',
      formData: Object.assign({ function: 'upload' }, extra || {}),
      timeout: 30000,   // 文档通常比图片大，超时放宽到 30s
      success(res) {
        const code = res.statusCode || 0
        if (code < 200 || code >= 300) {
          reject(new Error('服务返回异常（HTTP ' + code + '）'))
          return
        }
        let body = res.data
        try {
          body = JSON.parse(res.data)
        } catch (e) { /* 非 JSON：保留原始字符串 */ }
        if (typeof body === 'string') {
          resolve(body)
          return
        }
        try {
          resolve(unwrap(body, '文件上传失败'))
        } catch (err) {
          reject(err)
        }
      },
      fail(err) {
        reject(err || new Error('网络请求失败'))
      }
    })
  })
}

// 模板文件发送到邮箱：POST /file/sendEmail
// 入参：{ email 收件邮箱, url 模板文件地址（相对路径）, name 文件显示名 }
// 由后端通过 SMTP 把模板文件作为附件发送；返回解包后的业务数据
function sendFileToEmail(email, url, name) {
  return request(BASE + '/file/sendEmail', {
    email: email || '',
    url: url || '',
    name: name || ''
  }).then(res => {
    console.log('[sendEmail] /file/sendEmail 原始返回：', res)
    return unwrap(res, '邮件发送失败')
  })
}

module.exports = {
  BASE,
  // 不再导出 TOKEN 常量：那是模块加载时的值快照，拿到的会不是最新 token；
  // 需要当前 token 的调用方请用 getToken()
  setToken,
  getToken,
  refreshToken,
  refreshApplyUserToken,
  getApplyUserDetailShared,
  clearApplyUserDetailCache,
  SCAN_DETAIL_KEY,
  DEVICE_APPLY_KEY,
  BOOKING_DETAIL_KEY,
  ADMISSION_USER_DETAIL_KEY,
  ADMISSION_USER_DETAIL_TTL,
  CERT_RECORD_LIST_KEY,
  APPROVAL_PAGE_SIZE,
  getDeviceDetail,
  getDeviceList,
  checkAppointment,
  getDeviceApply,
  editDisable,
  cancelDisable,
  getDeviceApplyDetail,
  getApplyDetail,
  doApplyCheck,
  getApplyList,
  deviceApplyCancel,
  deviceOperate,
  uploadLog,
  logUpload,
  deviceLogList,
  getDeviceLogDetail,
  editDeviceLogDetail,
  doDeviceApply,
  loginByPhone,
  changePassword,
  registerAdmission,
  checkAttachments,
  saveApplyUserAttachments,
  uploadImage,
  uploadFile,
  sendFileToEmail,
  getDocInfoList,
  getDictData,
  applyUserDocUrl,
  sendApplyUserDocEmail,
  getDeptList,
  getWorkstationTeamTree,
  saveWorkstationApply,
  saveWorkstationSign,
  getTodoList,
  getWorkstationDutyMyWeek,
  saveWorkstationDutySign,
  getWorkstationApplyDetail,
  getSafetyTrainingDetail,
  getExamInfoDetail,
  submitExamRecord,
  checkCertRecordValid,
  getCertRecordList,
  getCertRecordDetail,
  getApplyUserDetail,
  getApplyUserDetailKeepToken,
  getApplyDetailById,
  getApplyDetailByIdKeepToken,
  getPendingAuditState,
  permsToPendingState,
  permsToStateList,
  getAuditStateList,
  getAuditStatesFromCache,
  getPermsCache,
  setPermsCache,
  clearPermsCache,
  clearAuditStateListCache,
  changeApplyUserState,
  getAccessState,
  getApprovalList,
  getMyApprovalList,
  auditApplyUser,
  initApplyUser
}
