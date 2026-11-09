from PySide6 import QtWidgets, QtCore, QtGui
import os
import re
import threading
import sys
import time

from app.log_view import LogView

try:
    import serial
    import serial.tools.list_ports
    SERIAL_AVAILABLE = True
except Exception:
    SERIAL_AVAILABLE = False

# esptool 是乐鑫官方烧录库。
# 导入 esptool 约需 0.6s，绝不能放在启动路径上：
# 这里只用 find_spec 探测是否安装，真正 import 推迟到第一次烧录时。
try:
    from importlib.util import find_spec as _find_spec
    ESPTOOL_AVAILABLE = _find_spec('esptool') is not None
except Exception:
    ESPTOOL_AVAILABLE = False

try:
    from importlib.metadata import version as _dist_version
    ESPTOOL_VERSION = _dist_version('esptool')
except Exception:
    ESPTOOL_VERSION = ''

_ESPTOOL_MOD = None


def _load_esptool():
    """延迟导入 esptool（首次烧录时才付出导入开销）"""
    global _ESPTOOL_MOD
    if _ESPTOOL_MOD is None:
        import esptool as _m
        _ESPTOOL_MOD = _m
    return _ESPTOOL_MOD

# Windows USB 设备变化监听
if sys.platform == 'win32':
    try:
        import ctypes
        from ctypes import wintypes
        WINDOWS_USB_AVAILABLE = True
    except Exception:
        WINDOWS_USB_AVAILABLE = False
else:
    WINDOWS_USB_AVAILABLE = False


class USBDeviceMonitor(QtCore.QAbstractNativeEventFilter):
    """Windows USB 设备插拔监听器"""

    # Windows 消息常量
    WM_DEVICECHANGE = 0x0219
    DBT_DEVICEARRIVAL = 0x8000
    DBT_DEVICEREMOVECOMPLETE = 0x8004

    def __init__(self, callback):
        super().__init__()
        self.callback = callback

    def nativeEventFilter(self, eventType, message):
        if WINDOWS_USB_AVAILABLE and sys.platform == 'win32':
            try:
                if eventType == "windows_generic_MSG" or eventType == "windows_dispatcher_MSG":
                    msg = ctypes.wintypes.MSG.from_address(int(message))
                    if msg.message == self.WM_DEVICECHANGE:
                        if msg.wParam in (self.DBT_DEVICEARRIVAL, self.DBT_DEVICEREMOVECOMPLETE):
                            # USB 设备插入或拔出
                            QtCore.QTimer.singleShot(500, self.callback)
            except Exception:
                pass
        return False, 0


class ESP32FlashTab(QtWidgets.QWidget):
    """ESP32 烧录页

    设计：本页不做常驻串口连接。点「烧录 / 擦除 / 检测芯片 / 烧密钥」时由 esptool
    自己打开串口，操作结束自动释放，因此不存在"串口被占用关不掉"的问题。
    需要看串口输出请用 ESP32 Log 页面。
    """

    changed = QtCore.Signal()

    # 与 esptool --chip 参数取值保持一致
    CHIP_OPTIONS = [
        ('auto', '自动检测'),
        ('esp32', 'ESP32'),
        ('esp32s2', 'ESP32-S2'),
        ('esp32s3', 'ESP32-S3'),
        ('esp32c2', 'ESP32-C2'),
        ('esp32c3', 'ESP32-C3'),
        ('esp32c6', 'ESP32-C6'),
        ('esp32c61', 'ESP32-C61'),
        ('esp32h2', 'ESP32-H2'),
        ('esp32p4', 'ESP32-P4'),
    ]

    def __init__(self, get_global_format, get_serial_blacklist=None, parent=None):
        super().__init__(parent)
        self.get_global_format = get_global_format
        self.get_serial_blacklist = get_serial_blacklist or (lambda: [])
        self.usb_monitor = None
        self.previous_ports = set()   # 记录之前的端口列表
        self.flashing = False         # 是否正在烧录/擦除，期间禁止重复触发
        self.ui_theme = 'dark'        # 由主窗口 set_theme 同步
        self._esptool_lock = threading.Lock()  # esptool 会重定向全局 stdout，需串行化
        self._build_ui()
        self._setup_usb_monitor()

    # ---------- UI ----------

    @staticmethod
    def _button(text, tooltip=None, big=False):
        """自适应宽度按钮：宽度由字体度量算出来，避免固定像素在高 DPI 下被文字撑破"""
        btn = QtWidgets.QPushButton(text)
        if big:
            # 主操作按钮：更高更宽更醒目（样式在 theme.py 的 QPushButton#bigBtn）
            btn.setObjectName('bigBtn')
            btn.setSizePolicy(QtWidgets.QSizePolicy.Policy.Fixed,
                              QtWidgets.QSizePolicy.Policy.Fixed)
        else:
            btn.setSizePolicy(QtWidgets.QSizePolicy.Policy.Fixed,
                              QtWidgets.QSizePolicy.Policy.Fixed)
        if tooltip:
            btn.setToolTip(tooltip)
        return btn

    def _build_ui(self):
        main_layout = QtWidgets.QVBoxLayout(self)
        main_layout.setContentsMargins(8, 4, 8, 8)
        main_layout.setSpacing(12)

        # === 1. 连接参数 ===
        serial_group = QtWidgets.QGroupBox('串口设置')
        serial_layout = QtWidgets.QHBoxLayout(serial_group)
        serial_layout.setContentsMargins(8, 8, 8, 8)
        serial_layout.setSpacing(6)

        serial_layout.addWidget(QtWidgets.QLabel('端口号:'))
        self.port_combo = QtWidgets.QComboBox()
        self.port_combo.setMinimumWidth(150)
        self.port_combo.setToolTip('烧录时自动连接该端口，结束后自动释放')
        serial_layout.addWidget(self.port_combo)

        self.refresh_btn = self._button('刷新', '重新扫描串口')
        serial_layout.addWidget(self.refresh_btn)

        serial_layout.addWidget(QtWidgets.QLabel('波特率:'))
        self.baud_combo = QtWidgets.QComboBox()
        self.baud_combo.addItems(['115200', '230400', '460800', '921600'])
        self.baud_combo.setCurrentText('460800')
        serial_layout.addWidget(self.baud_combo)

        serial_layout.addWidget(QtWidgets.QLabel('芯片型号:'))
        self.chip_combo = QtWidgets.QComboBox()
        for val, label in self.CHIP_OPTIONS:
            self.chip_combo.addItem(label, val)
        self.chip_combo.setMinimumWidth(110)
        self.chip_combo.setToolTip('选择目标芯片；不确定时用「自动检测」')
        serial_layout.addWidget(self.chip_combo)

        serial_layout.addStretch(1)

        self.status_label = QtWidgets.QLabel('就绪')
        self.status_label.setStyleSheet('color: gray; font-weight: bold;')
        serial_layout.addWidget(self.status_label)

        main_layout.addWidget(serial_group)

        # === 2. 烧录文件 ===
        download_group = QtWidgets.QGroupBox('下载功能')
        download_layout = QtWidgets.QVBoxLayout(download_group)
        download_layout.setContentsMargins(8, 8, 8, 8)
        download_layout.setSpacing(4)

        self.flash_rows = []
        for i in range(4):
            row_widget = QtWidgets.QWidget()
            row_layout = QtWidgets.QHBoxLayout(row_widget)
            row_layout.setContentsMargins(0, 0, 0, 0)
            row_layout.setSpacing(6)

            checkbox = QtWidgets.QCheckBox()
            checkbox.setChecked(i == 0)  # 默认第一行选中
            row_layout.addWidget(checkbox)

            row_layout.addWidget(QtWidgets.QLabel('烧录地址:'))
            addr_edit = QtWidgets.QLineEdit()
            addr_edit.setPlaceholderText('0x0')
            addr_edit.setFixedWidth(100)
            # 默认 0x0：通常烧录的是合并后的整片固件
            addr_edit.setText('0x0')
            row_layout.addWidget(addr_edit)

            row_layout.addWidget(QtWidgets.QLabel('Bin文件:'))
            bin_edit = QtWidgets.QLineEdit()
            bin_edit.setPlaceholderText('选择bin文件路径')
            row_layout.addWidget(bin_edit, 1)

            browse_btn = self._button('浏览...', '选择 bin 文件')
            row_layout.addWidget(browse_btn)

            download_layout.addWidget(row_widget)

            self.flash_rows.append({
                'checkbox': checkbox,
                'addr_edit': addr_edit,
                'bin_edit': bin_edit,
                'browse_btn': browse_btn
            })

            browse_btn.clicked.connect(lambda checked=False, idx=i: self._browse_bin_file(idx))

        # 操作按钮：加大加长，一行只放按钮
        bottom_layout = QtWidgets.QHBoxLayout()
        bottom_layout.setSpacing(14)

        self.erase_btn = self._button('擦除', '擦除整片 Flash', big=True)
        bottom_layout.addWidget(self.erase_btn)

        self.flash_btn = self._button('烧录', '烧录选中的固件文件', big=True)
        self.flash_btn.setProperty('primary', True)  # 主操作：走强调色样式
        bottom_layout.addWidget(self.flash_btn)

        bottom_layout.addStretch(1)
        download_layout.addLayout(bottom_layout)

        # 进度条独立成一行，百分比放在进度条右侧
        progress_layout = QtWidgets.QHBoxLayout()
        progress_layout.setSpacing(8)
        progress_layout.addWidget(QtWidgets.QLabel('进度:'))
        self.progress_bar = QtWidgets.QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        progress_layout.addWidget(self.progress_bar, 1)

        self.progress_value = QtWidgets.QLabel('0%')
        self.progress_value.setObjectName('progressValue')
        self.progress_value.setMinimumWidth(52)
        self.progress_value.setAlignment(QtCore.Qt.AlignmentFlag.AlignRight |
                                         QtCore.Qt.AlignmentFlag.AlignVCenter)
        progress_layout.addWidget(self.progress_value)
        download_layout.addLayout(progress_layout)

        main_layout.addWidget(download_group)

        # === 3. 芯片信息：结构化展示检测结果，不再刷一屏原始日志 ===
        chip_group = QtWidgets.QGroupBox('芯片信息')
        chip_layout = QtWidgets.QVBoxLayout(chip_group)
        chip_layout.setContentsMargins(8, 4, 8, 8)
        chip_layout.setSpacing(6)

        detect_row = QtWidgets.QHBoxLayout()
        self.chip_hint_label = QtWidgets.QLabel('点击「检测芯片」读取芯片与 Flash 信息')
        self.chip_hint_label.setObjectName('fieldLabel')
        detect_row.addWidget(self.chip_hint_label)
        detect_row.addStretch(1)
        self.detect_btn = self._button('检测芯片', '读取芯片型号、MAC 与 Flash 容量')
        detect_row.addWidget(self.detect_btn)
        chip_layout.addLayout(detect_row)

        grid = QtWidgets.QGridLayout()
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(3)

        def _field(name):
            label = QtWidgets.QLabel(name)
            label.setObjectName('fieldLabel')
            value = QtWidgets.QLabel('—')
            value.setObjectName('fieldValue')
            # 鼠标可划选，选中后 Ctrl+C 即可复制
            value.setTextInteractionFlags(
                QtCore.Qt.TextInteractionFlag.TextSelectableByMouse |
                QtCore.Qt.TextInteractionFlag.TextSelectableByKeyboard)
            value.setCursor(QtCore.Qt.CursorShape.IBeamCursor)
            return label, value

        self.chip_fields = {}
        pairs = [('chip', '芯片型号:'), ('crystal', '晶振频率:'),
                 ('usb', 'USB 模式:'), ('mac', 'MAC 地址:'),
                 ('flash_size', 'Flash 容量:'), ('flash_mode', 'Flash 模式:'),
                 ('flash_id', '厂商/器件 ID:'), ('flash_voltage', 'Flash 电压:')]

        r = 0
        for i in range(0, len(pairs), 2):
            for c, (key, text) in enumerate(pairs[i:i + 2]):
                label, value = _field(text)
                grid.addWidget(label, r, c * 2)
                grid.addWidget(value, r, c * 2 + 1)
                self.chip_fields[key] = value
            r += 1

        # 功能特性很长，单独占一整行
        label, value = _field('功能特性:')
        grid.addWidget(label, r, 0)
        grid.addWidget(value, r, 1, 1, 3)
        self.chip_fields['features'] = value
        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(3, 1)

        chip_layout.addLayout(grid)
        main_layout.addWidget(chip_group)

        # === 3. 操作日志：只记烧录/擦除/检测的过程与结果，不显示串口数据 ===
        log_group = QtWidgets.QGroupBox('操作日志')
        log_layout = QtWidgets.QVBoxLayout(log_group)
        log_layout.setContentsMargins(0, 2, 0, 0)
        log_layout.setSpacing(0)

        self.log_view = LogView(theme=self.ui_theme)
        log_layout.addWidget(self.log_view, 1)

        main_layout.addWidget(log_group, 1)

        # 连接信号
        self.refresh_btn.clicked.connect(self._refresh_ports)
        self.erase_btn.clicked.connect(self._erase_flash)
        self.flash_btn.clicked.connect(self._flash_firmware)
        self.detect_btn.clicked.connect(self._detect_chip)

        # 初始化串口列表
        self._refresh_ports()

        # 环境就绪提示
        if ESPTOOL_AVAILABLE:
            self._log_operation('就绪，点烧录会自动连接串口')
        else:
            self._set_status('环境异常', 'red')
            self._log_operation('未找到烧录组件，烧录/擦除不可用', 'red')

    # ---------- 端口列表 ----------

    def _refresh_ports(self, auto_select_new=False, quiet=False):
        """刷新串口列表

        Args:
            auto_select_new: 是否自动选中新插入的设备
            quiet: 静默刷新（USB 热插拔触发时用，不刷新底部提示）
        """
        if not SERIAL_AVAILABLE:
            if not quiet:
                self._set_hint('错误: 串口库不可用', 'red')
            return
        try:
            bl = list(self.get_serial_blacklist() or [])

            current_ports = set()
            port_infos = []
            for info in serial.tools.list_ports.comports():
                if info.device not in bl:
                    current_ports.add(info.device)
                    port_infos.append(info)

            # 记录当前选中项，刷新后尽量保持
            keep = self.port_combo.currentData()
            new_ports = current_ports - self.previous_ports

            self.port_combo.blockSignals(True)
            self.port_combo.clear()
            for info in port_infos:
                label = f"{info.device} - {getattr(info, 'description', None) or getattr(info, 'hwid', '')}"
                self.port_combo.addItem(label, info.device)
            self.port_combo.blockSignals(False)

            target = None
            if auto_select_new and new_ports:
                target = sorted(new_ports)[0]      # 优先选中新插入的设备
            elif keep in current_ports:
                target = keep

            if target:
                for i in range(self.port_combo.count()):
                    if self.port_combo.itemData(i) == target:
                        self.port_combo.setCurrentIndex(i)
                        break

            self.previous_ports = current_ports

            if not quiet:
                if port_infos:
                    self._set_hint(f'找到 {len(port_infos)} 个串口', 'gray')
                else:
                    self._set_hint('未找到串口，请检查 USB 线/驱动', 'orange')
        except Exception as e:
            if not quiet:
                self._set_hint(f'刷新串口失败: {e}', 'red')

    def _current_port(self):
        """当前选择的串口名"""
        return self.port_combo.currentData() or ''

    # ---------- 提示 / 状态 ----------

    def _set_status(self, text, color='gray'):
        self.status_label.setText(text)
        self.status_label.setStyleSheet(f'color: {color}; font-weight: bold;')

    def _set_hint(self, text, color='gray'):
        """兼容旧调用：一律写进操作日志"""
        self._log_operation(text, color)

    @QtCore.Slot(str, str)
    def _log_operation(self, text: str, color: str = ''):
        """写一行操作日志

        不指定颜色时跟随正文色（深色主题下不会出现黑字看不见的问题）；
        错误/成功/警告走 VS Code ANSI 配色。
        """
        line = (text or '').rstrip()
        if not line:
            return
        stamp = time.strftime('[%H:%M:%S] ')
        self.log_view.append_line(stamp + line, color)

    def set_theme(self, theme: str):
        self.ui_theme = theme
        self.log_view.set_theme(theme)


    def _ui_log(self, text, color='black'):
        """线程安全的日志输出（工作线程 -> 主线程）"""
        QtCore.QMetaObject.invokeMethod(
            self, '_log_operation', QtCore.Qt.ConnectionType.QueuedConnection,
            QtCore.Q_ARG(str, text), QtCore.Q_ARG(str, color))

    @QtCore.Slot(int)
    def _set_progress_value(self, value):
        """进度条 + 右侧百分比文字同步更新"""
        value = max(0, min(100, int(value)))
        self.progress_bar.setValue(value)
        self.progress_value.setText(f'{value}%')

    def _ui_progress(self, value):
        """线程安全的进度更新（工作线程 -> 主线程）"""
        value = max(0, min(100, int(value)))
        QtCore.QMetaObject.invokeMethod(
            self, '_set_progress_value', QtCore.Qt.ConnectionType.QueuedConnection,
            QtCore.Q_ARG(int, value))

    # ---------- 公共小工具 ----------

    @staticmethod
    def _esptool_cmd(name):
        """esptool 5.x 起子命令与取值改为连字符形式（write_flash -> write-flash）"""
        try:
            major = int(str(ESPTOOL_VERSION).split('.')[0])
        except (ValueError, TypeError):
            major = 4
        return name.replace('_', '-') if major >= 5 else name

    def _esptool_common_args(self):
        """esptool 的连接参数前缀（芯片 / 串口 / 波特率 / 复位方式）"""
        return ['--chip', self.chip_combo.currentData() or 'auto',
                '--port', self._current_port(),
                '--baud', self.baud_combo.currentText(),
                '--before', self._esptool_cmd('default_reset'),
                '--after', self._esptool_cmd('hard_reset')]

    @staticmethod
    def _format_addr(text):
        """把用户输入的地址规范成 0x 开头的十六进制；非法返回 None"""
        t = (text or '').strip().lower()
        if not t:
            return None
        if t.startswith('0x'):
            t = t[2:]
        try:
            return '0x%x' % int(t, 16)
        except ValueError:
            return None

    def _set_busy(self, busy):
        """操作期间锁定控件，避免重复触发"""
        self.flashing = busy
        for w in (self.flash_btn, self.erase_btn, self.detect_btn,
                  self.refresh_btn,
                  self.port_combo, self.baud_combo, self.chip_combo):
            w.setEnabled(not busy)
        for row in self.flash_rows:
            row['browse_btn'].setEnabled(not busy)

    # ---------- 文件选择 ----------

    def _browse_bin_file(self, idx: int):
        """浏览选择bin文件"""
        file_path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self,
            '选择Bin文件',
            '',
            'Bin Files (*.bin);;All Files (*.*)'
        )
        if file_path:
            self.flash_rows[idx]['bin_edit'].setText(file_path)
            self._set_hint(f'选择文件[{idx + 1}]: {file_path}', 'gray')

    # ---------- 烧录 / 擦除 ----------

    def _erase_flash(self):
        """擦除 Flash（无需先打开串口）"""
        if not self._current_port():
            self._set_hint('错误: 未选择串口', 'red')
            return

        reply = QtWidgets.QMessageBox.question(
            self,
            '确认擦除',
            '确定要擦除Flash吗？此操作将清除所有数据！',
            QtWidgets.QMessageBox.StandardButton.Yes | QtWidgets.QMessageBox.StandardButton.No
        )
        if reply != QtWidgets.QMessageBox.StandardButton.Yes:
            return

        if not ESPTOOL_AVAILABLE:
            self._set_hint('错误: 未安装 esptool（pip install esptool）', 'red')
            return

        argv = self._esptool_common_args() + [self._esptool_cmd('erase_flash')]
        self._run_esptool(argv, '擦除 Flash')

    def _flash_firmware(self):
        """烧录固件（无需先打开串口）"""
        port = self._current_port()
        if not port:
            self._set_hint('错误: 未选择串口', 'red')
            return

        # 收集选中的烧录任务
        tasks = []
        for i, row in enumerate(self.flash_rows):
            if not row['checkbox'].isChecked():
                continue
            addr = row['addr_edit'].text().strip()
            bin_path = row['bin_edit'].text().strip()
            if not addr or not bin_path:
                self._set_hint(f'错误: 第{i + 1}行地址或文件路径为空', 'red')
                return
            tasks.append({'index': i + 1, 'addr': addr, 'path': bin_path})

        if not tasks:
            self._set_hint('错误: 请至少选择一个烧录任务', 'red')
            return

        if not ESPTOOL_AVAILABLE:
            self._set_hint('错误: 未安装 esptool（pip install esptool）', 'red')
            return

        addr_args = []
        for task in tasks:
            addr = self._format_addr(task['addr'])
            if addr is None:
                self._set_hint(
                    f'错误: 第{task["index"]}行地址格式不正确: {task["addr"]}'
                    f'（应为 0x1000 这样的十六进制）', 'red')
                return
            if not os.path.isfile(task['path']):
                self._set_hint(f'错误: 第{task["index"]}行文件不存在: {task["path"]}', 'red')
                return
            addr_args.extend([addr, task['path']])

        flash_args = [self._esptool_cmd('write_flash'), '--flash-size', 'detect']
        argv = self._esptool_common_args() + flash_args + addr_args
        self._run_esptool(argv, '烧录固件')

    def _detect_chip(self):
        """读取芯片型号 / MAC / Flash 容量（esptool flash_id）"""
        if not self._current_port():
            self._set_hint('错误: 未选择串口', 'red')
            return
        if not ESPTOOL_AVAILABLE:
            self._set_hint('错误: 未安装 esptool（pip install esptool）', 'red')
            return
        argv = self._esptool_common_args() + [self._esptool_cmd('flash_id')]
        self._run_esptool(argv, '检测芯片')

    # ---------- esptool 执行核心 ----------

    def _run_esptool(self, argv, title):
        """后台线程执行 esptool

        串口由 esptool 自己打开，结束后自动关闭，本页不保留连接。
        """
        if self.flashing:
            self._set_hint('正在执行上一个操作，请稍候', 'orange')
            return

        try:
            if not ESPTOOL_AVAILABLE:
                raise ImportError('未安装 esptool（pip install esptool）')
            runner = _load_esptool().main
        except Exception as e:
            self._set_hint(f'错误: {e}', 'red')
            return

        port = self._current_port()
        if not port:
            self._set_hint('错误: 未选择串口', 'red')
            return

        self._set_status(f'{title}中...', 'orange')
        self._set_hint(f'{title}：连接 {port} @ {self.baud_combo.currentText()}')
        self._set_busy(True)
        self._set_progress_value(0)

        def worker():
            import io

            pct_re = re.compile(r'(\d+(?:\.\d+)?)\s*%')
            ui_log = self._ui_log
            ui_progress = self._ui_progress
            collected = []          # 全量输出行，检测芯片用它解析结构化字段

            class _Stream(io.TextIOBase):
                """逐行转发 esptool 的 stdout / stderr"""

                def __init__(self):
                    super().__init__()
                    self._buf = ''
                    self._lock = threading.Lock()

                def write(self, s):
                    with self._lock:
                        self._buf += s
                        while '\n' in self._buf:
                            line, self._buf = self._buf.split('\n', 1)
                            self._emit(line)
                    return len(s)

                def flush(self):
                    pass

                def isatty(self):
                    return False

                def _emit(self, line):
                    line = line.rstrip()
                    if not line:
                        return
                    # 纯进度点/横线行不写日志，避免刷屏
                    if line.strip(' .-') == '':
                        return
                    m = pct_re.search(line)
                    if m:
                        try:
                            ui_progress(int(float(m.group(1))))
                        except Exception:
                            pass
                        # esptool 的进度条行（一堆等号）不写日志
                        if line.count('=') > 3:
                            return
                    collected.append(line)
                    ui_log(line)

            with self._esptool_lock:
                old_out, old_err = sys.stdout, sys.stderr
                stream = _Stream()
                sys.stdout = stream
                sys.stderr = stream
                rc = 0
                try:
                    runner(argv)
                except SystemExit as e:
                    rc = e.code if isinstance(e.code, int) else 0
                except Exception as e:
                    ui_log(f'烧录异常: {e}', 'red')
                    rc = -1
                finally:
                    try:
                        sys.stdout, sys.stderr = old_out, old_err
                    except Exception:
                        pass

            QtCore.QMetaObject.invokeMethod(
                self, '_on_esptool_done', QtCore.Qt.ConnectionType.QueuedConnection,
                QtCore.Q_ARG(int, rc), QtCore.Q_ARG(str, title),
                QtCore.Q_ARG(str, '\n'.join(collected)))

        threading.Thread(target=worker, daemon=True).start()

    # esptool 输出 -> 芯片信息字段 的正则（按 esptool 5.x 实际打印格式）
    _FIELD_PATTERNS = [
        ('chip', r'Chip type:\s*(.+)'),
        ('features', r'Features:\s*(.+)'),
        ('crystal', r'Crystal frequency:\s*(.+)'),
        ('usb', r'USB mode:\s*(.+)'),
        ('mac', r'MAC:\s*([0-9A-Fa-f:]{11,17})'),
        ('flash_size', r'Detected flash size:\s*(.+)'),
        ('manufacturer', r'Manufacturer:\s*([0-9A-Fa-fxX]+)'),
        ('device', r'Device:\s*([0-9A-Fa-fxX]+)'),
        ('flash_mode', r'Flash type set in eFuse:\s*(.+)'),
        ('flash_voltage', r'Flash voltage set by eFuse:\s*(.+)'),
    ]

    @QtCore.Slot(int, str, str)
    def _on_esptool_done(self, rc, title, output=''):
        """esptool 执行结束（主线程回调）"""
        self.flashing = False
        self._set_busy(False)
        if rc == 0:
            self._set_progress_value(100)
            self._set_status('完成', 'green')
            self._log_operation(f'{title}完成', 'green')
            if title == '检测芯片':
                self._update_chip_fields(output)
        else:
            self._set_progress_value(0)
            self._set_status('失败', 'red')
            self._log_operation(f'{title}失败（退出码 {rc}）', 'red')
            self._log_operation('常见原因：串口被占用、开发板未进入下载模式、'
                                '端口选错、波特率过高', 'orange')
            if title == '检测芯片':
                self.chip_hint_label.setText('检测失败，请检查串口后重试')

    def _update_chip_fields(self, output):
        """把 esptool 的原始输出解析成结构化字段填进「芯片信息」卡"""
        values = {}
        for key, pattern in self._FIELD_PATTERNS:
            m = re.search(pattern, output, re.M)
            if m:
                values[key] = m.group(1).strip()

        # 厂商/器件 ID 合并成一格
        if 'manufacturer' in values or 'device' in values:
            values['flash_id'] = (f"{values.get('manufacturer', '?')}:"
                                  f"{values.get('device', '?')}")

        filled = []
        for key, label_widget in self.chip_fields.items():
            text = values.get(key, '—')
            label_widget.setText(text)
            if text != '—':
                filled.append(key)

        if filled:
            self.chip_hint_label.setText(
                f"检测成功，共读取 {len(filled)} 项信息")
        else:
            self.chip_hint_label.setText('未解析到芯片信息（输出格式可能已变化）')

    # ---------- 其它 ----------

    def apply_fonts(self, send_font: QtGui.QFont, recv_font: QtGui.QFont):
        """操作日志使用接收区字体（保留终端观感的配色与行距）"""
        f = QtGui.QFont(recv_font)
        f.setStyleHint(QtGui.QFont.StyleHint.Monospace)
        f.setFixedPitch(True)
        self.log_view.set_log_font(f)

    def get_config(self) -> dict:
        """获取配置"""
        flash_data = []
        for row in self.flash_rows:
            flash_data.append({
                'checked': row['checkbox'].isChecked(),
                'addr': row['addr_edit'].text(),
                'bin_path': row['bin_edit'].text()
            })

        return {
            'port': self.port_combo.currentData() or '',
            'baud': self.baud_combo.currentText(),
            'chip': self.chip_combo.currentData() or 'auto',
            'flash_data': flash_data,
        }

    def load_config(self, cfg: dict):
        """加载配置"""
        try:
            last_port = cfg.get('port')
            if last_port:
                for i in range(self.port_combo.count()):
                    if self.port_combo.itemData(i) == last_port:
                        self.port_combo.setCurrentIndex(i)
                        break

            self.baud_combo.setCurrentText(str(cfg.get('baud', '460800')))

            chip_index = self.chip_combo.findData(cfg.get('chip', 'auto'))
            if chip_index >= 0:
                self.chip_combo.setCurrentIndex(chip_index)

            flash_data = cfg.get('flash_data', [])
            for i, data in enumerate(flash_data):
                if i < len(self.flash_rows):
                    self.flash_rows[i]['checkbox'].setChecked(data.get('checked', False))
                    bin_path = data.get('bin_path', '')
                    addr = data.get('addr', '')
                    self.flash_rows[i]['bin_edit'].setText(bin_path)
                    # 只有确实选过 bin 的行才沿用旧地址，空行统一显示默认 0x0
                    self.flash_rows[i]['addr_edit'].setText(addr if (addr and bin_path) else '0x0')
        except Exception:
            pass

    def _setup_usb_monitor(self):
        """设置 USB 设备监听（仅用于自动刷新端口列表）"""
        if WINDOWS_USB_AVAILABLE and sys.platform == 'win32':
            try:
                self.usb_monitor = USBDeviceMonitor(self._on_usb_device_change)
                app = QtCore.QCoreApplication.instance()
                if app:
                    app.installNativeEventFilter(self.usb_monitor)
            except Exception:
                pass

    @QtCore.Slot()
    def _on_usb_device_change(self):
        """USB 设备变化回调：只在空闲时静默刷新端口列表"""
        if self.flashing:
            return
        self._refresh_ports(auto_select_new=True, quiet=True)

    def shutdown(self):
        """关闭tab"""
        if self.usb_monitor:
            try:
                app = QtCore.QCoreApplication.instance()
                if app:
                    app.removeNativeEventFilter(self.usb_monitor)
            except Exception:
                pass
            self.usb_monitor = None

    def _install_autosave_hooks(self):
        """安装自动保存钩子"""
        try:
            self.port_combo.currentIndexChanged.connect(lambda: self.changed.emit())
            self.baud_combo.currentIndexChanged.connect(lambda: self.changed.emit())
            self.chip_combo.currentIndexChanged.connect(lambda: self.changed.emit())
            for row in self.flash_rows:
                row['checkbox'].toggled.connect(lambda: self.changed.emit())
                row['addr_edit'].textChanged.connect(lambda: self.changed.emit())
                row['bin_edit'].textChanged.connect(lambda: self.changed.emit())
        except Exception:
            pass
