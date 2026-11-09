/**
 * Collision-risk decision engine. Pure function of the current predictions and
 * track quality; no timers, no knowledge of the scenario or the UI.
 */

import type { DecisionConfig } from './config.ts';
import type { CollisionPrediction } from './collision.ts';
import type { TrackView } from './tracker.ts';

export type ThreatLevel = 'NORMAL' | 'WATCH' | 'WARNING' | 'CRITICAL';

export const LEVEL_RANK: Record<ThreatLevel, number> = { NORMAL: 0, WATCH: 1, WARNING: 2, CRITICAL: 3 };

export interface TargetAssessment {
  targetId: string;
  level: ThreatLevel;
  reason: string;
  /** Track quality gates (confidence, freshness) passed: the prediction may drive protection. */
  trusted: boolean;
  prediction: CollisionPrediction;
  confidence: number;
  ageS: number;
}

export interface ThreatAssessment {
  level: ThreatLevel;
  /** The most severe target, null when nothing is tracked. */
  primary: TargetAssessment | null;
  targets: TargetAssessment[];
  /** CRITICAL from a trusted track: protection may be commanded. */
  protectionEligible: boolean;
  /** At least one track was ignored because of low confidence or stale data. */
  degraded: boolean;
}

export interface SafetyDecisionEngine {
  evaluate(input: { tracks: { view: TrackView; prediction: CollisionPrediction }[]; config: DecisionConfig }): ThreatAssessment;
}

const fmt = (n: number) => n.toFixed(2);

export function assessTarget(view: TrackView, p: CollisionPrediction, c: DecisionConfig): TargetAssessment {
  const base = { targetId: p.targetId, prediction: p, confidence: view.confidence, ageS: view.ageS };
  if (view.stale) {
    return { ...base, level: 'NORMAL', trusted: false, reason: `Sensor data stale (${fmt(view.ageS)} s > ${fmt(c.maxSensorAgeS)} s): not used for protection` };
  }
  if (view.confidence < c.minTrackConfidence) {
    const watch = p.collision;
    return { ...base, level: watch ? 'WATCH' : 'NORMAL', trusted: false, reason: `Track confidence ${Math.round(view.confidence * 100)}% below ${Math.round(c.minTrackConfidence * 100)}%` };
  }
  if (p.collision && p.ttc !== null) {
    if (p.closingSpeed < c.minClosingSpeedMps && p.ttc > 0) {
      return { ...base, level: 'WATCH', trusted: true, reason: `Contact predicted at ${fmt(p.ttc)} s but closing speed ${fmt(p.closingSpeed)} m/s is below ${fmt(c.minClosingSpeedMps)} m/s` };
    }
    if (p.ttc <= c.criticalTtcS) return { ...base, level: 'CRITICAL', trusted: true, reason: `Footprint contact predicted in ${fmt(p.ttc)} s (critical <= ${fmt(c.criticalTtcS)} s)` };
    if (p.ttc <= c.warningTtcS) return { ...base, level: 'WARNING', trusted: true, reason: `Footprint contact predicted in ${fmt(p.ttc)} s (warning <= ${fmt(c.warningTtcS)} s)` };
    return { ...base, level: 'WATCH', trusted: true, reason: `Contact predicted in ${fmt(p.ttc)} s, outside the warning window` };
  }
  if (p.closingSpeed > 0 && p.tCpa > 0 && p.tCpa < p.horizonS && p.dCpa < c.watchCpaDistanceM) {
    return { ...base, level: 'WATCH', trusted: true, reason: `No contact predicted; closest approach ${fmt(p.dCpa)} m in ${fmt(p.tCpa)} s` };
  }
  return { ...base, level: 'NORMAL', trusted: true, reason: `No contact predicted within ${fmt(p.horizonS)} s` };
}

export class ThresholdDecisionEngine implements SafetyDecisionEngine {
  evaluate({ tracks, config }: Parameters<SafetyDecisionEngine['evaluate']>[0]): ThreatAssessment {
    const targets = tracks.map(({ view, prediction }) => assessTarget(view, prediction, config));
    let primary: TargetAssessment | null = null;
    for (const t of targets) {
      if (!primary) { primary = t; continue; }
      const rank = LEVEL_RANK[t.level] - LEVEL_RANK[primary.level];
      const ttc = t.prediction.ttc ?? Infinity;
      const pTtc = primary.prediction.ttc ?? Infinity;
      if (rank > 0 || (rank === 0 && (ttc < pTtc || (ttc === pTtc && t.prediction.range < primary.prediction.range)))) primary = t;
    }
    return {
      level: primary?.level ?? 'NORMAL',
      primary,
      targets,
      protectionEligible: !!primary && primary.level === 'CRITICAL' && primary.trusted,
      degraded: targets.some((t) => !t.trusted),
    };
  }
}
