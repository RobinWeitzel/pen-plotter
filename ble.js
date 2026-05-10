// ble.js — Web Bluetooth + Grbl 1.1 streaming.
//
// Responsibilities:
//  - Connect to a Nordic UART Service (NUS) device named "PenPlotter".
//  - Subscribe to TX notifications, buffer bytes, split on '\n'.
//  - Stream G-code lines using Grbl's character-counting protocol so we never
//    overflow Grbl's 128-byte serial RX buffer.
//  - Send real-time single-byte commands (`?`, `!`, `~`, 0x18) out-of-band.
//
// Public surface: a single class, BleGrbl.

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // we WRITE to this
const NUS_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // we get NOTIFY here

const GRBL_RX_BUFFER = 128;
const GRBL_RX_SAFETY = 8;        // leave headroom; 120 bytes effective.
const GRBL_BUDGET    = GRBL_RX_BUFFER - GRBL_RX_SAFETY;
const MAX_BLE_WRITE  = 180;       // single writeValueWithoutResponse chunk cap.

const STATUS_POLL_MS = 200;

export class BleGrbl extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.rxChar = null;          // we write here
    this.txChar = null;          // we receive notifications here

    // Streaming state
    this.queue = [];             // pending lines (no trailing newline; we add it)
    this.inFlight = [];          // [{len}] of lines sent but not yet ack'd
    this.inFlightBytes = 0;
    this.totalLines = 0;
    this.sentLines = 0;
    this.acked = 0;
    this.running = false;
    this.paused = false;
    this.statusTimer = null;

    // Notification reassembly
    this.rxBuf = '';
  }

  get connected() { return !!this.server && this.server.connected; }

  log(msg) {
    this.dispatchEvent(new CustomEvent('log', { detail: msg }));
  }

  async connect() {
    if (!('bluetooth' in navigator)) {
      throw new Error('Web Bluetooth not available. Use Android Chrome over HTTPS.');
    }
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'PenPlotter' }],
      optionalServices: [NUS_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.log('GATT disconnected');
      this._teardown();
      this.dispatchEvent(new Event('disconnected'));
    });
    this.server = await this.device.gatt.connect();
    const svc = await this.server.getPrimaryService(NUS_SERVICE);
    this.rxChar = await svc.getCharacteristic(NUS_RX_CHAR);
    this.txChar = await svc.getCharacteristic(NUS_TX_CHAR);
    await this.txChar.startNotifications();
    this.txChar.addEventListener('characteristicvaluechanged', (e) => this._onNotify(e));
    this.log(`Connected to ${this.device.name}`);
    this.dispatchEvent(new Event('connected'));
  }

  async disconnect() {
    this.stop();                    // soft-reset + clear queue
    try { if (this.server?.connected) this.device.gatt.disconnect(); } catch (_) {}
    this._teardown();
  }

  _teardown() {
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    this.rxChar = this.txChar = null;
    this.server = null;
    this.queue.length = 0;
    this.inFlight.length = 0;
    this.inFlightBytes = 0;
    this.running = false;
    this.paused = false;
  }

  // ---- raw writes ----------------------------------------------------------

  async _writeRaw(bytes) {
    // Chunk to MAX_BLE_WRITE just in case. Lines are ~30 bytes typically.
    for (let i = 0; i < bytes.length; i += MAX_BLE_WRITE) {
      const chunk = bytes.subarray(i, i + MAX_BLE_WRITE);
      // writeValueWithoutResponse is the throughput-friendly path.
      if (this.rxChar.writeValueWithoutResponse) {
        await this.rxChar.writeValueWithoutResponse(chunk);
      } else {
        await this.rxChar.writeValue(chunk);
      }
    }
  }

  async sendRealtime(byte) {
    if (!this.rxChar) return;
    await this._writeRaw(new Uint8Array([byte]));
  }

  // Send a single line (e.g. $H, $X, G0 X0 Y0). Enqueues into the same
  // character-counting flow so it interleaves safely with a running job.
  async sendCommand(line) {
    if (!this.connected) throw new Error('Not connected');
    const clean = String(line).replace(/\r?\n/g, '').trim();
    if (!clean) return;
    this.queue.push(clean);
    this.totalLines++;
    this.dispatchEvent(new CustomEvent('progress', {
      detail: { sent: this.sentLines, acked: this.acked, total: this.totalLines },
    }));
    if (!this.running) {
      this.running = true;
      if (!this.statusTimer) {
        this.statusTimer = setInterval(() => {
          this.sendRealtime(0x3f /* '?' */).catch(() => {});
        }, STATUS_POLL_MS);
      }
    }
    this._pump();
  }

  // ---- notifications -------------------------------------------------------

  _onNotify(e) {
    const v = e.target.value;
    const text = new TextDecoder().decode(v);
    this.rxBuf += text;
    let idx;
    while ((idx = this.rxBuf.indexOf('\n')) >= 0) {
      const line = this.rxBuf.slice(0, idx).replace(/\r$/, '');
      this.rxBuf = this.rxBuf.slice(idx + 1);
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    if (!line.length) return;
    this.dispatchEvent(new CustomEvent('rx', { detail: line }));

    // Status reports look like  <Idle|MPos:0.000,0.000,0.000|...>
    if (line.startsWith('<') && line.endsWith('>')) {
      const status = parseStatus(line);
      if (status) this.dispatchEvent(new CustomEvent('status', { detail: status }));
      return;
    }

    // ok / error -> ack head of queue (character-counting protocol).
    if (line === 'ok' || line.startsWith('error:')) {
      const head = this.inFlight.shift();
      if (head) {
        this.inFlightBytes -= head.len;
        this.acked++;
        this.dispatchEvent(new CustomEvent('ack', {
          detail: { line, sent: this.sentLines, acked: this.acked, total: this.totalLines },
        }));
      }
      this._pump();
      // If queue drained and all acks received, job done.
      if (this.running && this.queue.length === 0 && this.inFlight.length === 0) {
        this.running = false;
        if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
        this.dispatchEvent(new Event('done'));
      }
    }
  }

  // ---- streaming -----------------------------------------------------------

  loadProgram(lines) {
    // Strip empties, drop full-line comments, trim.
    this.queue = lines
      .map(l => l.replace(/\r/g, '').trim())
      .filter(l => l.length && !l.startsWith(';') && !l.startsWith('('));
    this.totalLines = this.queue.length;
    this.sentLines = 0;
    this.acked = 0;
    this.inFlight.length = 0;
    this.inFlightBytes = 0;
    this.dispatchEvent(new CustomEvent('progress', {
      detail: { sent: 0, acked: 0, total: this.totalLines },
    }));
  }

  start() {
    if (!this.connected) throw new Error('Not connected');
    if (this.totalLines === 0) throw new Error('No program loaded');
    this.running = true;
    this.paused = false;
    if (!this.statusTimer) {
      this.statusTimer = setInterval(() => {
        this.sendRealtime(0x3f /* '?' */).catch(() => {});
      }, STATUS_POLL_MS);
    }
    this._pump();
  }

  pause() { this.paused = true; this.sendRealtime(0x21 /* '!' */); }
  resume() { this.paused = false; this.sendRealtime(0x7e /* '~' */); this._pump(); }

  stop() {
    // Soft reset 0x18, clear local queue. Grbl will re-init; user must re-home/zero.
    this.queue.length = 0;
    this.inFlight.length = 0;
    this.inFlightBytes = 0;
    this.running = false;
    this.paused = false;
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    return this.sendRealtime(0x18);
  }

  async _pump() {
    if (!this.running || this.paused) return;
    while (this.queue.length) {
      const next = this.queue[0];
      const lineWithNl = next + '\n';
      const len = lineWithNl.length;
      if (this.inFlightBytes + len > GRBL_BUDGET) return;
      this.queue.shift();
      this.inFlight.push({ len });
      this.inFlightBytes += len;
      this.sentLines++;
      this.dispatchEvent(new CustomEvent('sent', {
        detail: { line: next, sent: this.sentLines, total: this.totalLines },
      }));
      try {
        await this._writeRaw(new TextEncoder().encode(lineWithNl));
      } catch (err) {
        this.log('Write failed: ' + err.message);
        this.running = false;
        this.dispatchEvent(new CustomEvent('error', { detail: err.message }));
        return;
      }
    }
  }
}

function parseStatus(line) {
  // <Idle|MPos:0.000,0.000,0.000|FS:0,0|...>
  const inner = line.slice(1, -1);
  const parts = inner.split('|');
  if (!parts.length) return null;
  const state = parts[0];
  const out = { state, mpos: null };
  for (const p of parts.slice(1)) {
    if (p.startsWith('MPos:')) {
      const [x, y, z] = p.slice(5).split(',').map(Number);
      out.mpos = { x, y, z };
    } else if (p.startsWith('WPos:') && !out.mpos) {
      const [x, y, z] = p.slice(5).split(',').map(Number);
      out.mpos = { x, y, z };
    }
  }
  return out;
}
