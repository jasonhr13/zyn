export function targetOtpForTask(pending, taskId, email = '') {
  const wantedTask = String(taskId || '');
  const wantedEmail = String(email || '').trim().toLowerCase();
  return (Array.isArray(pending) ? pending : []).find(request => {
    const requestTask = String((request && request.taskId) || '');
    if (wantedTask && requestTask) return requestTask === wantedTask;
    return !requestTask && wantedEmail
      && String((request && request.email) || '').trim().toLowerCase() === wantedEmail;
  }) || null;
}

export function validTargetOtp(value) {
  return /^\d{6}$/.test(String(value || '').trim());
}
