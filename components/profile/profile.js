

// components/profile/profile.js
const { clearLogin, getLoginUser, setPassword, getOpenId } = require('../../utils/auth.js')
// getApplyUserDetailShared：带跨页缓存 + 并发去重的 detail 请求。
// 点击「我的」tab 时，index 页也会为刷新 token 调一次 detail；两边共用同一个在途 Promise，
// 保证一次点击只发一个请求（状态变更时先 clearApplyUserDetailCache 再拉，避免读到旧值）。
// changePassword：POST /api/changePassword（token + password），修改 web 端登录密码
const { getApplyUserDetailShared, clearApplyUserDetailCache, changePassword } = require('../../utils/api.js')
// 准入 state（/system/apply_user/detail → applyUser.state）→ 进度条步骤 / 总览页节点
// 与首页准入横幅、准入总览页共用同一份映射，避免同一 state 在不同入口落点不一致
const { stateToStep, stateToNode, pickState } = require('../../utils/admissionState.js')

// 调试标记：打开「我的」tab 时 Console 必须出现这行；若没有，说明运行的是旧代码
console.log('[profile] profile.js 模块已加载（v3 事件刷新版）')

// 进度条步骤（1-4）与申请页节点（0-3）一一对应，映射见 utils/admissionState.js：
//   1 申请登记 / 2 材料提交 / 3 审批审核 / 4 准入完成
const STATUS_TEXT = {
  1: '尚未提交准入申请，请先完成申请登记',
  2: '材料提交中：请上传审批文件并完成安全考试',
  3: '审批文件审核中，预计1-3个工作日',
  4: '已完成平台准入，可预约仪器与工位'
}
// 头像占位文字：中文取姓名首字，英文取首字母大写；无姓名时兜底「用」
function avatarTextOf(name) {
  const s = String(name || '').trim()
  if (!s) return '用'
  return s.slice(0, 1).toUpperCase()
}

const BADGE = {
  1: { text: '未开始', cls: 'reviewing' },
  2: { text: '材料提交', cls: 'reviewing' },
  3: { text: '审核中', cls: 'reviewing' },
  4: { text: '已准入', cls: 'passed' }
}

// 特殊状态（已取消/已驳回）专属状态文案，覆盖 STATUS_TEXT[step] 的默认文案
const STATE_STATUS_TEXT = {
  '1': '准入申请已取消，如需使用平台请重新登记申请',
  '3': '准入申请已被驳回，如需使用平台请重新登记申请'
}

// 根据当前步骤（1-4）生成进度条渲染数据（与申请页节点状态保持一致：之前的步骤 done，当前 active，之后 gray）
function buildSteps(step) {
  const labels = ['申请登记', '材料提交', '审批审核', '准入完成']
  return labels.map((label, i) => {
    const idx = i + 1
    // 到达第 4 步（准入完成）时，最后一项与前面已完成项样式一致
    const st = (idx < step || step >= 4) ? 'done' : idx === step ? 'active' : 'gray'
    const line = st === 'done' ? 'done-line' : st === 'active' ? 'active-line' : 'gray-line'
    return {
      label,
      num: idx,
      status: st,
      // 已完成的节点显示对号；第 4 步到达时状态即为 done，同样显示对号，未到达时显示数字
      showCheck: st === 'done',
      circleCls: st === 'done' ? 'done-circle' : st === 'active' ? 'active-circle' : 'gray-circle',
      numCls: st === 'gray' ? 'gray-num' : '',
      labelCls: st === 'active' ? 'active-label' : st === 'gray' ? 'gray-label' : '',
      lineCls: line
    }
  })
}

Component({
  data: {
    userInfo: {
      name: '张三',
      dept: '实验研究中心',
      role: '院内用户',
      phone: '',
      // 登录名：来自 /system/apply_user/detail 返回的 user.loginName（user 为空时不展示）
      loginName: '',
      // 账户余额：来自同一份响应里的 user.amount，取不到时用演示值
      amount: '1200.00',
      // 头像：优先用 avatarUrl 图片，取不到时用姓名首字占位
      avatarUrl: '',
      avatarText: avatarTextOf('张三'),
    },
    // 准入进度（1-4），来源 /system/apply_user/detail 的 applyUser.state；默认第 1 步
    admissionStep: 1,
    // 后端原始 state（null = 无申请记录/未查询），点击准入入口时按它定位总览页节点
    admissionState: null,
    pSteps: buildSteps(1),
    statusText: STATUS_TEXT[1],
    statusDone: false,          // true 时状态点为绿色（已准入）
    admissionBadge: BADGE[1],
    // 修改密码弹窗（只保留一个输入框：web 端登录密码）
    showPwdModal: false,
    newPwd: '',
    pwdSubmitting: false,
    // 账户余额可见性：默认闭眼，睁开后才展示金额
    amountVisible: false,
  },

  lifetimes: {
    attached() {
      // 展示当前登录手机号（无手机号则不显示）；若登录态里带了头像/昵称也一并同步
      const u = getLoginUser()
      if (u) {
        const patch = {}
        if (u.phone) patch['userInfo.phone'] = u.phone
        if (u.avatarUrl) patch['userInfo.avatarUrl'] = u.avatarUrl
        const nick = String(u.name || u.nickName || '').trim()
        if (nick) {
          patch['userInfo.name'] = nick
          patch['userInfo.avatarText'] = avatarTextOf(nick)
        }
        if (Object.keys(patch).length) this.setData(patch)
      }
      // 订阅准入状态变更事件：提交审核成功等场景由变更方主动通知，
      // 不再单纯依赖 pageLifetimes.show（自定义 tab 架构下不可靠）
      // 先丢弃 detail 跨页缓存再拉，避免读到变更前的 state
      this._onAdmissionChanged = () => {
        clearApplyUserDetailCache()
        // 状态变更需强制刷新，跳过 5 秒时间锁
        this._loadAccessState(true)
      }
      getApp().on('admission:changed', this._onAdmissionChanged)
      this._loadAccessState()
    },
    detached() {
      // 组件销毁（切走 tab）时取消订阅，避免重复回调
      if (this._onAdmissionChanged) {
        getApp().off('admission:changed', this._onAdmissionChanged)
        this._onAdmissionChanged = null
      }
    }
  },

  pageLifetimes: {
    show() {
      // 从准入流程返回时刷新进度（与首页行为一致）
      this._loadAccessState()
    }
  },

  methods: {
    // 页面层兜底刷新入口（index 页 onShow 时调用）：
    // 自定义 tab 架构下 pageLifetimes.show 不稳定触发，由页面显式调用
    onPageRefresh() {
      this._loadAccessState()
    },

    // 拉取准入状态：GET /system/apply_user/detail?openId={openId}
    // 以 applyUser.state 定位进度节点（与首页横幅 / 准入总览页共用 utils/admissionState.js 的映射），
    // 该接口同时返回姓名 / 部门 / 身份，一次请求即可刷新 Header，不再依赖 /system/apply_user/access。
    // 无 openId / 接口失败 → 按第 1 步展示，不阻塞页面
    _loadAccessState(force) {
      const openId = getOpenId()
      const now = Date.now()
      // 防重复：上一次请求仍在途时跳过
      if (this._accessLoading) return
      // 5 秒内对同一 openId 已刷新过，跳过；force=true（状态变更事件）时不跳过
      if (!force && this._lastAccessOpenId === openId && this._lastAccessAt && now - this._lastAccessAt < 5000) {
        console.log('[profile] 5s 内已刷新过准入状态，跳过')
        return
      }
      this._lastAccessOpenId = openId
      this._lastAccessAt = now
      this._accessLoading = true

      if (!openId) {
        this._accessLoading = false
        this._applyAccessState(null)
        return
      }
      getApplyUserDetailShared(openId)
        .then(({ applyUser, user }) => {
          const st = pickState(applyUser)
          console.log('[profile] detail 刷新：state =', st, '→ step', stateToStep(st))
          this._applyAccessState(st)
          // 同一份返回的 applyUser 直接刷新 Header（姓名 / 部门 / 身份），无需二次请求
          // user 内含登录名 loginName（可能为 null，_fillUserInfo 内部判空）
          this._fillUserInfo(applyUser, user)
        })
        .catch(err => {
          console.warn('[profile] 准入状态查询失败：', err)
          this._applyAccessState(null)
        })
        .then(() => { this._accessLoading = false })
    },

    // 用 /system/apply_user/detail 返回的 applyUser 刷新「我的」Header：姓名 / 部门 / 身份
    // user：同一份响应里的账号对象（内含 loginName 登录名），可能为空 → 取不到登录名时不覆盖已有值
    _fillUserInfo(applyUser, user) {
      if (!applyUser || typeof applyUser !== 'object') return
      const patch = {}
      // 登录名：user 对象非空才取 loginName；为空时保持原值，不在 Header 展示
      if (user && typeof user === 'object' && !Array.isArray(user)) {
        const loginName = String(user.loginName || user.login_name || '').trim()
        if (loginName) patch['userInfo.loginName'] = loginName
        // 账户余额：user.amount（兼容 balance / account），有值才覆盖默认演示值
        const raw = user.amount !== undefined && user.amount !== null ? user.amount
          : user.balance !== undefined && user.balance !== null ? user.balance
          : user.account
        if (raw !== undefined && raw !== null && raw !== '') patch['userInfo.amount'] = String(raw)
      }
      const name = String(applyUser.name || applyUser.userName || '').trim()
      if (name) {
        patch['userInfo.name'] = name
        // 姓名刷新后同步头像占位首字
        patch['userInfo.avatarText'] = avatarTextOf(name)
      }
      const avatar = String(applyUser.avatar || applyUser.avatarUrl || '').trim()
      if (avatar) patch['userInfo.avatarUrl'] = avatar
      const dept = String(applyUser.deptName || applyUser.dept_name || '').trim()
      const team = String(applyUser.teamName || applyUser.team_name || '').trim()
      if (dept || team) patch['userInfo.dept'] = dept || team
      // 身份：applyUser.type 1 = 院内用户，2 = 院外用户
      const t = applyUser.type
      if (t !== undefined && t !== null && t !== '') {
        const n = Number(t)
        if (n === 1) patch['userInfo.role'] = '院内用户'
        else if (n === 2) patch['userInfo.role'] = '院外用户'
      }
      if (Object.keys(patch).length) this.setData(patch)
    },

    // 准入 state → 进度渲染（与平台准入申请页节点一致）
    _applyAccessState(state) {
      const step = stateToStep(state)
      console.log('[profile] _applyAccessState：state =', state, '→ step =', step)
      this.setData({
        admissionState: (state === null || state === undefined) ? null : Number(state),
        admissionStep: step,
        pSteps: buildSteps(step),
        statusText: STATE_STATUS_TEXT[String(state)] || STATUS_TEXT[step],
        statusDone: step === 4,
        admissionBadge: BADGE[step]
      })
    },

    // ── 平台准入（跳转与首页横幅一致：按 state 定位节点）──
    //   节点 0（无记录 / 已取消 / 已驳回）→ 申请登记填写页
    //   节点 1 材料提交 / 节点 2 等待审核 / 节点 3 准入成功 → 总览页对应节点
    _goAdmissionEntry() {
      const node = stateToNode(this.data.admissionState)
      if (node === 0) {
        wx.navigateTo({ url: '/pages/onboarding/register/register' });
        return;
      }
      wx.navigateTo({ url: '/pages/onboarding/index/index?step=' + node });
    },
    goToOnboarding() {
      this._goAdmissionEntry();
    },
    goToAdmission() {
      this._goAdmissionEntry();
    },
    goToNewAdmission() {
      this._goAdmissionEntry();
    },
    viewProgress() {
      this._goAdmissionEntry();
    },

    // ── 审批入口（演示） ──
    goToApprovalDemo() {
      wx.navigateTo({ url: '/pages/approval/index' });
    },

    // ── 我的证书 → 证书列表页 ──
    // 不在本组件预请求 /system/cert_record/getList：列表页 onLoad 会统一拉取并落缓存，
    // 这里再拉一次会导致一次点击发两次请求（本组件一次 + 列表页一次）。
    goToMyCertificates() {
      const openId = getOpenId()
      if (!openId) {
        wx.showToast({ title: '请先登录', icon: 'none' })
        return
      }
      wx.navigateTo({ url: '/pages/my-certificates/index' })
    },
    goToMyBookings() {
      wx.navigateTo({ url: '/pages/my-booking/index' });
    },
    // 使用记录与费用页：与仪器详情页的「上机记录」共用同一个页 pages/instrument-logs
    // （不调接口，演示数据；不带 name 时每条显示各自的仪器）
    goToUsageRecord() {
      console.log('[profile] goToUsageRecord 点击，准备跳转 /pages/instrument-logs/index')
      wx.navigateTo({
        url: '/pages/instrument-logs/index',
        fail: err => console.error('[profile] 跳转 /pages/instrument-logs/index 失败：', err)
      });
    },
    // 直接进入实验台页（合并页）：根据本地存储里的最新记录状态自适应展示 apply / pending / approved 视图
    //   approved 视图里即包含扫码打卡卡 + 打卡记录列表
    goToMyStation() {
      wx.navigateTo({ url: '/pages/workbench/index' });
    },
    goToSettings() {
      wx.showToast({ title: '设置', icon: 'none' });
    },

    // ── 账户余额：睁眼 / 闭眼切换（默认闭眼）──
    onToggleAmount() {
      this.setData({ amountVisible: !this.data.amountVisible })
    },

    // ── 账户充值 / 月卡（参照 LabManagerMini/components/profile 的 charge / monthCard）──
    // 充值：原项目接 /api 订阅消息，此处按同一交互给出联系管理员的提示
    onRecharge() {
      wx.showModal({
        title: '提示',
        content: '请联系管理员进行充值！',
        showCancel: false,
        confirmText: '我知道了',
        confirmColor: '#0A7BB8'
      });
    },
    goToHelp() {
      wx.showToast({ title: '帮助与反馈', icon: 'none' });
    },

    // ── 修改密码（后台管理系统登录密码） ──
    noop() {},

    openPwdModal() {
      this.setData({
        showPwdModal: true,
        newPwd: '',
      });
    },
    closePwdModal() {
      if (this.data.pwdSubmitting) return;
      this.setData({ showPwdModal: false });
    },
    onNewPwdInput(e) {
      this.setData({ newPwd: e.detail.value });
    },
    // 提交：POST /api/changePassword，body { token, password }
    // 密码即在弹窗里填的这一个输入框（web 端登录密码），参数 token 由 api 层从全局 TOKEN 注入
    submitPwd() {
      if (this.data.pwdSubmitting) return;
      const newPwd = String(this.data.newPwd || '');
      if (newPwd.length < 6 || newPwd.length > 20) {
        wx.showToast({ title: '密码需为 6-20 位', icon: 'none' });
        return;
      }
      this.setData({ pwdSubmitting: true });
      wx.showLoading({ title: '提交中...', mask: true });
      changePassword(newPwd)
        .then(() => {
          wx.hideLoading();
          // 后端保存成功后本地同步一份（便于本地判断是否已设置过密码）
          setPassword(newPwd);
          this.setData({ showPwdModal: false, pwdSubmitting: false, newPwd: '' });
          wx.showToast({ title: '密码修改成功，可登录后台管理系统', icon: 'none' });
        })
        .catch(err => {
          wx.hideLoading();
          this.setData({ pwdSubmitting: false });
          console.warn('[profile] /api/changePassword 失败：', err);
          wx.showToast({ title: (err && err.message) || '密码修改失败', icon: 'none' });
        });
    },

    // ── 账号 ──
    // 重新登录：清除本地登录态，回到手机号授权登录页
    relogin() {
      wx.showModal({
        title: '重新登录',
        content: '将退出当前账号，返回登录页重新进行手机号授权。',
        confirmText: '退出登录',
        confirmColor: '#BA1A1A',
        success: (res) => {
          if (!res.confirm) return;
          clearLogin();
          wx.reLaunch({ url: '/pages/login/index?from=relogin' });
        }
      });
    },
  },
});
