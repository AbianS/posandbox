import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { PAPER_WIDTHS, PRINTER_FAULTS, type PaperWidth, type PrinterConfig, type PrinterConfigPatch, type PrinterFault, type PrinterSnapshot } from '../../shared/contract.ts';
import { api } from '../store.ts';
import { ArrowLineDown, Check, Copy, Lightning, Play, PlugsConnected, Printer, Scissors, SlidersHorizontal, WarningDiamond, type Icon } from '@phosphor-icons/react';
import { Switch } from './ui.tsx';

const FAULTS: Record<PrinterFault, { label: string; hint: string; reason: string }> = {
  paperNearEnd: { label: 'Paper near end', hint: 'Sensor warning; the printer keeps printing', reason: '' },
  paperOut: { label: 'Paper out', hint: 'Offline: stops printing and buffers data until paper is refilled', reason: 'Paper out' },
  coverOpen: { label: 'Cover open', hint: 'Offline with “cover open” reported in DLE EOT 2', reason: 'Cover open' },
  headOverheat: { label: 'Print head overheated', hint: 'Automatically recoverable error: offline until it cools down', reason: 'Print head overheated' },
};

export function PrinterPanel({ printer }: { printer: PrinterSnapshot }) {
  const { config, status } = printer;
  const id = config.id;

  return (
    <div className="panel">
      <header className="panel-head">
        <div className="title-row">
          <span className="tile" aria-hidden="true">
            <Printer size={18} weight="duotone" />
          </span>
          <div className="title-text">
            <h2 className="device-name">{config.name}</h2>
            <p className="device-model">Epson TM-T20III · ESC/POS profile</p>
          </div>
          <Switch label="Power" checked={config.enabled} onChange={(enabled) => api.updateConfig(id, { enabled })} />
        </div>
        <StatusLine printer={printer} />
      </header>

      <Section title="Connection" icon={PlugsConnected}>
        <Connection printer={printer} />
      </Section>

      <Section title="Paper and faults" icon={WarningDiamond}>
        <ul className="fault-list">
          {PRINTER_FAULTS.map((fault) => (
            <li key={fault} className="fault-row">
              <div>
                <div className="fault-label">{FAULTS[fault].label}</div>
                <div className="fault-hint">{FAULTS[fault].hint}</div>
              </div>
              <Switch label={FAULTS[fault].label} checked={status.faults[fault]} onChange={(value) => api.setFaults(id, { [fault]: value })} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Actions" icon={Lightning}>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => api.action(id, 'self-test')}>
            <Play size={14} weight="fill" aria-hidden />
            Print test receipt
          </button>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => api.action(id, 'feed')}>
              <ArrowLineDown size={14} aria-hidden />
              FEED button
            </button>
            <button type="button" className="btn" disabled={!printer.paper} onClick={() => api.action(id, 'tear-off')}>
              <Scissors size={14} aria-hidden />
              Tear off paper
            </button>
          </div>
        </div>
      </Section>

      <Section title="Settings" icon={SlidersHorizontal}>
        <ConfigForm config={config} />
      </Section>
    </div>
  );
}

/** Collapsible property group, open by default. */
export function Section({ title, icon: Glyph, children }: { title: string; icon: Icon; children: ReactNode }) {
  return (
    <details className="section" open>
      <summary>
        <Glyph size={14} weight="bold" aria-hidden />
        <h3 className="section-title">{title}</h3>
      </summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

export function StatusLine({ printer: { status } }: { printer: PrinterSnapshot }) {
  if (!status.listening) {
    return (
      <span className="status-line">
        <span className="pill pill-muted">Off</span>
        {status.listenError && <span className="status-reason danger">{status.listenError}</span>}
      </span>
    );
  }
  if (status.online) return <span className="status-line"><span className="pill pill-ok">Ready</span></span>;
  const reasons = PRINTER_FAULTS.filter((f) => status.faults[f] && FAULTS[f].reason).map((f) => FAULTS[f].reason);
  return (
    <span className="status-line">
      <span className="pill pill-warn">Offline</span>
      {reasons.length > 0 && <span className="status-reason">{reasons.join(' · ')}</span>}
    </span>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const relative = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

function ago(iso: string, now: number) {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s > -60) return 'a few seconds ago';
  if (s > -3600) return relative.format(Math.round(s / 60), 'minute');
  if (s > -86400) return relative.format(Math.round(s / 3600), 'hour');
  return relative.format(Math.round(s / 86400), 'day');
}

function Connection({ printer: { config, status } }: { printer: PrinterSnapshot }) {
  const now = useNow(30_000);
  const [copied, setCopied] = useState(false);
  const endpoint = `tcp://${location.hostname}:${config.port}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) */
    }
  };

  return (
    <div className="stack">
      <div className="endpoint">
        <code>{endpoint}</code>
        <button type="button" className="icon-btn" data-copied={copied || undefined} onClick={copy} aria-label={copied ? 'Copied' : 'Copy address'} title={copied ? 'Copied' : 'Copy'}>
          {copied ? <Check size={14} weight="bold" aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
      </div>
      <div className="client-row">
        {status.client ? (
          <div className="client">
            <span className="led led-ok" />
            <div className="mono">{status.client.address}</div>
            <div className="fault-hint">Connected {ago(status.client.since, now)}</div>
          </div>
        ) : (
          <span className="client muted"><span className="led led-off" />No POS connected</span>
        )}
        <button type="button" className="btn btn-ghost-danger btn-sm" disabled={!status.client} onClick={() => api.action(config.id, 'disconnect')}>
          Disconnect POS
        </button>
      </div>
      {(status.pendingBytes > 0 || status.asbEnabled) && (
        <div className="tags">
          {status.pendingBytes > 0 && <span className="fault-hint">Buffered data: {status.pendingBytes} bytes</span>}
          {status.asbEnabled && <span className="tag">ASB enabled</span>}
        </div>
      )}
    </div>
  );
}

function ConfigForm({ config }: { config: PrinterConfig }) {
  const [name, setName] = useState(config.name);
  const [port, setPort] = useState(String(config.port));
  const [paperWidth, setPaperWidth] = useState<PaperWidth>(config.paperWidth);

  useEffect(() => {
    setName(config.name);
    setPort(String(config.port));
    setPaperWidth(config.paperWidth);
  }, [config]);

  const portNum = Number(port);
  const patch: PrinterConfigPatch = {};
  if (name.trim() !== config.name) patch.name = name.trim();
  if (portNum !== config.port) patch.port = portNum;
  if (paperWidth !== config.paperWidth) patch.paperWidth = paperWidth;
  const valid = name.trim().length > 0 && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const dirty = Object.keys(patch).length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty && valid) api.updateConfig(config.id, patch);
  };

  return (
    <form className="config-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" maxLength={40} required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">TCP port</span>
          <input type="number" min={1} max={65535} required value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Paper width</span>
          <select value={paperWidth} onChange={(e) => setPaperWidth(Number(e.target.value) as PaperWidth)}>
            {PAPER_WIDTHS.map((w) => (
              <option key={w} value={w}>
                {w} mm
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="note">Changing the port restarts the TCP listener and closes the POS session. Changing the paper width archives the uncut paper.</p>
      <p className="note">In Docker, the published port does not update automatically: recreate the container if you change the port.</p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!dirty || !valid}>
          Save
        </button>
      </div>
    </form>
  );
}
