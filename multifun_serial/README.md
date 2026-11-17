# Multifun Serial（multifun_serial）

Multifun Serial 是串口日志 / 调试工具，也是 `debug_tool` 里 ESP Log tab 的 Tauri 重写版
（现已支持通用串口），并把 Qt 版的「TCP / UDP 通信」「固件合并」与「ESP32 烧录」一并迁了过来
（Qt 版拆成两个 tab 的 TCP 与 UDP，在这里合成一页，用协议下拉切换）。
**旧 PySide6 代码一行未动**，两个程序可以并存，只是不能同时打开同一个串口。

## 1. 为什么单独一个目录

| 端 | 目录 | 状态 |
|---|---|---|
| PySide6 桌面版（全部 5 个 tab） | `debug_tool/` | 唯一稳定实现，继续维护 |
| Android 日志端 | `esp_log_app/` | 独立 |
| **Multifun Serial**（Tauri） | `multifun_serial/`（本目录） | 4 个 tab 已全部迁移：ESP Log + TCP/UDP 通信 + 固件合并 + ESP32 烧录 |

目录名 `multifun_serial/`、Cargo crate `multifun-serial`、npm 包 `multifun-serial` 已统一到产品名。
只留两处标识符按历史保留：bundle identifier `com.multifun.esplog` 与偏好键 `esp-log-console.*`——
改它们会让 WebView2 数据目录换位置，本地保存的串口 / 波特率偏好会丢。

拆开的好处是验证成本低：样式和性能不达标时只需要删掉这一个目录，不会污染旧工程。

## 2. 视觉与交互基线

- **外壳**移植 HachimoDock 的设计令牌：浅色中性画布 + 单一品牌橙 `#ff6700`、
  4/8/12/16 圆角、34/40/44 控件高度、`card` 单层卡片、140/180ms 动效。
  令牌全部在 `src/styles/tokens.css`，业务样式不得自创色值。
- **日志区**沿用 `debug_tool/app/theme.py` 的 VS Code 终端配色：
  `#181d27` 背景 / `#cccccc` 正文 / 五级日志色（`#f14c4c` `#e5e510` `#0dbc79` `#3b8eea` `#d670d6`）。
  这样老用户切过来不需要重新认识颜色。
- 组件契约与 HachimoDock 一致：`Button`（primary/secondary/ghost/danger/icon）、`Card`、
  `Switch`（38×22 轨道）、`PageShell`。一页只允许一个 `primary`。
- 日志区的正文色与时间戳色可由用户在「日志颜色」弹窗里覆盖：运行时写
  `document.documentElement` 上的 `--term-fg` / `--term-ts` 内联变量，
  `tokens.css` 本身不动，各级别色也只在该用户勾选了「统一正文颜色」时才被压掉。

## 3. 运行

```powershell
cd multifun_serial
npm install

# 只调 UI（浏览器，日志是模拟数据，不需要编译 Rust）
npm run dev:web        # http://localhost:5183

# 真机联调（需要 WebView2 + Rust 工具链 + MSVC）
npm run dev

# 出包
npm run build          # 产物在 src-tauri/target/release/bundle/
```

> **`dev:web` 与 `dev` 的区别不是可选的两种风格，而是两个不同的程序。**
> `dev:web` 跑在普通浏览器里，没有 Tauri 运行时，后端自动切换成 `mock`：
> 串口列表是假的（COM7/COM3），日志是按模板凭空生成的，页面上会有橙色提示条、
> 按钮写「打开模拟串口」、状态栏写「未连接（模拟模式）」。
> **只有 `npm run dev` 会真正打开物理串口。**
>
> 跑 `npm run dev` 前要先停掉 `dev:web`：两者都占 5183，
> `vite.config.ts` 里 `strictPort: true`，端口被占会直接报错而不是悄悄换端口。

Rust 侧单测（日志解析规则 + 固件合并）：

```powershell
cd src-tauri
cargo test
```

## 4. 架构要点

```
串口数据
  └─ Rust 读线程（serialport，100ms 超时）
       ├─ 切包：CR/LF（ESP 固定）或 空闲超时 / 定长（通用串口）
       ├─ 每个包同时产出 raw（lossy 文本）与 hex（原始字节，无损）
       ├─ log_parser：级别 / 日志名（仅 ESP 模式；通用模式恒为 None）
       ├─ 过滤（级别 + 日志名白名单 / 行内关键字）在 Rust 侧完成
       ├─ 自动保存：按当前视图格式落盘（文本 / 十六进制），格式变了自动换文件
       └─ 每 50 行或 33ms 发一批 `esp://log-batch`
            └─ 前端 logStore（2 万行环形缓冲，rAF 合并通知）
                 └─ LogTerminal 虚拟滚动（定高 22px，只渲染可视窗口）
```

三条硬约束，缺一条高速日志就会卡：

1. **Rust 侧批量 emit**，不允许一行一次 IPC；
2. **前端环形缓冲**（`MAX_LINES = 20000`），不是无限追加 DOM；
3. **窗口化渲染**，DOM 常驻节点 < 100，与总行数无关。

安全约束：日志内容一律用 React 文本节点渲染，禁止 `innerHTML`；`tauri.conf.json` 的 CSP
不放开 `unsafe-eval`。

### 4.1 两种数据源：ESP-IDF 日志 / 通用串口

不是所有接进来的都是 ESP32。连接区第一行的「数据源」决定了整条链路怎么解释字节，
`open_log` 的 `generic` 参数就是它的开关：

| | ESP-IDF 日志（默认） | 通用串口 |
|---|---|---|
| 切包 | 固定只认 CR / LF | 行尾 / 空闲超时 / 定长，三选一 |
| 级别与日志名 | `log_parser` 解析 `I (123) TAG:` 前缀 | 不解析，级别恒为 `None`，不显示级别 chips |
| 过滤框语义 | 日志名精确白名单 | 行内包含任一关键字（ASCII 不区分大小写） |
| 打开时复位 | 默认开启 | 默认关闭 |
| 6 秒无数据提示 | 提示检查复位 / 换口 | 提示检查波特率 / TX-RX 交叉 |

切包策略（`SplitMode`）只在通用模式下可选，连接后置灰：

- **按行尾（`crlf`）**：遇 `\r` 或 `\n` 切，CRLF 算一个。AT 指令、NMEA、大多数文本协议用这个。
- **按空闲超时（`idle`）**：不靠分隔符，串口静默 50ms 就把攒到的字节整段切出。
  适合“一次性吐一串、然后停一会”的设备。阈值取 50ms 是因为读超时本身是 100ms，
  再小也观察不到。
- **按固定字节数（`fixed`）**：攒够 N 字节切一包，适合定长帧。注意它**不校验帧头**，
  起始字节错位后会一直错位，需要重新打开串口。

### 4.2 HEX 为什么必须由 Rust 生成

`String::from_utf8_lossy` 是不可逆的：非法字节变成 `U+FFFD`（`EF BF BD`），
切包时行尾的 `\r\n` 也被扔掉了。拿 `raw` 再 encode 出来的 HEX 只是“看着像十六进制”，
用它分析报文或导出 `.bin` 会得到错误的字节。

所以 `LogLine.hex` 在切包的那一刻直接从原始字节切片生成（含行尾），
HEX 视图与右键菜单的「导出原始数据（.bin）」都基于它，
后端 `save_raw_snapshot` 逐行解码后按字节写文件，全程无损。

代价是“查找 / 高亮”仍跑在 `raw` 上：二进制报文用关键字搜不到，
只能用 HEX 视图肉眼比对，或直接导出 `.bin` 用专业工具分析。

### 4.3 自动保存的目录布局

```
logs/
  2026-11/
    ESP32_Log_20261115_143022.txt
    ESP32_Log_20261115_161540_hex.txt
    Serial_Log_20261115_163810.txt
  2026-12/
    ESP32_Log_20261201_090512.txt
```

- **按年月分目录**（`YYYY-MM`）：单目录堆上千个文件后 Windows 资源管理器打开会明显卡顿；
- **文件名前缀区分数据源**：ESP 模式 `ESP32_Log_`、通用串口 `Serial_Log_`；
- **写入格式跟随屏幕**：HEX 视图下写十六进制文本（`.txt` 直接能读），
  文件名带 `_hex`；时间戳开关打开时每行前面多一段 `HH:MM:SS.mmm`；
- **切换格式会换文件**：同一个文件里前半段文本、后半段十六进制谁也读不了，
  所以 HEX / 时间戳一变，旧文件正常收尾（写结束时间）并另开一个；
- 月份在**创建文件那一刻**确定，跨月的长会话仍写在同一目录，一次连接归一次归档；
- 「日志目录」按钮打开的是 `logs/` 根目录，不是当月子目录；
- 手动指定过保存目录时，年月子目录建在你指定的目录下面。

> 想要**无损原始字节**（而不是十六进制文本）时，用右键菜单的「导出原始数据（.bin）」，
> 那个才是逐字节回写。

### 4.4 固件合并的扫描与拼接规则

```
src-tauri/src/firmware_merge.rs    扫描 / 解析 / 拼片，全部纯函数，不依赖 Tauri
  ├─ scan：定位 build 目录 → 读 flasher_args.json → 兜底按常见文件名猜 → 读 CMakeLists 版本 / 项目名
  └─ merge：校验文件名与文件存在 → 按偏移排序 → 全零缓冲逐段 copy → 写盘
```

几条刻意与旧版（`tool/release_output_binV2.py` + `app/firmware_merge_tab.py`）对齐的语义：

- **`flasher_args.json` 的 `flash_files` key 恒按十六进制解析**（旧版 `int(key, 16)`），带不带 `0x` 都认；
- **表格里手填的偏移只有写了 `0x` 才按十六进制**，否则按十进制 —— 所以 `10000` 是一万，不是 `0x10000`；
- 偏移或文件留空的行直接跳过、不算错误；偏移写错 / 文件不存在才中断并报错；
- 合并先建 `max(offset + size)` 长度的全零缓冲，再按偏移从小到大逐段写入，**后写的覆盖先写的**，
  重叠只提示不阻止（这正是把 `generated_assets.bin` 叠到固件尾部的用法）；
- 允许直接选 `build` 目录，此时 `CMakeLists.txt` 从上一级找；
- 合并后大小设了 512MB 上限，避免手填一个天文数字偏移把内存吃光（旧版没有这道闸）。

页面上：项目目录可以直接拖进窗口（Tauri 的拖放事件是全局的，按当前页 `active` 门控，避免和日志页串扰）；
输出文件名由「日期 / 版本号 / 项目名」三个开关拼成
`merged_firmware[-项目名][-V版本][-YYYYMMDD_HHMMSS].bin`，预览用 `X.Y.Z` 占位、真正合并时才取实时时间；
配置存 localStorage `multifun-serial.firmware.prefs.v1`，下次进来目录还在就自动扫一遍。

### 4.5 ESP32 烧录为什么不用 esptool

```
src-tauri/src/esp_flash.rs    烧录 / 擦除 / 检测，同步阻塞代码
  ├─ flash：读文件 → 开串口（115200 握手）→ Connection::new + begin() → Flasher::connect → write_bins_to_flash → 内部自动 hard reset
  ├─ erase：只走 stub 连接 → 分 1MB 块 erase_region() → reset_after(stub, chip)（espflash 擦完不复位）
  └─ detect：device_info() + connection().usb_pid() 推断走的是芯片 USB 还是 UART 桥
```
旧版是拼 `esptool` 命令行、再解析 stdout 里的百分比和字段，用 `QProcess` 拉起 Python。
这里改用 Rust crate [`espflash`](https://crates.io/crates/espflash)（`default-features = false, features = ["serialport"]`）：

- 不依赖用户机器上的 Python / esptool 版本，也不会因为 esptool 5.x 把参数改成连字符就失配；
- 进度是结构化回调，段与段之间按字节数加权，先写 20 KB 的 bootloader 不会瞬间冲到 50%；
  进度事件同时带 `written` / `total` / `bytesPerSec`（整次任务累计，50ms 节流一次），
  界面上的「平均速度」就是 `bytesPerSec`，完成日志写成
  `用时 9.3s（写入 8.2s，平均 119.4 KB/s）`：写入耗时与速度不含读文件与握手，
  否则小固件会被握手时间拖成个位数 KB/s；擦除也复用同一个事件，所以进度条和速度不会停在 0；
- 三个命令都丢进 `spawn_blocking`，不会卡住主线程；串口是一次性的（进来开、结束关），不会「烧录页握着串口关不掉」。

页面上：4 行固定任务（第一行默认勾选）、地址**一律按十六进制**解释（`0x10000` 与 `10000` 等价，与合并页的十进制规则不同）、
勾选与地址 / 路径持久化在 localStorage `multifun-serial.flash.prefs.v1`（只有确实选过 bin 的行沿用旧地址，空行回落 `0x0`）。
三个动作在 Rust 侧用 `AtomicBool` + RAII 互斥；日志页占着串口时点烧录会被直接拦下。

取不到的字段：`flashMode` / `flashId` / `flashVoltage` 是 eFuse 项，espflash 不读，界面显示「—」；
USB 模式用 `connection().usb_pid()` 推断（`0x1001` 为 USB-Serial/JTAG，否则按 UART 桥接）。

#### 连不上时做了什么兜底

espflash 的 `Error::Connection` 的 `Display` 恒为一句 `Error while connecting to device`，
真正原因（复位没生效、boot 模式不对、同步无回应、切速失败）藏在 `source()` 链里。所以：

- `describe()` 沿 `source()` 把整条错误链拼成 `A → B → C`，界面上直接看到根因；
- 握手固定 115200，复位方式按串口类型排序（PID `0x1001` 先试 USB-JTAG 复位，否则先试默认复位），
  每次重开串口，全失败才报错并把每条的原因列出来。PID `0x1001` 下 `DefaultReset` 与 `UsbReset`
  会落到同一套 `UsbJtagSerialReset`，所以那种口只试两种，省掉白等的一轮；
- **stub 没跑起来时自动退回 ROM 模式**：espflash 的 stub 在 USB-Serial-JTAG 上偶发丢 `OHAI`
  握手帧（`Stub written!` 后再无字节，见 esp-rs/espflash#1113），ROM 模式不传 stub，正好绕过；
  只有确实进过下载模式才会走这一轮，避免无谓等待；
- 两处剪枝让「连不上」不再白等十几秒：复位 / 同步就没过时，换 stub 还是 ROM 结果一样，直接结束；
  stub 已经写进 RAM 才失联时，换复位方式也一样，剩下的复位方式全跳过。
  阶段怎么判断：espflash 4 把连接拆成了两步，代码先自己 `Connection::begin()`（只做复位 + 同步），
  成功后才交给 `Flasher::connect`（检测芯片、读修订号、装 stub）——`begin()` 报错算同步阶段，
  之后的报错算 stub 阶段。4.x 的 `ConnectionError` 已经收回 crate 内部，不能再 match 错误类型，
  所以只能这样按「卡在哪一步」区分；代价是 `Flasher::connect` 内部会再 `begin()` 一次（约 0.4 秒）；
- **记住每个串口上次成功的模式**（`GOOD_MODE`，进程内、按 `端口@VID:PID` 索引），下次先试它：
  像 stub 起不来的板子，第一遍约 5 秒，第二遍直接走 ROM，一两秒就通；
- 高速档（默认 460800）在握手成功之后单独切，**切速失败只降速、不判死**：drop 后先按 115200 重连，
  不行再按请求的速率重连（芯片可能已经切过去了），拿到能用的链接就继续烧；
- 日志里打印串口的 VID/PID（`0x1001` 标注 USB-Serial-JTAG），并用 `log` 桥把 espflash 自己的
  `debug!`（复位策略、boot 模式、切换波特率）转发到页面，前缀 `espflash:`。

#### 擦除整片 Flash：必须是 stub 模式

`EraseFlash`(0xD0) / `EraseRegion`(0xD1) 在 espflash 的 `command.rs` 里被归为 **Stub-only commands**，
ROM 加载器根本没有擦除能力。真机日志完整演示了这件事：

```
11:29:39 已连接（USB-JTAG 复位，ROM 模式）      ← stub 在 `Stub written!` 后失联，只能走 ROM
11:29:39 Writing command: EraseRegion { .. }     ← ROM 不认，30 秒无回应
11:30:10 超时
11:30:10 Writing command: EraseFlash             ← 同样不认，再等几分钟
```

所以：

- 擦除只走 `connect_stub()`（`handshake(..., allow_rom = false)`）：不退回 ROM，
  而是把两种复位方式各试一遍、stub 失联后再整轮重试一次（#1113 那种偶发丢帧重跑常能过）；
- 连不上 stub 就直接报错，并说明「ROM 没有擦除命令、直接烧录会按扇区自动擦」；
  **不再发注定不回答的命令**，也不会再把超时放宽到几十分钟；
- 擦得动时也不走 `erase_flash()`：它只发一条 `EraseFlash`，超时在 crate 里写死 120 秒
  （`ERASE_CHIP_TIMEOUT`），而 32MB NOR 芯片级擦除典型就 100 秒上下，正好卡边界
  （旧日志 `11:09:51 → 11:11:51` 整 120 秒）。改成按容量 **分 1MB 块走 `EraseRegion`**：
  每块 30 秒预算（`30 秒/MB`）且有独立进度，失败就当场报错，不再补发第二条命令。

#### 为什么最后把 espflash 从 3.3 升到 4.7

只改「必须走 stub」还不够：这块 ESP32-P4（USB-Serial-JTAG，PID `0x1001`）在 espflash 3.3 下
stub 永远起不来——`Stub written!` 之后 3 秒一声不响（`Timeout while running command`），
所以擦除功能实际上仍不可用。而同一块板用 esptool 十几秒能擦完 32MB，说明芯片能跑 stub，
问题在 stub 本身。

真机日志（修复后只需 7 秒就能报出准确原因，不再卡几分钟）：

```
12:13:07 Stub written!                            ← espflash 3.3 的通用 P4 stub
12:13:10 Timeout while running command            ← 跳过去之后再无字节
12:13:11 再重试一轮 → 同样 Stub written! → 12:13:14 超时
```

根因在 espflash 的 stub 资源：4.x 把 P4 的 stub 按芯片修订号拆成了两份
（`resources/stubs/esp32p4.toml` 与 `esp32p4rc1.toml`，`rev = major * 100 + minor`，
`< 300` 走 RC1，与 esptool 的选择一致），3.3 只有一份通用 P4 stub。升级后，
连接时会先读芯片修订号、再选对应 stub。迁移代价：`Flasher::connect` 改成先建 `Connection`、
`Segment` 取代 `RomSegment`、`ProgressCallbacks::finish(skipped)` 多了参数、
`ConnectionError` 不再对外公开（所以改用「卡在哪一步」判断阶段）。

提醒：整片擦除不是烧录的前置步骤，直接烧录会按扇区自动擦除用到的范围。

排障顺序：先看日志里 `espflash:` 开头的行定位卡在哪一步，再试按住 BOOT 后点烧录，最后把波特率手改成 115200。

依赖上有一个必须记住的锁：espflash 的 `serialport` feature 要 `toml ^0.8.19`，而 Linux-only 的
`glib-macros 0.18.5` 会把 `proc-macro-crate` 升到 2.x，后者把 `toml_datetime` 钉死为 `0.6.3`，整张依赖图就解不出来。
现状是 `glib-macros 0.18.2` + `toml 0.8.23`（0.8.19 与 serde 1.0.229 编译不兼容）。
**升级 tauri 或跑 `cargo update` 后若又报 `toml_datetime` 冲突，先把这两个版本按上面的组合压回去。**
另外 espflash 4.7 自己声明 `rust-version = 1.95`，`src-tauri/Cargo.toml` 的 `rust-version` 跟着抬到 1.95。

### 4.6 TCP / UDP 通信：一个页面，协议下拉切换

Qt 版把 TCP 与 UDP 拆成两个 tab，可两边的发送区、终端、统计、醒目匹配几乎一模一样。
这里合成一页：第一行两个下拉选「协议」（TCP / UDP）与「工作模式」（客户端 / 服务端），
下面按协议展开各自的地址输入，收发终端和 5 行发送配置由两个协议共用。

- **切换协议前必须先停**：启动中 / 已建立时两个下拉都置灰，断开或停止之后才能换协议，
  所以同一时刻只会有一条 TCP 链路或一个 UDP socket，两类事件不会混进同一个终端。
- **地址区按组合展开**：TCP 客户端是「服务器地址 + 端口」，服务端换成「监听地址 + 端口 + 最大连接」；
  UDP 固定有「本地地址 + 本地端口」，客户端多一排「远程地址 + 远程端口」与广播 / 组播开关，
  服务端把远程行换成提示「发送给最近一次收到报文的来源」。
- **终端是共用的**：接收行带 `来自 地址:端口:`，发送行带 `→ 地址:端口`（TCP 服务端是 `→ N 个客户端`）；
  两个协议的接收 chunk 形状相同（`ts` / `len` / `hex` / `text` / `from`），前端只合成一种 `rx` 记录。

TCP 侧（`src-tauri/src/tcp_client.rs`，只用 `std::net`）：

```
src-tauri/src/tcp_client.rs      连接 / 监听 / 读线程 / 发送，只用 std::net
  ├─ connect：to_socket_addrs 解析 → connect_timeout(2s) → nodelay + read_timeout(200ms)
  ├─ listen：bind → 非阻塞 → accept 轮询（100ms），每个客户端一条读线程
  ├─ 读线程：200ms 轮询 read(4096)，每包 emit `tcp://data`（ts / len / hex / text / from）
  ├─ 写端：客户端 Arc<Mutex<TcpStream>>；服务端广播给所有在线客户端
  └─ stop：置停止位 → shutdown → join（客户端 1 条，服务端 N+1 条）
```

- **连接超时 2 秒**，与 Qt 版一致；**不提供「取消连接」**：Windows 上阻塞中的 `connect` 中断不干净，
  最多也就等 2 秒，不如不放这个点了没反应的按钮。服务端启动同理，只显示「启动中…」。
- **服务端发送是广播**：写给所有在线客户端，回执里的 `targets` 就是成功数，终端记成 `→ N 个客户端 内容`；
  没人接入时报「还没有客户端连接，无法发送」。单个客户端写失败只跳过它，**不会停掉监听**
  （客户端模式写失败则必须收掉连接：半包已经上线，这条流不可信）。
- **接收要标来源**：服务端模式下每行读线程带上自己的 `地址:端口`，终端显示 `来自 x:port: 内容`，
  同时发 `tcp://peer` 事件（connected / disconnected / rejected）更新状态栏的客户端数。
- **最大连接是硬上限**：Qt 版把它当 `listen(backlog)` 传，实际拦不住多余连接；这里在线数到顶就
  关闭新连接并在终端记一条「已达最大连接数，拒绝 x」（默认 5，上限 128）。
- 停止服务端时只置停止位并 join，不再逐条记「客户端断开」——这些客户端是被我们主动踢掉的。

UDP 侧（`src-tauri/src/udp_socket.rs`，同样只用 `std::net`）：

```
src-tauri/src/udp_socket.rs      绑定 / 读线程 / 发送，只用 std::net
  ├─ start：bind 本地地址端口（0 = 系统分配）→ 可选 set_broadcast / join_multicast_v4 + TTL 1
  ├─ 读线程：200ms 轮询 recv_from(4096)，每报 emit `udp://data`（ts / len / hex / text / from）
  ├─ 写端：Arc<UdpSocket>，udp_send 在 spawn_blocking 里 send_to
  └─ stop：置停止位 → join 读线程（UDP 没有 shutdown，靠读超时退出，最多等 200ms）
```

- **广播和组播在 Qt 版只是两个勾选框**：既不设 `SO_BROADCAST` 也不 join 组播组，勾了等于没勾。
  这里补成真实现：开广播设 `set_broadcast`，开组播 join 组 + TTL 固定 1（调试工具不跨网段）；
  两者互斥——同时勾没有额外语义，还容易让人以为地址栏会被自动改写。
- **服务端模式不再只能收**：远程地址留空时后端回给最近一次收到报文的来源；
  客户端模式仍发给界面填的远程地址。Qt 版服务端模式把远程输入框藏起来，等于只能看不能答。
- **组播发送目标 = 组地址 : 远程端口**（客户端）/ **组地址 : 实际绑定端口**（服务端），
  因为组成员的收与发都在同一个组端口上。
- 本地端口填 **0** 表示由系统分配，启动后状态灯显示的是实际绑定的 `地址:端口`。

两端共用的部分：

- **发送固定 5 行**，每行独立：数据、间隔（ms）、`ASCII` / `HEX`、自动发送、发送按钮。
  HEX 解析等价于 Python 的 `bytes.fromhex`（忽略空白与逗号，奇数位 / 非法字符给中文提示）；
  发送回执由 Rust 返回实际字节（TCP 是 `len` / `hex` / `text` / `targets`，UDP 是 `send_to` 后的 `to`），
  界面直接回显，不在 UI 侧再解析一遍。
- **自动发送**用 50ms 滴答 + 每行各自的到期时间，改别的行不会重置正在跑的定时器；
  勾上后先等满一个间隔再发第一包；内容为空或发送失败会**自动关掉该行的自动发送**，
  避免每秒刷同一条错误。
- **接收区**上限 2000 行，超出从头丢；行数 / 总计 / 速率每秒结算一次（总计在「清空」后继续累计，
  与 Qt 版一致）；上滚自动关自动滚动、滚到底自动恢复。
- **配色**：接收绿、发送蓝、提示黄、错误红；醒目匹配只改字色加粗，都沿用日志页的终端令牌。
- **偏差点**：「显示接收」关闭后只停界面回显，字节统计照常累加（两个协议一致；Qt 版会把统计一起停掉）。
- 地址 / 端口都可编辑并保留下拉历史（上限 20 条），链路建立后置灰；偏好统一存 localStorage
  `multifun-serial.comm.prefs.v1`（协议、模式、两套地址与 5 行配置），首次打开会从旧的
  `tcp.prefs.v1` / `udp.prefs.v1` 合并迁移一次；**自动发送不会被恢复**，免得一开机就往设备连发指令。

## 5. 与 Qt 版的对齐矩阵

| 功能 | 状态 | 说明 |
|---|---|---|
| 串口枚举 + 热插拔 | 已实现 | 500ms 轮询，COM 号降序，带 VID/PID |
| 通用串口（非 ESP 格式） | 已实现 | 不解析前缀，切包三选一，关键字过滤（见 4.1） |
| HEX 视图 | 已实现 | 基于 Rust 侧无损 `hex`，行尾可见，不加 ASCII 侧栏 |
| 时间戳显示 | 已实现 | 服务端切包时打 `ts`（毫秒），可开关，不影响保存的文件 |
| 日志颜色自定义 | 已实现 | 弹窗内改时间戳 / 正文色 + 「统一正文颜色」，即时预览、存 localStorage |
| 自动换行 | 已实现 | 仍走虚拟滚动，行高按等宽字符宽度反推 |
| 右键菜单 | 已实现 | 复制选中 / 复制全部（跟随当前视图）/ 导出 .bin / 清空 |
| 打开 / 关闭串口 | 已实现 | 复位默认开启；只脉冲 EN（esptool `hard_reset`），DTR 全程为高 |
| 波特率（含 921600 / 1000000） | 已实现 | 11 档建议值，且可直接手输任意整数 |
| 级别过滤 | 已实现 | Rust 侧过滤，chip 交互 |
| 日志名过滤（逗号分隔） | 已实现 | 精确匹配，无日志名的行放行 |
| 自动保存 | 已实现 | `logs/年-月/ESP32_Log_时间戳.txt`，格式跟随视图（HEX 时 `_hex`） |
| 单次保存 | 已实现 | 系统保存对话框（plugin-dialog），内容同样跟随 HEX / 时间戳视图 |
| 打开日志目录 | 已实现 | explorer / open / xdg-open |
| 行数 / 总计 / 速率 | 已实现 | 1s 推送一次 |
| 自动滚动（上滚自动关闭） | 已实现 | 与 Qt 版行为一致 |
| 查找 + 高亮 + 结果面板跳转 | 已实现 | 显式触发，命中行下标基于当前缓冲 |
| 清空 | 已实现 | 同时重置统计 |
| 导入日志文件 | **未实现** | P2；需补文件读取 + 回放 |
| 串口黑名单 | **未实现** | Rust 侧已预留 `blacklist` 状态，待接设置 UI |
| 字体大小设置 | **未实现** | P2；当前固定 13px 等宽 |
| 旧 `config.json` 迁移 | **未实现** | P2；当前偏好存 WebView localStorage |
| 搜索高亮字号 +3 | **有意改动** | 变字号会破坏虚拟滚动定高，改为黄底/橙底标记 |
| 固件合并：自动扫描 build | 已实现 | 优先 `flasher_args.json`，回退常见文件名（见 4.4） |
| 固件合并：芯片 / Flash / 频率 | 已实现 | 读 `extra_esptool_args` 与 `flash_settings`，列表底部展示 |
| 固件合并：版本号 / 项目名 | 已实现 | 从 `CMakeLists.txt` 的 `set(PROJECT_VER ...)` / `project(...)` 解析 |
| 固件合并：输出文件名格式 | 已实现 | 日期 / 版本号 / 项目名三个开关，预览用 `X.Y.Z` 占位 |
| 固件合并：表格增删改 | 已实现 | 偏移可手改、文件可换、行可增删，空行跳过 |
| 固件合并：拖放目录 | 已实现 | Tauri 全局拖放事件，按页面 `active` 门控 |
| 固件合并：执行日志 | 已实现 | 四色（info / warn / error / ok），最多留 500 行 |
| 固件合并：配置持久化 | 已实现 | localStorage，替代旧版 `config.json` |
| ESP32 烧录：烧录 / 擦除 / 检测 | 已实现 | espflash 直连串口，替代拼 esptool 命令行（见 4.5） |
| ESP32 烧录：进度与日志 | 已实现 | 结构化事件；按字节加权 + 50ms 节流；日志最多 500 行 |
| ESP32 烧录：芯片信息 | 部分实现 | Flash 模式 / 器件 ID / 电压是 eFuse 项，espflash 不读，显示「—」 |
| ESP32 烧录：ESP32-C61 | **有意改动** | espflash 只认 esp32/c2/c3/c6/h2/p4/s2/s3，下拉里去掉 C61 |
| 通信页：协议 / 模式切换 | 已实现 | 同一页两个下拉切换 TCP / UDP 与客户端 / 服务端；运行中置灰，切换前必须先停（见 4.6） |
| TCP 客户端：连接 / 断开 | 已实现 | 2 秒超时；对端关闭或写失败会自动收掉连接（见 4.6） |
| TCP 服务端：监听 / 多客户端 | 已实现 | 非阻塞 accept 轮询，每客户端一条读线程，接收带来源 |
| TCP 服务端：广播发送 | 已实现 | 发给所有在线客户端，回执 `targets` 记成「→ N 个客户端」 |
| TCP 服务端：最大连接 | **有意改动** | Qt 版当 backlog 传、拦不住；这里做成硬上限，超了直接拒 |
| TCP 客户端：5 行发送 | 已实现 | 每行独立间隔 / ASCII·HEX / 自动发送，失败自动停 |
| TCP 客户端：接收区 | 已实现 | 2000 行上限、行数/总计/速率、时间戳、HEX 视图、醒目匹配 |
| TCP 客户端：地址 / 端口历史 | 已实现 | 可编辑下拉，上限 20 条，连接后置灰 |
| TCP 客户端：不显示接收 | **有意改动** | 只停界面回显，字节统计照常累计 |
| UDP 通信：绑定 / 停止 | 已实现 | 本地端口 0 = 系统分配；运行中配置置灰（见 4.6） |
| UDP 通信：客户端 / 服务端 | 已实现 | 服务端模式回给最近来源；Qt 版服务端只能收不能回 |
| UDP 通信：广播 / 组播 | **有意改动** | Qt 版两个勾选框都没生效；这里真正设 SO_BROADCAST / join 组播组 |
| UDP 通信：5 行发送 / 接收区 | 已实现 | 与 TCP 共用同一个终端：间隔、ASCII·HEX、自动发送、2000 行、醒目匹配 |

## 6. 已知限制

### 6.1 复位时序（按 esptool 源码实现）

电平约定（esptool 源码注释原文）：`RTS = EN`（active low，True = 0V = 芯片处于复位），
`DTR = GPIO0`（active low，True = 0V = 进下载模式）。

Qt 版（`esp32_log_tab.py`）打开串口时做的是“两根线同时拉高 → 等 500ms → 同时归零”。
它能把芯片带起来，但依赖“DTR 先释放、RTS 后释放”这个隐含顺序，任何一次写入丢包或
重排序（Windows 的 `usbser.sys` 就不会单独下发 RTS 变化）都会变成“EN 释放时 GPIO0 仍为低”。
那就是 `rst:0x17 (CHIP_USB_UART_RESET)` + `boot:0x5 (DOWNLOAD)` + `waiting for download`。

本项目的行为：

1. **复位默认开启**（与 Qt 版一致：复位一次才能拿到启动日志），可手动关。
2. 时序只用 esptool 的 `hard_reset`：**只脉冲 EN，DTR 全程为 false**（GPIO0 保持高）。
   每一次 RTS 写入后紧跟一次 DTR 写入，绕过 `usbser.sys` 不下发 RTS 的问题。
3. 原生 USB 口（Espressif VID `0x303A`）复位后设备会重新枚举，旧句柄会失效，
   所以复位后自动关掉重开（最多重试 8 × 250ms），而不是拿着死句柄一直读超时。

### 6.2 选错串口也可能没数据

P4 开发板通常同时枚举两个口：UART 桥（日志口）与芯片原生 USB（USB-Serial-JTAG）。
页面里原生 USB 口会标注「芯片原生 USB，非 UART 桥」。日志不输出时优先换另一个 COM 口试。

### 6.3 仍无数据时的排查顺序

1. 确认「打开时复位设备」是勾上的（芯片停在 ROM 里不会主动输出）；
2. 给板子断电重上电（脱离 download 模式）；
3. 换一个 COM 口（UART 桥 ↔ 原生 USB）；
4. 看页面 6 秒无数据横幅与状态栏字节数，确认到底是“没收到”还是“被过滤掉了”。

### 6.4 普通串口「字节在涨、行数不动」

状态栏「总计」在涨但「行数」一直是 0，说明字节收到了，只是切不出包。按顺序查：

1. 数据源是不是还停在「ESP-IDF 日志」——那样只认 `\n`，只用 `\r` 结尾的设备永远切不出来；
2. 切包策略换成「按空闲超时」——二进制协议通常没有任何分隔符；
3. 定长帧就选「按固定字节数」，并把每包字节数填对。

残行缓存的硬上限是 256KB，攒满会整块丢弃并计入 `dropped`，
所以上述情况不会把内存吃掉，但日志会“凭空消失”。

### 6.5 其他

- **WebView2 不支持 Web Serial**，所以串口必须由 Rust 侧持有；纯浏览器模式下只能看模拟数据。
- `npm run build:web` 与 `cargo check` 各自独立通过，但 `tauri build` 还需要安装
  [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 与 MSVC 生成工具。
- 无代码签名时 Windows 会弹 SmartScreen 提示，与现有 PyInstaller 产物一致。
- 双程序同时运行会争用同一 COM 口，后打开的一方会收到"打开串口失败"。

## 7. 下一步（按 ROI 排序）

- **P2**：合并页产出后直接送到烧录页（当前需要手动选 bin）。
- **P2**：导入日志文件、串口黑名单、字体设置、旧 `config.json` 首次导入。
- **P2**：定长切包的帧头 / 帧尾校验（当前只按字节数硬切，错位后不会自动重新同步）。
- **P2**：常用切包方案（波特率 + 策略 + 关键字）存成可复用的「会话模板」。
- **P3**：NSIS 安装包（当前 CI 只出 MSI）。
- **P3**：TCP / UDP 收发记录导出（文本或原始字节），以及收发历史自动保存。

## 8. CI 打包

`v*` 标签会同时触发两个 workflow，产物互不重叠：

| workflow | 打标签时的产物 | 用途 |
|---|---|---|
| `release.yml` | `TcpTool.exe` + `Multifun Serial_x.y.z_x64_*.msi` | 挂到 GitHub Release 页 |
| `build-windows.yml` | `multifun-serial-msi` artifact | 在 Actions 页直接下载 / 验证 |

MSI 由 `npm run tauri -- build --bundles msi` 产出，路径
`src-tauri/target/release/bundle/msi/*.msi`；`.msi` 里已包含 WebView2 引导与快捷方式。
安装界面语言由 `bundle > windows > wix > language` 控制（现为 `zh-CN`，ProductLanguage 2052），
产物文件名会带 `_zh-CN`；默认不写这个键就是 `en-US`。
日常 push / PR 也会编译（带 rust-cache，增量一两分钟）；打标签时由 `release.yml` 统一构建，
`build-windows.yml` 里的同一个 job 自动跳过，不会重复编两遍。
`build-windows.yml` 的两个 job 是串行的：先编 MSI（Rust 编译最容易出问题，先暴露），
成功后才打 `TcpTool.exe`；MSI 失败则 Python 包不再构建。

版本号只有一个真相源：`package.json` 的 `version`（改版本只改这一处，然后 `npm run sync:version`
或任意一次 `npm run dev` / `npm run tauri -- build`，`scripts/sync-version.mjs` 会把数字写进
`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml`，同步动作挂在 npm 的 `predev` / `prebuild` / `pretauri` 钩子上）。
MSI 的 ProductVersion 与安装包名、侧栏显示的 `v2.0.2`、窗口标题背后的 `PackageInfo` 都来自同步后的
`tauri.conf.json`；侧栏是直接 `import` 这个文件，浏览器预览时由 `main.tsx` 改 `document.title`。
窗口标题显示为 `Multifun Serial 串口工具 v2.0.2`（Rust 侧 `setup` 用 `package_info().version` 拼在配置标题后面）。
以前 `package.json` / `tauri.conf.json` / `Cargo.toml` 各写一份，结果 2.0.2 发版时窗口还显示 v2.0.0，所以改成单一来源。
标签大小写现在都能用（`v*` 和 `V*`），手动触发时不会改写版本，MSI 就沿用文件里写死的值。
