import { Barcode, CaretRight, CreditCard, Printer, Scales, Vault } from '@phosphor-icons/react';
import { DRAWER_ID, useLab } from '../store.ts';
import { StatusLine } from './PrinterPanel.tsx';
import { TerminalStatusLine } from './TerminalPanel.tsx';
import { ScannerStatusLine } from './ScannerPanel.tsx';

const UPCOMING = [
  { name: 'Scale', hint: 'Weighing with a serial scale protocol.', icon: Scales },
];

export function BenchOverview() {
  const printers = useLab((s) => s.snapshot?.printers) ?? [];
  const terminals = useLab((s) => s.snapshot?.terminals) ?? [];
  const scanners = useLab((s) => s.snapshot?.scanners) ?? [];
  const focus = useLab((s) => s.focus);

  return (
    <div className="panel">
      <header className="panel-head">
        <h2 className="device-name">Workbench</h2>
        <p className="device-model">Select a device on the workbench or here to configure it.</p>
      </header>

      <section className="section">
        <h3 className="section-title">
          On the workbench <span className="count">{printers.length + (printers.length ? 1 : 0) + terminals.length + scanners.length}</span>
        </h3>
        {printers.length === 0 ? (
          <p className="empty">No devices</p>
        ) : (
          <ul className="bench-list">
            {printers.map((p) => (
              <li key={p.config.id}>
                <button type="button" className="bench-card" aria-label={`Configure ${p.config.name}`} onClick={() => focus(p.config.id)}>
                  <span className="tile" aria-hidden="true">
                    <Printer size={18} weight="duotone" />
                  </span>
                  <span className="bench-card-body">
                    <span className="bench-card-name">{p.config.name}</span>
                    <span className="bench-card-kind">Receipt printer · ESC/POS TCP</span>
                    <StatusLine printer={p} />
                    <span className="bench-card-foot">
                      <code>tcp://{location.hostname}:{p.config.port}</code>
                      <span className="muted">{p.tickets.length === 1 ? '1 receipt' : `${p.tickets.length} receipts`}</span>
                    </span>
                  </span>
                  <CaretRight size={14} className="bench-card-go" aria-hidden />
                </button>
              </li>
            ))}
            {terminals.map((t) => (
              <li key={t.config.id}>
                <button type="button" className="bench-card" aria-label={`Configure ${t.config.name}`} onClick={() => focus(t.config.id)}>
                  <span className="tile" aria-hidden="true">
                    <CreditCard size={18} weight="duotone" />
                  </span>
                  <span className="bench-card-body">
                    <span className="bench-card-name">{t.config.name}</span>
                    <span className="bench-card-kind">Adyen Terminal API (nexo) · {t.config.poiid}</span>
                    <TerminalStatusLine terminal={t} />
                    <span className="bench-card-foot">
                      <code>https://{location.hostname}:{t.config.port}/nexo</code>
                      <span className="muted">{t.transactions.length === 1 ? '1 payment' : `${t.transactions.length} payments`}</span>
                    </span>
                  </span>
                  <CaretRight size={14} className="bench-card-go" aria-hidden />
                </button>
              </li>
            ))}
            {scanners.map((s) => (
              <li key={s.config.id}>
                <button type="button" className="bench-card" aria-label={`Configure ${s.config.name}`} onClick={() => focus(s.config.id)}>
                  <span className="tile" aria-hidden="true">
                    <Barcode size={18} weight="duotone" />
                  </span>
                  <span className="bench-card-body">
                    <span className="bench-card-name">{s.config.name}</span>
                    <span className="bench-card-kind">USB HID keyboard · types into your POS through DevTools</span>
                    <ScannerStatusLine scanner={s} />
                    <span className="bench-card-foot">
                      <code>{s.config.cdpHost}:{s.config.cdpPort}</code>
                      <span className="muted">{s.scans.length === 1 ? '1 scan' : `${s.scans.length} scans`}</span>
                    </span>
                  </span>
                  <CaretRight size={14} className="bench-card-go" aria-hidden />
                </button>
              </li>
            ))}
            {printers[0] && (
              <li>
                <button type="button" className="bench-card" aria-label="Configure Cash drawer" onClick={() => focus(DRAWER_ID)}>
                  <span className="tile" aria-hidden="true">
                    <Vault size={18} weight="duotone" />
                  </span>
                  <span className="bench-card-body">
                    <span className="bench-card-name">Cash drawer</span>
                    <span className="bench-card-kind">4-note / 8-coin drawer · RJ12 to {printers[0].config.name}</span>
                    <span className="status-line">
                      <span className={`pill ${printers[0].status.drawerOpen ? 'pill-warn' : 'pill-ok'}`}>{printers[0].status.drawerOpen ? 'Open' : 'Closed'}</span>
                    </span>
                  </span>
                  <CaretRight size={14} className="bench-card-go" aria-hidden />
                </button>
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="section">
        <h3 className="section-title">Coming soon</h3>
        <ul className="bench-list">
          {UPCOMING.map(({ name, hint, icon: Glyph }) => (
            <li key={name} className="bench-card bench-card-soon" aria-disabled="true">
              <span className="tile" aria-hidden="true">
                <Glyph size={18} weight="duotone" />
              </span>
              <span className="bench-card-body">
                <span className="bench-card-name">{name}</span>
                <span className="bench-card-kind">{hint}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
