// app.js — entry point. Registers the service worker and boots the UI.

import { BleGrbl } from './ble.js';
import { UI } from './ui.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  });
}

// Wait for deferred CDN scripts (paper, ImageTracer) to be ready.
window.addEventListener('DOMContentLoaded', () => {
  const ble = new BleGrbl();
  const ui = new UI(ble);
  // Expose for console poking. Not used by app code.
  window.__app = { ble, ui };
});
