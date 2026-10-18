import { Role } from './types';

// ==========================================================
// ROLE-BASED ACCESS CONTROL
// ==========================================================
// Single source of truth for what each role is allowed to do.
// Import these helpers instead of comparing `role === '...'` inline
// so the rules stay consistent everywhere they're checked.

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  agent: "Agent",
};

// Order matters for the role picker UI (lowest privilege first)
export const ROLE_OPTIONS: Role[] = ["agent", "admin", "super_admin"];

/** Only super admins can add, edit, delete, or view the Agents management page. */
export const canManageAgents = (role?: Role | null): boolean =>
  role === "super_admin";

/** Super admins and admins can access the Settings page. */
export const canAccessSettings = (role?: Role | null): boolean =>
  role === "super_admin" || role === "admin";

/** Super admins and admins can access the Analytics page. */
export const canAccessAnalytics = (role?: Role | null): boolean =>
  role === "super_admin" || role === "admin";

/**
 * Only super admins and admins can issue refunds to the original payment
 * method. Agents are limited to manual, store credit, and gift card refunds.
 */
export const canRefundOriginalPayment = (role?: Role | null): boolean =>
  role === "super_admin" || role === "admin";

export const isSuperAdmin = (role?: Role | null): boolean =>
  role === "super_admin";

/** Type guard: is this value one of the known staff roles? */
export const isStaffRole = (role: unknown): role is Role =>
  role === "super_admin" || role === "admin" || role === "agent";

/** One-line explanation of each role (used by the Agents page role picker). */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  super_admin: "Full access, including managing other agents.",
  admin: "Can access Settings, Analytics, and refund to the original payment method. Cannot manage agents.",
  agent: "Handles returns day-to-day. Cannot refund to the original payment method, and has no access to Settings, Analytics, or Agent management.",
};
