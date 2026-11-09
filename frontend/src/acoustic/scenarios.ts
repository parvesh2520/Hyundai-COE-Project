/**
 * Test scenarios: initial conditions and driver inputs only. Every outcome is
 * computed by the same physics, sensing, prediction and decision pipeline.
 *
 * Road layout (left-hand traffic, as in India): intersection at the origin.
 * East-west road along x: eastbound lanes at y = +1.75 / +5.25.
 * North-south road along y: southbound lanes at x = +1.75 / +5.25.
 */

import { fromKmh } from './config.ts';
import type { VehicleState } from './vehicle.ts';

export const LANE_WIDTH = 3.5;
export const ROAD_HALF_WIDTH = 2 * LANE_WIDTH;
export const SEDAN = { length: 4.6, width: 1.8 };

/** A driver input applied when simulation time reaches `at` (e.g. the other driver brakes). */
export interface DriverEvent {
  at: number;
  vehicleId: string;
  accel?: number;
  yawRate?: number;
  note: string;
}

export interface Scenario {
  id: string;
  name: string;
  summary: string;
  expectation: string;
  ego: VehicleState;
  egoSetSpeed: number;
  targets: VehicleState[];
  events: DriverEvent[];
}

const EAST = 0;
const WEST = Math.PI;
const SOUTH = -Math.PI / 2;

const ego = (x: number, kmh: number): VehicleState => ({
  id: 'ego', label: 'Hyundai (ego)', kind: 'ego', x, y: LANE_WIDTH / 2, heading: EAST,
  speed: fromKmh(kmh), accel: 0, yawRate: 0, ...SEDAN,
});

const target = (id: string, label: string, x: number, y: number, heading: number, kmh: number, accel = 0): VehicleState => ({
  id, label, kind: 'target', x, y, heading, speed: fromKmh(kmh), accel, yawRate: 0, ...SEDAN,
});

export const SCENARIOS: Scenario[] = [
  {
    id: 'side',
    name: 'A · Side impact at intersection',
    summary: 'Hyundai crosses the junction at 50 km/h; a car from the left runs the junction at 45 km/h.',
    expectation: 'Footprints intersect in the junction: contact predicted at ~4.94 s, CRITICAL, protection activates before impact.',
    ego: ego(-70, 50), egoSetSpeed: fromKmh(50),
    targets: [target('t1', 'Sedan from left', LANE_WIDTH / 2, 66, SOUTH, 45)],
    events: [],
  },
  {
    id: 'rear',
    name: 'B · Rear-end',
    summary: 'Hyundai at 40 km/h; a car closes from behind in the same lane at 80 km/h.',
    expectation: 'Same-lane closing at 11.1 m/s from a 45.4 m gap: contact at ~4.09 s.',
    ego: ego(-60, 40), egoSetSpeed: fromKmh(40),
    targets: [target('t1', 'Fast follower', -110, LANE_WIDTH / 2, EAST, 80)],
    events: [],
  },
  {
    id: 'headon',
    name: 'C · Head-on',
    summary: 'Hyundai at 50 km/h; an oncoming car at 60 km/h is in the Hyundai lane.',
    expectation: 'Closing at 30.6 m/s from a 135.4 m gap: contact at ~4.43 s.',
    ego: ego(-80, 50), egoSetSpeed: fromKmh(50),
    targets: [target('t1', 'Wrong-way car', 60, LANE_WIDTH / 2, WEST, 60)],
    events: [],
  },
  {
    id: 'nearmiss',
    name: 'D · Near miss',
    summary: 'Same junction as A, but the crossing car arrives 0.8 s earlier and clears the Hyundai lane.',
    expectation: 'Paths come close but footprints never intersect: no collision predicted.',
    ego: ego(-70, 50), egoSetSpeed: fromKmh(50),
    targets: [target('t1', 'Sedan from left', LANE_WIDTH / 2, 56, SOUTH, 45)],
    events: [],
  },
  {
    id: 'avoided',
    name: 'E · Avoided collision',
    summary: 'As A, but the crossing driver brakes hard (8 m/s²) at t = 3.85 s.',
    expectation: 'Contact predicted, then the prediction disappears as the car stops 3 m short; protection cancels.',
    ego: ego(-70, 50), egoSetSpeed: fromKmh(50),
    targets: [target('t1', 'Sedan from left', LANE_WIDTH / 2, 66, SOUTH, 45)],
    events: [{ at: 3.85, vehicleId: 't1', accel: -8, note: 'Crossing driver brakes at 8 m/s²' }],
  },
  {
    id: 'stationary',
    name: 'F · Stationary obstacle',
    summary: 'Hyundai at 50 km/h approaches a stopped car in its lane beyond the junction.',
    expectation: 'Contact at ~8.31 s; it enters the 6 s horizon when the gap falls to 83.3 m.',
    ego: ego(-80, 50), egoSetSpeed: fromKmh(50),
    targets: [target('t1', 'Stopped car', 40, LANE_WIDTH / 2, EAST, 0)],
    events: [],
  },
];
