let des3 = require("./des3.js");
let crc = require("./crc.js");
let BASE64 = require("./Base64.js");
const api = require('./api.js');

// 错误日志上报（对应参考项目 utils/log.js 的 logError：POST /api/uploadLog type=4，
// 上报失败不影响主流程）
const log = {
  logError(data) {
    try { api.uploadLog(data, 4).catch(() => {}) } catch (e) { /* 忽略 */ }
  }
};

var BLEDevice = {
  deviceName: "ECOB",
  deviceId: null,
  sn: null,
  serviceId: null,
  writeId: null,
  operationId: 0,
  sign: [],
  app: getApp(),
  
  // 回调函数
  progressCallback: null,
  completeCallback: null,

  // 第一次握手成功后的暂停点（可选）：调用方在此完成服务端上报，
  // 再调用 proceed() 继续第二次握手，或调用 abort(msg) 终止流程。
  // 未设置时流程与原来完全一致（收到第一次握手响应立即发第二次握手）。
  // handler 入参：{ operation, proceed, abort }
  afterFirstHandshake: null,
  
  // 状态管理
  isListening: false,
  deviceFoundHandler: null,
  currentTimeout: null,

  // ==================== 工具方法 ====================
  
  // 设置步骤超时（1.5 秒）
  setStepTimeout(callback) {
    if (this.currentTimeout) clearTimeout(this.currentTimeout);
    this.currentTimeout = setTimeout(() => {
      // 注意：cleanup() 会把 completeCallback 置空，必须先把引用存下来，
      // 否则超时回调永远不执行，页面会一直卡在「操作中」状态
      var cb = this.completeCallback;
      this.cleanup();
      cb && cb({ success: false, msg: '操作超时，请重试' });
    }, 1500);
  },

  // 清除步骤超时
  clearStepTimeout() {
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
  },

  // 结束本次流程：先取出回调引用，再清理资源
  // 注意：cleanup() 会把 completeCallback 置空，若先 cleanup 再回调，
  // 回调永远不会执行 —— 页面就会一直停在「加载中」。
  // 因此所有失败/结束分支统一走这里。
  finish(result) {
    var cb = this.completeCallback;
    this.cleanup();
    cb && cb(result);
  },

  // 清理所有资源
  cleanup() {
    console.log("执行清理...");
    this.clearStepTimeout();
    
    // 移除设备发现监听器
    if (this.isListening && this.deviceFoundHandler) {
      wx.offBluetoothDeviceFound(this.deviceFoundHandler);
      this.isListening = false;
      this.deviceFoundHandler = null;
    }
    
    // 停止搜索蓝牙设备
    wx.stopBluetoothDevicesDiscovery({
      complete: () => console.log('已停止搜索')
    });
    
    // 关闭蓝牙连接
    if (this.deviceId) {
      wx.closeBLEConnection({
        deviceId: this.deviceId,
        complete: () => console.log('已关闭连接')
      });
    }
    
    // 重置状态
    this.deviceId = null;
    this.serviceId = null;
    this.writeId = null;
    this.progressCallback = null;
    this.completeCallback = null;
    // 清空握手暂停点，避免上次流程的回调残留（页面卸载后仍被调用）
    this.afterFirstHandshake = null;
  },

  // DES3 加密
  DES3_Encrypt(data, key) {
    return BASE64.encoder(des3.encrypt(key, data));
  },

  // DES3 解密
  DES3_Decrypt(data, key) {
    return des3.decrypt(key, BASE64.decoder(data));
  },

  // ==================== 主流程方法 ====================

  /**
   * 蓝牙操作主入口
   * @param {number} operationId - 操作ID (0:关闭, 1:开启)
   * @param {function} progressCallback - 进度回调函数
   * @param {function} completeCallback - 完成回调函数 {success: boolean, operation: number, msg: string}
   */
  BLEOperation(operationId, progressCallback, completeCallback, options) {
    let that = this;
    
    // 清理旧状态
    this.cleanup();
    
    // 保存参数
    this.operationId = operationId;
    this.progressCallback = progressCallback;
    this.completeCallback = completeCallback;
    // 第一次握手后的暂停点（可选）：cleanup 会清空该属性，故在清理之后再从入参赋值
    this.afterFirstHandshake = (options && typeof options.afterFirstHandshake === 'function')
      ? options.afterFirstHandshake
      : null;

    // 1. 初始化蓝牙适配器
    wx.openBluetoothAdapter({
      success: (res) => {
        progressCallback && progressCallback('初始化蓝牙设备成功...');
        that.setStepTimeout();
        // 2. 开始搜索蓝牙设备（失败会自动延迟重试一次，见 startDiscoveryWithRetry）
        that.startDiscoveryWithRetry(progressCallback);
      },
      fail: (res) => {
        that.cleanup();
        log.logError(res);
        completeCallback && completeCallback({
          success: false, 
          msg: '请先打开手机蓝牙！'
        });
      }
    });
  },

  /**
   * 开始搜索设备（失败时延迟重试一次）
   * 背景：Android 7+ 对同一应用有「30 秒内最多启动 5 次 BLE 扫描」的限制，
   *   且上一轮的 stopDiscovery / closeBLEConnection 是异步释放的；
   *   连续开关机四五次后 startBluetoothDevicesDiscovery 常被系统拒绝。
   * 策略：失败后先停一次扫描（避免「扫描已在进行中」），延迟 800ms 重试；
   *   仍失败则提示用户稍等几秒再试（而不是让用户以为设备坏了）。
   */
  startDiscoveryWithRetry(progressCallback) {
    let that = this;
    let tried = 0;

    const start = () => {
      tried++;
      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: false,
        interval: 0,
        success: (res) => {
          progressCallback && progressCallback('正在搜索设备...');
          that.setStepTimeout();
          that.getBlue();
        },
        fail: (res) => {
          log.logError(res);
          if (tried < 2) {
            // 首次失败：大概率是系统节流或上一轮连接未释放，延迟重试
            progressCallback && progressCallback('正在重新搜索设备...');
            // 重试等待期间不计步骤超时（否则 1.5s 会先判超时）
            that.clearStepTimeout();
            setTimeout(() => {
              // 页面已卸载或流程已结束（cleanup 会置空回调）则不再重试
              if (!that.completeCallback) return;
              wx.stopBluetoothDevicesDiscovery({
                complete: () => start()
              });
            }, 800);
            return;
          }
          // 重试后仍失败：给出可操作提示，交给页面复位按钮状态
          that.finish({
            success: false,
            msg: '蓝牙搜索失败，请稍等几秒后再试'
          });
        }
      });
    };

    start();
  },

  /**
   * 获取蓝牙设备列表
   */
  getBlue() {
    let that = this;
    
    // 如果已找到设备，停止搜索
    if (this.deviceId != null) {
      this.clearStepTimeout();
      return;
    }

    wx.getBluetoothDevices({
      success: (res) => {
        that.clearStepTimeout();
        
        // 设备列表为空，注册监听器
        if (res.devices.length == 0) {
          if (!that.isListening) {
            that.isListening = true;
            that.progressCallback && that.progressCallback("搜索到设备列表为空，继续搜索...");
            
            that.deviceFoundHandler = function(bres) {
              that.isListening = false;
              wx.offBluetoothDeviceFound(that.deviceFoundHandler);
              that.deviceFoundHandler = null;
              that.getBlue();
            };
            
            wx.onBluetoothDeviceFound(that.deviceFoundHandler);
            that.setStepTimeout();
          }
          return;
        }
        
        // 移除监听器（如果存在）
        if (that.isListening) {
          that.isListening = false;
          wx.offBluetoothDeviceFound(that.deviceFoundHandler);
          that.deviceFoundHandler = null;
        }
        
        // 查找匹配的设备
        let foundMatch = false;
        for (var i = 0; i < res.devices.length; i++) {
          let device = res.devices[i];
          
          if (device.name == that.deviceName || device.localName == that.deviceName) {
            that.progressCallback && that.progressCallback("找到蓝牙控制器，检查设备编号...");
            
            // 解析设备SN
            let sn = "";
            if (device.advertisData) {
              let snList = new Uint8Array(device.advertisData);
              for(let k = 0; k < snList.length; k++){
                sn += String.fromCharCode(snList[k]);
              }
            }

            // 匹配SN
            if(that.sn == sn){
              foundMatch = true;
              that.deviceId = device.deviceId;
              that.clearStepTimeout();
              that.connetBlue(device.deviceId);
              break;
            } else {
              that.progressCallback && that.progressCallback("编号不匹配，继续寻找...");
            }
          }
        }
        
        // 没找到匹配设备，继续监听
        if (!foundMatch && !that.isListening) {
          that.isListening = true;
          that.deviceFoundHandler = function(bres) {
            that.isListening = false;
            wx.offBluetoothDeviceFound(that.deviceFoundHandler);
            that.deviceFoundHandler = null;
            that.getBlue();
          };
          wx.onBluetoothDeviceFound(that.deviceFoundHandler);
          that.setStepTimeout();
        }
      },
      fail: (err) => {
        log.logError(err);
        that.finish({
          success: false, 
          msg: '搜索蓝牙设备失败'
        });
      }
    });
  },

  /**
   * 连接蓝牙设备
   */
  connetBlue(deviceId) {
    let that = this;
    that.setStepTimeout();
    
    wx.createBLEConnection({
      deviceId: deviceId,
      timeout: 1500,
      success: (res) => {
        that.clearStepTimeout();
        that.progressCallback && that.progressCallback('连接设备控制器成功...');
        
        // 连接成功后关闭蓝牙搜索
        wx.stopBluetoothDevicesDiscovery({
          success: (res) => {
            console.log('连接蓝牙成功之后关闭蓝牙搜索');
          }
        });
        
        that.getServiceId(deviceId);
      },
      fail: (err) =>{
        log.logError(err);
        that.finish({
          success: false, 
          msg: '连接设备控制器失败'
        });
      }
    });
  },

  /**
   * 获取服务ID
   */
  getServiceId(deviceId) {
    let that = this;
    that.setStepTimeout();
    
    wx.getBLEDeviceServices({
      deviceId: deviceId,
      success: (res) => {
        that.clearStepTimeout();
        
        if (res.services.length > 1) {
          var model = res.services[1];
          that.serviceId = model.uuid;
          that.getCharacteId(deviceId, model.uuid);
        } else {
          that.finish({
            success: false, 
            msg: '获取服务失败'
          });
        }
      },
      fail: (res) => {
        log.logError(res);
        that.finish({
          success: false, 
          msg: '获取服务失败'
        });
      }
    });
  },

  /**
   * 获取特征值ID
   */
  getCharacteId(deviceId, serviceId) {
    let that = this;
    that.setStepTimeout();
    
    wx.getBLEDeviceCharacteristics({
      deviceId: deviceId,
      serviceId: serviceId,
      success: (res) => {
        that.clearStepTimeout();
        
        for (var i = 0; i < res.characteristics.length; i++) {
          var model = res.characteristics[i];
          if (model.properties.notify == true) {
            that.serviceId = model.uuid;
            that.startNotice(deviceId, serviceId, model.uuid);
          }
          if (model.properties.write == true) {
            that.writeId = model.uuid;
          }
        }
      },
      fail: (err) => {
        log.logError(err);
        that.finish({
          success: false, 
          msg: '获取特征值失败'
        });
      }
    });
  },

  /**
   * 启动监听并处理握手
   */
  startNotice(deviceId, serviceId, uuid) {
    let that = this;
    that.setStepTimeout();
    
    wx.notifyBLECharacteristicValueChange({
      state: true,
      deviceId: deviceId,
      serviceId: serviceId,
      characteristicId: uuid,
      success: (res) => {
        console.log('启用监听成功');
      },
      fail: (res) =>{
        log.logError(res);
        that.finish({
          success: false, 
          msg: '启用监听失败'
        });
      }
    });
    
    // 监听设备返回的数据
    // 先移除之前注册的监听：本方法每次操作都会调用，不注销会导致监听器累积，
    // 同一帧被多个回调重复处理（重复发握手/指令帧），表现为「偶尔」卡住或失败
    try { wx.offBLECharacteristicValueChange() } catch (e) { /* 忽略 */ }
    wx.onBLECharacteristicValueChange((res) => {
      that.clearStepTimeout();
      
      let hex = Array.prototype.map.call(
        new Uint8Array(res.value), 
        x => ('00' + x.toString(16)).slice(-2)
      ).join('');
      
      console.log('回应数据', hex);
      
      // 第一次握手：设备发送初始数据
      if (hex == "000102030405060708090a0b0c0d0e") {
        that.progressCallback && that.progressCallback('收到设备响应，开始握手...');
        var cmd = that.buildBleCommand(1, 15, '+', 12, 0, 0, 0, 0, 0);
        that.sendMy(deviceId, serviceId, uuid, that.string2buffer(cmd));
        that.setStepTimeout();
        return;
      }
      
      // 解密消息
      var msg = des3.triple_udes("12345678", des3.hexToString(hex));
      console.log('回应msg:' + msg);
      
      // 第一次握手响应
      if (msg.charCodeAt(2) == 1) {
        console.log('握手', '收到第一次握手信息' + msg);
        that.progressCallback && that.progressCallback('第一次握手成功...');
        
        var p1 = msg.charCodeAt(3);
        var p2 = msg.substring(4, 5);
        var p3 = msg.charCodeAt(5);
        var exp = p1 + p2 + p3;
        var r = 0;
        
        switch (p2) {
          case '+':
            r = p1 + p3;
            break;
          case '-':
            r = p1 - p3;
            break;
          case '*':
            r = p1 * p3;
            break;
          case '!':
            r = p1 / p3;
            break;
          case '^':
            r = p1 ^ p3;
            break;
        }

        if (r > 255) {
          var h = r.toString(16);
          var x = h.substring(h.length - 2, h.length);
          r = parseInt(x, 16);
        } else if (r < 0) {
          var h = (r >>> 0).toString(16);
          var x = h.substring(h.length - 2, h.length);
          r = parseInt(x, 16);
        }

        console.log('计算', exp + '=' + r);

        if (isNaN(r) || Infinity == r || NaN == r || 0 == r) {
          console.log('表达式计算失败，结果为' + r);
          // 同上：cleanup 会置空 completeCallback，先留引用再清理
          var failCb = that.completeCallback;
          that.cleanup();
          failCb && failCb({
            success: false,
            msg: '设备握手失败，请重试'
          });
          return;
        }
        
        // 暂停点：若调用方注册了 afterFirstHandshake，则先交由其处理
        // （典型场景：先调 /api/deviceOperate 上报，接口成功后再继续第二次握手）
        if (typeof that.afterFirstHandshake === 'function') {
          var gate = that.afterFirstHandshake;
          that.afterFirstHandshake = null; // 只拦一次，避免后续流程重复触发
          // 等待接口期间不计步骤超时（HTTP 耗时不确定，1500ms 的步骤超时会误判失败）
          that.clearStepTimeout();

          var proceeded = false;
          var cbRef = that.completeCallback; // cleanup 会置空 completeCallback，先留引用
          gate({
            operation: that.operationId,
            // 继续：发送第二次握手请求
            proceed: function () {
              if (proceeded) return;
              proceeded = true;
              var cmd = that.buildBleCommand(2, p1, p2, p3, r, 0, 0, 0, 0);
              that.sendMy(deviceId, serviceId, uuid, that.string2buffer(cmd));
              that.setStepTimeout();
            },
            // 终止：清理连接并回调失败（如服务端上报失败）
            abort: function (msg) {
              if (proceeded) return;
              proceeded = true;
              that.cleanup();
              cbRef && cbRef({ success: false, operation: that.operationId, msg: msg || '操作已取消' });
            }
          });
          return;
        }

        var cmd = that.buildBleCommand(2, p1, p2, p3, r, 0, 0, 0, 0);
        that.sendMy(deviceId, serviceId, uuid, that.string2buffer(cmd));
        that.setStepTimeout();
      } 
      // 第二次握手响应
      else if (msg.charCodeAt(2) == 2) {
        console.log('握手', '收到第二次握手信息');
        that.progressCallback && that.progressCallback('第二次握手成功...');
        
        that.sign = [];
        for (var i = 7; i <= 10; i++) {
          that.sign.push(msg[i].charCodeAt());
        }
        
        var cmd = that.buildBleCommand(
          5, 
          that.operationId, 
          "+", 
          0, 
          0, 
          that.sign[0], 
          that.sign[1], 
          that.sign[2], 
          that.sign[3]
        );
        
        // 发送开启/关闭指令
        wx.writeBLECharacteristicValue({
          deviceId: deviceId,
          serviceId: serviceId,
          characteristicId: that.writeId,
          value: that.string2buffer(cmd),
          success: (res) => {
            console.log("指令发送成功");
            that.clearStepTimeout();
            
            let successMsg = that.operationId == 1 ? "设备已成功开启！" : "设备已成功关闭！";
            that.progressCallback && that.progressCallback(successMsg);
            
            // 调用完成回调
            if(that.completeCallback){
              that.completeCallback({
                success: true,
                operation: that.operationId
              });
            }
            
            // 延迟关闭连接，确保设备收到指令
            setTimeout(() => {
              that.closeConn(deviceId);
            }, 500);
          },
          fail: (err) => {
            log.logError(err);
            console.log('指令发送失败');$4that.finish({
              success: false, 
              msg: '指令发送失败'
            });
          }
        });
      } 
      // 其他响应类型
      else {
        console.log('其它回应类型', msg.charCodeAt(2));
        for (var i = 0; i < msg.length; i++) {
          console.log(msg[i].charCodeAt());
        }
        that.closeConn(deviceId);
      }
    });
  },

  /**
   * 发送数据到设备
   */
  sendMy(deviceId, serviceId, characteristicId, buffer) {
    wx.writeBLECharacteristicValue({
      deviceId: deviceId,
      serviceId: serviceId,
      characteristicId: characteristicId,
      value: buffer,
      success: (res) => {
        console.log("数据发送成功");
      },
      fail: (e) => {
        log.logError(e);
        console.log('数据发送失败', e);
      }
    });
  },

  // ==================== 数据转换方法 ====================

  /**
   * 将字符串转换成ArrayBuffer
   */
  string2buffer(str) {
    if (!str) return;
    let length = str.length;
    let index = 0;
    let array = [];
    
    while (index < length) {
      array.push(str.substring(index, index + 2));
      index = index + 2;
    }
    
    let val = array.join(",");
    return new Uint8Array(val.match(/[\da-f]{2}/gi).map(function (h) {
      return parseInt(h, 16);
    })).buffer;
  },

  /**
   * 将ArrayBuffer转换成字符串
   */
  ab2hex(buffer) {
    var hexArr = Array.prototype.map.call(
      new Uint8Array(buffer),
      function (bit) {
        return ('00' + bit.toString(16)).slice(-2);
      }
    );
    return hexArr.join('');
  },

  /**
   * 构建蓝牙命令
   */
  buildBleCommand(c, p1, p2, p3, p4, sign, sign1, sign2, sign3, data) {
    var ln = data ? data.length : 0;
    var op = p2 === '/' ? '!' : p2;
    var vd;
    
    if (!data) {
      vd = crc.CalcCRC8(new Array(c, p1, op.charCodeAt(), p3, p4, sign, sign1, sign2, sign3, ln));
    } else {
      var ar = new Array(c, p1, op.charCodeAt(), p3, p4, sign, sign1, sign2, sign3, ln);
      for (var i = 0; i < data.length; i++) {
        ar.push(data[i]);
      }
      vd = crc.CalcCRC8(ar);
    }

    var cmd = String.fromCharCode(0x5A) + String.fromCharCode(vd) + String.fromCharCode(c) 
      + String.fromCharCode(p1) + op + String.fromCharCode(p3) + String.fromCharCode(p4) 
      + String.fromCharCode(sign) + String.fromCharCode(sign1) + String.fromCharCode(sign2) 
      + String.fromCharCode(sign3) + String.fromCharCode(ln);
    
    if (data && data.length > 0) {
      for(let i = 0; i < data.length; i++){
        cmd += String.fromCharCode(data[i]);
      }
    }
    
    return des3.stringToHex(des3.triple_des('12345678', cmd));
  },

  /**
   * 关闭连接
   */
  closeConn(deviceId) {
    console.log("关闭连接: " + deviceId);
    let tempDeviceId = deviceId || this.deviceId;
    
    this.deviceId = null;
    this.clearStepTimeout();
    
    if (tempDeviceId) {
      wx.closeBLEConnection({
        deviceId: tempDeviceId,
        success: (res) => {
          console.log('连接已关闭', res);
        },
        fail: (res) => {
          log.logError(res);
          console.log('关闭连接失败', res);
        }
      });
    }
  }
};

module.exports = BLEDevice;