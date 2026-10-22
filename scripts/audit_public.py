#!/usr/bin/env python3
"""Fail closed on credentials, personal paths and accidentally bundled local state.

No matching value is ever printed. Test-only sk-fixture-* values are synthetic.
Use --deny-file outside the repository for a local exact-secret comparison.
"""
import argparse, re, subprocess, sys, zipfile, io
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--path',type=Path,default=ROOT)
parser.add_argument('--history',action='store_true')
parser.add_argument('--deny-file',type=Path)
args=parser.parse_args()
exact=[]
if args.deny_file:
    exact=re.findall(rb'sk-[A-Za-z0-9_-]{16,}',args.deny_file.read_bytes())
issues=[]
KEY=re.compile(rb'sk-[A-Za-z0-9_-]{16,}')
PERSONAL_PATH=re.compile(rb'/Users/(?!runner(?:/|$)|builder(?:/|$)|example(?:/|$)|user(?:/|$))[A-Za-z0-9._-]+')
TOKENS=re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)')
FORBIDDEN={'PrivateDefaults.json','cache.json','config.json','local-installation.json','installed-manifest.json','.DS_Store','.env'}
SKIP={'.git','node_modules','.build','dist','__pycache__'}
def inspect(name,data):
    if Path(name).name in FORBIDDEN: issues.append((name,'local state or private defaults'))
    if any(value in data for value in exact): issues.append((name,'known private credential'))
    for match in KEY.finditer(data):
        if not match.group().startswith((b'sk-fixture-',b'sk-example-',b'sk-test-')): issues.append((name,'provider credential'))
    if TOKENS.search(data): issues.append((name,'credential material'))
    if PERSONAL_PATH.search(data): issues.append((name,'personal absolute path'))
    if name.endswith(('.zip','.whl')):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for item in archive.infolist():
                    if not item.is_dir(): inspect(name+'!'+item.filename,archive.read(item))
        except zipfile.BadZipFile: issues.append((name,'unreadable archive'))
def walk(target):
    if target.is_file(): return [target]
    return [p for p in target.rglob('*') if p.is_file() and not any(part in SKIP for part in p.relative_to(target).parts)]
for file in walk(args.path.resolve()): inspect(str(file.relative_to(args.path.resolve())) if args.path.is_dir() else file.name,file.read_bytes())
if args.history:
    result=subprocess.run(['git','rev-list','--objects','--all'],cwd=ROOT,text=True,capture_output=True,check=True)
    for line in result.stdout.splitlines():
        sha,_,name=line.partition(' ')
        kind=subprocess.run(['git','cat-file','-t',sha],cwd=ROOT,text=True,capture_output=True,check=True).stdout.strip()
        if kind=='blob': inspect('history:'+name,subprocess.run(['git','cat-file','blob',sha],cwd=ROOT,capture_output=True,check=True).stdout)
if issues:
    for name,rule in sorted(set(issues)): print(f'BLOCKED {name}: {rule}',file=sys.stderr)
    raise SystemExit(1)
print('Public audit passed: no provider credentials, personal paths or local state found'+(' in all Git blobs.' if args.history else '.'))
