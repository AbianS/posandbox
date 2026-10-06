import { lazy, Suspense, useEffect, type CSSProperties } from 'react';
import { connectLab, useFocusedDrawer, useFocusedPrinter, useFocusedScanner, useFocusedTerminal, useLab, useSelectedPrinter } from './store.ts';
import { Header } from './components/Header.tsx';
import { PrinterPanel } from './components/PrinterPanel.tsx';
import { DrawerPanel } from './components/DrawerPanel.tsx';
import { TerminalPanel } from './components/TerminalPanel.tsx';
import { ScannerPanel } from './components/ScannerPanel.tsx';
import { BenchOverview } from './components/BenchOverview.tsx';
import { BottomPanel, ScannerBottomPanel, TerminalBottomPanel } from './components/BottomPanel.tsx';
import { Splitter } from './components/Splitter.tsx';
import { TicketViewer } from './components/TicketViewer.tsx';
import { Toast } from './components/Toast.tsx';

const Scene = lazy(() => import('./scene/Scene.tsx'));

export function App() {
  useEffect(() => connectLab(), []);
  const printer = useSelectedPrinter();
  const focused = useFocusedPrinter();
  const drawer = useFocusedDrawer();
  const terminal = useFocusedTerminal();
  const scanner = useFocusedScanner();
  const hasSnapshot = useLab((s) => s.snapshot !== null);
  const focus = useLab((s) => s.focus);
  const layout = useLab((s) => s.layout);
  const setLayout = useLab((s) => s.setLayout);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
      focus(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focus]);

  const style = { '--sidebar-w': `${layout.sidebar}px`, '--bottom-h': `${layout.bottom}px` } as CSSProperties;

  return (
    <div className="app" style={style}>
      <Header />
      <main className="workspace">
        <section className="stage" aria-label="3D workbench">
          <Suspense fallback={<div className="stage-loading"><span className="spinner" />Loading workbench…</div>}>
            <Scene />
          </Suspense>
        </section>
        <aside className="sidebar" aria-label={focused || drawer || terminal || scanner ? 'Device controls' : 'Workbench'}>
          {focused ? (
            <PrinterPanel printer={focused} />
          ) : drawer ? (
            <DrawerPanel printer={drawer} />
          ) : terminal ? (
            <TerminalPanel terminal={terminal} />
          ) : scanner ? (
            <ScannerPanel scanner={scanner} />
          ) : hasSnapshot ? (
            <BenchOverview />
          ) : (
            <p className="empty">Connecting to the lab…</p>
          )}
        </aside>
        <section className="bottom" aria-label={terminal ? 'Transactions and messages' : 'Receipts and inspector'}>
          {terminal ? <TerminalBottomPanel terminal={terminal} /> : scanner ? <ScannerBottomPanel scanner={scanner} /> : printer && <BottomPanel printer={printer} />}
        </section>
        <Splitter
          orientation="vertical"
          label="Sidebar width"
          value={layout.sidebar}
          min={300}
          max={640}
          defaultValue={380}
          onChange={(sidebar) => setLayout({ sidebar })}
        />
        <Splitter
          orientation="horizontal"
          label="Receipt panel height"
          value={layout.bottom}
          min={140}
          max={Math.round(window.innerHeight * 0.6)}
          defaultValue={260}
          onChange={(bottom) => setLayout({ bottom })}
        />
      </main>
      <TicketViewer />
      <Toast />
    </div>
  );
}
