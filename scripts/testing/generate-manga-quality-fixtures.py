#!/usr/bin/env python3
"""生成二十八种安全、文字可核对的漫画/图片翻译夹具；只需现有 Pillow 和显式本机字体。"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import unicodedata
from pathlib import Path

import PIL
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter


ENGLISH_FONT = Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")
JAPANESE_FONT_NAME = "ヒラギノ角ゴシック W4.ttc"
HANDWRITING_FONT = Path("/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf")
REGULAR_FONT = Path("/System/Library/Fonts/Supplemental/Arial.ttf")
MONOSPACE_FONT = Path("/System/Library/Fonts/Supplemental/Courier New.ttf")
SERIF_FONT = Path("/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf")


def normalize_anchor(text: str) -> str:
    """与浏览器质量门禁一致：NFKC、大写，只保留 Unicode 字母和数字。"""
    return "".join(char for char in unicodedata.normalize("NFKC", text).upper()
                   if unicodedata.category(char)[0] in {"L", "N"})


def japanese_font() -> Path:
    for path in Path("/System/Library/Fonts").glob("*.ttc"):
        if unicodedata.normalize("NFC", path.name) == JAPANESE_FONT_NAME:
            return path
    raise FileNotFoundError(f"Pass --japanese-font; expected {JAPANESE_FONT_NAME}")


class Page:
    def __init__(self, name: str, size: tuple[int, int], language: str, scene: str, color=(226, 230, 234)):
        self.image = Image.new("RGB", size, color)
        self.draw = ImageDraw.Draw(self.image)
        self.record = {"name": name, "file": f"{name}.png", "mime": "image/png", "width": size[0],
                       "height": size[1], "sourceLanguage": language, "scene": scene, "regions": [],
                       "protectedProbes": [], "tileBoundaryCrossings": []}

    def panel(self, box, fill=(240, 242, 244)):
        self.draw.rectangle(box, fill=fill, outline=(35, 42, 49), width=6)

    def balloon(self, box, dark=False):
        self.draw.ellipse(box, fill=(12, 16, 23) if dark else "white", outline="white" if dark else (35, 42, 49), width=5)

    def robot(self, x, y, scale=1, color=(92, 126, 146)):
        """简单几何机器人，避免使用第三方漫画、人物肖像或成人素材。"""
        d = self.draw
        d.rounded_rectangle((x-48*scale,y-50*scale,x+48*scale,y+24*scale), radius=14*scale, fill=color, outline=(35,42,49), width=4)
        for dx in [-20,20]:
            d.ellipse((x+(dx-5)*scale,y-22*scale,x+(dx+5)*scale,y-12*scale),fill=(15,25,35))
        d.line((x-14*scale,y+3*scale,x+14*scale,y+3*scale),fill=(15,25,35),width=3)
        d.rounded_rectangle((x-40*scale,y+32*scale,x+40*scale,y+100*scale),radius=10*scale,fill=color,outline=(35,42,49),width=4)
        d.line((x-22*scale,y+101*scale,x-30*scale,y+140*scale),fill=(35,42,49),width=8)
        d.line((x+22*scale,y+101*scale,x+30*scale,y+140*scale),fill=(35,42,49),width=8)

    def line(self, text, x, y, font, *, anchor=None, translation="", fill=(15,20,25), stroke=0):
        """x/y 是实际字形外框左上角，manifest 不依赖字体的 ascent 偏移。"""
        raw = self.draw.textbbox((0,0),text,font=font,stroke_width=stroke)
        position=(x-raw[0],y-raw[1])
        self.draw.text(position,text,font=font,fill=fill,stroke_width=stroke,stroke_fill="white" if stroke else fill)
        bbox=self.draw.textbbox(position,text,font=font,stroke_width=stroke)
        self.record["regions"].append({"id":f"line-{len(self.record['regions'])+1}","text":text,
            "anchor":anchor or text,"translation":translation,"bbox":{"x0":bbox[0],"y0":bbox[1],"x1":bbox[2],"y1":bbox[3]},"vertical":False})
        return bbox

    def vertical(self, text, x, y, font, *, translation="", advance=54):
        boxes=[]
        for index, char in enumerate(text):
            raw=self.draw.textbbox((0,0),char,font=font)
            position=(x-raw[0],y+index*advance-raw[1])
            self.draw.text(position,char,font=font,fill=(15,20,25))
            boxes.append(self.draw.textbbox(position,char,font=font))
        box={"x0":min(b[0] for b in boxes),"y0":min(b[1] for b in boxes),"x1":max(b[2] for b in boxes),"y1":max(b[3] for b in boxes)}
        self.record["regions"].append({"id":f"line-{len(self.record['regions'])+1}","text":text,
            "anchor":text,"translation":translation,"bbox":box,"vertical":True,"characterAdvance":advance})

    def protect(self, x, y):
        self.record["protectedProbes"].append({"x":x,"y":y,"rgb":list(self.image.getpixel((x,y)))[:3]})

    def negative(self, box, label):
        """声明确实没有字的画面区域；最终 OCR 原始行框不得进入这里。"""
        self.record.setdefault("forbiddenRegions",[]).append({"id":label,"bbox":dict(zip(("x0","y0","x1","y1"),box))})

    def tilted_line(self, text, x, y, font, angle, *, translation=""):
        raw=self.draw.textbbox((0,0),text,font=font)
        layer=Image.new("RGBA",(raw[2]-raw[0]+16,raw[3]-raw[1]+16))
        ImageDraw.Draw(layer).text((8-raw[0],8-raw[1]),text,font=font,fill=(15,20,25,255))
        layer=layer.rotate(angle,resample=Image.Resampling.BICUBIC,expand=True)
        bounds=layer.getbbox()
        self.image.paste(layer,(x,y),layer)
        self.record["regions"].append({"id":f"line-{len(self.record['regions'])+1}","text":text,"anchor":text,
            "translation":translation,"bbox":{"x0":x+bounds[0],"y0":y+bounds[1],"x1":x+bounds[2],"y1":y+bounds[3]},
            "vertical":False,"rotationDegrees":angle})

    def styled_line(self, text, x, y, font, *, angle=0, blur_radius=0, prefix_length=0,
                    tail_fill=(15,20,25), translation=""):
        """先冻结文字，再确定性地改变字形外观；不读取或模拟 OCR 结果。"""
        raw=self.draw.textbbox((0,0),text,font=font)
        layer=Image.new("RGBA",(raw[2]-raw[0]+24,raw[3]-raw[1]+24))
        draw=ImageDraw.Draw(layer);position=(12-raw[0],12-raw[1])
        draw.text(position,text,font=font,fill=(*tail_fill,255))
        if prefix_length:draw.text(position,text[:prefix_length],font=font,fill=(10,15,20,255))
        if blur_radius:layer=layer.filter(ImageFilter.GaussianBlur(blur_radius))
        if angle:layer=layer.rotate(angle,resample=Image.Resampling.BICUBIC,expand=True)
        bounds=layer.getbbox()
        if self.image.mode=="RGBA":self.image.alpha_composite(layer,(x,y))
        else:self.image.paste(layer,(x,y),layer)
        self.record["regions"].append({"id":f"line-{len(self.record['regions'])+1}","text":text,"anchor":text,
            "translation":translation,"bbox":{"x0":x+bounds[0],"y0":y+bounds[1],"x1":x+bounds[2],"y1":y+bounds[3]},
            "vertical":False,"rotationDegrees":angle,"blurRadius":blur_radius,"blackPrefixLength":prefix_length})


def generate(output: Path, english: Path, japanese: Path, handwriting: Path = HANDWRITING_FONT,
             regular: Path = REGULAR_FONT, monospace: Path = MONOSPACE_FONT, serif: Path = SERIF_FONT) -> dict:
    output.mkdir(parents=True,exist_ok=True)
    en=lambda size:ImageFont.truetype(str(english),size=size)
    ja=lambda size:ImageFont.truetype(str(japanese),size=size)
    hand=lambda size:ImageFont.truetype(str(handwriting),size=size)
    sans=lambda size:ImageFont.truetype(str(regular),size=size)
    mono=lambda size:ImageFont.truetype(str(monospace),size=size)
    italic=lambda size:ImageFont.truetype(str(serif),size=size)
    pages=[]

    p=Page("english-bubbles-caption",(1000,1400),"en","three separated speech balloons and one outside single-line caption")
    p.panel((24,24,976,680));p.panel((24,710,976,1376))
    p.balloon((55,130,485,420));p.balloon((530,150,945,445));p.balloon((200,785,805,1090))
    p.line("Morning at the quiet station.",62,65,en(32),anchor="quiet station",translation="安静车站的早晨。")
    p.line("THE TRAIN",145,215,en(38),translation="这班火车")
    p.line("LEAVES AT NINE",105,280,en(36),anchor="LEAVES AT NINE",translation="九点出发。")
    p.line("I WILL BRING",590,235,en(36),translation="我会带上")
    p.line("THE RED MAP",595,295,en(36),translation="那张红色地图。")
    p.line("WE CAN READ",360,875,en(40),translation="我们可以")
    p.line("ON THE WAY",375,940,en(40),translation="在路上读书。")
    p.robot(220,520,0.8);p.robot(760,1180,0.8);p.protect(220,500);pages.append(p)

    p=Page("japanese-vertical-columns",(1000,1400),"ja","Japanese vertical dialogue; right column precedes left column")
    p.panel((24,24,976,1376));p.balloon((180,90,820,780))
    p.vertical("明日は図書館へ",590,190,ja(44),translation="明天去图书馆。")
    p.vertical("一緒に行こう",410,190,ja(44),translation="一起去吧。")
    p.record["readingOrder"]=["line-1","line-2"]
    p.record["regions"][0]["anchor"]="図書館";p.record["regions"][1]["anchor"]="一緒"
    p.robot(500,1050,1.2);p.protect(500,1020);pages.append(p)

    p=Page("japanese-horizontal-mixed",(1000,1300),"ja","horizontal Japanese dialogue and Japanese/Latin mixed lettering")
    p.panel((24,24,976,1276));p.balloon((60,115,940,440));p.balloon((80,610,920,990))
    p.line("BOOK CLUB 2026",275,52,en(38),anchor="BOOK CLUB",translation="2026读书会")
    p.line("今日は図書館へ行こう。",180,215,ja(44),anchor="図書館",translation="今天去图书馆吧。")
    p.line("新しい本を見つけたよ。",180,285,ja(44),anchor="新しい本",translation="我找到了一本新书。")
    p.line("読書メモ NOTE 07",250,700,ja(44),anchor="NOTE 07",translation="读书笔记07")
    p.line("また明日ここで会おう。",180,780,ja(44),anchor="また明日",translation="明天再在这里见。")
    p.robot(500,1090,0.75);p.protect(500,1065);pages.append(p)

    p=Page("long-strip-tile-boundary",(960,3600),"en","long webtoon with uncropped caption crossing the original 1536px detector edge",color=(214,220,226))
    for top,bottom in [(24,1100),(1120,2350),(2370,3576)]:p.panel((24,top,936,bottom),fill=(225,229,233))
    p.line("A LONG QUIET JOURNEY",135,100,en(45),anchor="QUIET JOURNEY",translation="漫长而安静的旅程。")
    p.line("Every small word matters.",160,770,en(38),anchor="small word matters",translation="每一个小词都很重要。")
    boundary=p.line("BOUNDARY TEXT STAYS COMPLETE",85,1515,en(37),anchor="BOUNDARY TEXT STAYS COMPLETE",translation="边界处的文字保持完整。")
    p.record["tileBoundaryCrossings"].append({"axis":"y","position":1536,"regionId":"line-3"})
    assert boundary[1]<1536<boundary[3],"The boundary fixture must actually cross y=1536"
    p.line("Read beyond the next panel.",130,2200,en(38),anchor="next panel",translation="继续读到下一格。")
    p.line("THE LAST LINE IS STILL HERE",105,3210,en(37),anchor="LAST LINE IS STILL HERE",translation="最后一行仍在这里。")
    p.robot(480,400,1.2);p.robot(480,1850,1.2);p.robot(480,2780,1.2);p.protect(480,1800);pages.append(p)

    p=Page("dark-reverse-dialogue",(1000,1200),"en","white dialogue on black balloons without light connected-component crops",color=(24,31,45))
    p.panel((24,24,976,1176),fill=(34,43,61));p.balloon((80,95,920,490),dark=True);p.balloon((90,630,910,1050),dark=True)
    p.line("TURN ON",365,210,en(44),fill="white",translation="打开")
    p.line("THE SMALL LAMP",260,285,en(44),anchor="SMALL LAMP",fill="white",translation="那盏小灯。")
    p.line("WE CAN SEE",315,750,en(44),fill="white",translation="我们能看见")
    p.line("THE STARS TONIGHT",230,830,en(44),anchor="STARS TONIGHT",fill="white",translation="今晚的星星。")
    p.draw.ellipse((475,535,525,585),fill=(254,222,100));p.protect(500,560);pages.append(p)

    p=Page("textured-title-repair",(1000,1400),"en","title and dialogue on nonuniform hatching; protected probes lie outside source text masks",color=(225,217,198))
    p.panel((24,24,976,1376),fill=(224,218,202))
    for offset in range(-1400,1000,24):
        p.draw.line((offset,24,offset+1352,1376),fill=(160,164,152),width=2)
    for y in range(40,1376,30):p.draw.line((24,y,976,y),fill=(194,190,173),width=1)
    p.line("READING",215,120,en(86),anchor="READING",translation="阅读",stroke=3)
    p.line("ADVENTURE",145,235,en(86),anchor="ADVENTURE",translation="探险",stroke=3)
    p.line("The path continues",200,625,en(46),anchor="path continues",translation="道路仍在延伸，",stroke=3)
    p.line("beyond the old bridge.",140,705,en(46),anchor="old bridge",translation="通向古桥的另一端。",stroke=3)
    p.draw.rounded_rectangle((740,1080,880,1220),radius=12,fill=(88,119,156),outline=(35,42,49),width=5)
    p.protect(810,1150);p.protect(500,500);pages.append(p)

    # 下面八张使用不同的画面拓扑、字体尺度和识别边界，原六张输入保持逐字节不变。
    p=Page("double-spread-close-balloons",(1800,1200),"en","double-page spread with a central gutter and nearby independent speech balloons")
    p.panel((24,24,880,1176));p.panel((920,24,1776,1176))
    p.draw.rectangle((886,24,914,1176),fill=(64,71,78))
    for box in [(60,100,460,405),(455,115,845,420),(980,100,1720,425),(1020,680,1680,980)]:p.balloon(box)
    p.line("TAKE THE",160,195,en(34),translation="带上")
    p.line("BLUE MAP",155,250,en(34),translation="蓝色地图。")
    p.line("I KNOW",570,200,en(34),translation="我知道")
    p.line("THE WAY",550,255,en(34),translation="路怎么走。")
    p.line("MEET ACROSS THE RIVER",1060,230,en(38),translation="到河对岸见。")
    p.line("BEFORE SUNSET",1180,805,en(38),translation="日落之前。")
    p.robot(440,760,1.3);p.robot(1390,1080,0.5)
    p.negative((350,650,530,950),"left-page-robot");p.protect(440,740);p.protect(900,600);pages.append(p)

    p=Page("vertical-main-with-furigana",(1100,1500),"ja","vertical main dialogue with smaller furigana beside one column and a horizontal caption")
    p.panel((24,24,1076,1476));p.balloon((180,80,920,1040))
    p.vertical("未来の駅で会おう",675,190,ja(50),translation="在未来的车站见。",advance=66)
    p.vertical("切符を忘れないで",460,190,ja(50),translation="别忘了车票。",advance=66)
    p.vertical("みらい",740,192,ja(22),translation="未来",advance=29)
    p.record["regions"][-1]["role"]="furigana"
    p.record["regions"][0]["anchor"]="未来の駅";p.record["regions"][1]["anchor"]="切符"
    p.record["readingOrder"]=["line-1","line-2"]
    p.line("次のページへ",390,1110,ja(40),translation="翻到下一页。")
    p.robot(550,1280,0.65);p.negative((495,1220,605,1380),"caption-robot");p.protect(550,1260);pages.append(p)

    p=Page("tilted-signs-and-dialogue",(1400,1100),"en","three independent signboard/dialogue lines tilted in both directions")
    p.panel((24,24,1376,1076),fill=(227,234,219))
    p.draw.polygon([(95,100),(1180,45),(1250,380),(150,445)],fill=(255,251,225),outline=(50,62,49),width=5)
    p.tilted_line("FOLLOW THE PAPER BIRD",170,130,en(53),7,translation="跟着纸鸟走。")
    p.balloon((100,480,850,905));p.tilted_line("WE ARE ALMOST THERE",180,570,en(42),-10,translation="我们快到了。")
    p.tilted_line("KEEP READING",900,795,en(34),12,translation="继续阅读。")
    p.draw.polygon([(980,465),(1280,530),(1100,585),(1135,710),(1040,570)],fill=(80,118,144),outline=(35,42,49),width=4)
    p.negative((960,445,1300,725),"paper-bird");p.protect(1130,540);pages.append(p)

    p=Page("narrow-strip-small-print",(2400,480),"en","wide four-panel comic strip with small ticket lettering and numeric identifiers")
    for left in [24,620,1216,1812]:p.panel((left,24,left+564,456))
    for text,x in [("PLATFORM 12",110),("TICKET 2048",700),("ONE MORE PAGE",1285),("HOME AT LAST",1900)]:
        p.line(text,x,95,en(29),translation="车票与旅程。")
    for x in [300,895,1490,2085]:p.robot(x,270,0.55)
    p.negative((820,210,970,360),"ticket-panel-art");p.protect(895,260);p.protect(600,240);pages.append(p)

    p=Page("wide-tall-two-axis-tiles",(2600,2400),"en","high-resolution image with a full caption crossing both detector tile axes and a caption near the final edge")
    for box in [(24,24,1270,1150),(1300,24,2576,1150),(24,1180,2576,2376)]:p.panel(box)
    p.line("THE BRIDGE IS OPEN",180,160,en(48),translation="桥已经开放。")
    cross_x=p.line("CROSS THE WIDE RIVER",1300,500,en(48),translation="越过宽阔的河流。")
    cross_both=p.line("BOTH AXES STAY WHOLE",1300,1515,en(42),translation="双轴边界保持完整。")
    p.line("THE FAR CORNER STILL READS",1430,2230,en(42),translation="远端角落的文字仍可阅读。")
    assert cross_x[0]<1536<cross_x[2] and cross_both[0]<1536<cross_both[2] and cross_both[1]<1536<cross_both[3]
    p.record["tileBoundaryCrossings"]=[{"axis":"x","position":1536,"regionId":"line-2"},{"axis":"x","position":1536,"regionId":"line-3"},{"axis":"y","position":1536,"regionId":"line-3"}]
    p.robot(700,650,2.2);p.robot(700,1850,2.2);p.negative((530,1700,870,2180),"lower-panel-art");p.protect(700,1830);pages.append(p)

    p=Page("color-panels-over-gradient",(1400,1500),"en","colored balloons over a nonuniform gradient with different foreground contrasts")
    for y in range(p.image.height):p.draw.line((0,y,1399,y),fill=(65+y*110//1500,105+y*80//1500,155-y*60//1500))
    for index in range(18):p.draw.ellipse((index*90-60,1040+(index%3)*70,index*90+170,1290+(index%3)*70),fill=(40+index*5,110+index*3,90+index*4))
    p.draw.rounded_rectangle((100,90,1280,510),radius=100,fill=(255,238,178),outline=(77,64,35),width=6)
    p.draw.rounded_rectangle((150,650,1230,1020),radius=80,fill=(49,43,76),outline=(216,198,246),width=6)
    p.line("A COLORFUL NEW CHAPTER",230,200,en(53),translation="色彩斑斓的新篇章。")
    p.line("BRING YOUR FAVORITE BOOK",210,320,en(48),translation="带上你最喜欢的书。")
    p.line("READ UNDER THE MOON",280,770,en(48),fill=(255,246,230),translation="在月光下阅读。")
    p.robot(700,1270,1.0,color=(215,145,84));p.negative((595,1180,805,1440),"gradient-robot");p.protect(700,1250);pages.append(p)

    p=Page("repeated-dialogue-distinct-panels",(1000,1500),"en","the same real dialogue appears twice in separate panels; source occurrence counts must be preserved")
    for top,bottom in [(24,470),(500,970),(1000,1476)]:p.panel((24,top,976,bottom))
    p.balloon((100,80,900,335));p.balloon((100,560,900,815));p.balloon((50,1050,950,1350))
    p.line("WAIT FOR ME",330,170,en(46),translation="等等我。")
    p.line("WAIT FOR ME",330,650,en(46),translation="等等我。")
    p.line("WE WILL GO TOGETHER",210,1170,en(44),translation="我们一起走。")
    p.robot(210,390,0.4);p.robot(790,890,0.4);p.negative((745,840,835,956),"repeated-panel-art");p.protect(210,380);pages.append(p)

    p=Page("wordless-geometric-action",(1100,1200),"ja","wordless geometric action page; artwork and punctuation-shaped motion marks must not become translated text")
    p.panel((24,24,1076,1176),fill=(234,228,211))
    p.robot(350,480,2);p.robot(790,800,1.4,color=(146,104,116))
    for offset in range(8):p.draw.line((70+offset*16,100,160+offset*16,300),fill=(78,83,90),width=5)
    p.draw.polygon([(600,90),(650,190),(620,190),(670,300),(590,205),(620,205)],fill=(204,158,65))
    p.draw.polygon([(95,900),(170,950),(95,1000),(125,950)],fill=(78,120,150))
    p.record["expectedNoText"]=True;p.negative((24,24,1076,1176),"entire-wordless-panel")
    p.protect(350,460);p.protect(790,780);p.protect(625,160);pages.append(p)

    # 第三轮六张采用新字体和新拓扑；前十四张的像素、文字与预期保持不变。
    p=Page("handwritten-field-notes",(1200,1400),"en","handwriting-style field notes on ruled paper with original plant and sailboat illustrations",color=(225,215,194))
    p.record["stressors"]=["handwriting-style-font","ruled-paper","non-robot-illustration"]
    p.draw.polygon([(80,60),(1110,95),(1140,1320),(55,1350)],fill=(255,249,221),outline=(98,86,67),width=5)
    for y in range(180,1280,55):p.draw.line((90,y,1100,y),fill=(198,210,207),width=2)
    p.draw.line((160,100,160,1310),fill=(213,156,146),width=2)
    p.line("A little rain will not stop us.",205,155,hand(54),translation="一点小雨不会让我们停下。")
    p.line("Keep the paper boat dry.",205,285,hand(54),translation="别让纸船淋湿。")
    p.line("Meet me after the last bell.",205,415,hand(54),translation="最后一声铃响后见。")
    p.line("Bring a warm scarf.",205,545,hand(54),translation="带上一条暖和的围巾。")
    p.draw.line((340,1090,345,790),fill=(74,105,66),width=9)
    for x,y,side in [(340,850,-1),(342,940,1),(340,1020,-1)]:
        p.draw.ellipse((x-120 if side<0 else x,y-45,x if side<0 else x+120,y+20),fill=(109,143,87),outline=(63,91,59),width=3)
    p.draw.polygon([(700,1080),(1030,1080),(960,1180),(770,1180)],fill=(131,161,177),outline=(58,75,91),width=5)
    p.draw.line((865,810,865,1080),fill=(93,79,63),width=6)
    p.draw.polygon([(850,820),(710,1050),(850,1050)],fill=(242,232,202),outline=(93,79,63),width=4)
    p.draw.polygon([(880,860),(1005,1050),(880,1050)],fill=(230,218,182),outline=(93,79,63),width=4)
    p.negative((205,760,485,1140),"pressed-leaf-drawing");p.negative((680,790,1050,1200),"paper-sailboat-drawing")
    p.protect(340,900);p.protect(830,1130);pages.append(p)

    p=Page("bilingual-cafe-menu",(1100,1500),"ja","Japanese and Latin menu lettering with serif, regular, bold and Japanese fonts beside a wordless pastry drawing",color=(224,201,170))
    p.record["stressors"]=["japanese-latin-mixed","four-font-families","menu-layout"]
    p.draw.rounded_rectangle((70,60,1030,1435),radius=28,fill=(255,249,232),outline=(103,72,45),width=6)
    p.line("Cafe by the River",215,120,italic(64),translation="河畔咖啡馆")
    p.line("本日のおすすめ",255,255,ja(51),translation="今日推荐")
    p.draw.line((155,355,945,355),fill=(146,117,82),width=3)
    p.line("PEACH TEA",180,410,en(45),translation="蜜桃茶")
    p.line("桃の紅茶 380円",180,500,ja(43),translation="蜜桃红茶380日元")
    p.line("Please enjoy your tea.",180,660,sans(38),translation="请慢慢享用。")
    p.line("また来てください。",180,755,ja(43),translation="欢迎再来。")
    p.draw.ellipse((260,1110,840,1300),fill=(242,235,217),outline=(155,135,106),width=5)
    p.draw.pieslice((355,975,745,1240),180,355,fill=(201,139,70),outline=(118,77,39),width=5)
    for x in [430,510,590,670]:p.draw.arc((x-40,1010,x+45,1195),-90,85,fill=(244,188,108),width=13)
    p.negative((240,955,860,1320),"pastry-and-plate");p.protect(545,1150);p.protect(310,1220);pages.append(p)

    p=Page("low-contrast-fog-gradient",(1500,1100),"en","low-contrast lettering directly over a two-axis fog gradient and fine rain texture; no white speech balloon")
    p.record["stressors"]=["low-contrast","two-axis-gradient","fine-background-lines"]
    gradient=Image.linear_gradient("L")
    fog=Image.blend(gradient.resize(p.image.size),gradient.rotate(90).resize(p.image.size),0.5)
    p.image=ImageOps.colorize(fog,(166,183,177),(221,225,210));p.draw=ImageDraw.Draw(p.image)
    for x in range(-500,1500,41):p.draw.line((x,0,x+420,1100),fill=(186,198,187),width=1)
    p.line("THE FOG IS LIFTING",240,130,en(52),fill=(124,143,133),translation="雾正在散去。")
    p.line("Meet beside the old oak tree.",190,320,sans(48),fill=(139,153,139),translation="到老橡树旁边见。")
    p.line("KEEP THE PATH IN VIEW",200,515,en(48),fill=(128,143,133),translation="别让小路离开视线。")
    p.draw.polygon([(80,1040),(405,720),(650,1040)],fill=(149,169,156))
    p.draw.polygon([(470,1040),(845,780),(1230,1040)],fill=(164,180,165))
    p.draw.line((1250,1020,1250,770),fill=(116,140,122),width=14)
    for box in [(1160,710,1270,850),(1230,700,1360,845),(1190,780,1330,910)]:p.draw.ellipse(box,fill=(146,166,145))
    p.negative((75,700,665,1050),"foggy-mountain-art");p.negative((1150,690,1370,1030),"oak-silhouette")
    p.protect(380,960);p.protect(1250,960);pages.append(p)

    p=Page("microprint-station-screenshot",(1800,900),"en","a station screenshot with exact 8px, 12px and 18px source fonts, thin rules and a wordless route diagram",color=(241,244,245))
    p.record["stressors"]=["8px-font","12px-font","numeric-identifiers","wide-screenshot"]
    p.record["minimumFontSize"]=8
    p.draw.rectangle((0,0,1800,95),fill=(38,65,82))
    p.line("STATION CHECK-IN",65,31,en(32),fill=(250,252,253),translation="车站值乘登记")
    p.draw.rounded_rectangle((65,150,1735,395),radius=14,fill="white",outline=(186,199,205),width=2)
    p.line("KEEP YOUR TICKET",100,185,en(18),translation="请保留车票。")
    p.line("SEAT 18 GATE 06",100,245,mono(12),translation="18号座位，06号入口。")
    p.line("SMALL PRINT STILL COUNTS",100,305,sans(8),translation="小字也很重要。")
    p.line("REFERENCE 2048",1110,245,mono(12),translation="参考编号2048")
    p.line("LAST SERVICE AT 23:08",1110,305,sans(8),translation="末班车23点08分。")
    p.draw.line((100,600,500,600,780,760,1260,760,1600,520),fill=(55,116,139),width=9)
    for x,y in [(100,600),(500,600),(780,760),(1260,760),(1600,520)]:p.draw.ellipse((x-13,y-13,x+13,y+13),fill=(241,244,245),outline=(55,116,139),width=5)
    p.negative((75,485,1635,795),"unlabelled-route-diagram");p.protect(500,600);p.protect(1030,760);pages.append(p)

    p=Page("tailed-balloons-long-dialogue",(1200,1600),"en","long multiline dialogue in a tailed balloon, a jagged shout panel and overlapping thought-cloud lobes",color=(210,222,225))
    p.record["stressors"]=["speech-tail","jagged-balloon","thought-cloud","long-multiline-dialogue"]
    p.panel((24,24,1176,520),fill=(230,236,235));p.panel((24,545,1176,970),fill=(218,228,229));p.panel((24,995,1176,1576),fill=(228,232,221))
    p.draw.polygon([(900,340),(1100,500),(990,330)],fill="white",outline=(35,42,49),width=5)
    p.balloon((65,65,1130,425))
    p.line("THE WIND IS GETTING STRONGER",155,150,en(39),translation="风越来越大了。")
    p.line("HOLD THE PAPER SAIL",265,240,en(40),translation="扶住纸帆。")
    points=[]
    for x in range(65,1141,45):points.append((x,580 if (x//45)%2 else 600))
    points.extend([(1140,900),(1080,880)])
    for x in range(1080,64,-45):points.append((x,915 if (x//45)%2 else 895))
    points.extend([(55,620),(65,580)])
    p.draw.polygon(points,fill=(255,250,221),outline=(70,64,49),width=5)
    p.line("WE CAN WAIT BY THE LIGHTHOUSE",90,680,en(38),translation="我们可以到灯塔旁等候。")
    p.line("UNTIL THE RAIN HAS PASSED",175,770,en(38),translation="等到雨停。")
    for box in [(280,1090,610,1435),(525,1060,880,1440),(765,1100,1120,1440)]:p.balloon(box)
    p.draw.rounded_rectangle((350,1160,1040,1380),radius=70,fill="white")
    p.line("ONE STEP AT A TIME",365,1240,en(44),translation="一步一步慢慢来。")
    p.draw.polygon([(90,1490),(115,1140),(205,1140),(230,1490)],fill=(240,229,198),outline=(74,83,82),width=5)
    p.draw.rectangle((100,1090,220,1150),fill=(87,125,136),outline=(74,83,82),width=4)
    p.draw.polygon([(80,1090),(160,1040),(240,1090)],fill=(140,99,80),outline=(74,83,82),width=4)
    p.negative((75,1030,245,1510),"lighthouse-drawing");p.negative((1030,450,1105,505),"speech-tail-only")
    p.protect(160,1400);p.protect(1060,470);pages.append(p)

    p=Page("chat-screenshot-dialogue",(1080,1600),"en","chat screenshot with regular-font dialogue, a monospace time, asymmetric bubbles, avatar icons and a wordless landscape attachment",color=(233,240,237))
    p.record["stressors"]=["chat-screenshot","asymmetric-message-bubbles","ui-small-text","wordless-photo-card"]
    p.draw.rectangle((0,0,1080,130),fill=(43,83,78))
    p.draw.ellipse((32,26,104,98),fill=(173,202,186));p.draw.arc((48,39,90,86),20,340,fill=(48,85,73),width=5)
    p.line("MIRA",145,40,en(37),fill="white",translation="米拉")
    p.line("08:45",880,47,mono(23),fill=(233,246,238),translation="08:45")
    p.draw.rounded_rectangle((105,205,900,365),radius=30,fill="white")
    p.draw.polygon([(110,245),(68,285),(125,285)],fill="white")
    p.line("Did you save the last page?",145,267,sans(38),translation="你保存最后一页了吗？")
    p.draw.rounded_rectangle((170,440,995,610),radius=30,fill=(191,224,191))
    p.draw.polygon([(980,475),(1035,520),(970,520)],fill=(191,224,191))
    p.line("Yes. The map is on my phone.",205,505,sans(38),translation="保存了，地图在我的手机上。")
    p.draw.rounded_rectangle((105,685,900,845),radius=30,fill="white")
    p.line("See you at platform 12.",145,747,sans(38),translation="12号站台见。")
    p.draw.rounded_rectangle((105,900,900,1230),radius=20,fill=(205,223,224),outline="white",width=8)
    p.draw.ellipse((700,945,790,1035),fill=(249,223,143))
    p.draw.polygon([(125,1205),(360,1000),(555,1205)],fill=(95,142,136))
    p.draw.polygon([(400,1205),(660,1035),(880,1205)],fill=(123,161,141))
    p.draw.rounded_rectangle((170,1300,995,1450),radius=30,fill=(191,224,191))
    p.line("Bring the blue notebook.",210,1358,sans(38),translation="带上蓝色笔记本。")
    p.draw.rounded_rectangle((35,1500,1045,1570),radius=28,fill="white",outline=(183,199,192),width=2)
    p.line("Message",78,1522,sans(25),fill=(102,122,113),translation="消息")
    p.negative((20,15,115,110),"header-avatar-icon");p.negative((120,920,885,1215),"wordless-landscape-attachment")
    p.protect(745,990);p.protect(360,1140);pages.append(p)

    # 第四轮：先声明真值，再绘制易混字、复合排版和无字纹理；旧二十张仍逐字节保持。
    p=Page("confusable-signs-clear-soft",(2400,1500),"en","paired clear and mildly blurred physical labels retain true OT, OO, IT and mixed alphanumeric identifiers without semantic correction",color=(193,203,205))
    p.record["stressors"]=["true-OT-not-07","O0-I1-Z2-S5-T7-B8","paired-clear-soft","real-duplicate-occurrences"]
    labels=["NOTE OT","O0 I1 1I Z2 2Z S5 5S T7 7T B8 8B","NOTE 07","CODE OO","CHECK IT"]
    for column,left in enumerate([65,1255]):
        for row,label in enumerate(labels):
            top=70+row*275
            p.draw.rounded_rectangle((left,top,left+1080,top+215),radius=12,fill=(247,245,225),outline=(63,78,78),width=6)
            for cx in [left+22,left+1058]:p.draw.ellipse((cx-5,top+17,cx+5,top+27),fill=(93,103,105))
            p.styled_line(label,left+55,top+70,mono(34 if row==1 else 52),blur_radius=0.7 if column else 0,
                          translation="保留实际标牌和序列号。")
    p.draw.rectangle((1170,100,1230,1430),fill=(94,114,122))
    for y in range(150,1400,135):p.draw.line((1175,y,1225,y+40),fill=(186,195,194),width=4)
    p.negative((1160,95,1240,1440),"unlabelled-centre-brace");p.protect(1200,750);pages.append(p)

    p=Page("oblique-black-prefix-gray-tail",(1600,1350),"en","full sentences on angled sign strips with a black first word or letter and a gray remaining line",color=(204,216,215))
    p.record["stressors"]=["mixed-foreground-contrast","black-prefix","positive-and-negative-slant"]
    for box in [[(90,80),(1460,40),(1510,340),(145,395)],[(100,475),(1430,530),(1390,825),(55,775)],[(145,955),(1470,900),(1515,1190),(110,1260)]]:
        p.draw.polygon(box,fill=(243,240,220),outline=(64,78,74),width=5)
    p.styled_line("WE ARE STILL ON THE PLATFORM",160,100,en(48),angle=7,prefix_length=2,tail_fill=(134,139,127),translation="我们仍在站台上。")
    p.styled_line("I WILL KEEP THE NOTE",200,570,en(58),angle=-8,prefix_length=1,tail_fill=(143,143,130),translation="我会保存这张纸条。")
    p.styled_line("A QUIET STOP AFTER RAIN",220,955,en(54),angle=6,prefix_length=1,tail_fill=(135,141,132),translation="雨后安静的一站。")
    for x in [40,1510]:p.draw.rectangle((x,390,x+25,470),fill=(77,108,113))
    p.negative((25,385,80,475),"left-sign-bracket");p.protect(50,430);pages.append(p)

    p=Page("vertical-dialogue-ruby-neighbors",(1280,1700),"ja","two separate vertical dialogue balloons with four main columns, three neighboring ruby annotations and an outside caption")
    p.record["stressors"]=["four-main-vertical-columns","three-ruby-neighbors","separate-speaker-balloons","outside-caption"]
    p.panel((25,25,1255,1675),fill=(238,234,219));p.balloon((650,95,1210,1165));p.balloon((80,285,610,1360))
    p.vertical("「星を見に行こう」",1050,210,ja(38),advance=50,translation="去看星星吧。")
    p.vertical("切符は二枚あるよ",900,210,ja(38),advance=50,translation="我有两张车票。")
    p.vertical("ほし",1100,260,ja(20),advance=24,translation="星星")
    p.record["regions"][-1]["role"]="furigana"
    p.vertical("きっぷ",950,210,ja(20),advance=24,translation="车票")
    p.record["regions"][-1]["role"]="furigana"
    p.vertical("雨がやんだら出発",460,440,ja(38),advance=50,translation="雨停后出发。")
    p.vertical("小さな橋で待って",300,440,ja(38),advance=50,translation="在小桥边等我。")
    p.vertical("はし",350,590,ja(20),advance=24,translation="桥")
    p.record["regions"][-1]["role"]="furigana"
    p.record["readingOrderGroups"]=[["line-1","line-2"],["line-5","line-6"]]
    p.line("午後七時の約束",710,1510,ja(42),translation="下午七点的约定。")
    p.draw.arc((80,1390,550,1620),180,355,fill=(76,118,139),width=20)
    p.draw.line((90,1535,540,1535),fill=(76,118,139),width=8)
    p.negative((65,1380,575,1645),"wordless-arched-bridge");p.protect(300,1510);pages.append(p)

    p=Page("newspaper-columns-photo-inset",(1500,1900),"en","three narrow newspaper columns separated by thin rules, serif body lines and a wordless photo inset with its own small caption",color=(242,235,215))
    p.record["stressors"]=["three-column-newspaper","thin-serif-body","photo-inset-caption","vertical-rules"]
    for y in range(0,1900,17):p.draw.line((0,y,1499,y),fill=(233,227,208),width=1)
    p.line("THE EVENING READER",170,75,en(76),translation="晚间读者")
    p.draw.line((70,200,1430,200),fill=(54,58,52),width=4)
    columns=[("Readers share","a quiet corner","after the storm."),("A paper bird","crossed the town","before sunrise."),("The last train","will leave from","platform eight.")]
    for column,lines in enumerate(columns):
        x=95+column*470
        for row,value in enumerate(lines):p.line(value,x,290+row*95,italic(43),translation="报纸中的原始报道。")
    for x in [510,980]:p.draw.line((x,255,x,650),fill=(86,89,78),width=2)
    p.draw.rectangle((300,750,1200,1360),fill=(180,197,190),outline=(57,74,70),width=4)
    p.draw.polygon([(320,1335),(550,900),(785,1335)],fill=(127,157,141))
    p.draw.polygon([(655,1335),(925,960),(1180,1335)],fill=(143,170,151))
    p.draw.arc((410,1110,1090,1430),180,355,fill=(84,113,107),width=35)
    p.line("A bridge above the river.",385,1410,sans(31),translation="河流上方的一座桥。")
    p.line("FIELD REPORT 2026",150,1660,mono(36),translation="2026现场报道")
    p.negative((320,780,1180,1340),"newspaper-wordless-landscape");p.protect(550,1220);p.protect(1000,1320);pages.append(p)

    p=Page("border-connected-second-lines",(1500,1400),"en","mandatory second lines share ink with enclosing borders while an outside caption stays separate",color=(227,230,221))
    p.record["stressors"]=["text-touches-frame","mandatory-second-line","outside-narration","local-omission-trap"]
    p.draw.rectangle((70,100,1430,335),fill=(255,252,229),outline=(20,31,34),width=4)
    p.line("THE FIRST LINE IS ONLY THE START",70,125,en(43),translation="第一行只是开始。")
    second=p.line("THE SECOND LINE MUST STAY",70,303,en(43),translation="第二行必须保留。")
    assert second[3]>=331,"The lower glyphs must actually meet the frame ink"
    p.line("A small note outside the frame.",260,420,sans(42),translation="框外还有一条小旁白。")
    p.draw.polygon([(100,700),(260,555),(420,700),(350,875),(185,875)],fill=(100,145,145),outline=(47,77,79),width=5)
    for x in [130,190,250,310,370]:p.draw.line((x,690,x-20,820),fill=(214,222,193),width=5)
    p.draw.rectangle((445,990,1415,1190),fill=(249,247,226),outline=(20,31,34),width=5)
    p.line("READ THE WHOLE MESSAGE",445,1005,en(45),translation="请读完整条消息，")
    p.line("EVEN THE QUIET LAST WORDS",445,1144,en(43),translation="包括轻声说出的最后几个字。")
    p.negative((90,535,435,900),"unlettered-kite");p.protect(260,750);pages.append(p)

    p=Page("wordless-dense-pseudo-script",(1600,1400),"ja","dense original linework made only from geometry, with no assigned letters, numbers, words or speech; texture may resemble writing",color=(242,237,218))
    p.record["stressors"]=["dense-wordless-line-art","pseudo-script-texture","small-loop-grid","full-page-negative"]
    for row in range(14):
        for column in range(16):
            x=42+column*96;y=35+row*95;shade=55+(row*17+column*13)%75
            for stroke in range(4):
                dx=(column*13+row*7+stroke*19)%55;dy=(row*11+column*5+stroke*23)%55
                p.draw.arc((x+dx//2,y+dy//2,x+40+dx//2,y+42+dy//2),35+stroke*53,205+stroke*29,fill=(shade,shade+8,shade+5),width=2)
                p.draw.line((x+dx,y+dy,x+12+(dy*3)%58,y+13+(dx*5)%62),fill=(shade+22,shade+27,shade+18),width=2)
            p.draw.line((x+6,y+79,x+77,y+75),fill=(159,162,141),width=1)
    p.record["expectedNoText"]=True;p.negative((0,0,1600,1400),"entire-unlettered-texture")
    p.protect(500,500);p.protect(1000,900);pages.append(p)

    p=Page("transparent-notification-overlay",(1400,1000),"en","true RGBA notification overlay with transparent outer pixels, translucent panels, opaque source text and wordless UI icons")
    p.image=Image.new("RGBA",p.image.size,(0,0,0,0));p.draw=ImageDraw.Draw(p.image)
    p.record["stressors"]=["true-RGBA-alpha","translucent-overlay-ui","small-time","opaque-protected-art"]
    p.record["imageMode"]="RGBA"
    p.draw.rounded_rectangle((65,65,1335,930),radius=55,fill=(231,242,247,185),outline=(76,115,136,240),width=5)
    p.draw.ellipse((110,105,250,245),fill=(83,127,145,255));p.draw.ellipse((145,133,215,193),fill=(210,229,229,255))
    p.line("MIRA",300,140,en(48),translation="米拉")
    p.line("TRANSLATION READY",135,320,en(62),translation="翻译已就绪")
    p.line("Original artwork stays visible.",135,460,sans(48),translation="原始画面仍然可见。")
    p.line("Retry only this image.",135,560,sans(48),translation="只重试这张图片。")
    p.line("09:17",1100,160,mono(30),translation="09:17")
    p.draw.rounded_rectangle((135,685,590,780),radius=26,fill=(49,95,120,255))
    p.draw.rounded_rectangle((705,685,1240,780),radius=26,fill=(218,230,231,255),outline=(99,127,136,255),width=3)
    p.line("OPEN",300,715,en(34),fill=(255,255,255),translation="打开")
    p.line("DISMISS",875,715,en(34),translation="关闭")
    p.draw.rounded_rectangle((135,835,1240,855),radius=10,fill=(136,179,180,255))
    p.negative((95,90,265,260),"unlettered-avatar");p.negative((120,820,1255,870),"unlabelled-progress-track")
    p.protect(180,170);p.protect(300,845);pages.append(p)

    p=Page("map-inset-rotated-marginalia",(1500,1800),"en","an illustrated route map with two orthogonally rotated margin labels, a horizontal serif callout and a small inset caption",color=(229,236,214))
    p.record["stressors"]=["plus-minus-90-degree-text","map-grid","serif-callout","small-inset-caption"]
    for x in range(150,1370,85):p.draw.line((x,100,x,1630),fill=(186,204,180),width=2)
    for y in range(100,1650,85):p.draw.line((150,y,1370,y),fill=(186,204,180),width=2)
    p.draw.line((470,90,700,340,580,650,850,910,760,1250,1100,1620),fill=(108,169,188),width=70)
    p.draw.polygon([(240,550),(355,400),(500,590),(390,740)],fill=(133,166,121),outline=(82,121,91),width=4)
    p.styled_line("NORTH OF THE OLD BRIDGE",25,220,en(43),angle=90,translation="老桥的北边")
    p.styled_line("RIVER WALK 2026",1390,430,en(42),angle=-90,translation="2026河畔漫步")
    p.draw.rounded_rectangle((300,800,1320,1010),radius=25,fill=(254,250,222),outline=(102,123,90),width=4)
    p.line("Meet at the stone steps.",365,875,italic(60),translation="在石阶旁见面。")
    p.draw.rectangle((600,1190,1325,1540),fill=(216,225,220),outline=(61,98,93),width=5)
    p.draw.arc((680,1300,1250,1630),180,355,fill=(90,123,112),width=35)
    p.line("The small bridge is still open.",625,1580,sans(31),translation="小桥仍然开放。")
    p.line("ZONE B8",945,1665,mono(42),translation="B8区域")
    p.negative((200,375,525,765),"unlabelled-map-hill");p.negative((620,1210,1305,1515),"bridge-inset-art")
    p.protect(350,570);p.protect(1000,1425);pages.append(p)

    records=[]
    for p in pages:
        for region in p.record["regions"]:
            b=region["bbox"]
            assert 0<=b["x0"]<b["x1"]<=p.image.width and 0<=b["y0"]<b["y1"]<=p.image.height,(p.record["name"],region)
        path=output/p.record["file"];p.image.save(path,format="PNG",optimize=False)
        p.record["sha256"]=hashlib.sha256(path.read_bytes()).hexdigest()
        p.record["bytes"]=path.stat().st_size
        p.record["expectedSource"]=[r["text"] for r in p.record["regions"]]
        p.record["expectedAnchors"]=list(dict.fromkeys(r["anchor"] for r in p.record["regions"]))
        source=normalize_anchor(" ".join(p.record["expectedSource"]))
        anchors=p.record["expectedAnchors"]
        normalized=[normalize_anchor(anchor) for anchor in anchors]
        assert all(normalized) and len(set(normalized))==len(normalized),(p.record["name"],"anchors must be distinct and nonempty")
        assert bool(normalized) != bool(p.record.get("expectedNoText")),(p.record["name"],"wordless scenes have no invented text")
        occurrences={anchor:sum(source.startswith(needle,index) for index in range(len(source)))
                     for anchor,needle in zip(anchors,normalized)}
        assert all(count>=1 for count in occurrences.values()),(p.record["name"],occurrences)
        # 保留字符串数组以兼容已有读取器；次数约束可发现瓦片重叠造成的重复文字。
        p.record["anchorOccurrences"]=occurrences
        records.append(p.record)

    fonts=[{"purpose":purpose,"path":str(path),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()} for purpose,path in [
        ("English",english),("Japanese",japanese),("Handwriting style",handwriting),("Regular Latin",regular),("Monospace",monospace),("Italic serif",serif)]]
    manifest={"version":1,"generator":"scripts/testing/generate-manga-quality-fixtures.py","seed":1068,"pillowVersion":PIL.__version__,
              "anchorNormalization":{"unicode":"NFKC","case":"upper","keepCategories":["Letter","Number"],"countOverlaps":True},
              "fonts":fonts,"notes":["All panels, geometry and words are original deterministic test material.",
              "Expected source and translations are ground truth; anchors are checks, not fabricated OCR output.",
              "Use actual extension OCR to measure recognition separately from controlled OCR geometry/rendering tests.",
              "PNG bytes are reproducible with the recorded Pillow version and identical font files."],"fixtures":records}
    (output/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n")

    # 预览不参与 OCR，标签与缩略图不会污染每张原始输入。
    rows=(len(pages)+2)//3
    sheet=Image.new("RGB",(1200,rows*520+10),"white");draw=ImageDraw.Draw(sheet)
    for i,p in enumerate(pages):
        thumb=p.image.copy();thumb.thumbnail((360,440))
        x=20+(i%3)*400;y=35+(i//3)*520
        draw.text((x,y-24),p.record["name"],font=en(17),fill="black")
        position=(x+(360-thumb.width)//2,y)
        sheet.paste(thumb,position,thumb if thumb.mode=="RGBA" else None)
    sheet.save(output/"contact-sheet.png",format="PNG",optimize=False)
    cards="\n".join(f'<article><h2>{html.escape(r["name"])}</h2><p>{html.escape(r["scene"])}</p><img src="{r["file"]}" alt="{html.escape(r["name"])}"></article>' for r in records)
    (output/"gallery.html").write_text('<!doctype html><meta charset="utf-8"><title>FluentRead #1068 corpus</title><style>body{font:16px system-ui;background:#eee;margin:24px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}article{background:white;padding:16px}h2{font-size:18px}img{width:100%;height:auto}</style><h1>FluentRead #1068 deterministic manga corpus</h1><p>'+str(len(records))+' independent OCR inputs, including a wordless negative page. Ground truth: manifest.json.</p><main>'+cards+'</main>')
    return manifest


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir",type=Path,required=True)
    parser.add_argument("--english-font",type=Path,default=ENGLISH_FONT)
    parser.add_argument("--japanese-font",type=Path)
    parser.add_argument("--handwriting-font",type=Path,default=HANDWRITING_FONT)
    parser.add_argument("--regular-font",type=Path,default=REGULAR_FONT)
    parser.add_argument("--monospace-font",type=Path,default=MONOSPACE_FONT)
    parser.add_argument("--serif-font",type=Path,default=SERIF_FONT)
    args=parser.parse_args()
    result=generate(args.output_dir,args.english_font,args.japanese_font or japanese_font(),
                    args.handwriting_font,args.regular_font,args.monospace_font,args.serif_font)
    print(json.dumps({"fixtures":len(result["fixtures"]),"outputDir":str(args.output_dir.resolve())},ensure_ascii=False))
