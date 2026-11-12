// ==UserScript==
// @name         Suno 一键上传器
// @name:en      Suno One-Click Uploader
// @namespace    github.suno-tools.uploader
// @version      30.0.1
// @description  把手头的音频切段批量导入 Suno，在 Studio 里拼成完整作品并导出；附 listen-and-rank 自动评分。
// @description:en  Batch-import your own audio into Suno Studio, merge into a full track, export; plus listen-and-rank auto rating.
// @updateURL    https://raw.githubusercontent.com/diyiritian-ops/suno-uploader/main/src/Suno-OneClick-Uploader.user.js
// @downloadURL  https://raw.githubusercontent.com/diyiritian-ops/suno-uploader/main/src/Suno-OneClick-Uploader.user.js
// @author       suno-tools
// @license      MIT
// @match        https://suno.com/*
// @match        https://www.suno.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      studio-api-prod.suno.com
// @connect      suno.com
// @connect      www.suno.com
// @connect      suno-uploads.s3.amazonaws.com
// @connect      d2lwuy8qc234o3.cloudfront.net
// @connect      unpkg.com
// @connect      cdn.jsdelivr.net
// @connect      fastly.jsdelivr.net
// @connect      gcore.jsdelivr.net
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const API = 'https://studio-api-prod.suno.com';
  const BPS = 1.95;
  const MIN_SEG = 6;
  // Suno 要求上传音频至少这么长，短了会在【开头】补静音，导致合并后错位
  const SUNO_MIN_UPLOAD = 6;
  const POLL_MS = 2500;
  const MAX_POLL = 40;
  const VERSION = 'v30';
  const K_POS = 'suno_up:pos';
  const K_MIN = 'suno_up:min';
  const K_HIST = 'suno_up:hist';
  const K_CFG = 'suno_up:cfg';
  const K_PROG = 'suno_up:prog';
  const K_LIB = 'suno_up:lib';

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function readToken() {
    const m = document.cookie.match(/(?:^|;\s*)__session=([^;]+)/);
    if (!m) throw new Error('还没登录 suno.com：先在 suno.com 右上角登录，然后刷新这个页面再来');
    return decodeURIComponent(m[1]);
  }

  function getDeviceId() {
    let d = GM_getValue('device-id', null);
    if (!d) { d = uuid(); GM_setValue('device-id', d); }
    return d;
  }

  function headers(ct) {
    const h = {
      authorization: 'Bearer ' + readToken(),
      'browser-token': JSON.stringify({
        token: btoa(JSON.stringify({ timestamp: Date.now() }))
      }),
      'device-id': getDeviceId()
    };
    if (ct) h['content-type'] = ct;
    return h;
  }

  // ==================== 网络健康监测 ====================
  // 底层请求失败时上报，UI 层据此判断要不要暂停并提示换网络
  const NET = {
    fail: 0,
    onFail: null,     // (reason) => void
    onOk: null        // () => void
  };
  function netReportFail(reason) {
    NET.fail++;
    try { if (NET.onFail) NET.onFail(reason || '') } catch (e) {}
  }
  function netReportOk() {
    if (NET.fail > 0) {
      NET.fail = 0;
      try { if (NET.onOk) NET.onOk() } catch (e) {}
    }
  }

  function gmFetch(method, url, body, timeout) {
    return new Promise((resolve, reject) => {
      const hasBody = body !== undefined && body !== null;
      const withAuth = String(url).indexOf(API) === 0;
      GM_xmlhttpRequest({
        method, url,
        headers: withAuth ? headers(hasBody ? 'application/json' : undefined) : undefined,
        data: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        timeout: timeout || 90000,
        responseType: 'text',
        onload: r => { netReportOk(); resolve({ status: r.status, text: r.responseText }) },
        onerror: () => { netReportFail('连接中断'); reject(new Error('网络错误')) },
        ontimeout: () => { netReportFail('请求超时'); reject(new Error('超时')) }
      });
    });
  }

  // 二进制下载
  function gmFetchBinary(url, timeout) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        responseType: 'arraybuffer',
        timeout: timeout || 180000,
        onload: r => {
          if (r.status === 200 && r.response) { netReportOk(); resolve(new Uint8Array(r.response)) }
          else reject(new Error('HTTP ' + r.status));
        },
        onerror: () => { netReportFail('下载中断'); reject(new Error('网络错误')) },
        ontimeout: () => { netReportFail('下载超时'); reject(new Error('下载超时')) }
      });
    });
  }

  function gmUploadS3(url, fields, blob, filename) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      Object.keys(fields).forEach(k => fd.append(k, fields[k]));
      fd.append('file', blob, filename);
      GM_xmlhttpRequest({
        method: 'POST', url, data: fd,
        // 切片只有几百 KB；给 60 秒是考虑到国内上行慢，太短会误判超时
        timeout: 60000,
        onload: r => { netReportOk(); resolve({ status: r.status, text: r.responseText }) },
        onerror: () => { netReportFail('S3 连接中断'); reject(new Error('S3 网络错误')) },
        ontimeout: () => { netReportFail('S3 超时'); reject(new Error('S3 超时')) }
      });
    });
  }

  /**
   * 给任意 Promise 加总超时
   * 防止某个请求卡住导致整个上传任务推进不下去。
   */
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error((label || '操作') + '超时 ' + Math.round(ms / 1000) + 's'));
      }, ms);
      promise.then(v => {
        if (done) return;
        done = true; clearTimeout(timer); resolve(v);
      }, e => {
        if (done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  // ==================== 音频 ====================

  async function decodeAudio(file) {
    const ab = await file.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try { return await ctx.decodeAudioData(ab.slice(0)); }
    finally { ctx.close(); }
  }

  function bufferToWav(ab) {
    const rate = ab.sampleRate, len = ab.length, ch = Math.min(2, ab.numberOfChannels);
    const dataSize = len * ch * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const W = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    W(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); W(8, 'WAVE');
    W(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, ch, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * ch * 2, true); view.setUint16(32, ch * 2, true);
    view.setUint16(34, 16, true); W(36, 'data'); view.setUint32(40, dataSize, true);
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(ab.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        let v = Math.max(-1, Math.min(1, chans[c][i] || 0));
        view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function sliceToWav(audioBuffer, startSec, endSec) {
    const rate = audioBuffer.sampleRate;
    const s0 = Math.max(0, Math.floor(startSec * rate));
    const s1 = Math.min(audioBuffer.length, Math.floor(endSec * rate));
    const len = Math.max(0, s1 - s0);
    const ch = Math.min(2, audioBuffer.numberOfChannels);
    const minSamples = Math.ceil(MIN_SEG * rate);
    const pad = len < minSamples ? (minSamples - len) : 0;
    const total = len + pad;
    const dataSize = total * ch * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const W = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    W(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); W(8, 'WAVE');
    W(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, ch, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * ch * 2, true); view.setUint16(32, ch * 2, true);
    view.setUint16(34, 16, true); W(36, 'data'); view.setUint32(40, dataSize, true);
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(audioBuffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < total; i++) {
      for (let c = 0; c < ch; c++) {
        let v = i < len ? (chans[c][s0 + i] || 0) : 0;
        v = Math.max(-1, Math.min(1, v));
        view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /**
   * 移调：只做变速重采样，【不】保持时长
   *
   * ★ 关键认知（实测确认）：
   *   Studio 的 clip.transposition 是「变速播放」——设为 -N 就是把音频按
   *   2^(-N/12) 倍速播放，音高和时长同时变化。
   *
   *   所以上传时【必须】让音频随移调自然变短：
   *     原始 6 秒 → 移调 +24（4 倍速重采样）→ 上传 1.5 秒
   *     Studio 设 transposition -24 → 按 0.25 倍速播放 → 正好 6 秒、原调
   *
   *   如果上传时保持时长（6 秒），Studio 会把它拉成 24 秒，
   *   但场景只有 6 秒 → 被截断 → 只放出前 1/4 内容，听起来破碎。
   *
   *   这样全程只有一次重采样（浏览器自带抗混叠），没有重叠相加的金属味。
   *
   * @param semis 半音数（正数升调）
   * @returns {Blob, seconds} 变速后的音频及其实际时长
   */
  async function pitchShiftResample(blob, semis) {
    if (!semis) {
      const b0 = await decodeToBuffer(blob);
      return { blob, seconds: b0.duration };
    }
    const buf = await decodeToBuffer(blob);
    const chCount = buf.numberOfChannels;
    const rate = buf.sampleRate;
    const ratio = Math.pow(2, semis / 12);
    const outLen = Math.max(1, Math.ceil(buf.length / ratio));

    const off = new OfflineAudioContext(chCount, outLen, rate);
    const node = off.createBufferSource();
    node.buffer = buf;
    node.playbackRate.value = ratio;   // 音高 ×ratio，时长 ÷ratio
    node.connect(off.destination);
    node.start(0);
    const rendered = await off.startRendering();

    return { blob: bufferToWav(rendered), seconds: rendered.duration };
  }

  // 兼容旧名（不再保持时长）
  async function transposeKeepLength(blob, semis) {
    const r = await pitchShiftResample(blob, semis);
    return r.blob;
  }

  // 兼容旧名
  async function alterBlob(blob, factor) {
    const semis = 12 * Math.log2(factor);
    return transposeKeepLength(blob, semis);
  }

  /**
   * 强变换：专治 内容识别服务
   *
   * 内容识别服务 靠「频谱峰值序列」做匹配。要打断它需要：
   *   1. 大幅移调（>2 半音）—— 频谱整体平移，峰值序列全变
   *   2. 频谱扰动 —— 用 BiquadFilter 扫频，破坏局部峰值
   *   3. 轻微变速 —— 时间轴拉伸，打断时序
   *   4. 叠加上极轻噪声 —— 填平静音段特征
   *
   * level 1~4，越大越难还原
   */
  async function heavyAlter(blob, level) {
    const ab = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const decCtx = new AC();
    const src = await decCtx.decodeAudioData(ab);

    // 参数表
    const P = [
      null,
      { semi: 2.0, speed: 1.015, eq: [1800, 1.6, 3.0], noise: 0.0008 },
      { semi: 3.0, speed: 1.030, eq: [1200, 2.0, 4.5], noise: 0.0015 },
      { semi: 4.0, speed: 1.045, eq: [800, 2.4, 6.0], noise: 0.0025 },
      { semi: 5.0, speed: 1.060, eq: [600, 2.8, 7.0], noise: 0.0035 }
    ][Math.min(4, Math.max(1, level))];

    const rate = src.sampleRate;
    const chCount = src.numberOfChannels;
    // 移调 = 重采样率变化
    const pitchRatio = Math.pow(2, P.semi / 12) * P.speed;
    const newLen = Math.max(1, Math.floor(src.length / pitchRatio));

    const out = new OfflineAudioContext(chCount, newLen, rate);

    // 1. 重采样（移调 + 变速）
    const buf = out.createBuffer(chCount, newLen, rate);
    for (let c = 0; c < chCount; c++) {
      const s = src.getChannelData(c);
      const dd = buf.getChannelData(c);
      for (let i = 0; i < newLen; i++) {
        const x = i * pitchRatio;
        const i0 = Math.floor(x);
        const i1 = Math.min(i0 + 1, s.length - 1);
        const f = x - i0;
        dd[i] = s[i0] * (1 - f) + s[i1] * f;
      }
    }

    // 2. 频谱扰动（带阻扫频）
    const srcNode = out.createBufferSource();
    srcNode.buffer = buf;

    const filter = out.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.setValueAtTime(P.eq[0], 0);
    filter.frequency.linearRampToValueAtTime(P.eq[0] * 2.2, buf.duration);
    filter.Q.value = P.eq[1];
    filter.gain.value = P.eq[2];

    srcNode.connect(filter);
    filter.connect(out.destination);

    // 3. 加极轻噪声
    if (P.noise > 0) {
      const nb = out.createBuffer(chCount, newLen, rate);
      for (let c = 0; c < chCount; c++) {
        const d = nb.getChannelData(c);
        for (let i = 0; i < newLen; i++) d[i] = (Math.random() * 2 - 1) * P.noise;
      }
      const ns = out.createBufferSource();
      ns.buffer = nb;
      ns.connect(out.destination);
      ns.start(0);
    }

    srcNode.start(0);
    const rendered = await out.startRendering();
    decCtx.close();
    return bufferToWav(rendered);
  }

  // ==================== ★ 下载 + 解密 ====================

  function b64ToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  /**
   * 拿到任意 clip 的明文音频。
   *
   * 原理（逆向自 sunouploader 的桥接脚本）：
   *   ① 匿名请求 /api/mango/rights → {glt, key, iv}
   *      注意：必须不带 authorization，否则不返回 glt
   *   ② SHA-256(glt) 当 AES-GCM 密钥解开 key/iv，附加数据是 clipId
   *   ③ 从 /api/clip/{id} 的 media_urls 取 CDN 地址，下载加密 m4a
   *   ④ key+iv 做 AES-CTR 解密（计数器按 16 字节块递增）
   */
  // ==================== 音频解密（下载 / 清洗共用） ====================

  /**
   * 拿一个 clip 的明文音频（M4A / AAC）。
   *
   * 流程（TECH-NOTES 第五节）：
   *   ① POST /api/mango/rights  —— ★ 绝不要带 Authorization，否则拿不到 glt
   *   ② seed = SHA-256(glt) → AES-GCM 解包 key / iv（附加数据 = clipId）
   *   ③ GET /api/clip/{id} → media_urls[0]
   *   ④ 拉密文
   *   ⑤ AES-CTR 解密 → 前 8 字节里应有 'ftyp'
   *
   * 下载到本地和「清洗重传」走的是同一段，抽出来免得两份代码各自漂移。
   */
  async function fetchClipAudio(clipId, L0, opts) {
    const L = L0 || (() => {});
    const o = opts || {};
    const tRights = o.rightsTimeout || 30000;
    const tMedia = o.mediaTimeout || 180000;

    L('  ① 获取播放授权...');
    const ra = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: API + '/api/mango/rights',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ content_params: { content_id: clipId, content_type: 'clip' } }),
        timeout: tRights,
        onload: r => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new Error('授权请求失败')),
        ontimeout: () => reject(new Error('授权超时'))
      });
    });
    if (ra.status !== 200) throw new Error('rights HTTP ' + ra.status);
    const rights = JSON.parse(ra.text);
    if (!rights.glt) throw new Error('没拿到 glt（可能需要以游客方式请求）');

    L('  ② 解包密钥...');
    const seed = new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(rights.glt)));
    const gcmKey = await crypto.subtle.importKey('raw', seed, 'AES-GCM', false, ['decrypt']);
    const ad = new TextEncoder().encode(clipId);

    async function unwrap(val) {
      let s = String(val).replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      const bin = atob(s);
      const w = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) w[i] = bin.charCodeAt(i);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: w.slice(0, 12), additionalData: ad },
        gcmKey, w.slice(12));
      return new Uint8Array(plain);
    }
    const rawKey = await unwrap(rights.key);
    const rawIv = await unwrap(rights.iv);

    L('  ③ 获取媒体地址...');
    const rc = await gmFetch('GET', API + '/api/clip/' + clipId, null, 30000);
    if (rc.status !== 200) throw new Error('clip HTTP ' + rc.status);
    const cd = JSON.parse(rc.text);
    if (!cd.media_urls || !cd.media_urls.length) throw new Error('没有 media_urls');
    const mediaUrl = cd.media_urls[0].url;

    L('  ④ 下载加密音频...');
    const enc = await gmFetchBinary(mediaUrl, tMedia);
    L('      ' + (enc.length / 1024).toFixed(0) + ' KB');

    L('  ⑤ AES-CTR 解密...');
    const ctrKey = await crypto.subtle.importKey('raw', rawKey, 'AES-CTR', false, ['decrypt']);
    let n = BigInt(0);
    for (const b of rawIv) n = (n << BigInt(8)) | BigInt(b);
    const counter = new Uint8Array(16);
    for (let i = 15; i >= 0; i--) { counter[i] = Number(n & BigInt(255)); n >>= BigInt(8); }

    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter, length: 128 }, ctrKey, enc);
    const plain = new Uint8Array(plainBuf);

    const magic = String.fromCharCode.apply(null, plain.slice(4, 8));
    if (magic !== 'ftyp') throw new Error('解密结果不是音频（magic=' + magic + '）');
    L('      ✓ ' + (plain.length / 1024).toFixed(0) + ' KB');
    return new Blob([plain], { type: 'audio/mp4' });
  }

  /** 下载到本地用（结果卡片 / 作品库按钮） */
  async function downloadClip(clipId, log) {
    return fetchClipAudio(clipId, log);
  }


  // ==================== 格式转换 ====================

  /**
   * 解码任意音频 Blob 为 AudioBuffer
   */
  async function decodeToBuffer(blob) {
    const ab = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
      return await ctx.decodeAudioData(ab.slice(0));
    } finally {
      ctx.close();
    }
  }

  /**
   * AudioBuffer → WAV（48kHz / 16bit PCM）
   *
   * 如果源采样率不是 48k，用 OfflineAudioContext 重采样。
   */
  async function toWav(blob, targetRate) {
    const rate = targetRate || 48000;
    const buf = await decodeToBuffer(blob);
    let src = buf;

    if (buf.sampleRate !== rate) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const len = Math.ceil(buf.duration * rate);
      const off = new OfflineAudioContext(Math.min(2, buf.numberOfChannels), len, rate);
      const s = off.createBufferSource();
      s.buffer = buf;
      s.connect(off.destination);
      s.start(0);
      src = await off.startRendering();
    }
    return bufferToWav(src);
  }

  /**
   * AudioBuffer → MP3
   *
   * Chrome/Edge 不开放 WebCodecs 的 MP3 编码器，
   * 所以用 ffmpeg.wasm 按需加载（首次约 25MB，之后缓存）。
   */
  let _ffmpeg = null;
  let _ffmpegLoading = null;   // 防止并发重复加载
  // 本次会话里 MP3 编码器确认不可用；跨会话也会记住（见 saveCfg）
  let _mp3Broken = (() => {
    try { return GM_getValue('suno_up:mp3bad', false) === true } catch (e) { return false }
  })();

  /**
   * 拉取 CDN 上的二进制资源
   *
   * ★ 不能用 fetch：suno.com 的 CSP 会拦截 jsdelivr，fetch 会一直挂着不返回
   *   （这就是之前「MP3 下载卡死」的根因）
   * ★ 必须有超时：否则网络一慢就永久卡住，界面没有任何反馈
   * ★ 多源：jsdelivr 在国内不稳定，一个源失败自动换下一个
   */
  const FF_CDNS = [
    'https://cdn.jsdelivr.net/npm/@ffmpeg',
    'https://fastly.jsdelivr.net/npm/@ffmpeg',
    'https://gcore.jsdelivr.net/npm/@ffmpeg'
  ];

  function fetchCDN(url, label, onLog) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      let lastTick = 0;
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer',
        timeout: 60000,
        onprogress: (e) => {
          if (!onLog || !e.lengthComputable) return;
          const now = Date.now();
          if (now - lastTick < 500) return;      // 限流，别刷屏
          lastTick = now;
          const pct = Math.round(e.loaded / e.total * 100);
          const mb = (e.loaded / 1048576).toFixed(1);
          onLog('    ' + label + ' ' + pct + '% (' + mb + 'MB)');
        },
        onload: r => {
          if (r.status !== 200 || !r.response) {
            return reject(new Error(label + ' HTTP ' + r.status));
          }
          const sec = ((Date.now() - t0) / 1000).toFixed(1);
          if (onLog) onLog('    ' + label + ' 完成 (' + (r.response.byteLength / 1048576).toFixed(1) + 'MB, ' + sec + 's)');
          resolve(new Uint8Array(r.response));
        },
        onerror: () => reject(new Error(label + ' 网络失败')),
        ontimeout: () => reject(new Error(label + ' 超时'))
      });
    });
  }

  /**
   * 依次尝试多个 CDN 源取同一个文件
   */
  async function fetchCDNWithFallback(path, label, onLog) {
    let lastErr = null;
    for (const base of FF_CDNS) {
      try {
        const buf = await fetchCDN(base + path, label, onLog);
        return buf;
      } catch (e) {
        lastErr = e;
        if (onLog) onLog('    ' + label + ' 换源重试（' + e.message + '）');
      }
    }
    throw lastErr || new Error(label + ' 所有源都失败');
  }

  async function getFFmpeg(onLog) {
    if (_ffmpeg) return _ffmpeg;
    if (_ffmpegLoading) return _ffmpegLoading;

    _ffmpegLoading = (async () => {
      // 用 jsdelivr 多源（unpkg / cdnjs 在国内经常被墙）
      const P_FFMPEG = '/ffmpeg@0.12.10/dist/umd';
      const P_CORE = '/core@0.12.6/dist/umd';

      if (onLog) onLog('  加载 MP3 编码器（合计约 31MB，只需一次）...');

      // 把远程资源转成同源 blob URL，绕开 Worker 跨域限制
      async function toBlobURL(path, mime, label) {
        const buf = await fetchCDNWithFallback(path, label, onLog);
        return URL.createObjectURL(new Blob([buf], { type: mime }));
      }

      // ★ ffmpeg 的 UMD 会把 FFmpegWASM 挂到【页面 window】上，
      //   而 Tampermonkey 沙箱里的 window 看不到它 → 必须走 unsafeWindow
      const G = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

      if (!G.FFmpegWASM) {
        const u = await toBlobURL(P_FFMPEG + '/ffmpeg.js', 'text/javascript', 'encoder.js');
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = u;
          s.onload = resolve;
          s.onerror = () => reject(new Error('ffmpeg 脚本加载失败'));
          document.head.appendChild(s);
        });
        // script onload 有时早于全局赋值，稍等一下
        for (let i = 0; i < 20 && !G.FFmpegWASM; i++) await sleep(100);
        if (!G.FFmpegWASM) {
          throw new Error('编码器脚本没挂上 FFmpegWASM（网页 CSP 可能拦了）');
        }
      }

      const coreURL = await toBlobURL(P_CORE + '/ffmpeg-core.js', 'text/javascript', 'core.js');
      const wasmURL = await toBlobURL(P_CORE + '/ffmpeg-core.wasm', 'application/wasm', 'core.wasm');
      const workerURL = await toBlobURL(P_FFMPEG + '/814.ffmpeg.js', 'text/javascript', 'worker.js');

      const ff = new G.FFmpegWASM.FFmpeg();
      if (onLog) ff.on('log', ({ message }) => {
        if (/error|invalid/i.test(message)) onLog('  ffmpeg: ' + message.slice(0, 90));
      });

      if (onLog) onLog('  初始化编码器...');
      await ff.load({ coreURL, wasmURL, classWorkerURL: workerURL });
      _ffmpeg = ff;
      if (onLog) onLog('  ✓ 编码器就绪');
      return ff;
    })();

    try {
      return await _ffmpegLoading;
    } catch (e) {
      _ffmpegLoading = null;     // 失败后允许重试
      throw e;
    }
  }

  async function toMp3(blob, kbps, onLog) {
    const ff = await getFFmpeg(onLog);
    const src = new Uint8Array(await blob.arrayBuffer());
    await ff.writeFile('in.m4a', src);
    const br = String(kbps || 192) + 'k';
    await ff.exec(['-i', 'in.m4a', '-codec:a', 'libmp3lame', '-b:a', br, 'out.mp3']);
    const out = await ff.readFile('out.mp3');
    try { await ff.deleteFile('in.m4a'); await ff.deleteFile('out.mp3'); } catch (e) {}
    if (!out || !out.length) throw new Error('ffmpeg 没有输出');
    return new Blob([out.buffer ? out.buffer : out], { type: 'audio/mpeg' });
  }

  /**
   * 把下载到的 m4a 转成目标格式并保存
   *
   * MP3 依赖 CDN 上的 ffmpeg.wasm，网络不通时会自动降级：
   *   MP3 失败 → WAV → M4A（原格式，永远可用）
   *
   * @param blob 解密后的 m4a
   * @param format 'm4a' | 'mp3' | 'wav'
   * @param baseName 文件名（不含扩展名）
   */
  async function convertAndSave(blob, format, baseName, log) {
    const L = log || (() => {});
    if (!format || format === 'm4a') {
      saveBlob(blob, baseName + '.m4a');
      return 'm4a';
    }
    if (format === 'wav') {
      try {
        L('  转换 WAV...');
        const w = await toWav(blob, 48000);
        L('      ' + (w.size / 1048576).toFixed(1) + ' MB');
        saveBlob(w, baseName + '.wav');
        return 'wav';
      } catch (e) {
        L('  WAV 转换失败（' + e.message + '），保存原格式');
        saveBlob(blob, baseName + '.m4a');
        return 'm4a';
      }
    }
    if (format === 'mp3') {
      // 这台机器上编码器已经确认跑不起来 → 直接存 M4A（零转换，音质和 MP3 源一样）
      if (_mp3Broken) {
        L('  MP3 编码器在这台机器上不可用，直接保存 M4A（质量等同，秒出）');
        saveBlob(blob, baseName + '.m4a');
        return 'm4a';
      }
      try {
        L('  转换 MP3（192kbps）...');
        const m = await toMp3(blob, 192, L);
        L('      ' + (m.size / 1048576).toFixed(1) + ' MB');
        saveBlob(m, baseName + '.mp3');
        return 'mp3';
      } catch (e) {
        _mp3Broken = true;
        try { GM_setValue('suno_up:mp3bad', true) } catch (e2) {}
        L('  MP3 转换失败：' + (e && e.message ? e.message : '浏览器限制'));
        L('  这台机器上编码器跑不起来（网页 CSP 拦了 Worker），以后直接跳过');
        L('  → 改成 WAV。想文件小就用 M4A（和 MP3 音质一样，且秒出）');
        try {
          const w = await toWav(blob, 48000);
          saveBlob(w, baseName + '.wav');
          return 'wav';
        } catch (e2) {
          L('  → WAV 也失败，保存原始 M4A');
          saveBlob(blob, baseName + '.m4a');
          return 'm4a';
        }
      }
    }
    saveBlob(blob, baseName + '.m4a');
    return 'm4a';
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }

  function safeName(s) {
    return String(s || 'audio')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 80) || 'audio';
  }

  // ==================== 上传 ====================

  /**
   * 上传一段音频到 Suno。
   *
   * ★ 超时值必须大于内层最坏情况：
   *     init(15s) + S3(60s) + finish(15s) + 轮询(40×2s=80s) ≈ 170s
   *   之前外层只有 75s，比内层轮询上限还短 →
   *   只要 Suno 处理稍慢就一定被外层掐断，重试也全超时，表现为「卡住」。
   */
  async function uploadSegment(blob, filename, title, ext, totalMs, onTick) {
    return withTimeout(_uploadSegment(blob, filename, title, ext, onTick),
      totalMs || 180000, '上传');
  }

  async function _uploadSegment(blob, filename, title, ext, onTick) {
    const ri = await gmFetch('POST', API + '/api/uploads/audio/',
      { extension: ext || 'wav', is_stem_mix: false, upload_type: 'file_upload' });
    if (ri.status !== 200) throw new Error('init HTTP' + ri.status);
    const init = JSON.parse(ri.text);

    const s3 = await gmUploadS3(init.url, init.fields, blob, filename);
    if (s3.status !== 200 && s3.status !== 204) throw new Error('S3 HTTP' + s3.status);

    const rf = await gmFetch('POST',
      API + '/api/uploads/audio/' + init.id + '/upload-finish/',
      { upload_type: 'file_upload', upload_filename: filename });
    if (rf.status !== 200) throw new Error('finish HTTP ' + rf.status);

    let st = null;
    const t0 = Date.now();
    for (let i = 0; i < MAX_POLL; i++) {
      await sleep(POLL_MS);
      const rq = await gmFetch('GET', API + '/api/uploads/audio/' + init.id + '/');
      if (rq.status !== 200) continue;
      st = JSON.parse(rq.text);
      if (st.status === 'complete' || st.status === 'error') break;
      // 每 4 次（约 8 秒）报一次进度，避免界面看起来卡死
      if (onTick && i % 4 === 3) {
        onTick('Suno 处理中 ' + Math.round((Date.now() - t0) / 1000) + 's（' +
               (st.status || 'pending') + '）');
      }
    }
    if (!st) throw new Error('轮询无响应');
    if (st.status === 'error') {
      const e = new Error(st.error_type || st.error_message || '被拒');
      e.rejected = true;
      throw e;
    }
    if (st.status !== 'complete') throw new Error('处理超时');

    const r5 = await gmFetch('POST',
      API + '/api/uploads/audio/' + init.id + '/initialize-clip/', '{}');
    if (r5.status !== 200) throw new Error('initialize-clip HTTP ' + r5.status);
    const d5 = JSON.parse(r5.text);
    const cid = d5.clip_id || d5.id;
    if (!cid) throw new Error('无 clipId');

    const mb = {
      title, is_audio_upload_tos_accepted: true,
      skip_notification: true, show_success_toast: false
    };
    if (st.image_url) mb.image_url = st.image_url;
    await gmFetch('POST', API + '/api/gen/' + cid + '/set_metadata/', mb);
    // 返回 clipId + 实际时长（Suno 处理后的真实长度）
    return { clipId: cid, realDur: (st.duration || 0) };
  }

  // ==================== 项目 / 导出 ====================

  async function createProject(title) {
    const r = await gmFetch('POST',
      API + '/api/studio/create-project?title=' + encodeURIComponent(title), '{}');
    if (r.status !== 200) throw new Error('建项目 HTTP ' + r.status);
    return JSON.parse(r.text).id;
  }

  /**
   * 构建 Studio 工程 state。
   *
   * ★ 移调还原：每个 entry 带 semis（上传时的移调量），
   *   这里设 transposition = -semis，Studio 播放/导出时移回原调。
   *   二分后各块移调量可能不同，所以逐块独立还原。
   */
  /**
   * 生成 warp 数据
   *
   * Studio 里 warp 用「hash + 注册表」两级结构：
   *   clip.warp.markersHash = 'warp_<base64("0:0,D:beats")>'
   *   state.markersRegistry[hash] = { "0": 0, "<D>": <beats> }
   *
   * 只设 hash 不设 registry 的话 Studio 找不到映射，warp 会失效。
   */
  function warpData(padSec, totalSec, endBeats) {
    const f = n => n.toFixed(3).replace(/\.?0+$/, '');
    const pad = padSec > 0.0001 ? padSec : 0;
    const raw = f(pad) + ':0,' + f(totalSec) + ':' + f(endBeats);
    const hash = 'warp_' + btoa(raw).replace(/=+$/, '');
    const markers = {};
    markers['0'] = 0;
    markers[f(totalSec)] = endBeats;
    return { hash, markers };
  }

  function buildState(entries, title, fallbackSemis) {
    const sorted = entries.slice().sort((a, b) => a.t0 - b.t0);
    const trackId = uuid();
    const markersRegistry = {};
    let cursor = 0;
    const clips = sorted.map((e, i) => {
      // 场景长度用【原始时长】
      const sec = (e.origDur && e.origDur > 0) ? e.origDur : (e.t1 - e.t0);
      const durBeats = sec * BPS;
      const semis = (e.semis !== undefined && e.semis !== null)
        ? e.semis : (fallbackSemis || 0);
      // 上传音频的实际存储时长（移调后变短 + Suno 可能补的静音）
      const srcSec = (e.audioDur && e.audioDur > 0) ? e.audioDur : sec;
      const padSec = (e.padDur && e.padDur > 0) ? e.padDur : 0;

      // ★ 按【原始时间轴上的绝对位置】摆放，而不是首尾紧排。
      //   紧排的话只要有一段缺失，后面所有片段都会前移，
      //   导致整首歌后面全错位（Go West 就是这么坏的）。
      const startBeats = (typeof e.t0 === 'number' && e.t0 >= 0)
        ? e.t0 * BPS
        : cursor;

      const c = {
        color: '#FF6A00', fadeInCurve: 1, startBeats: startBeats, mute: false,
        type: 'audio', fadeInBeats: 0,
        transposition: -semis,
        formantCorrection: 0,
        streaming: false,
        amplitude: 1, fadeOutBeats: 0, fadeOutCurve: 1,
        loop: { endBeats: durBeats, enabled: false, startBeats: 0 },
        name: ('00' + (i + 1)).slice(-3) + ' ' + title + ' p' + ('00' + (i + 1)).slice(-3),
        endBeats: startBeats + durBeats, clipId: e.clipId, readStartBeats: 0,
        id: uuid(), asset: { type: 'clip', id: e.clipId }, reversed: false,
        // ★ warp 必须启用，否则 Studio 不会把音频拉伸到场景长度 → 出现静音
        warp: (() => {
          const w = warpData(padSec, srcSec, durBeats);
          markersRegistry[w.hash] = w.markers;
          return { awaitingAnalysis: false, markersHash: w.hash, enabled: true };
        })()
      };
      cursor += durBeats;
      return c;
    });
    return {
      state: {
        timing: { type: 'manual', bps: BPS, lockBPS: true, firstBeatSeconds: 0, bpsAutomation: [] },
        markersRegistry: markersRegistry, recording: { countInBars: 0, preRollBars: 0 },
        contextualWindowConfig: { focusedPanel: 'generate' }, sections: {},
        tracks: [{
          color: '#208BFF', takeLanes: [], faderAutomation: {}, clips,
          solo: false, mute: false, instrument: { type: 'song' }, type: 'audio',
          eq: {}, clipCreationIntents: [], amplitude: 1, takeLanesExpanded: false,
          balance: 0, signalChain: [], name: 'Main', id: trackId,
          routingMode: 'linear', arm: false, height: 96
        }],
        layout: { midiAutomationLaneHeight: 24, arrangementEditorHeight: 280,
                  midiAutomationLaneId: { category: 'noteProperty', property: 'velocity' } },
        routing: {}, amplitude: 1, songFadeOutBeats: 0,
        selection: { contextAfterBeats: 32, focusBeats: cursor, noteIds: [],
                     contextBeforeBeats: 32, automationPointIndices: [],
                     trackIds: [trackId], focusedArea: 'timeline',
                     warpMarkerSeconds: {}, focusedTrackId: trackId, anchorBeats: 0 },
        loop: { endBeats: 32, enabled: false, startBeats: 0 },
        masterRoutingMode: 'stereo', metronome: { enabled: false, volume: 0.5 },
        editorPointerModes: {}, timeSignatureChanges: [], midiCcMappings: [],
        songFadeInBeats: 0, masterSignalChain: [], lyricsCorrectionsByClipId: {}
      },
      totalSeconds: cursor / BPS
    };
  }

  /**
   * 提交 Studio 导出。
   *
   * ★ 关键：两种模式产出的 clip 类型不同（逆向自 Suno 前端源码）
   *
   *   clipType = studio_export（老模式）
   *     body: { studio_project_id, export_mode: 'studio_export' }
   *     产物: type=studio_export,  is_download_unlocked=true
   *
   *   clipType = rendered_context_window（Studio 界面默认用的模式）
   *     body: { from_studio_project_id, export_mode: 'rendered_context_window' }
   *     产物: type=rendered_context_window,  is_download_unlocked=false
   *
   * sunouploader 产出的是后者，也是「原始合并音频（未清洗）」那个可用的成品。
   */
  async function renderProject(projectId, title, state, lastBeats) {
    const body = {
      title: title + ' (Full)', lyrics: '', tags: '', negative_tags: '',
      style_summary: '', caption: '',
      state,
      start_beats: 0, end_beats: lastBeats,
      project_id: projectId,
      from_studio_project_id: projectId,          // ★ 不是 studio_project_id
      export_mode: 'rendered_context_window',     // ★ 不是 studio_export
      web_client_pathname: '/studio'
    };
    const r = await gmFetch('POST', API + '/api/studio/render-state', body, 120000);
    if (r.status !== 200) throw new Error('render HTTP ' + r.status + ' ' + r.text.slice(0, 120));
    const d = JSON.parse(r.text);
    if (!d.id) throw new Error('render 没返回 id');
    return d.id;
  }

  /**
   * ★ 清洗：把导出的成品再处理一遍，变成不会被删的 clip
   *
   * 原理（逆向自 sunouploader.site）：
   *   Studio 导出得到 type=rendered_context_window 的 clip，
   *   它会被 Suno 后续审查删除。
   *
   *   清洗 = 在该 clip 被删之前（约 47 秒窗口），
   *          下载它的明文音频，重新上传成一个新 clip。
   *   新 clip 的 type 是 upload/edit_crop，不会触发二次审查。
   *
   * 步骤：
   *   ① 用 mango/rights 拿解密密钥
   *   ② 下载加密 m4a 并解密
   *   ③ 重新上传成新 clip
   */
  async function cleanClip(srcClipId, title, log) {
    const L = log || (() => {});

    // ①–⑤ 和「下载到本地」共用同一条解密流水线（见 fetchClipAudio）
    const blob = await fetchClipAudio(srcClipId, L, { rightsTimeout: 20000, mediaTimeout: 90000 });

    // ⑥ 重新上传：生成全新 clip，保持成品稳定
    L('  ⑥ 重新上传...');
    const up = await uploadSegment(blob, 'clean_' + srcClipId.slice(0, 8) + '.m4a',
      title, 'mp4');
    L('      ✓ 新 clip ' + up.clipId.slice(0, 8));
    return up;
  }

  async function waitRendered(clipId, log, maxWaitMs) {
    const t0 = Date.now(), limit = maxWaitMs || 300000;
    let last = '';
    while (Date.now() - t0 < limit) {
      await sleep(4000);
      const r = await gmFetch('GET', API + '/api/clip/' + clipId, null, 30000);
      if (r.status !== 200) continue;
      let d;
      try { d = JSON.parse(r.text); } catch (e) { continue }
      if (d.status !== last) { last = d.status; log('    导出: ' + d.status); }
      if (d.status === 'complete') return d;
      if (d.status === 'error') throw new Error('导出失败');
    }
    throw new Error('导出超时');
  }

  // ==================== 存储 ====================

  // ---- 拉取用户作品列表 ----
  /**
   * 拉取「我的作品」列表
   *
   * ★ 必须翻深一点：上传合成的完整版（rendered_context_window）
   *   往往排在第 12 页之后，只拉前几页根本看不到。
   * ★ 按 id 去重：分页偶尔会重复返回同一条。
   * ★ 并行拉取：串行 40 页要 2 分钟，按批并行能压到 20 秒内。
   *
   * @param maxPages 最多翻几页（每页 20 条）
   * @param onProgress (已翻页数, 已收集条数) => void
   */
  async function fetchLibrary(maxPages, onProgress) {
    const out = [];
    const seen = new Set();
    const max = maxPages || 40;
    const BATCH = 5;              // 每次并发 5 页
    let done = 0;
    let stop = false;

    for (let start = 0; start < max && !stop; start += BATCH) {
      const pages = [];
      for (let p = start; p < Math.min(start + BATCH, max); p++) pages.push(p);

      const results = await Promise.all(pages.map(async (p) => {
        try {
          const r = await gmFetch('GET', API + '/api/feed/v2?page=' + p, null, 30000);
          if (r.status !== 200) return null;
          return JSON.parse(r.text);
        } catch (e) { return null }
      }));

      let anyMore = false;
      for (let i = 0; i < results.length; i++) {
        const d = results[i];
        done++;
        if (!d) continue;
        const list = d.clips || [];
        if (d.has_more) anyMore = true;
        if (!list.length) continue;
        for (const c of list) {
          if (!c.id || seen.has(c.id)) continue;
          seen.add(c.id);
          out.push({
            id: c.id,
            title: c.title || '未命名',
            type: (c.metadata && c.metadata.type) || 'unknown',
            duration: (c.metadata && c.metadata.duration) || 0,
            status: c.status,
            model: c.model_name || '',
            image: c.image_url || '',
            createdAt: c.created_at || ''
          });
        }
      }
      if (onProgress) onProgress(done, out.length);
      if (!anyMore) stop = true;
    }
    return out;
  }

  function loadHist() {
    try { return JSON.parse(GM_getValue(K_HIST, '[]')) } catch (e) { return [] }
  }
  function addHist(rec) {
    const list = loadHist();
    list.unshift(rec);
    GM_setValue(K_HIST, JSON.stringify(list.slice(0, 30)));
  }
  function loadCfg() {
    try { return JSON.parse(GM_getValue(K_CFG, '{}')) } catch (e) { return {} }
  }
  function saveCfg(c) { GM_setValue(K_CFG, JSON.stringify(c)); }

  // ==================== UI ====================

  let UI = null;

  /* ══════════════════════════════════════════════════════════════════
     听歌赚积分（suno.com/listen-and-rank）自动评分

     2026-11 实测结构（Edg 156 / TM 5.5.1）：
       入口       首页 hero 上的 "Earn credits" 按钮
       资料向导   [role=dialog] 里 "Set up your profile"，5 步：
                  creator_type(单选) → musical_background(单选) →
                  genres(多选) → languages(多选) → listening_setup(单选)
                  → Finish → "You're all set" → "Start Earning Credits"
       评分弹窗   [role=dialog] 里 "Which version sounds better?"
       每段一行   div.cursor-pointer.flex-col.gap-2
                  内含 button[aria-label="Play"|"Pause"] 和进度条
       打分       "Overall Sound" 右侧三个 div.min-w-6（A / B / Neither）
       ★ 门槛     每段必须真的播够约 5 秒，否则 Submit 一直是 disabled
       ★ 实测     media.muted = true 也算「听」——可以全程静音刷，不出声
       提交后     原地换下一组，不跳页（所以是一个自循环）

     停的条件：跑够设定轮数 / 页面提示没有任务 / 长时间无法提交。
     ══════════════════════════════════════════════════════════════════ */
  const K_PTS = 'suno_up:pts';        // 累计战绩
  const K_PTS_AUTO = 'suno_up:pts_auto'; // 跨页面自动续跑
  const K_PTS_RL = 'suno_up:pts_rl';     // 上次「等不到任务就刷新」的时间
  const K_PTS_MAX = 'suno_up:pts_max';   // 用户设置的轮数上限，刷新后保持

  function createPointsFarmer(h) {
    const S = {
      on: false, timer: null, busy: false, pending: false,
      rounds: 0, creds: 0, idle: 0, max: 40, navTried: false, lastClick: [0, 0], waitSince: 0,
    };
    const L = (m) => { try { h.log(m); } catch (e) {} };
    const S2 = (m, c) => { try { h.state(m, c); } catch (e) {} };
    const T = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
    const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    const DIALOG = '[role="dialog"]';
    const ROW = 'div[class*="cursor-pointer"][class*="flex-col"]';
    const OPT = 'div[class*="min-w-6"]';

    function dlg() {
      return qa(DIALOG).find(d => /Which version sounds better|Set up your profile|You.re all set/i.test(T(d))) || null;
    }
    function muteAll() {
      qa('audio,video').forEach(m => { try { m.muted = true; } catch (e) {} });
    }
    function rows(d) {
      return qa(ROW, d).filter(r => /^Clip [AB]/.test(T(r)) &&
        r.querySelector('button[aria-label="Play"],button[aria-label="Pause"]'));
    }
    function submitBtn(d) {
      return qa('button', d).find(b => /^Submit/i.test(T(b))) || null;
    }
    function opts(d) {
      return qa(OPT, d).filter(e => /^(A|B|Neither)$/.test(T(e)));
    }

    /** 资料向导：这题没选就随机选一个，然后点下一步 */
    function doWizard(d) {
      const go = qa('button', d).find(b => /^(Next|Finish|Start Earning Credits)$/i.test(T(b)));
      if (!go) return false;
      const radios = qa('input[type="radio"]:not(:checked)', d);
      if (radios.length) {
        const r = radios[Math.floor(Math.random() * radios.length)];
        (r.closest('label') || r).click();
      } else {
        const boxes = qa('input[type="checkbox"]', d);
        if (boxes.length && !boxes.some(b => b.checked)) {
          boxes.filter(b => !b.checked)
               .slice(0, 2 + Math.floor(Math.random() * 2))
               .forEach(b => (b.closest('label') || b).click());
        }
      }
      go.click();
      return true;
    }

    function stop(reason, kind) {
      S.on = false;
      S.pending = false;
      if (S.timer) { clearTimeout(S.timer); S.timer = null; }
      try { GM_setValue(K_PTS_AUTO, false); } catch (e) {}
      S2(reason, kind || 'ok');
      L('■ ' + reason);
      if (h.done) { try { h.done(); } catch (e) {} }
    }

    /** 一轮 = 一个动作，900ms 一跳，避免和 React 打架 */
    function step() {
      // 后台标签里计时器会被节流，听歌秒数不涨 —— 这时只等，不算失败
      if (document.hidden) { S2('标签页在后台：切回这个标签才会继续计时', 'run'); return; }
      const d = dlg();
      muteAll();

      if (!d) {
        if (!/listen-and-rank/.test(location.pathname)) {
          if (!S.navTried) {
            S.navTried = true;
            L('→ 跳转到 /listen-and-rank');
            location.href = 'https://suno.com/listen-and-rank';
          } else {
            stop('不在评分页，已停止', 'err');
          }
          return;
        }
        const body = T(document.body);

        /* 入口按钮会变：
           第一组是 "Earn credits"（中文版「赚取积分」），做完一组后变成 "Next tasks"。
           ★ 这个按钮 DOM 上位于 <header> 里，所以绝不能按 header 排除；
             侧边栏那个 "Earn Credits" 是 <a>，只查 button 就不会误点。 */
        const CTA_RE = /^(earn credits|next tasks?|start earning credits|keep rating|continue|rate more|surprise me|赚取积分|继续评分|开始评分|随机来点)$/i;
        const cta =
          qa('button').filter(b => !b.closest('nav,aside') && CTA_RE.test(T(b)))[0] ||
          qa('[role="button"]').filter(b => !b.closest('nav,aside') && /surprise me|随机来点/i.test(T(b)))[0];
        if (cta) { S2('开题中…（' + T(cta) + '）', 'run'); cta.click(); S.idle = 0; return; }

        /* ★ 只有「找不到入口按钮」时才去判断是不是配额用完了。
           注意：排行榜里本来就有一行 "Resets in 23h 1m"（排行榜倒计时），
           它不是任务配额！所以这个判断必须放在 CTA 之后，否则永远误报、一题都不跑。 */
        const avail = body.match(/(\d+)\s*(?:tasks? available|个任务可做)/i);
        const hasTasks = avail && parseInt(avail[1], 10) > 0;
        const reset = body.match(/resets in\s*(\d+\s*h(?:\s*\d+\s*m)?)/i);
        /* 任务池会动态补充：入口消失后先等 20 秒，还没出现就刷新页面重试一次，
           再没有才停（排行榜那行 Resets in 只是排行榜倒计时，不代表今日配额）。 */
        if (!hasTasks && reset) {
          if (!S.waitSince) S.waitSince = Date.now();
          const waited = Date.now() - S.waitSince;
          if (waited < 20000) { S2('暂时没有任务，等新任务补充…', 'run'); return; }
          let lastRl = 0;
          try { lastRl = GM_getValue(K_PTS_RL, 0) || 0; } catch (e) {}
          if (Date.now() - lastRl > 5 * 60 * 1000) {
            try { GM_setValue(K_PTS_RL, Date.now()); } catch (e) {}
            L('20 秒没等到新任务，刷新页面再试一次');
            location.reload();
            return;
          }
          stop('暂时没有可评的任务了（页面显示 ' + reset[1].replace(/\s+/g, '') + ' 后重置）');
          return;
        }
        S.waitSince = 0;
        if (/no more tasks|come back later|no tasks (right now|available)|暂时没有|稍后再来|已达上限|reached the limit|limit reached/i.test(body)) {
          stop('页面提示没有更多任务了');
          return;
        }
        if (++S.idle > 20) stop('找不到开始评分的按钮（页面结构可能变了）', 'err');
        return;
      }

      if (/Set up your profile/i.test(T(d))) { doWizard(d); S2('填写评分者资料…', 'run'); return; }
      if (/You.re all set/i.test(T(d))) {
        const b = qa('button', d).find(x => /Start Earning Credits/i.test(T(x)));
        if (b) b.click();
        return;
      }

      const rs = rows(d);
      if (rs.length < 2) { if (++S.idle > 20) stop('评分弹窗结构异常', 'err'); return; }

      /* ★ 解锁 Submit 需要两个条件同时成立：
           ① 选了答案（A / B / Neither，选中时 div 会带 bg-accent）
           ② Clip A、Clip B 各听满约 5 秒
         所以先选答案，再去听，最后提交。 */
      const o = opts(d);
      if (!o.length) { if (++S.idle > 20) stop('找不到 A/B 选项', 'err'); return; }
      const picked = o.some(e => /bg-accent/.test(String(e.className || '')));
      if (!picked && !S.pending) {
        const r0 = Math.random();
        const want = r0 < 0.42 ? 'A' : r0 < 0.84 ? 'B' : 'Neither';
        (o.find(x => T(x) === want) || o[0]).click();
        S2('选择答案 ' + want + '…', 'run');
        return;
      }

      /* ★ 关键坑（2026-11 实测）：
         · 每点一次播放，这一段的听歌计数就从 5 重新开始 —— 反复点永远听不完
         · 所以每段每题只点一次，然后老实等到「Listen for N more seconds」消失
         · media.muted = true 不影响计数，可以全程不出声 */
      const need = rs.filter(r => /listen for .*more second|再听\s*\d+\s*秒/i.test(T(r)));
      if (need.length && !S.pending) {
        const r = need[0];
        const idx = rs.indexOf(r);
        if (Date.now() - (S.lastClick[idx] || 0) < 9000) {
          S2('听 ' + (idx === 0 ? 'Clip A' : 'Clip B') + ' 中…（第 ' + (S.rounds + 1) + ' 题）', 'run');
          return;
        }
        const b = r.querySelector('button[aria-label="Play"],button[aria-label="Pause"]');
        if (b) b.click();
        S.lastClick[idx] = Date.now();
        S2('开始听 ' + (idx === 0 ? 'Clip A' : 'Clip B') + '（第 ' + (S.rounds + 1) + ' 题）', 'run');
        return;
      }

      const sub = submitBtn(d);
      if (!sub) { if (++S.idle > 20) stop('找不到 Submit 按钮', 'err'); return; }

      if (sub.disabled) {
        S.idle++;
        S2('等 Submit 解锁…（第 ' + (S.rounds + 1) + ' 题）', 'run');
        if (S.idle > 60) stop('连续 60 秒无法提交，已停止', 'err');
        return;
      }

      sub.click();
      S.rounds++; S.creds += 5; S.idle = 0; S.pending = false; S.lastClick = [0, 0];
      // 顺手读一下页面上的真实结算状态（会显示 "105 credits +45 pending"）
      const pend = T(document.body).match(/\+\s*(\d+)\s*pending/i);
      L('✓ 第 ' + S.rounds + ' 题已提交（本次约 +' + S.creds +
        (pend ? '；页面待结算 +' + pend[1] : '') + '）');
      S2('已评 ' + S.rounds + ' 题' + (pend ? ' · 待结算 +' + pend[1] : '') + ' 积分', 'ok');
      if (S.max && S.rounds >= S.max) stop('已跑够 ' + S.max + ' 题');
    }

    function tick() {
      if (!S.on) return;
      S.timer = setTimeout(tick, 900);
      if (S.busy) return;
      S.busy = true;
      try { step(); } catch (e) { L('! ' + e.message); }
      setTimeout(() => { S.busy = false; }, 500);
    }

    return {
      isOn: () => S.on,
      rounds: () => S.rounds,
      start(max) {
        if (S.on) return;
        S.on = true; S.rounds = 0; S.creds = 0; S.idle = 0;
        S.pending = false; S.navTried = false; S.lastClick = [0, 0]; S.waitSince = 0;
        S.max = Number(max) > 0 ? Number(max) : 0;
        try { GM_setValue(K_PTS_MAX, S.max); } catch (e) {}
        try { GM_setValue(K_PTS_AUTO, true); } catch (e) {}
        L('▶ 开始自动评分（上限 ' + (S.max || '不限') + ' 题）');
        S2('启动中…', 'run');
        tick();
      },
      stop: (why) => stop(why || '手动停止'),
      /** 页面刷新后自动续跑 */
      resumeIfArmed(max) {
        let armed = false;
        try { armed = GM_getValue(K_PTS_AUTO, false) === true; } catch (e) {}
        if (armed && /listen-and-rank/.test(location.pathname)) {
          let saved = max;
          try { saved = Number(GM_getValue(K_PTS_MAX, max)) || max; } catch (e) {}
          L('检测到上次未跑完，自动续跑（上限 ' + (saved || '不限') + ' 题）');
          this.start(saved);
        } else if (armed) {
          try { GM_setValue(K_PTS_AUTO, false); } catch (e) {}
        }
      },
    };
  }

  function mount() {
    if (UI) return UI;

    const pos = (() => { try { return JSON.parse(GM_getValue(K_POS, 'null')) } catch (e) { return null } })();
    const minimized = GM_getValue(K_MIN, false) === true;

    /**
     * 把保存的位置夹回可视区域。
     *
     * 面板宽度约 460，高度最多 92vh。如果之前在小窗口里拖到右边，
     * 换成窄窗口后 left 会超出视口 → 面板完全看不见。
     */
    function clampPos(p) {
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
      const W = window.innerWidth || document.documentElement.clientWidth || 1200;
      const H = window.innerHeight || document.documentElement.clientHeight || 800;
      const pw = 460, ph = Math.min(H * 0.92, 800);
      // 至少留 120px 在可视区域内，保证能抓到
      const maxX = Math.max(0, W - 120);
      const maxY = Math.max(0, H - 80);
      return {
        x: Math.max(0, Math.min(p.x, maxX)),
        y: Math.max(0, Math.min(p.y, maxY)),
        changed: false
      };
    }
    const safePos = clampPos(pos);

    const host = document.createElement('div');
    host.id = '__suno_up_host';
    host.style.cssText = 'position:fixed;z-index:2147483647;' +
      (safePos ? `left:${safePos.x}px;top:${safePos.y}px;right:auto;bottom:auto;`
               : 'right:16px;bottom:16px;');
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
<style>
:host{
  --bg:#fff; --bg2:#faf9ff; --bg3:#f3f0fb; --ink:#1a1526; --ink2:#5b5470; --muted:#8b85a3;
  --line:#e9e5f3; --line2:#dcd5ec; --accent:#7c3aed; --accent2:#a855f7; --soft:#f2ecff;
  --ok:#0f9d76; --oksoft:#e9fbf4; --warn:#c2760a; --warnsoft:#fff8e8;
  --bad:#d61f4a; --badsoft:#fff1f4;
  --sh:0 24px 64px rgba(60,40,120,.16),0 3px 10px rgba(60,40,120,.05);
  all:initial;
}
@media (prefers-color-scheme:dark){
  :host{
    --bg:#15121d; --bg2:#1b1726; --bg3:#221d31; --ink:#efeafd; --ink2:#b6afcb; --muted:#847d9c;
    --line:#2a2436; --line2:#39304b; --accent:#a78bfa; --accent2:#c084fc; --soft:#241d38;
    --ok:#34d399; --oksoft:#10261f; --warn:#fbbf24; --warnsoft:#2a2210;
    --bad:#fb7185; --badsoft:#2c1119;
    --sh:0 24px 64px rgba(0,0,0,.6);
  }
}
*{box-sizing:border-box}
.wrap{font:13.5px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
      color:var(--ink);user-select:none}
.panel{width:472px;background:var(--bg);border:1px solid var(--line);border-radius:18px;
       box-shadow:var(--sh);overflow:hidden;display:flex;flex-direction:column;max-height:92vh}

/* ── 顶栏 ── */
.bar{display:flex;align-items:center;gap:8px;padding:11px 14px;cursor:grab;
     background:linear-gradient(120deg,var(--bg2),var(--bg));border-bottom:1px solid var(--line)}
.bar.grab{cursor:grabbing}
.brand{display:flex;align-items:center;gap:8px;flex:1;pointer-events:none;min-width:0}
.logo{width:24px;height:24px;border-radius:8px;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:13px;
      box-shadow:0 3px 10px rgba(124,58,237,.35)}
.brand b{font-size:14.5px;font-weight:700;letter-spacing:.2px;color:var(--ink)}
.ver{font-size:11px;color:var(--muted);font-weight:600;background:var(--bg3);
     border:1px solid var(--line);padding:1px 6px;border-radius:6px}
.baracts{display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--line2);transition:.2s}
.dot.run{background:var(--warn);box-shadow:0 0 0 4px color-mix(in srgb,var(--warn) 18%,transparent)}
.dot.ok{background:var(--ok)}
.dot.err{background:var(--bad)}
.bar button{background:none;border:0;color:var(--muted);cursor:pointer;font-size:16px;
            padding:4px 7px;border-radius:7px;line-height:1;font-family:inherit}
.bar button:hover{background:var(--bg3);color:var(--ink)}

/* ── 标签页 ── */
.tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid var(--line);background:var(--bg)}
.tab{flex:1;border:0;background:none;cursor:pointer;font-family:inherit;font-size:13px;
     font-weight:600;color:var(--muted);padding:9px 4px 11px;border-radius:10px 10px 0 0;
     position:relative;transition:.15s}
.tab:hover{color:var(--ink2);background:var(--bg2)}
.tab.on{color:var(--accent)}
.tab.on::after{content:'';position:absolute;left:12%;right:12%;bottom:-1px;height:2px;
               border-radius:2px;background:linear-gradient(90deg,var(--accent),var(--accent2))}

/* ── 面板主体 ── */
.body{padding:13px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;
      flex:1 1 auto;min-height:0;background:var(--bg)}
.body>*{flex:0 0 auto}

/* ── 拖拽区 ── */
.dd{border:1.5px dashed var(--line2);border-radius:14px;padding:20px 14px;text-align:center;
    color:var(--ink2);cursor:pointer;transition:.16s;background:linear-gradient(165deg,var(--bg2),var(--bg))}
.dd:hover,.dd.on{border-color:var(--accent);color:var(--accent);
                 background:color-mix(in srgb,var(--accent) 7%,var(--bg));transform:translateY(-1px)}
.dd-ico{font-size:26px;line-height:1;margin-bottom:7px}
.dd-t{font-weight:700;font-size:14.5px;color:var(--ink);margin-bottom:3px}
.dd-s{font-size:11.5px;color:var(--muted)}

/* ── 文件卡 ── */
.fcard{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:13px;
       background:var(--bg2);border:1px solid var(--line)}
.fc-ico{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;
        background:var(--soft);font-size:16px;flex:0 0 34px}
.fc-main{flex:1;min-width:0}
.fc-main b{display:block;font-size:13px;font-weight:700;color:var(--ink);white-space:nowrap;
           overflow:hidden;text-overflow:ellipsis}
.fc-main span{font-size:11.5px;color:var(--muted)}

/* ── 表单 ── */
.row{display:flex;gap:8px;align-items:center;min-width:0}
.row label{color:var(--ink2);flex:0 0 66px;font-size:12px;font-weight:600}
.field{flex:1;min-width:0;background:var(--bg2);border:1.5px solid var(--line);color:var(--ink);
       border-radius:10px;padding:8px 11px;font-size:13px;font-family:inherit;outline:none;
       transition:.15s}
.field:focus{border-color:var(--accent);background:var(--bg);
            box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
select.field{cursor:pointer}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.grid2 .row label{flex:0 0 auto}

/* ── 开关 ── */
.chips{display:flex;gap:8px}
.chip{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:9px 6px;
      border-radius:11px;background:var(--bg2);border:1.5px solid var(--line);font-size:12.5px;
      color:var(--ink2);cursor:pointer;transition:.15s;font-weight:600}
.chip:hover{border-color:var(--line2);color:var(--ink)}
.chip input{display:none}
.chip:has(input:checked){background:var(--soft);border-color:color-mix(in srgb,var(--accent) 45%,var(--line));
                         color:var(--accent)}
.chip:has(input:checked)::before{content:'✓';font-size:12px;font-weight:800}

/* ── 折叠区 ── */
.adv{background:var(--bg2);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.adv summary{padding:10px 12px;cursor:pointer;font-size:12.5px;color:var(--ink2);list-style:none;
             display:flex;align-items:center;gap:7px;font-weight:600}
.adv summary::-webkit-details-marker{display:none}
.adv summary::before{content:'▸';color:var(--muted);font-size:10px;transition:.2s}
.adv[open] summary::before{transform:rotate(90deg)}
.adv summary:hover{color:var(--ink)}
.adv .hint{margin-left:auto;font-size:11px;color:var(--muted);font-weight:500}
.advbody{padding:0 12px 12px;display:flex;flex-direction:column;gap:8px}

/* ── 主按钮 ── */
.go{width:100%;padding:13px;border:0;border-radius:12px;color:#fff;cursor:pointer;
    font-weight:700;font-size:14.5px;font-family:inherit;
    background:linear-gradient(120deg,var(--accent),var(--accent2));
    box-shadow:0 6px 18px color-mix(in srgb,var(--accent) 35%,transparent);transition:.15s}
.go:hover{filter:brightness(1.06);transform:translateY(-1px)}
.go:disabled{background:var(--bg3);color:var(--muted);cursor:default;box-shadow:none;transform:none;filter:none}
.btn{border:1px solid var(--line2);background:var(--bg2);color:var(--ink2);border-radius:10px;
     padding:8px 13px;font-size:12.5px;font-family:inherit;font-weight:600;cursor:pointer;transition:.15s}
.btn:hover{background:var(--bg3);color:var(--ink)}
.btn.sm{padding:6px 11px;font-size:12px}
.btn.pri{background:linear-gradient(120deg,var(--accent),var(--accent2));color:#fff;border:0;
         box-shadow:0 4px 12px color-mix(in srgb,var(--accent) 30%,transparent)}
.btn.pri:hover{filter:brightness(1.06)}

/* ── 进度 ── */
.prog{height:6px;background:var(--bg3);border-radius:4px;overflow:hidden}
.prog i{display:block;height:100%;width:0;border-radius:4px;
        background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .3s}
.prog-cap{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:5px}

/* ── 状态 ── */
.st{display:block;padding:9px 12px;border-radius:10px;background:var(--soft);
    border-left:3px solid var(--accent);color:var(--accent);font-size:12.5px;font-weight:600}
.st.ok{background:var(--oksoft);border-color:var(--ok);color:var(--ok)}
.st.err{background:var(--badsoft);border-color:var(--bad);color:var(--bad)}
.st.run{background:var(--warnsoft);border-color:var(--warn);color:var(--warn)}

/* ── 统计 ── */
.nums{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center;font-size:11px;color:var(--muted)}
.nums b{display:block;font-size:16px;color:var(--ink);font-weight:700;line-height:1.25}

/* ── 段格子 ── */
.seg{display:flex;flex-wrap:wrap;gap:3px;max-height:56px;overflow-y:auto}
.seg i{width:18px;height:18px;border-radius:5px;font-size:10px;line-height:18px;text-align:center;
       font-style:normal;color:var(--muted);background:var(--bg3);font-weight:700}
.seg i.ok{background:var(--ok);color:#fff}
.seg i.bad{background:var(--bad);color:#fff}
.seg i.part{background:var(--warn);color:#fff}
.seg i.run{background:var(--accent);color:#fff}

/* ── 步骤引导 ── */
.guide{display:flex;align-items:center;gap:5px}
.guide i{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;
         font-style:normal;font-size:11.5px;font-weight:600;color:var(--muted);
         background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:7px 3px;
         transition:.18s;white-space:nowrap}
.guide i b{width:15px;height:15px;border-radius:50%;background:var(--bg3);color:var(--muted);
           font-size:9.5px;display:flex;align-items:center;justify-content:center;font-weight:700;
           flex:0 0 15px}
.guide i.on{color:var(--accent);background:var(--soft);
            border-color:color-mix(in srgb,var(--accent) 40%,var(--line))}
.guide i.on b{background:var(--accent);color:#fff}
.guide i.done{color:var(--ok);background:var(--oksoft);
              border-color:color-mix(in srgb,var(--ok) 35%,var(--line))}
.guide i.done b{background:var(--ok);color:#fff;font-size:0}
.guide i.done b::after{content:'✓';font-size:9.5px}
.hintline{font-size:11.5px;color:var(--muted);line-height:1.55;text-align:center}
.hintline b{color:var(--accent);font-weight:700}
.hintline.warn,.hintline.warn b{color:var(--bad)}

/* ── 日志 ── */
.logbox{background:var(--bg2);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.logbox summary{padding:10px 12px;cursor:pointer;font-size:12.5px;color:var(--ink2);list-style:none;
                display:flex;align-items:center;gap:7px;font-weight:600}
.logbox summary::-webkit-details-marker{display:none}
.logbox summary::before{content:'▸';color:var(--muted);font-size:10px;transition:.2s}
.logbox[open] summary::before{transform:rotate(90deg)}
.logbox .cnt{margin-left:auto;font-size:11px;color:var(--muted);font-weight:600;
             background:var(--bg3);border-radius:6px;padding:1px 7px}
.logacts{display:flex;gap:6px;padding:0 12px 8px}
.logacts button{background:var(--bg3);border:1px solid var(--line);color:var(--ink2);border-radius:8px;
                padding:4px 10px;cursor:pointer;font-size:11.5px;font-family:inherit;font-weight:600}
.logacts button:hover{background:var(--soft);color:var(--accent)}
.log{max-height:170px;overflow-y:auto;padding:0 12px 12px;
     font:11.5px/1.7 ui-monospace,Consolas,monospace;color:var(--ink2);white-space:pre-wrap;word-break:break-all}

/* ── 结果页 ── */
.hero{border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--bg2)}
.hero-img{position:relative;height:112px;background:linear-gradient(135deg,var(--accent),var(--accent2))}
.hero-img img{width:100%;height:100%;object-fit:cover;display:block}
.hero-img::after{content:'';position:absolute;inset:0;
                 background:linear-gradient(180deg,transparent 35%,rgba(0,0,0,.55))}
.hero-img .play{position:absolute;right:10px;bottom:10px;z-index:2;width:34px;height:34px;border-radius:50%;
                background:rgba(255,255,255,.92);color:#1a1526;display:flex;align-items:center;justify-content:center;
                font-size:14px;text-decoration:none;box-shadow:0 4px 12px rgba(0,0,0,.3)}
.hero-body{padding:12px 13px 13px}
.hero-body h3{margin:0 0 5px;font-size:14.5px;font-weight:700;color:var(--ink);
              overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badges{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}
.badge{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;
       background:var(--soft);color:var(--accent)}
.badge.ok{background:var(--oksoft);color:var(--ok)}
.badge.gray{background:var(--bg3);color:var(--muted)}
.hmeta{font-size:11.5px;color:var(--muted)}
.hactions{display:flex;gap:8px;margin-top:10px}
.hactions .go{flex:1;text-align:center;text-decoration:none;display:block;padding:11px}
.hint{font-size:11.5px;color:var(--muted);line-height:1.55}
.empty{color:var(--muted);font-size:12.5px;text-align:center;padding:38px 10px;line-height:1.9}

/* ── 提示条（恢复 / 网络） ── */
.resumebar,.netbar{display:none;flex-direction:column;gap:8px;padding:12px;border-radius:12px}
.resumebar{background:var(--warnsoft);border:1px solid color-mix(in srgb,var(--warn) 35%,var(--line))}
.netbar{background:var(--badsoft);border:1px solid color-mix(in srgb,var(--bad) 35%,var(--line))}
.resumebar.on,.netbar.on{display:flex}
.rb-h,.nb-h{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700}
.resumebar .rb-h{color:var(--warn)}
.netbar .nb-h{color:var(--bad)}
.rb-d,.nb-d{font-size:11.5px;color:var(--ink2);line-height:1.6}
.rb-acts{display:flex;gap:7px}
.rb-acts .btn{flex:1}

/* ── 作品库 ── */
.libtitle{display:flex;align-items:center;gap:9px;font-size:14.5px;font-weight:700}
.libtitle span{flex:1}
.linkbar{display:flex;gap:7px}
.linkbar .field{border-width:1.5px}
.linkbar .go{width:auto;padding:9px 16px;font-size:13px;flex:0 0 auto}
.libbar{display:flex;gap:7px}
.libbar .btn{flex:0 0 auto;padding:9px 12px}
.filters{display:flex;gap:5px;flex-wrap:wrap}
.fbtn{flex:1 1 0;min-width:70px;padding:8px 4px;border-radius:9px;background:var(--bg2);
      border:1px solid var(--line);color:var(--ink2);cursor:pointer;font-size:11.5px;
      font-family:inherit;font-weight:600;transition:.15s;white-space:nowrap}
.fbtn:hover{border-color:var(--line2);color:var(--ink)}
.fbtn.on{background:linear-gradient(120deg,var(--accent),var(--accent2));border-color:transparent;color:#fff}
.libstat{font-size:11.5px;color:var(--muted);line-height:1.5}
.hist{display:flex;flex-direction:column;gap:8px;max-height:430px;overflow-y:auto}
.hist>*{flex:0 0 auto}
.hitem{display:flex;align-items:center;gap:10px;padding:10px;border-radius:12px;background:var(--bg2);
       border:1px solid var(--line);border-left:3px solid var(--ok);transition:.15s}
.hitem:hover{border-color:var(--line2)}
.hitem.fail{border-left-color:var(--bad);opacity:.7}
.hitem .thumb{width:42px;height:42px;border-radius:9px;object-fit:cover;flex:0 0 42px;
              background:var(--soft);display:flex;align-items:center;justify-content:center;font-size:17px}
.hitem .hbody{flex:1;min-width:0}
.hitem .t{font-size:12.5px;font-weight:700;color:var(--ink);line-height:1.4;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hitem .meta{font-size:11px;color:var(--muted);margin-top:2px}
.hitem .hacts{display:flex;gap:5px;align-items:center}
.tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:5px;background:var(--bg3);
     color:var(--muted);font-weight:700;margin-left:4px}
.tag.gen{background:var(--soft);color:var(--accent)}
.tag.up{background:var(--warnsoft);color:var(--warn)}

/* 列表项里的按钮 */
.hitem .dl,.grp .gitem .dl{background:linear-gradient(120deg,var(--accent),var(--accent2));
  border:0;color:#fff;border-radius:8px;padding:6px 11px;font-size:11.5px;font-family:inherit;
  font-weight:700;cursor:pointer;white-space:nowrap;flex:0 0 auto;
  box-shadow:0 2px 8px color-mix(in srgb,var(--accent) 28%,transparent)}
.hitem .dl:hover,.grp .gitem .dl:hover{filter:brightness(1.07)}
.hitem .dl:disabled,.grp .gitem .dl:disabled{background:var(--bg3);color:var(--muted);
  filter:none;box-shadow:none;cursor:default}
.hitem .cp,.grp .gitem .cp{background:var(--bg3);border:1px solid var(--line);color:var(--ink2);
  border-radius:8px;padding:6px 8px;font-size:11.5px;cursor:pointer;font-family:inherit;
  flex:0 0 auto;line-height:1}
.hitem .cp:hover,.grp .gitem .cp:hover{background:var(--soft);color:var(--accent)}
.hitem .nope,.grp .gitem .nope{font-size:10.5px;color:var(--muted);flex:0 0 auto}
.hitem .thumb img{width:100%;height:100%;object-fit:cover;border-radius:9px;display:block}
.hitem .meta a{color:var(--accent);text-decoration:none}

/* 分组卡片（同一首歌的多个版本） */
.grp{background:var(--bg2);border:1px solid var(--line);border-radius:12px;overflow:hidden;
     border-left:3px solid var(--accent)}
.grp .ghead{display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:pointer;transition:.15s}
.grp .ghead:hover{background:var(--bg3)}
.grp .gtitle{flex:1;min-width:0;font-size:12.5px;font-weight:700;color:var(--ink);
             line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp .gcount{font-size:10.5px;font-weight:700;color:var(--accent);background:var(--soft);
             border-radius:6px;padding:2px 7px;white-space:nowrap;flex:0 0 auto}
.grp .garrow{color:var(--muted);font-size:10px;transition:.2s;flex:0 0 auto}
.grp.open .garrow{transform:rotate(90deg)}
.grp .glist{display:none;flex-direction:column;gap:6px;padding:0 9px 9px}
.grp.open .glist{display:flex}
.grp .gitem{display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:9px;
            background:var(--bg);border:1px solid var(--line)}
.grp .gitem .gmeta{flex:1;min-width:0;font-size:10.5px;color:var(--muted);line-height:1.45;
                   overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp .gitem .gmeta b{display:block;color:var(--ink);font-size:11.5px;font-weight:700;
                     margin-bottom:1px}
.gkind{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:5px;
       font-size:9.5px;font-weight:700;vertical-align:middle}
.gkind.up{background:var(--oksoft);color:var(--ok)}
.gkind.gen{background:var(--soft);color:var(--accent)}

/* ── 悬浮球 ── */
.ball{width:54px;height:54px;border-radius:50%;color:#fff;font-size:20px;cursor:pointer;
      display:flex;align-items:center;justify-content:center;position:relative;transition:.15s;
      background:linear-gradient(135deg,var(--accent),var(--accent2));
      box-shadow:0 10px 30px color-mix(in srgb,var(--accent) 45%,transparent)}
.ball:hover{transform:scale(1.06)}
.ball .badge{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;border-radius:10px;
             background:var(--warn);color:#fff;font-size:11px;font-weight:700;display:none;
             align-items:center;justify-content:center;padding:0 5px;border:2px solid var(--bg)}
.ball.run{animation:pulse 1.6s infinite}
@keyframes pulse{0%,100%{box-shadow:0 10px 30px color-mix(in srgb,var(--accent) 40%,transparent)}
                 50%{box-shadow:0 10px 44px color-mix(in srgb,var(--accent) 75%,transparent)}}
</style>
<div class="wrap">
  <div class="panel" id="panel">
    <div class="bar" id="dragbar">
      <div class="brand">
        <span class="logo">♪</span>
        <b>Suno 上传器</b>
        <span class="ver">${VERSION}</span>
      </div>
      <div class="baracts">
        <span class="dot" id="statusDot" title="状态"></span>
        <button id="btnMin" title="最小化">—</button>
      </div>
    </div>

    <div class="tabs" id="tabs">
      <button class="tab on" data-tab="main">上传</button>
      <button class="tab" data-tab="res">结果</button>
      <button class="tab" data-tab="hist">作品库</button>
      <button class="tab" data-tab="pts">积分</button>
    </div>

    <!-- ═════ 上传 ═════ -->
    <div class="body" id="bodyMain">
      <div class="guide" id="guide">
        <i data-g="1"><b>1</b>选文件</i>
        <i data-g="2"><b>2</b>参数</i>
        <i data-g="3"><b>3</b>上传</i>
        <i data-g="4"><b>4</b>成品</i>
      </div>
      <div class="hintline" id="hintline">把音频拖进来，或点下面的框选择文件</div>

      <div class="resumebar" id="resumebar">
        <div class="rb-h">发现上次未完成的进度</div>
        <div class="rb-d" id="resumeInfo"></div>
        <div class="rb-acts">
          <button class="btn pri sm" id="btnResume">恢复并继续</button>
          <button class="btn sm" id="btnDropResume">丢弃</button>
        </div>
      </div>

      <div class="netbar" id="netbar">
        <div class="nb-h"><span>📡</span><b>网络异常</b></div>
        <div class="nb-d" id="netInfo">连续多次请求失败，可能是网络不稳定。</div>
        <div class="rb-acts">
          <button class="btn pri sm" id="btnNetRetry">已换网络，继续</button>
          <button class="btn sm" id="btnNetSkip">跳过失败段</button>
        </div>
      </div>

      <div class="dd" id="d">
        <div class="dd-ico">🎵</div>
        <div class="dd-t">把音频拖到这里</div>
        <div class="dd-s">或点击选择 · WAV / MP3 / M4A / FLAC</div>
      </div>
      <input type="file" id="f" accept="audio/*,video/*" hidden>

      <div class="fcard" id="fileCard" style="display:none">
        <div class="fc-ico">🎧</div>
        <div class="fc-main"><b id="fcName">—</b><span id="fcMeta">—</span></div>
        <button class="btn sm" id="fcAgain">更换</button>
      </div>

      <div class="row"><label>项目名</label><input id="t" class="field" placeholder="默认用文件名"></div>

      <div class="grid2">
        <div class="row"><label>切片(秒)</label><input id="ss" class="field" value="6" title="6 秒最容易提高通过率（Suno 最短上传）"></div>
        <div class="row"><label>移调</label><input id="pitch" class="field" value="4" title="+4 保住 19kHz；超过 +7 会明显发闷"></div>
      </div>

      <details class="adv">
        <summary>更多参数<span class="hint">默认已调好，不用改</span></summary>
        <div class="advbody">
          <div class="grid2">
            <div class="row"><label>并发</label><input id="cf" class="field" value="6" title="同时上传几段，1-6"></div>
            <div class="row"><label>重试</label><input id="rt" class="field" value="3"></div>
            <div class="row"><label>补全轮数</label><input id="rr" class="field" value="3"></div>
          </div>
          <div class="row"><label>下载格式</label>
            <select id="fmt" class="field">
              <option value="m4a" selected>M4A（推荐 · 秒出）</option>
              <option value="mp3">MP3（首次需下编码器）</option>
              <option value="wav">WAV（无损、体积大）</option>
            </select>
          </div>
        </div>
      </details>

      <div class="chips">
        <label class="chip"><input type="checkbox" id="doExport" checked><span>自动导出</span></label>
        <label class="chip"><input type="checkbox" id="doClean" checked><span>自动清洗</span></label>
      </div>

      <button class="go" id="go" style="display:none">开始上传</button>

      <div id="progWrap" style="display:none">
        <div class="prog" id="bar"><i id="barIn"></i></div>
        <div class="prog-cap"><span id="stage">准备</span><span><span id="pct">0%</span><span id="eta" style="margin-left:8px"></span></span></div>
      </div>

      <div class="st" id="st">等待文件</div>
      <div class="nums">
        <span><b id="n1">0</b>成功</span>
        <span><b id="n2">0</b>缺失</span>
        <span><b id="n3">0</b>总段</span>
        <span><b id="n4">0</b>轮次</span>
      </div>
      <div class="seg" id="sg"></div>

    </div>

    <!-- ═════ 结果 ═════ -->
    <div class="body" id="bodyRes" style="display:none">
      <div class="empty" id="resEmpty">还没有作品<br>上传完成后，完整作品会出现在这里</div>
      <div id="resWrap" style="display:none"></div>
    </div>

    <!-- ═════ 作品库 ═════ -->
    <div class="body" id="bodyHist" style="display:none">
      <div class="libtitle"><span>📚 作品库</span></div>
      <div class="linkbar">
        <input id="linkInput" class="field" placeholder="粘贴歌曲链接或 ID，回车直接下载">
        <button class="go" id="linkGo">下载</button>
      </div>
      <div class="hint">支持 <code>suno.com/song/xxx</code>、<code>suno.com/clip/xxx</code> 或直接粘贴 ID</div>
      <div class="libbar">
        <input id="libq" class="field" placeholder="搜索我的作品...">
        <button class="btn" id="libRefresh">⟳ 刷新</button>
      </div>
      <div class="filters">
        <button class="fbtn on" data-f="all">全部</button>
        <button class="fbtn" data-f="upfull">⬆ 上传合成</button>
        <button class="fbtn" data-f="genfull">✨ AI 生成</button>
        <button class="fbtn" data-f="part">片段</button>
      </div>
      <div class="libstat" id="libstat"></div>
      <div class="hist" id="hist"><div class="empty">点「⟳ 刷新」加载我的作品</div></div>
    </div>

    <!-- ═════ 积分 ═════ -->
    <div class="body" id="bodyPts" style="display:none">
      <div class="libtitle"><span>⚡ 听歌赚积分</span></div>
      <div class="libstat" id="ptsStat">自动完成 listen-and-rank 的评分任务，全程静音，不出声。</div>
      <div class="row"><label>最多轮数</label><input id="ptsMax" class="field" value="40" title="跑够这么多题自动停；0 = 不限"></div>
      <button class="go" id="ptsGo">开始赚积分</button>
      <div class="st" id="ptsState">未开始</div>
    </div>
  </div>

  <div class="ball" id="ball" style="display:none" title="打开上传器">♪
    <span class="badge" id="badge"></span>
  </div>
</div>`;
    document.body.appendChild(host);

    const $ = s => sh.querySelector(s);
    const stEl = $('#st'),
          barIn = $('#barIn'), progWrapEl = $('#progWrap'),
          pctEl = $('#pct'), etaEl = $('#eta'), stageEl = $('#stage'),
          guideEl = $('#guide'), hintEl = $('#hintline'),
          segEl = $('#sg'), histEl = $('#hist'),
          ballEl = $('#ball'), badgeEl = $('#badge'),
          panelEl = $('#panel'), tabsEl = $('#tabs'),
          bodyMain = $('#bodyMain'), bodyHist = $('#bodyHist'),
          bodyPts = $('#bodyPts'), bodyRes = $('#bodyRes'),
          resEmpty = $('#resEmpty'), resWrap = $('#resWrap'),
          statusDotEl = $('#statusDot'),
          fileCardEl = $('#fileCard'), fcNameEl = $('#fcName'), fcMetaEl = $('#fcMeta'),
          netbarEl = $('#netbar'), resumebarEl = $('#resumebar');

    const lines = [];
    let file = null, audio = null, segs = [], running = false;

    // ==================== 阶段 ====================
    const STAGES = { 1: '准备', 2: '切片', 3: '上传', 4: '建项目', 5: '导出', 6: '完成' };
    let curStep = 1;
    function setStep(n) {
      curStep = n;
      if (stageEl) {
        stageEl.textContent = STAGES[n] || '';
        progWrapEl.style.display = n > 1 ? 'block' : 'none';
      }
    }
    setStep(1);

    // ==================== 网络状态 ====================
    // 连续失败计数：达到阈值就暂停，提示用户换网络，换好后点「继续」
    let netFail = 0;
    let netPaused = false;
    let netResolve = null;        // 继续的 Promise resolver
    let netSkip = false;          // 用户选择跳过失败段

    // 把底层请求的失败/成功上报接到这里
    NET.onFail = (reason) => { netBad(reason) };
    NET.onOk = () => { netOk() };

    function netOk() {
      if (netFail > 0) netFail = 0;
    }

    function netBad(reason) {
      netFail++;
      if (netFail >= 3 && !netPaused) {
        pauseForNet(reason);
        return true;
      }
      return false;
    }

    function pauseForNet(reason) {
      netPaused = true;
      netSkip = false;
      $('#netInfo').textContent =
        '连续 ' + netFail + ' 次请求失败' + (reason ? '（' + reason + '）' : '') +
        '。请检查网络，必要时切换 WiFi / 手机热点 / 代理，然后点「继续」。' +
        '已上传的片段不会丢失。';
      netbarEl.classList.add('on');
      status('网络异常，已暂停', 'err');
      log('');
      log('⚠ 网络异常：连续 ' + netFail + ' 次失败');
      log('  请更换网络后点面板上的「已换网络，继续」');
      log('  已经上传成功的片段会保留，不会重传');
    }

    /** 等待用户点「继续」。恢复网络后自动往下走。 */
    function waitNetResume() {
      return new Promise(resolve => {
        if (!netPaused) return resolve('ok');
        netResolve = resolve;
      });
    }

    $('#btnNetRetry').onclick = () => {
      netPaused = false;
      netFail = 0;
      netbarEl.classList.remove('on');
      status('继续上传...', 'run');
      log('→ 已恢复网络，继续上传');
      if (netResolve) { const r = netResolve; netResolve = null; r('ok'); }
    };

    $('#btnNetSkip').onclick = () => {
      netPaused = false;
      netFail = 0;
      netSkip = true;
      netbarEl.classList.remove('on');
      status('跳过失败段...', 'run');
      log('→ 跳过当前失败的片段，继续后面的');
      if (netResolve) { const r = netResolve; netResolve = null; r('skip'); }
    };

    // ==================== 进度存档（刷新后可恢复） ====================
    /**
     * 把进度存到 GM 存储。
     * 浏览器刷新后可以恢复已上传的片段，不用重传。
     *
     * 注意：File 对象无法持久化，恢复时需要用户重新选择同一个文件
     * （用文件名 + 大小校验是不是同一个）。
     */
    function saveProgress(stage, extra) {
      try {
        if (!file) return;
        const snap = Object.assign({
          at: Date.now(),
          stage: stage,                     // 'upload' | 'project' | 'export' | 'done'
          fileName: file.name,
          fileSize: file.size,
          title: $('#t').value,
          pitch: $('#pitch').value,
          slice: $('#ss').value,
          segs: segs.map(s => ({
            idx: s.idx, t0: s.t0, t1: s.t1,
            clipId: s.clipId || null
          })),
          pieces: (window.__PIECES || []).map(p => ({
            clipId: p.clipId, t0: p.t0, t1: p.t1,
            semis: p.semis, depth: p.depth,
            origDur: p.origDur, audioDur: p.audioDur, padDur: p.padDur
          })),
          projectId: window.__PID || null,
          exportId: window.__EXPORT || null
        }, extra || {});
        GM_setValue(K_PROG, JSON.stringify(snap));
      } catch (e) { /* 存不下就算了 */ }
    }

    function loadProgress() {
      try {
        const raw = GM_getValue(K_PROG, '');
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (!p || !p.segs || !p.segs.length) return null;
        // 超过 3 天的记录忽略（片段可能已被 Suno 清理）
        if (Date.now() - (p.at || 0) > 3 * 86400 * 1000) return null;
        return p;
      } catch (e) { return null }
    }

    function clearProgress() {
      try { GM_setValue(K_PROG, ''); } catch (e) {}
    }

    /** 显示「恢复上次进度」提示条 */
    function showResumeBar(p) {
      const done = p.segs.filter(s => s.clipId).length;
      const total = p.segs.length;
      $('#resumeInfo').textContent =
        '《' + p.fileName + '》 已上传 ' + done + ' / ' + total + ' 段' +
        (p.stage !== 'upload' ? '（已到「' + stageName(p.stage) + '」阶段）' : '') +
        '。点「恢复」后需要重新选择这个文件。';
      resumebarEl.classList.add('on');
    }

    function stageName(s) {
      return ({ upload: '上传', project: '建项目', export: '导出', done: '完成' })[s] || s;
    }

    /**
     * 运行日志：只留在内存里，界面上不再显示（客户版）。
     * 排错时用 Tampermonkey 菜单「复制运行日志」导出。
     */
    function log(m) {
      lines.push(m);
      if (lines.length > 1200) lines.shift();
      try { console.debug('[suno]', m); } catch (e) {}
    }
    /** 状态行 + 顶栏小圆点，一处改两处同步 */
    function status(m, c) {
      stEl.textContent = m;
      stEl.className = 'st' + (c ? ' ' + c : '');
      if (statusDotEl) statusDotEl.className = 'dot' + (c ? ' ' + c : '');
    }

    // ---- 步骤引导 ----
    let curGuide = 1;
    /** n = 1..4：当前第几步；比 n 小的自动打勾 */
    function setGuide(n) {
      curGuide = n;
      if (!guideEl) return;
      Array.from(guideEl.querySelectorAll('i')).forEach(el => {
        const k = parseInt(el.dataset.g, 10);
        el.classList.toggle('done', k < n);
        el.classList.toggle('on', k === n);
      });
    }
    /** 引导下面那行提示：一句话说清"现在该干嘛" */
    function hint(text, warn) {
      if (!hintEl) return;
      hintEl.innerHTML = text || '';
      hintEl.className = 'hintline' + (warn ? ' warn' : '');
    }
    setGuide(1);

    function prog(p) {
      const v = Math.max(0, Math.min(1, p || 0));
      progWrapEl.style.display = v > 0 ? 'block' : 'none';
      barIn.style.width = Math.round(v * 100) + '%';
      if (pctEl) pctEl.textContent = Math.round(v * 100) + '%';
    }

    // ---- 进度 + 剩余时间 ----
    let upStartAt = 0, upDone = 0, upTotal = 0;

    /** 毫秒 → 「约 2 分 10 秒」 */
    function fmtLeft(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return s + ' 秒';
      const m = Math.floor(s / 60);
      const r = s % 60;
      return m + ' 分' + (r ? ' ' + r + ' 秒' : '');
    }

    function setEta(text) {
      if (etaEl) etaEl.textContent = text || '';
    }

    /**
     * 上传阶段的统一进度入口：百分比 + 预计剩余。
     * 估算方式：已用时间 ÷ 已完成段数 × 剩余段数（段耗时差异不大，够准）。
     */
    function setProgress(done, total) {
      upDone = done; upTotal = total;
      prog(total ? done / total : 0);
      if (done >= total) {
        setEta('');
        hint('上传完成，正在合并成整首…');
        return;
      }
      if (!upStartAt || done <= 0) { setEta(''); hint('正在切段准备上传…'); return; }
      const per = (Date.now() - upStartAt) / done;
      const left = per * (total - done);
      const tail = left > 1000 ? '剩余约 ' + fmtLeft(left) : '快好了';
      setEta('· ' + tail);
      hint('正在上传 <b>' + done + '</b> / ' + total + ' 段 · ' + tail);
    }

    function resetProgressClock() {
      upStartAt = Date.now();
      upDone = 0; upTotal = 0;
      setEta('');
    }
    function paint() {
      // 只统计真正"完整"的段（部分覆盖的段不算成功）
      const ok = segs.filter(s => s.state === 'ok').length;
      $('#n1').textContent = ok;
      $('#n2').textContent = segs.length - ok;
      $('#n3').textContent = segs.length;
      segEl.innerHTML = segs.map(s => {
        let cls = '', txt = s.idx;
        if (s.state === 'ok') { cls = 'ok'; txt = '✓' }
        else if (s.state === 'part') { cls = 'part'; txt = '±' }
        else if (s.state === 'bad') { cls = 'bad'; txt = '×' }
        else if (s.state === 'run') { cls = 'run'; txt = s.idx }
        return '<i class="' + cls + '" title="第' + s.idx + '段">' + txt + '</i>';
      }).join('');
    }

    function setMin(m) {
      GM_setValue(K_MIN, m);
      panelEl.style.display = m ? 'none' : 'flex';
      ballEl.style.display = m ? 'flex' : 'none';
    }
    $('#btnMin').onclick = () => setMin(true);
    ballEl.onclick = () => setMin(false);
    setMin(minimized);

    // 拖动
    (function makeDraggable() {
      const bar = $('#dragbar');
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      function onDown(cx, cy, tgt) {
        if (tgt && tgt.tagName === 'BUTTON') return;
        const r = host.getBoundingClientRect();
        dragging = true;
        bar.classList.add('grab');
        sx = cx; sy = cy; ox = r.left; oy = r.top;
      }
      function onMove(cx, cy) {
        if (!dragging) return;
        let nx = ox + (cx - sx), ny = oy + (cy - sy);
        const w = host.offsetWidth || 400;
        nx = Math.max(4, Math.min(window.innerWidth - w - 4, nx));
        ny = Math.max(4, Math.min(window.innerHeight - 40, ny));
        host.style.left = nx + 'px';
        host.style.top = ny + 'px';
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      }
      function onUp() {
        if (!dragging) return;
        dragging = false;
        bar.classList.remove('grab');
        const r = host.getBoundingClientRect();
        GM_setValue(K_POS, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
      }

      // 窗口尺寸变化时，把面板拉回可视区域（防止面板跑到屏幕外看不见）
      function keepInView() {
        const r = host.getBoundingClientRect();
        const W = window.innerWidth, H = window.innerHeight;
        let nx = r.left, ny = r.top, moved = false;
        if (nx > W - 120) { nx = Math.max(0, W - 120); moved = true; }
        if (ny > H - 80) { ny = Math.max(0, H - 80); moved = true; }
        if (nx < 0) { nx = 0; moved = true; }
        if (ny < 0) { ny = 0; moved = true; }
        if (moved) {
          host.style.left = nx + 'px';
          host.style.top = ny + 'px';
          host.style.right = 'auto';
          host.style.bottom = 'auto';
          GM_setValue(K_POS, JSON.stringify({ x: Math.round(nx), y: Math.round(ny) }));
        }
      }
      window.addEventListener('resize', keepInView);
      setTimeout(keepInView, 300);
      bar.addEventListener('mousedown', e => { onDown(e.clientX, e.clientY, e.target); e.preventDefault(); });
      document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY), true);
      document.addEventListener('mouseup', onUp, true);
      bar.addEventListener('touchstart', e => {
        const t = e.touches[0];
        onDown(t.clientX, t.clientY, e.target);
        e.preventDefault();
      }, { passive: false });
      document.addEventListener('touchmove', e => {
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
      }, { passive: true });
      document.addEventListener('touchend', onUp, true);
    })();

    let tab = 'main';
    const TAB_BODY = { main: bodyMain, res: bodyRes, hist: bodyHist, pts: bodyPts };
    function switchTab(t) {
      if (!TAB_BODY[t]) t = 'main';
      tab = t;
      Object.keys(TAB_BODY).forEach(k => {
        const b = TAB_BODY[k];
        if (b) b.style.display = k === t ? 'flex' : 'none';
      });
      Array.from(tabsEl.querySelectorAll('.tab')).forEach(btn => {
        btn.classList.toggle('on', btn.dataset.tab === t);
      });
      if (t === 'hist' && !libAll.length) {
        // ★ 先用本地缓存秒出，不重新翻 40 页
        const cache = loadLibCache();
        if (cache) {
          libAll = cache.items;
          renderLib();
          log('作品库: 已从本地缓存加载 ' + libAll.length + ' 条（' +
              timeAgo(cache.at) + '刷新）');
        } else {
          loadLibrary();
        }
      }
    }
    Array.from(tabsEl.querySelectorAll('.tab')).forEach(btn => {
      btn.onclick = () => switchTab(btn.dataset.tab);
    });

    // ==================== 听歌赚积分 ====================
    const ptsStateEl = $('#ptsState'), ptsStatEl = $('#ptsStat'), ptsMaxEl = $('#ptsMax');
    const ptsGoEl = $('#ptsGo');
    const ptsLines = [];   // 同样只在内存里，界面不显示
    function ptsLine(m) {
      ptsLines.push(new Date().toLocaleTimeString() + '  ' + m);
      if (ptsLines.length > 300) ptsLines.shift();
      try { console.debug('[suno:pts]', m); } catch (e) {}
    }

    const farmer = createPointsFarmer({
      log: ptsLine,
      state: (m, c) => { ptsStateEl.textContent = m; ptsStateEl.className = 'st' + (c ? ' ' + c : ''); },
      done: () => { ptsGoEl.textContent = '开始赚积分'; },
    });

    function ptsStart() {
      const max = parseInt(ptsMaxEl.value, 10);
      farmer.start(isNaN(max) ? 40 : max);
      ptsGoEl.textContent = '停止';
      if (tab !== 'pts') switchTab('pts');
    }
    ptsGoEl.onclick = () => {
      if (farmer.isOn()) { farmer.stop('手动停止'); }
      else { ptsStart(); }
    };
    // 刷新页面后自动续跑（跨页跳转也能接上）
    setTimeout(() => farmer.resumeIfArmed(parseInt(ptsMaxEl.value, 10) || 40), 1200);

    function backToMain() { switchTab('main'); }

    // ---- 结果页 ----
    function resetResultView() {
      if (resEmpty) resEmpty.style.display = '';
      if (resWrap) { resWrap.style.display = 'none'; resWrap.innerHTML = ''; }
    }

    /**
     * 把最终成品摆到「结果」页正中间。
     *
     * 现在的定位：上传的终点就是 Suno 里那首完整作品，不再默认下载到本地。
     * 所以这里给的是 封面 + 标题 + 时长 + 一键打开 + 复制 ID；下载降级成可选小按钮。
     */
    async function showResult(d) {
      const clipId = d.clipId || null;
      const projectId = d.pid || null;
      const link = clipId ? 'https://suno.com/song/' + clipId
                          : (projectId ? 'https://suno.com/studio/' + projectId : '');
      const secs = d.seconds ? d.seconds.toFixed(1) + 's' : '';
      const meta = [secs, d.segCount ? d.segCount + ' 段' : '', d.type || '']
        .filter(Boolean).join(' · ');

      resEmpty.style.display = 'none';
      resWrap.style.display = 'block';
      resWrap.innerHTML = `
        <div class="hero">
          <div class="hero-img" id="heroImg">
            ${clipId ? '<a class="play" href="' + link + '" target="_blank" title="在 Suno 打开">▶</a>' : ''}
          </div>
          <div class="hero-body">
            <div class="badges">
              ${d.missing ? '<span class="badge gray">有缺段 · 未导出</span>'
                          : '<span class="badge ok">完整作品</span>'}
              ${clipId ? '<span class="badge">可直接 Cover</span>' : ''}
              ${(d.semis && d.semis.length) ? '<span class="badge gray">还原 ' + d.semis.join('/') + ' 半音</span>' : ''}
            </div>
            <h3 title="${escapeAttr(d.title || '')}">${escapeHtml(d.title || '未命名')}</h3>
            <div class="hmeta">${escapeHtml(meta || '—')}</div>
            <div class="hactions">
              ${d.missing
                ? '<button class="go" id="resRetry">只补缺的 ' + d.missing + ' 段</button>'
                : (link ? '<a class="go" href="' + link + '" target="_blank">在 Suno 打开</a>' : '')}
              ${clipId ? '<button class="btn" id="resCopy">复制 ID</button>' : ''}
            </div>
            ${d.missing
              ? '<div class="hint" style="margin-top:8px;color:var(--bad)">缺 ' +
                escapeHtml((d.missingNames || []).join('、')) +
                '，已阻止导出（强行导出会得到中间缺一段、后面全错位的歌）。</div>' +
                '<div class="hint" style="margin-top:4px">已经成功的段不会重传。' +
                (file ? '' : ' 需要先把原文件重新拖进来（进度已保存）。') + '</div>'
              : '<div class="hint" style="margin-top:8px">成品已在你的 Suno 账号里，打开就能听 / 做 Cover。</div>'}
            ${projectId
              ? '<div class="hint" style="margin-top:4px"><a href="https://suno.com/studio/' + projectId +
                '" target="_blank" style="color:var(--accent);text-decoration:none">在 Studio 打开项目 →</a></div>'
              : ''}
            ${clipId ? '<button class="btn sm" id="resDl" style="margin-top:8px">下载到本地（可选）</button>' : ''}
          </div>
        </div>`;

      // 封面（拿不到就保持渐变底，不影响功能）
      if (clipId) {
        try {
          const r = await gmFetch('GET', API + '/api/clip/' + clipId, null, 15000);
          if (r.status === 200) {
            const c = JSON.parse(r.text);
            const img = c.image_large_url || c.image_url;
            const box = resWrap.querySelector('#heroImg');
            if (img && box) {
              const im = document.createElement('img');
              im.src = img;
              im.alt = '';
              box.insertBefore(im, box.firstChild);
            }
          }
        } catch (e) { /* 封面失败无所谓 */ }

        const cp = resWrap.querySelector('#resCopy');
        if (cp) cp.onclick = () => {
          if (copyText(clipId)) {
            cp.textContent = '✓ 已复制';
            setTimeout(() => { cp.textContent = '复制 ID'; }, 1500);
          }
        };
        const dl = resWrap.querySelector('#resDl');
        if (dl) dl.onclick = () => doDownload(clipId, d.title, dl);
      }

      // 缺段：一键只补缺的那几段
      const rb = resWrap.querySelector('#resRetry');
      if (rb) rb.onclick = () => {
        if (!file) {
          switchTab('main');
          status('请把原文件重新拖进来再补', 'err');
          log('⚠ 「只补缺段」需要原文件：把同一个文件再拖进来，会提示「恢复上次进度」');
          return;
        }
        switchTab('main');
        log('');
        log('=== 只补缺段 ===');
        run();
      };

      switchTab('res');
    }

    /** 剪贴板（异步 API 不可用时回退到 execCommand） */
    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(() => {});
          return true;
        }
      } catch (e) {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    }

    // ---- 通用下载动作 ----
    async function doDownload(clipId, title, btn) {
      const old = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '下载中...'; }
      try {
        log('下载: ' + (title || clipId));
        const blob = await downloadClip(clipId, log);
        const fmt = getFormat();
        const name = safeName(title);
        const realFmt = await convertAndSave(blob, fmt, name, log);
        log('  ✓ 已保存 ' + name + '.' + realFmt);
        if (btn) btn.textContent = '✓ 已下载';
      } catch (e) {
        log('  ✗ 下载失败: ' + e.message);
        if (btn) { btn.textContent = '重试'; btn.disabled = false; }
        return;
      }
      setTimeout(() => { if (btn) { btn.textContent = old || '下载'; btn.disabled = false; } }, 3000);
    }

    function getFormat() {
      const el = $('#fmt');
      return el ? el.value : 'm4a';
    }

    // ==================== 粘贴链接下载 ====================
    /**
     * 从各种形态里抠出 clip id：
     *   https://suno.com/song/<id>
     *   https://suno.com/clip/<id>
     *   https://suno.com/song/<id>?sh=xxx
     *   <id>  直接是 uuid
     */
    function parseClipId(text) {
      const s = String(text || '').trim();
      if (!s) return null;
      const m = s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      return m ? m[1] : null;
    }

    /** 是不是短分享链接 suno.com/s/xxxx */
    function isShortLink(text) {
      return /suno\.com\/s\/[A-Za-z0-9_-]+/i.test(String(text || ''));
    }

    /**
     * 解析短分享链接
     *
     * suno.com/s/<短码> 会跳转到 suno.com/song/<uuid>?sh=<短码>，
     * GM_xmlhttpRequest 自动跟随跳转，finalUrl 里就带真正的 clip id。
     */
    function resolveShortLink(text) {
      const raw = String(text || '').trim();
      const url = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw);
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 20000,
          onload: r => {
            const finalUrl = r.finalUrl || r.responseURL || '';
            const id = parseClipId(finalUrl) || parseClipId(r.responseText || '');
            if (id) resolve(id);
            else reject(new Error('跳转后找不到歌曲 ID'));
          },
          onerror: () => reject(new Error('解析短链接失败（网络）')),
          ontimeout: () => reject(new Error('解析短链接超时'))
        });
      });
    }

    async function downloadByLink() {
      const raw = ($('#linkInput').value || '').trim();
      if (!raw) {
        log('请先粘贴歌曲链接');
        status('请输入链接', 'err');
        return;
      }

      let id = parseClipId(raw);
      const btn = $('#linkGo');
      btn.disabled = true;
      btn.textContent = '解析中';

      // 短分享链接：先跟随跳转拿真实 id
      if (!id && isShortLink(raw)) {
        try {
          log('解析短链接: ' + raw);
          status('解析短链接...', 'run');
          id = await resolveShortLink(raw);
          log('  → 歌曲 ID: ' + id);
          $('#linkInput').value = 'https://suno.com/song/' + id;
        } catch (e) {
          log('✗ ' + e.message);
          log('  办法：手动打开那个链接，把地址栏里 suno.com/song/xxx 那串复制过来');
          status('短链接解析失败', 'err');
          btn.disabled = false;
          btn.textContent = '下载';
          return;
        }
      }

      if (!id) {
        log('✗ 认不出链接里的歌曲 ID');
        log('  支持:');
        log('    https://suno.com/song/xxxxxxxx-xxxx-...');
        log('    https://suno.com/s/AbCdEf123      （短分享链接）');
        status('链接格式不对', 'err');
        btn.disabled = false;
        btn.textContent = '下载';
        return;
      }

      btn.textContent = '下载中';

      try {
        log('');
        log('=== 按链接下载 ===');
        log('ID: ' + id);

        // 先查一下这首歌的信息，好起文件名
        let title = id.slice(0, 8);
        try {
          const rc = await gmFetch('GET', API + '/api/clip/' + id, null, 20000);
          if (rc.status === 200) {
            const cd = JSON.parse(rc.text);
            if (cd.title) title = cd.title;
            log('标题: ' + title);
            if (cd.metadata && cd.metadata.duration) {
              log('时长: ' + cd.metadata.duration.toFixed(0) + 's');
            }
          } else {
            log('查询歌曲信息 HTTP ' + rc.status + '（继续尝试下载）');
          }
        } catch (e) { log('查询信息失败，继续下载') }

        status('下载中...', 'run');
        const blob = await downloadClip(id, log);
        const fmt = getFormat();
        const name = safeName(title);
        const realFmt = await convertAndSave(blob, fmt, name, log);
        log('✓ 已保存: ' + name + '.' + realFmt);
        status('下载完成', 'ok');
        btn.textContent = '✓ 完成';
      } catch (e) {
        log('✗ 下载失败: ' + e.message);
        status('下载失败: ' + e.message, 'err');
        btn.textContent = '下载';
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = '下载'; }, 2500);
      }
    }

    $('#linkGo').onclick = downloadByLink;
    $('#linkInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') downloadByLink();
    });
    // 粘贴即自动识别并提示
    $('#linkInput').addEventListener('paste', () => {
      setTimeout(() => {
        const id = parseClipId($('#linkInput').value);
        if (id) status('已识别 ID，回车下载', 'ok');
      }, 60);
    });

    // ---- 作品库 ----
    let libAll = [];
    let libLoading = false;
    let libFilter = 'all';       // all | upfull | genfull | part

    /**
     * 上传合成完整版：脚本把切片拼起来导出的成品
     *
     * 特征（实测数据）：
     *   type    = rendered_context_window / studio_export / edit_crop
     *   model   = chirp-chirp
     *   metadata 里有 studio_project_start_beats / studio_project_end_beats
     *   is_remix = false
     */
    const UP_FULL_TYPES = ['rendered_context_window', 'studio_export', 'edit_crop'];
    function isUploadedFull(h) {
      return UP_FULL_TYPES.indexOf(h.type) >= 0;
    }

    /**
     * AI 生成完整版：Suno 模型生成的歌（含从上传歌做 Cover 出来的）
     *
     * 特征：
     *   type    = gen
     *   model   = chirp-hawk / chirp-v4 等真实模型
     *   metadata.task = 'cover' / 'extend' / ...
     *   is_remix = true，带 cover_clip_id
     */
    function isGeneratedFull(h) {
      return h.type === 'gen';
    }

    /** 上传的切片片段 */
    function isPart(h) {
      return !isUploadedFull(h) && !isGeneratedFull(h);
    }

    function isFull(h) {
      return isUploadedFull(h) || isGeneratedFull(h);
    }

    /** 去掉 (Full) 后缀，用于分组归并 */
    function baseTitle(t) {
      return String(t || '').replace(/\s*\((Full|Edit)\)\s*$/i, '').trim();
    }

    function typeTag(t) {
      if (t === 'gen') return '<span class="tag gen">AI生成</span>';
      if (t === 'upload' || t === 'upsample') return '<span class="tag up">片段</span>';
      if (t === 'studio_export') return '<span class="tag gen">上传合成</span>';
      if (t === 'rendered_context_window') return '<span class="tag gen">上传合成</span>';
      if (t === 'edit_crop') return '<span class="tag gen">上传合成</span>';
      return '<span class="tag">' + t + '</span>';
    }

    function bindItemButtons(root) {
      root.querySelectorAll('button.dl').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          doDownload(btn.dataset.id, btn.dataset.t, btn);
        };
      });
      root.querySelectorAll('button.cp').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const url = 'https://suno.com/song/' + btn.dataset.id;
          try {
            await navigator.clipboard.writeText(url);
            const old = btn.textContent;
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = old }, 1400);
            log('已复制链接: ' + url);
          } catch (err) {
            log('复制失败，链接: ' + url);
          }
        };
      });
    }

    function renderLib() {
      const q = ($('#libq').value || '').trim().toLowerCase();
      let list = libAll;

      // 筛选
      if (libFilter === 'upfull') list = list.filter(isUploadedFull);
      else if (libFilter === 'genfull') list = list.filter(isGeneratedFull);
      else if (libFilter === 'part') list = list.filter(isPart);

      if (q) list = list.filter(h => String(h.title).toLowerCase().indexOf(q) >= 0);

      // 统计条
      const nUp = libAll.filter(isUploadedFull).length;
      const nGen = libAll.filter(isGeneratedFull).length;
      const nPart = libAll.filter(isPart).length;
      const stat = $('#libstat');
      if (stat) {
        const cache = loadLibCache();
        stat.textContent = '共 ' + libAll.length + ' 条（上传合成 ' + nUp +
          ' · AI生成 ' + nGen + ' · 片段 ' + nPart + '）' +
          (libFilter !== 'all' ? ' · 当前 ' + list.length + ' 条' : '') +
          (cache ? ' · ' + timeAgo(cache.at) + '刷新' : '');
      }

      if (!list.length) {
        histEl.innerHTML = '<div class="empty">' +
          (libAll.length ? '没有匹配的歌曲' : '点「⟳ 刷新」加载我的作品') + '</div>';
        return;
      }

      // ★ 两种完整版都按歌名分组：同一首歌的多个版本折叠成一条
      if (libFilter === 'upfull' || libFilter === 'genfull') {
        const groups = new Map();
        for (const h of list) {
          const key = baseTitle(h.title);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(h);
        }
        const arr = Array.from(groups.entries());

        histEl.innerHTML = arr.map(([title, items], gi) => {
          const kind = isUploadedFull(items[0]) ? '上传合成' : 'AI生成';
          return '<div class="grp" data-g="' + gi + '">' +
            '<div class="ghead">' +
              '<div class="gtitle">' + escapeHtml(title) +
                '<span class="gkind ' + (isUploadedFull(items[0]) ? 'up' : 'gen') + '">' +
                kind + '</span></div>' +
              '<span class="gcount">' + items.length + ' 个版本</span>' +
              '<span class="garrow">▸</span>' +
            '</div>' +
            '<div class="glist">' +
              items.map(h => {
                const canDl = h.status === 'complete';
                const dur = h.duration ? Math.round(h.duration) + 's' : '--';
                const when = (h.createdAt || '').replace('T', ' ').slice(0, 16);
                return '<div class="gitem">' +
                  '<div class="gmeta">' +
                    '<b>' + dur + (h.model ? ' · ' + h.model : '') + '</b>' +
                    when +
                  '</div>' +
                  (canDl
                    ? '<button class="dl" data-id="' + h.id + '" data-t="' +
                        escapeAttr(h.title) + '">⬇ 下载</button>'
                    : '<span class="nope">未完成</span>') +
                  '<button class="cp" data-id="' + h.id + '" title="复制链接">🔗</button>' +
                '</div>';
              }).join('') +
            '</div>' +
          '</div>';
        }).join('');

        histEl.querySelectorAll('.grp .ghead').forEach(head => {
          head.onclick = () => head.parentNode.classList.toggle('open');
        });
        // 第一个默认展开
        const first = histEl.querySelector('.grp');
        if (first) first.classList.add('open');
        bindItemButtons(histEl);
        return;
      }

      // 全部 / 片段：平铺列表
      histEl.innerHTML = list.map(h => {
        const canDl = h.status === 'complete';
        const dur = h.duration ? Math.round(h.duration) + 's' : '--';
        const img = h.image
          ? '<img class="thumb" src="' + escapeAttr(h.image) + '" loading="lazy">'
          : '<div class="thumb ph">♪</div>';
        return '<div class="hitem' + (canDl ? '' : ' fail') + '">' +
          img +
          '<div class="hbody">' +
            '<div class="t">' + escapeHtml(h.title) + '</div>' +
            '<div class="meta">' + typeTag(h.type) + ' · ' + dur +
              (h.model ? ' · ' + h.model : '') + '</div>' +
          '</div>' +
          '<div class="hacts">' +
            (canDl
              ? '<button class="dl" data-id="' + h.id + '" data-t="' +
                  escapeAttr(h.title) + '">⬇ 下载</button>'
              : '<span class="nope">未完成</span>') +
            '<button class="cp" data-id="' + h.id + '" title="复制歌曲链接">🔗</button>' +
          '</div>' +
        '</div>';
      }).join('');

      bindItemButtons(histEl);
    }

    // 筛选按钮
    Array.from(sh.querySelectorAll('.fbtn')).forEach(b => {
      b.onclick = () => {
        libFilter = b.dataset.f;
        Array.from(sh.querySelectorAll('.fbtn')).forEach(x => x.classList.toggle('on', x === b));
        renderLib();
      };
    });

    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
    function escapeAttr(s) {
      return String(s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    async function loadLibrary() {
      if (libLoading) return;
      libLoading = true;
      histEl.innerHTML = '<div class="empty">加载中... 正在翻页（完整版通常在第 12 页之后）</div>';
      try {
        // ★ 翻到 40 页（约 800 条）。之前只翻 12 页，
        //   而上传合成的完整版往往排在第 12 页之后，导致「找不到」
        libAll = await fetchLibrary(40, (pg, n) => {
          histEl.innerHTML = '<div class="empty">加载中... 已翻 ' + pg +
            ' 页，收集到 ' + n + ' 条</div>';
          const st = $('#libstat');
          if (st) st.textContent = '加载中... 已翻 ' + pg + ' 页，收集到 ' + n + ' 条';
        });
        saveLibCache(libAll);
        renderLib();
        log('作品库: ' + libAll.length + ' 条（上传合成 ' +
            libAll.filter(isUploadedFull).length + ' · AI生成 ' +
            libAll.filter(isGeneratedFull).length + '）');
      } catch (e) {
        histEl.innerHTML = '<div class="empty">加载失败: ' + escapeHtml(e.message) + '</div>';
      } finally {
        libLoading = false;
      }
    }

    // ==================== 作品库缓存 ====================
    /**
     * 把作品列表存到本地，下次打开秒出，不用再翻 40 页。
     * 只有用户主动点「⟳ 刷新」才会重新拉取。
     */
    function saveLibCache(list) {
      try {
        GM_setValue(K_LIB, JSON.stringify({ at: Date.now(), items: list }));
      } catch (e) { /* 存不下就算了 */ }
    }

    function loadLibCache() {
      try {
        const raw = GM_getValue(K_LIB, '');
        if (!raw) return null;
        const d = JSON.parse(raw);
        if (!d || !Array.isArray(d.items) || !d.items.length) return null;
        return d;
      } catch (e) { return null }
    }

    function clearLibCache() {
      try { GM_setValue(K_LIB, ''); } catch (e) {}
    }

    function timeAgo(ts) {
      const s = Math.floor((Date.now() - ts) / 1000);
      if (s < 60) return '刚刚';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
      return Math.floor(s / 86400) + ' 天前';
    }

    // 刷新 = 丢掉缓存重新拉取
    $('#libRefresh').onclick = () => {
      clearLibCache();
      libAll = [];
      loadLibrary();
    };
    $('#libq').addEventListener('input', () => {
      if (libAll.length) renderLib();
    });

    const drop = $('#d'), fileIn = $('#f');

    /** 文件卡：选完文件后替换掉拖拽区，避免"附件式"堆叠 */
    function showFileCard(f, extra) {
      if (!fileCardEl) return;
      const has = !!f;
      fileCardEl.style.display = has ? 'flex' : 'none';
      if (drop) drop.style.display = has ? 'none' : 'block';
      if (!has) return;
      fcNameEl.textContent = f.name;
      fcMetaEl.textContent = extra || ((f.size / 1048576).toFixed(1) + ' MB');
    }

    drop.onclick = () => fileIn.click();
    fileIn.onchange = e => onFile(e.target.files[0]);
    $('#fcAgain').onclick = () => fileIn.click();

    // 拖到面板任何地方都算（文件卡状态下拖拽区是隐藏的）
    ['dragover', 'dragenter'].forEach(ev => panelEl.addEventListener(ev, e => {
      e.preventDefault();
      if (drop) drop.classList.add('on');
    }));
    panelEl.addEventListener('dragleave', e => {
      if (drop && !panelEl.contains(e.relatedTarget)) drop.classList.remove('on');
    });
    panelEl.addEventListener('drop', e => {
      e.preventDefault();
      if (drop) drop.classList.remove('on');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });

    // 恢复进度时，选中的文件要先过校验
    let pendingResume = null;

    function onFile(f) {
      if (!f) return;

      // 若正在恢复进度，先校验是不是同一个文件
      if (pendingResume) {
        const p = pendingResume;
        if (f.name !== p.fileName || f.size !== p.fileSize) {
          log('✗ 文件不匹配，无法恢复');
          log('  需要: ' + p.fileName + ' (' + (p.fileSize / 1048576).toFixed(1) + 'MB)');
          log('  你选了: ' + f.name + ' (' + (f.size / 1048576).toFixed(1) + 'MB)');
          status('文件不匹配', 'err');
          return;
        }
        pendingResume = null;
        restoreProgress(p, f);
        return;
      }

      file = f; audio = null; segs = [];
      window.__PIECES = []; window.__PID = null; window.__EXPORT = null;
      backToMain();
      $('#t').value = f.name.replace(/\.[^.]+$/, '');
      showFileCard(f);
      setGuide(2);
      hint('参数默认就行，直接点 <b>开始上传</b>');
      status('已就绪', 'ok');
      $('#go').style.display = 'block';
      setStep(2);
      paint();
      log('已选择: ' + f.name + ' (' + (f.size / 1048576).toFixed(1) + 'MB)');
      log('参数不用改，直接点上方的「开始上传」');

      // 选完就先把时长/段数算出来（解码很快），省得点了开始才知道会切几段
      prepare().then(() => {
        status('已就绪 · ' + segs.length + ' 段', 'ok');
      }).catch(e => {
        status('解码失败: ' + e.message, 'err');
        log('✗ 解码失败: ' + e.message);
      });
    }

    /**
     * 用存档恢复：恢复已上传的片段，跳过重传
     */
    function restoreProgress(p, f) {
      file = f;
      audio = null;
      backToMain();
      setGuide(2);
      hint('已恢复进度，点 <b>开始上传</b> 继续');
      resumebarEl.classList.remove('on');

      window.__PIECES = (p.pieces || []).slice();
      window.__PID = p.projectId || null;
      window.__EXPORT = p.exportId || null;

      // ★ 按【实际覆盖】判断每段是否完整，而不是只看有没有 clipId：
      //   二分上传可能只补上了半段，那种情况必须重新传。
      const plist = window.__PIECES;
      segs = p.segs.map(s => {
        let cov = 0;
        for (const pc of plist) {
          if (pc.t1 <= s.t0 || pc.t0 >= s.t1) continue;
          cov += Math.min(pc.t1, s.t1) - Math.max(pc.t0, s.t0);
        }
        const full = cov >= (s.t1 - s.t0) - 0.35;
        return {
          idx: s.idx, t0: s.t0, t1: s.t1,
          clipId: s.clipId || null,
          state: full ? 'ok' : (cov > 0.3 ? 'part' : 'new')
        };
      });

      if (p.title) $('#t').value = p.title;
      if (p.pitch) $('#pitch').value = p.pitch;

      drop.innerHTML = '<b>' + f.name + '</b>' + (f.size / 1048576).toFixed(1) +
        ' MB<br><small>点这里换文件</small>';

      const done = segs.filter(s => s.state === 'ok').length;
      const partial = segs.filter(s => s.state === 'part').length;
      status('已恢复 ' + done + '/' + segs.length + ' 段' +
             (partial ? '（' + partial + ' 段只传了一半）' : ''), 'ok');
      $('#go').style.display = 'block';
      $('#go').textContent = '继续上传';
      $('#n1').textContent = done;
      $('#n2').textContent = segs.length - done;
      $('#n3').textContent = segs.length;
      setStep(3);
      paint();

      log('=== 已恢复上次进度 ===');
      log('完整 ' + done + ' / ' + segs.length + ' 段，其余会重新上传');
      if (partial) log('  其中 ' + partial + ' 段只覆盖了一部分，会补齐');
      if (window.__PID) log('Studio 项目: ' + window.__PID.slice(0, 8));
      log('点「继续上传」接着跑');

      if (done === segs.length && window.__EXPORT) {
        log('');
        log('所有片段都已上传，导出也已经提交过');
        log('可以直接点「继续上传」，它会跳过上传直接重做导出');
      }
    }

    // ---- 恢复提示条按钮 ----
    $('#btnResume').onclick = () => {
      const p = loadProgress();
      if (!p) { resumebarEl.classList.remove('on'); return; }
      pendingResume = p;
      log('请重新选择同一个文件：' + p.fileName);
      status('请选择原文件以恢复', 'run');
      $('#f').click();
    };

    $('#btnDropResume').onclick = () => {
      clearProgress();
      resumebarEl.classList.remove('on');
      log('已丢弃上次进度');
    };

    // 启动时检查有没有未完成的存档
    (function checkResume() {
      const p = loadProgress();
      if (!p) return;
      const done = p.segs.filter(s => s.clipId).length;
      if (!done && p.stage === 'upload') { clearProgress(); return; }
      showResumeBar(p);
    })();

    (function restoreCfg() {
      const c = loadCfg();
      // 只恢复不影响成功率的项
      if (c.rt) $('#rt').value = c.rt;
      if (c.rr) $('#rr').value = c.rr;
      if (c.cf !== undefined) $('#cf').value = c.cf;
      // v17：这三项用实测最优值，不读旧配置
      $('#ss').value = 6;      // 6 秒切片最容易提高通过率
      // ★ 移调不能太大：+4 保留 19kHz 带宽，+24 会把 6kHz 以上全砍掉（音质灾难）
      $('#pitch').value = 4;
      // 并发太高容易触发 S3 限流导致请求悬挂，默认 4
      $('#cf').value = 4;
      $('#doExport').checked = true;
      $('#doClean').checked = true;
      if (c.fmt && $('#fmt')) $('#fmt').value = c.fmt;
    })();
    function saveCfgNow() {
      saveCfg({
        ss: $('#ss').value, rt: $('#rt').value, rr: $('#rr').value,
        doExport: $('#doExport').checked,
        doClean: $('#doClean').checked,
        pitch: $('#pitch').value, cf: $('#cf').value,
        fmt: $('#fmt') ? $('#fmt').value : 'mp3'
      });
    }
    ['#ss', '#rt', '#rr', '#doExport', '#doClean', '#pitch', '#cf', '#fmt'].forEach(s => {
      const el = sh.querySelector(s);
      if (el) el.addEventListener('change', saveCfgNow);
    });

    async function prepare() {
      if (!audio) {
        status('解码中...', 'run');
        log('解码音频...');
        audio = await decodeAudio(file);
        log('时长 ' + audio.duration.toFixed(1) + 's, ' + audio.sampleRate + 'Hz, ' +
            audio.numberOfChannels + 'ch');
      }      let want = Math.max(MIN_SEG, parseFloat($('#ss').value) || 20);

      // ★ Suno 要求上传音频 ≥ 6 秒，短了会【在前面补静音】，导致成品错位
      //   移调会让音频变短（÷ 2^(n/12)），所以切片长度必须按倍数放大
      const semisNow = parseFloat($('#pitch').value) || 0;
      const ratio = Math.pow(2, semisNow / 12);
      const needSec = Math.ceil(SUNO_MIN_UPLOAD * ratio) + 1;   // 留 1 秒余量
      if (want < needSec) {
        log('切片从 ' + want + 's 调整为 ' + needSec + 's');
        log('  原因：移调 +' + semisNow + ' 会把音频压缩 ' + ratio.toFixed(2) +
            ' 倍，Suno 要求上传 ≥ ' + SUNO_MIN_UPLOAD + ' 秒，否则会补静音');
        want = needSec;
      }

      const sec = want;
      // ★ 用 floor 而不是 ceil：ceil 会把步长压到 sec 以下
      //   例：30 秒音频、sec=9 → ceil 得 4 段、步长 7.5s，
      //       7.5/1.26=5.95 < 6 秒 → Suno 补静音 → 成品错位
      //   floor 保证每段都 ≥ needSec
      let n = Math.max(1, Math.floor(audio.duration / sec));
      let step = audio.duration / n;

      // 保险：步长经移调后仍不足 6 秒，就再减少段数
      while (n > 1 && step / ratio < SUNO_MIN_UPLOAD) {
        n--;
        step = audio.duration / n;
      }
      if (step / ratio < SUNO_MIN_UPLOAD) {
        log('⚠ 音频太短：整首上传后只有 ' + (step / ratio).toFixed(1) +
            's，Suno 会自动补静音（可能引起轻微错位）');
      }
      if (step > sec * 1.05) {
        log('分段调整为 ' + n + ' 段 × ' + step.toFixed(1) + 's' +
            '（保证每段移调后仍 ≥ ' + SUNO_MIN_UPLOAD + ' 秒）');
      }
      if (!segs.length) {
        for (let i = 0; i < n; i++) {
          segs.push({
            idx: i + 1, t0: i * step,
            t1: Math.min(audio.duration, (i + 1) * step),
            clipId: null, state: 'new'
          });
        }
        log('分段: ' + n + ' 段 × ' + step.toFixed(1) + 's' +
            '（上传后约 ' + (step / ratio).toFixed(1) + 's）');
        showFileCard(file, audio.duration.toFixed(1) + 's · ' + n + ' 段 × ' +
          step.toFixed(1) + 's');
      }
      return n;
    }

    /**
     * 上传一段音频，失败了就【二分】。
     *
     * 策略：
     *   ① 先按设定移调上传整段
     *   ② 失败 → 移调递增再试（每个移调 1 次）
     *   ③ 移调全试过还不行 → 对半切开，左右两半各自递归
     *   ④ 切到不足 MIN_SEG（6 秒）就放弃
     *
     * 返回 [{clipId, t0, t1, semis, depth}]，一次二分可能产生多块。
     */
    async function uploadWithBisect(t0, t1, depth, label, pitchSemis, maxTry) {
      const dur = t1 - t0;
      const MAX_DEPTH = 3;
      const pad = '  '.repeat(depth);

      for (let i = 0; i < maxTry; i++) {
        // 网络异常暂停中 → 等用户换好网络再继续
        if (netPaused) {
          const r = await waitNetResume();
          if (r === 'skip') {
            log(pad + '（网络异常，跳过此段）');
            return [];
          }
        }
        const semis = pitchSemis + i;
        try {
          const base = sliceToWav(audio, t0, t1);
          // ★ 只变速不补时长：音频随移调变短，Studio 用 transposition 拉回来
          const shifted = semis === 0
            ? { blob: base, seconds: dur }
            : await pitchShiftResample(base, semis);
          const name = 'p' + label.replace(/\W/g, '') + '_s' + semis + '.wav';

          const up = await uploadSegment(shifted.blob, name,
            label + (semis ? ' +' + semis : ''), 'wav', 180000,
            (tick) => log(pad + '  ' + tick));

          // ★ 查询 Suno 最终存储的音频时长：
          //   若短于 SUNO_MIN_UPLOAD，Suno 会在开头补静音（实测）
          let storedDur = up.realDur || shifted.seconds;
          try {
            const rr = await gmFetch('GET', API + '/api/clip/' + up.clipId, null, 15000);
            if (rr.status === 200) {
              const cj = JSON.parse(rr.text);
              if (cj.metadata && cj.metadata.duration) storedDur = cj.metadata.duration;
            }
          } catch (e) { /* 拿不到就用上传时长 */ }

          const pad = Math.max(0, storedDur - shifted.seconds);
          if (pad > 0.15) {
            log(pad + '  ⚠ Suno 在开头补了 ' + pad.toFixed(2) + 's 静音（音频太短）');
          }

          log(pad + '✓ ' + up.clipId.slice(0, 8) + '  (' + dur.toFixed(1) + 's' +
              (semis ? ' → 传 ' + shifted.seconds.toFixed(1) + 's, 移调+' + semis : '') + ')');
          // origDur = 原始时长（场景长度）；audioDur = 存储时长；pad = 开头静音
          return [{
            clipId: up.clipId, t0, t1, semis, depth,
            origDur: dur,
            audioDur: storedDur,
            padDur: pad
          }];
        } catch (e) {
          // 版权拒绝和网络/超时都算可重试，换移调再来
          log(pad + '× 移调+' + semis + ': ' + e.message);
          await sleep(600);
        }
      }

      if (depth >= MAX_DEPTH || dur / 2 < MIN_SEG) {
        log(pad + '✗ 放弃（已切 ' + depth + ' 层，' + dur.toFixed(1) + 's）');
        return [];
      }

      const mid = (t0 + t1) / 2;
      log(pad + '⇢ 二分 ' + dur.toFixed(1) + 's → 两段 ' + (dur / 2).toFixed(1) + 's');
      await sleep(500);

      const left = await uploadWithBisect(t0, mid, depth + 1, label + 'a', pitchSemis, 2);
      const right = await uploadWithBisect(mid, t1, depth + 1, label + 'b', pitchSemis, 2);
      return left.concat(right);
    }

    async function run() {
      if (running) return;

      // 没选文件就点开始 → 明确提示，而不是报一堆看不懂的错
      if (!file) {
        status('还没有选择文件', 'err');
        log('');
        log('⚠ 请先把音频文件拖到上面的虚线框（或点它选择文件）');
        log('  选好文件后再点「开始上传」');
        return;
      }

      running = true;
      $('#go').disabled = true;
      setGuide(3);
      hint('正在准备…');
      ballEl.classList.add('run');
      try {
        const title = $('#t').value || 'Suno Upload';
        const maxTry = Math.max(1, parseInt($('#rt').value) || 3);
        const maxRound = Math.max(1, parseInt($('#rr').value) || 3);
        const concurrency = Math.max(1, Math.min(6, parseInt($('#cf').value) || 3));
        const wantExport = $('#doExport').checked;
        const doClean = $('#doClean') ? $('#doClean').checked : true;
        const pitchSemis = parseFloat($('#pitch').value) || 0;

        const total = await prepare();
        log('');
        log('=== 开始 ===');
        log('共 ' + total + ' 段 | 并发 ' + concurrency + ' | 每段试 ' + maxTry + ' 个移调 | 失败自动二分' +
            (pitchSemis ? ' | 移调 +' + pitchSemis + ' 半音起' : '') +
            (wantExport ? ' | 导出' : ''));

        // 移调过大会永久损失高频（Nyquist 截断），提示用户
        if (pitchSemis > 7) {
          const limitK = (24 / Math.pow(2, pitchSemis / 12)).toFixed(1);
          log('⚠ 移调 +' + pitchSemis + ' 偏大：超过 ' + limitK +
              'kHz 的高频会被永久截断，成品会发闷');
          log('  建议改成 +4（保住 19kHz，音质几乎无损）');
        }

        let round = 0;
        // 恢复进度时，已上传的片段从这里接着用；否则是空数组
        const pieces = (window.__PIECES && window.__PIECES.length)
          ? window.__PIECES.slice() : [];
        window.__PIECES = pieces;      // 供进度存档读取

        /**
         * 某一段【已被覆盖】的秒数
         *
         * ★ 不能只看 clipId 有没有值：二分上传时可能只成功了左半段，
         *   clipId 有了但右边那截其实是空的 —— Go West 丢的那一段就是这么来的。
         */
        function segCoverage(s) {
          let cov = 0;
          for (const p of pieces) {
            if (p.t1 <= s.t0 || p.t0 >= s.t1) continue;
            cov += Math.min(p.t1, s.t1) - Math.max(p.t0, s.t0);
          }
          return cov;
        }
        /** 这段是否真的完整了（容差 0.35 秒） */
        function segDone(s) {
          return segCoverage(s) >= (s.t1 - s.t0) - 0.35;
        }
        function incompleteSegs() {
          return segs.filter(s => !segDone(s));
        }

        let doneSegs = segmentsDone();
        function segmentsDone() {
          let n = 0;
          for (const s of segs) if (segDone(s)) n++;
          return n;
        }

        setStep(3);
        saveProgress('upload');
        resetProgressClock();       // 从这一刻开始算「预计剩余」

        while (round < maxRound) {
          const missing = incompleteSegs();
          if (!missing.length) break;
          round++;
          $('#n4').textContent = round;
          log('');
          log('--- 第 ' + round + ' 轮（缺 ' + missing.length + ' 段，并发 ' + concurrency + '）---');

          const queue = missing.slice();
          const nW = Math.min(concurrency, queue.length);
          const workers = [];

          for (let w = 0; w < nW; w++) {
            workers.push((async () => {
              while (queue.length) {
                const s = queue.shift();
                if (!s) break;
                s.state = 'run';
                paint();
                const pending = incompleteSegs().length;
                status('上传 第' + round + '轮 · 剩余 ' + pending, 'run');
                setProgress(doneSegs, total);
                badgeEl.style.display = 'flex';
                badgeEl.textContent = pending;
                log('[' + s.idx + '] ' + s.t0.toFixed(1) + '-' + s.t1.toFixed(1) + 's 开始');

                const lbl = 'part' + ('00' + s.idx).slice(-3);
                let results = [];
                try {
                  results = await uploadWithBisect(
                    s.t0, s.t1, 0, title + ' ' + lbl, pitchSemis, maxTry);
                } catch (e) {
                  log('[' + s.idx + '] 异常: ' + e.message);
                }

                if (results.length) {
                  // 先入列再判断覆盖，避免自己看不到自己
                  const before = segDone(s);
                  pieces.push.apply(pieces, results);
                  results.forEach(p => { if (p.clipId) s.lastClipId = p.clipId });
                  if (!s.clipId && results[0].clipId) s.clipId = results[0].clipId;

                  if (segDone(s)) {
                    s.state = 'ok';
                    log('[' + s.idx + '] ✓ 完成 ' + results.length + ' 块（覆盖完整）');
                    if (!before) doneSegs++;
                  } else {
                    // 只补上了一部分
                    const need = (s.t1 - s.t0) - segCoverage(s);
                    s.state = 'part';
                    log('[' + s.idx + '] ⚠ 只补上 ' + results.length + ' 块，还差 ' +
                        need.toFixed(1) + 's，后续轮次会重试');
                  }
                  saveProgress('upload');       // 每段成功就存档，刷新后可恢复
                } else {
                  s.state = 'bad';
                  log('[' + s.idx + '] ✗ 本轮放弃');
                }
                paint();
                await sleep(300);
              }
            })());
          }
          await Promise.all(workers);
        }

        // ==================== 补漏：确保没有空洞才允许导出 ====================
        let gaps = incompleteSegs();
        if (gaps.length) {
          log('');
          log('=== 补漏：还有 ' + gaps.length + ' 段不完整 ===');
          log('  ' + gaps.map(s => 'part' + ('00' + s.idx).slice(-3)).join(' '));

          // 用更高的移调再硬试两轮（内容检测主要靠频谱，移调越大越容易过）
          // ★ 上限 +7：再高的话 9 秒切片会被压到不足 6 秒，
          //   Suno 就会在前面补静音，反而引入新的错位
          for (let extra = 0; extra < 2 && gaps.length; extra++) {
            const topSemis = Math.min(7, pitchSemis + maxTry + extra * 2);
            log('');
            log('--- 补漏第 ' + (extra + 1) + ' 轮（移调 +' + topSemis + ' 起，' + gaps.length + ' 段）---');
            for (const s of gaps) {
              if (netPaused) {
                const r = await waitNetResume();
                if (r === 'skip') break;
              }
              const lbl = 'part' + ('00' + s.idx).slice(-3);
              log('[' + s.idx + '] 补漏尝试 +' + topSemis);
              let results = [];
              try {
                results = await uploadWithBisect(
                  s.t0, s.t1, 0, title + ' ' + lbl, topSemis, 2);
              } catch (e) { log('[' + s.idx + '] 异常: ' + e.message) }
              if (results.length) {
                pieces.push.apply(pieces, results);
                results.forEach(p => { if (p.clipId) s.lastClipId = p.clipId });
                if (!s.clipId && results[0].clipId) s.clipId = results[0].clipId;
              }
              s.state = segDone(s) ? 'ok' : 'bad';
              if (segDone(s)) { log('[' + s.idx + '] ✓ 补上了'); doneSegs++ }
              paint();
              saveProgress('upload');
              await sleep(400);
            }
            gaps = incompleteSegs();
            if (!gaps.length) break;
          }
        }

        prog(1); setEta('');

        // ★ 硬性拦截：还有缺口就不导出，否则会生成一首缺一段、后面全错位的废歌
        if (gaps.length) {
          const names = gaps.map(s => 'part' + ('00' + s.idx).slice(-3)).join('、');
          log('');
          log('✗✗ 有 ' + gaps.length + ' 段始终没能上传：' + names);
          log('   已停止导出 —— 强行导出会得到一首中间缺一段的歌。');
          log('   建议：');
          log('     1. 点结果页的「只补缺的 ' + gaps.length + ' 段」（或上传页「开始上传」），已成功的段不会重传');
          log('     2. 若某段总是被拒，把「上传移调」调高到 7～10 再试');
          log('     3. 进度已保存，刷新页面也不会丢');
          setGuide(4);
          hint('有 ' + gaps.length + ' 段没传上去，去 <b>结果</b> 页点「只补缺的 ' + gaps.length + ' 段」', true);
          status('有 ' + gaps.length + ' 段缺失，已阻止导出', 'err');
          showResult({
            title, pid: window.__PID || null, clipId: null,
            missing: gaps.length,
            missingNames: gaps.map(s => 'part' + ('00' + s.idx).slice(-3)),
            seconds: segs.length ? segs[segs.length - 1].t1 : 0,
            segCount: total, semis: []
          });
          return;
        }

        if (!pieces.length) { status('全部失败', 'err'); return; }

        pieces.sort((a, b) => a.t0 - b.t0);

        log('');
        log('上传完成: ' + pieces.length + ' 块（原始 ' + total + ' 段，' + round + ' 轮）');
        log('✓ 完整性校验通过：' + total + ' 段全部覆盖');

        setStep(4);
        status('建 Studio 项目...', 'run');
        const pid = await createProject(title);
        window.__PID = pid;
        // 每块按各自移调量反向还原
        const built = buildState(pieces, title);
        await gmFetch('POST', API + '/api/studio/save-project',
          { project_id: pid, state: built.state });
        saveProgress('project');
        const semisSet = Array.from(new Set(pieces.map(p => p.semis)))
          .filter(x => x > 0).sort((a, b) => a - b);
        log('项目已建: ' + pid.slice(0, 8) +
            (semisSet.length ? '（还原 ' + semisSet.join('/') + ' 半音）' : ''));

        let exportId = null;
        let finalId = null;
        if (wantExport) {
          log('');
          log('=== 导出完整作品 ===');
          status('提交导出...', 'run');
          const lastBeats = built.state.tracks[0].clips.slice(-1)[0].endBeats;
          exportId = await renderProject(pid, title, built.state, lastBeats);
          window.__EXPORT = exportId;
          saveProgress('export');
          log('导出 clip: ' + exportId.slice(0, 8));
          status('渲染中...', 'run');
          const done = await waitRendered(exportId, log, 300000);
          log('渲染完成（' + ((done.metadata && done.metadata.duration) || built.totalSeconds).toFixed(1) + 's）');
          finalId = exportId;

          // ★ 清洗：立刻下载重传，避免被后续审查删除
          if (doClean) {
            log('');
            log('=== 清洗（防止被删）===');
            status('清洗中...', 'run');
            try {
              const cleaned = await cleanClip(exportId, title, log);
              finalId = cleaned.clipId;
              log('★ 清洗完成: ' + finalId.slice(0, 8));
              log('  这个 clip 不会被动，可直接 Cover');
            } catch (e) {
              log('✗ 清洗失败: ' + e.message);
              log('  原导出 clip 仍在，尽快使用（约 47 秒窗口）');
            }
          }
        }

        addHist({
          at: Date.now(), title,
          total, ok: pieces.length, dur: built.totalSeconds,
          projectId: pid, songId: finalId || exportId
        });

        // 走到这里说明完整性校验已通过（有缺口会在前面 return）
        setGuide(4);
        hint('成品已就绪，点上方 <b>结果</b> 查看');
        status('完成！成品已就绪', 'ok');
        log('');
        log('=== 全部完成（' + total + ' 段全覆盖，无缺失）===');
        if (finalId) log('作品: https://suno.com/song/' + finalId);

        // 终点就是 Suno 里那首完整作品：把它摆到「结果」页，不再自动下载
        await showResult({
          title,
          pid,
          clipId: finalId || exportId,
          seconds: built.totalSeconds,
          segCount: total,
          semis: semisSet,
          type: finalId && finalId !== exportId ? '清洗后 · edit_crop' : 'rendered_context_window'
        });
        setStep(6);
        clearProgress();     // 完成后清掉存档
      } catch (e) {
        status('失败: ' + e.message, 'err');
        log('错误: ' + e.message);
      } finally {
        running = false;
        ballEl.classList.remove('run');
        badgeEl.style.display = 'none';
        $('#go').disabled = false;
        $('#go').textContent = '再次上传';
      }
    }

    $('#go').onclick = run;

    // 暴露几个内部方法，方便在控制台/CDP 里调试（也方便以后写自动化）
    UI = {
      log, status, host, mount: () => setMin(false),
      switchTab, showResult, resetResultView, farmer, setProgress, resetProgressClock,
      logs: () => lines.join('\n') +
        (ptsLines.length ? '\n\n===== 积分 =====\n' + ptsLines.join('\n') : ''),
      state: () => ({ tab, segs, file: file && file.name, running }),
    };
    try { (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__sunoUI = UI; } catch (e) {}

    // 首次使用引导（只提示一次）
    try {
      if (!GM_getValue('welcome_v22', false)) {
        GM_setValue('welcome_v22', true);
        setTimeout(() => {
          log('欢迎使用 Suno 一键上传器 ' + VERSION);
          log('');
          log('步骤：');
          log('  ① 把音频拖到虚线框');
          log('  ② 参数不用动（默认值已调好）');
          log('  ③ 点「开始上传」');
          log('  ④ 等它自动建工程并导出');
          log('  ⑤ 完成后自动下载');
          log('');
          log('小提示：');
          log('  · 中途刷新页面不会丢进度，会提示「恢复上次进度」');
          log('  · 网络断了会自动暂停，换好网络点「继续」即可');
          log('  · 已上传的片段不会重传');
        }, 600);
      }
    } catch (e) { /* GM 不可用时忽略 */ }

    return UI;
  }

  if (typeof GM_registerMenuCommand === 'function') {
    // 客户版不显示日志，排错时用这个导出来
    GM_registerMenuCommand('复制运行日志（排错用）', () => {
      const text = (UI && UI.logs) ? UI.logs() : '';
      if (!text) return;
      try {
        navigator.clipboard.writeText(text).catch(() => {});
      } catch (e) {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      } catch (e) {}
      if (UI && UI.status) UI.status('运行日志已复制到剪贴板', 'ok');
    });

    GM_registerMenuCommand('显示上传面板', () => {
      if (UI) UI.mount(); else mount();
    });

    // 面板被拖到屏幕外看不见时用这个恢复
    GM_registerMenuCommand('重置面板位置（看不见面板时用）', () => {
      GM_setValue(K_POS, JSON.stringify({ x: 16, y: 16 }));
      GM_setValue(K_MIN, false);
      const h = document.getElementById('__suno_up_host');
      if (h) h.remove();
      UI = null;
      mount();
      if (UI) {
        UI.log('面板位置已重置到左上角');
        UI.log('如果还是看不到，请刷新页面（Ctrl+Shift+R）');
      }
    });
  }

  function boot() {
    if (document.body) mount();
    else setTimeout(boot, 300);
  }
  boot();

})();
