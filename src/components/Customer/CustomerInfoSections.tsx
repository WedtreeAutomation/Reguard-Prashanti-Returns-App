/**
 * Static landing sections of the return portal (shown on the first step):
 * proof strip, how it works, customer care, FAQs.
 */
import React from 'react';
import { Link } from 'react-router-dom';

const STORE = 'https://www.prashantisarees.com';

const SUPPORT_CARDS: { href: string; internal?: boolean; icon: React.ReactNode; title: string; desc: string }[] = [
  {
    href: `${STORE}/pages/faq`,
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v9a2.5 2.5 0 0 1-2.5 2.5H11l-5 4v-4h-.5A2.5 2.5 0 0 1 3 14.5v-9z" /></svg>,
    title: 'FAQs',
    desc: "Read Prashanti's answers about delivery, returns, and support.",
  },
  {
    href: '/ReturnStatusPage',
    internal: true,
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg>,
    title: 'Track return',
    desc: 'Check the status of a return or exchange request you have raised.',
  },
  {
    href: `${STORE}/en-us/pages/return-policy`,
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 2.9 7.8 7 10 4.1-2.2 7-5.5 7-10V6l-7-3Z" /><path d="M9.5 12.2 11.2 14l3.5-4" /></svg>,
    title: 'Return policy',
    desc: 'Check eligibility, conditions, timelines, and exclusions.',
  },
  {
    href: `${STORE}/en-us/pages/return-policy`,
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3v18M16 7.5c0-1.4-1.7-2.5-4-2.5s-4 1.1-4 2.5 1.7 2.5 4 2.5 4 1.1 4 2.5-1.7 2.5-4 2.5-4 1.1-4 2.5 1.7 2.5 4 2.5 4-1.1 4-2.5" /></svg>,
    title: 'Refund policy',
    desc: 'Refunds go to the original payment mode in 7–10 working days.',
  },
];

const FAQS = [
  { q: 'When will my order be delivered?', a: 'Prashanti ships worldwide. Orders are packaged carefully and delivery takes between 2–4 business days. You will receive an email after ordering with more information about delivery.' },
  { q: 'Can I return my product?', a: 'For domestic orders, a return request can be raised within 3 days from the date of delivery. Products must be in their original, unaltered and unused condition, with the price tag and silk mark tag where applicable. Blouse Bits are non-returnable and non-exchangeable.' },
  { q: 'What if my item is damaged or incorrect?', a: 'Damaged or defective items and incorrect deliveries may be eligible for a refund or gift card. When raising the request, photographs of the product, price tag, and packing cover are required.' },
  { q: 'When will I receive my refund?', a: 'Approved refunds are credited to the same payment mode used for the order. The refund may take 7–10 working days from the date of initiation, after the item is received and approved by the quality-assurance team.' },
  { q: 'Are customised orders eligible for return?', a: 'Return or cancellation is not accepted for orders with custom tailoring, including fall and edging services. Please review the full return policy before placing a customised order.' },
];

export const CustomerInfoSections = () => (
  <>
    {/* PROOF STRIP */}
    <section className="rg-proof-strip" aria-label="Why return with Re-guard">
      <div className="rg-proof-row">
        <div className="rg-proof">
          <span className="rg-proof-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h13v11H3zM16 11h3l2 2v5h-5z" /><circle cx="7" cy="19" r="2" /><circle cx="18" cy="19" r="2" /></svg></span>
          <span><strong>3 Days Return</strong><span>For eligible domestic orders</span></span>
        </div>
        <div className="rg-proof">
          <span className="rg-proof-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3 5 6v5c0 4.5 2.9 7.8 7 10 4.1-2.2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg></span>
          <span><strong>Quality reviewed</strong><span>Items checked before refund</span></span>
        </div>
        <div className="rg-proof">
          <span className="rg-proof-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 5v5h-5" /></svg></span>
          <span><strong>Support available</strong><span>Call, email or WhatsApp</span></span>
        </div>
      </div>
    </section>

    {/* HOW IT WORKS */}
    <section className="rg-section" id="how-it-works" aria-labelledby="rg-how-title">
      <div className="rg-section-wrap">
        <div className="rg-section-heading">
          <div className="rg-eyebrow" style={{ justifyContent: 'center' }}><span className="rg-eyebrow-dot" /> Your return, your way</div>
          <h2 id="rg-how-title">Three easy steps to a fresh start.</h2>
          <p>No confusing forms or long email chains. Tell us what you need and we'll take it from there.</p>
        </div>
        <div className="rg-how-grid">
          <article className="rg-how-card">
            <div className="rg-how-number" aria-hidden="true">01</div>
            <h3>Find your order</h3>
            <p>Enter your order ID and the email or phone number used at checkout.</p>
          </article>
          <article className="rg-how-card">
            <div className="rg-how-number" aria-hidden="true">02</div>
            <h3>Choose what works</h3>
            <p>Select your item, tell us why you're returning it, and pick a resolution.</p>
          </article>
          <article className="rg-how-card">
            <div className="rg-how-number" aria-hidden="true">03</div>
            <h3>Send it back</h3>
            <p>Get clear next steps for your pickup or drop-off, then track everything here.</p>
          </article>
        </div>
      </div>
    </section>

    {/* SUPPORT */}
    <section className="rg-section rg-section-soft" id="help" aria-labelledby="rg-help-title">
      <div className="rg-support-grid">
        <div>
          <div className="rg-eyebrow"><span className="rg-eyebrow-dot" /> Prashanti customer care</div>
          <h2 id="rg-help-title" className="rg-support-title">Questions? We're here to help.</h2>
          <p className="rg-support-copy">
            Need help with a return, refund, or order? Reach the Prashanti team by phone, email, or WhatsApp.
          </p>
          <div className="rg-support-contacts">
            <a href="tel:+919962505459">+91 99625 05459</a>
            <a href="mailto:support@prashantisarees.in">support@prashantisarees.in</a>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link className="rg-btn-solid" to="/ReturnStatusPage">Track Return</Link>
            <a className="rg-btn-ghost" href={`${STORE}/pages/contact-us`} target="_blank" rel="noopener noreferrer">Contact support ↗</a>
            <a className="rg-btn-ghost" href="https://wa.me/919962505459" target="_blank" rel="noopener noreferrer">WhatsApp ↗</a>
          </div>
        </div>
        <div className="rg-support-cards">
          {SUPPORT_CARDS.map(({ href, internal, icon, title, desc }) => {
            const body = (
              <>
                <div style={{ color: 'var(--raspberry)', marginBottom: 14 }}>{icon}</div>
                <h3 style={{ margin: '0 0 5px', color: 'var(--plum-deep)', fontSize: 13 }}>{title}</h3>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 11, lineHeight: 1.5 }}>{desc}</p>
              </>
            );
            return internal ? (
              <Link key={title} to={href} className="rg-support-card-link">{body}</Link>
            ) : (
              <a key={title} href={href} target="_blank" rel="noopener noreferrer" className="rg-support-card-link">
                {body}<span className="rg-sr-only"> (opens in a new tab)</span>
              </a>
            );
          })}
        </div>
      </div>
    </section>

    {/* FAQ */}
    <section className="rg-section" id="faq" aria-labelledby="rg-faq-title">
      <div className="rg-section-wrap">
        <div className="rg-section-heading">
          <div className="rg-eyebrow" style={{ justifyContent: 'center' }}><span className="rg-eyebrow-dot" /> Good to know</div>
          <h2 id="rg-faq-title">Frequently asked questions</h2>
          <p>Clear answers based on Prashanti Sarees' published customer-care information.</p>
        </div>
        <div className="rg-faq-list">
          {FAQS.map(({ q, a }, i) => (
            <details key={q} className="rg-faq" open={i === 0}>
              <summary>
                {q}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  </>
);
