'use strict';

// Bing 的宿主脚本会在鼠标经过结果时把跟踪跳转改为直链。只在普通 Bing
// 搜索页解码已观察的 a1 + base64 URL 格式，原始 href 仍保留在浏览器证据中。
// 其它站点、路径、协议或目标变化继续使用严格相等，不能泛化为忽略链接变化。
function interactionHrefsEquivalent(before, after, pageUrl) {
  if (before === after) return true;
  let page;
  try {page = new URL(pageUrl);} catch {return false;}
  if (page.protocol !== 'https:' || page.hostname !== 'www.bing.com' || page.pathname !== '/search') return false;
  const destination = href => {
    try {
      const url = new URL(href);
      if (url.origin !== 'https://www.bing.com' || url.pathname !== '/ck/a') return href;
      const encoded = url.searchParams.get('u');
      if (!/^a1[A-Za-z0-9_+/=-]+$/u.test(encoded || '')) return href;
      const decoded = Buffer.from(encoded.slice(2), 'base64').toString('utf8');
      const target = new URL(decoded);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return href;
      return target.href;
    } catch {return href;}
  };
  return destination(before) === destination(after);
}

module.exports = {interactionHrefsEquivalent};
