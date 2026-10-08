import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createCommentKeepAlive} from '@/src/features/comment-assistant/keepalive';

describe('comment keepalive metronome', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('pings periodically from the first acquire and stops once the count returns to zero', () => {
        const ping = vi.fn();
        const keepAlive = createCommentKeepAlive(ping, 5_000);
        const release = keepAlive.acquire();
        expect(ping).not.toHaveBeenCalled();
        vi.advanceTimersByTime(5_000);
        expect(ping).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(15_000);
        expect(ping).toHaveBeenCalledTimes(4);
        release();
        vi.advanceTimersByTime(50_000);
        expect(ping).toHaveBeenCalledTimes(4);
    });

    it('shares one timer across concurrent acquires and keeps ticking while any reference lives', () => {
        const ping = vi.fn();
        const keepAlive = createCommentKeepAlive(ping, 10_000);
        const releaseA = keepAlive.acquire();
        const releaseB = keepAlive.acquire();
        vi.advanceTimersByTime(30_000);
        expect(ping).toHaveBeenCalledTimes(3);
        releaseA();
        vi.advanceTimersByTime(30_000);
        // B 仍持有引用：节拍不重启也不中断，计数只是从 2 降到 1。
        expect(ping).toHaveBeenCalledTimes(6);
        releaseB();
        vi.advanceTimersByTime(30_000);
        expect(ping).toHaveBeenCalledTimes(6);
    });

    it('tolerates repeated releases without a negative count or a broken restart', () => {
        const ping = vi.fn();
        const keepAlive = createCommentKeepAlive(ping, 1_000);
        const release = keepAlive.acquire();
        release();
        release();
        release(); // 重复释放幂等：不抛错、不为负、不重复停表。
        vi.advanceTimersByTime(5_000);
        expect(ping).not.toHaveBeenCalled();
        const restart = keepAlive.acquire(); // 过度释放后仍可按首次 acquire 语义重新启动。
        vi.advanceTimersByTime(1_000);
        expect(ping).toHaveBeenCalledOnce();
        restart();
        vi.advanceTimersByTime(5_000);
        expect(ping).toHaveBeenCalledOnce();
    });

    it('defaults to a 20 second interval', () => {
        const ping = vi.fn();
        const keepAlive = createCommentKeepAlive(ping);
        const release = keepAlive.acquire();
        vi.advanceTimersByTime(19_999);
        expect(ping).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(ping).toHaveBeenCalledOnce();
        release();
        vi.advanceTimersByTime(20_000);
        expect(ping).toHaveBeenCalledOnce();
    });
});
