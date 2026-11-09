/**
 * Collision prediction between two vehicles with oriented rectangular footprints.
 *
 * Two methods, chosen automatically:
 *  - analytic-swept-sat: both vehicles move at constant velocity without yaw.
 *    Their footprints then only translate relative to each other, so the
 *    separating-axis theorem gives exact entry/exit times per axis and the
 *    earliest contact is the latest entry time (if it precedes the earliest exit).
 *  - sampled-trajectory: acceleration or yaw present. Both trajectories are
 *    propagated with the same motion model as the simulator; the step is
 *    bounded so relative displacement per step is at most a quarter of the
 *    smallest footprint dimension, and the first overlap is refined by bisection.
 */

import type { PredictionConfig } from './config.ts';
import { accelVector, corners, dot, effectiveAccel, norm, propagate, sub, velocity, type Vec2, type VehicleState } from './vehicle.ts';

export type PredictionMethod = 'analytic-swept-sat' | 'sampled-trajectory' | 'already-overlapping';

export interface CollisionPrediction {
  targetId: string;
  /** Footprint contact predicted within the horizon. */
  collision: boolean;
  /** Earliest predicted footprint contact (s from now), null when none within the horizon. */
  ttc: number | null;
  method: PredictionMethod;
  horizonS: number;
  /** Relative position r = p_target - p_ego (m, world frame). */
  relPos: Vec2;
  /** Relative velocity v_rel = v_target - v_ego (m/s). */
  relVel: Vec2;
  /** Relative acceleration a_target - a_ego (m/s²). */
  relAccel: Vec2;
  /** Centre-to-centre range |r| (m). */
  range: number;
  /** Current footprint-to-footprint gap (m), 0 when overlapping. */
  gap: number;
  /** -(r·v_rel)/|r| (m/s): positive when the vehicles are getting closer. */
  closingSpeed: number;
  /** Time of closest approach under constant relative velocity, clamped to [0, horizon] (s). */
  tCpa: number;
  /** Centre-to-centre separation at t_CPA (m). */
  dCpa: number;
  egoAtContact: VehicleState | null;
  targetAtContact: VehicleState | null;
  contactPoint: Vec2 | null;
  /** Predicted centre tracks (for display), sampled every pathSampleS up to contact or horizon. */
  egoPath: Vec2[];
  targetPath: Vec2[];
}

// ---------------------------------------------------------------- polygon geometry

function axesOf(poly: Vec2[]): Vec2[] {
  // A rectangle has two unique edge normals.
  const out: Vec2[] = [];
  for (let i = 0; i < 2; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    out.push({ x: -ey / len, y: ex / len });
  }
  return out;
}

function project(poly: Vec2[], axis: Vec2): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/** Separating-axis overlap test for two oriented rectangles (touching counts as contact). */
export function rectanglesOverlap(a: Vec2[], b: Vec2[]): boolean {
  for (const axis of [...axesOf(a), ...axesOf(b)]) {
    const [aMin, aMax] = project(a, axis);
    const [bMin, bMax] = project(b, axis);
    if (aMax < bMin || bMax < aMin) return false;
  }
  return true;
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2)) : 0;
  return Math.hypot(p.x - (a.x + ab.x * t), p.y - (a.y + ab.y * t));
}

/** Minimum distance between two convex polygons (0 when they overlap). */
export function polygonGap(a: Vec2[], b: Vec2[]): number {
  if (rectanglesOverlap(a, b)) return 0;
  let best = Infinity;
  for (const [poly, other] of [[a, b], [b, a]] as const) {
    for (const p of poly) {
      for (let i = 0; i < other.length; i++) {
        best = Math.min(best, pointSegmentDistance(p, other[i], other[(i + 1) % other.length]));
      }
    }
  }
  return best;
}

/**
 * Exact earliest contact time for polygon b translating with velocity vRel
 * relative to a fixed polygon a (both convex). Returns null when no contact in [0, tMax].
 */
export function sweptContactTime(a: Vec2[], b: Vec2[], vRel: Vec2, tMax: number): number | null {
  let tEnter = -Infinity;
  let tExit = Infinity;
  for (const axis of [...axesOf(a), ...axesOf(b)]) {
    const [aMin, aMax] = project(a, axis);
    const [bMin, bMax] = project(b, axis);
    const v = vRel.x * axis.x + vRel.y * axis.y;
    if (Math.abs(v) < 1e-12) {
      if (bMax < aMin || aMax < bMin) return null; // separated forever on this axis
      continue;
    }
    const t1 = (aMin - bMax) / v;
    const t2 = (aMax - bMin) / v;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return null;
  }
  if (tExit < 0 || tEnter > tMax) return null;
  return Math.max(0, tEnter);
}

/** A corner of one footprint inside the other, else the midpoint between centres. */
function contactPointOf(ego: VehicleState, target: VehicleState): Vec2 {
  const a = corners(ego);
  const b = corners(target);
  const inside = (p: Vec2, poly: Vec2[]) => rectanglesOverlap([p, p, p, p], poly);
  const hits = [...b.filter((p) => inside(p, a)), ...a.filter((p) => inside(p, b))];
  if (hits.length) {
    return { x: hits.reduce((s, p) => s + p.x, 0) / hits.length, y: hits.reduce((s, p) => s + p.y, 0) / hits.length };
  }
  return { x: (ego.x + target.x) / 2, y: (ego.y + target.y) / 2 };
}

// ---------------------------------------------------------------- closest approach

/** t_CPA = -(r·v)/|v|², clamped to [0, horizon]; d_CPA = |r + v·t_CPA|. */
export function closestApproach(r: Vec2, v: Vec2, horizonS: number): { tCpa: number; dCpa: number } {
  const v2 = dot(v, v);
  if (v2 < 1e-12) return { tCpa: 0, dCpa: norm(r) }; // no relative motion: separation is constant
  const t = Math.max(0, Math.min(horizonS, -dot(r, v) / v2));
  return { tCpa: t, dCpa: Math.hypot(r.x + v.x * t, r.y + v.y * t) };
}

// ---------------------------------------------------------------- prediction

function isConstantVelocity(s: VehicleState, eps: number) {
  return Math.abs(effectiveAccel(s)) < eps && Math.abs(s.yawRate) < eps;
}

function linearPath(s: VehicleState, until: number, every: number): Vec2[] {
  const v = velocity(s);
  const out: Vec2[] = [];
  for (let t = 0; t <= until + 1e-9; t += every) out.push({ x: s.x + v.x * t, y: s.y + v.y * t });
  return out;
}

export function predictCollision(ego: VehicleState, target: VehicleState, cfg: PredictionConfig): CollisionPrediction {
  const horizon = cfg.horizonS;
  const relPos = sub(target, ego);
  const vE = velocity(ego);
  const vT = velocity(target);
  const relVel = sub(vT, vE);
  const relAccel = sub(accelVector(target), accelVector(ego));
  const range = norm(relPos);
  const closingSpeed = range > 1e-9 ? -dot(relPos, relVel) / range : 0;
  const { tCpa, dCpa } = closestApproach(relPos, relVel, horizon);
  const egoPoly = corners(ego);
  const targetPoly = corners(target);
  const gap = polygonGap(egoPoly, targetPoly);

  const base = { targetId: target.id, horizonS: horizon, relPos, relVel, relAccel, range, gap, closingSpeed, tCpa, dCpa };

  if (gap === 0) {
    return {
      ...base, collision: true, ttc: 0, method: 'already-overlapping',
      egoAtContact: { ...ego }, targetAtContact: { ...target }, contactPoint: contactPointOf(ego, target),
      egoPath: [{ x: ego.x, y: ego.y }], targetPath: [{ x: target.x, y: target.y }],
    };
  }

  if (isConstantVelocity(ego, cfg.constantMotionEps) && isConstantVelocity(target, cfg.constantMotionEps)) {
    const ttc = sweptContactTime(egoPoly, targetPoly, relVel, horizon);
    const until = ttc ?? horizon;
    if (ttc === null) {
      return {
        ...base, collision: false, ttc: null, method: 'analytic-swept-sat',
        egoAtContact: null, targetAtContact: null, contactPoint: null,
        egoPath: linearPath(ego, until, cfg.pathSampleS), targetPath: linearPath(target, until, cfg.pathSampleS),
      };
    }
    const egoC = propagate(ego, ttc);
    const tgtC = propagate(target, ttc);
    return {
      ...base, collision: true, ttc, method: 'analytic-swept-sat',
      egoAtContact: egoC, targetAtContact: tgtC, contactPoint: contactPointOf(egoC, tgtC),
      egoPath: [...linearPath(ego, until, cfg.pathSampleS), { x: egoC.x, y: egoC.y }],
      targetPath: [...linearPath(target, until, cfg.pathSampleS), { x: tgtC.x, y: tgtC.y }],
    };
  }

  // Sampled trajectory propagation with a speed-bounded step.
  const minDim = Math.min(ego.length, ego.width, target.length, target.width);
  const speedBound = ego.speed + target.speed + (Math.abs(ego.accel) + Math.abs(target.accel)) * horizon
    + (ego.speed * Math.abs(ego.yawRate) + target.speed * Math.abs(target.yawRate)) * horizon;
  const step = Math.max(0.002, Math.min(cfg.maxSampleStepS, (0.25 * minDim) / Math.max(speedBound, 1e-6)));

  const egoPath: Vec2[] = [{ x: ego.x, y: ego.y }];
  const targetPath: Vec2[] = [{ x: target.x, y: target.y }];
  let nextPathT = cfg.pathSampleS;
  let prevE = ego;
  let prevT = target;
  let prevTime = 0;
  while (prevTime < horizon - 1e-12) {
    const dt = Math.min(step, horizon - prevTime);
    const e = propagate(prevE, dt);
    const t = propagate(prevT, dt);
    const time = prevTime + dt;
    if (rectanglesOverlap(corners(e), corners(t))) {
      // Bisection on [prevTime, time] for the first overlap instant.
      let lo = 0;
      let hi = dt;
      for (let i = 0; i < 30 && hi - lo > 1e-6; i++) {
        const mid = (lo + hi) / 2;
        if (rectanglesOverlap(corners(propagate(prevE, mid)), corners(propagate(prevT, mid)))) hi = mid;
        else lo = mid;
      }
      const egoC = propagate(prevE, hi);
      const tgtC = propagate(prevT, hi);
      egoPath.push({ x: egoC.x, y: egoC.y });
      targetPath.push({ x: tgtC.x, y: tgtC.y });
      return {
        ...base, collision: true, ttc: prevTime + hi, method: 'sampled-trajectory',
        egoAtContact: egoC, targetAtContact: tgtC, contactPoint: contactPointOf(egoC, tgtC), egoPath, targetPath,
      };
    }
    if (time >= nextPathT - 1e-9) {
      egoPath.push({ x: e.x, y: e.y });
      targetPath.push({ x: t.x, y: t.y });
      nextPathT += cfg.pathSampleS;
    }
    prevE = e;
    prevT = t;
    prevTime = time;
  }
  return {
    ...base, collision: false, ttc: null, method: 'sampled-trajectory',
    egoAtContact: null, targetAtContact: null, contactPoint: null, egoPath, targetPath,
  };
}
