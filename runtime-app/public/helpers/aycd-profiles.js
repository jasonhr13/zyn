// AYCD billing-profile format ⇄ this app's profile shape.
//
// AYCD publishes this format so any bot can import/export without a bespoke converter per program —
// their Profile Builder supports 200+ bots and speaks this in the middle. Supporting it means a user
// can bring profiles in from anywhere, and take them out again.
//
// THE TWO FORMATS DISAGREE ON THREE THINGS, and each is a place to get it wrong quietly:
//
//   1. NAMES. AYCD stores one "name" per address ("John Doe"); we store firstName/lastName. Splitting
//      on the LAST space keeps multi-word first names intact ("Mary Jane Watson" → "Mary Jane" +
//      "Watson"), which is the right way round: a compound surname is rarer than a middle name, and
//      the surname is what shipping matches on.
//
//   2. STATE AND COUNTRY. AYCD requires LONG FORM ("Texas", "United States") precisely so there is no
//      ambiguity; we store the two-letter codes the checkout engines send. Both directions are mapped
//      below. An unmapped value passes through untouched rather than being dropped -- a profile with
//      an odd state should still import, and be visibly wrong, instead of silently losing its state.
//
//   3. GROUPS. AYCD has ONE "profileGroup" string; we have a `groups` array, because a profile here
//      can be in both "Coupon" and "Invites". Import puts the single group into the array; export
//      writes the FIRST group and, when a profile has several, that is lossy -- flagged to the caller
//      rather than hidden.

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico', GU: 'Guam',
  AS: 'American Samoa', VI: 'U.S. Virgin Islands', MP: 'Northern Mariana Islands',
};
const STATE_TO_CODE = Object.fromEntries(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]));

const COUNTRIES = { US: 'United States', CA: 'Canada', GB: 'United Kingdom', JP: 'Japan',
  AU: 'Australia', MX: 'Mexico', SG: 'Singapore', HK: 'Hong Kong', CN: 'China' };
const COUNTRY_TO_CODE = Object.fromEntries(
  Object.entries(COUNTRIES).map(([code, name]) => [name.toLowerCase(), code]));

// Split on the LAST space — see note 2 above.
function splitName(full) {
  const s = String(full || '').trim().replace(/\s+/g, ' ');
  if (!s) return { firstName: '', lastName: '' };
  const i = s.lastIndexOf(' ');
  if (i < 0) return { firstName: s, lastName: '' };
  return { firstName: s.slice(0, i), lastName: s.slice(i + 1) };
}

const toStateCode = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.length === 2) return s.toUpperCase();
  return STATE_TO_CODE[s.toLowerCase()] || s;
};
const toStateLong = (v) => {
  const s = String(v || '').trim();
  return US_STATES[s.toUpperCase()] || s;
};
const toCountryCode = (v) => {
  const s = String(v || '').trim();
  if (!s) return 'US';
  if (s.length === 2) return s.toUpperCase();
  return COUNTRY_TO_CODE[s.toLowerCase()] || s;
};
const toCountryLong = (v) => {
  const s = String(v || '').trim();
  return COUNTRIES[s.toUpperCase()] || s || 'United States';
};

// Card brand from the number, because AYCD requires cardType and we do not store one.
// Prefix rules only — enough to label Visa/Mastercard/Amex/Discover correctly, which is all the
// format asks for. An unrecognised prefix yields '' rather than a guess.
function cardTypeOf(number) {
  const n = String(number || '').replace(/\D/g, '');
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'American Express';
  if (/^(6011|65|64[4-9])/.test(n)) return 'Discover';
  return '';
}

// ── AYCD → ours ──────────────────────────────────────────────────────────────
function fromAycd(a, makeId) {
  const ship = a.shippingAddress || a.billingAddress || {};
  const bill = a.billingAddress || ship;
  const pay = a.paymentDetails || {};
  const sn = splitName(ship.name || bill.name || pay.nameOnCard);

  // Year is normalised to 4 digits: AYCD mandates 4, but files in the wild carry "27". A 2-digit
  // year silently rejected at checkout is exactly the kind of failure nobody traces back to import.
  const yr = String(pay.cardExpYear || '').trim();
  const cardYear = yr.length === 2 ? `20${yr}` : yr;

  return {
    id: makeId(),
    profileName: String(a.name || '').trim() || 'Imported',
    // Contact details live on the profile root here, on the address in AYCD.
    email: String(bill.email || ship.email || '').trim(),
    phone: String(bill.phone || ship.phone || '').replace(/\D/g, ''),
    shipping: {
      firstName: sn.firstName,
      lastName: sn.lastName,
      address: String(ship.line1 || '').trim(),
      // line3 is rare and we have nowhere for it; appended to line2 as AYCD's own docs advise for
      // sites without a third line, rather than dropped.
      address2: [ship.line2, ship.line3].map((x) => String(x || '').trim()).filter(Boolean).join(', '),
      city: String(ship.city || '').trim(),
      state: toStateCode(ship.state),
      zipcode: String(ship.postCode || '').trim(),
      country: toCountryCode(ship.country),
    },
    payment: {
      cardName: String(pay.nameOnCard || '').trim(),
      cardNumber: String(pay.cardNumber || '').replace(/\s|-/g, ''),
      cardMonth: String(pay.cardExpMonth || '').padStart(2, '0'),
      cardYear,
      cardCvv: String(pay.cardCvv || '').trim(),
    },
    group: '',
    groups: a.profileGroup ? [String(a.profileGroup)] : [],
  };
}

// ── ours → AYCD ──────────────────────────────────────────────────────────────
function toAycd(p) {
  const s = p.shipping || {};
  const pay = p.payment || {};
  const full = [s.firstName, s.lastName].filter(Boolean).join(' ').trim();
  const addr = {
    name: full,
    email: String(p.email || '').trim(),
    phone: String(p.phone || '').replace(/\D/g, ''),
    line1: String(s.address || '').trim(),
    line2: String(s.address2 || '').trim(),
    line3: '',
    postCode: String(s.zipcode || '').trim(),
    city: String(s.city || '').trim(),
    country: toCountryLong(s.country),
    state: toStateLong(s.state),
  };
  return {
    name: String(p.profileName || '').trim(),
    size: '',
    profileGroup: (p.groups && p.groups[0]) || p.group || '',
    billingAddress: addr,
    shippingAddress: addr,
    paymentDetails: {
      nameOnCard: String(pay.cardName || '').trim() || full,
      cardType: cardTypeOf(pay.cardNumber),
      cardNumber: String(pay.cardNumber || '').replace(/\s|-/g, ''),
      cardExpMonth: String(pay.cardMonth || '').padStart(2, '0'),
      cardExpYear: String(pay.cardYear || '').trim(),
      cardCvv: String(pay.cardCvv || '').trim(),
    },
    // We keep one address, so billing and shipping are the same by construction.
    sameBillingAndShippingAddress: true,
    onlyCheckoutOnce: false,
    matchNameOnCardAndAddress: (pay.cardName || '').trim().toLowerCase() === full.toLowerCase(),
  };
}

// Accepts a bare array, or the {profiles:[…]} wrapper some exports use.
function parseAycdFile(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data
    : (Array.isArray(data.profiles) ? data.profiles : null);
  if (!arr) throw new Error('Not an AYCD profile file — expected an array of profiles.');
  // One well-formed profile is enough to accept the file; a bare array of anything else is not.
  const looksRight = arr.some((x) => x && (x.billingAddress || x.shippingAddress || x.paymentDetails));
  if (arr.length && !looksRight) {
    throw new Error('That JSON is an array, but none of it looks like an AYCD profile.');
  }
  return arr;
}

module.exports = {
  fromAycd, toAycd, parseAycdFile,
  splitName, toStateCode, toStateLong, toCountryCode, toCountryLong, cardTypeOf,
  US_STATES, COUNTRIES,
};
