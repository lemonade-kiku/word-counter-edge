// 选中字数统计 — 内容脚本
// 按住 Shift + 鼠标左键拖选文本（或键盘 Shift+方向键 / Ctrl+A）后，
// 在选区附近弹出悬浮窗显示字数 / 词数 / 字符数；普通拖选不触发
// 悬浮窗内置"论文审查"按钮：把选中文本【直接 fetch】本地桥接服务（不经过
// 扩展后台中转——MV3 的 service worker 会被浏览器按生命周期回收，审查中途
// 一断结果就丢；弹窗直连后 SW 生死不影响审查），由 Claude Code CLI 按论文
// 写作规范审查，结果流式回显在悬浮窗内
(() => {
  'use strict';

  console.log('[选中字数统计] 内容脚本已注入');

  const TIP_ID = 'wc-count-tip';
  const MAX_TEXT_LEN = 6000; // 与 bridge.js 保持一致
  const REVIEW_URL = 'http://127.0.0.1:8899/review';
  const ABORT_URL = 'http://127.0.0.1:8899/abort';
  const REVIEW_TIMEOUT_MS = 480000; // 客户端兜底超时（8 分钟；桥接服务 7 分钟超时会更早触发）
  let tip = null;
  let reviewPending = false; // 审查进行中：悬浮窗保持显示，防止结果丢失
  let reviewCtrl = null;     // 当前审查的 AbortController（点 ✕ / 超时时中止）

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
    // 页面脚本可能偷偷删掉/替换悬浮窗节点；被删则下次重建
    if (tip && !tip.isConnected) tip = null;
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = TIP_ID;
    // 用 closed shadow DOM 承载全部内容：页面脚本读不到悬浮窗里的文字
    // （含审查结果），也点不到里面的按钮——恶意页面无法窃取审查输出
    tip.__wcRoot = tip.attachShadow({ mode: 'closed' });
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
    if (reviewPending) { abortReview(); return; } // 审查中：✕ = 中止审查并收起
    if (tip) tip.style.display = 'none';
  }

  // 中止当前审查：abort fetch + 通知桥接服务杀掉 claude 进程树（释放 busy）
  function abortReview() {
    if (reviewCtrl) { reviewCtrl.abort(); reviewCtrl = null; }
    fetch(ABORT_URL, { method: 'POST' }).catch(() => {});
    reviewPending = false;
    if (tip) tip.style.display = 'none';
  }

  function showTip(sel, mouseX, mouseY) {
    const s = countText(sel.text);
    const el = ensureTip();
    // 记忆本次选中的文本，供"论文审查"按钮使用
    el.__wcText = sel.text;
    el.__wcRoot.innerHTML =
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
    const btn = el.__wcRoot.querySelector('#wc-review-btn');
    if (btn) btn.addEventListener('click', (ev) => { if (ev.isTrusted) startReview(el); });
    const closeBtn = el.__wcRoot.querySelector('#wc-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', (ev) => { if (ev.isTrusted) hideTip(); });

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
    const st = el.__wcRoot.querySelector('#wc-status');
    st.textContent = text;
    st.style.color = isError ? '#ff9e9e' : '';
    st.style.display = 'block';
  }

  /* ---------------- 复制（带 http 页面兜底） ---------------- */
  function copyText(text, btn) {
    const done = () => {
      btn.textContent = '✅ 已复制';
      setTimeout(() => { btn.textContent = '📋 复制结果'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => { if (fallbackCopy(text)) done(); });
    } else if (fallbackCopy(text)) {
      done();
    }
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 论文审查（弹窗直连桥接服务，流式） ---------------- */
  async function startReview(el) {
    const btn = el.__wcRoot.querySelector('#wc-review-btn');
    const text = (el.__wcText || '').trim();
    if (!text || btn.disabled) return;
    if (text.length > MAX_TEXT_LEN) {
      setStatus(el, '选中文本过长（' + text.length + ' 字符，上限 ' + MAX_TEXT_LEN + '），请分段审查。', true);
      return;
    }

    reviewPending = true; // 审查期间悬浮窗钉住不收起
    btn.disabled = true;
    btn.textContent = '⏳ 审查中…';
    btn.style.opacity = '.6';

    // 状态区：状态行 + 实时输出容器
    const st = el.__wcRoot.querySelector('#wc-status');
    st.innerHTML = '';
    const statusLine = document.createElement('div');
    statusLine.textContent = '正在连接本地 Claude Code…';
    const pre = document.createElement('div');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;line-height:1.7;margin-top:4px';
    st.appendChild(statusLine);
    st.appendChild(pre);
    st.style.display = 'block';
    st.style.color = '';

    let acc = '';
    let finished = false;
    const ctrl = new AbortController();
    reviewCtrl = ctrl;

    // 心跳：审查可能数分钟无正文输出（文献核对阶段），用已用时长告诉用户仍在运行
    const t0 = Date.now();
    const beat = setInterval(() => {
      if (!finished) {
        statusLine.textContent = '⏳ 审查中，已运行 ' + Math.round((Date.now() - t0) / 1000) +
          ' 秒（文献核对需读原文，请耐心等待）';
      }
    }, 5000);

    // 统一收尾：只触发一次；重置按钮 / reviewPending / 心跳 / 超时定时器
    let timeoutTimer = null;
    const finish = (ok, msg) => {
      if (finished) return;
      finished = true;
      clearInterval(beat);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      reviewPending = false;
      reviewCtrl = null;
      btn.disabled = false;
      btn.style.opacity = '';
      if (ok) {
        btn.textContent = '📝 重新审查';
        statusLine.textContent = '✅ 审查完成（用时 ' + msg + ' 秒）';
        statusLine.style.cssText = 'color:#9fe0a0;font-weight:bold';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;margin-top:6px';
        const copyBtn = document.createElement('button');
        copyBtn.style.cssText = btnCss();
        copyBtn.textContent = '📋 复制结果';
        copyBtn.addEventListener('click', () => copyText(acc, copyBtn));
        row.appendChild(copyBtn);
        st.appendChild(row);
      } else {
        btn.textContent = '📝 重试审查';
        statusLine.textContent = '❌ 审查失败';
        statusLine.style.cssText = 'color:#ff9e9e;font-weight:bold';
        const errPre = document.createElement('div');
        errPre.style.cssText = 'white-space:pre-wrap;word-break:break-word;line-height:1.7;margin-top:4px;color:#ff9e9e';
        errPre.textContent = msg || '未知错误';
        st.appendChild(errPre);
      }
    };

    timeoutTimer = setTimeout(() => { ctrl.abort(); }, REVIEW_TIMEOUT_MS);

    try {
      const res = await fetch(REVIEW_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error('桥接服务返回 ' + res.status + (body ? '：' + body.slice(0, 200) : ''));
      }

      // 读取流式响应：正文流式增量显示；结尾按 NUL 分隔符切出标记
      // （\u0000DONE 秒数\n 表示完成，\u0000ERROR 消息\n 表示失败）
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done: rdDone } = await reader.read();
        if (rdDone) break;
        buf += decoder.decode(value, { stream: true });
        const nul = buf.indexOf('\u0000');
        if (nul < 0) {
          // 标记尚未到达：buf 全部是正文，增量显示（多字节字符由 TextDecoder 跨块正确拼接）
          if (buf) {
            acc += buf;
            pre.textContent = acc;
            st.scrollTop = st.scrollHeight;
            buf = '';
          }
        } else {
          // 标记到达：NUL 之前是正文，之后是标记行
          const bodyText = buf.slice(0, nul);
          if (bodyText) {
            acc += bodyText;
            pre.textContent = acc;
            st.scrollTop = st.scrollHeight;
          }
          let rest = buf.slice(nul + 1);
          let nl = rest.indexOf('\n');
          // 标记行可能被网络分块切断，跨块拼接直到拿到完整行
          while (nl < 0) {
            const next = await reader.read();
            if (next.done) break;
            rest += decoder.decode(next.value, { stream: true });
            nl = rest.indexOf('\n');
          }
          const marker = nl < 0 ? rest : rest.slice(0, nl);
          if (marker.startsWith('DONE')) finish(true, marker.slice(5).trim());
          else if (marker.startsWith('ERROR')) finish(false, marker.slice(6).trim());
          else finish(false, '连接中断：无法识别的完成标记');
          reader.cancel().catch(() => {});
          break;
        }
      }
      // 流自然结束但未收到标记：桥接端异常（正常时桥接总在结束前写标记）
      if (!finished) finish(false, '连接中断：未收到完成标记');
    } catch (e) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (e && e.name === 'AbortError') {
        // 超时中止（✕ 中止时 reviewPending 已被 abortReview 置 false，静默收起）
        if (reviewPending) {
          finish(false, '审查超时（超过 ' + Math.round(REVIEW_TIMEOUT_MS / 60000) + ' 分钟）');
        }
      } else if (e && typeof e.message === 'string' && e.message.indexOf('桥接服务返回') === 0) {
        finish(false, e.message);
      } else {
        finish(false, '无法连接本地桥接服务。请先双击运行 bridge\\start-bridge.bat，然后重试。');
      }
    }
  }

  /* ---------------- 事件 ---------------- */
  // 悬浮窗仅通过右上角 ✕ 关闭（点击页面、滚动、缩放都不会收起；审查中 ✕ 会中止审查）；
  // 仅当【按住 Shift + 鼠标左键拖选】时才弹出 / 更新内容（普通拖选不触发，避免误弹）；
  // 点击悬浮窗内部不触发更新；审查进行中禁止重建弹窗（否则正在流式的结果会写进分离节点丢失）
  document.addEventListener('mouseup', (e) => {
    if (tip && tip.contains(e.target)) return;
    if (!e.isTrusted) return; // 只响应真实用户操作，无视页面脚本派发的合成事件
    if (!e.shiftKey) return;
    if (reviewPending) return;
    const sel = getSelection();
    if (!sel) return;
    showTip(sel, e.clientX, e.clientY);
  }, true);
  // 键盘选择（Shift + 方向键 / Home/End/Page / Ctrl+A）。
  // 只认选择相关按键：排除裸 Shift / Ctrl 松开（普通拖选后 Ctrl+C 复制会误弹窗）
  document.addEventListener('keyup', (e) => {
    if (!e.isTrusted) return; // 只响应真实键盘操作，无视页面派发的合成事件
    if (reviewPending) return;
    const isNav = /^Arrow|^Home$|^End$|^Page/.test(e.key);
    const isSelectAll = e.ctrlKey && (e.key === 'a' || e.key === 'A');
    if (!isNav && !isSelectAll) return;
    const sel = getSelection();
    if (!sel) return;
    showTip(sel, 0, 0);
  }, true);
})();
