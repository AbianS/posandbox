import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ReactNode } from 'react';
import type { InspectorEntry, PrinterSnapshot, ScannerSnapshot, TerminalSnapshot, TicketInfo } from '../../shared/contract.ts';
import { api, paperImageUrl, ticketImageUrl, useLab } from '../store.ts';
import { ArrowDown, Barcode, CreditCard, MagnifyingGlass, Receipt, Terminal, Trash, type Icon } from '@phosphor-icons/react';
import { clock, endLabel } from './ui.tsx';

type Tab = 'tickets' | 'inspector';

export function BottomPanel({ printer }: { printer: PrinterSnapshot }) {
  const [tab, setTab] = useState<Tab>('tickets');
  return (
    <Tabbed<Tab>
      tabs={[
        { id: 'tickets', label: 'Receipts', icon: Receipt, count: printer.tickets.length },
        { id: 'inspector', label: 'Inspector', icon: Terminal },
      ]}
      tab={tab}
      onTab={setTab}
      actions={tab === 'tickets' && printer.tickets.length > 0 && <ClearTickets key={printer.config.id} printer={printer} />}
    >
      {tab === 'tickets' ? <Tickets printer={printer} /> : <Inspector entries={printer.inspector} />}
    </Tabbed>
  );
}

/** The payment terminal's transactions and its Terminal API messages (decrypted JSON). */
export function TerminalBottomPanel({ terminal }: { terminal: TerminalSnapshot }) {
  const [tab, setTab] = useState<'transactions' | 'messages'>('transactions');
  return (
    <Tabbed<'transactions' | 'messages'>
      tabs={[
        { id: 'transactions', label: 'Transactions', icon: CreditCard, count: terminal.transactions.length },
        { id: 'messages', label: 'Messages', icon: Terminal },
      ]}
      tab={tab}
      onTab={setTab}
    >
      {tab === 'transactions' ? <Transactions terminal={terminal} /> : <Inspector entries={terminal.inspector} />}
    </Tabbed>
  );
}

/** What the scanner read and whether the POS window got it. */
export function ScannerBottomPanel({ scanner }: { scanner: ScannerSnapshot }) {
  return (
    <Tabbed tabs={[{ id: 'scans', label: 'Scans', icon: Barcode, count: scanner.scans.length }]} tab="scans" onTab={() => {}}>
      {scanner.scans.length === 0 ? (
        <p className="empty"><Barcode size={28} weight="duotone" aria-hidden />No scans yet. Click a product on the workbench or “Scan”.</p>
      ) : (
        <ul className="tx-list">
          {scanner.scans.map((s) => (
            <li key={s.seq} className="scan-row">
              <span className="mono">{clock(s.at)}</span>
              <span className="mono">{s.data}</span>
              <span className="badges">
                <span className={`badge badge-${s.delivered ? 'ok' : 'danger'}`}>{s.delivered ? 'typed' : 'not delivered'}</span>
                <span className="muted">{s.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Tabbed>
  );
}

function Transactions({ terminal }: { terminal: TerminalSnapshot }) {
  if (terminal.transactions.length === 0) {
    return <p className="empty"><CreditCard size={28} weight="duotone" aria-hidden />No payments yet. Send a PaymentRequest to https://host:port/nexo or try “posandbox terminal pay 12.50”.</p>;
  }
  return (
    <ul className="tx-list">
      {terminal.transactions.map((t) => (
        <li key={`${t.id}-${t.serviceId}`} className="tx-row">
          <span className="mono">{clock(t.at)}</span>
          <strong>{new Intl.NumberFormat('en-GB', { style: 'currency', currency: t.currency }).format(t.amount)}</strong>
          <span className="badges">
            <span className={`badge badge-${t.result === 'Success' ? 'ok' : t.errorCondition === 'Cancel' || t.errorCondition === 'Aborted' ? 'muted' : 'danger'}`}>
              {t.result === 'Success' ? 'Approved' : t.errorCondition}
            </span>
            {t.kind !== 'payment' && <span className="badge badge-muted">{t.kind === 'refund' ? 'refund' : 'reversal'}</span>}
            {!t.delivered && <span className="badge badge-warn">response lost</span>}
          </span>
          <span className="muted">{t.result === 'Success' ? `${t.card?.brand} ${t.card?.maskedPan} · ${t.card?.entry}` : t.detail}</span>
          <span className="mono muted" title={`POITransactionID ${t.id} · ServiceID ${t.serviceId}`}>
            {t.id}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Tabbed<T extends string>({ tabs, tab, onTab, actions, children }: { tabs: { id: T; label: string; icon: Icon; count?: number }[]; tab: T; onTab(t: T): void; actions?: ReactNode; children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = tabs[(tabs.findIndex((t) => t.id === tab) + 1) % tabs.length].id;
    onTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <div className="bottom-panel">
      <div className="bottom-head">
        <div className="tablist" role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
          {tabs.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => onTab(t.id)}
            >
              <t.icon size={14} weight={tab === t.id ? 'fill' : 'regular'} aria-hidden />
              {t.label}
              {t.count !== undefined && <span className="count">{t.count}</span>}
            </button>
          ))}
        </div>
        {actions}
      </div>
      <div className="tabpanel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {children}
      </div>
    </div>
  );
}

function Tickets({ printer }: { printer: PrinterSnapshot }) {
  const openViewer = useLab((s) => s.openViewer);
  const id = printer.config.id;

  if (!printer.paper && printer.tickets.length === 0) {
    return <p className="empty"><Receipt size={28} weight="duotone" aria-hidden />No receipts yet. Send ESC/POS bytes to tcp://host:port or click “Print test receipt”.</p>;
  }

  return (
    <ul className="ticket-strip">
      {printer.paper && (
        <TicketCard ticket={printer.paper} src={paperImageUrl(id, printer.paper.heightDots)} title="In the printer" onOpen={() => openViewer(id, 'paper')} />
      )}
      {[...printer.tickets].reverse().map((t) => (
        <TicketCard key={t.id} ticket={t} src={ticketImageUrl(id, t.id)} onOpen={() => openViewer(id, t.id)} onDelete={() => api.deleteTickets(id, t.id)} />
      ))}
    </ul>
  );
}

function ClearTickets({ printer }: { printer: PrinterSnapshot }) {
  const [confirming, setConfirming] = useState(false);
  const n = printer.tickets.length;

  if (!confirming) {
    return (
      <button type="button" className="btn btn-ghost-danger btn-sm" onClick={() => setConfirming(true)}>
        <Trash size={13} aria-hidden />
        Delete all
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label="Confirm deletion">
      <span>{n === 1 ? 'Delete 1 receipt?' : `Delete ${n} receipts?`}</span>
      <button type="button" className="btn btn-danger btn-sm" autoFocus onClick={() => api.deleteTickets(printer.config.id).then(() => setConfirming(false))}>
        Yes
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
        No
      </button>
    </span>
  );
}

function TicketCard({ ticket, src, title, onOpen, onDelete }: { ticket: TicketInfo; src: string; title?: string; onOpen(): void; onDelete?(): void }) {
  const end = endLabel(ticket);
  return (
    <li className="ticket-item">
      <button type="button" className="ticket-card" onClick={onOpen} aria-label={`Open receipt ${title ?? clock(ticket.endedAt ?? ticket.startedAt)}`}>
        <div className="ticket-thumb">
          <img src={src} alt="" loading="lazy" />
        </div>
        <div className="ticket-meta">
          {title && <span className="ticket-title">{title}</span>}
          <span className="mono">{clock(ticket.endedAt ?? ticket.startedAt)}</span>
          <span className="muted">{(ticket.heightDots / 8).toFixed(1)} mm</span>
          <span className="badges">
            <span className={`badge badge-${end.tone}`}>{end.text}</span>
            {ticket.truncated && <span className="badge badge-danger">Truncated</span>}
          </span>
        </div>
      </button>
      {onDelete && (
        <button
          type="button"
          className="ticket-del"
          aria-label={`Delete receipt ${clock(ticket.endedAt ?? ticket.startedAt)}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash size={14} aria-hidden />
        </button>
      )}
    </li>
  );
}

const KINDS = [
  { kind: 'rx', label: 'RX' },
  { kind: 'tx', label: 'TX' },
  { kind: 'command', label: 'CMD' },
  { kind: 'info', label: 'INFO' },
] as const;

const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label])) as Record<InspectorEntry['kind'], string>;

const SUPPORT = {
  supported: null,
  ignored: { text: 'ignored', tone: 'muted' },
  unsupported: { text: 'unsupported', tone: 'warn' },
  unknown: { text: 'unknown', tone: 'danger' },
} as const;

const isIssue = (e: InspectorEntry) => e.kind === 'info' || e.support === 'unsupported' || e.support === 'unknown';

function Inspector({ entries }: { entries: InspectorEntry[] }) {
  const [hidden, setHidden] = useState<Set<InspectorEntry['kind']>>(new Set());
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [query, setQuery] = useState('');
  const [stuck, setStuck] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const rows = entries.filter(
    (e) => !hidden.has(e.kind) && (!onlyIssues || isIssue(e)) && (!q || e.label.toLowerCase().includes(q) || e.hex.toLowerCase().includes(q) || Boolean(e.body?.toLowerCase().includes(q))),
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck) el.scrollTop = el.scrollHeight;
  }, [rows.length, entries, stuck]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const toggleKind = (kind: InspectorEntry['kind']) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

  return (
    <div className="inspector">
      <div className="inspector-filters">
        {KINDS.map(({ kind, label }) => (
          <button key={kind} type="button" className={`chip chip-${kind}`} aria-pressed={!hidden.has(kind)} onClick={() => toggleKind(kind)}>
            {label}
          </button>
        ))}
        <button type="button" className="chip" aria-pressed={onlyIssues} onClick={() => setOnlyIssues(!onlyIssues)}>
          Issues only
        </button>
        <label className="inspector-search">
          <span className="visually-hidden">Filter</span>
          <MagnifyingGlass size={13} aria-hidden />
          <input type="search" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <div className="inspector-scroll" ref={scroller} onScroll={onScroll}>
        {rows.length === 0 ? (
          <p className="empty"><Terminal size={28} weight="duotone" aria-hidden />{entries.length === 0 ? 'No traffic yet.' : 'No entries match the filter.'}</p>
        ) : (
          <table className="inspector-table">
            <tbody>
              {rows.map((e) => {
                const support = e.support && SUPPORT[e.support];
                return (
                  <tr key={e.seq}>
                    <td className="col-time">{clock(e.at, true)}</td>
                    <td className="col-kind">
                      <span className={`kind kind-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                    </td>
                    <td className="col-label">
                      {e.body ? (
                        <details>
                          <summary>{e.label}</summary>
                          <pre className="inspector-body">{e.body}</pre>
                        </details>
                      ) : (
                        e.label
                      )}
                      {support && <span className={`badge badge-${support.tone}`}>{support.text}</span>}
                    </td>
                    <td className="col-hex" title={e.hex}>
                      {e.hex}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {!stuck && (
        <button type="button" className="btn btn-primary btn-sm jump-new" onClick={() => setStuck(true)}>
          <ArrowDown size={13} weight="bold" aria-hidden />
          Latest
        </button>
      )}
    </div>
  );
}
