/**
 * Small presentational pieces of the public return wizard.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Globe, Loader2, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { IneligibleType, STEPS, STEP_LABELS, Step } from './customerUtils';

// ==========================================
// STEP INDICATOR
// ==========================================
export const StepBar = ({ step }: { step: Step }) => {
  const currentIdx = STEPS.indexOf(step);
  return (
    <ol
      className="rg-steps"
      aria-label={`Return progress: step ${currentIdx + 1} of ${STEPS.length}, ${STEP_LABELS[step]}`}
      style={{ listStyle: 'none', padding: 0, marginTop: 0 }}
    >
      {STEPS.map((s, i) => (
        <li
          key={s}
          className={`rg-step${i === currentIdx ? ' active' : i < currentIdx ? ' done' : ''}`}
          aria-current={i === currentIdx ? 'step' : undefined}
          title={STEP_LABELS[s]}
        >
          <span className="rg-step-number" aria-hidden="true">{i < currentIdx ? '✓' : i + 1}</span>
          <span className="rg-sr-only">{STEP_LABELS[s]}{i < currentIdx ? ' (completed)' : ''}</span>
          <span className="rg-step-line" aria-hidden="true" />
        </li>
      ))}
    </ol>
  );
};

// ==========================================
// IMAGE CAROUSEL (review step)
// ==========================================
export const ImageCarousel = ({ images, title }: { images: string[]; title: string }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  // Keep the index valid when the list shrinks.
  const safeIndex = images.length ? Math.min(currentIndex, images.length - 1) : 0;
  if (!images || images.length === 0) {
    return <div className="rg-image-empty">No images uploaded</div>;
  }
  const next = () => setCurrentIndex((prev) => (Math.min(prev, images.length - 1) + 1) % images.length);
  const prev = () => setCurrentIndex((prev) => (Math.min(prev, images.length - 1) - 1 + images.length) % images.length);
  return (
    <div className="rg-carousel" role="group" aria-roledescription="carousel" aria-label={`Your photos of ${title}`}>
      <img src={images[safeIndex]} alt={`Your photo ${safeIndex + 1} of ${images.length} for ${title}`} className="rg-carousel-img" />
      <span className="rg-carousel-counter" aria-hidden="true">{safeIndex + 1} / {images.length}</span>
      {images.length > 1 && (
        <>
          <button type="button" onClick={prev} className="rg-carousel-btn rg-carousel-prev" aria-label="Previous photo">
            <ChevronLeft size={18} />
          </button>
          <button type="button" onClick={next} className="rg-carousel-btn rg-carousel-next" aria-label="Next photo">
            <ChevronRight size={18} />
          </button>
          <div className="rg-carousel-dots" aria-hidden="true">
            {images.map((_, idx) => (
              <div key={idx} className={`rg-carousel-dot${idx === safeIndex ? ' active' : ''}`} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ==========================================
// INELIGIBLE ORDER MODAL
// ==========================================
export interface IneligibleState {
  show: boolean;
  orderName: string;
  type: IneligibleType;
}

export const IneligibleModal = ({
  state, returnDaysLimit, onClose,
}: { state: IneligibleState; returnDaysLimit: number; onClose: () => void }) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  const { show, type, orderName } = state;
  const isActiveReturn = type === 'active_return';

  useEffect(() => {
    if (!show) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    // Informational variants auto-dismiss (previous behaviour); the
    // "active return" variant has an action, so it stays until closed.
    const timer = isActiveReturn ? undefined : window.setTimeout(() => onCloseRef.current(), 8000);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (timer) window.clearTimeout(timer);
    };
  }, [show, isActiveReturn]);

  if (!show) return null;
  const isInternational = type === 'international';
  const isTimeWindow = type === 'time_window';
  const tone = isInternational ? 'blue' : isActiveReturn ? 'amber' : isTimeWindow ? 'orange' : 'plum';
  const title = isInternational ? 'International Order' : isActiveReturn ? 'Return Already In Progress' : isTimeWindow ? 'Return Period Expired' : 'Return Not Eligible';
  const message = isInternational ? 'Returns are only accepted for orders shipped within India.'
    : isActiveReturn ? 'This order has an active return or exchange request. You can submit a new request once the current one is closed.'
    : isTimeWindow ? `Returns are only accepted within ${returnDaysLimit} days of order delivery.`
    : 'This order is marked as Final Sale.';

  return (
    <div className="rg-modal-backdrop" onClick={onClose}>
      <div
        className="rg-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="rg-ineligible-title"
        aria-describedby="rg-ineligible-msg"
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeRef} type="button" className="rg-modal-close" onClick={onClose} aria-label="Close dialog">×</button>
        <div className={`rg-modal-icon ${tone}`} aria-hidden="true">
          {isInternational ? <Globe size={24} /> : <AlertCircle size={24} />}
        </div>
        <h3 className="rg-modal-title" id="rg-ineligible-title">{title}</h3>
        <p className="rg-modal-copy">
          Order <strong style={{ color: 'var(--plum)' }}>{orderName}</strong>
        </p>
        <div className={`rg-modal-box ${tone}`}>
          <p id="rg-ineligible-msg" style={{ margin: 0 }}>{message}</p>
        </div>
        <div className="rg-modal-actions">
          {isActiveReturn && (
            <Link className="rg-btn-solid rg-btn-wide" to={`/ReturnStatusPage?order=${encodeURIComponent(orderName)}`}>
              <Search size={14} /> Track this request
            </Link>
          )}
          <button
            type="button"
            className={isActiveReturn ? 'rg-btn-ghost rg-btn-wide' : 'rg-btn-solid rg-btn-wide'}
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};

// ==========================================
// SUBMITTING OVERLAY
// ==========================================
export const SubmittingOverlay = ({ stage, progress }: { stage: string; progress: number }) => (
  <div className="rg-submit-overlay">
    <div className="rg-submit-card" role="status" aria-live="polite" aria-busy="true">
      <span className="rg-submit-spinner" aria-hidden="true"><Loader2 size={34} className="rg-spin" /></span>
      <h3>Submitting your request</h3>
      <p>{stage || 'Please wait…'}</p>
      <div className="rg-submit-bar" aria-hidden="true">
        <span style={{ width: `${Math.round(Math.max(0.05, Math.min(1, progress)) * 100)}%` }} />
      </div>
      <p style={{ marginTop: 12, fontSize: 11 }}>Please keep this page open until it finishes.</p>
    </div>
  </div>
);
