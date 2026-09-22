/**
 * HydroSync Node <-> Python AI bridge check.
 *
 * Validates the SCADA gateway in whichever state it is in:
 *   - ONLINE   : Python engine reachable, full FFT contract is asserted.
 *   - FALLBACK : Python engine down, Node must degrade gracefully so the
 *                dashboard can switch to its local FFT ("LOCAL FFT FALLBACK").
 *
 * Usage: npm test
 * Requires: Node SCADA on :3000. Start the Python engine on :8000 to exercise
 * the ONLINE path; stop it and re-run to exercise the FALLBACK path.
 */

const http = require('http');

const BASE_URL = process.env.HYDROSYNC_BASE_URL || 'http://localhost:3000';
const DIAGNOSTICS_URL = BASE_URL + '/api/ai/diagnostics';
const VIBRATION_URL = BASE_URL + '/api/ai/vibration';

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('   PASS  ' + label);
  } else {
    failures.push(label + (detail ? ' -> ' + detail : ''));
    console.log('   FAIL  ' + label + (detail ? ' -> ' + detail : ''));
  }
}

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
          reject(new Error('Empty response body from ' + url));
          return;
        }
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
        } catch (err) {
          reject(
            new Error(
              'Response from ' +
                url +
                ' is not valid JSON: ' +
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
          'Timed out reaching ' + url + '. Is the SCADA server running (npm start)?'
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

function isFiniteNumberArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/**
 * The frontend reads d.fft.magnitudes (plural). A previous regression shipped
 * d.fft.magnitude (singular), which silently froze the spectrum chart, so the
 * singular spelling is asserted against explicitly rather than tolerated.
 */
function assertFftContract(source, fft) {
  check(source + ': fft object present', !!fft && typeof fft === 'object');
  if (!fft || typeof fft !== 'object') return;

  check(
    source + ': fft.magnitudes is a non-empty numeric array',
    isFiniteNumberArray(fft.magnitudes),
    'got ' + JSON.stringify(fft.magnitudes && fft.magnitudes.slice && fft.magnitudes.slice(0, 3))
  );

  check(
    source + ': fft.frequencies_hz is a non-empty numeric array',
    isFiniteNumberArray(fft.frequencies_hz),
    'got ' + JSON.stringify(fft.frequencies_hz && fft.frequencies_hz.slice && fft.frequencies_hz.slice(0, 3))
  );

  if (Array.isArray(fft.magnitudes) && Array.isArray(fft.frequencies_hz)) {
    check(
      source + ': magnitudes and frequencies_hz have equal length',
      fft.magnitudes.length === fft.frequencies_hz.length,
      fft.magnitudes.length + ' vs ' + fft.frequencies_hz.length
    );
  }

  check(
    source + ': no singular fft.magnitude (regression guard)',
    fft.magnitude === undefined,
    'singular "magnitude" key is present - the chart hook expects "magnitudes"'
  );
}

async function main() {
  console.log('HydroSync Node <-> Python bridge test');
  console.log('base: ' + BASE_URL);
  console.log('');

  const diag = await fetchJson(DIAGNOSTICS_URL);
  console.log('GET /api/ai/diagnostics  HTTP ' + diag.statusCode);

  const data = diag.data;
  check(
    'diagnostics: payload is an object',
    data && typeof data === 'object' && !Array.isArray(data)
  );
  check(
    'diagnostics: status is ONLINE or FALLBACK',
    data.status === 'ONLINE' || data.status === 'FALLBACK',
    'got ' + JSON.stringify(data.status)
  );

  const online = data.status === 'ONLINE';
  console.log('   mode: ' + data.status + '  engine: ' + (data.engine || '(none)'));
  console.log('');

  const vib = await fetchJson(VIBRATION_URL);
  console.log('GET /api/ai/vibration    HTTP ' + vib.statusCode);
  check(
    'vibration: status matches diagnostics mode',
    vib.data.status === data.status,
    vib.data.status + ' vs ' + data.status
  );

  if (online) {
    assertFftContract('diagnostics', data.fft);
    assertFftContract('vibration', vib.data.fft);

    const waveform = vib.data.waveform;
    check(
      'vibration: waveform is a non-empty numeric array',
      isFiniteNumberArray(waveform),
      'got ' + (Array.isArray(waveform) ? waveform.length + ' samples' : typeof waveform)
    );

    if (isFiniteNumberArray(waveform) && Array.isArray(vib.data.fft && vib.data.fft.magnitudes)) {
      const expectedBins = Math.floor(waveform.length / 2) + 1;
      check(
        'vibration: bin count matches rFFT of waveform length',
        vib.data.fft.magnitudes.length === expectedBins,
        vib.data.fft.magnitudes.length + ' bins for ' + waveform.length + ' samples (expected ' + expectedBins + ')'
      );
    }

    check(
      'vibration: ISO 10816 features present',
      !!vib.data.features && typeof vib.data.features.vibration_rms === 'number',
      'features.vibration_rms missing or not numeric'
    );
  } else {
    console.log('   Python engine is offline - asserting graceful degradation.');
    check(
      'fallback: explanatory msg returned to the operator',
      typeof data.msg === 'string' && data.msg.length > 0
    );
    check(
      'fallback: engine label identifies the Node baseline',
      typeof data.engine === 'string' && data.engine.length > 0,
      'got ' + JSON.stringify(data.engine)
    );
    console.log('');
    console.log('   The dashboard should now show "LOCAL FFT FALLBACK".');
    console.log('   Start the engine with: python ai_engine/main.py   (FastAPI on :8000)');
  }

  console.log('');
  if (failures.length > 0) {
    console.log(failures.length + ' check(s) failed, ' + passed + ' passed.');
    process.exit(1);
  }
  console.log('All ' + passed + ' checks passed (' + data.status + ' mode).');
}

main().catch((err) => {
  console.error('');
  console.error('Bridge test failed: ' + err.message);
  process.exit(1);
});
