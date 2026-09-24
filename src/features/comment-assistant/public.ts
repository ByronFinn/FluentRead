/**
 * @file src/features/comment-assistant/public.ts
 * 文件职责：向划词卡片、设置页与组合根导出评论功能的稳定公共入口。
 * 主要内容：评论面板组件、请求客户端、选区图片捕获与可序列化类型契约。
 * 模块边界：只做静态导出，不注册事件、不初始化模型，也不持有页面选区所有权。
 */
export {default as CommentPanel} from './ui/CommentPanel.vue';
export {requestComments} from './client';
export {captureCommentImages} from './selectionImages';
export {browserSelectionImageDeps} from './content/imageDeps';
export type {CommentItem, CommentRequest, CommentResponse} from './types';
