import { Printer } from '@phosphor-icons/react';
import { useLab } from '../store.ts';

export function Header() {
  const connection = useLab((s) => s.connection);

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Printer size={14} weight="bold" />
        </span>
        <span className="brand-name">POSandbox</span>
        <span className="brand-sub">POS device lab</span>
      </div>
      {/* only says something when something is wrong */}
      <span className="conn" role="status">
        {connection === 'offline' ? 'Engine disconnected · retrying' : connection === 'connecting' ? 'Connecting…' : ''}
      </span>
    </header>
  );
}
