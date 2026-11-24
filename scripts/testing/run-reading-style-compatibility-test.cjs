#!/usr/bin/env node
'use strict';
// 网页译文阅读专项：真实生产扩展、确定性本地服务和隔离后台 Edge，覆盖局部主题、动态切换、链接、窄屏与辅助颜色。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const ROOT = path.resolve(__dirname, '../..');
const EXT = path.resolve(arg('extension-dir', path.join(ROOT, '.output/chrome-mv3')));
const OUT = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-reading-style-compatibility'));
const packages = arg('playwright-root');
const diagnosticsPath = arg('runtime-diagnostics');
assert(packages && diagnosticsPath, '需要 --playwright-root 与 --runtime-diagnostics');
const {chromium} = require(require.resolve('playwright', {paths: [packages]}));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require('./focus-safe-browser.cjs');
const {createRuntimeDiagnostics, finalizeRun, redact} = require(path.resolve(diagnosticsPath));
const registry = fs.readFileSync(path.join(ROOT, 'src/core/config/translationAppearance.ts'), 'utf8');
const PRESETS = [...registry.matchAll(/\{value: (\d+), className: '([^']+)', label: '([^']+)', legacyGroup: '[^']+', category: '(card|fun)'/gu)]
  .map(([,value,className,label,category])=>({value:Number(value),className,label,category}));
assert.equal(PRESETS.length, 24);
const FIXED_OR_TEXT = new Set(['fluent-display-rainbow-underline','fluent-display-terminal','fluent-display-spoiler','fluent-display-spotlight']);
const SURFACE_PRESETS = PRESETS.filter(p => !FIXED_OR_TEXT.has(p.className));
assert.equal(SURFACE_PRESETS.length, 20);
const EXTRA_PRESETS = [{value:28,className:'fluent-display-blur-reveal',label:'模糊遮罩'},{value:40,className:'fluent-display-gradient-text',label:'渐变文字'}];
const APPEARANCE = {textColor:'',backgroundColor:'',lineColor:'',fillColor:'',fontScale:100,fontWeight:'default',fontFamily:'default',opacity:100,customCss:''};
const SOURCE = 'Reading should feel calm and effortless. Useful decorations should leave long paragraphs clear and comfortable on every page.';
const TRANSLATED = '阅读应该轻松自然。适度的装饰应该让每个网页上的长段落都保持清晰舒适。';
const THEMES = [
  {name:'white',foreground:'#202124',background:'#ffffff',link:'#1d4ed8',os:'dark',dark:false},
  {name:'black',foreground:'#e8eaed',background:'#111318',link:'#b8d5ff',os:'light',dark:true},
  {name:'warm',foreground:'#593e27',background:'#fff1d6',link:'#235ba4',os:'dark',dark:false},
  {name:'violet',foreground:'#ece8fa',background:'#27203f',link:'#bfddff',os:'light',dark:true},
];
const pause = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds));

async function createFixture() {
  const requests=[];
  const server=http.createServer(async(request,response)=>{
    response.setHeader('Access-Control-Allow-Origin','*');
    response.setHeader('Access-Control-Allow-Headers','*');
    if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
    if(request.method==='POST'){
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const prompt=body.messages.filter(message=>message.role==='user').map(message=>message.content).join('\n');
      const source=/SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1]||'';
      requests.push({length:source.length,at:Date.now()});
      const content=source.replaceAll(SOURCE,TRANSLATED).replaceAll('reading guide','阅读指南');
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({id:'reading-style-fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}));return;
    }
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reading style compatibility</title><style>
      :root{--page-text:#202124;--page-paper:#fff;--page-link:#1d4ed8}body{margin:0;padding:28px 5vw;background:var(--page-paper);color:var(--page-text);font:17px/1.7 system-ui}main{max-width:780px;margin:auto}h1{font-size:24px}h2{font-size:14px;font-weight:500;margin:0;opacity:.7}section{padding:12px 18px;margin:0 0 16px;border-radius:8px}p{margin:8px 0 20px}a{color:var(--page-link)}code{font-size:.8em}.mixed section:nth-of-type(2n){background:#182d32;color:#edf8f5}.mixed section:nth-of-type(2n+1){background:#fff2d9;color:#514028}
    </style></head><body><main><h1 translate="no">网页阅读样式兼容性</h1>${[...PRESETS,...EXTRA_PRESETS].map(p=>`<section><h2 translate="no">${p.label}</h2><p id="style-${p.value}">${SOURCE} <a href="#reading-guide">reading guide</a> <code translate="no">sample = ${p.value}</code>.</p></section>`).join('')}<div id="reading-guide" translate="no">阅读指南</div><section translate="no">${Array.from({length:40},(_,index)=>`<p>阅读续篇 ${index+1}：网页文章中的段落、引用与链接应该按照原有顺序呈现，让读者保持自己的节奏。这里保留真实的静态文章文字，用于检查较长网页上译文的屏外渲染。</p>`).join('')}</section></main></body></html>`);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}`,requests,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}

// 通过 Canvas 把浏览器已计算的任意颜色空间归到 sRGB；渐变取正文纸面第一处不透明色，纹理位置留给截图复核。
async function measure(locator) {
  return locator.evaluate(element=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data];};
    const blend=(foreground,background)=>foreground.slice(0,3).map((value,index)=>value*foreground[3]/255+background[index]*(1-foreground[3]/255));
    const luminance=rgb=>rgb.slice(0,3).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
    const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    const colors=image=>{
      const found=[];const pattern=/(?:oklch|oklab|color|rgba?|hsla?)\(/gu;let match;
      while((match=pattern.exec(image))){let depth=1,end=pattern.lastIndex;for(;end<image.length&&depth;end++){if(image[end]==='(')depth++;if(image[end]===')')depth--;}
        found.push(rgba(image.slice(match.index,end)));pattern.lastIndex=end;}
      return found;
    };
    const style=getComputedStyle(element);const rect=element.getBoundingClientRect();const parent=element.parentElement.getBoundingClientRect();
    const layers=[];for(let current=element;current;current=current.parentElement)layers.unshift(rgba(getComputedStyle(current).backgroundColor));
    let background=layers.reduce((result,layer)=>blend(layer,result),[255,255,255]);
    const opaquePaper=colors(style.backgroundImage).find(color=>color[3]===255);
    // 折角的首个渐变色只画在右上角；有不透明底色时先用底色。邮票的底色是外沿，第一层才是正文纸面。
    if(opaquePaper&&(rgba(style.backgroundColor)[3]<255||element.classList.contains('fluent-display-postage')))background=opaquePaper.slice(0,3);
    const foreground=blend(rgba(style.color),background);const link=element.querySelector('a');
    const pseudo=getComputedStyle(element,'::before');
    return {color:style.color,colorAlpha:rgba(style.color)[3],textFillColor:style.webkitTextFillColor,foreground,background:style.backgroundColor,backgroundRgb:background,backgroundImage:style.backgroundImage,textContrast:contrast(foreground,background),
      link:link?{color:getComputedStyle(link).color,contrast:contrast(blend(rgba(getComputedStyle(link).color),background),background),href:link.getAttribute('href'),outline:getComputedStyle(link).outlineStyle}:null,
      bounds:{left:rect.left,right:rect.right,width:rect.width,height:rect.height,parentLeft:parent.left,parentRight:parent.right,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth},
      filter:style.filter,backdropFilter:style.backdropFilter,boxShadow:style.boxShadow,mask:style.maskImage,pseudo:{content:pseudo.content,pointerEvents:pseudo.pointerEvents},
      renderingContained:element.getAttribute('data-fr-rendering-contained'),contentVisibility:style.contentVisibility,classes:element.className};
  });
}

async function main() {
  fs.mkdirSync(OUT,{recursive:true});
  const diagnostics=createRuntimeDiagnostics();
  const report={ok:false,scope:'production-reading-style-host-compatibility',extensionDir:EXT,checks:[],screenshots:[],metrics:{themes:{},mixed:{},narrow:{}},caseCoverage:[],
    evidenceBoundary:'Real production MV3 Edge content scripts and local deterministic HTML/OpenAI-compatible provider. Controlled host themes and rendering checks; no live-provider, arbitrary-host, physical-device or Firefox-runtime acceptance claim.'};
  let launched,local,profileDir,failure,launchAttempted=false;
  try {
    assert(fs.existsSync(path.join(EXT,'manifest.json')),'production manifest missing');
    local=await createFixture();profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-reading-style-edge-'));
    report.profileDir=profileDir;launchAttempted=true;
    launched=await launchFocusSafePersistentContext({chromium,profileDir,background:true,headless:false,displayTarget:'secondary',browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),viewport:{width:1280,height:960},timeout:30000,browserArgs:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,'--no-first-run','--no-default-browser-check']});
    Object.assign(report,{launchMode:launched.launchMode,focusPolicy:launched.focusPolicy,windowPlacement:launched.windowPlacement});
    assert.equal(report.launchMode,'macos-background-cdp');assert.equal(report.focusPolicy,'launchservices-no-foreground');assert.equal(report.windowPlacement.mode,'background-visible-no-focus');assert.equal(report.windowPlacement.browserFrontmost,false);
    const context=launched.context;await diagnostics.start(context);
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:30000});
    const origin=/^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];diagnostics.setExtensionId(new URL(origin).host);
    const newPage=async(url,surface)=>{const page=await newPageWithoutForeground(context,30000);await diagnostics.attachPage(page,surface);await page.goto(url,{waitUntil:'domcontentloaded'});return page;};
    const shot=async(page,name)=>{const file=path.join(OUT,`${name}.png`);await page.screenshot({path:file});report.screenshots.push(file);};
    const control=await newPage(`${origin}/popup.html`,'popup-control');
    const readConfig=()=>control.evaluate(async()=>{const result=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});if(!result?.success)throw new Error(result?.error||'config read failed');return typeof result.value==='string'?JSON.parse(result.value):result.value;});
    const untilConfig=async(predicate,label='config')=>{for(let attempt=0;attempt<200;attempt++){const config=await readConfig();if(config&&predicate(config))return config;await pause(50);}throw new Error(`${label} did not converge`);};
    await untilConfig(config=>config.to&&config.service);
    const patch=async(next)=>{const current=await readConfig();const initial=Object.hasOwn(next,'token');const expected=Object.fromEntries(Object.keys(next).map(key=>[key,current[key]]));const result=await control.evaluate(({next,current,initial,expected})=>chrome.runtime.sendMessage({type:'persistConfig',mode:initial?'replace':'patch',config:initial?{...current,...next}:next,expected,baseRevision:initial?current.__fluentConfigRevision:undefined,clientId:`reading-style-${crypto.randomUUID()}`,sequence:1}),{next,current,initial,expected});assert.equal(result?.success,true,result?.error);};
    const service='custom:reading-style-fixture';
    await patch({uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,on:true,theme:'light',display:1,style:7,translationAppearance:APPEARANCE,service,from:'en',to:'zh-Hans',useCache:false,autoTranslate:false,bilingualSentenceHighlightEnabled:false,translationBeforeOriginal:false,customOpenAIProviders:[{id:service,name:'阅读样式夹具',endpoint:`${local.url}/v1/chat/completions`,models:['fixture']}],token:{[service]:'synthetic-local-fixture-not-a-secret'},model:{[service]:'fixture'},user_role:{[service]:'SOURCE_BEGIN{{origin}}SOURCE_END'},enableAIContext:false,enableAIMultiSegment:false,glossaryEnabled:false,hotkey:'Control',floatingBallHotkey:'Alt+T',mouseHoverTranslationDelay:0,selectionTranslatorMode:'disabled',disableSelectionTranslator:true,animations:false});
    await untilConfig(config=>config.service===service);
    const article=await newPage(`${local.url}/article`,'content-fixture');
    await article.locator('#fluent-read-page-styles').waitFor({state:'attached'});
    report.relativeColorSupport=await article.evaluate(()=>CSS.supports('color','oklch(from currentColor clamp(0.30, round(nearest, calc(l - 0.1), 1),0.92) 0.025 250 / 1)'));
    assert.equal(report.relativeColorSupport,true,'this matrix requires relative color and round() support');
    diagnostics.setPhase('translate-all-card-and-fun-styles');
    for(const preset of [...PRESETS,...EXTRA_PRESETS]){
      await patch({style:preset.value});await untilConfig(config=>config.style===preset.value);
      await activateExtensionTabWithoutForeground(context,article,30000);
      const source=article.locator(`#style-${preset.value}`);await source.hover();await article.keyboard.down('Control');await article.keyboard.up('Control');
      await article.waitForFunction(value=>document.querySelector(`#style-${value} > .fluent-read-bilingual-content`)?.textContent.includes('阅读应该轻松自然'),preset.value,{timeout:30000});
      const content=source.locator('> .fluent-read-bilingual-content');
      assert.equal(await content.count(),1);assert((await content.getAttribute('class')).split(/\s+/u).includes(preset.className));
      report.caseCoverage.push({value:preset.value,label:preset.label,realContentTranslation:true});
    }
    const content=preset=>article.locator(`#style-${preset.value} > .fluent-read-bilingual-content`);
    diagnostics.setPhase('translation-toggle');
    await patch({style:7});await untilConfig(config=>config.style===7);
    const toggleSource=article.locator('#style-7');const states=[await content(PRESETS[0]).count()];
    for(const count of [0,1]){await toggleSource.hover({position:{x:20,y:10}});await article.keyboard.down('Control');await article.keyboard.up('Control');await article.waitForFunction(expected=>document.querySelectorAll('#style-7 > .fluent-read-bilingual-content').length===expected,count,{timeout:30000});states.push(await content(PRESETS[0]).count());}
    assert.deepEqual(states,[1,0,1]);report.metrics.toggleStates=states;
    const requestCount=local.requests.length;
    const assertLayout=(metrics,label)=>{const b=metrics.bounds;assert(b.width>20&&b.height>10,`${label}: hidden`);assert(b.scrollWidth<=b.clientWidth+1,`${label}: text overflows`);assert(b.left>=b.parentLeft-1&&b.right<=b.parentRight+1,`${label}: exceeds parent`);};
    const assertReadable=(metrics,label)=>{assert(metrics.textContrast>=4.5,`${label}: text contrast ${metrics.textContrast}`);assert(metrics.link&&metrics.link.contrast>=4.5,`${label}: link contrast ${metrics.link?.contrast}`);};
    const settle=()=>article.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    for(const theme of THEMES){
      diagnostics.setPhase(`host-theme-${theme.name}`);await article.emulateMedia({colorScheme:theme.os});
      await article.evaluate(theme=>{document.documentElement.style.setProperty('--page-text',theme.foreground);document.documentElement.style.setProperty('--page-paper',theme.background);document.documentElement.style.setProperty('--page-link',theme.link);},theme);await settle();
      report.metrics.themes[theme.name]={};
      for(const preset of PRESETS){
        const target=content(preset);await target.scrollIntoViewIfNeeded();if(preset.value===48){await target.hover();await pause(250);}
        const metrics=await measure(target);assertLayout(metrics,`${theme.name}/${preset.value}`);assertReadable(metrics,`${theme.name}/${preset.value}`);
        assert.equal(metrics.link.href,'#reading-guide');
        if(SURFACE_PRESETS.some(p=>p.value===preset.value))assert(theme.dark?Math.max(...metrics.backgroundRgb)<130:Math.min(...metrics.backgroundRgb)>180,`${theme.name}/${preset.value}: surface must follow local foreground`);
        report.metrics.themes[theme.name][preset.value]=metrics;
      }
      await content(PRESETS[0]).scrollIntoViewIfNeeded();await shot(article,`01-host-${theme.name}`);
      await content(PRESETS[12]).scrollIntoViewIfNeeded();await shot(article,`02-fun-${theme.name}`);
    }
    report.checks.push('24 real translated presets remain readable across four host themes with opposite OS themes; 20 paper surfaces adapt without retranslating');
    const light=report.metrics.themes.white;
    for(const value of [7,8,9,39]){assert.equal(light[value].boxShadow,'none',`${value}: repeated cards avoid outer shadows`);assert.equal(light[value].backdropFilter,'none',`${value}: repeated cards avoid live backdrop sampling`);}
    report.metrics.longPageRendering={translatedWrappers:26,documentHeight:await article.evaluate(()=>document.documentElement.scrollHeight),
      containedPresets:PRESETS.filter(p=>light[p.value].renderingContained==='true').map(p=>p.value),
      lowDecorationPresets:[7,8,9,39],
      note:'Observed existing offscreen-containment eligibility and computed decoration costs on a real translated long page; no general FPS or speedup claim.'};
    for(const value of [7,8,9,39])assert.equal(light[value].renderingContained,'true',`${value}: long-page cards can use existing offscreen containment`);
    for(const fraction of [0,0.25,0.5,0.75,1]){await article.evaluate(fraction=>scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*fraction),fraction);await settle();}
    report.checks.push('Four common card styles avoid backdrop filtering and shadows, remain eligible for existing offscreen rendering on a long page, and survive a complete scroll');
    diagnostics.setPhase('foreground-boundaries');report.metrics.foregroundBoundaries=[];
    for(const [foreground,dark] of [['oklch(.59 .02 200)',false],['oklch(.60 .02 200)',true],['oklch(.61 .02 200)',true],['rgba(240,240,240,.3)',true]]){
      await toggleSource.evaluate((element,foreground)=>{element.style.color=foreground;},foreground);await settle();
      const metrics=await measure(content(PRESETS[0]));assertReadable(metrics,`boundary/${foreground}`);assert.equal(metrics.colorAlpha,255);
      assert(dark?Math.max(...metrics.backgroundRgb)<130:Math.min(...metrics.backgroundRgb)>180,`boundary/${foreground}: stable discrete paper`);report.metrics.foregroundBoundaries.push({foreground,dark,metrics});
    }
    await toggleSource.evaluate(element=>element.style.removeProperty('color'));await settle();
    report.checks.push('Foreground threshold boundaries and translucent source text produce discrete opaque readable paper/ink pairs');
    diagnostics.setPhase('mixed-local-themes');
    await article.evaluate(()=>document.body.classList.add('mixed'));await settle();
    for(const preset of SURFACE_PRESETS){const target=content(preset);await target.scrollIntoViewIfNeeded();const metrics=await measure(target);assertReadable(metrics,`mixed/${preset.value}`);const index=PRESETS.indexOf(preset);assert(index%2===1?Math.max(...metrics.backgroundRgb)<130:Math.min(...metrics.backgroundRgb)>180,`mixed/${preset.value}: must use local section foreground`);report.metrics.mixed[preset.value]=metrics;}
    await content(PRESETS[0]).scrollIntoViewIfNeeded();await shot(article,'03-local-mixed-themes');
    report.checks.push('Light and dark regions on the same webpage keep independent paper surfaces');
    diagnostics.setPhase('narrow-and-links');await article.setViewportSize({width:390,height:960});await settle();
    for(const preset of PRESETS){const target=content(preset);await target.scrollIntoViewIfNeeded();if(preset.value===48){await target.hover();await pause(250);}const metrics=await measure(target);assertLayout(metrics,`390/${preset.value}`);const link=target.locator('a').first();await link.scrollIntoViewIfNeeded();const clickable=await link.evaluate(e=>{const r=e.getClientRects()[0];return document.elementFromPoint(r.left+Math.min(r.width/2,8),r.top+r.height/2)?.closest('a')===e;});assert.equal(clickable,true,`${preset.value}: link hit testing`);await link.focus();assert.equal(await link.evaluate(e=>document.activeElement===e),true);report.metrics.narrow[preset.value]=metrics;}
    assert(await article.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px document overflow');
    await content(PRESETS[0]).scrollIntoViewIfNeeded();await shot(article,'04-narrow-local-themes');
    const firstLink=content(PRESETS[0]).locator('a').first();await firstLink.click();assert.equal(new URL(article.url()).hash,'#reading-guide');
    report.checks.push('All 24 translated styles wrap at 390px, preserve link hit testing and keyboard focus, and a real link click reaches its destination');
    assert.equal(local.requests.length,requestCount,'host changes must not trigger translation requests');
    diagnostics.setPhase('keyboard-and-touch-reveal');
    const spoiler=article.locator('#style-48 > .fluent-read-bilingual-content');const blur=article.locator('#style-28 > .fluent-read-bilingual-content');
    const waitForSpoiler=()=>article.waitForFunction(()=>getComputedStyle(document.querySelector('#style-48 > .fluent-read-bilingual-content > .fluent-read-translation-text')).backgroundColor==='rgba(0, 0, 0, 0)');
    const waitForBlur=()=>article.waitForFunction(()=>getComputedStyle(document.querySelector('#style-28 > .fluent-read-bilingual-content')).filter==='none');
    await spoiler.locator('a').focus();await article.mouse.move(0,0);await waitForSpoiler();
    await blur.locator('a').focus();await article.mouse.move(0,0);await waitForBlur();
    const cdp=await context.newCDPSession(article);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    assert.equal(await article.evaluate(()=>matchMedia('(hover: none)').matches),true,'touch emulation must expose no-hover CSS');
    await article.evaluate(()=>document.activeElement?.blur());await article.mouse.move(0,0);
    // 屏外 content-visibility 元素的动画可被延迟；在读者真正能看到的视口内验证最终揭开状态。
    await blur.scrollIntoViewIfNeeded();await waitForBlur();await spoiler.scrollIntoViewIfNeeded();await waitForSpoiler();
    report.metrics.touchAndKeyboard={keyboardSpoilerRevealed:true,keyboardBlurRevealed:true,touchMediaHoverNone:true,touchSpoilerRevealed:true,touchBlurRevealed:true};
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await cdp.detach();
    report.checks.push('Keyboard focus reveals spoiler and blur text; simulated no-hover input leaves both readable');
    diagnostics.setPhase('custom-appearance');await article.setViewportSize({width:1280,height:960});
    await patch({translationAppearance:{...APPEARANCE,textColor:'#123456',backgroundColor:'#fff8cc'}});await untilConfig(config=>config.translationAppearance.backgroundColor==='#fff8cc');
    await article.waitForFunction(()=>getComputedStyle(document.querySelector('#style-7 > .fluent-read-bilingual-content')).backgroundColor==='rgb(255, 248, 204)');
    const custom=await measure(content(PRESETS[0]));assert.equal(custom.color,'rgb(18, 52, 86)');assert.equal(custom.background,'rgb(255, 248, 204)');report.metrics.customAppearance=custom;
    await patch({translationAppearance:APPEARANCE});await untilConfig(config=>!config.translationAppearance.textColor);await settle();
    assert.notEqual((await measure(content(PRESETS[0]))).background,'rgb(255, 248, 204)');
    report.checks.push('Explicit user foreground/background colors win, and restoring defaults returns to the local theme');
    const options=await newPage(`${origin}/options.html#settings-interface`,'options-preview');
    const group=options.locator('.translation-style-group');await group.waitFor({state:'visible',timeout:30000});
    const preview=group.getByTestId('bilingual-highlight-preview-translation');
    report.metrics.customSurfacePairs=[];
    for(const {appearance,expected} of [
      {appearance:{...APPEARANCE,backgroundColor:'#000000'},expected:'rgb(0, 0, 0)'},
      {appearance:{...APPEARANCE,backgroundColor:'#ffffff'},expected:'rgb(255, 255, 255)'},
      {appearance:{...APPEARANCE,fillColor:'#111111'},expected:'rgb(231, 231, 231)'},
      {appearance:{...APPEARANCE,backgroundColor:'#ffffff',customCss:'background-color:#fff; background:#000'},expected:'rgb(0, 0, 0)'},
      {appearance:{...APPEARANCE,backgroundColor:'#000000',customCss:'background-color:#000; background:#fff'},expected:'rgb(255, 255, 255)'},
      ...['initial','unset','currentcolor'].map(reset=>({appearance:{...APPEARANCE,customCss:`background:linear-gradient(red,blue); background:${reset}; background-color:#fff`},expected:'rgb(255, 255, 255)'})),
    ]){
      await patch({translationAppearance:appearance});await untilConfig(config=>config.translationAppearance.customCss===appearance.customCss&&config.translationAppearance.backgroundColor===appearance.backgroundColor&&config.translationAppearance.fillColor===appearance.fillColor);
      await article.waitForFunction(expected=>getComputedStyle(document.querySelector('#style-7 > .fluent-read-bilingual-content')).backgroundColor===expected,expected);
      await options.waitForFunction(expected=>getComputedStyle(document.querySelector('[data-testid="bilingual-highlight-preview-translation"]')).backgroundColor===expected,expected);
      const actual=await measure(content(PRESETS[0]));const previewMetrics=await measure(preview);
      assertReadable(actual,'custom surface pair');assert.equal(actual.color,previewMetrics.color);assert.equal(actual.background,previewMetrics.background);
      report.metrics.customSurfacePairs.push({appearance,content:actual,preview:previewMetrics});
    }
    await patch({translationAppearance:APPEARANCE});await untilConfig(config=>!config.translationAppearance.backgroundColor&&!config.translationAppearance.fillColor&&!config.translationAppearance.customCss);await settle();
    await options.close();report.checks.push('Black/white backgrounds, fill-only and repeated shorthand ordering pair readable text identically in settings preview and existing webpage content');
    diagnostics.setPhase('forced-colors');
    await patch({translationAppearance:{...APPEARANCE,textColor:'#ef4776',backgroundColor:'#111111'}});await untilConfig(config=>config.translationAppearance.backgroundColor==='#111111');
    await article.emulateMedia({forcedColors:'active'});await settle();
    report.metrics.forcedColors={};
    for(const preset of PRESETS){const target=content(preset);await target.scrollIntoViewIfNeeded();if(preset.value===48){await target.hover();await pause(250);}const metrics=await measure(target);assertLayout(metrics,`forced/${preset.value}`);assertReadable(metrics,`forced/${preset.value}`);report.metrics.forcedColors[preset.value]=metrics;}
    await content(PRESETS[0]).scrollIntoViewIfNeeded();await shot(article,'05-forced-colors');
    report.checks.push('Forced colors mode keeps all styles and links readable');
    const gradient=article.locator('#style-40 > .fluent-read-bilingual-content');
    const forcedGradient=await measure(gradient);assert.notEqual(forcedGradient.textFillColor,'rgba(0, 0, 0, 0)');assertReadable(forcedGradient,'forced gradient text');report.metrics.forcedGradient=forcedGradient;
    await article.emulateMedia({forcedColors:'none'});await settle();
    diagnostics.setPhase('print-reading');await article.emulateMedia({media:'print'});await settle();
    report.metrics.print={};
    for(const preset of [...PRESETS,...EXTRA_PRESETS]){const metrics=await measure(content(preset));assert.equal(metrics.filter,'none');assert.equal(metrics.mask,'none');assert.equal(metrics.boxShadow,'none');assert.equal(metrics.color,'rgb(0, 0, 0)');assert.equal(metrics.link.color,'rgb(0, 0, 0)');assert.notEqual(metrics.textFillColor,'rgba(0, 0, 0, 0)');report.metrics.print[preset.value]=metrics;}
    await article.emulateMedia({media:'screen'});await patch({translationAppearance:APPEARANCE});await untilConfig(config=>!config.translationAppearance.textColor);await settle();
    report.checks.push('Print removes decorative masks, filters and shadows and preserves black text and underlined links');
    report.requests=local.requests.length;report.requestEvidence={received:report.requests,realTranslatedPresets:26,cardFunThemeCases:96,changesCausedNewRequests:local.requests.length!==requestCount};
    assert.equal(local.requests.length,requestCount,'appearance/input/printing changes must not translate again');
    report.contrastBoundary='Computed text and link colors against the opaque base paper, or the first opaque gradient color used for the content surface; decorative gradient locations and textures are retained for visual inspection. This is not pixel-perfect gradient contrast proof.';
    await diagnostics.flush();diagnostics.assertClean();report.ok=true;
  } catch(error){failure=error;report.error=redact(error.stack||String(error));}
  finally {
    report.cleanupErrors=[];let closed=!launchAttempted;
    const cleanup=(stage,action)=>({stage,action:async()=>{try{await action();}catch(error){report.cleanupErrors.push({stage,message:redact(error.message||error)});throw error;}}});
    await finalizeRun({diagnostics,result:report,artifactsDir:OUT,primaryError:failure,cleanup:[cleanup('browser-close',async()=>{if(launched){await launched.close();closed=true;}}),cleanup('fixture-close',async()=>{await local?.close();}),cleanup('profile-removal',async()=>{if(profileDir&&closed)fs.rmSync(profileDir,{recursive:true,force:true});else if(profileDir)report.retainedProfile=profileDir;})],emitReport:result=>{const snapshot=result.runtimeDiagnostics;const own=snapshot.entries.filter(entry=>entry.ownership==='fluentread'&&!entry.expectedCase);result.diagnosticSummary={passed:snapshot.passed,fluentreadErrors:own.filter(entry=>entry.level==='error').length,fluentreadWarnings:own.filter(entry=>entry.level==='warning').length,expectedDiagnostics:snapshot.entries.filter(entry=>entry.expectedCase).length,provenSiteDiagnostics:snapshot.entries.filter(entry=>entry.ownership==='site').length,unattributedDiagnostics:snapshot.entries.filter(entry=>entry.ownership==='unattributed').length,collectionFailures:snapshot.coverage.failures,collectionLimitations:snapshot.coverage.limitations,workerObserved:snapshot.workerObserved,completeCoverage:snapshot.completeCoverage,coverageScope:snapshot.coverageScope};fs.writeFileSync(path.join(OUT,'report.json'),`${JSON.stringify(result,null,2)}\n`);}});
  }
  console.log(JSON.stringify({ok:report.ok,checks:report.checks,diagnostics:report.diagnosticSummary,error:report.error,report:path.join(OUT,'report.json')}));if(failure)throw failure;
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
