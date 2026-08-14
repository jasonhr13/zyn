#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  generatedProfilesFromTemplate,
  isTargetProfile,
  targetProfileTemplateReady,
} from '../frontend/src/components/generated-profile-template.mjs';

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

console.log(JSON.stringify({
  ok: true,
  matchingEmail: true,
  skipsExistingProfiles: true,
  realAddressPreserved: true,
}, null, 2));
