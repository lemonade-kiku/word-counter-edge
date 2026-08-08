#!/usr/bin/env node
/**
 * 论文审查桥接服务
 * 作用：浏览器插件（word-counter-edge）与 Claude Code CLI 之间的本地桥梁。
 * 插件把选中的文本 POST 到本服务，本服务调用 `claude -p`（无头模式）做论文写作审查，
 * 再把 Claude 的审查结果返回给插件悬浮窗。
 *
 * 启动：双击 start-bridge.bat，或命令行执行 `node bridge.js`
 * 地址：http://127.0.0.1:8899
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8899;
const HOST = '127.0.0.1';
const MAX_TEXT_LEN = 6000;        // 单次审查的最大字符数
const REVIEW_TIMEOUT_MS = 180000; // 等待 Claude 审查的最长时间（3 分钟）

// Claude CLI 的工作目录：优先用研究/论文目录，便于加载该目录下的 CLAUDE.md 等项目上下文；
// 可通过环境变量 CLAUDE_CWD 覆盖。
const DEFAULT_CWD = path.join(os.homedir(), 'Documents', 'scientific_research');
const CLAUDE_CWD =
  process.env.CLAUDE_CWD ||
  (fs.existsSync(DEFAULT_CWD) ? DEFAULT_CWD : __dirname);

/* ---------------- 审查提示词 ---------------- */
function buildPrompt(text) {
  return `你是学术论文写作审查专家。请对用户选中的文本段落按学术论文写作规范进行审查，重点三个方面：

1. 内容正确性：语法错误、拼写错误、逻辑矛盾、事实或数据表述是否准确
2. 表达地道性：是否符合学术语体（正式、客观、简洁），用词搭配是否地道，有无口语化表达或"中式英语"痕迹（若原文为中文，检查是否学术化）
3. 写作规范：句式与结构、时态语态、主谓一致、标点、术语一致性、段内衔接与连贯性

请按以下格式输出审查报告：
【总体评价】一到两句总评。
【问题清单】按严重程度从高到低列出，每条格式：
  - 严重度（高/中/低）｜原文摘引 → 问题说明 → 修改建议（英文原文请给出地道英文改写，中文原文给出学术化中文改写）
【润色后版本】给出整合全部修改建议后的完整段落。
若文本没有明显问题，直接说明"未发现明显问题"并简要点评，不必强行修改。

待审查文本：
---
${text}
---`;
}

/* ---------------- 调用 Claude CLI ---------------- */
function runReview(text) {
  return new Promise((resolve) => {
    const prompt = buildPrompt(text);
    // claude -p 无头模式：从 stdin 读入提示词（避免超长参数在 Windows 命令行下被截断）
    // 参数全部是静态字符串，不存在注入面，用整条命令字符串避免 Node 24 的 shell+args 弃用警告
    const child = spawn('claude -p --output-format text', {
      shell: true,
      windowsHide: true,
      cwd: CLAUDE_CWD,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill();
    }, REVIEW_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: '无法启动 claude 命令：' + err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (code === 0 && out) {
        resolve({ ok: true, result: out });
      } else {
        const detail = stderr.trim() || stdout.trim() || 'Claude 无输出';
        resolve({ ok: false, error: detail + (code ? '（退出码 ' + code + '）' : '') });
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/* ---------------- HTTP 服务 ---------------- */
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

let busy = false;

const server = http.createServer(async (req, res) => {
  const ts = new Date().toLocaleTimeString();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  // 健康检查：插件/用户可用来确认服务是否在运行
  if (req.method === 'GET' && req.url === '/health') {
    sendJSON(res, 200, { ok: true, service: 'paper-review-bridge', pid: process.pid, claudeCwd: CLAUDE_CWD });
    console.log(`[${ts}] GET /health`);
    return;
  }

  if (req.method === 'POST' && req.url === '/review') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
      return;
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      sendJSON(res, 400, { ok: false, error: '缺少选中文本' });
      return;
    }
    if (text.length > MAX_TEXT_LEN) {
      sendJSON(res, 400, {
        ok: false,
        error: '选中文本过长（' + text.length + ' 字符，上限 ' + MAX_TEXT_LEN + '），请分段审查'
      });
      return;
    }
    if (busy) {
      sendJSON(res, 409, { ok: false, error: '已有一次审查正在进行，请稍候' });
      return;
    }

    busy = true;
    console.log(`[${ts}] 收到审查请求（${text.length} 字符），正在调用 Claude Code…`);
    const started = Date.now();
    const result = await runReview(text);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    busy = false;

    if (result.ok) {
      console.log(`[${ts}] 审查完成，用时 ${secs}s，结果 ${result.result.length} 字符`);
      sendJSON(res, 200, { ok: true, result: result.result, seconds: secs });
    } else {
      console.log(`[${ts}] 审查失败（${secs}s）：${result.error}`);
      sendJSON(res, 500, { ok: false, error: result.error });
    }
    return;
  }

  sendJSON(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(PORT, HOST, () => {
  console.log('==========================================================');
  console.log('  Claude 论文审查桥接服务已启动');
  console.log('  地址: http://' + HOST + ':' + PORT);
  console.log('  Claude 工作目录: ' + CLAUDE_CWD);
  console.log('  保持本窗口开启。浏览器选中文字后点悬浮窗的"论文审查"按钮');
  console.log('  按 Ctrl+C 退出');
  console.log('==========================================================');
});
