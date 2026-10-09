function analyzeWaveform(waveform, samplingRateHz) {
  if (!Array.isArray(waveform) || waveform.length < 32) {
    throw new Error('Vibration waveform must contain at least 32 samples');
  }
  if (!Number.isFinite(samplingRateHz) || samplingRateHz <= 0) {
    throw new Error('Sampling rate must be a positive finite number');
  }

  const n = waveform.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error('Vibration waveform length must be a power of two');
  }

  const mean = waveform.reduce((sum, value) => sum + value, 0) / n;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  let windowSum = 0;

  for (let i = 0; i < n; i++) {
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    real[i] = (waveform[i] - mean) * window;
    windowSum += window;
  }

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const angle = (-2 * Math.PI) / size;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);

    for (let start = 0; start < n; start += size) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      for (let offset = 0; offset < halfSize; offset++) {
        const even = start + offset;
        const odd = even + halfSize;
        const oddReal = real[odd] * twiddleReal - imag[odd] * twiddleImag;
        const oddImag = real[odd] * twiddleImag + imag[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imag[odd] = imag[even] - oddImag;
        real[even] += oddReal;
        imag[even] += oddImag;

        const nextTwiddleReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }

  const binCount = (n >> 1) + 1;
  const spectrum = new Float64Array(binCount);
  for (let i = 0; i < binCount; i++) {
    spectrum[i] = (2 * Math.hypot(real[i], imag[i])) / windowSum;
    if (i === 0 || (n % 2 === 0 && i === binCount - 1)) spectrum[i] /= 2;
    if (i === 0) spectrum[i] = 0;
  }

  const frequencies = Array.from({ length: binCount }, (_, i) => (i * samplingRateHz) / n);
  const oneXCandidates = [];
  for (let i = 0; i < binCount; i++) {
    if (frequencies[i] >= 30 && frequencies[i] <= 70) oneXCandidates.push(i);
  }
  let oneXIndex = 0;
  for (const i of oneXCandidates) {
    if (spectrum[i] > spectrum[oneXIndex]) oneXIndex = i;
  }
  const dominantIndex = oneXIndex;

  const oneXFrequency = frequencies[oneXIndex];
  const targetTwoX = oneXFrequency * 2;
  let twoXIndex = 0;
  for (let i = 1; i < binCount; i++) {
    if (Math.abs(frequencies[i] - targetTwoX) < Math.abs(frequencies[twoXIndex] - targetTwoX)) {
      twoXIndex = i;
    }
  }

  const oneXAmplitude = spectrum[oneXIndex];
  const twoXAmplitude = spectrum[twoXIndex];
  const round4 = value => Number(value.toFixed(4));

  return {
    vibration_rms: round4(Math.sqrt(
      waveform.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n
    )),
    dominant_frequency_hz: Number(frequencies[dominantIndex].toFixed(2)),
    one_x_amplitude: round4(oneXAmplitude),
    two_x_amplitude: round4(twoXAmplitude),
    two_x_to_one_x_ratio: round4(oneXAmplitude > 0 ? twoXAmplitude / oneXAmplitude : 0),
    spectral_energy: round4(spectrum.reduce((sum, value) => sum + value ** 2, 0))
  };
}

module.exports = { analyzeWaveform };
