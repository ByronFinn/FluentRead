import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createOffscreenMessageListener} from '@/src/app/offscreen/messageRouter';
import {LOCAL_TRANSLATION_MODEL_IDS} from '@/src/core/config/localTranslation';
import {OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE} from '@/src/platform/offscreen/client';
import {createChromePreparationRequiredError} from '@/src/app/offscreen/translation';
import {
    OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
    OFFSCREEN_READY_MESSAGE_TYPE,
} from '@/src/platform/offscreen/client';
import {translateImageTextsInExtension} from '@/src/features/image-translation/services/offscreenRuntime';
import {
    MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE,
    MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
} from '@/src/services/harness/modelCallProtocol';

const mocks = {
    downloadOcrLanguages: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    fetchImage: vi.fn(async () => 'data:image/png;base64,remote'),
    stop: vi.fn(() => true),
    translate: vi.fn(async () => '译文'),
    translateArea: vi.fn(async () => ({image: 'area', lines: []})),
    cropArea: vi.fn(async () => ({image: 'crop', lines: []})),
    translateImage: vi.fn(async () => ({image: 'translated', lines: []})),
};

const listener = createOffscreenMessageListener({
    translate: mocks.translate,
    ttsPlayer: {play: mocks.play, stop: mocks.stop},
    fetchImage: mocks.fetchImage,
    translateImage: mocks.translateImage,
    translateArea: mocks.translateArea,
    cropArea: mocks.cropArea,
    downloadOcrLanguages: mocks.downloadOcrLanguages,
});

async function dispatch(message: unknown, handler = listener): Promise<{handled: boolean; response?: unknown}> {
    let resolveResponse!: (response: unknown) => void;
    const response = new Promise<unknown>((resolve) => { resolveResponse = resolve; });
    const routedMessage = message && typeof message === 'object' && !Array.isArray(message)
        && !Object.hasOwn(message, 'target')
        ? {...message, target: 'offscreen'}
        : message;
    const handled = handler(routedMessage, {}, resolveResponse);
    return handled ? {handled, response: await response} : {handled};
}

describe('Offscreen 消息静态路由', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.play.mockResolvedValue(undefined);
        mocks.stop.mockReturnValue(true);
        mocks.translate.mockResolvedValue('译文');
        mocks.fetchImage.mockResolvedValue('data:image/png;base64,remote');
        mocks.translateImage.mockResolvedValue({image: 'translated', lines: []});
        mocks.translateArea.mockResolvedValue({image: 'area', lines: []});
        mocks.cropArea.mockResolvedValue({image: 'crop', lines: []});
        mocks.downloadOcrLanguages.mockResolvedValue(undefined);
    });

    it('将本地 TTS 的 ArrayBuffer 编码为 runtime 可传输的 Base64', async () => {
        const localTts = createOffscreenMessageListener({
            ...mocks,
            ttsPlayer: {play: mocks.play, stop: mocks.stop},
            localTts: {
                synthesize: vi.fn(async () => ({
                    audio: new Uint8Array([82, 73, 70, 70]).buffer,
                    contentType: 'audio/wav',
                    voice: 'zf_001',
                    backend: 'wasm',
                })),
                prepare: vi.fn(async () => ({warm: false})),
                status: vi.fn(async () => ({models: []})),
                removeModel: vi.fn(async () => undefined),
            },
        });

        await expect(dispatch({
            type: 'LOCAL_TTS_SYNTHESIZE',
            requestId: 'tts-binary-1',
            text: '你好',
            language: 'zh-CN',
            voice: 'zf_001',
        }, localTts)).resolves.toEqual({
            handled: true,
            response: {
                success: true,
                audioBase64: 'UklGRg==',
                contentType: 'audio/wav',
                voice: 'zf_001',
                backend: 'wasm',
                requestId: 'tts-binary-1',
            },
        });
    });

    it('null、数组、无 type 与未知消息保持未处理', async () => {
        await expect(dispatch(null)).resolves.toEqual({handled: false});
        await expect(dispatch([])).resolves.toEqual({handled: false});
        await expect(dispatch({type: 1})).resolves.toEqual({handled: false});
        await expect(dispatch({type: 'UNKNOWN'})).resolves.toEqual({handled: false});
    });

    it('在业务消息前确认 Offscreen 接收端已经完成监听注册', async () => {
        await expect(dispatch({type: OFFSCREEN_READY_MESSAGE_TYPE}))
            .resolves.toEqual({handled: true, response: {success: true, ready: true}});
        expect(Object.values(mocks).every(mock => mock.mock.calls.length === 0)).toBe(true);
    });

    it('区域裁剪依赖缺失时返回明确不可用响应', async () => {
        const withoutCrop = createOffscreenMessageListener({
            ...mocks, cropArea: undefined, ttsPlayer: {play: mocks.play, stop: mocks.stop},
        });
        await expect(dispatch({type: 'FLUENT_READ_AREA_CROP_OFFSCREEN', image: 'data:image/png,x', selection: {
            left: 0, top: 0, width: 10, height: 10, viewportWidth: 20, viewportHeight: 20,
        }}, withoutCrop)).resolves.toEqual({handled: true, response: {success: false, error: '区域裁剪不可用'}});
    });

    it('TTS 只接收 offscreen target，并统一返回成功或错误', async () => {
        await expect(dispatch({type: 'PLAY_SELECTION_TTS', target: 'page'})).resolves.toEqual({handled: false});
        await expect(dispatch({type: 'STOP_SELECTION_TTS', target: 'page'})).resolves.toEqual({handled: false});
        const play = {
            type: 'PLAY_SELECTION_TTS',
            target: 'offscreen',
            sourceUrl: 'x',
            tabId: 0,
            clientRequestId: 'client-1',
        };
        await expect(dispatch(play)).resolves.toEqual({handled: true, response: {success: true}});
        expect(mocks.play).toHaveBeenCalledWith(play);
        const stop = {type: 'STOP_SELECTION_TTS', target: 'offscreen', tabId: 0, clientRequestId: 'client-1'};
        await expect(dispatch(stop))
            .resolves.toEqual({handled: true, response: {success: true}});
        expect(mocks.stop).toHaveBeenCalledWith(stop);

        mocks.play.mockRejectedValueOnce(new Error('play failed'));
        await expect(dispatch(play)).resolves.toEqual({handled: true, response: {success: false, error: 'play failed'}});
        mocks.stop.mockImplementationOnce(() => { throw 'bad id'; });
        await expect(dispatch({type: 'STOP_SELECTION_TTS', target: 'offscreen', tabId: 0, clientRequestId: 'bad'}))
            .resolves.toEqual({handled: true, response: {success: false, error: 'bad id'}});
    });

    it('视频 AI 接收端复用消息通道，并隔离未启用、失败与非法结果', async () => {
        for (const type of ['VIDEO_AI_TRANSCRIBE', 'VIDEO_AI_PREPARE']) {
            expect((await dispatch({type})).response).toMatchObject({success: false});
        }
        expect((await dispatch({type: 'VIDEO_AI_CANCEL'})).response).toEqual({success: true});
        const videoAi = {transcribe: vi.fn().mockResolvedValue({text: 'spoken'}), prepare: vi.fn().mockResolvedValue({model: 'tiny'}), cancel: vi.fn().mockResolvedValue(undefined)};
        const handler = createOffscreenMessageListener({...mocks, ttsPlayer: {play: mocks.play, stop: mocks.stop}, videoAi});
        expect((await dispatch({type: 'VIDEO_AI_TRANSCRIBE', streamId: 'video-1'}, handler)).response).toEqual({success: true, text: 'spoken'});
        expect(videoAi.transcribe).toHaveBeenCalledWith({type: 'VIDEO_AI_TRANSCRIBE', target: 'offscreen', streamId: 'video-1'});
        expect((await dispatch({type: 'VIDEO_AI_PREPARE'}, handler)).response).toEqual({success: true, model: 'tiny'});
    expect((await dispatch({type: 'VIDEO_AI_CANCEL', streamId: 'video-1'}, handler)).response).toEqual({success: true});
    expect(videoAi.cancel).toHaveBeenCalledWith('video-1', 'cancel');
    expect((await dispatch({type: 'VIDEO_AI_CANCEL', streamId: 'video-1', reason: 'complete'}, handler)).response).toEqual({success: true});
    expect(videoAi.cancel).toHaveBeenCalledWith('video-1', 'complete');
        expect((await dispatch({type: 'VIDEO_AI_CANCEL'}, handler)).response).toMatchObject({success: false});
        videoAi.transcribe.mockResolvedValueOnce(null);
        expect((await dispatch({type: 'VIDEO_AI_TRANSCRIBE'}, handler)).response).toMatchObject({success: false});
        videoAi.prepare.mockRejectedValueOnce(new Error('model offline'));
        expect((await dispatch({type: 'VIDEO_AI_PREPARE'}, handler)).response).toEqual({success: false, error: 'model offline'});
    });

    it('Chrome translate 只接受合法 requestId，并把内部 AbortSignal 传给执行器', async () => {
        const data = {text: 'hello', from: 'en', to: 'ja'};
        await expect(dispatch({type: 'CHROME_TRANSLATE_OFFSCREEN', requestId: 'chrome-1', data}))
            .resolves.toEqual({
                handled: true,
                response: {success: true, result: '译文', requestId: 'chrome-1'},
            });
        expect(mocks.translate).toHaveBeenCalledWith(data, expect.any(AbortSignal));
        mocks.translate.mockRejectedValueOnce('translator failed');
        await expect(dispatch({type: 'CHROME_TRANSLATE_OFFSCREEN', requestId: 'chrome-2', data}))
            .resolves.toEqual({
                handled: true,
                response: {success: false, requestId: 'chrome-2', error: 'translator failed'},
            });

        for (const requestId of [undefined, 1, '', 'bad request', 'x'.repeat(129)]) {
            expect((await dispatch({type: 'CHROME_TRANSLATE_OFFSCREEN', requestId, data})).response)
                .toMatchObject({success: false});
        }
    });

    it('结构化返回待准备语言对和环境不可用错误', async () => {
        const preparation = createChromePreparationRequiredError('en', 'zh');
        mocks.translate.mockRejectedValueOnce(preparation);
        await expect(dispatch({type: 'CHROME_TRANSLATE_OFFSCREEN', requestId: 'prep-1', data: {}}))
            .resolves.toMatchObject({response: {
                success: false,
                errorCode: 'preparation-required',
                errorName: 'ChromePreparationRequiredError',
                sourceLanguage: 'en',
                targetLanguage: 'zh',
            }});
        const unavailable = new Error('device policy');
        unavailable.name = 'ChromeModelUnavailableError';
        mocks.translate.mockRejectedValueOnce(unavailable);
        await expect(dispatch({type: 'CHROME_TRANSLATE_OFFSCREEN', requestId: 'model-1', data: {}}))
            .resolves.toMatchObject({response: {success: false, errorCode: 'model-unavailable', errorName: 'ChromeModelUnavailableError'}});
    });

    it('取消 active Chrome 翻译会立即响应一次，迟到结果不会再次提交', async () => {
        let resolveTranslation!: (value: string) => void;
        mocks.translate.mockImplementationOnce(() => new Promise<string>((resolve) => {
            resolveTranslation = resolve;
        }));
        const originalResponses = vi.fn();
        expect(listener({
            type: 'CHROME_TRANSLATE_OFFSCREEN',
            target: 'offscreen',
            requestId: 'chrome-pending',
            data: {text: 'hello', from: 'en', to: 'ja'},
        }, {}, originalResponses)).toBe(true);
        await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalledOnce());
        const signal = (mocks.translate.mock.calls as unknown[][])[0]?.[1] as AbortSignal;

        await expect(dispatch({
            type: 'CANCEL_CHROME_TRANSLATE_OFFSCREEN',
            requestId: 'chrome-pending',
        })).resolves.toEqual({
            handled: true,
            response: {success: true, cancelled: true, requestId: 'chrome-pending'},
        });
        expect(signal.aborted).toBe(true);
        expect(originalResponses).toHaveBeenCalledOnce();
        expect(originalResponses).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            cancelled: true,
            requestId: 'chrome-pending',
        }));

        resolveTranslation('迟到译文');
        await Promise.resolve();
        await Promise.resolve();
        expect(originalResponses).toHaveBeenCalledOnce();

        await expect(dispatch({
            type: 'CANCEL_CHROME_TRANSLATE_OFFSCREEN', requestId: 'chrome-pending',
        })).resolves.toEqual({
            handled: true,
            response: {success: true, cancelled: false, requestId: 'chrome-pending'},
        });
        expect((await dispatch({
            type: 'CANCEL_CHROME_TRANSLATE_OFFSCREEN', requestId: 'bad request',
        })).response).toMatchObject({success: false});
    });

    it('拒绝重复 active requestId 和非字符串 Chrome 翻译结果', async () => {
        let resolveTranslation!: (value: string) => void;
        mocks.translate.mockImplementationOnce(() => new Promise<string>((resolve) => {
            resolveTranslation = resolve;
        }));
        const firstResponse = vi.fn();
        const message = {
            type: 'CHROME_TRANSLATE_OFFSCREEN', target: 'offscreen', requestId: 'duplicate-1', data: {},
        };
        expect(listener(message, {}, firstResponse)).toBe(true);
        await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalledOnce());
        expect((await dispatch(message)).response).toEqual({
            success: false,
            error: 'Offscreen Chrome 翻译 requestId 正在执行',
        });

        resolveTranslation('完成');
        await vi.waitFor(() => expect(firstResponse).toHaveBeenCalledOnce());
        mocks.translate.mockResolvedValueOnce(null as never);
        await expect(dispatch({...message, requestId: 'invalid-result'})).resolves.toEqual({
            handled: true,
            response: {success: false, requestId: 'invalid-result', error: 'Chrome 翻译结果无效'},
        });
    });

    it('图片操作校验 data:image 与源语言后才进入 Offscreen 服务', async () => {
        for (const message of [
            {type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', image: null, sourceLanguage: 'en'},
            {type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', image: ' ', sourceLanguage: 'en'},
            {type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', image: 'data:image/png,x', sourceLanguage: ' '},
            {type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', image: 'data:image/png,x', sourceLanguage: 'bad!'},
            {type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', image: 'https://host/image.png', sourceLanguage: 'en'},
        ]) {
            expect((await dispatch(message)).response).toMatchObject({success: false});
        }
        expect(mocks.translateImage).not.toHaveBeenCalled();
    });

    it('图片翻译规范化缺省 title 并校验结果对象', async () => {
        await expect(dispatch({
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', requestId: 'image-translate-1',
            image: 'data:image/png,image', sourceLanguage: 'en',
        })).resolves.toEqual({handled: true, response: {success: true, image: 'translated', lines: []}});
        expect(mocks.translateImage).toHaveBeenCalledWith(
            'data:image/png,image', 'en', '', expect.any(AbortSignal), 'image-translate-1',
        );
        await dispatch({
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', requestId: 'image-translate-2',
            image: 'data:image/png,image', sourceLanguage: 'en', title: 'Page',
        });
        expect(mocks.translateImage).toHaveBeenLastCalledWith(
            'data:image/png,image', 'en', 'Page', expect.any(AbortSignal), 'image-translate-2',
        );

        expect((await dispatch({
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', image: 'data:image/png,image', sourceLanguage: 'en', title: 1,
        })).response).toEqual({success: false, error: 'Offscreen title 必须是字符串'});
        mocks.translateImage.mockResolvedValueOnce([] as never);
        expect((await dispatch({
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', image: 'data:image/png,image', sourceLanguage: 'en',
        })).response).toEqual({success: false, error: '图片翻译结果无效'});
        mocks.translateImage.mockResolvedValueOnce({image: 'safe', lines: [], success: false} as never);
        expect((await dispatch({
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN', image: 'data:image/png,image', sourceLanguage: 'en',
        })).response).toEqual({image: 'safe', lines: [], success: true});
    });

    it('跨域图片读取只在 Offscreen 中接收 URL，并返回受校验的 data URL', async () => {
        await expect(dispatch({
            type: 'FLUENT_READ_IMAGE_FETCH_OFFSCREEN',
            requestId: 'image-fetch-1',
            url: 'https://pbs.twimg.com/media/demo.png?format=png',
        })).resolves.toEqual({
            handled: true,
            response: {success: true, image: 'data:image/png;base64,remote'},
        });
        expect(mocks.fetchImage).toHaveBeenCalledWith(
            'https://pbs.twimg.com/media/demo.png?format=png',
            expect.any(AbortSignal),
        );

        for (const url of [undefined, '', 1]) {
            expect((await dispatch({
                type: 'FLUENT_READ_IMAGE_FETCH_OFFSCREEN',
                url,
            })).response).toMatchObject({success: false});
        }
        mocks.fetchImage.mockResolvedValueOnce('not-an-image');
        await expect(dispatch({
            type: 'FLUENT_READ_IMAGE_FETCH_OFFSCREEN',
            url: 'https://pbs.twimg.com/media/demo.png',
        })).resolves.toEqual({handled: true, response: {success: false, error: '远程图片结果无效'}});
    });

    it('区域翻译验证六个有限坐标和正尺寸', async () => {
        const selection = {left: 0, top: 1, width: 2, height: 3, viewportWidth: 100, viewportHeight: 80};
        await expect(dispatch({
            type: 'FLUENT_READ_AREA_TRANSLATE_OFFSCREEN',
            image: 'data:image/png,image',
            sourceLanguage: 'auto',
            title: 'Area',
            selection,
            requestId: 'area-translate-1',
        })).resolves.toEqual({handled: true, response: {success: true, image: 'area', lines: []}});
        expect(mocks.translateArea).toHaveBeenCalledWith(
            'data:image/png,image', 'auto', 'Area', selection, expect.any(AbortSignal), 'area-translate-1',
        );

        expect((await dispatch({
            type: 'FLUENT_READ_AREA_TRANSLATE_OFFSCREEN', image: 'data:image/png,image', sourceLanguage: 'en', selection: null,
        })).response).toEqual({success: false, error: 'Offscreen selection 必须是对象'});
        for (const field of Object.keys(selection)) {
            const invalid = {...selection, [field]: Number.NaN};
            expect((await dispatch({
                type: 'FLUENT_READ_AREA_TRANSLATE_OFFSCREEN', image: 'data:image/png,image', sourceLanguage: 'en', selection: invalid,
            })).response).toEqual({success: false, error: `Offscreen selection.${field} 必须是有限数字`});
        }
        for (const invalid of [
            {...selection, left: -1},
            {...selection, top: -1},
            {...selection, width: 0},
            {...selection, height: 0},
            {...selection, viewportWidth: 0},
            {...selection, viewportHeight: 0},
        ]) {
            expect((await dispatch({
                type: 'FLUENT_READ_AREA_TRANSLATE_OFFSCREEN', image: 'data:image/png,image', sourceLanguage: 'en', selection: invalid,
            })).response).toEqual({success: false, error: 'Offscreen selection 尺寸无效'});
        }
        mocks.translateArea.mockResolvedValueOnce(null as never);
        expect((await dispatch({
            type: 'FLUENT_READ_AREA_TRANSLATE_OFFSCREEN', image: 'data:image/png,image', sourceLanguage: 'en', selection,
        })).response).toEqual({success: false, error: '区域翻译结果无效'});
    });

    it('区域 crop-only 路由校验并传递 requestId', async () => {
        const selection = {left: 0, top: 1, width: 2, height: 3, viewportWidth: 100, viewportHeight: 80};
        await expect(dispatch({type: 'FLUENT_READ_AREA_CROP_OFFSCREEN', image: 'data:image/png,image', selection, requestId: 'crop-1'}))
            .resolves.toEqual({handled: true, response: {success: true, image: 'crop', lines: []}});
        expect(mocks.cropArea).toHaveBeenCalledWith('data:image/png,image', selection, expect.any(AbortSignal), 'crop-1');
        await expect(dispatch({type: 'FLUENT_READ_AREA_CROP_OFFSCREEN', image: 'data:image/png,image', selection: null})).resolves
            .toMatchObject({response: {success: false}});
    });

    it('OCR 下载拒绝非数组和未知语言，并去重有效语言', async () => {
        await expect(dispatch({type: 'FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN', languages: ['eng', 'eng', 'jpn']}))
            .resolves.toEqual({handled: true, response: {success: true}});
        expect(mocks.downloadOcrLanguages).toHaveBeenCalledWith(['eng', 'jpn']);
        expect((await dispatch({type: 'FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN', languages: null})).response)
            .toEqual({success: false, error: 'Offscreen OCR languages 必须是非空数组'});
        expect((await dispatch({type: 'FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN', languages: []})).response)
            .toEqual({success: false, error: 'Offscreen OCR languages 必须是非空数组'});
        expect((await dispatch({type: 'FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN', languages: ['unsupported']})).response)
            .toEqual({success: false, error: 'Offscreen OCR languages 包含不支持的语言'});
        expect((await dispatch({type: 'FLUENT_READ_IMAGE_OCR_DOWNLOAD_OFFSCREEN', languages: [1]})).response)
            .toEqual({success: false, error: 'Offscreen OCR languages 包含不支持的语言'});
    });

    it('取消 active 图片操作会中止 Worker signal，迟到结果不会再次响应', async () => {
        let resolveRecognition!: (value: {image: string; lines: []}) => void;
        mocks.translateImage.mockImplementationOnce(() => new Promise(resolve => {
            resolveRecognition = resolve;
        }));
        const originalResponses = vi.fn();
        expect(listener({
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN',
            target: 'offscreen',
            requestId: 'image-pending',
            image: 'data:image/png,x',
            sourceLanguage: 'en',
        }, {}, originalResponses)).toBe(true);
        await vi.waitFor(() => expect(mocks.translateImage).toHaveBeenCalledOnce());
        const signal = (mocks.translateImage.mock.calls as unknown[][])[0]?.[3] as AbortSignal;

        await expect(dispatch({
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN',
            requestId: 'image-pending',
            image: 'data:image/png,x',
            sourceLanguage: 'en',
        })).resolves.toEqual({
            handled: true,
            response: {success: false, error: 'Offscreen 图片 requestId 正在执行'},
        });

        await expect(dispatch({
            type: OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
            requestId: 'image-pending',
        })).resolves.toEqual({
            handled: true,
            response: {success: true, cancelled: true, requestId: 'image-pending'},
        });
        expect(signal.aborted).toBe(true);
        expect(originalResponses).toHaveBeenCalledOnce();
        expect(originalResponses).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            cancelled: true,
            requestId: 'image-pending',
        }));

        resolveRecognition({image: 'late', lines: []});
        await Promise.resolve();
        expect(originalResponses).toHaveBeenCalledOnce();
    });

    it('Offscreen 取消图片翻译时向 background 终止同 requestId 的 provider 子请求', async () => {
        let resolveTextMessage!: (response: unknown) => void;
        const sendMessage = vi.fn((message: {type: string}, callback: (response: unknown) => void) => {
            if (message.type === 'fluentReadImageTranslateTexts') resolveTextMessage = callback;
            else callback({success: true});
        });
        vi.stubGlobal('chrome', {runtime: {sendMessage, lastError: undefined}});
        const controller = new AbortController();
        const pending = translateImageTextsInExtension(
            ['hello'], 'Page', 'image-provider-pending', controller.signal,
        );
        expect(sendMessage).toHaveBeenCalledWith({
            type: 'fluentReadImageTranslateTexts',
            texts: ['hello'],
            title: 'Page',
            requestId: 'image-provider-pending',
            timeoutMs: 120_000,
        }, expect.any(Function));

        controller.abort();

        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).toHaveBeenLastCalledWith({
            type: 'fluentReadImageCancel',
            requestId: 'image-provider-pending',
        }, expect.any(Function));
        resolveTextMessage({success: true, translations: ['迟到译文']});
        await Promise.resolve();
    });

    it('Offscreen cancel 先到时拒绝后到的同 requestId 图片操作，不启动 Worker', async () => {
        await expect(dispatch({
            type: OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
            requestId: 'offscreen-cancelled-before-start',
        })).resolves.toEqual({
            handled: true,
            response: {success: true, cancelled: false, requestId: 'offscreen-cancelled-before-start'},
        });

        await expect(dispatch({
            type: 'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN',
            requestId: 'offscreen-cancelled-before-start',
            image: 'data:image/png,x',
            sourceLanguage: 'en',
        })).resolves.toEqual({
            handled: true,
            response: {
                success: false,
                cancelled: true,
                requestId: 'offscreen-cancelled-before-start',
                error: '图片 OCR 请求已取消',
            },
        });
        expect(mocks.translateImage).not.toHaveBeenCalled();
    });

    it('Offscreen 图片取消严格校验 ID，并有界保存重复的 cancel-before-start', async () => {
        await expect(dispatch({
            type: OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
            requestId: 'bad request',
        })).resolves.toEqual({
            handled: true,
            response: {success: false, error: 'Offscreen requestId 格式无效'},
        });

        const localListener = createOffscreenMessageListener({
            translate: mocks.translate,
            ttsPlayer: {play: mocks.play, stop: mocks.stop},
            fetchImage: mocks.fetchImage,
            translateImage: mocks.translateImage,
            translateArea: mocks.translateArea,
            downloadOcrLanguages: mocks.downloadOcrLanguages,
        });
        const cancel = (requestId: string) => {
            const response = vi.fn();
            expect(localListener({
                type: OFFSCREEN_CANCEL_IMAGE_OPERATION_MESSAGE_TYPE,
                target: 'offscreen',
                requestId,
            }, {}, response)).toBe(true);
            expect(response).toHaveBeenCalledOnce();
        };

        cancel('repeat-before-start');
        cancel('repeat-before-start');
        for (let index = 0; index <= 512; index += 1) cancel(`bounded-offscreen-${index}`);

    });

    it('模型调用受理校验字段后同步回执 accepted，并把执行转交宿主', async () => {
        const modelCall = {start: vi.fn(), cancel: vi.fn()};
        const handler = createOffscreenMessageListener({
            ...mocks, ttsPlayer: {play: mocks.play, stop: mocks.stop}, modelCall,
        });
        const request = {
            type: MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
            requestId: 'model-call-router-1',
            service: 'openai',
            model: 'gpt-test',
            kind: 'generate',
            config: {token: {}},
            options: {prompt: []},
        };
        await expect(dispatch(request, handler)).resolves.toEqual({
            handled: true,
            response: {accepted: true, requestId: 'model-call-router-1'},
        });
        expect(modelCall.start).toHaveBeenCalledWith({
            type: MODEL_CALL_START_OFFSCREEN_MESSAGE_TYPE,
            requestId: 'model-call-router-1',
            service: 'openai',
            model: 'gpt-test',
            kind: 'generate',
            config: {token: {}},
            options: {prompt: []},
        });

        await expect(dispatch({...request, kind: 'stream', requestId: 'model-call-router-2'}, handler))
            .resolves.toEqual({handled: true, response: {accepted: true, requestId: 'model-call-router-2'}});
        expect(modelCall.start).toHaveBeenCalledTimes(2);

        for (const invalid of [
            {requestId: ' '}, {requestId: 1}, {service: ''}, {model: null}, {kind: 'gen'},
            {options: null}, {options: []}, {config: null}, {config: 'x'},
        ]) {
            expect((await dispatch({...request, ...invalid}, handler)).response)
                .toMatchObject({success: false, error: expect.any(String)});
        }
        expect(modelCall.start).toHaveBeenCalledTimes(2);
        // 宿主未装配时给出明确不可用回执，不占死消息通道。
        await expect(dispatch(request)).resolves.toMatchObject({
            handled: true,
            response: {success: false, error: '模型调用未启用'},
        });
    });

    it('模型调用取消透传 requestId 并对宿主缺失幂等成功', async () => {
        const modelCall = {start: vi.fn(), cancel: vi.fn()};
        const handler = createOffscreenMessageListener({
            ...mocks, ttsPlayer: {play: mocks.play, stop: mocks.stop}, modelCall,
        });
        await expect(dispatch({type: MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE, requestId: 'model-call-router-1'}, handler))
            .resolves.toEqual({handled: true, response: {success: true}});
        expect(modelCall.cancel).toHaveBeenCalledWith('model-call-router-1');
        await expect(dispatch({type: MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE, requestId: ' '}, handler))
            .resolves.toEqual({handled: true, response: {success: false, error: 'Offscreen requestId 必须是非空字符串'}});
        // 对齐 VIDEO_AI_CANCEL 先例：宿主未装配时取消幂等成功。
        await expect(dispatch({type: MODEL_CALL_CANCEL_OFFSCREEN_MESSAGE_TYPE, requestId: 'model-call-router-1'}))
            .resolves.toEqual({handled: true, response: {success: true}});
    });
});

it('模型清除路由等待删除并阻止同时识别或重复清除', async () => {
 const base={...mocks,ttsPlayer:{play:mocks.play,stop:mocks.stop}};
 let release!:()=>void; const removeOcrLanguages=vi.fn(()=>new Promise<void>(resolve=>{release=resolve}));
 const handler=createOffscreenMessageListener({...base,removeOcrLanguages,videoAi:{prepare:vi.fn(),transcribe:vi.fn(),cancel:vi.fn(),removeModel:vi.fn(async()=>{})}});
 expect((await dispatch({type:'VIDEO_AI_REMOVE_MODEL'},handler)).response).toEqual({success:true});
 expect((await dispatch({type:'VIDEO_AI_REMOVE_MODEL'})).response).toMatchObject({success:false});
 expect((await dispatch({type:'FLUENT_READ_IMAGE_OCR_REMOVE_OFFSCREEN',languages:['eng']})).response).toMatchObject({success:false});
 const pending=dispatch({type:'FLUENT_READ_IMAGE_OCR_REMOVE_OFFSCREEN',languages:['eng']},handler);
 await vi.waitFor(()=>expect(removeOcrLanguages).toHaveBeenCalled());
 expect((await dispatch({type:'FLUENT_READ_IMAGE_OCR_REMOVE_OFFSCREEN',languages:['eng']},handler)).response).toMatchObject({success:false});
 expect((await dispatch({type:'FLUENT_READ_IMAGE_TRANSLATE_OFFSCREEN',image:'data:image/png;base64,AA==',sourceLanguage:'en'},handler)).response).toMatchObject({success:false,error:expect.stringContaining('清除')});
 release();expect((await pending).response).toEqual({success:true});
});

describe('Offscreen 本地模型可取消请求', () => {
    function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
        return {promise, resolve, reject};
    }
    const base = {...mocks, ttsPlayer: {play: mocks.play, stop: mocks.stop}};
    const ttsRequest = {type: 'LOCAL_TTS_SYNTHESIZE', requestId: 'tts-1', text: '你好', language: 'zh-CN', voice: 'zf_001'};
    const model = LOCAL_TRANSLATION_MODEL_IDS.m2m100;

    it('本地 TTS 未启用时所有入口返回明确不可用', async () => {
        for (const type of ['LOCAL_TTS_PREPARE', 'LOCAL_TTS_STATUS', 'LOCAL_TTS_REMOVE_MODEL', 'LOCAL_TTS_SYNTHESIZE']) {
            await expect(dispatch({type, requestId: 'x'}, createOffscreenMessageListener(base)))
                .resolves.toEqual({handled: true, response: {success: false, error: '本地 TTS 未启用'}});
        }
    });

    it('本地 TTS 模型管理透传结果并校验结果形状', async () => {
        const localTts = {
            synthesize: vi.fn(), prepare: vi.fn(async () => ({warm: true})),
            status: vi.fn(async () => ({models: []})), removeModel: vi.fn(async () => undefined),
        };
        const handler = createOffscreenMessageListener({...base, localTts});
        await expect(dispatch({type: 'LOCAL_TTS_PREPARE'}, handler)).resolves.toEqual({handled: true, response: {success: true, warm: true}});
        await expect(dispatch({type: 'LOCAL_TTS_STATUS'}, handler)).resolves.toEqual({handled: true, response: {success: true, models: []}});
        await expect(dispatch({type: 'LOCAL_TTS_REMOVE_MODEL'}, handler)).resolves.toEqual({handled: true, response: {success: true}});
        localTts.status.mockResolvedValueOnce('bad' as never);
        await expect(dispatch({type: 'LOCAL_TTS_STATUS'}, handler)).resolves.toEqual({handled: true, response: {success: false, error: '本地 TTS 模型状态结果无效'}});
        localTts.prepare.mockResolvedValueOnce(null as never);
        await expect(dispatch({type: 'LOCAL_TTS_PREPARE'}, handler)).resolves.toEqual({handled: true, response: {success: false, error: '本地 TTS 模型结果无效'}});
    });

    it('本地 TTS 合成校验参数、拒绝重复 requestId、保留错误码并支持取消', async () => {
        const pending = deferred<unknown>();
        const synthesize = vi.fn((_request: Record<string, unknown>, signal: AbortSignal) => {
            void signal;
            return pending.promise;
        });
        const handler = createOffscreenMessageListener({...base, localTts: {
            synthesize, prepare: vi.fn(), status: vi.fn(), removeModel: vi.fn(),
        }});

        for (const invalid of [{requestId: 'bad id'}, {text: ' '}, {language: ''}, {voice: 3}]) {
            const response = (await dispatch({...ttsRequest, ...invalid}, handler)).response;
            expect(response).toMatchObject({success: false, error: expect.any(String)});
        }
        const first = dispatch(ttsRequest, handler);
        await expect(dispatch(ttsRequest, handler)).resolves.toEqual({handled: true, response: {success: false, error: 'Offscreen 本地 TTS requestId 正在执行'}});
        const cancelType = OFFSCREEN_CANCEL_LOCAL_TTS_MESSAGE_TYPE;
        await expect(dispatch({type: cancelType, requestId: 'tts-1'}, handler))
            .resolves.toEqual({handled: true, response: {success: true, cancelled: true, requestId: 'tts-1'}});
        await expect(first).resolves.toEqual({handled: true, response: {success: false, cancelled: true, requestId: 'tts-1', error: '本地 TTS 请求已取消'}});
        // 取消后迟到的结果不能再次回复。
        pending.resolve({audio: new Uint8Array([1]).buffer});
        await expect(dispatch({type: cancelType, requestId: 'tts-1'}, handler))
            .resolves.toEqual({handled: true, response: {success: true, cancelled: false, requestId: 'tts-1'}});
        await expect(dispatch({type: cancelType, requestId: '??'}, handler))
            .resolves.toMatchObject({handled: true, response: {success: false}});

        synthesize.mockRejectedValueOnce(Object.assign(new Error('model missing'), {code: 'local-tts-model-not-downloaded'}));
        await expect(dispatch({...ttsRequest, requestId: 'tts-2'}, handler)).resolves.toEqual({handled: true, response: {
            success: false, error: 'model missing', errorCode: 'local-tts-model-not-downloaded', requestId: 'tts-2',
        }});
        synthesize.mockResolvedValueOnce({audio: 'not-binary'});
        await expect(dispatch({...ttsRequest, requestId: 'tts-3'}, handler)).resolves.toEqual({handled: true, response: {
            success: false, error: '本地 TTS 合成音频结果无效', errorCode: undefined, requestId: 'tts-3',
        }});
        const large = new Uint8Array(0x8000 * 2 + 3).map((_, index) => index % 251);
        synthesize.mockResolvedValueOnce({audio: new DataView(large.buffer, 1, large.length - 1), voice: 'zm_009'});
        const encoded = (await dispatch({...ttsRequest, requestId: 'tts-4'}, handler)).response as {audioBase64: string; voice: string};
        expect(encoded.voice).toBe('zm_009');
        expect(Buffer.from(encoded.audioBase64, 'base64')).toEqual(Buffer.from(large.subarray(1)));
    });

    it('本地翻译未启用、模型管理与可取消翻译共用同一回复纪律', async () => {
        await expect(dispatch({type: 'LOCAL_TRANSLATION_STATUS'}, createOffscreenMessageListener(base)))
            .resolves.toEqual({handled: true, response: {success: false, error: '本地翻译未启用'}});
        await expect(dispatch({type: 'LOCAL_TRANSLATION_PAUSE', model}, createOffscreenMessageListener(base)))
            .resolves.toEqual({handled: true, response: {success: false, error: 'LOCAL_TRANSLATION_UNAVAILABLE'}});
        for (const type of ['LOCAL_TRANSLATION_PREPARE', 'LOCAL_TRANSLATION_REMOVE_MODEL', 'LOCAL_TRANSLATION_TRANSLATE']) {
            await expect(dispatch({type, model}, createOffscreenMessageListener(base)))
                .resolves.toEqual({handled: true, response: {success: false, error: '本地翻译未启用'}});
        }

        const pending = deferred<unknown>();
        const localTranslation = {
            translate: vi.fn((_request: Record<string, unknown>, _signal: AbortSignal) => pending.promise),
            prepare: vi.fn(async () => ({downloaded: true})),
            status: vi.fn(async () => ({models: []})),
            pause: vi.fn(async () => ({paused: true})),
            removeModel: vi.fn(async () => undefined),
        };
        const handler = createOffscreenMessageListener({...base, localTranslation});
        await expect(dispatch({type: 'LOCAL_TRANSLATION_PREPARE', model}, handler)).resolves.toEqual({handled: true, response: {success: true, downloaded: true}});
        await expect(dispatch({type: 'LOCAL_TRANSLATION_PREPARE', model: 'unknown-model'}, handler)).resolves.toEqual({handled: true, response: {success: false, error: '本地翻译模型标识无效'}});
        await expect(dispatch({type: 'LOCAL_TRANSLATION_PAUSE', model}, handler)).resolves.toEqual({handled: true, response: {success: true, paused: true}});
        await expect(dispatch({type: 'LOCAL_TRANSLATION_STATUS'}, handler)).resolves.toEqual({handled: true, response: {success: true, models: []}});
        await expect(dispatch({type: 'LOCAL_TRANSLATION_REMOVE_MODEL', model}, handler)).resolves.toEqual({handled: true, response: {success: true}});
        expect(localTranslation.pause).toHaveBeenCalledWith({model});

        const request = {type: 'LOCAL_TRANSLATION_TRANSLATE', requestId: 'lt-1', model, text: 'hello', sourceLanguage: 'en', targetLanguage: 'zh-Hans'};
        for (const invalid of [{text: ''}, {sourceLanguage: 1}, {targetLanguage: ''}, {model: 'x'}, {sourceLanguageDetectionText: 5}]) {
            expect((await dispatch({...request, ...invalid}, handler)).response).toMatchObject({success: false});
        }
        const first = dispatch(request, handler);
        await expect(dispatch(request, handler)).resolves.toEqual({handled: true, response: {success: false, error: 'Offscreen 本地翻译 requestId 正在执行'}});
        pending.resolve('你好');
        await expect(first).resolves.toEqual({handled: true, response: {success: true, result: '你好', requestId: 'lt-1'}});

        localTranslation.translate.mockResolvedValueOnce(42 as never);
        await expect(dispatch({...request, requestId: 'lt-2', sourceLanguageDetectionText: 'hello'}, handler))
            .resolves.toEqual({handled: true, response: {success: false, error: '本地翻译结果无效', requestId: 'lt-2'}});
        localTranslation.translate.mockRejectedValueOnce('worker gone');
        await expect(dispatch({...request, requestId: 'lt-3'}, handler))
            .resolves.toEqual({handled: true, response: {success: false, error: 'worker gone', requestId: 'lt-3'}});
    });
});
