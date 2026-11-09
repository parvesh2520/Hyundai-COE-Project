/**
 * three.js visualisation of the Acoustic Shield simulation.
 *
 * Purely a view: it reads simulation state and never feeds anything back into
 * the physics or decision pipeline. World (x east, y north) maps to three.js
 * (x, 0, -y); a heading θ maps to a rotation of θ about +Y.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DEG } from './config.ts';
import type { ThreatLevel } from './decision.ts';
import { LANE_WIDTH, ROAD_HALF_WIDTH } from './scenarios.ts';
import type { AcousticShieldSimulation } from './simulation.ts';
import { corners, type Vec2, type VehicleState } from './vehicle.ts';

export type CameraMode = 'chase' | 'orbit' | 'top';

export const LEVEL_COLORS: Record<ThreatLevel, string> = {
  NORMAL: '#3ec98a',
  WATCH: '#e3c14d',
  WARNING: '#ff9a3d',
  CRITICAL: '#ff4d57',
};

const TARGET_COLORS = ['#a32e33', '#2f5683', '#b88a2e', '#3f6b4a', '#6b4a7a'];
const EGO_COLOR = '#c8d0da';
const TRACK_COLOR = '#5cc8ff';

const v3 = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- dynamic overlay primitives

class Ribbon {
  readonly mesh: THREE.Mesh;
  private positions: Float32Array;
  private max: number;

  constructor(maxPoints: number, color: string, opacity: number) {
    this.max = maxPoints;
    this.positions = new Float32Array(maxPoints * 2 * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geom.setIndex(index);
    this.mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  update(points: Vec2[], width: number, height: number, color?: string) {
    const n = Math.min(points.length, this.max);
    if (color) (this.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    this.mesh.visible = n >= 2;
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const q = points[Math.min(n - 1, i + 1)];
      const o = points[Math.max(0, i - 1)];
      let dx = q.x - o.x;
      let dy = q.y - o.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy * width / 2;
      const ny = dx * width / 2;
      this.positions.set([p.x + nx, height, -(p.y + ny), p.x - nx, height, -(p.y - ny)], i * 6);
    }
    const geom = this.mesh.geometry;
    geom.attributes.position.needsUpdate = true;
    geom.setDrawRange(0, (n - 1) * 6);
    geom.computeBoundingSphere();
  }
}

class RectOutline {
  readonly line: THREE.LineLoop;
  private positions = new Float32Array(12);

  constructor(color: string, opacity = 1) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.line = new THREE.LineLoop(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 3;
  }

  update(s: Pick<VehicleState, 'x' | 'y' | 'heading' | 'length' | 'width'> | null, height = 0.08, color?: string) {
    this.line.visible = !!s;
    if (!s) return;
    if (color) (this.line.material as THREE.LineBasicMaterial).color.set(color);
    corners(s).forEach((c, i) => this.positions.set([c.x, height, -c.y], i * 3));
    this.line.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- vehicle model

function sedanMesh(length: number, width: number, color: string): THREE.Group {
  const g = new THREE.Group();
  const L = length;
  const W = width;
  const half = L / 2;
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.32 });
  const glass = new THREE.MeshStandardMaterial({ color: '#141b24', metalness: 0.2, roughness: 0.08 });
  const dark = new THREE.MeshStandardMaterial({ color: '#16181b', roughness: 0.85 });

  // Side silhouette extruded across the width; proportions scale with the configured length.
  const k = L / 4.6;
  const body = new THREE.Shape();
  body.moveTo(-half, 0.36);
  body.lineTo(half - 0.05, 0.36);
  body.quadraticCurveTo(half + 0.04, 0.42, half, 0.66);
  body.lineTo(half - 0.9 * k, 0.84);
  body.lineTo(half - 1.5 * k, 0.92);
  body.lineTo(0.3 * k, 1.42);
  body.lineTo(-0.95 * k, 1.42);
  body.lineTo(-half + 0.55 * k, 0.99);
  body.lineTo(-half + 0.02, 0.94);
  body.quadraticCurveTo(-half - 0.05, 0.8, -half - 0.02, 0.58);
  body.closePath();
  const bevel = 0.06;
  const depth = W - 2 * bevel - 0.02;
  const bodyGeom = new THREE.ExtrudeGeometry(body, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 8 });
  bodyGeom.translate(0, 0, -depth / 2);
  const bodyMesh = new THREE.Mesh(bodyGeom, paint);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  g.add(bodyMesh);

  const cabin = new THREE.Shape();
  cabin.moveTo(half - 1.46 * k, 0.95);
  cabin.lineTo(0.3 * k, 1.39);
  cabin.lineTo(-0.93 * k, 1.39);
  cabin.lineTo(-half + 0.62 * k, 1.0);
  cabin.lineTo(-half + 0.62 * k, 0.97);
  cabin.closePath();
  const glassDepth = W - 0.06;
  const glassGeom = new THREE.ExtrudeGeometry(cabin, { depth: glassDepth, bevelEnabled: false });
  glassGeom.translate(0, 0, -glassDepth / 2);
  g.add(new THREE.Mesh(glassGeom, glass));

  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, W - 0.04), paint);
  pillar.position.set(-0.22 * k, 1.17, 0);
  g.add(pillar);

  const wheelGeom = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 24);
  wheelGeom.rotateX(Math.PI / 2);
  const rimGeom = new THREE.CylinderGeometry(0.21, 0.21, 0.25, 16);
  rimGeom.rotateX(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({ color: '#9aa3ad', metalness: 0.8, roughness: 0.3 });
  for (const wx of [half - 0.88 * k, -half + 0.84 * k]) for (const side of [1, -1]) {
    const w = new THREE.Mesh(wheelGeom, dark);
    w.position.set(wx, 0.34, side * (W / 2 - 0.13));
    w.castShadow = true;
    g.add(w);
    const r = new THREE.Mesh(rimGeom, rimMat);
    r.position.copy(w.position);
    g.add(r);
  }

  const head = new THREE.MeshStandardMaterial({ color: '#f4f7ff', emissive: '#dfe8ff', emissiveIntensity: 0.6 });
  const tail = new THREE.MeshStandardMaterial({ color: '#5a0d10', emissive: '#ff1f2d', emissiveIntensity: 0.35 });
  for (const side of [1, -1]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.42), head);
    h.position.set(half - 0.02, 0.68, side * (W / 2 - 0.32));
    g.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.46), tail);
    t.position.set(-half - 0.02, 0.8, side * (W / 2 - 0.3));
    t.name = 'tail';
    g.add(t);
  }
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, W * 0.5), dark);
  grille.position.set(half + 0.005, 0.52, 0);
  g.add(grille);
  return g;
}

interface VehicleView {
  group: THREE.Group;
  dims: string;
  color: string;
  tails: THREE.MeshStandardMaterial[];
}

// ---------------------------------------------------------------- scene

export class ShieldScene {
  onPick: (id: string | null) => void = () => {};
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private sun: THREE.DirectionalLight;
  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private vehicles = new Map<string, VehicleView>();
  private mode: CameraMode = 'chase';
  private lastEgo: THREE.Vector3 | null = null;
  private targetPaths = new Map<string, { path: Ribbon; truth: Ribbon; egoGhost: RectOutline; tgtGhost: RectOutline; trackBox: RectOutline; los: THREE.Line }>();
  private egoPath: Ribbon;
  private contactMarker: THREE.Mesh;
  private selectionRing: THREE.Mesh;
  private radar: THREE.Group;
  private radarFan: THREE.Mesh;
  private sweep: THREE.Mesh;
  private measurementDots: THREE.InstancedMesh;
  private pointerDown: { x: number; y: number } | null = null;
  private clock = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1500);
    this.camera.position.set(-80, 6, -2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 220;
    this.controls.enabled = false;

    const sky = new THREE.Color('#aebfd0');
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 160, 620);
    this.scene.add(new THREE.HemisphereLight('#dfe9f5', '#4b4f45', 1.1));
    this.sun = new THREE.DirectionalLight('#fff3e2', 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 320;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);

    this.buildEnvironment();

    this.egoPath = new Ribbon(80, EGO_COLOR, 0.55);
    this.scene.add(this.egoPath.mesh);

    this.contactMarker = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.1, 40), new THREE.MeshBasicMaterial({ color: LEVEL_COLORS.CRITICAL, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.contactMarker.rotation.x = -Math.PI / 2;
    this.contactMarker.renderOrder = 4;
    this.scene.add(this.contactMarker);

    this.selectionRing = new THREE.Mesh(new THREE.RingGeometry(3.1, 3.35, 56), new THREE.MeshBasicMaterial({ color: '#8fc1ff', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.renderOrder = 3;
    this.scene.add(this.selectionRing);

    this.radar = new THREE.Group();
    this.radarFan = new THREE.Mesh(new THREE.CircleGeometry(1, 72), new THREE.MeshBasicMaterial({ color: '#4fa8ff', transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }));
    this.radarFan.rotation.x = -Math.PI / 2;
    this.radar.add(this.radarFan);
    for (const r of [25, 50, 75, 100, 125, 150]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.08, r + 0.08, 128), new THREE.MeshBasicMaterial({ color: '#7cc0ff', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.userData.radius = r;
      this.radar.add(ring);
    }
    this.sweep = new THREE.Mesh(new THREE.CircleGeometry(1, 24, 0, 10 * DEG), new THREE.MeshBasicMaterial({ color: '#7cc0ff', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
    this.sweep.rotation.x = -Math.PI / 2;
    this.radar.add(this.sweep);
    this.radar.position.y = 0.05;
    this.radar.renderOrder = 1;
    this.scene.add(this.radar);

    this.measurementDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: TRACK_COLOR }), 32);
    this.measurementDots.count = 0;
    this.measurementDots.frustumCulled = false;
    this.scene.add(this.measurementDots);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.handleDown);
    el.addEventListener('pointerup', this.handleUp);
  }

  // ---------------------------------------------------------------- static world

  private buildEnvironment() {
    const add = (o: THREE.Object3D) => { this.scene.add(o); return o; };
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), new THREE.MeshStandardMaterial({ color: '#5d6655', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    add(ground);

    const asphalt = new THREE.MeshStandardMaterial({ color: '#2c2f34', roughness: 0.92 });
    const roadW = 2 * ROAD_HALF_WIDTH + 1;
    for (const [w, d] of [[1600, roadW], [roadW, 1600]]) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), asphalt);
      road.rotation.x = -Math.PI / 2;
      road.position.y = 0.02;
      road.receiveShadow = true;
      add(road);
    }

    // Sidewalks / curbs in the four quadrants.
    const kerb = new THREE.MeshStandardMaterial({ color: '#8d9198', roughness: 0.95 });
    const e = ROAD_HALF_WIDTH + 0.5;
    const walk = 4;
    const far = 800;
    for (const sx of [1, -1]) for (const sy of [1, -1]) {
      for (const [cx, cy, w, d] of [
        [sx * (e + far / 2), sy * (e + walk / 2), far, walk],
        [sx * (e + walk / 2), sy * (e + far / 2), walk, far],
      ]) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), kerb);
        b.position.copy(v3(cx, cy, 0.08));
        b.receiveShadow = true;
        add(b);
      }
    }

    // Lane markings: instanced quads.
    const white: THREE.Matrix4[] = [];
    const yellow: THREE.Matrix4[] = [];
    const stripe = (list: THREE.Matrix4[], x: number, y: number, len: number, wid: number, alongX: boolean) => {
      const m = new THREE.Matrix4().compose(v3(x, y, 0.035), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), new THREE.Vector3(alongX ? len : wid, alongX ? wid : len, 1));
      list.push(m);
    };
    const gap = e + walk; // keep markings out of the junction and crosswalks
    for (const along of [true, false]) {
      for (const sgn of [1, -1]) {
        const from = gap + 2;
        const to = 450;
        const mid = (from + to) / 2;
        const len = to - from;
        const place = (lat: number, list: THREE.Matrix4[], w: number, dashed: boolean) => {
          if (dashed) {
            for (let s = from; s < to; s += 9) stripe(list, along ? sgn * (s + 1.5) : lat, along ? lat : sgn * (s + 1.5), 3, w, along);
          } else stripe(list, along ? sgn * mid : lat, along ? lat : sgn * mid, len, w, along);
        };
        place(0.15, yellow, 0.12, false);
        place(-0.15, yellow, 0.12, false);
        place(LANE_WIDTH, white, 0.13, true);
        place(-LANE_WIDTH, white, 0.13, true);
        place(ROAD_HALF_WIDTH - 0.2, white, 0.15, false);
        place(-ROAD_HALF_WIDTH + 0.2, white, 0.15, false);
      }
    }
    // Zebra crossings and stop lines.
    for (const sgn of [1, -1]) {
      for (let k = -ROAD_HALF_WIDTH + 0.6; k < ROAD_HALF_WIDTH; k += 1.2) {
        stripe(white, sgn * (e + 2), k, 3, 0.6, true);
        stripe(white, k, sgn * (e + 2), 3, 0.6, false);
      }
    }
    stripe(white, -(gap + 1.2), ROAD_HALF_WIDTH / 2, 0.4, ROAD_HALF_WIDTH, true);
    stripe(white, gap + 1.2, -ROAD_HALF_WIDTH / 2, 0.4, ROAD_HALF_WIDTH, true);
    stripe(white, ROAD_HALF_WIDTH / 2, gap + 1.2, 0.4, ROAD_HALF_WIDTH, false);
    stripe(white, -ROAD_HALF_WIDTH / 2, -(gap + 1.2), 0.4, ROAD_HALF_WIDTH, false);
    const quad = new THREE.PlaneGeometry(1, 1);
    for (const [list, color] of [[white, '#e9ecef'], [yellow, '#e5b93a']] as const) {
      const inst = new THREE.InstancedMesh(quad, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }), list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.receiveShadow = true;
      add(inst);
    }

    // Buildings and trees, seeded so the city is identical on every load.
    const rand = mulberry(7);
    const facade = ['#9a9c9f', '#b3aa9c', '#7f858c', '#c2bdb4', '#8e8a84', '#a6aeb6'].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
    const windowMat = new THREE.MeshStandardMaterial({ color: '#3b4654', roughness: 0.3, metalness: 0.4 });
    for (const sx of [1, -1]) for (const sy of [1, -1]) {
      for (const alongX of [true, false]) {
        let s = e + walk + 6;
        while (s < 360) {
          const w = 10 + rand() * 18;
          const d = 10 + rand() * 14;
          const h = 6 + rand() * (s < 120 ? 26 : 14);
          const set = e + walk + 4 + rand() * 6;
          const cx = alongX ? sx * (s + w / 2) : sx * (set + d / 2);
          const cy = alongX ? sy * (set + d / 2) : sy * (s + w / 2);
          const bw = alongX ? w : d;
          const bd = alongX ? d : w;
          const b = new THREE.Mesh(new THREE.BoxGeometry(bw, h, bd), facade[Math.floor(rand() * facade.length)]);
          b.position.copy(v3(cx, cy, h / 2));
          b.castShadow = s < 160;
          b.receiveShadow = true;
          add(b);
          // Window bands on the street-facing side (near blocks only, to bound draw calls).
          for (let fy = 3; s < 160 && fy < h - 1; fy += 3.2) {
            const band = new THREE.Mesh(new THREE.BoxGeometry(alongX ? bw * 0.86 : 0.05, 1.3, alongX ? 0.05 : bw * 0.86), windowMat);
            const face = alongX ? v3(cx, cy - sy * (bd / 2 + 0.03), fy) : v3(cx - sx * (bw / 2 + 0.03), cy, fy);
            band.position.copy(face);
            add(band);
          }
          s += w + 3 + rand() * 6;
        }
      }
    }
    const trunks: THREE.Matrix4[] = [];
    const crowns: THREE.Matrix4[] = [];
    for (const sx of [1, -1]) for (const sy of [1, -1]) for (const alongX of [true, false]) {
      for (let s = e + walk + 5; s < 300; s += 16) {
        const lat = e + walk - 1;
        const p = alongX ? v3(sx * s, sy * lat, 0) : v3(sx * lat, sy * s, 0);
        const scale = 0.8 + rand() * 0.5;
        trunks.push(new THREE.Matrix4().compose(p.clone().setY(1.3 * scale), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)));
        crowns.push(new THREE.Matrix4().compose(p.clone().setY(3.6 * scale), new THREE.Quaternion(), new THREE.Vector3(scale, scale * 1.15, scale)));
      }
    }
    const trunkMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.2, 2.6, 6), new THREE.MeshStandardMaterial({ color: '#5a4636' }), trunks.length);
    trunks.forEach((m, i) => trunkMesh.setMatrixAt(i, m));
    trunkMesh.castShadow = true;
    const crownMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.7, 1), new THREE.MeshStandardMaterial({ color: '#3e5b3a', roughness: 0.95, flatShading: true }), crowns.length);
    crowns.forEach((m, i) => crownMesh.setMatrixAt(i, m));
    crownMesh.castShadow = true;
    add(trunkMesh);
    add(crownMesh);

    // Signal poles at the junction corners.
    const pole = new THREE.MeshStandardMaterial({ color: '#3a3d42', metalness: 0.6, roughness: 0.5 });
    const head = new THREE.MeshStandardMaterial({ color: '#1b1d20' });
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 5.5, 8), pole);
      p.position.copy(v3(sx * (e + 1), sy * (e + 1), 2.75));
      p.castShadow = true;
      add(p);
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.0, 0.35), head);
      h.position.copy(v3(sx * (e + 1), sy * (e + 1), 5.0));
      add(h);
    }
  }

  // ---------------------------------------------------------------- interaction

  private handleDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private handleUp = (e: PointerEvent) => {
    const start = this.pointerDown;
    this.pointerDown = null;
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const groups = [...this.vehicles.values()].map((v) => v.group);
    const hit = ray.intersectObjects(groups, true)[0];
    let obj: THREE.Object3D | null = hit?.object ?? null;
    while (obj && obj.userData.vehicleId === undefined) obj = obj.parent;
    this.onPick(obj ? (obj.userData.vehicleId as string) : null);
  };

  setCameraMode(mode: CameraMode) {
    this.mode = mode;
    this.controls.enabled = mode === 'orbit';
    this.lastEgo = null;
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- per-frame update

  private vehicleView(v: VehicleState, index: number): VehicleView {
    const dims = `${v.length.toFixed(2)}x${v.width.toFixed(2)}`;
    let view = this.vehicles.get(v.id);
    if (view && view.dims === dims) return view;
    if (view) this.disposeObject(view.group);
    const color = v.kind === 'ego' ? EGO_COLOR : TARGET_COLORS[index % TARGET_COLORS.length];
    const group = sedanMesh(v.length, v.width, color);
    group.userData.vehicleId = v.id;
    const tails: THREE.MeshStandardMaterial[] = [];
    group.traverse((o) => { if (o.name === 'tail') tails.push((o as THREE.Mesh).material as THREE.MeshStandardMaterial); });
    this.scene.add(group);
    view = { group, dims, color, tails };
    this.vehicles.set(v.id, view);
    return view;
  }

  private overlaysFor(id: string) {
    let o = this.targetPaths.get(id);
    if (!o) {
      const losGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      o = {
        path: new Ribbon(80, LEVEL_COLORS.NORMAL, 0.7),
        truth: new Ribbon(80, '#ffffff', 0.25),
        egoGhost: new RectOutline(EGO_COLOR, 0.95),
        tgtGhost: new RectOutline(LEVEL_COLORS.CRITICAL, 0.95),
        trackBox: new RectOutline(TRACK_COLOR, 0.95),
        los: new THREE.Line(losGeom, new THREE.LineBasicMaterial({ color: TRACK_COLOR, transparent: true, opacity: 0.45, depthTest: false })),
      };
      o.los.frustumCulled = false;
      this.scene.add(o.path.mesh, o.truth.mesh, o.egoGhost.line, o.tgtGhost.line, o.trackBox.line, o.los);
      this.targetPaths.set(id, o);
    }
    return o;
  }

  render(sim: AcousticShieldSimulation, opts: { dt: number; selectedId: string | null; showTruth: boolean; showRadar: boolean }) {
    this.clock += opts.dt;
    const alpha = sim.interpolationAlpha;
    const pose = (v: VehicleState) => {
      const p = sim.prevPoses.get(v.id);
      if (!p) return { x: v.x, y: v.y, heading: v.heading };
      const dh = Math.atan2(Math.sin(v.heading - p.heading), Math.cos(v.heading - p.heading));
      return { x: p.x + (v.x - p.x) * alpha, y: p.y + (v.y - p.y) * alpha, heading: p.heading + dh * alpha };
    };

    // Vehicles.
    const all = [sim.ego, ...sim.targets];
    const live = new Set(all.map((v) => v.id));
    all.forEach((v, i) => {
      const view = this.vehicleView(v, i - 1);
      const p = pose(v);
      view.group.position.copy(v3(p.x, p.y));
      view.group.rotation.y = p.heading;
      const braking = v.accel < -1 && v.speed > 0.1;
      for (const t of view.tails) t.emissiveIntensity = braking ? 2.4 : 0.35;
    });
    for (const [id, view] of this.vehicles) if (!live.has(id)) { this.disposeObject(view.group); this.vehicles.delete(id); }

    // Per-target overlays.
    const levelOf = new Map(sim.assessment.targets.map((t) => [t.targetId, t.level]));
    const tracked = new Map(sim.trackViews.map((v) => [v.track.objectId, v]));
    for (const [id, o] of this.targetPaths) {
      if (!live.has(id) || id === 'ego') {
        this.scene.remove(o.path.mesh, o.truth.mesh, o.egoGhost.line, o.tgtGhost.line, o.trackBox.line, o.los);
        this.targetPaths.delete(id);
      }
    }
    let primaryContact: Vec2 | null = null;
    const primaryId = sim.assessment.primary?.targetId ?? null;
    for (const t of sim.targets) {
      const o = this.overlaysFor(t.id);
      const pred = sim.predictions.get(t.id);
      const truth = sim.truthPredictions.get(t.id);
      const color = LEVEL_COLORS[levelOf.get(t.id) ?? 'NORMAL'];
      if (pred) o.path.update(pred.targetPath, 0.45, 0.06, color);
      else o.path.mesh.visible = false;
      if (opts.showTruth && truth) o.truth.update(truth.targetPath, 0.16, 0.07);
      else o.truth.mesh.visible = false;
      const contact = pred?.collision && pred.ttc !== null && pred.ttc > 0;
      o.egoGhost.update(contact ? pred!.egoAtContact : null, 0.1);
      o.tgtGhost.update(contact ? pred!.targetAtContact : null, 0.1, color);
      if (contact && t.id === primaryId) primaryContact = pred!.contactPoint;
      const tv = tracked.get(t.id);
      o.trackBox.update(tv ? tv.state : null, 0.12, tv && tv.confidence > 0 ? TRACK_COLOR : '#7d8794');
      o.los.visible = !!tv && opts.showRadar;
      if (tv) {
        const pos = o.los.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, sim.ego.x, 0.6, -sim.ego.y);
        pos.setXYZ(1, tv.state.x, 0.6, -tv.state.y);
        pos.needsUpdate = true;
      }
    }
    const primaryPred = primaryId ? sim.predictions.get(primaryId) : undefined;
    if (primaryPred) this.egoPath.update(primaryPred.egoPath, 0.45, 0.055);
    else this.egoPath.mesh.visible = false;

    this.contactMarker.visible = !!primaryContact;
    if (primaryContact) {
      this.contactMarker.position.copy(v3(primaryContact.x, primaryContact.y, 0.12));
      const s = 1 + 0.25 * Math.sin(this.clock * 8);
      this.contactMarker.scale.set(s, s, s);
    }

    // Selection ring.
    const sel = all.find((v) => v.id === opts.selectedId);
    this.selectionRing.visible = !!sel;
    if (sel) {
      const p = pose(sel);
      this.selectionRing.position.copy(v3(p.x, p.y, 0.09));
      const r = Math.max(sel.length, sel.width) / 4.6;
      this.selectionRing.scale.set(r, r, r);
    }

    // Radar coverage and raw measurements.
    const ego = pose(sim.ego);
    const sensor = sim.config.sensor;
    this.radar.visible = opts.showRadar;
    this.radar.position.set(ego.x, 0.05, -ego.y);
    this.radar.rotation.y = ego.heading;
    const fov = Math.min(360, sensor.fovDeg) * DEG;
    if ((this.radarFan.userData.key as string) !== `${fov}:${sensor.maxRangeM}`) {
      this.radarFan.geometry.dispose();
      this.radarFan.geometry = new THREE.CircleGeometry(sensor.maxRangeM, 96, -fov / 2, fov);
      this.radarFan.userData.key = `${fov}:${sensor.maxRangeM}`;
    }
    for (const child of this.radar.children) {
      if (child.userData.radius) child.visible = child.userData.radius <= sensor.maxRangeM + 0.1;
    }
    this.sweep.scale.setScalar(sensor.maxRangeM);
    this.sweep.rotation.z = fov >= 2 * Math.PI - 1e-6 ? -this.clock * 2.4 : -fov / 2 + ((this.clock * 0.6) % 1) * (fov - 10 * DEG);
    const dot = new THREE.Matrix4();
    let n = 0;
    if (opts.showRadar) {
      for (const m of sim.lastMeasurements) {
        if (n >= 32 || !Number.isFinite(m.range)) continue;
        const b = m.egoPose.heading + m.azimuth;
        dot.makeTranslation(m.egoPose.x + m.range * Math.cos(b), 0.6, -(m.egoPose.y + m.range * Math.sin(b)));
        this.measurementDots.setMatrixAt(n++, dot);
      }
    }
    this.measurementDots.count = n;
    this.measurementDots.instanceMatrix.needsUpdate = true;

    // Camera.
    this.updateCamera(ego, opts.dt);
    this.sun.position.set(ego.x + 60, 90, -ego.y + 40);
    this.sun.target.position.set(ego.x, 0, -ego.y);
    this.renderer.render(this.scene, this.camera);
  }

  private updateCamera(ego: { x: number; y: number; heading: number }, dt: number) {
    const egoPos = v3(ego.x, ego.y);
    const fwd = new THREE.Vector3(Math.cos(ego.heading), 0, -Math.sin(ego.heading));
    const k = 1 - Math.exp(-dt * 5);
    if (this.mode === 'chase') {
      const desired = egoPos.clone().addScaledVector(fwd, -11).setY(4.3);
      if (!this.lastEgo) this.camera.position.copy(desired);
      else this.camera.position.lerp(desired, k);
      this.camera.lookAt(egoPos.clone().addScaledVector(fwd, 8).setY(1.2));
    } else if (this.mode === 'top') {
      const desired = egoPos.clone().addScaledVector(fwd, 18).setY(95);
      desired.z += 0.01;
      if (!this.lastEgo) this.camera.position.copy(desired);
      else this.camera.position.lerp(desired, k);
      this.camera.lookAt(egoPos.clone().addScaledVector(fwd, 18));
    } else {
      if (this.lastEgo) {
        const delta = egoPos.clone().sub(this.lastEgo);
        this.camera.position.add(delta);
        this.controls.target.add(delta);
      } else {
        this.controls.target.copy(egoPos).setY(1);
      }
      this.controls.update();
    }
    this.lastEgo = egoPos;
  }

  private disposeObject(obj: THREE.Object3D) {
    this.scene.remove(obj);
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
  }

  dispose() {
    this.resizeObserver.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.handleDown);
    el.removeEventListener('pointerup', this.handleUp);
    this.controls.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else (mat as THREE.Material | undefined)?.dispose();
    });
    this.renderer.dispose();
    el.remove();
  }
}
