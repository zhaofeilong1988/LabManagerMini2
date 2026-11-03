// utils/device.js
// 设备状态（开机/关机）接口模拟：查询与开机均带网络延迟，状态持久化到本地缓存
// 说明：演示阶段无后端，这里用 storage 模拟“设备接口”；
//       接入真实系统后，把 queryDevice / powerOnDevice 里的实现替换为 wx.request 即可。
const KEY = 'lab_device_states'

// 各设备首次查询时的默认状态（key 为设备编号，即固定资产编号）
const DEFAULT_STATES = {
  'SB-2019-00102': { poweredOn: false, powerOnTime: '' },       // 共聚焦 FV3000（演示：未开机）
  'SB-2021-00877': { poweredOn: true, powerOnTime: '2026-09-04 08:30' }, // 流式 CytoFLEX（演示：已开机）
  'SB-2018-00115': { poweredOn: false, powerOnTime: '' },       // 透射电镜 Tecnai（演示：未开机）
  'SB-2022-01560': { poweredOn: false, powerOnTime: '' }        // 激光共聚焦 LSM900（演示：未开机）
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function nowText() {
  const t = new Date()
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) +
    ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes())
}

function loadMap() {
  try {
    const m = wx.getStorageSync(KEY)
    if (m && typeof m === 'object') return m
  } catch (e) { /* 忽略读取异常 */ }
  return {}
}

function saveMap(map) {
  try {
    wx.setStorageSync(KEY, map)
  } catch (e) { /* 存储失败时忽略 */ }
}

// 查询设备状态（模拟接口，约 300ms 返回）
function queryDevice(no) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const st = loadMap()[no] || DEFAULT_STATES[no] || { poweredOn: false, powerOnTime: '' }
        resolve({ poweredOn: !!st.poweredOn, powerOnTime: st.powerOnTime || '' })
      } catch (e) {
        reject(e)
      }
    }, 300)
  })
}

// 开机（模拟接口，约 500ms 返回成功后状态）
function powerOnDevice(no) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const time = nowText()
        const map = loadMap()
        map[no] = { poweredOn: true, powerOnTime: time }
        saveMap(map)
        resolve({ poweredOn: true, powerOnTime: time })
      } catch (e) {
        reject(e)
      }
    }, 500)
  })
}

// 关机（模拟接口，约 500ms 返回成功后状态）
function powerOffDevice(no) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const map = loadMap()
        map[no] = { poweredOn: false, powerOnTime: '' }
        saveMap(map)
        resolve({ poweredOn: false, powerOnTime: '' })
      } catch (e) {
        reject(e)
      }
    }, 500)
  })
}

module.exports = {
  queryDevice,
  powerOnDevice,
  powerOffDevice
}
