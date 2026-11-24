import {afterEach, describe, expect, it, vi} from 'vitest';
import {VideoPretranslationController} from '@/src/features/video-subtitle/content/pretranslationController';

const track = (kind = 'captions') => Object.assign(new EventTarget(), {kind}) as unknown as TextTrack;
const video = (tracks: TextTrack[]) => {
  const list = Object.assign(new EventTarget(), {length: tracks.length, [Symbol.iterator]: () => tracks[Symbol.iterator]()});
  return Object.assign(new EventTarget(), {textTracks: list}) as unknown as HTMLVideoElement;
};
afterEach(() => vi.useRealTimers());
describe('VideoPretranslationController', () => {
  it('高频 cue 更新只通知与预取，不重新读取或重绑轨道监听；增删只调整对应轨道', () => {
    const tracks = Array.from({length: 32}, () => track());
    const current = video(tracks);
    const prime = vi.fn(), changed = vi.fn();
    const additions = tracks.map(item => vi.spyOn(item, 'addEventListener'));
    const removals = tracks.map(item => vi.spyOn(item, 'removeEventListener'));
    const controller = new VideoPretranslationController(prime, changed);
    controller.observe(current);
    const list = current.textTracks;
    const readTracks = vi.fn(() => list);
    Object.defineProperty(current, 'textTracks', {get: readTracks});
    additions.forEach(spy => spy.mockClear());
    for (let index = 0; index < 120; index++) tracks[0].dispatchEvent(new Event('cuechange'));
    expect(prime).toHaveBeenCalledTimes(120); expect(changed).toHaveBeenCalledTimes(120);
    expect(readTracks).not.toHaveBeenCalled();
    expect(additions.every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(removals.every(spy => spy.mock.calls.length === 0)).toBe(true);
    const next = track('subtitles'), addNext = vi.spyOn(next, 'addEventListener');
    tracks.push(next); current.textTracks.dispatchEvent(new Event('addtrack'));
    expect(addNext).toHaveBeenCalledOnce();
    expect(additions.every(spy => spy.mock.calls.length === 0)).toBe(true);
    const removed = tracks.shift()!; current.textTracks.dispatchEvent(new Event('removetrack'));
    expect(removals[0]).toHaveBeenCalledOnce();
    expect(removals.slice(1).every(spy => spy.mock.calls.length === 0)).toBe(true);
    removed.dispatchEvent(new Event('cuechange'));
    expect(changed).toHaveBeenCalledTimes(122);
    controller.destroy();
  });

  it('合并普通更新，立即预取取消等待，并在清理和卸载后停止计时器', () => {
    vi.useFakeTimers();
    const prime = vi.fn();
    const controller = new VideoPretranslationController(prime, vi.fn());
    controller.schedule(); controller.schedule();
    vi.advanceTimersByTime(119); expect(prime).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(prime).toHaveBeenCalledTimes(1);
    controller.schedule(); controller.schedule(true);
    expect(prime).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(120); expect(prime).toHaveBeenCalledTimes(2);
    controller.clear(); controller.schedule(); controller.clear();
    vi.advanceTimersByTime(120); expect(prime).toHaveBeenCalledTimes(2);
    controller.schedule(); controller.destroy(); controller.destroy(); controller.schedule(true); controller.schedule();
    vi.advanceTimersByTime(120); expect(prime).toHaveBeenCalledTimes(2);
  });

  it('轨道加入、删除、选择或 cue 更新立即预取，换视频和销毁释放旧监听', () => {
    const prime = vi.fn(); const changed = vi.fn();
    const caption = track(); const subtitle = track('subtitles'); const metadata = track('metadata');
    const tracks = [caption, metadata];
    const first = video(tracks); const second = video([subtitle]);
    const controller = new VideoPretranslationController(prime, changed);
    controller.observe(null); controller.observe(first); controller.observe(first);
    caption.dispatchEvent(new Event('cuechange')); metadata.dispatchEvent(new Event('cuechange'));
    tracks.push(subtitle); first.textTracks.dispatchEvent(new Event('addtrack'));
    subtitle.dispatchEvent(new Event('cuechange'));
    tracks.splice(0, 1); first.textTracks.dispatchEvent(new Event('removetrack'));
    caption.dispatchEvent(new Event('cuechange'));
    first.textTracks.dispatchEvent(new Event('change'));
    expect(prime).toHaveBeenCalledTimes(5); expect(changed).toHaveBeenCalledTimes(5);
    controller.observe(second);
    first.textTracks.dispatchEvent(new Event('change')); first.dispatchEvent(new Event('load'));
    subtitle.dispatchEvent(new Event('cuechange'));
    expect(prime).toHaveBeenCalledTimes(6);
    controller.destroy(); controller.observe(first);
    second.textTracks.dispatchEvent(new Event('change')); subtitle.dispatchEvent(new Event('cuechange'));
    expect(prime).toHaveBeenCalledTimes(6);
  });

  it('仅当前 video 的 track load 触发预取，忽略其他元素和其他媒体的 load', () => {
    const prime = vi.fn(); const controller = new VideoPretranslationController(prime, vi.fn());
    const current = video([]); controller.observe(current);
    const dispatchLoad = (target: unknown) => {
      const event = new Event('load');
      Object.defineProperty(event, 'target', {value: target});
      current.dispatchEvent(event);
    };
    dispatchLoad(null); dispatchLoad({tagName: 'IMG', parentElement: current});
    dispatchLoad({tagName: 'TRACK', parentElement: video([])});
    expect(prime).not.toHaveBeenCalled();
    dispatchLoad({tagName: 'TRACK', parentElement: current});
    expect(prime).toHaveBeenCalledOnce();
    controller.destroy();
  });
});
