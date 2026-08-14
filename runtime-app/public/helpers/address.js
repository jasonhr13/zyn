// Address normalisation shared by the checkout engines.
//
// Retailers validate the state code strictly — two characters, upper case. A profile typed as "sc"
// or "ca " survives every step of a run and then dies at the very last one with
//   400 {"code":"INVALID_STATE_FORMAT","message":"Invalid state code format. State code must be 2 characters"}
// so the cost is the checkout, not just the request. Normalising on the way out fixes every profile
// already saved instead of asking anyone to re-type them.
//
// Lives here rather than in one engine because Target and Walmart build their profile payloads
// independently and both had the same raw pass-through.

const STATE_CODES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'puerto rico': 'PR', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

// Full names are mapped as well as case-fixed: they fail the same validator for the same reason, and
// "South Carolina" is a reasonable thing to have typed into a box labelled State.
function normalizeState(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const full = STATE_CODES[s.toLowerCase().replace(/\s+/g, ' ')];
  // Anything else goes through untouched rather than guessed at. A wrong code ships the order to the
  // wrong address, which is a great deal worse than a rejected payment.
  return full || s;
}

module.exports = { normalizeState };
