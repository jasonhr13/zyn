export function asEpoch(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

export function normalizeSchedule(raw, site = 'target') {
  if (String(site || '').toLowerCase() !== 'target' || !raw || typeof raw !== 'object') return null;
  const startAt = asEpoch(raw.startAt);
  let stopAt = asEpoch(raw.stopAt);
  if (startAt != null && stopAt != null && stopAt <= startAt) stopAt = null;
  if (startAt == null && stopAt == null) return null;
  return { startAt, stopAt };
}

export function resolveClockTimeToEpoch(value, now = Date.now()) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const base = new Date(now);
  const result = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  if (result.getTime() <= now) result.setDate(result.getDate() + 1);
  return result.getTime();
}

export function resolveIntervalToEpoch(amount, unit, now = Date.now()) {
  const number = Number(amount);
  if (!Number.isFinite(number) || number <= 0) return null;
  const multiplier = String(unit || '').toLowerCase() === 'minutes' ? 60_000 : 3_600_000;
  return Math.floor(now + number * multiplier);
}

export function buildScheduleFromDraft(draft, now = Date.now()) {
  const value = draft && typeof draft === 'object' ? draft : {};
  let startAt = null;
  let stopAt = null;
  if (value.startMode === 'at') startAt = resolveClockTimeToEpoch(value.startTime, now);
  if (value.startMode === 'in') startAt = resolveIntervalToEpoch(value.startAmount, value.startUnit, now);
  if (value.stopMode === 'at') stopAt = resolveClockTimeToEpoch(value.stopTime, now);
  if (value.stopMode === 'in') stopAt = resolveIntervalToEpoch(value.stopAmount, value.stopUnit, now);
  if (value.startMode !== 'off' && startAt == null) return { error: 'Choose a valid start time or interval.' };
  if (value.stopMode !== 'off' && stopAt == null) return { error: 'Choose a valid stop time or interval.' };
  if (startAt != null && stopAt != null && stopAt <= startAt) return { error: 'Stop time must be after the start time.' };
  return { schedule: startAt == null && stopAt == null ? null : { startAt, stopAt } };
}

export function formatLocalTime(epochMs) {
  const value = asEpoch(epochMs);
  if (value == null) return '';
  return new Date(value).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function formatCountdown(epochMs, now = Date.now()) {
  const value = asEpoch(epochMs);
  if (value == null || value <= now) return 'now';
  const totalMinutes = Math.max(1, Math.round((value - now) / 60_000));
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

export function scheduleSummary(schedule, now = Date.now()) {
  const normalized = normalizeSchedule(schedule);
  if (!normalized) return '';
  const parts = [];
  if (normalized.startAt != null) parts.push(`Starts ${formatCountdown(normalized.startAt, now)}`);
  if (normalized.stopAt != null) parts.push(`Stops ${formatCountdown(normalized.stopAt, now)}`);
  return parts.join(' · ');
}

export function scheduleDetailLine(schedule) {
  const normalized = normalizeSchedule(schedule);
  if (!normalized) return '';
  const parts = [];
  if (normalized.startAt != null) parts.push(`start ${formatLocalTime(normalized.startAt)}`);
  if (normalized.stopAt != null) parts.push(`stop ${formatLocalTime(normalized.stopAt)}`);
  return parts.join(', ');
}

export function emptyScheduleDraft() {
  return {
    startMode: 'off', startTime: '', startAmount: '1', startUnit: 'hours',
    stopMode: 'off', stopTime: '', stopAmount: '1', stopUnit: 'hours',
  };
}

export function draftFromSchedule(schedule) {
  const normalized = normalizeSchedule(schedule);
  const draft = emptyScheduleDraft();
  if (!normalized) return draft;
  if (normalized.startAt != null) {
    const date = new Date(normalized.startAt);
    draft.startMode = 'at';
    draft.startTime = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  if (normalized.stopAt != null) {
    const date = new Date(normalized.stopAt);
    draft.stopMode = 'at';
    draft.stopTime = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return draft;
}
