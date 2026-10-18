import React, { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { Home, RotateCcw, TrendingUp, Settings, Users, ArchiveRestore, X, LogOut } from 'lucide-react';
import { User } from '../../Interfaces/types';
import { canAccessSettings, canAccessAnalytics, canManageAgents, ROLE_LABELS } from '../../Interfaces/permissions';
import { Avatar } from './Header';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  user: User;
  onLogout?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose, user, onLogout }) => {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the drawer when it opens on mobile.
  useEffect(() => {
    if (isOpen) closeRef.current?.focus();
  }, [isOpen]);

  // Off-canvas on < lg: hidden (and not focusable) when closed; `visibility` transitions
  // after the slide so the close animation still plays.
  const drawerState = isOpen ? 'translate-x-0 visible' : '-translate-x-full invisible lg:visible';

  return (
    <>
      {/* Mobile Backdrop */}
      <div
        className={`fixed inset-0 bg-slate-900/40 z-30 lg:hidden backdrop-blur-sm transition-opacity duration-300 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        id="app-sidebar"
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] transform transition-[transform,visibility] duration-300 ease-in-out lg:relative lg:z-auto lg:translate-x-0 ${drawerState} flex flex-col h-full bg-white border-r border-slate-200 shadow-xl lg:shadow-sm`}
      >
        {/* Logo Area */}
        <div className="h-16 sm:h-20 flex items-center justify-between gap-2 px-4 sm:px-6 border-b border-slate-100 shrink-0">
          <img
            src="/reguard-logo.png"
            alt="Re-guard by Prashanti"
            className="h-12 sm:h-16 w-auto max-w-[11rem] object-contain"
          />
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="lg:hidden h-10 w-10 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 sm:px-4 space-y-1 overflow-y-auto py-2">
          <p className="px-4 text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 mt-2">Menu</p>
          <NavItem to="/" end icon={Home} label="Dashboard" onClick={onClose} />
          <NavItem to="/returns" icon={RotateCcw} label="Returns" onClick={onClose} />
          <NavItem to="/restock-history" icon={ArchiveRestore} label="Restock History" onClick={onClose} />

          {canAccessAnalytics(user?.role) && (
            <NavItem to="/analytics" icon={TrendingUp} label="Analytics" onClick={onClose} />
          )}

          {(canManageAgents(user?.role) || canAccessSettings(user?.role)) && (
            <>
              <p className="px-4 text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 mt-6">System</p>
              {canManageAgents(user?.role) && (
                <NavItem to="/agents" icon={Users} label="Agents" onClick={onClose} />
              )}
              {canAccessSettings(user?.role) && (
                <NavItem to="/settings" icon={Settings} label="Settings" onClick={onClose} />
              )}
            </>
          )}
        </nav>

        {/* Account (mobile convenience; desktop has the header menu too) */}
        <div className="border-t border-slate-100 p-3 sm:p-4 shrink-0">
          <div className="flex items-center gap-3 px-1">
            <Avatar user={user} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-800 truncate">{user?.name}</p>
              <p className="text-xs text-slate-500 truncate">{ROLE_LABELS[user?.role] || 'Agent'}</p>
            </div>
            {onLogout && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onLogout();
                }}
                aria-label="Sign out"
                title="Sign out"
                className="h-10 w-10 flex items-center justify-center rounded-lg text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                <LogOut className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};

const NavItem = ({
  to,
  end,
  icon: Icon,
  label,
  badge,
  onClick,
}: {
  to: string;
  end?: boolean;
  icon: React.ElementType;
  label: string;
  badge?: string;
  onClick: () => void;
}) => (
  <NavLink
    to={to}
    end={end}
    onClick={onClick}
    className={({ isActive }) => `
      flex items-center gap-3 px-4 min-h-[44px] rounded-lg transition-all duration-200 group
      ${isActive
        ? 'bg-indigo-50 text-indigo-700 font-semibold'
        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}
    `}
  >
    <Icon className="w-5 h-5 shrink-0 transition-colors group-hover:text-indigo-600" aria-hidden="true" />
    <span className="flex-1 truncate">{label}</span>
    {badge && (
      <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-0.5 rounded-full">
        {badge}
      </span>
    )}
  </NavLink>
);
