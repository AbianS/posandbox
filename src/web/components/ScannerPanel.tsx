import { useEffect, useState, type FormEvent } from 'react';
import { Barcode, Lightning, PlugsConnected, SlidersHorizontal } from '@phosphor-icons/react';
import { TEST_BARCODES, type ScannerConfig, type ScannerSnapshot } from '../../shared/contract.ts';
import { scannerApi } from '../store.ts';
import { Section } from './PrinterPanel.tsx';
import { Switch } from './ui.tsx';

export function ScannerPanel({ scanner }: { scanner: ScannerSnapshot }) {
  const { config } = scanner;
  const id = config.id;
  const [custom, setCustom] = useState('');
  const busy = scanner.status.scanning !== null;
  return (
    <div className="panel">
      <header className="panel-head">
        <div className="title-row">
          <span className="tile" aria-hidden="true">
            <Barcode size={18} weight="duotone" />
          </span>
          <div className="title-text">
            <h2 className="device-name">{config.name}</h2>
            <p className="device-model">USB scanner in keyboard mode (HID) · {config.suffix === 'none' ? 'no suffix' : `suffix ${config.suffix}`}</p>
          </div>
          <Switch label="Connected" checked={config.enabled} onChange={(enabled) => scannerApi.updateConfig(id, { enabled })} />
        </div>
        <ScannerStatusLine scanner={scanner} />
      </header>

      <Section title="Scan" icon={Lightning}>
        <ul className="code-list">
          {TEST_BARCODES.map((b) => (
            <li key={b.id} className="fault-row">
              <div>
                <div className="fault-label">{b.label}</div>
                <div className="fault-hint mono">{b.symbology} · {b.data}</div>
              </div>
              <button type="button" className="btn btn-sm" disabled={busy || !config.enabled} onClick={() => scannerApi.scan(id, b.data)}>
                Scan
              </button>
            </li>
          ))}
        </ul>
        <form className="field-row scan-custom" onSubmit={(e: FormEvent) => (e.preventDefault(), custom && scannerApi.scan(id, custom))}>
          <label className="field">
            <span className="field-label">Custom code</span>
            <input type="text" value={custom} maxLength={200} placeholder="Enter the label data" onChange={(e) => setCustom(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !custom || !config.enabled}>
            Scan
          </button>
        </form>
      </Section>

      <Section title="POS connection" icon={PlugsConnected}>
        <div className="stack">
          <p className="note">
            A physical USB scanner types into the active window. Docker cannot type into your desktop, so POSandbox uses your Electron DevTools port:
            start the app with <code>--remote-debugging-port={config.cdpPort}</code> (development only). Keystrokes follow the same path as a keyboard
            (<code>isTrusted</code>), without changing the app code.
          </p>
          <button type="button" className="btn btn-sm" onClick={() => scannerApi.probe(id)}>
            Find POS window
          </button>
        </div>
      </Section>

      <Section title="Settings" icon={SlidersHorizontal}>
        <ConfigForm config={config} />
      </Section>
    </div>
  );
}

export function ScannerStatusLine({ scanner: { config, status } }: { scanner: ScannerSnapshot }) {
  if (!config.enabled) return <span className="status-line"><span className="pill pill-muted">Disconnected</span></span>;
  if (status.scanning) return <span className="status-line"><span className="pill pill-warn">Reading</span><span className="status-reason mono">{status.scanning}</span></span>;
  if (!status.link) return <span className="status-line"><span className="pill pill-ok">Ready</span><span className="status-reason">POS not checked</span></span>;
  return (
    <span className="status-line">
      <span className={`pill ${status.link.ok ? 'pill-ok' : 'pill-warn'}`}>{status.link.ok ? 'POS found' : 'No POS'}</span>
      <span className={`status-reason${status.link.ok ? '' : ' danger'}`}>{status.link.detail}</span>
    </span>
  );
}

function ConfigForm({ config }: { config: ScannerConfig }) {
  const [form, setForm] = useState({ name: config.name, cdpHost: config.cdpHost, cdpPort: String(config.cdpPort), target: config.target, suffix: config.suffix, keyDelay: String(config.keyDelay) });
  useEffect(() => setForm({ name: config.name, cdpHost: config.cdpHost, cdpPort: String(config.cdpPort), target: config.target, suffix: config.suffix, keyDelay: String(config.keyDelay) }), [config]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const patch = {
    name: form.name.trim(), cdpHost: form.cdpHost.trim(), cdpPort: Number(form.cdpPort), target: form.target, suffix: form.suffix as ScannerConfig['suffix'], keyDelay: Number(form.keyDelay),
  };
  const valid = patch.name && /^[A-Za-z0-9.-]+$/.test(patch.cdpHost) && Number.isInteger(patch.cdpPort) && patch.cdpPort > 0 && patch.cdpPort < 65536 && Number.isInteger(patch.keyDelay) && patch.keyDelay >= 0 && patch.keyDelay <= 200;
  const dirty = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => patch[k] !== config[k]);
  return (
    <form className="config-form" onSubmit={(e) => (e.preventDefault(), dirty && valid && scannerApi.updateConfig(config.id, patch))}>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" maxLength={40} value={form.name} onChange={set('name')} />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">POS host</span>
          <input type="text" value={form.cdpHost} onChange={set('cdpHost')} />
        </label>
        <label className="field field-narrow">
          <span className="field-label">DevTools port</span>
          <input type="number" min={1} max={65535} value={form.cdpPort} onChange={set('cdpPort')} />
        </label>
      </div>
      <label className="field">
        <span className="field-label">Window (title or URL text; blank: first window)</span>
        <input type="text" value={form.target} onChange={set('target')} placeholder="My POS" />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Suffix</span>
          <select value={form.suffix} onChange={set('suffix')}>
            <option value="Enter">Enter (CR)</option>
            <option value="Tab">Tab</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="field field-narrow">
          <span className="field-label">ms between keystrokes</span>
          <input type="number" min={0} max={200} value={form.keyDelay} onChange={set('keyDelay')} />
        </label>
      </div>
      <p className="note">From Docker, your Mac POS is <code>host.docker.internal</code>; locally, <code>127.0.0.1</code>.</p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!dirty || !valid}>
          Save
        </button>
      </div>
    </form>
  );
}
