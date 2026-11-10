// Rules for new passwords (OWASP ASVS 2.1, NIST SP 800-63B): long enough, not a known common
// password, and not built from the account's own details. No composition rules (no forced
// symbols or digits) and no forced periodic changes, which make passwords weaker in practice.
import { COMMON_PASSWORDS } from "./common-passwords";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

const STRIP_EDGES = /^[^a-z]+|[^a-z]+$/g;

/**
 * The English-language list misses what French speakers and Cameroonians commonly use: AZERTY
 * keyboard rows, French words, places, football and faith. Compared after removing digits and
 * symbols at either end, like the main list.
 */
const LOCAL_COMMON_PASSWORDS = new Set([
  "azerty", "azertyuiop", "azertyuiopqsdfghjklm", "qsdfghjklm", "wxcvbn", "azertyqwerty", "aqwzsx",
  "motdepasse", "mot de passe", "monmotdepasse", "secret", "soleil", "bonjour", "bonsoir", "salut", "coucou",
  "doudou", "chouchou", "loulou", "bebe", "cheri", "cherie", "jetaime", "amour", "monamour",
  "maman", "papa", "mamanjetaime", "famille", "princesse", "prince", "chocolat", "football", "foot",
  "cameroun", "cameroon", "douala", "yaounde", "bafoussam", "garoua", "bamenda", "maroua", "ngaoundere",
  "kribi", "limbe", "buea", "lionsindomptables", "lions", "indomptables", "etoo", "afrique", "africa",
  "jesus", "jesuschrist", "dieu", "dieuestamour", "dieuestbon", "jehovah", "alleluia", "allah", "emmanuel",
  "moncarnet", "medichain", "carnet", "sante", "docteur", "hopital", "patient",
]);

/** The reason a new password is refused, or null when it is acceptable. Messages are translated by the web app. */
export function newPasswordProblem(
  password: string,
  account: { email?: string | null; name?: string | null; contactInfo?: string | null } = {},
): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters. A short sentence is easy to remember and hard to guess.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  const lower = password.toLowerCase();
  // "password2024!" and "!!azerty123" count as the common words they are built on.
  const core = lower.replace(STRIP_EDGES, "");
  const isCommon = (word: string) => COMMON_PASSWORDS.has(word) || LOCAL_COMMON_PASSWORDS.has(word);
  if (new Set(lower).size <= 2 || isCommon(lower) || (core.length >= 4 && isCommon(core))) {
    return "This password is too common and easy to guess. Choose another one, for example a short sentence.";
  }
  const personal = [
    account.email?.split("@")[0]?.toLowerCase(),
    ...(account.name ?? "").toLowerCase().split(/[\s'’-]+/),
  ].filter((part): part is string => Boolean(part) && part!.length >= 4);
  const phoneDigits = (account.contactInfo ?? "").replace(/\D/g, "");
  if (personal.some((part) => lower.includes(part)) || (phoneDigits.length >= 8 && password.replace(/\D/g, "").includes(phoneDigits.slice(-8)))) {
    return "Do not use your name, email address or phone number in your password.";
  }
  return null;
}
