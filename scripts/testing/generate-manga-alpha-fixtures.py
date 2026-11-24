#!/usr/bin/env python3
"""Rebuild six original alpha/structure fixtures into a nonexistent directory; no OCR or models."""
from pathlib import Path
import argparse
import hashlib
import io
import json
import math
import sys

sys.dont_write_bytecode = True
import PIL
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent.parent / 'tests' / 'fixtures' / 'manga-alpha'
DESIGN_SHA = '0a576bb798af2ae15632ac9a3e1576fe9dfc84c35e34756e4f01efd48afd5de7'
FROZEN_FIXTURES_SHA = '8bf003458009f9f5e646165f5df9af5ce17fb948db818a6ad0e6abf1a637f48e'
FROZEN_CONTENT_SHA = '139a41260dc69427db3fdfd20a7b5dcc053db26f28e1fc49e01c9d1951bc2788'
GENERATOR = 'scripts/testing/generate-manga-alpha-fixtures.py'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def content_sha(value):
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def box(values):
    return dict(zip(('x0', 'y0', 'x1', 'y1'), values))


def intersects(a, b):
    return min(a['x1'], b['x1']) > max(a['x0'], b['x0']) and min(a['y1'], b['y1']) > max(a['y0'], b['y0'])


def artwork(scene):
    name = scene['name']
    w, h = scene['size']
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if name == 'transparent-lantern-bridge-balloons':
        d.ellipse((70, 80, 595, 420), fill=(255, 255, 248, 224), outline=(32, 58, 68, 255), width=5)
        d.polygon([(420, 380), (455, 490), (485, 380)], fill=(255, 255, 248, 224), outline=(32, 58, 68, 255))
        d.ellipse((615, 125, 1135, 465), fill=(248, 255, 250, 208), outline=(32, 58, 68, 255), width=5)
        d.polygon([(720, 420), (675, 510), (785, 420)], fill=(248, 255, 250, 208), outline=(32, 58, 68, 255))
        for x in range(130, 1080, 94):
            d.line((x, 730, x, 900), fill=(62, 112, 110, 170), width=8)
        d.arc((130, 650, 1070, 950), 180, 360, fill=(64, 105, 96, 255), width=10)
        d.rectangle((130, 790, 1070, 840), fill=(70, 100, 90, 255))
        for x in (300, 900):
            d.line((x, 640, x, 716), fill=(64, 105, 96, 255), width=4)
            d.ellipse((x-24, 716, x+24, 764), fill=(255, 190, 65, 255), outline=(125, 83, 40, 255), width=3)
        for x, y in ((170, 600), (610, 620), (1000, 590)):
            d.arc((x-30, y-15, x, y+15), 190, 350, fill=(47, 88, 112, 210), width=4)
            d.arc((x, y-15, x+30, y+15), 190, 350, fill=(47, 88, 112, 210), width=4)
    elif name == 'translucent-riverside-notice':
        # A reproducible original scene, not a photograph or an external asset.
        for y in range(20, h-20):
            for x in range(20, w-20):
                grain = ((x*17 + y*11 + (x//71)*scene['backgroundSeed']) % 29) - 14
                d.point((x, y), fill=(int(110 + 35*x/w + grain), int(127 + 30*y/h + grain/2), int(132 + 17*math.sin(x/150) + grain/3), 255))
        for i, x in enumerate((50, 460, 870)):
            d.rectangle((x, 650, x+380, 950), fill=(80+i*8, 100+i*7, 92, 255))
            for stripe in range(10):
                left = x + stripe*38
                d.polygon([(left, 620), (left+38, 620), (left+53, 705), (left-15, 705)], fill=(198, 103, 80, 255) if stripe%2 else (226, 210, 160, 255))
        for x, c in ((250, (180, 74, 57, 255)), (700, (209, 165, 62, 255)), (1150, (78, 145, 91, 255))):
            for dx, dy in ((-50, -35), (45, -30), (0, 0), (-45, 45), (50, 48)):
                d.ellipse((x+dx-26, 800+dy-26, x+dx+26, 800+dy+26), fill=c, outline=(65, 84, 73, 255), width=2)
        overlay = Image.new('RGBA', im.size)
        ImageDraw.Draw(overlay).rounded_rectangle((155, 145, 1260, 635), radius=22, fill=(255, 255, 255, scene['noticeAlpha']), outline=(245, 245, 235, 210), width=3)
        im.alpha_composite(overlay)
    elif name == 'perforated-alpha-dock-note':
        d.rounded_rectangle((100, 120, 1100, 660), radius=28, fill=(255, 250, 230, 255), outline=(60, 100, 115, 255), width=5)
        d.line((155, 175, 1045, 175), fill=(105, 140, 150, 160), width=2)
        for x in (170, 440, 760, 1030):
            d.rectangle((x-20, 760, x+20, 930), fill=(102, 88, 71, 255))
        d.rectangle((130, 800, 1070, 855), fill=(79, 122, 133, 255))
        for y in (890, 925):
            d.arc((80, y-15, 1120, y+25), 5, 175, fill=(70, 140, 173, 160), width=3)
    elif name == 'same-tone-cabin-controls':
        d.rectangle((20, 20, 1180, 980), fill=(24, 44, 68, 255))
        for y in (185, 255):
            d.rounded_rectangle((1100, y-11, 1150, y+11), radius=11, fill=(38, 78, 96, 255))
            d.ellipse((1127, y-9, 1145, y+9), fill=(90, 222, 167, 255))
        for x in (250, 600, 950):
            d.ellipse((x-100, 700, x+100, 900), fill=(40, 70, 90, 255), outline=(81, 155, 179, 255), width=4)
            for a in range(0, 360, 30):
                angle = math.radians(a)
                d.line((x+70*math.cos(angle), 800+70*math.sin(angle), x+85*math.cos(angle), 800+85*math.sin(angle)), fill=(160, 197, 201, 255), width=2)
            d.line((x, 800, x+50, 755), fill=(255, 193, 80, 255), width=5)
            d.ellipse((x-7, 793, x+7, 807), fill=(255, 193, 80, 255))
    elif name == 'inverse-neighbor-tidal-balloons':
        d.rectangle((35, 35, 1365, 965), fill=(48, 104, 124, 224))
        d.ellipse((70, 110, 690, 480), fill=(10, 19, 29, 255), outline=(130, 220, 224, 255), width=2)
        d.polygon([(500, 425), (610, 560), (560, 430)], fill=(10, 19, 29, 255), outline=(130, 220, 224, 255))
        d.ellipse((715, 130, 1335, 500), fill=(250, 250, 237, 255), outline=(10, 30, 40, 255), width=2)
        d.polygon([(800, 440), (750, 565), (860, 450)], fill=(250, 250, 237, 255), outline=(10, 30, 40, 255))
        for y in (760, 810, 880, 925):
            d.arc((70, y-25, 1330, y+25), 5, 175, fill=(145, 220, 229, 155), width=3)
        for x in (250, 1150):
            d.ellipse((x-60, 800, x+60, 860), fill=(109, 178, 162, 255), outline=(30, 84, 103, 255), width=3)
            d.polygon([(x-55, 830), (x-90, 800), (x-90, 860)], fill=(109, 178, 162, 255))
            d.ellipse((x+25, 820, x+31, 826), fill=(15, 45, 63, 255))
        d.polygon([(610, 830), (790, 830), (760, 875), (650, 875)], fill=(186, 136, 87, 255))
        d.line((700, 745, 700, 835), fill=(75, 58, 45, 255), width=5)
        d.polygon([(705, 750), (705, 820), (760, 820)], fill=(245, 234, 202, 225))
    elif name == 'bound-atlas-rule-and-inset-card':
        d.rectangle((45, 45, 1555, 1055), fill=(70, 65, 59, 235))
        d.rectangle((60, 60, 785, 1040), fill=(249, 244, 224, 235))
        d.rectangle((815, 60, 1540, 1040), fill=(243, 240, 221, 235))
        for x in range(755, 846):
            value = int(60 + 130*abs(x-800)/45)
            d.line((x, 60, x, 1040), fill=(value, value-4, value-10, 255))
        d.line((120, 430, 720, 430), fill=(64, 92, 101, 255), width=1)
        d.rectangle((995, 440, 1450, 560), fill=(23, 46, 59, 255))
        d.rectangle((999, 444, 1446, 556), fill=(252, 250, 237, 255))
        d.polygon([(180, 955), (210, 760), (300, 800), (380, 750), (520, 890), (620, 920), (490, 995)], fill=(86, 130, 105, 255), outline=(45, 80, 70, 255), width=4)
        d.line((220, 930, 300, 860, 470, 900, 560, 930), fill=(226, 207, 161, 255), width=6)
        for i in range(5):
            d.ellipse((1080+i*30, 750+i*18, 1420-i*30, 970-i*18), outline=(67, 123, 142, 255), width=3)
        d.ellipse((1225, 835, 1275, 885), fill=(67, 123, 142, 255))
    else:
        raise ValueError('Unknown frozen artwork rule: '+name)
    return im


def make_glyph(spec, fonts):
    font = ImageFont.truetype(str(fonts[spec['fontKey']]), spec['fontSize'])
    raw = font.getbbox(spec['text'])
    size = (raw[2]-raw[0], raw[3]-raw[1])
    if not (0 < size[0]*size[1] <= 2_000_000):
        raise ValueError('Glyph resource limit exceeded')
    mask = Image.new('L', size)
    ImageDraw.Draw(mask).text((-raw[0], -raw[1]), spec['text'], font=font, fill=255)
    if spec['rotationDegrees']:
        mask = mask.rotate(spec['rotationDegrees'], expand=True, resample=Image.Resampling.BICUBIC)
    layer = Image.new('RGBA', mask.size, tuple(spec['fill']))
    layer.putalpha(mask.point(lambda value: (value*spec['fill'][3]+127)//255))
    return font, raw, mask, layer


def render(design, fonts):
    records, pngs = [], []
    caps = design['resourceCaps']
    if len(design['scenes']) != 6 or len({s['name'] for s in design['scenes']}) != 6:
        raise ValueError('Exactly six distinct frozen scenes required')
    total_pixels = 0
    for scene in design['scenes']:
        w, h = scene['size']
        if not (isinstance(w, int) and isinstance(h, int) and 0 < w <= caps['maxWidth'] and 0 < h <= caps['maxHeight'] and w*h <= caps['maxScenePixels']):
            raise ValueError('Source dimensions exceed frozen limits')
        total_pixels += w*h
        if total_pixels > caps['maxTotalPixels'] or len(scene['regions']) > caps['maxRegionsPerScene']:
            raise ValueError('Page or suite resource limit exceeded')
        if len({r['id'] for r in scene['regions']}) != len(scene['regions']):
            raise ValueError('Duplicate physical region ID')
        im = artwork(scene)
        regions, alpha_holes = [], []
        for spec in scene['regions']:
            if not spec['text'] or len(spec['text']) > 256 or not 1 <= spec['fontSize'] <= 96 or spec['rotationDegrees'] not in (0, 90):
                raise ValueError('Invalid frozen source glyph')
            font, raw, mask, layer = make_glyph(spec, fonts)
            local = mask.getbbox()
            if local is None:
                raise ValueError('Source glyph is empty')
            b = box((spec['x']+local[0], spec['y']+local[1], spec['x']+local[2], spec['y']+local[3]))
            if not (0 <= b['x0'] < b['x1'] <= w and 0 <= b['y0'] < b['y1'] <= h):
                raise ValueError('Full source text escapes the image: '+spec['id'])
            for hole in scene.get('holes', []):
                if hole['regionId'] != spec['id']:
                    continue
                if spec['rotationDegrees'] or not spec['text'].startswith(hole['afterPrefix']+' '):
                    raise ValueError('Perforation must reference an existing horizontal interword space')
                center = round((font.getlength(hole['afterPrefix']) + font.getlength(hole['afterPrefix']+' '))/2-raw[0])
                x0, y0 = center-hole['width']//2, (mask.height-hole['height'])//2
                local_hole = (x0, y0, x0+hole['width'], y0+hole['height'])
                if not (0 <= x0 < local_hole[2] <= mask.width and 0 <= y0 < local_hole[3] <= mask.height) or mask.crop(local_hole).getbbox() is not None:
                    raise ValueError('Alpha perforation cuts a source glyph')
                hb = box((spec['x']+x0, spec['y']+y0, spec['x']+local_hole[2], spec['y']+local_hole[3]))
                if not (b['x0'] <= hb['x0'] < hb['x1'] <= b['x1'] and b['y0'] <= hb['y0'] < hb['y1'] <= b['y1']):
                    raise ValueError('Perforation is not inside the complete physical text box')
                fill = (0, 0, 0, 0) if hole['alpha'] == 0 else (255, 250, 230, hole['alpha'])
                ImageDraw.Draw(im).rectangle((hb['x0'], hb['y0'], hb['x1']-1, hb['y1']-1), fill=fill)
                alpha_holes.append({'regionId':spec['id'], 'bbox':hb, 'alpha':hole['alpha'], 'sourceGlyphMaskCoverage':0, 'probe':{'x':spec['x']+center, 'y':spec['y']+mask.height//2}})
            im.alpha_composite(layer, (spec['x'], spec['y']))
            regions.append({'id':spec['id'], 'text':spec['text'], 'anchor':spec['text'], 'translation':'受控译文用于透明度与分段回归。', 'bbox':b, 'vertical':spec['vertical'], 'fontSize':spec['fontSize'], 'fontKey':spec['fontKey'], 'paragraphId':spec['paragraphId'], 'rotationDegrees':spec['rotationDegrees'], 'sourceStyle':{'fill':spec['fill'][:3], 'alpha':spec['fill'][3]}, 'glyphAlphaSha256':sha(layer.getchannel('A').tobytes())})
        negatives = [{'id':'wordless-art-'+str(i+1), 'bbox':box(b)} for i, b in enumerate(scene['negativeRegions'])]
        if any(intersects(a['bbox'], b['bbox']) for a in negatives for b in regions):
            raise ValueError('Negative art region intersects complete source text')
        protects = []
        for x, y in scene['protectedPoints']:
            rgba = im.getpixel((x, y))
            if rgba[3] != 255 or any(r['bbox']['x0'] <= x < r['bbox']['x1'] and r['bbox']['y0'] <= y < r['bbox']['y1'] for r in regions):
                raise ValueError('RGB protection must be opaque and outside source text')
            protects.append({'x':x, 'y':y, 'rgb':list(rgba[:3])})
        alpha_probes = [{'x':x, 'y':y, 'rgba':list(im.getpixel((x, y)))} for x, y in scene['alphaProbePoints']]
        for hole in alpha_holes:
            p = hole['probe']
            rgba = im.getpixel((p['x'], p['y']))
            if rgba[3] != hole['alpha']:
                raise ValueError('Frozen alpha perforation was overwritten')
            alpha_probes.append({**p, 'rgba':list(rgba), 'regionId':hole['regionId'], 'purpose':'Interword alpha perforation inside physical text bbox; no source glyph removed'})
        alpha = im.getchannel('A').histogram()
        groups = {}
        for r in regions:
            groups.setdefault(r['paragraphId'], []).append(r['id'])
        output = io.BytesIO()
        im.save(output, format='PNG', optimize=False)
        data = output.getvalue()
        record = {'name':scene['name'], 'file':scene['name']+'.png', 'mime':'image/png', 'width':w, 'height':h, 'sourceLanguage':scene['sourceLanguage'], 'scene':scene['structure'], 'regions':regions, 'expectedSource':[r['text'] for r in regions], 'expectedAnchors':[r['text'] for r in regions], 'anchorOccurrences':{r['text']:sum(q['text'] == r['text'] for q in regions) for r in regions}, 'paragraphGroups':list(groups.values()), 'forbiddenRegions':negatives, 'protectedProbes':protects, 'protectedAlphaProbes':alpha_probes, 'sourceAlphaHoles':alpha_holes, 'alphaCoverage':{'transparentPixels':alpha[0], 'partialPixels':sum(alpha[1:255]), 'opaquePixels':alpha[255]}, 'imageMode':'RGBA', 'decodedRgbaSha256':sha(im.tobytes()), 'tileBoundaryCrossings':[], 'provenance':{'originalArtworkAndText':True, 'sourceDesignedBeforeAnyOcr':True, 'selectionByOcrResult':False, 'designSha256':DESIGN_SHA, 'existing51Unmodified':True}, 'sha256':sha(data), 'bytes':len(data)}
        if sum(record['alphaCoverage'].values()) != w*h or not record['alphaCoverage']['transparentPixels']:
            raise ValueError('Every source must retain true transparent pixels')
        records.append(record)
        pngs.append((record['file'], data))
    manifest = {'version':1, 'generator':GENERATOR, 'designSha256':DESIGN_SHA, 'pillowVersion':PIL.__version__, 'fonts':[{k:f[k] for k in ('key', 'sha256')} for f in design['fontFiles']], 'notes':['Independent six-scene RGBA stress suite. Source text, geometry and paragraph groups froze before any OCR; no results-based selection.', 'protectedProbes retains the existing opaque RGB contract. protectedAlphaProbes and sourceAlphaHoles are additional full-RGBA source truth, not an assertion of current browser-harness support.', 'Source alpha holes are inside complete physical text bboxes but have zero source glyph coverage. No source letters are erased to manufacture a repair case.', 'No fonts, model weights, external artwork or AI image assets are bundled.'], 'fixtures':records}
    return manifest, pngs


def generate(out, design_path, font_overrides):
    if out.exists() or out.is_symlink():
        raise FileExistsError('Choose a nonexistent output directory; existing files, directories and symlinks are never overwritten')
    data = design_path.read_bytes()
    if sha(data) != DESIGN_SHA:
        raise ValueError('Design differs from the pre-first-OCR freeze')
    design = json.loads(data)
    if PIL.__version__ != design['pillowVersion']:
        raise ValueError('Exact frozen Pillow version required: '+design['pillowVersion'])
    keys = {f['key'] for f in design['fontFiles']}
    if set(font_overrides)-keys:
        raise ValueError('Unknown font override key')
    fonts = {f['key']:Path(font_overrides.get(f['key'], f['path'])) for f in design['fontFiles']}
    for f in design['fontFiles']:
        if not fonts[f['key']].is_file() or sha(fonts[f['key']].read_bytes()) != f['sha256']:
            raise ValueError('Exact frozen font required: '+f['key'])
    manifest, pngs = render(design, fonts)
    if content_sha(manifest['fixtures']) != FROZEN_FIXTURES_SHA or content_sha(manifest) != FROZEN_CONTENT_SHA:
        raise ValueError('Rendered PNGs or complete source truth differ from the frozen corpus; do not retune truth to observed OCR')
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2)+'\n').encode()
    # All six pixel/record/font/design checks finish before the first output write.
    out.mkdir(parents=True, exist_ok=False)
    for name, data in [*pngs, ('manifest.json', manifest_bytes)]:
        with (out/name).open('xb') as target:
            target.write(data)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--design', type=Path, default=FIXTURES/'design.json')
    parser.add_argument('--font', action='append', default=[], help='key=local-path with the exact frozen SHA; repeatable')
    args = parser.parse_args()
    result = generate(args.out_dir, args.design, dict(value.split('=', 1) for value in args.font))
    print(json.dumps({'scenes':len(result['fixtures']), 'anchors':sum(len(f['regions']) for f in result['fixtures']), 'manifestSha256':sha((args.out_dir/'manifest.json').read_bytes()), 'generatorSha256':sha(Path(__file__).read_bytes())}))
