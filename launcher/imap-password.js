// Clipboard sources can insert non-breaking spaces, line separators, zero-width characters, and
// direction markers into what visually appears to be a plain app password. Preserve ordinary ASCII
// spaces exactly (Gmail displays app passwords in spaced groups), translate other whitespace to a
// regular space, and remove only invisible control/formatting characters. Visible punctuation is
// deliberately untouched because it can be part of a legitimate provider password.
function sanitizeImapPassword(value) {
  return String(value ?? '')
    .replace(/[^\S ]/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\u034F]/gu, '');
}

module.exports = { sanitizeImapPassword };
