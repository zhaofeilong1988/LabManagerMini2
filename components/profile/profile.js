
Component({
  data: {
    userInfo: {
      name: '张三',
      dept: '实验研究中心',
      role: '院内用户',
    },
    admissionStep: 3, // 当前步骤 1-4
  },

  methods: {
    goToAdmission() {
      wx.showToast({ title: '平台准入申请', icon: 'none' });
    },
    goToMyApplications() {
      wx.showToast({ title: '我的申请记录', icon: 'none' });
    },
    goToPermission() {
      wx.showToast({ title: '我的权限身份', icon: 'none' });
    },
    goToMyBookings() {
      wx.showToast({ title: '我的预约', icon: 'none' });
    },
    goToUsageRecord() {
      wx.showToast({ title: '使用记录与费用', icon: 'none' });
    },
    goToSettings() {
      wx.showToast({ title: '设置', icon: 'none' });
    },
    goToHelp() {
      wx.showToast({ title: '帮助与反馈', icon: 'none' });
    },
    goToNewAdmission() {
      wx.showToast({ title: '新版准入申请', icon: 'none' });
    },
    goToApprovalDemo() {
      wx.showToast({ title: '审批入口（演示）', icon: 'none' });
    },
    viewProgress() {
      wx.showToast({ title: '查看详情', icon: 'none' });
    },
  },
});
