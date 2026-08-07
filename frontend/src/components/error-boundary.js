import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, color: '#f87171', fontFamily: 'monospace', fontSize: 12 }}>
          <div style={{ fontSize: 14, marginBottom: 12, color: '#f3f4f6' }}>Something went wrong</div>
          <pre style={{ color: '#f87171', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {this.state.error?.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
