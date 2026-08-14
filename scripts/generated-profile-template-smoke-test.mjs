#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  generatedProfilesFromTemplate,
  isTargetProfile,
  jigShippingLines,
  targetProfileTemplateReady,
} from '../frontend/src/components/generated-profile-template.mjs';

function seededRng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

const template = {
  id: 'template-1',
  profileType: 'target',
  profileName: 'Real checkout template',
  email: 'owner@example.com',
  phone: '5551234567',
  groups: ['Primary'],
  imap: { host: 'imap.gmail.com', port: 993, user: 'catchall@example.com', password: 'app secret' },
  shipping: {
    firstName: 'Real', lastName: 'Buyer', address: '123 Main St', address2: 'Apt 4',
    city: 'Los Angeles', state: 'CA', zipcode: '90001', country: 'US',
  },
  billingSameShipping: true,
  billing: {
    firstName: 'Real', lastName: 'Buyer', address: '123 Main St', address2: 'Apt 4',
    city: 'Los Angeles', state: 'CA', zipcode: '90001', country: 'US',
  },
  payment: { cardName: 'Real Buyer', cardNumber: '4111111111111111', cardMonth: '12', cardYear: '2099', cardCvv: '123' },
};

assert.equal(isTargetProfile(template), true);
assert.equal(isTargetProfile({ ...template, profileType: 'pokemoncenter' }), false);
assert.equal(targetProfileTemplateReady(template), true);
assert.equal(targetProfileTemplateReady({ ...template, payment: { ...template.payment, cardCvv: '' } }), false);
assert.equal(targetProfileTemplateReady({ ...template, billingSameShipping: false, billing: {} }), false);

const generated = generatedProfilesFromTemplate(template, [
  'First@Catchall.Example', 'second@catchall.example', 'FIRST@catchall.example',
], [{ id: 'existing', profileType: 'target', email: 'second@catchall.example' }]);
assert.equal(generated.length, 1);
assert.equal(generated[0].id, undefined);
assert.equal(generated[0].email, 'first@catchall.example');
assert.equal(generated[0].profileName, 'first');
assert.deepEqual(generated[0].shipping, template.shipping, 'the real shipping address was changed');
assert.deepEqual(generated[0].billing, template.billing, 'the real billing address was changed');
assert.deepEqual(generated[0].payment, template.payment, 'payment details were changed');
assert.equal(generated[0].imap, null, 'template mailbox was copied onto the generated profile');
assert.notEqual(generated[0].shipping, template.shipping, 'shipping object was not cloned');

const withMailbox = generatedProfilesFromTemplate(template, ['otp@catchall.example'], [], {
  imap: { host: 'imap.mail.me.com', port: 993, password: 'modal secret', user: 'Inbox@Catchall.Example' },
});
assert.equal(withMailbox.length, 1);
assert.equal(withMailbox[0].email, 'otp@catchall.example');
assert.deepEqual(withMailbox[0].imap, {
  host: 'imap.mail.me.com',
  port: 993,
  user: 'inbox@catchall.example',
  password: 'modal secret',
});
assert.notEqual(withMailbox[0].imap.user, withMailbox[0].email, 'IMAP login was the generated catchall');
assert.notEqual(withMailbox[0].imap.user, template.imap.user, 'OTP mailbox still used the template email');
assert.notEqual(withMailbox[0].imap.password, template.imap.password, 'OTP mailbox still used the template password');

const missingMailboxUser = generatedProfilesFromTemplate(template, ['orphan@catchall.example'], [], {
  imap: { host: 'imap.mail.me.com', port: 993, password: 'modal secret' },
});
assert.equal(missingMailboxUser[0].imap, null, 'IMAP was saved without a mailbox login');

function hasLetterPrefix(address) {
  return /^[a-z]{3} /.test(String(address || ''));
}

const jigged = generatedProfilesFromTemplate(template, [
  'alpha@catchall.example', 'beta@catchall.example',
], [], { jigShipping: true, rng: seededRng(7) });
assert.equal(jigged.length, 2);
for (const profile of jigged) {
  assert.match(profile.shipping.address, /\b123\b/, 'house number was not preserved');
  assert.notEqual(profile.shipping.address, template.shipping.address, 'line 1 was left unchanged');
  assert.match(String(profile.shipping.address2), /4/, 'existing unit number was not preserved');
  assert.equal(profile.shipping.firstName, template.shipping.firstName);
  assert.equal(profile.shipping.lastName, template.shipping.lastName);
  assert.equal(profile.shipping.city, template.shipping.city);
  assert.equal(profile.shipping.state, template.shipping.state);
  assert.equal(profile.shipping.zipcode, template.shipping.zipcode);
  assert.deepEqual(profile.billing, template.billing, 'jigging changed the card billing address');
  assert.equal(profile.billingSameShipping, false, 'jigged shipping was left aliased as billing');
  assert.deepEqual(profile.payment, template.payment, 'payment details were changed');
  assert.equal(profile.imap, null, 'template mailbox was copied onto a jigged profile');
}
assert.notEqual(
  `${jigged[0].shipping.address}\0${jigged[0].shipping.address2}`,
  `${template.shipping.address}\0${template.shipping.address2}`,
  'jigging left shipping identical to the template',
);
assert.notEqual(
  jigged[0].shipping.address,
  jigged[1].shipping.address,
  'two jigged profiles reused the same line 1',
);
assert.notEqual(
  `${jigged[0].shipping.address}\0${jigged[0].shipping.address2}`,
  `${jigged[1].shipping.address}\0${jigged[1].shipping.address2}`,
  'two jigged profiles reused the same shipping lines',
);

const emptyTemplate = { ...template, shipping: { ...template.shipping, address2: '' } };
const mixed = generatedProfilesFromTemplate(
  emptyTemplate,
  Array.from({ length: 16 }, (_, index) => `mix${index}@catchall.example`),
  [],
  { jigShipping: true, rng: seededRng(11) },
);
assert.equal(mixed.length, 16);
const prefixed = mixed.filter(profile => hasLetterPrefix(profile.shipping.address));
const unprefixed = mixed.filter(profile => !hasLetterPrefix(profile.shipping.address));
assert.ok(prefixed.length > 0, 'batch never chose the 3-letter line 1 prefix');
assert.ok(unprefixed.length > 0, 'batch never chose a no-prefix line 1 jig');
for (const profile of mixed) {
  assert.match(profile.shipping.address, /\b123\b/, 'house number was not preserved');
  assert.notEqual(profile.shipping.address, emptyTemplate.shipping.address, 'line 1 was left unchanged');
  assert.deepEqual(profile.billing, template.billing);
  if (hasLetterPrefix(profile.shipping.address)) {
    assert.equal(String(profile.shipping.address2 || '').trim(), '', 'prefix path invented a line 2');
  } else {
    assert.match(String(profile.shipping.address2), /^(Apt|Apartment|Unit|Ste|Suite|#)\s*\S+/,
      'no-prefix path did not add a line 2');
  }
}

const laneTemplate = {
  ...template,
  shipping: { ...template.shipping, address: '100 Oak Lane', address2: '' },
};
const laneBatch = generatedProfilesFromTemplate(
  laneTemplate,
  Array.from({ length: 24 }, (_, index) => `lane${index}@catchall.example`),
  [],
  { jigShipping: true, rng: seededRng(19) },
);
assert.equal(laneBatch.length, 24);
const laneSuffixes = new Set(laneBatch.map(profile => String(profile.shipping.address)
  .replace(/^[a-z]{3} /, '')
  .replace(/,/g, ' ')
  .trim()
  .split(/\s+/)
  .pop()));
assert.ok(laneSuffixes.size >= 5, `Lane only produced ${[...laneSuffixes].join(', ')}`);
assert.ok(
  [...laneSuffixes].some(suffix => /^(LLane|Lanee|Lan)$/i.test(suffix)),
  `Lane extra-letter forms never appeared: ${[...laneSuffixes].join(', ')}`,
);
for (const profile of laneBatch) {
  assert.match(profile.shipping.address, /\b100\b/);
  assert.match(profile.shipping.address, /Oak/i);
}

const lines = jigShippingLines(template.shipping, seededRng(3));
assert.match(lines.address, /\b123\b/);
assert.notEqual(lines.address, template.shipping.address);
assert.match(String(lines.address2), /4/);
assert.notDeepEqual(lines, { address: template.shipping.address, address2: template.shipping.address2 });

const firstJig = generatedProfilesFromTemplate(template, ['reuse@catchall.example'], [], {
  jigShipping: true, rng: seededRng(7),
});
const avoided = generatedProfilesFromTemplate(template, ['fresh@catchall.example'], [{
  id: 'already',
  profileType: 'target',
  email: 'already@catchall.example',
  shipping: firstJig[0].shipping,
}], { jigShipping: true, rng: seededRng(7) });
assert.equal(avoided.length, 1);
assert.notEqual(
  `${avoided[0].shipping.address}\0${avoided[0].shipping.address2}`,
  `${firstJig[0].shipping.address}\0${firstJig[0].shipping.address2}`,
  'jigging reused a shipping address already saved on a Target profile',
);

const pokemonCenterCollision = generatedProfilesFromTemplate(template, ['pc@catchall.example'], [{
  id: 'pc',
  profileType: 'pokemoncenter',
  email: 'pc@example.com',
  shipping: firstJig[0].shipping,
}], { jigShipping: true, rng: seededRng(7) });
assert.equal(
  `${pokemonCenterCollision[0].shipping.address}\0${pokemonCenterCollision[0].shipping.address2}`,
  `${firstJig[0].shipping.address}\0${firstJig[0].shipping.address2}`,
  'a Pokémon Center shipping address reserved a Target jig slot',
);

console.log(JSON.stringify({
  ok: true,
  matchingEmail: true,
  skipsExistingProfiles: true,
  realAddressPreserved: true,
  jiggedShippingUnique: true,
  billingUnchangedWhenJigged: true,
  avoidsExistingTargetShipping: true,
}, null, 2));
