// utils/instruments.js
// 仪器列表数据源：仪器组件（列表）与仪器详情页共用，保持字段一致
// 字段说明：
//   image        列表缩略图（占位图为 picsum，可替换为真实照片 URL / 本地路径）
//   gallery      详情页轮播图（3 张，首张与 image 一致）
//   needBook     是否需要预约标记    needApprove 是否需要审批标记
//   control      控制方式（自助上机 / 委托测试等，扫描设备页展示）
//   status       idle=空闲 / online=在线
//   lab          所属实验室            platform 来源平台
//   price        收费标准表：院内/院外/所外 × 自助价/委托价
//   bookRule     预约时长规则：min 最短(分钟) / rec 推荐 / max 最大；closedHours 维护禁用小时
//   manager/contact/contactPhone/address/assetNo/sn/instAssetNo/model/spec/manufacturer/
//   costPrice/purchaseDate/fundSource/ownership   资产与位置说明（管理员/联系人/地址/编号/型号/厂家/成本/购置等）
//   description   仪器说明（详情页中仅展示内容，不带“仪器说明”标题）
const INSTRUMENTS = [
  {
    id: 1,
    name: '共聚焦显微镜 FV3000',
    image: 'https://picsum.photos/seed/fv3000/750/420',
    icon: '🔬',
    needBook: true,
    needApprove: true,
    status: 'idle',
    statusText: '空闲',
    lab: '生物成像与分析实验室',
    platform: '生物医学大型仪器共享平台',
    gallery: [
      'https://picsum.photos/seed/fv3000-a/750/420',
      'https://picsum.photos/seed/fv3000-b/750/420',
      'https://picsum.photos/seed/fv3000-c/750/420'
    ],
    price: [
      { cat: '院内', self: '¥1', entrust: '¥2' },
      { cat: '院外', self: '¥1', entrust: '¥2' },
      { cat: '所外', self: '¥1', entrust: '¥2' }
    ],
    manager: '王强 · 高级工程师',
    control: '自助上机 / 委托测试',
    contact: '王强',
    contactPhone: '138-0000-1201',
    address: '生命科学楼 A 座 302 室',
    assetNo: 'SB-2019-00102',
    sn: 'FV3000-2019-000421',
    instAssetNo: 'ZS-2019-0087',
    model: 'FV3000（倒置型）',
    spec: '激光 405/488/561/640nm，扫描分辨率 4096×4096',
    manufacturer: '奥林巴斯（Olympus，日本）',
    costPrice: '¥286 万元',
    purchaseDate: '2019-06-18',
    fundSource: '学科建设专项',
    ownership: '生物成像与分析实验室',
    description: '本仪器安放于恒温恒湿实验室内，用于活细胞与固定样本的多色荧光成像、时间序列采集及三维重构。自助上机前请先通过平台培训考核，需自备玻片与封片剂；委托测试请提前 2 个工作日送样。',
    bookRule: { min: 60, rec: 120, max: 600, closedHours: [12] }
  },
  {
    id: 2,
    name: '流式细胞仪 CytoFLEX',
    image: 'https://picsum.photos/seed/cytoflex/750/420',
    icon: '🧫',
    needBook: true,
    needApprove: false,
    status: 'online',
    statusText: '在线',
    lab: '免疫学流式分析实验室',
    platform: '生命科学公共仪器平台',
    gallery: [
      'https://picsum.photos/seed/cytoflex-a/750/420',
      'https://picsum.photos/seed/cytoflex-b/750/420',
      'https://picsum.photos/seed/cytoflex-c/750/420'
    ],
    price: [
      { cat: '院内', self: '¥1', entrust: '¥2' },
      { cat: '院外', self: '¥1', entrust: '¥2' },
      { cat: '所外', self: '¥1', entrust: '¥2' }
    ],
    manager: '李敏 · 实验师',
    control: '自助上机 / 委托测试',
    contact: '李敏',
    contactPhone: '138-0000-3305',
    address: '生命科学楼 B 座 115 室',
    assetNo: 'SB-2021-00877',
    sn: 'CYTOFLEX-2021-00912',
    instAssetNo: 'ZS-2021-0125',
    model: 'CytoFLEX S',
    spec: '4 激光 13 色，检出灵敏度 ≤ 30 MESF',
    manufacturer: '贝克曼库尔特（Beckman Coulter，美国）',
    costPrice: '¥98 万元',
    purchaseDate: '2021-11-02',
    fundSource: '中央引导地方科技发展基金',
    ownership: '免疫学流式分析实验室',
    description: '本仪器用于细胞表型分析、凋亡检测与分选前评估，支持 4 激光 13 色方案。日常维护由管理员负责，开机后请先运行质控微球校准；上样前样本需过滤去除团块，避免堵塞管路。',
    bookRule: { min: 60, rec: 120, max: 360, closedHours: [14] }
  },
  {
    id: 3,
    name: '透射电子显微镜 Tecnai G2',
    image: 'https://picsum.photos/seed/tecnai-g2/750/420',
    icon: '🖥️',
    needBook: true,
    needApprove: true,
    status: 'idle',
    statusText: '空闲',
    lab: '电镜中心实验室',
    platform: '材料与结构表征共享平台',
    gallery: [
      'https://picsum.photos/seed/tecnai-a/750/420',
      'https://picsum.photos/seed/tecnai-b/750/420',
      'https://picsum.photos/seed/tecnai-c/750/420'
    ],
    price: [
      { cat: '院内', self: '¥1', entrust: '¥2' },
      { cat: '院外', self: '¥1', entrust: '¥2' },
      { cat: '所外', self: '¥1', entrust: '¥2' }
    ],
    manager: '赵文博 · 高级实验师',
    control: '仅委托测试（管理员操作）',
    contact: '赵文博',
    contactPhone: '138-0000-7702',
    address: '电镜楼 2 层 201 机房',
    assetNo: 'SB-2018-00115',
    sn: 'TECNAI-2018-00315',
    instAssetNo: 'ZS-2018-0041',
    model: 'Tecnai G2 F20',
    spec: '加速电压 200kV，点分辨率 ≤ 0.24nm',
    manufacturer: 'FEI（赛默飞，美国）',
    costPrice: '¥860 万元',
    purchaseDate: '2018-09-26',
    fundSource: '211 工程专项',
    ownership: '电镜中心实验室',
    description: '本仪器为 200kV 场发射透射电镜，适用于纳米材料形貌、晶体结构及生物超微结构观察。样品需完成超薄切片或负染前处理，未经培训人员禁止上机操作；高真空腔体维护期间暂停预约。',
    bookRule: { min: 120, rec: 180, max: 720, closedHours: [13] }
  },
  {
    id: 4,
    name: '激光共聚焦 LSM 900',
    image: 'https://picsum.photos/seed/lsm900/750/420',
    icon: '🔭',
    needBook: true,
    needApprove: true,
    status: 'idle',
    statusText: '空闲',
    lab: '神经影像实验室',
    platform: '生物医学大型仪器共享平台',
    gallery: [
      'https://picsum.photos/seed/lsm900-a/750/420',
      'https://picsum.photos/seed/lsm900-b/750/420',
      'https://picsum.photos/seed/lsm900-c/750/420'
    ],
    price: [
      { cat: '院内', self: '¥1', entrust: '¥2' },
      { cat: '院外', self: '¥1', entrust: '¥2' },
      { cat: '所外', self: '¥1', entrust: '¥2' }
    ],
    manager: '陈曦 · 助理研究员',
    control: '自助上机 / 委托测试',
    contact: '陈曦',
    contactPhone: '138-0000-8819',
    address: '神经影像楼 4 层 407 暗室',
    assetNo: 'SB-2022-01560',
    sn: 'LSM900-2022-01560',
    instAssetNo: 'ZS-2022-0231',
    model: 'LSM 900',
    spec: 'Airyscan 2 超高分辨，全光谱 32 通道检测',
    manufacturer: '卡尔蔡司（Zeiss，德国）',
    costPrice: '¥380 万元',
    purchaseDate: '2022-03-15',
    fundSource: '双一流建设经费',
    ownership: '神经影像实验室',
    description: '本仪器支持 405/488/561/640nm 多通道成像与 Airyscan 2 超高分辨模式，适用于神经元形态与活体动态观测。请按预约时段使用并提前 10 分钟开机预热；使用油镜后请及时清洁物镜并关闭激光。',
    bookRule: { min: 60, rec: 120, max: 480, closedHours: [12] }
  }
]

function findInstrument(id) {
  return INSTRUMENTS.find(i => i.id === Number(id)) || null
}

// 按“设备编号”查找（二维码内容即仪器编号）：
// 支持固定资产编号 assetNo / SN / 所资产编号 / 数字 id 命中
function findInstrumentByNo(no) {
  const key = String(no == null ? '' : no).trim()
  if (!key) return null
  return INSTRUMENTS.find(i =>
    key === String(i.id) ||
    key === i.assetNo ||
    key === i.sn ||
    key === i.instAssetNo
  ) || null
}

module.exports = {
  list: INSTRUMENTS,
  findInstrument,
  findInstrumentByNo
}
