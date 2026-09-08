export function targetOtpForTask(pending, taskId, email = '', status) {
  if (arguments.length >= 4 && !targetStatusAllowsOtp(status)) return null;
  const wantedTask = String(taskId || '');
  const wantedEmail = String(email || '').trim().toLowerCase();
  return (Array.isArray(pending) ? pending : []).find(request => {
    const requestTasks = new Set([
      String((request && request.taskId) || ''),
      ...((Array.isArray(request && request.taskIds) ? request.taskIds : []).map(id => String(id || ''))),
    ].filter(Boolean));
    if (wantedTask && requestTasks.size) return requestTasks.has(wantedTask);
    return !requestTasks.size && wantedEmail
      && String((request && request.email) || '').trim().toLowerCase() === wantedEmail;
  }) || null;
}

export function targetStatusAllowsOtp(status) {
  const text = [status && status.label, status && status.state, status && status.detail]
    .filter(Boolean).join(' ');
  if (!text) return false;
  return !/\b(?:waiting for restock|watching for restock|getting product(?:s|\(s\))?|monitoring products?|adding to cart|carted|submitting payment|submitting cvv|submitting order|successful|checked out|out of stock|waiting for order)\b/i.test(text);
}

export function validTargetOtp(value) {
  return /^\d{6}$/.test(String(value || '').trim());
}
