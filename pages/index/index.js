// index.js
Page({
  data: {
    page: 'home'   // 默认显示首页
  },

  toolbarClick(e) {
    const target = e.currentTarget.dataset.page
    if (target !== this.data.page) {
      this.setData({ page: target })
    }
  },

  // 接收 home component 内部发出的 tab 切换事件
  onSwitchTab(e) {
    const target = e.detail.page
    if (target !== this.data.page) {
      this.setData({ page: target })
    }
  }
})
