// utils/bookings.js
// 「我的预约」数据源：提交预约后写入本地缓存（wx storage），我的预约页读取展示
// 字段约定：
//   id          预约单号（MB + 时间戳）
//   instId      仪器 id        instName / instIcon / lab
//   dateLabel   预约日期文案    startText / endText  时段文案
//   modeName    计费方式         costText            预估费用
//   needApprove 是否需审批
//   status      pending 待审批 / confirmed 已确认 / cancelled 已取消
//   submitTime  提交时间
const KEY = 'lab_my_bookings'

// 历史遗留 demo 数据 id 集合：旧的演示代码里在「首次进入且无记录」时预置的两条假数据。
// 这里走精确集合比对，避免误伤真实预约号（真实 id 是 'MB' + 14 位时间戳 + 2 位随机数）。
const DEMO_IDS = new Set(['MB202609010001', 'MB202609010002'])

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function listBookings() {
  // 列表里不再预置任何 demo 数据：空 storage 直接返回 []
  try {
    const arr = wx.getStorageSync(KEY)
    if (Array.isArray(arr) && arr.length) {
      // 一次性清理已存在的 demo 数据（仅匹配精确 id 集合，安全无损）
      const cleaned = arr.filter(b => !(b && b.id && DEMO_IDS.has(String(b.id))))
      if (cleaned.length !== arr.length) {
        try { wx.setStorageSync(KEY, cleaned) } catch (e) { /* 忽略 */ }
      }
      return cleaned
    }
  } catch (e) { /* 忽略读取异常 */ }
  return []
}

function saveBookings(arr) {
  try {
    wx.setStorageSync(KEY, arr)
  } catch (e) { /* 存储失败时忽略 */ }
}

// 新增预约记录（插到最前，便于列表倒序展示最新预约）
function addBooking(record) {
  const t = new Date()
  const stamp =
    t.getFullYear() + pad2(t.getMonth() + 1) + pad2(t.getDate()) +
    pad2(t.getHours()) + pad2(t.getMinutes()) + pad2(t.getSeconds())
  const item = Object.assign({}, record, {
    id: 'MB' + stamp + Math.floor(Math.random() * 90 + 10),
    submitTime: stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8) +
      ' ' + stamp.slice(8, 10) + ':' + stamp.slice(10, 12)
  })
  const arr = listBookings()
  arr.unshift(item)
  saveBookings(arr)
  return item
}

// 取消预约：仅未取消的记录可取消
function cancelBooking(id) {
  const arr = listBookings()
  const it = arr.find(x => x.id === id)
  if (!it || it.status === 'cancelled') return false
  it.status = 'cancelled'
  saveBookings(arr)
  return true
}

module.exports = {
  listBookings,
  addBooking,
  cancelBooking
}
