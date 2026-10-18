/**
 * Status page building blocks: the privacy-preserving lookup form
 * (order number + email/phone) and the balances panel (store credit /
 * gift cards of the verified order only).
 */
import React from 'react';
import { AlertCircle, ArrowRight, Gift, Loader2, Mail, RefreshCw, Search, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';
import type { BalancesResponse } from '../../Interfaces/publicApi';
import { formatDate } from './customerUtils';
import { formatINR } from './statusModel';

// ==========================================
// LOOKUP FORM
// ==========================================
export interface LookupFormProps {
  idPrefix: string;
  orderValue: string;
  contactValue: string;
  onOrderChange: (v: string) => void;
  onContactChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
  error: string;
  submitLabel: string;
  contactRef?: React.Ref<HTMLInputElement>;
}

export const LookupForm = ({
  idPrefix, orderValue, contactValue, onOrderChange, onContactChange, onSubmit, loading, error, submitLabel, contactRef,
}: LookupFormProps) => {
  const errorId = `${idPrefix}-error`;
  const privacyId = `${idPrefix}-privacy`;
  return (
    <form onSubmit={onSubmit} className="rg-search-form" noValidate aria-describedby={privacyId}>
      <div>
        <label className="rsp-field-label" htmlFor={`${idPrefix}-order`}>Order number</label>
        <div className="rg-input-wrap">
          <Search size={16} aria-hidden="true" />
          <input
            id={`${idPrefix}-order`}
            type="text"
            value={orderValue}
            onChange={(e) => onOrderChange(e.target.value)}
            placeholder="e.g. P123456"
            className="rg-input"
            disabled={loading}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            aria-invalid={!!error && !orderValue.trim()}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
      </div>
      <div>
        <label className="rsp-field-label" htmlFor={`${idPrefix}-contact`}>Email or phone used at checkout</label>
        <div className="rg-input-wrap">
          <Mail size={16} aria-hidden="true" />
          <input
            id={`${idPrefix}-contact`}
            ref={contactRef}
            type="text"
            value={contactValue}
            onChange={(e) => onContactChange(e.target.value)}
            placeholder="you@example.com or 98xxxxxx10"
            className="rg-input"
            disabled={loading}
            autoComplete="email"
            spellCheck={false}
            required
            aria-describedby={error ? errorId : undefined}
          />
        </div>
      </div>
      <p className="rsp-privacy-note" id={privacyId}>
        <ShieldCheck size={14} aria-hidden="true" />
        <span>
          <strong>For your privacy</strong> we ask for both your order number and the email or phone number used at
          checkout, so only you can see your request details and balances.
        </span>
      </p>
      {error && (
        <div className="rg-error-box" role="alert" id={errorId}>
          <AlertCircle size={14} aria-hidden="true" style={{ flexShrink: 0 }} /> <span>{error}</span>
        </div>
      )}
      <button type="submit" disabled={loading} className="rg-btn-solid" style={{ background: 'linear-gradient(145deg, var(--plum-bright), var(--plum-deep))' }}>
        {loading
          ? <><Loader2 size={15} className="rg-spin" aria-hidden="true" /> Searching…</>
          : <>{submitLabel} <ArrowRight size={15} aria-hidden="true" /></>}
      </button>
    </form>
  );
};

// ==========================================
// BALANCES
// ==========================================
export interface BalancesPanelProps {
  kind: 'giftcards' | 'storecredit';
  orderName: string;
  balances: BalancesResponse | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
}

export const BalancesPanel = ({ kind, orderName, balances, loading, error, onRetry }: BalancesPanelProps) => {
  if (loading) {
    return <div className="rsp-loading" role="status"><Loader2 size={16} className="rg-spin" aria-hidden="true" /> Checking balances…</div>;
  }
  if (error) {
    return (
      <div className="rg-results">
        <div className="rg-error-box" role="alert"><AlertCircle size={14} aria-hidden="true" style={{ flexShrink: 0 }} /> <span>{error}</span></div>
        <button type="button" className="rsp-btn-ghost" onClick={onRetry} style={{ alignSelf: 'center' }}>
          <RefreshCw size={14} aria-hidden="true" /> Try again
        </button>
      </div>
    );
  }
  if (!balances) return null;

  if (kind === 'storecredit') {
    const sc = balances.storeCredit;
    const amount = Number(sc?.amount) || 0;
    return (
      <div className="rg-results" aria-live="polite">
        {sc && amount > 0 ? (
          <div className="rsp-balance-card">
            <div>
              <p className="rsp-balance-label">Store credit available</p>
              <p className="rsp-balance-amt">{formatINR(amount)}{sc.currency && sc.currency !== 'INR' ? ` ${sc.currency}` : ''}</p>
            </div>
            <div className="rg-balance-icon" aria-hidden="true"><TrendingUp size={20} /></div>
          </div>
        ) : (
          <div className="rg-empty-state">
            <Wallet size={40} style={{ color: '#d1c7d1', marginBottom: 8 }} aria-hidden="true" />
            <p>No store credit available for the customer of order {orderName}.</p>
          </div>
        )}
        <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
          Store credit is applied automatically at checkout when you sign in to your Prashanti account.
        </p>
      </div>
    );
  }

  const cards = balances.giftCards || [];
  const total = cards.reduce((s, gc) => s + (Number(gc.balance) || 0), 0);
  return (
    <div className="rg-results" aria-live="polite">
      {total > 0 && (
        <div className="rsp-balance-card gold">
          <div>
            <p className="rsp-balance-label">Total gift card balance</p>
            <p className="rsp-balance-amt">{formatINR(total)}</p>
          </div>
          <div className="rg-balance-icon" aria-hidden="true"><Gift size={20} /></div>
        </div>
      )}
      {cards.length > 0 ? (
        <div>
          <div className="rg-results-header"><Gift size={14} aria-hidden="true" /> Gift cards ({cards.length})</div>
          {cards.map((gc, i) => (
            <div key={`${gc.last4}-${i}`} className="rg-result-item">
              <div>
                <p className="rg-result-label">Gift card</p>
                <p className="rg-result-mono" style={{ color: 'var(--ink)', fontSize: 13 }}>•••• {gc.last4 || '----'}</p>
                {gc.expiresOn && <p className="rg-result-label" style={{ marginTop: 6 }}>Expires {formatDate(gc.expiresOn)}</p>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <p className="rg-result-label">Balance</p>
                <p style={{ fontSize: 18, fontWeight: 800, color: 'var(--plum)', margin: 0 }}>{formatINR(Number(gc.balance) || 0)}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rg-empty-state">
          <Gift size={40} style={{ color: '#d1c7d1', marginBottom: 8 }} aria-hidden="true" />
          <p>No gift cards found for the customer of order {orderName}.</p>
        </div>
      )}
    </div>
  );
};
