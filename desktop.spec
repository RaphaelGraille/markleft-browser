# -*- mode: python ; coding: utf-8 -*-
# PyInstaller build spec for the MarkLeft Browser desktop app.
# Build with: ./build.sh   (or directly: pyinstaller desktop.spec)
# Produces: dist/MarkLeft Browser.app

a = Analysis(
    ['desktop.py'],
    pathex=[],
    binaries=[],
    datas=[('static', 'static')],  # bundled so server.py can serve it inside the .app
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

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
