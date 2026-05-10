// ui.js — DOM glue: file input, settings, previews, button wiring.
//
// Pulls together ble.js (streaming) and gcode.js (image -> g-code).
// Keeps DOM lookups in one place so app.js stays slim.

import {
  svgToPolylines,
  rasterToPolylines,
  layoutPolylines,
  reorderPolylines,
  emitGcode,
  filterShortPolylines,
  applyOrigin,
} from './gcode.js';

const $ = (id) => document.getElementById(id);

const PAPER_PRESETS = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
};

export class UI {
  constructor(ble) {
    this.ble = ble;
    this.sourceImage = null;          // HTMLImageElement OR { svg: '...' }
    this.polylines = [];              // current laid-out polylines (mm)
    this.gcodeLines = [];

    this._wireSettings();
    this._wireFile();
    this._wireButtons();
    this._wireBleEvents();
  }

  // --------------------------------------------------------------------------

  _wireSettings() {
    $('paperSize').addEventListener('change', () => {
      const v = $('paperSize').value;
      if (v in PAPER_PRESETS) {
        $('paperW').value = PAPER_PRESETS[v].w;
        $('paperH').value = PAPER_PRESETS[v].h;
      }
    });
  }

  _settings() {
    return {
      paperW: +$('paperW').value,
      paperH: +$('paperH').value,
      margin: +$('margin').value,
      fit: $('fitMode').value,
      outW: +$('outW').value,
      outH: +$('outH').value,
      feed: +$('feed').value,
      tolerance: +$('tolerance').value,
      penUp: $('penUp').value.trim(),
      penDown: $('penDown').value.trim(),
      origin: $('origin').value,
      threshold: +$('trThresh').value,
      smoothing: +$('trSmooth').value,
      minPathLength: +$('minPath').value,
    };
  }

  // --------------------------------------------------------------------------

  _wireFile() {
    $('fileInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this.log(`Loaded ${file.name} (${file.type || 'unknown'})`);
      if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) {
        const text = await file.text();
        this.sourceImage = { svg: text };
        await this._drawSourceFromSvg(text);
      } else {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          this.sourceImage = img;
          this._drawSourceFromImage(img);
          URL.revokeObjectURL(url);
        };
        img.src = url;
      }
      $('btnGenerate').disabled = false;
    });
  }

  _drawSourceFromImage(img) {
    const c = $('srcCanvas');
    const ctx = c.getContext('2d');
    fitDraw(ctx, c.width, c.height, img.width, img.height, (sx, sy, sw, sh) => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, sx, sy, sw, sh);
    });
  }

  async _drawSourceFromSvg(svgText) {
    const c = $('srcCanvas');
    const ctx = c.getContext('2d');
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      fitDraw(ctx, c.width, c.height, img.width || 300, img.height || 300, (sx, sy, sw, sh) => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, sx, sy, sw, sh);
      });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  // --------------------------------------------------------------------------

  _wireButtons() {
    $('btnConnect').onclick = async () => {
      try {
        await this.ble.connect();
      } catch (err) {
        this.log('Connect failed: ' + err.message);
      }
    };
    $('btnDisconnect').onclick = () => this.ble.disconnect();

    $('btnGenerate').onclick = () => this._generate();
    $('btnSend').onclick = () => this._send();
    $('btnPause').onclick = () => this.ble.pause();
    $('btnResume').onclick = () => this.ble.resume();
    $('btnStop').onclick = () => this.ble.stop();

    const send = (cmd) => this._sendCommand(cmd);
    $('btnHome').onclick = () => send('$H');
    $('btnUnlock').onclick = () => send('$X');
    $('btnZero').onclick = () => send('G10 P0 L20 X0 Y0 Z0');
    $('btnGoZero').onclick = () => send('G90 G0 X0 Y0');
    $('btnState').onclick = () => {
      this.log('> ?');
      this.ble.sendRealtime(0x3f).catch((err) => this.log('Send failed: ' + err.message));
    };
    $('btnCustomSend').onclick = () => {
      const v = $('customCmd').value;
      if (!v.trim()) return;
      send(v);
      $('customCmd').value = '';
    };
    $('customCmd').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btnCustomSend').click();
    });

    // Jog: directional pad uses Grbl jog command ($J=) with current feed rate.
    this.jogStep = 1;
    document.querySelectorAll('.seg button[data-step]').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.seg button[data-step]').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        this.jogStep = parseFloat(b.dataset.step);
      });
    });
    const jog = (dx, dy) => {
      const s = this.jogStep;
      const feed = +$('feed').value || 1500;
      const parts = [];
      if (dx) parts.push(`X${(dx * s).toFixed(3)}`);
      if (dy) parts.push(`Y${(dy * s).toFixed(3)}`);
      this._sendCommand(`$J=G91 G21 ${parts.join(' ')} F${feed}`);
    };
    $('jogXp').onclick = () => jog(+1, 0);
    $('jogXm').onclick = () => jog(-1, 0);
    $('jogYp').onclick = () => jog(0, -1);
    $('jogYm').onclick = () => jog(0, +1);

    $('penUpBtn').onclick = () => this._sendCommand($('penUp').value.trim());
    $('penDownBtn').onclick = () => this._sendCommand($('penDown').value.trim());
  }

  _sendCommand(cmd) {
    this.log('> ' + cmd);
    this.ble.sendCommand(cmd).catch((err) => this.log('Send failed: ' + err.message));
  }

  _wireBleEvents() {
    this.ble.addEventListener('connected', () => {
      $('connState').textContent = 'Connected';
      $('connState').className = 'pill on';
      $('btnConnect').disabled = true;
      $('btnDisconnect').disabled = false;
      if (this.gcodeLines.length) $('btnSend').disabled = false;
      for (const id of ['btnHome','btnUnlock','btnZero','btnGoZero','btnState','btnCustomSend','jogXp','jogXm','jogYp','jogYm','penUpBtn','penDownBtn']) {
        $(id).disabled = false;
      }
    });
    this.ble.addEventListener('disconnected', () => {
      $('connState').textContent = 'Disconnected';
      $('connState').className = 'pill off';
      $('btnConnect').disabled = false;
      $('btnDisconnect').disabled = true;
      $('btnSend').disabled = true;
      $('btnPause').disabled = true;
      $('btnResume').disabled = true;
      $('btnStop').disabled = true;
      for (const id of ['btnHome','btnUnlock','btnZero','btnGoZero','btnState','btnCustomSend','jogXp','jogXm','jogYp','jogYm','penUpBtn','penDownBtn']) {
        $(id).disabled = true;
      }
    });
    this.ble.addEventListener('status', (e) => {
      const s = e.detail;
      $('grblState').textContent = s.state;
      if (s.mpos) {
        $('mpos').textContent = `${s.mpos.x.toFixed(2)}, ${s.mpos.y.toFixed(2)}`;
      }
    });
    this.ble.addEventListener('sent', (e) => {
      $('lineCounter').textContent = `${e.detail.sent} / ${e.detail.total}`;
      $('currentLine').textContent = e.detail.line;
    });
    this.ble.addEventListener('ack', (e) => {
      $('lineCounter').textContent = `${e.detail.acked} / ${e.detail.total} acked`;
    });
    this.ble.addEventListener('done', () => {
      this.log('Job complete.');
      $('btnPause').disabled = true;
      $('btnResume').disabled = true;
      $('btnStop').disabled = true;
    });
    this.ble.addEventListener('rx', (e) => this.log('< ' + e.detail));
    this.ble.addEventListener('log', (e) => this.log(e.detail));
    this.ble.addEventListener('error', (e) => this.log('ERR: ' + e.detail));
  }

  // --------------------------------------------------------------------------

  _generate() {
    if (!this.sourceImage) return;
    const opts = this._settings();
    let polys = [], bounds = null;
    try {
      if (this.sourceImage.svg) {
        ({ polylines: polys, bounds } = svgToPolylines(this.sourceImage.svg, opts.tolerance));
      } else {
        const imgData = imageToImageData(this.sourceImage);
        ({ polylines: polys, bounds } = rasterToPolylines(imgData, {
          threshold: opts.threshold,
          smoothing: opts.smoothing,
          minPathLength: opts.minPathLength,
          tolerance: opts.tolerance,
        }));
      }
    } catch (err) {
      this.log('Generate failed: ' + err.message);
      return;
    }

    let laid = layoutPolylines(polys, bounds, opts);
    laid = filterShortPolylines(laid, opts.minPathLength);
    laid = reorderPolylines(laid);
    this.polylines = laid;

    const machinePolys = applyOrigin(laid, opts.origin, opts.paperW, opts.paperH);
    const gcode = emitGcode(machinePolys, opts);
    this.gcodeLines = gcode.split('\n').filter(l => l.length);

    $('gcodeOut').value = gcode;
    this._drawPathPreview(laid, opts);
    this.log(`Generated ${this.gcodeLines.length} lines from ${laid.length} polylines.`);
    if (this.ble.connected) $('btnSend').disabled = false;
  }

  _drawPathPreview(polys, opts) {
    const c = $('pathCanvas');
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (!polys.length) return;
    const pad = 6;
    const sx = (c.width - pad * 2) / opts.paperW;
    const sy = (c.height - pad * 2) / opts.paperH;
    const s = Math.min(sx, sy);
    const ox = pad, oy = pad;
    const toCanvas = ([x, y]) => [ox + x * s, oy + (opts.paperH - y) * s];

    // Paper rect
    ctx.strokeStyle = '#ddd';
    ctx.strokeRect(ox, oy, opts.paperW * s, opts.paperH * s);

    // Travel moves (between polylines) in light red, drawing strokes in black.
    let cursor = null;
    for (const poly of polys) {
      if (cursor) {
        ctx.strokeStyle = 'rgba(255,80,80,0.4)';
        ctx.beginPath();
        const a = toCanvas(cursor), b = toCanvas(poly[0]);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const [x0, y0] = toCanvas(poly[0]);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < poly.length; i++) {
        const [x, y] = toCanvas(poly[i]);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      cursor = poly[poly.length - 1];
    }
  }

  // --------------------------------------------------------------------------

  _send() {
    if (!this.gcodeLines.length) return;
    if (!this.ble.connected) { this.log('Not connected'); return; }
    this.ble.loadProgram(this.gcodeLines);
    this.ble.start();
    $('btnPause').disabled = false;
    $('btnResume').disabled = false;
    $('btnStop').disabled = false;
  }

  log(msg) {
    const el = $('log');
    const t = new Date().toLocaleTimeString();
    el.textContent += `[${t}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }
}

// ----------------------------------------------------------------------------

function fitDraw(ctx, cw, ch, iw, ih, draw) {
  const s = Math.min(cw / iw, ch / ih);
  const w = iw * s, h = ih * s;
  const x = (cw - w) / 2, y = (ch - h) / 2;
  ctx.clearRect(0, 0, cw, ch);
  draw(x, y, w, h);
}

function imageToImageData(img) {
  const c = document.createElement('canvas');
  // Cap raster size to keep tracing snappy on phones.
  const MAX = 800;
  const s = Math.min(1, MAX / Math.max(img.width, img.height));
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}
