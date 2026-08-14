const STREET_SUFFIXES = {
  street: ['St', 'St.', 'Street'],
  st: ['St', 'St.', 'Street'],
  avenue: ['Ave', 'Ave.', 'Avenue'],
  ave: ['Ave', 'Ave.', 'Avenue'],
  boulevard: ['Blvd', 'Blvd.', 'Boulevard'],
  blvd: ['Blvd', 'Blvd.', 'Boulevard'],
  drive: ['Dr', 'Dr.', 'Drive'],
  dr: ['Dr', 'Dr.', 'Drive'],
  road: ['Rd', 'Rd.', 'Road'],
  rd: ['Rd', 'Rd.', 'Road'],
  lane: ['Ln', 'Ln.', 'Lane'],
  ln: ['Ln', 'Ln.', 'Lane'],
  court: ['Ct', 'Ct.', 'Court'],
  ct: ['Ct', 'Ct.', 'Court'],
  place: ['Pl', 'Pl.', 'Place'],
  pl: ['Pl', 'Pl.', 'Place'],
  circle: ['Cir', 'Cir.', 'Circle'],
  cir: ['Cir', 'Cir.', 'Circle'],
  terrace: ['Ter', 'Ter.', 'Terrace'],
  ter: ['Ter', 'Ter.', 'Terrace'],
  parkway: ['Pkwy', 'Parkway'],
  pkwy: ['Pkwy', 'Parkway'],
  highway: ['Hwy', 'Highway'],
  hwy: ['Hwy', 'Highway'],
  trail: ['Trl', 'Trail'],
  trl: ['Trl', 'Trail'],
  way: ['Way'],
};

const UNIT_PREFIXES = ['Apt', 'Apartment', 'Unit', 'Ste', 'Suite', '#'];

function cloneAddress(value) {
  return value && typeof value === 'object' ? { ...value } : value;
}

function hasStreetAddress(value) {
  return Boolean(value && String(value.address || '').trim());
}

function pick(rng, list) {
  return list[Math.max(0, Math.min(list.length - 1, Math.floor(rng() * list.length)))];
}

function rotateStreetSuffix(rest, rng) {
  const tokens = String(rest || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return rest;
  const last = tokens[tokens.length - 1];
  const key = last.toLowerCase().replace(/\.+$/, '');
  const variants = STREET_SUFFIXES[key];
  if (!variants) return tokens.join(' ');
  const others = variants.filter(variant => variant.toLowerCase() !== last.toLowerCase());
  tokens[tokens.length - 1] = pick(rng, others.length ? others : variants);
  return tokens.join(' ');
}

function jigLine1(address, rng) {
  const original = String(address || '').trim();
  if (!original) return original;
  const match = original.match(/^(\S+)(\s+)(.+)$/);
  if (!match) return original;
  const house = match[1];
  const street = rotateStreetSuffix(match[3], rng);
  return rng() < 0.5 ? `${house}  ${street}` : `${house}, ${street}`;
}

function jigLine2(address2, rng) {
  const original = String(address2 || '').trim();
  if (!original) {
    const prefix = pick(rng, UNIT_PREFIXES);
    const number = 1 + Math.floor(rng() * 299);
    return prefix === '#' ? `#${number}` : `${prefix} ${number}`;
  }
  const parsed = original.match(/^(apt\.?|apartment|unit|ste\.?|suite|#|no\.?|number)\s*(.+)$/i);
  const unit = parsed ? String(parsed[2] || '').trim() : original;
  const prefix = pick(rng, UNIT_PREFIXES);
  return prefix === '#' ? `#${unit}` : `${prefix} ${unit}`;
}

function addressKey(address, address2) {
  return `${address}\0${address2}`;
}

function uniqueJiggedShipping(shipping, rng, used) {
  let last = { address: shipping.address, address2: shipping.address2 };
  for (let attempt = 0; attempt < 24; attempt++) {
    const lines = jigShippingLines(shipping, rng);
    const key = addressKey(lines.address, lines.address2);
    const changed = lines.address !== String(shipping.address || '')
      || lines.address2 !== String(shipping.address2 || '');
    if (changed && !used.has(key)) {
      used.add(key);
      return { ...shipping, ...lines };
    }
    last = lines;
  }
  let address = String(last.address || shipping.address || '');
  const address2 = last.address2 ?? shipping.address2 ?? '';
  do address = `${address} `;
  while (used.has(addressKey(address, address2)));
  used.add(addressKey(address, address2));
  return { ...shipping, address, address2 };
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

export function jigShippingLines(shipping, rng = Math.random) {
  return {
    address: jigLine1(shipping && shipping.address, rng),
    address2: jigLine2(shipping && shipping.address2, rng),
  };
}

export function generatedProfilesFromTemplate(template, emails, existingProfiles = [], options = {}) {
  if (!targetProfileTemplateReady(template)) return [];
  const jigShipping = options.jigShipping === true;
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const used = new Set();
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
      imap: template.imap ? { ...template.imap } : template.imap,
    });
  }
  return created;
}
