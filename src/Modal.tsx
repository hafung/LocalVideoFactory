import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export function Modal({ title, subtitle, close, children, wide, className = '', workspace, closeDisabled }: {
  title: string; subtitle?: string; close: () => void; children: React.ReactNode; wide?: boolean; className?: string; workspace?: boolean; closeDisabled?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? []).filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  const modal = <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}><section ref={ref} className={`modal ${wide ? 'library-modal' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}><header><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭" disabled={closeDisabled} onClick={close}><X size={18}/></button></header>{children}</section></div>;
  return workspace ? createPortal(modal, document.body) : modal;
}
