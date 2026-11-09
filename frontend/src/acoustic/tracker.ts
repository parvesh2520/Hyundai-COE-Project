/**
 * Object tracking layer: SensorMeasurement -> ObjectTrack.
 *
 * Linear Kalman filter per object with a constant-acceleration (white jerk)
 * motion model. Polar measurements are converted to world coordinates using
 * the ego pose captured with them; their covariance is the polar noise
 * propagated through the conversion Jacobian. Radar range-rate is fused as a
 * scalar measurement of the line-of-sight velocity. Association is by the
 * sensor's object id (radar object lists carry persistent ids).
 */

import { DEG, type SensorConfig, type TrackerConfig } from './config.ts';
import { isValidMeasurement, type SensorMeasurement } from './sensors.ts';
import { wrapAngle, type VehicleState } from './vehicle.ts';

type Mat = number[][];
const zeros = (r: number, c: number): Mat => Array.from({ length: r }, () => new Array<number>(c).fill(0));
const symmetrize = (a: Mat) => {
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) a[i][j] = a[j][i] = (a[i][j] + a[j][i]) / 2;
};

/** State layout: [x, vx, ax, y, vy, ay]. */
const IX = 0;
const IVX = 1;
const IY = 3;
const IVY = 4;

export interface ObjectTrack {
  trackId: string;
  objectId: string;
  /** Kalman state [x, vx, ax, y, vy, ay] at the latest measurement capture time (world frame). */
  state: number[];
  covariance: Mat;
  /** Object orientation reported by the sensor (rad, world frame). */
  heading: number;
  length: number;
  width: number;
  lastCaptureTime: number;
  updates: number;
  /** 0..1, grows with consistent updates, decays with missed scans. */
  quality: number;
}

export interface TrackView {
  track: ObjectTrack;
  /** now - lastCaptureTime (s). */
  ageS: number;
  stale: boolean;
  confidence: number;
  /** 1-sigma velocity uncertainty of the estimate (m/s). */
  velocityStd: number;
  /** Track extrapolated to `now` as a vehicle state usable by the predictor. */
  state: VehicleState;
}

export class ObjectTracker {
  config: TrackerConfig;
  private sensor: SensorConfig;
  private tracks = new Map<string, ObjectTrack>();

  constructor(config: TrackerConfig, sensor: SensorConfig) {
    this.config = { ...config };
    this.sensor = { ...sensor };
  }

  /** Measurement noise model and scan rate expected from the sensor. */
  setSensorModel(sensor: SensorConfig) {
    this.sensor = { ...sensor };
  }

  private noise() {
    // Floors keep the filter well-conditioned when the simulated sensor is ideal.
    return {
      range: Math.max(this.sensor.rangeNoiseM, 0.02),
      azimuth: Math.max(this.sensor.azimuthNoiseDeg, 0.01) * DEG,
      rangeRate: Math.max(this.sensor.rangeRateNoiseMps, 0.02),
    };
  }

  private predict(t: ObjectTrack, dt: number) {
    const F = [[1, dt, 0.5 * dt * dt], [0, 1, dt], [0, 0, 1]];
    const d2 = dt * dt, d3 = d2 * dt, d4 = d3 * dt, d5 = d4 * dt;
    const q = this.config.processNoiseJerk;
    const Q = [[d5 / 20, d4 / 8, d3 / 6], [d4 / 8, d3 / 3, d2 / 2], [d3 / 6, d2 / 2, dt]];
    // The two axes share F and Q; cross-axis blocks transform as F·P·Fᵀ too.
    const P = t.covariance;
    const next = zeros(6, 6);
    for (const oi of [0, 3]) for (const oj of [0, 3]) {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let v = 0;
        for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) v += F[i][k] * P[oi + k][oj + l] * F[j][l];
        next[oi + i][oj + j] = v + (oi === oj ? q * Q[i][j] : 0);
      }
    }
    t.covariance = next;
    const s = t.state;
    t.state = [
      s[0] + s[1] * dt + 0.5 * s[2] * d2, s[1] + s[2] * dt, s[2],
      s[3] + s[4] * dt + 0.5 * s[5] * d2, s[4] + s[5] * dt, s[5],
    ];
  }

  private correct(t: ObjectTrack, m: SensorMeasurement) {
    const n = this.noise();
    const bearing = m.egoPose.heading + m.azimuth;
    const c = Math.cos(bearing);
    const s = Math.sin(bearing);
    const z = [m.egoPose.x + m.range * c, m.egoPose.y + m.range * s];
    // R = J·diag(σr², σθ²)·Jᵀ with J = ∂(x,y)/∂(r,θ).
    const sr2 = n.range * n.range;
    const st2 = (m.range * n.azimuth) ** 2;
    const R = [[c * c * sr2 + s * s * st2, c * s * (sr2 - st2)], [c * s * (sr2 - st2), s * s * sr2 + c * c * st2]];
    let P = t.covariance;
    const S00 = P[IX][IX] + R[0][0], S01 = P[IX][IY] + R[0][1], S10 = P[IY][IX] + R[1][0], S11 = P[IY][IY] + R[1][1];
    const det = S00 * S11 - S01 * S10;
    const Si = [[S11 / det, -S01 / det], [-S10 / det, S00 / det]];
    const K = P.map((row) => [row[IX] * Si[0][0] + row[IY] * Si[1][0], row[IX] * Si[0][1] + row[IY] * Si[1][1]]);
    const ix = z[0] - t.state[IX];
    const iy = z[1] - t.state[IY];
    t.state = t.state.map((v, i) => v + K[i][0] * ix + K[i][1] * iy);
    t.covariance = P.map((row, i) => row.map((v, j) => v - (K[i][0] * P[IX][j] + K[i][1] * P[IY][j])));
    symmetrize(t.covariance);

    // Doppler: line-of-sight velocity of the target in the world frame.
    P = t.covariance;
    const zr = m.rangeRate + m.egoPose.vx * c + m.egoPose.vy * s;
    const Ph = P.map((row) => row[IVX] * c + row[IVY] * s);
    const sr = Ph[IVX] * c + Ph[IVY] * s + n.rangeRate * n.rangeRate;
    const innov = zr - (t.state[IVX] * c + t.state[IVY] * s);
    const Kd = Ph.map((v) => v / sr);
    t.state = t.state.map((v, i) => v + Kd[i] * innov);
    t.covariance = P.map((row, i) => row.map((v, j) => v - Kd[i] * Ph[j]));
    symmetrize(t.covariance);
  }

  /** Returns ids of tracks created and deleted, and the number of rejected measurements. */
  update(measurements: SensorMeasurement[], now: number): { created: string[]; deleted: string[]; rejected: number } {
    const created: string[] = [];
    let rejected = 0;
    const ordered = [...measurements].sort((a, b) => a.captureTime - b.captureTime);
    for (const m of ordered) {
      if (!isValidMeasurement(m)) { rejected++; continue; }
      let track = this.tracks.get(m.objectId);
      if (!track) {
        const bearing = m.egoPose.heading + m.azimuth;
        const P = zeros(6, 6);
        P[0][0] = P[3][3] = 25;
        P[1][1] = P[4][4] = 900; // velocity unknown: ±30 m/s
        P[2][2] = P[5][5] = 25;
        track = {
          trackId: `T-${m.objectId}`, objectId: m.objectId,
          state: [m.egoPose.x + m.range * Math.cos(bearing), 0, 0, m.egoPose.y + m.range * Math.sin(bearing), 0, 0],
          covariance: P, heading: 0, length: m.length, width: m.width, lastCaptureTime: m.captureTime, updates: 0, quality: 0.3,
        };
        this.tracks.set(m.objectId, track);
        created.push(track.trackId);
      } else {
        const dt = m.captureTime - track.lastCaptureTime;
        if (dt <= 1e-6) { rejected++; continue; } // duplicate or out-of-order sample
        this.predict(track, dt);
        const missedScans = Math.max(0, Math.round(dt * this.sensor.updateRateHz) - 1);
        track.quality = track.quality * Math.pow(0.7, missedScans);
        track.quality += 0.3 * (1 - track.quality);
      }
      this.correct(track, m);
      track.heading = wrapAngle(m.egoPose.heading + m.orientation);
      track.length = m.length;
      track.width = m.width;
      track.lastCaptureTime = m.captureTime;
      track.updates++;
    }
    const deleted: string[] = [];
    for (const [id, t] of this.tracks) {
      if (now - t.lastCaptureTime > this.config.deleteAfterS) {
        this.tracks.delete(id);
        deleted.push(t.trackId);
      }
    }
    return { created, deleted, rejected };
  }

  drop(objectId: string) {
    this.tracks.delete(objectId);
  }

  views(now: number, maxAgeS: number): TrackView[] {
    const out: TrackView[] = [];
    for (const t of this.tracks.values()) {
      const age = Math.max(0, now - t.lastCaptureTime);
      const stale = age > maxAgeS;
      const freshness = stale ? Math.max(0, 1 - (age - maxAgeS) / maxAgeS) : 1;
      const [x, vx0, ax, y, vy0, ay] = t.state;
      // Latency compensation: extrapolate the estimate to the present.
      const vx = vx0 + ax * age;
      const vy = vy0 + ay * age;
      const speed = Math.hypot(vx, vy);
      const heading = speed > 0.5 ? Math.atan2(vy, vx) : t.heading;
      const rawAccel = speed > 0.5 ? (ax * vx + ay * vy) / speed : 0;
      // Small acceleration estimates are mostly noise and dominate long-horizon error.
      const accel = Math.abs(rawAccel) >= this.config.accelDeadbandMps2 ? rawAccel : 0;
      const velocityStd = Math.sqrt(Math.max(0, t.covariance[IVX][IVX] + t.covariance[IVY][IVY]));
      // A track whose velocity is still poorly known carries no confidence.
      const settled = velocityStd <= this.config.maxVelocityStdMps;
      out.push({
        track: t,
        ageS: age,
        stale,
        velocityStd,
        confidence: settled ? t.quality * freshness : 0,
        state: {
          id: t.objectId, label: t.trackId, kind: 'target',
          x: x + vx0 * age + 0.5 * ax * age * age,
          y: y + vy0 * age + 0.5 * ay * age * age,
          heading, speed, accel, yawRate: 0, length: t.length, width: t.width,
        },
      });
    }
    return out;
  }
}
