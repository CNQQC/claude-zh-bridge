#!/usr/bin/env python3
"""Package only public browser runtime files; omit tests and local state."""
import json, subprocess, zipfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent
subprocess.run(['python3','scripts/audit_public.py'],cwd=root,check=True)
version=json.loads((root/'package.json').read_text())['version']
out=root/'dist';out.mkdir(exist_ok=True)
archive=out/f'claude-zh-bridge-extension-{version}.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted((root/'extension').iterdir()):
        if p.is_file() and (p.suffix in ['.js','.css','.html'] or p.name=='manifest.json'): z.write(p,'claude-zh-bridge/'+p.name)
subprocess.run(['python3','scripts/audit_public.py','--path',str(archive)],cwd=root,check=True)
print(archive.name)
