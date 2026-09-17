/**
 * HydroSync Frontend Charting Module
 * Author: Abdelhak Hamzi
 */
/**
 * charts.js - HydroSync Frontend Charting Module
 * Handles: Live Vibration Waveform (Time-Domain) & FFT Spectrum (Frequency-Domain)
 * Author: Abdelhak Hamzi
 */

(function () {
  'use strict';

  var waveformChart = null;
  var fftChart = null;
  var WAVEFORM_SAMPLES = 256;
  var SAMPLING_RATE = 1000;

  function initWaveformChart(canvasId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var labels = [];
    for (var i = 0; i < WAVEFORM_SAMPLES; i++) {
      labels.push((i / SAMPLING_RATE).toFixed(4));
    }

    waveformChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Vibration Waveform',
          data: new Array(WAVEFORM_SAMPLES).fill(0),
          borderColor: '#00E5FF',
          backgroundColor: 'rgba(0, 229, 255, 0.08)',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: {
            title: { display: true, text: 'Time (s)', color: 'rgba(139,152,179,.8)' },
            ticks: { color: 'rgba(139,152,179,.8)', maxTicksLimit: 8 },
            grid: { color: 'rgba(255,255,255,.04)' }
          },
          y: {
            title: { display: true, text: 'Amplitude', color: 'rgba(139,152,179,.8)' },
            ticks: { color: 'rgba(232,238,247,.55)' },
            grid: { color: 'rgba(255,255,255,.06)' }
          }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  function updateWaveformChart(samples) {
    if (!waveformChart || !Array.isArray(samples) || samples.length === 0) return;
    waveformChart.data.datasets[0].data = samples;
    waveformChart.update('none');
  }

  function computeFFT(samples) {
    var N = samples.length;
    var magnitudes = [];
    var halfN = Math.floor(N / 2);
    for (var k = 0; k < halfN; k++) {
      var real = 0;
      var imag = 0;
      for (var n = 0; n < N; n++) {
        var angle = (2 * Math.PI * k * n) / N;
        real += samples[n] * Math.cos(angle);
        imag -= samples[n] * Math.sin(angle);
      }
      magnitudes.push(Math.sqrt(real * real + imag * imag) / N);
    }
    return magnitudes;
  }

  function initFFTChart(canvasId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var halfN = WAVEFORM_SAMPLES / 2;
    var labels = [];
    for (var i = 0; i < halfN; i++) {
      labels.push((i * SAMPLING_RATE / WAVEFORM_SAMPLES).toFixed(1));
    }

    fftChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'FFT Magnitude',
          data: new Array(halfN).fill(0),
          borderColor: '#10B981',
          backgroundColor: 'rgba(16, 185, 129, 0.12)',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            title: { display: true, text: 'Frequency (Hz)', color: 'rgba(139,152,179,.8)' },
            ticks: { color: 'rgba(139,152,179,.8)', maxTicksLimit: 10 },
            grid: { color: 'rgba(255,255,255,.04)' }
          },
          y: {
            title: { display: true, text: 'Magnitude', color: 'rgba(139,152,179,.8)' },
            ticks: { color: 'rgba(232,238,247,.55)' },
            grid: { color: 'rgba(255,255,255,.06)' }
          }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  function updateFFTChart(magnitudes) {
    if (!fftChart || !Array.isArray(magnitudes) || magnitudes.length === 0) return;
    fftChart.data.datasets[0].data = magnitudes;
    fftChart.update('none');
  }

  window.HydroSyncCharts = {
    initWaveformChart: initWaveformChart,
    updateWaveformChart: updateWaveformChart,
    initFFTChart: initFFTChart,
    updateFFTChart: updateFFTChart,
    computeFFT: computeFFT
  };

})();