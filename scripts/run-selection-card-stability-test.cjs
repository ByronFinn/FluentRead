#!/usr/bin/env node
// 统一卡片、稳定位置与学习中心专项：使用生产扩展、独立 profile 与焦点安全 helper。AI/译文由本地确定性夹具返回。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const support = require('./run-selection-trigger-test.cjs');
const arg = (key) => process.argv[process.argv.indexOf(`--${key}`) + 1];
const output = path.resolve(arg('artifacts-dir'));
const extensionDir = path.resolve(arg('extension-dir'));
const {chromium} = createRequire(path.join(arg('playwright-root'), 'package.json'))('playwright');
const helper = require(path.resolve(arg('focus-safe-helper')));
const sentence = 'The curious reader explores new ideas.';
const grammar = '### 主干\nThe reader explores ideas. 读者探索想法。\n\n### 词性与句法\n| Text | POS | Role | Meaning |\n| --- | --- | --- | --- |\n| The | article | 限定 reader | 这位 |\n| curious | adjective | 修饰 reader | 好奇的 |\n| reader | noun | 主语 | 读者 |\n| explores | verb | 谓语 | 探索 |\n| new | adjective | 修饰 ideas | 新的 |\n| ideas | noun | 宾语 | 想法 |\n\n### 关键点\n形容词描述名词，词性和句中作用分开理解。';
const report = {providerEvidence:'Production extension in isolated Edge; translation and AI responses use deterministic local fixtures. Dictionary uses the real dictionary pipeline. No authenticated AI quality claim.',ok:false,cases:[],screenshots:[],consoleErrors:[],translationRequests:0,aiRequests:0,persistenceCases:[],quickClose:{},crossPageSync:{},latestWriteWins:{}};
const record = name => {report.cases.push(name); console.log('PASS',name);};
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
let session, context, worker, server, optionsPage, popup, page;
async function screenshot(target,name) {const file=path.join(output,name+'.png'); await target.screenshot({path:file,fullPage:false}); report.screenshots.push(file);}
async function node(predicate) {const {root}=await support.getSelectionUiTree(page); return support.findCdpNode(root,predicate);}
const cls = name => n => support.hasCdpClass(n,name);
async function until(predicate,message) {for(let i=0;i<80;i++){if(await predicate()) return; await wait(100);} throw new Error(message);}
async function clickNode(predicate) {const {session:cdp,root}=await support.getSelectionUiTree(page); const n=support.findCdpNode(root,predicate); assert(n,'Missing UI node'); await cdp.send('DOM.scrollIntoViewIfNeeded',{nodeId:n.nodeId}); const {model}=await cdp.send('DOM.getBoxModel',{nodeId:n.nodeId}); const q=model.content; await page.mouse.click((q[0]+q[2]+q[4]+q[6])/4,(q[1]+q[3]+q[5]+q[7])/4);}
const button = text => n=> n.nodeName==='BUTTON' && support.cdpText(n).trim()===text;
async function choose(selector) {
 await helper.activateExtensionTabWithoutForeground(context,page);
 const points=await page.evaluate(selector=>{
  const target=document.querySelector(selector),text=target.firstChild,range=document.createRange();
  range.setStart(text,0);range.setEnd(text,1);const first=range.getBoundingClientRect();
  range.setStart(text,text.length-1);range.setEnd(text,text.length);const last=range.getBoundingClientRect();
  return {start:{x:first.left,y:first.top+first.height/2},end:{x:last.right+2,y:last.top+last.height/2}};
 },selector);
 await page.mouse.move(points.start.x,points.start.y);await page.mouse.down();await page.mouse.move(points.end.x,points.end.y,{steps:12});await page.mouse.up();
}
async function select(selector) {await helper.activateExtensionTabWithoutForeground(context,page); await page.mouse.click(20,20); await choose(selector); await until(()=>node(cls('fr-selection-indicator')),'selection indicator missing');
 const state=await support.getSelectionUiTree(page);const indicator=support.findCdpNode(state.root,cls('fr-selection-indicator'));const {model}=await state.session.send('DOM.getBoxModel',{nodeId:indicator.nodeId});
 const anchor=await page.evaluate(()=>{const r=getSelection().getRangeAt(0).getBoundingClientRect();return {right:r.right,bottom:r.bottom};});
 assert(Math.abs(model.border[0]+model.width/2-anchor.right)<24 && Math.abs(model.border[1]+model.height/2-anchor.bottom)<24,'selection icon is not anchored beside the selected text');
 await clickNode(cls('fr-selection-indicator')); await until(()=>node(cls('fr-translation-tooltip')),'selection popup missing');}
async function patch(value) {await support.patchStoredConfig(popup,value); await wait(350);}
async function inspectCard(fn) {
 const {session:cdp,root}=await support.getSelectionUiTree(page);const card=support.findCdpNode(root,cls('fr-translation-tooltip'));assert(card);
 const {object}=await cdp.send('DOM.resolveNode',{nodeId:card.nodeId});
 const value=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,returnByValue:true,awaitPromise:true,functionDeclaration:fn});return value.result.value;
}
const geometry=()=>inspectCard('function(){const b=this.getBoundingClientRect();return {left:b.left,top:b.top,width:b.width,height:b.height,right:b.right,bottom:b.bottom}}');
async function trackCard() {
 await inspectCard(`function(){const card=this;globalThis.__cardSamples=[];globalThis.__cardTracking=true;const sample=()=>{if(!globalThis.__cardTracking)return;const b=card.getBoundingClientRect();globalThis.__cardSamples.push({left:b.left,top:b.top,width:b.width,height:b.height});requestAnimationFrame(sample)};sample()}`);
}
async function assertStable(name,initial,full=false) {
 const samples=await page.evaluate(()=>{globalThis.__cardTracking=false;return globalThis.__cardSamples});assert(samples.length>2);
 const dimensions=full?['left','top','width','height']:['left','top','width'];
 for(const sample of samples)for(const key of dimensions)assert(Math.abs(sample[key]-initial[key])<1,`${name} changed ${key}: ${initial[key]} -> ${sample[key]}`);
 report.geometry=report.geometry||[];report.geometry.push({name,frames:samples.length,initial,final:samples.at(-1)});record(name);
}
function silentWav(seconds=8) {
 const rate=24000,bytes=rate*seconds*2,buf=Buffer.alloc(44+bytes);buf.write('RIFF',0);buf.writeUInt32LE(36+bytes,4);buf.write('WAVEfmt ',8);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);buf.writeUInt32LE(rate,24);buf.writeUInt32LE(rate*2,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(bytes,40);return buf;
}
async function main(){
 fs.mkdirSync(output,{recursive:true});const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-selection-stable-'));
 server=http.createServer(async(req,res)=>{
  if(req.url==='/translate'){report.translationRequests++;let body='';for await(const chunk of req)body+=chunk;const texts=JSON.parse(body);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(texts.map(text=>({translations:[{text:text===sentence?'这位好奇的读者探索新的想法。':'好奇的；求知欲强的',to:'zh-Hans'}]}))));return;}
  report.aiRequests++;let body='';for await(const chunk of req)body+=chunk;
  const answer=body.includes('Text | POS | Role | Meaning')?grammar:'### 学习要点\n这位好奇的读者探索新的想法。\n\n### 用法\ncurious reader 描述读者的好奇心。';
  res.writeHead(200,{'content-type':'text/event-stream','access-control-allow-origin':'*'});
  for(const part of answer.match(/[\s\S]{1,40}/g)){res.write('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:{content:part},finish_reason:null}]})+'\n\n');await wait(20);}
  res.end('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 try {
  session=await helper.launchFocusSafePersistentContext({chromium,profileDir,browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:false,background:true,browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check','--mute-audio'],viewport:{width:1440,height:960}});
  context=session.context;Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement,extensionDir,audio:{muted:true,listeningVerified:false}});
  const ready=await support.waitForWorker(context);worker=ready.worker;const id=ready.extensionId;
  const newPage=async()=>{const p=await helper.newPageWithoutForeground(context);p.on('pageerror',e=>report.consoleErrors.push(e.message));return p};
  popup=await newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await popup.locator('.popup-shell[data-config-ready="true"]').waitFor();
  const saved=await support.readStoredConfig(popup);
  await patch({on:true,vocabularyBookEnabled:false,uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,service:'microsoft',from:'auto',to:'zh-Hans',selectionTranslatorMode:'bilingual',selectionTranslatorPresentation:'card',selectionTranslatorTrigger:'icon',selectionTranslatorAutoDismiss:false,selectionTranslatorDelay:0,hotkey:'none',floatingBallHotkey:'none',useCache:false,selectionTtsMode:'online-first',harness:{...saved.harness,enabled:true,memoryEnabled:false,service:'custom:fixture',model:'learning-fixture',trigger:'click'},customOpenAIProviders:[{id:'custom:fixture',name:'Local fixture',endpoint:`http://127.0.0.1:${port}/v1/chat/completions`,models:['learning-fixture']}],token:{'custom:fixture':'fixture-token'},model:{...saved.model,'custom:fixture':'learning-fixture'}});
  assert.equal((await support.readStoredConfig(popup)).selectionTranslatorPresentation,'card');
  await worker.evaluate(url=>{const native=fetch.bind(globalThis);globalThis.fetch=(input,init)=>String(input).startsWith('https://edge.microsoft.com/translate/translatetext')?native(url,init):native(input,init)},`http://127.0.0.1:${port}/translate`);
  await context.route('https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({t:'fixture-tts-token',r:'fixture'})}));
  await context.route('https://fixture.tts.speech.microsoft.com/cognitiveservices/v1',route=>{report.audio.requests=(report.audio.requests||0)+1;return route.fulfill({status:200,contentType:'audio/wav',body:silentWav()})});
  optionsPage=await newPage();await optionsPage.goto(`chrome-extension://${id}/options.html#settings-selection`);await optionsPage.locator('#settings-selection').waitFor();
  assert.equal(await optionsPage.getByRole('group',{name:'划词默认呈现'}).count(),0);
  const preview=optionsPage.locator('.selection-setup .settings-preview-example');
  await preview.locator('.selection-preview-word').waitFor();
  assert((await preview.innerText()).includes('Eager to know or learn something.'));
  await preview.getByRole('button',{name:'句子',exact:true}).click();
  await preview.locator('[data-reading-answer]').waitFor();
  assert((await preview.innerText()).includes('Every language offers a new way to see the world.'));
  await screenshot(optionsPage,'merged-selection-settings');
  await optionsPage.setViewportSize({width:390,height:800});
  assert(await optionsPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot(optionsPage,'merged-selection-settings-390');
  await optionsPage.setViewportSize({width:1440,height:960});
  record('merged settings preserve visible word and sentence previews in the shared layout');
  const learningPage=await newPage();await learningPage.goto(`chrome-extension://${id}/options.html?learningTab=saved#settings-vocabulary`);await learningPage.locator('.fr-learning-center').waitFor();
  assert.deepEqual(await learningPage.locator('.fr-learning-center .segmented-control button').allTextContents(),['单词与句子','阅读记录','学习笔记']);
  assert((await learningPage.locator('.fr-learning-center-purpose').innerText()).includes('单词、短语和句子'));
  await learningPage.getByRole('button',{name:'开启收藏入口',exact:true}).click();
  await learningPage.locator('.book-more > summary').click();
  await learningPage.getByRole('switch',{name:'收藏入口',exact:true}).waitFor();assert.equal(await learningPage.getByRole('switch',{name:'收藏入口',exact:true}).getAttribute('aria-checked'),'true');
  assert.equal((await support.readStoredConfig(popup)).vocabularyBookEnabled,true);assert.equal((await support.readStoredConfig(popup)).harness.memoryEnabled,false);
  await learningPage.locator('.book-more > summary').press('Escape');
  await learningPage.setViewportSize({width:390,height:800});await wait(200);assert(await learningPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await learningPage.locator('.collection-overview h2').click();await screenshot(learningPage,'learning-empty-guidance');
  record('learning tabs explain destinations and the empty list enables saving without AI reference');
  await popup.reload();await popup.locator('.popup-shell[data-config-ready="true"]').waitFor();
  await popup.locator('[data-popup-quick-feature="selection"]').click();assert.equal(await popup.getByRole('group',{name:'划词默认呈现'}).count(),0);record('settings and popup use one card presentation');
  await context.route('https://example.com/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="en"><head><title>Stable selection card</title><style>body{margin:80px;color:#253248;font:20px/1.8 system-ui}p{max-width:750px}#sentence{margin-top:300px}#word{margin-top:120px}</style></head><body><h1>Stable translation card</h1><p id="sentence">${sentence}</p><p id="word">curious</p><p id="neighbor">Learning grows with every question.</p><div style="height:1500px"></div></body></html>`}));
  page=await newPage();await page.goto('https://example.com/');await page.locator('#fluent-read-selection-translator-container').waitFor({state:'attached'});
  await select('#sentence');await until(async()=>support.cdpText(await node(cls('fr-translation-tooltip'))).includes('这位好奇'),'translation missing');await wait(200);
  assert.equal(report.aiRequests,0);assert(await inspectCard(`function(){return [...this.querySelectorAll('.fr-close-btn,.fr-text-audio-btn')].every(b=>getComputedStyle(b).visibility==='visible')}`));const tabs=await inspectCard(`function(){return [...this.querySelector('.fr-study-toolbar').querySelectorAll('button')].map(b=>({text:b.textContent.trim(),pressed:b.getAttribute('aria-pressed')}))}`);
  assert.deepEqual(tabs.map(t=>t.text),['翻译','读懂','词性与句法','用法','练习','记录']);assert.equal(tabs[0].pressed,'true');assert.equal(await node(cls('fr-mode-btn')),null);record('translation is the first default tab and opening it does not request AI');
  const initial=await geometry();assert.equal((await inspectCard('function(){return this.dataset.placement}')),'top');await screenshot(page,'translation-first');
  await trackCard();await clickNode(button('词性与句法'));await until(()=>node(cls('fr-sentence-tokens')),'grammar missing');await until(()=>node(button('保存学习笔记')),'answer still streaming');await wait(200);await assertStable('grammar switch and streaming preserve the opening anchor',initial);
  assert.equal(await node(cls('fr-reading-actions')),null);await screenshot(page,'grammar-stable');
  await trackCard();await clickNode(button('用法'));await until(()=>node(button('保存学习笔记')),'usage incomplete');await wait(200);await assertStable('usage tab preserves the same anchor',initial);
  await clickNode(button('保存学习笔记'));await until(()=>node(button('查看学习笔记')),'memory save did not succeed');await screenshot(page,'memory-saved');
  // 导航点击仍经过真实 runtime handler；为保护焦点，仅将浏览器原生新页创建替换成预创建的后台页 URL 更新。
  const memoryPage=await newPage();await memoryPage.goto(`chrome-extension://${id}/options.html?reserved-memory=1#settings-general`);await memoryPage.locator('.settings-app').waitFor();
  const memoryTabId=await memoryPage.evaluate(async()=> (await chrome.tabs.getCurrent()).id);assert(Number.isSafeInteger(memoryTabId));
  await worker.evaluate(targetId=>{globalThis.__learningOpen=[];chrome.tabs.create=(properties,callback)=>{globalThis.__learningOpen.push(properties);const promise=chrome.tabs.update(targetId,{url:properties.url,active:false});if(callback)promise.then(callback);return promise}},memoryTabId);
  await helper.activateExtensionTabWithoutForeground(context,page);await clickNode(button('查看学习笔记'));await wait(250);report.memoryClicked=await worker.evaluate(()=>globalThis.__learningOpen);await memoryPage.waitForURL(/learningTab=memory/);await memoryPage.locator('.fr-memory-item').waitFor();
  assert((await memoryPage.locator('.fr-memory-item').innerText()).includes(sentence));assert((await memoryPage.locator('.fr-memory-item').innerText()).includes('学习要点'));assert.equal(await memoryPage.locator('.fr-learning-center .segmented-control button[aria-checked="true"]').innerText(),'学习笔记');
  assert.equal(await memoryPage.locator('.fr-memory-options').getAttribute('open'),null);
  await memoryPage.locator('.fr-memory-options > summary').click();
  assert((await memoryPage.locator('.fr-memory-options').innerText()).includes('回答时暂不参考笔记'));
  await memoryPage.locator('.fr-memory-options > summary').press('Escape');
  assert.equal((await support.readStoredConfig(popup)).harness.memoryEnabled,false);
  assert.equal(await memoryPage.locator('.fr-memory-item').count(),1);
  await learningPage.reload();await learningPage.locator('.empty-state').waitFor();assert.equal(await learningPage.locator('.word-list').count(),0);
  record('study notes save while AI reference is off and do not populate saved words');
  await memoryPage.locator('.fr-memory-heading h2').click();await screenshot(memoryPage,'learning-memory-destination');report.memoryNavigation={requests:await worker.evaluate(()=>globalThis.__learningOpen),adapter:'precreated background tab, native tabs.update(active:false); runtime validation and options UI are real',nativeTabCreation:false};record('saved key points appear in Study notes and view opens that tab directly');
  await helper.activateExtensionTabWithoutForeground(context,page);await clickNode(button('收藏原文'));await until(()=>node(button('查看单词与句子')),'source was not saved');
  await clickNode(button('查看单词与句子'));await memoryPage.waitForURL(/learningTab=saved/);await memoryPage.locator('.word-list').waitFor();
  assert((await memoryPage.locator('.word-list').innerText()).includes(sentence));assert((await memoryPage.locator('.word-list').innerText()).includes('这位好奇的读者探索新的想法。'));assert(!(await memoryPage.locator('.word-list').innerText()).includes('学习要点'));assert.equal(await memoryPage.locator('.fr-learning-center .segmented-control button[aria-checked="true"]').innerText(),'单词与句子');
  await screenshot(memoryPage,'learning-words-destination');record('saved original opens Words and sentences separately from study notes');
  // 收藏页专项：所有数据经真实后台消息保存，学习/筛选/复习均操作生产 UI。
  const sendBook = message => memoryPage.evaluate(message => chrome.runtime.sendMessage(message),message);
  for(const [term,translation,text] of [['curious','好奇的；求知欲强的',sentence],['on time','准时','We arrived on time.']]) {
    const savedEntry=await sendBook({type:'fluentReadVocabularyBook',action:'upsert',input:{term,translation,sourceLanguage:'en',targetLanguage:'zh-Hans',context:{text,sourceUrl:'https://example.com/article',pageTitle:'Reading fixture'}}});
    assert(savedEntry.success);
  }
  await memoryPage.reload();await memoryPage.locator('.word-row').nth(2).waitFor();
  assert.equal(await memoryPage.getByRole('switch',{name:'收藏入口',exact:true}).isVisible(),false);
  assert.equal(await memoryPage.locator('.entry-study').count(),3);
  const aiBeforeLearning=report.aiRequests;
  await memoryPage.getByRole('button',{name:'听读与理解',exact:true}).click();await memoryPage.locator('.word-study').waitFor();
  assert((await memoryPage.locator('.study-title').innerText()).includes(sentence));assert.equal(await memoryPage.locator('.sentence-translation').innerText(),'这位好奇的读者探索新的想法。');assert.equal(await memoryPage.locator('.study-reference').count(),0);assert.equal(report.aiRequests,aiBeforeLearning);
  await screenshot(memoryPage,'learning-sentence-study');
  await memoryPage.getByRole('button',{name:/返回收藏/}).click();await memoryPage.locator('.word-list').waitFor();
  await memoryPage.locator('.word-row').filter({has:memoryPage.getByRole('heading',{name:'curious',exact:true})}).getByRole('button',{name:'学习用法',exact:true}).click();await memoryPage.locator('.word-study').waitFor();
  assert.equal(report.aiRequests,aiBeforeLearning);await memoryPage.getByRole('button',{name:/返回收藏/}).click();
  record('visible sentence and expression learning actions open the matching study page without requesting AI');
  const choose = async(label,text) => {await memoryPage.locator('.el-select').filter({has:memoryPage.getByRole('combobox',{name:label,exact:true})}).locator('.el-select__wrapper').click();await memoryPage.getByRole('option',{name:text,exact:true}).click();await wait(100)};
  await choose('收藏类型','句子');assert.equal(await memoryPage.locator('.word-row').count(),1);
  await memoryPage.getByRole('searchbox',{name:'搜索收藏',exact:true}).fill('no-match-fixture');await memoryPage.locator('.empty-state').waitFor();
  assert((await memoryPage.locator('.collection-results').innerText()).includes('0'));
  await memoryPage.locator('.empty-state').getByRole('button',{name:'清除筛选',exact:true}).click();await memoryPage.locator('.word-row').nth(2).waitFor();
  await memoryPage.getByRole('searchbox',{name:'搜索收藏',exact:true}).fill('准时');assert.equal(await memoryPage.locator('.word-row').count(),1);
  await memoryPage.locator('.collection-results').getByRole('button',{name:'清除筛选',exact:true}).click();
  await memoryPage.locator('.book-filter > summary').click();await choose('掌握状态','已掌握');assert.equal(await memoryPage.locator('.word-row').count(),0);
  await memoryPage.locator('.filter-panel').getByRole('button',{name:'清除筛选',exact:true}).click();await memoryPage.locator('.book-filter > summary').press('Escape');await memoryPage.locator('.word-row').nth(2).waitFor();
  record('type, translation search and mastery filters work and empty results have a reset action');
  const centerFile=path.join(output,'learning-library-desktop.png');await memoryPage.locator('.fr-learning-center').screenshot({path:centerFile});report.screenshots.push(centerFile);
  for(const width of [1024,390]) {await memoryPage.setViewportSize({width,height:900});await wait(180);assert(await memoryPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot(memoryPage,`learning-library-${width}`);}
  await memoryPage.locator('.book-more > summary').click();
  const switchControl=memoryPage.getByRole('switch',{name:'收藏入口',exact:true});await switchControl.click();
  await until(async()=>!(await support.readStoredConfig(popup)).vocabularyBookEnabled,'saving setting was not persisted');
  await memoryPage.reload();await memoryPage.locator('.word-row').nth(2).waitFor();await memoryPage.locator('.book-more > summary').click();
  assert.equal(await switchControl.getAttribute('aria-checked'),'false');assert.equal(await memoryPage.locator('.word-row').count(),3);
  const reencounter=memoryPage.getByRole('switch',{name:'再次遇见收藏表达',exact:true});await reencounter.click();
  await until(async()=>(await support.readStoredConfig(popup)).vocabularyReencounterEnabled,'reencounter setting was not persisted');
  await screenshot(memoryPage,'learning-library-management-mobile');await memoryPage.locator('.book-more > summary').press('Escape');
  await memoryPage.reload();await memoryPage.locator('.word-row').nth(2).waitFor();await memoryPage.locator('.book-more > summary').click();assert.equal(await reencounter.getAttribute('aria-checked'),'true');await switchControl.click();await memoryPage.locator('.book-more > summary').press('Escape');
  report.persistenceCases.push({name:'collection settings in management menu',reopenVerified:true,savedEntriesRetained:3});
  record('management toggles persist after reopening and disabling the saving entry keeps the collection');
  await memoryPage.setViewportSize({width:1440,height:960});await patch({theme:'dark'});await wait(200);await screenshot(memoryPage,'learning-library-dark');await patch({theme:'light'});
  const beforeReview=(await sendBook({type:'fluentReadVocabularyBook',action:'list'})).data.reduce((sum,entry)=>sum+entry.reviewCount,0);
  assert.equal(beforeReview,0);await memoryPage.locator('.start-review').click();await memoryPage.locator('.review-card').waitFor();assert.equal(await memoryPage.locator('.review-actions').count(),0);
  await memoryPage.getByRole('textbox',{name:'我的回忆',exact:true}).fill('I remember this expression.');await memoryPage.getByRole('button',{name:/显示答案/}).click();await memoryPage.locator('.review-actions').waitFor();await screenshot(memoryPage,'learning-library-review');
  await memoryPage.locator('.review-actions .good').click();await until(async()=>(await sendBook({type:'fluentReadVocabularyBook',action:'list'})).data.reduce((sum,entry)=>sum+entry.reviewCount,0)===1,'review rating was not persisted');
  await memoryPage.getByRole('button',{name:'退出本轮',exact:true}).click();assert.equal(report.aiRequests,aiBeforeLearning);
  record('review asks for recall before reveal and only an explicit rating updates the persisted schedule');

  await helper.activateExtensionTabWithoutForeground(context,page);const requests=report.aiRequests;await trackCard();await clickNode(button('翻译'));await wait(250);await assertStable('return to translation preserves the anchor',initial);await clickNode(button('词性与句法'));await wait(350);assert.equal(report.aiRequests,requests);record('completed grammar is reused without a second AI request');await clickNode(button('翻译'));
  for(const label of ['播放原文','播放译文']) {
   const before=await geometry();await trackCard();await clickNode(n=>n.nodeName==='BUTTON'&&support.cdpAttribute(n,'aria-label')===label);await until(()=>node(button('停止')),'speech did not begin');await wait(300);await clickNode(n=>support.cdpAttribute(n,'aria-label')==='停止播放');await wait(250);await assertStable(`${label} start and stop keep the anchor and width`,before);
  }
  await page.keyboard.press('Escape');await select('#word');await until(()=>node(cls('fr-word-meaning')),'dictionary missing');await wait(200);const wordBefore=await geometry();await trackCard();await clickNode(cls('fr-text-audio-btn'));await until(()=>node(button('停止')),'word audio missing');await wait(250);await clickNode(n=>support.cdpAttribute(n,'aria-label')==='停止播放');await wait(200);await assertStable('word pronunciation start and stop keep the anchor and width',wordBefore);await screenshot(page,'word-stable');
  await page.setViewportSize({width:390,height:800});await wait(350);let bounds=await geometry();assert(bounds.left>=11&&bounds.right<=391&&bounds.bottom<=789);const narrow=await geometry();await trackCard();await clickNode(button('用法'));await until(()=>node(button('保存学习笔记')),'narrow usage missing');await wait(200);await assertStable('narrow viewport tab switch stays anchored and scrolls inside',narrow);bounds=await geometry();assert(bounds.bottom<=789);await screenshot(page,'narrow-stable');
  await page.keyboard.press('Escape');await wait(150);assert.equal(await node(cls('fr-translation-tooltip')),null);await page.setViewportSize({width:1440,height:960});await select('#sentence');await until(()=>node(cls('fr-translation-result')),'reopened translation missing');assert.equal((await inspectCard(`function(){return this.querySelector('.fr-study-toolbar button').getAttribute('aria-pressed')}`)),'true');record('close and reselect restore the translation tab and fresh geometry');
  const beforeResize=await geometry();
  const handle=await inspectCard(`function(){const b=this.querySelector('.fr-popup-resize-e').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,width:b.width,height:b.height}}`);
  assert(handle.width>0&&handle.height>0,'resize handle is not rendered');
  await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(handle.x+60,handle.y,{steps:8});await page.mouse.up();await wait(150);
  const resized=await geometry();assert(Math.abs(resized.width-beforeResize.width-60)<1);
  await trackCard();await clickNode(button('词性与句法'));await until(()=>node(button('保存学习笔记')),'resized grammar missing');await wait(200);await assertStable('resizing keeps the selected size when switching to grammar',resized,true);
  const header=await inspectCard(`function(){const b=this.querySelector('.fr-tooltip-title').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}}`);
  await page.mouse.move(header.x,header.y);await page.mouse.down();await page.mouse.move(header.x+40,header.y+20,{steps:8});await page.mouse.up();await wait(150);
  const dragged=await geometry();assert(Math.abs(dragged.left-resized.left-40)<1&&Math.abs(dragged.top-resized.top-20)<1);
  await trackCard();await clickNode(button('翻译'));await wait(200);await assertStable('dragging in grammar keeps the chosen position when returning to translation',dragged,true);
  await patch({uiLanguage:'en-US'});await memoryPage.reload();await memoryPage.locator('.fr-learning-center').waitFor();await memoryPage.setViewportSize({width:390,height:800});await wait(200);
  assert.deepEqual(await memoryPage.locator('.fr-learning-center .segmented-control button').allTextContents(),['Words & sentences','Reading history','Study notes']);assert(await memoryPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  for(const language of ['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES','zh-CN']) {
    await patch({uiLanguage:language});await memoryPage.reload();await memoryPage.locator('.word-row').nth(2).waitFor();
    assert(await memoryPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert(await memoryPage.locator('.collection-management').evaluate(element=>[...element.querySelectorAll('.start-review,.book-more > summary')].every(control=>{const b=control.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth})),`${language} collection actions extend past the viewport`);
    if(language==='en-US')await screenshot(memoryPage,'learning-library-english-narrow');
  }
  record('collection actions and learning buttons fit the narrow viewport in all seven interface languages');
  await patch({uiLanguage:'en-US'});await memoryPage.reload();await memoryPage.locator('.fr-learning-center').waitFor();
  await memoryPage.getByRole('radio',{name:'Study notes',exact:true}).click();await memoryPage.locator('.fr-memory-item').waitFor();assert.equal(await memoryPage.locator('.fr-memory-item').count(),1);await screenshot(memoryPage,'learning-notes-english-narrow');
  record('English learning tabs and notes remain usable in a narrow viewport');
  assert.equal(report.consoleErrors.length,0);assert(report.audio.requests>=3);report.ok=true;
 }catch(error){report.error=error.stack;report.navigationDiagnostic=await worker?.evaluate(()=>globalThis.__learningOpen).catch(()=>null);if(page&&!page.isClosed())await screenshot(page,'failure-page').catch(()=>{});if(popup&&!popup.isClosed())await screenshot(popup,'failure-popup').catch(()=>{});throw error}
 finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await session?.close();server.close();fs.rmSync(profileDir,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1});
