import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { PrinterSnapshot, TicketInfo } from '../../shared/contract.ts';
import { api, onLabEvent, paperImageUrl, ticketImageUrl, useLab } from '../store.ts';
import { CounterTicket, createStripGeometry, PaperStrip, type LooseTicket } from './PaperStrip.tsx';
import { PrinterModel, type PrinterLook } from './PrinterModel.tsx';
import { adopt, DOTS_PER_M, printableSpan, useReceiptTexture } from './receipt-texture.ts';
import { CUBE_SHAPE, MAX_STEP } from './paper-path.ts';
import { printingSound } from './sound.ts';

/** Paper speed in m/s: the TM-T20III prints at up to 250 mm/s; the slow mode lets you watch it. */
const FEED_SPEED = { real: 0.25, slow: 0.05 };
const MAX_ON_COUNTER = 4;

function useThrottled<T>(value: T, ms: number): T {
  const [throttled, setThrottled] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - performance.now());
    const timer = setTimeout(() => {
      last.current = performance.now();
      setThrottled(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return throttled;
}

function look(printer: PrinterSnapshot): PrinterLook {
  const { status } = printer;
  const { faults } = status;
  return {
    powered: status.listening,
    lidOpen: faults.coverOpen,
    error: faults.headOverheat ? 'blink' : status.online ? 'off' : 'on',
    paperLed: faults.paperNearEnd || faults.paperOut,
    rollRadius: faults.paperOut ? 0 : faults.paperNearEnd ? 0.0155 : 0.036,
  };
}

/**
 * One printer on the counter. The engine is the source of truth: the strip only animates towards the
 * printed height the engine reports, and cut tickets (events) are played in order before new paper.
 */
export function PrinterStation({ printer, focused, onSelect }: { printer: PrinterSnapshot; focused: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false);
  const id = printer.config.id;
  const width = printer.config.paperWidth / 1000;
  const openViewer = useLab((s) => s.openViewer);
  const [queue, setQueue] = useState<TicketInfo[]>([]);
  const [loose, setLoose] = useState<LooseTicket[]>(() =>
    printer.tickets.slice(0, MAX_ON_COUNTER).map((t) => ({ key: t.id, length: t.heightDots / DOTS_PER_M, texture: null })),
  );
  const shown = useRef((printer.paper?.heightDots ?? 0) / DOTS_PER_M); // reopen = current state, no replay
  const geometry = useMemo(createStripGeometry, []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useEffect(
    () =>
      onLabEvent((event) => {
        if (event.deviceId !== id) return;
        if (event.type === 'printer.tickets-deleted') {
          // deleted in the panel: also gone from the desk (and from the cut queue, if not shown yet)
          setLoose((l) => l.filter((t) => !event.ids.includes(t.key)));
          setQueue((q) => q.filter((t) => !event.ids.includes(t.id)));
          return;
        }
        if (event.type !== 'printer.ticket' || event.ticket.end === 'power-off') return;
        setQueue((q) => [...q, event.ticket]);
      }),
    [id],
  );

  const cutting = queue[0];
  const paperHeight = useThrottled(printer.paper?.heightDots ?? 0, 400); // each refresh is a texture upload
  const url = cutting ? ticketImageUrl(id, cutting.id) : printer.paper ? paperImageUrl(id, paperHeight) : null;
  const receipt = useReceiptTexture(url);
  const span = printableSpan(printer.config.paperWidth);
  const fullLength = (cutting?.heightDots ?? printer.paper?.heightDots ?? 0) / DOTS_PER_M;
  // paper only comes out as far as its printed image is ready: motion, sound and print stay in sync
  const ready = receipt !== null && url !== null && receipt.source === url.split('?')[0];
  const target = ready ? Math.min(fullLength, receipt.heightDots / DOTS_PER_M) : Math.min(fullLength, shown.current);

  useFrame(({ invalidate }, delta) => {
    const dt = Math.min(delta, MAX_STEP);
    if (shown.current > target) shown.current = target; // paper removed or replaced
    const feeding = shown.current < target;
    if (feeding) {
      const speed = useLab.getState().realSpeed ? FEED_SPEED.real : FEED_SPEED.slow;
      shown.current = Math.min(target, shown.current + speed * dt);
      invalidate();
    }
    printingSound.feeding(id, feeding);
    if (cutting && !feeding && ready && receipt.heightDots === cutting.heightDots) {
      // the whole ticket is out: cut it and lay it on the pad
      const from = new Float32Array(geometry.getAttribute('position').array as Float32Array);
      const piece: LooseTicket = { key: cutting.id, length: fullLength, texture: adopt(receipt.texture), from };
      setLoose((l) => [piece, ...l.filter((t) => t.key !== piece.key)].slice(0, MAX_ON_COUNTER));
      setQueue((q) => q.slice(1));
      printingSound.cut();
      shown.current = 0;
      invalidate();
    }
  });

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
        <PrinterModel look={look(printer)} onFeed={() => void api.action(id, 'feed')} />
      </group>
      {!focused && hover && (
        <Html position={[0, 0.17, 0]} center zIndexRange={[10, 0]} className="scene-tip">
          <strong>{printer.config.name}</strong>
          <span className="scene-tip-row">
            <i className={`led led-${!printer.status.listening ? 'off' : printer.status.online ? 'ok' : 'warn'}`} />
            {!printer.status.listening ? 'Off' : printer.status.online ? 'Ready' : 'Offline'}
            <span className="scene-tip-sep">·</span>
            <span className="mono">:{printer.config.port}</span>
          </span>
          <span className="scene-tip-hint">Click to configure</span>
        </Html>
      )}
      <PaperStrip
        geometry={geometry}
        length={() => shown.current}
        imageLength={(receipt?.heightDots ?? 0) / DOTS_PER_M}
        texture={receipt?.texture ?? null}
        width={width}
        shape={CUBE_SHAPE}
        span={span}
        onClick={(e) => {
          e.stopPropagation();
          openViewer(id, cutting?.id ?? 'paper');
        }}
      />
      {loose.map((ticket, index) => (
        <LooseCounterTicket key={ticket.key} printerId={id} ticket={ticket} index={index} width={width} onOpen={() => openViewer(id, ticket.key)} />
      ))}
    </group>
  );
}

/** Tickets already on the counter when the panel opens load their own image. */
function LooseCounterTicket({ printerId, ticket, index, width, onOpen }: { printerId: string; ticket: LooseTicket; index: number; width: number; onOpen: () => void }) {
  const own = useReceiptTexture(ticket.texture ? null : ticketImageUrl(printerId, ticket.key));
  const span = printableSpan(width === 0.058 ? 58 : 80);
  return <CounterTicket ticket={ticket} texture={ticket.texture ?? own?.texture ?? null} index={index} width={width} shape={CUBE_SHAPE} span={span} onClick={onOpen} />;
}
