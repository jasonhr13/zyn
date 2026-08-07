import React from 'react';
import CreateProfileModal from './create-modal';

// Edit modal reuses Create modal, pre-populating from the flat profile
function EditProfileModal({ profile, onSave, onClose }) {
  const initial = {
    profileName: profile.profileName || '',
    email: profile.email || '',
    phone: profile.phone || '',
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
