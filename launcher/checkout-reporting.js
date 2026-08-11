'use strict';

// Checkout notifications are operational telemetry, so identify the buyer with the same account
// that the license authority has actually authenticated. Read it at checkout/task-launch time so a
// login, logout, or account switch takes effect without restarting the app.

function signedInEmail(getLicenseStatus) {
  try {
    const status = getLicenseStatus();
    if (!status || status.ok !== true) return '';
    return String(status.email || '').trim().toLowerCase().slice(0, 254);
  } catch {
    return '';
  }
}

function installCheckoutReporting({ reporter, taskHandler, getLicenseStatus = () => null } = {}) {
  const buyerEmail = () => signedInEmail(getLicenseStatus);

  if (reporter && typeof reporter.configure === 'function') {
    const configureReporter = reporter.configure.bind(reporter);
    const reportCheckout = typeof reporter.report === 'function'
      ? reporter.report.bind(reporter)
      : null;
    const configureForAccount = (next = {}) => configureReporter({
      ...next,
      key: '',
      token: '',
      discord: buyerEmail(),
      discordId: '',
    });

    // The retired license client may still attempt to configure this object. Keep account identity
    // authoritative at that boundary, and refresh immediately before every checkout notification.
    reporter.configure = configureForAccount;
    if (reportCheckout) {
      reporter.report = (...args) => {
        configureForAccount();
        return reportCheckout(...args);
      };
    }
    configureForAccount();
  }

  if (taskHandler && typeof taskHandler.startPbandai === 'function') {
    const startPbandai = taskHandler.startPbandai.bind(taskHandler);
    taskHandler.startPbandai = (options, ...rest) => startPbandai({
      ...(options || {}),
      buyerDiscord: buyerEmail(),
      dashboardKey: '',
    }, ...rest);
  }
}

module.exports = { installCheckoutReporting, signedInEmail };
