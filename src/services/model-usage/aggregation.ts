/**
 * @file src/services/model-usage/aggregation.ts
 * 文件职责：把本地大模型调用事件按本地日界线聚合成设置页可直接消费的统计快照。
 * 主要内容：规范化筛选条件，计算成功调用的输出速度与可计算样本数、今日、七日和三十日汇总、缓存可计算请求的三段 Token 构成，生成逐小时或逐日时间线，并按服务与模型分组；已有记录起点直接复用，缺省时逐项归约，不额外分配起点数组或展开无界实参。
 * 模块边界：本文件只执行确定性的内存计算，不访问 IndexedDB、浏览器 runtime、供应商响应或 Vue 组件。
 */

import type {
    DashboardSnapshot,
    Filter,
    ModelUsageBreakdownItem,
    ModelUsageDimension,
    ModelUsageEvent,
    ModelUsageTimelinePoint,
    Range,
    StoredModelUsageEvent,
    Totals,
} from './types';

type AggregatableEvent = ModelUsageEvent | StoredModelUsageEvent;

export interface DashboardAggregationOptions {
    now?: number;
    recordingStartedAt?: number | null;
    dimensions?: readonly ModelUsageDimension[];
}

const VALID_RANGES = new Set<Range>(['today', '7d', '30d']);
const HOUR_MS = 60 * 60 * 1000;

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function localDateKey(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function epochHourStart(timestamp: number): number {
    const dayStart = localDayStart(timestamp);
    return dayStart + Math.floor((timestamp - dayStart) / HOUR_MS) * HOUR_MS;
}

function epochHourKey(timestamp: number): string {
    return `hour:${epochHourStart(timestamp)}`;
}

function localDayStart(timestamp: number): number {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function shiftLocalDays(timestamp: number, delta: number): number {
    const date = new Date(timestamp);
    date.setDate(date.getDate() + delta);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

function safeTokenCount(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optionalSafeTokenCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function eventModel(event: AggregatableEvent): string {
    const storedModel = 'model' in event && typeof event.model === 'string' ? event.model.trim() : '';
    return storedModel || event.actualModel?.trim() || event.configuredModel.trim() || 'unknown';
}

function matchesDimensions(event: AggregatableEvent, filter: Pick<Filter, 'serviceId' | 'model'>): boolean {
    if (filter.serviceId && event.serviceId !== filter.serviceId) return false;
    if (filter.model && eventModel(event) !== filter.model) return false;
    return true;
}

function eventsWithin(
    events: readonly AggregatableEvent[],
    start: number,
    end: number,
): AggregatableEvent[] {
    return events.filter((event) => event.startedAt >= start && event.startedAt <= end);
}

export function normalizeModelUsageFilter(value?: Partial<Filter>): Filter {
    const range = value?.range && VALID_RANGES.has(value.range) ? value.range : '30d';
    const serviceId = typeof value?.serviceId === 'string' && value.serviceId.trim()
        ? value.serviceId.trim()
        : undefined;
    const model = typeof value?.model === 'string' && value.model.trim()
        ? value.model.trim()
        : undefined;
    return {
        range,
        ...(serviceId ? {serviceId} : {}),
        ...(model ? {model} : {}),
    };
}

export function getModelUsageRangeStart(range: Range, now: number): number {
    const today = localDayStart(now);
    if (range === 'today') return today;
    return shiftLocalDays(today, range === '7d' ? -6 : -29);
}

export function emptyModelUsageTotals(): Totals {
    return {
        outputTokensPerSecond: null,
        speedReportedRequests: 0,
        requestCount: 0,
        successfulRequests: 0,
        failedRequests: 0,
        errorRequests: 0,
        timeoutRequests: 0,
        cancelledRequests: 0,
        reportedTokenRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        cacheReportedRequests: 0,
        cacheHitRequests: 0,
        cacheEligibleInputTokens: 0,
        cacheEligibleOutputTokens: 0,
        cacheTokenHitRate: null,
        cacheRequestHitRate: null,
        cacheCoverageRate: null,
        reasoningTokens: 0,
        averageDurationMs: null,
        averageTokensPerReportedRequest: null,
        averageInputTokensPerReportedRequest: null,
        averageOutputTokensPerReportedRequest: null,
        averageUncachedInputTokensPerCacheReportedRequest: null,
        averageCachedInputTokensPerCacheReportedRequest: null,
        averageOutputTokensPerCacheReportedRequest: null,
        uncachedInputTokenShare: null,
        cachedInputTokenShare: null,
        outputTokenShare: null,
    };
}

/** 输出速度包含首字等待与传输耗时；失败、缺失输出或无效耗时均不参与。 */
export function requestOutputTokensPerSecond(event: ModelUsageEvent): number | null {
    if (event.outcome !== 'success' || event.usageAvailability !== 'reported'
        || typeof event.outputTokens !== 'number' || !Number.isSafeInteger(event.outputTokens)
        || event.outputTokens < 0 || !Number.isFinite(event.durationMs) || event.durationMs <= 0) return null;
    const speed = event.outputTokens / event.durationMs * 1_000;
    return Number.isFinite(speed) ? speed : null;
}

export function aggregateModelUsageTotals(events: readonly AggregatableEvent[]): Totals {
    const totals = emptyModelUsageTotals();
    let totalDurationMs = 0;
    let speedDurationMs = 0;
    let speedOutputTokens = 0;
    let cacheCohortCachedInputTokens = 0;
    for (const event of events) {
        totals.requestCount += 1;
        if (requestOutputTokensPerSecond(event) !== null) {
            totals.speedReportedRequests += 1;
            speedDurationMs += event.durationMs;
            speedOutputTokens += event.outputTokens!;
        }
        if (event.outcome === 'success') totals.successfulRequests += 1;
        else {
            totals.failedRequests += 1;
            if (event.outcome === 'timeout') totals.timeoutRequests += 1;
            else if (event.outcome === 'cancelled') totals.cancelledRequests += 1;
            else totals.errorRequests += 1;
        }
        if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0) {
            totalDurationMs += event.durationMs;
        }

        if (event.usageAvailability === 'reported') totals.reportedTokenRequests += 1;
        totals.inputTokens += safeTokenCount(event.inputTokens);
        totals.outputTokens += safeTokenCount(event.outputTokens);
        totals.totalTokens += safeTokenCount(event.totalTokens);
        totals.cachedInputTokens += safeTokenCount(event.cachedInputTokens);
        totals.cacheWriteTokens += safeTokenCount(event.cacheWriteTokens);
        totals.reasoningTokens += safeTokenCount(event.reasoningTokens);

        const cachedInputTokens = optionalSafeTokenCount(event.cachedInputTokens);
        const inputTokens = optionalSafeTokenCount(event.inputTokens);
        const outputTokens = optionalSafeTokenCount(event.outputTokens);
        if (
            event.usageAvailability === 'reported'
            && cachedInputTokens !== undefined
            && inputTokens !== undefined
            && outputTokens !== undefined
            && cachedInputTokens <= inputTokens
        ) {
            totals.cacheReportedRequests += 1;
            if (cachedInputTokens > 0) totals.cacheHitRequests += 1;
            totals.cacheEligibleInputTokens += inputTokens;
            totals.cacheEligibleOutputTokens += outputTokens;
            cacheCohortCachedInputTokens += cachedInputTokens;
        }
    }
    totals.cacheTokenHitRate = totals.cacheEligibleInputTokens > 0
        ? cacheCohortCachedInputTokens / totals.cacheEligibleInputTokens
        : null;
    totals.cacheRequestHitRate = totals.cacheReportedRequests > 0
        ? totals.cacheHitRequests / totals.cacheReportedRequests
        : null;
    totals.cacheCoverageRate = totals.reportedTokenRequests > 0
        ? totals.cacheReportedRequests / totals.reportedTokenRequests
        : null;
    totals.outputTokensPerSecond = speedDurationMs > 0 ? speedOutputTokens / speedDurationMs * 1_000 : null;
    totals.averageDurationMs = totals.requestCount > 0 ? totalDurationMs / totals.requestCount : null;
    totals.averageTokensPerReportedRequest = totals.reportedTokenRequests > 0
        ? totals.totalTokens / totals.reportedTokenRequests
        : null;
    totals.averageInputTokensPerReportedRequest = totals.reportedTokenRequests > 0
        ? totals.inputTokens / totals.reportedTokenRequests
        : null;
    totals.averageOutputTokensPerReportedRequest = totals.reportedTokenRequests > 0
        ? totals.outputTokens / totals.reportedTokenRequests
        : null;
    const uncachedInputTokens = totals.cacheEligibleInputTokens - cacheCohortCachedInputTokens;
    const compositionTokens = totals.cacheEligibleInputTokens + totals.cacheEligibleOutputTokens;
    totals.averageUncachedInputTokensPerCacheReportedRequest = totals.cacheReportedRequests > 0
        ? uncachedInputTokens / totals.cacheReportedRequests
        : null;
    totals.averageCachedInputTokensPerCacheReportedRequest = totals.cacheReportedRequests > 0
        ? cacheCohortCachedInputTokens / totals.cacheReportedRequests
        : null;
    totals.averageOutputTokensPerCacheReportedRequest = totals.cacheReportedRequests > 0
        ? totals.cacheEligibleOutputTokens / totals.cacheReportedRequests
        : null;
    totals.uncachedInputTokenShare = compositionTokens > 0 ? uncachedInputTokens / compositionTokens : null;
    totals.cachedInputTokenShare = compositionTokens > 0 ? cacheCohortCachedInputTokens / compositionTokens : null;
    totals.outputTokenShare = compositionTokens > 0 ? totals.cacheEligibleOutputTokens / compositionTokens : null;
    return totals;
}

export function collectModelUsageDimensions(events: readonly AggregatableEvent[]): ModelUsageDimension[] {
    const modelsByService = new Map<string, Set<string>>();
    for (const event of events) {
        const serviceId = event.serviceId.trim();
        if (!serviceId) continue;
        const models = modelsByService.get(serviceId) ?? new Set<string>();
        models.add(eventModel(event));
        modelsByService.set(serviceId, models);
    }
    return [...modelsByService]
        .map(([serviceId, models]) => ({serviceId, models: [...models].sort((a, b) => a.localeCompare(b))}))
        .sort((a, b) => a.serviceId.localeCompare(b.serviceId));
}

function buildTimeline(
    events: readonly AggregatableEvent[],
    range: Range,
    now: number,
): ModelUsageTimelinePoint[] {
    const byBucket = new Map<string, AggregatableEvent[]>();
    for (const event of events) {
        const date = new Date(event.startedAt);
        const key = range === 'today' ? epochHourKey(event.startedAt) : localDateKey(date);
        const bucket = byBucket.get(key) ?? [];
        bucket.push(event);
        byBucket.set(key, bucket);
    }

    if (range === 'today') {
        const todayStart = localDayStart(now);
        const tomorrowStart = shiftLocalDays(todayStart, 1);
        const points: ModelUsageTimelinePoint[] = [];
        // 按真实经过的 epoch 小时推进；夏令时切换日会自然得到 23 或 25 个唯一桶。
        for (let bucketStart = todayStart; bucketStart < tomorrowStart; bucketStart += HOUR_MS) {
            const date = new Date(bucketStart);
            const key = epochHourKey(bucketStart);
            points.push({
                key,
                label: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
                startedAt: bucketStart,
                totals: aggregateModelUsageTotals(byBucket.get(key) ?? []),
            });
        }
        return points;
    }

    const days = range === '7d' ? 7 : 30;
    const start = getModelUsageRangeStart(range, now);
    return Array.from({length: days}, (_, index) => {
        const bucketStart = shiftLocalDays(start, index);
        const date = new Date(bucketStart);
        const key = localDateKey(date);
        return {
            key,
            label: `${date.getMonth() + 1}/${date.getDate()}`,
            startedAt: bucketStart,
            totals: aggregateModelUsageTotals(byBucket.get(key) ?? []),
        };
    });
}

function buildBreakdown(events: readonly AggregatableEvent[]): ModelUsageBreakdownItem[] {
    const groups = new Map<string, {serviceId: string; model: string; events: AggregatableEvent[]}>();
    for (const event of events) {
        const model = eventModel(event);
        const key = `${event.serviceId}\u0000${model}`;
        const group = groups.get(key) ?? {serviceId: event.serviceId, model, events: []};
        group.events.push(event);
        groups.set(key, group);
    }
    return [...groups.values()]
        .map((group) => ({
            serviceId: group.serviceId,
            model: group.model,
            totals: aggregateModelUsageTotals(group.events),
        }))
        .sort((left, right) => (
            right.totals.totalTokens - left.totals.totalTokens
            || right.totals.inputTokens - left.totals.inputTokens
            || right.totals.outputTokens - left.totals.outputTokens
            || right.totals.requestCount - left.totals.requestCount
            || left.serviceId.localeCompare(right.serviceId)
            || left.model.localeCompare(right.model)
        ));
}

export function buildModelUsageDashboard(
    events: readonly AggregatableEvent[],
    requestedFilter: Partial<Filter> = {},
    options: DashboardAggregationOptions = {},
): DashboardSnapshot {
    const generatedAt = options.now ?? Date.now();
    const filter = normalizeModelUsageFilter(requestedFilter);
    const dimensionEvents = events.filter((event) => matchesDimensions(event, filter));
    const selectedStart = getModelUsageRangeStart(filter.range, generatedAt);
    const selectedEvents = eventsWithin(dimensionEvents, selectedStart, generatedAt);
    const recordingStartedAt = options.recordingStartedAt === undefined
        ? events.reduce<number | null>((start, event) => start === null ? event.startedAt : Math.min(start, event.startedAt), null)
        : options.recordingStartedAt;

    return {
        generatedAt,
        recordingStartedAt,
        dimensions: (options.dimensions ?? collectModelUsageDimensions(events)).map((dimension) => ({
            serviceId: dimension.serviceId,
            models: [...dimension.models],
        })),
        metrics: {
            today: aggregateModelUsageTotals(eventsWithin(
                dimensionEvents,
                getModelUsageRangeStart('today', generatedAt),
                generatedAt,
            )),
            sevenDays: aggregateModelUsageTotals(eventsWithin(
                dimensionEvents,
                getModelUsageRangeStart('7d', generatedAt),
                generatedAt,
            )),
            thirtyDays: aggregateModelUsageTotals(eventsWithin(
                dimensionEvents,
                getModelUsageRangeStart('30d', generatedAt),
                generatedAt,
            )),
        },
        selected: {
            filter,
            totals: aggregateModelUsageTotals(selectedEvents),
        },
        timeline: buildTimeline(selectedEvents, filter.range, generatedAt),
        breakdown: buildBreakdown(selectedEvents),
    };
}
