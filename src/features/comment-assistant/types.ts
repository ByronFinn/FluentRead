/**
 * @file src/features/comment-assistant/types.ts
 * 文件职责：声明划词评论面板与后台之间可序列化的请求与结果契约。
 * 主要内容：选区文本与 data URL 图片、按请求标识的运行与取消消息、评论条目结构及成功失败联合。
 * 模块边界：这里只定义类型；捕获、模型调用与展示分别由 selectionImages、services/comment 与 UI 负责。
 */

export interface CommentItem {
    content: string;
    translation: string | null;
}

export interface CommentRequest {
    type: 'fluentReadComment';
    action: 'run';
    requestId: string;
    text: string;
    images: string[];
}

export interface CommentCancelRequest {
    type: 'fluentReadComment';
    action: 'cancel';
    requestId: string;
}

export type CommentResponse =
    | {success: true; comments: CommentItem[]}
    | {success: false; error: string; cancelled?: boolean};

export type CommentStreamMessage = {type: 'result'; requestId: string; response: CommentResponse};
