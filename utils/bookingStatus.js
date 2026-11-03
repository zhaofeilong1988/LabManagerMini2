// utils/bookingStatus.js
// 预约状态字段映射工具：后端 state 字段（数字）与界面层用的归一化 key + 视图标签，集中放在此处维护
//
// 后端约定（用户明确提供，applyList / deviceApplyDetail 均按此返回）：
//   0: 待审核  → pending
//   1: 已取消  → cancelled
//   2: 已通过  → approved
//   3: 已拒绝  → rejected
//   4: 已关闭  → closed
//   5: 已上机  → active
//   6: 爽约    → noShow

// 数字 → 归一化 key
const STATE_KEY = {
  0: 'pending',
  1: 'cancelled',
  2: 'approved',
  3: 'rejected',
  4: 'closed',
  5: 'active',
  6: 'noShow'
}

// 输入 数字 / 数字字符串 / 已是归一化 key 字符串 / 未知值 → 归一化 key
//   - 数字或数字字符串 → 查 STATE_KEY，无则返回 ''（无效输入不兜底成默认）
//   - 非数字字符串 → 小写后直接返回（兼容本地兜底数据可能仍是 'pending' 等字符串 key）
//   - null / undefined / 空串 → 返回 ''
function keyFromState(v) {
  if (v == null) return ''
  const s = String(v).trim()
  if (!s) return ''
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return STATE_KEY[n] !== undefined ? STATE_KEY[n] : ''
  }
  return s.toLowerCase()
}

// 「我的预约」列表视图的状态标签（使用 mb-tag-* 类名，与 my-booking/index.wxss 对齐）
const LIST_TAG = {
  pending:   { text: '待审核', cls: 'mb-tag-warn' },
  approved:  { text: '已通过', cls: 'mb-tag-ok' },
  active:    { text: '已上机', cls: 'mb-tag-ok' },
  cancelled: { text: '已取消', cls: 'mb-tag-gray' },
  rejected:  { text: '已拒绝', cls: 'mb-tag-err' },
  closed:    { text: '已关闭', cls: 'mb-tag-gray' },
  noShow:    { text: '爽约',   cls: 'mb-tag-gray' }
}

// 「预约详情」详情视图的状态标签（使用 bd-status--* 类名，与 booking-detail/index.wxss 对齐）
const DETAIL_TAG = {
  pending:   { text: '待审核', cls: 'bd-status--warn' },
  approved:  { text: '已通过', cls: 'bd-status--ok' },
  active:    { text: '已上机', cls: 'bd-status--ok' },
  cancelled: { text: '已取消', cls: 'bd-status--gray' },
  rejected:  { text: '已拒绝', cls: 'bd-status--err' },
  closed:    { text: '已关闭', cls: 'bd-status--gray' },
  noShow:    { text: '爽约',   cls: 'bd-status--gray' },
  default:   { text: '未知',   cls: 'bd-status--gray' }
}

// 可取消的状态集合：仅有 「待审核 / 已通过 / 已上机」 三态允许发起取消操作
const CANCELLABLE_KEYS = new Set(['pending', 'approved', 'active'])

module.exports = {
  STATE_KEY,
  keyFromState,
  LIST_TAG,
  DETAIL_TAG,
  CANCELLABLE_KEYS
}
