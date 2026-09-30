'use strict';
/**
 * 源码语法守卫：遍历 src/ 下所有 .js 做语法检查。
 *
 * 为什么需要：npm test 只跑 test/ 下的测试，而 preload 入口（src/preload/index.js）
 * 等文件不被测试 require，语法错误会静默通过。此守卫补上这个盲区。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', '..', 'src');

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('src/ 下所有 .js 语法正确', () => {
  const files = walk(SRC, []);
  assert.ok(files.length > 0, '应找到至少一个 .js 文件');
  const bad = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (err) {
      bad.push(path.relative(SRC, f) + ': ' + String(err.stderr || err.message).split('\n')[0]);
    }
  }
  assert.strictEqual(bad.length, 0, '有语法错误的文件:\n' + bad.join('\n'));
});
