# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置（唯一一份）

在项目根目录或 packaging 目录下执行都可：
    python -m PyInstaller --noconfirm packaging/TcpTool.spec

打包方式为 **onedir**（不是 onefile）：onefile 每次启动都要把 ~70MB 解压到
%TEMP%，冷启动要 3~5 秒；onedir 直接就地运行，启动只需 ~0.5 秒。
产物在 dist/TcpTool/ 目录下，分发时整个目录一起打包成 zip 即可。
"""
import os

from PyInstaller.utils.hooks import collect_all

# 项目根目录（spec 所在目录的上一级），不依赖当前工作目录
ROOT = os.path.abspath(os.path.join(SPECPATH, os.pardir))

datas = [
    (os.path.join(ROOT, 'app'), 'app'),
    (os.path.join(ROOT, 'font'), 'font'),
    (os.path.join(ROOT, 'packaging', 'icon.ico'), 'packaging'),
]
binaries = []
hiddenimports = [
    'app.base_comm',
    'app.tcp_tab',
    'app.udp_tab',
    'app.esp32_log_tab',
    'app.esp32_flash_tab',
    'app.firmware_merge_tab',
    'app.theme',
    'app.version_manager',
    'tool.release_output_binV2',
    # version_manager 里是延迟导入，显式声明避免打包遗漏
    'requests',
    # Qt 只用到这 4 个模块；交给 PyInstaller 官方 hook 按需收集，
    # 不再 collect_all('pyside6')，那样会把 Quick/Qml/Pdf 整套搬进来
    'PySide6.QtCore',
    'PySide6.QtGui',
    'PySide6.QtWidgets',
    'PySide6.QtNetwork',
]

# 这些包内部有数据文件，需显式收集
# esptool: 烧录 / 擦除 / 芯片检测（加密烧录功能已移除，不再打包 espefuse / espsecure）
for _pkg in ('esptool', 'esp_pylib'):
    try:
        _ret = collect_all(_pkg)
        datas += _ret[0]
        binaries += _ret[1]
        hiddenimports += _ret[2]
    except Exception:
        pass


# 显式排除用不到的重量级依赖（占了 ~78MB）
# numpy/PIL 是某些库顺带拖进来的，本工程一行都没用；
# Qt 侧只用到 Core/Gui/Widgets/Network，Quick/Qml/Pdf 全是 PySide6 全量收集带进来的。
excludes = [
    'numpy', 'PIL', 'Pillow', 'matplotlib', 'pandas', 'scipy',
    'tkinter', 'IPython', 'jupyter', 'notebook',
    'PySide6.QtQml', 'PySide6.QtQuick', 'PySide6.QtQuickWidgets',
    'PySide6.QtQuick3D', 'PySide6.QtPdf', 'PySide6.QtPdfWidgets',
    'PySide6.QtWebEngineCore', 'PySide6.QtWebEngineWidgets',
    'PySide6.QtWebChannel', 'PySide6.QtWebSockets',
    'PySide6.QtMultimedia', 'PySide6.QtMultimediaWidgets',
    'PySide6.Qt3DCore', 'PySide6.Qt3DRender', 'PySide6.QtCharts',
    'PySide6.QtDataVisualization', 'PySide6.QtDesigner', 'PySide6.QtHelp',
    'PySide6.QtBluetooth', 'PySide6.QtNfc', 'PySide6.QtPositioning',
    'PySide6.QtSerialBus', 'PySide6.QtSensors', 'PySide6.QtSql',
    'PySide6.QtTest', 'PySide6.QtOpenGLWidgets',
]

a = Analysis(
    [os.path.join(ROOT, 'qt_app.py')],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

# collect_all('pyside6') 会把整套 Qt 全搬进来，这里按文件名过滤掉没用到的模块
# opengl32sw.dll 是软件 OpenGL 回退（20MB），纯 Widgets 程序用不到
_UNUSED_BIN_PATTERNS = (
    'qt6quick', 'qt6qml', 'qt6pdf', 'qt6webengine', 'qt6multimedia',
    'qt6charts', 'qt63d', 'qt6bluetooth', 'qt6nfc', 'qt6positioning',
    'qt6sensors', 'qt6serialbus', 'qt6sql', 'qt6test', 'qt6designer',
    'opengl32sw', 'qt6virtualkeyboard', 'qt6texttospeech',
)
_UNUSED_DATA_PATTERNS = ('qml', '__pycache__')


def _keep_bin(entry):
    """entry = (dest_name, src_path, typecode)"""
    name = entry[0].replace('\\', '/').lower()
    return not any(p in name for p in _UNUSED_BIN_PATTERNS)


def _keep_data(entry):
    name = entry[0].replace('\\', '/').lower()
    if any(p in name for p in _UNUSED_DATA_PATTERNS):
        return False
    # Qt 自带翻译只保留简体中文，其余语种丢掉（7MB → 0.5MB）
    # 保留是因为 QMessageBox 的「确定/取消」按钮文案靠它
    if 'translations' in name and 'zh_cn' not in name:
        return False
    return True


a.binaries = [b for b in a.binaries if _keep_bin(b)]
a.datas = [d for d in a.datas if _keep_data(d)]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='TcpTool',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=[os.path.join(ROOT, 'packaging', 'icon.ico')],
)

# onedir：依赖放在 exe 同级目录，避免每次启动解压
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='TcpTool',
)
