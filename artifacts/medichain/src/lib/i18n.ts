import { useSyncExternalStore } from 'react';
import { fr } from './i18n-fr';

/**
 * Minimal bilingual (French / English) support.
 *
 * English text stays in the code and is the lookup key; `fr` maps it to French.
 * A missing translation falls back to the English text, so nothing breaks while
 * the dictionary catches up. Placeholders use `{name}` or `{0}`.
 *
 *   t('Medical records')
 *   t('Good to see you, {0}.', { 0: firstName })
 */
export type Language = 'fr' | 'en';

export const LANGUAGES: { code: Language; label: string; name: string }[] = [
  { code: 'fr', label: 'FR', name: 'Français' },
  { code: 'en', label: 'EN', name: 'English' },
];

const STORAGE_KEY = 'moncarnet_language';

function detectLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'fr' || saved === 'en') return saved;
  } catch {
    // Storage can be unavailable (private mode); fall through to the browser language.
  }
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  // Most of Cameroon reads French; use English only when the device asks for it first.
  return preferred.find((code) => /^(en|fr)/i.test(code))?.toLowerCase().startsWith('en') ? 'en' : 'fr';
}

let current: Language = detectLanguage();
const listeners = new Set<() => void>();

function applyDocumentLanguage(language: Language) {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}
applyDocumentLanguage(current);

export function getLanguage(): Language {
  return current;
}

export function setLanguage(language: Language) {
  if (language === current) return;
  current = language;
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Keep the choice for this visit only.
  }
  applyDocumentLanguage(language);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders the calling component when the language changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/** Locale for dates and numbers, e.g. 7 nov. 2026 in French. */
export function locale(): string {
  return current === 'fr' ? 'fr-CM' : 'en-GB';
}

export function t(text: string, values?: Record<string | number, string | number | null | undefined>): string {
  const template = current === 'fr' ? fr[text] ?? text : text;
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? match : String(value);
  });
}
