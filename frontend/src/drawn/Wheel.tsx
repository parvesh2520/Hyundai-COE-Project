import { useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import type { CarState, Intent } from '../types';
import { carAudio } from '../lib/audio';
import { Part } from './Part';
import { RIM, WHEEL, ellipsePath } from './geometry';

const BOX = { x: WHEEL.cx - 256, y: 226, w: 514, h: 480 };
/** The spokes, switch pads and keys are drawn symmetric about SX, then moved onto the rim's centre. */
const SX = 1561;
const DX = WHEEL.cx - SX;
/** The airbag pad and badge are drawn centred at x 1557. */
const HUB_DX = WHEEL.cx - 1557;
/** The stalks were drawn for a column at x 1572. */
const COLUMN_DX = WHEEL.cx - 1572;
const mirror = (x: number) => 2 * SX - x;

/** Point on the rim's ellipse at `deg` (clockwise from 3 o'clock), `k` = fraction of the outer radius. */
const onRim = (deg: number, k: number) => {
  const a = (deg * Math.PI) / 180;
  return [WHEEL.cx + Math.cos(a) * WHEEL.rx * k, WHEEL.cy + Math.sin(a) * WHEEL.ry * k] as const;
};

/** Elliptical ring bands used to keep the perforated leather on the hand grips only. */
const ringBand = (a0: number, a1: number) => {
  const [ox0, oy0] = onRim(a0, 1);
  const [ox1, oy1] = onRim(a1, 1);
  const [ix0, iy0] = onRim(a0, WHEEL.irx / WHEEL.rx);
  const [ix1, iy1] = onRim(a1, WHEEL.irx / WHEEL.rx);
  return `M${ox0.toFixed(1)} ${oy0.toFixed(1)} A${WHEEL.rx} ${WHEEL.ry} 0 0 1 ${ox1.toFixed(1)} ${oy1.toFixed(1)} L${ix1.toFixed(1)} ${iy1.toFixed(1)} A${WHEEL.irx} ${WHEEL.iry} 0 0 0 ${ix0.toFixed(1)} ${iy0.toFixed(1)} Z`;
};
const GRIP_BANDS = [ringBand(148, 212), ringBand(328, 392)];
/** Seams where the perforated grip panels meet the smooth leather, at roughly 10, 8, 2 and 4 o'clock. */
const SEAMS = [205, 148, 335, 32].map((deg) => {
  const [x0, y0] = onRim(deg, WHEEL.irx / WHEEL.rx);
  const [x1, y1] = onRim(deg, 1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)}`;
});

/** Lower spoke: one symmetric V, its outer edges trimmed in chrome, running down into the rim. */
const V_EDGE = `M1450 516 L1490 628 Q1497 647 1518 649 L${mirror(1518)} 649 Q${mirror(1497)} 647 ${mirror(1490)} 628 L${mirror(1450)} 516`;
const V_BODY = `M1450 516 L1490 628 Q1496 640 1492 690 L${mirror(1492)} 690 Q${mirror(1496)} 640 ${mirror(1490)} 628 L${mirror(1450)} 516 Q${SX} 548 1450 516 Z`;
/** Left switch pad; the right one is its mirror image. */
const PAD = 'M1378 434 Q1416 427 1454 432 L1455 504 Q1416 506 1386 499 Q1374 490 1374 468 Q1374 446 1378 434 Z';
const HUB = 'M1476 420 Q1557 406 1640 420 Q1662 427 1661 470 Q1657 538 1600 554 Q1557 562 1516 554 Q1458 538 1454 470 Q1453 427 1476 420 Z';
const HUB_FACE = 'M1481 426 Q1557 413 1635 426 Q1654 432 1653 470 Q1649 532 1597 547 Q1557 555 1519 547 Q1466 532 1462 470 Q1461 432 1481 426 Z';

/** Both switch pads share one grid: an outer and an inner column, three rows with a chrome bar above the last. */
const KEY_COLS = { outer: 1404, inner: 1432 };
const KEY_ROWS = [445, 463, 490];
const KEY_W = 24;
const KEY_H = 14;
/** Column x on the left pad, or its mirror on the right pad. */
const col = (side: 'left' | 'right', c: keyof typeof KEY_COLS) => (side === 'left' ? KEY_COLS[c] : mirror(KEY_COLS[c]));

/** A physical switch: dark cap in a recess, a faint top edge and a softly lit glyph, drawn about (0, 0). */
function Key({ x, y, w = KEY_W, h = KEY_H, label, onClick, children }: {
  x: number; y: number; w?: number; h?: number; label: string; onClick: () => void; children: ReactNode;
}) {
  return (
    <g className="hit btn key" onClick={(e) => { e.stopPropagation(); onClick(); }} onPointerDown={(e) => e.stopPropagation()} role="button" aria-label={label}>
      <title>{label}</title>
      <rect x={x - w / 2 - 0.8} y={y - h / 2 - 0.8} width={w + 1.6} height={h + 1.6} rx="3.4" fill="#030304" />
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx="2.8" fill="url(#w-key)" stroke="#2a2e35" strokeWidth="0.6" />
      <path d={`M${x - w / 2 + 2.5} ${y - h / 2 + 0.9} L${x + w / 2 - 2.5} ${y - h / 2 + 0.9}`} stroke="#4b515c" strokeWidth="0.6" opacity="0.8" />
      <g className="key-glyph" transform={`translate(${x} ${y})`} stroke="#d3e4f4" fill="none" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">{children}</g>
    </g>
  );
}

/**
 * Steering wheel. The geometry rotates (drag the rim to steer, it springs back);
 * the lighting stays fixed on top so highlights don't spin with it.
 */
export function Wheel({ car, onIntent, onMic }: { car: CarState; onIntent: (i: Intent) => void; onMic: () => void }) {
  const [angle, setAngle] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ a0: number; base: number; cx: number; cy: number } | null>(null);

  const pointerAngle = (e: RPointerEvent, cx: number, cy: number) => (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  const onDown = (e: RPointerEvent<SVGPathElement>) => {
    const svg = (e.currentTarget.ownerSVGElement ?? e.currentTarget) as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    // Wheel centre in screen space (rotation keeps it fixed)
    const cx = r.left + ((WHEEL.cx - BOX.x) / BOX.w) * r.width;
    const cy = r.top + ((WHEEL.cy - BOX.y) / BOX.h) * r.height;
    start.current = { a0: pointerAngle(e, cx, cy), base: angle, cx, cy };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onMove = (e: RPointerEvent) => {
    const s = start.current;
    if (!s) return;
    let d = pointerAngle(e, s.cx, s.cy) - s.a0;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    setAngle(Math.max(-450, Math.min(450, s.base + d)));
  };
  const onUp = () => { start.current = null; setDragging(false); setAngle(0); };

  const m = car.media;
  return (
    <>
      <Part x={BOX.x} y={BOX.y} w={BOX.w} h={BOX.h + 20}>
        <path d={RIM} fillRule="evenodd" fill="#000" opacity="0.5" transform="translate(4 8)" filter="url(#d-b8)" />
      </Part>
      <div className={`wheel-rot ${dragging ? 'dragging' : ''}`}
        style={{ left: BOX.x, top: BOX.y, width: BOX.w, height: BOX.h, transformOrigin: `${WHEEL.cx - BOX.x}px ${WHEEL.cy - BOX.y}px`, transform: `rotate(${angle}deg)` }}>
        <svg viewBox={`${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`} width={BOX.w} height={BOX.h} style={{ overflow: 'visible' }}>
          <defs>
            {/* Layered leather shading: a broad padded crest, a soft lower roll, and a deep inner edge. */}
            <linearGradient id="w-tube" gradientUnits="userSpaceOnUse" x1={WHEEL.cx} y1={WHEEL.cy - WHEEL.ry} x2={WHEEL.cx} y2={WHEEL.cy + WHEEL.ry}>
              <stop offset="0" stopColor="#343840" />
              <stop offset="0.08" stopColor="#25282f" />
              <stop offset="0.24" stopColor="#14171c" />
              <stop offset="0.55" stopColor="#080a0d" />
              <stop offset="0.78" stopColor="#171a1f" />
              <stop offset="0.94" stopColor="#0b0d11" />
              <stop offset="1" stopColor="#020304" />
            </linearGradient>
            <linearGradient id="w-rimSheen" gradientUnits="userSpaceOnUse" x1="0" y1={WHEEL.cy - WHEEL.ry} x2="0" y2={WHEEL.cy + WHEEL.ry}>
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
              <stop offset="0.16" stopColor="#ffffff" stopOpacity="0.06" />
              <stop offset="0.36" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="0.78" stopColor="#000000" stopOpacity="0.16" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.28" />
            </linearGradient>
            <linearGradient id="w-leather" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#262930" />
              <stop offset="0.18" stopColor="#171a20" />
              <stop offset="0.62" stopColor="#0b0d10" />
              <stop offset="1" stopColor="#030405" />
            </linearGradient>
            <linearGradient id="w-spoke" x1="0" y1="0" x2="0.85" y2="1">
              <stop offset="0" stopColor="#2b2e35" />
              <stop offset="0.2" stopColor="#1a1d23" />
              <stop offset="0.7" stopColor="#0b0d11" />
              <stop offset="1" stopColor="#030405" />
            </linearGradient>
            <linearGradient id="w-gloss" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1a1c21" />
              <stop offset="0.3" stopColor="#090a0c" />
              <stop offset="1" stopColor="#0c0d10" />
            </linearGradient>
            <linearGradient id="w-key" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1f2228" />
              <stop offset="0.5" stopColor="#131519" />
              <stop offset="1" stopColor="#0d0e11" />
            </linearGradient>
            <radialGradient id="w-hubFace" cx="0.42" cy="0.18" r="0.9">
              <stop offset="0" stopColor="#363941" />
              <stop offset="0.28" stopColor="#24272e" />
              <stop offset="0.68" stopColor="#13161b" />
              <stop offset="1" stopColor="#07090c" />
            </radialGradient>
            <pattern id="w-perf" width="5.2" height="5.2" patternUnits="userSpaceOnUse">
              <circle cx="2.6" cy="2.8" r="0.82" fill="#010203" />
              <circle cx="2.2" cy="2.1" r="0.28" fill="#69717c" opacity="0.55" />
            </pattern>
            <clipPath id="w-grips">
              {GRIP_BANDS.map((d) => <path key={d} d={d} />)}
            </clipPath>
            {/* The chrome badge is photographed under studio light; dim and cool it to sit in a night cabin */}
            <filter id="w-logoTone" x="-5%" y="-5%" width="110%" height="110%">
              <feColorMatrix type="matrix" values="0.78 0 0 0 0  0 0.8 0 0 0  0 0 0.88 0 0.015  0 0 0 1 0" />
            </filter>
          </defs>

          {/* Spoke bodies in black leather, under the rim: the two side spokes and the lower V */}
          <g transform={`translate(${DX} 0)`}>
            <path d="M1336 432 Q1410 419 1478 428 L1480 532 L1452 520 Q1400 510 1340 500 Z" fill="url(#w-spoke)" stroke="#303640" strokeWidth="0.8" />
            <path d={`M${mirror(1336)} 432 Q${mirror(1410)} 419 ${mirror(1478)} 428 L${mirror(1480)} 532 L${mirror(1452)} 520 Q${mirror(1400)} 510 ${mirror(1340)} 500 Z`} fill="url(#w-spoke)" stroke="#303640" strokeWidth="0.8" />
            <path d={V_BODY} fill="url(#w-spoke)" stroke="#303640" strokeWidth="0.8" />
            <path d={V_BODY} fill="#000" filter="url(#d-leatherGrain)" opacity="0.22" />
            <path d="M1344 437 Q1405 428 1468 435" stroke="#727985" strokeWidth="1" opacity="0.34" fill="none" />
            <path d={`M${mirror(1344)} 437 Q${mirror(1405)} 428 ${mirror(1468)} 435`} stroke="#727985" strokeWidth="1" opacity="0.34" fill="none" />
            <path d="M1498 548 Q1557 565 1616 548" stroke="#535a65" strokeWidth="1" opacity="0.32" fill="none" />
            {/* Contact shadow under the pad */}
            <path d="M1470 540 Q1557 572 1648 540" stroke="#000" strokeWidth="8" opacity="0.46" fill="none" filter="url(#d-b3)" />

          </g>

          {/* Rim: layered padded leather, realistic grip zones, edge roll, seams and hand-stitching. */}
          <path d={RIM} fillRule="evenodd" fill="#000" opacity="0.7" filter="url(#d-b8)" transform="translate(0 5)" />
          <path d={RIM} fillRule="evenodd" fill="url(#w-tube)" />
          <path d={RIM} fillRule="evenodd" fill="url(#w-rimSheen)" opacity="0.9" />
          <g clipPath="url(#w-grips)">
            {GRIP_BANDS.map((d) => <path key={d} d={d} fill="url(#w-perf)" opacity="0.82" />)}
          </g>
          <path d={RIM} fillRule="evenodd" fill="#000" filter="url(#d-leatherGrain)" opacity="0.24" />
          <path d={ellipsePath(WHEEL.cx, WHEEL.cy, WHEEL.rx - 5, WHEEL.ry - 5)} stroke="#737b87" strokeWidth="1.1" fill="none" opacity="0.24" />
          <path d={ellipsePath(WHEEL.cx, WHEEL.cy, WHEEL.rx - 11, WHEEL.ry - 11)} stroke="#020304" strokeWidth="3.2" fill="none" opacity="0.62" filter="url(#d-b1)" />
          <path d={ellipsePath(WHEEL.cx, WHEEL.cy, WHEEL.irx + 7, WHEEL.iry + 7)} stroke="#89929e" strokeWidth="0.9" strokeDasharray="1.4 3.1" strokeLinecap="round" fill="none" opacity="0.42" />
          <path d={ellipsePath(WHEEL.cx, WHEEL.cy, WHEEL.irx, WHEEL.iry)} stroke="#000" strokeWidth="3.2" fill="none" filter="url(#d-b1)" opacity="0.76" />
          <path d={RIM} fillRule="evenodd" fill="#000" opacity="0.001" className="hit rim"
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            <title>Drag the rim to steer</title>
          </path>
          <g stroke="#020203" strokeWidth="2.3" opacity="0.85">{SEAMS.map((d) => <path key={`shadow-${d}`} d={d} />)}</g>
          <g stroke="#7f8793" strokeWidth="0.72" opacity="0.5">{SEAMS.map((d) => <path key={d} d={d} transform="translate(0 -0.7)" />)}</g>

          <g transform={`translate(${DX} 0)`}>
            {/* Switch pads: gloss black, chrome on the outer edge and between the rows */}
            <path d={PAD} fill="url(#w-gloss)" stroke="#23262c" strokeWidth="0.7" />
            <path d={PAD} fill="url(#w-gloss)" stroke="#23262c" strokeWidth="0.7" transform={`translate(${2 * SX} 0) scale(-1 1)`} />
            <path d="M1380 440 Q1365 468 1374 498" stroke="url(#d-chrome)" strokeWidth="2" strokeLinecap="round" fill="none" />
            <path d={`M${mirror(1380)} 440 Q${mirror(1365)} 468 ${mirror(1374)} 498`} stroke="url(#d-chrome)" strokeWidth="2" strokeLinecap="round" fill="none" />
            <rect x="1388" y="476.3" width="60" height="1.4" rx="0.7" fill="url(#d-chromeH)" />
            <rect x={mirror(1448)} y="476.3" width="60" height="1.4" rx="0.7" fill="url(#d-chromeH)" />

            {/* Lower V spoke trim */}
            <path d={V_EDGE} stroke="#000" strokeWidth="5" opacity="0.5" fill="none" filter="url(#d-b1)" transform="translate(0 2)" />
            <path d={V_EDGE} stroke="url(#d-chromeH)" strokeWidth="2.2" fill="none" strokeLinejoin="round" />
            <path d={V_EDGE} stroke="#ffffff" strokeWidth="0.6" fill="none" opacity="0.45" transform="translate(0 -0.8)" />

          </g>

          {/* Hub: bevelled airbag pad and the Hyundai badge */}
          <g transform={`translate(${HUB_DX} 0)`}>
            <path d={HUB} fill="#000" opacity="0.72" filter="url(#d-b3)" transform="translate(0 4)" />
            <path d={HUB} fill="#0a0b0e" stroke="#2a3039" strokeWidth="1.2" />
            <path d={HUB_FACE} fill="url(#w-hubFace)" stroke="#3b424d" strokeWidth="0.7" />
            <path d={HUB_FACE} fill="#000" filter="url(#d-leatherGrain)" opacity="0.2" />
            <path d="M1486 428 Q1557 416 1630 428" stroke="#7c8490" strokeWidth="1.3" fill="none" opacity="0.55" filter="url(#d-b1)" />
            <path d="M1480 523 Q1557 548 1634 523" stroke="#050608" strokeWidth="3" fill="none" opacity="0.68" filter="url(#d-b1)" />
            <ellipse cx="1557" cy="479" rx="44" ry="20" fill="#000" opacity="0.42" filter="url(#d-b3)" />
            <image href="/images/hyundai-logo.webp" x="1515" y="459" width="84" height="38" preserveAspectRatio="none" filter="url(#w-logoTone)" />
            <text x="1557" y="526" className="airbag">AIRBAG</text>
            <circle cx="1557" cy="482" r="66" fill="transparent" className="hit" onClick={() => carAudio.horn()}>
              <title>Horn</title>
            </circle>
          </g>

          <g transform={`translate(${DX} 0)`}>
            {/* Left spoke: audio */}
            <Key x={col('left', 'outer')} y={KEY_ROWS[0]} label={m.playing ? 'Pause' : 'Play'} onClick={() => onIntent(m.playing ? { type: 'media.pause' } : { type: 'media.play' })}>
              {m.playing ? <path d="M-2.5 -3.5 L-2.5 3.5 M2.5 -3.5 L2.5 3.5" /> : <path d="M-2.5 -3.5 L4 0 L-2.5 3.5 Z" />}
            </Key>
            <Key x={col('left', 'inner')} y={KEY_ROWS[0]} label="Mute" onClick={() => onIntent({ type: 'media.volume', mute: !m.muted })}>
              <path d="M-5.5 -1.5 L-3 -1.5 L-0.5 -4 L-0.5 4 L-3 1.5 L-5.5 1.5 Z M2.5 -2 L5.5 2 M5.5 -2 L2.5 2" />
            </Key>
            <Key x={col('left', 'outer')} y={KEY_ROWS[1]} label="Volume down" onClick={() => onIntent({ type: 'media.volume', delta: -2 })}>
              <path d="M-3 0 L3 0" />
            </Key>
            <Key x={col('left', 'inner')} y={KEY_ROWS[1]} label="Volume up" onClick={() => onIntent({ type: 'media.volume', delta: 2 })}>
              <path d="M-3 0 L3 0 M0 -3 L0 3" />
            </Key>
            <Key x={col('left', 'outer')} y={KEY_ROWS[2]} label="Previous track" onClick={() => onIntent({ type: 'media.skip', dir: -1 })}>
              <path d="M-3.5 -3.5 L-3.5 3.5 M3 -3.5 L-2 0 L3 3.5 Z" />
            </Key>
            <Key x={col('left', 'inner')} y={KEY_ROWS[2]} label="Next track" onClick={() => onIntent({ type: 'media.skip', dir: 1 })}>
              <path d="M3.5 -3.5 L3.5 3.5 M-3 -3.5 L2 0 L-3 3.5 Z" />
            </Key>
            {/* Myra key under the left pad: cosmetic for now, no action */}
            <g className="myra-key" aria-hidden="true">
              <rect x="1403.2" y="507.7" width="29.6" height="8.6" rx="2.6" fill="#030304" />
              <rect x="1404" y="508.5" width="28" height="7" rx="2.2" fill="url(#w-key)" stroke="#2a2e35" strokeWidth="0.5" />
              <text x="1418" y="513.4" className="myra-label">Myra</text>
            </g>

            {/* Right spoke: voice, phone, climate, cluster pages */}
            <Key x={col('right', 'inner')} y={KEY_ROWS[0]} label="Voice assistant" onClick={onMic}>
              <path d="M-1.5 -4 Q-1.5 -5.5 0 -5.5 Q1.5 -5.5 1.5 -4 L1.5 0 Q1.5 1.5 0 1.5 Q-1.5 1.5 -1.5 0 Z M-3.5 -1 Q-3.5 4 0 4 Q3.5 4 3.5 -1 M0 4 L0 5.5" />
            </Key>
            <Key x={col('right', 'outer')} y={KEY_ROWS[0]} label={car.phone ? 'End call' : 'Phone'} onClick={() => onIntent(car.phone ? { type: 'phone.end' } : { type: 'screen', page: 'phone' })}>
              <path d="M-4 -3 Q-3 4 4.5 4.5 L4.5 2 L2 1 L1 2 Q-1.5 1 -2.5 -1.5 L-1.5 -2.5 L-2.5 -5 Z" fill={car.phone ? '#ff6b6b' : 'none'} />
            </Key>
            <Key x={col('right', 'inner')} y={KEY_ROWS[1]} label="Temperature down" onClick={() => onIntent({ type: 'climate.setTemp', value: car.climate.temp - 0.5 })}>
              <path d="M-3 -1.5 L0 2 L3 -1.5" />
            </Key>
            <Key x={col('right', 'outer')} y={KEY_ROWS[1]} label="Temperature up" onClick={() => onIntent({ type: 'climate.setTemp', value: car.climate.temp + 0.5 })}>
              <path d="M-3 1.5 L0 -2 L3 1.5" />
            </Key>
            {/* Cluster menu keys: cycle the centre of the instrument cluster */}
            <Key x={col('right', 'inner')} y={KEY_ROWS[2]} label="Cluster: previous page" onClick={() => onIntent({ type: 'cluster.view', dir: -1 })}>
              <path d="M1.5 -3.5 L-2 0 L1.5 3.5" />
            </Key>
            <Key x={col('right', 'outer')} y={KEY_ROWS[2]} label="Cluster: next page (trip, tyres)" onClick={() => onIntent({ type: 'cluster.view', dir: 1 })}>
              <path d="M-1.5 -3.5 L2 0 L-1.5 3.5" />
            </Key>
          </g>
        </svg>
      </div>

      {/* Fixed lighting over the rim: one soft sheen along the top, nothing glossy */}
      <Part x={BOX.x} y={BOX.y} w={BOX.w} h={BOX.h} className="no-hit">
        <path d={RIM} fillRule="evenodd" fill="url(#d-rimLight)" />
        <path d="M1400 330 Q1470 262 1572 250 Q1680 256 1745 318" stroke="#c9ccd4" strokeWidth="2" opacity="0.1" fill="none" filter="url(#d-b1)" transform={`translate(${COLUMN_DX} 0)`} />
      </Part>
    </>
  );
}

/** Column stalks behind the wheel: left = wipers, right = indicators (Indian RHD layout). */
export function Stalks({ car, onIntent }: { car: CarState; onIntent: (i: Intent) => void }) {
  const tilt = car.indicator === 'right' ? -7 : car.indicator === 'left' ? 7 : 0;
  const wiperTilt = car.wipers === 'fast' ? -10 : car.wipers === 'slow' ? -5 : 0;
  return (
    <Part x={1366 + COLUMN_DX} y={392} w={432} h={60} className="stalks">
      <g transform={`translate(${COLUMN_DX} 0)`}>
      <g className="hit stalk" style={{ transform: `rotate(${wiperTilt}deg)`, transformOrigin: '1430px 410px' }}
        onClick={() => onIntent({ type: 'wipers', mode: car.wipers === 'off' ? 'slow' : car.wipers === 'slow' ? 'fast' : 'off' })} role="button" aria-label="Wiper stalk">
        <title>Wipers: click to cycle off / low / high</title>
        <path d="M1382 401 L1432 405 L1432 418 L1380 415 Q1372 408 1382 401 Z" fill="#121418" stroke="#262b33" strokeWidth="0.8" />
        <path d="M1384 403 L1430 406" stroke="#4a515c" strokeWidth="0.7" />
        <rect x="1386" y="404" width="7" height="9" rx="1.5" fill="#1e2228" />
      </g>
      <g className="hit stalk" style={{ transform: `rotate(${tilt}deg)`, transformOrigin: '1742px 430px' }} role="button" aria-label="Indicator stalk">
        <title>Indicators: top half = right, bottom half = left</title>
        <path d="M1784 422 L1742 424 L1742 438 L1786 436 Q1793 429 1784 422 Z" fill="#121418" stroke="#262b33" strokeWidth="0.8" />
        <path d="M1782 424 L1744 426" stroke="#4a515c" strokeWidth="0.7" />
        <rect x="1742" y="414" width="54" height="16" fill="transparent" onClick={() => onIntent({ type: 'indicator', dir: car.indicator === 'right' ? 'off' : 'right' })} />
        <rect x="1742" y="430" width="54" height="16" fill="transparent" onClick={() => onIntent({ type: 'indicator', dir: car.indicator === 'left' ? 'off' : 'left' })} />
      </g>
      </g>
    </Part>
  );
}
