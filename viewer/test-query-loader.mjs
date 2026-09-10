// 测试专用 ESM loader（P16）：让 Node 能 import 顶层带 `?v=` cache-busting 查询串的模块。
//
// 背景：app.js 的顶层 import 全带 `?v=<日期-序号>` cache-busting 查询串（浏览器靠它强制刷新
// 入口模块；具体值见 app.js 文件头，会随每次改动 bump，此处不写死以免注释过期）。Node ESM
// 把查询串当模块 URL 的一部分，默认按文件名读盘 → ENOENT。选型见
// openspec/changes/p16-viewer-dom-test-harness/design.md D2：不改 app.js 源码、不破坏浏览器
// cache-busting（浏览器侧完全无感知）。
//
// 只用 resolve 钩子（**刻意不注册 load 钩子**）：
//   - 说明符带查询串、且是相对/绝对/file: 形态时，把查询串搬到 URL 的 **fragment**（`#`）上，
//     路径部分还原成干净的 .js —— Node 内置的文件加载器即可正常读盘，无需自己 readFileSync。
//   - fragment 只参与「模块身份」，不参与文件路径。不同 `?…` 于是得到不同的模块 URL →
//     各自独立的模块实例（与浏览器「同 URL 只求值一次」语义一致），测试可据此隔离 app.js
//     的模块级状态。
//   - 保留查询串（旧方案）会让内置加载器仍按含查询串的路径读盘而 ENOENT；搬到 fragment 则
//     路径干净、可被内置加载器直接消费。
//
// 为什么不注册 load 钩子：只要注册了 load 钩子（**哪怕纯 passthrough、直接 nextLoad 转发**），
// Node 就会改变同进程后续「经由 ESM import 载入的 CJS 包」的链接方式，导致 `import('jsdom')`
// 报 `ERR_VM_MODULE_LINK_FAILURE`。本 harness 静态 import jsdom 恰好在其之前执行，才没被波及 ——
// 这是「靠 import 顺序兜住的隐患」：将来任何在注册后动态 `await import('jsdom')`（或其它深层
// CJS 包）的代码都会莫名炸掉。resolve-only 方案从根上消除该隐患（已实测：注册后 import jsdom 正常）。
//
// 只接管相对/绝对/file: 说明符；node_modules 裸包名（jsdom 等）不受影响（无查询串，直接透传）。

import { registerHooks } from 'node:module';

// 需要接管的说明符形态：相对路径、绝对路径、file: URL。裸包名不碰。
const PATH_LIKE = /^(\.{1,2}\/|\/|file:)/;

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
      // 查询串 → fragment：路径干净（内置加载器可读），身份独立（模块实例隔离）。
      url.hash = url.search.slice(1);
      url.search = '';
      return { url: url.href, shortCircuit: true };
    },
  });
}
