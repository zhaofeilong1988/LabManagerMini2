// pages/scan-device/index.js
// 扫描设备页：扫码识别设备编号后进入，展示设备信息与开机状态
// 未开机时提供「开机」按钮，点击调用设备接口后状态刷新为已开机
const { findInstrumentByNo } = require('../../utils/instruments.js')
const { listBookings } = require('../../utils/bookings.js')
const { queryDevice, powerOnDevice } = require('../../utils/device.js')

// 该设备最近一次预约（未取消）的时段文案
function latestBookingText(instId) {
  const hit = listBookings()
    .filter(b => b.instId === instId && b.status !== 'cancelled')
    .sort((a, b) =>
      (b.dateLabel + ' ' + (b.startText || '')).localeCompare(a.dateLabel + ' ' + (a.startText || ''))
    )[0]
  if (!hit) return '暂无预约记录'
  return hit.rangeText || (hit.dateLabel + ' ' + hit.startText + ' - ' + hit.endText)
}

Page({
  data: {
    loading: true,
    powering: false,
    device: null
  },

  onLoad(options) {
    const no = String((options && options.no) || '').trim()
    const detail = findInstrumentByNo(no)
    if (!no || !detail) {
      wx.showToast({ title: '未找到对应设备', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 900)
      return
    }
    this.detail = detail
    queryDevice(no).then(state => {
      this.setData({
        loading: false,
        device: {
          id: detail.id,
          icon: detail.icon,
          name: detail.name,
          lab: detail.lab,
          manager: detail.manager,
          bookText: detail.needBook ? '需要预约' : '无需预约',
          lastBookText: latestBookingText(detail.id),
          controlText: detail.control || '--',
          deviceNo: no,
          poweredOn: state.poweredOn,
          powerOnTime: state.powerOnTime || ''
        }
      })
    })
  },

  // 开机：调用设备接口成功后刷新为已开机状态
  onPowerOn() {
    if (this.data.powering) return
    this.setData({ powering: true })
    wx.showLoading({ title: '正在开机…', mask: true })
    powerOnDevice(this.data.device.deviceNo)
      .then(state => {
        wx.hideLoading()
        wx.showToast({ title: '开机成功', icon: 'success' })
        this.setData({
          powering: false,
          'device.poweredOn': state.poweredOn,
          'device.powerOnTime': state.powerOnTime
        })
      })
      .catch(() => {
        wx.hideLoading()
        this.setData({ powering: false })
        wx.showToast({ title: '开机失败，请重试', icon: 'none' })
      })
  },

  goBack() {
    wx.navigateBack()
  }
})
