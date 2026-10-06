import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import bwipjs from 'bwip-js/browser';
import { TEST_BARCODES, type ScannerSnapshot, type TestBarcodeId } from '../../shared/contract.ts';
import { scannerApi } from '../store.ts';
import { MAT } from './bench.ts';
import { MAX_STEP } from './paper-path.ts';
import { footprint, slab, usePlastic } from './PrinterModel.tsx';
import { scannerSound } from './sound.ts';

// Handheld 1D/2D imager (gun type) resting nose-down in its presentation stand, and a few products with
// real, valid barcodes waiting on the desk beside the pad. A scan brings the product in front of the window,
// barcode towards it; the aiming beam shows only while it is being read. Origin: the scanner slot's centre on
// the pad, +z towards the user.

const STAND = { x: 0, z: -0.045 };
/** Where the gun rests in the stand, and its tilt (nose down towards the products). */
const GUN = { position: new THREE.Vector3(0, 0.118, -0.06), tilt: 0.62 };
/** The exit window in the gun's own frame (+z is the nose). */
const WINDOW = new THREE.Vector3(0, 0.024, 0.058);

const GUN_FRAME = new THREE.Object3D();
GUN_FRAME.position.copy(GUN.position);
GUN_FRAME.rotation.x = GUN.tilt;
GUN_FRAME.updateMatrix();
/** The window, and the point 9 cm in front of it where a presented barcode is read. */
const WINDOW_AT = WINDOW.clone().applyMatrix4(GUN_FRAME.matrix);
const NOSE = new THREE.Vector3(0, 0, 1).applyQuaternion(GUN_FRAME.quaternion);
const READ_AT = WINDOW_AT.clone().addScaledVector(NOSE, 0.09);
/** The desk beside the pad, in this station's frame. */
const DESK_Y = -(MAT.thickness + 0.0002);

const BCID: Record<string, string> = { 'EAN-13': 'ean13', 'EAN-8': 'ean8', 'UPC-A': 'upca', 'Code 128': 'code128', QR: 'qrcode' };

function texture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A printed barcode as bwip-js renders it (the same symbology rules a decoder checks). */
function barcodeCanvas(id: TestBarcodeId): HTMLCanvasElement {
  const b = TEST_BARCODES.find((c) => c.id === id)!;
  const canvas = document.createElement('canvas');
  const linear = b.symbology !== 'QR';
  bwipjs.toCanvas(canvas, { bcid: BCID[b.symbology], text: b.data, scale: 4, ...(linear ? { height: 14, includetext: true, textxalign: 'center' } : {}), backgroundcolor: 'FFFFFF', paddingwidth: 6, paddingheight: 4 });
  return canvas;
}

/** A label: background, brand text and the barcode placed where packaging puts it. */
function label(id: TestBarcodeId, w: number, h: number, draw: (ctx: CanvasRenderingContext2D, code: HTMLCanvasElement) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!, barcodeCanvas(id));
  return texture(canvas);
}

interface Pose { position: THREE.Vector3; quaternion: THREE.Quaternion }

interface Product {
  id: TestBarcodeId;
  Model: () => React.JSX.Element;
  /** Resting on the desk, right of the pad. */
  rest: Pose;
  /** The barcode on the product (its own frame): centre and the face's outward normal. */
  code: { at: THREE.Vector3; normal: THREE.Vector3 };
}

const restPose = (x: number, z: number, ry: number): Pose => ({ position: new THREE.Vector3(x, DESK_Y, z), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)) });

/** Held in front of the window: barcode centre on the read point, facing the scanner. */
function readPose(code: Product['code']): Pose {
  const quaternion = new THREE.Quaternion().setFromUnitVectors(code.normal, NOSE.clone().negate());
  return { position: READ_AT.clone().sub(code.at.clone().applyQuaternion(quaternion)), quaternion };
}

function WaterBottle() {
  const map = useMemo(() => label('water', 1024, 256, (ctx, code) => {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#e8f4fb');
    g.addColorStop(1, '#bfe0f2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 256);
    ctx.fillStyle = '#0b5c8e';
    ctx.font = '800 92px system-ui, sans-serif';
    ctx.fillText('WATER', 60, 128);
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.fillText('natural mineral · 50 cl', 62, 186);
    ctx.drawImage(code, 600, 40, 300, 300 * (code.height / code.width));
  }), []);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <group>
      <mesh position={[0, 0.085, 0]} castShadow>
        <cylinderGeometry args={[0.031, 0.031, 0.17, 40]} />
        <meshPhysicalMaterial color="#d9eef8" transparent opacity={0.55} roughness={0.08} clearcoat={1} />
      </mesh>
      <mesh position={[0, 0.07, 0]}>
        <cylinderGeometry args={[0.0315, 0.0315, 0.06, 40, 1, true]} />
        <meshStandardMaterial map={map} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.183, 0]} castShadow>
        <cylinderGeometry args={[0.0145, 0.0145, 0.018, 28]} />
        <meshStandardMaterial color="#1565c0" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.17, 0]}>
        <cylinderGeometry args={[0.015, 0.031, 0.012, 40, 1, true]} />
        <meshPhysicalMaterial color="#d9eef8" transparent opacity={0.55} roughness={0.08} />
      </mesh>
    </group>
  );
}

function Chocolate() {
  const map = useMemo(() => label('chocolate', 1024, 512, (ctx, code) => {
    ctx.fillStyle = '#5b2a17';
    ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = '#e8c27a';
    ctx.font = 'italic 800 110px Georgia, serif';
    ctx.fillText('Cocoa', 70, 200);
    ctx.font = '600 44px system-ui, sans-serif';
    ctx.fillText('dark chocolate 72 %', 74, 280);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(700, 300, 280, 180);
    ctx.drawImage(code, 712, 310, 256, 256 * (code.height / code.width));
  }), []);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <group>
      <mesh position={[0, 0.006, 0]} castShadow>
        <boxGeometry args={[0.155, 0.012, 0.078]} />
        <meshStandardMaterial color="#4a2213" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.0122, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.155, 0.078]} />
        <meshStandardMaterial map={map} roughness={0.45} metalness={0.05} />
      </mesh>
    </group>
  );
}

function Cereal() {
  const map = useMemo(() => label('cereal', 512, 768, (ctx, code) => {
    const g = ctx.createLinearGradient(0, 0, 0, 768);
    g.addColorStop(0, '#f6b21b');
    g.addColorStop(1, '#e2611a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 768);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 96px system-ui, sans-serif';
    ctx.fillText('CRUNCH', 40, 150);
    ctx.font = '700 40px system-ui, sans-serif';
    ctx.fillText('corn flakes', 44, 210);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(256, 430, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(250, 590, 240, 160);
    ctx.drawImage(code, 258, 598, 224, 224 * (code.height / code.width));
  }), []);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <group>
      <mesh position={[0, 0.065, 0]} castShadow>
        <boxGeometry args={[0.085, 0.13, 0.032]} />
        <meshStandardMaterial color="#e8821a" roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.065, 0.0162]}>
        <planeGeometry args={[0.085, 0.13]} />
        <meshStandardMaterial map={map} roughness={0.6} />
      </mesh>
    </group>
  );
}

function Coupon() {
  const map = useMemo(() => label('coupon', 512, 640, (ctx, code) => {
    ctx.fillStyle = '#fbfaf7';
    ctx.fillRect(0, 0, 512, 640);
    ctx.fillStyle = '#c62828';
    ctx.font = '800 64px system-ui, sans-serif';
    ctx.fillText('-25 %', 40, 96);
    ctx.fillStyle = '#333';
    ctx.font = '500 30px system-ui, sans-serif';
    ctx.fillText('Discount coupon', 42, 146);
    ctx.drawImage(code, 96, 190, 320, 320);
    ctx.font = '500 22px system-ui, sans-serif';
    ctx.fillText('Valid until 31 Dec', 42, 590);
  }), []);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <mesh position={[0, 0.0006, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[0.06, 0.075]} />
      <meshStandardMaterial map={map} roughness={0.85} side={THREE.DoubleSide} />
    </mesh>
  );
}

// Barcode positions follow the label drawings above (canvas → face of the product).
const PRODUCTS: Product[] = [
  { id: 'cereal', Model: Cereal, rest: restPose(0.14, -0.03, -0.3), code: { at: new THREE.Vector3(0.0189, 0.0195, 0.0162), normal: new THREE.Vector3(0, 0, 1) } },
  { id: 'water', Model: WaterBottle, rest: restPose(0.215, 0.03, 0.6), code: { at: new THREE.Vector3(-0.0313, 0.073, -0.0035), normal: new THREE.Vector3(-0.994, 0, -0.11) } },
  { id: 'chocolate', Model: Chocolate, rest: restPose(0.14, 0.11, 1.4), code: { at: new THREE.Vector3(0.0496, 0.0122, 0.0203), normal: new THREE.Vector3(0, 1, 0) } },
  { id: 'coupon', Model: Coupon, rest: restPose(0.21, 0.13, 0.4), code: { at: new THREE.Vector3(0, 0.0006, 0.0035), normal: new THREE.Vector3(0, 1, 0) } },
];

/** A product moving between its place on the desk and the scanner's window (lifted while it travels). */
function Presented({ product, reading, onClick, onPose }: { product: Product; reading: boolean; onClick: (e: ThreeEvent<MouseEvent>) => void; onPose: (arrived: boolean) => void }) {
  const group = useRef<THREE.Group>(null);
  const read = useMemo(() => readPose(product.code), [product]);
  useEffect(() => {
    group.current!.position.copy(product.rest.position);
    group.current!.quaternion.copy(product.rest.quaternion);
  }, [product]);
  useFrame(({ invalidate }, delta) => {
    const g = group.current!;
    const dt = Math.min(delta, MAX_STEP);
    const target = reading ? read : product.rest;
    const before = g.position.clone();
    const speed = 9;
    g.position.x = THREE.MathUtils.damp(g.position.x, target.position.x, speed, dt);
    g.position.z = THREE.MathUtils.damp(g.position.z, target.position.z, speed, dt);
    const remaining = g.position.distanceTo(target.position);
    // arc: up while travelling, down onto the target at the end
    g.position.y = THREE.MathUtils.damp(g.position.y, target.position.y + Math.min(0.06, remaining * 0.5), speed, dt);
    g.quaternion.slerp(target.quaternion, 1 - Math.exp(-speed * dt));
    const moving = before.distanceToSquared(g.position) > 1e-12 || g.quaternion.angleTo(target.quaternion) > 1e-4;
    if (moving) invalidate();
    onPose(reading && g.position.distanceTo(read.position) < 0.004);
  });
  return (
    <group ref={group} onClick={onClick}>
      <product.Model />
    </group>
  );
}

/** The gun: rounded head with the exit window, angled grip, trigger and status LED. */
function Gun({ windowMaterial, led }: { windowMaterial: React.RefObject<THREE.MeshPhysicalMaterial | null>; led: 'off' | 'green' | 'red' }) {
  const shell = usePlastic('#26272b', 0.55);
  const grip = usePlastic('#18191c', 0.85);
  const geometry = useMemo(() => ({
    head: slab(footprint(-0.03, -0.055, 0.03, 0.058, [0.026, 0.026, 0.012, 0.012]), 0, 0.048, 0.013),
    window: slab(footprint(-0.024, -0.002, 0.024, 0.002, [0.0015, 0.0015, 0.0015, 0.0015]), 0, 0.03, 0.001),
    grip: new THREE.CapsuleGeometry(0.0165, 0.085, 8, 24),
    trigger: slab(footprint(-0.007, -0.006, 0.007, 0.006, [0.005, 0.005, 0.005, 0.005]), 0, 0.022, 0.003),
  }), []);
  useEffect(() => () => Object.values(geometry).forEach((g) => g.dispose()), [geometry]);
  return (
    <group>
      <mesh geometry={geometry.head} material={shell} castShadow receiveShadow />
      {/* exit window: dark red glass, glowing while the imager is on */}
      <mesh geometry={geometry.window} position={[0, 0.009, 0.0575]}>
        <meshPhysicalMaterial ref={windowMaterial} color="#3a0507" emissive="#ff1e1e" emissiveIntensity={0} roughness={0.08} clearcoat={1} />
      </mesh>
      <mesh geometry={geometry.grip} material={grip} position={[0, -0.04, -0.03]} rotation={[-0.32, 0, 0]} castShadow />
      <mesh geometry={geometry.trigger} position={[0, -0.022, 0.0]} rotation={[-0.32, 0, 0]} castShadow>
        <meshStandardMaterial color="#3a3c42" roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.0485, -0.032]}>
        <sphereGeometry args={[0.0026, 20, 12]} />
        <meshStandardMaterial color={led === 'off' ? '#1f2a1f' : led === 'green' ? '#7dff9a' : '#ff6b5b'} emissive={led === 'green' ? '#2bff6a' : '#ff3b2b'} emissiveIntensity={led === 'off' ? 0 : 3} toneMapped={led === 'off'} />
      </mesh>
      {/* grey accent band */}
      <mesh position={[0, 0.0245, -0.0005]}>
        <boxGeometry args={[0.0605, 0.004, 0.09]} />
        <meshStandardMaterial color="#4a4d55" roughness={0.5} />
      </mesh>
    </group>
  );
}

function Stand() {
  const body = usePlastic('#202125', 0.7);
  return (
    <group position={[STAND.x, 0, STAND.z]}>
      <mesh position={[0, 0.006, 0]} material={body} castShadow receiveShadow>
        <cylinderGeometry args={[0.048, 0.052, 0.012, 48]} />
      </mesh>
      <mesh position={[0, 0.0005, 0]}>
        <cylinderGeometry args={[0.051, 0.051, 0.001, 48]} />
        <meshStandardMaterial color="#0b0b0c" roughness={0.95} />
      </mesh>
      {/* neck and cup that hold the grip */}
      <mesh position={[0, 0.03, -0.012]} rotation={[-0.32, 0, 0]} material={body} castShadow>
        <cylinderGeometry args={[0.012, 0.016, 0.045, 24]} />
      </mesh>
      <mesh position={[0, 0.058, -0.02]} rotation={[-0.3, 0, 0]} material={body} castShadow>
        <cylinderGeometry args={[0.024, 0.02, 0.03, 32, 1, true]} />
      </mesh>
    </group>
  );
}

export function ScannerStation({ scanner, focused, onSelect }: { scanner: ScannerSnapshot; focused: boolean; onSelect: () => void }) {
  const { config, status } = scanner;
  const invalidate = useThree((s) => s.invalidate);
  const [hover, setHover] = useState(false);
  const [led, setLed] = useState<'off' | 'green' | 'red'>('off');
  const beam = useRef<THREE.Mesh>(null);
  const windowMaterial = useRef<THREE.MeshPhysicalMaterial>(null);
  const scanning = status.scanning;
  /** The product being read, if the code belongs to one on the desk. */
  const product = PRODUCTS.find((p) => TEST_BARCODES.find((b) => b.id === p.id)?.data === scanning);
  const arrived = useRef(false);
  useEffect(() => {
    arrived.current = false; // each read waits for its product to reach the window
    invalidate();
  }, [scanning, invalidate]);

  // good read: beep and green flash; a code the POS did not get: red
  const lastSeq = useRef(scanner.scans[0]?.seq ?? 0);
  useEffect(() => {
    const last = scanner.scans[0];
    if (!last || last.seq === lastSeq.current) return;
    lastSeq.current = last.seq;
    scannerSound.goodRead();
    setLed(last.delivered ? 'green' : 'red');
    const timer = setTimeout(() => setLed('off'), 600);
    return () => clearTimeout(timer);
  }, [scanner.scans]);

  // the aiming beam lights only while a code is being read and the product is in front of the window
  const beamGeometry = useMemo(() => new THREE.ConeGeometry(1, 1, 4, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.5), []);
  useEffect(() => () => beamGeometry.dispose(), [beamGeometry]);
  useFrame(() => {
    const mesh = beam.current;
    if (!mesh) return;
    const on = Boolean(scanning) && (!product || arrived.current);
    if (windowMaterial.current) windowMaterial.current.emissiveIntensity = on ? 2.4 : 0;
    mesh.visible = on;
    if (!on) return;
    const length = WINDOW_AT.distanceTo(READ_AT) + 0.004;
    mesh.position.copy(WINDOW_AT);
    mesh.lookAt(READ_AT);
    mesh.scale.set(0.03, 0.002, length);
  });

  const scan = (id: TestBarcodeId) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (!focused) return onSelect();
    if (!scanning && config.enabled) void scannerApi.scan(config.id, TEST_BARCODES.find((b) => b.id === id)!.data);
  };

  return (
    <group>
      <group
        onClick={(e) => {
          e.stopPropagation();
          if (!focused) onSelect();
        }}
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
        <Stand />
        <group position={GUN.position} rotation={[GUN.tilt, 0, 0]}>
          <Gun windowMaterial={windowMaterial} led={led} />
        </group>
        <ScannerCable />
      </group>

      <mesh ref={beam} geometry={beamGeometry} visible={false} renderOrder={3}>
        <meshBasicMaterial color="#ff2a2a" transparent opacity={0.55} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>

      <group
        onPointerOver={(e) => {
          if (!focused) return;
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        {PRODUCTS.map((p) => (
          <Presented
            key={p.id}
            product={p}
            reading={p === product}
            onClick={scan(p.id)}
            onPose={(at) => {
              if (p === product && at !== arrived.current) arrived.current = at;
            }}
          />
        ))}
      </group>

      {!focused && hover && (
        <Html position={[0, 0.2, -0.05]} center zIndexRange={[10, 0]} className="scene-tip">
          <strong>{config.name}</strong>
          <span className="scene-tip-row">
            <i className={`led led-${!config.enabled ? 'off' : status.link && !status.link.ok ? 'warn' : 'ok'}`} />
            {!config.enabled ? 'Disconnected' : status.link ? (status.link.ok ? 'POS found' : 'No POS') : 'Ready'}
          </span>
          <span className="scene-tip-hint">Click to configure</span>
        </Html>
      )}
    </group>
  );
}

/** USB cable from the grip, through the stand, to the back of the bench. */
function ScannerCable() {
  const geometry = useMemo(
    () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, 0.012, STAND.z - 0.045], [0, 0.003, STAND.z - 0.07], [0.01, 0.0018, -0.16], [0.02, -0.0012, -0.3]].map((p) => new THREE.Vector3(...p))), 48, 0.0022, 10),
    [],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} castShadow>
      <meshStandardMaterial color="#141416" roughness={0.6} />
    </mesh>
  );
}
