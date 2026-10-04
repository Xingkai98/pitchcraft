// 视觉审阅：把一张 PNG 交给视觉模型判读，打印文字。
//
// 为什么不用 ~/.claude/scripts/vision.py：它是**推理模型**（deepseek-v4-flash-vision-exp），
// 思维链进 reasoning_content，最终答案进 content；vision.py 的 max_tokens=2048 会被思维链吃光
// → content 为空 → 打印空白。本脚本把 max_tokens 提到 8192，content 为空时回落到 reasoning_content。
//
// Key 取 DEEPSEEK_API_KEY → ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN（本机 Claude Code 用的那把）。
//
// 用法：node tools/visual-review/ask-vision.mjs <img.png> "<问题>"
const MODEL = 'deepseek-v4-flash-vision-exp';
const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const [img, ...qParts] = process.argv.slice(2);
if (!img) { console.error('用法: node ask-vision.mjs <img.png> "<问题>"'); process.exit(2); }
const question = qParts.join(' ') || '请详细描述这张图片的内容。';
const key = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
if (!key) { console.error('找不到 API key（DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN）'); process.exit(1); }

const b64 = readFileSync(img).toString('base64');
const mime = MIME[extname(img).toLowerCase()] || 'image/png';
const body = {
  model: MODEL, max_tokens: 8192,
  messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
    { type: 'text', text: question },
  ] }],
};
const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const j = await res.json();
const msg = j.choices?.[0]?.message || {};
console.log((msg.content || '').trim() || (msg.reasoning_content || '').trim() || '(空响应)');
