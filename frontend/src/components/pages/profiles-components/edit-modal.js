import React from 'react';
import CreateProfileModal from './create-modal';

// Edit modal reuses Create modal, pre-populating from the flat profile
function EditProfileModal({ profile, mailboxProfiles, onSave, onClose }) {
  const knownImapHosts = new Set(['imap.gmail.com', 'outlook.office365.com', 'imap.mail.yahoo.com', 'imap.mail.me.com']);
  const imapHost = profile.imap?.host || '';
  const shipping = profile.shipping || {};
  const billing = profile.billing || shipping;
  const addressFields = ['firstName', 'lastName', 'address', 'address2', 'city', 'state', 'zipcode', 'country'];
  const billingSameShipping = typeof profile.billingSameShipping === 'boolean'
    ? profile.billingSameShipping
    : addressFields.every(field => String(billing[field] || '') === String(shipping[field] || ''));
  const initial = {
    profileType: profile.profileType || 'target',
    profileName: profile.profileName || '',
    email: profile.email || '',
    phone: profile.phone || '',
    imapProvider: imapHost ? (knownImapHosts.has(imapHost) ? imapHost : 'custom') : '',
    imapHostCustom: imapHost && !knownImapHosts.has(imapHost) ? imapHost : '',
    imapUser: profile.imap?.user || '',
    imapPass: profile.imap?.password || '',
    firstName: profile.shipping?.firstName || profile.firstName || '',
    lastName: profile.shipping?.lastName || profile.lastName || '',
    address: profile.shipping?.address || profile.address || '',
    address2: profile.shipping?.address2 || profile.address2 || '',
    city: profile.shipping?.city || profile.city || '',
    state: profile.shipping?.state || profile.state || '',
    zipcode: profile.shipping?.zipcode || profile.zipcode || '',
    country: profile.shipping?.country || profile.country || 'US',
    billingSameShipping,
    billingFirstName: billing.firstName || '',
    billingLastName: billing.lastName || '',
    billingAddress: billing.address || '',
    billingAddress2: billing.address2 || '',
    billingCity: billing.city || '',
    billingState: billing.state || '',
    billingZipcode: billing.zipcode || billing.zip || '',
    billingCountry: billing.country || 'US',
    cardName: profile.payment?.cardName || profile.cardName || '',
    cardNumber: profile.payment?.cardNumber || profile.cardNumber || '',
    cardMonth: profile.payment?.cardMonth || profile.cardMonth || '',
    cardYear: profile.payment?.cardYear || profile.cardYear || '',
    cardCvv: profile.payment?.cardCvv || profile.cardCvv || '',
  };

  return (
    <CreateProfileModal
      initial={initial}
      mailboxProfiles={mailboxProfiles}
      excludeProfileId={profile.id}
      onSave={(data) => onSave(profile.id, data)}
      onClose={onClose}
    />
  );
}

export default EditProfileModal;
