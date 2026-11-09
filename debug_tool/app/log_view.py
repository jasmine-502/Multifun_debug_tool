# -*- coding: utf-8 -*-
"""仿 VS Code 输出面板的日志视图

数值是按 VS Code 输出面板截图逐像素标定的：
    Consolas 16px → 字宽 9px、字形高 17px
    行距 22px（QTextEdit 块行高 92%）

注意：QPlainTextEdit 的文档布局**忽略块行高**，行距只能停在字体自带的 19px，
所以这里统一用 QTextEdit；日志量（几千行）对 QTextEdit 完全不是负担。
"""
import html as _html
import time

from PySide6 import QtCore, QtGui, QtWidgets

from app.theme import ModernTheme

FONT_PX = 16
LINE_RATIO = 92          # 92% × 24px = 22px，与 VS Code 输出面板行距一致
MAX_BLOCKS = 5000


def _block_fmt(ratio=LINE_RATIO):
    fmt = QtGui.QTextBlockFormat()
    fmt.setLineHeight(ratio, QtGui.QTextBlockFormat.LineHeightTypes.ProportionalHeight.value)
    return fmt


def _set_doc_line_height(doc, ratio=LINE_RATIO):
    cur = QtGui.QTextCursor(doc)
    cur.select(QtGui.QTextCursor.SelectionType.Document)
    cur.mergeBlockFormat(_block_fmt(ratio))


def terminal_block_format(ratio=LINE_RATIO):
    """给"自己插文本"的调用方用：写完一行 merge 一次，行距才不会退回默认 24px"""
    return _block_fmt(ratio)


def apply_terminal_style(editor, theme='dark', font=None, line_ratio=LINE_RATIO):
    """把任意 QTextEdit / QPlainTextEdit 调成终端观感（只改外观，不动行为）

    字体必须写进控件样式表：全局 QSS 的 QWidget 字体规则优先级高于 setFont，
    只调 setFont 会被按回界面字体，行距也跟着算错。
    """
    t = ModernTheme.terminal(theme)

    if font is None:
        family, px = ModernTheme.mono_family(), FONT_PX
    else:
        info = QtGui.QFontInfo(font)
        family = info.family() or ModernTheme.mono_family()
        px = info.pixelSize()
        if px <= 0:
            px = max(8, round(info.pointSize() * 96 / 72))

    editor.setFont(font or ModernTheme.mono_font(px))
    editor.setStyleSheet(
        f"QTextEdit, QPlainTextEdit {{"
        f" font-family: '{family}';"
        f" font-size: {px}px;"
        f" background-color: {t['bg']};"
        f" color: {t['fg']};"
        f" border: none;"
        f" border-radius: 0px;"
        f" padding: 4px 8px;"
        f" selection-background-color: {t['selection']};"
        f" selection-color: #ffffff; }}"
    )
    if isinstance(editor, QtWidgets.QTextEdit):
        _set_doc_line_height(editor.document(), line_ratio)


class LogView(QtWidgets.QTextEdit):
    """只读日志视图：终端观感 + 自动滚动 + 限行 + 右键菜单"""

    def __init__(self, parent=None, theme='dark', max_blocks=MAX_BLOCKS,
                 with_timestamp=False):
        super().__init__(parent)
        self.theme = theme
        self.max_blocks = max_blocks
        self.with_timestamp = with_timestamp

        self.setReadOnly(True)
        self.setAcceptRichText(True)
        self.setFrameShape(QtWidgets.QFrame.Shape.NoFrame)
        self.setLineWrapMode(QtWidgets.QTextEdit.LineWrapMode.WidgetWidth)
        self.document().setDocumentMargin(0)
        self.setContextMenuPolicy(QtCore.Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._show_menu)

        self.set_theme(theme)

    # ---------- 外观 ----------
    def set_theme(self, theme):
        self.theme = theme
        apply_terminal_style(self, theme)

    def set_log_font(self, font):
        """字体来自用户设置时也保持行高比例不变"""
        apply_terminal_style(self, self.theme, font=font)

    # ---------- 写入 ----------
    def append_line(self, text, color=None):
        """追加一行；color 可以是颜色名，也可以是 '#rrggbb'"""
        line = (text or '').replace('\r\n', '\n')
        line = line.rstrip('\n')
        if self.with_timestamp and line:
            line = time.strftime('[%H:%M:%S] ') + line
        self.append_html(self._wrap(line, color))

    def append_html(self, fragment):
        doc = self.document()
        cur = QtGui.QTextCursor(doc)
        cur.movePosition(QtGui.QTextCursor.MoveOperation.End)
        cur.beginEditBlock()
        # 文档还是空白时直接写进当前块，否则第一行前面会多出一个空行
        if doc.characterCount() > 1 or doc.blockCount() > 1:
            cur.insertBlock(_block_fmt())
        else:
            cur.mergeBlockFormat(_block_fmt())
        cur.insertHtml(fragment)
        cur.endEditBlock()
        self._trim()
        self.scroll_to_end()

    def _wrap(self, line, color):
        c = ModernTheme.log_color(color, self.theme)
        style = f'color:{c}; white-space:pre' if c else 'white-space:pre'
        return f'<span style="{style}">{_html.escape(line)}</span>'

    # ---------- 维护 ----------
    def _trim(self):
        if not self.max_blocks:
            return
        doc = self.document()
        extra = doc.blockCount() - self.max_blocks
        if extra <= 0:
            return
        first = doc.firstBlock()
        last = first
        for _ in range(extra - 1):
            last = last.next()
        cur = QtGui.QTextCursor(doc)
        cur.setPosition(first.position())
        cur.setPosition(last.position() + last.length(),
                        QtGui.QTextCursor.MoveMode.KeepAnchor)
        cur.removeSelectedText()

    def scroll_to_end(self):
        sb = self.verticalScrollBar()
        sb.setValue(sb.maximum())

    def clear(self):
        super().clear()
        self.scroll_to_end()

    # ---------- 右键菜单 ----------
    def _show_menu(self, pos):
        menu = QtWidgets.QMenu(self)
        has_sel = self.textCursor().hasSelection()
        act_copy = menu.addAction('复制')
        act_copy.setEnabled(has_sel)
        act_copy.triggered.connect(self.copy)
        act_all = menu.addAction('全选')
        act_all.triggered.connect(self.selectAll)
        menu.addSeparator()
        act_clear = menu.addAction('清空')
        act_clear.triggered.connect(self.clear)
        menu.exec(self.mapToGlobal(pos))
