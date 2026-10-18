/**
 * Staff session state.
 *
 * Source of truth = Firebase Auth (`onAuthStateChanged`) + `GET /api/auth/me`
 * (role, name, …). The profile is mirrored to localStorage with
 * `saveUserToStorage` for display only (legacy components read it with
 * `getUserFromStorage`) — never use that copy for authorization.
 *
 * Usage:
 *   const { user, loading, logout, refreshProfile } = useAuth();
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { onAuthStateChanged, signInWithCustomToken, signOut, type User as FirebaseUser } from 'firebase/auth';
import { toast } from 'react-toastify';
import { auth } from '../../Interfaces/firebase';
import { SESSION_EXPIRED_EVENT, getApiErrorMessage, getApiErrorStatus } from '../../Interfaces/http';
import { agentToUser, getMe, type LoginResult } from '../../Interfaces/authApi';
import { User, clearUserFromStorage, getUserFromStorage, saveUserToStorage } from '../../Interfaces/types';
import { isStaffRole } from '../../Interfaces/permissions';

export interface AuthContextValue {
  /** Signed-in staff member (authoritative profile from /auth/me), or null. */
  user: User | null;
  /** True until the initial Firebase session + profile have been resolved. */
  loading: boolean;
  /**
   * Sign out, clear the cached profile and go to `/login` (or `redirectTo`).
   * `returnHere: true` passes `state.from` (current location) so signing in again returns to this page.
   */
  logout: (opts?: { redirectTo?: string; returnHere?: boolean }) => Promise<void>;
  /** Re-fetch /auth/me (e.g. after editing your own profile). */
  refreshProfile: () => Promise<User | null>;
  /** Used by the login page: sign in with the backend's custom token. */
  completeSignIn: (result: LoginResult) => Promise<User>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Paths where an expired staff session should NOT redirect to /login. */
const PUBLIC_PATH_PREFIXES = ['/CustomerPage', '/ReturnStatusPage', '/login'];
const isPublicPath = (path: string) =>
  PUBLIC_PATH_PREFIXES.some((p) => path.toLowerCase().startsWith(p.toLowerCase()));

/** Custom-token users have no `email`; the backend uses the lower-cased email as uid. */
const firebaseIdentity = (fbUser: FirebaseUser): string => (fbUser.email || fbUser.uid || '').toLowerCase();
const sameIdentity = (u: User | null, fbUser: FirebaseUser) =>
  !!u && (u.email || '').trim().toLowerCase() === firebaseIdentity(fbUser);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  /** Latest location, read by logout() without re-creating the callback on every navigation. */
  const locationRef = useRef(location);
  locationRef.current = location;
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const userRef = useRef<User | null>(null);
  /** Incremented on every profile load / sign-out so stale responses are ignored. */
  const seqRef = useRef(0);
  /** Profile returned by /auth/login or /auth/setup-password (skips one /auth/me round-trip). */
  const pendingRef = useRef<User | null>(null);

  const applyUser = useCallback((u: User | null) => {
    userRef.current = u;
    if (u) saveUserToStorage(u);
    else clearUserFromStorage();
    setUser(u);
  }, []);

  const forceSignOut = useCallback(async () => {
    seqRef.current += 1;
    pendingRef.current = null;
    applyUser(null);
    try {
      await signOut(auth);
    } catch (err) {
      console.error('Sign-out failed:', err);
    }
  }, [applyUser]);

  const loadProfile = useCallback(
    async (fbUser: FirebaseUser): Promise<User | null> => {
      const seq = ++seqRef.current;
      try {
        const agent = await getMe();
        if (seq !== seqRef.current) return userRef.current;
        const u = agentToUser(agent);
        applyUser(u);
        return u;
      } catch (err) {
        if (seq !== seqRef.current) return userRef.current;
        const status = getApiErrorStatus(err);
        if (status === 401 || status === 403) {
          // 401s also fire SESSION_EXPIRED_EVENT (http.ts) which shows its own toast.
          if (status === 403) toast.error(getApiErrorMessage(err), { toastId: 'auth-forbidden' });
          await forceSignOut();
          return null;
        }
        // Network / server error: keep the Firebase session and fall back to
        // the cached profile or the role claims inside the ID token.
        console.error('Could not load staff profile:', err);
        const cached = getUserFromStorage();
        if (cached && sameIdentity(cached, fbUser)) {
          applyUser(cached);
          return cached;
        }
        try {
          const { claims } = await fbUser.getIdTokenResult();
          if (seq !== seqRef.current) return userRef.current;
          if (claims.staff === true && isStaffRole(claims.role)) {
            const identity = firebaseIdentity(fbUser);
            const u: User = {
              email: identity,
              name: typeof claims.name === 'string' && claims.name ? claims.name : identity,
              role: claims.role,
            };
            applyUser(u);
            toast.warning("Couldn't load your full profile. Some details may be missing.", { toastId: 'auth-profile' });
            return u;
          }
        } catch (claimErr) {
          console.error('Could not read session claims:', claimErr);
        }
        toast.error("We couldn't verify your session. Please sign in again.", { toastId: 'auth-profile' });
        await forceSignOut();
        return null;
      }
    },
    [applyUser, forceSignOut]
  );

  // Firebase session listener.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onAuthStateChanged(
      auth,
      (fbUser) => {
        if (cancelled) return;
        if (!fbUser) {
          seqRef.current += 1;
          applyUser(null);
          setLoading(false);
          return;
        }
        const pending = pendingRef.current;
        if (pending && sameIdentity(pending, fbUser)) {
          pendingRef.current = null;
          applyUser(pending);
          setLoading(false);
          return;
        }
        if (!sameIdentity(userRef.current, fbUser)) setLoading(true);
        void loadProfile(fbUser).finally(() => {
          if (!cancelled) setLoading(false);
        });
      },
      (err) => {
        console.error('Auth state error:', err);
        if (cancelled) return;
        applyUser(null);
        setLoading(false);
      }
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyUser, loadProfile]);

  const logout = useCallback(
    async (opts?: { redirectTo?: string; returnHere?: boolean }) => {
      const loc = locationRef.current;
      navigate(opts?.redirectTo ?? '/login', {
        replace: true,
        ...(opts?.returnHere && loc
          ? { state: { from: { pathname: loc.pathname, search: loc.search, hash: loc.hash } } }
          : {}),
      });
      await forceSignOut();
    },
    [navigate, forceSignOut]
  );

  // Backend says the session is no longer valid (http.ts interceptor).
  useEffect(() => {
    const onExpired = () => {
      if (!userRef.current && !auth.currentUser) return;
      const path = window.location.pathname;
      if (isPublicPath(path)) {
        void forceSignOut();
        return;
      }
      toast.error('Your session expired, please sign in again', { toastId: 'session-expired' });
      // Come back to this page after signing in again.
      void logout({ returnHere: true });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [logout, forceSignOut]);

  const refreshProfile = useCallback(async () => {
    const fbUser = auth.currentUser;
    if (!fbUser) return null;
    return loadProfile(fbUser);
  }, [loadProfile]);

  const completeSignIn = useCallback(
    async (result: LoginResult) => {
      const u = agentToUser(result.agent);
      pendingRef.current = u;
      try {
        await signInWithCustomToken(auth, result.customToken);
      } catch (err) {
        pendingRef.current = null;
        throw err;
      }
      seqRef.current += 1; // ignore any in-flight profile load for a previous session
      pendingRef.current = null;
      applyUser(u);
      setLoading(false);
      return u;
    },
    [applyUser]
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, logout, refreshProfile, completeSignIn }),
    [user, loading, logout, refreshProfile, completeSignIn]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Access the staff session. Must be used under `<AuthProvider>` (inside the router). */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
