'use strict';
// ============================================================
//  「解析中」提示语的渲染（纯函数，**单拎出来是为了能被测试**）
//
//  🔴 为什么单独一个文件：
//     这个模板渲染原来写在 index.js 里，而 index.js 一被 require 就会连网关
//     ⇒ 测试没法直接碰它，于是这个 bug 一直没人拦（见下面）。
//     抽成纯函数后，`server/test-brain.js` 可以直接喂模板进去验。
//
//  🔴 2026-10-10 修的真 bug（线上实测原文）：
//     `🎬 正在处理 **7.7MBMB** 的视频，需要一点时间`
//     原因：模板里写的是 `{size}MB`（**单位在模板里**），而代码又给 `{size}`
//     拼上了一个 `'MB'` ⇒ 单位重复。
//
//  ⇒ 定规范：**单位一律由模板负责，代码只给裸数字**。
//     （`{quality}` 同理 —— 代码给的是 `360P` 这种自带单位的档位名，模板里别再拼）
// ============================================================

// 占位符（只有这三个，加新的请同时加测试）
const PLACEHOLDERS = ['{size}', '{quality}', '{title}'];

/**
 * @param {string} tpl   模板，如 '🎬 正在处理 {size}MB 的视频'
 * @param {{sizeMB?: string|number, quality?: string, title?: string}} data
 *        sizeMB 传**裸数字**（如 '7.7'），单位由模板写
 * @returns {string}
 */
function renderPendingText(tpl, data = {}) {
  const { sizeMB, quality, title } = data;
  const size = (sizeMB || sizeMB === 0) ? String(sizeMB) : '';
  return String(tpl == null ? '' : tpl)
    .replace(/\{size\}/g, size)
    .replace(/\{quality\}/g, String(quality || ''))
    .replace(/\{title\}/g, String(title || '').slice(0, 30));
}

// 模板里用了哪些占位符（给测试用：要求"模板只能出现已知占位符"）
function placeholdersIn(tpl) {
  const found = String(tpl || '').match(/\{[a-z]+\}/gi) || [];
  return [...new Set(found)];
}

module.exports = { renderPendingText, placeholdersIn, PLACEHOLDERS };
