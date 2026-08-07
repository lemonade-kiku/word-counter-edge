// 选中字数统计 — 内容脚本
// 鼠标左键（或键盘 Shift+方向键）选中文本后，在选区附近弹出悬浮窗显示字数 / 词数 / 字符数
(() => {
  'use strict';

  console.log('[选中字数统计] 内容脚本已注入');

  const TIP_ID = 'wc-count-tip';
  let tip = null;

  /* ---------------- 统计 ---------------- */
  function countText(text) {
    const total = text.length;                                   // 字符数（含空格）
    const noSpace = text.replace(/\s+/g, '').length;             // 字符数（不含空格）
    const cjk = (text.match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length; // 汉字数
    const latin = (text.match(/[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*/g) || []).length; // 英文单词数
    return { total, noSpace, cjk, latin, words: cjk + latin };   // 词数 = 汉字 + 英文单词
  }

  /* ---------------- 获取选中内容 ---------------- */
  function getSelection() {
    // 输入框 / 文本域中的选中（如搜索框、评论框）
    const el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' && /^(text|search|url|email|password|tel|number)$/.test(el.type)))) {
      const s = el.selectionStart;
      const e = el.selectionEnd;
      if (typeof s === 'number' && typeof e === 'number' && e > s) {
        const text = el.value.slice(s, e).trim();
        if (text) return { text, rect: el.getBoundingClientRect() };
        return null;
      }
    }
    // 普通页面文本
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    let text = '';
    for (let i = 0; i < sel.rangeCount; i++) text += sel.getRangeAt(i).toString();
    text = text.trim();
    if (!text) return null;
    let rect = null;
    if (sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width > 0 || r.height > 0) rect = r;
    }
    return { text, rect };
  }

  /* ---------------- 悬浮窗 ---------------- */
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = TIP_ID;
    tip.setAttribute('aria-hidden', 'true');
    tip.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'pointer-events:none',
      'user-select:none',
      'display:none',
      'padding:8px 12px',
      'border-radius:8px',
      'border:1px solid rgba(255,255,255,.18)',
      'background:rgba(28,28,32,.96)',
      'color:#f2f2f2',
      'font:12px/1.5 "Microsoft YaHei", system-ui, sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)',
      'white-space:nowrap'
    ].join(';');
    document.documentElement.appendChild(tip);
    return tip;
  }

  function hideTip() {
    if (tip) tip.style.display = 'none';
  }

  function showTip(sel, mouseX, mouseY) {
    const s = countText(sel.text);
    const el = ensureTip();
    el.innerHTML =
      '<div>字数 <b>' + s.noSpace + '</b> · 词数 <b>' + s.words + '</b></div>' +
      '<div style="opacity:.75;margin-top:2px">字符 ' + s.total +
      '（含空格）· 汉字 ' + s.cjk + ' · 英文单词 ' + s.latin + '</div>';
    // 先显示再测量：display:none 时 offsetWidth/offsetHeight 为 0，会导致定位不准
    el.style.display = 'block';

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x;
    let y;
    if (sel.rect) {
      // 优先显示在选区上方
      const r = sel.rect;
      x = r.left + r.width / 2 - el.offsetWidth / 2;
      y = r.top - el.offsetHeight - 10;
      if (y < 8) y = Math.min(r.bottom + 10, vh - el.offsetHeight - 8);
    } else {
      // 兜底：显示在鼠标位置附近
      x = mouseX + 14;
      y = mouseY + 14;
    }
    x = Math.min(Math.max(x, 8), vw - el.offsetWidth - 8);
    y = Math.min(Math.max(y, 8), vh - el.offsetHeight - 8);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  /* ---------------- 事件 ---------------- */
  // 鼠标按下（开始新选择 / 点击页面其他位置）时收起
  document.addEventListener('mousedown', hideTip, true);
  // 鼠标左键选中完成后弹出
  document.addEventListener('mouseup', (e) => {
    const sel = getSelection();
    if (!sel) { hideTip(); return; }
    showTip(sel, e.clientX, e.clientY);
  }, true);
  // 键盘选择（Shift + 方向键、Ctrl + A 等）
  document.addEventListener('keyup', (e) => {
    if (!(e.key === 'Shift' || e.key === 'Control' ||
          /^Arrow|^Home$|^End$|^Page/.test(e.key))) return;
    const sel = getSelection();
    if (!sel) { hideTip(); return; }
    showTip(sel, 0, 0);
  }, true);
  // 页面滚动 / 窗口缩放时收起，避免悬浮窗停留在错误位置
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);
})();
