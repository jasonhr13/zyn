const { ImapFlow } = require('imapflow');
const { sanitizeImapPassword } = require('./imap-password');

const DEFAULT_TIMEOUT_MS = 15000;

function normalizeConfig(raw = {}) {
  return {
    host: String(raw.host || '').trim(),
    port: Number(raw.port || 993),
    user: String(raw.user || '').trim(),
    password: sanitizeImapPassword(raw.password || ''),
  };
}

function validateConfig(config) {
  if (!config.host) return 'Enter or select an IMAP server first.';
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) return 'Enter a valid IMAP port.';
  if (!config.user) return 'Enter the mailbox username.';
  if (!config.password) return 'Enter the mailbox app password.';
  return '';
}

function friendlyConnectionError(error) {
  const name = String(error?.name || '');
  const code = String(error?.serverResponseCode || error?.code || '').toUpperCase();
  const message = String(error?.message || '');
  const combined = `${name} ${code} ${message}`;

  if (/AuthenticationFailure|AUTHENTICATIONFAILED|AUTHENTICATION|Invalid credentials|Login failed|Password/i.test(combined)) {
    return 'Mailbox login was rejected. Check the username and use an app-specific password.';
  }
  if (/CONNECT_TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT|timed?\s*out|timeout/i.test(combined)) {
    return 'The connection timed out. Check the IMAP server and your internet connection.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(combined)) {
    return 'The IMAP server could not be found. Check the server address.';
  }
  if (/ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|NoConnection|Connection (?:closed|not available)/i.test(combined)) {
    return 'Could not connect to the IMAP server. Check the server address and port.';
  }
  if (/CERT|certificate|SSL|TLS/i.test(combined)) {
    return 'The IMAP server’s secure connection could not be verified.';
  }
  return 'Could not verify this mailbox. Check the IMAP settings and try again.';
}

async function testImapConnection(rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig);
  const validationError = validateConfig(config);
  if (validationError) return { ok: false, message: validationError };

  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const createClient = options.createClient || ((clientOptions) => new ImapFlow(clientOptions));
  const client = createClient({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: false },
    logger: false,
    verifyOnly: true,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });

  try {
    // verifyOnly authenticates and immediately logs out. It never selects a mailbox or reads mail.
    await client.connect();
    return { ok: true, message: 'Connection successful. The mailbox credentials are valid.' };
  } catch (error) {
    return { ok: false, message: friendlyConnectionError(error) };
  } finally {
    // Authentication failures can leave a partially opened transport. close() is synchronous and
    // safe to call after verifyOnly has already logged out.
    if (!client.isClosed && typeof client.close === 'function') client.close();
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  friendlyConnectionError,
  normalizeConfig,
  testImapConnection,
  validateConfig,
};
