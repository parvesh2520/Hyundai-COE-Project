/**
 * Acoustic protection controller: turns threat assessments into simulated
 * preconditioning commands. Activation depends only on the assessment it is
 * given (predicted contact time, track trust); there is no countdown timer.
 * The two short time constants are debounce/hysteresis on the prediction itself.
 *
 * Commands go to ProtectionCommandSink implementations. In this prototype the
 * only sinks are the browser pink-noise generator and the event log. No sink
 * drives vehicle hardware.
 */

import type { ProtectionConfig } from './config.ts';
import type { ThreatAssessment } from './decision.ts';

export type ProtectionState = 'STANDBY' | 'ARMED' | 'ACTIVE' | 'IMPACT';

export interface ProtectionCommand {
  type: 'PRECONDITION_START' | 'PRECONDITION_STOP';
  time: number;
  targetId: string | null;
  /** Predicted time to contact when the command was issued (s). */
  ttc: number | null;
  reason: string;
}

export interface ProtectionCommandSink {
  send(command: ProtectionCommand): void;
}

export interface ActivationRecord {
  time: number;
  targetId: string | null;
  ttcAtActivation: number;
  /** ttc - required lead time: negative means the stimulus started too late. */
  leadMarginS: number;
  late: boolean;
  endedAt: number | null;
  endReason: string | null;
}

export class AcousticProtectionController {
  state: ProtectionState = 'STANDBY';
  activations: ActivationRecord[] = [];
  /** Predicted time remaining until impact while ACTIVE (s). */
  timeRemaining: number | null = null;
  private criticalSince: number | null = null;
  private clearSince: number | null = null;
  private config: ProtectionConfig;
  private sinks: ProtectionCommandSink[];

  constructor(config: ProtectionConfig, sinks: ProtectionCommandSink[] = []) {
    this.config = { ...config };
    this.sinks = sinks;
  }

  setConfig(config: ProtectionConfig) {
    this.config = { ...config };
  }

  get current(): ActivationRecord | null {
    const last = this.activations[this.activations.length - 1];
    return last && last.endedAt === null ? last : null;
  }

  private emit(command: ProtectionCommand) {
    for (const sink of this.sinks) sink.send(command);
  }

  update(now: number, assessment: ThreatAssessment): ProtectionState {
    if (this.state === 'IMPACT') return this.state;
    const primary = assessment.primary;
    const ttc = primary?.prediction.ttc ?? null;

    if (this.state === 'ACTIVE') {
      const stillPredicted = !!primary && primary.trusted && primary.prediction.collision;
      if (stillPredicted) {
        this.clearSince = null;
        this.timeRemaining = ttc;
        return this.state;
      }
      this.clearSince ??= now;
      if (now - this.clearSince + 1e-9 >= this.config.deactivateHoldS) {
        const reason = primary && !primary.trusted ? `Prediction no longer trusted: ${primary.reason}` : 'Predicted collision no longer present';
        this.stop(now, reason);
        this.state = assessment.level === 'WARNING' ? 'ARMED' : 'STANDBY';
      }
      return this.state;
    }

    if (assessment.protectionEligible && ttc !== null) {
      this.criticalSince ??= now;
      if (now - this.criticalSince + 1e-9 >= this.config.activationConfirmS) {
        const lead = ttc - this.config.requiredLeadTimeS;
        this.activations.push({
          time: now, targetId: primary?.targetId ?? null, ttcAtActivation: ttc,
          leadMarginS: lead, late: lead < 0, endedAt: null, endReason: null,
        });
        this.state = 'ACTIVE';
        this.timeRemaining = ttc;
        this.clearSince = null;
        this.emit({ type: 'PRECONDITION_START', time: now, targetId: primary?.targetId ?? null, ttc, reason: primary?.reason ?? '' });
        return this.state;
      }
    } else {
      this.criticalSince = null;
    }
    this.state = assessment.level === 'WARNING' || assessment.level === 'CRITICAL' ? 'ARMED' : 'STANDBY';
    return this.state;
  }

  private stop(now: number, reason: string) {
    const record = this.current;
    if (record) {
      record.endedAt = now;
      record.endReason = reason;
    }
    this.timeRemaining = null;
    this.criticalSince = null;
    this.clearSince = null;
    this.emit({ type: 'PRECONDITION_STOP', time: now, targetId: record?.targetId ?? null, ttc: null, reason });
  }

  /** Ground-truth contact occurred in the simulation. */
  notifyImpact(now: number) {
    if (this.current) this.stop(now, 'Impact reached');
    this.state = 'IMPACT';
  }

  reset() {
    if (this.current) this.stop(0, 'Reset');
    this.state = 'STANDBY';
    this.activations = [];
    this.timeRemaining = null;
    this.criticalSince = null;
    this.clearSince = null;
  }
}
