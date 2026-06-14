// components/home/home.js
Component({
  properties: {},

  data: {
    userInfo: {
      name: '张三',
      group: '李教授 · 神经生物学组',
      initial: '张'
    },
    notice: '本周六将进行主要楼层停电检修，请提前安排实验计划',
    dutyStatus: {
      done: false,
      scheduleSet: false
    },
    appointments: [
      {
        id: 1,
        name: '共聚焦显微镜 FV3000',
        date: '2024-03-15',
        timeSlot: '09:00 - 12:00',
        status: 'confirmed',
        statusText: '已确认'
      },
      {
        id: 2,
        name: '流式细胞仪 CytoFLEX',
        date: '2024-03-18',
        timeSlot: '14:00 - 17:00',
        status: 'pending',
        statusText: '待审核'
      }
    ],
    trainings: [
      { id: 1, name: '流式细胞仪操作培训', done: 3, total: 5 },
      { id: 2, name: '共聚焦显微镜操作培训', done: 1, total: 4 }
    ]
  },

  methods: {
    goToDuty() {
      wx.navigateTo({ url: '/pages/duty/duty' });
    },
    goToDutyAdmin() {
      wx.navigateTo({ url: '/pages/duty/duty?admin=1' });
    },
    goToScan() {
      wx.navigateTo({ url: '/pages/scan/scan' });
    },
    goToInstrument() {
      this.triggerEvent('switchTab', { page: 'instrument' });
    },
    goToTraining() {
      this.triggerEvent('switchTab', { page: 'training' });
    },
    goToWorkbench() {
      wx.navigateTo({ url: '/pages/workbench/workbench' });
    },
    goToRepair() {
      wx.navigateTo({ url: '/pages/repair/repair' });
    },
    goToApproval() {
      wx.navigateTo({ url: '/pages/approval/approval' });
    },
    goToMentor() {
      wx.navigateTo({ url: '/pages/mentor/mentor' });
    }
  }
});
