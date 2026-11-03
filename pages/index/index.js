// index.js
const { isLoggedIn, getOpenId } = require('../../utils/auth.js')
// getApplyUserDetailShared：GET /system/apply_user/detail，响应体里的 token 会被写回全局 TOKEN（含本地持久化）
// 用「共享版」而非 getApplyUserDetail：点击 tab 时目标组件（如 profile）也会拉一次 detail，
// 共用同一个在途 Promise / 跨页缓存，保证一次点击只发一个请求。
const { getApplyUserDetailShared } = require('../../utils/api.js')

// 点这两个 tab 时用 /system/apply_user/detail 刷新 token
const TOKEN_REFRESH_PAGES = ['home', 'profile']

Page({
  data: {
    page: 'home'   // 默认显示首页
  },

  onLoad(options) {
    // 支持从子页跳回指定 Tab（如 我的预约 → 仪器）
    const target = options && options.page
    if (target && ['home', 'instrument', 'training', 'profile'].indexOf(target) >= 0) {
      this.setData({ page: target })
    }
  },

  onShow() {
    // 从「培训详情」（navigationStyle: custom）返回时，微信在「自定义导航栏页 ↔ 普通页」
    // 混用页面栈时存在已知渲染缺陷：本页原生导航栏（状态栏区域）会被刷成白框。
    // onShow 里强制重刷一次导航栏颜色即可恢复。
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: '#0A7BB8',
      fail: () => {}
    })
    // 进入小程序：未登录则先跳转手机号授权登录页（登录成功后会回到本页）
    if (!isLoggedIn()) {
      wx.redirectTo({ url: '/pages/login/index' })
    }
    // 从子页返回（如「准入审批」→ 返回）：刷新一次 /system/apply_user/detail，
    // 保证全局 token 与「权限 perms 缓存」是最新的（后台改权限后回到首页能立即生效）
    // 注：自定义 tab 架构下，组件的 pageLifetimes.show 在 attached 后接连触发，
    // 会造成接口被请求两次（如 /api/deviceList、/system/apply_user/access）。
    // 这里不再无条件调用 onPageRefresh；改为「刷新一次 detail + 让当前组件按需刷新」。
    this._refreshOnShow()
  },

  // 从子页返回首页时调用 /system/apply_user/detail?openId={openId}
  //   ① 用响应体里的 token 刷新全局 token（getApplyUserDetailShared 内部已 refreshToken）
  //   ② 刷新全局权限缓存（getApplyUserDetail 内部 setPermsCache），准入审批的权限判定即时生效
  //   ③ 请求完成后通知当前 tab 组件按需刷新（home 会跳过 60s 缓存重拉，命中 5s 跨页缓存则不再发请求）
  // 节流：同一 openId 2 秒内不重复；与 tab 点击共用 _tokenRefreshing 防止并发
  _refreshOnShow() {
    const openId = getOpenId()
    if (!openId) {
      console.warn('[index] 无 openId，跳过返回首页时的 /system/apply_user/detail 刷新')
      return
    }
    const now = Date.now()
    if (this._lastShowRefreshOpenId === openId && this._lastShowRefreshAt &&
      now - this._lastShowRefreshAt < 2000) {
      console.log('[index] 2s 内已刷新过，跳过本次返回刷新')
      this._notifyCurrentTabRefresh()
      return
    }
    this._lastShowRefreshOpenId = openId
    this._lastShowRefreshAt = now
    if (this._tokenRefreshing) {
      this._notifyCurrentTabRefresh()
      return
    }
    this._tokenRefreshing = true
    console.log('[index] 从子页返回首页，调用 /system/apply_user/detail 刷新 token 与权限缓存')
    getApplyUserDetailShared(openId)
      .then(detail => {
        console.log('[index] /system/apply_user/detail 已返回（返回首页刷新）')
        this._notifyCurrentTabRefresh()
      })
      .catch(err => {
        console.warn('[index] /system/apply_user/detail 刷新失败：', err && (err.message || err))
        this._notifyCurrentTabRefresh()
      })
      .then(() => { this._tokenRefreshing = false })
  },

  // 通知当前 tab 组件刷新（组件实现了 onPageRefresh 才会被调用）
  _notifyCurrentTabRefresh() {
    const comp = this.selectComponent('#' + this.data.page)
    if (comp && typeof comp.onPageRefresh === 'function') {
      try { comp.onPageRefresh() } catch (e) { console.warn('[index] 组件刷新异常：', e) }
    }
  },

  toolbarClick(e) {
    const target = e.currentTarget.dataset.page
    if (target !== this.data.page) {
      this.setData({ page: target })
    }
    // 点「首页 / 我的」时刷新一次 token
    this._refreshToken(target)
  },

  // 底部导航点击 → GET /system/apply_user/detail?openId={openId}
  // 目的：用接口响应里下发的新 token 覆盖旧 token（getApplyUserDetailShared 内部已调用 refreshToken，
  // 会同步更新内存 TOKEN 与本地缓存），避免后续 /api/xxx 接口因 token 过期鉴权失败。
  // 仅「首页 / 我的」触发；失败不阻塞使用（沿用现有 token）。
  _refreshToken(page) {
    if (TOKEN_REFRESH_PAGES.indexOf(page) < 0) return
    const openId = getOpenId()
    if (!openId) {
      console.warn('[index] 无 openId，跳过 /system/apply_user/detail 刷新 token')
      return
    }
    if (this._tokenRefreshing) return   // 防止连点并发
    // 5 秒内对同一 openId 已刷新过 token，跳过（避免快速切 tab / 事件重复导致多次请求）
    const now = Date.now()
    if (this._lastRefreshOpenId === openId && this._lastRefreshAt && now - this._lastRefreshAt < 5000) {
      console.log('[index] 5s 内已刷新过 token，跳过')
      return
    }
    this._lastRefreshOpenId = openId
    this._lastRefreshAt = now
    this._tokenRefreshing = true
    console.log('[index] 点击「' + page + '」tab，调用 /system/apply_user/detail 更新 token，openId =', openId)
    getApplyUserDetailShared(openId)
      .then(detail => {
        const name = detail && detail.applyUser && (detail.applyUser.name || detail.applyUser.userName)
        console.log('[index] /system/apply_user/detail 已返回，token 已同步更新', name ? '（用户：' + name + '）' : '')
      })
      .catch(err => {
        console.warn('[index] /system/apply_user/detail 刷新 token 失败，沿用当前 token：', err && (err.message || err))
      })
      .then(() => { this._tokenRefreshing = false })
  },

  // 接收 home component 内部发出的 tab 切换事件
  onSwitchTab(e) {
    const target = e.detail.page
    if (target !== this.data.page) {
      this.setData({ page: target })
    }
  }
})
