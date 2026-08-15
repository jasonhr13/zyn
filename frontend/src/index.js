import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

function rendererPlatform() {
  try { return window.require('electron').process.platform; } catch {}
  try { return process.platform; } catch {}
  return '';
}

const platform = rendererPlatform();
if (platform) document.body.classList.add(`platform-${platform}`);

const root = createRoot(document.getElementById('root'));
root.render(<App />);
