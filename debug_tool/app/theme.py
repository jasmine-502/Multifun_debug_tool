# -*- coding: utf-8 -*-
import os
import sys


def _assets_dir():
    """定位 assets 目录

    QSS 的 image 只认真实文件路径（不支持 data URI），且打包后 __file__ 的
    指向可能落在 _MEIPASS 或 exe 同级目录，这里按优先级逐个探测。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(here, 'assets')]

    meipass = getattr(sys, '_MEIPASS', None)
    if meipass:
        candidates.append(os.path.join(meipass, 'app', 'assets'))

    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(sys.executable)
        candidates.append(os.path.join(exe_dir, '_internal', 'app', 'assets'))
        candidates.append(os.path.join(exe_dir, 'app', 'assets'))

    for path in candidates:
        if os.path.isdir(path):
            return path
    return candidates[0]


_ICON_DIR = _assets_dir()
_CHECK_ICON = os.path.join(_ICON_DIR, 'check.png').replace('\\', '/')
_CHEVRON_ICON = os.path.join(_ICON_DIR, 'chevron.png').replace('\\', '/')


class ModernTheme:
    # ---- VS Code 终端配色 ----
    # 深色值是从 VS Code 输出面板截图上逐像素取出来的：背景 #181d27、正文 #cccccc，
    # ANSI 色与 VS Code 官方终端主题一致（#0dbc79 / #11a8cd / #e5e510 可精确对上）。
    TERMINAL_DARK = {
        'bg': '#181d27',
        'fg': '#cccccc',
        'selection': '#264f78',
        'ansi': {
            'black': '#000000', 'red': '#cd3131', 'green': '#0dbc79',
            'yellow': '#e5e510', 'blue': '#2472c8', 'magenta': '#bc3fbc',
            'cyan': '#11a8cd', 'white': '#e5e5e5',
            'bright_black': '#666666', 'bright_red': '#f14c4c',
            'bright_green': '#23d18b', 'bright_yellow': '#f5f543',
            'bright_blue': '#3b8eea', 'bright_magenta': '#d670d6',
            'bright_cyan': '#29b8db', 'bright_white': '#ffffff',
        },
    }
    # 浅色终端：正文用近黑（浅灰在白底上看不清），ANSI 全部压暗一档保证可读
    TERMINAL_LIGHT = {
        'bg': '#ffffff',
        'fg': '#1e1e1e',
        'selection': '#add6ff',
        'ansi': {
            'black': '#000000', 'red': '#cd3131', 'green': '#0f7a3d',
            'yellow': '#8a7500', 'blue': '#0451a5', 'magenta': '#bc05bc',
            'cyan': '#056c8a', 'white': '#555555',
            'bright_black': '#595959', 'bright_red': '#a80000',
            'bright_green': '#0f7a3d', 'bright_yellow': '#8a7500',
            'bright_blue': '#0b5cad', 'bright_magenta': '#a005a0',
            'bright_cyan': '#04687f', 'bright_white': '#333333',
        },
    }

    # 日志颜色名 -> ANSI 槽位
    _LOG_ALIAS = {
        'red': 'bright_red', 'error': 'bright_red', 'err': 'bright_red',
        'green': 'bright_green', 'success': 'bright_green', 'ok': 'bright_green',
        'yellow': 'yellow', 'orange': 'yellow', 'warning': 'yellow', 'warn': 'yellow',
        'blue': 'bright_blue', 'info': 'bright_blue',
        'cyan': 'cyan', 'magenta': 'bright_magenta',
        'gray': 'bright_black', 'grey': 'bright_black', 'dim': 'bright_black',
    }

    @classmethod
    def terminal(cls, theme="dark"):
        """终端观感配色（日志视图专用）"""
        return cls.TERMINAL_DARK if theme == "dark" else cls.TERMINAL_LIGHT

    @classmethod
    def log_color(cls, name, theme="dark"):
        """日志颜色名转十六进制；空/未知返回 None（表示跟随正文色）

        也接受直接传 '#rrggbb'。
        """
        if not name:
            return None
        s = str(name).strip()
        if s.startswith('#') and len(s) in (4, 7):
            return s
        slot = cls._LOG_ALIAS.get(s.lower())
        if not slot:
            return None
        return cls.terminal(theme)['ansi'].get(slot)

    @staticmethod
    def mono_font(pixel_size=16):
        """等宽日志字体

        Cascadia Mono 字宽 0.6em，Consolas 0.5498em；16px Consolas 的字宽正好 9px，
        与 VS Code 输出面板实测一致，所以字号按 px 定而不是 pt。
        """
        from PySide6 import QtGui

        f = QtGui.QFont()
        try:
            f.setFamilies(ModernTheme.MONO_STACK)
        except Exception:
            f.setFamily('Consolas')
        f.setPixelSize(pixel_size)
        f.setStyleHint(QtGui.QFont.StyleHint.Monospace)
        f.setFixedPitch(True)
        f.setStyleStrategy(QtGui.QFont.StyleStrategy.PreferAntialias)
        return f

    MONO_STACK = ['Cascadia Mono', 'Consolas', 'JetBrains Mono',
                  'DejaVu Sans Mono', 'Courier New']

    @classmethod
    def mono_family(cls):
        """挑一个本机真实存在的等宽字体

        全局 QSS 里的 QWidget 字体优先级高于 setFont，所以字体必须写进
        控件自己的样式表，这里先确定要写哪个名字。
        """
        from PySide6 import QtGui

        try:
            available = set(QtGui.QFontDatabase.families())
        except Exception:
            return 'Consolas'
        for name in cls.MONO_STACK:
            if name in available:
                return name
        return 'Consolas'

    @staticmethod
    def get_font_style():
        """Return a standard font string for the application.

        中文字体必须排在首位：若首选项是 Segoe UI，它没有中文字形，
        Qt 要靠系统回退去凑，而按钮/标签的 sizeHint 是按回退前的字体算的，
        中文一渲染就会超出，文字被截成 "浏..."。
        """
        return ("font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', "
                "'PingFang SC', 'Noto Sans CJK SC', 'Segoe UI', "
                "'San Francisco', 'Helvetica Neue', Helvetica, Arial, sans-serif; "
                "font-size: 10pt;")

    @staticmethod
    def dark_palette():
        return {
            "background": "#2b2d30",
            "surface": "#3c3f41",
            "header_footer": "#222426", # Slightly darker than background
            "primary": "#365880",
            "primary_hover": "#4b6e99",
            "accent": "#528bff",
            "text": "#e3e5e8",
            "text_bright": "#ffffff",
            "border": "#555555",
            # 输入框比卡片面略深一点，才有"凹陷"的层次感
            "input_bg": "#313438",
            "input_text": "#ffffff",
            "success": "#6a8759",
            "error": "#bc3f3c",
            "warning": "#d19a66",
            "splitter": "#1e1e1e",
        }

    @staticmethod
    def light_palette():
        return {
            "background": "#f0f2f5",
            "surface": "#ffffff",
            "header_footer": "#e1e4e8", # Slightly darker than background
            "primary": "#0078d4",
            "primary_hover": "#1084d9",
            "accent": "#0064b0",
            "text": "#333333",
            "text_bright": "#000000",
            "border": "#d1d1d1",
            "input_bg": "#ffffff",
            "input_text": "#000000",
            "success": "#107c10",
            "error": "#a80000",
            "warning": "#d9a100",
            "splitter": "#e0e0e0",
        }

    @classmethod
    def get_palette(cls, theme="dark"):
        """与 QSS 配套的 QPalette

        QSS 只覆盖被显式写到的控件，其余（如表格行号表头、滚动区角落、
        各平台原生子控件）会退回默认调色板；不设 palette 就会在暗色下
        冒出刺眼的白块。
        """
        from PySide6 import QtGui

        p = cls.dark_palette() if theme == "dark" else cls.light_palette()
        pal = QtGui.QPalette()
        role = QtGui.QPalette.ColorRole
        group = QtGui.QPalette.ColorGroup

        pal.setColor(role.Window, QtGui.QColor(p['background']))
        pal.setColor(role.WindowText, QtGui.QColor(p['text']))
        pal.setColor(role.Base, QtGui.QColor(p['input_bg']))
        pal.setColor(role.AlternateBase, QtGui.QColor(p['surface']))
        pal.setColor(role.Text, QtGui.QColor(p['input_text']))
        pal.setColor(role.Button, QtGui.QColor(p['surface']))
        pal.setColor(role.ButtonText, QtGui.QColor(p['text']))
        pal.setColor(role.BrightText, QtGui.QColor(p['text_bright']))
        pal.setColor(role.Highlight, QtGui.QColor(p['accent']))
        pal.setColor(role.HighlightedText, QtGui.QColor('#ffffff'))
        pal.setColor(role.ToolTipBase, QtGui.QColor(p['surface']))
        pal.setColor(role.ToolTipText, QtGui.QColor(p['text_bright']))
        pal.setColor(role.PlaceholderText, QtGui.QColor(p['border']))
        pal.setColor(role.Link, QtGui.QColor(p['accent']))
        # 禁用态
        for r in (role.Text, role.ButtonText, role.WindowText):
            pal.setColor(group.Disabled, r, QtGui.QColor(p['border']))
        return pal

    @classmethod
    def get_qss(cls, theme="dark"):
        p = cls.dark_palette() if theme == "dark" else cls.light_palette()
        
        qss = f"""
        /* Global —— 只统一配色与字体，不设底色，否则所有子容器都会被刷成一块死板色 */
        QWidget {{
            color: {p['text']};
            {cls.get_font_style()}
        }}

        /* QMainWindow & Central Widget */
        QMainWindow, QDialog {{
            background-color: {p['background']};
        }}

        /* GroupBox —— 当卡片用：标题放在框内当卡片头，外框线不会被标题压断 */
        QGroupBox {{
            border: 1px solid {p['border']};
            border-radius: 4px;
            /* 标题整段画在边框上方，margin-top 必须 >= 标题高度，否则标题会和内容重叠 */
            margin-top: 22px;
            background-color: {p['surface']};
            padding: 8px 10px 10px 10px;
        }}
        QGroupBox::title {{
            subcontrol-origin: margin;
            subcontrol-position: top left;
            top: 2px;
            /* 与卡片内容的左内边距对齐，视觉上成一列 */
            left: 10px;
            padding: 0px;
            color: {p['accent']};
            font-weight: bold;
        }}

        /* Buttons */
        QPushButton {{
            background-color: {p['input_bg']};
            border: 1px solid {p['border']};
            border-radius: 4px;
            padding: 5px 12px;
            min-height: 22px;
        }}
        QPushButton:hover {{
            background-color: {p['primary']};
            color: {p['text_bright']};
            border-color: {p['primary']};
        }}
        QPushButton:pressed {{
            background-color: {p['primary_hover']};
            color: {p['text_bright']};
        }}
        QPushButton:disabled {{
            background-color: {p['background']};
            color: {p['border']};
            border-color: {p['border']};
        }}
        /* 主操作按钮（烧录）：直接给强调色 */
        QPushButton[primary="true"] {{
            background-color: {p['primary']};
            color: {p['text_bright']};
            border-color: {p['primary']};
            font-weight: bold;
        }}
        QPushButton[primary="true"]:hover {{
            background-color: {p['primary_hover']};
            border-color: {p['primary_hover']};
        }}
        QPushButton[primary="true"]:disabled {{
            background-color: {p['background']};
            color: {p['border']};
            border-color: {p['border']};
        }}

        /* 紧凑按钮（表格里的 "..." 之类）：去掉左右内边距，避免文字被挤没 */
        QPushButton#tinyBtn {{
            padding: 2px 0px;
            min-height: 20px;
        }}

        /* 大按钮（擦除/烧录这类主操作）：更高更宽，字重加粗 */
        QPushButton#bigBtn {{
            padding: 8px 28px;
            min-height: 26px;
            min-width: 88px;
            font-size: 11pt;
            font-weight: bold;
        }}

        /* 芯片信息卡的字段：标签浅色、值加粗，一眼分清 */
        QLabel#fieldLabel {{
            color: {p['text']};
        }}
        QLabel#fieldValue {{
            color: {p['text_bright']};
            font-weight: bold;
        }}

        /* RadioButton & CheckBox */
        QRadioButton, QCheckBox {{
            spacing: 5px;
            background-color: transparent;
        }}
        
        /* CheckBox Indicator - 方框内显示对号 */
        QCheckBox::indicator {{
            width: 16px;
            height: 16px;
            border: 1px solid {p['border']};
            border-radius: 3px;
            background-color: {p['input_bg']};
        }}

        QCheckBox::indicator:checked {{
            background-color: {p['accent']};
            border: 1px solid {p['accent']};
            image: url("{_CHECK_ICON}");
        }}

        QCheckBox::indicator:hover {{
            border-color: {p['accent']};
        }}

        QCheckBox::indicator:checked:hover {{
            background-color: {p['primary_hover']};
            border-color: {p['primary_hover']};
            image: url("{_CHECK_ICON}");
        }}

        QCheckBox::indicator:disabled {{
            background-color: {p['background']};
            border-color: {p['border']};
        }}

        QCheckBox::indicator:checked:disabled {{
            background-color: {p['border']};
            border-color: {p['border']};
            image: url("{_CHECK_ICON}");
        }}

        /* RadioButton Indicator - Fixed Size, No Growth */
        QRadioButton::indicator {{
            width: 8px; 
            height: 8px;
            border: 1px solid {p['border']};
            border-radius: 4px;
            background-color: {p['input_bg']};
        }}

        /* RadioButton Checked - Inner Dot Fill Only */
        QRadioButton::indicator:checked {{
            background-color: {p['accent']}; /* Blue fill */
            border: 1px solid {p['accent']}; /* Blue Outer Ring */
            image: none;
        }}
        
        QRadioButton::indicator:hover {{
            border-color: {p['accent']};
        }}

        /* Inputs */
        QLineEdit, QTextEdit, QPlainTextEdit, QSpinBox, QDoubleSpinBox {{
            background-color: {p['input_bg']};
            color: {p['input_text']};
            border: 1px solid {p['border']};
            border-radius: 4px;
            padding: 4px 8px;
            selection-background-color: {p['accent']};
            selection-color: #ffffff;
        }}
        QLineEdit:hover, QSpinBox:hover, QDoubleSpinBox:hover {{
            border-color: {p['accent']};
        }}
        QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus,
        QSpinBox:focus, QDoubleSpinBox:focus {{
            border: 1px solid {p['accent']};
        }}

        /* ComboBox */
        QComboBox {{
            background-color: {p['input_bg']};
            color: {p['input_text']};
            border: 1px solid {p['border']};
            border-radius: 4px;
            padding: 4px 8px;
            min-height: 22px;
        }}
        QComboBox:hover {{
            border-color: {p['accent']};
        }}
        QComboBox:focus {{
            border: 1px solid {p['accent']};
        }}
        QComboBox::drop-down {{
            subcontrol-origin: padding;
            subcontrol-position: top right;
            width: 22px;
            border: none;
        }}
        QComboBox::down-arrow {{
            image: url("{_CHEVRON_ICON}");
            width: 10px;
            height: 10px;
        }}
        QComboBox QAbstractItemView {{
            background-color: {p['surface']};
            color: {p['text']};
            border: 1px solid {p['border']};
            border-radius: 4px;
            padding: 4px;
            outline: none;
            selection-background-color: {p['primary']};
            selection-color: {p['text_bright']};
        }}

        /* TabWidget —— 下划线式标签，比色块更轻 */
        QTabWidget::pane {{
            border: none;
            border-top: 1px solid {p['border']};
            background-color: {p['background']};
            top: -1px;
        }}
        QTabBar {{
            background: transparent;
        }}
        QTabBar::tab {{
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            padding: 8px 18px;
            margin-right: 4px;
            color: {p['text']};
        }}
        QTabBar::tab:hover:!selected {{
            color: {p['text_bright']};
            border-bottom-color: {p['border']};
        }}
        QTabBar::tab:selected {{
            color: {p['accent']};
            border-bottom: 2px solid {p['accent']};
            font-weight: bold;
        }}

        /* ProgressBar —— 百分比不再画在条里（右侧有独立数字标签） */
        QProgressBar {{
            border: 1px solid {p['border']};
            border-radius: 4px;
            background-color: {p['input_bg']};
            min-height: 16px;
            max-height: 18px;
            color: transparent;
        }}
        QProgressBar::chunk {{
            background-color: {p['accent']};
            border-radius: 3px;
        }}
        QLabel#progressValue {{
            color: {p['text_bright']};
            font-weight: bold;
            font-size: 11pt;
        }}

        /* ToolTip */
        QToolTip {{
            background-color: {p['surface']};
            color: {p['text_bright']};
            border: 1px solid {p['border']};
            padding: 4px 6px;
        }}

        /* Scrollbars */
        QScrollBar:vertical {{
            border: none;
            background: transparent;
            width: 9px;
            margin: 0px;
        }}
        QScrollBar::handle:vertical {{
            background: {p['border']};
            min-height: 24px;
            border-radius: 4px;
        }}
        QScrollBar::handle:vertical:hover {{
            background: {p['primary']};
        }}
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
            height: 0px;
        }}
        QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{
            background: transparent;
        }}
        QScrollBar:horizontal {{
            border: none;
            background: transparent;
            height: 9px;
            margin: 0px;
        }}
        QScrollBar::handle:horizontal {{
            background: {p['border']};
            min-width: 24px;
            border-radius: 4px;
        }}
        QScrollBar::handle:horizontal:hover {{
            background: {p['primary']};
        }}
        QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
            width: 0px;
        }}
        QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {{
            background: transparent;
        }}

        /* Splitter */
        QSplitter::handle {{
            background-color: {p['splitter']};
        }}
        
        /* List & Table —— 表格不画外框线，靠底色区分成"内嵌区域"，避免和卡片圆角打架 */
        QListWidget, QTableWidget {{
            background-color: {p['input_bg']};
            color: {p['input_text']};
            gridline-color: {p['border']};
            outline: none;
            alternate-background-color: {p['surface']};
        }}
        QTableWidget {{
            border: none;
        }}
        QListWidget {{
            border: 1px solid {p['border']};
            border-radius: 4px;
        }}
        QHeaderView::section {{
            background-color: {p['surface']};
            color: {p['text']};
            padding: 5px;
            border: none;
            border-right: 1px solid {p['border']};
            border-bottom: 1px solid {p['border']};
            font-weight: bold;
        }}
        QTableCornerButton::section {{
            background-color: {p['surface']};
            border: none;
            border-right: 1px solid {p['border']};
            border-bottom: 1px solid {p['border']};
        }}

        /* Status Bar & Menu Bar - Darker Header/Footer */
        QStatusBar {{
            background: {p['header_footer']};
            border-top: 1px solid {p['border']};
            color: {p['text']};
        }}
        QMenuBar {{
            background-color: {p['header_footer']};
            border-bottom: 1px solid {p['border']};
        }}
        QMenuBar::item {{
            spacing: 3px; 
            padding: 6px 10px;
            background: transparent;
            border-radius: 4px;
        }}
        QMenuBar::item:selected {{ 
            background-color: {p['primary']};
            color: {p['text_bright']};
        }}
        QMenu {{
            background-color: {p['surface']};
            border: 1px solid {p['border']};
        }}
        QMenu::item {{
            padding: 6px 24px;
        }}
        QMenu::item:selected {{
            background-color: {p['primary']};
            color: {p['text_bright']};
        }}
        
        /* Dialogs */
        QDialog {{
            background-color: {p['background']};
        }}
        
        /* Status Labels via Property */
        QLabel[status="success"] {{
            color: {p['success']};
            font-weight: bold;
        }}
        QLabel[status="error"] {{
            color: {p['error']};
            font-weight: bold;
        }}
        QLabel[status="warning"] {{
            color: {p['warning']};
            font-weight: bold;
        }}

        /* 固件合并页：信息条与输出文件名（在此统一定义，避免页面里硬编码浅色） */
        QFrame#infoBar {{
            border: 1px solid {p['border']};
            border-radius: 4px;
            background-color: {p['input_bg']};
        }}
        QLabel#infoText {{
            color: {p['accent']};
            font-weight: bold;
            padding: 0px 10px;
        }}
        QLabel#outputName {{
            color: {p['accent']};
            font-weight: bold;
        }}
        """
        return qss
