const STREET_SUFFIXES = {
  street: ['St', 'St.', 'Street', 'STR', 'STR.', 'ST'],
  st: ['St', 'St.', 'Street', 'STR', 'STR.', 'ST'],
  str: ['St', 'St.', 'Street', 'STR', 'STR.'],
  avenue: ['Ave', 'Ave.', 'Avenue', 'AV', 'AV.', 'AVE'],
  ave: ['Ave', 'Ave.', 'Avenue', 'AV', 'AV.', 'AVE'],
  av: ['Ave', 'Ave.', 'Avenue', 'AV', 'AV.'],
  boulevard: ['Blvd', 'Blvd.', 'Boulevard', 'BLVD', 'Boul'],
  blvd: ['Blvd', 'Blvd.', 'Boulevard', 'BLVD', 'Boul'],
  drive: ['Dr', 'Dr.', 'Drive', 'DRV', 'DRV.', 'DR'],
  dr: ['Dr', 'Dr.', 'Drive', 'DRV', 'DRV.', 'DR'],
  drv: ['Dr', 'Dr.', 'Drive', 'DRV', 'DRV.'],
  road: ['Rd', 'Rd.', 'Road', 'RD', 'RD.'],
  rd: ['Rd', 'Rd.', 'Road', 'RD', 'RD.'],
  lane: ['Ln', 'Ln.', 'Lane', 'LN', 'LN.', 'LANE'],
  ln: ['Ln', 'Ln.', 'Lane', 'LN', 'LN.', 'LANE'],
  court: ['Ct', 'Ct.', 'Court', 'CRT', 'CRT.', 'CT'],
  ct: ['Ct', 'Ct.', 'Court', 'CRT', 'CRT.', 'CT'],
  crt: ['Ct', 'Ct.', 'Court', 'CRT', 'CRT.'],
  place: ['Pl', 'Pl.', 'Place', 'PL', 'PL.'],
  pl: ['Pl', 'Pl.', 'Place', 'PL', 'PL.'],
  circle: ['Cir', 'Cir.', 'Circle', 'CIR', 'CRCL'],
  cir: ['Cir', 'Cir.', 'Circle', 'CIR', 'CRCL'],
  terrace: ['Ter', 'Ter.', 'Terrace', 'TERR', 'TER'],
  ter: ['Ter', 'Ter.', 'Terrace', 'TERR', 'TER'],
  terr: ['Ter', 'Ter.', 'Terrace', 'TERR'],
  parkway: ['Pkwy', 'Pkwy.', 'Parkway', 'PKWY', 'Pky'],
  pkwy: ['Pkwy', 'Pkwy.', 'Parkway', 'PKWY', 'Pky'],
  highway: ['Hwy', 'Hwy.', 'Highway', 'HWY'],
  hwy: ['Hwy', 'Hwy.', 'Highway', 'HWY'],
  trail: ['Trl', 'Trl.', 'Trail', 'TRL'],
  trl: ['Trl', 'Trl.', 'Trail', 'TRL'],
  way: ['Way', 'WAY', 'Wy', 'Wy.'],
  wy: ['Way', 'WAY', 'Wy', 'Wy.'],
};

const UNIT_PREFIXES = ['Apt', 'Apartment', 'Unit', 'Ste', 'Suite', '#'];
const LINE1_PREFIX_LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const LINE1_PREFIX_LENGTH = 3;

function cloneAddress(value) {
  return value && typeof value === 'object' ? { ...value } : value;
}

function hasStreetAddress(value) {
  return Boolean(value && String(value.address || '').trim());
}

function pick(rng, list) {
  return list[Math.max(0, Math.min(list.length - 1, Math.floor(rng() * list.length)))];
}

function longestSuffixWord(variants) {
  return (variants || []).reduce((best, item) => {
    const word = String(item || '').replace(/\.+$/, '');
    return word.length > best.length ? word : best;
  }, '');
}

function mutateSuffixToken(token, variants, rng) {
  const full = longestSuffixWord(variants.length ? variants : [token]);
  const roll = rng();
  // Extra-letter forms on the full word (Lanee, LLane) stay closer to the real suffix
  // than mutating "Ln" into "Lnn". Short table picks stay in the mix too.
  if (full.length >= 3 && roll < 0.28) return `${full.charAt(0)}${full}`;
  if (full.length >= 3 && roll < 0.56) return `${full}${full.charAt(full.length - 1)}`;
  if (full.length >= 4 && roll < 0.70) return full.slice(0, -1);
  return token;
}

function rotateStreetSuffix(rest, rng) {
  const tokens = String(rest || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return rest;
  const last = tokens[tokens.length - 1];
  const key = last.toLowerCase().replace(/\.+$/, '');
  const variants = STREET_SUFFIXES[key] || [last];
  const others = variants.filter(variant => variant.toLowerCase() !== last.toLowerCase());
  const next = pick(rng, others.length ? others : variants);
  tokens[tokens.length - 1] = mutateSuffixToken(next, variants, rng);
  return tokens.join(' ');
}

function randomLine1Prefix(rng) {
  let prefix = '';
  for (let index = 0; index < LINE1_PREFIX_LENGTH; index++) {
    prefix += LINE1_PREFIX_LETTERS[Math.max(0, Math.min(
      LINE1_PREFIX_LETTERS.length - 1,
      Math.floor(rng() * LINE1_PREFIX_LETTERS.length),
    ))];
  }
  return prefix;
}

function composeLine1(house, street, rng) {
  const cosmetic = Math.floor(rng() * 3);
  if (cosmetic === 0) return `${house}  ${street}`;
  if (cosmetic === 1) return `${house}, ${street}`;
  return `${house} ${street}`;
}

function jigLine1(address, rng, usePrefix) {
  const original = String(address || '').trim();
  if (!original) return { address: original, usedPrefix: false, changed: false };
  const match = original.match(/^(\S+)(\s+)(.+)$/);
  const body = match
    ? (usePrefix
      ? `${match[1]} ${rotateStreetSuffix(match[3], rng)}`
      : composeLine1(match[1], rotateStreetSuffix(match[3], rng), rng))
    : original;
  if (usePrefix) {
    const next = `${randomLine1Prefix(rng)} ${body}`;
    return { address: next, usedPrefix: true, changed: next !== original };
  }
  if (body !== original) return { address: body, usedPrefix: false, changed: true };
  // Street could not be varied enough on its own — fall back to the 3-letter prefix
  // instead of the same line 1 plus a fake apt.
  const next = `${randomLine1Prefix(rng)} ${original}`;
  return { address: next, usedPrefix: true, changed: true };
}

function reformatUnit(address2, rng) {
  const original = String(address2 || '').trim();
  const parsed = original.match(/^(apt\.?|apartment|unit|ste\.?|suite|#|no\.?|number)\s*(.+)$/i);
  const unit = parsed ? String(parsed[2] || '').trim() : original;
  const prefix = pick(rng, UNIT_PREFIXES);
  return prefix === '#' ? `#${unit}` : `${prefix} ${unit}`;
}

function inventUnit(rng) {
  const prefix = pick(rng, UNIT_PREFIXES);
  const number = 1 + Math.floor(rng() * 299);
  return prefix === '#' ? `#${number}` : `${prefix} ${number}`;
}

function shippingAddressKey(shipping) {
  const value = shipping || {};
  return [
    String(value.address || ''),
    String(value.address2 || ''),
    String(value.city || '').trim().toLowerCase(),
    String(value.state || '').trim().toLowerCase(),
    String(value.zipcode || value.zip || '').trim(),
  ].join('\0');
}

function reservedShippingKeys(profiles) {
  const used = new Set();
  for (const profile of (Array.isArray(profiles) ? profiles : [])) {
    if (!isTargetProfile(profile) || !hasStreetAddress(profile.shipping)) continue;
    used.add(shippingAddressKey(profile.shipping));
  }
  return used;
}

function uniqueJiggedShipping(shipping, rng, used) {
  let last = { address: shipping.address, address2: shipping.address2 };
  for (let attempt = 0; attempt < 24; attempt++) {
    const lines = jigShippingLines(shipping, rng);
    const candidate = { ...shipping, ...lines };
    const key = shippingAddressKey(candidate);
    const line1Changed = lines.address !== String(shipping.address || '');
    if (line1Changed && !used.has(key)) {
      used.add(key);
      return candidate;
    }
    last = lines;
  }
  let address = String(last.address || shipping.address || '');
  const address2 = last.address2 ?? shipping.address2 ?? '';
  let candidate = { ...shipping, address, address2 };
  while (used.has(shippingAddressKey(candidate))) {
    address = `${address} `;
    candidate = { ...shipping, address, address2 };
  }
  used.add(shippingAddressKey(candidate));
  return candidate;
}

export function isTargetProfile(profile) {
  return Boolean(profile && String(profile.profileType || 'target').toLowerCase() !== 'pokemoncenter');
}

export function targetProfileTemplateReady(profile) {
  if (!isTargetProfile(profile)) return false;
  const shipping = profile.shipping || {};
  const billing = profile.billing || {};
  const payment = profile.payment || {};
  const shippingReady = Boolean(
    String(shipping.firstName || '').trim()
    && String(shipping.lastName || '').trim()
    && String(shipping.address || '').trim()
    && String(shipping.city || '').trim()
    && String(shipping.state || '').trim()
    && String(shipping.zipcode || shipping.zip || '').trim()
  );
  const billingReady = profile.billingSameShipping !== false || Boolean(
    String(billing.firstName || '').trim()
    && String(billing.lastName || '').trim()
    && String(billing.address || '').trim()
    && String(billing.city || '').trim()
    && String(billing.state || '').trim()
    && String(billing.zipcode || billing.zip || '').trim()
  );
  return Boolean(
    shippingReady
    && billingReady
    && String(payment.cardNumber || '').trim()
    && String(payment.cardMonth || '').trim()
    && String(payment.cardYear || '').trim()
    && String(payment.cardCvv || '').trim()
  );
}

function mailboxForGeneratedEmail(options) {
  const requested = options && options.imap;
  const host = String((requested && requested.host) || '').trim();
  const user = String((requested && requested.user) || '').trim().toLowerCase();
  const password = String((requested && requested.password) || '');
  if (!host || !user || !password) return null;
  return {
    host,
    port: Number(requested.port) || 993,
    user,
    password,
  };
}

export function jigShippingLines(shipping, rng = Math.random) {
  const originalLine2 = String((shipping && shipping.address2) || '').trim();
  const line1 = jigLine1(shipping && shipping.address, rng, rng() < 0.5);
  // Prefix path: line 1 is already unique, so do not invent a secondary.
  // No-prefix path: line 1 was varied with suffix/spacing — add a line 2 for entropy.
  // A real unit number is never replaced, only relabeled.
  let address2 = originalLine2;
  if (originalLine2) address2 = reformatUnit(originalLine2, rng);
  else if (!line1.usedPrefix) address2 = inventUnit(rng);
  return { address: line1.address, address2 };
}

export function generatedProfilesFromTemplate(template, emails, existingProfiles = [], options = {}) {
  if (!targetProfileTemplateReady(template)) return [];
  const jigShipping = options.jigShipping === true;
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const used = reservedShippingKeys(existingProfiles);
  const known = new Set((Array.isArray(existingProfiles) ? existingProfiles : [])
    .filter(isTargetProfile)
    .map(profile => String(profile.email || '').trim().toLowerCase())
    .filter(Boolean));
  const created = [];
  for (const raw of (Array.isArray(emails) ? emails : [])) {
    const email = String(raw || '').trim().toLowerCase();
    if (!email || known.has(email)) continue;
    known.add(email);
    const { id: ignoredId, ...base } = template; // eslint-disable-line no-unused-vars
    const originalShipping = cloneAddress(template.shipping);
    const shipping = jigShipping && originalShipping
      ? uniqueJiggedShipping(originalShipping, rng, used)
      : originalShipping;
    // Billing and payment stay the template's real card identity. When shipping is jigged,
    // billingSameShipping must be false so checkout does not send the jigged street as AVS.
    const billing = jigShipping
      ? (hasStreetAddress(template.billing) ? cloneAddress(template.billing) : cloneAddress(originalShipping))
      : cloneAddress(template.billing);
    created.push({
      ...base,
      profileType: 'target',
      profileName: email.split('@')[0],
      email,
      shipping,
      billing,
      billingSameShipping: jigShipping ? false : base.billingSameShipping,
      payment: template.payment ? { ...template.payment } : template.payment,
      // Login is the generator mailbox + app password. OTP mail is matched to this
      // generated email. Catchall aliases are not IMAP usernames.
      imap: mailboxForGeneratedEmail(options),
    });
  }
  return created;
}
