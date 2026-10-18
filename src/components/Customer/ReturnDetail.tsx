/**
 * Detail view of one public return/exchange request on the status page.
 * Shows only what the server's PublicReturn exposes (no address/phone/email).
 */
import {
  CheckCircle2, CreditCard, ExternalLink, Gift, History, Mail, MapPin, MessageCircle, Package, PackageOpen,
  PackageX, Phone, ShoppingBag, Truck, User, Wallet, XCircle,
} from 'lucide-react';
import type { PublicReturn } from '../../Interfaces/publicApi';
import { formatDate, parsePrice } from './customerUtils';
import {
  TrackingStep, courierTrackingUrl, exchangeOutcomeLabel, formatINR, getContactMessage, getStatusPresentation,
  getTrackingModel, isExchangeRecord, lower, refundAmountOf, refundMethodLabel, requestTypeLabel, requestedMethodLabel,
} from './statusModel';

const SUPPORT_PHONE = '9962505459';

export const TrackingTimeline = ({ steps }: { steps: TrackingStep[] }) => (
  <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Request progress">
    {steps.map((step, idx) => {
      const isLast = idx === steps.length - 1;
      const StepIcon = step.icon;
      const stateText = step.state === 'complete' ? 'completed' : step.state === 'current' ? 'in progress' : 'not started';
      return (
        <li key={step.key} className="rg-timeline-row" aria-current={step.state === 'current' ? 'step' : undefined}>
          <div className="rg-timeline-left" aria-hidden="true">
            <div className={`rg-timeline-dot ${step.state}`}>
              {step.state === 'complete' ? <CheckCircle2 size={18} /> : <StepIcon size={18} />}
              {step.state === 'current' && <span className="rg-timeline-ping" />}
            </div>
            {!isLast && <div className={`rg-timeline-line${step.state === 'complete' ? ' complete' : ''}`} />}
          </div>
          <div className={`rg-timeline-body${isLast ? '' : ' spaced'}`}>
            <div className="rg-timeline-header">
              <span className={`rg-timeline-title${step.state === 'upcoming' ? ' upcoming' : ''}`}>{step.title}</span>
              <span className="rg-sr-only">({stateText})</span>
              {step.state === 'current' && <span className="rg-timeline-badge" aria-hidden="true">In Progress</span>}
            </div>
            <p className={`rg-timeline-desc${step.state === 'upcoming' ? ' upcoming' : ''}`}>{step.description}</p>
            {step.meta && (
              <div className="rg-timeline-meta">
                <Truck size={11} aria-hidden="true" /> {step.meta}
              </div>
            )}
          </div>
        </li>
      );
    })}
  </ol>
);

export const ReturnDetail = ({ data }: { data: PublicReturn }) => {
  const model = getTrackingModel(data);
  const pres = getStatusPresentation(data);
  const Icon = pres.icon;
  const exchange = isExchangeRecord(data);
  const outcome = lower(data.financialOutcome);
  const items = Array.isArray(data.items) ? data.items : [];
  const activeItems = items.filter((i) => !i.rejected);
  const total = activeItems.reduce((s, i) => s + parsePrice(i.price) * (Number(i.quantityReturned) || 1), 0);
  const refundAmt = refundAmountOf(data);
  const trackUrl = courierTrackingUrl(data);
  const requested = requestedMethodLabel(data.requestedMethod);
  const hideRequestedMethod = outcome === 'even' || outcome === 'extra' || !requested;
  const refundStatus = data.refundStatus && lower(data.refundStatus) !== 'n/a' ? data.refundStatus : '';
  const headerClass = `rsp-detail-header-${pres.gradient}`;
  const timeline = (Array.isArray(data.timeline) ? data.timeline : []).filter((t) => t?.title);
  const showRequestId = data.returnId && data.returnId !== data.orderId;

  return (
    <article className="rsp-panel rsp-detail" aria-labelledby="rsp-detail-ran">
      <div className={`rsp-detail-header ${headerClass}`}>
        <div className="rsp-detail-header-inner">
          <div style={{ minWidth: 0 }}>
            <p className="rsp-detail-ran-label">{exchange ? 'Request' : 'Return'} Authorization Number</p>
            <p className="rsp-detail-ran" id="rsp-detail-ran">{data.RAN || '—'}</p>
            <p className="rsp-detail-order">
              Order: {data.orderId}{showRequestId ? ` · Request ${data.returnId}` : ''}
              {data.createdAt ? ` · Submitted ${formatDate(data.createdAt)}` : ''}
            </p>
          </div>
          <span className={`rsp-status-badge ${pres.bg} ${pres.color} ${pres.border}`} style={{ alignSelf: 'flex-start' }}>
            {Icon && <Icon size={13} aria-hidden="true" />} <span className="rg-sr-only">Status: </span>{pres.label}
          </span>
        </div>
      </div>

      {/* TRACKING */}
      <section style={{ background: 'var(--soft)', borderBottom: '1px solid var(--line)' }} aria-label="Tracking">
        <div className="rsp-section-body">
          <div>
            <span className="rsp-type-pill"><Package size={10} aria-hidden="true" /> {requestTypeLabel(data)}</span>
            {data.awb && (
              <span className="rsp-awb-pill">
                <Truck size={10} aria-hidden="true" /> {data.awb}{data.courierPartner ? ` · ${data.courierPartner}` : ''}
              </span>
            )}
          </div>

          {model.terminal ? (
            <div className={`rsp-terminal-box ${model.terminal}`} role="status">
              <div className={`rsp-terminal-icon ${model.terminal === 'rejected' ? 'red' : 'slate'}`} aria-hidden="true">
                {model.terminal === 'rejected' ? <PackageX size={20} /> : <XCircle size={20} />}
              </div>
              <div>
                <p className={`rsp-terminal-title ${model.terminal === 'rejected' ? 'rg-status-red' : ''}`}>{model.title}</p>
                <p className="rsp-terminal-msg">{model.message}</p>
              </div>
            </div>
          ) : (
            <div className="rsp-tracking-box">
              <TrackingTimeline steps={model.steps} />
              {trackUrl && (
                <a className="rsp-track-link" href={trackUrl} target="_blank" rel="noopener noreferrer">
                  <Truck size={13} aria-hidden="true" /> Track shipment{data.courierPartner ? ` on ${data.courierPartner}` : ' on Blue Dart'}
                  <ExternalLink size={12} aria-hidden="true" /><span className="rg-sr-only"> (opens in a new tab)</span>
                </a>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ITEMS */}
      <div className="rsp-section-head">
        <h3><ShoppingBag size={16} style={{ color: 'var(--raspberry)' }} aria-hidden="true" /> Items in this request</h3>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{items.length} item(s)</span>
      </div>
      <div className="rsp-section-body" style={{ paddingTop: 8 }}>
        {items.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>No items found for this request.</p>}
        {items.map((item, idx) => {
          const qty = Number(item.quantityReturned) || 1;
          const unit = parsePrice(item.price);
          const action = lower(item.actionType) === 'exchange' ? 'Exchange' : 'Return';
          return (
            <div key={`${item.lineItemId}-${idx}`} className={`rsp-item${item.rejected ? ' rejected' : ''}`}>
              <div className="rsp-item-img">
                {item.productImage
                  ? <img src={item.productImage} alt={item.title} loading="lazy" />
                  : <PackageOpen size={22} style={{ color: '#c4b8c4' }} aria-hidden="true" />}
              </div>
              <div className="rsp-item-info">
                <div>
                  <p className="rsp-item-title">{item.title}</p>
                  <div className="rsp-item-tags">
                    <span className="rsp-item-tag action">{action}</span>
                    {item.sku && <span className="rsp-item-tag sku">SKU: {item.sku}</span>}
                    {item.reason && <span className="rsp-item-tag reason">Reason: {item.reason}</span>}
                    {item.rejected && <span className="rsp-item-tag rejected">Not approved</span>}
                  </div>
                  {item.rejected && item.rejectionReason && (
                    <p className="rsp-item-note" style={{ color: '#b91c1c' }}>Reason: {item.rejectionReason}</p>
                  )}
                </div>
                <div className="rsp-item-footer">
                  <span className="rsp-item-qty">Qty: {qty}</span>
                  <span className="rsp-item-price">{unit > 0 ? formatINR(unit * qty) : '—'}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="rsp-items-total">
        <span className="rsp-items-total-label">Estimated Total Value</span>
        <span className="rsp-items-total-val">{formatINR(total)}</span>
      </div>

      <div className="rsp-section-body">
        {/* REFUND / EXCHANGE OUTCOME */}
        <div className="rsp-info-grid" style={{ marginBottom: 16 }}>
          {!hideRequestedMethod && (
            <div className="rsp-info-cell">
              <p className="rsp-method-label">Requested refund method</p>
              <p className="rsp-method-val" style={{ fontSize: 14 }}>
                {lower(data.requestedMethod) === 'store_credit' && <Wallet size={15} aria-hidden="true" />}
                {lower(data.requestedMethod) === 'gift_card' && <Gift size={15} aria-hidden="true" />}
                {lower(data.requestedMethod) === 'refund' && <CreditCard size={15} aria-hidden="true" />}
                {requested}
              </p>
            </div>
          )}
          {refundStatus && (
            <div className="rsp-info-cell">
              <p className="rsp-method-label">Refund status</p>
              <p className="rsp-info-val">{refundStatus}</p>
            </div>
          )}
          {refundAmt > 0 && (
            <div className="rsp-info-cell">
              <p className="rsp-method-label">Refund issued</p>
              <p className="rsp-info-val">{formatINR(refundAmt)}</p>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)' }}>
                to your {refundMethodLabel(data.refundMethod || data.requestedMethod, data.giftCardLast4)}
              </p>
            </div>
          )}
          {data.giftCardLast4 && (
            <div className="rsp-info-cell">
              <p className="rsp-method-label">Gift card</p>
              <p className="rsp-info-val">•••• {data.giftCardLast4}</p>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)' }}>The full code was sent to your e-mail.</p>
            </div>
          )}
          {exchange && exchangeOutcomeLabel(outcome) && (
            <div className="rsp-info-cell">
              <p className="rsp-method-label">Exchange outcome</p>
              <p className="rsp-info-val">{exchangeOutcomeLabel(outcome)}</p>
              {outcome === 'extra' && data.outstandingBalance ? (
                <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)' }}>Balance: {formatINR(data.outstandingBalance)}</p>
              ) : null}
            </div>
          )}
        </div>

        {/* ACTIVITY */}
        {timeline.length > 0 && (
          <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}>
            <div className="rsp-section-head" style={{ borderTop: 0 }}>
              <h3><History size={15} style={{ color: 'var(--raspberry)' }} aria-hidden="true" /> Activity</h3>
            </div>
            <div style={{ padding: '6px 16px' }}>
              <ul className="rsp-activity">
                {timeline.map((t, i) => (
                  <li key={`${t.title}-${i}`}>
                    <span>{t.title}</span>
                    {t.at && <time dateTime={t.at}>{formatDate(t.at, true)}</time>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* CUSTOMER (name + city only) */}
        {(data.customer?.name || data.customer?.city) && (
          <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}>
            <div className="rsp-section-head" style={{ borderTop: 0 }}>
              <h3><User size={15} style={{ color: 'var(--raspberry)' }} aria-hidden="true" /> Customer</h3>
            </div>
            <div style={{ padding: 16 }}>
              <div className="rsp-cust-grid">
                {data.customer?.name && (
                  <div className="rsp-cust-item">
                    <div className="rsp-cust-icon indigo" aria-hidden="true"><User size={16} /></div>
                    <div><p className="rsp-cust-label">Name</p><p className="rsp-cust-val">{data.customer?.name}</p></div>
                  </div>
                )}
                {data.customer?.city && (
                  <div className="rsp-cust-item">
                    <div className="rsp-cust-icon amber" aria-hidden="true"><MapPin size={16} /></div>
                    <div><p className="rsp-cust-label">City</p><p className="rsp-cust-val">{data.customer?.city}</p></div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* SUPPORT */}
        <div className="rsp-support-box">
          <div className="rsp-support-icon" aria-hidden="true"><MessageCircle size={20} /></div>
          <div style={{ flex: 1 }}>
            <p className="rsp-support-title">Need Assistance?</p>
            <p className="rsp-support-msg">{getContactMessage(data, SUPPORT_PHONE)}</p>
            <div className="rsp-support-actions">
              <a href={`tel:+91${SUPPORT_PHONE}`} className="rsp-support-btn"><Phone size={13} aria-hidden="true" /> Call {SUPPORT_PHONE}</a>
              <a href="mailto:support@prashantisarees.in" className="rsp-support-btn"><Mail size={13} aria-hidden="true" /> Email Support</a>
              <a href={`https://wa.me/91${SUPPORT_PHONE}`} target="_blank" rel="noopener noreferrer" className="rsp-support-btn">
                <MessageCircle size={13} aria-hidden="true" /> WhatsApp
              </a>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
};
