# 快速上手

## 三步用起来

**1. 装用户脚本管理器**

- Chrome / Edge：[Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- Firefox：[Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/)
- 或 [Violentmonkey](https://violentmonkey.github.io/)

**2. 装脚本**

把 `Suno-OneClick-Uploader.user.js` 拖进浏览器窗口 → 点「安装」

或者：Tampermonkey 面板 → 实用工具 → 导入 → 选文件 → 安装

**3. 用**

1. 打开 <https://suno.com> 并登录
2. **刷新页面**，右下角出现紫色圆按钮
3. 点它展开面板
4. 拖音频进去
5. 点「开始上传」
6. 等跑完

---

## 跑完之后

去 <https://suno.com/me> 找标题带 `(Full)` 的那首歌。

**做 Cover**：打开 → 点 `⋯ Remix` → `Cover` → 编辑 → `Create`

---

## 下载库（粘贴链接就能下）

面板底部点 **「📚 下载库 · 粘贴链接直接下载」**：

1. **贴链接** → 回车
   ```
   https://suno.com/song/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
2. 或者点 **「⟳ 刷新」** 加载自己的作品列表，逐条点 **⬇ 下载**

每条右边还有个 **🔗** 按钮，点一下就把那首歌的链接复制走了。

> **格式选 M4A 最快**（约 5 秒）。
> MP3 第一次要下 31MB 编码器，网络不好会慢，脚本会自动降级。

---

## 参数不用改

面板顶部有 **5 步引导**，跟着亮的那一步走就行：

```
① 选文件 → ② 设参数 → ③ 上传 → ④ 导出 → ⑤ 下载
```

默认值已经调好：
- 切片 6 秒（会自动放大以保证上传 ≥6 秒）
- 并发 4
- 移调 +4（音质几乎无损）

**移调不要超过 +8**，否则高频会被砍掉，声音发闷。

---

## 两个贴心功能

**网络断了会自动停** —— 弹出红色提示条，换好网络点「已换网络，继续」，已传的段不会重传。

**刷新页面不丢进度** —— 中途刷新会提示「恢复上次进度」，重新选同一个文件即可接着传。

---

## 出问题看这里

| 现象 | 怎么办 |
|---|---|
| 面板没出现 / 突然看不到 | 面板被拖到屏幕外了 → 点 Tampermonkey 图标 → `重置面板位置` |
| 上传老被拒 | 移调改 +5 或 +6，并发降到 2 |
| 成品有静音/断裂 | 切片改成 12 秒 |
| MP3 下载失败 | 网络访问不了 jsdelivr，会自动存 WAV |
| 卡住不动 | 看有没有红色「网络异常」提示条，换网后点继续 |

> 面板位置会被记住。如果拖到屏幕边缘外面，看起来就像脚本消失了。
> 点 Tampermonkey 图标的 `重置面板位置（看不见面板时用）` 即可恢复。

详细说明见 `README.md`。
