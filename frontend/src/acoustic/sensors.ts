/**
 * Sensor abstraction and the simulated sensor.
 *
 * Ground truth (simulator vehicle states) never reaches the collision
 * predictor directly. It goes: ground truth -> SimulatedSensorProvider
 * (noise, latency, range/FOV limits, dropouts, corrupt samples) ->
 * SensorMeasurement -> ObjectTracker (tracker.ts) -> ObjectTrack -> predictor.
 *
 * A future hardware adapter (radar object list, camera detections, fused
 * object list) implements SensorProvider and emits the same SensorMeasurement.
 */

import { DEG, type SensorConfig } from './config.ts';
import { velocity, wrapAngle, type VehicleState } from './vehicle.ts';

export type SensorSource = 'simulated' | 'radar' | 'camera' | 'fusion';

/** Ego pose/motion time-aligned with a measurement (from odometry / vehicle bus). */
export interface EgoPose {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
}

/** One object detection in the ego body frame (x forward, y left). */
export interface SensorMeasurement {
  source: SensorSource;
  sensorId: string;
  /** Sensor-assigned object id (radar object lists carry persistent ids). */
  objectId: string;
  captureTime: number;
  deliveryTime: number;
  range: number;
  /** Bearing (rad) from the ego heading, CCW positive. */
  azimuth: number;
  /** Radial velocity (m/s), negative when approaching. */
  rangeRate: number;
  /** Object heading relative to the ego heading (rad). */
  orientation: number;
  length: number;
  width: number;
  egoPose: EgoPose;
}

/** Anything that delivers measurements: simulated today, hardware adapters later. */
export interface SensorProvider {
  readonly source: SensorSource;
  /** Measurements delivered at or before `now` that have not been returned yet. */
  poll(now: number): SensorMeasurement[];
}

/** Provides the ego vehicle's own motion (vehicle bus speed, IMU, localisation). */
export interface VehicleStateProvider {
  getEgoState(): VehicleState;
}

// ---------------------------------------------------------------- deterministic PRNG

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number, sigma: number): number {
  if (sigma <= 0) return 0;
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- simulated sensor

/**
 * Generates radar-like object measurements from simulator ground truth.
 * This is a model of a sensor, not a real one: nothing here comes from hardware.
 */
export class SimulatedSensorProvider implements SensorProvider {
  readonly source = 'simulated' as const;
  config: SensorConfig;
  private rand: () => number;
  private queue: SensorMeasurement[] = [];
  private nextScan = 0;

  constructor(config: SensorConfig) {
    this.config = { ...config };
    this.rand = mulberry32(config.seed);
  }

  setConfig(config: SensorConfig) {
    this.config = { ...config };
  }

  /** Simulator-only: sample ground truth if a scan is due. */
  observe(now: number, ego: VehicleState, targets: VehicleState[]) {
    const c = this.config;
    if (now + 1e-9 < this.nextScan) return;
    this.nextScan = now + 1 / Math.max(1, c.updateRateHz);
    if (c.blackout) return;
    const vE = velocity(ego);
    const pose: EgoPose = { x: ego.x, y: ego.y, heading: ego.heading, vx: vE.x, vy: vE.y };
    for (const t of targets) {
      const dx = t.x - ego.x;
      const dy = t.y - ego.y;
      const range = Math.hypot(dx, dy);
      const azimuth = wrapAngle(Math.atan2(dy, dx) - ego.heading);
      if (range > c.maxRangeM || Math.abs(azimuth) > (c.fovDeg * DEG) / 2 + 1e-9) continue;
      if (this.rand() < c.dropoutProbability) continue;
      const vT = velocity(t);
      const rangeRate = range > 1e-9 ? ((vT.x - vE.x) * dx + (vT.y - vE.y) * dy) / range : 0;
      const corrupt = this.rand() < c.invalidProbability;
      this.queue.push({
        source: 'simulated',
        sensorId: 'sim-radar-0',
        objectId: t.id,
        captureTime: now,
        deliveryTime: now + c.latencyS,
        range: corrupt ? Number.NaN : range + gaussian(this.rand, c.rangeNoiseM),
        azimuth: azimuth + gaussian(this.rand, c.azimuthNoiseDeg * DEG),
        rangeRate: rangeRate + gaussian(this.rand, c.rangeRateNoiseMps),
        orientation: wrapAngle(t.heading - ego.heading + gaussian(this.rand, c.orientationNoiseDeg * DEG)),
        length: t.length,
        width: t.width,
        egoPose: pose,
      });
    }
  }

  poll(now: number): SensorMeasurement[] {
    const ready = this.queue.filter((m) => m.deliveryTime <= now + 1e-9);
    this.queue = this.queue.filter((m) => m.deliveryTime > now + 1e-9);
    return ready;
  }
}

export function isValidMeasurement(m: SensorMeasurement): boolean {
  const numbers = [m.captureTime, m.range, m.azimuth, m.rangeRate, m.orientation, m.length, m.width, m.egoPose.x, m.egoPose.y, m.egoPose.heading];
  return numbers.every(Number.isFinite) && m.range >= 0 && m.length > 0 && m.width > 0;
}
