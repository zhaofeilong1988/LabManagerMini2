// utils/admissionState.js —— 准入状态统一映射
//
// 数据源唯一：GET /system/apply_user/detail 返回的 applyUser.state
// 之前 home / profile / onboarding 三处各写一份映射且互不一致，导致同一 state
// 在不同入口落在不同节点（如 state=4：首页落到「准入成功」、「我的」落到「申请登记」）。
// 这里集中定义，三处共用，避免再次出现不一致。
//
// ── state 约定（以后端 apply_user.state 为准）──
//   -1        已登记，尚未提交材料          → 节点 1「材料提交」
//   0         已提交审核（历史 access 语义）→ 节点 2「等待审核」
//   4         已提交准入申请，待审核        → 节点 2「等待审核」
//   2         已准入（审核通过）            → 节点 3「准入成功」
//   1         已取消                        → 回到节点 0「申请登记」
//   3         已驳回                        → 回到节点 0「申请登记」
//   null / 未知 → 无申请记录或未查询        → 节点 0「申请登记」
//
// ── 流程节点（总览页 /pages/onboarding/index/index?step=）──
//   0 申请登记 / 1 材料提交 / 2 等待审核 / 3 准入成功
const STATE_TO_NODE = {
  '-1': 1,
  '0': 2,
  '4': 2,
  '2': 3,
  '1': 0,
  '3': 0
}

// state → 总览页节点（0-3）；null / undefined / 无法识别 → 0（申请登记）
function stateToNode(state) {
  if (state === null || state === undefined || state === '') return 0
  const n = Number(state)
  if (isNaN(n)) return 0
  const node = STATE_TO_NODE[String(n)]
  return node == null ? 0 : node
}

// state → 「我的」页进度条步骤（1-4），与总览页节点一一对应（节点 + 1）
function stateToStep(state) {
  return stateToNode(state) + 1
}

// 从 detail 接口返回的 applyUser 解析数字状态：
//   无申请记录（空对象 / null）或 state 字段缺失 → null（表示「无数据」）
function pickState(applyUser) {
  if (!applyUser || typeof applyUser !== 'object') return null
  if (!Object.keys(applyUser).length) return null
  const raw = applyUser.state
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return isNaN(n) ? null : n
}

// 是否已准入（审核通过，state = 2）
function isAdmitted(state) {
  const n = Number(state)
  return !isNaN(n) && n === 2
}

module.exports = {
  STATE_TO_NODE,
  stateToNode,
  stateToStep,
  pickState,
  isAdmitted
}
