import type { KeyboardEvent, PointerEvent } from 'react';

interface Props {
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange(value: number): void;
}

const STEP = 16;

/** Drag handle for a panel that sits to its right (vertical) or below it (horizontal): moving the line left/up grows the panel. */
export function Splitter({ orientation, label, value, min, max, defaultValue, onChange }: Props) {
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));
  const vertical = orientation === 'vertical';
  const pos = (e: { clientX: number; clientY: number }) => (vertical ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = pos(e);
    el.setPointerCapture(e.pointerId);
    el.dataset.dragging = '';
    document.body.style.userSelect = 'none';
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    const move = (ev: globalThis.PointerEvent) => onChange(clamp(value + start - pos(ev)));
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      delete el.dataset.dragging;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const grow = vertical ? 'ArrowLeft' : 'ArrowUp';
    const shrink = vertical ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    onChange(clamp(value + (e.key === grow ? STEP : -STEP)));
  };

  return (
    <div
      className={`splitter splitter-${vertical ? 'v' : 'h'}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(clamp(defaultValue))}
    />
  );
}
