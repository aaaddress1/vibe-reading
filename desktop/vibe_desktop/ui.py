from pathlib import Path
import math
import time
from PySide6.QtCore import QEvent, QPointF, QRectF, QSignalBlocker, QSize, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QDesktopServices, QIcon, QKeySequence, QPainter, QPen, QPixmap, QPolygonF, QShortcut
from PySide6.QtWidgets import (QApplication, QComboBox, QFrame, QHBoxLayout, QLabel,
    QPlainTextEdit, QPushButton, QSizeGrip, QSizePolicy, QVBoxLayout, QWidget)
from .languages import TARGET_LANGUAGES, languages_for
from . import __version__

ASSETS = Path(__file__).parent / 'assets'
GITHUB_URL = 'https://github.com/aaaddress1/vibe-reading'
COFFEE_URL = 'https://buymeacoffee.com/aaaddress1'
STYLE = """
QWidget { color:#e5e5e5; font-family:'Segoe UI','Microsoft JhengHei'; font-size:13px; }
QWidget#window { background:#282828; border:1px solid #4b4b4b; border-radius:7px; }
QFrame#header { background:#202020; border:0; border-bottom:1px solid #414141; border-top-left-radius:7px; border-top-right-radius:7px; }
QLabel#brand { color:#f0f0f0; font-size:13px; font-weight:600; }
QLabel#version { color:#a8a8a8; font-size:10px; }
QPushButton#github { color:#ffdc69; }
QPushButton#coffee { background:#ffdd00; border-color:#ffdd00; color:#202020; font-weight:600; }
QPushButton#coffee:hover { background:#ffe958; border-color:#ffe958; }
QLabel#tab { background:#085398; color:#fff; border:1px solid #1680d6; border-radius:4px; padding:4px 10px; font-size:13px; font-weight:600; }
QLabel#status { color:#a8a8a8; font-size:11px; }
QLabel#count { color:#858585; font-size:11px; }
QFrame#languageBar { border:0; border-bottom:1px solid #474747; }
QComboBox { color:#e8e8e8; background:#282828; border:1px solid #505050; border-radius:4px; padding:5px 10px; min-width:106px; font-size:13px; font-weight:600; }
QComboBox:hover { background:#303030; border-color:#727272; }
QComboBox::drop-down { border:0; width:24px; }
QComboBox QAbstractItemView { background:#292929; color:#eee; selection-background-color:#155484; padding:4px; border:1px solid #555; }
QPlainTextEdit { background:#282828; color:#e1e1e1; border:0; border-radius:0; padding:15px; selection-background-color:#125a8b; font-size:16px; }
QWidget#window[compact="true"] QPlainTextEdit#translation { border:1px solid #444; border-radius:5px; padding:8px; font-size:14px; }
QPushButton { background:#282828; border:1px solid #525252; border-radius:4px; padding:5px 11px; color:#ddd; font-size:12px; }
QPushButton:hover { background:#363636; border-color:#777; }
QPushButton:pressed { background:#424242; }
QPushButton#primary { background:#0874c4; color:white; border-color:#0874c4; font-weight:600; }
QPushButton#primary:hover { background:#1684d2; }
QPushButton#icon { background:transparent; border:0; padding:0; }
QPushButton#icon:hover { background:#3b3b3b; }
QPushButton#close:hover { background:#c84242; }
QPushButton#close { background:transparent; border:0; padding:0; }
QPushButton:disabled { color:#727272; border-color:#414141; }
QFrame#divider { background:#4a4a4a; border:0; }
QFrame#footer { background:#2e2e2e; border:0; border-top:1px solid #454545; }
QScrollBar:vertical { background:transparent; width:6px; margin:4px 0; }
QScrollBar::handle:vertical { background:#5a5a5a; border-radius:3px; min-height:25px; }
QScrollBar::add-line:vertical,QScrollBar::sub-line:vertical { height:0; }
QMenu { background:#292929; border:1px solid #505050; padding:5px; }
QMenu::item { padding:7px 20px; }
QMenu::item:selected { background:#155484; }
QDialog { background:#282828; }
"""


def glyph(name):
    """Small neutral line icons, drawn natively instead of emoji fonts."""
    pixmap = QPixmap(36, 36)
    pixmap.setDevicePixelRatio(2)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    pen = QPen(Qt.GlobalColor.lightGray, 1.25)
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    painter.setPen(pen)
    if name == 'close':
        painter.drawLine(QPointF(5, 5), QPointF(13, 13))
        painter.drawLine(QPointF(13, 5), QPointF(5, 13))
    elif name == 'minimize':
        painter.drawLine(QPointF(4, 10), QPointF(14, 10))
    elif name == 'maximize':
        painter.drawRect(QRectF(4.5, 4.5, 9, 9))
    elif name == 'copy':
        painter.drawRoundedRect(QRectF(6, 6, 8, 9), 1.5, 1.5)
        painter.drawLine(QPointF(4, 12), QPointF(3, 12))
        painter.drawLine(QPointF(3, 12), QPointF(3, 3))
        painter.drawLine(QPointF(3, 3), QPointF(11, 3))
    elif name == 'expand':
        painter.drawLine(QPointF(5, 13), QPointF(13, 5))
        painter.drawLine(QPointF(7, 5), QPointF(13, 5))
        painter.drawLine(QPointF(13, 5), QPointF(13, 11))
    elif name == 'collapse':
        painter.drawLine(QPointF(5, 13), QPointF(13, 5))
        painter.drawLine(QPointF(5, 7), QPointF(5, 13))
        painter.drawLine(QPointF(5, 13), QPointF(11, 13))
    elif name == 'swap':
        painter.drawLine(QPointF(3, 6), QPointF(15, 6))
        painter.drawLine(QPointF(12, 3), QPointF(15, 6))
        painter.drawLine(QPointF(15, 12), QPointF(3, 12))
        painter.drawLine(QPointF(6, 15), QPointF(3, 12))
    elif name == 'translate':
        painter.drawLine(QPointF(3, 9), QPointF(15, 9))
        painter.drawLine(QPointF(11, 5), QPointF(15, 9))
        painter.drawLine(QPointF(11, 13), QPointF(15, 9))
    elif name == 'star':
        painter.setPen(QPen(Qt.GlobalColor.yellow, 1))
        painter.setBrush(Qt.GlobalColor.yellow)
        points = []
        for index in range(10):
            radius = 7 if index % 2 == 0 else 3.2
            angle = math.pi * index / 5 - math.pi / 2
            points.append(QPointF(9 + radius * math.cos(angle), 9 + radius * math.sin(angle)))
        painter.drawPolygon(QPolygonF(points))
    elif name == 'coffee':
        painter.setPen(QPen(Qt.GlobalColor.black, 1.25))
        painter.drawRoundedRect(QRectF(3, 6, 9, 8), 2, 2)
        painter.drawArc(QRectF(10, 7, 5, 5), -90 * 16, 180 * 16)
        painter.drawLine(QPointF(2, 16), QPointF(14, 16))
        painter.drawLine(QPointF(5, 2), QPointF(5, 4))
        painter.drawLine(QPointF(9, 2), QPointF(9, 4))
    elif name == 'settings':
        points = []
        for index in range(24):
            radius = 7 if index % 4 in (1, 2) else 5.4
            angle = math.pi * index / 12
            points.append(QPointF(9 + radius * math.cos(angle), 9 + radius * math.sin(angle)))
        painter.drawPolygon(QPolygonF(points))
        painter.drawEllipse(QRectF(6.6, 6.6, 4.8, 4.8))
    painter.end()
    return QIcon(pixmap)


def button(text='', name='', icon=None):
    widget = QPushButton(text)
    widget.setObjectName(name)
    widget.setCursor(Qt.CursorShape.PointingHandCursor)
    if icon:
        widget.setIcon(glyph(icon))
        widget.setIconSize(QSize(16, 16))
    return widget


class TranslationWindow(QWidget):
    translate_requested = Signal()
    mode_requested = Signal()
    settings_requested = Signal()
    language_changed = Signal()
    source_changed = Signal()
    swap_requested = Signal()

    def __init__(self, compact=False):
        flags = Qt.WindowType.FramelessWindowHint | (Qt.WindowType.Tool | Qt.WindowType.WindowStaysOnTopHint if compact else Qt.WindowType.Window)
        super().__init__(None, flags)
        self.compact = compact
        self.setProperty('compact', compact)
        self.setObjectName('window')
        self.setWindowTitle(f'氛圍閱讀 · {"快速翻譯" if compact else "Vibe Reading Desktop"} v{__version__}')
        self.setWindowIcon(QIcon(str(ASSETS / 'icon.png')))
        self.resize(460, 264) if compact else self.resize(820, 500)
        self.setMinimumSize(380, 230) if compact else self.setMinimumSize(640, 380)
        self.paint_latencies = []
        self.show_started = None
        self.drag_position = None
        self.dismiss_timer = QTimer(self)
        self.dismiss_timer.setSingleShot(True)
        self.dismiss_timer.setInterval(60)
        self.dismiss_timer.timeout.connect(self.dismiss_if_inactive)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(1, 1, 1, 1)
        layout.setSpacing(0)
        header = QFrame()
        header.setObjectName('header')
        self.header = header
        header.setFixedHeight(50 if compact else 58)
        bar = QHBoxLayout(header)
        bar.setContentsMargins(11, 5, 6, 5)
        bar.setSpacing(6)
        self.logo = QLabel()
        logo_size = 36 if compact else 44
        self.logo.setFixedSize(logo_size, logo_size)
        self.logo.setPixmap(QPixmap(str(ASSETS / 'icon.png')).scaled(logo_size, logo_size, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        bar.addWidget(self.logo)
        identity = QVBoxLayout()
        identity.setSpacing(0)
        brand = QLabel('氛圍閱讀' if compact else '氛圍閱讀 Vibe Reading')
        brand.setObjectName('brand')
        identity.addWidget(brand)
        self.version_label = QLabel(f'Desktop v{__version__}')
        self.version_label.setObjectName('version')
        identity.addWidget(self.version_label)
        bar.addLayout(identity)
        bar.addStretch()
        self.github_button = button('' if compact else 'GitHub', 'github', icon='star')
        self.github_button.setToolTip('在 GitHub 上查看原始碼／給顆星')
        self.github_button.setAccessibleName('GitHub — 給氛圍閱讀一顆星')
        self.github_button.clicked.connect(lambda: QDesktopServices.openUrl(QUrl(GITHUB_URL)))
        self.coffee_button = button(name='coffee', icon='coffee')
        self.coffee_button.setFixedSize(29, 28)
        self.coffee_button.setToolTip('喜歡氛圍閱讀？請作者喝杯咖啡')
        self.coffee_button.setAccessibleName('Buy me a coffee — 請作者喝杯咖啡')
        self.coffee_button.clicked.connect(lambda: QDesktopServices.openUrl(QUrl(COFFEE_URL)))
        for link in (self.github_button, self.coffee_button):
            if compact:
                link.setFixedSize(29, 28)
            bar.addWidget(link)
        for label in header.findChildren(QLabel):
            label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        settings = button(name='icon', icon='settings')
        settings.setFixedSize(29, 28)
        settings.setToolTip('偏好設定')
        settings.setAccessibleName('偏好設定')
        settings.clicked.connect(self.settings_requested)
        bar.addWidget(settings)
        if not compact:
            minimize = button(name='icon', icon='minimize')
            minimize.setFixedSize(28, 28)
            minimize.setAccessibleName('最小化')
            minimize.clicked.connect(self.showMinimized)
            bar.addWidget(minimize)
            maximize = button(name='icon', icon='maximize')
            maximize.setFixedSize(28, 28)
            maximize.setAccessibleName('最大化／還原')
            maximize.clicked.connect(self.toggle_maximized)
            bar.addWidget(maximize)
        close = button(name='close', icon='close')
        close.setFixedSize(29, 28)
        close.setToolTip('收起')
        close.setAccessibleName('收起視窗')
        close.clicked.connect(self.hide)
        bar.addWidget(close)
        layout.addWidget(header)

        self.source_language = QComboBox(self)
        for label, code in [('偵測語言', 'auto'), ('English', 'en'), ('中文', 'zh')]:
            self.source_language.addItem(label, code)
        self.source_language.setAccessibleName('來源語言')
        self.target_language = QComboBox(self)
        for label, code in TARGET_LANGUAGES:
            self.target_language.addItem(label, code)
        self.target_language.setAccessibleName('翻譯目標語言')
        for combo in (self.source_language, self.target_language):
            combo.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
            combo.setMinimumContentsLength(12)
            combo.setMaximumWidth(230)
        self.status = QLabel('準備就緒')
        self.status.setObjectName('status')
        self.status.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)

        self.source = QPlainTextEdit(self)
        self.source.setAccessibleName('原文輸入')
        self.source.setPlaceholderText('輸入或貼上文字進行翻譯\n\n也可選取文字後，快速按 Ctrl+C、C。')
        self.source.setReadOnly(compact)
        self.translation = QPlainTextEdit(self)
        self.translation.setObjectName('translation')
        self.translation.setAccessibleName('翻譯結果')
        self.translation.setReadOnly(True)
        self.translation.setPlaceholderText('翻譯結果')

        self.copy = button('複製', icon='copy')
        self.copy.setEnabled(False)
        self.copy.setAccessibleName('複製譯文')
        self.copy.clicked.connect(lambda: QApplication.clipboard().setText(self.translation.toPlainText()))
        self.mode_button = button('完整介面' if compact else '懸浮翻譯', icon='expand' if compact else 'collapse')
        self.mode_button.clicked.connect(self.mode_requested)
        self.translate_button = button('翻譯', 'primary', icon='translate')
        self.translate_button.clicked.connect(self.translate_requested)

        if compact:
            self.source.hide()
            self.source_language.hide()
            content = QVBoxLayout()
            content.setContentsMargins(11, 9, 11, 10)
            content.setSpacing(9)
            languages = QHBoxLayout()
            languages.setSpacing(10)
            languages.addWidget(self.target_language)
            languages.addWidget(self.status, 1)
            self.status.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            content.addLayout(languages)
            content.addWidget(self.translation, 1)
            actions = QHBoxLayout()
            actions.setSpacing(7)
            actions.addWidget(self.copy)
            actions.addWidget(self.mode_button)
            actions.addStretch()
            actions.addWidget(self.translate_button)
            grip = QSizeGrip(self)
            grip.setFixedSize(10, 10)
            actions.addWidget(grip, 0, Qt.AlignmentFlag.AlignBottom)
            content.addLayout(actions)
            layout.addLayout(content, 1)
        else:
            language_bar = QFrame()
            language_bar.setObjectName('languageBar')
            language_bar.setFixedHeight(45)
            languages = QHBoxLayout(language_bar)
            languages.setContentsMargins(0, 6, 0, 6)
            languages.setSpacing(0)
            left = QHBoxLayout()
            left.addStretch()
            left.addWidget(self.source_language)
            left.addStretch()
            right = QHBoxLayout()
            right.addStretch()
            right.addWidget(self.target_language)
            right.addStretch()
            languages.addLayout(left, 1)
            swap = button(name='icon', icon='swap')
            swap.setFixedSize(28, 28)
            swap.setAccessibleName('交換語言')
            swap.setToolTip('交換語言')
            swap.clicked.connect(self.swap_requested)
            languages.addWidget(swap)
            languages.addLayout(right, 1)
            layout.addWidget(language_bar)
            columns = QHBoxLayout()
            columns.setContentsMargins(0, 0, 0, 0)
            columns.setSpacing(0)
            columns.addWidget(self.source, 1)
            divider = QFrame()
            divider.setObjectName('divider')
            divider.setFixedWidth(1)
            columns.addWidget(divider)
            columns.addWidget(self.translation, 1)
            layout.addLayout(columns, 1)
            footer = QFrame()
            footer.setObjectName('footer')
            footer.setFixedHeight(39)
            actions = QHBoxLayout(footer)
            actions.setContentsMargins(12, 5, 5, 5)
            actions.setSpacing(7)
            self.count = QLabel('0 字')
            self.count.setObjectName('count')
            actions.addWidget(self.count)
            actions.addSpacing(9)
            actions.addWidget(self.status, 1)
            actions.addWidget(self.copy)
            actions.addWidget(self.mode_button)
            actions.addWidget(self.translate_button)
            grip = QSizeGrip(self)
            grip.setFixedSize(11, 11)
            actions.addWidget(grip, 0, Qt.AlignmentFlag.AlignBottom)
            layout.addWidget(footer)
            self.source.textChanged.connect(lambda: self.count.setText(f'{len(self.source.toPlainText()):,} 字'))

        QShortcut(QKeySequence('Esc'), self, activated=self.hide)
        QShortcut(QKeySequence('Ctrl+Return'), self, activated=self.translate_requested.emit)
        self.source.textChanged.connect(self.source_changed)
        self.source_language.currentIndexChanged.connect(self.language_changed)
        self.target_language.currentIndexChanged.connect(self.language_changed)
        self.ensurePolished()
        self.layout().activate()
        self.winId()

    def dismiss_if_inactive(self):
        if not self.compact or not self.isVisible():
            return
        for active in (QApplication.activePopupWidget(), QApplication.activeWindow()):
            while active is not None:
                if active is self:
                    return
                active = active.parentWidget()
        self.hide()

    def set_engine(self, engine, target):
        source = self.source_language.currentData() or 'auto'
        choices = languages_for(engine)
        source_choices = [('偵測語言', 'auto'), ('English', 'en'), ('中文', 'zh')] if engine == 'opus' else [('偵測語言', 'auto'), *choices]
        for combo, entries, selected in ((self.source_language, source_choices, source), (self.target_language, choices, target)):
            blocker = QSignalBlocker(combo)
            combo.clear()
            for label, code in entries:
                combo.addItem(label, code)
            index = combo.findData(selected)
            combo.setCurrentIndex(max(0, index))
            del blocker

    def event(self, event):
        handled = super().event(event)
        if (event.type() == QEvent.Type.WindowDeactivate
                and getattr(self, 'compact', False) and hasattr(self, 'dismiss_timer') and self.isVisible()):
            # Resolve focus after Qt has assigned it to the next window. Owned
            # language menus and preferences must not dismiss their own parent.
            self.dismiss_timer.start()
        return handled

    def showEvent(self, event):
        self.dismiss_timer.stop()
        super().showEvent(event)

    def paintEvent(self, event):
        if self.show_started is not None:
            self.paint_latencies.append((time.perf_counter() - self.show_started) * 1000)
            self.show_started = None
        super().paintEvent(event)

    def toggle_maximized(self):
        self.showNormal() if self.isMaximized() else self.showMaximized()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and event.position().y() < self.header.height():
            self.drag_position = event.globalPosition().toPoint() - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, event):
        if self.drag_position is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self.drag_position)

    def mouseReleaseEvent(self, event):
        self.drag_position = None

    def mouseDoubleClickEvent(self, event):
        if not self.compact and event.position().y() < self.header.height():
            self.toggle_maximized()

    def closeEvent(self, event):
        self.hide()
        event.ignore()
