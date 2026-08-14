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

export function generatedProfilesFromTemplate(template, emails, existingProfiles = []) {
  if (!targetProfileTemplateReady(template)) return [];
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
    created.push({
      ...base,
      profileType: 'target',
      profileName: email.split('@')[0],
      email,
      // Shipping, billing, payment, phone, and mailbox stay byte-for-byte equivalent to the
      // operator's real template. This workflow never invents address variants.
      shipping: template.shipping ? { ...template.shipping } : template.shipping,
      billing: template.billing ? { ...template.billing } : template.billing,
      payment: template.payment ? { ...template.payment } : template.payment,
      imap: template.imap ? { ...template.imap } : template.imap,
    });
  }
  return created;
}
