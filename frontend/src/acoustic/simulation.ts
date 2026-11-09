/**
 * Acoustic Shield simulation orchestrator.
 *
 * Fixed-timestep pipeline, executed every physics step (default 10 ms):
 *   1. ego speed controller + scheduled driver events
 *   2. vehicle propagation (ground truth)
 *   3. ground-truth contact detection (ends the run)
 *   4. simulated sensor -> measurements -> tracker
 *   5. collision prediction per track (and per ground-truth vehicle, for comparison only)
 *   6. decision engine -> acoustic protection controller
 *
 * Rendering is decoupled: the UI calls advance(realDt * timeScale) and reads state.
 */

import { cloneConfig, type AcousticShieldConfig } from './config.ts';
import { predictCollision, rectanglesOverlap, type CollisionPrediction } from './collision.ts';
import { ThresholdDecisionEngine, type SafetyDecisionEngine, type ThreatAssessment, type ThreatLevel } from './decision.ts';
import { AcousticProtectionController, type ProtectionCommand, type ProtectionCommandSink } from './protection.ts';
import { SEDAN, type DriverEvent, type Scenario } from './scenarios.ts';
import { SimulatedSensorProvider, type SensorMeasurement, type VehicleStateProvider } from './sensors.ts';
import { ObjectTracker, type TrackView } from './tracker.ts';
import { corners, propagate, wrapAngle, type VehicleState } from './vehicle.ts';

export type SimEventKind = 'info' | 'driver' | 'level' | 'protection' | 'cancel' | 'impact' | 'sensor';

export interface SimEvent {
  t: number;
  kind: SimEventKind;
  message: string;
}

export interface HistorySample {
  t: number;
  /** Primary tracked-prediction TTC (s) or null. */
  ttc: number | null;
  /** Earliest ground-truth TTC (s) or null. */
  ttcTruth: number | null;
  level: ThreatLevel;
  active: boolean;
}

export interface Pose {
  x: number;
  y: number;
  heading: number;
}

export interface Placement {
  /** Centre-to-centre distance from the Hyundai (m). */
  distance: number;
  /** Approach angle: bearing of the vehicle from the Hyundai heading (rad, CCW, 0 = ahead). */
  bearing: number;
  /** Lateral shift along the target's own left normal (m): lane offset. */
  lateral: number;
}

export interface ContactRecord {
  time: number;
  targetId: string;
  /** Activation lead achieved: contact time - activation time (s), null if never activated. */
  leadAchievedS: number | null;
}

const HISTORY_EVERY_S = 0.05;
const HISTORY_MAX = 800;
const EVENTS_MAX = 200;

export class AcousticShieldSimulation implements VehicleStateProvider {
  config: AcousticShieldConfig;
  scenario: Scenario;
  time = 0;
  ego!: VehicleState;
  targets: VehicleState[] = [];
  egoSetSpeed = 0;
  egoBraking = false;
  sensor: SimulatedSensorProvider;
  tracker: ObjectTracker;
  decision: SafetyDecisionEngine = new ThresholdDecisionEngine();
  protection: AcousticProtectionController;
  trackViews: TrackView[] = [];
  /** Predictions from tracked (sensor) data: these drive decisions. Keyed by object id. */
  predictions = new Map<string, CollisionPrediction>();
  /** Predictions from ground truth: displayed for validation only, never used for decisions. */
  truthPredictions = new Map<string, CollisionPrediction>();
  assessment: ThreatAssessment = { level: 'NORMAL', primary: null, targets: [], protectionEligible: false, degraded: false };
  lastMeasurements: SensorMeasurement[] = [];
  events: SimEvent[] = [];
  history: HistorySample[] = [];
  contact: ContactRecord | null = null;
  /** Poses before the latest physics step, for render interpolation. */
  prevPoses = new Map<string, Pose>();
  accumulator = 0;
  private pendingEvents: DriverEvent[] = [];
  private nextHistory = 0;
  private nextTargetNumber = 2;
  private externalSinks: ProtectionCommandSink[];

  constructor(scenario: Scenario, config: AcousticShieldConfig, sinks: ProtectionCommandSink[] = []) {
    this.config = cloneConfig(config);
    this.scenario = scenario;
    this.externalSinks = sinks;
    this.sensor = new SimulatedSensorProvider(this.config.sensor);
    this.tracker = new ObjectTracker(this.config.tracker, this.config.sensor);
    this.protection = this.makeProtection();
    this.load(scenario);
  }

  private makeProtection() {
    const logSink: ProtectionCommandSink = { send: (c: ProtectionCommand) => this.logCommand(c) };
    return new AcousticProtectionController(this.config.protection, [logSink, ...this.externalSinks]);
  }

  get ended() {
    return this.contact !== null;
  }

  getEgoState(): VehicleState {
    return this.ego;
  }

  load(scenario: Scenario) {
    this.protection.reset();
    this.scenario = scenario;
    this.time = 0;
    this.accumulator = 0;
    this.ego = { ...scenario.ego };
    this.egoSetSpeed = scenario.egoSetSpeed;
    this.egoBraking = false;
    this.targets = scenario.targets.map((t) => ({ ...t }));
    this.pendingEvents = [...scenario.events].sort((a, b) => a.at - b.at);
    this.sensor = new SimulatedSensorProvider(this.config.sensor);
    this.tracker = new ObjectTracker(this.config.tracker, this.config.sensor);
    this.protection = this.makeProtection();
    this.trackViews = [];
    this.predictions.clear();
    this.truthPredictions.clear();
    this.assessment = { level: 'NORMAL', primary: null, targets: [], protectionEligible: false, degraded: false };
    this.lastMeasurements = [];
    this.events = [];
    this.history = [];
    this.contact = null;
    this.nextHistory = 0;
    this.nextTargetNumber = this.targets.length + 1;
    this.capturePoses();
    this.log('info', `Scenario loaded: ${scenario.name}`);
    this.evaluate();
  }

  reset() {
    this.load(this.scenario);
  }

  /** Advance by simulated seconds using the fixed-step accumulator. Returns physics steps executed. */
  advance(simDt: number): number {
    if (this.ended || simDt <= 0) return 0;
    const h = this.config.physics.fixedDtS;
    this.accumulator += simDt;
    let steps = 0;
    while (this.accumulator >= h - 1e-12 && steps < this.config.physics.maxStepsPerFrame && !this.ended) {
      this.step();
      this.accumulator -= h;
      steps++;
    }
    if (steps >= this.config.physics.maxStepsPerFrame) this.accumulator = 0; // drop backlog after a stall
    return steps;
  }

  /** Fraction of a step remaining in the accumulator, for render interpolation. */
  get interpolationAlpha() {
    return Math.min(1, this.accumulator / this.config.physics.fixedDtS);
  }

  private capturePoses() {
    this.prevPoses.clear();
    for (const v of [this.ego, ...this.targets]) this.prevPoses.set(v.id, { x: v.x, y: v.y, heading: v.heading });
  }

  step() {
    if (this.ended) return;
    const h = this.config.physics.fixedDtS;
    const ec = this.config.egoControl;
    this.capturePoses();

    // 1. Ego longitudinal control (speed hold or brake) and scheduled driver inputs.
    this.ego.accel = this.egoBraking
      ? -ec.maxBrakeMps2
      : Math.max(-ec.maxBrakeMps2, Math.min(ec.maxAccelMps2, ec.speedGain * (this.egoSetSpeed - this.ego.speed)));
    if (Math.abs(this.ego.accel) < 1e-4) this.ego.accel = 0;
    while (this.pendingEvents.length && this.pendingEvents[0].at <= this.time + h / 2) {
      const ev = this.pendingEvents.shift()!;
      const v = this.targets.find((t) => t.id === ev.vehicleId);
      if (!v) continue;
      if (ev.accel !== undefined) v.accel = ev.accel;
      if (ev.yawRate !== undefined) v.yawRate = ev.yawRate;
      this.log('driver', ev.note);
    }

    // 2. Ground-truth propagation.
    const before = { ego: this.ego, targets: this.targets };
    this.ego = propagate(this.ego, h);
    this.targets = this.targets.map((t) => propagate(t, h));
    this.time += h;

    // 3. Ground-truth contact, refined by bisection within the step.
    const egoPoly = corners(this.ego);
    for (let i = 0; i < this.targets.length; i++) {
      if (!rectanglesOverlap(egoPoly, corners(this.targets[i]))) continue;
      let lo = 0;
      let hi = h;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (rectanglesOverlap(corners(propagate(before.ego, mid)), corners(propagate(before.targets[i], mid)))) hi = mid;
        else lo = mid;
      }
      const t = this.time - h + hi;
      const act = this.protection.current;
      this.contact = { time: t, targetId: this.targets[i].id, leadAchievedS: act ? t - act.time : null };
      this.protection.notifyImpact(t);
      this.log('impact', `Footprint contact with ${this.targets[i].label} at t = ${t.toFixed(3)} s`
        + (act ? ` (stimulus lead ${(t - act.time).toFixed(3)} s)` : ' (protection was not active)'));
      break;
    }

    // 4-6. Sensing, tracking, prediction, decision, protection.
    if (!this.ended) this.evaluate();
    this.recordHistory();
  }

  /** Runs the sensing/prediction/decision chain at the current time without moving vehicles. */
  evaluate() {
    const now = this.time;
    this.sensor.observe(now, this.ego, this.targets);
    const measurements = this.sensor.poll(now);
    if (measurements.length) this.lastMeasurements = measurements;
    const { created, deleted, rejected } = this.tracker.update(measurements, now);
    for (const id of created) this.log('sensor', `Track ${id} initiated`);
    for (const id of deleted) this.log('sensor', `Track ${id} dropped (no measurements)`);
    if (rejected) this.log('sensor', `${rejected} invalid measurement(s) rejected`);

    const c = this.config;
    this.trackViews = this.tracker.views(now, c.decision.maxSensorAgeS);
    this.predictions.clear();
    for (const view of this.trackViews) this.predictions.set(view.track.objectId, predictCollision(this.ego, view.state, c.prediction));
    this.truthPredictions.clear();
    for (const t of this.targets) this.truthPredictions.set(t.id, predictCollision(this.ego, t, c.prediction));

    const previous = this.assessment.level;
    this.assessment = this.decision.evaluate({
      tracks: this.trackViews.map((view) => ({ view, prediction: this.predictions.get(view.track.objectId)! })),
      config: c.decision,
    });
    if (this.assessment.level !== previous) {
      this.log('level', `${previous} → ${this.assessment.level}: ${this.assessment.primary?.reason ?? 'no tracked objects'}`);
    }
    this.protection.update(now, this.assessment);
  }

  private recordHistory() {
    if (this.time + 1e-9 < this.nextHistory) return;
    this.nextHistory = this.time + HISTORY_EVERY_S;
    let ttcTruth: number | null = null;
    for (const p of this.truthPredictions.values()) if (p.ttc !== null && (ttcTruth === null || p.ttc < ttcTruth)) ttcTruth = p.ttc;
    this.history.push({
      t: this.time,
      ttc: this.assessment.primary?.prediction.ttc ?? null,
      ttcTruth,
      level: this.assessment.level,
      active: this.protection.state === 'ACTIVE',
    });
    if (this.history.length > HISTORY_MAX) this.history.shift();
  }

  private log(kind: SimEventKind, message: string) {
    this.events.push({ t: this.time, kind, message });
    if (this.events.length > EVENTS_MAX) this.events.shift();
  }

  private logCommand(c: ProtectionCommand) {
    if (c.type === 'PRECONDITION_START') {
      const lead = c.ttc !== null ? c.ttc - this.config.protection.requiredLeadTimeS : 0;
      this.log('protection', `ACOUSTIC SHIELD ACTIVE: predicted impact in ${c.ttc?.toFixed(3)} s (lead margin ${lead >= 0 ? '+' : ''}${lead.toFixed(3)} s)`);
    } else {
      this.log(c.reason === 'Impact reached' ? 'impact' : 'cancel', `Preconditioning stopped: ${c.reason}`);
    }
  }

  // ---------------------------------------------------------------- interactive controls

  setEgoSetSpeed(mps: number) {
    this.egoSetSpeed = Math.max(0, mps);
  }

  setEgoBraking(on: boolean) {
    if (on !== this.egoBraking) this.log('driver', on ? 'Hyundai driver brakes' : 'Hyundai brake released');
    this.egoBraking = on;
  }

  /** Live edit of a target's motion or size. Takes effect on the next physics step. */
  updateTarget(id: string, patch: Partial<Pick<VehicleState, 'speed' | 'accel' | 'heading' | 'yawRate' | 'length' | 'width' | 'label'>>) {
    const t = this.targets.find((v) => v.id === id);
    if (!t) return;
    Object.assign(t, patch);
    t.speed = Math.max(0, t.speed);
    t.heading = wrapAngle(t.heading);
    this.pendingEvents = this.pendingEvents.filter((e) => e.vehicleId !== id || patch.accel === undefined);
    if (!this.ended) this.evaluate();
  }

  placementOf(id: string): Placement | null {
    const t = this.targets.find((v) => v.id === id);
    if (!t) return null;
    const dx = t.x - this.ego.x;
    const dy = t.y - this.ego.y;
    return { distance: Math.hypot(dx, dy), bearing: wrapAngle(Math.atan2(dy, dx) - this.ego.heading), lateral: 0 };
  }

  /** Re-position a target relative to the Hyundai. The track restarts because this is a discontinuity. */
  placeTarget(id: string, p: Placement) {
    const t = this.targets.find((v) => v.id === id);
    if (!t) return;
    const a = this.ego.heading + p.bearing;
    t.x = this.ego.x + p.distance * Math.cos(a) - p.lateral * Math.sin(t.heading);
    t.y = this.ego.y + p.distance * Math.sin(a) + p.lateral * Math.cos(t.heading);
    this.prevPoses.set(t.id, { x: t.x, y: t.y, heading: t.heading });
    this.tracker.drop(id);
    if (!this.ended) this.evaluate();
  }

  addTarget(): VehicleState {
    const n = this.nextTargetNumber++;
    const id = `t${n}`;
    // Spawn ahead in the oncoming lane, driving towards the Hyundai.
    const c = Math.cos(this.ego.heading);
    const s = Math.sin(this.ego.heading);
    const v: VehicleState = {
      id, label: `Vehicle ${n}`, kind: 'target',
      x: this.ego.x + 60 * c + 3.5 * s, y: this.ego.y + 60 * s - 3.5 * c,
      heading: wrapAngle(this.ego.heading + Math.PI), speed: 8.33, accel: 0, yawRate: 0, ...SEDAN,
    };
    this.targets.push(v);
    this.prevPoses.set(id, { x: v.x, y: v.y, heading: v.heading });
    this.log('info', `${v.label} added to the simulation`);
    if (!this.ended) this.evaluate();
    return v;
  }

  removeTarget(id: string) {
    const t = this.targets.find((v) => v.id === id);
    this.targets = this.targets.filter((v) => v.id !== id);
    this.tracker.drop(id);
    if (t) this.log('info', `${t.label} removed`);
    if (!this.ended) this.evaluate();
  }

  setConfig(config: AcousticShieldConfig) {
    this.config = cloneConfig(config);
    this.sensor.setConfig(this.config.sensor);
    this.tracker.config = { ...this.config.tracker };
    this.tracker.setSensorModel(this.config.sensor);
    this.protection.setConfig(this.config.protection);
  }
}
