// utils/dev-reset.js
// 开发版/体验版专属工具：环境检测 + 实验台申请数据重置。
// 该模块仅在 develop / trial 环境下生效；release 环境调用 resetWorkbench() 不会清空任何数据，
// 调用 isDevEnv() 始终返回 false —— 业务页面据此显隐「重置」按钮即可，无须重复做环境判断。

// 是否处于开发版（develop / trial）。
// 通过 wx.getAccountInfoSync().miniProgram.envVersion 检测；接口不存在或失败时按 release 处理。
function isDevEnv() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync()
    if (info && info.miniProgram) {
      const env = info.miniProgram.envVersion || 'release'
      return env === 'develop' || env === 'trial' || env === 'developer' /* 老版本兼容 */
    }
  } catch (e) { /* 忽略检测异常 */ }
  return false
}

// 实验台申请数据重置：清空 workbenchApplies（申请记录）+ workbenchDraft（表单草稿）。
// 调用方应在 button 上做二次确认 Modal 后再调用本方法。
// 返回 { ok, removed: string[], error?: string }，便于调用方按需展示结果。
function resetWorkbenchData() {
  const KEYS = ['workbenchApplies', 'workbenchDraft']
  if (!isDevEnv()) return { ok: false, removed: [], error: '当前为正式版，已跳过清空' }
  const removed = []
  try {
    KEYS.forEach(k => {
      try {
        wx.removeStorageSync(k)
        removed.push(k)
      } catch (e) { /* 单个 key 清空失败不影响其它 key */ }
    })
    return { ok: true, removed }
  } catch (e) {
    return { ok: false, removed, error: (e && e.message) || '清空失败' }
  }
}

module.exports = {
  isDevEnv,
  resetWorkbenchData
}
