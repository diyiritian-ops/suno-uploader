# 参与贡献

感谢你愿意帮忙。这个项目是**单文件用户脚本**，没有构建步骤，改动门槛很低。

## 本地跑起来

1. 浏览器装 Tampermonkey
2. Tampermonkey → 实用工具 → 导入 → 选 `src/Suno-OneClick-Uploader.user.js`
3. 打开 <https://suno.com> 登录并刷新，右下角出现小球即成功
4. 改代码后：重新导入一次，刷新页面

想自动化一点，可以用仓库自带的两个工具：

```bash
# 本地 CDP 代理：给脚本调试 / 截图 / 注入用
node tools/cdp-proxy.mjs --port 3456 --cdp-port 9222

# 静态服务：让 Tampermonkey 从 URL 安装，省得每次拖文件
node tools/serve.mjs ./dist 3457
```

## 提交前

- `node --check src/Suno-OneClick-Uploader.user.js` 必须通过
- `@version` 和代码里的 `const VERSION` 保持一致
- 改 UI 的话，附一张改动前后的截图
- 不要提交本机路径、账号名、真实项目 ID（CI 不查这些，靠自觉）

## 代码约定

| 约定 | 说明 |
|---|---|
| 单文件 | 所有逻辑在 `Suno-OneClick-Uploader.user.js` 里，不引入构建步骤 |
| 依赖 | 只用浏览器原生 API + Tampermonkey 的 `GM_*`，不加 npm 包 |
| 文案 | 面向普通用户，中文；代码注释可以用技术术语 |
| 错误处理 | 用户能看懂的写进状态条，技术细节写进内存日志（`log()`） |
| 选择器 | 平台 DOM 会变，所有选择器集中写、带 `★` 注释说明为什么这么取 |

## 提交 PR

1. fork → 建分支（`feat/xxx` / `fix/xxx`）
2. 一个 PR 只做一件事
3. 描述里写清楚：改了什么、怎么验证的、有没有副作用

## 报告问题

用 Issue 模板，附上：

- 浏览器 + 版本（`edge://version`）
- 脚本版本（面板标题上的 `vXX`）
- Tampermonkey 菜单「复制运行日志（排错用）」粘出来的日志
- 出错时面板状态条上的原文
