/** Time helpers. All persisted timestamps are unix epoch milliseconds. */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function now(): number {
  return Date.now();
}

export function iso(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

const FA_MONTHS = [
  "ژانویه",
  "فوریه",
  "مارس",
  "آوریل",
  "مه",
  "ژوئن",
  "ژوئیه",
  "اوت",
  "سپتامبر",
  "اکتبر",
  "نوامبر",
  "دسامبر",
];

/** Gregorian date rendered in Persian digits, e.g. `۱۴۰۴/۰۸/۱۰` style is avoided
 * on purpose: the platform stores what customers ask for, so we show the ISO
 * calendar with Persian digits and a Persian month name. */
export function formatDateFa(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  const day = toPersianDigits(date.getUTCDate());
  const month = FA_MONTHS[date.getUTCMonth()] ?? "";
  const year = toPersianDigits(date.getUTCFullYear());
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year} — ${toPersianDigits(hh)}:${toPersianDigits(mm)} UTC`;
}

export function formatRelativeFa(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const diff = Date.now() - ms;
  if (diff < MINUTE) return "همین حالا";
  if (diff < HOUR) return `${toPersianDigits(Math.floor(diff / MINUTE))} دقیقه پیش`;
  if (diff < DAY) return `${toPersianDigits(Math.floor(diff / HOUR))} ساعت پیش`;
  return `${toPersianDigits(Math.floor(diff / DAY))} روز پیش`;
}

export function formatDurationFa(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / SECOND);
  if (seconds < 60) return `${toPersianDigits(seconds)} ثانیه`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${toPersianDigits(minutes)} دقیقه`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${toPersianDigits(hours)} ساعت`;
  return `${toPersianDigits(Math.floor(hours / 24))} روز`;
}

const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

export function toPersianDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/** Truncates to whole minutes — used for rate-limit windows. */
export function windowStart(sizeMs: number, at: number = Date.now()): number {
  return Math.floor(at / sizeMs) * sizeMs;
}
