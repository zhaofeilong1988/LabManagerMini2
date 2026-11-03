// pages/training/cert-detail/cert-detail.js
const { findCert } = require('../../../utils/certificates.js')

Page({
  data: {
    cert: null,
    // 演示用户，与「我的」页保持一致；接入真实账号体系后可改为读取用户资料
    holderName: '张三'
  },

  onLoad(options) {
    const cert = findCert(options && options.id)
    if (!cert) {
      wx.showToast({ title: '未找到该证书', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 900)
      return
    }
    this.setData({ cert })
    wx.setNavigationBarTitle({ title: cert.name + ' 证书' })
  }
})
