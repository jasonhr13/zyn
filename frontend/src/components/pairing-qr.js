import React, { Component } from 'react';
import QRCode from 'qrcode';

export default class PairingQr extends Component {
  constructor(props) {
    super(props);
    this.state = { src: '' };
    this.generation = 0;
  }

  componentDidMount() {
    this.renderQr();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.url !== this.props.url) this.renderQr();
  }

  renderQr() {
    const url = String(this.props.url || '');
    const generation = ++this.generation;
    if (!url) {
      this.setState({ src: '' });
      return;
    }
    QRCode.toDataURL(url, {
      width: 192,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' },
    }).then((src) => {
      if (generation === this.generation) this.setState({ src: src });
    }).catch(() => {
      if (generation === this.generation) this.setState({ src: '' });
    });
  }

  render() {
    if (!this.state.src) return null;
    return (
      <img
        alt="Pairing QR code"
        src={this.state.src}
        width={192}
        height={192}
        style={{
          display: 'block',
          width: 192,
          height: 192,
          marginTop: 8,
          padding: 8,
          background: '#fff',
          borderRadius: 8,
        }}
      />
    );
  }
}
