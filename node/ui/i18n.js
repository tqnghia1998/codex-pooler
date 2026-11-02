import { zhCN } from './locales/zh-CN.js';

export const LOCALE_STORAGE_KEY = 'relaydeck_locale';
export const SUPPORTED_LOCALES = Object.freeze(['en', 'zh-CN']);
export const ASTRYX_MESSAGES = {
  'zh-CN': {
    '@astryx.alertDialog.cancel': '取消',
    '@astryx.appShell.mobileNavigation': '移动导航',
    '@astryx.checkboxList.item.checkbox': '复选框',
    '@astryx.dialog.close': '关闭',
    '@astryx.selector.searchPlaceholder': '搜索…',
    '@astryx.selector.searchOptions': '搜索选项',
    '@astryx.selector.placeholder': '请选择…',
    '@astryx.toast.dismiss': '关闭通知',
    '@astryx.toast.viewport': '通知',
    '@astryx.moreMenu.label': '更多选项',
    '@astryx.numberInput.clearLabel': '清空{label}',
    '@astryx.selector.clearLabel': '清空{label}',
    '@astryx.textInput.clearLabel': '清空{label}'
  }
};
const listeners = new Set();
let currentLocale;

export function detectLocale(preference, languages = []) {
  if (SUPPORTED_LOCALES.includes(preference)) return preference;
  const language = String(languages[0] || '').toLowerCase();
  return /^zh(?:-|$)/.test(language) && !/(?:hant|tw|hk|mo)(?:-|$)/.test(language) ? 'zh-CN' : 'en';
}

export function getLocale() {
  if (currentLocale) return currentLocale;
  let preference;
  try { preference = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY); } catch {}
  currentLocale = detectLocale(preference, globalThis.navigator?.languages || [globalThis.navigator?.language]);
  return currentLocale;
}

export function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  currentLocale = locale;
  try { globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale); } catch {}
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener) {
  if (!listeners.size) globalThis.addEventListener?.('storage', syncStoredLocale);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) globalThis.removeEventListener?.('storage', syncStoredLocale);
  };
}

function syncStoredLocale(event) {
  if (event.key !== LOCALE_STORAGE_KEY && event.key !== null) return;
  currentLocale = undefined;
  getLocale();
  for (const listener of listeners) listener();
}

// Interpolate as text; values (including user data and protocol identifiers)
// are never looked up, reparsed, or inserted as HTML.
export function translate(source, values = {}, locale = 'en') {
  const message = locale === 'zh-CN' && Object.hasOwn(zhCN, source) ? zhCN[source] : source;
  return message.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(values, key) ? String(values[key] ?? '') : token);
}

export function t(source, values) {
  return translate(source, values, getLocale());
}

export function localeTag() {
  return getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US';
}

export function statusText(value) {
  const labels = {
    unknown: 'Unknown', known: 'Known', fresh: 'Fresh', stale: 'Stale',
    normal: 'Normal', cap_reached: 'Cap reached', continuation: 'Continuation',
    ready: 'Ready', enabled: 'Enabled', disabled: 'Disabled',
    closed: 'Closed', clear: 'Clear', live: 'Live', static: 'Static', cache: 'Cached',
    failed: 'Failed', pending: 'Pending', unlisted: 'Unlisted'
  };
  return t(labels[value] || value || 'Unknown');
}
