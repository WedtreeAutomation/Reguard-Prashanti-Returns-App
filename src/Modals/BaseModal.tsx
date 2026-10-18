import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind max-width class for desktop (mobile is always full width). */
  maxWidth?: string;
  /** Optional line under the title. */
  subtitle?: React.ReactNode;
  /** Optional icon shown before the title. */
  icon?: React.ReactNode;
  /** Block Esc / backdrop / close button (e.g. while a request is in flight). */
  closeDisabled?: boolean;
  /** Close when the backdrop is clicked (default false — avoids losing form input). */
  closeOnBackdrop?: boolean;
}

// Stack of open dialogs so only the top-most one reacts to Esc / owns focus,
// and a counter so nested dialogs don't release the body scroll lock early.
const openStack: string[] = [];
let scrollLocks = 0;
let savedOverflow = '';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog: role="dialog", aria-modal, labelled by its title,
 * Esc closes, focus moves inside and is restored on close, Tab is trapped,
 * body scroll is locked. On phones it renders as a full-width bottom sheet.
 */
export const BaseModal: React.FC<ModalProps> = ({
  isOpen, onClose, title, children, footer, maxWidth = 'max-w-md', subtitle, icon,
  closeDisabled = false, closeOnBackdrop = false,
}) => {
  const id = useId();
  const titleId = `${id}-title`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  onCloseRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    openStack.push(id);

    if (scrollLocks === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLocks += 1;

    // Move focus into the dialog (first field/button, else the dialog itself).
    const focusTimer = window.setTimeout(() => {
      const root = dialogRef.current;
      if (!root || root.contains(document.activeElement)) return;
      const auto = root.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
      const body = root.querySelector<HTMLElement>('[data-modal-body]');
      const first = auto || body?.querySelector<HTMLElement>(FOCUSABLE) || root.querySelector<HTMLElement>(FOCUSABLE);
      (first || root).focus();
    }, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        if (!closeDisabledRef.current) {
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement
        );
        if (nodes.length === 0) {
          e.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      const idx = openStack.lastIndexOf(id);
      if (idx >= 0) openStack.splice(idx, 1);
      scrollLocks = Math.max(0, scrollLocks - 1);
      if (scrollLocks === 0) document.body.style.overflow = savedOverflow;
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen, id]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm sm:p-4"
      onMouseDown={(e) => {
        if (closeOnBackdrop && !closeDisabled && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`bg-white w-full ${maxWidth} max-h-[92dvh] sm:max-h-[90dvh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden outline-none animate-in fade-in zoom-in-95 duration-200`}
      >
        <div className="flex justify-between items-start gap-3 px-4 py-4 sm:p-5 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {icon && <div className="shrink-0">{icon}</div>}
            <div className="min-w-0">
              <h3 id={titleId} className="font-bold text-lg text-slate-900 leading-snug">{title}</h3>
              {subtitle && <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close dialog"
            className="shrink-0 w-10 h-10 -mr-1 -mt-1 flex items-center justify-center hover:bg-slate-100 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="w-5 h-5 text-slate-500" aria-hidden="true" />
          </button>
        </div>
        <div data-modal-body className="px-4 py-5 sm:p-6 overflow-y-auto overscroll-contain flex-1 min-h-0">
          {children}
        </div>
        {footer && (
          <div className="px-4 pt-4 sm:p-5 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-slate-100 shrink-0 bg-white">
            {footer}
          </div>
        )}
        {!footer && <div className="pb-[env(safe-area-inset-bottom)] shrink-0" />}
      </div>
    </div>
  );
};
