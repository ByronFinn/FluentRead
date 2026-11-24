import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';

// Every child and signal source is fake; these tests do not launch browsers or Node children.
const require = createRequire(import.meta.url);
type Job = {name: string; mode: string; tier: string};
type Result = {
  ok: boolean;
  timedOut: boolean;
  aborted?: boolean;
  notStarted?: boolean;
  error?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  attempts?: Result[];
};
type Child = EventEmitter & {pid: number};
const {
  MAX_CONCURRENT_JOBS,
  runChildWithWatchdog,
  runJobAttempts,
  runJobsWithBoundedConcurrency,
} = require('../scripts/run-site-translation-matrix.cjs') as {
  MAX_CONCURRENT_JOBS: number;
  runChildWithWatchdog: (command: string, values: string[], options: {
    timeoutMs: number;
    signal?: AbortSignal;
    spawnImpl: () => Child;
    killProcessGroupImpl: (child: Child, signal: string) => boolean;
  }) => Promise<Result>;
  runJobAttempts: (
    runAttempt: (attempt: number) => Promise<Result>, maxAttempts: number, options?: {signal?: AbortSignal},
  ) => Promise<Result>;
  runJobsWithBoundedConcurrency: (
    jobs: Job[], runJob: (job: Job, signal: AbortSignal) => Promise<Result>, options: {signalSource: EventEmitter},
  ) => Promise<{results: Array<Job & Result>; aborted: boolean; abortSignal: string | null}>;
};

const jobs = Array.from({length: 4}, (_, index) => ({name: `required-${index}`, mode: 'hover', tier: 'required'}));

function fakeMatrix(input = jobs) {
  const signalSource = new EventEmitter();
  const children: Array<{child: Child; name: string; attempt: number}> = [];
  const signals: Array<{pid: number; signal: string}> = [];
  let active = 0;
  let peak = 0;
  const pending = runJobsWithBoundedConcurrency(input, (job, signal) => runJobAttempts((attempt) =>
    runChildWithWatchdog('fake-runner', [], {
      timeoutMs: 60_000,
      signal,
      spawnImpl: () => {
        const child = Object.assign(new EventEmitter(), {pid: 10_000 + children.length});
        children.push({child, name: job.name, attempt});
        active += 1;
        peak = Math.max(peak, active);
        child.once('close', () => { active -= 1; });
        return child;
      },
      killProcessGroupImpl: (child, sent) => {
        signals.push({pid: child.pid, signal: sent});
        return true;
      },
    }), job.tier === 'required' ? 2 : 1, {signal}), {signalSource});
  const close = (index: number, code = 0, signal: string | null = null) => {
    children[index].child.emit('exit', code, signal);
    children[index].child.emit('close', code, signal);
  };
  return {pending, signalSource, children, signals, close, active: () => active, peak: () => peak};
}

describe('bounded real-site matrix scheduling', () => {
  it('runs at most two owned fake children, preserves job order and continues required jobs after FAIL', async () => {
    vi.useFakeTimers();
    try {
      expect(MAX_CONCURRENT_JOBS).toBe(2);
      const matrix = fakeMatrix();
      expect(matrix.children.map(({name}) => name)).toEqual(['required-0', 'required-1']);
      matrix.close(1); // Complete later job first, then dispatch required-2.
      await vi.advanceTimersByTimeAsync(0);
      expect(matrix.children[2].name).toBe('required-2');
      matrix.close(0, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(matrix.children[3]).toMatchObject({name: 'required-0', attempt: 2});
      matrix.close(3, 1); // FAIL must not cancel required-3.
      await vi.advanceTimersByTimeAsync(0);
      expect(matrix.children[4].name).toBe('required-3');
      matrix.close(4);
      matrix.close(2);
      const result = await matrix.pending;
      expect(matrix.peak()).toBe(2);
      expect(matrix.active()).toBe(0);
      expect(result).toMatchObject({aborted: false, abortSignal: null});
      expect(result.results.map(({name}) => name)).toEqual(jobs.map(({name}) => name));
      expect(result.results.map(({ok}) => ok)).toEqual([false, true, true, true]);
      expect(result.results[0].attempts?.map(({exitCode}) => exitCode)).toEqual([1, 1]);
      expect(matrix.signals).toEqual([]);
      expect(matrix.signalSource.listenerCount('SIGINT')).toBe(0);
      expect(matrix.signalSource.listenerCount('SIGTERM')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['SIGINT', 'SIGTERM'])('stops dispatch on %s, retains the tail and joins both owned children after KILL', async (signal) => {
    vi.useFakeTimers();
    try {
      const matrix = fakeMatrix();
      let joined = false;
      void matrix.pending.then(() => { joined = true; });
      matrix.signalSource.emit(signal);
      matrix.signalSource.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
      expect(matrix.children).toHaveLength(2);
      expect(matrix.signals).toEqual([
        {pid: 10_000, signal: 'SIGTERM'}, {pid: 10_001, signal: 'SIGTERM'},
      ]);
      matrix.close(0, 0, 'SIGTERM'); // Even a zero exit after abort cannot pass.
      await vi.advanceTimersByTimeAsync(4999);
      expect(joined).toBe(false);
      expect(matrix.signals).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(matrix.signals).toEqual([
        {pid: 10_000, signal: 'SIGTERM'}, {pid: 10_001, signal: 'SIGTERM'},
        {pid: 10_000, signal: 'SIGKILL'}, {pid: 10_001, signal: 'SIGKILL'},
      ]);
      await vi.advanceTimersByTimeAsync(60_000); // KILL alone cannot synthesize close.
      expect(joined).toBe(false);
      expect(matrix.children).toHaveLength(2);
      matrix.close(1, 0, 'SIGKILL');
      const result = await matrix.pending;
      expect(result).toMatchObject({aborted: true, abortSignal: signal});
      expect(result.results.map(({name}) => name)).toEqual(jobs.map(({name}) => name));
      expect(result.results.every(({ok}) => !ok)).toBe(true);
      expect(result.results.slice(0, 2)).toMatchObject([
        {aborted: true, attempts: [{signal: 'SIGTERM'}]},
        {aborted: true, attempts: [{signal: 'SIGKILL'}]},
      ]);
      expect(result.results.slice(2)).toMatchObject([
        {notStarted: true, aborted: true, attempts: []},
        {notStarted: true, aborted: true, attempts: []},
      ]);
      expect(matrix.signalSource.listenerCount('SIGINT')).toBe(0);
      expect(matrix.signalSource.listenerCount('SIGTERM')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an owned child error until its real close and saves every required retry outcome', async () => {
    vi.useFakeTimers();
    try {
      const matrix = fakeMatrix([jobs[0]]);
      let joined = false;
      void matrix.pending.then(() => { joined = true; });
      matrix.children[0].child.emit('error', new Error('owned child error'));
      await vi.advanceTimersByTimeAsync(0);
      expect(joined).toBe(false);
      expect(matrix.children).toHaveLength(1);
      matrix.close(0, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(matrix.children).toHaveLength(2);
      matrix.close(1);
      const result = await matrix.pending;
      expect(result.results[0]).toMatchObject({ok: true, attempts: [
        {ok: false, exitCode: 1, error: 'owned child error'}, {ok: true, exitCode: 0},
      ]});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves thrown spawn errors and rejected attempts instead of dropping required jobs', async () => {
    const result = await runJobAttempts((attempt) => {
      if (attempt === 1) return runChildWithWatchdog('fake', [], {
        timeoutMs: 100,
        spawnImpl: () => { throw new Error('spawn denied'); },
        killProcessGroupImpl: () => { throw new Error('must never signal an unspawned child'); },
      });
      return Promise.reject('attempt rejected');
    }, 2);
    expect(result).toMatchObject({ok: false, error: 'attempt rejected', attempts: [
      {ok: false, error: 'spawn denied'}, {ok: false, error: 'attempt rejected'},
    ]});

    const signalSource = new EventEmitter();
    const runJob = vi.fn((job: Job) => {
      if (job.name === jobs[0].name) throw new Error('job threw');
      if (job.name === jobs[1].name) return Promise.reject('job rejected');
      return Promise.resolve({ok: true, timedOut: false});
    });
    const scheduled = await runJobsWithBoundedConcurrency(jobs, runJob, {signalSource});
    expect(runJob.mock.calls.map(([job]) => job.name)).toEqual(jobs.map(({name}) => name));
    expect(scheduled.results).toMatchObject([
      {ok: false, error: 'job threw'}, {ok: false, error: 'job rejected'}, {ok: true}, {ok: true},
    ]);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });

  it('keeps the original timeout and no-retry policy while waiting for real close after KILL', async () => {
    vi.useFakeTimers();
    try {
      const matrix = fakeMatrix([jobs[0]]);
      let joined = false;
      void matrix.pending.then(() => { joined = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(matrix.signals).toEqual([{pid: 10_000, signal: 'SIGTERM'}]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(matrix.signals).toEqual([
        {pid: 10_000, signal: 'SIGTERM'}, {pid: 10_000, signal: 'SIGKILL'},
      ]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(joined).toBe(false);
      matrix.close(0, 0, 'SIGKILL');
      const result = await matrix.pending;
      expect(result.results[0]).toMatchObject({ok: false, timedOut: true, exitCode: 0, attempts: [{timedOut: true}]});
      expect(matrix.children).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not signal a completed sibling or an exited child that is still waiting for close', async () => {
    vi.useFakeTimers();
    try {
      const matrix = fakeMatrix(jobs.slice(0, 2));
      matrix.close(0);
      await vi.advanceTimersByTimeAsync(0);
      matrix.children[1].child.emit('exit', 0, null);
      matrix.signalSource.emit('SIGTERM');
      expect(matrix.signals).toEqual([]);
      let joined = false;
      void matrix.pending.then(() => { joined = true; });
      await vi.advanceTimersByTimeAsync(70_000);
      expect(joined).toBe(false);
      matrix.children[1].child.emit('close', 0, null);
      const result = await matrix.pending;
      expect(result.aborted).toBe(true);
      expect(result.results).toMatchObject([{ok: true}, {ok: false, aborted: true}]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles abort during spawn without losing the owned child or starting another job', async () => {
    vi.useFakeTimers();
    try {
      const signalSource = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {pid: 12345});
      const sent: string[] = [];
      const runJob = vi.fn((_job: Job, signal: AbortSignal) => runChildWithWatchdog('fake', [], {
        timeoutMs: 100,
        signal,
        spawnImpl: () => {
          signalSource.emit('SIGINT');
          return child;
        },
        killProcessGroupImpl: (_target, signal) => { sent.push(signal); return true; },
      }));
      const pending = runJobsWithBoundedConcurrency(jobs, runJob, {signalSource});
      expect(runJob).toHaveBeenCalledTimes(1);
      expect(sent).toEqual(['SIGTERM']);
      child.emit('close', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      expect(result).toMatchObject({aborted: true, abortSignal: 'SIGINT'});
      expect(sent).toEqual(['SIGTERM', 'SIGKILL']);
      expect(result.results.slice(1).every(({notStarted}) => notStarted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spawn after cancellation and does not retry when abort lands between attempts', async () => {
    const controller = new AbortController();
    controller.abort('SIGTERM');
    const spawnImpl = vi.fn(() => Object.assign(new EventEmitter(), {pid: 54321}));
    expect(await runChildWithWatchdog('fake', [], {
      timeoutMs: 100, signal: controller.signal, spawnImpl, killProcessGroupImpl: vi.fn(() => true),
    })).toMatchObject({ok: false, aborted: true, notStarted: true});
    expect(spawnImpl).not.toHaveBeenCalled();

    const between = new AbortController();
    const runAttempt = vi.fn(async () => {
      between.abort('SIGTERM');
      return {ok: false, timedOut: false, error: 'first failure before abort'};
    });
    expect(await runJobAttempts(runAttempt, 2, {signal: between.signal})).toMatchObject({
      ok: false, attempts: [{error: 'first failure before abort'}],
    });
    expect(runAttempt).toHaveBeenCalledTimes(1);
  });
});

describe('maintained compatibility profile', () => {
  const {parseArgs, selectedEntries, childArgs} = require('../scripts/run-site-translation-matrix.cjs');
  const {parseArgs: parseCase} = require('../scripts/run-site-translation-test.cjs');
  const cases = require('./browser-translation-cases.json');
  const profile = require('../scripts/site-translation/maintenance-cases.json');
  const args = ['--extension-dir', '/temporary/production', '--playwright-root', '/runtime',
    '--focus-safe-helper', '/helper', '--runtime-diagnostics-helper', '/diagnostics', '--allow-network', '--mode', 'full'];

  it('selects ten independent real required hosts and all requested content categories', () => {
    const parsed = parseArgs([...args, '--profile', 'maintenance']);
    const entries = selectedEntries(parsed, Object.entries(cases)) as Array<[string, {url: string; tier: string}]>;
    expect(entries).toHaveLength(10);
    expect(new Set(entries.map(([, value]) => new URL(value.url).hostname)).size).toBe(10);
    expect(entries.every(([, value]) => value.tier === 'required')).toBe(true);
    expect(profile.cases.map((entry: {category: string}) => entry.category))
      .toEqual(expect.arrayContaining(['news', 'long-article', 'github', 'discussion', 'dynamic-documentation']));
    expect(() => selectedEntries({...parsed, cases: ['example-com']}, Object.entries(cases))).toThrow('cannot be combined');
    expect(() => selectedEntries({...parsed, profile: 'unknown'}, Object.entries(cases))).toThrow('Unknown profile');
  });

  it('forwards explicit controlled-provider and lifecycle scope to each child without changing default live-provider mode', () => {
    const parsed = parseArgs([...args, '--controlled-provider', '--stability-probes']);
    const child = childArgs(parsed, 'index-luke-preface', 'full');
    expect(child).toEqual(expect.arrayContaining(['--controlled-provider', '--stability-probes']));
    expect(child).toEqual(expect.arrayContaining(['--runtime-diagnostics-helper', '/diagnostics']));
    expect(parseCase(child.slice(1))).toMatchObject({controlledProvider: true, stabilityProbes: true, service: 'microsoft'});
    expect(parseCase(childArgs(parseArgs(args), 'index-luke-preface', 'full').slice(1)).service).toBe('freeTranslation');
    expect(() => parseArgs([...args, '--mode', 'both', '--stability-probes'])).toThrow('requires --mode full');
    expect(() => parseCase([...child.slice(1), '--mode', 'hover'])).toThrow('requires --mode full');
  });

  it('requires runtime diagnostics for execution while keeping case listing available without a browser', () => {
    const missing = args.filter(value => !['--runtime-diagnostics-helper', '/diagnostics'].includes(value));
    expect(() => parseArgs(missing)).toThrow('--runtime-diagnostics-helper');
    expect(() => parseCase([...missing, '--case', 'example-com'])).toThrow('--runtime-diagnostics-helper');
    expect(parseArgs(['--list'])).toMatchObject({list: true});
  });
});

describe('site runtime diagnostics verdict and evidence', () => {
  const {loadRuntimeDiagnostics, finishRuntimeDiagnostics, unloadRuntimePage} = require('../scripts/run-site-translation-test.cjs');

  it('unloads the owned document with a bounded navigation while runtime collection is still active', async () => {
    const phases: string[] = [];
    const diagnostics = {setPhase: vi.fn((phase: string) => phases.push(phase))};
    const page = {isClosed: () => false, goto: vi.fn(async () => {expect(phases).toEqual(['case/full/unload']);})};
    expect(await unloadRuntimePage(page, diagnostics, 'case/full/unload')).toMatchObject({status: 'observed'});
    expect(page.goto).toHaveBeenCalledWith('about:blank', {waitUntil: 'domcontentloaded', timeout: 3000});
    expect(await unloadRuntimePage(null, diagnostics, 'unload')).toMatchObject({status: 'unavailable'});
  });

  it('rejects a helper missing required capture interfaces instead of running a browser without diagnostics', () => {
    expect(() => loadRuntimeDiagnostics('/helper', () => ({}))).toThrow('createRuntimeDiagnostics/redact');
    expect(() => loadRuntimeDiagnostics('/helper', () => ({redact: String, createRuntimeDiagnostics: () => ({start() {}})})))
      .toThrow('attachPage');
  });

  it('fails completed DOM work on runtime warnings and still retains capture gaps and stops the collector', async () => {
    const warning = Error('one extension warning');
    const snapshot = {passed: false, completeCoverage: false, coverage: {limitations: ['worker startup gap']}, counts: {errors: 0, warnings: 1}};
    const diagnostics = {flush: vi.fn(), assertClean: vi.fn(() => {throw warning;}), snapshot: vi.fn(() => snapshot), stop: vi.fn()};
    const output: Record<string, unknown> = {ok: true};
    expect(await finishRuntimeDiagnostics(diagnostics, output, null)).toEqual([{stage: 'runtime-verdict', error: warning}]);
    expect(output).toEqual({ok: false, runtimeDiagnostics: snapshot});
    expect(diagnostics.stop).toHaveBeenCalledOnce();
  });

  it('keeps the original functional failure and continues snapshot/stop when flush and verdict fail', async () => {
    const flushError = Error('collector disconnected'), verdictError = Error('worker not observed');
    const diagnostics = {flush: vi.fn(() => {throw flushError;}), assertClean: vi.fn(() => {throw verdictError;}), snapshot: vi.fn(() => ({passed: false})), stop: vi.fn()};
    const output = {ok: false, error: 'original missing paragraph'};
    expect(await finishRuntimeDiagnostics(diagnostics, output, null)).toEqual([
      {stage: 'runtime-flush', error: flushError}, {stage: 'runtime-verdict', error: verdictError},
    ]);
    expect(output.error).toBe('original missing paragraph');
    expect(diagnostics.snapshot).toHaveBeenCalledOnce();
    expect(diagnostics.stop).toHaveBeenCalledOnce();
  });

  it('writes failed runtime evidence before stopping and preserves unknown ownership for investigation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fluentread-runtime-evidence-test-'));
    const snapshot = {passed: false, completeCoverage: false, entries: [{ownership: 'unattributed', message: 'unknown warning'}]};
    const diagnostics = {flush: vi.fn(), assertClean: vi.fn(() => {throw Error('unknown warning');}), snapshot: vi.fn(() => snapshot),
      stop: vi.fn(() => {expect(JSON.parse(readFileSync(join(directory, 'runtime-diagnostics.json'), 'utf8'))).toEqual(snapshot);})};
    try {
      const output = {ok: true};
      const failures = await finishRuntimeDiagnostics(diagnostics, output, directory);
      expect(output.ok).toBe(false);
      expect(failures.map((failure: {stage: string}) => failure.stage)).toEqual(['runtime-verdict']);
      expect(diagnostics.stop).toHaveBeenCalledOnce();
    } finally {rmSync(directory, {recursive: true, force: true});}
  });

  it('does not accept a silent helper verdict when its snapshot has no passing evidence', async () => {
    const diagnostics = {flush() {}, assertClean() {}, snapshot: () => ({passed: false}), stop: vi.fn()};
    const output = {ok: true};
    expect((await finishRuntimeDiagnostics(diagnostics, output, null)).map((failure: {stage: string}) => failure.stage))
      .toEqual(['runtime-snapshot']);
    expect(output.ok).toBe(false);
    expect(diagnostics.stop).toHaveBeenCalledOnce();
  });
});

describe('bounded initial corpus on infinite feeds', () => {
  const {completeFullPageScope, withMandatoryHeadingCoverage} = require('../scripts/run-site-translation-test.cjs');
  const {normalizeCaseConfig, collectBaseCaseConfigErrors, CASES} = require('../scripts/site-translation/case-config.cjs');
  const makeActions = () => ({scrollAndWaitFullPage: vi.fn(), settleCoverageByReveal: vi.fn(),
    revealFullPageTarget: vi.fn(), waitForTranslationIdle: vi.fn(), observeCoverage: vi.fn()});
  const context = {page: {}, timeout: 1000, selector: 'h3', scrollContainer: undefined,
    verifyUnchanged: vi.fn(), waitForTarget: vi.fn()};

  it('retains finite-page bottom traversal by default and exposes every frozen initial owner for a feed', async () => {
    const finite = makeActions();
    await completeFullPageScope(context, finite);
    expect(finite.scrollAndWaitFullPage).toHaveBeenCalledOnce();
    expect(finite.settleCoverageByReveal).not.toHaveBeenCalled();
    const bounded = makeActions();
    await completeFullPageScope({...context, fullPageScope: 'initial-corpus'}, bounded);
    expect(bounded.scrollAndWaitFullPage).not.toHaveBeenCalled();
    expect(bounded.settleCoverageByReveal).toHaveBeenCalledWith(context.page, 1000, '本轮已载入正文覆盖收敛', 0, context.verifyUnchanged);
    expect(bounded.revealFullPageTarget).toHaveBeenCalledWith(context.page, 'h3');
    expect(bounded.waitForTranslationIdle).toHaveBeenCalledWith(context.page, 1000, '本轮已载入正文回到目标后', 0);
    expect(bounded.observeCoverage).toHaveBeenCalledOnce();
  });

  it('propagates a missing initial owner failure instead of calling incomplete feed coverage a pass', async () => {
    const actions = makeActions();
    actions.settleCoverageByReveal.mockRejectedValue(Error('initial owner missing-wrapper'));
    await expect(completeFullPageScope({...context, fullPageScope: 'initial-corpus'}, actions)).rejects.toThrow('missing-wrapper');
    expect(actions.revealFullPageTarget).not.toHaveBeenCalled();
    expect(actions.observeCoverage).not.toHaveBeenCalled();
  });

  it('rejects unsupported scopes and unbounded dynamic collection in initial-corpus cases', () => {
    const example = structuredClone(CASES['example-com']);
    expect(normalizeCaseConfig('finite', example).fullPageScope).toBe('finite-page');
    example.fullPageScope = 'initial-corpus';
    expect(collectBaseCaseConfigErrors('bounded', example)).toEqual([]);
    example.coverageRules[0].trackDynamic = true;
    expect(collectBaseCaseConfigErrors('bounded', example).join(' ')).toContain('不得启用 trackDynamic');
    example.fullPageScope = 'skip-everything';
    expect(collectBaseCaseConfigErrors('invalid', example).join(' ')).toContain('finite-page 或 initial-corpus');
    expect(withMandatoryHeadingCoverage([], false, 'initial-corpus')).toEqual([
      expect.objectContaining({selector: 'h1', name: 'mandatory-visible-latin-h1', trackDynamic: false}),
    ]);
    expect(withMandatoryHeadingCoverage([])[0].trackDynamic).toBe(true);
  });
});

describe('focus guard is a matrix stop condition', () => {
  it('does not retry a focus violation as a flaky site failure', async () => {
    const attempt=vi.fn(async () => ({ok:false,timedOut:false,exitCode:86}));
    const result=await runJobAttempts(attempt,2);
    expect(attempt).toHaveBeenCalledOnce();expect(result.attempts).toHaveLength(1);
  });
  it('stops dispatch and signals an already running sibling after the owned browser becomes foreground', async () => {
    const source=new EventEmitter();const started:string[]=[];let siblingAborted=false;
    const result=await runJobsWithBoundedConcurrency(jobs,async (job,signal)=>{
      started.push(job.name);
      if(job.name==='required-0')return {ok:false,timedOut:false,exitCode:86};
      signal.addEventListener('abort',()=>{siblingAborted=true;},{once:true});
      await Promise.resolve();await Promise.resolve();
      return {ok:!signal.aborted,timedOut:false,aborted:signal.aborted};
    },{signalSource:source});
    expect(started).toEqual(['required-0','required-1']);expect(siblingAborted).toBe(true);
    expect(result).toMatchObject({aborted:true,abortSignal:'FOCUS_SAFETY_VIOLATION'});
    expect(result.results.slice(2).every(item=>item.notStarted&&item.aborted)).toBe(true);
    expect(source.listenerCount('SIGINT')).toBe(0);expect(source.listenerCount('SIGTERM')).toBe(0);
  });
});

it('only propagates a public focus code through own causal errors into the fatal exit status', () => {
  const {siteTestExitCode}=require('../scripts/testing/site-error-diagnostics.cjs');
  const focused=Object.assign(new Error('Owned browser is foreground'),{code:'FOCUS_SAFETY_VIOLATION'});
  expect(siteTestExitCode(focused)).toBe(86);
  expect(siteTestExitCode(new AggregateError([new Error('cleanup'),new Error('wrapper',{cause:focused})]))).toBe(86);
  const getter=vi.fn(()=>focused);const accessor=Object.defineProperty({},'cause',{get:getter});
  for(const error of [new Error('FOCUS_SAFETY_VIOLATION'),{code:'UNKNOWN'},Object.create(focused),accessor])expect(siteTestExitCode(error)).toBe(1);
  expect(getter).not.toHaveBeenCalled();
});
