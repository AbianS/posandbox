import { useEffect } from 'react';
import { WarningCircle, X } from '@phosphor-icons/react';
import { useLab } from '../store.ts';

export function Toast() {
  const error = useLab((s) => s.error);
  const dismiss = useLab((s) => s.dismissError);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(dismiss, 5000);
    return () => clearTimeout(timer);
  }, [error, dismiss]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {error && (
        <div className="toast" key={error}>
          <WarningCircle size={18} weight="fill" className="toast-icon" aria-hidden />
          <span>{error}</span>
          <button type="button" className="icon-btn" onClick={dismiss} aria-label="Dismiss notification">
            <X size={14} weight="bold" aria-hidden />
          </button>
          <span className="toast-timer" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
