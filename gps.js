// ============================================================================
// gps.js — location capture: auto GPS device first, manual fallback second
// ============================================================================
// Matches the record schema's `location` shape:
//   { type: "gps"|"coordinates"|"address"|"none", lat, lon, address, timestamp }
// ============================================================================

import { createInterface } from 'readline/promises';
import { SerialPort } from 'serialport';

const GPS_DEVICE_PATH = process.env.GPS_DEVICE_PATH || '/dev/ttyUSB0'; // adjust per machine
const GPS_TIMEOUT_MS = 4000;

function nmeaToDecimal(raw, dir) {
  if (!raw) return null;
  const deg = parseFloat(raw.slice(0, raw.indexOf('.') - 2));
  const min = parseFloat(raw.slice(raw.indexOf('.') - 2));
  let dec = deg + min / 60;
  if (dir === 'S' || dir === 'W') dec *= -1;
  return dec;
}

// --- Try reading one fix from a connected USB/serial GPS receiver ---
async function tryAutoGPS() {
  return new Promise((resolve) => {
    let port;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.close(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), GPS_TIMEOUT_MS);

    try {
      port = new SerialPort({ path: GPS_DEVICE_PATH, baudRate: 9600 });

      port.on('data', (data) => {
        const line = data.toString();
        if (line.startsWith('$GPGGA')) {
          const parts = line.split(',');
          if (parts[6] !== '0') {
            // fixQuality 0 = no fix yet
            finish({
              lat: nmeaToDecimal(parts[2], parts[3]),
              lon: nmeaToDecimal(parts[4], parts[5]),
            });
          }
        }
      });

      port.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

// --- Ask the user directly if auto-GPS isn't available ---
async function askUserForLocation() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    'No GPS device found. Enter coordinates as "lat,lon", an address, or press Enter to skip: '
  );
  rl.close();

  const trimmed = answer.trim();
  if (!trimmed) {
    return { type: 'none', lat: null, lon: null, address: null };
  }
  if (/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(trimmed)) {
    const [lat, lon] = trimmed.split(',').map((s) => parseFloat(s.trim()));
    return { type: 'coordinates', lat, lon, address: null };
  }
  return { type: 'address', lat: null, lon: null, address: trimmed };
}

/**
 * Get the current location: try a connected GPS device first, fall back to
 * asking the user. Returns an object matching the record schema's shape.
 */
export async function getLocation() {
  const gpsFix = await tryAutoGPS();
  const timestamp = new Date().toISOString();

  if (gpsFix) {
    console.log(`GPS fix acquired: ${gpsFix.lat}, ${gpsFix.lon}`);
    return { type: 'gps', lat: gpsFix.lat, lon: gpsFix.lon, address: null, timestamp };
  }

  const manual = await askUserForLocation();
  return { ...manual, timestamp };
}
