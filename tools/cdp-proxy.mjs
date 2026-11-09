#!/usr/bin/env node
/**
 * cdp-proxy — 本地 CDP 代理（Suno 上传器调试用）
 *
 * 与交接文档中的 web-access 代理接口保持一致：
 *   GET  /health
 *   GET  /targets
 *   GET  /new?url=...
 *   GET  /close?target=...
 *   POST /navigate?target=...     body: URL
 *   POST /eval?target=...         body: JS 表达式
 *   GET|POST /screenshot?target=...
 *   POST /click?target=...        body: CSS 选择器 或 {"x":1,"y":2}
 *   GET  /info?target=...
 *
 * ⚠ sendCDP 硬编码 30 秒超时 —— 长任务必须拆段。
 *
 * 用法：
 *   node cdp-proxy.mjs                 # 默认 3456，自动启动/连接 Edge
 *   node cdp-proxy.mjs --port 3456 --cdp-port 9222 --browser edge
 *   node cdp-proxy.mjs --profile D:\some\dir   # 指定调试专用配置目录
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ─────────────────────────── 参数 ───────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(arg('port', 3456));
const CDP_PORT = Number(arg('cdp-port', 9222));
const BROWSER = arg('browser', 'edge');
const PROFILE = arg('profile', path.join(process.env.LOCALAPPDATA || process.env.HOME, 'suno-cdp-profile'));
const CDP_TIMEOUT = 30_000; // ★ 硬编码，与交接文档一致

const BROWSER_PATHS = {
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ─────────────────────────── CDP 基础 ───────────────────────────
const cdpBase = () => `http://127.0.0.1:${CDP_PORT}`;

async function jget(url, timeout = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** 是否已有调试端口 */
async function probeCdp() {
  const v = await jget(`${cdpBase()}/json/version`, 2000);
  return v ? v : null;
}

async function launchBrowser() {
  const exe = (BROWSER_PATHS[BROWSER] || BROWSER_PATHS.edge).find((p) => fs.existsSync(p));
  if (!exe) throw new Error(`找不到 ${BROWSER} 可执行文件`);
  fs.mkdirSync(PROFILE, { recursive: true });
  log('启动浏览器：', exe);
  log('调试配置目录：', PROFILE);
  const child = spawn(exe, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const v = await probeCdp();
    if (v) return v;
  }
  throw new Error('浏览器启动后 20 秒内未开放调试端口');
}

/** 已连接的 target WS 池 */
const pool = new Map(); // targetId -> { ws, nextId, pending }

function connect(targetId, wsUrl) {
  const cached = pool.get(targetId);
  if (cached && cached.ws.readyState === 1) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const entry = { ws, nextId: 1, pending: new Map() };
    ws.addEventListener('open', () => {
      pool.set(targetId, entry);
      resolve(entry);
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && entry.pending.has(msg.id)) {
        const { resolve: res, reject: rej, timer } = entry.pending.get(msg.id);
        clearTimeout(timer);
        entry.pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
      }
    });
    ws.addEventListener('close', () => {
      if (pool.get(targetId) === entry) pool.delete(targetId);
      for (const [, p] of entry.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP 连接已关闭'));
      }
      entry.pending.clear();
    });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });
}

/** ★ 30 秒硬超时 */
function sendCDP(entry, method, params = {}, timeout = CDP_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const id = entry.nextId++;
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error(`CDP 超时（${timeout}ms）：${method}`));
    }, timeout);
    entry.pending.set(id, { resolve, reject, timer });
    entry.ws.send(JSON.stringify({ id, method, params }));
  });
}

// ─────────────────────────── target 管理 ───────────────────────────
async function listTargets() {
  const list = await jget(`${cdpBase()}/json/list`, 5000);
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    .map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl }));
}

async function resolveTarget(targetId) {
  const list = await listTargets();
  if (!list.length) throw new Error('没有可用的页面 target');
  if (!targetId) return list[0];
  const hit = list.find((t) => t.id === targetId || t.id.startsWith(targetId));
  if (!hit) throw new Error(`找不到 target: ${targetId}`);
  return hit;
}

async function getEntry(targetId) {
  const t = await resolveTarget(targetId);
  return { target: t, entry: await connect(t.id, t.ws) };
}

// ─────────────────────────── HTTP 层 ───────────────────────────
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(
    typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
  res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'access-control-allow-origin': '*' });
  res.end(buf);
}

const fail = (res, e) => send(res, 500, { error: String(e && e.message ? e.message : e) });

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const target = u.searchParams.get('target') || u.searchParams.get('targetId');
  const route = u.pathname.replace(/\/+$/, '') || '/';

  try {
    if (route === '/health') {
      const v = await probeCdp();
      const list = v ? await listTargets() : [];
      return send(res, 200, {
        status: v ? 'ok' : 'down',
        connected: Boolean(v),
        browser: v ? v.Browser : null,
        protocol: v ? v['Protocol-Version'] : null,
        cdpPort: CDP_PORT,
        proxyPort: PORT,
        targets: list.length,
        profile: PROFILE,
        timeoutMs: CDP_TIMEOUT,
      });
    }

    if (route === '/targets') {
      const list = await listTargets();
      return send(res, 200, list.map(({ id, type, title, url }) => ({ id, type, title, url })));
    }

    if (route === '/new') {
      const url = u.searchParams.get('url') || 'about:blank';
      const r = await fetch(`${cdpBase()}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      const j = await r.json();
      return send(res, 200, { targetId: j.id, url: j.url, title: j.title });
    }

    if (route === '/close') {
      const t = await resolveTarget(target);
      await fetch(`${cdpBase()}/json/close/${t.id}`);
      const p = pool.get(t.id);
      if (p) { try { p.ws.close(); } catch {} pool.delete(t.id); }
      return send(res, 200, { closed: t.id });
    }

    if (route === '/info') {
      const t = await resolveTarget(target);
      return send(res, 200, { id: t.id, title: t.title, url: t.url });
    }

    if (route === '/front') {
      const { target: t, entry } = await getEntry(target);
      await sendCDP(entry, 'Page.bringToFront', {});
      return send(res, 200, { front: t.id, url: t.url });
    }

    if (route === '/screenshot') {
      const { entry } = await getEntry(target);
      const r = await sendCDP(entry, 'Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(r.data, 'base64');
      return send(res, 200, buf, 'image/png');
    }

    if (route === '/eval') {
      const body = (await readBody(req)).trim();
      if (!body) return send(res, 400, { error: '缺少 JS 表达式 body' });
      const { entry } = await getEntry(target);
      const r = await sendCDP(entry, 'Runtime.evaluate', {
        expression: body,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        return send(res, 200, {
          ok: false,
          value: r.exceptionDetails.text,
          detail: r.exceptionDetails.exception?.description || null,
        });
      }
      return send(res, 200, { ok: true, value: r.result.value ?? null, type: r.result.type });
    }

    if (route === '/navigate') {
      const body = (await readBody(req)).trim();
      const url = body || u.searchParams.get('url');
      if (!url) return send(res, 400, { error: '缺少 URL' });
      const { target: t, entry } = await getEntry(target);
      await sendCDP(entry, 'Page.navigate', { url });
      return send(res, 200, { navigated: url, targetId: t.id });
    }

    if (route === '/click') {
      const body = (await readBody(req)).trim();
      const { entry } = await getEntry(target);
      let spec = null;
      try { spec = body ? JSON.parse(body) : null; } catch { spec = null; }
      if (spec && typeof spec.x === 'number') {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await sendCDP(entry, 'Input.dispatchMouseEvent', {
            type, x: spec.x, y: spec.y, button: 'left', clickCount: 1,
          });
        }
        return send(res, 200, { ok: true, clicked: { x: spec.x, y: spec.y } });
      }
      const sel = body.replace(/^["']|["']$/g, '');
      if (!sel) return send(res, 400, { error: '缺少选择器或坐标' });
      const r = await sendCDP(entry, 'Runtime.evaluate', {
        expression: `(function(){var el=document.querySelector(${JSON.stringify(sel)});
          if(!el) return 'NOT_FOUND'; el.scrollIntoView({block:'center'}); el.click();
          return 'CLICKED:' + (el.tagName||'');})()`,
        returnByValue: true,
      });
      return send(res, 200, { ok: true, value: r.result.value });
    }

    send(res, 404, { error: `未知接口 ${route}`, endpoints: ['/health','/targets','/new','/close','/navigate','/eval','/screenshot','/click','/info'] });
  } catch (e) {
    fail(res, e);
  }
});

// ─────────────────────────── 启动 ───────────────────────────
(async () => {
  let v = await probeCdp();
  if (!v) {
    log('未发现调试端口，准备启动浏览器…');
    try {
      v = await launchBrowser();
    } catch (e) {
      console.error('✗', e.message);
      process.exit(1);
    }
  }
  log(`已连接 ${v.Browser}  (CDP ${CDP_PORT})`);
  server.listen(PORT, '127.0.0.1', () => {
    log(`CDP 代理就绪 → http://localhost:${PORT}/health`);
    log(`单次 evaluate 上限 ${CDP_TIMEOUT / 1000}s —— 长任务请拆段`);
  });
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const [, p] of pool) { try { p.ws.close(); } catch {} }
    process.exit(0);
  });
}
