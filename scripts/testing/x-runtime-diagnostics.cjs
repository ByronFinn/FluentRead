/**
 * @file scripts/testing/x-runtime-diagnostics.cjs
 * 文件职责：给原运行时采集器补充 X 原生 guide 请求的逐请求归属证据，不改变生产扩展或原始采集结果。
 * 主要内容：在原采集器同一个 CDP session 上观察 Network，包装 Log 回调以绑定其实际新增 entry ID，
 * 仅对经过已审核透明 fetch 转发器的完整原生请求链派生 site 归属；未知请求保留脱敏关联事实，继续阻断。
 * 模块边界：不注入页面脚本、不修改请求/响应、不读取 headers/body，不编辑或复制外部原始采集器。
 */
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const POLICY = Object.freeze({
  id: 'x-native-guide-404-transparent-forwarder-v1',
  pageUrl: 'https://x.com/NASA/status/1571977394151383042',
  requestUrl: 'https://api.x.com/2/guide.json?count=5&display_location=web_sidebar',
  bridgePath: 'content-scripts/xVideoBridge.js',
  bridgeSha256: '1c06d41d6967e862989a938cda622a6bc72e8b07c0b3b6cc3fe6938b25f9009e',
  // 零起算位置与已保存的真实 CDP 栈一致；产物或宿主启动脚本变更时必须重新审阅。
  frames: [
    {functionName: 'W', bridge: true, lineNumber: 0, columnNumber: 2853},
    {functionName: '', url: 'https://abs.twimg.com/x-web/x-web/assets/startup-vendor-CViFHjoW.js', lineNumber: 4, columnNumber: 10860},
    {functionName: 't', url: 'https://abs.twimg.com/x-web/x-web/assets/startup-DfleHLPI.js', lineNumber: 0, columnNumber: 5578},
    {functionName: '', url: 'https://abs.twimg.com/x-web/x-web/assets/startup-DfleHLPI.js', lineNumber: 0, columnNumber: 6056},
  ],
});

function explicitArguments(argv) {
  const read = flag => {
    const positions = argv.flatMap((value, index) => value === flag ? [index] : []);
    if (positions.length !== 1 || !argv[positions[0] + 1] || argv[positions[0] + 1].startsWith('--')) {
      throw new Error(`X diagnostics requires one explicit ${flag} path`);
    }
    return path.resolve(argv[positions[0] + 1]);
  };
  return {rawHelperPath: read('--raw-runtime-diagnostics-helper'), extensionDir: read('--extension-dir')};
}

function loadRawHelper(argv) {
  const options = explicitArguments(argv);
  if (options.rawHelperPath === __filename) throw new Error('X diagnostics cannot wrap itself');
  const rawHelper = require(options.rawHelperPath);
  if (typeof rawHelper.createRuntimeDiagnostics !== 'function' || typeof rawHelper.redact !== 'function') {
    throw new Error('Raw diagnostics helper lacks createRuntimeDiagnostics/redact');
  }
  return {...options, rawHelper};
}

function classifyRequest({entry, binding, request, extensionId, artifactHash}) {
  const refuse = reason => ({matched: false, reason});
  if (entry.ownership !== 'unattributed' || entry.type !== 'browser-log' || entry.browserSource !== 'network'
    || entry.targetType !== 'page' || entry.level !== 'error' || entry.expectedCase) return refuse('not-an-unattributed-network-error');
  if (entry.contextOrigin || entry.contextName || entry.contextIsDefault === false || entry.stack?.length) return refuse('runtime-context-or-stack-present');
  if (entry.targetUrl !== POLICY.pageUrl || entry.sourceUrl !== POLICY.requestUrl
    || entry.message !== 'Failed to load resource: the server responded with a status of 404 ()') return refuse('different-log');
  if (!binding?.networkRequestId || binding.ambiguous || binding.entryIds?.length !== 1
    || binding.entryIds[0] !== entry.id) return refuse('missing-or-ambiguous-entry-binding');
  if (!request || request.ambiguous || request.logCount !== 1 || request.requestCount !== 1
    || request.responseCount !== 1 || request.finishCount !== 1) return refuse('missing-or-ambiguous-request');
  if (!request.targetId || request.targetId !== binding.targetId || request.sessionKey !== binding.sessionKey
    || request.requestId !== binding.networkRequestId || request.loaderId !== binding.loaderId
    || request.frameId !== binding.frameId || !request.loaderId || !request.frameId) return refuse('wrong-target-session-or-loader');
  if (request.pageUrl !== POLICY.pageUrl || binding.pageUrl !== POLICY.pageUrl
    || request.documentURL !== POLICY.pageUrl || request.method !== 'GET' || request.url !== POLICY.requestUrl
    || request.hasPostData || request.redirected || request.failed || request.fromServiceWorker
    || request.responseUrl !== POLICY.requestUrl || request.status !== 404 || request.type !== 'Fetch') return refuse('different-request-or-response');
  if (artifactHash !== POLICY.bridgeSha256 || !extensionId) return refuse('unreviewed-bridge-artifact');
  const stack = request.initiator?.stack;
  if (request.initiator?.type !== 'script' || stack?.parent || stack?.parentId
    || stack?.callFrames?.length !== POLICY.frames.length) return refuse('different-initiator');
  const expectedBridge = `chrome-extension://${extensionId}/${POLICY.bridgePath}`;
  if (!POLICY.frames.every((expected, index) => {
    const actual = stack.callFrames[index];
    return actual.url === (expected.bridge ? expectedBridge : expected.url)
      && actual.functionName === expected.functionName && actual.lineNumber === expected.lineNumber
      && actual.columnNumber === expected.columnNumber;
  })) return refuse('different-initiator-frame');
  return {matched: true, policyId: POLICY.id, requestId: request.requestId,
    targetId: request.targetId, sessionKey: request.sessionKey, loaderId: request.loaderId,
    frameId: request.frameId, bridgeSha256: artifactHash, method: request.method,
    requestUrl: request.url, responseStatus: request.status, initiator: request.initiator};
}

function createXRuntimeDiagnostics({rawHelper, extensionDir,
  readArtifactHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')}) {
  const base = rawHelper.createRuntimeDiagnostics();
  for (const method of ['start', 'attachPage', 'setExtensionId', 'setPhase', 'flush', 'snapshot', 'assertClean', 'stop']) {
    if (typeof base[method] !== 'function') throw new Error(`Raw diagnostics helper lacks ${method}`);
  }
  const redact = rawHelper.redact;
  const states = [];
  const bindings = new Map();
  const failures = [];
  let extensionId, sequence = 0, phase = 'bootstrap', artifactHash;
  let rawVerdict = {observed: false};
  let closing = false;
  const failure = (surface, error) => failures.push({surface, message: redact(error.message || error)});
  try {artifactHash = readArtifactHash(path.join(path.resolve(extensionDir), POLICY.bridgePath));}
  catch (error) {failure('bridge-artifact', error);}

  async function instrumentSession(context, page) {
    const session = await context.newCDPSession(page);
    const state = {session, sessionKey: `page-session-${++sequence}`, targetId: '', frame: null,
      requests: new Map(), listeners: [], active: true};
    states.push(state);
    const on = (method, listener) => {session.on(method, listener); state.listeners.push([method, listener]);};
    on('Page.frameNavigated', ({frame}) => {
      if (!frame.parentId) state.frame = {id: frame.id, loaderId: frame.loaderId, url: frame.url};
    });
    on('Network.requestWillBeSent', event => {
      if (closing || !state.active) return;
      if (state.requests.size >= 2000 && !state.requests.has(event.requestId)) {
        failure('network-capacity', 'Request ledger exceeded 2000 entries'); state.active = false; return;
      }
      const prior = state.requests.get(event.requestId);
      const request = prior || {requestId: event.requestId, requestCount: 0, responseCount: 0, finishCount: 0, logCount: 0};
      Object.assign(request, {requestCount: request.requestCount + 1, redirected: !!event.redirectResponse || !!prior,
        targetId: state.targetId, sessionKey: state.sessionKey, frameId: event.frameId, loaderId: event.loaderId,
        pageUrl: page.url(), documentURL: event.documentURL, method: event.request.method, url: event.request.url,
        hasPostData: !!event.request.hasPostData, initiator: event.initiator});
      state.requests.set(event.requestId, request);
    });
    on('Network.responseReceived', event => {
      const request = state.requests.get(event.requestId);
      if (request) Object.assign(request, {responseCount: request.responseCount + 1, responseUrl: event.response.url,
        status: event.response.status, type: event.type, fromServiceWorker: !!event.response.fromServiceWorker,
        ambiguous: request.ambiguous || event.loaderId !== request.loaderId || event.frameId !== request.frameId});
    });
    on('Network.loadingFinished', ({requestId}) => {
      const request = state.requests.get(requestId);
      if (request) request.finishCount += 1;
    });
    on('Network.loadingFailed', ({requestId, errorText, canceled, blockedReason, corsErrorStatus, type}) => {
      const request = state.requests.get(requestId);
      if (request) Object.assign(request, {failed: true,
        failure: {errorText, canceled, blockedReason, corsErrorStatus, type}});
    });
    try {
      await session.send('Network.enable');
      await session.send('Page.enable');
      const {targetInfo} = await session.send('Target.getTargetInfo');
      if (!targetInfo?.targetId || targetInfo.type !== 'page') throw new Error('Page target identity unavailable');
      state.targetId = targetInfo.targetId;
      const {frameTree} = await session.send('Page.getFrameTree');
      if (!frameTree?.frame?.id || !frameTree.frame.loaderId) throw new Error('Top-frame loader identity unavailable');
      const {id, loaderId, url} = frameTree.frame;
      state.frame = {id, loaderId, url};
    } catch (error) {state.active = false; failure(state.sessionKey, error);}

    // 原 Log 回调仍以原 receiver/参数完整调用。用调用前后的真实 entry ID 差集绑定，不按 URL/时间猜测。
    return new Proxy(session, {get(target, property) {
      if (property !== 'on') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (method, callback) => {
        if (method !== 'Log.entryAdded') {target.on(method, callback); return target;}
        target.on(method, function linkedOriginalCallback(params) {
          let before;
          try {before = new Set(base.snapshot().entries.map(entry => entry.id));}
          catch (error) {failure('entry-binding-before', error);}
          const result = Reflect.apply(callback, this, [params]);
          let added;
          try {added = before && base.snapshot().entries.filter(entry => !before.has(entry.id));}
          catch (error) {failure('entry-binding-after', error);}
          if (!added) return result;
          if (closing || !state.active || !added.length) return result;
          const log = params.entry;
          const request = log.networkRequestId && state.requests.get(log.networkRequestId);
          if (request) request.logCount += 1;
          const binding = {networkRequestId: log.networkRequestId || null, entryIds: added.map(entry => entry.id),
            targetId: state.targetId, sessionKey: state.sessionKey, frameId: state.frame?.id,
            loaderId: state.frame?.loaderId, pageUrl: page.url(), phase,
            ambiguous: added.length !== 1 || !!result?.then};
          for (const entry of added) {
            if (bindings.has(entry.id)) binding.ambiguous = true;
            bindings.set(entry.id, {binding, request});
          }
          return result;
        });
        return target;
      };
    }});
  }

  function snapshot() {
    const raw = base.snapshot();
    const duplicateIds = new Set(raw.entries.filter((entry, index, entries) => entries.findIndex(other => other.id === entry.id) !== index).map(entry => entry.id));
    const adjustments = [];
    const unclassifiedEntries = [];
    const redactObservation = value => typeof value === 'string' ? redact(value)
      : Array.isArray(value) ? value.map(redactObservation)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObservation(item)])) : value;
    const entries = raw.entries.map(entry => {
      const linked = bindings.get(entry.id);
      const evidence = classifyRequest({entry, binding: linked?.binding, request: linked?.request, extensionId, artifactHash});
      if (!evidence.matched || duplicateIds.has(entry.id)) {
        if (entry.ownership === 'unattributed' && entry.type === 'browser-log' && entry.browserSource === 'network') {
          const keys = ['requestId', 'targetId', 'sessionKey', 'frameId', 'loaderId', 'pageUrl', 'documentURL',
            'method', 'url', 'hasPostData', 'initiator', 'requestCount', 'responseCount', 'finishCount',
            'logCount', 'redirected', 'responseUrl', 'status', 'type', 'fromServiceWorker', 'ambiguous', 'failed', 'failure'];
          unclassifiedEntries.push({entryId: entry.id,
            reason: duplicateIds.has(entry.id) ? 'duplicate-entry-id' : evidence.reason,
            binding: linked ? redactObservation(linked.binding) : null,
            request: linked?.request ? redactObservation(Object.fromEntries(keys
              .filter(key => linked.request[key] !== undefined).map(key => [key, linked.request[key]]))) : null});
        }
        return {...entry};
      }
      adjustments.push({entryId: entry.id, rawOwnership: entry.ownership, ownership: 'site', evidence});
      return {...entry, rawOwnership: entry.ownership, ownership: 'site', ownershipEvidence: evidence};
    });
    const remaining = raw.blockerIds.filter(id => !adjustments.some(adjustment => adjustment.entryId === id));
    const counts = {...raw.counts, errors: entries.filter(entry => remaining.includes(entry.id) && entry.level === 'error').length,
      warnings: entries.filter(entry => remaining.includes(entry.id) && entry.level === 'warning').length,
      site: entries.filter(entry => entry.ownership === 'site').length};
    const rawConsistent = raw.passed === (raw.blockerIds.length === 0 && raw.coverage.failures.length === 0 && raw.workerObserved === true);
    return {...raw, entries, counts, blockerIds: remaining,
      passed: rawConsistent && remaining.length === 0 && raw.coverage.failures.length === 0 && raw.workerObserved === true && failures.length === 0,
      rawDiagnostics: raw, rawVerdict, requestOwnership: {policyId: POLICY.id, artifactHash,
        rawSnapshotConsistent: rawConsistent, adjustments, unclassifiedEntries,
        failures: failures.map(item => ({...item})),
        limitations: ['Only exact Log networkRequestId bindings from the same page CDP session can be classified.',
          'Missing/changed native startup stacks, unknown bridge builds, OOPIFs and pre-attachment requests remain unclassified.']}};
  }

  return {
    start(context) {
      const decoratedContext = new Proxy(context, {get(target, property) {
        if (property === 'newCDPSession') return page => instrumentSession(target, page);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      return base.start(decoratedContext);
    },
    attachPage: (...args) => base.attachPage(...args),
    setExtensionId(value) {extensionId = value; return base.setExtensionId(value);},
    setPhase(value) {phase = String(value); return base.setPhase(value);},
    flush: () => base.flush(),
    snapshot,
    assertClean() {
      const raw = base.snapshot();
      let error;
      try {base.assertClean();} catch (caught) {error = caught;}
      rawVerdict = {observed: true, passed: !error, ...(error ? {message: redact(error.message || error)} : {})};
      // 原 helper 的已知所有门禁必须能由原 snapshot 完整解释；任何额外或不一致的判定继续失败。
      const expectedError = `运行时诊断未通过：${raw.counts.errors} 个错误、${raw.counts.warnings} 个告警、${raw.coverage.failures.length} 个采集失败，后台采集${raw.workerObserved ? '已连接' : '未连接'}；见 runtime-diagnostics.json`;
      if (!!error === !!raw.passed || (error && error.message !== expectedError)) {
        failure('raw-verdict', error || 'Raw verdict disagrees with its snapshot');
      }
      const report = snapshot();
      if (!report.passed) throw error || new Error(`X request ownership diagnostics failed; ${report.blockerIds.length} blockers, ${failures.length} evidence failures`);
    },
    async stop() {
      closing = true;
      let firstError;
      for (const state of states) for (const [method, listener] of state.listeners) {
        try {state.session.off(method, listener);}
        catch (error) {firstError ||= error; failure('listener-cleanup', error);}
      }
      try {await base.stop();}
      catch (error) {firstError ||= error; failure('raw-stop', error);}
      if (firstError) throw firstError;
    },
  };
}

module.exports = {POLICY, explicitArguments, classifyRequest, createXRuntimeDiagnostics,
  createRuntimeDiagnostics() {return createXRuntimeDiagnostics(loadRawHelper(process.argv));},
  redact(value) {return loadRawHelper(process.argv).rawHelper.redact(value);},
};
