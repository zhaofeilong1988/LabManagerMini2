// pages/login/index.js —— 手机号授权登录
const { loginByPhone } = require('../../utils/api.js')
const { isLoggedIn, saveLoginUser, saveOpenId, getOpenId } = require('../../utils/auth.js')

// 体验账号手机号（开发调试用，非真实授权）
const DEMO_PHONE = '13800000000'

// wx.login 获取临时 code
function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: res => (res && res.code ? resolve(res.code) : reject(new Error('wx.login 失败'))),
      fail: reject
    })
  })
}

Page({
  data: {
    agreed: true,  // 默认勾选协议
    loading: false,
    from: ''       // 登录来源：''= 进入拦截；relogin= 个人页重新登录
  },

  onLoad(options) {
    this.setData({ from: (options && options.from) || '' })
    // 已登录（如清缓存前残留状态）直接回首页
    if (isLoggedIn()) {
      this._goBack()
    }
  },

  // 登录成功后统一回到首页（不再回「我的」）
  _goBack() {
    wx.redirectTo({ url: '/pages/index/index' })
  },

  // 勾选/取消协议
  toggleAgree() {
    this.setData({ agreed: !this.data.agreed })
  },

  // 微信手机号授权回调（e.detail.code 需交由后端换取手机号）
  onGetPhoneNumber(e) {
    if (!this._checkAgreed()) return
    const detail = (e && e.detail) || {}
    const errMsg = detail.errMsg || ''
    // 打印微信真实回调，便于定位是「用户拒绝」还是「环境/权限不支持」
    console.log('[login] getPhoneNumber 回调：', detail)

    // 用户主动拒绝 / 取消授权：轻提示即可，不弹降级弹窗
    if (/deny|cancel/i.test(errMsg)) {
      wx.showToast({ title: '已取消授权', icon: 'none' })
      return
    }
    // 正常拿到 code：交后端换取手机号
    if (detail.code && errMsg === 'getPhoneNumber:ok') {
      this._startLogin({ phoneCode: detail.code })
      return
    }
    // 其它情况：多为环境 / 主体能力限制（个人主体、开发者工具模拟器、未开通能力、未配置隐私指引）
    this._fallback(this._phoneFailReason(errMsg))
  },

  // 根据微信 errMsg 归类失败原因，给出更准确的提示
  _phoneFailReason(errMsg) {
    const msg = String(errMsg || '')
    if (/privacy/i.test(msg)) {
      return '需先在小程序后台配置「用户隐私保护指引」并声明手机号用途'
    }
    if (/no permission|not support|unsupported/i.test(msg)) {
      return '当前环境暂不支持手机号授权（需非个人主体小程序，并在真机使用）'
    }
    return '手机号授权未完成' + (msg ? '（' + msg + '）' : '')
  },

  // 体验账号登录（开发调试：后端未就绪 / 授权不可用时使用）
  onDemoLogin() {
    if (!this._checkAgreed()) return
    this._startLogin({ demo: true, phone: DEMO_PHONE })
  },

  _checkAgreed() {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意用户协议', icon: 'none' })
      return false
    }
    return true
  },

  // 发起登录：真实授权走后端换取 token/手机号；体验模式直接落本地登录态
  async _startLogin(params) {
    if (this.data.loading) return
    this.setData({ loading: true })
    wx.showLoading({ title: '登录中...', mask: true })
    try {
      let user
      if (params.demo) {
        user = { phone: params.phone, name: '体验用户', demo: true }
      } else {
        let code = ''
        try {
          code = await wxLoginCode()
        } catch (err) {
          /* wx.login 失败不阻塞，仍携带 phoneCode 尝试 */
        }
        user = await loginByPhone(code, params.phoneCode)
      }
      saveLoginUser(user)
      // /api/login 返回的 data.openid 单独缓存，供 /api/register 等接口携带
      // 每次登录都覆写一次缓存（新值为空也写入，由 saveOpenId 清掉 OPENID_KEY），
      // 避免「重新登录 / 换账号 / 真机→体验」等场景下，前一个用户的 openid 残留
      saveOpenId((user && user.openid) || '')
      console.log('[login] openid 已缓存 =', getOpenId() || '(空)')
      wx.hideLoading()
      this.setData({ loading: false })
      wx.showToast({ title: '登录成功', icon: 'success' })
      setTimeout(() => {
        this._goBack()
      }, 600)
    } catch (err) {
      wx.hideLoading()
      this.setData({ loading: false })
      this._fallback('后端登录接口暂未就绪')
    }
  },

  // 授权/后端不可用时的降级引导（体验账号）
  _fallback(reason) {
    wx.showModal({
      title: '提示',
      content: reason + '。是否切换「体验账号」继续浏览演示？',
      confirmText: '体验登录',
      cancelText: '取消',
      success: res => {
        if (res.confirm) this.onDemoLogin()
      }
    })
  }
})
