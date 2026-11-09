/**
 * Vehicle state and the deterministic motion model shared by the simulator and
 * the collision predictor.
 *
 * World frame: +x east, +y north, heading measured counter-clockwise from +x.
 * Motion model: point-mass bicycle approximation with longitudinal acceleration
 * and constant yaw rate (CTRA). Speed never goes negative: braking brings the
 * vehicle to a stop, it does not reverse it.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface VehicleState {
  id: string;
  label: string;
  kind: 'ego' | 'target';
  /** Footprint centre (m). */
  x: number;
  y: number;
  /** Heading (rad), CCW from +x. */
  heading: number;
  /** Speed along the heading (m/s, >= 0). */
  speed: number;
  /** Commanded longitudinal acceleration (m/s²). */
  accel: number;
  /** Yaw rate (rad/s), positive = turning left. */
  yawRate: number;
  length: number;
  width: number;
}

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const norm = (a: Vec2) => Math.hypot(a.x, a.y);

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Acceleration actually acting on the vehicle: a stopped car does not keep "braking". */
export function effectiveAccel(s: VehicleState): number {
  return s.speed <= 0 && s.accel < 0 ? 0 : s.accel;
}

export function velocity(s: VehicleState): Vec2 {
  return { x: s.speed * Math.cos(s.heading), y: s.speed * Math.sin(s.heading) };
}

/** Acceleration vector: longitudinal term plus centripetal term v·ω. */
export function accelVector(s: VehicleState): Vec2 {
  const a = effectiveAccel(s);
  const c = Math.cos(s.heading);
  const sn = Math.sin(s.heading);
  const lat = s.speed * s.yawRate;
  return { x: a * c - lat * sn, y: a * sn + lat * c };
}

/** Distance travelled and final speed over dt under constant longitudinal accel, stopping at zero. */
function longitudinal(speed: number, accel: number, dt: number): { distance: number; speed: number } {
  if (accel < 0 && speed + accel * dt <= 0) {
    if (speed <= 0) return { distance: 0, speed: 0 };
    const tStop = -speed / accel;
    return { distance: 0.5 * speed * tStop, speed: 0 };
  }
  return { distance: speed * dt + 0.5 * accel * dt * dt, speed: Math.max(0, speed + accel * dt) };
}

const YAW_SUBSTEP_S = 0.005;

/**
 * Advance a vehicle by dt. Straight-line motion is integrated exactly; with a
 * yaw rate the arc is integrated with 5 ms midpoint sub-steps.
 */
export function propagate(s: VehicleState, dt: number): VehicleState {
  if (dt <= 0) return { ...s };
  if (Math.abs(s.yawRate) < 1e-9) {
    const { distance, speed } = longitudinal(s.speed, s.accel, dt);
    return { ...s, x: s.x + distance * Math.cos(s.heading), y: s.y + distance * Math.sin(s.heading), speed };
  }
  const n = Math.max(1, Math.ceil(dt / YAW_SUBSTEP_S));
  const h = dt / n;
  let { x, y, heading, speed } = s;
  for (let i = 0; i < n; i++) {
    const step = longitudinal(speed, s.accel, h);
    if (step.distance <= 0 && step.speed <= 0) { speed = 0; break; }
    // Heading change proportional to the fraction of the sub-step spent moving.
    const moving = speed > 0 ? Math.min(1, step.distance / Math.max(1e-9, 0.5 * (speed + step.speed) * h)) : 0;
    const dHeading = s.yawRate * h * moving;
    const mid = heading + dHeading / 2;
    x += step.distance * Math.cos(mid);
    y += step.distance * Math.sin(mid);
    heading = wrapAngle(heading + dHeading);
    speed = step.speed;
  }
  return { ...s, x, y, heading, speed };
}

/** Oriented-rectangle footprint corners (CCW: front-left, rear-left, rear-right, front-right). */
export function corners(s: Pick<VehicleState, 'x' | 'y' | 'heading' | 'length' | 'width'>): Vec2[] {
  const c = Math.cos(s.heading);
  const sn = Math.sin(s.heading);
  const hl = s.length / 2;
  const hw = s.width / 2;
  const pt = (lx: number, ly: number): Vec2 => ({ x: s.x + lx * c - ly * sn, y: s.y + lx * sn + ly * c });
  return [pt(hl, hw), pt(-hl, hw), pt(-hl, -hw), pt(hl, -hw)];
}

/** Express a world point in a vehicle's body frame (x forward, y left). */
export function toBodyFrame(s: Pick<VehicleState, 'x' | 'y' | 'heading'>, p: Vec2): Vec2 {
  const dx = p.x - s.x;
  const dy = p.y - s.y;
  const c = Math.cos(s.heading);
  const sn = Math.sin(s.heading);
  return { x: dx * c + dy * sn, y: -dx * sn + dy * c };
}

export function fromBodyFrame(s: Pick<VehicleState, 'x' | 'y' | 'heading'>, p: Vec2): Vec2 {
  const c = Math.cos(s.heading);
  const sn = Math.sin(s.heading);
  return { x: s.x + p.x * c - p.y * sn, y: s.y + p.x * sn + p.y * c };
}
