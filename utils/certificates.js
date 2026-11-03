// utils/certificates.js
// 「我的证书」数据源：培训组件列表页与证书详情页共用，保持字段一致
const CERTIFICATES = [
  {
    id: 1,
    name: '安全培训',
    type: 'basic',
    date: '2026-03-15',
    no: 'SAFE-2026-0001',
    course: '实验室安全规范培训',
    score: '95 分',
    organizer: '实验室安全管理中心',
    validity: '长期有效',
    desc: '本证书证明持证人已完成实验室安全规范培训并通过考核，是获得平台准入资格、进入实验室开展实验的必要条件。'
  },
  {
    id: 2,
    name: '流式细胞仪',
    type: 'special',
    date: '2026-04-20',
    no: 'FCM-2026-0012',
    course: '流式细胞仪专项培训',
    instrument: 'BD FACSCanto II',
    score: '实操考核 · 优秀',
    organizer: '大型仪器共享平台',
    validity: '2028-04-20',
    desc: '本证书证明持证人已通过 BD FACSCanto II 流式细胞仪专项培训与实操考核，具备独立操作资格，可用于预约并使用该仪器。'
  },
  {
    id: 3,
    name: '激光共聚焦',
    type: 'special',
    date: '2026-05-10',
    no: 'CLSM-2026-0007',
    course: '激光共聚焦显微镜操作',
    instrument: 'Zeiss LSM 900',
    score: '实操考核 · 合格',
    organizer: '大型仪器共享平台',
    validity: '2028-05-10',
    desc: '本证书证明持证人已通过 Zeiss LSM 900 激光共聚焦显微镜操作培训与实操考核，具备独立操作资格，可用于预约并使用该仪器。'
  }
]

function findCert(id) {
  return CERTIFICATES.find(c => c.id === Number(id)) || null
}

module.exports = {
  list: CERTIFICATES,
  findCert
}
