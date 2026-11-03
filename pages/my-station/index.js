// pages/my-station/index.js —— 我的工位列表页
// 入口：我的页「我的工位」菜单项
// 数据：本地暂存的实验台申请记录（pages/workbench 提交后写入 workbenchApplies）
//      后端工位接口提供后，将 _loadRecords 替换为 API 拉取即可
// 交互：点击卡片 / 扫码打卡成功 → 进入实验台合并页（pages/workbench?id=xxx）
Page({
  data: {
    records: []      // 申请记录卡片渲染数据
  },

  onShow() {
    // 每次进入页面刷新（从合并页返回时立即看到最新状态）
    this._loadRecords()
  },

  // 读取本地申请记录 → 渲染结构
  _loadRecords() {
    let list = []
    try {
      list = wx.getStorageSync('workbenchApplies') || []
    } catch (e) {
      console.warn('[my-station] 读取工位申请记录失败：', e)
    }
    // 规范化：为缺失 id 的旧记录补一个稳定 id（并回写存储），保证打卡等操作能精确定位
    let dirty = false
    list = (Array.isArray(list) ? list : []).map((r, i) => {
      if (!r || typeof r !== 'object') return r
      if (r.id === undefined || r.id === null) {
        r.id = 'wb_' + Date.now() + '_' + i
        dirty = true
      }
      return r
    })
    if (dirty) {
      try { wx.setStorageSync('workbenchApplies', list) } catch (e) { /* 忽略缓存异常 */ }
    }
    const STATUS = {
      pending:  { text: '审核中', cls: 'reviewing' },
      approved: { text: '已通过', cls: 'passed' },
      rejected: { text: '已驳回', cls: 'rejected' }
    }
    const records = list.map((r) => {
      const st = STATUS[r && r.status] || STATUS.pending
      return {
        id: (r && r.id !== undefined) ? r.id : '',
        group: (r && r.group) || '--',
        startDate: (r && r.startDate) || '',
        endDate: (r && r.endDate) || '',
        submitTime: (r && r.submitTime) || '',
        statusText: st.text,
        statusCls: st.cls
      }
    })
    this.setData({ records })
  },

  // 点击申请记录卡片 → 实验台合并页（自动按状态渲染对应视图）
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (id == null || String(id).trim() === '') return
    wx.navigateTo({ url: '/pages/workbench/index?id=' + id })
  },

  // ── 扫码打卡（仅审核通过的工位显示入口） ──
  // 扫码成功 → 记录打卡 → toast「打卡成功」→ 跳转到该工位的合并页（自动展示 checkin 视图）
  scanCheckIn(e) {
    const id = e.currentTarget.dataset.id
    wx.scanCode({
      scanType: ['qrCode'],
      onlyFromCamera: false,
      success: (res) => {
        const code = (res.result || '').trim()
        if (!code) return
        const now = new Date()
        const p = (n) => String(n).padStart(2, '0')
        const checkInTime = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`
        let list = []
        try {
          list = wx.getStorageSync('workbenchApplies') || []
        } catch (err) { /* 忽略缓存异常 */ }
        const entry = { time: checkInTime, code }
        list = (Array.isArray(list) ? list : []).map((r) =>
          (r && String(r.id) === String(id))
            ? Object.assign({}, r, {
                checkInTime,
                checkIns: [entry, ...((r && Array.isArray(r.checkIns)) ? r.checkIns : [])]
              })
            : r
        )
        try { wx.setStorageSync('workbenchApplies', list) } catch (err) { /* 忽略缓存异常 */ }
        wx.showToast({ title: '打卡成功', icon: 'success' })
        setTimeout(() => {
          wx.navigateTo({ url: '/pages/workbench/index?id=' + id })
        }, 600)
      }
    })
  },

  // 去申请实验台 → 实验台合并页（无记录 → 申请表单单）
  goApply() {
    wx.navigateTo({ url: '/pages/workbench/index' })
  }
})
