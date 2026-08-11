const TIME_PREFIX = /^\[(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s?[AP]M)?\]\s/i;

const pad = value => String(value).padStart(2, '0');

export function formatLogTime(at = Date.now()) {
  const candidate = new Date(at);
  const date = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function timestampLogLine(value, at = Date.now()) {
  const time = formatLogTime(at);
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => TIME_PREFIX.test(line) ? line : `[${time}] ${line}`)
    .join('\n');
}

export function timestampLogLines(values, at = Date.now()) {
  return (Array.isArray(values) ? values : []).map(value => timestampLogLine(value, at));
}
