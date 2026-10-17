const assert = require('node:assert/strict');
const test = require('node:test');

const demoMode = require('../database/demoMode');
const { buildCollectionMetadata } = require('../database/telemetryCollector');

function createSimulator(calls) {
  return {
    setDemoMode: () => {},
    prepareAutoCollectionBlock: () => {},
    injectFault: () => {},
    setImbalanceLevel: () => {},
    setTankVolumePercent: () => {},
    setBearingWearLevel: () => {},
    setThermalFaultLevel: () => {},
    setManualMode: () => {},
    finishAutoCollection: () => {},
    injectDisturbance: (type, durationTicks) => {
      calls.push({ type, durationTicks });
    }
  };
}

test('demo keeps drought and flood disturbances alive through measurement', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  const disturbances = [];
  const stateChanges = [];

  global.setTimeout = (callback) => {
    const handle = { callback, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => { handle.cleared = true; };

  try {
    const warmupMs = 2_000;
    const measurementMs = 3_000;
    const expectedMinimumLease = Math.ceil((warmupMs + measurementMs) / 1000) + 5;

    assert.equal(demoMode.start(createSimulator(disturbances), {
      demo_warmup_ms: warmupMs,
      demo_measure_ms: measurementMs,
      maxCycles: 1,
      onStateChange: (event) => stateChanges.push(event)
    }).started, true);

    // Execute scheduled phase transitions until both operating-condition states start.
    while (!disturbances.some(d => d.type === 'flood')) {
      const timer = timers.shift();
      assert.ok(timer, 'demo should schedule the next phase transition');
      if (!timer.cleared) timer.callback();
    }

    for (const type of ['drought', 'flood']) {
      const disturbance = disturbances.find(d => d.type === type);
      assert.ok(disturbance, `${type} disturbance should be injected`);
      assert.ok(
        disturbance.durationTicks >= expectedMinimumLease,
        `${type} lease must cover warm-up, measurement, and safety margin`
      );
    }

    const droughtMeasurement = stateChanges.find(
      event => event.state === 'drought' && event.phase === 'measurement'
    );
    assert.deepEqual(
      {
        operatingCondition: droughtMeasurement.operatingCondition,
        severityInjected: droughtMeasurement.severityInjected
      },
      { operatingCondition: 'drought', severityInjected: 0 }
    );
  } finally {
    demoMode.stop();
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('demo collection metadata contains state, phase, condition, and severity', () => {
  const collection = buildCollectionMetadata({}, {
    state: 'flood_risk',
    pwm: 60,
    phase: 'measurement',
    runId: 'run-123',
    mode: 'quick',
    faultType: 'none',
    operatingCondition: 'flood_risk',
    severityInjected: 0,
    isBaseline: false
  }, 60, 42);

  assert.deepEqual(collection, {
    demo_state: 'flood_risk',
    demo_pwm: 60,
    demo_phase: 'measurement',
    demo_mode: true,
    demo_run_id: 'run-123',
    demo_run_mode: 'quick',
    fault_type: 'none',
    operating_condition: 'flood_risk',
    severity_injected: 0,
    condition_block_id: null,
    pwm_target: 60,
    is_baseline: false,
    sample_id: 42
  });
});

test('quick demo schedules all nine scenarios at three PWM levels with a unique run ID', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  const stateChanges = [];
  const simulator = createSimulator([]);
  global.setTimeout = (callback) => {
    const timer = { callback, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = timer => { timer.cleared = true; };

  try {
    const started = demoMode.startQuick(simulator, {
      onStateChange: event => stateChanges.push(event)
    });

    assert.equal(started.started, true);
    assert.equal(started.mode, 'quick');
    assert.deepEqual(started.pwmLevels, [40, 60, 80]);
    assert.equal(started.totalStates, 27);
    assert.equal(started.demo_warmup_ms, 30_000);
    assert.equal(started.demo_measure_ms, 15_000);
    assert.equal(started.estimatedRuntimeMs, 27 * 45_000);
    assert.match(started.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(demoMode.getStatus().runId, started.runId);

    while (demoMode.isRunning()) {
      const timer = timers.shift();
      assert.ok(timer, 'each quick phase should schedule the next transition');
      if (!timer.cleared) timer.callback();
    }

    const measurementEvents = stateChanges.filter(event => event.phase === 'measurement');
    assert.equal(measurementEvents.length, 27);
    assert.equal(new Set(measurementEvents.map(event => event.state)).size, 9);
    assert.deepEqual(
      [...new Set(measurementEvents.map(event => event.pwm))].sort((a, b) => a - b),
      [40, 60, 80]
    );
    assert.ok(measurementEvents.every(event => event.runId === started.runId));
    assert.equal(demoMode.getStatus().completed, true);
    assert.equal(demoMode.getStatus().completedBlocks, 27);
  } finally {
    demoMode.stop();
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('default demo retains the five PWM settings and full-sweep timing', () => {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = callback => ({ callback });
  try {
    const started = demoMode.start(createSimulator([]));
    assert.equal(started.started, true);
    assert.equal(started.mode, 'full');
    assert.deepEqual(started.pwmLevels, [40, 50, 60, 70, 80]);
    assert.equal(started.demo_warmup_ms, 60_000);
    assert.equal(started.demo_measure_ms, 30_000);
    assert.equal(started.totalStates, 45);
  } finally {
    demoMode.stop();
    global.setTimeout = realSetTimeout;
  }
});
