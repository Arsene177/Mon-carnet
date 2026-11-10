import { t } from '@/lib/i18n';

/** A readable, translated message for an API or network error. */
export const errText = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'data' in error && typeof error.data === 'object' && error.data !== null) {
    if ('error' in error.data && typeof error.data.error === 'string') return t(error.data.error);
    if ('message' in error.data && typeof error.data.message === 'string') return t(error.data.message);
  }
  if (error instanceof Error) {
    if (/failed to fetch|network/i.test(error.message)) return t("Unable to connect. Check your internet connection and try again.");
    return t(error.message);
  }
  return t("Something went wrong. Please try again.");
};
