#!/usr/bin/env node
/**
 * 仓库自检：不依赖网络、不依赖 CI，本地一条命令跑完
 *
 *   node tools/check.mjs
 *
 * 检查项（任何一项失败都以退出码 1 结束）：
 *   1. 语法        src/Suno-OneClick-Uploader.user.js 与 tools/*.mjs 的 node --check
 *   2. 版本一致    // @version 的主版本号 == 代码里的 const VERSION
 *   3. 残留        本机路径 / 真实账号名 / 目标仓库地址以外的账号出现
 *   4. 占位符      %%INSTALL%% / %%BADGES%% / %%REPO%% 没替换干净
 *   5. 链接        README 里引用的相对路径文件是否真的存在
 *
 * 设计上和 .github/workflows/check.yml 做同一件事，区别是这个需要 Node，
 * 但不需要 GitHub 权限、断网也能跑。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'Suno-OneClick-Uploader.user.js');

let failed = 0;
const ok = (msg) => console.log('  \u2713 ' + msg);
const bad = (msg) => { failed++; console.log('  \u2717 ' + msg); };

// ── 1. 语法 ────────────────────────────────────────────────
console.log('\n[1] 语法');
const targets = [SRC];
const toolsDir = path.join(ROOT, 'tools');
if (fs.existsSync(toolsDir)) {
  for (const f of fs.readdirSync(toolsDir)) {
    if (f.endsWith('.mjs')) targets.push(path.join(toolsDir, f));
  }
}
for (const f of targets) {
  const rel = path.relative(ROOT, f);
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status === 0) ok(rel);
  else bad(rel + ' → ' + (r.stderr || '').trim().split('\n')[0]);
}

const src = fs.readFileSync(SRC, 'utf8');

// ── 2. 版本号一致性 ────────────────────────────────────────
console.log('\n[2] 版本号');
const metaVer = (src.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '';
const codeVer = (src.match(/const VERSION = '([^']+)'/) || [])[1] || '';
const metaMajor = metaVer.split('.')[0];
const codeMajor = codeVer.replace(/^v/, '');
if (!metaVer || !codeVer) bad('没读到版本号（@version=' + JSON.stringify(metaVer) + ' code=' + JSON.stringify(codeVer) + '）');
else if (metaMajor !== codeMajor) bad('@version=' + metaVer + ' 与 const VERSION=' + codeVer + ' 主版本不一致，改版本时两处都要动');
else ok('@version=' + metaVer + '  const VERSION=' + codeVer);

// ── 3. 残留扫描 ────────────────────────────────────────────
console.log('\n[3] 残留');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
// 扫描器自己带规则字面量，跳过它
const SKIP_FILES = new Set([path.join('tools', 'check.mjs')]);
const TEXT_EXT = new Set(['.md', '.js', '.mjs', '.yml', '.yaml', '.json', '.txt', '.srt', '.ps1']);
const rules = [
  { name: '本机用户目录', re: /[A-Za-z]:\\+Users\\+[A-Za-z0-9_.-]+/ },
  { name: '本机项目路径', re: /[A-Za-z]:\\+(agent|deepseek)/ },
  { name: '真实账号名', re: /diy[i]ritian|quanquanquan[0-9]{3}/ },
  { name: '未登录态特征的 token', re: /\bghp_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9]{20,}/ },
  { name: '明显违规词', re: /破解版|外挂|白嫖|免会员|无限积分|盗版下载/ },
];
// 仓库地址里本来就有账号名，不算泄漏
const ALLOW = /githubusercontent\.com|github\.com\//;
const walked = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (TEXT_EXT.has(path.extname(entry.name))) walked.push(p);
  }
})(ROOT);

let hits = 0;
for (const file of walked) {
  const rel = path.relative(ROOT, file);
  if (SKIP_FILES.has(rel)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (ALLOW.test(line)) return;
    for (const rule of rules) {
      if (rule.re.test(line)) {
        hits++;
        console.log('  \u2717 ' + rel + ':' + (i + 1) + '  [' + rule.name + '] ' + line.trim().slice(0, 80));
      }
    }
  });
}
if (hits === 0) ok(walked.length + ' 个文本文件里没有残留');

// ── 4. 占位符 ──────────────────────────────────────────────
console.log('\n[4] 占位符');
let ph = 0;
for (const file of walked) {
  if (SKIP_FILES.has(path.relative(ROOT, file))) continue;
  const txt = fs.readFileSync(file, 'utf8');
  const m = txt.match(/%%(INSTALL|BADGES|REPO)%%/g);
  if (m) { ph += m.length; bad(path.relative(ROOT, file) + ' 还有 ' + [...new Set(m)].join(' ')); }
}
if (ph === 0) ok('没有未替换的占位符');

// ── 5. README 里的相对链接 ─────────────────────────────────
console.log('\n[5] README 链接');
const readmePath = path.join(ROOT, 'README.md');
if (!fs.existsSync(readmePath)) bad('缺 README.md');
else {
  const readme = fs.readFileSync(readmePath, 'utf8');
  const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((u) => !/^https?:|^#|^mailto:/.test(u));
  let missing = 0;
  for (const u of links) {
    const p = path.join(ROOT, decodeURIComponent(u.split('#')[0]));
    if (!fs.existsSync(p)) { missing++; bad('README 引用了不存在的文件: ' + u); }
  }
  if (missing === 0) ok(links.length + ' 个相对链接全部存在');
}

console.log(failed === 0 ? '\n全部通过 \u2713\n' : '\n' + failed + ' 项没通过\n');
process.exit(failed === 0 ? 0 : 1);
