// utils/auth.js —— 登录态统一管理（本地持久化，后续可替换为 token 校验）
// token 只从统一来源读写（utils/token.js，内部持久化 lab_api_token），
// 不再经过 api.js，避免登录态与接口层各存一份而不同步
const { setToken: setApiToken } = require('./token.js')
const { clearPermsCache } = require('./api.js')
const USER_KEY = 'lab_user'
// 授权登录返回的 openid 独立缓存键（/api/login 的 data.openid）
const OPENID_KEY = 'lab_openid'

// 读取当前登录用户（未登录返回 null）
function getLoginUser() {
  return wx.getStorageSync(USER_KEY) || null
}

// 是否已登录
function isLoggedIn() {
  return !!getLoginUser()
}

// 保存登录态（user: { token, phone, name?, demo? }）
function saveLoginUser(user) {
  const u = Object.assign({}, user, { loginAt: Date.now() })
  wx.setStorageSync(USER_KEY, u)
  // 登录态里的 token 同步给统一来源：换账号后所有 /api/xxx 立刻用上这个新 token。
  // 不这样做的话，接口层会一直沿用上一个账号（或默认调试）的旧 token
  if (u.token) {
    try { setApiToken(u.token) } catch (e) { /* 忽略 */ }
  }
  const app = getApp()
  if (app) app.globalData.userInfo = u
  return u
}

// 缓存授权登录返回的 openid（提交登记等接口需要携带）
function saveOpenId(openid) {
  const v = openid ? String(openid) : ''
  if (v) wx.setStorageSync(OPENID_KEY, v)
  else wx.removeStorageSync(OPENID_KEY)
  return v
}

// 读取缓存的 openid（优先独立缓存，回退登录态中的 openid，兼容旧数据）
function getOpenId() {
  const cached = wx.getStorageSync(OPENID_KEY)
  if (cached) return String(cached)
  const u = getLoginUser()
  return (u && (u.openid || u.openId)) || ''
}

// 退出登录
function clearLogin() {
  wx.removeStorageSync(USER_KEY)
  wx.removeStorageSync(OPENID_KEY)
  // 同步重置 token（回退默认调试 token，避免换账号/体验登录时残留上一用户的 token）
  try { setApiToken('') } catch (e) { /* 忽略 */ }
  // 清掉全局权限缓存：换账号后不能沿用上一个账号的 perms
  try { clearPermsCache() } catch (e) { /* 忽略 */ }
  const app = getApp()
  if (app) app.globalData.userInfo = null
}

// ── 后台管理系统登录密码（demo：本地持久化，后端接入后替换为接口校验） ──
const PWD_KEY = 'lab_pwd'

// 是否已设置（修改过）密码
function hasPassword() {
  return !!wx.getStorageSync(PWD_KEY)
}

// 校验原密码：未设置过密码时直接通过
function verifyPassword(pwd) {
  const saved = wx.getStorageSync(PWD_KEY)
  return !saved || saved === pwd
}

// 保存 / 修改密码
function setPassword(pwd) {
  wx.setStorageSync(PWD_KEY, pwd)
  return true
}

module.exports = {
  USER_KEY,
  OPENID_KEY,
  PWD_KEY,
  getLoginUser,
  isLoggedIn,
  saveLoginUser,
  saveOpenId,
  getOpenId,
  clearLogin,
  hasPassword,
  verifyPassword,
  setPassword
}
