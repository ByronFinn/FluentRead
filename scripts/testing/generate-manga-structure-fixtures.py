#!/usr/bin/env python3
"""Original five-scene geometry corpus; validate all inputs and render before exclusive new-directory writes."""
from pathlib import Path
import argparse,hashlib,importlib.util,io,json,math,sys
sys.dont_write_bytecode=True
import PIL
from PIL import Image,ImageDraw,ImageFont,ImageFilter
HERE=Path(__file__).resolve().parent
FIXTURES=HERE.parent.parent/'tests'/'fixtures'/'manga-structures'
sha=lambda b:hashlib.sha256(b).hexdigest()

def solve(matrix,vector):
 a=[list(map(float,row))+[float(v)] for row,v in zip(matrix,vector)]
 for i in range(len(a)):
  pivot=max(range(i,len(a)),key=lambda r:abs(a[r][i]));a[i],a[pivot]=a[pivot],a[i]
  assert abs(a[i][i])>1e-10
  value=a[i][i];a[i]=[v/value for v in a[i]]
  for j in range(len(a)):
   if i==j:continue
   factor=a[j][i];a[j]=[x-factor*y for x,y in zip(a[j],a[i])]
 return [row[-1] for row in a]

def homography(source,target):
 rows=[];values=[]
 for (x,y),(u,v) in zip(source,target):
  rows.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]);values.extend([u,v])
 return tuple(solve(rows,values))

def generate(out,design_path,helper_path,font_overrides=None):
 if out.exists() or out.is_symlink():raise FileExistsError('Choose a new output directory; no existing path may be overwritten')
 design_bytes=design_path.read_bytes();design=json.loads(design_bytes)
 frozen_manifest=json.loads((FIXTURES/'manifest.json').read_text())
 if sha(design_bytes)!=frozen_manifest['designSha256']:raise ValueError('Design differs from the repository pre-OCR freeze')
 if PIL.__version__!=design['pillowVersion']:raise ValueError('Frozen Pillow version required: '+design['pillowVersion'])
 if sha(helper_path.read_bytes())!=design['pageHelperSha256']:raise ValueError('Page helper differs from frozen source')
 spec=importlib.util.spec_from_file_location('maintained_page_helper',helper_path);helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
 fonts={f['key']:Path((font_overrides or {}).get(f['key'],f['path'])) for f in design['fontFiles']}
 for f in design['fontFiles']:
  if not fonts[f['key']].is_file() or sha(fonts[f['key']].read_bytes())!=f['sha256']:raise ValueError('Exact frozen font required: '+f['key'])
 pages=[];encoded=[]
 for s in design['scenes']:
  p=helper.Page(s['name'],tuple(s['size']),s['language'],s['structure'],color=(220,225,224));name=s['name']
  if name=='narrow-inset-card-dialogue':
   p.panel((30,30,970,1170),fill=(229,236,229));p.balloon((100,80,900,820))
   p.draw.rectangle((330,310,360,490),fill=(20,25,30));p.draw.rectangle((333,313,357,487),fill='white')
   for x in range(140,900,120):p.draw.ellipse((x,1050,x+48,1120),fill=(79,130,112),outline=(25,55,46),width=3)
  elif name=='midband-crossing-detached-cards':
   p.panel((30,30,1170,1170),fill=(224,231,240));p.balloon((150,100,1050,860))
   for x,y in [(700,220),(800,570)]:p.draw.rectangle((x,y,x+30,y+180),fill=(20,25,30));p.draw.rectangle((x+3,y+3,x+27,y+177),fill='white')
   for x in range(120,1100,160):p.draw.polygon([(x,950),(x+40,910),(x+80,950)],fill=(75,109,145))
  elif name=='bound-spread-gutter-caption':
   p.draw.rectangle((45,45,1555,1005),fill=(69,60,52));p.draw.rectangle((60,60,790,990),fill=(247,241,224));p.draw.rectangle((810,60,1540,990),fill=(243,237,217))
   for x in range(740,861):
    value=int(55+150*abs(x-800)/60);p.draw.line((x,62,x,988),fill=(value,value-4,value-12))
   p.draw.ellipse((200,660,500,940),outline=(64,89,91),width=8);p.draw.line((350,675,350,925),fill=(64,89,91),width=5);p.draw.line((215,800,485,800),fill=(64,89,91),width=5)
   for y in range(700,920,70):p.draw.ellipse((1120,y,1370,y+55),fill=(74,123,94));p.draw.line((1250,670,1250,940),fill=(49,91,65),width=9)
  elif name=='multisize-margin-callouts':
   p.panel((25,25,1175,1375),fill=(238,234,213));p.balloon((200,130,900,700))
   p.draw.line((600,880,600,1240),fill=(53,105,70),width=14)
   for y,sign in [(930,-1),(1010,1),(1100,-1)]:p.draw.ellipse((600 if sign>0 else 425,y-55,775 if sign>0 else 600,y+45),fill=(100,151,93),outline=(53,105,70),width=4)
   p.draw.line((600,1240,525,1310),fill=(126,92,66),width=8);p.draw.line((600,1240,660,1320),fill=(126,92,66),width=8)
   p.draw.line((835,925,760,1010),fill=(83,83,73),width=2);p.draw.line((805,1155,650,1280),fill=(83,83,73),width=2)
  elif name=='photographed-perspective-note':
   for y in range(p.image.height):
    for x in range(p.image.width):
     grain=((x*13+y*7+(x//70)*19)%31)-15;v=math.sin(y/48+x/400)*8
     p.image.putpixel((x,y),(max(0,min(255,int(143+grain+v))),max(0,min(255,int(110+grain*.5+v))),max(0,min(255,int(78+grain*.3+v)))))
   shadow=Image.new('RGBA',p.image.size);ImageDraw.Draw(shadow).polygon([(x+18,y+25) for x,y in s['paperQuad']],fill=(0,0,0,90));shadow=shadow.filter(ImageFilter.GaussianBlur(16));p.image.paste(shadow,(0,0),shadow)
   paper=Image.new('RGBA',tuple(s['paperSize']),(245,240,221,255));d=ImageDraw.Draw(paper)
   for y in range(180,610,48):d.line((50,y,1130,y),fill=(208,214,203),width=1)
   d.ellipse((770,440,1010,620),fill=(76,128,156),outline=(40,77,99),width=5);d.arc((980,475,1080,575),-90,90,fill=(40,77,99),width=10);d.ellipse((790,450,990,475),fill=(186,210,212))
   corners=[(0,0),(s['paperSize'][0],0),tuple(s['paperSize']),(0,s['paperSize'][1])];inverse=homography(s['paperQuad'],corners)
   p.draw=ImageDraw.Draw(p.image)
   p.draw.polygon([(1340,105),(1570,130),(1545,300),(1320,275)],fill=(229,210,118),outline=(108,90,44))
  else:raise ValueError(name)
  for r in s['regions']:
   target=paper if r.get('paper') else p.image;font=ImageFont.truetype(str(fonts[r['fontKey']]),r['fontSize']);mask=Image.new('RGBA',target.size);d=ImageDraw.Draw(mask);fill=tuple(r.get('fill',[18,25,29]))+(255,)
   if r['vertical']:
    for i,char in enumerate(r['text']):
     b=d.textbbox((0,0),char,font=font);d.text((r['x']-b[0],r['y']+i*r['advance']-b[1]),char,font=font,fill=fill)
   elif r.get('rotation'):
    b=d.textbbox((0,0),r['text'],font=font);label=Image.new('RGBA',(b[2]-b[0]+8,b[3]-b[1]+8));ImageDraw.Draw(label).text((4-b[0],4-b[1]),r['text'],font=font,fill=fill);label=label.rotate(r['rotation'],expand=True,resample=Image.Resampling.BICUBIC);mask.alpha_composite(label,(r['x'],r['y']))
   else:
    b=d.textbbox((0,0),r['text'],font=font);d.text((r['x']-b[0],r['y']-b[1]),r['text'],font=font,fill=fill)
   box=mask.getbbox();assert box
   if r.get('paper'):
    paper.alpha_composite(mask);warped=mask.transform(p.image.size,Image.Transform.PERSPECTIVE,inverse,Image.Resampling.BICUBIC);box=warped.getbbox()
   else:target.paste(mask,(0,0),mask)
   assert 0<=box[0]<box[2]<=p.image.width and 0<=box[1]<box[3]<=p.image.height
   p.record['regions'].append({'id':r['id'],'text':r['text'],'anchor':r['text'],'translation':'受控译文用于结构回归。','bbox':dict(zip(['x0','y0','x1','y1'],box)),'vertical':r['vertical'],'fontKey':r['fontKey'],'fontSize':r['fontSize'],'paragraphId':r['paragraphId'],'rotationDegrees':r.get('rotation',0),'perspectiveTransformed':bool(r.get('paper'))})
  if name=='photographed-perspective-note':
   warped=paper.transform(p.image.size,Image.Transform.PERSPECTIVE,inverse,Image.Resampling.BICUBIC);p.image.paste(warped,(0,0),warped)
  # Gutter shading applies to the original printed title and paper alike, without erasing any source glyph.
  if name=='bound-spread-gutter-caption':
   overlay=Image.new('RGBA',p.image.size);d=ImageDraw.Draw(overlay)
   for x in range(755,846):d.line((x,100,x,250),fill=(10,8,5,int(80*(1-abs(x-800)/45))))
   p.image.paste(overlay,(0,0),overlay)
  p.record['expectedSource']=[r['text'] for r in s['regions']];p.record['expectedAnchors']=p.record['expectedSource'];p.record['anchorOccurrences']={text:p.record['expectedSource'].count(text) for text in p.record['expectedSource']}
  groups={}
  for r in s['regions']:groups.setdefault(r['paragraphId'],[]).append(r['id'])
  p.record['paragraphGroups']=list(groups.values())
  for i,box in enumerate(s['negativeRegions']):p.negative(box,'unlettered-art-'+str(i+1))
  for x,y in s['protectedPoints']:p.protect(x,y)
  for negative in p.record['forbiddenRegions']:
   a=negative['bbox']
   for region in p.record['regions']:
    b=region['bbox'];assert min(a['x1'],b['x1'])<=max(a['x0'],b['x0']) or min(a['y1'],b['y1'])<=max(a['y0'],b['y0']),('negative overlaps source',name,region['id'])
  p.record['provenance']={'originalArtworkAndText':True,'sourceDesignedBeforeAnyOcr':True,'designSha256':sha(design_bytes),'selectionByOcrResult':False,'main32AndSixConfusablesUnmodified':True}
  encoded_png=io.BytesIO();p.image.save(encoded_png,format='PNG',optimize=False);data=encoded_png.getvalue();p.record.update({'sha256':sha(data),'bytes':len(data)});pages.append(p);encoded.append((p.record['file'],data))
 manifest={'version':1,'generator':'scripts/testing/generate-manga-structure-fixtures.py','designSha256':sha(design_bytes),'pillowVersion':PIL.__version__,'fonts':[{k:f[k] for k in ['key','sha256']} for f in design['fontFiles']],'notes':['Independent five-scene structural stress suite. No OCR/model run before source freeze.','All original source strings are complete anchors, including small ruby and narrow-card text.','paragraphGroups preserves explicit source grouping and independent single-card paragraphs; source regions are never split to manufacture groups.'],'fixtures':[p.record for p in pages]}
 if manifest!=frozen_manifest:raise ValueError('Rendered pixels or fixture metadata differ from the repository pre-OCR freeze; do not update truth to accommodate rendering drift')
 data=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode();out.mkdir(parents=True,exist_ok=False)
 for name,data in [*encoded,('manifest.json',data)]:
  with (out/name).open('xb') as target:target.write(data)
 return manifest

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out-dir',required=True,type=Path);parser.add_argument('--design',type=Path,default=FIXTURES/'design.json');parser.add_argument('--page-helper',type=Path,default=HERE/'generate-manga-quality-fixtures.py');parser.add_argument('--font',action='append',default=[],help='key=local-path with the exact frozen SHA, repeatable')
 args=parser.parse_args();overrides=dict(value.split('=',1) for value in args.font);result=generate(args.out_dir,args.design,args.page_helper,overrides);print(json.dumps({'scenes':len(result['fixtures']),'anchors':sum(len(f['regions']) for f in result['fixtures']),'manifestSha256':sha((args.out_dir/'manifest.json').read_bytes())}))
