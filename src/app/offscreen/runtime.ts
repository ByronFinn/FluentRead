/**
 * @file src/app/offscreen/runtime.ts
 * 文件职责：作为 Chrome Offscreen 与 Firefox 后台 iframe 共用 DOM 页面的组合根，创建独占 TTS 播放器并安装一次 runtime 消息监听，把浏览器资源适配给各离屏用例。
 * 主要内容：将 base64 音频解码为 Uint8Array，注入 Audio、Blob URL 创建/释放和状态回传，组合 Chrome Translation、OCR、图片/区域翻译与语言包下载依赖，装配 Harness 模型调用执行宿主（直连工厂 + chrome.runtime 事件推送 + 心跳定时器），注册 message listener。
 * 模块边界：本文件只负责 Web API 资源与用例装配，不解析业务消息、不实现 OCR/翻译，也不创建 Offscreen document；两种浏览器容器的文档生命周期均由 platform/offscreen client 和 WXT 入口管理。
 */
import {
    downloadImageOcrLanguages,
    removeImageOcrLanguages,
    fetchImageInOffscreen,
    translateAreaInOffscreen,
    cropAreaInOffscreen,
    translateImageInOffscreen,
} from './imageTranslation';
import {createOffscreenMessageListener} from './messageRouter';
import {createModelExecutorHost} from './modelExecutorHost';
import {createSelectionTtsPlayer} from './ttsPlayback';
import {translateWithChromeApi, type ChromeTranslationEnvironment} from './translation';
import {createHarnessLanguageModelDirect} from '@/src/services/harness/modelGateway';
import {removeLocalVideoTranscriptionModel, cancelLocalVideoTranscription, prepareLocalVideoTranscriptionModel, transcribeLocalVideoAudio} from '@/src/features/video-subtitle/offscreen/transcription';
import {
    disposeLocalTtsWorker,
    getLocalTtsModelStatus,
    prepareLocalTtsModel,
    removeLocalTtsModel,
    synthesizeLocalTts,
} from '@/src/features/local-tts/offscreen/tts';
import {
    disposeLocalTranslationWorker,
    configureLocalTranslationDownloadNotifications,
    pauseLocalTranslationModelDownload,
    getLocalTranslationModelStatus,
    prepareLocalTranslationModel,
    removeLocalTranslationModel,
    translateLocalText,
} from '@/src/features/local-translation/offscreen/translation';

function decodeAudioBase64(audioBase64: string): Uint8Array {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** 组装 Offscreen 的实验 API、Audio/Blob 和图片 OCR 浏览器能力。 */
export function startOffscreenApp(): void {
    configureLocalTranslationDownloadNotifications((snapshot) => new Promise<void>((resolve) => {
        chrome.runtime.sendMessage({type: 'fluentReadLocalTranslationDownloadProgress', snapshot}, () => {
            void chrome.runtime.lastError;
            resolve();
        });
    }));
    const ttsPlayer = createSelectionTtsPlayer({
        createAudio: () => new Audio(),
        decodeBase64: decodeAudioBase64,
        createObjectUrl: (bytes, contentType) => URL.createObjectURL(new Blob([bytes], {type: contentType})),
        revokeObjectUrl: (url) => URL.revokeObjectURL(url),
        notify: (request, state, error) => {
            void chrome.runtime.sendMessage({
                type: 'selectionTtsPlaybackState',
                tabId: request.tabId,
                clientRequestId: request.clientRequestId,
                state,
                error: error instanceof Error ? error.message : error ? String(error) : undefined,
            }, () => {
                // Firefox 的 chrome 命名空间只提供 callback；两种容器共用此通知路径。
                void chrome.runtime.lastError;
            });
        },
    });
    // 模型调用宿主必须注入直连工厂：Offscreen 内再走带代理切换的入口会把调用代理回
    // 后台、形成递归；事件推送用默认实现（chrome.runtime.sendMessage，宿主内吞错）。
    const modelCall = createModelExecutorHost({createModel: createHarnessLanguageModelDirect});
    const listener = createOffscreenMessageListener({
        translate: (data, signal) => translateWithChromeApi(data, self as ChromeTranslationEnvironment, signal),
        ttsPlayer,
        translateImage: translateImageInOffscreen,
        translateArea: translateAreaInOffscreen,
        cropArea: cropAreaInOffscreen,
        fetchImage: fetchImageInOffscreen,
        downloadOcrLanguages: downloadImageOcrLanguages,
        removeOcrLanguages: removeImageOcrLanguages,
        videoAi: {
            transcribe: (request) => transcribeLocalVideoAudio(request as any),
            prepare: (request) => prepareLocalVideoTranscriptionModel(request.model, {keepWarm: request.keepWarm === true, streamId: request.streamId}),
            cancel: cancelLocalVideoTranscription,
            removeModel: request => removeLocalVideoTranscriptionModel(request.model),
        },
        localTranslation: {
            translate: (request, signal) => translateLocalText(request as any, signal),
            prepare: (request) => prepareLocalTranslationModel(request.model),
            pause: (request) => pauseLocalTranslationModelDownload(request.model),
            status: getLocalTranslationModelStatus,
            removeModel: request => removeLocalTranslationModel(request.model),
            dispose: disposeLocalTranslationWorker,
        },
        localTts: {
            synthesize: (request, signal) => synthesizeLocalTts(
                String(request.text || ''),
                String(request.language || ''),
                request.voice,
                signal,
            ),
            prepare: (request) => prepareLocalTtsModel(request.keepWarm === true),
            status: getLocalTtsModelStatus,
            removeModel: async () => { await removeLocalTtsModel(); },
            dispose: disposeLocalTtsWorker,
        },
        modelCall,
    });

    chrome.runtime.onMessage.addListener(listener);
    window.addEventListener('pagehide', () => {
        ttsPlayer.dispose();
        disposeLocalTranslationWorker();
        disposeLocalTtsWorker();
        // 模型调用宿主无需在此清理：执行器只持有心跳定时器与在途 AbortController，
        // 二者随页面终止；后台代理对“接收端消失”另有本地超时/取消兜底。
    }, {once: true});
}
