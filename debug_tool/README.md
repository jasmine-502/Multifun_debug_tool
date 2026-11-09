# 通信测试上位机

基于 Python + PySide6 的多功能通信调试工具，入口为 `qt_app.py`。

## 功能特性

### 1. TCP 通信
- 客户端 / 服务端两种模式，服务端支持多客户端连接
- 多个发送框，支持文本与 HEX 格式
- 实时接收显示并标注数据来源，连接状态监控

### 2. UDP 通信
- 客户端 / 服务端模式，支持广播与组播
- 多目标发送，10 个发送框，支持文本与 HEX 格式
- 显示数据来源地址

### 3. ESP32 日志与烧录
- ESP32 Log 实时查看
- 基于 **esptool** 的真实烧录 / 整片擦除 / 芯片检测（乐鑫官方库）
- 烧录地址默认 `0x0`，适合直接烧录合并后的整片固件；也支持多文件按地址烧录
- 芯片型号可选（ESP32 / S2 / S3 / C2 / C3 / C6 / C61 / H2 / P4）或「自动检测」
- **加密烧录**：勾选后由芯片用 eFuse 密钥加密固件；可烧录加密密钥（espefuse）
- USB 插拔自动刷新串口列表
- 烧录前自动释放串口、结束后自动恢复
- 日志**默认自动保存**到 `logs/`，可在「设置 → 自动保存日志」中开关

### 4. 固件合并
- 读取 ESP-IDF 的 `flasher_args.json`，按偏移合并多个 bin
- 支持从 `CMakeLists.txt` 读取项目名与版本号

## 目录结构

```
debug_tool/
├── qt_app.py                  程序入口
├── README.md
├── app/                       各功能标签页与核心模块
├── tool/                      固件合并核心逻辑
├── font/                      界面字体
├── packaging/                 打包脚本、图标、requirements
│   ├── TcpTool.spec           PyInstaller 配置
│   ├── build_exe.bat          一键打包
│   ├── convert_icon.py        图标处理（去白边 + 生成多尺寸 ico）
│   ├── install_dependencies.bat
│   ├── requirements.txt
│   └── icon.ico / icon.png
├── docs/                      补充文档
├── config/                    github_config.json.example（GitHub token 模板）
└── tests/                     测试脚本
```

## 安装和运行

```bash
# 安装依赖（Windows 可双击 packaging\install_dependencies.bat）
pip install -r packaging/requirements.txt

# 运行
python qt_app.py
```

## 打包（Windows）

```bash
pip install pyinstaller
packaging\build_exe.bat
```

产物：`dist\TcpTool\TcpTool.exe`（**onedir 目录版**），分发时把整个 `dist\TcpTool`
目录压缩成 zip 即可。

> **为什么不用 --onefile 单文件？**
> onefile 每次启动都要把 ~70MB 内容解压到 `%TEMP%`，冷启动要 3~5 秒；
> onedir 就地运行，启动约 1 秒。这是启动速度差别最大的一个开关，比换语言更立竿见影。

启动耗时另外两处大头（已修）：

| 项 | 优化前 | 优化后 | 做法 |
|---|---|---|---|
| `import esptool` / `espefuse` | 0.87s | ~0 | 改为首次烧录时才导入 |
| `import requests`（更新检查） | 1.05s | ~0 | 改成延迟代理，且检查本身在后台线程 |
| onefile 解压 | 3~5s | 0 | 改 onedir |

源码直跑（`python qt_app.py`）冷启动实测：**2.4s → 约 1.0s**。

配置 `config.json` 与日志目录 `logs/` 都写在 exe 同级目录，便于便携使用。

## 依赖库

| 库 | 用途 |
|---|---|
| `pyserial` | 串口通信 |
| `PySide6` | Qt 界面 |
| `requests` | 版本更新检查 |
| `esptool` | ESP32 烧录 / 擦除 / 芯片检测（同包内含 espefuse、espsecure） |
| `Pillow` | 打包时图标处理 |

## ESP32 烧录说明

本工具调用乐鑫官方 `esptool` 完成真实烧录，与 Flash Download Tool 底层一致。

**本页不需要先打开串口**：点「烧录 / 擦除 / 检测芯片 / 烧密钥」时由 esptool 自己打开串口，
操作结束自动释放，所以不会出现"串口被占用关不掉"的问题。

1. 选择串口、波特率和芯片型号（芯片不确定就留「自动检测」）
2. 勾选需要烧录的行，填写地址与 bin 文件（点击「浏览...」选择）。
   地址默认 `0x0` —— 直接烧合并后的整片固件即可；若要分开烧，再按需改地址
3. 点击「烧录」，进度条实时显示进度，底部一行显示当前动作
4. 「检测芯片」可读取芯片型号、MAC 与 Flash 容量
5. 需要看芯片的串口输出，请用「ESP32 Log」页面（本页不重复显示串口日志）

> 串口没插、端口选错、开发板没进下载模式时，会弹出错误框并给出最后 20 行 esptool 输出。

需要加密烧录时使用本工具内置能力，无需官方图形工具：

1. **烧密钥**（仅首次，不可逆）：点击「烧密钥...」，选择 32 字节密钥文件，确认后由
   `espefuse` 写入芯片 eFuse。eFuse 只能写一次，密钥写错会导致芯片永久无法解密。
2. **加密烧录**：勾选「加密烧录」后正常点「烧录」。明文固件发给芯片，由芯片用 eFuse
   中的密钥加密后写入 flash（等价于 `esptool write-flash --encrypt`）。

未烧过密钥的芯片勾选加密烧录会报错，取消勾选即可正常烧录。

自行生成密钥：

```bash
python -m espsecure generate_flash_encryption_key my_key.bin
```

> 打包后的 exe 已内置 esptool / espefuse / espsecure，用户无需另行安装或下载官方工具。

## 使用说明

### TCP 通信
**客户端模式**：选择「客户端」→ 填服务器地址与端口 → 连接 → 输入数据（选文本或 HEX）→ 发送。
**服务端模式**：选择「服务端」→ 设置监听地址、端口、最大连接数 → 启动服务 → 选择目标客户端或「全部」→ 发送。

### UDP 通信
选择工作模式 → 配置本地与远程地址端口 → 可勾选广播/组播 → 启动 → 输入数据与目标地址 → 发送。

## 配置与日志

- **配置**：自动保存到 `config.json`（连接参数、发送框内容、界面设置），下次启动自动加载。
- **日志**：ESP32 串口日志默认自动写入 `logs/ESP32_Log_<时间戳>.txt`，写入过程无弹窗打扰。
  可在「设置 → 自动保存日志」关闭自动保存，此时会显示「保存日志」按钮改为手动保存。
- **GitHub token**（可选，用于提升更新检查的 API 限额）：
  复制 `config/github_config.json.example` 为 `config/github_config.json` 并填入 token，
  也支持直接设置环境变量 `GITHUB_TOKEN`。

## 注意事项

1. **串口权限**：部分系统需管理员权限才能访问串口
2. **端口独占**：烧录时 esptool 会独占串口，请勿同时用其他工具打开同一串口
3. **防火墙**：TCP 连接可能被防火墙阻止
4. **设备占用**：确保设备未被其他程序占用

## 故障排除

### 串口无法打开
- 检查是否被其他程序（含本工具的其他页面）占用
- 确认串口参数正确，必要时以管理员权限运行

### 烧录页提示未安装 esptool
```bash
pip install esptool
```

### TCP 连接失败
- 检查服务器地址与端口、网络连通性、防火墙设置

## 开发信息

- 开发语言：Python 3.x
- GUI 框架：PySide6（Qt）
- 支持平台：Windows

## 版本历史

- v1.0：支持 TCP、串口、USB 通信
- v1.1：新增 UDP，支持客户端/服务端、广播、组播
- v1.2：TCP 升级为支持服务端多客户端
- v1.3：新增 Modbus、数据波形、协议分析、ESP32 日志与烧录、固件合并；
  移除 RS485 与 USB 功能；ESP32 烧录改为调用 esptool 真实烧录
- v1.4：移除串口调试 / Modbus / 数据波形 / 协议分析四个页面；移除官方 Flash Download Tool 依赖，
  加密烧录改用 espefuse 自实现；烧录地址默认 0x0；移除烧录页独立操作日志面板
- v1.5：烧录页去掉常驻串口连接与底部串口Log（与 ESP32 Log 页重复），点烧录自动连接、
  结束自动释放，彻底解决擦除后串口关不掉的问题；勾选框改为显示对号
- v1.6：启动提速（esptool / requests 延迟导入、打包改 onedir，源码冷启动 2.4s → 1.0s）；
  界面细节优化（卡片分层、下划线式标签栏、下拉箭头、进度条、滚动条、输入框层次、
  主操作按钮强调色、配套 QPalette 避免暗色白块）；统一圆角为 4px、深色主题正文改近白色
  (#e3e5e8)、中文字体优先（避免 sizeHint 按回退字体算导致文字被截断）
- v1.7：日志区复刻 VS Code 输出面板（Consolas 16px / 行距 22px / 终端配色 #181d27 + ANSI，
  新增 app/log_view.py）；修复无级别日志行深底黑字不可见；日志级别配色随主题自动切换，
  移除日志颜色设置对话框；分组框标题不再被边框线压断；烧录页擦除/烧录按钮加大、
  进度条独立成行并在右侧显示百分比；新增「芯片信息」卡（检测结果解析成结构化字段，
  可选中复制）；移除加密烧录与烧密钥功能（连带不再打包 espefuse / espsecure，体积再降）
