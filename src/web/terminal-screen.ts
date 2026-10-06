import type { TerminalStatus } from '../shared/contract.ts';

// The payment terminal's colour screen (320×240, 4:3), drawn from the engine's state. The same drawing is
// used by the panel preview and as the 3D model's screen texture. `t` (seconds) animates spinners.

export const SCREEN = { width: 640, height: 480 };

const money = (value: number, currency: string) => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value);

export function drawScreen(ctx: CanvasRenderingContext2D, status: TerminalStatus, t = 0): void {
  const { width: w, height: h } = SCREEN;
  const { screen } = status;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (!status.listening) {
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, w, h);
    return ctx.restore();
  }

  const text = (s: string, y: number, size: number, color: string, weight = 600) => {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(s, w / 2, y, w - 48);
  };
  const statusBar = (dark: boolean) => {
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.08)' : '#eef0f3';
    ctx.fillRect(0, 0, w, 44);
    ctx.font = '600 20px system-ui, sans-serif';
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.7)' : '#5b6270';
    ctx.textAlign = 'left';
    ctx.fillText(new Date().toTimeString().slice(0, 5), 18, 23);
    ctx.textAlign = 'right';
    ctx.fillText('▮▮▮▮  100%', w - 18, 23);
    ctx.textAlign = 'center';
  };

  if (screen.phase === 'idle') {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0f1b2d');
    g.addColorStop(1, '#0a2a3a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    statusBar(true);
    text('Welcome', h / 2 - 20, 54, '#ffffff', 700);
    text('POSandbox · ready for payment', h / 2 + 40, 24, 'rgba(255,255,255,0.6)', 500);
    return ctx.restore();
  }

  if (screen.phase === 'result') {
    const tone = screen.result === 'approved' ? ['#12a150', '#0b7a3c'] : screen.result === 'declined' ? ['#d93a3a', '#a42121'] : ['#5f6570', '#454a52'];
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, tone[0]);
    g.addColorStop(1, tone[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(w / 2, 170, 74, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    if (screen.result === 'approved') {
      ctx.moveTo(w / 2 - 34, 172);
      ctx.lineTo(w / 2 - 8, 198);
      ctx.lineTo(w / 2 + 38, 146);
    } else {
      ctx.moveTo(w / 2 - 28, 142);
      ctx.lineTo(w / 2 + 28, 198);
      ctx.moveTo(w / 2 + 28, 142);
      ctx.lineTo(w / 2 - 28, 198);
    }
    ctx.stroke();
    text(screen.message, 312, 52, '#ffffff', 700);
    if (screen.amount) text(money(screen.amount.value, screen.amount.currency), 372, 30, 'rgba(255,255,255,0.85)', 600);
    return ctx.restore();
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  statusBar(false);
  if (screen.amount) {
    text(screen.operation === 'refund' ? 'Refund' : 'Amount', 86, 22, screen.operation === 'refund' ? '#b45309' : '#6b7280', screen.operation === 'refund' ? 650 : 500);
    text(money(screen.amount.value, screen.amount.currency), 140, 72, '#111827', 750);
  }

  if (screen.phase === 'card') {
    // contactless symbol
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(w / 2 - 40, 262, 16 + i * 15, -0.75, 0.75);
      ctx.stroke();
    }
    text(screen.message.split('. ')[0], 364, 28, '#111827', 600);
    if (screen.message.includes('. ')) text(screen.message.split('. ')[1], 404, 26, '#b45309', 600);
    else text('Visa · Mastercard · Maestro', 410, 20, '#9ca3af', 500);
  } else if (screen.phase === 'pin') {
    const wrong = screen.message !== 'Enter PIN';
    text(screen.message, 232, 32, wrong ? '#dc2626' : '#111827', 650);
    const boxes = Math.max(4, screen.pinDigits);
    for (let i = 0; i < boxes; i++) {
      const x = w / 2 + (i - (boxes - 1) / 2) * 52;
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(x - 20, 284, 40, 48);
      if (i < screen.pinDigits) {
        ctx.fillStyle = '#111827';
        ctx.beginPath();
        ctx.arc(x, 308, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.font = '600 20px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#dc2626';
    ctx.fillText('✕ Cancel', 28, 440);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ca8a04';
    ctx.fillText('‹ Clear', w / 2, 440);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#16a34a';
    ctx.fillText('OK ●', w - 28, 440);
  } else {
    // reading / authorizing: spinner
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(w / 2, 272, 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(w / 2, 272, 40, t * 6, t * 6 + 1.6);
    ctx.stroke();
    text(screen.message, 372, 30, '#111827', 600);
  }
  ctx.restore();
}
