# Suno 一键上传器 · 技术档案

> 这份文档记录所有逆向得到的接口细节和踩过的坑。
> 换电脑继续开发时，**先读这份**，能省掉大量重复试错。

最后更新：2026-10-28 · 对应脚本 v27

---

## 一、Suno 前端架构

| 项 | 值 |
|---|---|
| 站点 | `https://suno.com`（Next.js SPA） |
| API 域名 | `https://studio-api-prod.suno.com` |
| 媒体 CDN | `d2lwuy8qc234o3.cloudfront.net` |
| S3 上传 | `suno-uploads.s3.amazonaws.com` |

### 认证（三个头都要）

```
authorization: Bearer <__session cookie 里的 JWT>
browser-token: {"token": "<base64(JSON.stringify({timestamp: Date.now()}))>"}
device-id:     <从 localStorage 或 cookie 取>
```

`__session` 是 HttpOnly=false 的 cookie，前端能读。
`browser-token` 是防机器人用的，格式固定，不需要签名。

---

## 二、上传流水线（6 步，顺序不能乱）

```
① POST /api/uploads/audio/
   body: {extension:"wav", is_stem_mix:false, upload_type:"file_upload"}
   → {id, url, fields}
   ★ body 必须是【扁平】的，套一层 spec 会 422

② POST {url}   ← S3，FormData
   先 append fields 里的所有键值，最后 append('file', blob, filename)
   ★ filename 必须和 fields.key 的最后一段一致

③ POST /api/uploads/audio/{id}/upload-finish/
   body: {upload_type:"file_upload", upload_filename:"xxx.wav"}

④ 轮询 GET /api/uploads/audio/{id}/
   status: pending → processing → complete | error
   ★ error 时 error_type 就是拒绝原因

⑤ POST /api/uploads/audio/{id}/initialize-clip/
   body: {}  → {clip_id}

⑥ POST /api/gen/{clip_id}/set_metadata/
   body: {title, is_audio_upload_tos_accepted:true,
          skip_notification:true, show_success_notification:false}
```

### 拒绝原因（error_type）

| 值 | 含义 |
|---|---|
| `upload_failure_match_acrcloud` | 内容识别服务命中 |
| `upload_failure_match_audible_magic` | 内容识别服务命中 |
| `upload_failure_lyrics_copyright` | 歌词版权 |
| `upload_failure_fetch_audio` | 拉不到音频（S3 问题） |

**对策**：换移调重试。移调改变频谱，特征匹配率大幅下降。

---

## 三、关键参数与公式

| 常量 | 值 | 说明 |
|---|---|---|
| `BPS` | **1.95** | Studio 的 beats per second，写死 |
| `SUNO_MIN_UPLOAD` | **6 秒** | Suno 最短上传时长 |
| `MIN_SEG` | 6 秒 | 二分上传的下限（再小就没意义） |

### 6 秒限制的真相

**上传时长 < 6 秒时，Suno 会在【开头】补静音**，不是结尾。

实测：上传 4.762 秒 → 存储 6.6 秒，前 1.75 秒是静音。

所以切片长度必须满足：

```
切片秒数 ÷ 2^(移调/12) ≥ 6
即：切片秒数 ≥ 6 × 2^(移调/12) + 1（留余量）
```

+4 移调 → 至少 9 秒切片（9/1.26 = 7.14 秒上传）。

### transposition 是变速，不是移调

`clip.transposition = -N` 的实际行为是 **playbackRate = 2^(-N/12)**：

- 音高变
- **时长也变**（duration ÷ 2^(-N/12)）

所以场景长度公式：

```
sceneSec = audioSec × 2^(|transposition|/12)
```

实测对照：

| 项目 | audio | transposition | scene |
|---|---|---|---|
| 珠玉 | 6 s | -24 | 24 s |
| 李白 | 6 s | -2 | 6.73 s |

### 移调与音质（Nyquist 截断）

移调会让采样率等比变化，超过 Nyquist 上限的频率永久丢失：

| 移调 | 保留最高频 | 效果 |
|---|---|---|
| +4 | 19 kHz | 几乎无损 ✅ 默认 |
| +7 | 16 kHz | 勉强 |
| +8 | 15 kHz | 开始发闷 |
| +12 | 12 kHz | 明显发闷 |
| +24 | 6 kHz | 高频全没 |

**默认 +4，补漏时最多 +7**（再高 9 秒切片会不足 6 秒，又会补静音）。

---

## 四、Studio 工程与导出

### warp 是两级结构（必须两个都设）

```js
clip.warp = {
  awaitingAnalysis: false,
  markersHash: 'warp_<base64("pad:0,D:endBeats")>',
  enabled: true                    // ★ false 或缺失 → Studio 不拉伸 → 静音
}

state.markersRegistry[hash] = {
  "0": 0,                          // 源 0 秒 → beat 0
  "<D>": <endBeats>                // 源 D 秒 → 结束 beat
}
```

**只设 markersHash 不设 registry，warp 会失效**（Studio 查不到映射）。

实测真实数据：

```json
"markersRegistry": {
  "warp_MDowLDMuOTg4Mzk1ODMzMzMz": {"0": 0, "3.988": 31.109},
  "warp_MDowLDY6NDYuOA":           {"0": 0, "6": 46.8}
}
```

### 两种导出模式（区别很大）

Suno 前端源码里的分支：

```js
...(clipType === StudioExport
  ? { studio_project_id: ..., export_mode: ... }
  : { from_studio_project_id: ..., export_mode: RenderedContextWindow })
```

| | 上传合成 ✅ | 旧模式 |
|---|---|---|
| 参数 | `from_studio_project_id` | `studio_project_id` |
| export_mode | `rendered_context_window` | `studio_export` |
| 产物 type | `rendered_context_window` | `studio_export` |
| is_download_unlocked | false | true |

**只有 `rendered_context_window` 在 Suno 里表现正常、可 Cover。**

完整请求体：

```js
POST /api/studio/render-state
{
  title, lyrics: '', tags: '', negative_tags: '',
  style_summary: '', caption: '',
  state,                     // 完整 Studio state
  start_beats: 0,
  end_beats: <总beats>,
  project_id: <projectId>,
  from_studio_project_id: <projectId>,
  export_mode: 'rendered_context_window',
  web_client_pathname: '/studio'
}
```

> `export_mode` 曾被怀疑是关键，实测 8 种取值都返回同一个 id —— 说明
> 服务端按 (project_id, state, beats) 去重，**真正的区分器是 from_studio_project_id**。

### clip type 分类

| type | 含义 |
|---|---|
| `upload` | 上传的原始切片 |
| `upsample` | 升采样过的切片 |
| `gen` | AI 生成的歌（含 Cover 出来的） |
| `rendered_context_window` | **上传合成的完整版** ✅ |
| `studio_export` | 旧模式导出 |
| `edit_crop` | 清洗后的派生 clip |

判断"上传合成"：`type ∈ {rendered_context_window, studio_export, edit_crop}`
判断"AI 生成"：`type === 'gen'`

`gen` 里标题带 `(Full)` 的，多为从上传歌做 Cover 出来的：
`metadata.task === 'cover'`、`metadata.cover_clip_id`、`metadata.is_remix === true`

---

## 五、下载与解密

### 完整流程

```
① POST /api/mango/rights
   body: {content_params: {content_id: clipId, content_type: 'clip'}}
   ★★ 绝对不要带 Authorization 头，否则拿不到 glt
   → {glt, key, iv}

② seed = SHA-256(glt)
   AES-GCM 解包 key / iv：
     iv = wrapped[0:12]
     additionalData = clipId（UTF-8）
     data = wrapped[12:]

③ GET /api/clip/{id} → media_urls[0].url

④ GM_xmlhttpRequest 拉加密数据（arraybuffer）

⑤ AES-CTR 解密：
     counter = iv 按大端转成 BigInt
     length = 128
   → 明文 M4A（Opus 48kHz 立体声）
```

前面 4 字节是 `ftyp`，可以用来校验解密是否正确。

### 格式转换

| 格式 | 实现 | 依赖 |
|---|---|---|
| M4A | 直接保存解密结果 | 无 ✅ 秒出 |
| WAV | decodeAudioData → 手写 WAV 头 | 无（约 10 秒） |
| MP3 | ffmpeg.wasm | CDN 31MB，**常被 CSP 拦** |

**M4A 就是 AAC 源，音质和 MP3 完全一样**。默认用它。

---

## 六、作品库接口

```
GET /api/feed/v2?page=N
→ {clips: [...20 条...], num_total_results, current_page, has_more}
```

### 三个必须知道的坑

1. **`has_more` 永远是 true**，别拿它当终止条件
2. **上传合成的完整版排在第 12 页之后**（实测：第 12、15、20 页才有）
   → 必须翻到 **40 页（约 800 条）**
3. 翻页偶尔重复 → **必须按 clip id 去重**

### 性能

串行 40 页 ≈ 120 秒，太慢。
**每批并行 5 页** → 约 48 秒。
结果缓存到 `GM_setValue('suno_up:lib')`，下次打开 2 秒即出。

---

## 七、踩过的坑（按严重程度）

### 🔴 致命

| 坑 | 症状 | 解法 |
|---|---|---|
| 外层超时 < 内层轮询 | 上传永远「超时 75s」 | 外层 180s，内层最多 100s |
| 二分只补半段算成功 | 成品中间少一段，后面全错位 | 按**实际覆盖秒数**判定 |
| 缺段仍导出 | 得到一首缺段的废歌 | 缺口 >0 就 **阻止导出** |
| 时间线首尾紧排 | 缺一段后面全前移 | 按 `t0 * BPS` **绝对定位** |
| 分段用 ceil | 步长被压小 → 补静音 | 用 **floor** + 二次校验 |

### 🟡 影响体验

| 坑 | 症状 | 解法 |
|---|---|---|
| `fetch` 在隐藏标签页不 resolve | 请求永远挂着 | 用 `GM_xmlhttpRequest` |
| Tampermonkey 沙箱看不到页面全局 | `FFmpegWASM is undefined` | 用 `unsafeWindow` |
| 页面 CSP 拦 jsdelivr | MP3 编码器加载失败 | GM_xhr + 多 CDN 源 + 超时 |
| flex 子项默认可收缩 | 区块被压成 2px 看不见 | `flex: 0 0 auto` |
| 面板位置被记住 | 换窄窗口后跑到屏幕外 | 加载时 + resize 时夹回视口 |
| CDP 代理硬编码 30s | 长 eval 返回 None | 拆成多段短请求 |

### 🟢 细节

- `warp.enabled: false` 或缺 `markersHash` → Studio 不拉伸 → 静音
- 只设 markersHash 不设 markersRegistry → warp 失效
- `is_download_unlocked: false` **不阻止**下载，可以忽略
- PowerShell `Set-Content -Encoding utf8` 会把中文读成 GBK 写坏 → **编辑含中文的文件必须用 write/edit 工具或 Python `io.open(encoding='utf-8')`**
- `-replace` 里带转义引号在 `pwsh -c "python -c \"...\""` 里会被吃掉 → 写成临时 .py 文件

---

## 八、Studio state 骨架

```js
{
  timing: {type:'manual', bps:1.95, lockBPS:true, firstBeatSeconds:0, bpsAutomation:[]},
  markersRegistry: {},              // warp 注册表
  recording: {countInBars:0, preRollBars:0},
  contextualWindowConfig: {focusedPanel:'generate'},
  sections: {},
  tracks: [{
    color:'#208BFF', takeLanes:[], faderAutomation:{},
    clips: [{
      color:'#FF6A00', fadeInCurve:1,
      startBeats: t0 * 1.95,        // ★ 绝对定位
      endBeats: startBeats + durBeats,
      mute:false, type:'audio', fadeInBeats:0,
      transposition: -semis,        // ★ 负号
      formantCorrection:0, streaming:false,
      amplitude:1, fadeOutBeats:0, fadeOutCurve:1,
      loop:{endBeats:durBeats, enabled:false, startBeats:0},
      name, clipId, readStartBeats:0, id: uuid(),
      asset:{type:'clip', id:clipId}, reversed:false,
      warp:{awaitingAnalysis:false, markersHash:hash, enabled:true}
    }],
    solo:false, mute:false,
    instrument:{type:'song'}, type:'audio', eq:{},
    clipCreationIntents:[], amplitude:1, takeLanesExpanded:false, balance:0,
    signalChain:[], name:'Main', id:trackId, routingMode:'linear',
    arm:false, height:96
  }],
  layout:{midiAutomationLaneHeight:24, arrangementEditorHeight:280,
          midiAutomationLaneId:{category:'noteProperty', property:'velocity'}},
  routing:{}, amplitude:1, songFadeOutBeats:0,
  selection:{contextAfterBeats:32, focusBeats:totalBeats, noteIds:[],
             contextBeforeBeats:32, automationPointIndices:[], trackIds:[trackId],
             focusedArea:'timeline', warpMarkerSeconds:{},
             focusedTrackId:trackId, anchorBeats:0},
  loop:{endBeats:totalBeats, enabled:false, startBeats:0},
  masterRoutingMode:'stereo', metronome:{enabled:false, volume:0.5},
  editorPointerModes:{}, timeSignatureChanges:[], midiCcMappings:[],
  songFadeInBeats:0, masterSignalChain:[], lyricsCorrectionsByClipId:{}
}
```

---

## 九、上传/清洗后的产物生命周期

```
切片(upload) ──Studio合并──> rendered_context_window
                                    │
                                    ├─ 可直接 Cover
                                    │
                                    └─「清洗」：下载 → 重新上传 → 新 clip
                                         （type=upload，躲过二次审查）
```

清洗是为了防止导出后的 clip 被 Suno 后续审查删掉。
实测：`rendered_context_window` 和 `edit_crop` 都能存活，`studio_export` 容易被删。

---

## 十、参考数据（这台机器上的实测 ID）

| 项目 | ID |
|---|---|
| 珠玉（旧，15 clips） | `<id>` |
| 珠玉·Studio合并（sunouploader） | `<id>` |
| 李白·Studio合并 | `<id>` |
| 快乐老家 | `<id>` |
| 珠玉原始合并 | `<id>` |
| 珠玉清洗后 | `<id>` |
| Go West 导出（缺 part022） | `<id>` |

> 这些 ID 绑在 `<账号>` 账号上，换账号后无效。

---

## 十一、听歌赚积分（listen-and-rank）

> 2026-11 实测（Edg 156 / TM 5.5.1 / 账号 <账号>）。对应脚本 v28 的 ⚡ 面板。

### 页面结构

| 元素 | 选择器 / 文本 |
|---|---|
| 页面 | `https://suno.com/listen-and-rank` |
| 入口按钮 | hero 上的按钮，文案会变：`Earn credits` → 做完一组后变成 `Next tasks` |
| 资料向导 | `[role=dialog]` 里含 `Set up your profile`，5 步 |
| 评分弹窗 | `[role=dialog]` 里含 `Which version sounds better?` |
| 每段一行 | `div[class*="cursor-pointer"][class*="flex-col"]`，文本以 `Clip A` / `Clip B` 开头 |
| 播放按钮 | 行内 `button[aria-label="Play"|"Pause"]`（★ 这个 label 会滞后甚至反着，别信它） |
| 打分选项 | `div[class*="min-w-6"]`，文本 `A` / `B` / `Neither`；选中后 class 里出现 `bg-accent` |
| 提交 | `button` 文本以 `Submit` 开头 |

### 资料向导 5 步（一次性的）

| 步 | 字段名 | 类型 |
|---|---|---|
| 1 | `creator_type` | 单选 5 项 |
| 2 | `musical_background` | 单选 4 项 |
| 3 | genres | 多选 23 项 |
| 4 | languages | 多选 15 项 |
| 5 | `listening_setup` | 单选 5 项 |

之后 `Finish` → `You're all set` → `Start Earning Credits`。

### 🔴 四个致命坑（都是实测踩出来的）

1. **每点一次播放，这一段的听歌计数就从 5 重新开始**
   → 每秒点一次「确保在播放」= 永远听不完，Submit 永远 disabled。
   正确做法：**每段每题只点一次，然后等 5 秒以上再判断**（脚本里用 `lastClick[]` + 9 秒冷却）。
2. **Submit 需要两个条件同时成立**：① 选了 A/B/Neither ② 两段都听满 5 秒。
   先听再选、或先选再听都行，但**只做一件永远解不开**（一开始就是死在这里，日志表现为「连续 90 秒无法提交」）。
3. **入口按钮会变**：第一组是 `Earn credits`，做完后 hero 变成 `Next tasks`。
   只认 `Earn credits` 就会在第二组停住。另外侧边栏也有个 `<a>Earn Credits</a>`，点了整页跳转，必须用 `closest('nav,aside,header')` 排除。
4. **每日池子有限**：实测约 10 题（5 分/题），跑完页面出现 `Resets in 23h 27m`，
   入口按钮直接消失。别把它当成「选择器失效」。

### 🔴 后来又踩的两个（v28 二次修正）

5. **入口按钮在 `<header>` 里**：最初按 `closest('nav,aside,header')` 排除侧边栏，
   结果把真正的 hero CTA 也排掉了 → 一题都开不了。
   正确做法：只排除 `nav,aside`；侧边栏那个同名入口是 `<a>`，只查 `button` 就不会误点。
6. **`Resets in 23h 1m` 是排行榜倒计时，不是任务配额**：
   页面上永远有这行字。把它当「配额用完」会让脚本一启动就自停。
   正确做法：**先找入口按钮**，找不到再谈配额；并且要结合 `N tasks available` 判断。

### 🟡 两个体验坑

- **后台标签不计时**：标签切走以后计时器被节流，听歌秒数不涨。脚本检测 `document.hidden` 并暂停，提示切回前台。
- **静音不影响计数**：`media.muted = true` 照样算听完（可以全程不出声刷）。

### 结算与速率

```
积分显示：  "105 credits +45 pending"
            → 已结算 105 分，待结算 45 分（9 题 × 5）
速率：      一轮 ≈ 13 秒（选答案 1s + 听两段各 ~6s + 提交 1s）
每日：      ~10 题 ≈ 50 积分，次日 UTC 0 点前后重置（页面倒计时）
```

### 自检片段

```js
var h=document.getElementById('__suno_up_host');
h.shadowRoot.querySelector('.ver').textContent          // v28
h.shadowRoot.getElementById('ptsState').textContent     // 当前状态
h.shadowRoot.getElementById('ptsLog').textContent       // 运行日志
```
---

## 十二、v29 界面重构与代码结构

### 面板结构

```
host(#__suno_up_host, Shadow DOM)
└ .panel
   ├ .bar      品牌 / 版本 / 状态圆点 / 最小化（同时是拖拽柄）
   ├ .tabs     4 个标签：main=上传 · res=结果 · hist=作品库 · pts=积分
   ├ #bodyMain 拖拽区 → 文件卡 → 参数 → 开关 → 主按钮 → 进度 → 状态 → 统计 → 折叠日志
   ├ #bodyRes  空状态 / 结果卡片（封面 + 标题 + 徽章 + 主按钮）
   ├ #bodyHist 链接下载 + 搜索 + 筛选 + 列表
   └ #bodyPts  轮数 + 开始 + 状态 + 日志
```

### 设计约定

| 项 | 做法 |
|---|---|
| 主题 | CSS 变量 + `prefers-color-scheme: dark` 自动适配 |
| 主色 | `--accent` #7c3aed → `--accent2` #a855f7 渐变（按钮/进度/选中态统一） |
| 状态同步 | `status(msg, kind)` 同时改状态条和顶栏圆点；`err` 会自动展开日志 |
| 日志 | 默认折叠，summary 右侧显示行数；只有展开时才自动滚到底 |
| 结果 | `showResult({title, clipId, pid, seconds, segCount, semis, missing, type})` 统一入口，跑完自动切到「结果」页 |

### 流程变化：终点不再是"下载"

```
旧：上传 → 合并 → 导出 → 下载到本地
新：上传 → 合并 → 导出 → 结果页展示成品（下载降级为可选）
```

`#doDownload` 开关已移除；`wantDownload` 相关分支全删。
「结果」页给的是：封面（`/api/clip/{id}` 的 `image_large_url`）+ 标题 + 时长/段数/type +
「在 Suno 打开」+「复制 ID」+「在 Studio 打开项目」+「下载到本地（可选）」。

### 代码整理

- `fetchClipAudio(clipId, log, opts)`：把 `downloadClip` 和 `cleanClip` 里重复的
  「授权 → 解包 key/iv → 取 media_url → 拉密文 → AES-CTR 解密 → 校验 ftyp」合并成一份，
  两边只是超时不同（下载 180s / 清洗 90s）。
- 选文件即调用 `prepare()` 解码，文件卡立刻显示「时长 · 段数」，不用等点开始。
- 拖拽监听从只有虚线框扩展到整个面板（文件卡状态下框是隐藏的）。
- `UI` 对象暴露调试入口：`log / status / mount / switchTab / showResult / resetResultView / farmer / state()`，
  TM 里再挂到 `unsafeWindow.__sunoUI`，控制台可直接调用。
### v29.1 增补：进度估算与缺段重试

**预计剩余时间**

```js
// 每完成一段调一次；per = 已用时间 ÷ 已完成段数
function setProgress(done, total) {
  prog(total ? done / total : 0);
  const per = (Date.now() - upStartAt) / done;
  setEta('· 剩余约 ' + fmtLeft(per * (total - done)));
}
```

- 时钟在 `setStep(3)` 时用 `resetProgressClock()` 归零，避免把「解码 / 建项目」的时间也算进上传速率。
- 段耗时差异不大（同一首歌、同一移调），线性外推误差在 ±10 秒内。
- `done >= total` 或 `done = 0` 时不显示，避免出现「剩余 0 秒」这种无意义提示。

**缺段一键补**

- `showResult({missing, missingNames})` 会把结果页的主按钮从「在 Suno 打开」换成「只补缺的 N 段」，
  并把 `part007、part012` 这样的清单标红列出来。
- 点击后：`switchTab('main')` → `run()`。`run()` 内部的 `incompleteSegs()` 只会取未完成的段，天生就是"只补缺段"。
- **原文件不在时**（刷新过页面）不要假装能跑：直接提示把同一个文件拖回来，
  因为切片要重新从原始音频里取（进度存档里没有音频本体）。
- 缺段分支不能引用 `built`（它在 `createProject` 之后才生成），时长要用 `segs[last].t1`。
### v30 增补：客户版（引导 + 去日志）

**4 步引导**

```
[1 选文件] [2 参数] [3 上传] [4 成品]     ← .guide
把音频拖进来，或点下面的框选择文件         ← .hintline
```

- `setGuide(n)`：n 之前的所有步骤自动加 `.done`（✓），当前步加 `.on`。
- `hint(text, warn)`：一句话告诉用户"现在该干嘛"，`warn` 用于缺段这类需要用户处理的红色提示。
- 状态由流程驱动：选完文件 → 2；点开始 → 3；`setProgress()` 里同时更新「正在上传 12/30 段 · 剩余约 3 分」；
  完成 → 4；缺段 → 4 + 红色提示。

**日志对客户不可见**

| 之前 | 现在 |
|---|---|
| 页面底部折叠面板，用户能展开看 | 完全移除 DOM |
| 「复制 / 清空」按钮 | 移除 |
| 出错自动展开日志 | 改为：状态条 + 引导行红色提示 |

日志仍然写进内存（`lines[]`，最多 1200 行），并通过：
- `UI.logs()` 暴露给调试；
- Tampermonkey 菜单 **「复制运行日志（排错用）」** 一键进剪贴板。

这样客户看不到噪音，出问题时又能拿到完整现场——比"干脆不记录"好得多。

**作品库分组卡片**

v29 重写 CSS 时漏了 `.grp / .ghead / .gtitle / .gcount / .gitem / .gmeta / .dl / .cp / .gkind` 这一组，
导致分组视图变成"标题 + 1 个版本 + 按钮"的竖排裸文本。v30 补齐：
单行省略号标题、右侧「N 个版本」胶囊、展开箭头、条目内「时长·模型 / 日期」+ 下载/复制按钮。