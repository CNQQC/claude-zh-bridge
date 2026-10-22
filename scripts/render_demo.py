#!/usr/bin/env python3
"""Edit actual app captures into a README GIF. No UI is synthesized.
Raw captures stay outside this repository. Adjust crops for your display size.
Requires Pillow. Captions live outside the app image.
"""
from pathlib import Path
import argparse, json
from PIL import Image, ImageDraw, ImageFont
parser=argparse.ArgumentParser()
parser.add_argument('captures',type=Path)
parser.add_argument('--output',type=Path,default=Path('docs/media'))
parser.add_argument('--frames-output',type=Path)
args=parser.parse_args()
args.output.mkdir(parents=True,exist_ok=True)
fontfile=Path('/System/Library/Fonts/STHeiti Medium.ttc')
font=ImageFont.truetype(str(fontfile),24) if fontfile.exists() else ImageFont.load_default()
smallfile=Path('/System/Library/Fonts/Helvetica.ttc')
small=ImageFont.truetype(str(smallfile),17) if smallfile.exists() else ImageFont.load_default()
meta=json.loads((args.captures/'frames.json').read_text())
chosen=[item for item in meta if item['tag'] in ['input-zh','live-response','cache-restore']]
frames=[];durations=[]
for item in chosen:
    original=Image.open(args.captures/item['file']).convert('RGB')
    if original.size!=(3840,1898): raise SystemExit('Review crops for this capture resolution before exporting.')
    is_input=item['tag']=='input-zh'
    bounds=(900,1530,2940,1840) if is_input else (900,150,2940,1030)
    crop=original.crop(bounds)
    crop.thumbnail((1120,484),Image.Resampling.LANCZOS)
    frame=Image.new('RGB',(1200,600),'#f6f4ef');draw=ImageDraw.Draw(frame)
    title='用中文输入，照常发送' if is_input else ('刷新后，继续中文阅读' if item['tag']=='cache-restore' else '英文回复生成后，自动显示中文')
    draw.ellipse((40,28,49,37),fill='#bd4c36')
    draw.text((62,21),title,font=font,fill='#282722')
    draw.text((938,28),'LIVE · CLAUDE DESKTOP',font=small,fill='#77746b')
    frame.paste(crop,((1200-crop.width)//2,68+(484-crop.height)//2))
    draw.text((40,570),'真实应用录制 · 已裁切界面并压缩等待时间',font=ImageFont.truetype(str(fontfile),17) if fontfile.exists() else small,fill='#7d786c')
    frames.append(frame)
    durations.append(1100 if is_input else 180 if item['tag']=='live-response' else 230)
# Leave the completed Chinese reply readable at the end of each stage.
for index,item in enumerate(chosen):
    if index+1==len(chosen) or chosen[index+1]['tag']!=item['tag']:
        durations[index]=2000 if item['tag']!='input-zh' else 1100
if args.frames_output:
    args.frames_output.mkdir(parents=True,exist_ok=True)
    for index,frame in enumerate(frames): frame.save(args.frames_output/f'{index:03}.png')
frames[-1].save(args.output/'claude-live.png')
palette=[frame.quantize(colors=128,method=Image.Quantize.MEDIANCUT) for frame in frames]
palette[0].save(args.output/'claude-live.gif',save_all=True,append_images=palette[1:],duration=durations,loop=0,optimize=True,disposal=2)
print(f'Edited {len(frames)} actual captures; no account/sidebar pixels included in the selected crop.')
