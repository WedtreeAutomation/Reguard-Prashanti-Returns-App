import React, { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { User } from '../../Interfaces/types';

interface MainLayoutProps {
  user: User;
  onLogout: () => void;
  children?: React.ReactNode;
}

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/home': 'Dashboard',
  '/returns': 'Returns Management',
  '/restock-history': 'Restock History',
  '/analytics': 'Analytics',
  '/agents': 'Team Management',
  '/settings': 'Settings',
};

const getTitle = (pathname: string): string => {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  if (pathname.startsWith('/returns/')) return 'Return Details';
  return 'Dashboard';
};

export const MainLayout: React.FC<MainLayoutProps> = ({ user, onLogout, children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const title = getTitle(location.pathname);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  useEffect(() => {
    document.title = `${title} · Re-Guard`;
  }, [title]);

  return (
    <div className="flex h-screen h-dvh bg-slate-50 font-sans text-slate-800 overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-indigo-700 focus:shadow"
      >
        Skip to content
      </a>

      <Sidebar isOpen={sidebarOpen} onClose={closeSidebar} user={user} onLogout={onLogout} />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          menuOpen={sidebarOpen}
          title={title}
          user={user}
          onLogout={onLogout}
        />

        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4 md:p-6 focus:outline-none">
          {children || <Outlet />}
        </main>
      </div>
    </div>
  );
};
