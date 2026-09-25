import {beforeEach, describe, expect, it, vi} from 'vitest';
import {attachCommentStreamPort} from '@/src/features/comment-assistant/streamPort';
import type {CommentStreamPort} from '@/src/features/comment-assistant/streamPort';

const makePort = (name = 'fluentReadCommentStream') => {
    const listeners: Array<(message: unknown) => void> = [];
    const disconnects: Array<() => void> = [];
    const port: CommentStreamPort & {fire(message: unknown): void; drop(): void} = {
        name,
        sender: {id: 'ext', tab: {id: 1}},
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onMessage: {addListener: vi.fn((l) => listeners.push(l)), removeListener: vi.fn((l) => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); })},
        onDisconnect: {addListener: vi.fn((l) => disconnects.push(l)), removeListener: vi.fn((l) => { const i = disconnects.indexOf(l); if (i >= 0) disconnects.splice(i, 1); })},
        fire: (message) => [...listeners].forEach((l) => l(message)),
        drop: () => [...disconnects].forEach((l) => l()),
    };
    return port;
};

describe('comment stream port', () => {
    const handler = {handle: vi.fn()};
    // mockReset() 返回 mock 自身用于链式调用；生命周期钩子必须用函数体吞掉返回值，
    // 否则 Vitest 会把它当作测试后的清理回调登记。
    beforeEach(() => { handler.handle.mockReset(); });

    it('ignores unrelated ports', () => {
        const port = makePort('other');
        attachCommentStreamPort(port, handler);
        expect(port.onMessage.addListener).not.toHaveBeenCalled();
    });

    it('answers exactly one request and cleans up', async () => {
        handler.handle.mockResolvedValue({success: true, comments: [{content: 'x', translation: null}]});
        const port = makePort();
        attachCommentStreamPort(port, handler);
        port.fire({type: 'fluentReadComment', action: 'run', requestId: 'r1', text: 't', images: []});
        port.fire({type: 'fluentReadComment', action: 'run', requestId: 'r2', text: 't', images: []});
        await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
        expect(port.postMessage).toHaveBeenCalledWith({type: 'result', requestId: 'r1', response: {success: true, comments: [{content: 'x', translation: null}]}});
        expect(handler.handle).toHaveBeenCalledOnce();
        port.fire('late');
        expect(handler.handle).toHaveBeenCalledOnce();
        expect(port.disconnect).toHaveBeenCalled();
    });

    it('reports internal failures as a result message', async () => {
        handler.handle.mockRejectedValue(new Error('boom'));
        const port = makePort();
        attachCommentStreamPort(port, handler);
        port.fire({requestId: 'r9'});
        await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
        const sent = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(sent.type).toBe('result');
        expect(sent.requestId).toBe('r9');
        expect(sent.response.success).toBe(false);
    });

    it('cancels the recorded request when the port drops mid-flight', async () => {
        handler.handle.mockImplementation(() => new Promise(() => { /* 永不完成 */ }));
        const port = makePort();
        attachCommentStreamPort(port, handler);
        port.fire({requestId: 'r3'});
        await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledOnce());
        port.drop();
        await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledWith({type: 'fluentReadComment', action: 'cancel', requestId: 'r3'}, port.sender));
    });

    it('disconnect without a started request only cleans up', () => {
        const port = makePort();
        attachCommentStreamPort(port, handler);
        port.drop();
        expect(handler.handle).not.toHaveBeenCalled();
    });

    it('treats a failed result post as a disconnect', async () => {
        handler.handle.mockResolvedValue({success: true, comments: []});
        const port = makePort();
        (port.postMessage as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('closed'); });
        attachCommentStreamPort(port, handler);
        port.fire({requestId: 'r7'});
        await vi.waitFor(() => expect(port.disconnect).toHaveBeenCalled());
        await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledWith({type: 'fluentReadComment', action: 'cancel', requestId: 'r7'}, port.sender));
    });

    it('drops a result that arrives after the port already closed', async () => {
        let finish!: (response: {success: true; comments: never[]; sourceTranslation: null}) => void;
        handler.handle.mockImplementation((message: {action: string}) => (message.action === 'cancel'
            ? Promise.resolve({success: false, error: '已取消', cancelled: true})
            : new Promise((resolve) => { finish = resolve; })));
        const port = makePort();
        attachCommentStreamPort(port, handler);
        port.fire({requestId: 'r8'});
        await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledOnce());
        port.drop();
        finish({success: true, comments: [], sourceTranslation: null});
        await vi.waitFor(() => expect(handler.handle).toHaveBeenCalledTimes(2));
        expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('uses an empty sender and survives a disconnect that throws', async () => {
        handler.handle.mockResolvedValue({success: true, comments: []});
        const port = makePort();
        delete (port as unknown as {sender?: unknown}).sender;
        (port.disconnect as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('already closed'); });
        attachCommentStreamPort(port, handler);
        port.fire({requestId: 'r10'});
        await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
        expect(handler.handle).toHaveBeenCalledWith({requestId: 'r10'}, {});
    });
});
