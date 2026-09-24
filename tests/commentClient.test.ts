import {beforeEach, describe, expect, it, vi} from 'vitest';
import {requestComments} from '@/src/features/comment-assistant/client';

type Mock = ReturnType<typeof vi.fn>;
interface PortStub {
    postMessage: Mock;
    disconnect: Mock;
    onMessage: {addListener: Mock};
    onDisconnect: {addListener: Mock};
}

const state = vi.hoisted(() => ({message: vi.fn(), connect: vi.fn(), port: null as never}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: state.message, connect: state.connect}}}));

const port = () => state.port as unknown as PortStub;

beforeEach(() => {
    state.message.mockReset();
    state.port = {postMessage: vi.fn(), disconnect: vi.fn(), onMessage: {addListener: vi.fn()}, onDisconnect: {addListener: vi.fn()}} as never;
    state.connect.mockReset().mockReturnValue(state.port);
});

const request = {type: 'fluentReadComment' as const, action: 'run' as const, requestId: 'c1', text: '原文', images: [] as string[]};

describe('comment client', () => {
    it('delivers the matching result once and disconnects', () => {
        const result = vi.fn(); const error = vi.fn();
        requestComments(request, {result, error});
        const onMessage = port().onMessage.addListener.mock.calls[0][0];
        onMessage({type: 'result', requestId: 'other', response: {success: true, comments: []}});
        expect(result).not.toHaveBeenCalled();
        onMessage({type: 'result', requestId: 'c1', response: {success: true, comments: [{content: 'x', translation: null}]}});
        onMessage({type: 'result', requestId: 'c1', response: {success: false, error: 'late'}});
        expect(result).toHaveBeenCalledOnce();
        expect(error).not.toHaveBeenCalled();
        expect(port().disconnect).toHaveBeenCalled();
    });

    it('reports disconnect as an error only once', () => {
        const error = vi.fn();
        requestComments(request, {error});
        const onDisconnect = port().onDisconnect.addListener.mock.calls[0][0];
        onDisconnect();
        onDisconnect();
        expect(error).toHaveBeenCalledOnce();
    });

    it('cancel disconnects, notifies the background and is idempotent', () => {
        state.message.mockResolvedValue({});
        const handle = requestComments(request, {});
        handle.cancel();
        handle.cancel();
        expect(port().disconnect).toHaveBeenCalledOnce();
        expect(state.message).toHaveBeenCalledWith({type: 'fluentReadComment', action: 'cancel', requestId: 'c1'});
    });

    it('treats a post failure as disconnect and swallows cancel send failures', async () => {
        port().postMessage = vi.fn(() => { throw new Error('gone'); });
        const error = vi.fn();
        const handle = requestComments(request, {error});
        expect(error).toHaveBeenCalledOnce();
        state.message.mockRejectedValue(new Error('no channel'));
        handle.cancel();
        await Promise.resolve();
    });

    it('swallows a port that refuses to disconnect', () => {
        state.message.mockResolvedValue({});
        const result = vi.fn();
        requestComments(request, {result});
        port().disconnect.mockImplementation(() => { throw new Error('already closed'); });
        port().onMessage.addListener.mock.calls[0][0]({type: 'result', requestId: 'c1', response: {success: true, comments: []}});
        expect(result).toHaveBeenCalledOnce();
        const other = requestComments({...request, requestId: 'c9'}, {});
        other.cancel();
        expect(state.message).toHaveBeenCalledTimes(1);
    });
});
