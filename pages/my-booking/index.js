// pages/my-booking/index.js
// 我的预约：列表数据完全由 /api/applyList 接口返回渲染（去除本地兜底）
//   「进行中」标签 → /api/applyList，state=4（用户约定值）
//   「历史」标签   → /api/applyList，state=5（已取消/已完成的猜测值，待后端约定确认；不匹配时需调整该常量）
// 进入页面只请求当前 tab 的接口，避免并发两个调用同时发请求且互相踩回调；
// 另一个 tab 的数据在用户切换时（setTab）按需加载，count 与 list 随之刷新。
const { getDeviceDetail, SCAN_DETAIL_KEY, getDeviceApply, DEVICE_APPLY_KEY, getDeviceApplyDetail, BOOKING_DETAIL_KEY, getApplyList, deviceApplyCancel } = require('../../utils/api.js')
// 状态字段映射（数字枚举 0~6 → 归一化 key + 视图标签），集中维护在 utils/bookingStatus.js
// keyFromState 已下沉到 utils/applyListItem.js 内部使用，本文件不再直接引用
const { LIST_TAG, CANCELLABLE_KEYS } = require('../../utils/bookingStatus.js')
// /api/applyList 原始条目 → 列表项格式的归一化函数（与 components/home 共用）
const { mapApplyListItem } = require('../../utils/applyListItem.js')

// /api/applyList 的 state 字段约定
const STATE_ACTIVE = 4   // 进行中（待审批 + 已确认）
const STATE_HISTORY = 5  // 历史（已取消 / 已完成）。如后端约定不同，改这一个常量即可

// 「我的预约」列表状态标签：来自 utils/bookingStatus.js 的 LIST_TAG
// 同时也保留一份 TAG 别名（= LIST_TAG），让 decorateItem 在感知层只引用同一个常量
const TAG = LIST_TAG

// 装饰单条记录：补上 tagText / tagCls 给 wxml 直接展示，并预计算 cancellable 标记
// （「待审核 / 已通过 / 已上机」三态允许在卡片上渲染「取消预约」按钮，
//   其余 已取消 / 已拒绝 / 已关闭 / 爽约 视为不可再操作）
function decorateItem(b) {
  const t = TAG[b.status] || { text: '未知', cls: 'mb-tag-gray' }
  return Object.assign({}, b, {
    tagText: t.text,
    tagCls: t.cls,
    cancellable: CANCELLABLE_KEYS.has(b.status)
  })
}

Page({
  data: {
    tab: 'active', // active 进行中 | history 历史
    list: [],
    countActive: 0,
    countHistory: 0,
    emptyText: '',
    loading: false  // 当前 tab 拉接口时的小菊花
  },
  // 切换 tab / 重载 序列号：每个 tab 各自维护一个 seq，
  // 防止快速切换/并发调用时旧请求晚回覆盖新数据。
  // 两个 tab 的 seq 必须独立，否则 _loadActive 与 _loadHistory 会互相踩回调，
  // 导致 loading: false 永远不被设回，菊花卡死。
  _seqActive: 0,
  _seqHistory: 0,

  onShow() {
    // 每次进入页面同时刷新「进行中」与「历史」两个 tab 的数据
    // 当前 tab：列表 + 计数都更新（带小菊花）
    // 非当前 tab：仅静默更新计数，不抢界面
    this._loadActive()
    this._loadHistory()
  },

  setTab(e) {
    const tab = e.currentTarget.dataset.t
    if (tab === this.data.tab) return
    // 切换前清空列表，避免旧 tab 数据短暂残留；新 tab 数据由对应接口返回后填充
    this.setData({ tab, list: [], emptyText: '正在加载…', loading: true })
    if (tab === 'active') this._loadActive()
    else this._loadHistory()
  },

  reload() {
    // 当前 tab 重载（如下拉刷新 / 取消预约后调用）
    // 两个 tab 的计数都一并刷新，避免取消回到「历史」后「进行中」计数残留
    this._loadActive()
    this._loadHistory()
  },

  // 「进行中」标签：仅从 /api/applyList (state=3) 拉取数据渲染
  _loadActive() {
    const seq = ++this._seqActive
    if (this.data.tab === 'active') {
      this.setData({ loading: true, emptyText: '正在加载预约列表…' })
    }
    getApplyList(STATE_ACTIVE)
      .then(items => {
        if (seq !== this._seqActive) return  // 已切换 tab / 又一次加载，丢弃这次结果
        const apiItems = (items || []).map(mapApplyListItem).filter(Boolean).map(decorateItem)
        const patch = { countActive: apiItems.length }
        // 仅当停留在当前 tab 时刷新 list / emptyText / loading，避免抢界面
        if (this.data.tab === 'active') {
          Object.assign(patch, {
            list: apiItems,
            emptyText: apiItems.length ? '' : '暂无进行中的预约\n在仪器详情页提交预约后会显示在这里',
            loading: false
          })
        }
        this.setData(patch)
      })
      .catch(err => {
        if (seq !== this._seqActive) return
        console.warn('[my-booking] /api/applyList(state=' + STATE_ACTIVE + ') 失败：', err)
        const patch = { countActive: 0 }
        if (this.data.tab === 'active') {
          Object.assign(patch, {
            list: [],
            emptyText: '加载失败，请稍后重试',
            loading: false
          })
        }
        this.setData(patch)
      })
  },

  // 「历史」标签：仅从 /api/applyList (state=2) 拉取数据渲染
  _loadHistory() {
    const seq = ++this._seqHistory
    if (this.data.tab === 'history') {
      this.setData({ loading: true, emptyText: '正在加载历史预约…' })
    }
    getApplyList(STATE_HISTORY)
      .then(items => {
        if (seq !== this._seqHistory) return
        const apiItems = (items || []).map(mapApplyListItem).filter(Boolean).map(decorateItem)
        const patch = { countHistory: apiItems.length }
        if (this.data.tab === 'history') {
          Object.assign(patch, {
            list: apiItems,
            emptyText: apiItems.length ? '' : '暂无历史预约记录\n取消或已完成的预约会显示在这里',
            loading: false
          })
        }
        this.setData(patch)
      })
      .catch(err => {
        if (seq !== this._seqHistory) return
        console.warn('[my-booking] /api/applyList(state=' + STATE_HISTORY + ') 失败：', err)
        const patch = { countHistory: 0 }
        if (this.data.tab === 'history') {
          Object.assign(patch, {
            list: [],
            emptyText: '加载失败，请稍后重试',
            loading: false
          })
        }
        this.setData(patch)
      })
  },

  // 点击仪器图标 + 名称 → 仪器详情页（catchtap 已阻止冒泡到卡片 onDetail）
  // 流程与 components/instrument 一致：/api/deviceApply 取数 → 写 DEVICE_APPLY_KEY → 跳转仪器详情
  onGoInstDetail(e) {
    const id = e.currentTarget.dataset.id
    if (id == null || String(id).trim() === '') return
    console.log('[my-booking] onGoInstDetail 触发，deviceId =', id)
    // 防重复点击：上一次请求进行中时忽略
    if (this._insting) return
    this._insting = true
    wx.showLoading({ title: '正在加载仪器详情…', mask: true })
    getDeviceApply(id)
      .then(data => {
        try { wx.setStorageSync(DEVICE_APPLY_KEY, { deviceId: String(id), data, ts: Date.now() }) } catch (e) { /* 忽略缓存异常 */ }
        wx.navigateTo({
          url: '/pages/instrument-detail/index?id=' + id,
          complete: () => wx.hideLoading()
        })
      })
      .catch(err => {
        wx.hideLoading()
        wx.showModal({
          title: '加载失败',
          content: (err && err.message) || '仪器数据获取失败，请稍后重试。',
          showCancel: false,
          confirmColor: '#0A7BB8'
        })
      })
      .then(() => { this._insting = false })
  },

  onDetail(e) {
    // 跳转预约详情：优先调 /api/deviceApplyDetail 拿到完整数据写入 BOOKING_DETAIL_KEY，
    // 接口失败时不再弹错阻断，而是继续跳详情页、由详情页用本地 listBookings() 兜底渲染。
    // 原因：本地预约号为 'MB...' 本地生成，后端若未落地对应记录时该接口会 404 / 报错；
    //       此时仍应进入详情页，至少能把仪器 / 时间 / 方式 / 费用 / 测试信息 memos 等基本信息展示出来。
    const id = e.currentTarget.dataset.id
    if (!id) return
    const MIN_LOADING_MS = 400 // 接口通常 200ms~ 内返回，loading 不必再拖到 600ms，体感更顺畅
    const t0 = Date.now()
    const done = () => {
      const left = MIN_LOADING_MS - (Date.now() - t0)
      setTimeout(() => wx.hideLoading(), left > 0 ? left : 0)
    }
    const gotoDetail = (withLocal) => {
      const url = '/pages/booking-detail/index?id=' + encodeURIComponent(id) +
        (withLocal ? '&local=1' : '')
      wx.navigateTo({ url, complete: done })
    }
    wx.showLoading({ title: '正在加载预约详情…', mask: true })
    // 设个 5 秒超时硬墙：超时也走 fallback，避免后端久不响应时卡死在 loading
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      console.warn('[my-booking] /api/deviceApplyDetail 超时，走本地兜底')
      gotoDetail(true)
    }, 5000)
    getDeviceApplyDetail(id)
      .then(data => {
        clearTimeout(timer)
        if (timedOut) return
        try { wx.setStorageSync(BOOKING_DETAIL_KEY, { id, data, ts: Date.now() }) } catch (e) { /* 忽略缓存异常 */ }
        gotoDetail(false)
      })
      .catch(err => {
        clearTimeout(timer)
        if (timedOut) return
        // 不再弹「加载失败」——仅 console 记录 + 走本地兜底渲染
        console.warn('[my-booking] /api/deviceApplyDetail 失败，使用本地预约数据兜底：', err)
        gotoDetail(true)
      })
  },

  onCancel(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const it = this.data.list.find(x => x.id === id)
    const instName = it ? it.instName : '该预约'
    const rangeText = it ? (it.rangeText || (it.dateLabel + ' ' + it.startText + ' - ' + it.endText)) : ''
    wx.showModal({
      title: '取消预约',
      content: '确定取消「' + instName + '」' + rangeText + ' 的预约吗？',
      cancelText: '再想想',
      confirmText: '确认取消',
      confirmColor: '#BA1A1A',
      success: res => {
        if (!res.confirm) return
        // 提交取消预约 → POST /api/deviceApplyCancel { id, token }
        wx.showLoading({ title: '正在取消预约…', mask: true })
        deviceApplyCancel(id)
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已取消预约', icon: 'success' })
            // 取消成功：跳到「历史」tab，刚取消的记录会作为历史预约展示
            // 已在「历史」tab 时只重拉当前 tab；其它情况切换并触发 _loadHistory
            if (this.data.tab !== 'history') {
              this.setData({ tab: 'history', list: [], emptyText: '正在加载历史预约…', loading: true })
              this._loadHistory()
            } else {
              this.reload()
            }
          })
          .catch(err => {
            wx.hideLoading()
            console.warn('[my-booking] /api/deviceApplyCancel 失败：', err)
            wx.showToast({
              title: (err && err.message) ? err.message : '取消预约失败，请稍后重试',
              icon: 'none',
              duration: 2200
            })
          })
      }
    })
  },

  // 仪器扫码：扫码得到 deviceId → 查询设备详情 → 进入扫码详情页（与首页「仪器扫码」功能一致）
  onScan() {
    wx.scanCode({
      scanType: ['qrCode'],
      onlyFromCamera: false,
      success: res => {
        const deviceId = (res.result || '').trim()
        if (!deviceId) return
        this._openDeviceDetail(deviceId)
      }
    })
  },

  // 扫码 → 详情页的统一过渡：loading 覆盖「查询中 → 跳转完成」，失败/成功均收敛
  _openDeviceDetail(deviceId) {
    const MIN_LOADING_MS = 600 // loading 最小可见时长，防止接口秒回时无感知
    const t0 = Date.now()
    const done = () => {
      const left = MIN_LOADING_MS - (Date.now() - t0)
      setTimeout(() => wx.hideLoading(), left > 0 ? left : 0)
    }
    wx.showLoading({ title: '正在查询设备详情…', mask: true })
    getDeviceDetail(deviceId)
      .then(data => {
        try { wx.setStorageSync(SCAN_DETAIL_KEY, { deviceId, data, ts: Date.now() }) } catch (e) { /* 忽略缓存异常 */ }
        // 跳转完成后再收起 loading，由详情页自身内容（或页内 loading）无缝衔接
        wx.navigateTo({
          url: '/pages/scan-detail/index?deviceId=' + encodeURIComponent(deviceId),
          complete: done
        })
      })
      .catch(() => {
        done()
        wx.showModal({
          title: '查询失败',
          content: '未获取到设备详情，请确认后端服务已启动且该二维码为本平台设备编码。',
          showCancel: false,
          confirmColor: '#0A7BB8'
        })
      })
  },

  // 空态去预约：回到容器页并切到仪器 Tab
  goBrowse() {
    wx.reLaunch({ url: '/pages/index/index?page=instrument' })
  },

  // 待审核预约的扫码按钮占位：catchtap 阻止冒泡到卡片的 onDetail，避免误跳详情页
  onScanDisabled() {
    // noop：置灰状态下点击不响应
  }
})
