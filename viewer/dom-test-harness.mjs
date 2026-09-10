// jsdom DOM 测试基建（P16）：把真实 viewer/app.js 拉进 Node 测试。
//
// 用途：app.js 是纯浏览器模块（顶层 `document.getElementById` 取几十个元素、绑真实监听器，
// 并 fetch engine.wasm + 起 rAF 循环）——import 即执行。本 harness 负责：
//   1. 从 index.html 建完整 DOM（元素缺一个 app.js 顶层就抛错）；
//   2. 装上 app.js 会用到、而 Node 没有的浏览器全局（Canvas context / rAF / fetch 等）；
//   3. 让 import 到的 app.js 走「无 WASM → mock 事件流」路径，不起网络请求、不跑渲染循环。
//
// 关键原则：harness 只**搭台**，不重写任何被断言的逻辑 —— 测试点的是 app.js 自己
// `addEventListener` 绑的按钮，断言的是它自己写进 DOM 的值。删掉 app.js 里的接线，测试必红。
//
// 与 app.js 的 `?v=` 查询串配合见 ./test-query-loader.mjs（resolve 阶段剥离）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { MockContext } from './mock-canvas.js';
import { mockEventStream } from './mock-event-stream.js';
import { registerQueryStripLoader } from './test-query-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, 'index.html');

// 每个 harness 实例用不同的查询串 import app.js：Node 视作不同模块 URL → 拿到独立的
// 模块实例，app.js 的模块级状态（lastBundle / observationList / game）不会跨用例串味。
// 这与浏览器一致（同一个 URL 只求值一次），不是 hack。
//
// 隔离边界（实测核查过，写在这里免得后来人误判）：只有 app.js 是逐用例独立的。app.js 自己
// 的传递依赖（game.js / renderer.js / observation.js 等）import URL 恒定 → 所有 harness 共享
// 同一实例。当前无影响：这些模块无模块级可变状态（唯二的 micro-motion `_params`/`_fade`
// 只在渲染路径写入，而 rAF 是 no-op、采集/提交路径不碰）。若将来新增「驱动单帧渲染」的用例，
// 需注意该共享状态会跨用例渗漏。
let instanceSeq = 0;

// 需要从 jsdom window 借到 globalThis 的全局名。仅列 app.js 及其传递依赖在「import +
// init + 采集/提交」路径上真正会读到的；其余（Blob / URL / TextEncoder 等）Node 自带，
// 不必也不该覆盖。
const DOM_GLOBALS = ['document', 'window', 'location', 'localStorage', 'navigator', 'getComputedStyle'];

// rAF：jsdom 默认不提供（需 pretendToBeVisual，那会真起 16ms 定时器空转）。app.js 末尾
// `requestAnimationFrame(frame)` 起的渲染循环不在本 change 覆盖范围（design.md Non-Goals），
// 故给 no-op：测试确定性、不空转、无残留定时器。想驱动单帧的测试可在 import 前替换。
const noopRequestAnimationFrame = () => 0;
const noopCancelAnimationFrame = () => {};

// fetch 桩默认行为：抛错。app.js 的 loadEngine 会 catch 掉并退回 mock 事件流
//（mock-event-stream.js 注释即「engine.wasm 未就绪时 app 可用此数据替代」），
// 于是测试不碰网络、不依赖 engine.wasm 产物。
function makeFetchStub() {
  const calls = [];
  let handler = (call) => {
    throw new Error(`DOM harness: fetch 被禁用（${call.method} ${call.url}）`);
  };
  const fetchImpl = (url, init = {}) => {
    const call = { url: String(url), method: init?.method ?? 'GET', init };
    // 提交路径的 body 是 JSON 串：解析出来便于断言「实际提交了什么」。解析失败保留原文。
    if (typeof init?.body === 'string') {
      try {
        call.body = JSON.parse(init.body);
      } catch {
        call.rawBody = init.body;
      }
    }
    calls.push(call);
    return handler(call);
  };
  return {
    fetchImpl,
    calls,
    setHandler(fn) {
      handler = fn;
    },
    // 最近一次匹配方法的调用；找不到返回 undefined（断言里直接 .body 会 TypeError，够用）。
    lastCall(method) {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        if (calls[i].method === method) return calls[i];
      }
      return undefined;
    },
  };
}

// jsdom 没有 2d context（那要 node-canvas 原生依赖）。复用 renderer/micro-motion 测试
// 已在用的 MockContext。按元素缓存，语义上等价「一个 canvas 一个 context」。
function patchCanvasContext(window) {
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    if (!this.__mockCtx) {
      this.__mockCtx = new MockContext();
      this.__mockCtx.width = this.width;
      this.__mockCtx.height = this.height;
    }
    return this.__mockCtx;
  };
}

// ---- 假 WASM 引擎（opt-in）：断言「app.js 实际发给引擎什么 config」时才装 ----
// 不装时 fetch 桩抛错 → app.js 走 mock 事件流，测试完全不碰 wasm（既有用例的确定性路径）。
// 装上后 fetch(engine.wasm) 返回假字节，WebAssembly.instantiate 返回假实例：simulate() 把
// 收到的 config 原样记下来（app.js 把它写进 wasm 线性内存的 scratch 区，见 app.js loadEngine），
// 事件流则由同一份 mockEventStream() 充当——格式已知有效，createGame 能正常解析。
const FAKE_WASM_OUT_OFFSET = 8192; // 输出区（避开低地址 scratch 区）
const FAKE_WASM_MEM_BYTES = 64 * 1024;

function makeFakeEngine() {
  const calls = [];
  const memory = new Uint8Array(FAKE_WASM_MEM_BYTES);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let outLen = 0;
  const exportsObj = {
    memory: { buffer: memory.buffer },
    simulate(seed, ptr, len) {
      calls.push({ seed: Number(seed), config: JSON.parse(decoder.decode(memory.subarray(ptr, ptr + len))) });
      const out = encoder.encode(JSON.stringify(mockEventStream()));
      memory.set(out, FAKE_WASM_OUT_OFFSET);
      outLen = out.length;
    },
    get_json_ptr: () => FAKE_WASM_OUT_OFFSET,
    get_json_length: () => outLen,
    free_json: () => {},
  };
  return {
    calls,
    // 形状对齐 app.js loadEngine 的用法：await WebAssembly.instantiate(bytes, {}) → { instance: { exports } }
    webAssembly: { instantiate: async () => ({ instance: { exports: exportsObj } }) },
  };
}

function installGlobals(dom, fetchImpl, engineStub = null) {
  const restore = [];
  const put = (key, value) => {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of DOM_GLOBALS) {
    // getComputedStyle 等 window 方法依赖 this === window，取出时绑好。
    const value = dom.window[key];
    put(key, typeof value === 'function' ? value.bind(dom.window) : value);
  }
  put('requestAnimationFrame', noopRequestAnimationFrame);
  put('cancelAnimationFrame', noopCancelAnimationFrame);
  // fetch 覆盖 Node 内置的：默认抛错 → mock 事件流路径（见 makeFetchStub）。
  put('fetch', fetchImpl);
  // 假引擎只在显式 opt-in 时装：覆盖 Node 内置 WebAssembly（app.js 读裸全局）。
  if (engineStub) put('WebAssembly', engineStub.webAssembly);

  // app.js 的 showNotice（app.js:114）用全局 setTimeout 排 2.5s 定时器清 notice，属模块级
  // 状态、harness 够不着。不清理的话，点过采集/提交的用例会留个定时器吊着进程（app.test.js
  // 因此要 4.4s 才退出），并在 window.close() 后往 detached DOM 写。这里在 harness 存活期间
  // 包一层记录 handle，close() 时统一清掉。真实回调/clearTimeout 语义原样透传，只多记一笔。
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pendingTimers = new Set();
  put('setTimeout', (handler, delay, ...args) => {
    // 字符串 handler 形态 app.js 不用；非函数直接透传，绝不改语义。
    if (typeof handler !== 'function') return realSetTimeout(handler, delay, ...args);
    const handle = realSetTimeout((...cbArgs) => {
      pendingTimers.delete(handle);
      handler(...cbArgs);
    }, delay, ...args);
    pendingTimers.add(handle);
    return handle;
  });
  put('clearTimeout', (handle) => {
    pendingTimers.delete(handle);
    return realClearTimeout(handle);
  });

  return () => {
    // 先清 harness 期间排下的定时器（close 后不该再有回调落到已销毁的 window 上）。
    for (const handle of pendingTimers) realClearTimeout(handle);
    pendingTimers.clear();
    // 倒序还原，把 Node 原本的全局（navigator/fetch 等）还回去，避免污染同进程其他测试。
    for (let i = restore.length - 1; i >= 0; i -= 1) {
      const [key, descriptor] = restore[i];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

// 等 app.js 的启动链（tryLoadEngine().then(init)）把 game 建好。
// init 成功 → status 以「事件数」开头；失败 → 「错误」开头（原样抛出，方便定位）。
async function waitForAppReady(document) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const text = document.getElementById('status')?.textContent ?? '';
    if (text.startsWith('事件数')) return text;
    if (text.startsWith('错误')) throw new Error(`app.js init 失败：${text}`);
    if (Date.now() > deadline) throw new Error(`等 app.js init 超时（status="${text}"）`);
    await new Promise((r) => setImmediate(r));
  }
}

// 跑空若干轮宏任务，让 app.js 的 async 处理函数（提交等）跑完。
async function flushAsync(turns = 8) {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
}

// 同时只允许一个 harness 存活。原因：harness 把 jsdom window 的全局**装到 globalThis**上，
// 而 app.js 读的是裸 `document`/`window`。若两个 harness 重叠，close() 的逆序还原会互相踩踏
//（后关的那个会把前一个已失效的 window 还原回 globalThis，静默留下悬空全局）。串行是唯一
// 支持的用法（node:test 顶层用例本就串行），故把误用变成一眼可读的错误，而非静默串味。
let activeHarness = null;

/**
 * 建一个隔离的 app.js 测试环境。串行使用：用完必须 close() 再建下一个。
 * @param {{url?: string, fakeEngine?: boolean}} [opts] url：jsdom 的页面地址（默认 localhost）；
 *   fakeEngine：装假 WASM 引擎（默认 false）。装上后 app.js 走真实引擎路径，测试可经
 *   `harness.engineCalls` 断言 app.js 实际发给引擎的 config（见 makeFakeEngine）。
 * @returns harness
 */
export function createAppHarness({ url = 'http://localhost/', fakeEngine = false } = {}) {
  if (activeHarness) {
    throw new Error(
      'createAppHarness: 上一个 harness 尚未 close()。harness 会改写全局 document/window，' +
        '同一时刻只能有一个存活 —— 请在用例结束时 close()（afterEach）。'
    );
  }
  registerQueryStripLoader();

  const dom = new JSDOM(readFileSync(INDEX_HTML, 'utf8'), { url });
  patchCanvasContext(dom.window);

  const fetchStub = makeFetchStub();
  const engineStub = fakeEngine ? makeFakeEngine() : null;
  if (engineStub) {
    // app.js loadEngine 只在 response.ok 为真时继续；给个空体即可，内容不进 wasm 实例化。
    fetchStub.setHandler(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }));
  }
  const uninstallGlobals = installGlobals(dom, fetchStub.fetchImpl, engineStub);
  const { document } = dom.window;

  let closed = false;
  activeHarness = dom;

  const harness = {
    dom,
    window: dom.window,
    document,
    fetch: fetchStub,

    /** 元素查询（index.html 的 id）。 */
    $(id) {
      return document.getElementById(id);
    },

    /**
     * import 一份新鲜的 app.js（独立模块实例）并等它 init 完成。
     * 返回 app.js 的模块命名空间（本 change 不断言导出，保留供后续扩展）。
     */
    async importApp() {
      if (closed) throw new Error('harness 已关闭');
      instanceSeq += 1;
      const mod = await import(`./app.js?dom-harness=${instanceSeq}`);
      await waitForAppReady(document);
      return mod;
    },

    /** 点真实按钮（触发 app.js 自己绑的监听器）。 */
    click(id) {
      const el = document.getElementById(id);
      if (!el) throw new Error(`找不到元素 #${id}`);
      el.click();
      return flushAsync();
    },

    /** 等 app.js 里的 async 处理函数跑完。 */
    flush: flushAsync,

    /** 假引擎收到的 simulate 调用（仅 fakeEngine: true 时非空）：{ seed, config }[]。 */
    engineCalls: engineStub ? engineStub.calls : [],

    /** 观察描述输入框（#obs-statement）当前值。 */
    get statement() {
      return document.getElementById('obs-statement').value;
    },

    /** 设置观察描述输入框的值（模拟用户输入）。 */
    set statement(value) {
      document.getElementById('obs-statement').value = value;
    },

    /** 观察列表里某条目的描述（列表条目 title 存的是未截断的 statement）。 */
    entryStatements() {
      return [...document.querySelectorAll('#obs-list .obs-entry-statement')].map((el) => el.title);
    },

    close() {
      if (closed) return;
      closed = true;
      if (activeHarness === dom) activeHarness = null;
      uninstallGlobals();
      dom.window.close();
    },
  };

  return harness;
}
