/**
 * @file src/features/video-subtitle/content/video-ai/cueTimeline.ts
 * 文件职责：合并 AI 字幕 cue、规范化有界时间轴并按 spoken 时间选择当前 cue。
 * 主要内容：处理重叠窗口、短暂时间孔洞、迟到识别元数据和严格播放头可见性，将完成的识别字幕转换为可立即回放的原文时间轴。
 * 模块边界：只处理时间轴数据结构，不读取播放器、不触发翻译，也不修改页面 DOM。
 */
import type { VideoSubtitleCue } from '../youtubeSubtitleData';
import {
  areVideoAiTranscriptCorrectionVariants,
  areVideoAiTranscriptTextsRelated,
  mergeVideoAiTranscriptText,
  type VideoAiStabilizedCue,
} from './streamingTranscript';

/**
 * AI 字幕的时间轴策略集中在这个模块，播放器接入层不再自己拼接 cue。
 * 每个分片只允许产生有限数量的 cue，避免识别结果异常时把数组无限推大。
 */
export const VIDEO_AI_CUE_EARLY_TOLERANCE_MS = 80;
// 可见性严格服从 spoken 时间；识别或翻译迟到只影响何时能看到 cue，不能
// 把已说完的旧句延长到后续音频内容上。
export const VIDEO_AI_CUE_LATE_GRACE_MS = 0;
export const VIDEO_AI_CUE_MIN_DURATION_MS = 500;
export const VIDEO_AI_CUE_MERGE_GAP_MS = 500;
export const VIDEO_AI_CUE_GAP_FILL_MS = 560;
export const VIDEO_AI_MAX_CUE_COUNT = 1_200;

type VideoAiTimelineCue = VideoSubtitleCue
  & Partial<Pick<VideoAiStabilizedCue, 'availableAtMs' | 'spokenEndMs'>>
  & { translationAvailableAtMs?: number };

function normalizeCueText(text: string): string {
  return text.replace(/[\s\u3000]+/g, ' ').trim();
}

/** 完整识别完成后立即回放原文；只使用 spoken 时长，不把译文预取当成可用门槛。 */
export function finalizeVideoAiCuesForPlayback(cues: readonly VideoAiStabilizedCue[]): VideoSubtitleCue[] {
  return cues.map(cue => ({
    ...cue,
    startMs: Math.max(0, cue.startMs),
    durationMs: Math.max(1, cue.spokenEndMs - cue.startMs),
    text: normalizeCueText(cue.text),
    availableAtMs: 0,
    translationAvailableAtMs: 0,
  })).filter(cue => cue.text);
}

function getAiCueTranslationAvailableAtMs(cue: VideoSubtitleCue): number {
  const value = (cue as VideoAiTimelineCue).translationAvailableAtMs;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function getAiCueEndMs(cue: VideoSubtitleCue): number {
  const durationMs = Number.isFinite(cue.durationMs)
    ? Math.max(cue.durationMs, VIDEO_AI_CUE_MIN_DURATION_MS)
    : VIDEO_AI_CUE_MIN_DURATION_MS;
  return cue.startMs + durationMs;
}

function getAiCueAvailableAtMs(cue: VideoSubtitleCue): number {
  const value = (cue as VideoAiTimelineCue).availableAtMs;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : Math.max(0, cue.startMs);
}

function getAiCueSpokenEndMs(cue: VideoSubtitleCue): number {
  const value = (cue as VideoAiTimelineCue).spokenEndMs;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(cue.startMs, value)
    : getAiCueEndMs(cue);
}

function normalizeVideoAiCueEnd(cue: VideoAiTimelineCue): VideoAiTimelineCue {
  const spokenEndMs = getAiCueSpokenEndMs(cue);
  return {
    ...cue,
    durationMs: Math.max(1, spokenEndMs - cue.startMs),
    spokenEndMs,
  };
}

/**
 * 将 AI cue 的可见时长收敛到 spoken 时间轴。该操作必须在完整窗口的
 * correction/consolidation 之后执行，否则会让 correction 失去用于判定
 * spoken overlap 的原始 span。native 字幕不调用此 helper，因此保留原生
 * 字幕允许同时出现的合法重叠语义。
 */
export function normalizeVideoAiSubtitleTimeline(cues: VideoSubtitleCue[]): VideoSubtitleCue[] {
  const ordered = [...cues]
    .filter((cue) => Number.isFinite(cue.startMs) && typeof cue.text === 'string' && cue.text.trim())
    .map((cue) => ({
      ...cue,
      startMs: Math.max(0, cue.startMs),
      durationMs: Number.isFinite(cue.durationMs)
        ? Math.max(VIDEO_AI_CUE_MIN_DURATION_MS, cue.durationMs)
        : VIDEO_AI_CUE_MIN_DURATION_MS,
      text: normalizeCueText(cue.text),
    }))
    .sort((left, right) => left.startMs - right.startMs);

  const result: VideoAiTimelineCue[] = [];
  for (const sourceCue of ordered) {
    const cue = {...sourceCue} as VideoAiTimelineCue;
    const previous = result[result.length - 1];
    if (!previous) {
      result.push(cue);
      continue;
    }

    if (cue.startMs === previous.startMs) {
      // 同一 spoken 起点的独立 AI 结果不可能在时间轴上并列显示；后到结果
      // 是当前窗口对该起点的最新判断，保留它并继续处理后续边界。
      result[result.length - 1] = cue;
      continue;
    }

    const previousSpokenEndMs = getAiCueSpokenEndMs(previous);
    if (cue.startMs < previousSpokenEndMs) {
      const boundedEndMs = Math.max(previous.startMs, cue.startMs);
      result[result.length - 1] = {
        ...previous,
        durationMs: Math.max(1, boundedEndMs - previous.startMs),
        spokenEndMs: boundedEndMs,
      };
    } else if (typeof previous.spokenEndMs === 'number' && Number.isFinite(previous.spokenEndMs)) {
      // 保留 spoken gap：展示时长不能把静音区间重新填回上一句。
      result[result.length - 1] = {
        ...previous,
        durationMs: Math.max(1, previousSpokenEndMs - previous.startMs),
      };
    }

    result.push(cue);
  }

  return result.map(normalizeVideoAiCueEnd).slice(-VIDEO_AI_MAX_CUE_COUNT);
}

/**
 * 合并相邻分片的结果，消除 Whisper 在分片边界重复输出同一句造成的闪烁。
 * 不会把不相关的句子强行合并；重叠时由后一个真实 start 接管时间轴。
 */
export function mergeVideoAiSubtitleCues(cues: VideoSubtitleCue[]): VideoSubtitleCue[] {
  const ordered = [...cues]
    .filter((cue) => Number.isFinite(cue.startMs) && typeof cue.text === 'string' && cue.text.trim())
    .map((cue) => ({
      ...cue,
      startMs: Math.max(0, cue.startMs),
      durationMs: Number.isFinite(cue.durationMs)
        ? Math.max(VIDEO_AI_CUE_MIN_DURATION_MS, cue.durationMs)
        : VIDEO_AI_CUE_MIN_DURATION_MS,
      text: normalizeCueText(cue.text),
    }))
    .sort((left, right) => left.startMs - right.startMs);

  const result: VideoAiTimelineCue[] = [];
  for (const cue of ordered) {
    const previous = result[result.length - 1];
    if (!previous) {
      result.push(cue);
      continue;
    }

    const previousEndMs = getAiCueEndMs(previous);
    const correctionVariant = cue.startMs < getAiCueSpokenEndMs(previous)
      && areVideoAiTranscriptCorrectionVariants(previous.text, cue.text);
    const relatedText = correctionVariant || areVideoAiTranscriptTextsRelated(previous.text, cue.text);
    if (relatedText && cue.startMs <= previousEndMs + VIDEO_AI_CUE_MERGE_GAP_MS) {
      const startMs = Math.min(previous.startMs, cue.startMs);
      const endMs = Math.max(previousEndMs, getAiCueEndMs(cue));
      const mergedText = correctionVariant ? cue.text : mergeVideoAiTranscriptText(previous.text, cue.text);
      const textChanged = mergedText !== previous.text;
      result[result.length - 1] = {
        ...previous,
        ...cue,
        startMs,
        durationMs: Math.max(VIDEO_AI_CUE_MIN_DURATION_MS, endMs - startMs),
        text: mergedText,
        availableAtMs: textChanged
          ? Math.max(getAiCueAvailableAtMs(previous), getAiCueAvailableAtMs(cue))
          : Math.min(getAiCueAvailableAtMs(previous), getAiCueAvailableAtMs(cue)),
        spokenEndMs: Math.max(getAiCueSpokenEndMs(previous), getAiCueSpokenEndMs(cue)),
        translationAvailableAtMs: Math.max(
          getAiCueTranslationAvailableAtMs(previous),
          getAiCueTranslationAvailableAtMs(cue),
        ) || undefined,
      };
      continue;
    }

    const gapMs = cue.startMs - previousEndMs;
    if (gapMs > 0 && gapMs <= VIDEO_AI_CUE_GAP_FILL_MS) {
      // 时间戳量化可能留下很短的空洞，直接延长上一句可避免字幕闪空。
      previous.durationMs = Math.max(VIDEO_AI_CUE_MIN_DURATION_MS, cue.startMs - previous.startMs);
    }
    if (cue.startMs > previous.startMs && cue.startMs < previousEndMs) {
      previous.durationMs = Math.max(VIDEO_AI_CUE_MIN_DURATION_MS, cue.startMs - previous.startMs);
    }
    result.push(cue);
  }

  return result.slice(-VIDEO_AI_MAX_CUE_COUNT);
}

/** 找到当前播放头应显示的最新 cue，而不是让重叠 cue 来回抢占字幕层。 */
export function getVisibleVideoAiCue(
  cues: VideoSubtitleCue[],
  currentMs: number,
  earlyToleranceMs = VIDEO_AI_CUE_EARLY_TOLERANCE_MS,
  lateGraceMs = VIDEO_AI_CUE_LATE_GRACE_MS,
): VideoSubtitleCue | null {
  if (!Number.isFinite(currentMs)) return null;
  let visible: VideoSubtitleCue | null = null;
  let visibleAvailableAtMs = -Infinity;
  for (const cue of cues) {
    const availableAtMs = getAiCueAvailableAtMs(cue);
    const startMs = cue.startMs - earlyToleranceMs;
    const spokenEndMs = getAiCueSpokenEndMs(cue);
    if (currentMs < startMs || currentMs >= spokenEndMs + lateGraceMs) continue;
    if (!visible || cue.startMs > visible.startMs
      || (cue.startMs === visible.startMs && availableAtMs > visibleAvailableAtMs)) {
      visible = cue;
      visibleAvailableAtMs = availableAtMs;
    }
  }
  return visible;
}
