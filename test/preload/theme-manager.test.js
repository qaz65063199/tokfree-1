'use strict';

const test = require('node:test');
const assert = require('node:assert');

const themeManager = require('../../src/preload/overlay/theme-manager.js');

test('模块能被 require，且导出预期 API', () => {
  assert.strictEqual(typeof themeManager.getTheme, 'function');
  assert.strictEqual(typeof themeManager.setTheme, 'function');
  assert.strictEqual(typeof themeManager.listThemes, 'function');
});

test('listThemes 返回 4 项主题，每项含 id 与 name', () => {
  const themes = themeManager.listThemes();
  assert.strictEqual(themes.length, 4);
  for (const t of themes) {
    assert.strictEqual(typeof t.id, 'string');
    assert.ok(t.id.length > 0);
    assert.strictEqual(typeof t.name, 'string');
    assert.ok(t.name.length > 0);
  }
  const ids = themes.map((t) => t.id).sort();
  assert.deepStrictEqual(ids, ['forest', 'ocean', 'sunset', 'violet']);
});

test('setTheme 对无效主题不崩溃，返回 false', () => {
  assert.doesNotThrow(() => {
    themeManager.setTheme('not-a-theme');
  });
  assert.strictEqual(themeManager.setTheme('not-a-theme'), false);
  assert.strictEqual(themeManager.setTheme(undefined), false);
});

test('无 DOM 环境下 getTheme 回退默认主题', () => {
  // 单测运行在 Node 中，无 document / localStorage
  assert.strictEqual(themeManager.getTheme(), themeManager.DEFAULT_THEME);
  assert.strictEqual(themeManager.DEFAULT_THEME, 'violet');
});
