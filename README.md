# Pen Plotter PWA

A mobile-first Progressive Web App that turns SVG / PNG / JPG into G-code and streams it over Web Bluetooth to an ESP32 BLE→UART bridge fronting a Grbl 1.1f pen plotter.

No build pipeline. Vanilla HTML / CSS / ES modules. Two CDN libs (Paper.js for SVG flattening, ImageTracer.js for raster vectorization).

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup, settings form, canvases, log. |
| `styles.css` | Mobile-first dark UI. |
| `app.js` | Entry point. Registers SW, boots `UI`. |
| `ble.js` | Web Bluetooth + Grbl character-counting streamer. |
| `gcode.js` | SVG / raster → polylines → laid-out → reordered → G-code. |
| `ui.js` | DOM glue, file input, previews, button wiring. |
| `service-worker.js` | Cache-first app shell for offline install. |
| `manifest.json` | PWA install metadata. |
| `icons/` | 192px and 512px PNG icons (placeholders — replace at will). |

## BLE target

Nordic UART Service. Device name advertised as `PenPlotter`.

| | UUID | Notes |
|---|---|---|
| Service | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | |
| RX (we write) | `6E400002-…` | `writeValueWithoutResponse` for streaming. |
| TX (we notify on) | `6E400003-…` | Subscribe; parse line-by-line. |

## Streaming protocol

Grbl character-counting:

- Track `inFlight = sum(line.length + 1)` for sent-but-unacked lines.
- Send the next line when `inFlight + nextLen + 1 ≤ 120` (Grbl's 128-byte serial RX, with 8 bytes of safety).
- TX notifications buffered and split on `\n`. Each `ok` / `error:` ack pops the head of the in-flight queue.
- Real-time bytes `?` `!` `~` `0x18` bypass the queue.
- While running: `?` is sent every 200ms; the response is parsed for `state` and `MPos`.

## Dev — serving over HTTPS

Web Bluetooth requires HTTPS or `localhost`.

### Localhost (laptop dev)

```sh
npx serve .            # http://localhost:3000
```

That works from a laptop browser, but a phone needs HTTPS. Two options:

### Phone-on-LAN with HTTPS via mkcert

```sh
brew install mkcert
mkcert -install
mkcert 192.168.1.42        # your laptop's LAN IP
npx http-server . -S -C 192.168.1.42.pem -K 192.168.1.42-key.pem -p 8443
# then visit https://192.168.1.42:8443 from your Android device
```

### GitHub Pages (easiest)

Push this directory to a repo, enable Pages on `main` / `/` (root). HTTPS is provided. Open the URL on Android Chrome.

## Install on Android

1. Open the site in Chrome on Android.
2. Menu → "Add to Home Screen" / "Install app".
3. Launch from the home screen — it runs standalone, fullscreen-ish.

## Use

1. **Connect** — Chrome's BLE picker opens. Select `PenPlotter`.
2. Pick an image. Source preview renders.
3. Tweak settings (paper, margin, feed, pen-up/down commands, raster threshold/smoothing).
4. **Generate G-code** — toolpath preview renders; G-code populates the textarea.
5. Manually park the plotter head at where you want `(0, 0)` on the paper. The header emits `G92 X0 Y0` to set the work zero — there is **no homing** assumed.
6. **Send** — streaming starts. Pause / Resume / Stop are real-time bytes.

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| Paper | A4 | A4 / A5 / custom W×H. |
| Margin | 10 mm | All four sides. |
| Fit mode | Fit | `Fit` scales to the drawable area; `Explicit` honors output W×H. |
| Feed rate | 1500 mm/min | `G1` feed for drawing moves. |
| Flatten tolerance | 0.1 mm | Adaptive subdivision tolerance for beziers/arcs. |
| Pen-up cmd | `M3 S100` | Servo "up" — adjust to your hardware. |
| Pen-down cmd | `M3 S600` | Servo "down". |
| Tracer threshold | 128 | Raster luminance cutoff (0–255). |
| Tracer smoothing | 1 | ImageTracer `ltres`. |
| Min path length | 1 mm | Drops noise polylines after layout. |

## Caveats

- The icons are placeholder solid squares. Replace `icons/icon-192.png` and `icons/icon-512.png` with real artwork before publishing.
- Stop sends `0x18` (Grbl soft reset) and clears the local queue. After Stop the controller re-initializes; re-zero the head before the next job.
- The status row reads `MPos` — since we set `G92 X0 Y0` rather than homing, `MPos` and `WPos` will be the same. If your config uses `WPos` instead, the parser falls back to it.
- Web Bluetooth is Chromium-only. Safari on iOS does not implement it.

## License

MIT.
