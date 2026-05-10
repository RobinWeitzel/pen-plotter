// app.js — entry point. Registers the service worker and boots the UI.

import { BleGrbl } from './ble.js';
import { UI } from './ui.js';

// Bump together with CACHE_VERSION in service-worker.js on each release.
export const APP_VERSION = 'v0.6';

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
  const ver = document.getElementById('appVersion');
  if (ver) ver.textContent = APP_VERSION;
  // Expose for console poking. Not used by app code.
  window.__app = { ble, ui, version: APP_VERSION };
});
