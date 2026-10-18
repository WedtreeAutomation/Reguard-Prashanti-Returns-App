/**
 * Public tracking page.
 *
 * Lookup = order number + email/phone (POST /public/returns/lookup), which
 * issues an order-scoped customer token. With a token for the requested order
 * already in this tab's session the page loads via GET /public/returns.
 * Balances come from GET /public/balances for the verified order only.
 * No direct Firestore access.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Gift as GiftIcon, Info, Menu, PackageOpen, ShoppingBag, User, Wallet, X,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { getApiErrorMessage, getApiErrorStatus } from '../../Interfaces/http';
import {
  BalancesResponse, PublicReturn, clearCustomerSession, getBalances, getCustomerSessionOrder, getMyReturns,
  lookupReturns, normalizeOrderName, validateVerificationInput,
} from '../../Interfaces/publicApi';
import { STATUS_PAGE_CSS } from '../Customer/statusPageStyles';
import { formatDate } from '../Customer/customerUtils';
import { getStatusPresentation, isExchangeRecord, requestTypeLabel, sortReturns } from '../Customer/statusModel';
import { ReturnDetail } from '../Customer/ReturnDetail';
import { BalancesPanel, LookupForm } from '../Customer/StatusLookup';

type Tab = 'returns' | 'giftcards' | 'storecredit';
type View = 'search' | 'list' | 'detail';

const TABS: { id: Tab; label: string; icon: any }[] = [
  { id: 'returns', label: 'Return Tracking', icon: PackageOpen },
  { id: 'giftcards', label: 'Gift Cards', icon: GiftIcon },
  { id: 'storecredit', label: 'Store Credit', icon: Wallet },
];

const lookupErrorMessage = (err: unknown): string => {
  const status = getApiErrorStatus(err);
  if (status === 403) return "The email or phone number doesn't match this order. Please use the details from checkout.";
  if (status === 404) return 'We could not find this order. Please check the order number (e.g. P123456).';
  return getApiErrorMessage(err, 'Failed to fetch return details. Please try again.');
};

export const ReturnStatusPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialOrderParam = useRef(normalizeOrderName(searchParams.get('order') || '')).current;

  const [activeTab, setActiveTab] = useState<Tab>('returns');
  const [view, setView] = useState<View>('search');
  const [orderInput, setOrderInput] = useState(initialOrderParam);
  const [contactInput, setContactInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  /** Order the customer has verified in this tab (customer token held). */
  const [sessionOrder, setSessionOrder] = useState<string | null>(null);
  const [returns, setReturns] = useState<PublicReturn[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [balances, setBalances] = useState<BalancesResponse | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState('');
  const [balancesNonce, setBalancesNonce] = useState(0);
  const balancesRequestedFor = useRef<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const showResults = useCallback((orderName: string, list: PublicReturn[]) => {
    const sorted = sortReturns(list);
    setSessionOrder(orderName);
    setReturns(sorted);
    setBalances(null);
    setBalancesError('');
    balancesRequestedFor.current = null;
    setError('');
    if (sorted.length === 0) {
      setNotice(`No return or exchange requests found for order ${orderName} yet.`);
      setSelectedId(null);
      setView('search');
    } else if (sorted.length === 1) {
      setNotice('');
      setSelectedId(sorted[0].returnId);
      setView('detail');
    } else {
      setNotice('');
      setSelectedId(null);
      setView('list');
    }
  }, []);

  // Auto-load when this tab already holds a token for the requested order
  // (e.g. right after submitting a request, or reloading the page).
  useEffect(() => {
    const held = getCustomerSessionOrder();
    if (!held || (initialOrderParam && normalizeOrderName(held) !== initialOrderParam)) return;
    const controller = new AbortController();
    setAutoLoading(true);
    getMyReturns(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setOrderInput(held);
        showResults(held, list);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const status = getApiErrorStatus(err);
        if (status === 401 || status === 403) {
          clearCustomerSession(); // expired token — ask again
        } else {
          setError(getApiErrorMessage(err, 'Failed to load your requests. Please search again.'));
        }
        setOrderInput(held);
      })
      .finally(() => { if (!controller.signal.aborted) setAutoLoading(false); });
    return () => controller.abort();
  }, [initialOrderParam, showResults]);

  // Balances for the verified order (fetched when a balance tab is opened).
  useEffect(() => {
    if (activeTab === 'returns' || !sessionOrder) return;
    if (balancesRequestedFor.current === sessionOrder) return;
    balancesRequestedFor.current = sessionOrder;
    const controller = new AbortController();
    let finished = false;
    setBalancesLoading(true);
    setBalancesError('');
    getBalances(controller.signal)
      .then((data) => { if (!controller.signal.aborted) setBalances(data); })
      .catch((err) => {
        if (controller.signal.aborted) return;
        balancesRequestedFor.current = null;
        const status = getApiErrorStatus(err);
        setBalancesError(status === 401 || status === 403
          ? 'Your verification has expired. Please search for your order again.'
          : getApiErrorMessage(err, 'Failed to fetch balances. Please try again.'));
      })
      .finally(() => {
        finished = true;
        if (!controller.signal.aborted) setBalancesLoading(false);
      });
    return () => {
      if (!finished) {
        controller.abort();
        balancesRequestedFor.current = null;
      }
    };
  }, [activeTab, sessionOrder, balancesNonce]);

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    const orderName = normalizeOrderName(orderInput);
    if (!orderName) { setError('Please enter your order number (e.g. P123456).'); return; }
    const contactError = validateVerificationInput(contactInput);
    if (contactError) { setError(contactError); return; }
    setLoading(true);
    setError('');
    setNotice('');
    setIsMobileMenuOpen(false);
    try {
      const res = await lookupReturns(orderName, contactInput);
      if (!mountedRef.current) return;
      showResults(orderName, res.returns);
      setContactInput('');
      try { setSearchParams({ order: orderName }, { replace: true }); } catch { /* non-critical */ }
    } catch (err) {
      if (mountedRef.current) setError(lookupErrorMessage(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [loading, orderInput, contactInput, showResults, setSearchParams]);

  const forgetOrder = useCallback(() => {
    clearCustomerSession();
    setSessionOrder(null);
    setReturns([]);
    setSelectedId(null);
    setBalances(null);
    setBalancesError('');
    balancesRequestedFor.current = null;
    setOrderInput('');
    setContactInput('');
    setNotice('');
    setError('');
    setView('search');
  }, []);

  const handleBack = useCallback(() => {
    if (view === 'detail' && returns.length > 1) { setSelectedId(null); setView('list'); }
    else { setSelectedId(null); setView('search'); }
  }, [view, returns.length]);

  const selected = selectedId ? returns.find((r) => r.returnId === selectedId) || null : null;
  const retryBalances = useCallback(() => {
    balancesRequestedFor.current = null;
    setBalancesNonce((n) => n + 1);
  }, []);

  const renderLookup = (prefix: string, label: string) => (
    <LookupForm
      idPrefix={prefix}
      orderValue={orderInput}
      contactValue={contactInput}
      onOrderChange={setOrderInput}
      onContactChange={setContactInput}
      onSubmit={handleSearch}
      loading={loading}
      error={error}
      submitLabel={label}
    />
  );

  return (
    <>
      <style>{STATUS_PAGE_CSS}</style>

      <div className="rsp-root">
        <div className="rsp-announcement">
          <strong>Free shipping above ₹1,999/–</strong> · 3 Days Return · Support for every Prashanti order
        </div>

        {/* DESKTOP HEADER */}
        <header className="rsp-header">
          <div className="rsp-navbar">
            <Link to="/ReturnStatusPage" className="rsp-brand">
              <img src="/reguard-logo.png" alt="Re-guard by Prashanti" style={{ height: 64, objectFit: 'contain' }} />
            </Link>
            <div className="rsp-nav-actions">
              <Link to="/CustomerPage" className="rsp-btn-ghost">
                <ShoppingBag size={14} aria-hidden="true" /> Start a Return
              </Link>
              <a href="https://www.prashantisarees.com/account" target="_blank" rel="noopener noreferrer" className="rsp-btn-solid">
                My account
              </a>
            </div>
          </div>
        </header>

        {/* MOBILE HEADER */}
        <div className="rsp-mobile-header">
          <div className="rsp-mobile-top">
            <Link to="/ReturnStatusPage" className="rsp-mobile-brand">
              <img src="/reguard-logo-bg.png" alt="Re-guard by Prashanti" style={{ height: 36, objectFit: 'contain' }} />
            </Link>
            <div className="rsp-mobile-actions">
              <Link to="/CustomerPage" className="rsp-mobile-btn" aria-label="Start a return">
                <ShoppingBag size={16} aria-hidden="true" />
              </Link>
              <button
                type="button"
                className="rsp-mobile-btn"
                onClick={() => setIsMobileMenuOpen((o) => !o)}
                aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={isMobileMenuOpen}
                aria-controls="rsp-mobile-menu"
              >
                {isMobileMenuOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
              </button>
            </div>
          </div>
          {isMobileMenuOpen && (
            <nav className="rsp-mobile-dropdown" id="rsp-mobile-menu" aria-label="Menu">
              <Link to="/CustomerPage" onClick={() => setIsMobileMenuOpen(false)}>
                <ShoppingBag size={15} aria-hidden="true" /> Start a Return
              </Link>
              <a href="https://www.prashantisarees.com/account" target="_blank" rel="noopener noreferrer" onClick={() => setIsMobileMenuOpen(false)}>
                <User size={15} aria-hidden="true" /> My Account
              </a>
            </nav>
          )}
        </div>

        {/* HERO */}
        <section className="rsp-hero">
          <div className="rsp-hero-inner">
            <div className="rsp-eyebrow"><span className="rsp-eyebrow-dot" /> Re-guard status centre</div>
            <h1>Track your <em>return</em> or check your balance.</h1>
            <p className="rsp-hero-copy">
              Enter your order number with the email or phone used at checkout to see the latest update on your return —
              or check your gift card and store credit balances.
            </p>
          </div>
        </section>

        <main className="rsp-main" id="main">
          {view !== 'search' && (
            <button type="button" className="rsp-back-btn" onClick={handleBack}>
              <ChevronLeft size={15} aria-hidden="true" /> {view === 'detail' && returns.length > 1 ? 'Back to all requests' : 'Back to search'}
            </button>
          )}

          {/* ===== SEARCH PANEL ===== */}
          {view === 'search' && (
            <>
              {sessionOrder && (
                <div className="rsp-session-bar">
                  <span>Verified order <strong>{sessionOrder}</strong></span>
                  <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {returns.length > 0 && (
                      <button type="button" className="rsp-link-btn" onClick={() => {
                        if (returns.length === 1) { setSelectedId(returns[0].returnId); setView('detail'); } else setView('list');
                      }}>
                        View requests
                      </button>
                    )}
                    <button type="button" className="rsp-link-btn" onClick={forgetOrder}>Use a different order</button>
                  </span>
                </div>
              )}

              <div className="rsp-panel">
                <div className="rsp-tab-nav" role="tablist" aria-label="Status centre">
                  {TABS.map(({ id, label, icon: TabIcon }) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      id={`rsp-tab-${id}`}
                      aria-selected={activeTab === id}
                      aria-controls={`rsp-panel-${id}`}
                      className={`rsp-tab-btn${activeTab === id ? ` active-${id}` : ''}`}
                      onClick={() => setActiveTab(id)}
                    >
                      <TabIcon size={15} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>

                {activeTab === 'returns' && (
                  <div className="rsp-track-body" role="tabpanel" id="rsp-panel-returns" aria-labelledby="rsp-tab-returns">
                    <div>
                      <div className="rsp-track-icon" aria-hidden="true">
                        <svg viewBox="0 0 28 28" fill="none" width="24" height="24">
                          <path d="M5 8.2h10.4a5.2 5.2 0 1 1 0 10.4H9.6" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
                          <path d="m9.1 4.8 4.6 3.4-4.6 3.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M22.8 15.7 17.2 23l-2.5-2.6" stroke="var(--gold)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <h2 className="rsp-track-title">Track Your Return</h2>
                      <p className="rsp-track-subtitle">Enter your order number and the email or phone used at checkout</p>
                    </div>

                    {autoLoading ? (
                      <div className="rsp-loading" role="status">Loading your requests…</div>
                    ) : (
                      <>
                        {notice && (
                          <div className="rsp-privacy-note" role="status">
                            <Info size={14} aria-hidden="true" /> <span>{notice}</span>
                          </div>
                        )}
                        {renderLookup('rsp-track', 'Track Return')}
                      </>
                    )}

                    <div className="rsp-quick-links">
                      <Link to="/CustomerPage" className="rsp-quick-link">
                        <span className="rsp-quick-icon" aria-hidden="true"><ShoppingBag size={14} /></span>
                        <span>Start a return<small>Submit a new request</small></span>
                      </Link>
                      <a href="https://www.prashantisarees.com/en-us/pages/return-policy" target="_blank" rel="noopener noreferrer" className="rsp-quick-link">
                        <span className="rsp-quick-icon" aria-hidden="true">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3 5 6v5c0 4.5 2.9 7.8 7 10 4.1-2.2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
                        </span>
                        <span>Return policy<small>Eligibility &amp; timelines</small></span>
                      </a>
                    </div>
                  </div>
                )}

                {activeTab !== 'returns' && (
                  <div className="rg-tab-body" role="tabpanel" id={`rsp-panel-${activeTab}`} aria-labelledby={`rsp-tab-${activeTab}`}>
                    <div className="rg-tab-header">
                      <div className="rg-tab-icon brand" aria-hidden="true">
                        {activeTab === 'giftcards' ? <GiftIcon size={22} /> : <Wallet size={22} />}
                      </div>
                      <h2 className="rg-tab-title">{activeTab === 'giftcards' ? 'Gift Card Balance' : 'Store Credit Balance'}</h2>
                      <p className="rg-tab-subtitle">
                        {sessionOrder
                          ? `Balances linked to the customer of order ${sessionOrder}`
                          : 'Verify your order to see the balances linked to it'}
                      </p>
                    </div>
                    {sessionOrder ? (
                      <BalancesPanel
                        kind={activeTab}
                        orderName={sessionOrder}
                        balances={balances}
                        loading={balancesLoading}
                        error={balancesError}
                        onRetry={retryBalances}
                      />
                    ) : (
                      renderLookup(`rsp-${activeTab}`, 'Check Balance')
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ===== SELECTION LIST ===== */}
          {view === 'list' && returns.length > 0 && (
            <div className="rsp-panel">
              <div className="rsp-selection">
                <h2>Requests for order {sessionOrder}</h2>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {returns.map((ret) => {
                    const pres = getStatusPresentation(ret);
                    const Icon = pres.icon;
                    return (
                      <li key={ret.returnId}>
                        <button
                          type="button"
                          className="rsp-selection-item"
                          onClick={() => { setSelectedId(ret.returnId); setView('detail'); }}
                          aria-label={`View request ${ret.RAN || ret.returnId}, ${requestTypeLabel(ret)}, status ${pres.label}`}
                        >
                          <div className="rsp-sel-left">
                            <div className={`rsp-sel-icon ${pres.bg}`} aria-hidden="true">
                              {Icon && <Icon size={20} className={pres.color} />}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <p className="rsp-sel-ran">RAN: {ret.RAN || '—'}</p>
                              <p className="rsp-sel-order">
                                Order: {ret.orderId}
                                {isExchangeRecord(ret) && <span className="rsp-sel-exchange"> · {requestTypeLabel(ret)}</span>}
                              </p>
                              {ret.createdAt && <p className="rsp-sel-meta">Submitted {formatDate(ret.createdAt)}</p>}
                            </div>
                          </div>
                          <div className="rsp-sel-right" aria-hidden="true">
                            <span className={`rsp-status-badge ${pres.bg} ${pres.color} ${pres.border}`}>
                              {Icon && <Icon size={12} />} {pres.label}
                            </span>
                            <ChevronRight size={16} style={{ color: 'var(--muted)' }} />
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}

          {/* ===== DETAIL VIEW ===== */}
          {view === 'detail' && selected && <ReturnDetail data={selected} />}
          {view === 'detail' && !selected && (
            <div className="rg-error-box" role="alert">This request is no longer available. Please search again.</div>
          )}
        </main>

        {/* FOOTER */}
        <footer className="rsp-footer">
          <div className="rsp-footer-inner">
            <div className="rsp-footer-top">
              <div>
                <Link to="/ReturnStatusPage" className="rsp-brand" style={{ marginBottom: 0 }}>
                  <img src="/reguard-logo.png" alt="Re-guard by Prashanti" style={{ height: 36, objectFit: 'contain' }} />
                </Link>
                <p className="rsp-footer-tagline">Traditional &amp; contemporary sarees for today's women — with thoughtful care from purchase to return.</p>
              </div>
              <nav className="rsp-footer-links" aria-label="Footer">
                <div>
                  <h4>Navigate</h4>
                  <Link to="/CustomerPage">Start a return</Link>
                  <a href="https://www.prashantisarees.com/account" target="_blank" rel="noopener noreferrer">My orders</a>
                  <a href="https://www.prashantisarees.com/pages/faq" target="_blank" rel="noopener noreferrer">FAQs</a>
                </div>
                <div>
                  <h4>Customer care</h4>
                  <a href="https://www.prashantisarees.com/account/login" target="_blank" rel="noopener noreferrer">Log in</a>
                  <a href="tel:+919962505459">+91 99625 05459</a>
                  <a href="mailto:support@prashantisarees.in">Email support</a>
                </div>
              </nav>
            </div>
            <div className="rsp-footer-bottom">
              <span>© 2026 Re-guard by Prashanti. All rights reserved.</span>
              <span>
                <a href="https://www.prashantisarees.com/en-us/pages/return-policy" target="_blank" rel="noopener noreferrer">Return policy</a>
                {' · '}
                <a href="https://www.prashantisarees.com/pages/faq" target="_blank" rel="noopener noreferrer">FAQs</a>
                {' · '}
                <a href="https://wa.me/919962505459" target="_blank" rel="noopener noreferrer">WhatsApp</a>
              </span>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
};

export default ReturnStatusPage;
