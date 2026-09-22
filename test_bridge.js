/**
 * HydroSync Node ↔ Python AI bridge check.
 * Calls GET /api/ai/diagnostics and reports ONLINE FFT vs FALLBACK.
 *
 * Usage: npm test
 * Requires: Node SCADA on :3000 (and Python engine on :8000 for ONLINE).
 */

const http = require('http');

const DIAGNOSTICS_URL =
  process.env.HYDROSYNC_DIAGNOSTICS_URL ||
  'http://localhost:3000/api/ai/diagnostics';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        if (!raw || !String(raw).trim()) {
          reject(new Error('Empty response body (not valid JSON).'));
          return;
        }
        try {
          resolve({
            statusCode: res.statusCode,
            data: JSON.parse(raw)
          });
        } catch (err) {
          reject(
            new Error(
              'Response is not valid JSON: ' +
                String(raw).slice(0, 180).replace(/\s+/g, ' ')
            )
          );
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(
        new Error(
          'Timed out reaching ' +
            url +
            '. Is `node server.js` running on port 3000?'
        )
      );
    });

    req.on('error', (err) => {
      reject(
        new Error(
          'Cannot reach ' +
            url +
            ' (' +
            err.message +
            '). Start the SCADA server with `npm start`.'
        )
      );
    });
  });
}

function fftFromDiagnostics(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.diagnostics && data.diagnostics.fft) return data.diagnostics.fft;
  if (data.fft) return data.fft;
  if (data.vibration && data.vibration.fft) return data.vibration.fft;
  return null;
}

async function main() {
  console.log('🔗 HydroSync bridge test → ' + DIAGNOSTICS_URL);

  const { statusCode, data } = await fetchJson(DIAGNOSTICS_URL);

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('JSON parsed, but the payload is not an object.');
  }

  console.log('   HTTP ' + statusCode);
  console.log('   status: ' + data.status);
  console.log('   engine: ' + (data.engine || '(none)'));

  if (data.status === 'FALLBACK') {
    console.log('⚠️  FALLBACK — Python AI Engine is offline or unreachable.');
    if (data.msg) console.log('   ' + data.msg);
    console.log(
      '   Start it with: python ai_engine/main.py  (FastAPI must listen on :8000)'
    );
    console.log(
      '✅ Bridge test passed (Node responded; fallback handled gracefully).'
    );
    return;
  }

  if (data.status !== 'ONLINE') {
    throw new Error(
      'Unexpected diagnostics status "' +
        data.status +
        '". Expected ONLINE or FALLBACK.'
    );
  }

  const fft = fftFromDiagnostics(data);
  const magnitudes = fft && fft.magnitudes;

  if (!Array.isArray(magnitudes) || magnitudes.length === 0) {
    throw new Error(
      'ONLINE but diagnostics.fft.magnitudes is missing or empty. ' +
        'Python /diagnostics is up, but no FFT spectrum has been produced yet. ' +
        'Confirm POST /vibration is reaching ai_engine (leave the SCADA running ~2s, then re-run npm test).'
    );
  }

  const freq = fft.frequencies_hz;
  console.log(
    '✅ ONLINE — Python FFT spectrum received (' +
      magnitudes.length +
      ' bins' +
      (Array.isArray(freq) ? ', ' + freq.length + ' frequencies' : '') +
      ').'
  );
}

main().catch((err) => {
  console.error('❌ Bridge test failed: ' + err.message);
  process.exit(1);
});
