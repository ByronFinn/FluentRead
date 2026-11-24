#!/usr/bin/env python3
"""Rebuild the independent six-page confusable suite from its pre-first-OCR design.

Requires Pillow 12.3.0 and the two exact font files declared in design.json.
No model/browser, downloads, expected-text-based selection, or main-corpus writes.
"""
from pathlib import Path
import argparse,hashlib,importlib.util,io,json,math,sys
sys.dont_write_bytecode=True
from PIL import Image,ImageDraw,ImageFont,ImageFilter
import PIL
HERE=Path(__file__).resolve().parent
FIXTURES=HERE.parent.parent/'tests'/'fixtures'/'manga-confusables'
sha=lambda data:hashlib.sha256(data).hexdigest()
def generate(out, japanese_font=None, monospace_font=None):
 if out.exists() or out.is_symlink():
  raise FileExistsError(f'Choose a new output directory; refusing to overwrite {out}')
 design_bytes=(FIXTURES/'design.json').read_bytes();design=json.loads(design_bytes)
 expected={f['name']:f for f in json.loads((FIXTURES/'manifest.json').read_text())['fixtures']}
 if PIL.__version__!=design['pillowVersion']:
  raise ValueError(f"Pillow {design['pillowVersion']} is required for byte reproduction; got {PIL.__version__}")
 # Import the maintained Page helper; never execute or copy the 28-scene generator.
 helper=HERE/'generate-manga-quality-fixtures.py'
 spec=importlib.util.spec_from_file_location('manga_quality_fixture_helpers',helper)
 source=importlib.util.module_from_spec(spec);spec.loader.exec_module(source)
 overrides={'cjk':japanese_font,'mono':monospace_font}
 fonts={f['key']:Path(overrides[f['key']] or f['path']) for f in design['fontFiles']}
 for f in design['fontFiles']:
  font=fonts[f['key']]
  if not font.is_file() or sha(font.read_bytes())!=f['sha256']:
   option='--japanese-font' if f['key']=='cjk' else '--monospace-font'
   raise ValueError(f"Pass {option} with the frozen font SHA-256 {f['sha256']}; checked {font}")
 pages=[];encoded_pages=[]
 for scene in design['scenes']:
  p=source.Page(scene['name'],tuple(design['size']),scene['sourceLanguage'],'Evidence-only generic low-confidence-path control; all outcomes retained, no OCR-driven selection',color=(221,225,224))
  if scene['background']=='white-balloons':
   p.panel((30,30,1570,970),fill=(238,237,226));p.balloon((80,130,1520,410));p.balloon((80,460,1520,750))
  elif scene['background']=='ruled-memo':
   p.draw.rectangle((60,80,1540,750),fill=(251,246,222),outline=(103,106,91),width=4)
   for y in range(180,736,62):p.draw.line((80,y,1520,y),fill=(207,215,202),width=2)
  elif scene['background']=='gray-labels':
   for box in [(80,140,1520,390),(80,470,1520,720)]:p.draw.rounded_rectangle(box,radius=24,fill=(237,240,239),outline=(99,116,117),width=4)
  else:raise AssertionError(scene['background'])
  for index,value in enumerate(scene['lines']):
   x,y=design['linePositions'][index]
   if 'runs' not in scene:
    font=ImageFont.truetype(str(fonts['cjk']),scene['fontSize'])
    p.styled_line(value,x,y,font,blur_radius=scene['blurRadius'],tail_fill=tuple(design['fill']),translation='受控译文用于独立诊断。')
   else:
    runs=scene['runs'][index];assert ''.join(run[1] for run in runs)==value
    active=[(key,text,ImageFont.truetype(str(fonts[key]),scene['latinFontSize'] if key=='mono' else scene['fontSize'])) for key,text in runs]
    width=math.ceil(sum(font.getlength(text) for _,text,font in active));ascent=max(font.getmetrics()[0] for _,_,font in active);descent=max(font.getmetrics()[1] for _,_,font in active)
    layer=Image.new('RGBA',(width+32,ascent+descent+32));draw=ImageDraw.Draw(layer);cursor=16
    for key,text,font in active:
     draw.text((cursor,16+ascent),text,font=font,anchor='ls',fill=(*design['fill'],255));cursor+=font.getlength(text)
    layer=layer.filter(ImageFilter.GaussianBlur(scene['blurRadius']));bounds=layer.getbbox();p.image.paste(layer,(x,y),layer)
    p.record['regions'].append({'id':f'line-{index+1}','text':value,'anchor':value,'translation':'受控译文用于独立诊断。','bbox':{'x0':x+bounds[0],'y0':y+bounds[1],'x1':x+bounds[2],'y1':y+bounds[3]},'vertical':False,'fontRuns':[{'fontKey':key,'text':text,'size':scene['latinFontSize'] if key=='mono' else scene['fontSize']} for key,text in runs],'blurRadius':scene['blurRadius']})
  p.draw.rounded_rectangle((1300,790,1490,930),radius=20,fill=(97,134,142),outline=(52,76,78),width=5)
  p.draw.ellipse((1340,815,1370,845),fill=(222,229,208));p.draw.ellipse((1420,815,1450,845),fill=(222,229,208));p.draw.line((1360,885,1430,885),fill=(54,80,83),width=8)
  p.negative((1280,770,1510,950),'unlettered-geometry-control');p.protect(1400,850);p.protect(40,40)
  p.record['textLanguage']=scene.get('textLanguage','ja')
  p.record['design']={key:scene[key] for key in ['fontSize','blurRadius','background']};p.record['design']['latinFontSize']=scene.get('latinFontSize')
  p.record['expectedSource']=scene['lines'];p.record['expectedAnchors']=scene['lines'];p.record['anchorOccurrences']={value:1 for value in scene['lines']}
  p.record['preOcrGeometryEstimates']=[]
  for region in p.record['regions']:
   b=region['bbox'];assert 0<=b['x0']<b['x1']<=p.image.width and 0<=b['y0']<b['y1']<=p.image.height
   aspect=(b['x1']-b['x0'])/(b['y1']-b['y0'])
   p.record['preOcrGeometryEstimates'].append({'regionId':region['id'],'inkAspect':aspect,'roughStepsAt48PxHeight':math.ceil(aspect*6),'scope':'Pre-OCR ink geometry only; actual detector crop, resize, steps and eligibility must be reported from the observer.'})
  encoded=io.BytesIO();p.image.save(encoded,format='PNG',optimize=False);data=encoded.getvalue()
  p.record['sha256']=sha(data);p.record['bytes']=len(data)
  p.record['provenance']={'original':True,'designFrozenBeforeAnyOcr':True,'designSha256':sha(design_bytes),'filterByOcrResult':False,'main32Unmodified':True}
  if p.record!=expected[scene['name']]:
   raise ValueError(f"Source pixels or metadata differ from the frozen fixture: {scene['name']}; do not update truth to accommodate OCR")
  encoded_pages.append((p.record['file'],data));pages.append(p)
 manifest={'version':1,'generator':'scripts/testing/generate-manga-confusable-fixtures.py','repositoryCommit':design['repositoryCommit'],'designSha256':sha(design_bytes),'pillowVersion':PIL.__version__,'fonts':[{key:f[key] for key in ['key','sha256']} for f in design['fontFiles']],'notes':['Evidence-only diagnostic sidecar; not included in the frozen 32-scene main corpus.','Source text, glyph fonts, size, blur, positions and background fixed before any OCR.','Keep correctly recognized, incorrectly recognized and ineligible high-confidence/long outputs alike.','Never read expectedSource or anchor strings to choose candidates or replace OCR results.'],'fixtures':[p.record for p in pages]}
 # Validate every rendered image and source record before creating any output.
 manifest_bytes=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
 out.mkdir(parents=True,exist_ok=False)
 for name,data in [*encoded_pages,('manifest.json',manifest_bytes)]:
  with (out/name).open('xb') as target:target.write(data)
 return manifest
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--out-dir',required=True,type=Path,help='Output directory for only this independent six-page suite')
 parser.add_argument('--japanese-font',type=Path,help='Exact Hiragino W4 font from design.json, at any local path')
 parser.add_argument('--monospace-font',type=Path,help='Exact Courier New font from design.json, at any local path')
 args=parser.parse_args()
 m=generate(args.out_dir,args.japanese_font,args.monospace_font)
 print(json.dumps({'scenes':len(m['fixtures']),'manifestSha256':sha((args.out_dir/'manifest.json').read_bytes())}))
