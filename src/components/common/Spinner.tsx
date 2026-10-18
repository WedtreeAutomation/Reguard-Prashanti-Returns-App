import { useState } from 'react';

interface SpinnerProps {
  /** Tailwind size classes, default `w-5 h-5`. */
  className?: string;
  /** Accessible label; omit when the spinner sits next to visible text. */
  label?: string;
}

/** Small circular spinner (inherits text colour). */
export const Spinner = ({ className = 'w-5 h-5', label }: SpinnerProps) => (
  <span
    role={label ? 'status' : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
    className={`inline-block shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin ${className}`}
  />
);

/** Brand logo that silently hides itself if the image fails to load. */
const BrandLogo = ({ className }: { className?: string }) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <p className="text-xl font-bold tracking-wide text-indigo-700">Re-Guard</p>;
  }
  return (
    <img
      src="/reguard-logo.png"
      alt="Re-Guard by Prashanti"
      className={className}
      onError={() => setFailed(true)}
    />
  );
};

interface LoaderProps {
  label?: string;
}

/** Branded full-screen loader (used while the session is being resolved). */
export const FullScreenLoader = ({ label = 'Loading…' }: LoaderProps) => (
  <div
    className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-5 bg-white px-6 text-center"
    role="status"
    aria-live="polite"
  >
    <BrandLogo className="h-16 w-auto max-w-[70vw] object-contain" />
    <Spinner className="w-8 h-8 text-indigo-600" />
    <p className="text-sm font-medium text-slate-500">{label}</p>
  </div>
);

/** In-page loader (used as the Suspense fallback inside the staff layout). */
export const PageLoader = ({ label = 'Loading…' }: LoaderProps) => (
  <div className="flex min-h-[40vh] w-full flex-col items-center justify-center gap-3" role="status" aria-live="polite">
    <Spinner className="w-8 h-8 text-indigo-600" />
    <p className="text-sm font-medium text-slate-500">{label}</p>
  </div>
);
