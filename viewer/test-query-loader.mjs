// 测试专用 ESM loader（P16）：让 Node 能 import 顶层带 `?v=` cache-busting 查询串的模块。
//
// 背景：app.js 的顶层 import 全带 `?v=20260910-1`（浏览器靠它强制刷新入口模块）。Node ESM
// 把查询串当模块 URL 的一部分，默认按文件名读盘 → ENOENT。选型见
// openspec/changes/p16-viewer-dom-test-harness/design.md D2：不改 app.js 源码、不破坏浏览器
// cache-busting（浏览器侧完全无感知）。
//
// 两条钩子分工：
//   resolve：相对/绝对/file: 说明符若带查询串，解析成「保留查询串的绝对 file URL」并
//            shortCircuit。查询串保留 → 不同查询串是不同的模块 URL（与浏览器一致），
//            因此测试可用不同查询串各 import 一份独立的 app.js（模块级状态互不污染）。
//   load：读盘时把查询串剥掉再 readFileSync —— 查询串是模块身份，不是文件名的一部分。
//
// 只处理 file: 协议；node_modules 的裸说明符不受影响（无查询串，直接走默认解析）。

import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

// 需要接管的说明符形态：相对路径、绝对路径、file: URL。裸包名（jsdom 等）不碰。
const PATH_LIKE = /^(\.{1,2}\/|\/|file:)/;

// 按扩展名给 format：Node 的 load 钩子要求显式 format（默认解析已被 shortCircuit 跳过）。
// 本项目的带查询串模块全是 .js（ESM）；其余扩展名保守按 module 处理，避免误判成 CJS。
const FORMAT_BY_EXT = { '.mjs': 'module', '.cjs': 'commonjs', '.json': 'json' };

let registered = false;

// 幂等：harness 可能被多个测试文件 import，重复注册会叠加多条钩子。
export function registerQueryStripLoader() {
  if (registered) return;
  // module.registerHooks 自 Node 22.15 起可用。缺失说明 Node 过旧 —— 直接给出可操作的
  // 错误，而不是让 app.js 的查询串 import 以难懂的 ENOENT 失败（design.md D2 已弃用
  // 「改 app.js 去查询串」方案，故此处不静默回退）。
  if (typeof registerHooks !== 'function') {
    throw new Error(
      `当前 Node ${process.version} 不支持 module.registerHooks（需 >= 22.15.0）；` +
        'viewer DOM 测试（app.test.js）无法剥离 app.js 的 ?v= 查询串 import。请升级 Node。'
    );
  }
  registered = true;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.includes('?') || !PATH_LIKE.test(specifier)) {
        return nextResolve(specifier, context);
      }
      // parentURL 必为 file:（本仓库全是文件模块）；相对说明符相对它解析。
      const url = new URL(specifier, context.parentURL);
      return { url: url.href, shortCircuit: true };
    },

    load(url, context, nextLoad) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'file:' || parsed.search === '') {
        return nextLoad(url, context);
      }
      const path = decodeURIComponent(parsed.pathname);
      const dot = path.lastIndexOf('.');
      const format = FORMAT_BY_EXT[path.slice(dot)] ?? 'module';
      return { format, source: readFileSync(path, 'utf8'), shortCircuit: true };
    },
  });
}
