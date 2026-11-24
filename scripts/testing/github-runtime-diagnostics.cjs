/**
 * @file scripts/testing/github-runtime-diagnostics.cjs
 * 文件职责：为指定公开 GitHub issue 的三条原生请求提供逐请求运行时归属证据。
 * 主要内容：在原 collector 的同一 CDP session 上预先开启2048帧采集，以真实 entry ID 与
 * Log.networkRequestId 绑定 GET/404/完成事件；只接受无扩展对照实测的版本化完整栈哈希。
 * 模块边界：不改原 collector、生产扩展、网页 DOM 或请求响应；旧200帧栈、未知端点和采集缺口仍失败。
 */
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const POLICY = Object.freeze({
  id: 'github-vue-issue-native-404-full-stack-v1',
  pageUrl: 'https://github.com/vuejs/core/issues/1932',
  captureSize: 2048,
  baselineSource: 'wave5/github-issue/native-network-baseline2048/report.json',
  baselineSha256: "440d88998b4bfb15ab5eaa651322a7a4dec59a5dde79301e0ecb79a3cc6890f3",
  requests: [
  {
    "requestUrl": "https://github.com/copilot/agent-sessions/vuejs/core/agents",
    "frames": 277,
    "stackSha256": "2100857691a8d3e17e1671fad9eb64635203a61112ddb5f63c15b8c01acfa0f5"
  },
  {
    "requestUrl": "https://github.com/vuejs/core/issues/1932/agent_tasks",
    "frames": 226,
    "stackSha256": "466e39d8ee39c63c67c52a69acaf4aeda309926492be1f20e06902ee8cec10de"
  },
  {
    "requestUrl": "https://github.com/_global-navigation/payloads.json?can_toggle_site_admin_and_employee_status=0&is_admin_mode_on=0&is_ui_opted_out=0&show_ui_opt_out=0&v=8",
    "frames": 6,
    "stackSha256": "95b2b6e1a329aef1c90aef87b6d57ed5cd7e828bdb21506bad417a39dda31a11"
  }
],
});

function canonicalStack(value) {
  if (Array.isArray(value)) return value.map(canonicalStack);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'scriptId')
    .map(([key, child]) => [key, canonicalStack(child)]));
}
const stackHash = stack => createHash('sha256').update(JSON.stringify(canonicalStack(stack))).digest('hex');

function explicitArguments(argv) {
  const flag = '--raw-runtime-diagnostics-helper';
  const positions = argv.flatMap((value, index) => value === flag ? [index] : []);
  if (positions.length !== 1 || !argv[positions[0] + 1] || argv[positions[0] + 1].startsWith('--')) {
    throw new Error(`GitHub diagnostics requires one explicit ${flag} path`);
  }
  return {rawHelperPath: path.resolve(argv[positions[0] + 1])};
}

function loadRawHelper(argv) {
  const options = explicitArguments(argv);
  if (options.rawHelperPath === __filename) throw new Error('GitHub diagnostics cannot wrap itself');
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
  const expected = POLICY.requests.find(policy => policy.requestUrl === entry.sourceUrl);
  if (!expected || entry.targetUrl !== POLICY.pageUrl ||
      entry.message !== 'Failed to load resource: the server responded with a status of 404 ()') return refuse('different-log-or-endpoint');
  if (!binding?.networkRequestId || binding.ambiguous || binding.entryIds?.length !== 1
    || binding.entryIds[0] !== entry.id) return refuse('missing-or-ambiguous-entry-binding');
  if (!request || request.ambiguous || request.logCount !== 1 || request.requestCount !== 1
    || request.responseCount !== 1 || request.finishCount !== 1) return refuse('missing-or-ambiguous-request');
  if (!request.targetId || request.targetId !== binding.targetId || request.sessionKey !== binding.sessionKey
    || request.requestId !== binding.networkRequestId || request.loaderId !== binding.loaderId
    || request.frameId !== binding.frameId || !request.loaderId || !request.frameId) return refuse('wrong-target-session-or-loader');
  if (request.captureConfigured !== true || binding.captureConfigured !== true ||
      request.captureSize !== POLICY.captureSize || binding.captureSize !== POLICY.captureSize) return refuse('stack-capture-not-configured-before-request');
  if (request.pageUrl !== POLICY.pageUrl || binding.pageUrl !== POLICY.pageUrl
    || request.documentURL !== POLICY.pageUrl || request.method !== 'GET' || request.url !== expected.requestUrl
    || request.hasPostData !== false || request.redirected !== false || request.failed
    || request.fromServiceWorker !== false || request.responseUrl !== expected.requestUrl
    || request.status !== 404 || request.type !== 'Fetch') return refuse('different-request-or-response');
  if (!extensionId || !/^[a-f0-9]{64}$/u.test(artifactHash || '')) return refuse('missing-extension-or-helper-binding');
  const stack = request.initiator?.stack;
  if (request.initiator?.type !== 'script' || !stack || stack.parent || stack.parentId ||
      !Array.isArray(stack.callFrames) || stack.callFrames.length >= POLICY.captureSize) return refuse('incomplete-or-parented-initiator');
  if (stack.callFrames.length !== expected.frames || stackHash(stack) !== expected.stackSha256) return refuse('different-versioned-initiator-stack');
  return {matched: true, policyId: POLICY.id, helperSha256: artifactHash,
    baselineSource: POLICY.baselineSource, baselineSha256: POLICY.baselineSha256,
    requestId: request.requestId, targetId: request.targetId, sessionKey: request.sessionKey,
    loaderId: request.loaderId, frameId: request.frameId, method: request.method,
    requestUrl: request.url, responseStatus: request.status, captureSize: request.captureSize,
    frames: stack.callFrames.length, stackSha256: expected.stackSha256, initiator: request.initiator};
}

function createGithubRuntimeDiagnostics({rawHelper,
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
  try {artifactHash = readArtifactHash(__filename);}
  catch (error) {failure('helper-artifact', error);}

  async function instrumentSession(context, page) {
    const session = await context.newCDPSession(page);
    const state = {session, sessionKey: `page-session-${++sequence}`, targetId: '', frame: null,
      requests: new Map(), listeners: [], active: true, captureConfigured: false, captureSize: null, captureCommands: []};
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
        hasPostData: !!event.request.hasPostData, initiator: event.initiator, captureConfigured: state.captureConfigured, captureSize: state.captureSize});
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
      await session.send('Runtime.enable'); state.captureCommands.push({method: 'Runtime.enable', accepted: true});
      await session.send('Runtime.setMaxCallStackSizeToCapture', {size: POLICY.captureSize});
      state.captureCommands.push({method: 'Runtime.setMaxCallStackSizeToCapture', size: POLICY.captureSize, accepted: true});
      state.captureConfigured = true; state.captureSize = POLICY.captureSize;
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
            loaderId: state.frame?.loaderId, pageUrl: page.url(), phase, captureConfigured: state.captureConfigured, captureSize: state.captureSize,
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
            'logCount', 'captureConfigured', 'captureSize', 'redirected', 'responseUrl', 'status', 'type', 'fromServiceWorker', 'ambiguous', 'failed', 'failure'];
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
        captures: states.map(state => ({targetId: state.targetId, sessionKey: state.sessionKey, configured: state.captureConfigured, size: state.captureSize, commands: state.captureCommands})),
        failures: failures.map(item => ({...item})),
        limitations: ['Only exact Log networkRequestId bindings from the same page CDP session can be classified.',
          'Only the exact public Vue issue and three version-pinned native request stacks are accepted; old200/cap/parent/unknown endpoints remain unclassified.']}};
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
      if (!report.passed) throw error || new Error(`GitHub request ownership diagnostics failed; ${report.blockerIds.length} blockers, ${failures.length} evidence failures`);
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

module.exports = {POLICY, canonicalStack, stackHash, explicitArguments, classifyRequest, createGithubRuntimeDiagnostics,
  createRuntimeDiagnostics() {return createGithubRuntimeDiagnostics(loadRawHelper(process.argv));},
  redact(value) {return loadRawHelper(process.argv).rawHelper.redact(value);},
};
