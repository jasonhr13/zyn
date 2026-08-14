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
assert.deepEqual(generated[0].imap, template.imap, 'catch-all mailbox details were changed');
assert.notEqual(generated[0].shipping, template.shipping, 'shipping object was not cloned');

const jigged = generatedProfilesFromTemplate(template, [
  'alpha@catchall.example', 'beta@catchall.example',
], [], { jigShipping: true, rng: seededRng(7) });
assert.equal(jigged.length, 2);
for (const profile of jigged) {
  assert.match(profile.shipping.address, /\b123\b/, 'house number was not preserved');
  assert.match(String(profile.shipping.address2), /4/, 'existing unit number was not preserved');
  assert.equal(profile.shipping.firstName, template.shipping.firstName);
  assert.equal(profile.shipping.lastName, template.shipping.lastName);
  assert.equal(profile.shipping.city, template.shipping.city);
  assert.equal(profile.shipping.state, template.shipping.state);
  assert.equal(profile.shipping.zipcode, template.shipping.zipcode);
  assert.deepEqual(profile.billing, template.billing, 'jigging changed the card billing address');
  assert.equal(profile.billingSameShipping, false, 'jigged shipping was left aliased as billing');
  assert.deepEqual(profile.payment, template.payment, 'payment details were changed');
  assert.deepEqual(profile.imap, template.imap, 'catch-all mailbox details were changed');
}
assert.notEqual(
  `${jigged[0].shipping.address}\0${jigged[0].shipping.address2}`,
  `${template.shipping.address}\0${template.shipping.address2}`,
  'jigging left shipping identical to the template',
);
assert.notEqual(
  `${jigged[0].shipping.address}\0${jigged[0].shipping.address2}`,
  `${jigged[1].shipping.address}\0${jigged[1].shipping.address2}`,
  'two jigged profiles reused the same shipping lines',
);

const emptyLine2 = generatedProfilesFromTemplate({
  ...template,
  shipping: { ...template.shipping, address2: '' },
}, ['gamma@catchall.example'], [], { jigShipping: true, rng: seededRng(11) });
assert.equal(emptyLine2.length, 1);
assert.match(String(emptyLine2[0].shipping.address2), /^(Apt|Apartment|Unit|Ste|Suite|#)\s*\S+/);
assert.deepEqual(emptyLine2[0].billing, template.billing);

const lines = jigShippingLines(template.shipping, seededRng(3));
assert.match(lines.address, /\b123\b/);
assert.match(String(lines.address2), /4/);
assert.notDeepEqual(lines, { address: template.shipping.address, address2: template.shipping.address2 });

console.log(JSON.stringify({
  ok: true,
  matchingEmail: true,
  skipsExistingProfiles: true,
  realAddressPreserved: true,
  jiggedShippingUnique: true,
  billingUnchangedWhenJigged: true,
}, null, 2));
