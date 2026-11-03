// pages/onboarding/result/result.js
Page({
  data: {
    type: 'exam',   // exam | admission
    status: 'done', // done 已出分 | grading 判卷中（含简答题）
    passed: true,
    score: 80,
    correct: 4,
    total: 5
  },

  onLoad(options) {
    const type = options.type || 'exam'
    const status = options.status || 'done'
    if (type === 'exam') {
      if (status === 'grading') {
        // 含简答题：交卷后仅展示「判卷中」，不出分
        const total = parseInt(options.total || '0', 10)
        this.setData({ type, status, total })
      } else {
        const score = parseInt(options.score || '0', 10)
        const correct = parseInt(options.correct || '0', 10)
        const total = parseInt(options.total || '5', 10)
        this.setData({ type, status, passed: score >= 60, score, correct, total })
      }
    } else {
      this.setData({ type })
    }
  },

  // 判卷中：返回准入总览，等待人工批阅出分
  backToOnboarding() {
    wx.navigateBack({
      fail: () => wx.navigateTo({ url: '/pages/onboarding/index/index' })
    })
  },

  // 重新考试：先回到安全培训详情页完成学习后再参加
  retakeExam() {
    wx.redirectTo({ url: '/pages/training/detail/detail?id=5&from=admission' })
  },

  // 考试通过 → 返回准入总览第 2 步「材料提交」，由用户在总览页提交审核
  backToHub() {
    wx.setStorageSync('admissionStep', 1)
    wx.showToast({ title: '考试已通过', icon: 'success' })
    setTimeout(() => {
      wx.navigateBack({
        fail: () => wx.navigateTo({ url: '/pages/onboarding/index/index' })
      })
    }, 400)
  },

  // 返回首页（无 tabBar，用 reLaunch 回到首页）
  goHome() {
    wx.setStorageSync('admissionStep', 3)
    wx.reLaunch({ url: '/pages/index/index' })
  }
})
