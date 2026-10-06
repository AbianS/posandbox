import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { TEST_CARDS, type TerminalSnapshot, type TestCardId } from '../../shared/contract.ts';
import { terminalApi } from '../store.ts';
import { drawScreen, SCREEN } from '../terminal-screen.ts';
import { MAX_STEP } from './paper-path.ts';
import { footprint, slab, usePlastic } from './PrinterModel.tsx';
import { terminalSound } from './sound.ts';

// Countertop payment terminal with physical keypad (P400 Plus class): 190 × 83 mm, a wedge whose top slopes
// towards the shopper. Origin: base centre, +z = front (keypad, chip slot). The deck is the sloped top:
// in its frame y is the surface normal and z runs down the slope towards the front.

const L = 0.19;
const W = 0.083;
const H_FRONT = 0.03;
const H_REAR = 0.064;
const SLOPE = Math.atan((H_REAR - H_FRONT) / L);
const DECK_Y = H_FRONT + (L / 2) * Math.tan(SLOPE); // surface height above the centre
const SLOT_Y = 0.012; // chip reader, front face
const CARD = { w: 0.0856, d: 0.05398, t: 0.00076 };
const SCREEN_U = -0.036;
const MSR_U = -0.079;

/** Deck → station transform (the sloped top surface). */
const DECK = new THREE.Object3D();
DECK.position.set(0, DECK_Y, 0);
DECK.rotation.x = SLOPE;
DECK.updateMatrix();

/** Wedge side profile (z, y) with rounded corners, extruded across the width with rounded side edges. */
function bodyGeometry(): THREE.BufferGeometry {
  const r = 0.012;
  const rb = 0.005;
  const [c, s] = [Math.cos(SLOPE), Math.sin(SLOPE)];
  const p = new THREE.Shape();
  p.moveTo(L / 2 - rb, 0);
  p.lineTo(-L / 2 + rb, 0);
  p.quadraticCurveTo(-L / 2, 0, -L / 2, rb);
  p.lineTo(-L / 2, H_REAR - r);
  p.quadraticCurveTo(-L / 2, H_REAR, -L / 2 + r * c, H_REAR - r * s);
  p.lineTo(L / 2 - r * c, H_FRONT + r * s);
  p.quadraticCurveTo(L / 2, H_FRONT, L / 2, H_FRONT - r);
  p.lineTo(L / 2, rb);
  p.quadraticCurveTo(L / 2, 0, L / 2 - rb, 0);
  const b = 0.006;
  const g = new THREE.ExtrudeGeometry(p, { depth: W - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 6, curveSegments: 12 });
  g.rotateY(-Math.PI / 2);
  g.translate(W / 2 - b, 0, 0);
  g.computeVertexNormals();
  return g;
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// ---- keypad ----

type KeyDef = { key: string; label: string; x: number; u: number; color: string; text: string };
const COLS = [-0.021, 0, 0.021];
const KEYS: KeyDef[] = [
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((label, i) => ({
    key: /\d/.test(label) ? label : '', label, x: COLS[i % 3], u: 0.006 + Math.floor(i / 3) * 0.0135, color: '#2d2f34', text: '#f2f3f5',
  })),
  { key: 'cancel', label: '✕', x: COLS[0], u: 0.0635, color: '#c62828', text: '#ffffff' },
  { key: 'clear', label: '‹', x: COLS[1], u: 0.0635, color: '#e3b008', text: '#2a2200' },
  { key: 'enter', label: 'O', x: COLS[2], u: 0.0635, color: '#2e9e46', text: '#ffffff' },
];

function Key({ def, geometry, onPress }: { def: KeyDef; geometry: THREE.BufferGeometry; onPress: (() => void) | null }) {
  const [down, setDown] = useState(false);
  const legend = useMemo(() => canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = def.text;
    ctx.font = `${def.label === 'O' ? 700 : 600} ${def.label.length > 1 ? 30 : 40}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (def.label === 'O') {
      ctx.strokeStyle = def.text;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(32, 32, 13, 0, Math.PI * 2);
      ctx.stroke();
    } else ctx.fillText(def.label, 32, 34);
  }), [def]);
  useEffect(() => () => legend.dispose(), [legend]);
  const release = () => setDown(false);
  return (
    <group position={[def.x, down ? -0.0011 : 0, def.u]}>
      <mesh
        geometry={geometry}
        castShadow
        onPointerDown={(e) => {
          if (!onPress) return;
          e.stopPropagation();
          setDown(true);
          terminalSound.key();
          onPress();
        }}
        onPointerUp={release}
        onPointerOut={release}
      >
        <meshPhysicalMaterial color={def.color} roughness={0.55} clearcoat={0.15} />
      </mesh>
      <mesh position={[0, 0.0031, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.0085, 0.0085]} />
        <meshBasicMaterial map={legend} transparent depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
    </group>
  );
}

// ---- cards ----

const BRAND: Record<string, { bg: [string, string]; name: string }> = {
  visa: { bg: ['#1a2a7a', '#0e1647'], name: 'VISA' },
  maestro: { bg: ['#0f6fb3', '#073a66'], name: 'maestro' },
  mc: { bg: ['#2b2b2e', '#111113'], name: 'mastercard' },
};

function cardFace(id: TestCardId): THREE.CanvasTexture {
  const c = TEST_CARDS.find((t) => t.id === id)!;
  const brand = BRAND[c.brand];
  return canvasTexture(512, 323, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 512, 323);
    g.addColorStop(0, id === 'visa-msr' ? '#3a4a5c' : brand.bg[0]);
    g.addColorStop(1, id === 'visa-msr' ? '#1d2732' : brand.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 323);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.arc(420, -40, 240, 0, Math.PI * 2);
    ctx.fill();
    if (id !== 'visa-msr') {
      // EMV chip
      const chip = ctx.createLinearGradient(52, 110, 122, 165);
      chip.addColorStop(0, '#f1d488');
      chip.addColorStop(1, '#b8913d');
      ctx.fillStyle = chip;
      ctx.beginPath();
      ctx.roundRect(52, 108, 72, 56, 9);
      ctx.fill();
      ctx.strokeStyle = 'rgba(90,64,20,0.6)';
      ctx.lineWidth = 2;
      for (const y of [126, 146]) {
        ctx.beginPath();
        ctx.moveTo(52, y);
        ctx.lineTo(124, y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(88, 108);
      ctx.lineTo(88, 164);
      ctx.stroke();
      // contactless mark
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 4;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(150, 136, 8 + i * 7, -0.7, 0.7);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 30px "Geist Mono Variable", ui-monospace, monospace';
    ctx.fillText(c.pan.replace(/(\d{4})(?=\d)/g, '$1 '), 50, 222);
    ctx.font = '500 18px system-ui, sans-serif';
    ctx.fillText(`VALID THRU ${c.expiry.slice(0, 2)}/${c.expiry.slice(2)}`, 50, 256);
    ctx.fillText('POSANDBOX TEST CARD', 50, 290);
    ctx.textAlign = 'right';
    ctx.font = brand.name === 'VISA' ? 'italic 800 52px system-ui, sans-serif' : '700 34px system-ui, sans-serif';
    ctx.fillText(brand.name, 470, 290);
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('TEST', 470, 46);
  });
}

const cardBack = () =>
  canvasTexture(512, 323, (ctx) => {
    ctx.fillStyle = '#e9e9ec';
    ctx.fillRect(0, 0, 512, 323);
    ctx.fillStyle = '#141416';
    ctx.fillRect(0, 34, 512, 62); // magnetic stripe
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(40, 120, 300, 40);
    ctx.fillStyle = '#9a9aa0';
    ctx.font = '500 14px system-ui, sans-serif';
    ctx.fillText('Test card. No monetary value.', 40, 200);
  });

interface Pose { position: THREE.Vector3; quaternion: THREE.Quaternion }
const pose = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Pose => ({
  position: new THREE.Vector3(x, y, z),
  quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
});
/** A pose given in the deck's frame, expressed in the station's. */
const onDeck = (p: Pose): Pose => ({ position: p.position.clone().applyMatrix4(DECK.matrix), quaternion: DECK.quaternion.clone().multiply(p.quaternion) });

const TAP = onDeck(pose(0, 0.026, SCREEN_U));
// chip end first: the long side along z, a third of the card inside the reader
const PRE_INSERT = pose(0, SLOT_Y, L / 2 + CARD.w / 2 + 0.012, 0, Math.PI / 2);
const INSERTED = pose(0, SLOT_Y, L / 2 + CARD.w / 2 - 0.048, 0, Math.PI / 2);
// standing on its long edge in the swipe slot, stripe towards the rear
const SWIPE_FROM = onDeck(pose(-0.06, CARD.d / 2 - 0.009, MSR_U, Math.PI / 2));
const SWIPE_TO = onDeck(pose(0.06, CARD.d / 2 - 0.009, MSR_U, Math.PI / 2));

const deskPose = (i: number) => pose(-0.004 + i * 0.007, 0.0002 + i * 0.0009, L / 2 + 0.05 + i * 0.011, 0, 0.12 - i * 0.07);

type CardMode = 'desk' | 'tap' | 'insert' | 'swipe';

function TestCard({ id, index, mode, onClick }: { id: TestCardId; index: number; mode: CardMode; onClick: (() => void) | null }) {
  const group = useRef<THREE.Group>(null);
  const stage = useRef<'free' | 'pre' | 'in' | 'swipe-start' | 'swipe-end'>('free');
  const { face, back, edge } = useMemo(() => ({
    face: cardFace(id),
    back: cardBack(),
    edge: slab(footprint(-CARD.w / 2, -CARD.d / 2, CARD.w / 2, CARD.d / 2, [0.0032, 0.0032, 0.0032, 0.0032]), 0, CARD.t, 0.0002),
  }), [id]);
  useEffect(() => () => [face, back, edge].forEach((o) => o.dispose()), [face, back, edge]);
  const desk = useMemo(() => deskPose(index), [index]);
  useLayoutEffect(() => {
    group.current!.position.copy(desk.position);
    group.current!.quaternion.copy(desk.quaternion);
  }, [desk]);

  useFrame(({ invalidate }, delta) => {
    const g = group.current!;
    const dt = Math.min(delta, MAX_STEP);
    const near = (p: Pose, d = 0.002) => g.position.distanceTo(p.position) < d;
    // waypoints keep the card out of the terminal's body
    let target = desk;
    if (mode === 'insert') {
      if (stage.current !== 'in') stage.current = near(PRE_INSERT) ? 'in' : 'pre';
      target = stage.current === 'in' ? INSERTED : PRE_INSERT;
    } else if (mode === 'swipe') {
      if (stage.current !== 'swipe-end') stage.current = near(SWIPE_FROM) ? 'swipe-end' : 'swipe-start';
      target = stage.current === 'swipe-end' ? SWIPE_TO : SWIPE_FROM;
    } else if (mode === 'tap') {
      stage.current = 'free';
      target = TAP;
    } else if (stage.current === 'in') {
      target = PRE_INSERT;
      if (near(PRE_INSERT)) stage.current = 'free';
    } else {
      stage.current = 'free';
    }
    const speed = stage.current === 'in' || stage.current === 'swipe-end' ? 9 : 7;
    const before = g.position.clone();
    g.position.x = THREE.MathUtils.damp(g.position.x, target.position.x, speed, dt);
    g.position.y = THREE.MathUtils.damp(g.position.y, target.position.y, speed, dt);
    g.position.z = THREE.MathUtils.damp(g.position.z, target.position.z, speed, dt);
    // lift while travelling so it never scrapes the desk or the body
    if (mode !== 'desk' && stage.current !== 'in' && stage.current !== 'swipe-end') g.position.y = Math.max(g.position.y, Math.min(0.09, g.position.distanceTo(target.position) * 0.6 + target.position.y));
    g.quaternion.slerp(target.quaternion, 1 - Math.exp(-speed * dt));
    if (before.distanceToSquared(g.position) > 1e-12 || g.quaternion.angleTo(target.quaternion) > 1e-4) invalidate();
  });

  return (
    <group
      ref={group}
      onClick={(e) => {
        if (!onClick) return;
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        if (!onClick) return;
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => (document.body.style.cursor = '')}
    >
      <mesh geometry={edge} castShadow>
        <meshStandardMaterial color="#d9dade" roughness={0.4} />
      </mesh>
      <mesh position={[0, CARD.t + 0.00003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[CARD.w - 0.0004, CARD.d - 0.0004]} />
        <meshPhysicalMaterial map={face} roughness={0.32} clearcoat={0.6} clearcoatRoughness={0.25} />
      </mesh>
      <mesh position={[0, -0.00003, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[CARD.w - 0.0004, CARD.d - 0.0004]} />
        <meshStandardMaterial map={back} roughness={0.45} />
      </mesh>
    </group>
  );
}

// ---- the terminal ----

/** Contactless LEDs: one lit while waiting for a card, the four filling up while reading, all on when approved. */
function useLeds(status: TerminalSnapshot['status']) {
  const lit = useRef([false, false, false, false]);
  const since = useRef(performance.now());
  const phase = status.screen.phase;
  useEffect(() => {
    since.current = performance.now();
  }, [phase]);
  return { lit, since };
}

export function TerminalStation({ terminal, focused, onSelect }: { terminal: TerminalSnapshot; focused: boolean; onSelect: () => void }) {
  const { status, config } = terminal;
  const { screen } = status;
  const id = config.id;
  const invalidate = useThree((s) => s.invalidate);
  const [hover, setHover] = useState(false);
  const body = usePlastic('#25262a', 0.62);
  const geometry = useMemo(() => ({
    body: bodyGeometry(),
    key: slab(footprint(-0.0085, -0.0052, 0.0085, 0.0052, [0.0022, 0.0022, 0.0022, 0.0022]), 0, 0.003, 0.001),
    bezel: slab(footprint(-0.034, -0.0265, 0.034, 0.0265, [0.0045, 0.0045, 0.0045, 0.0045]), 0, 0.0014, 0.0006),
    well: slab(footprint(-0.035, -0.0093, 0.035, 0.0093, [0.0045, 0.0045, 0.0045, 0.0045]), 0, 0.0006, 0.0002),
  }), []);
  useEffect(() => () => Object.values(geometry).forEach((g) => g.dispose()), [geometry]);

  // live screen
  const screenCanvas = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = SCREEN.width;
    canvas.height = SCREEN.height;
    return canvas;
  }, []);
  const screenTexture = useMemo(() => {
    const t = new THREE.CanvasTexture(screenCanvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [screenCanvas]);
  useEffect(() => () => screenTexture.dispose(), [screenTexture]);
  useEffect(() => {
    drawScreen(screenCanvas.getContext('2d')!, status, performance.now() / 1000);
    screenTexture.needsUpdate = true;
    invalidate();
  }, [status, screenCanvas, screenTexture, invalidate]);

  // sounds on the moments a shopper hears
  const previous = useRef(screen.phase);
  useEffect(() => {
    const was = previous.current;
    previous.current = screen.phase;
    if (was === 'reading' && screen.phase !== 'reading') terminalSound.read();
    if (screen.phase === 'result' && was !== 'result') (screen.result === 'approved' ? terminalSound.approved : terminalSound.declined)();
  }, [screen.phase, screen.result]);

  const { lit, since } = useLeds(status);
  const ledMaterials = useMemo(() => [0, 1, 2, 3].map(() => new THREE.MeshStandardMaterial({ color: '#1b2a1e', emissive: '#3dff7a', emissiveIntensity: 0, roughness: 0.2, toneMapped: false })), []);
  useEffect(() => () => ledMaterials.forEach((m) => m.dispose()), [ledMaterials]);
  const lastSpin = useRef(0);
  useFrame(({ invalidate }) => {
    const now = performance.now();
    const t = (now - since.current) / 1000;
    const phase = screen.phase;
    const reading = phase === 'reading';
    const next = [0, 1, 2, 3].map((i) =>
      status.listening && (phase === 'card' ? i === 0 : reading ? t > i * 0.11 : phase === 'result' && screen.result === 'approved' ? t < 1.5 : false));
    if (next.some((v, i) => v !== lit.current[i])) {
      lit.current = next;
      next.forEach((on, i) => (ledMaterials[i].emissiveIntensity = on ? 2.6 : 0));
      invalidate();
    }
    if (reading || phase === 'result') invalidate(); // keep checking the timed LEDs
    // spinner on the screen at ~15 fps
    if ((reading || phase === 'authorizing') && now - lastSpin.current > 66) {
      lastSpin.current = now;
      drawScreen(screenCanvas.getContext('2d')!, status, now / 1000);
      screenTexture.needsUpdate = true;
      invalidate();
    }
  });

  const icons = useMemo(() => ({
    contactless: canvasTexture(128, 128, (ctx) => {
      ctx.strokeStyle = 'rgba(210,214,222,0.85)';
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(30, 64, 14 + i * 16, -0.8, 0.8);
        ctx.stroke();
      }
    }),
    brand: canvasTexture(512, 64, (ctx) => {
      ctx.fillStyle = 'rgba(205,210,218,0.55)';
      ctx.font = '700 34px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('P O S A N D B O X', 256, 44);
    }),
  }), []);
  useEffect(() => () => Object.values(icons).forEach((t) => t.dispose()), [icons]);

  // which card is where
  const presented = status.presented;
  const modeOf = (card: TestCardId): CardMode => {
    if (status.cardInserted === card || (presented?.card === card && presented.entry === 'ICC')) return 'insert';
    if (presented?.card === card && screen.phase === 'reading') return presented.entry === 'MagStripe' ? 'swipe' : 'tap';
    return 'desk';
  };
  const waiting = screen.phase === 'card';
  const press = (key: string) => (focused && key ? () => void terminalApi.key(id, key) : null);

  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (!focused) onSelect();
  };

  return (
    <group>
      <group
        onClick={select}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
          if (!focused) document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHover(false);
          document.body.style.cursor = '';
        }}
      >
        <mesh geometry={geometry.body} material={body} castShadow receiveShadow />
        {/* rubber feet */}
        {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => (
          <mesh key={`${sx}${sz}`} position={[sx * (W / 2 - 0.012), -0.0004, sz * (L / 2 - 0.016)]}>
            <cylinderGeometry args={[0.005, 0.005, 0.0012, 20]} />
            <meshStandardMaterial color="#0b0b0c" roughness={0.95} />
          </mesh>
        )))}
        {/* chip reader slot on the front face */}
        <group position={[0, SLOT_Y, L / 2]}>
          <mesh position={[0, 0, 0.0004]}>
            <boxGeometry args={[0.062, 0.0062, 0.0012]} />
            <meshPhysicalMaterial color="#1c1d20" roughness={0.35} clearcoat={0.5} />
          </mesh>
          <mesh position={[0, 0, 0.0011]}>
            <planeGeometry args={[0.057, 0.0016]} />
            <meshBasicMaterial color="#020203" />
          </mesh>
        </group>

        <group position={DECK.position} rotation={DECK.rotation}>
          {/* magnetic stripe slot across the rear */}
          <mesh geometry={geometry.well} position={[0, 0, MSR_U]}>
            <meshPhysicalMaterial color="#1f2024" roughness={0.4} clearcoat={0.4} />
          </mesh>
          <mesh position={[0, 0.00065, MSR_U]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.064, 0.0018]} />
            <meshBasicMaterial color="#020203" />
          </mesh>
          {/* contactless landing zone: LEDs and symbol above the screen */}
          {ledMaterials.map((m, i) => (
            <mesh key={i} position={[-0.0105 + i * 0.007, 0.0004, -0.0665]} rotation={[-Math.PI / 2, 0, 0]} material={m}>
              <circleGeometry args={[0.0014, 24]} />
            </mesh>
          ))}
          <mesh position={[-0.026, 0.0004, -0.0665]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.009, 0.009]} />
            <meshBasicMaterial map={icons.contactless} transparent depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-1} />
          </mesh>
          {/* screen: glossy black bezel, live display */}
          <mesh geometry={geometry.bezel} position={[0, 0, SCREEN_U]} castShadow>
            <meshPhysicalMaterial color="#08090b" roughness={0.12} clearcoat={1} clearcoatRoughness={0.06} />
          </mesh>
          {/* the display emits its own light: unlit and outside tone mapping, so white stays white */}
          <mesh position={[0, 0.00142, SCREEN_U]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.0576, 0.0432]} />
            <meshBasicMaterial map={screenTexture} color={status.listening ? '#ececec' : '#000000'} toneMapped={false} />
          </mesh>
          {/* cover glass: only reflections */}
          <mesh position={[0, 0.0016, SCREEN_U]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
            <planeGeometry args={[0.064, 0.049]} />
            <meshStandardMaterial color="#000000" transparent opacity={0.14} roughness={0.04} metalness={0} depthWrite={false} />
          </mesh>
          <mesh position={[0, 0.0003, -0.0055]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.04, 0.005]} />
            <meshBasicMaterial map={icons.brand} transparent depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-1} />
          </mesh>
          {KEYS.map((def) => (
            <Key key={def.label} def={def} geometry={geometry.key} onPress={press(def.key)} />
          ))}
        </group>
      </group>

      <Cables />

      {TEST_CARDS.map((c, i) => (
        <TestCard
          key={c.id}
          id={c.id}
          index={i}
          mode={modeOf(c.id)}
          onClick={focused && waiting ? () => void terminalApi.present(id, c.id, c.id === 'visa-msr' ? 'MagStripe' : 'Contactless') : focused ? null : onSelect}
        />
      ))}

      {!focused && hover && (
        <Html position={[0, 0.11, 0]} center zIndexRange={[10, 0]} className="scene-tip">
          <strong>{config.name}</strong>
          <span className="scene-tip-row">
            <i className={`led led-${!status.listening ? 'off' : screen.phase === 'idle' || screen.phase === 'result' ? 'ok' : 'warn'}`} />
            {!status.listening ? 'Off' : screen.phase === 'idle' || screen.phase === 'result' ? 'Ready' : screen.message}
            <span className="scene-tip-sep">·</span>
            <span className="mono">:{config.port}</span>
          </span>
          <span className="scene-tip-hint">Click to configure</span>
        </Html>
      )}
    </group>
  );
}

/** Power and network cables from the rear, down onto the desk and towards the wall. */
function Cables() {
  const geometry = useMemo(() => {
    const tube = (points: [number, number, number][], radius: number) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), 64, radius, 10);
    return {
      power: tube([[-0.016, 0.014, -L / 2 - 0.002], [-0.017, 0.012, -L / 2 - 0.02], [-0.02, 0.0025, -L / 2 - 0.05], [-0.03, -0.001, -0.2], [-0.045, -0.0012, -0.3]], 0.0022),
      lan: tube([[0.014, 0.012, -L / 2 - 0.002], [0.015, 0.01, -L / 2 - 0.02], [0.02, 0.0024, -L / 2 - 0.05], [0.03, -0.001, -0.2], [0.04, -0.0012, -0.3]], 0.0026),
    };
  }, []);
  useEffect(() => () => Object.values(geometry).forEach((g) => g.dispose()), [geometry]);
  return (
    <group>
      <mesh geometry={geometry.power} castShadow>
        <meshStandardMaterial color="#121214" roughness={0.6} />
      </mesh>
      <mesh geometry={geometry.lan} castShadow>
        <meshStandardMaterial color="#3d6fb6" roughness={0.45} />
      </mesh>
      {[[-0.016, 0.014], [0.014, 0.012]].map(([x, y]) => (
        <mesh key={x} position={[x, y, -L / 2 - 0.004]} castShadow>
          <boxGeometry args={[0.012, 0.009, 0.008]} />
          <meshStandardMaterial color="#1a1b1e" roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
}
