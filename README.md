# TcpTool — 通信测试上位机

基于 **Python + PySide6** 的多功能通信调试工具，主打 TCP / UDP 联调与 ESP32 日志查看、烧录、固件合并，内置 VS Code 风格终端日志视图，支持深色 / 浅色主题切换。

## 功能一览

| 页面 | 功能 |
|---|---|
| **TCP 通信** | 客户端 / 服务端双模式，服务端支持多客户端；10 个发送框，文本与 HEX 格式 |
| **UDP 通信** | 客户端 / 服务端模式，支持广播、组播，多目标发送 |
| **ESP32 Log** | 串口实时日志查看，按级别着色（Error / Warning / Info / Debug / Verbose），日志默认自动保存到 `logs/` |
| **ESP32 烧录** | 基于乐鑫官方 **esptool** 的真实烧录 / 整片擦除 / **芯片检测**；芯片型号可选或自动检测；USB 插拔自动刷新串口 |
| **固件合并** | 读取 ESP-IDF `flasher_args.json` 按偏移合并多个 bin，自动从 `CMakeLists.txt` 读取项目名与版本号 |

界面细节：

- 日志区完整复刻 VS Code 输出面板的观感（Consolas 16px、22px 行距、`#181d27` 深底 + ANSI 配色，浅色主题有配套配色）
- 烧录页提供结构化「芯片信息」卡：芯片型号、晶振、USB 模式、MAC、Flash 容量 / 模式 / ID / 电压等，结果可选中复制
- 进度条独立成行并在右侧显示百分比，擦除 / 烧录大按钮，全程无需手动开串口（esptool 自动占用与释放）

## 下载

前往 [Releases](https://github.com/jasmine-502/Multifun_debug_tool/releases/latest) 下载最新版 `TcpTool.zip`（Windows，onedir 免安装版），解压后运行 `TcpTool.exe` 即可。

> 打包后的 exe 已内置 esptool，无需另装 Python 或乐鑫工具。

## 仓库结构

```
Multifun_debug_tool/
├── debug_tool/      Windows 上位机（Python + PySide6，本仓库主体）
│   ├── qt_app.py            程序入口
│   ├── app/                 各功能标签页与核心模块
│   ├── tool/                固件合并核心逻辑
│   ├── packaging/           PyInstaller 打包配置与脚本
│   └── README.md            详细使用文档（功能、烧录说明、故障排除）
└── esp_log_app/     ESP32 日志 Android 端（Kotlin + Jetpack Compose）
```

## 源码运行 / 打包

```bash
# 安装依赖
pip install -r debug_tool/packaging/requirements.txt

# 源码运行
cd debug_tool
python qt_app.py

# Windows 打包（PyInstaller onedir）
packaging\build_exe.bat
```

打 tag（`v*`）会触发 GitHub Actions 自动构建并发布 Release。

## 文档

功能使用说明、ESP32 烧录注意事项、故障排除等详见 **[debug_tool/README.md](debug_tool/README.md)**。

## 版本历史

见 [debug_tool/README.md 的「版本历史」](debug_tool/README.md#版本历史)，当前版本 **v1.7.0**。
