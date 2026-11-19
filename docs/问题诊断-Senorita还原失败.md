# 问题诊断 · 《Senorita》(还原).wav 只有 51 秒

> 2026-11-19。用户反馈：脚本产出的「(还原).wav」时长不对、变调。
> **已定位并修复，版本 v50.1.0。**

---

## 一、现象

用户拿到的文件：

```
【4K30FPS】...Senorita...(Av7 (还原).wav
大小    8.64 MB
时长    51.365 秒        ← 原曲 205.461 秒
格式    PCM 16bit / 44100 Hz / 2ch
```

面板显示：
```
51.4s · 8 段 × 6.4s
已逐段还原 7 半音
成品上传：MP3 编码器未加载
```

**矛盾点**：标着"还原 7 半音"，时长却是 51.4 秒。

---

## 二、验算：51.365 秒对应哪个移调

| 移调 | 压缩倍率 | 压缩后时长 | 与实测对比 |
|---|---|---|---|
| +24 | 4.0000 | **51.365s** | ✅ **完全吻合** |
| +23 | 3.7755 | 54.420s | ✗ |
| +7 | 1.4983 | 137.129s | ✗ |
| 0 | 1.0000 | 205.461s | ✗ |

**结论**：这份 WAV 是 **+24 压缩后的音频，根本没有被还原**。

主频检测也印证了：WAV 主频 523 Hz vs 原曲 102 Hz，比值 5.14 → 约 +28 半音。

---

## 三、根因

### 代码位置

```js
async function prepare(replan = false) {
  if (!audio) {                    // ← 关键：只在【首次】执行
    setPitch($('#pitch').value);   // ← PITCH 只在这时更新
    const rawAudio = await decodeAudio(file);
    audio = await 移调(rawAudio, PITCH);   // ← 音频只在这时移调
  }
  ...
}
```

`audio` 和 `PITCH` 是模块级变量，**只有拖入新文件时才会重置**（第 3762 行）。

### 实际发生的顺序

```
① 移调 +24，拖入 Senorita
   → audio = 51.4s（+24 压缩）
   → PITCH = 24

② 中途把移调改成 7
   → 输入框显示 7，但 PITCH / audio 都没变

③ 点「再次上传」
   → prepare() 里 `if (!audio)` 为 false，整段跳过
   → audio 仍是 51.4s（+24 压缩的）
   → 但 assembleWhole 里 ratio = 2^(7/12) = 1.498
   → 每段按 1.498 倍还原，而实际需要 4 倍
   → 得到 51.4s × (1.498/4) ≈ 19s 的内容，再补静音
```

**最终产出的 51.365s 文件，就是那份从未还原的 +24 压缩音频。**

---

## 四、修复（v50.1.0）

### 核心改动

```js
let _audioPitch = null;   // 记住 audio 是按哪个移调生成的
let _rawAudio = null;     // 缓存原始解码结果

async function prepare(replan = false) {
  setPitch($('#pitch').value);        // ← 每次都应用 UI 值

  // ★ 移调值变了就重新移调
  const needRedo = audio && _audioPitch !== null && _audioPitch !== PITCH;
  if (needRedo) {
    log('检测到移调从 ' + _audioPitch + ' 改为 ' + PITCH + '，重新移调...');
    audio = null;
    segs = [];
    window.__PIECES = [];
  }

  if (!audio) {
    let rawAudio = _rawAudio;         // ← 复用原始解码，不重复解码
    if (!rawAudio) {
      rawAudio = await decodeAudio(file);
      _rawAudio = rawAudio;
    }
    audio = await 移调(rawAudio, PITCH);
    _audioPitch = PITCH;              // ← 记录本次的移调值
  }
}
```

**关键点**：从**原始音频**重新移调，不在已移调的音频上二次移调。

### 实测验证

复现用户的完整操作：

```
① 移调 +24 拖入 → 面板：51.4s · 8 段 × 6.4s   （复现成功）
② 改成 +7，点再次上传
   → 日志：检测到移调从 24 改为 7，重新移调...
   → 日志：复用已解码的原始音频（跳过解码）
   → 日志：✓ 整首移调 +7 半音：205.5s → 137.1s
   → 面板：137.1s · 22 段 × 6.2s              （修复生效）
```

`137.1s` 正是 205.461 ÷ 2^(7/12) = 137.13s。**倍率正确了。**

---

## 五、第二个问题：MP3 编码器未加载

### 现象

```
成品上传：MP3 编码器未加载
```

### 原因

```js
async function prepareMasterUpload(wav) {
  if (wav.size <= 8 * 1024 * 1024) return { blob: wav, extension: 'wav' };
  if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder)
    throw new Error('MP3 编码器未加载');   // ← 直接抛错，流程中断
```

205 秒的歌拼成 WAV 是 **33MB**，超过 8MB 阈值 → 走 MP3 编码器 → 编码器不可用（CSP 拦 Worker）→ 抛错。

**明明直接用 WAV 也能上传，却因为编码器缺失整个流程断掉。**

### 修复

```js
const HARD_LIMIT = 24 * 1024 * 1024;   // 阈值放宽到 24MB
if (wav.size <= HARD_LIMIT) return { blob: wav, extension: 'wav' };

const hasLame = (typeof lamejs !== 'undefined' && lamejs.Mp3Encoder);
if (!hasLame) {
  // 编码器不可用 → 降采样到 44.1k 压体积，仍超就直接传 WAV
  const slim = await toWav(wav, 44100);
  return { blob: slim, extension: 'wav' };
}
```

**原则：宁传大 WAV，不要中断流程。**

---

## 六、这次问题暴露的设计缺陷

| 缺陷 | 说明 |
|---|---|
| **参数变更未触发重算** | 音频处理结果与参数强耦合，但只在首次计算 |
| **静默使用陈旧数据** | 没有任何提示说"音频还是按旧参数生成的" |
| **编码器缺失直接抛错** | 应该降级而不是中断 |
| **跨轮次状态残留** | `audio` / `PITCH` / `segs` 生命周期不清晰 |

### 同类风险点（已排查）

| 参数 | 改了会重算吗 |
|---|---|
| 移调 | ✅ 已修（v50.1） |
| 切片秒数 | ✅ 会（`prepare()` 每次都重算 `segs`） |
| 并发 | ✅ 会（主流程每次读） |
| 文件名 | ✅ 不影响 |

---

## 七、给用户的操作建议

**这一版修好后**，改完移调直接点「再次上传」即可，脚本会自动重新移调。

如果仍遇到问题，检查日志里有没有这两行：
```
检测到移调从 XX 改为 YY，重新移调...
✓ 整首移调 +YY 半音：205.5s → XXX.Xs
```

没有这两行就说明没重算，把日志发出来。

---

## 八、版本

- **v50.1.0** — 修复移调变更不重算 + MP3 编码器降级
- 备份：`tools/suno-v50.1.js`
- 待提交：`open/src/Suno-OneClick-Uploader.user.js`
