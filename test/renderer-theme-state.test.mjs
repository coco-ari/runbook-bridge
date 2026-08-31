import assert from 'node:assert/strict';
import test from 'node:test';
import {
  THEME_STORAGE_KEY,
  applyTheme,
  isThemePreference,
  persistThemePreference,
  readThemePreference,
  resolveTheme,
} from '../renderer/v2/src/state/theme-state.ts';

test('theme preferences accept only the three supported exact values', () => {
  for (const preference of ['light', 'dark', 'system']) assert.equal(isThemePreference(preference), true);
  for (const invalid of [undefined, null, true, 0, {}, [], '', 'Dark', ' light ', 'auto']) {
    assert.equal(isThemePreference(invalid), false);
  }
});

test('reading a theme preference uses the stable key and falls back for absent or invalid stored values', () => {
  assert.equal(THEME_STORAGE_KEY, 'runbook-bridge:theme-preference:v1');
  for (const stored of ['light', 'dark', 'system', null, '', 'sepia', '"dark"', ' dark ']) {
    const reads = [];
    const preference = readThemePreference({ getItem(key) { reads.push(key); return stored; } });
    assert.deepEqual(reads, [THEME_STORAGE_KEY]);
    assert.equal(preference, ['light', 'dark', 'system'].includes(stored) ? stored : 'system');
  }
});

test('explicit themes override the system while the system preference follows both appearances', () => {
  for (const [preference, prefersDark, expected] of [
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ]) assert.equal(resolveTheme(preference, prefersDark), expected);
});

test('persisted preferences round-trip to the same appearance on a new startup without changing unrelated storage', () => {
  const values = new Map([['unrelated-setting', 'preserved']]);
  const writes = [];
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); values.set(key, value); },
  };
  for (const preference of ['light', 'dark', 'system']) {
    assert.equal(persistThemePreference(preference, storage), true);
    assert.deepEqual(writes.at(-1), [THEME_STORAGE_KEY, preference]);
    const restartedStorage = { getItem: (key) => values.get(key) ?? null };
    const restartedPreference = readThemePreference(restartedStorage);
    assert.equal(restartedPreference, preference);
    for (const prefersDark of [false, true]) {
      assert.equal(resolveTheme(restartedPreference, prefersDark), resolveTheme(preference, prefersDark));
    }
  }
  assert.equal(values.get('unrelated-setting'), 'preserved');
  assert.equal(values.size, 2);
  assert.equal(writes.length, 3);
});

test('unavailable storage and read or write failures are safe fallbacks', () => {
  assert.equal(readThemePreference(null), 'system');
  assert.equal(persistThemePreference('dark', null), false);
  assert.equal(readThemePreference({ getItem() { throw new Error('Storage unavailable'); } }), 'system');
  assert.equal(persistThemePreference('light', { setItem() { throw new Error('Storage full'); } }), false);
});

test('default storage access uses the current window and safely handles unavailable storage', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    delete globalThis.window;
    assert.equal(readThemePreference(), 'system');
    assert.equal(persistThemePreference('dark'), false);

    const writes = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: {
        getItem: (key) => key === THEME_STORAGE_KEY ? 'light' : null,
        setItem: (key, value) => writes.push([key, value]),
      } },
    });
    assert.equal(readThemePreference(), 'light');
    assert.equal(persistThemePreference('dark'), true);
    assert.deepEqual(writes, [[THEME_STORAGE_KEY, 'dark']]);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { get localStorage() { throw new Error('Storage access denied'); } },
    });
    assert.equal(readThemePreference(), 'system');
    assert.equal(persistThemePreference('light'), false);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  }
});

test('applying themes records the preference and effective appearance while preserving other dataset values', () => {
  const root = { dataset: { theme: 'dark', themePreference: 'dark', workspaceMode: 'detail' } };
  applyTheme('light', true, root);
  assert.deepEqual(root.dataset, { theme: 'light', themePreference: 'light', workspaceMode: 'detail' });
  applyTheme('dark', false, root);
  assert.deepEqual(root.dataset, { theme: 'dark', themePreference: 'dark', workspaceMode: 'detail' });
  applyTheme('system', false, root);
  assert.deepEqual(root.dataset, { theme: 'light', themePreference: 'system', workspaceMode: 'detail' });
  applyTheme('system', true, root);
  assert.deepEqual(root.dataset, { theme: 'dark', themePreference: 'system', workspaceMode: 'detail' });
});
