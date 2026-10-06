import { memo, Suspense, useCallback, useEffect, useState } from 'react';
import { Barcode, Cards, Coins, CreditCard, Package, CubeTransparent, DeviceMobile, GridFour, Printer, Rabbit, Receipt, Scroll, SpeakerHigh, SpeakerSlash, Vault, type Icon } from '@phosphor-icons/react';
import { Canvas, invalidate } from '@react-three/fiber';
import { EffectComposer, N8AO, SMAA, ToneMapping } from '@react-three/postprocessing';
import { AccumulativeShadows, Environment, RandomizedLight } from '@react-three/drei';
import { MAT } from './bench.ts';
import { ToneMappingMode } from 'postprocessing';
import * as THREE from 'three';
import { DRAWER_ID, useFocusedDrawer, useFocusedPrinter, useFocusedScanner, useFocusedTerminal, useLab } from '../store.ts';
import { drawerPosition, printerPosition, scannerPosition, terminalPosition } from './bench.ts';
import { ScannerStation } from './ScannerStation.tsx';
import { TerminalStation } from './TerminalStation.tsx';
import { DrawerStation } from './DrawerStation.tsx';
import { CameraRig, type CameraPose } from './CameraRig.tsx';
import { DeviceTools, DrawerTools, ScannerTools, TerminalTools } from './DeviceTools.tsx';
import { PrinterStation } from './PrinterStation.tsx';
import { printingSound } from './sound.ts';
import { Workbench } from './Workbench.tsx';
import { PERF_ENABLED, PERF_FLAGS, PerfProbe } from './PerfProbe.tsx';
import { Tool } from '../components/ui.tsx';


type View = 'device' | 'paper' | 'inside' | 'tickets' | 'front' | 'tray' | 'terminal' | 'screen' | 'cards' | 'scanner' | 'products';

const PRINTER_VIEWS: { view: View; label: string; icon: Icon }[] = [
  { view: 'device', label: 'Printer', icon: Printer },
  { view: 'paper', label: 'Paper', icon: Scroll },
  { view: 'inside', label: 'Inside', icon: CubeTransparent },
  { view: 'tickets', label: 'Cut receipts', icon: Receipt },
];
const TERMINAL_VIEWS: typeof PRINTER_VIEWS = [
  { view: 'terminal', label: 'Payment terminal', icon: CreditCard },
  { view: 'screen', label: 'Screen', icon: DeviceMobile },
  { view: 'cards', label: 'Cards', icon: Cards },
];
const SCANNER_VIEWS: typeof PRINTER_VIEWS = [
  { view: 'scanner', label: 'Scanner', icon: Barcode },
  { view: 'products', label: 'Products', icon: Package },
];
const DRAWER_VIEWS: typeof PRINTER_VIEWS = [
  { view: 'front', label: 'Drawer', icon: Vault },
  { view: 'tray', label: 'Tray', icon: Coins },
];

const OVERVIEW: CameraPose = { position: [0.07, 0.58, 0.98], target: [0.07, 0.02, -0.03] };

function devicePose([x, , z]: [number, number, number], view: View): CameraPose {
  switch (view) {
    case 'device': return { position: [x + 0.14, 0.25, z + 0.4], target: [x, 0.07, z + 0.03] };
    case 'paper': return { position: [x + 0.02, 0.23, z + 0.3], target: [x, 0.16, z] };
    case 'inside': return { position: [x + 0.04, 0.3, z + 0.17], target: [x, 0.07, z - 0.012] };
    case 'tickets': return { position: [x + 0.02, 0.36, z + 0.36], target: [x, 0, z + 0.17] };
    default: return OVERVIEW;
  }
}

function terminalPose(view: View): CameraPose {
  const [x, , z] = terminalPosition();
  switch (view) {
    case 'screen': return { position: [x + 0.005, 0.25, z + 0.13], target: [x, 0.05, z - 0.03] };
    case 'cards': return { position: [x + 0.03, 0.3, z + 0.4], target: [x, 0.02, z + 0.1] };
    default: return { position: [x + 0.15, 0.26, z + 0.4], target: [x, 0.035, z + 0.04] };
  }
}

function scannerPose(view: View): CameraPose {
  const [x, , z] = scannerPosition();
  return view === 'products'
    ? { position: [x + 0.16, 0.36, z + 0.36], target: [x + 0.14, 0.01, z + 0.05] }
    : { position: [x + 0.2, 0.3, z + 0.44], target: [x + 0.04, 0.06, z + 0.02] };
}

function drawerPose(view: View): CameraPose {
  const [x, , z] = drawerPosition();
  return view === 'tray'
    ? { position: [x + 0.06, 0.62, z + 0.78], target: [x, 0, z + 0.19] }
    : { position: [x + 0.16, 0.3, z + 0.78], target: [x, 0.05, z + 0.1] };
}

/**
 * Shadows baked once at load (from the key light's direction plus soft ambient), instead of real-time
 * shadow maps on every frame. Never re-baked at runtime: accumulating toggles lights on and off, and in
 * three.js a change in the light count recompiles every material (measured: ~0.8 s freeze per re-bake).
 * Moving paper does not cast shadows, so nothing gets frozen into the bake.
 */
const BakedShadows = memo(function BakedShadows() {
  return (
    <AccumulativeShadows temporal frames={60} alphaTest={0.75} opacity={0.85} scale={1.2} resolution={1024}
      color="#0b0907" colorBlend={2} position={[0, MAT.thickness + 0.0003, MAT.z]}>
      <RandomizedLight amount={8} radius={0.12} ambient={0.35} intensity={1.4} position={[0.45, 1.2, 0.7]} size={0.6} near={0.1} far={3} mapSize={1024} bias={0.0002} />
    </AccumulativeShadows>
  );
});

export default function Scene() {
  const printers = useLab((s) => s.snapshot?.printers ?? []);
  const focus = useLab((s) => s.focus);
  const toBench = useCallback(() => focus(null), [focus]); // stable: keeps the memoised bench from re-rendering
  const focused = useFocusedPrinter();
  const drawer = useFocusedDrawer();
  const terminal = useFocusedTerminal();
  const terminals = useLab((s) => s.snapshot?.terminals ?? []);
  const scanner = useFocusedScanner();
  const scanners = useLab((s) => s.snapshot?.scanners ?? []);
  const focusedId = focused?.config.id ?? terminal?.config.id ?? scanner?.config.id ?? (drawer ? DRAWER_ID : null);
  const realSpeed = useLab((s) => s.realSpeed);
  const setRealSpeed = useLab((s) => s.setRealSpeed);
  const [sound, setSound] = useState(printingSound.enabled);
  // the chosen view belongs to one device: focusing another starts again from its front
  const [chosen, setChosen] = useState<{ id: string; view: View } | null>(null);
  const views = drawer ? DRAWER_VIEWS : terminal ? TERMINAL_VIEWS : scanner ? SCANNER_VIEWS : PRINTER_VIEWS;
  const view = chosen && chosen.id === focusedId ? chosen.view : views[0].view;

  const focusedIndex = printers.findIndex((p) => p.config.id === focused?.config.id);
  const drawerPrinter = printers[0]; // the drawer is wired to the first printer
  const toDrawer = useCallback(() => focus(DRAWER_ID), [focus]);
  const pose = drawer ? drawerPose(view) : terminal ? terminalPose(view) : scanner ? scannerPose(view) : focusedIndex >= 0 ? devicePose(printerPosition(focusedIndex), view) : OVERVIEW;

  useEffect(() => invalidate(), [pose]);

  useEffect(() => {
    if (!focusedId) return;
    const id = focusedId;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
      const next = views[Number(e.key) - 1];
      if (next) setChosen({ id, view: next.view });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusedId, views]);

  return (
    <>
      <div className="stage-canvas">
        <Canvas
          shadows
          dpr={[1, 2]}
          frameloop="demand"
          camera={{ position: OVERVIEW.position, fov: 34, near: 0.01, far: 20 }}
          gl={{ antialias: false, toneMapping: THREE.NoToneMapping, powerPreference: 'high-performance' }}
        >
          <color attach="background" args={['#16171c']} />
          <CameraRig pose={pose} />
          {PERF_ENABLED && <PerfProbe />}
          <Suspense fallback={null}>
            <Environment files="/hdri/studio.hdr" environmentIntensity={0.75} environmentRotation={[0, Math.PI / 3, 0]} />
            <Workbench onBackgroundClick={toBench} />
            {printers.map((printer, i) => (
              <group key={printer.config.id} position={printerPosition(i)}>
                <PrinterStation printer={printer} focused={printer.config.id === focused?.config.id} onSelect={() => focus(printer.config.id)} />
              </group>
            ))}
            {scanners[0] && (
              <group position={scannerPosition()}>
                <ScannerStation scanner={scanners[0]} focused={scanner?.config.id === scanners[0].config.id} onSelect={() => focus(scanners[0].config.id)} />
              </group>
            )}
            {terminals[0] && (
              <group position={terminalPosition()}>
                <TerminalStation terminal={terminals[0]} focused={terminal?.config.id === terminals[0].config.id} onSelect={() => focus(terminals[0].config.id)} />
              </group>
            )}
            {drawerPrinter && (
              <group position={drawerPosition()}>
                <DrawerStation printer={drawerPrinter} focused={!!drawer} onSelect={toDrawer} />
              </group>
            )}
            <BakedShadows />
          </Suspense>
          <directionalLight position={[0.45, 1.2, 0.7]} intensity={1.5} color="#fff6ea" />
          {!PERF_FLAGS.noFx && (
            <EffectComposer multisampling={0}>
              <>{!PERF_FLAGS.noAo && <N8AO aoRadius={0.05} distanceFalloff={0.5} intensity={2.2} quality={(PERF_FLAGS.aoQuality as 'low' | 'medium' | 'performance' | null) ?? 'medium'} halfRes />}</>
              <>{!PERF_FLAGS.noSmaa && <SMAA />}</>
              <ToneMapping mode={ToneMappingMode.AGX} />
            </EffectComposer>
          )}
        </Canvas>
      </div>

      <div className="vp-crumbs" aria-live="polite">
        <span className={focusedId ? 'crumb' : 'crumb crumb-current'}>Workbench</span>
        {focusedId && (
          <>
            <span className="crumb-sep" aria-hidden="true">/</span>
            <span className="crumb crumb-current">{focused?.config.name ?? terminal?.config.name ?? scanner?.config.name ?? 'Cash drawer'}</span>
          </>
        )}
      </div>

      <nav className="vp-rail" role="toolbar" aria-orientation="vertical" aria-label="Workbench and devices">
        <Tool icon={GridFour} label="Workbench" kbd="Esc" tip="right" pressed={!focusedId} onClick={() => focus(null)} />
        <span className="vp-sep" aria-hidden="true" />
        {printers.map((p) => (
          <Tool
            key={p.config.id}
            icon={Printer}
            label={p.config.name}
            tip="right"
            status={!p.status.listening ? 'off' : p.status.online ? 'ok' : 'warn'}
            pressed={p.config.id === focused?.config.id}
            onClick={() => focus(p.config.id)}
          />
        ))}
        {terminals.map((t) => (
          <Tool
            key={t.config.id}
            icon={CreditCard}
            label={t.config.name}
            tip="right"
            status={!t.status.listening ? 'off' : t.status.screen.phase === 'idle' || t.status.screen.phase === 'result' ? 'ok' : 'warn'}
            pressed={t.config.id === terminal?.config.id}
            onClick={() => focus(t.config.id)}
          />
        ))}
        {scanners.map((s) => (
          <Tool
            key={s.config.id}
            icon={Barcode}
            label={s.config.name}
            tip="right"
            status={!s.config.enabled ? 'off' : s.status.link && !s.status.link.ok ? 'warn' : 'ok'}
            pressed={s.config.id === scanner?.config.id}
            onClick={() => focus(s.config.id)}
          />
        ))}
        {drawerPrinter && (
          <Tool
            icon={Vault}
            label="Cash drawer"
            tip="right"
            status={drawerPrinter.status.drawerOpen ? 'warn' : 'ok'}
            pressed={!!drawer}
            onClick={toDrawer}
          />
        )}
      </nav>

      {focusedId && (
        <div className="vp-views" role="toolbar" aria-label="Device view">
          {views.map((v, i) => (
            <Tool key={v.view} icon={v.icon} label={v.label} kbd={String(i + 1)} tip="bottom" pressed={view === v.view} onClick={() => setChosen({ id: focusedId, view: v.view })} />
          ))}
        </div>
      )}

      <div className="vp-toggles" role="toolbar" aria-label="Animation">
        <Tool icon={Rabbit} label="Real speed" tip="bottom" pressed={realSpeed} onClick={() => setRealSpeed(!realSpeed)} />
        <Tool
          icon={sound ? SpeakerHigh : SpeakerSlash}
          label="Sound"
          tip="bottom"
          pressed={sound}
          onClick={() => {
            printingSound.setEnabled(!sound);
            setSound(!sound);
          }}
        />
      </div>

      {focused ? <DeviceTools printer={focused} /> : drawer ? <DrawerTools printer={drawer} /> : terminal ? <TerminalTools terminal={terminal} /> : scanner ? <ScannerTools scanner={scanner} /> : <p className="vp-hint">Click a device to work with it</p>}
    </>
  );
}
