// components/training/training.js
Component({
  data: {
    safetyTraining: {
      status: 'ongoing',   // none | ongoing | passed
      statusText: '进行中',
      progress: 60,
      score: null
    },
    certificates: [
      { id: 1, name: '安全培训', date: '2026-03-15', type: 'basic' },
      { id: 2, name: '流式细胞仪', date: '2026-04-20', type: 'special' },
      { id: 3, name: '激光共聚焦', date: '2026-05-10', type: 'special' }
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
      }
    ],
    filteredTrainings: []
  },

  lifetimes: {
    attached() {
      this.filterTrainings('all')
    }
  },

  methods: {
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
      this.setData({ filteredTrainings: result })
    },

    goSafetyTraining() {
      const s = this.data.safetyTraining.status
      if (s === 'passed') {
        wx.navigateTo({ url: '/pages/training/certificates/index' })
      } else {
        wx.navigateTo({ url: '/pages/training/detail/index?id=safety' })
      }
    },

    goCertificates() {
      wx.navigateTo({ url: '/pages/training/certificates/index' })
    },

    viewCert(e) {
      wx.navigateTo({ url: `/pages/training/certificates/index?id=${e.currentTarget.dataset.id}` })
    },

    goTrainingDetail(e) {
      wx.navigateTo({ url: `/pages/training/detail/index?id=${e.currentTarget.dataset.id}` })
    },

    enrollTraining(e) {
      const id = e.currentTarget.dataset.id
      wx.showModal({
        title: '确认报名',
        content: '报名后请准时参加培训，如需取消请提前联系管理员',
        confirmText: '确认报名',
        confirmColor: '#03A9F4',
        success: (res) => {
          if (res.confirm) {
            const all = this.data.allTrainings.map(t => {
              if (t.id === id) return { ...t, status: 'enrolled', statusText: '已报名', enrolled: t.enrolled + 1 }
              return t
            })
            this.setData({ allTrainings: all })
            this.filterTrainings(this.data.activeFilter)
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
