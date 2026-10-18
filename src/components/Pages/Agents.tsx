import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus,
  Edit2,
  Trash2,
  Loader2,
  User as UserIcon,
  Check,
  AlertCircle,
  Users,
  Mail,
  Phone,
  ShieldAlert,
  Crown,
  ShieldCheck,
  Search,
  KeyRound,
  Clock,
  RefreshCw,
  UserCheck,
} from "lucide-react";
import { toast } from "react-toastify";
import { User, Role } from "../../Interfaces/types";
import { canManageAgents, ROLE_LABELS, ROLE_OPTIONS, ROLE_DESCRIPTIONS } from "../../Interfaces/permissions";
import { getApiErrorMessage } from "../../Interfaces/http";
import {
  AgentProfile,
  CreateAgentInput,
  UpdateAgentInput,
  createAgent,
  deleteAgent,
  listAgents,
  updateAgent,
} from "../../Interfaces/authApi";
import { Modal } from "../common/Modal";
import { useAuth } from "../common/AuthContext";

interface AgentsProps {
  currentUser?: User | null;
}

type StatusFilter = "all" | "active" | "inactive" | "pending";

interface AgentForm {
  name: string;
  email: string;
  phone: string;
  role: Role;
  active: boolean;
  profilePic: string;
}

const EMPTY_FORM: AgentForm = { name: "", email: "", phone: "", role: "agent", active: true, profilePic: "" };

const ROLE_BADGE_STYLES: Record<Role, string> = {
  super_admin: "bg-indigo-50 text-indigo-700 border-indigo-100",
  admin: "bg-blue-50 text-blue-700 border-blue-100",
  agent: "bg-slate-50 text-slate-600 border-slate-200",
};

const ROLE_ICONS: Record<Role, typeof Crown> = {
  super_admin: Crown,
  admin: ShieldCheck,
  agent: UserIcon,
};

const PENDING_HELP = "Invitation pending — ask the agent to use 'Forgot / set password' on the login page.";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const inputCls = (hasError?: boolean) =>
  `w-full min-h-[44px] bg-slate-50 border ${
    hasError ? "border-red-300" : "border-slate-200"
  } rounded-xl px-4 py-2.5 text-slate-900 focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-medium disabled:bg-slate-100 disabled:text-slate-500`;

const initialsOf = (name: string) =>
  (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";

const formatDateTime = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return d.toISOString();
  }
};

const isHttpUrl = (value: string) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ small UI */

const AgentAvatar = ({ agent, size = "h-10 w-10" }: { agent: Pick<AgentProfile, "name" | "profilePic">; size?: string }) => {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`${size} shrink-0 rounded-full overflow-hidden border border-slate-200 shadow-sm`}>
      {agent.profilePic && !failed ? (
        <img src={agent.profilePic} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className="h-full w-full bg-slate-100 flex items-center justify-center text-slate-500 font-bold text-xs" aria-hidden="true">
          {initialsOf(agent.name)}
        </div>
      )}
    </div>
  );
};

const RoleBadge = ({ role }: { role: Role }) => {
  const RoleIcon = ROLE_ICONS[role] ?? UserIcon;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${ROLE_BADGE_STYLES[role] ?? ROLE_BADGE_STYLES.agent}`}>
      <RoleIcon className="h-3 w-3 mr-1.5" aria-hidden="true" />
      {ROLE_LABELS[role] ?? "Agent"}
    </span>
  );
};

const StatusBadges = ({ agent }: { agent: AgentProfile }) => (
  <div className="flex flex-wrap gap-1.5">
    {!agent.active && (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border bg-slate-100 text-slate-600 border-slate-200">
        Inactive
      </span>
    )}
    {agent.hasSetPassword === false ? (
      <span
        className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border bg-amber-50 text-amber-800 border-amber-200"
        title={PENDING_HELP}
      >
        <Clock className="h-3 w-3 mr-1.5" aria-hidden="true" />
        Invitation pending
      </span>
    ) : agent.hasSetPassword === true ? (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border bg-emerald-50 text-emerald-700 border-emerald-100">
        <KeyRound className="h-3 w-3 mr-1.5" aria-hidden="true" />
        Password set
      </span>
    ) : null}
  </div>
);

/** Icon button that stays hoverable (tooltip) even when disabled. */
const ActionButton = ({
  label,
  disabledReason,
  onClick,
  tone,
  children,
}: {
  label: string;
  disabledReason?: string;
  onClick: () => void;
  tone: "edit" | "delete";
  children: React.ReactNode;
}) => {
  const disabled = !!disabledReason;
  const toneCls =
    tone === "edit" ? "hover:text-indigo-600 hover:bg-indigo-50" : "hover:text-red-600 hover:bg-red-50";
  return (
    <span title={disabledReason ?? label} className="inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={disabled ? `${label} (${disabledReason})` : label}
        className={`h-10 w-10 flex items-center justify-center rounded-lg text-slate-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-400 ${toneCls}`}
      >
        {children}
      </button>
    </span>
  );
};

/* ------------------------------------------------------------------ page */

export default function Agents({ currentUser }: AgentsProps) {
  const { refreshProfile } = useAuth();
  const allowed = canManageAgents(currentUser?.role);

  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentProfile | null>(null);
  const [form, setForm] = useState<AgentForm>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof AgentForm, string>>>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<AgentProfile | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isSelf = useCallback(
    (agent: Pick<AgentProfile, "id" | "email">) => {
      if (!currentUser) return false;
      if (currentUser.id && agent.id && currentUser.id === agent.id) return true;
      return !!agent.email && agent.email.toLowerCase() === (currentUser.email || "").toLowerCase();
    },
    [currentUser]
  );

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const list = await listAgents();
      list.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
      setAgents(list);
    } catch (err) {
      console.error("Error fetching agents:", err);
      const msg = getApiErrorMessage(err, "Failed to load agents.");
      setLoadError(msg);
      toast.error(msg, { toastId: "agents-load" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (allowed) void fetchAgents();
    else setLoading(false);
  }, [allowed, fetchAgents]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    return agents.filter((a) => {
      if (roleFilter !== "all" && a.role !== roleFilter) return false;
      if (statusFilter === "active" && !a.active) return false;
      if (statusFilter === "inactive" && a.active) return false;
      if (statusFilter === "pending" && a.hasSetPassword !== false) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q) ||
        (qDigits.length >= 3 && a.phone.replace(/\D/g, "").includes(qDigits))
      );
    });
  }, [agents, search, roleFilter, statusFilter]);

  const stats = useMemo(
    () => ({
      total: agents.length,
      active: agents.filter((a) => a.active).length,
      pending: agents.filter((a) => a.hasSetPassword === false).length,
    }),
    [agents]
  );

  /* ---------------------------------------------------------------- form */

  const openAddModal = () => {
    setEditingAgent(null);
    setForm(EMPTY_FORM);
    setFormErrors({});
    setFormError("");
    setModalOpen(true);
  };

  const openEditModal = (agent: AgentProfile) => {
    setEditingAgent(agent);
    setForm({
      name: agent.name,
      email: agent.email,
      phone: agent.phone,
      role: agent.role,
      active: agent.active,
      profilePic: agent.profilePic,
    });
    setFormErrors({});
    setFormError("");
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
  };

  const validateForm = (): boolean => {
    const errors: Partial<Record<keyof AgentForm, string>> = {};
    const name = form.name.trim();
    if (!name) errors.name = "Name is required";
    else if (name.length > 100) errors.name = "Name must be 100 characters or fewer";
    if (!editingAgent) {
      if (!form.email.trim()) errors.email = "Email is required";
      else if (!EMAIL_RE.test(form.email.trim())) errors.email = "Enter a valid email address";
    }
    const digits = form.phone.replace(/\D/g, "");
    if (!form.phone.trim()) errors.phone = "Phone is required";
    else if (digits.length < 10 || digits.length > 15) errors.phone = "Enter a valid phone number (10–15 digits)";
    const pic = form.profilePic.trim();
    if (pic && !isHttpUrl(pic)) errors.profilePic = "Enter a full image URL starting with https://";
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const saveAgent = async () => {
    if (saving) return;
    if (!allowed) {
      toast.error("You don't have permission to manage agents");
      return;
    }
    setFormError("");
    if (!validateForm()) return;

    setSaving(true);
    try {
      if (editingAgent) {
        const self = isSelf(editingAgent);
        const patch: UpdateAgentInput = {};
        if (form.name.trim() !== editingAgent.name) patch.name = form.name.trim();
        if (form.phone.trim() !== editingAgent.phone) patch.phone = form.phone.trim();
        if (form.profilePic.trim() !== editingAgent.profilePic) patch.profilePic = form.profilePic.trim();
        if (!self) {
          if (form.role !== editingAgent.role) patch.role = form.role;
          if (form.active !== editingAgent.active) patch.active = form.active;
        }
        if (Object.keys(patch).length === 0) {
          toast.info("No changes to save");
          setModalOpen(false);
          return;
        }
        await updateAgent(editingAgent.id, patch);
        toast.success(`${form.name.trim()} updated`);
        if (self) {
          try {
            await refreshProfile();
          } catch (e) {
            console.error("Profile refresh failed:", e);
          }
        }
      } else {
        const input: CreateAgentInput = {
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          role: form.role,
          profilePic: form.profilePic.trim() || undefined,
        };
        await createAgent(input);
        toast.success(`${input.name} added. Ask them to use 'Forgot / set password' on the login page to set their password.`, {
          autoClose: 8000,
        });
      }
      setModalOpen(false);
      await fetchAgents();
    } catch (err) {
      console.error("Error saving agent:", err);
      const msg = getApiErrorMessage(err, `Failed to ${editingAgent ? "update" : "add"} agent.`);
      setFormError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    if (isSelf(deleteTarget)) {
      toast.error("You can't delete your own account");
      return;
    }
    setDeleting(true);
    try {
      await deleteAgent(deleteTarget.id);
      toast.success(`${deleteTarget.name} deleted`);
      setDeleteTarget(null);
      await fetchAgents();
    } catch (err) {
      console.error("Error deleting agent:", err);
      toast.error(getApiErrorMessage(err, "Failed to delete agent."));
    } finally {
      setDeleting(false);
    }
  };

  /* ---------------------------------------------------------------- render */

  if (!allowed) {
    return (
      <div className="py-10 flex items-center justify-center">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 sm:p-10 max-w-md w-full text-center">
          <div className="h-16 w-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4 text-red-500">
            <ShieldAlert className="h-8 w-8" aria-hidden="true" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Access Restricted</h2>
          <p className="text-sm text-slate-500">
            Agent management is only available to Super Admins. Contact a Super Admin if you need changes made to the team.
          </p>
        </div>
      </div>
    );
  }

  const editingSelf = !!editingAgent && isSelf(editingAgent);
  const selfReason = "You can't change your own role or status";

  return (
    <div className="max-w-7xl mx-auto space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <div className="h-12 w-12 sm:h-14 sm:w-14 shrink-0 bg-indigo-50 rounded-xl flex items-center justify-center text-indigo-600 border border-indigo-100">
              <Users className="h-6 w-6 sm:h-7 sm:w-7" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">Agents Management</h1>
              <p className="text-sm text-slate-500 font-medium">Manage your Returns team and permissions</p>
            </div>
          </div>
          <button
            type="button"
            onClick={openAddModal}
            disabled={loading}
            className="inline-flex min-h-[44px] items-center justify-center px-5 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all shadow-sm font-semibold text-sm disabled:opacity-60"
          >
            <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
            Add New Agent
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[
          { label: "Total", value: stats.total, icon: Users, cls: "bg-blue-50 text-blue-600" },
          { label: "Active", value: stats.active, icon: UserCheck, cls: "bg-emerald-50 text-emerald-600" },
          { label: "Pending", value: stats.pending, icon: Clock, cls: "bg-amber-50 text-amber-600" },
        ].map(({ label, value, icon: Icon, cls }) => (
          <div key={label} className="bg-white rounded-xl p-3 sm:p-6 border border-slate-200 shadow-sm flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 truncate">{label}</p>
              <p className="text-xl sm:text-3xl font-bold text-slate-900">{loading ? "–" : value}</p>
            </div>
            <div className={`hidden sm:flex h-12 w-12 shrink-0 rounded-full items-center justify-center ${cls}`}>
              <Icon className="h-6 w-6" aria-hidden="true" />
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-3 sm:p-4 flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true" />
          <label htmlFor="agent-search" className="sr-only">Search agents</label>
          <input
            id="agent-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email or phone"
            className="w-full min-h-[44px] pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 md:flex">
          <label className="sr-only" htmlFor="agent-role-filter">Filter by role</label>
          <select
            id="agent-role-filter"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as "all" | Role)}
            className="min-h-[44px] px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          >
            <option value="all">All roles</option>
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
          <label className="sr-only" htmlFor="agent-status-filter">Filter by status</label>
          <select
            id="agent-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="min-h-[44px] px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="pending">Invitation pending</option>
          </select>
        </div>
      </div>

      {/* List */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex justify-center items-center h-64" role="status">
            <div className="text-center">
              <Loader2 className="h-10 w-10 text-indigo-600 animate-spin mx-auto mb-3" aria-hidden="true" />
              <p className="text-slate-500 font-medium text-sm">Loading team…</p>
            </div>
          </div>
        ) : loadError ? (
          <div className="text-center py-16 px-4" role="alert">
            <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-3" aria-hidden="true" />
            <h3 className="text-base font-bold text-slate-800 mb-1">Couldn't load agents</h3>
            <p className="text-sm text-slate-500 mb-5">{loadError}</p>
            <button
              type="button"
              onClick={() => void fetchAgents()}
              className="inline-flex min-h-[44px] items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 text-slate-700 font-semibold rounded-xl hover:bg-slate-50 text-sm"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" /> Try again
            </button>
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-16 sm:py-20 px-4 bg-slate-50/50">
            <div className="h-20 w-20 bg-white rounded-full flex items-center justify-center mx-auto mb-4 border border-slate-200 shadow-sm">
              <Users className="h-10 w-10 text-slate-300" aria-hidden="true" />
            </div>
            <h3 className="text-lg font-bold text-slate-800 mb-1">No agents found</h3>
            <p className="text-slate-500 mb-6 text-sm">Add your first agent to get started.</p>
            <button
              type="button"
              onClick={openAddModal}
              className="min-h-[44px] px-5 py-2.5 bg-white border border-slate-200 text-slate-700 font-semibold rounded-lg hover:bg-slate-50 text-sm shadow-sm"
            >
              + Add Agent
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-14 px-4 text-sm text-slate-500">No agents match your search or filters.</div>
        ) : (
          <>
            {/* Mobile cards */}
            <ul className="md:hidden divide-y divide-slate-100">
              {filtered.map((agent) => {
                const self = isSelf(agent);
                return (
                  <li key={agent.id || agent.email} className="p-4">
                    <div className="flex items-start gap-3">
                      <AgentAvatar agent={agent} />
                      <div className="min-w-0 flex-1">
                        <p className="font-bold text-slate-900 text-sm break-words">
                          {agent.name}
                          {self && <span className="ml-1.5 text-xs font-medium text-slate-400">(you)</span>}
                        </p>
                        <p className="text-xs text-slate-600 break-all flex items-center gap-1.5 mt-1">
                          <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                          {agent.email}
                        </p>
                        {agent.phone && (
                          <p className="text-xs text-slate-600 flex items-center gap-1.5 mt-1">
                            <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                            {agent.phone}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          <RoleBadge role={agent.role} />
                          <StatusBadges agent={agent} />
                        </div>
                        {agent.hasSetPassword === false && (
                          <p className="text-[11px] text-amber-700 mt-2">{PENDING_HELP}</p>
                        )}
                      </div>
                      <div className="flex flex-col gap-1 -mr-2">
                        <ActionButton label={`Edit ${agent.name}`} tone="edit" onClick={() => openEditModal(agent)}>
                          <Edit2 className="h-4 w-4" />
                        </ActionButton>
                        <ActionButton
                          label={`Delete ${agent.name}`}
                          tone="delete"
                          disabledReason={self ? "You can't delete your own account" : undefined}
                          onClick={() => setDeleteTarget(agent)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </ActionButton>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    <th scope="col" className="text-left py-4 px-6 text-xs font-bold text-slate-500 uppercase tracking-wider">Profile</th>
                    <th scope="col" className="text-left py-4 px-6 text-xs font-bold text-slate-500 uppercase tracking-wider">Contact Info</th>
                    <th scope="col" className="text-left py-4 px-6 text-xs font-bold text-slate-500 uppercase tracking-wider">Access Role</th>
                    <th scope="col" className="text-left py-4 px-6 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                    <th scope="col" className="py-4 px-6 text-xs font-bold text-slate-500 uppercase tracking-wider text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filtered.map((agent) => {
                    const self = isSelf(agent);
                    const lastLogin = formatDateTime(agent.lastLoginAt);
                    return (
                      <tr key={agent.id || agent.email} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-4 px-6">
                          <div className="flex items-center gap-4">
                            <AgentAvatar agent={agent} />
                            <div className="min-w-0">
                              <div className="font-bold text-slate-900 text-sm">
                                {agent.name}
                                {self && <span className="ml-1.5 text-xs font-medium text-slate-400">(you)</span>}
                              </div>
                              {lastLogin && <div className="text-xs text-slate-400 mt-0.5">Last login {lastLogin}</div>}
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-6">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <Mail className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                              {agent.email}
                            </div>
                            {agent.phone && (
                              <div className="flex items-center gap-2 text-sm text-slate-600">
                                <Phone className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                                {agent.phone}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="py-4 px-6">
                          <RoleBadge role={agent.role} />
                        </td>
                        <td className="py-4 px-6">
                          <StatusBadges agent={agent} />
                        </td>
                        <td className="py-4 px-6 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <ActionButton label={`Edit ${agent.name}`} tone="edit" onClick={() => openEditModal(agent)}>
                              <Edit2 className="h-4 w-4" />
                            </ActionButton>
                            <ActionButton
                              label={`Delete ${agent.name}`}
                              tone="delete"
                              disabledReason={self ? "You can't delete your own account" : undefined}
                              onClick={() => setDeleteTarget(agent)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </ActionButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Add / Edit */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        closeDisabled={saving}
        title={editingAgent ? "Edit Agent" : "Add New Agent"}
        description={editingAgent ? editingAgent.email : "New agents set their own password from the login page."}
        footer={
          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3">
            <button
              type="button"
              onClick={closeModal}
              disabled={saving}
              className="min-h-[44px] flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-slate-600 font-semibold hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="agent-form"
              disabled={saving}
              className="min-h-[44px] flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl font-bold shadow-sm transition-all disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {saving ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Check className="h-5 w-5" aria-hidden="true" />}
              {editingAgent ? "Save changes" : "Create agent"}
            </button>
          </div>
        }
      >
        <form
          id="agent-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void saveAgent();
          }}
          className="space-y-4"
        >
          <div className="flex items-center gap-3">
            <AgentAvatar agent={{ name: form.name, profilePic: form.profilePic.trim() }} size="h-14 w-14" />
            <p className="text-xs text-slate-500">
              Profile picture is optional. Paste a public image URL below.
            </p>
          </div>

          <div>
            <label htmlFor="agent-name" className="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Full Name</label>
            <input
              id="agent-name"
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputCls(!!formErrors.name)}
              placeholder="e.g. Sarah Smith"
              autoComplete="off"
              maxLength={100}
              disabled={saving}
              aria-invalid={!!formErrors.name}
              aria-describedby={formErrors.name ? "agent-name-err" : undefined}
            />
            {formErrors.name && <FieldError id="agent-name-err" msg={formErrors.name} />}
          </div>

          <div>
            <label htmlFor="agent-email" className="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Email</label>
            <input
              id="agent-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className={inputCls(!!formErrors.email)}
              placeholder="agent@prashantisarees.com"
              autoComplete="off"
              inputMode="email"
              autoCapitalize="none"
              disabled={saving || !!editingAgent}
              aria-invalid={!!formErrors.email}
              aria-describedby={editingAgent ? "agent-email-help" : formErrors.email ? "agent-email-err" : undefined}
            />
            {editingAgent && (
              <p id="agent-email-help" className="text-xs text-slate-400 mt-1 ml-1">
                Email can't be changed. To use a different email, delete this agent and add them again.
              </p>
            )}
            {formErrors.email && <FieldError id="agent-email-err" msg={formErrors.email} />}
          </div>

          <div>
            <label htmlFor="agent-phone" className="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">Phone</label>
            <input
              id="agent-phone"
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className={inputCls(!!formErrors.phone)}
              placeholder="+91 98765 43210"
              autoComplete="off"
              inputMode="tel"
              disabled={saving}
              aria-invalid={!!formErrors.phone}
              aria-describedby={formErrors.phone ? "agent-phone-err" : undefined}
            />
            {formErrors.phone && <FieldError id="agent-phone-err" msg={formErrors.phone} />}
          </div>

          <div>
            <label htmlFor="agent-pic" className="block text-xs font-bold text-slate-500 uppercase mb-1.5 ml-1">
              Profile picture URL <span className="normal-case font-medium text-slate-400">(optional)</span>
            </label>
            <input
              id="agent-pic"
              type="url"
              value={form.profilePic}
              onChange={(e) => setForm({ ...form, profilePic: e.target.value })}
              className={inputCls(!!formErrors.profilePic)}
              placeholder="https://…"
              autoComplete="off"
              inputMode="url"
              disabled={saving}
              aria-invalid={!!formErrors.profilePic}
              aria-describedby={formErrors.profilePic ? "agent-pic-err" : undefined}
            />
            {formErrors.profilePic && <FieldError id="agent-pic-err" msg={formErrors.profilePic} />}
          </div>

          <fieldset disabled={saving || editingSelf}>
            <legend className="block text-xs font-bold text-slate-500 uppercase mb-2 ml-1">Access Role</legend>
            <div className="grid grid-cols-3 gap-2" title={editingSelf ? selfReason : undefined}>
              {ROLE_OPTIONS.map((roleOption) => {
                const RoleIcon = ROLE_ICONS[roleOption];
                const active = form.role === roleOption;
                return (
                  <label
                    key={roleOption}
                    className={`min-h-[60px] border rounded-xl p-2 sm:p-3 flex flex-col items-center justify-center gap-1 transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-300 ${
                      editingSelf ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                    } ${
                      active
                        ? `${ROLE_BADGE_STYLES[roleOption]} border-2`
                        : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="role"
                      className="sr-only"
                      checked={active}
                      onChange={() => setForm({ ...form, role: roleOption })}
                    />
                    <RoleIcon className="w-4 h-4" aria-hidden="true" />
                    <span className="font-semibold text-xs text-center">{ROLE_LABELS[roleOption]}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-slate-400 mt-2 ml-1">{ROLE_DESCRIPTIONS[form.role]}</p>
          </fieldset>

          {editingAgent && (
            <div
              className={`flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3 ${editingSelf ? "opacity-60" : ""}`}
              title={editingSelf ? selfReason : undefined}
            >
              <div className="min-w-0">
                <p id="agent-active-label" className="text-sm font-bold text-slate-700">Active</p>
                <p className="text-xs text-slate-500">Inactive agents can't sign in. Their history is kept.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={form.active}
                aria-labelledby="agent-active-label"
                disabled={saving || editingSelf}
                onClick={() => setForm({ ...form, active: !form.active })}
                className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 ${
                  form.active ? "bg-indigo-600" : "bg-slate-300"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    form.active ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          )}

          {editingSelf && <p className="text-xs text-slate-500">{selfReason}.</p>}

          {editingAgent && editingAgent.hasSetPassword === false && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">{PENDING_HELP}</p>
          )}

          {formError && (
            <div role="alert" className="p-3 bg-red-50 border border-red-100 rounded-xl flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" aria-hidden="true" />
              <p className="text-red-700 text-sm">{formError}</p>
            </div>
          )}

          {/* Allows Enter to submit from any field. */}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        open={!!deleteTarget}
        onClose={() => !deleting && setDeleteTarget(null)}
        closeDisabled={deleting}
        size="sm"
        title="Delete agent?"
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="min-h-[44px] flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-slate-600 font-semibold hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              className="min-h-[44px] flex-1 px-4 py-2.5 bg-red-600 text-white rounded-xl font-semibold hover:bg-red-700 shadow-sm flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Delete
            </button>
          </div>
        }
      >
        <p className="text-slate-600 text-sm">
          Are you sure you want to delete <span className="font-bold text-slate-800">{deleteTarget?.name}</span>
          {deleteTarget?.email ? <> ({deleteTarget.email})</> : null}? They will be signed out immediately and won't be able to sign in
          again. This can't be undone.
        </p>
      </Modal>
    </div>
  );
}

const FieldError = ({ id, msg }: { id: string; msg: string }) => (
  <p id={id} className="text-red-600 text-xs mt-1 ml-1 flex items-center gap-1">
    <AlertCircle className="w-3 h-3" aria-hidden="true" /> {msg}
  </p>
);
