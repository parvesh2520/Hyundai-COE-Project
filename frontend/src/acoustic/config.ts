/**
 * Hyundai Acoustic Shield: central prototype parameters.
 *
 * Every threshold the collision decision engine, sensor model and acoustic
 * controller use lives here. These are PROTOTYPE parameters chosen for an
 * engineering demonstrator. They are not certified automotive safety limits
 * and have not been calibrated against vehicle tests or clinical data.
 *
 * Units: metres, seconds, metres/second, metres/second², radians (degrees only
 * where the field name says Deg).
 */

export interface PhysicsConfig {
  /** Fixed simulation timestep (s). Physics never runs on the render frame rate. */
  fixedDtS: number;
  /** Upper bound on catch-up steps per rendered frame (prevents a spiral of death after a tab stall). */
  maxStepsPerFrame: number;
}

export interface PredictionConfig {
  /** Collision prediction horizon (s). Contacts later than this are not reported. */
  horizonS: number;
  /** Largest sampling step for the trajectory-propagation method (s). Reduced automatically at high relative speed. */
  maxSampleStepS: number;
  /** |a| and |yaw rate| below this are treated as zero, enabling the exact constant-velocity swept test. */
  constantMotionEps: number;
  /** Spacing of the predicted path points returned for visualisation (s). */
  pathSampleS: number;
}

export interface DecisionConfig {
  /** Collisions predicted with a lower closing speed (m/s) are only monitored (WATCH). */
  minClosingSpeedMps: number;
  /** Tracks below this confidence (0..1) cannot raise WARNING or CRITICAL. */
  minTrackConfidence: number;
  /** A predicted contact within this time (s) is a WARNING. */
  warningTtcS: number;
  /** A predicted contact within this time (s) is CRITICAL and may trigger protection. */
  criticalTtcS: number;
  /** No contact predicted, but closest approach (centre-to-centre, m) below this while closing is a WATCH. */
  watchCpaDistanceM: number;
  /** Sensor freshness limit (s): tracks whose newest measurement is older are not trusted. */
  maxSensorAgeS: number;
}

export interface ProtectionConfig {
  /**
   * Minimum time (s) the acoustic preconditioning stimulus must precede the predicted
   * impact. Covers audio-path latency plus an assumed reflex onset window. The
   * acoustic (stapedius) reflex onset reported in literature is roughly tens to
   * ~150 ms; 0.3 s is a conservative prototype placeholder that needs calibration.
   */
  requiredLeadTimeS: number;
  /** CRITICAL must persist this long (s) before activation (rejects single-sample noise). */
  activationConfirmS: number;
  /** After the predicted collision disappears, wait this long (s) before cancelling. */
  deactivateHoldS: number;
}

export interface SensorConfig {
  updateRateHz: number;
  /** Capture-to-delivery latency (s). */
  latencyS: number;
  maxRangeM: number;
  /** Total field of view (deg) centred on the ego heading. 360 = surround coverage (fused corner radars). */
  fovDeg: number;
  /** 1-sigma Gaussian noise. */
  rangeNoiseM: number;
  azimuthNoiseDeg: number;
  rangeRateNoiseMps: number;
  orientationNoiseDeg: number;
  /** Probability (0..1) that a detection is missing from a scan. */
  dropoutProbability: number;
  /** Probability (0..1) that a delivered detection is corrupt (NaN fields). */
  invalidProbability: number;
  /** When true the sensor delivers nothing (blackout), producing stale tracks. */
  blackout: boolean;
  /** PRNG seed: the whole simulation is deterministic for a given seed. */
  seed: number;
}

export interface TrackerConfig {
  /** Kalman process noise: white-jerk spectral density (m²/s⁵). Higher reacts faster to braking, but is noisier. */
  processNoiseJerk: number;
  /** Estimated longitudinal accelerations smaller than this (m/s²) are treated as zero in prediction. */
  accelDeadbandMps2: number;
  /** Tracks whose 1-sigma velocity uncertainty exceeds this (m/s) report zero confidence. */
  maxVelocityStdMps: number;
  /** Tracks are deleted after this long without a measurement (s). */
  deleteAfterS: number;
}

export interface EgoControlConfig {
  maxAccelMps2: number;
  maxBrakeMps2: number;
  /** Proportional speed-hold gain (1/s). */
  speedGain: number;
}

export interface AcousticShieldConfig {
  physics: PhysicsConfig;
  prediction: PredictionConfig;
  decision: DecisionConfig;
  protection: ProtectionConfig;
  sensor: SensorConfig;
  tracker: TrackerConfig;
  egoControl: EgoControlConfig;
}

export const DEFAULT_CONFIG: AcousticShieldConfig = {
  physics: { fixedDtS: 0.01, maxStepsPerFrame: 40 },
  prediction: { horizonS: 6, maxSampleStepS: 0.02, constantMotionEps: 1e-3, pathSampleS: 0.1 },
  decision: {
    minClosingSpeedMps: 1.0,
    minTrackConfidence: 0.6,
    warningTtcS: 3.0,
    criticalTtcS: 1.2,
    watchCpaDistanceM: 5.0,
    maxSensorAgeS: 0.25,
  },
  protection: { requiredLeadTimeS: 0.3, activationConfirmS: 0.03, deactivateHoldS: 0.15 },
  sensor: {
    updateRateHz: 20,
    latencyS: 0.05,
    maxRangeM: 150,
    fovDeg: 360,
    rangeNoiseM: 0.1,
    azimuthNoiseDeg: 0.15,
    rangeRateNoiseMps: 0.1,
    orientationNoiseDeg: 1,
    dropoutProbability: 0.02,
    invalidProbability: 0,
    blackout: false,
    seed: 20261109,
  },
  tracker: { processNoiseJerk: 2, accelDeadbandMps2: 1.5, maxVelocityStdMps: 0.8, deleteAfterS: 2 },
  egoControl: { maxAccelMps2: 2.5, maxBrakeMps2: 7, speedGain: 1.2 },
};

/** Noise-free, loss-free sensor: useful for validating the pipeline against ground truth. */
export const IDEAL_SENSOR: SensorConfig = {
  ...DEFAULT_CONFIG.sensor,
  latencyS: 0,
  rangeNoiseM: 0,
  azimuthNoiseDeg: 0,
  rangeRateNoiseMps: 0,
  orientationNoiseDeg: 0,
  dropoutProbability: 0,
  invalidProbability: 0,
};

export function cloneConfig(config: AcousticShieldConfig): AcousticShieldConfig {
  return {
    physics: { ...config.physics },
    prediction: { ...config.prediction },
    decision: { ...config.decision },
    protection: { ...config.protection },
    sensor: { ...config.sensor },
    tracker: { ...config.tracker },
    egoControl: { ...config.egoControl },
  };
}

export const KMH_PER_MPS = 3.6;
export const toKmh = (mps: number) => mps * KMH_PER_MPS;
export const fromKmh = (kmh: number) => kmh / KMH_PER_MPS;
export const DEG = Math.PI / 180;
