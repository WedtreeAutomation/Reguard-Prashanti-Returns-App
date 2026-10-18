import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** When this value changes, a captured error is cleared (e.g. the route path). */
  resetKey?: unknown;
  /** `full` = whole-screen fallback (top level); `page` = inline card inside the layout. */
  variant?: 'full' | 'page';
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Errors thrown when a lazily-loaded JS/CSS chunk can't be fetched — typically because a new
 * build was deployed and the old hashed files are gone. Messages differ per browser/bundler:
 *   Chrome  "Failed to fetch dynamically imported module: …"
 *   Firefox "error loading dynamically imported module"
 *   Safari  "Importing a module script failed."
 *   Vite    "Unable to preload CSS for …"
 *   webpack "ChunkLoadError" / "Loading chunk 12 failed"
 */
const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading (CSS )?chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

const isChunkLoadError = (error: Error | null): boolean => {
  const msg = `${error?.name ?? ''} ${error?.message ?? ''}`;
  return CHUNK_ERROR_RE.test(msg);
};

/**
 * Catches render errors so the app never shows a blank white screen.
 * Wrap the routes once at the top level, and once per page (with `resetKey`)
 * so navigating to another page recovers automatically.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Render error:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunk = isChunkLoadError(error);
    const full = this.props.variant !== 'page';
    const title = chunk ? 'A new version is available' : 'Something went wrong';
    const message = chunk
      ? 'This page could not be loaded, probably because the app was just updated. Please reload to get the latest version.'
      : 'An unexpected error occurred while showing this page. Reloading usually fixes it. If it keeps happening, please contact support.';

    const card = (
      <div
        role="alert"
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm sm:p-8"
      >
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-2xl text-red-500" aria-hidden="true">
          !
        </div>
        <h2 className="mb-2 text-lg font-bold text-slate-900">{title}</h2>
        <p className="mb-6 text-sm text-slate-500">{message}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={this.handleReload}
            className="min-h-[40px] rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2"
          >
            Reload page
          </button>
          {!chunk && (
            <button
              type="button"
              onClick={this.handleRetry}
              className="min-h-[40px] rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              Try again
            </button>
          )}
          {full && (
            <a
              href="/"
              className="inline-flex min-h-[40px] items-center justify-center rounded-xl px-5 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
            >
              Go to home
            </a>
          )}
        </div>
      </div>
    );

    if (!full) {
      return <div className="flex w-full justify-center py-10">{card}</div>;
    }
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">{card}</div>;
  }
}

export default ErrorBoundary;
