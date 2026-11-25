import { DE } from './lang-de.js';

const LANG_KEY = 'mcnetwork.lang';

function detect() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved) return saved;
  } catch {
    /* storage blocked: use the browser language */
  }
  return (navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en';
}

let lang = detect();
export const getLang = () => lang;

export function setLang(next) {
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* storage blocked */
  }
  document.documentElement.lang = next;
  window.dispatchEvent(new Event('languagechange-app'));
}
document.documentElement.lang = lang;

/** Texts are written in English in the code; other languages map them. Missing entries fall back to English. */
export function t(text, vars) {
  let out = lang === 'de' ? (DE[text] ?? text) : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}
