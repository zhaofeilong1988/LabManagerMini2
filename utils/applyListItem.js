// utils/applyListItem.js
// /api/applyList 返回的原始条目 → 列表项格式的归一化函数，集中维护在此处。
// 原本内联在 pages/my-booking/index.js，home 组件复用后提取成共用工具，避免两边漂移。
//
// 输出字段：
//   id / instId / instName / instIcon / lab / dateLabel / endDateLabel
//   / startText / endText / durText / endDs / modeName / costText / status
//   / submitTime / purpose / contentQty / remark
//
// 兼容若干种字段命名（驼峰 / 下划线 / 嵌套 device / deviceInfo 子对象），
// 解析失败时返回 null 整条丢弃。
const { keyFromState } = require('./bookingStatus.js')

function mapApplyListItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const pick = (...keys) => {
    const tryPath = (obj, path) => {
      if (!obj || typeof obj !== 'object') return undefined
      const segs = String(path || '').split('.').filter(Boolean)
      let cur = obj
      for (let i = 0; i < segs.length; i++) {
        if (cur == null || typeof cur !== 'object') return undefined
        cur = cur[segs[i]]
      }
      return (cur !== undefined && cur !== null && cur !== '') ? cur : undefined
    }
    for (const k of keys) {
      let v = tryPath(raw, k)
      // 嵌套 device / deviceInfo 兜底
      if (v === undefined && raw.device && typeof raw.device === 'object') v = tryPath(raw.device, k)
      if (v === undefined && raw.deviceInfo && typeof raw.deviceInfo === 'object') v = tryPath(raw.deviceInfo, k)
      if (v !== undefined) return v
    }
    return undefined
  }
  const str = (v, def) => {
    const s = String(v == null ? '' : v).trim()
    return s || def
  }
  const num = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.]/g, ''))
    return isNaN(n) ? 0 : n
  }
  // 时间戳解析：'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DDTHH:mm:ss' / 仅日期 → { ds, hh, mm }
  const tsParts = (s) => {
    const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?/)
    return m ? { ds: m[1], hh: m[2] || '00', mm: m[3] || '00' } : null
  }
  const sAt = pick('begin_at', 'startAt', 'beginAt', 'apply.begin_at', 'apply.startAt')
  const eAt = pick('finish_at', 'finishAt', 'endAt', 'apply.finish_at', 'apply.finishAt')
  const a = tsParts(sAt), b = tsParts(eAt)
  // 时长（分钟）
  const durMin = (a && b) ? Math.max(0, (parseInt(b.hh, 10) * 60 + parseInt(b.mm, 10)) - (parseInt(a.hh, 10) * 60 + parseInt(a.mm, 10))) : 0
  let durText = ''
  if (durMin > 0) {
    const h = Math.floor(durMin / 60), m = durMin % 60
    durText = (h && m) ? (h + '小时' + m + '分钟') : (h ? (h + '小时') : (m + '分钟'))
  }
  // 计费方式：1=自助 / 2=委托
  const opRaw = pick('operateType', 'operate_type', 'apply.operateType', 'mode')
  const opNum = Number(opRaw)
  const modeName = (opNum === 1) ? '自助' : (opNum === 2) ? '委托' : str(pick('modeName'), '')
  // 总费用（amount 优先；缺则回退 price；缺 / 为 0 时统一显示 ¥0，避免列表出现「自助 · 」缺位）
  const amountNum = num(pick('amount', 'cost', 'total', 'apply.amount'))
  const fallbackPriceNum = num(pick('price', 'apply.price'))
  const billNum = amountNum || fallbackPriceNum
  const costText = billNum ? ('¥' + (Math.round(billNum * 100) / 100)) : '¥0'
  // 状态归一化：按后端约定的数字枚举 (0~6) 映射到归一化 key
  //   0:待审核 / 1:已取消 / 2:已通过 / 3:已拒绝 / 4:已关闭 / 5:已上机 / 6:爽约
  // 字段名优先取 state，兼容 status / apply.state；字符串 key 也透传
  const status = keyFromState(pick('state', 'status', 'apply.state', 'apply.status'))
  // id 必有，否则整条无效
  const id = str(pick('id', 'applyId', 'apply_id'))
  if (!id) return null
  // 仪器信息
  const deviceId = pick('deviceId', 'device_id', 'device.id', 'apply.deviceId', 'id')
  // 时间戳清洗：把 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DDTHH:mm:ss' / unix 数字
  // 归一成 'YYYY-MM-DD HH:mm'，避免列表里出现秒位或裸时间戳
  const prettyTs = (s) => {
    const raw = s == null ? '' : s
    // unix 秒（10 位）/ 毫秒（13 位）→ 字符串化后再格式化
    if (typeof raw === 'number' || /^\d{9,13}$/.test(String(raw).trim())) {
      const n = String(raw).trim().length === 13 ? Number(raw) : Number(raw) * 1000
      const d = new Date(n)
      if (!isNaN(d.getTime())) {
        const p = (x) => (x < 10 ? '0' + x : '' + x)
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
          ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      }
    }
    const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/)
    return m ? (m[1] + (m[2] ? ' ' + m[2] : '')) : ''
  }
  return {
    id,
    instId: deviceId,
    instName: str(pick('device_name', 'device.name', 'deviceName', 'device.deviceName', 'name', 'deviceName'), '未知仪器'),
    instIcon: str(pick('device.icon', 'icon', 'emoji'), '🔬'),
    lab: str(pick('lab', 'device.company', 'company', 'organ.name'), ''),
    dateLabel: (a && a.ds) || '',
    endDateLabel: (b && b.ds) || '',
    endDs: (b && b.ds) || '',     // 跨天时显示「连续 X 小时」
    startText: a ? (a.hh + ':' + a.mm) : '',
    endText: b ? (b.hh + ':' + b.mm) : '',
    durText,
    modeName: modeName || '--',
    costText,
    status,
    // 提交时间：兼容驼峰 / 下划线 / apply. 嵌套 / unix 时间戳，与 booking-detail 详情页保持一致
    submitTime: prettyTs(pick(
      'apply.submitTime',
      'submitTime',
      'apply.createTime',
      'createTime',
      'apply.created_at',
      'created_at',
      'apply.create_time',
      'create_time',
      'apply.createdAt',
      'createdAt',
      'apply.submit_time',
      'submit_time',
      'apply.updateTime',
      'updateTime',
      'apply.updated_at',
      'updated_at',
      'ts',
      'timestamp'
    )),
    // 测试 memos —— 详情页透传给 booking-detail 用
    purpose: str(pick('memo1', 'apply.memo1'), ''),
    contentQty: str(pick('memo2', 'apply.memo2'), ''),
    remark: str(pick('memo3', 'apply.memo3'), ''),
    // 标识来源，方便后续调试与统计
    _fromApi: true
  }
}

module.exports = { mapApplyListItem }
