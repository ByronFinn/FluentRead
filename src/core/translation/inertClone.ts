/**
 * @file src/core/translation/inertClone.ts
 *
 * 文件职责：在没有浏览上下文的文档中复制翻译来源元素，避免为了读取骨架而在实时文档中深拷贝资源节点。
 * 主要内容：按来源 ownerDocument 弱缓存浅复制的空文档，通过 importNode 保留元素命名空间、原始属性和指定深度的子节点。
 * 副本只供读取文本与序列化骨架；相对地址保持属性原文，由展示层沿用实时页面的地址解析，不在空文档中补写 base。
 * 模块边界：不挂载来源或返回元素、不修改宿主策略、不净化内容、不访问配置或网络，也不缓存宿主元素或读取窗口地址。
 */

const documents = new WeakMap<Document, Document>();

/** 默认返回独立深副本；只保留地址属性原文，副本的 baseURI 与已解析地址不属于快照契约。 */
export function cloneTranslationElementInert<T extends Element>(source: T, deep = true): T {
    const owner = source.ownerDocument;
    let document = documents.get(owner);
    if (!document) {
        // 只浅复制 Document，不经过实时文档中任何 IMG、媒体或其它来源子树。
        document = owner.cloneNode(false) as Document;
        // 即使没有浏览上下文，补写 base 仍可能触发来源继承的 base-uri CSP；空文档保持为空。
        documents.set(owner, document);
        // 已惰性的副本再次取快照时继续复用，不形成一串中间文档。
        documents.set(document, document);
    }
    return document.importNode(source, deep);
}
