import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import './index.css';
import LoginPage from './components/Pages/LoginPage';
import { canManageAgents, canAccessAnalytics, canAccessSettings } from './Interfaces/permissions';
import { AuthProvider, useAuth } from './components/common/AuthContext';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { GuestOnly, RequireRole, RequireStaff } from './components/common/RouteGuards';
import { FullScreenLoader } from './components/common/Spinner';

// Heavy pages are code-split; named exports are mapped to `default` for React.lazy.
const Home = lazy(() => import('./components/Pages/Home').then((m) => ({ default: m.Home })));
const Returns = lazy(() => import('./components/Pages/Returns').then((m) => ({ default: m.Returns })));
const Analytics = lazy(() => import('./components/Pages/Analytics').then((m) => ({ default: m.Analytics })));
const ReturnPortalSplit = lazy(() =>
  import('./components/Pages/CustomerPage').then((m) => ({ default: m.ReturnPortalSplit }))
);
const ReturnStatusPage = lazy(() =>
  import('./components/Pages/ReturnStatusPage').then((m) => ({ default: m.ReturnStatusPage }))
);
const ReturnDetailsPage = lazy(() =>
  import('./components/Pages/ReturnDetailsPage').then((m) => ({ default: m.ReturnDetailsPage }))
);
const RestockHistory = lazy(() =>
  import('./components/Pages/RestockHistory').then((m) => ({ default: m.RestockHistory }))
);
const Agents = lazy(() => import('./components/Pages/Agents'));
const Settings = lazy(() => import('./components/Pages/Settings').then((m) => ({ default: m.Settings })));

// Pages that still take the signed-in user as a prop.
const AnalyticsRoute = () => {
  const { user } = useAuth();
  return <Analytics currentUser={user} />;
};
const AgentsRoute = () => {
  const { user } = useAuth();
  return <Agents currentUser={user} />;
};
const SettingsRoute = () => {
  const { user } = useAuth();
  return <Settings currentUser={user} />;
};

function App() {
  return (
    <ErrorBoundary variant="full">
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<FullScreenLoader />}>
            <Routes>
              {/* Public routes - no authentication required */}
              <Route path="/ReturnStatusPage" element={<ReturnStatusPage />} />
              <Route path="/CustomerPage" element={<ReturnPortalSplit />} />

              {/* Staff sign-in */}
              <Route
                path="/login"
                element={
                  <GuestOnly>
                    <LoginPage />
                  </GuestOnly>
                }
              />

              {/* Staff routes - require a signed-in agent/admin (anonymous "/" -> CustomerPage) */}
              <Route element={<RequireStaff />}>
                <Route path="/" element={<Home />} />
                <Route path="/returns" element={<Returns />} />
                <Route path="/returns/:id" element={<ReturnDetailsPage />} />
                <Route path="/restock-history" element={<RestockHistory />} />

                {/* Analytics - super_admin and admin */}
                <Route element={<RequireRole allowed={canAccessAnalytics} />}>
                  <Route path="/analytics" element={<AnalyticsRoute />} />
                </Route>

                {/* Agents - super_admin only */}
                <Route element={<RequireRole allowed={canManageAgents} />}>
                  <Route path="/agents" element={<AgentsRoute />} />
                </Route>

                {/* Settings - super_admin and admin */}
                <Route element={<RequireRole allowed={canAccessSettings} />}>
                  <Route path="/settings" element={<SettingsRoute />} />
                </Route>
              </Route>

              {/* Anything else -> public customer portal */}
              <Route path="*" element={<Navigate to="/CustomerPage" replace />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
      <ToastContainer
        position="top-center"
        autoClose={4000}
        newestOnTop
        closeOnClick
        pauseOnFocusLoss={false}
        limit={4}
        theme="light"
      />
    </ErrorBoundary>
  );
}

export default App;
