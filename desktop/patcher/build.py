#!/usr/bin/env python3
"""Build the public macOS patcher. Never reads a user key or installed Claude."""
import argparse, json, plistlib, shutil, subprocess
from pathlib import Path
root = Path(__file__).resolve().parent
repo = root.parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=repo/'dist/Claude 中文桥.app')
parser.add_argument('--binary', type=Path)
args = parser.parse_args()
app = args.output.resolve()
if app.exists():
    raise SystemExit('Output already exists. Choose a fresh path; existing apps are never overwritten.')
subprocess.run(['node', 'scripts/build.mjs'], cwd=repo, check=True)
subprocess.run(['python3', 'scripts/audit_public.py'], cwd=repo, check=True)
build = repo/'.build'
build.mkdir(exist_ok=True)
binary = args.binary or build/'ClaudeZhPatcher'
if args.binary is None:
    subprocess.run(['swiftc', '-swift-version', '5', '-parse-as-library', '-O', '-target', 'arm64-apple-macos14.0',
                    '-file-prefix-map', str(repo)+'=.', '-debug-prefix-map', str(repo)+'=.',
                    '-module-cache-path', str(build/'module-cache'),
                    *[str(root/'Sources'/name) for name in ['Core.swift','Installer.swift','App.swift']],
                    '-o', str(binary)], check=True, cwd=repo)
resources = app/'Contents/Resources'
executable = app/'Contents/MacOS/ClaudeZhPatcher'
executable.parent.mkdir(parents=True)
resources.mkdir(parents=True)
shutil.copy2(binary, executable)
executable.chmod(0o755)
payload = resources/'Bridge'
(payload/'extension').mkdir(parents=True)
bridge = root.parent/'bridge'
for name in ['main.cjs','backend.cjs','storage.cjs','config.cjs','preload.cjs']:
    shutil.copy2(bridge/name, payload/name)
for file in (bridge/'extension').iterdir():
    if file.is_file(): shutil.copy2(file, payload/'extension'/file.name)
version = json.loads((repo/'package.json').read_text())['version']
info = {'CFBundleName':'Claude 中文桥','CFBundleDisplayName':'Claude 中文桥','CFBundleIdentifier':'local.claude-zh.patcher',
        'CFBundleExecutable':'ClaudeZhPatcher','CFBundleShortVersionString':version,'CFBundleVersion':version.replace('.',''),
        'CFBundlePackageType':'APPL','LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True,
        'NSPrincipalClass':'NSApplication','NSHumanReadableCopyright':'Unofficial open-source project. MIT License.'}
iconset = build/'AppIcon.iconset'
subprocess.run(['swift','-module-cache-path',str(build/'module-cache'),str(root/'Sources/MakeIcon.swift'),str(iconset)],check=True)
subprocess.run(['/usr/bin/iconutil','-c','icns',str(iconset),'-o',str(resources/'AppIcon.icns')],check=True)
info['CFBundleIconFile']='AppIcon'
(app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
subprocess.run(['python3','scripts/audit_public.py','--path',str(app)],cwd=repo,check=True)
subprocess.run(['codesign','--force','--sign','-','--timestamp=none',str(app)],check=True,capture_output=True)
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
print('Built public macOS app: no embedded provider key, no Claude bundle, no installation changes.')
