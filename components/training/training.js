// components/training/training.js
const CERTIFICATES = require('../../utils/certificates.js').list

Component({
  data: {
    safetyTraining: {
      status: 'ongoing',   // none | ongoing | passed
      statusText: '进行中',
      progress: 60,
      score: null
    },
    // 证书数据与证书详情页共享（utils/certificates.js）
    certificates: CERTIFICATES,
    // 模块概览：已完成 / 进行中 / 可报名（数量随数据变化实时刷新）
    overview: [
      { key: 'done', label: '已完成', num: 0 },
      { key: 'doing', label: '进行中', num: 0 },
      { key: 'open', label: '可报名', num: 0 }
    ],
    activeFilter: 'all',
    allTrainings: [
      {
        id: 1, title: '流式细胞仪专项培训',
        instrument: 'BD FACSCanto II',
        category: 'special', categoryText: '专项培训',
        status: 'open', statusText: '可报名',
        date: '2026-06-20 14:00', enrolled: 6, capacity: 10
      },
      {
        id: 2, title: '激光共聚焦显微镜操作',
        instrument: 'Zeiss LSM 900',
        category: 'plan', categoryText: '计划培训',
        status: 'enrolled', statusText: '已报名',
        date: '2026-06-25 09:00', enrolled: 8, capacity: 8
      },
      {
        id: 3, title: '透射电子显微镜培训',
        instrument: 'FEI Tecnai G2',
        category: 'special', categoryText: '专项培训',
        status: 'full', statusText: '名额已满',
        date: '2026-07-05 10:00', enrolled: 12, capacity: 12
      },
      {
        id: 4, title: '实验室安全规范培训',
        instrument: '全平台通用',
        category: 'safety', categoryText: '安全培训',
        status: 'ended', statusText: '已结束',
        date: '2026-05-01 09:00', enrolled: 30, capacity: 30
      },
      {
        id: 5, title: '安全培训',
        instrument: '实验室安全规范 · 全平台通用',
        category: 'safety', categoryText: '安全培训',
        status: 'open', statusText: '可报名',
        date: '2026-09-10 14:00', enrolled: 21, capacity: 50, unlimited: true
      }
    ],
    filteredTrainings: []
  },

  lifetimes: {
    attached() {
      this._syncEnrolled()
      this.filterTrainings('all')
      this._refreshOverview()
    }
  },

  methods: {
    // 从本地存储同步「安全培训」报名状态（报名成功后跨页保留）
    _syncEnrolled() {
      if (!wx.getStorageSync('safetyTrainingEnrolled')) return
      const all = this.data.allTrainings.map(t =>
        t.id === 5 && t.status !== 'enrolled'
          ? { ...t, status: 'enrolled', statusText: '已报名' }
          : t
      )
      this.setData({ allTrainings: all })
    },

    // 刷新模块概览统计：
    // 已完成 = 已获得证书的培训模块数；进行中 = 已报名场次 + 安全培训学习进度未完成；
    // 可报名 = 当前开放报名的培训场次数
    _refreshOverview() {
      const all = this.data.allTrainings
      const doing =
        all.filter(t => t.status === 'enrolled').length +
        (this.data.safetyTraining.status === 'ongoing' ? 1 : 0)
      const open = all.filter(t => t.status === 'open').length
      this.setData({
        overview: [
          { key: 'done', label: '已完成', num: this.data.certificates.length },
          { key: 'doing', label: '进行中', num: doing },
          { key: 'open', label: '可报名', num: open }
        ]
      })
    },

    setFilter(e) {
      const val = e.currentTarget.dataset.val
      this.setData({ activeFilter: val })
      this.filterTrainings(val)
    },

    filterTrainings(filter) {
      const all = this.data.allTrainings
      let result
      if (filter === 'open') {
        result = all.filter(t => t.status === 'open')
      } else if (filter === 'mine') {
        result = all.filter(t => t.status === 'enrolled')
      } else {
        result = all
      }
      // 安全培训置顶展示（列表第一位），专项培训 / 计划培训等其余培训顺序保持不变
      const safetyAhead = result.filter(t => t.category === 'safety' && t.status !== 'ended')
      const others = result.filter(t => !(t.category === 'safety' && t.status !== 'ended'))
      this.setData({ filteredTrainings: safetyAhead.concat(others) })
    },

    goCertificates() {
      wx.showToast({ title: '我的证书', icon: 'none' })
    },

    // 点击证书 → 证书详情页
    viewCert(e) {
      const id = e.currentTarget.dataset.id
      wx.navigateTo({ url: '/pages/training/cert-detail/cert-detail?id=' + id })
    },

    goTrainingDetail(e) {
      const id = e.currentTarget.dataset.id
      wx.navigateTo({ url: '/pages/training/detail/detail?id=' + id })
    },

    enrollTraining(e) {
      const id = e.currentTarget.dataset.id
      wx.showModal({
        title: '确认报名',
        content: '报名后请准时参加培训，如需取消请提前联系管理员',
        confirmText: '确认报名',
        confirmColor: '#33ADDE',
        success: (res) => {
          if (res.confirm) {
            const all = this.data.allTrainings.map(t => {
              if (t.id === id) return { ...t, status: 'enrolled', statusText: '已报名', enrolled: t.enrolled + 1 }
              return t
            })
            this.setData({ allTrainings: all })
            this.filterTrainings(this.data.activeFilter)
            this._refreshOverview()
            if (id === 5) wx.setStorageSync('safetyTrainingEnrolled', true)
            wx.showToast({ title: '报名成功', icon: 'success' })
          }
        }
      })
    },

    cancelEnroll(e) {
      wx.showToast({ title: '如需取消请联系管理员', icon: 'none' })
    }
  }
})
