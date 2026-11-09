import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, IDEAL_SENSOR, cloneConfig, type AcousticShieldConfig } from './config.ts';
import { closestApproach, predictCollision, type CollisionPrediction } from './collision.ts';
import { ThresholdDecisionEngine, type ThreatAssessment } from './decision.ts';
import { AcousticProtectionController, type ProtectionCommand } from './protection.ts';
import { SCENARIOS } from './scenarios.ts';
import type { SensorMeasurement } from './sensors.ts';
import { ObjectTracker } from './tracker.ts';
import { AcousticShieldSimulation } from './simulation.ts';
import { propagate, type VehicleState } from './vehicle.ts';

const P = DEFAULT_CONFIG.prediction;
const L = 4.6;

function car(id: string, x: number, y: number, heading: number, speed: number, accel = 0): VehicleState {
  return { id, label: id, kind: id === 'ego' ? 'ego' : 'target', x, y, heading, speed, accel, yawRate: 0, length: L, width: 1.8 };
}
const EAST = 0;
const WEST = Math.PI;
const NORTH = Math.PI / 2;
const near = (actual: number | null, expected: number, tol: number, msg?: string) => {
  assert.ok(actual !== null, msg ?? `expected ${expected}, got null`);
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);
};

// ---------------------------------------------------------------- kinematics & geometry

test('head-on: 20 m bumper gap closing at 20 m/s gives TTC 1.0 s', () => {
  const p = predictCollision(car('ego', 0, 0, EAST, 10), car('t', 20 + L, 0, WEST, 10), P);
  assert.equal(p.method, 'analytic-swept-sat');
  assert.equal(p.collision, true);
  near(p.ttc, 1.0, 1e-9);
  near(p.gap, 20, 1e-9);
  near(p.closingSpeed, 20, 1e-9);
  near(p.range, 24.6, 1e-9);
});

test('rear-end: 20 m gap, follower 5 m/s faster gives TTC 4.0 s', () => {
  const p = predictCollision(car('ego', 0, 0, EAST, 10), car('t', -(20 + L), 0, EAST, 15), P);
  near(p.ttc, 4.0, 1e-9);
  near(p.closingSpeed, 5, 1e-9);
});

test('vehicle moving away: no collision, negative closing speed, t_CPA = 0', () => {
  const p = predictCollision(car('ego', 0, 0, EAST, 10), car('t', 30, 0, EAST, 15), P);
  assert.equal(p.collision, false);
  assert.equal(p.ttc, null);
  near(p.closingSpeed, -5, 1e-9);
  assert.equal(p.tCpa, 0);
  near(p.dCpa, 30, 1e-9);
});

test('identical speed and direction: zero relative velocity, no collision', () => {
  const p = predictCollision(car('ego', 0, 0, EAST, 16.7), car('t', 20, 0, EAST, 16.7), P);
  assert.equal(p.collision, false);
  near(p.closingSpeed, 0, 1e-9);
  assert.equal(p.tCpa, 0);
  near(p.dCpa, 20, 1e-9);
  const z = closestApproach({ x: 3, y: 4 }, { x: 0, y: 0 }, 6);
  assert.deepEqual(z, { tCpa: 0, dCpa: 5 });
});

test('intersection: crossing footprints give the hand-computed first-contact time', () => {
  // Ego x-overlap window [4.68, 5.32] s, target y-overlap window [4.88, 5.52] s -> contact at 4.88 s.
  const p = predictCollision(car('ego', -50, 0, EAST, 10), car('t', 0, -52, NORTH, 10), P);
  assert.equal(p.method, 'analytic-swept-sat');
  near(p.ttc, 4.88, 1e-9);
  assert.ok(p.contactPoint);
  // r = (50,-52), v_rel = (-10,10): t_CPA = 1020/200 = 5.1 s, d_CPA = |(-1, -1)| = 1.414 m.
  near(p.tCpa, 5.1, 1e-9);
  near(p.dCpa, Math.SQRT2, 1e-9);
});

test('intersection with acceleration uses trajectory sampling and matches the closed form', () => {
  // Target y(t) = -52 + 8t + 0.5t². Enters ego lane when y + 2.3 = -0.9 -> t = -8 + sqrt(161.6).
  const p = predictCollision(car('ego', -50, 0, EAST, 10), car('t', 0, -52, NORTH, 8, 1), P);
  assert.equal(p.method, 'sampled-trajectory');
  near(p.ttc, -8 + Math.sqrt(161.6), 1e-4);
});

test('trajectories that pass without intersecting are not predicted as a collision', () => {
  // Target clears the ego path in [3.68, 4.32] s; ego reaches the crossing in [4.68, 5.32] s.
  const p = predictCollision(car('ego', -50, 0, EAST, 10), car('t', 0, -40, NORTH, 10), P);
  assert.equal(p.collision, false);
  near(p.tCpa, 4.5, 1e-9);
  near(p.dCpa, Math.hypot(5, 5), 1e-9);
});

test('braking target: stops short (no collision) or collides at the closed-form time', () => {
  // Ego stopped; target 30 m gap at 10 m/s. At -5 m/s² it stops after 10 m.
  const ego = car('ego', 0, 0, EAST, 0);
  const stops = predictCollision(ego, car('t', 30 + L, 0, WEST, 10, -5), P);
  assert.equal(stops.collision, false);
  // At -1 m/s²: 30 = 10t - 0.5t² -> t = 10 - sqrt(40).
  const hits = predictCollision(ego, car('t', 30 + L, 0, WEST, 10, -1), P);
  near(hits.ttc, 10 - Math.sqrt(40), 1e-4);
  // Motion model never reverses a braking vehicle.
  const stopped = propagate(car('t', 0, 0, EAST, 10, -5), 5);
  assert.equal(stopped.speed, 0);
  near(stopped.x, 10, 1e-9);
});

test('stationary obstacle: 30 m gap at 15 m/s gives TTC 2.0 s', () => {
  const p = predictCollision(car('ego', 0, 0, EAST, 15), car('t', 30 + L, 0, EAST, 0), P);
  near(p.ttc, 2.0, 1e-9);
});

test('contacts beyond the prediction horizon are not reported', () => {
  const p = predictCollision(car('ego', 0, 0, EAST, 10), car('t', 100 + L, 0, EAST, 0), P);
  assert.equal(p.collision, false);
  assert.equal(p.ttc, null);
});

// ---------------------------------------------------------------- sensors & tracking

function measurement(overrides: Partial<SensorMeasurement> = {}): SensorMeasurement {
  return {
    source: 'simulated', sensorId: 's', objectId: 't1', captureTime: 0, deliveryTime: 0,
    range: 30, azimuth: 0, rangeRate: -5, orientation: Math.PI, length: L, width: 1.8,
    egoPose: { x: 0, y: 0, heading: 0, vx: 0, vy: 0 }, ...overrides,
  };
}

test('tracker rejects invalid measurements and never creates a track from them', () => {
  const tracker = new ObjectTracker(DEFAULT_CONFIG.tracker, DEFAULT_CONFIG.sensor);
  const r = tracker.update([measurement({ range: Number.NaN }), measurement({ captureTime: Number.POSITIVE_INFINITY })], 0);
  assert.equal(r.rejected, 2);
  assert.equal(tracker.views(0, 0.25).length, 0);
});

test('Kalman tracker converges on a constant-velocity target from ideal measurements', () => {
  const tracker = new ObjectTracker(DEFAULT_CONFIG.tracker, IDEAL_SENSOR);
  for (let k = 0; k < 10; k++) tracker.update([measurement({ captureTime: k * 0.05, range: 30 - 5 * k * 0.05 })], k * 0.05);
  const [view] = tracker.views(0.5, 0.25);
  near(view.state.speed, 5, 0.02);
  near(view.state.x, 30 - 5 * 0.5, 0.02);
  assert.ok(view.confidence >= DEFAULT_CONFIG.decision.minTrackConfidence);
});

test('missing measurements: a sensor that sees nothing produces no tracks and NORMAL', () => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.sensor = { ...IDEAL_SENSOR, dropoutProbability: 1 };
  const sim = new AcousticShieldSimulation(SCENARIOS[0], config);
  sim.advance(4.5);
  assert.equal(sim.trackViews.length, 0);
  assert.equal(sim.assessment.level, 'NORMAL');
  assert.equal(sim.protection.activations.length, 0);
  // Ground truth still shows the collision: the gap is in sensing, not physics.
  assert.equal(sim.truthPredictions.get('t1')?.collision, true);
});

test('stale measurements: blackout stops trust and cancels active protection', () => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.sensor = { ...IDEAL_SENSOR };
  const sim = new AcousticShieldSimulation(SCENARIOS[0], config);
  while (sim.protection.state !== 'ACTIVE' && !sim.ended) sim.step();
  assert.equal(sim.protection.state, 'ACTIVE');
  sim.setConfig({ ...config, sensor: { ...config.sensor, blackout: true } });
  for (let i = 0; i < 40; i++) sim.step(); // 0.4 s without data
  const primary = sim.assessment.primary!;
  assert.equal(primary.trusted, false);
  assert.match(primary.reason, /stale/i);
  assert.notEqual(sim.protection.state, 'ACTIVE');
  assert.match(sim.protection.activations[0].endReason ?? '', /no longer trusted/i);
});

// ---------------------------------------------------------------- decision & protection

function fakeAssessment(ttc: number | null): ThreatAssessment {
  const prediction = { targetId: 't1', collision: ttc !== null, ttc, closingSpeed: 10, horizonS: 6, tCpa: 0, dCpa: 10, range: 20 } as CollisionPrediction;
  const engine = new ThresholdDecisionEngine();
  return engine.evaluate({
    tracks: [{ view: { track: {} as never, ageS: 0, stale: false, confidence: 1, velocityStd: 0.1, state: {} as VehicleState }, prediction }],
    config: DEFAULT_CONFIG.decision,
  });
}

test('decision engine levels follow the configured TTC thresholds', () => {
  assert.equal(fakeAssessment(null).level, 'NORMAL');
  assert.equal(fakeAssessment(5).level, 'WATCH');
  assert.equal(fakeAssessment(2.5).level, 'WARNING');
  assert.equal(fakeAssessment(1.0).level, 'CRITICAL');
  assert.equal(fakeAssessment(1.0).protectionEligible, true);
});

test('protection never activates on elapsed time alone, only on the prediction, and cancels when it disappears', () => {
  const commands: ProtectionCommand[] = [];
  const ctl = new AcousticProtectionController(DEFAULT_CONFIG.protection, [{ send: (c) => commands.push(c) }]);
  for (let t = 0; t < 20; t += 0.01) ctl.update(t, fakeAssessment(null));
  assert.equal(ctl.state, 'STANDBY');
  assert.equal(commands.length, 0);

  ctl.update(20.0, fakeAssessment(1.1));
  assert.notEqual(ctl.state, 'ACTIVE'); // confirmation pending
  ctl.update(20.03, fakeAssessment(1.07));
  assert.equal(ctl.state, 'ACTIVE');
  assert.equal(commands[0].type, 'PRECONDITION_START');
  near(ctl.activations[0].ttcAtActivation, 1.07, 1e-12);
  near(ctl.activations[0].leadMarginS, 1.07 - DEFAULT_CONFIG.protection.requiredLeadTimeS, 1e-12);

  ctl.update(20.1, fakeAssessment(null));
  assert.equal(ctl.state, 'ACTIVE'); // hold
  ctl.update(20.3, fakeAssessment(null));
  assert.equal(ctl.state, 'STANDBY');
  assert.equal(commands[1].type, 'PRECONDITION_STOP');
});

// ---------------------------------------------------------------- full pipeline scenarios

function run(id: string, sensor = IDEAL_SENSOR, maxT = 12) {
  const config: AcousticShieldConfig = cloneConfig(DEFAULT_CONFIG);
  config.sensor = { ...sensor };
  const sim = new AcousticShieldSimulation(SCENARIOS.find((s) => s.id === id)!, config);
  let predicted = false;
  let maxLevel = 0;
  const rank = { NORMAL: 0, WATCH: 1, WARNING: 2, CRITICAL: 3 } as const;
  while (sim.time < maxT && !sim.ended) {
    sim.step();
    if (sim.assessment.primary?.prediction.collision) predicted = true;
    maxLevel = Math.max(maxLevel, rank[sim.assessment.level]);
  }
  return { sim, predicted, maxLevel };
}

const expectedContact: Record<string, number> = {
  side: (68.55) / (50 / 3.6),
  rear: (50 - L) / ((80 - 40) / 3.6),
  headon: (140 - L) / ((50 + 60) / 3.6),
  stationary: (120 - L) / (50 / 3.6),
};

for (const id of Object.keys(expectedContact)) {
  test(`scenario ${id}: protection activates with sufficient lead before the computed contact time`, () => {
    const { sim } = run(id);
    assert.ok(sim.contact, 'contact expected');
    near(sim.contact.time, expectedContact[id], 1e-3, 'contact time');
    const act = sim.protection.activations[0];
    assert.ok(act, 'activation expected');
    assert.equal(act.late, false);
    assert.ok(sim.contact.leadAchievedS! >= DEFAULT_CONFIG.protection.requiredLeadTimeS);
    assert.ok(act.ttcAtActivation <= DEFAULT_CONFIG.decision.criticalTtcS);
  });
}

test('scenario nearmiss: no collision is ever predicted and protection never activates', () => {
  // Ideal sensor: the geometry itself never yields a contact.
  const ideal = run('nearmiss');
  assert.equal(ideal.sim.contact, null);
  assert.equal(ideal.predicted, false);
  assert.equal(ideal.sim.protection.activations.length, 0);
  // Default noisy sensor over many seeds: tracking noise may cause brief long-horizon WATCH
  // predictions, but never a WARNING, CRITICAL or activation.
  for (let seed = 1; seed <= 20; seed++) {
    const { sim, maxLevel } = run('nearmiss', { ...DEFAULT_CONFIG.sensor, seed });
    assert.equal(sim.contact, null);
    assert.ok(maxLevel <= 1, `seed ${seed}: at most WATCH`);
    assert.equal(sim.protection.activations.length, 0);
  }
});

test('noisy sensor: all collision scenarios still activate in time and E still cancels (20 seeds)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const sensor = { ...DEFAULT_CONFIG.sensor, seed };
    for (const id of Object.keys(expectedContact)) {
      const { sim } = run(id, sensor);
      assert.ok(sim.contact && sim.contact.leadAchievedS !== null && sim.contact.leadAchievedS >= DEFAULT_CONFIG.protection.requiredLeadTimeS, `${id} seed ${seed}`);
    }
    const avoided = run('avoided', sensor).sim;
    assert.equal(avoided.contact, null);
    assert.notEqual(avoided.protection.state, 'ACTIVE', `avoided seed ${seed}`);
  }
});

test('scenario avoided: predicted contact is recalculated away and protection is cancelled', () => {
  const { sim, predicted } = run('avoided');
  assert.equal(predicted, true);
  assert.equal(sim.contact, null);
  assert.notEqual(sim.protection.state, 'ACTIVE');
  assert.equal(sim.assessment.primary?.prediction.collision, false);
  for (const a of sim.protection.activations) assert.match(a.endReason ?? '', /no longer present/i);
});

test('physics is independent of the render frame rate', () => {
  const a = new AcousticShieldSimulation(SCENARIOS[0], DEFAULT_CONFIG);
  const b = new AcousticShieldSimulation(SCENARIOS[0], DEFAULT_CONFIG);
  for (let i = 0; i < 120; i++) a.advance(1 / 40);
  for (let i = 0; i < 50; i++) b.advance(3 / 50);
  assert.equal(a.time.toFixed(6), b.time.toFixed(6));
  assert.equal(a.ego.x, b.ego.x);
  assert.equal(a.targets[0].y, b.targets[0].y);
  assert.equal(a.assessment.primary?.prediction.ttc, b.assessment.primary?.prediction.ttc);
});
