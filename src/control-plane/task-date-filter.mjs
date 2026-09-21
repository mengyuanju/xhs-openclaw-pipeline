const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SHANGHAI_DATE_FORMAT = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function daysInMonth(year, month) {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function normalizeTaskDateFilter(value, field = 'task date filter') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a calendar date`);
  const match = value.match(DATE_ONLY_PATTERN);
  if (!match) throw new TypeError(`${field} must use YYYY-MM-DD`);
  const [, rawYear, rawMonth, rawDay] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new TypeError(`${field} is not a valid calendar date`);
  }
  return value;
}

export function normalizeTaskDateRange(createdDateFrom, createdDateTo) {
  const from = normalizeTaskDateFilter(createdDateFrom, 'createdDateFrom');
  const to = normalizeTaskDateFilter(createdDateTo, 'createdDateTo');
  if (from !== null && to !== null && from > to) {
    throw new RangeError('createdDateFrom cannot be after createdDateTo');
  }
  return { createdDateFrom: from, createdDateTo: to };
}

export function shanghaiCalendarDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('current date is invalid');
  const parts = Object.fromEntries(
    SHANGHAI_DATE_FORMAT.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
