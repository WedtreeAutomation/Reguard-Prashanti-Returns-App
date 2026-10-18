import React, { useEffect, useRef, useState } from 'react';
import { Menu, ChevronDown, LogOut } from 'lucide-react';
import { User } from '../../Interfaces/types';
import { ROLE_LABELS } from '../../Interfaces/permissions';

interface HeaderProps {
  onMenuClick: () => void;
  /** Whether the mobile navigation drawer is open (for aria-expanded). */
  menuOpen?: boolean;
  title?: string;
  user: User;
  onLogout: () => void;
}

// Badge colour per role, shown in the account dropdown
const ROLE_BADGE_CLASSES: Record<string, string> = {
  super_admin: 'bg-indigo-100 text-indigo-800',
  admin: 'bg-blue-100 text-blue-700',
  agent: 'bg-slate-100 text-slate-700',
};

const initialsOf = (name: string | undefined, email: string | undefined) => {
  const source = (name || email || '?').trim();
  return (
    source
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || '?'
  );
};

export const Avatar = ({ user, size = 'w-9 h-9' }: { user: User; size?: string }) => {
  const [failed, setFailed] = useState(false);
  if (user.profilePic && !failed) {
    return (
      <img
        src={user.profilePic}
        alt=""
        className={`${size} rounded-full object-cover shrink-0`}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className={`${size} rounded-full bg-indigo-600 text-white flex items-center justify-center text-sm font-semibold shrink-0`}
      aria-hidden="true"
    >
      {initialsOf(user.name, user.email)}
    </span>
  );
};

export const Header: React.FC<HeaderProps> = ({ onMenuClick, menuOpen = false, title = 'Dashboard', user, onLogout }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const roleLabel = ROLE_LABELS[user.role] || 'Agent';
  const firstName = (user.name || user.email || '').split(' ')[0];

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-20 bg-white border-b border-slate-200 h-16 sm:h-20 shrink-0">
      <div className="px-3 sm:px-6 h-full flex items-center justify-between gap-2 sm:gap-4">
        {/* Left: Mobile Toggle & Page Title */}
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="Open navigation menu"
            aria-controls="app-sidebar"
            aria-expanded={menuOpen}
            className="h-10 w-10 -ml-1 flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded-lg lg:hidden transition-colors shrink-0"
          >
            <Menu className="w-6 h-6" />
          </button>
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 leading-tight truncate">{title}</h1>
        </div>

        {/* Right: User menu */}
        <div className="relative shrink-0" ref={wrapRef}>
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Account menu for ${user.name || user.email}`}
            className="flex items-center gap-2 sm:gap-3 hover:bg-slate-50 p-1 sm:p-1.5 sm:pr-3 rounded-full transition-colors border border-transparent hover:border-slate-200 min-h-[40px]"
          >
            <Avatar user={user} />
            <span className="hidden md:block text-left">
              <span className="block text-sm font-semibold text-slate-700 leading-none max-w-[10rem] truncate">{firstName}</span>
              <span className="block text-xs text-slate-500 mt-0.5">{roleLabel}</span>
            </span>
            <ChevronDown
              className={`hidden sm:block w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>

          {open && (
            <div
              role="menu"
              aria-label="Account"
              className="absolute right-0 mt-2 w-64 max-w-[calc(100vw-1.5rem)] bg-white rounded-xl shadow-lg border border-slate-200 py-2 z-30"
            >
              <div className="px-4 py-3 border-b border-slate-100">
                <p className="text-sm font-semibold text-slate-800 break-words">{user.name}</p>
                <p className="text-xs text-slate-500 mt-0.5 break-all">{user.email}</p>
                <span
                  className={`inline-block mt-2 px-2 py-0.5 text-xs font-medium rounded-full ${
                    ROLE_BADGE_CLASSES[user.role] || ROLE_BADGE_CLASSES.agent
                  }`}
                >
                  {roleLabel}
                </span>
              </div>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onLogout();
                }}
                className="flex items-center w-full px-4 py-3 text-sm font-medium text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none transition-colors mt-1"
              >
                <LogOut className="w-4 h-4 mr-2" aria-hidden="true" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
