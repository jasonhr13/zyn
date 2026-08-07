import React from 'react';
import CreateProfileModal from './create-modal';

// Edit modal reuses Create modal, pre-populating from the flat profile
function EditProfileModal({ profile, onSave, onClose }) {
  const knownImapHosts = new Set(['imap.gmail.com', 'outlook.office365.com', 'imap.mail.yahoo.com', 'imap.mail.me.com']);
  const imapHost = profile.imap?.host || '';
  const initial = {
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
    cardName: profile.payment?.cardName || profile.cardName || '',
    cardNumber: profile.payment?.cardNumber || profile.cardNumber || '',
    cardMonth: profile.payment?.cardMonth || profile.cardMonth || '',
    cardYear: profile.payment?.cardYear || profile.cardYear || '',
    cardCvv: profile.payment?.cardCvv || profile.cardCvv || '',
  };

  return (
    <CreateProfileModal
      initial={initial}
      onSave={(data) => onSave(profile.id, data)}
      onClose={onClose}
    />
  );
}

export default EditProfileModal;
