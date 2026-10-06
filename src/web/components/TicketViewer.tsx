import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { api, paperImageUrl, ticketImageUrl, useLab } from '../store.ts';
import { CornersIn, DownloadSimple, MagnifyingGlassMinus, MagnifyingGlassPlus, Trash, X } from '@phosphor-icons/react';
import { clock, endLabel, Tip, Tool } from './ui.tsx';

interface View {
  z: number;
  x: number;
  y: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function TicketViewer() {
  const viewer = useLab((s) => s.viewer);
  const printer = useLab((s) => s.snapshot?.printers.find((p) => p.config.id === s.viewer?.printerId));
  const closeViewer = useLab((s) => s.closeViewer);
  const openViewer = useLab((s) => s.openViewer);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (viewer && !el.open) el.showModal();
    if (!viewer && el.open) el.close();
  }, [viewer]);

  const isPaper = viewer?.ticketId === 'paper';
  const ticket = isPaper ? printer?.paper : printer?.tickets.find((t) => t.id === viewer?.ticketId);
  const order = printer ? [...(printer.paper ? ['paper'] : []), ...[...printer.tickets].reverse().map((t) => t.id)] : [];

  const onKeyDown = (e: KeyboardEvent) => {
    if (!viewer || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const next = order[order.indexOf(viewer.ticketId) + (e.key === 'ArrowLeft' ? -1 : 1)];
    if (next) {
      e.preventDefault();
      openViewer(viewer.printerId, next);
    }
  };

  const remove = async () => {
    if (!viewer || isPaper) return;
    const i = order.indexOf(viewer.ticketId);
    const next = order[i + 1] ?? order[i - 1];
    if (!(await api.deleteTickets(viewer.printerId, viewer.ticketId))) return;
    if (next) openViewer(viewer.printerId, next);
    else closeViewer();
  };

  const src = viewer && ticket ? (isPaper ? paperImageUrl(viewer.printerId, ticket.heightDots) : ticketImageUrl(viewer.printerId, ticket.id)) : null;

  return (
    <dialog ref={dialog} className="viewer" aria-label="Receipt viewer" onClose={closeViewer} onKeyDown={onKeyDown}>
      {viewer && (
        <div className="viewer-layout">
          <header className="viewer-head">
            <div className="viewer-info">
              <h2>{isPaper ? 'Paper in printer (uncut)' : <>Receipt <span className="mono">{viewer.ticketId}</span></>}</h2>
              {ticket ? (
                <dl className="viewer-meta">
                  <div><dt>Started</dt><dd className="mono">{clock(ticket.startedAt)}</dd></div>
                  <div><dt>Ended</dt><dd className="mono">{ticket.endedAt ? clock(ticket.endedAt) : '—'}</dd></div>
                  <div>
                    <dt>Ending</dt>
                    <dd>
                      <span className={`badge badge-${endLabel(ticket).tone}`}>{endLabel(ticket).text}</span>
                      {ticket.truncated && <span className="badge badge-danger">Truncated</span>}
                    </dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{ticket.widthDots} × {ticket.heightDots} dots · {ticket.widthDots / 8} × {(ticket.heightDots / 8).toFixed(1)} mm</dd>
                  </div>
                </dl>
              ) : (
                <p className="muted">This receipt is no longer available.</p>
              )}
            </div>
            <div className="viewer-buttons">
              {src && (
                <a className="btn" href={src} download={`${isPaper ? 'paper' : viewer.ticketId}.png`}>
                  <DownloadSimple size={14} aria-hidden />
                  Download PNG
                </a>
              )}
              {ticket && !isPaper && (
                <button type="button" className="btn btn-ghost-danger" onClick={remove}>
                  <Trash size={14} aria-hidden />
                  Delete
                </button>
              )}
              <span className="vp-sep" aria-hidden="true" />
              <Tool icon={X} label="Close" kbd="Esc" tip="bottom" onClick={closeViewer} />
            </div>
          </header>
          {src && <ZoomView key={viewer.ticketId} src={src} />}
        </div>
      )}
    </dialog>
  );
}

function ZoomView({ src }: { src: string }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const fitted = useRef(false);
  const [view, setView] = useState<View>({ z: 1, x: 0, y: 0 });

  const fit = () => {
    const b = box.current;
    const i = img.current;
    if (!b || !i?.naturalWidth) return;
    const z = clampZoom(Math.min(1, (b.clientWidth - 48) / i.naturalWidth));
    setView({ z, x: (b.clientWidth - i.naturalWidth * z) / 2, y: 24 });
  };

  const zoomAt = (factor: number, px?: number, py?: number) =>
    setView((v) => {
      const b = box.current;
      const cx = px ?? (b ? b.clientWidth / 2 : 0);
      const cy = py ?? (b ? b.clientHeight / 2 : 0);
      const z = clampZoom(v.z * factor);
      return { z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z };
    });

  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = b.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    b.addEventListener('wheel', onWheel, { passive: false });
    return () => b.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const onDoubleClick = (e: MouseEvent) => {
    if (view.z === 1) return fit();
    const r = e.currentTarget.getBoundingClientRect();
    zoomAt(1 / view.z, e.clientX - r.left, e.clientY - r.top);
  };

  return (
    <div className="zoom">
      <div className="zoom-toolbar" role="toolbar" aria-label="Zoom">
        <Tool icon={MagnifyingGlassMinus} label="Zoom out" tip="bottom" onClick={() => zoomAt(1 / 1.25)} />
        <button type="button" className="tool zoom-level" onClick={() => zoomAt(1 / view.z)} data-side="bottom">
          {Math.round(view.z * 100)} %
          <Tip label="Actual size" />
        </button>
        <Tool icon={MagnifyingGlassPlus} label="Zoom in" tip="bottom" onClick={() => zoomAt(1.25)} />
        <span className="vp-sep" aria-hidden="true" />
        <Tool icon={CornersIn} label="Fit" tip="bottom" onClick={fit} />
      </div>
      <div
        ref={box}
        className="zoom-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      >
        <img
          ref={img}
          src={src}
          alt="Printed receipt"
          draggable={false}
          className="zoom-image"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, imageRendering: view.z >= 2 ? 'pixelated' : 'auto' }}
          onLoad={() => {
            if (fitted.current) return;
            fitted.current = true;
            fit();
          }}
        />
      </div>
    </div>
  );
}
