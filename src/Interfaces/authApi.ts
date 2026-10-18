/**
 * Typed client for the staff auth + admin endpoints (CONTRACT §1.1, §4.4).
 *
 * All functions throw on failure (axios errors). Callers show messages with
 * `getApiErrorMessage(err)` from `./http`, and can branch on the backend's
 * machine-readable `code` with `getApiErrorCode(err)` below.
 */
import axios from 'axios';
import { apiClient } from './http';
import type { Role, User } from './types';
import { isStaffRole } from './permissions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `agent_public_profile` from the backend (+ admin-only extras). */
export interface AgentProfile {
  id: string;
  email: string;
  name: string;
  role: Role;
  phone: string;
  profilePic: string;
  active: boolean;
  /** Only returned by the admin list endpoint. */
  hasSetPassword?: boolean;
  /** ISO strings (admin list endpoint). */
  createdAt?: string | null;
  lastLoginAt?: string | null;
}

export interface LoginResult {
  customToken: string;
  agent: AgentProfile;
}

export interface CreateAgentInput {
  name: string;
  email: string;
  phone: string;
  role: Role;
  profilePic?: string;
}

export interface UpdateAgentInput {
  name?: string;
  phone?: string;
  role?: Role;
  active?: boolean;
  profilePic?: string;
}

export interface RefundPasswordStatus {
  configured: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Backend error `code` (e.g. 'password_setup_required'), if any. */
export const getApiErrorCode = (err: unknown): string | undefined => {
  if (!axios.isAxiosError(err)) return undefined;
  const data = err.response?.data as { code?: unknown } | undefined;
  return typeof data?.code === 'string' ? data.code : undefined;
};

type RawAgent = Partial<Record<keyof AgentProfile, unknown>> | null | undefined;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Normalise whatever the server sent into a well-formed AgentProfile. */
export const normalizeAgent = (raw: RawAgent): AgentProfile => {
  const a = raw ?? {};
  const email = str(a.email);
  return {
    id: str(a.id),
    email,
    name: str(a.name) || email,
    role: isStaffRole(a.role) ? a.role : 'agent',
    phone: str(a.phone),
    profilePic: str(a.profilePic),
    active: a.active !== false,
    hasSetPassword: typeof a.hasSetPassword === 'boolean' ? a.hasSetPassword : undefined,
    createdAt: isoOrNull(a.createdAt),
    lastLoginAt: isoOrNull(a.lastLoginAt),
  };
};

/** Convert an AgentProfile into the app-wide `User` shape (types.ts). */
export const agentToUser = (agent: AgentProfile): User => ({
  id: agent.id || undefined,
  email: agent.email,
  name: agent.name || agent.email,
  role: agent.role,
  phone: agent.phone || undefined,
  profilePic: agent.profilePic || undefined,
  active: agent.active,
  hasSetPassword: agent.hasSetPassword,
});

const requireLoginResult = (data: { customToken?: unknown; agent?: RawAgent } | undefined): LoginResult => {
  const customToken = data?.customToken;
  if (typeof customToken !== 'string' || !customToken) {
    throw new Error('Sign-in failed: the server did not return a session. Please try again.');
  }
  return { customToken, agent: normalizeAgent(data?.agent) };
};

const normEmail = (email: string) => email.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Auth (§1.1)
// ---------------------------------------------------------------------------

/** POST /auth/login. 403 `code:'password_setup_required'` → use the set-password flow. */
export async function login(email: string, password: string): Promise<LoginResult> {
  const { data } = await apiClient.post('/auth/login', { email: normEmail(email), password });
  return requireLoginResult(data);
}

/** POST /auth/send-otp. Always succeeds for well-formed input (no user enumeration). */
export async function sendOtp(email: string): Promise<{ message: string }> {
  const { data } = await apiClient.post('/auth/send-otp', { email: normEmail(email) });
  return { message: str(data?.message, 'If the email is registered, an OTP has been sent.') };
}

/** POST /auth/verify-otp → single-use reset token (15 min). */
export async function verifyOtp(email: string, otp: string): Promise<{ resetToken: string }> {
  const { data } = await apiClient.post('/auth/verify-otp', { email: normEmail(email), otp: otp.trim() });
  const resetToken = data?.resetToken;
  if (typeof resetToken !== 'string' || !resetToken) {
    throw new Error('Verification failed. Please request a new code.');
  }
  return { resetToken };
}

/** POST /auth/setup-password → signs the agent in (custom token). */
export async function setupPassword(email: string, resetToken: string, password: string): Promise<LoginResult> {
  const { data } = await apiClient.post('/auth/setup-password', { email: normEmail(email), resetToken, password });
  return requireLoginResult(data);
}

/** GET /auth/me → authoritative profile of the signed-in staff member. */
export async function getMe(): Promise<AgentProfile> {
  const { data } = await apiClient.get('/auth/me');
  if (!data?.agent) throw new Error('Could not load your profile.');
  return normalizeAgent(data.agent);
}

/** POST /auth/change-password (optional endpoint). */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiClient.post('/auth/change-password', { currentPassword, newPassword });
}

/**
 * POST /auth/verify-refund-password — early feedback for a mistyped refund password.
 * The single implementation used by every refund flow.
 *   'ok'          password accepted
 *   'bad'         server rejected the password (403 `bad_refund_password`, or a bare 403 that is not
 *                 an account/permission problem)
 *   'unavailable' the check itself could not run (network / 5xx / endpoint missing) — callers carry on,
 *                 because the refund endpoint verifies the password again anyway.
 * Throws for 401 (session expired), 429 (rate limited) and 403 account/permission errors so the caller
 * shows that message instead of "wrong password".
 */
export async function verifyRefundPassword(password: string): Promise<'ok' | 'bad' | 'unavailable'> {
  try {
    await apiClient.post('/auth/verify-refund-password', { password });
    return 'ok';
  } catch (err) {
    if (!axios.isAxiosError(err) || !err.response) return 'unavailable';
    const status = err.response.status;
    const code = getApiErrorCode(err);
    if (code === 'bad_refund_password') return 'bad';
    if (status === 403) {
      if (code === 'account_disabled' || code === 'forbidden') throw err;
      return 'bad';
    }
    if (status === 401 || status === 429) throw err;
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Admin (§4.4)
// ---------------------------------------------------------------------------

/** GET /admin/agents (super_admin). */
export async function listAgents(): Promise<AgentProfile[]> {
  const { data } = await apiClient.get('/admin/agents');
  const list: unknown = data?.agents;
  return Array.isArray(list) ? list.map((a) => normalizeAgent(a as RawAgent)) : [];
}

/** POST /admin/agents (super_admin). Returns the created agent when the server echoes it. */
export async function createAgent(input: CreateAgentInput): Promise<AgentProfile | null> {
  const body: CreateAgentInput = {
    name: input.name.trim(),
    email: normEmail(input.email),
    phone: input.phone.trim(),
    role: input.role,
  };
  if (input.profilePic?.trim()) body.profilePic = input.profilePic.trim();
  const { data } = await apiClient.post('/admin/agents', body);
  return data?.agent ? normalizeAgent(data.agent) : null;
}

/** PUT /admin/agents/:id (super_admin) — merge update. */
export async function updateAgent(id: string, patch: UpdateAgentInput): Promise<AgentProfile | null> {
  const { data } = await apiClient.put(`/admin/agents/${encodeURIComponent(id)}`, patch);
  return data?.agent ? normalizeAgent(data.agent) : null;
}

/** DELETE /admin/agents/:id (super_admin). */
export async function deleteAgent(id: string): Promise<void> {
  await apiClient.delete(`/admin/agents/${encodeURIComponent(id)}`);
}

/** POST /admin/settings/refund-password (admin+). */
export async function setRefundPassword(newPassword: string): Promise<void> {
  await apiClient.post('/admin/settings/refund-password', { newPassword });
}

/** GET /admin/settings/refund-password/status (admin+). */
export async function getRefundPasswordStatus(): Promise<RefundPasswordStatus> {
  const { data } = await apiClient.get('/admin/settings/refund-password/status');
  return { configured: data?.configured === true };
}
