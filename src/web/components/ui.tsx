import type { ButtonHTMLAttributes } from 'react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import type { TicketInfo } from '../../shared/contract.ts';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(value: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}

interface ToolProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: PhosphorIcon;
  label: string;
  /** Shortcut shown in the tooltip. */
  kbd?: string;
  pressed?: boolean;
  tip?: 'top' | 'bottom' | 'left' | 'right';
  /** Small status light in the corner (devices in the rail). */
  status?: 'ok' | 'warn' | 'off';
}

/** Icon-only button: the label is its accessible name and its tooltip. Pressed toggles switch to the filled glyph. */
export function Tool({ icon: Glyph, label, kbd, pressed, tip = 'top', status, className = '', ...rest }: ToolProps) {
  return (
    <button type="button" className={`tool ${className}`} aria-label={label} aria-pressed={pressed} data-side={tip} {...rest}>
      <Glyph size={18} weight={pressed ? 'fill' : 'regular'} aria-hidden />
      {status && <i className={`led tool-led led-${status}`} />}
      <Tip label={label} kbd={kbd} />
    </button>
  );
}

/** Hover/focus tooltip for the button it sits in; the button carries the accessible name. */
export function Tip({ label, kbd }: { label: string; kbd?: string }) {
  return (
    <span className="tip" aria-hidden="true">
      {label}
      {kbd && <kbd>{kbd}</kbd>}
    </span>
  );
}

const pad = (n: number, size = 2) => String(n).padStart(size, '0');

export function clock(iso: string, millis = false): string {
  const d = new Date(iso);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return millis ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

export function endLabel(t: TicketInfo): { text: string; tone: string } {
  switch (t.end) {
    case 'cut':
    case 'partial-cut':
      return { text: 'Cut', tone: 'ok' };
    case 'torn':
      return { text: 'Torn off', tone: 'info' };
    case 'power-off':
      return { text: 'Archived', tone: 'muted' };
    default:
      return { text: 'Uncut', tone: 'warn' };
  }
}
