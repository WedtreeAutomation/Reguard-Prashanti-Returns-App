import {
  Gift, CreditCard, Wallet, Receipt, ArrowRightLeft, ClipboardList, Package, HelpCircle, Users, RotateCcw,
  Eye, FileSpreadsheet, FileText, Loader2, AlertCircle, CheckCircle2,
} from 'lucide-react';
import type { ReportIconName, ReportTypeMeta } from '../../Interfaces/reportsApi';

export type CardAction = 'preview' | 'xlsx' | 'csv';

export interface CardState {
  busy?: CardAction;
  error?: string;
  notice?: string;
}

// lucide-react is typed `any` in the sandbox shim; keep the map loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ICONS: Record<ReportIconName, any> = {
  Gift, CreditCard, Wallet, Receipt, ArrowRightLeft, ClipboardList, Package, HelpCircle, Users, RotateCcw,
};

interface Props {
  meta: ReportTypeMeta;
  state: CardState;
  /** Disable all actions (e.g. while "Download all" is running). */
  disabled?: boolean;
  onAction: (meta: ReportTypeMeta, action: CardAction) => void;
}

const ACTIONS: Array<{ id: CardAction; label: string; verb: string; Icon: typeof Eye }> = [
  { id: 'preview', label: 'Preview', verb: 'Preview', Icon: Eye },
  { id: 'xlsx', label: 'Excel', verb: 'Download Excel for', Icon: FileSpreadsheet },
  { id: 'csv', label: 'CSV', verb: 'Download CSV for', Icon: FileText },
];

export const ReportCard = ({ meta, state, disabled = false, onAction }: Props) => {
  const Icon = ICONS[meta.icon] ?? FileText;
  const busy = state.busy;
  const statusId = `report-status-${meta.id}`;

  return (
    <article
      className="flex h-full min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
      aria-labelledby={`report-title-${meta.id}`}
      aria-busy={busy ? true : undefined}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-xl bg-indigo-50 p-2.5 text-indigo-700" aria-hidden="true">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 id={`report-title-${meta.id}`} className="text-sm font-bold leading-snug text-slate-900">{meta.title}</h4>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">{meta.description}</p>
        </div>
      </div>

      <div className="mt-auto pt-4">
        <div className="grid grid-cols-3 gap-2">
          {ACTIONS.map(({ id, label, verb, Icon: ActionIcon }) => {
            const isBusy = busy === id;
            const primary = id === 'xlsx';
            return (
              <button
                key={id}
                type="button"
                onClick={() => onAction(meta, id)}
                disabled={disabled || !!busy}
                aria-label={`${verb} ${meta.title}`}
                aria-describedby={statusId}
                className={`inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  primary
                    ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                    : 'border border-slate-200 bg-white text-slate-700 hover:border-indigo-300 hover:text-indigo-700'
                }`}
              >
                {isBusy
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <ActionIcon className="h-4 w-4" aria-hidden="true" />}
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        <div id={statusId} aria-live="polite" className="min-h-0">
          {busy && (
            <p className="mt-2 text-xs text-slate-500">
              {busy === 'preview' ? 'Loading preview…' : 'Preparing download…'}
            </p>
          )}
          {!busy && state.error && (
            <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-red-600" role="alert">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{state.error}</span>
            </p>
          )}
          {!busy && !state.error && state.notice && (
            <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{state.notice}</span>
            </p>
          )}
        </div>
      </div>
    </article>
  );
};

export default ReportCard;
