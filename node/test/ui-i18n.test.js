import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zhCN } from '../ui/locales/zh-CN.js';
import { detectLocale, getLocale, setLocale, subscribeLocale, translate, LOCALE_STORAGE_KEY } from '../ui/i18n.js';

const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('locale detection respects the saved choice and Simplified Chinese browser language', () => {
  assert.equal(detectLocale('en', ['zh-CN']), 'en');
  assert.equal(detectLocale('zh-CN', ['en-US']), 'zh-CN');
  for (const language of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans-CN']) assert.equal(detectLocale(null, [language]), 'zh-CN');
  for (const language of ['en-US', 'fr-FR', 'zh-TW', 'zh-HK', 'zh-Hant-CN']) assert.equal(detectLocale('invalid', [language]), 'en');
});

test('Chinese catalog keeps interpolation values literal and English falls back safely', () => {
  assert.equal(translate('Add upstream', {}, 'zh-CN'), '添加上游账户');
  assert.equal(translate('Unknown future message', {}, 'zh-CN'), 'Unknown future message');
  const value = '<script>{value1}</script>';
  assert.equal(translate('For {value0}', { value0: value }, 'zh-CN'), `账户：${value}`);
  assert.equal(translate('For {value0}', { value0: value }, 'en'), `For ${value}`);
  for (const [source, translated] of Object.entries(zhCN)) {
    assert.ok(translated.trim(), source);
    assert.deepEqual(placeholders(translated), placeholders(source), source);
  }
});

test('dashboard translation calls have reviewed Chinese messages', () => {
  const source = readFileSync(new URL('../ui/main.jsx', import.meta.url), 'utf8');
  const patterns = [/\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    /\bt\([^?\n]+\?\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")/g];
  const keys = [];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) for (const literal of match.slice(1)) {
    const key = literal.startsWith('"') ? JSON.parse(literal) : literal.slice(1, -1);
    keys.push(key);
    assert.ok(Object.hasOwn(zhCN, key), `Missing translation: ${key}`);
  }
  assert.ok(new Set(keys).size >= 280);
});

test('locale updates notify without remount requirements and survive unavailable storage', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const initial = getLocale();
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  let notifications = 0;
  const unsubscribe = subscribeLocale(() => { notifications++; });
  try {
    setLocale('zh-CN');
    assert.equal(getLocale(), 'zh-CN');
    assert.equal(storage.get(LOCALE_STORAGE_KEY), 'zh-CN');
    setLocale('invalid');
    assert.equal(getLocale(), 'zh-CN');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    setLocale('en');
    assert.equal(getLocale(), 'en');
    assert.equal(notifications, 2);
    unsubscribe(); setLocale('zh-CN'); assert.equal(notifications, 2);
  } finally {
    unsubscribe();
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage;
    setLocale(initial);
  }
});
