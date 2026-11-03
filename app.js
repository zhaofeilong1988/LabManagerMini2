// app.js
const { getLoginUser } = require('./utils/auth.js')

// ── 全局调试日志开关 ──
//   true  = 正常打印（排查问题时打开）
//   false = 屏蔽 console.log / info / debug，warn / error 保留（便于看报错）
// 想看接口请求/响应打印（[api]、[applyUser]、[approval]、[pickPerms] 等）时改成 true
const ENABLE_CONSOLE_LOG = false

try {
  if (!ENABLE_CONSOLE_LOG && console) {
    const noop = function () {}
    console.log = noop
    console.info = noop
    console.debug = noop
  }
} catch (e) { /* 环境不允许改写 console 时忽略，不影响运行 */ }

App({
  onLaunch() {
    // 展示本地存储能力
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)

    // 恢复本地登录态
    this.globalData.userInfo = getLoginUser()

    // 静默登录：wx.login 仅获取 code，用于后续换取 openId/sessionKey
    wx.login({
      success: res => {
        // 发送 res.code 到后台换取 openId, sessionKey, unionId
      }
    })
  },
  globalData: {
    userInfo: null
  },

  // ── 轻量事件总线（页面/组件间通信）──
  // 背景：自定义 tab + wx:elif 架构下，返回页面时组件的 pageLifetimes.show
  // 不稳定触发，改为「状态变更方主动 emit，展示方订阅刷新」保证数据及时更新。
  _listeners: {},
  on(evt, fn) {
    if (!this._listeners[evt]) this._listeners[evt] = []
    this._listeners[evt].push(fn)
  },
  off(evt, fn) {
    const arr = this._listeners[evt] || []
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  },
  emit(evt, payload) {
    (this._listeners[evt] || []).slice().forEach(fn => {
      try { fn(payload) } catch (e) { console.error('[app] 事件处理异常：', evt, e) }
    })
  }
})
