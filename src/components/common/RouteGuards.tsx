/**
 * Stable route guards (declared once at module level so pages are not
 * remounted on every App render).
 *
 *   <Route element={<RequireStaff />}>                       // any signed-in staff + MainLayout
 *     <Route path="/returns" element={<Returns />} />
 *     <Route element={<RequireRole allowed={canAccessSettings} />}>
 *       <Route path="/settings" element={...} />
 *     </Route>
 *   </Route>
 *   <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
 */
import React, { Suspense } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { ErrorBoundary } from './ErrorBoundary';
import { FullScreenLoader, PageLoader } from './Spinner';
import { MainLayout } from '../Layout/MainLayout';
import type { Role } from '../../Interfaces/types';

/** Where to send an anonymous visitor: the root is the public customer portal. */
const anonymousRedirect = (pathname: string) => (pathname === '/' ? '/CustomerPage' : '/login');

/** Layout route: requires any signed-in staff member and renders the staff shell. */
export function RequireStaff() {
  const { user, loading, logout } = useAuth();
  const location = useLocation();

  if (loading) return <FullScreenLoader label="Checking your session…" />;
  if (!user) {
    return <Navigate to={anonymousRedirect(location.pathname)} replace state={{ from: location }} />;
  }

  return (
    <MainLayout user={user} onLogout={() => void logout()}>
      <ErrorBoundary variant="page" resetKey={location.pathname}>
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </ErrorBoundary>
    </MainLayout>
  );
}

/** Nested layout route: signed-in staff whose role passes `allowed`; others go to the dashboard. */
export function RequireRole({ allowed }: { allowed: (role?: Role | null) => boolean }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!allowed(user.role)) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** For the login page: signed-in staff are sent to where they came from (or the dashboard). */
export function GuestOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullScreenLoader label="Checking your session…" />;
  if (user) return <Navigate to={redirectTargetFromState(location.state)} replace />;
  return <>{children}</>;
}

/** Safe in-app path from `location.state.from` (set by RequireStaff), default "/". */
export function redirectTargetFromState(state: unknown): string {
  const from = (state as { from?: { pathname?: unknown; search?: unknown } } | null)?.from;
  const pathname = typeof from?.pathname === 'string' ? from.pathname : '';
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname === '/login') return '/';
  const search = typeof from?.search === 'string' ? from.search : '';
  return `${pathname}${search}`;
}
