import React, { Component } from 'react';

const BLANK = {
  profileName: '', email: '', phone: '',
  firstName: '', lastName: '',
  address: '', address2: '', city: '', state: '', zipcode: '', country: 'US',
  cardName: '', cardNumber: '', cardMonth: '', cardYear: '', cardCvv: '',
};

class CreateProfileModal extends Component {
  constructor(props) {
    super(props);
    this.state = { ...BLANK, ...(props.initial || {}) };
  }

  set = (field, value) => this.setState({ [field]: value });

  handleSubmit = () => {
    const { profileName, email, firstName, lastName, address, city, state, zipcode, cardNumber, cardMonth, cardYear, cardCvv } = this.state;
    if (!profileName || !email || !firstName || !lastName || !address || !city || !state || !zipcode || !cardNumber || !cardMonth || !cardYear || !cardCvv) return;

    const profile = {
      profileName: this.state.profileName,
      email: this.state.email,
      phone: this.state.phone,
      shipping: {
        firstName: this.state.firstName,
        lastName: this.state.lastName,
        address: this.state.address,
        address2: this.state.address2,
        city: this.state.city,
        state: this.state.state,
        zipcode: this.state.zipcode,
        country: this.state.country,
      },
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
              <label className="form-label">Phone</label>
              {this.input('phone', '5551234567')}
            </div>

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
