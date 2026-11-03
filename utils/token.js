// utils/token.js —— 全局 token 的唯一来源
//
// 之前 token 分散在两处：
//   ① utils/api.js 的模块内变量（持久化键 lab_api_token）
//   ② utils/auth.js 的登录态对象（lab_user.token）
// 两边互不感知，会出现「登录态已经是新账号、接口还在用旧 token」的情况。
// 现在统一由本模块持有：登录态保存 / 清除、接口层注入与轮换，都通过这里读写同一份值。

const TOKEN_KEY = 'lab_api_token'
// 默认 token（开发调试用）：/api/login 登录成功后会被返回的 token 覆盖，并本地持久化
const DEFAULT_TOKEN = '6eb82185-5d8c-4289-ba4e-0d419c32fc79'

let TOKEN = ''
try { TOKEN = wx.getStorageSync(TOKEN_KEY) || DEFAULT_TOKEN } catch (e) { TOKEN = DEFAULT_TOKEN }

// 读取当前生效的 token
function getToken() {
  return TOKEN
}

// 写入 token：内存 + 本地持久化
// 传空值 → 回退默认调试 token 并清掉持久化（换账号 / 退出登录时用）
// 返回写入后的值，便于调用方判断值是否真的变化
function setToken(token) {
  const v = token ? String(token).trim() : ''
  if (v) {
    if (v !== TOKEN) {
      TOKEN = v
      try { wx.setStorageSync(TOKEN_KEY, v) } catch (e) { /* 忽略缓存异常 */ }
      console.log('[token] token 已更新')
    }
  } else {
    TOKEN = DEFAULT_TOKEN
    try { wx.removeStorageSync(TOKEN_KEY) } catch (e) { /* 忽略缓存异常 */ }
  }
  return TOKEN
}

module.exports = {
  TOKEN_KEY,
  DEFAULT_TOKEN,
  getToken,
  setToken
}
