// 选中字数统计 — 内容脚本
// 按住 Shift + 鼠标左键拖选文本（或键盘 Shift+方向键 / Ctrl+A）后，
// 在选区附近弹出悬浮窗显示字数 / 词数 / 字符数；普通拖选不触发
// 悬浮窗内置"论文审查"按钮：把选中文本经 background 转发到本地桥接服务，
// 由 Claude Code CLI 按论文写作规范审查，结果回显在悬浮窗内
(() => {
  'use strict';

  console.log('[选中字数统计] 内容脚本已注入');

  const TIP_ID = 'wc-count-tip';
  const MAX_TEXT_LEN = 6000; // 与 bridge.js 保持一致
  let tip = null;
  let reviewPending = false; // 审查进行中：悬浮窗保持显示，防止结果丢失

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
      'pointer-events:auto',
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
    if (reviewPending) return; // 审查期间不允许收起，保证结果可见
    if (tip) tip.style.display = 'none';
  }

  function showTip(sel, mouseX, mouseY) {
    const s = countText(sel.text);
    const el = ensureTip();
    // 记忆本次选中的文本，供"论文审查"按钮使用
    el.__wcText = sel.text;
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">' +
        '<div>' +
          '<div>字数 <b>' + s.noSpace + '</b> · 词数 <b>' + s.words + '</b></div>' +
          '<div style="opacity:.75;margin-top:2px">字符 ' + s.total +
          '（含空格）· 汉字 ' + s.cjk + ' · 英文单词 ' + s.latin + '</div>' +
        '</div>' +
        '<button id="wc-close-btn" title="关闭" style="background:none;border:none;color:rgba(255,255,255,.55);cursor:pointer;font:14px/1 system-ui;padding:0 2px">✕</button>' +
      '</div>' +
      '<div style="display:flex;gap:6px;margin-top:6px;align-items:center">' +
        '<button id="wc-review-btn" style="' + btnCss() + '">📝 论文审查</button>' +
      '</div>' +
      '<div id="wc-status" style="display:none;margin-top:6px;border-top:1px solid rgba(255,255,255,.15);padding-top:6px;max-width:440px;max-height:55vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.7 "Microsoft YaHei", system-ui, sans-serif"></div>';
    const btn = el.querySelector('#wc-review-btn');
    if (btn) btn.addEventListener('click', () => startReview(el));
    const closeBtn = el.querySelector('#wc-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', hideTip);

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

  function btnCss() {
    return 'background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.25);' +
      'border-radius:6px;padding:3px 10px;cursor:pointer;font:12px "Microsoft YaHei", system-ui, sans-serif';
  }

  function setStatus(el, text, isError) {
    const st = el.querySelector('#wc-status');
    st.textContent = text;
    st.style.color = isError ? '#ff9e9e' : '';
    st.style.display = 'block';
  }

  /* ---------------- 论文审查 ---------------- */
  function startReview(el) {
    const btn = el.querySelector('#wc-review-btn');
    const text = (el.__wcText || '').trim();
    if (!text) return;
    if (text.length > MAX_TEXT_LEN) {
      setStatus(el, '选中文本过长（' + text.length + ' 字符，上限 ' + MAX_TEXT_LEN + '），请分段审查。', true);
      return;
    }

    reviewPending = true; // 审查期间悬浮窗钉住不收起
    btn.disabled = true;
    btn.textContent = '⏳ 审查中…';
    btn.style.opacity = '.6';
    setStatus(el, '正在连接本地 Claude Code…（约需 30~90 秒，完成前悬浮窗将保持显示）');

    chrome.runtime.sendMessage({ type: 'review', text }, (resp) => {
      reviewPending = false;
      if (chrome.runtime.lastError) {
        btn.disabled = false;
        btn.textContent = '📝 重试审查';
        btn.style.opacity = '';
        setStatus(el, '扩展通信失败：' + chrome.runtime.lastError.message, true);
        return;
      }
      if (!resp || !resp.ok) {
        btn.disabled = false;
        btn.textContent = '📝 重试审查';
        btn.style.opacity = '';
        setStatus(el, (resp && resp.error) ? resp.error : '审查失败，请查看桥接服务窗口的日志。', true);
        return;
      }

      // 审查成功：显示结果 + 复制 / 关闭按钮
      btn.disabled = false;
      btn.textContent = '📝 重新审查';
      btn.style.opacity = '';
      const st = el.querySelector('#wc-status');
      st.innerHTML = '';
      const done = document.createElement('div');
      done.style.cssText = 'color:#9fe0a0;margin-bottom:4px;font-weight:bold';
      done.textContent = '✅ 审查完成（用时 ' + (resp.seconds || '') + ' 秒）';
      const pre = document.createElement('div');
      pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;line-height:1.7';
      pre.textContent = resp.result;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;margin-top:6px';
      const copyBtn = document.createElement('button');
      copyBtn.style.cssText = btnCss();
      copyBtn.textContent = '📋 复制结果';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(resp.result).then(() => {
          copyBtn.textContent = '✅ 已复制';
          setTimeout(() => { copyBtn.textContent = '📋 复制结果'; }, 1500);
        });
      });
      row.appendChild(copyBtn);
      st.appendChild(done);
      st.appendChild(pre);
      st.appendChild(row);
      st.style.display = 'block';
      st.style.color = '';
    });
  }

  /* ---------------- 事件 ---------------- */
  // 悬浮窗仅通过右上角 ✕ 关闭（点击页面、滚动、缩放都不会收起）；
  // 仅当【按住 Shift + 鼠标左键拖选】时才弹出 / 更新内容（普通拖选不触发，避免误弹）；
  // 点击悬浮窗内部不触发更新
  document.addEventListener('mouseup', (e) => {
    if (tip && tip.contains(e.target)) return;
    if (!e.shiftKey) return;
    const sel = getSelection();
    if (!sel) return;
    showTip(sel, e.clientX, e.clientY);
  }, true);
  // 键盘选择（Shift + 方向键、Ctrl + A 等）
  document.addEventListener('keyup', (e) => {
    if (!(e.key === 'Shift' || e.key === 'Control' ||
          /^Arrow|^Home$|^End$|^Page/.test(e.key))) return;
    const sel = getSelection();
    if (!sel) return;
    showTip(sel, 0, 0);
  }, true);
})();
