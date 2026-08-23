import React, { Component } from 'react';

const { ipcRenderer } = window.require('electron');

const IMAP_PROVIDERS = [
  { value: 'imap.gmail.com', label: 'Gmail' },
  { value: 'outlook.office365.com', label: 'Outlook / Hotmail' },
  { value: 'imap.mail.yahoo.com', label: 'Yahoo' },
  { value: 'imap.mail.me.com', label: 'iCloud' },
];

// Matches the upstream helper used in main. Ordinary spaces in app passwords are preserved.
const sanitizeImapPassword = (value) => String(value ?? '')
  .replace(/[^\S ]/gu, ' ')
  .replace(/[\p{Cc}\p{Cf}\u034F]/gu, '');

function savedMailboxPresets(profiles, excludeProfileId) {
  const excludedId = String(excludeProfileId || '');
  const presets = [];
  const byCredential = new Map();

  (Array.isArray(profiles) ? profiles : []).forEach(profile => {
    if (!profile || (excludedId && String(profile.id || '') === excludedId)) return;
    const host = String(profile.imap?.host || '').trim();
    const user = String(profile.imap?.user || '').trim();
    const password = sanitizeImapPassword(profile.imap?.password || '');
    if (!host || !user || !password) return;

    // Comparing here lets alias profiles sharing one app password appear as a single safe choice.
    // The password itself is never used as the option value or rendered in its label.
    const credentialKey = `${host.toLowerCase()}\u0000${password}`;
    const existing = byCredential.get(credentialKey);
    if (existing) {
      existing.profileCount += 1;
      return;
    }

    const knownProvider = IMAP_PROVIDERS.find(provider => provider.value === host);
    const preset = {
      key: `saved-mailbox-${presets.length + 1}`,
      provider: knownProvider ? host : 'custom',
      customHost: knownProvider ? '' : host,
      providerLabel: knownProvider?.label || host,
      user,
      password,
      sourceName: String(profile.profileName || profile.email || user).trim(),
      profileCount: 1,
    };
    byCredential.set(credentialKey, preset);
    presets.push(preset);
  });

  return presets;
}

const BLANK = {
  profileType: 'target',
  profileName: '', email: '', phone: '',
  mailboxPresetKey: '', imapProvider: '', imapHostCustom: '', imapUser: '', imapPass: '', showImapPass: false,
  imapTesting: false, imapTestResult: null,
  firstName: '', lastName: '',
  address: '', address2: '', city: '', state: '', zipcode: '', country: 'US',
  billingSameShipping: true,
  billingFirstName: '', billingLastName: '',
  billingAddress: '', billingAddress2: '', billingCity: '', billingState: '', billingZipcode: '', billingCountry: 'US',
  cardName: '', cardNumber: '', cardMonth: '', cardYear: '', cardCvv: '',
};

class CreateProfileModal extends Component {
  constructor(props) {
    super(props);
    this.state = { ...BLANK, ...(props.initial || {}), imapPass: sanitizeImapPassword(props.initial?.imapPass || '') };
    this.imapTestSequence = 0;
  }

  componentWillUnmount() {
    this.imapTestSequence += 1;
  }

  set = (field, value) => {
    const testingField = ['imapProvider', 'imapHostCustom', 'imapUser', 'imapPass'].includes(field);
    if (testingField) this.imapTestSequence += 1;
    this.setState({
      [field]: field === 'imapPass' ? sanitizeImapPassword(value) : value,
      ...(testingField ? { mailboxPresetKey: '', imapTesting: false, imapTestResult: null } : {}),
    });
  };

  applyMailboxPreset = (key, presets) => {
    const preset = presets.find(candidate => candidate.key === key);
    this.imapTestSequence += 1;
    if (!preset) {
      this.setState({ mailboxPresetKey: '' });
      return;
    }
    this.setState({
      mailboxPresetKey: preset.key,
      imapProvider: preset.provider,
      imapHostCustom: preset.customHost,
      imapUser: preset.user,
      imapPass: preset.password,
      showImapPass: false,
      imapTesting: false,
      imapTestResult: null,
    });
  };

  resolvedImapHost = () => (this.state.imapProvider === 'custom'
    ? this.state.imapHostCustom.trim()
    : this.state.imapProvider);

  testImap = async () => {
    const host = this.resolvedImapHost();
    const user = this.state.imapUser.trim();
    const password = this.state.imapPass;
    if (!host || !user || !password) {
      this.setState({
        imapTestResult: { ok: false, message: 'Complete the IMAP server, mailbox user, and app password first.' },
      });
      return;
    }

    const sequence = ++this.imapTestSequence;
    this.setState({ imapTesting: true, imapTestResult: null });
    try {
      const result = await ipcRenderer.invoke('testProfileImap', { host, port: 993, user, password });
      if (sequence === this.imapTestSequence) {
        this.setState({
          imapTesting: false,
          imapTestResult: result?.message
            ? result
            : { ok: false, message: 'Could not verify this mailbox. Try again.' },
        });
      }
    } catch {
      if (sequence === this.imapTestSequence) {
        this.setState({
          imapTesting: false,
          imapTestResult: { ok: false, message: 'Could not run the mailbox test. Try again.' },
        });
      }
    }
  };

  handleSubmit = () => {
    const {
      profileType, profileName, email, phone, firstName, lastName, address, city, state, zipcode,
      billingSameShipping, billingFirstName, billingLastName, billingAddress, billingCity, billingState, billingZipcode,
      cardNumber, cardMonth, cardYear, cardCvv,
    } = this.state;
    const pokemonCenter = profileType === 'pokemoncenter';
    const usesMailbox = !pokemonCenter;
    if (!profileName || !email || !firstName || !lastName || !address || !city || !state || !zipcode
      || !cardNumber || !cardMonth || !cardYear || !cardCvv) {
      window.alert('Complete every required profile, shipping, and payment field.');
      return;
    }
    if (pokemonCenter && !phone.trim()) {
      window.alert('Pokémon Center profiles require a phone number.');
      return;
    }
    if (pokemonCenter && !billingSameShipping
      && (!billingFirstName || !billingLastName || !billingAddress || !billingCity || !billingState || !billingZipcode)) {
      window.alert('Complete every required billing-address field.');
      return;
    }

    const imapHost = this.resolvedImapHost();
    if (usesMailbox && this.state.imapProvider && (!imapHost || !this.state.imapUser.trim() || !this.state.imapPass)) {
      window.alert('Complete the IMAP host, mailbox user, and app password, or select “No automatic mailbox”.');
      return;
    }

    const shipping = {
      firstName: this.state.firstName,
      lastName: this.state.lastName,
      address: this.state.address,
      address2: this.state.address2,
      city: this.state.city,
      state: this.state.state,
      zipcode: this.state.zipcode,
      country: this.state.country,
    };
    const billing = billingSameShipping ? { ...shipping } : {
      firstName: this.state.billingFirstName,
      lastName: this.state.billingLastName,
      address: this.state.billingAddress,
      address2: this.state.billingAddress2,
      city: this.state.billingCity,
      state: this.state.billingState,
      zipcode: this.state.billingZipcode,
      country: this.state.billingCountry,
    };

    const profile = {
      profileType,
      profileName: this.state.profileName,
      email: this.state.email,
      phone: this.state.phone,
      imap: usesMailbox && this.state.imapProvider ? {
        host: imapHost,
        port: 993,
        user: this.state.imapUser.trim(),
        password: this.state.imapPass,
      } : null,
      shipping,
      billingSameShipping,
      billing,
      payment: {
        cardName: this.state.cardName || `${this.state.firstName} ${this.state.lastName}`,
        cardNumber: this.state.cardNumber.replace(/\s/g, ''),
        cardMonth: this.state.cardMonth,
        cardYear: this.state.cardYear,
        cardCvv: this.state.cardCvv,
      },
    };

    this.props.onSave(profile);
  };

  input = (field, placeholder, opts = {}) => (
    <input
      className="form-input"
      placeholder={placeholder}
      value={this.state[field]}
      onChange={e => this.set(field, e.target.value)}
      {...opts}
    />
  );

  render() {
    const { onClose } = this.props;
    const title = this.props.title || (this.props.initial ? 'Edit Profile' : 'New Profile');
    const mailboxPresets = savedMailboxPresets(this.props.mailboxProfiles, this.props.excludeProfileId);

    return (
      <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-lg">
          <div className="modal-header">
            <span className="modal-title">{title}</span>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>

          <div className="modal-body">
            {/* General */}
            <div className="form-section-title">General</div>
            <div className="form-group">
              <label className="form-label">Profile Type *</label>
              <select className="form-select" value={this.state.profileType} onChange={e => this.set('profileType', e.target.value)}>
                <option value="target">Target</option>
                <option value="pokemoncenter">Pokémon Center</option>
                <option value="walmart">Walmart</option>
              </select>
              <span className="form-hint">
                {this.state.profileType === 'pokemoncenter'
                  ? 'Guest checkout profile with shipping and billing addresses. No mailbox configuration is needed.'
                  : this.state.profileType === 'walmart'
                    ? 'Walmart checkout profile with shipping, payment, and optional email OTP mailbox configuration.'
                    : 'Target account profile with optional email OTP mailbox configuration.'}
              </span>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Profile Name *</label>
                {this.input('profileName', 'e.g. John - Chase Sapphire')}
              </div>
              <div className="form-group">
                <label className="form-label">Email *</label>
                {this.input('email', 'john@example.com', { type: 'email' })}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Phone{this.state.profileType === 'pokemoncenter' ? ' *' : ''}</label>
              {this.input('phone', '5551234567')}
            </div>

            {this.state.profileType !== 'pokemoncenter' && <>
              <hr className="form-divider" />

            {/* Profile-owned IMAP configuration. */}
            <div className="form-section-title">Email OTP Mailbox</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', margin: '-4px 0 12px' }}>
              Optional. Target and Walmart use this profile’s mailbox when the matching account requests a login code.
            </div>
            {!!mailboxPresets.length && (
              <div className="form-group">
                <label className="form-label">Reuse Saved Mailbox Credentials</label>
                <select
                  className="form-select"
                  value={this.state.mailboxPresetKey}
                  onChange={event => this.applyMailboxPreset(event.target.value, mailboxPresets)}
                >
                  <option value="">Enter mailbox credentials manually</option>
                  {mailboxPresets.map(preset => (
                    <option key={preset.key} value={preset.key}>
                      {preset.sourceName} — {preset.user} · {preset.providerLabel}
                      {preset.profileCount > 1 ? ` · shared by ${preset.profileCount} profiles` : ''}
                    </option>
                  ))}
                </select>
                <span className="form-hint">
                  Copies the provider, mailbox user, and saved app password. The password stays hidden; change the mailbox user afterward for another alias.
                </span>
              </div>
            )}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Mailbox Provider</label>
                <select className="form-select" value={this.state.imapProvider} onChange={e => this.set('imapProvider', e.target.value)}>
                  <option value="">No automatic mailbox</option>
                  {IMAP_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  <option value="custom">Custom…</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 0.35 }}>
                <label className="form-label">Port</label>
                <input className="form-input monospace" value="993" disabled readOnly />
              </div>
            </div>
            {this.state.imapProvider === 'custom' && (
              <div className="form-group">
                <label className="form-label">Custom IMAP Host</label>
                {this.input('imapHostCustom', 'imap.example.com', { className: 'form-input monospace' })}
              </div>
            )}
            {!!this.state.imapProvider && (
              <>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Mailbox User</label>
                    {this.input('imapUser', 'mailbox@example.com', { type: 'email', className: 'form-input monospace' })}
                  </div>
                  <div className="form-group">
                    <label className="form-label">Mailbox App Password</label>
                    <div style={{ position: 'relative' }}>
                      {this.input('imapPass', 'App-specific password', {
                        type: this.state.showImapPass ? 'text' : 'password',
                        className: 'form-input monospace',
                        style: { paddingRight: 34 },
                      })}
                      <button
                        type="button"
                        title={this.state.showImapPass ? 'Hide password' : 'Show password'}
                        onClick={() => this.setState(s => ({ showImapPass: !s.showImapPass }))}
                        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 2 }}
                      >
                        {this.state.showImapPass ? '🙈' : '👁️'}
                      </button>
                    </div>
                    <small style={{ color: 'var(--muted)' }}>Spaces are preserved; invisible paste formatting is removed automatically.</small>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 30, margin: '-2px 0 4px' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={this.testImap}
                    disabled={this.state.imapTesting}
                  >
                    {this.state.imapTesting ? 'Testing…' : 'Test IMAP Connection'}
                  </button>
                  <span
                    aria-live="polite"
                    className={this.state.imapTestResult?.ok ? 'text-success' : 'text-danger'}
                    style={{ fontSize: 11 }}
                  >
                    {this.state.imapTestResult?.message || ''}
                  </span>
                </div>
              </>
            )}
            </>}

            <hr className="form-divider" />

            {/* Shipping */}
            <div className="form-section-title">Shipping Address</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">First Name *</label>
                {this.input('firstName', 'John')}
              </div>
              <div className="form-group">
                <label className="form-label">Last Name *</label>
                {this.input('lastName', 'Doe')}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Address *</label>
              {this.input('address', '123 Main St')}
            </div>
            <div className="form-group">
              <label className="form-label">Address 2</label>
              {this.input('address2', 'Apt 4B (optional)')}
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">City *</label>
                {this.input('city', 'New York')}
              </div>
              <div className="form-group">
                <label className="form-label">State *</label>
                {this.input('state', 'NY')}
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Zip Code *</label>
                {this.input('zipcode', '10001')}
              </div>
              <div className="form-group">
                <label className="form-label">Country</label>
                <select className="form-select" value={this.state.country} onChange={e => this.set('country', e.target.value)}>
                  <option value="US">United States</option>
                  <option value="GB">United Kingdom</option>
                  <option value="CA">Canada</option>
                  <option value="AU">Australia</option>
                  <option value="DE">Germany</option>
                  <option value="FR">France</option>
                </select>
              </div>
            </div>

            {this.state.profileType === 'pokemoncenter' && <>
              <hr className="form-divider" />
              <div className="form-section-title">Billing Address</div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 12, fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={this.state.billingSameShipping}
                  onChange={e => this.set('billingSameShipping', e.target.checked)}
                />
                Billing address is the same as shipping
              </label>
              {!this.state.billingSameShipping && <>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">First Name *</label>
                    {this.input('billingFirstName', 'John')}
                  </div>
                  <div className="form-group">
                    <label className="form-label">Last Name *</label>
                    {this.input('billingLastName', 'Doe')}
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Address *</label>
                  {this.input('billingAddress', '123 Main St')}
                </div>
                <div className="form-group">
                  <label className="form-label">Address 2</label>
                  {this.input('billingAddress2', 'Apt 4B (optional)')}
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">City *</label>
                    {this.input('billingCity', 'New York')}
                  </div>
                  <div className="form-group">
                    <label className="form-label">State *</label>
                    {this.input('billingState', 'NY')}
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Zip Code *</label>
                    {this.input('billingZipcode', '10001')}
                  </div>
                  <div className="form-group">
                    <label className="form-label">Country</label>
                    <select className="form-select" value={this.state.billingCountry} onChange={e => this.set('billingCountry', e.target.value)}>
                      <option value="US">United States</option>
                      <option value="GB">United Kingdom</option>
                      <option value="CA">Canada</option>
                      <option value="AU">Australia</option>
                      <option value="DE">Germany</option>
                      <option value="FR">France</option>
                    </select>
                  </div>
                </div>
              </>}
            </>}

            <hr className="form-divider" />

            {/* Payment */}
            <div className="form-section-title">Payment</div>
            <div className="form-group">
              <label className="form-label">Name on Card</label>
              {this.input('cardName', 'John Doe (defaults to shipping name)')}
            </div>
            <div className="form-group">
              <label className="form-label">Card Number *</label>
              {this.input('cardNumber', '4111 1111 1111 1111', { className: 'form-input monospace' })}
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Exp Month *</label>
                {this.input('cardMonth', '12')}
              </div>
              <div className="form-group">
                <label className="form-label">Exp Year *</label>
                {this.input('cardYear', '2027')}
              </div>
              <div className="form-group">
                <label className="form-label">CVV *</label>
                {this.input('cardCvv', '123', { type: 'password' })}
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={this.handleSubmit}>Save Profile</button>
          </div>
        </div>
      </div>
    );
  }
}

export default CreateProfileModal;
