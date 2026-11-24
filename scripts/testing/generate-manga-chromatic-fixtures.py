#!/usr/bin/env python3
"""Generate eight original chromatic diagnostics from the pre-OCR frozen design. No models."""
from pathlib import Path
import argparse, hashlib, io, json, math
import PIL
from PIL import Image, ImageDraw, ImageFont

HERE=Path(__file__).resolve().parent
FIXTURES=HERE.parent.parent/'tests'/'fixtures'/'manga-chromatic'
FROZEN_FIXTURES_SHA='4489bca5470305202e07d533bdb0e399e8bfc355b86f3328e088c3e4a42264d4'
FROZEN_CONTENT_SHA='e03d96b352f29e32ecaf8d305175e692a70c9f3e2c9362a866f4dcd1f5fcf371'
ORIGINAL_GENERATOR_SHA='022aacee37d2456bf11f529aa5808525bb172c0d27c140b8300a0c355f2fea2b'
DESIGN_SHA='1287de36a49b5002a2ee1e0a2be683a685ca30db40a9efa5288e35fa605935e6'
def sha(data): return hashlib.sha256(data).hexdigest()
def content_sha(value): return sha(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
def frozen_manifest(value):
 if content_sha(value.get('fixtures'))!=FROZEN_FIXTURES_SHA:raise ValueError('Complete pre-OCR fixture content is immutable')
 payload={k:v for k,v in value.items() if k not in ['generator','generatorSha256']}
 if content_sha(payload)!=FROZEN_CONTENT_SHA:raise ValueError('Complete pre-OCR manifest content is immutable')
 allowed={'generate-chromatic-fixtures.py':ORIGINAL_GENERATOR_SHA,'scripts/testing/generate-manga-chromatic-fixtures.py':sha(Path(__file__).read_bytes())}
 if value.get('generator') not in allowed or value.get('generatorSha256')!=allowed[value['generator']]:raise ValueError('Only the original or exact maintained generator provenance is allowed')
 return payload
def box(values): return dict(zip(('x0','y0','x1','y1'),values))
def intersects(a,b): return min(a['x1'],b['x1'])>max(a['x0'],b['x0']) and min(a['y1'],b['y1'])>max(a['y0'],b['y0'])

def artwork(name,size):
 w,h=size;rgba=name.startswith('translucent-')
 im=Image.new('RGBA',size,(0,0,0,0) if rgba else (255,255,255,255));d=ImageDraw.Draw(im)
 if name=='white-red-magenta-independent-labels':
  d.rectangle((25,25,875,875),outline=(210,210,210,255),width=2)
  for x,c in [(240,(255,0,0,255)),(450,(255,0,255,255)),(660,(80,80,80,255))]:
   d.line((x,650,x,795),fill=c,width=3);d.ellipse((x-38,682,x+38,758),outline=c,width=5);d.ellipse((x-7,713,x+7,727),fill=c)
 elif name=='black-cyan-oxygen-hud':
  im.paste((0,0,0,255),(0,0,w,h));d=ImageDraw.Draw(im)
  d.rounded_rectangle((40,60,860,450),radius=24,outline=(0,180,200,255),width=3)
  for x in range(100,820,40):d.line((x,560,x,820),fill=(25,37,42,255),width=1)
  for y in range(560,821,40):d.line((100,y,800,y),fill=(25,37,42,255),width=1)
  for x,c in [(200,(0,255,255,255)),(450,(255,190,0,255)),(700,(0,255,255,255))]:
   d.arc((x-55,655,x+55,765),0,330,fill=c,width=5);d.ellipse((x-6,704,x+6,716),fill=c)
 elif name=='equal-luma-red-green-cards':
  im.paste((70,75,80,255),(0,0,w,h));d=ImageDraw.Draw(im)
  d.rectangle((40,100,860,300),fill=(0,130,0,255));d.rectangle((40,340,860,540),fill=(255,0,0,255));d.rectangle((40,590,860,690),fill=(255,255,255,255))
  for x,c in [(160,(255,0,0,255)),(450,(0,130,0,255)),(740,(255,0,0,255))]:
   d.rectangle((x-45,745,x+45,835),fill=c);d.ellipse((x-20,770,x+20,810),fill=(0,130,0,255) if x!=450 else (255,0,0,255))
 elif name=='translucent-red-dialogue-overlay':
  d.ellipse((50,80,850,300),fill=(255,0,0,24),outline=(255,0,0,150),width=5)
  d.rounded_rectangle((100,360,800,560),radius=20,fill=(255,0,0,30),outline=(255,0,0,140),width=3)
  d.line((250,800,650,800),fill=(255,0,0,60),width=3)
  for x in [250,450,650]:d.ellipse((x-22,778,x+22,822),fill=(255,0,0,255));d.arc((x-36,764,x+36,836),20,300,fill=(255,0,0,120),width=2)
 elif name=='translucent-cyan-night-hud':
  d.rounded_rectangle((55,90,845,245),radius=20,outline=(0,255,255,80),width=4)
  d.line((60,295,820,295),fill=(0,255,255,55),width=2);d.rectangle((60,280,820,440),outline=(0,255,255,80),width=3)
  for x in [200,450,700]:
   d.line((x,660,x,825),fill=(0,255,255,80),width=2);d.ellipse((x-30,720,x+30,780),outline=(0,255,255,150),width=3);d.ellipse((x-18,732,x+18,768),fill=(0,255,255,255))
 elif name=='thin-aa-gray-and-chromatic-tail':
  d.rectangle((25,25,875,875),outline=(235,235,235,255),width=1)
  for x,y,c in [(120,720,(110,110,110,255)),(450,740,(255,170,210,255)),(780,760,(35,100,220,255))]:
   d.line((x-35,y+50,x+20,y-60),fill=c,width=1);d.ellipse((x-4,y-4,x+4,y+4),fill=c)
 elif name=='mixed-color-edge-screenshot':
  for y in range(h):
   for x in range(w):
    im.putpixel((x,y),(int(48+55*x/(w-1)+8*math.sin(y/31)),int(74+65*y/(h-1)),int(105+50*(1-x/(w-1))),255))
  d=ImageDraw.Draw(im);d.polygon([(35,65),(865,95),(840,210),(45,185)],fill=(130,57,77,255))
  d.rounded_rectangle((80,300,420,430),radius=10,fill=(40,110,150,255),outline=(255,160,100,255),width=4)
  d.rounded_rectangle((480,300,820,430),radius=10,fill=(180,80,55,255),outline=(40,210,240,255),width=4)
  # The control really spans a nonuniform colored strip rather than an exact white/black crop border.
  for y in range(475,565):
   for x in range(40,860):d.point((x,y),fill=(50+(x%31),60+(y%19),80+(x+y)%27,255))
  for x,c in [(150,(250,170,80,255)),(450,(60,210,200,255)),(750,(170,140,240,255))]:
   d.polygon([(x-55,810),(x-35,710),(x+30,680),(x+55,810)],fill=c);d.ellipse((x-6,744,x+6,756),fill=c)
 elif name=='wordless-chromatic-diagram':
  d.rectangle((0,0,449,449),fill=(255,255,255,255));d.rectangle((450,0,899,449),fill=(0,0,0,255))
  d.rectangle((0,450,449,899),fill=(0,130,0,255));d.rectangle((450,450,899,899),fill=(255,0,0,255))
  for n in range(5):
   d.ellipse((60+n*23,60+n*23,380-n*23,380-n*23),outline=(255,0,0,255),width=4)
   d.arc((500+n*17,40+n*17,840-n*17,390-n*17),20,320,fill=(0,255,255,255),width=5)
  d.polygon([(60,790),(160,520),(300,710),(410,540),(370,850)],fill=(255,0,0,255))
  d.polygon([(490,800),(600,510),(730,710),(850,540),(820,860)],fill=(0,130,0,255))
  d.line((450,600,450,850),fill=(255,0,255,255),width=6)
 else:raise ValueError(name)
 return im

def glyph(spec,fonts):
 scale=spec.get('supersample',1);font=ImageFont.truetype(str(fonts[spec['fontKey']]),spec['fontSize']*scale)
 raw=font.getbbox(spec['text']);sw,sh=raw[2]-raw[0],raw[3]-raw[1]
 if sw*sh>2000000:raise ValueError('Supersampled glyph resource cap exceeded')
 mask=Image.new('L',(sw,sh));ImageDraw.Draw(mask).text((-raw[0],-raw[1]),spec['text'],font=font,fill=255)
 if scale!=1:mask=mask.resize((math.ceil(sw/scale),math.ceil(sh/scale)),Image.Resampling.LANCZOS)
 layer=Image.new('RGBA',mask.size,tuple(spec['fill'])+(255,))
 if 'prefix' in spec:
  cutoff=math.ceil((font.getlength(spec['prefix'])-raw[0])/scale);ImageDraw.Draw(layer).rectangle((0,0,cutoff-1,mask.height),fill=tuple(spec['prefixFill'])+(255,))
 alpha=spec['alpha'];layer.putalpha(mask.point(lambda v:(v*alpha+127)//255));return layer

def generate(out,design_path,font_overrides,reference=None):
 if out.exists() or out.is_symlink():raise FileExistsError('Choose a nonexistent output directory; never overwrite existing artifacts')
 reference=FIXTURES/'manifest.json' if reference is None else reference
 reference_payload=frozen_manifest(json.loads(reference.read_text()))
 db=design_path.read_bytes()
 if sha(db)!=DESIGN_SHA:raise ValueError('Design does not match the pre-first-OCR freeze')
 design=json.loads(db)
 if PIL.__version__!=design['pillowVersion']:raise ValueError('Exact frozen Pillow version required')
 fonts={f['key']:Path(font_overrides.get(f['key'],f['path'])) for f in design['fontFiles']}
 for f in design['fontFiles']:
  if not fonts[f['key']].is_file() or sha(fonts[f['key']].read_bytes())!=f['sha256']:raise ValueError('Exact frozen font required: '+f['key'])
 records=[];encoded=[]
 for scene in design['scenes']:
  im=artwork(scene['name'],tuple(design['size']));w,h=im.size;regions=[]
  for spec in scene['regions']:
   layer=glyph(spec,fonts);local=layer.getbbox();assert local
   b=box((spec['x']+local[0],spec['y']+local[1],spec['x']+local[2],spec['y']+local[3]))
   if not (0<=b['x0']<b['x1']<=w and 0<=b['y0']<b['y1']<=h):raise ValueError('Full source glyph escapes image: '+spec['id'])
   im.alpha_composite(layer,(spec['x'],spec['y']))
   regions.append({'id':spec['id'],'text':spec['text'],'anchor':spec['text'],'translation':'受控译文用于彩色文本回归。','bbox':b,'vertical':False,'fontSize':spec['fontSize'],'fontKey':spec['fontKey'],'paragraphId':spec['paragraphId'],'sourceStyle':{k:v for k,v in spec.items() if k in ['fill','alpha','supersample','prefix','prefixFill']},'glyphAlphaSha256':sha(layer.getchannel('A').tobytes())})
  negatives=[{'id':'wordless-art-'+str(i+1),'bbox':box(b)} for i,b in enumerate(scene['negativeRegions'])]
  if any(intersects(n['bbox'],r['bbox']) for n in negatives for r in regions):raise ValueError('Negative region overlaps real source glyphs')
  protects=[]
  for x,y in scene['protectedPoints']:
   rgba=im.getpixel((x,y))
   if rgba[3]!=255:raise ValueError('Standard protected pixel must be opaque')
   protects.append({'x':x,'y':y,'rgb':list(rgba[:3])})
  groups={}
  for r in regions:groups.setdefault(r['paragraphId'],[]).append(r['id'])
  record={'name':scene['name'],'file':scene['name']+'.png','mime':'image/png','width':w,'height':h,'sourceLanguage':scene['sourceLanguage'],'scene':scene['category'],'regions':regions,'expectedSource':[r['text'] for r in regions],'expectedAnchors':[r['text'] for r in regions],'anchorOccurrences':{r['text']:sum(q['text']==r['text'] for q in regions) for r in regions},'forbiddenRegions':negatives,'protectedProbes':protects,'tileBoundaryCrossings':[],'provenance':{'originalArtworkAndText':True,'sourceDesignedBeforeAnyOcr':True,'selectionByOcrResult':False,'designSha256':DESIGN_SHA,'old43Unmodified':True}}
  if groups:record['paragraphGroups']=list(groups.values())
  if scene.get('expectedNoText'):record['expectedNoText']=True
  if 'rgbaProbePoints' in scene:record['protectedRgbaProbes']=[{'x':x,'y':y,'rgba':list(im.getpixel((x,y)))} for x,y in scene['rgbaProbePoints']]
  if 'lumaPair' in scene:record['lumaPair']=scene['lumaPair']
  if scene['mode']=='RGB':im=im.convert('RGB')
  data=io.BytesIO();im.save(data,format='PNG',optimize=False);data=data.getvalue();record.update({'sha256':sha(data),'bytes':len(data),'imageMode':scene['mode']});records.append(record);encoded.append((record['file'],data))
 manifest={'version':1,'generator':'scripts/testing/generate-manga-chromatic-fixtures.py','generatorSha256':sha(Path(__file__).read_bytes()),'designSha256':DESIGN_SHA,'sourceFrozenAtUtc':design['frozenAtUtc'],'pillowVersion':PIL.__version__,'fonts':[{k:f[k] for k in ['key','sha256']} for f in design['fontFiles']],'notes':['Eight original deterministic chromatic diagnostics, independently frozen before any OCR.','No actual model crop edge or expected OCR result is prescribed; model detection decides physical crops.','Complete original strings are anchors, including low-contrast tail, small gray Latin/digits and CJK.','Independent suite; no old43 asset, manifest, truth or generator is modified; no fonts or model data bundled.'],'fixtures':records}
 if frozen_manifest(manifest)!=reference_payload:raise ValueError('Generated pixels or metadata drift from the frozen first generation')
 mb=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
 # Every font, image, glyph, negative, protection and optional full-manifest comparison completes before mkdir.
 out.mkdir(parents=True,exist_ok=False)
 for f,data in [*encoded,('manifest.json',mb)]:
  with (out/f).open('xb') as target:target.write(data)
 return manifest

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out-dir',type=Path,required=True);parser.add_argument('--design',type=Path,default=FIXTURES/'design.json');parser.add_argument('--reference-manifest',type=Path)
 for key in ['bold','regular','cjk']:parser.add_argument('--'+key+'-font',type=Path)
 args=parser.parse_args();m=generate(args.out_dir,args.design,{k:str(getattr(args,k+'_font')) for k in ['bold','regular','cjk'] if getattr(args,k+'_font')},args.reference_manifest)
 print(json.dumps({'scenes':len(m['fixtures']),'anchors':sum(len(f['expectedAnchors']) for f in m['fixtures']),'manifestSha256':sha((args.out_dir/'manifest.json').read_bytes()),'pngBytes':sum(f['bytes'] for f in m['fixtures'])},indent=2))
