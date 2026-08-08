// 后台服务：把内容脚本的"论文审查"请求转发到本地桥接服务
const BRIDGE_URL = 'http://127.0.0.1:8899';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'review') {
    fetch(BRIDGE_URL + '/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg.text })
    })
      .then(async (resp) => {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) return { ok: false, error: data.error || 'HTTP ' + resp.status };
        return data;
      })
      .catch(() => ({
        ok: false,
        error: '无法连接本地桥接服务。请先双击运行 bridge\\start-bridge.bat，然后重试。'
      }))
      .then(sendResponse);
    return true; // 异步响应
  }
});
