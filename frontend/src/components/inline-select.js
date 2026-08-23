import React, { Component, createRef } from 'react';

export default class InlineSelect extends Component {
  state = { open: false, top: 0, left: 0, width: 0 };
  button = createRef();

  componentDidMount() {
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
  }

  componentWillUnmount() {
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
  }

  onDocumentMouseDown = event => {
    if (!this.state.open) return;
    if (this.menu && this.menu.contains(event.target)) return;
    if (this.button.current && this.button.current.contains(event.target)) return;
    this.setState({ open: false });
  };

  onDocumentKeyDown = event => {
    if (this.state.open && event.key === 'Escape') this.setState({ open: false });
  };

  toggle = event => {
    event.stopPropagation();
    if (this.props.disabled) return;
    if (this.state.open) {
      this.setState({ open: false });
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    this.setState({
      open: true,
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 160),
    });
  };

  choose = (event, value) => {
    event.stopPropagation();
    this.setState({ open: false });
    if (value !== this.props.value) this.props.onChange(value);
  };

  render() {
    const { value, options, placeholder, disabled, ariaLabel, className } = this.props;
    const selected = (options || []).find(option => String(option.value) === String(value));
    const label = selected ? selected.label : (placeholder || 'Select');
    return (
      <div className={`inline-select${this.state.open ? ' open' : ''}${disabled ? ' disabled' : ''}`}>
        <button
          ref={this.button}
          type="button"
          className={className || 'inline-select-button'}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={this.state.open}
          aria-label={ariaLabel || label}
          onClick={this.toggle}
          onKeyDown={event => event.stopPropagation()}
        >
          <span>{label}</span>
        </button>
        {this.state.open && (
          <div
            ref={node => { this.menu = node; }}
            className="inline-select-menu"
            role="listbox"
            style={{ top: this.state.top, left: this.state.left, width: this.state.width }}
          >
            {(options || []).map(option => (
              <button
                type="button"
                role="option"
                aria-selected={String(option.value) === String(value)}
                className={`inline-select-option${String(option.value) === String(value) ? ' selected' : ''}`}
                key={String(option.value)}
                onClick={event => this.choose(event, option.value)}
              >
                {option.group ? <small>{option.group}</small> : null}
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
}
