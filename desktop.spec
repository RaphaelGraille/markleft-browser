# -*- mode: python ; coding: utf-8 -*-
# PyInstaller build spec for the MarkLeft Browser desktop app.
# Build with: ./build.sh   (or directly: pyinstaller desktop.spec)
#
# Produces, depending on the platform this is run on:
#   macOS   -> dist/MarkLeft Browser.app   (a real .app bundle, via BUNDLE)
#   Windows -> dist/MarkLeft Browser.exe   (a single portable exe)
#   Linux   -> dist/MarkLeft Browser       (a single portable binary)
#
# Windows/Linux use PyInstaller's ONEFILE mode (passing a.binaries/a.datas
# straight to EXE) since there's no OS-native bundle format to put them in
# the way BUNDLE gives macOS one -- a single file is the simplest portable
# shape on those two platforms.
import sys

a = Analysis(
    ['desktop.py'],
    pathex=[],
    binaries=[],
    datas=[('static', 'static')],  # bundled so server.py can serve it inside the package
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

if sys.platform == 'darwin':
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name='MarkLeft Browser',
        debug=False,
        strip=False,
        upx=False,
        console=False,  # GUI app -- no terminal window
        icon='assets/AppIcon.icns',
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        name='MarkLeft Browser',
    )
    app = BUNDLE(
        coll,
        name='MarkLeft Browser.app',
        icon='assets/AppIcon.icns',
        bundle_identifier='com.raphaelgraille.mdbrowser',
        info_plist={
            'CFBundleName': 'MarkLeft Browser',
            'CFBundleDisplayName': 'MarkLeft Browser',
            'CFBundleShortVersionString': '1.0.0',
            'CFBundleVersion': '1.0.0',
            'NSHighResolutionCapable': True,
        },
    )
else:
    # Windows: PyInstaller appends .exe to the name automatically.
    # Linux: PyInstaller can't embed an icon in a plain ELF binary, so icon
    # is only passed on Windows.
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name='MarkLeft Browser',
        debug=False,
        strip=False,
        upx=False,
        console=False,  # GUI app -- no terminal window
        icon='assets/AppIcon.ico' if sys.platform == 'win32' else None,
    )
