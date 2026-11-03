// components/instrument/instrument.js
const { getDeviceList, checkAppointment, getDeviceApply, DEVICE_APPLY_KEY } = require('../../utils/api.js')

// ── 仪器列表缓存（模块级，跨组件实例存活）──
// deviceList 仅用于仪器列表页渲染：自定义 tab（wx:elif）架构下组件每次切回
// 「仪器」tab 都会销毁重建（attached 必触发）。
// 缓存策略：带 TTL 的缓存，短时间内反复切 tab 不会重复请求，超过 TTL 后自动回源，
// 避免改了数据却要重启小程序才看得到。需要立刻刷新时由 index 页调用 onPageRefresh()。
// TTL 与 home 组件的准入状态缓存保持一致（60 秒）。
const LIST_CACHE_TTL = 60 * 1000
let _listCache = { ts: 0, devices: [] }

// /api/deviceList 返回字段名兼容映射：不同后端字段命名风格差异较大，
// 这里统一映射为列表组件使用的字段，便于上层渲染稳定
function mapDevice(it) {
  if (!it || typeof it !== 'object') return null
  const pick = (...keys) => {
    for (const k of keys) {
      const v = it[k]
      if (v !== undefined && v !== null && v !== '') return v
    }
    return undefined
  }
  const idRaw = pick('id', 'deviceId', 'device_id', 'no', 'assetNo', 'sn')
  const name = String(pick('name', 'deviceName', 'devName', 'title') || '').trim()
  if (idRaw == null || !name) return null
  // 左下角位置（来源 company），右下角机构名称（来源 organ_name / organName）
  const company = String(pick('company') || '').trim()
  const organName = String(pick('organName', 'organ_name') || '').trim()
  const image = String(pick('image', 'imageUrl', 'img', 'imgUrl', 'cover', 'coverUrl', 'photo', 'thumb', 'thumbnail') || '').trim()
  const icon = String(pick('icon', 'emoji') || '').trim() || '🔬'
  // 布尔字段兼容数字 0/1 与布尔值
  // need_appointment: 0 = 无需预约, 1 = 需预约 → needBook
  // need_check:       0 = 无需审批, 1 = 需审批 → needApprove
  const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true'
  const needBook = toBool(pick('need_appointment', 'needAppointment', 'needBook', 'need_book', 'bookRequired'))
  const needApprove = toBool(pick('need_check', 'needCheck', 'needApprove', 'need_approve', 'approveRequired'))
  // 开关机状态：power_state 1 = 开机，0 = 空闲；优先 power_state，无值时回退 status/state
  const powerStateRaw = pick('power_state', 'powerState')
  let status = ''
  let statusText = ''
  if (powerStateRaw !== undefined && powerStateRaw !== null && powerStateRaw !== '') {
    const ps = Number(powerStateRaw)
    if (ps === 1) { status = 'on'; statusText = '开机' }
    else if (ps === 0) { status = 'idle'; statusText = '空闲' }
  }
  if (!statusText) {
    const statusRaw = pick('status', 'state')
    status = statusRaw == null ? '' : String(statusRaw).trim().toLowerCase()
    statusText = String(pick('statusText', 'status_text') || '').trim()
    if (!statusText && status) {
      const STATUS_TEXT_MAP = { idle: '空闲', online: '在线', offline: '离线', busy: '使用中', running: '使用中', maintenance: '维护中', fault: '故障' }
      statusText = STATUS_TEXT_MAP[status] || status
    }
  }
  return {
    id: String(idRaw),
    name,
    company,
    organName,
    image,
    icon,
    needBook,
    needApprove,
    status,
    statusText,
    imgOk: !!image
  }
}

Component({
  data: {
    keyword: '',
    imgErr: [],
    loading: false,
    instruments: [],
    filtered: [],
    // 回到顶部按钮：scrollTop > 200px 时显示，scroll-top 用于反向控制 scroll-view
    showBackTop: false,
    scrollTop: 0
  },

  // 注意：不要在这里加 pageLifetimes.show —— 自定义 tab（wx:elif）架构下组件
  // 每次「切到仪器 tab」都会重新 attached，pageLifetimes.show 只会额外造成
  // 重复请求（attached 与 show 接连触发），首页/我的 tab 的组件切换不会触达本组件
  lifetimes: {
    attached() {
      this._loadDevices('attached')
    }
  },

  methods: {
    // 拉取仪器列表：POST /api/deviceList
    // 触发源有两个：attached（切到仪器 tab）与 index 页通知的 onPageRefresh：
    //   ① 缓存命中（60s 内拉过）且非强制 → 直接用缓存渲染，不发请求
    //   ② 请求进行中直接跳过
    //   ③ 强制刷新：force=true 时绕过缓存重新拉取（从子页返回 / 手动刷新）
    _loadDevices(source, force) {
      console.log('[instrument] _loadDevices 触发源：', source || 'unknown', 'force =', !!force)
      if (this._loading) return
      // 缓存命中条件：非强制刷新 且 缓存时间在 TTL 内
      const cacheHit = !force && _listCache.ts && (Date.now() - _listCache.ts < LIST_CACHE_TTL)
      if (cacheHit) {
        console.log('[instrument] 列表缓存命中（60s 内），不发请求')
        this.setData({ instruments: _listCache.devices })
        this.applyFilter(this.data.keyword)
        return
      }
      this._loading = true
      this.setData({ loading: true })
      getDeviceList()
        .then(list => {
          const devices = (Array.isArray(list) ? list : [])
            .map(mapDevice)
            .filter(Boolean)
          _listCache = { ts: Date.now(), devices }
          this.setData({ instruments: devices })
          this.applyFilter(this.data.keyword)
        })
        .catch(err => {
          console.warn('[instrument] /api/deviceList 获取失败：', err)
          this.setData({ instruments: [] })
          this.applyFilter('')
          wx.showToast({ title: '仪器列表加载失败', icon: 'none' })
        })
        .then(() => {
          this._loading = false
          this.setData({ loading: false })
        })
    },
    // 页面层刷新入口（index 页 onShow / 从子页返回时调用）：
    // 与 home、profile 组件保持同名协议，index 页通过 selectComponent 找到它并调用。
    // 忽略缓存重新拉取一次，保证回到「仪器」tab 时能看到最新数据。
    onPageRefresh() {
      this._loadDevices('onPageRefresh', true)
    },

    onSearch(e) {
      this.applyFilter(e.detail || '')
    },

    // 滚动监听：超过阈值时显示悬浮回顶按钮，低于阈值时收回
    // 节流：避免每次 setData；只在需要翻转 showBackTop 时才触发
    onScroll(e) {
      const st = (e && e.detail && Number(e.detail.scrollTop)) || 0
      const shouldShow = st > 200
      if (shouldShow !== this.data.showBackTop) {
        this.setData({ showBackTop: shouldShow })
      }
    },

    // 点击回顶：通过修改 scroll-top 触发 scroll-view 平滑回滚
    // enhanced + scroll-with-animation 组合下，scrollTop 由非零改 0 即触发过渡动画
    onBackTop() {
      this.setData({ scrollTop: 0, showBackTop: false })
    },

    applyFilter(kw) {
      const keyword = (kw || '').trim()
      const errSet = new Set(this.data.imgErr)
      const filtered = this.data.instruments
        .filter(i =>
          !keyword ||
          i.name.includes(keyword) ||
          i.company.includes(keyword) ||
          i.organName.includes(keyword)
        )
        .map(i => ({ ...i, imgOk: i.imgOk && !errSet.has(i.id) }))
      this.setData({ keyword, filtered })
    },

    // 图片加载失败时回退为图标占位
    onImgErr(e) {
      const id = e.currentTarget.dataset.id
      if (this.data.imgErr.indexOf(id) >= 0) return
      this.setData({
        imgErr: [...this.data.imgErr, id],
        filtered: this.data.filtered.map(i =>
          i.id === id ? { ...i, imgOk: false } : i
        )
      })
    },

    // 点击卡片其它区域 → 先调 /api/deviceApply（{ token, id }）获取该仪器数据，
    // 缓存后仍跳转仪器详情页（与预约按钮跳转的预约页不同，保持原有跳转目标不变）
    goDetail(e) {
      const id = e.currentTarget.dataset.id
      // 拦截空 id：dataset 缺失/为空时直接返回，避免发出空参数请求
      if (id == null || String(id).trim() === '') return
      console.log('[instrument] goDetail 触发，id =', id)
      // 防重复点击：上一次请求进行中时忽略
      if (this._detailing) return
      this._detailing = true
      wx.showLoading({ title: '加载中…', mask: true })
      getDeviceApply(id)
        .then(data => {
          // 接口返回数据经本地缓存中转（navigateTo 不便携带复杂对象），详情页可按需取用
          try { wx.setStorageSync(DEVICE_APPLY_KEY, { deviceId: String(id), data, ts: Date.now() }) } catch (err) { /* 忽略缓存异常 */ }
          wx.navigateTo({
            url: '/pages/instrument-detail/index?id=' + id,
            complete: () => wx.hideLoading()
          })
        })
        .catch(err => {
          // 接口失败（code 非 0 + 后端 msg）透出提示，不跳转
          wx.hideLoading()
          wx.showModal({
            title: '加载失败',
            content: (err && err.message) || '仪器数据获取失败，请稍后重试。',
            showCancel: false,
            confirmColor: '#0A7BB8'
          })
        })
        .then(() => { this._detailing = false })
    },

    // 点击预约按钮：
    //   ① /api/checkAppointment（{ token, deviceId }）校验预约权限，code=0 即有权限
    //     （api.js 的 unwrap 对 code=0 放行、非 0 抛后端 msg 走 catch）
    //   ② 有权限 → /api/deviceApply（{ token, deviceId }）获取预约页数据，
    //     缓存后进入预约时段选择页渲染；无权限/失败弹窗提示，不跳转
    goBook(e) {
      const id = e.currentTarget.dataset.id
      // 拦截空 id：dataset 缺失/为空时直接返回，避免发出 deviceId 为空的请求
      if (id == null || String(id).trim() === '') return
      console.log('[instrument] goBook 触发，deviceId =', id)
      // 防重复点击：上一次校验进行中时忽略
      if (this._checking) return
      this._checking = true
      wx.showLoading({ title: '校验预约权限…', mask: true })
      checkAppointment(id)
        .then(() => getDeviceApply(id))
        .then(data => {
          // 预约页渲染数据经本地缓存中转（navigateTo 不便携带复杂对象）
          try { wx.setStorageSync(DEVICE_APPLY_KEY, { deviceId: String(id), data, ts: Date.now() }) } catch (err) { /* 忽略缓存异常 */ }
          wx.navigateTo({
            url: '/pages/instrument-book/index?id=' + id,
            complete: () => wx.hideLoading()
          })
        })
        .catch(err => {
          // 无权限（code 非 0 + 后端 msg）或接口失败，透出提示
          wx.hideLoading()
          wx.showModal({
            title: '无法预约',
            content: (err && err.message) || '您暂无该仪器的预约权限，请先完成平台准入或联系管理员开通。',
            showCancel: false,
            confirmColor: '#0A7BB8'
          })
        })
        .then(() => { this._checking = false })
    }
  }
})
