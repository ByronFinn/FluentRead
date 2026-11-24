/**
 * @file src/features/vocabulary/content/readingText.ts
 * 文件职责：只读收集网页与开放 Shadow DOM 的可读正文，将收藏命中转为原生文字范围。
 * 主要内容：以可关闭的工作迭代器收集正文、按需匹配并用二分定位相交文本段；保留块、换行、Shadow 与保护边界，空索引不读取页面，几何在首个有效矩形停止。
 * 模块边界：不包裹或替换原文，不注册监听、不调用模型、不持久化遇见；调用方拥有范围、绘制样式与观察器生命周期。
 */
import {iterateExpressionMatches, reencounterSentence, type ExpressionIndex, type ReencounterEntry} from '../domain/reencounter';

interface TextRun {node: Text; start: number; end: number}
interface TextGroup {text: string; runs: TextRun[]; root: Document | ShadowRoot}
interface ReadingFrame {next: Node | null; assigned?: Node[]; offset: number; endGroup: boolean}
export interface ReencounterOccurrence {entry: ReencounterEntry; sentence: string; ranges: Range[]; root: Document | ShadowRoot}
export interface ReadingScan {occurrences: ReencounterOccurrence[]; roots: Array<Document | ShadowRoot>}
const excluded = 'script,style,noscript,template,textarea,input,select,button,a,[role="button"],[role="link"],[role="textbox"],pre,code,kbd,svg,math,mjx-container,.katex,[hidden],[inert],[aria-hidden="true"],[translate="no"],[contenteditable]:not([contenteditable="false"]),[data-fr-translation-owned="true"],[data-fluent-read-ui],[id^="fluent-read-"]';
const blocks = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BODY|DD|DETAILS|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|TABLE|TD|TH|TR|UL)$/u;

function* collectReadingGroupsWork(document: Document, onRoot?: (root: ShadowRoot) => void): Generator<undefined, {groups: TextGroup[]; roots: Array<Document | ShadowRoot>}> {
  const groups: TextGroup[] = [];
  const roots: Array<Document | ShadowRoot> = [document];
  const view = document.defaultView!;
  let current: TextGroup | undefined;
  // 每层只保留下一个兄弟游标，不复制整层 childNodes，也不使用 JS 调用栈。
  const stack: ReadingFrame[] = document.body ? [{next: document.body, offset: 0, endGroup: false}] : [];
  while (stack.length) {
    yield undefined;
    const frame = stack[stack.length - 1];
    const node = frame.next;
    if (!node) {
      stack.pop();
      if (frame.endGroup) current = undefined;
      continue;
    }
    frame.next = frame.assigned ? frame.assigned[++frame.offset] ?? null : stack.length === 1 ? null : node.nextSibling;
    if (node.nodeType === 3) {
      const text = (node as Text).data;
      if (!text) continue;
      const root = node.getRootNode() as Document | ShadowRoot;
      if (current?.root !== root) current = undefined;
      if (!current) { current = {text: '', runs: [], root}; groups.push(current); }
      const start = current.text.length;
      current.text += text;
      current.runs.push({node: node as Text, start, end: current.text.length});
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as HTMLElement;
    if (element.matches(excluded)) { current = undefined; continue; }
    const blockTag = blocks.test(element.tagName);
    if (blockTag && element !== document.body) {
      const box = element.getBoundingClientRect(); const height = view.innerHeight;
      if (box.bottom < -height || box.top > height * 2) { current = undefined; continue; }
    }
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') { current = undefined; continue; }
    const block = blockTag || !['inline', 'contents', 'inline-block', 'inline-flex', 'inline-grid'].includes(style.display);
    if (block || element.tagName === 'BR') current = undefined;
    const shadow = element.shadowRoot;
    let next: Node | null = element.firstChild;
    let assigned: Node[] | undefined;
    if (shadow) {
      current = undefined; roots.push(shadow); next = shadow.firstChild;
      onRoot?.(shadow);
    } else if (element.tagName === 'SLOT' && (element as HTMLSlotElement).assignedNodes) {
      const projected = (element as HTMLSlotElement).assignedNodes({flatten: true});
      if (projected.length) {assigned = projected; next = assigned[0];}
    }
    stack.push({next, assigned, offset: 0, endGroup: block || Boolean(shadow)});
  }
  return {groups, roots};
}

/** 每个检查点允许调用方让出执行权；结果全部完成后才交付，关闭迭代器会释放未绘制的分组与范围。 */
export function* scanReadingExpressionsWork(document: Document, entries: readonly ReencounterEntry[], index: ExpressionIndex, onRoot?: (root: ShadowRoot) => void): Generator<undefined, ReadingScan> {
  if (!entries.length || index.nodes.length === 1) return {occurrences: [], roots: [document]};
  const {groups, roots} = yield* collectReadingGroupsWork(document, onRoot);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const occurrences: ReencounterOccurrence[] = [];
  const height = document.defaultView!.innerHeight;
  for (const group of groups) {
    for (const match of iterateExpressionMatches(group.text, index)) {
      yield undefined;
      if (!match) continue;
      const ranges: Range[] = [];
      let low = 0; let high = group.runs.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (group.runs[middle].end <= match.start) low = middle + 1; else high = middle;
      }
      for (let cursor = low; cursor < group.runs.length && group.runs[cursor].start < match.end; cursor += 1) {
        yield undefined;
        const run = group.runs[cursor];
        const start = Math.max(match.start, run.start);
        const end = Math.min(match.end, run.end);
        const range = document.createRange();
        range.setStart(run.node, start - run.start); range.setEnd(run.node, end - run.start);
        ranges.push(range);
      }
      let visible = false;
      for (const range of ranges) {
        for (const rect of range.getClientRects()) {
          yield undefined;
          if (rect.height > 0 && rect.width > 0 && rect.bottom >= -height && rect.top <= height * 2) {visible = true; break;}
        }
        if (visible) break;
      }
      if (!visible) continue;
      occurrences.push({entry: byId.get(match.entryId)!, sentence: reencounterSentence(group.text, match.start, match.end), ranges, root: group.root});
      if (occurrences.length >= 300) break;
    }
    if (occurrences.length >= 300) break;
  }
  return {occurrences, roots};
}
