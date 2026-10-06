import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bank, Check, Copy, CreditCard, DownloadSimple, HandTap, Key, PlugsConnected, SlidersHorizontal } from '@phosphor-icons/react';
import { ISSUER_OUTCOMES, TEST_CARDS, type EntryMode, type TerminalConfig, type TerminalSnapshot, type TestCardId } from '../../shared/contract.ts';
import { terminalApi } from '../store.ts';
import { drawScreen, SCREEN } from '../terminal-screen.ts';
import { Section } from './PrinterPanel.tsx';
import { Switch } from './ui.tsx';

const ENTRY_LABEL: Record<EntryMode, string> = { Contactless: 'Tap', ICC: 'Insert', MagStripe: 'Swipe' };

export function TerminalPanel({ terminal }: { terminal: TerminalSnapshot }) {
  const { config, status } = terminal;
  const id = config.id;
  return (
    <div className="panel">
      <header className="panel-head">
        <div className="title-row">
          <span className="tile" aria-hidden="true">
            <CreditCard size={18} weight="duotone" />
          </span>
          <div className="title-text">
            <h2 className="device-name">{config.name}</h2>
            <p className="device-model">Adyen Terminal API (nexo) · {config.poiid}</p>
          </div>
          <Switch label="Power" checked={config.enabled} onChange={(enabled) => terminalApi.updateConfig(id, { enabled })} />
        </div>
        <TerminalStatusLine terminal={terminal} />
      </header>

      <ScreenPreview terminal={terminal} />

      <Section title="Shopper" icon={HandTap}>
        <Shopper terminal={terminal} />
      </Section>

      <Section title="Bank and network" icon={Bank}>
        <ul className="fault-list">
          <li className="fault-row">
            <div>
              <div className="fault-label">Issuer response</div>
              <div className="fault-hint">Defaults to Adyen test rules: the last three digits of the amount (…124 = insufficient balance).</div>
            </div>
          </li>
          <li>
            <select className="select-wide" aria-label="Issuer response" value={status.behaviour.issuer} onChange={(e) => terminalApi.setBehaviour(id, { issuer: e.target.value as never })}>
              <option value="amount">By amount (Adyen test rules)</option>
              <option value="approve">Always approve</option>
              <option value="timeout">No issuer response (timeout)</option>
              {Object.entries(ISSUER_OUTCOMES).map(([code, [condition, reason]]) => (
                <option key={code} value={code}>
                  …{code} · {condition} · {reason}
                </option>
              ))}
            </select>
          </li>
          <li className="fault-row">
            <div>
              <div className="fault-label">Drop response</div>
              <div className="fault-hint">The terminal records the payment but closes the connection without responding. The POS must recover it with TransactionStatusRequest.</div>
            </div>
            <Switch label="Drop response" checked={status.behaviour.responseLost} onChange={(responseLost) => terminalApi.setBehaviour(id, { responseLost })} />
          </li>
        </ul>
      </Section>

      <Section title="Connection" icon={PlugsConnected}>
        <Connection config={config} />
      </Section>

      <Section title="Settings" icon={SlidersHorizontal}>
        <ConfigForm config={config} />
      </Section>
    </div>
  );
}

export function TerminalStatusLine({ terminal: { status } }: { terminal: TerminalSnapshot }) {
  if (!status.listening) {
    return (
      <span className="status-line">
        <span className="pill pill-muted">Off</span>
        {status.listenError && <span className="status-reason danger">{status.listenError}</span>}
      </span>
    );
  }
  const busy = status.screen.phase !== 'idle' && status.screen.phase !== 'result';
  return (
    <span className="status-line">
      <span className={`pill ${busy ? 'pill-warn' : 'pill-ok'}`}>{busy ? 'Processing payment' : 'Ready'}</span>
      {busy && <span className="status-reason">{status.screen.message}</span>}
    </span>
  );
}

/** Live copy of the terminal's screen (the same drawing as the 3D model). */
function ScreenPreview({ terminal }: { terminal: TerminalSnapshot }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { status } = terminal;
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    let frame = 0;
    const draw = () => {
      drawScreen(ctx, status, performance.now() / 1000);
      if (status.screen.phase === 'reading' || status.screen.phase === 'authorizing') frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [status]);
  return (
    <div className="terminal-screen">
      <canvas ref={canvas} width={SCREEN.width} height={SCREEN.height} role="img" aria-label={`Payment terminal screen: ${status.screen.message}`} />
    </div>
  );
}

function Shopper({ terminal }: { terminal: TerminalSnapshot }) {
  const { id } = terminal.config;
  const { screen, behaviour, cardInserted } = terminal.status;
  const [cardId, setCardId] = useState<TestCardId>('visa');
  const card = TEST_CARDS.find((c) => c.id === cardId)!;
  const waitingCard = screen.phase === 'card';
  const pin = screen.phase === 'pin' && screen.message === 'Enter PIN';
  const cancellable = screen.phase === 'card' || screen.phase === 'reading' || screen.phase === 'pin';

  return (
    <div className="stack">
      <div className="fault-row">
        <div>
          <div className="fault-label">Automatic shopper</div>
          <div className="fault-hint">Automatically taps the test Visa and enters PIN 1234 to continue without clicking.</div>
        </div>
        <Switch label="Automatic shopper" checked={behaviour.shopper === 'auto'} onChange={(on) => terminalApi.setBehaviour(id, { shopper: on ? 'auto' : 'manual' })} />
      </div>

      <fieldset className="card-pick">
        <legend className="field-label">Test card (PIN 1234)</legend>
        {TEST_CARDS.map((c) => (
          <label key={c.id} className="card-option">
            <input type="radio" name="card" value={c.id} checked={cardId === c.id} onChange={() => setCardId(c.id)} />
            <span className={`card-chip brand-${c.brand}`} aria-hidden="true" />
            <span>{c.label}</span>
            <span className="mono muted">·{c.pan.slice(-4)}</span>
          </label>
        ))}
      </fieldset>
      <div className="btn-row">
        {(['Contactless', 'ICC', 'MagStripe'] as const).map((entry) => (
          <button key={entry} type="button" className="btn btn-sm" disabled={!waitingCard || !(card.entry as readonly EntryMode[]).includes(entry)} onClick={() => terminalApi.present(id, cardId, entry)}>
            {ENTRY_LABEL[entry]}
          </button>
        ))}
        <button type="button" className="btn btn-sm" disabled={!cardInserted} onClick={() => terminalApi.removeCard(id)}>
          Remove card
        </button>
      </div>

      <div className="keypad" role="group" aria-label="Payment terminal keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button key={k} type="button" className="key" disabled={!pin} onClick={() => terminalApi.key(id, k)}>{k}</button>
        ))}
        <button type="button" className="key key-cancel" disabled={!cancellable} onClick={() => terminalApi.key(id, 'cancel')} aria-label="Cancel">✕</button>
        <button type="button" className="key" disabled={!pin} onClick={() => terminalApi.key(id, '0')}>0</button>
        <button type="button" className="key key-clear" disabled={!pin} onClick={() => terminalApi.key(id, 'clear')} aria-label="Clear">‹</button>
        <button type="button" className="key key-ok" disabled={!pin || screen.pinDigits < 4} onClick={() => terminalApi.key(id, 'enter')}>OK</button>
      </div>
    </div>
  );
}

function Connection({ config }: { config: TerminalConfig }) {
  const [copied, setCopied] = useState(false);
  const endpoint = `https://${location.hostname}:${config.port}/nexo`;
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
      <p className="note">
        The terminal certificate is <code>{config.poiid}.test.terminal.adyen.com</code>, signed by the POSandbox CA. Your POS must trust this CA instead of the Adyen root
        (Node: <code>certificatePath</code>; Java: truststore for <code>SSLContext</code>; .NET: system root store). This requires a configuration change.
      </p>
      <a className="btn btn-sm" href={terminalApi.caUrl(config.id)} download>
        <DownloadSimple size={14} aria-hidden />
        Download CA (posandbox-terminal-ca.pem)
      </a>
      <NotificationForm config={config} />
      <SharedKeyForm config={config} />
    </div>
  );
}

/** Display notifications: the terminal POSTs each step of the payment to this POS endpoint. */
function NotificationForm({ config }: { config: TerminalConfig }) {
  const [url, setUrl] = useState(config.notificationUrl ?? '');
  useEffect(() => setUrl(config.notificationUrl ?? ''), [config.notificationUrl]);
  const value = url.trim() || null;
  const valid = value === null || /^https?:\/\/\S+$/.test(value);
  return (
    <form className="config-form" onSubmit={(e) => (e.preventDefault(), valid && terminalApi.updateConfig(config.id, { notificationUrl: value }))}>
      <label className="field">
        <span className="field-label">Display notification URL (optional)</span>
        <input type="url" placeholder="http://host.docker.internal:3000/adyen/events" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <p className="note">The terminal sends each payment step to this URL (TENDER_CREATED, CARD_INSERTED, WAIT_FOR_PIN…), like Adyen’s “Local event URL”. From Docker, your Mac is <code>host.docker.internal</code>.</p>
      <div className="form-actions">
        <button type="submit" className="btn btn-sm" disabled={!valid || value === (config.notificationUrl ?? null)}>
          Save URL
        </button>
      </div>
    </form>
  );
}

function SharedKeyForm({ config }: { config: TerminalConfig }) {
  const [keyIdentifier, setKeyIdentifier] = useState(config.sharedKey?.keyIdentifier ?? '');
  const [passphrase, setPassphrase] = useState(config.sharedKey?.passphrase ?? '');
  const [keyVersion, setKeyVersion] = useState(String(config.sharedKey?.keyVersion ?? 1));
  useEffect(() => {
    setKeyIdentifier(config.sharedKey?.keyIdentifier ?? '');
    setPassphrase(config.sharedKey?.passphrase ?? '');
    setKeyVersion(String(config.sharedKey?.keyVersion ?? 1));
  }, [config.sharedKey]);
  const valid = keyIdentifier.trim() && passphrase && Number.isInteger(Number(keyVersion));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) terminalApi.updateConfig(config.id, { sharedKey: { keyIdentifier: keyIdentifier.trim(), passphrase, keyVersion: Number(keyVersion) } });
  };
  return (
    <form className="config-form" onSubmit={submit}>
      <div className="fault-label">
        <Key size={13} aria-hidden /> Shared key {config.sharedKey ? <span className="tag">encryption enabled</span> : <span className="muted">(unencrypted: testing only)</span>}
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">Identifier</span>
          <input type="text" value={keyIdentifier} onChange={(e) => setKeyIdentifier(e.target.value)} autoComplete="off" />
        </label>
        <label className="field field-narrow">
          <span className="field-label">Version</span>
          <input type="number" min={1} value={keyVersion} onChange={(e) => setKeyVersion(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="field-label">Passphrase</span>
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
      </label>
      <div className="form-actions">
        {config.sharedKey && (
          <button type="button" className="btn btn-ghost-danger btn-sm" onClick={() => terminalApi.updateConfig(config.id, { sharedKey: null })}>
            Remove key
          </button>
        )}
        <button type="submit" className="btn btn-primary btn-sm" disabled={!valid}>
          Save key
        </button>
      </div>
    </form>
  );
}

function ConfigForm({ config }: { config: TerminalConfig }) {
  const [name, setName] = useState(config.name);
  const [port, setPort] = useState(String(config.port));
  const [poiid, setPoiid] = useState(config.poiid);
  useEffect(() => {
    setName(config.name);
    setPort(String(config.port));
    setPoiid(config.poiid);
  }, [config]);
  const portNum = Number(port);
  const patch: Record<string, unknown> = {};
  if (name.trim() !== config.name) patch.name = name.trim();
  if (portNum !== config.port) patch.port = portNum;
  if (poiid !== config.poiid) patch.poiid = poiid;
  const valid = name.trim().length > 0 && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 && /^[A-Za-z0-9]{3,}-[0-9]{9,15}$/.test(poiid);
  const dirty = Object.keys(patch).length > 0;
  return (
    <form className="config-form" onSubmit={(e) => (e.preventDefault(), dirty && valid && terminalApi.updateConfig(config.id, patch))}>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" maxLength={40} required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">POIID (model-serial)</span>
          <input type="text" required value={poiid} onChange={(e) => setPoiid(e.target.value)} />
        </label>
        <label className="field field-narrow">
          <span className="field-label">HTTPS port</span>
          <input type="number" min={1} max={65535} required value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
      </div>
      <p className="note">Changing the POIID generates a new certificate with that name (the CA stays the same). Changing the port or POIID restarts the terminal.</p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!dirty || !valid}>
          Save
        </button>
      </div>
    </form>
  );
}
