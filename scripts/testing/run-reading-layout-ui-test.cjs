#!/usr/bin/env node
/**
 * @file scripts/testing/run-reading-layout-ui-test.cjs
 * 文件职责：在隔离生产扩展中验证网页上下顺序即时应用与视频读音设置的模式联动。
 * 主要内容：用本地服务验证原文身份、重复切换、无额外翻译请求和恢复；验证真实设置页的读音预览顺序、单语禁用、显式恢复、键盘焦点、快关持久化及七语窄屏，并采集内容隔离世界、扩展页面与后台诊断。
 * 模块边界：只使用本轮临时 Edge profile、本地翻译夹具和固定预览；不连接用户浏览器、不请求在线服务或下载读音词典，不推断 Firefox 实机表现。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {startFocusEventMonitor} = require('./mac-focus-event-monitor.cjs');
const {assertFreshProductionExtension} = require('../run-site-translation-test.cjs');
const arg = (key, fallback) => {const i = process.argv.indexOf(`--${key}`); return i < 0 ? fallback : process.argv[i + 1];};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-reading-layout-ui'));
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const helperPath = arg('focus-safe-helper', path.join(os.homedir(), '.codex/skills/fluentread-extension-ui-test/scripts/focus-safe-browser.cjs'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
const {createRuntimeDiagnostics, finalizeRun} = require(path.join(path.dirname(helperPath), 'runtime-diagnostics.cjs'));
const SOURCE = 'Reading should feel calm and effortless. Colors and lines should follow the page you are reading.';
const TRANSLATION = '阅读应该轻松、自然。颜色和线条应当贴合你正在阅读的网页。';
const service = 'custom:reading-layout-fixture';
const result = {ok: false, extensionDir, cases: [], screenshots: [], requests: 0, layouts: [],
  scope: 'Production MV3 Edge, local provider fixture, real options and content scripts; fixed reading preview only',
  notRun: ['live provider', 'physical Firefox', 'real video reading engines', 'assistive technology speech']};
const diagnostics = createRuntimeDiagnostics();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-reading-layout-'));
fs.mkdirSync(artifactsDir, {recursive: true});
let session, control, browserPid, monitor, focusError, primaryError, closed = false, launchStarted = false;
function stage(label) {diagnostics.setPhase(label); console.error(`[reading-layout] ${label}`);}
const server = http.createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*'); response.setHeader('access-control-allow-headers', '*');
  if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return;}
  if (request.method === 'POST') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
    const source = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1] || '';
    result.requests++; response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({id: 'reading-layout', object: 'chat.completion', created: 1, model: body.model,
      choices: [{index: 0, message: {role: 'assistant', content: source.replace(SOURCE, TRANSLATION)}, finish_reason: 'stop'}]})); return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title></title><style>body{padding:48px;font:18px/1.8 system-ui;background:#fff;color:#263044}p{max-width:800px;padding:20px;border:1px solid #ddd}</style><p id="primary">${SOURCE}</p></html>`);
});
function checkFocus() {if (focusError || monitor?.error) throw focusError || monitor.error; assert(!browserPid || !monitor.events.some(event => event.pid === browserPid));}
async function read() {return control.evaluate(async () => {const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}); if (!r.success) throw Error(r.error); return typeof r.value === 'string' ? JSON.parse(r.value) : r.value;});}
async function until(test, label) {const deadline = Date.now() + 15000; while (Date.now() < deadline) {if (await test()) return; await new Promise(resolve => setTimeout(resolve, 75));} throw Error(`Timed out: ${label}`);}
async function saved(key, value) {await until(async () => JSON.stringify((await read())[key]) === JSON.stringify(value), `persist ${key}`);}
async function patch(values) {
  const current = await read(), replace = Object.hasOwn(values, 'token');
  const response = await control.evaluate(({values, current, replace}) => chrome.runtime.sendMessage({type: 'persistConfig', mode: replace ? 'replace' : 'patch',
    config: replace ? {...current, ...values} : values, expected: Object.fromEntries(Object.keys(values).map(key => [key, current[key]])),
    ...(replace ? {baseRevision: current.__fluentConfigRevision || 0} : {}), clientId: crypto.randomUUID(), sequence: 1}), {values, current, replace});
  assert.equal(response.success, true, response.error);
  for (const [key, value] of Object.entries(values)) if (key !== 'token') await saved(key, value);
}
async function open(url, surface) {const page = await newPageWithoutForeground(session.context); await diagnostics.attachPage(page, surface); await page.goto(url); await activateExtensionTabWithoutForeground(session.context, page); return page;}
async function shot(page, name) {checkFocus();const file = path.join(artifactsDir, `${name}.png`);await page.screenshot({path: file});result.screenshots.push(file);}
async function main() {
  try {
    stage('launch');
    result.buildFreshness = assertFreshProductionExtension(extensionDir, path.resolve(__dirname, '../..'));
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/article`;
    monitor = startFocusEventMonitor({onEvent: event => {if (browserPid && event.pid === browserPid) focusError = Error('Owned Edge became foreground');}, onError: error => {focusError = error;}}); await monitor.ready;
    launchStarted = true;
    session = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      headless: false, background: true, displayTarget: 'secondary', viewport: {width: 1280, height: 900},
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(result, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    assert.equal(result.windowPlacement.browserFrontmost, false);
    const cdp = await session.context.browser().newBrowserCDPSession();
    try {browserPid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(process => process.type === 'browser').id;} finally {await cdp.detach();}
    await diagnostics.start(session.context);
    const worker = session.context.serviceWorkers()[0] || await session.context.waitForEvent('serviceworker', {timeout: 30000});
    const extensionId = new URL(worker.url()).host, base = `chrome-extension://${extensionId}`;
    diagnostics.setExtensionId(extensionId); await diagnostics.flush();
    stage('configure-fixture');
    control = await open(`${base}/popup.html`, 'control-popup'); await control.locator('.popup-shell[data-config-ready="true"]').waitFor();
    const initial = await read();
    await patch({on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, theme: 'light', animations: false,
      service, from: 'auto', to: 'zh-Hans', display: 1, translationBeforeOriginal: false, style: 1, autoTranslate: false,
      useCache: false, alwaysTranslateDomains: [], disabledExtensionDomains: [], disableFloatingBall: true, selectionTranslatorMode: 'disabled',
      customOpenAIProviders: [{id: service, name: '本地测试服务', endpoint: fixtureUrl.replace('/article', '/v1/chat/completions'), models: ['reading-layout']}],
      token: {[service]: 'synthetic-local-fixture-not-a-secret'}, model: {...initial.model, [service]: 'reading-layout'},
      user_role: {...initial.user_role, [service]: 'SOURCE_BEGIN{{origin}}SOURCE_END'}, enableAIContext: false, enableAIMultiSegment: false, glossaryEnabled: false,
      videoTranslationEnabled: true, videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual'});
    const content = await open(fixtureUrl, 'page-content');
    stage('page-translation');
    await content.waitForSelector('#fluent-read-page-styles', {state: 'attached'});
    const tabId = await control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, fixtureUrl);
    await until(async () => {try {return (await control.evaluate(id => chrome.tabs.sendMessage(id, {type: 'getFullPageTranslationState'}), tabId)).status === 'success';} catch {return false;}}, 'content ready');
    await content.evaluate(() => {globalThis.__readingOriginal = document.querySelector('#primary').firstChild;});
    const translate = await control.evaluate(id => chrome.tabs.sendMessage(id, {type: 'contextMenuTranslate', action: 'fullPage'}), tabId);
    assert(translate);
    await content.waitForFunction(expected => document.querySelector('#primary .fluent-read-bilingual-content')?.textContent === expected, TRANSLATION);
    const requestCount = result.requests; assert(requestCount > 0);
    const options = await open(`${base}/options.html#settings-advanced`, 'options-settings');
    stage('page-order');
    const order = options.locator('[data-page-translation-order]'); await order.waitFor();
    for (const before of [true, false, true]) {
      await order.getByRole('radio').nth(before ? 1 : 0).click(); await saved('translationBeforeOriginal', before);
      await content.waitForFunction(before => {const p = document.querySelector('#primary'), t = p.querySelector('.fluent-read-bilingual-content'); return (before ? p.firstChild : p.lastChild) === t && p.contains(globalThis.__readingOriginal);}, before);
      assert.equal(result.requests, requestCount);
    }
    await shot(content, 'page-translation-first');
    await patch({display: 0}); await order.getByRole('radio').first().waitFor();
    await until(() => order.getByRole('radio').first().isDisabled(), 'single mode order disabled');
    await options.locator('.paragraph-order-note button').click(); await saved('display', 1);
    await content.waitForFunction(() => document.querySelector('#primary')?.firstChild?.classList?.contains('fluent-read-bilingual-content'));
    assert.equal(result.requests, requestCount);
    await control.evaluate(id => chrome.tabs.sendMessage(id, {type: 'contextMenuTranslate', action: 'restore'}), tabId);
    await content.waitForFunction(source => document.querySelector('#primary')?.textContent === source && document.querySelector('#primary')?.firstChild === globalThis.__readingOriginal, SOURCE);
    result.cases.push({name: 'page-order-switch-and-single-mode-recovery-preserve-original-and-provider-count', passed: true, requests: requestCount});
    stage('video-reading-settings');
    await options.goto(`${base}/options.html#settings-video`);
    const panel = options.locator('[data-video-subtitle-appearance]'); await panel.waitFor();
    const mode = panel.locator('[data-video-subtitle-display-mode]'), videoOrder = panel.locator('[data-video-subtitle-order]');
    await panel.locator('[data-video-subtitle-reading-annotation]').click();
    await until(async () => (await read()).videoSubtitleAppearance.readingAnnotation === true, 'reading enabled');
    await videoOrder.getByRole('radio').nth(1).click();
    await until(async () => (await read()).videoSubtitleAppearance.bilingualOrder === 'translation-first', 'video order');
    const readingPreview = panel.locator('[data-video-subtitle-reading-preview]'); await readingPreview.waitFor();
    const positions = await panel.locator('[data-video-subtitle-preview]').evaluate(node => [...node.querySelectorAll('span,small,b')].filter(el => el.getBoundingClientRect().height > 0).map(el => ({tag: el.localName, top: el.getBoundingClientRect().top})));
    assert(positions.find(p => p.tag === 'b').top < positions.find(p => p.tag === 'span').top);
    assert(positions.find(p => p.tag === 'span').top < positions.find(p => p.tag === 'small').top);
    await mode.getByRole('radio').nth(1).click(); await saved('videoSubtitleDisplayMode', 'translation-only');
    assert(await videoOrder.getByRole('radio').first().isDisabled()); assert.equal(await readingPreview.isVisible(), false);
    const recover = panel.locator('[data-video-subtitle-reading-show-original]'); await recover.focus(); await options.keyboard.press('Space');
    await saved('videoSubtitleDisplayMode', 'bilingual'); await readingPreview.waitFor();
    await options.waitForFunction(() => document.activeElement?.matches('[data-video-subtitle-display-mode] [aria-checked="true"]'));
    result.cases.push({name: 'reading-preview-follows-original-and-explicit-recovery-keeps-preference-and-keyboard-focus', passed: true});
    await shot(options, 'reading-settings-desktop');
    stage('settings-locales-and-narrow-layout');
    for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES']) {
      await patch({uiLanguage: language}); await options.waitForFunction(language => document.documentElement.lang === language, language);
      await options.setViewportSize({width: 390, height: 844});
      const metrics = await options.evaluate(() => ({width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        panels: [...document.querySelectorAll('[data-video-subtitle-appearance]')].filter(el => el.getClientRects().length).map(el => ({width: el.clientWidth, scrollWidth: el.scrollWidth}))}));
      assert(metrics.scrollWidth <= metrics.width + 1); assert(metrics.panels.every(p => p.scrollWidth <= p.width + 1));
      result.layouts.push({language, ...metrics});
    }
    await patch({uiLanguage: 'zh-CN', theme: 'dark'});
    await options.waitForFunction(() => document.documentElement.lang === 'zh-CN' && document.documentElement.classList.contains('dark'));
    await shot(options, 'reading-settings-narrow-dark');
    await videoOrder.getByRole('radio').first().click();
    stage('quick-close-and-reopen');
    await options.close();
    await until(async () => (await read()).videoSubtitleAppearance.bilingualOrder === 'original-first', 'quick-close order');
    const reopened = await open(`${base}/options.html#settings-video`, 'options-reopened');
    await reopened.locator('[data-video-subtitle-order] [aria-checked="true"]').waitFor();
    assert.equal(await reopened.locator('[data-video-subtitle-order] [aria-checked="true"]').getAttribute('data-option-index'), '0');
    assert.equal((await read()).videoSubtitleAppearance.readingAnnotation, true);
    result.cases.push({name: 'quick-close-reopen-keeps-video-order-and-reading', passed: true});
    checkFocus(); await diagnostics.flush(); diagnostics.assertClean(); result.ok = true;
  } catch (error) {primaryError = error; result.error = error.stack || String(error);}
  finally {
    await finalizeRun({diagnostics, result, artifactsDir, primaryError, cleanup: [
      {stage: 'browser-close', action: async () => {if (session) {await session.close();closed = true;} else if (!launchStarted) closed = true;}},
      {stage: 'monitor-stop', action: async () => {if (monitor) {await monitor.stop(); result.focusEvents = {browserActivations: monitor.events.filter(event => event.pid === browserPid).length};}}},
      {stage: 'server-close', action: () => new Promise(resolve => server.close(resolve))},
      {stage: 'profile-remove', action: async () => {if (closed) fs.rmSync(profileDir, {recursive: true, force: true});}},
    ], emitReport: () => {diagnostics.write(artifactsDir, result); console.log(JSON.stringify({ok: result.ok, error: result.error, cases: result.cases, runtimeCounts: result.runtimeDiagnostics?.counts, artifactsDir}, null, 2));}});
  }
  if (primaryError) throw primaryError;
}
main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
