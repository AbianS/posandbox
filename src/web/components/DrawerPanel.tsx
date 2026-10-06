import { HandPointing, PlugsConnected, Vault } from '@phosphor-icons/react';
import type { PrinterSnapshot } from '../../shared/contract.ts';
import { api } from '../store.ts';
import { Section } from './PrinterPanel.tsx';

/** The cash drawer's own panel. `printer` is the one it is wired to: the drawer has no network of its own. */
export function DrawerPanel({ printer }: { printer: PrinterSnapshot }) {
  const open = printer.status.drawerOpen;
  return (
    <div className="panel">
      <header className="panel-head">
        <div className="title-row">
          <span className="tile" aria-hidden="true">
            <Vault size={18} weight="duotone" />
          </span>
          <div className="title-text">
            <h2 className="device-name">Cash drawer</h2>
            <p className="device-model">4-note / 8-coin drawer · RJ12 24 V</p>
          </div>
        </div>
        <span className="status-line">
          <span className={`pill ${open ? 'pill-warn' : 'pill-ok'}`}>{open ? 'Open' : 'Closed'}</span>
        </span>
      </header>

      <Section title="Drawer" icon={HandPointing}>
        <div className="fault-row">
          <div>
            <div className="fault-label">{open ? 'Open' : 'Closed and latched'}</div>
            <div className="fault-hint">A pulse releases the latch and the spring pushes the drawer out; close it by hand.</div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => api.setDrawer(printer.config.id, !open)}>
            {open ? 'Close' : 'Open with key'}
          </button>
        </div>
      </Section>

      <Section title="Connection" icon={PlugsConnected}>
        <p className="note">
          RJ12 cable to the drawer connector on <strong>{printer.config.name}</strong> (pin 2). The POS opens the drawer through the
          printer using <code>ESC p</code> or <code>DLE DC4 1</code>, and reads its open status on pin 3 (<code>DLE EOT 1</code>, <code>GS r 2</code> or ASB).
        </p>
      </Section>
    </div>
  );
}
