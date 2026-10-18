/* Styles for the public return/exchange wizard (CustomerPage). Colours come from theme.ts. */
import { CUSTOMER_THEME_CSS } from './theme';

export const CUSTOMER_PAGE_CSS = CUSTOMER_THEME_CSS + `

/* ---- BASE ---- */
.rg-root {
  min-height: 100vh;
  background: var(--soft);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
  color: var(--ink);
  display: flex;
  flex-direction: column;
}

/* ---- ANNOUNCEMENT ---- */
.rg-announcement {
  background: var(--announce-bg);
  color: var(--announce-ink);
  text-align: center;
  font-size: 12px;
  letter-spacing: .035em;
  padding: 9px 20px;
}
.rg-announcement strong { color: #fff; font-weight: 750; }

/* ---- HEADER ---- */
.rg-header {
  position: sticky;
  top: 0;
  z-index: 30;
  background: rgba(255,255,255,.96);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(16px);
}
.rg-navbar {
  max-width: 1160px;
  margin: 0 auto;
  padding: 0 24px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.rg-brand {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  text-decoration: none;
  min-width: max-content;
}
.rg-brand-mark {
  display: grid;
  place-items: center;
  width: 39px;
  height: 39px;
  border: 1px solid rgba(var(--gold-rgb),.6);
  border-radius: 12px;
  color: #fff;
  background: linear-gradient(145deg, var(--plum-bright), var(--plum-deep));
  box-shadow: 0 7px 17px rgba(var(--shadow-rgb),.2);
}
.rg-brand-text { display: flex; flex-direction: column; }
.rg-brand-name {
  color: var(--plum);
  font-size: 18px;
  line-height: 1;
  letter-spacing: -.055em;
  font-weight: 780;
}
.rg-brand-by {
  margin-top: 2px;
  color: var(--muted);
  font-size: 8px;
  letter-spacing: .2em;
  font-weight: 750;
  text-transform: uppercase;
}
.rg-nav-links {
  display: flex;
  align-items: center;
  gap: 24px;
}
.rg-nav-links a {
  color: #625965;
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
  transition: color .2s ease;
}
.rg-nav-links a:hover { color: var(--plum); }
.rg-nav-actions { display: flex; align-items: center; gap: 10px; }
.rg-btn-ghost {
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 10px 16px;
  background: transparent;
  color: var(--plum);
  font-size: 13px;
  font-weight: 750;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all .18s ease;
}
.rg-btn-ghost:hover { background: var(--soft); transform: translateY(-1px); }
.rg-btn-solid {
  border: 0;
  border-radius: 11px;
  padding: 11px 18px;
  background: var(--plum);
  color: #fff;
  font-size: 13px;
  font-weight: 750;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-shadow: 0 8px 18px rgba(var(--plum-rgb),.18);
  transition: all .18s ease;
}
.rg-btn-solid:hover { background: var(--plum-deep); transform: translateY(-1px); }
.rg-btn-solid:disabled, .rg-btn-ghost:disabled { opacity: .6; cursor: not-allowed; transform: none; }
.rg-btn-solid:active { transform: translateY(0); }
.rg-btn-gold {
  border: 0;
  border-radius: 11px;
  padding: 13px 20px;
  background: var(--gold);
  color: var(--plum-deep);
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-shadow: 0 8px 18px rgba(125,78,37,.18);
  transition: all .18s ease;
}
.rg-btn-gold:hover { background: var(--gold-light); transform: translateY(-1px); }
.rg-btn-gold:disabled { opacity: .6; cursor: not-allowed; transform: none; }
.rg-btn-wide { width: 100%; justify-content: center; }
.rg-icon-btn {
  width: 42px; height: 42px; padding: 0;
  display: grid; place-items: center;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: transparent;
  color: var(--plum);
  cursor: pointer;
  transition: all .18s ease;
}
.rg-icon-btn:hover { background: var(--soft); }
.rg-mobile-only { display: none; }

/* ---- HERO ---- */
.rg-hero {
  position: relative;
  overflow: hidden;
  padding: 80px 0 88px;
  background:
    radial-gradient(circle at 88% 10%, rgba(var(--gold-rgb),.16), transparent 21%),
    radial-gradient(circle at 12% 85%, rgba(var(--raspberry-rgb),.15), transparent 26%),
    linear-gradient(132deg, var(--plum-deep) 0%, var(--hero-mid) 55%, var(--hero-end) 100%);
}
.rg-hero::before {
  content: "R";
  position: absolute;
  top: 10%; right: 4%;
  color: rgba(255,255,255,.035);
  font-family: Georgia, serif;
  font-size: clamp(220px, 30vw, 420px);
  font-weight: 500;
  line-height: .8;
  pointer-events: none;
}
.rg-hero-grid {
  position: relative;
  z-index: 1;
  max-width: 1160px;
  margin: 0 auto;
  padding: 0 24px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: center;
  gap: 80px;
  width: 100%;
}
.rg-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--gold);
  font-size: 11px;
  letter-spacing: .13em;
  font-weight: 800;
  text-transform: uppercase;
  margin-bottom: 18px;
}
.rg-eyebrow-dot {
  width: 7px; height: 7px;
  border-radius: 99px;
  background: var(--gold);
  box-shadow: 0 0 0 5px rgba(var(--gold-rgb),.18);
  display: block;
}
.rg-hero h1 {
  margin: 0 0 18px;
  color: #fff;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(38px, 4.5vw, 62px);
  line-height: .97;
  letter-spacing: -.06em;
  font-weight: 500;
}
.rg-hero h1 em { color: var(--hero-accent); font-style: normal; }
.rg-hero-copy {
  max-width: 460px;
  margin: 0 0 30px;
  color: var(--hero-copy);
  font-size: 15px;
  line-height: 1.7;
}
.rg-confidence {
  display: flex;
  flex-wrap: wrap;
  gap: 15px;
  color: var(--hero-copy);
  font-size: 12px;
  font-weight: 650;
  margin-bottom: 32px;
}
.rg-confidence span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.rg-confidence svg { color: #b9e3cf; }

/* ---- RETURN CARD ---- */
.rg-return-card {
  position: relative;
  padding: 28px;
  border: 1px solid rgba(var(--gold-rgb),.7);
  border-radius: var(--radius);
  background: #fffdfa;
  box-shadow: 0 25px 75px rgba(var(--plum-deep-rgb),.28);
}
.rg-return-card::before {
  content: "";
  position: absolute;
  top: 0; left: 28px; right: 28px;
  height: 3px;
  border-radius: 0 0 5px 5px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}
.rg-card-kicker {
  color: var(--raspberry);
  font-size: 10px;
  letter-spacing: .16em;
  font-weight: 800;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.rg-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
}
.rg-card-title {
  margin: 0 0 5px;
  color: var(--plum-deep);
  font-family: Georgia, serif;
  font-size: 23px;
  font-weight: 500;
  letter-spacing: -.035em;
}
.rg-card-subtitle { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.rg-secure-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 9px;
  border-radius: 99px;
  color: #31775e;
  background: #f0f8f4;
  font-size: 10px;
  font-weight: 800;
  white-space: nowrap;
}

/* ---- STEP PROGRESS ---- */
.rg-steps {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  margin-bottom: 22px;
}
.rg-step {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rg-step-number {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px; height: 24px;
  border-radius: 99px;
  color: #fff;
  background: var(--step-idle);
  color: var(--step-idle-ink);
  font-size: 10px;
  font-weight: 800;
  transition: background .25s, color .25s;
}
.rg-step.active .rg-step-number { background: var(--raspberry); color: #fff; }
.rg-step.done .rg-step-number { background: var(--green); color: #fff; }
.rg-step-line {
  height: 3px;
  flex: 1;
  border-radius: 9px;
  background: var(--step-track);
  transition: background .25s;
}
.rg-step.done .rg-step-line { background: var(--green); }
.rg-step.active .rg-step-line { background: var(--raspberry); }

/* ---- FORM FIELDS ---- */
.rg-field-label {
  display: block;
  margin: 0 0 7px;
  color: #403841;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .03em;
}
.rg-input-wrap { position: relative; margin-bottom: 12px; }
.rg-input-wrap svg {
  position: absolute;
  left: 14px; top: 50%;
  color: #a89ca8;
  transform: translateY(-50%);
  pointer-events: none;
}
.rg-input {
  width: 100%;
  height: 48px;
  padding: 0 14px 0 41px;
  color: var(--ink);
  border: 1px solid #e7dfe7;
  border-radius: 9px;
  outline: none;
  background: #fff;
  font-size: 13px;
  font-family: inherit;
  transition: border .18s ease, box-shadow .18s ease;
}
.rg-input.no-icon { padding-left: 14px; }
.rg-input::placeholder { color: #aea5af; }
.rg-input:focus { border-color: var(--raspberry); box-shadow: 0 0 0 4px rgba(var(--focus-rgb),.09); }
.rg-input.error { border-color: #f87171; }
.rg-card-note {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  margin: 12px 1px 0;
  color: #928792;
  font-size: 10px;
  line-height: 1.5;
}
.rg-form-message {
  display: none;
  margin-top: 12px;
  padding: 11px 12px;
  border-radius: 10px;
  color: var(--green);
  background: #eef9f4;
  font-size: 12px;
  line-height: 1.45;
  font-weight: 650;
}
.rg-form-message.show { display: block; }

/* ---- QUICK LINKS ---- */
.rg-quick-links {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-top: 14px;
}
.rg-quick-link {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 58px;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 14px;
  color: #403841;
  background: #fff;
  font-size: 11px;
  font-weight: 750;
  text-decoration: none;
  transition: all .2s ease;
}
.rg-quick-link:hover { border-color: var(--plum-border); background: var(--soft); transform: translateY(-2px); }
.rg-quick-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 30px; height: 30px;
  border-radius: 9px;
  color: var(--raspberry);
  background: var(--pink);
}
.rg-quick-link small { display: block; margin-top: 2px; color: #978d97; font-size: 9px; font-weight: 550; }
.rg-quick-arrow { margin-left: auto; color: #b5aab3; }

/* ---- PROOF STRIP ---- */
.rg-proof-strip {
  background: #fff;
  border-bottom: 1px solid var(--line);
}
.rg-proof-row {
  max-width: 1160px;
  margin: 0 auto;
  padding: 22px 24px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}
.rg-proof {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 0 16px;
  border-right: 1px solid var(--line);
}
.rg-proof:last-child { border: 0; }
.rg-proof-icon {
  display: grid;
  place-items: center;
  width: 36px; height: 36px;
  border-radius: 11px;
  color: var(--raspberry);
  background: var(--pink);
  flex: none;
}
.rg-proof strong { display: block; color: #322834; font-size: 12px; }
.rg-proof span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; }

/* ---- HOW IT WORKS ---- */
.rg-section { padding: 80px 0; }
.rg-section-soft { background: var(--soft); }
.rg-section-heading { max-width: 580px; margin: 0 auto 40px; text-align: center; }
.rg-section-heading h2 {
  margin: 12px 0 10px;
  color: var(--plum-deep);
  font-family: Georgia, serif;
  font-size: clamp(28px, 3.2vw, 42px);
  line-height: 1.08;
  letter-spacing: -.05em;
  font-weight: 500;
}
.rg-section-heading p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.6; }
.rg-how-grid {
  max-width: 1160px;
  margin: 0 auto;
  padding: 0 24px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
}
.rg-how-card {
  position: relative;
  min-height: 200px;
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #fff;
}
.rg-how-card::after {
  content: "";
  position: absolute;
  top: 40px; right: -20px;
  width: 22px; height: 1px;
  background: var(--plum-line);
}
.rg-how-card:last-child::after { display: none; }
.rg-how-number {
  display: grid;
  place-items: center;
  width: 40px; height: 40px;
  margin-bottom: 22px;
  border-radius: 13px;
  color: #fff;
  background: var(--plum);
  font-size: 14px;
  font-weight: 800;
}
.rg-how-card h3 { margin: 0 0 7px; color: var(--plum-deep); font-size: 15px; }
.rg-how-card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.65; }

/* ---- PORTAL AREA (non-hero steps) ---- */
.rg-portal {
  max-width: 1160px;
  margin: 0 auto;
  padding: 48px 24px 72px;
  flex: 1;
}
.rg-portal-grid {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 32px;
  align-items: start;
}

/* LEFT PANEL */
.rg-left-panel {
  position: sticky;
  top: 88px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.rg-left-panel-top {
  padding: 24px;
  border-bottom: 1px solid var(--line);
  background: var(--plum-deep);
  color: #fff;
}
.rg-left-panel-top h2 {
  margin: 0 0 4px;
  font-family: Georgia, serif;
  font-size: 22px;
  font-weight: 500;
  letter-spacing: -.04em;
}
.rg-left-panel-top p { margin: 0; color: var(--on-dark); font-size: 12px; line-height: 1.5; }
.rg-left-panel-body { padding: 20px 24px; }

/* Order info block */
.rg-order-info {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 16px;
}
.rg-order-info-label { color: var(--muted); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 6px; }
.rg-order-num { font-size: 20px; font-weight: 800; color: var(--plum-deep); }
.rg-order-email { font-size: 12px; color: var(--muted); margin-top: 2px; }
.rg-order-date { font-size: 10px; color: var(--muted); margin-top: 6px; }

/* Back button */
.rg-back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  transition: color .18s;
}
.rg-back-btn:hover { color: var(--plum); }

/* Method summary on left panel */
.rg-method-summary {
  background: var(--pink);
  border: 1px solid rgba(var(--raspberry-rgb),.2);
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 16px;
}
.rg-method-summary-label { color: var(--raspberry); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 6px; }
.rg-method-summary-val { font-size: 14px; font-weight: 700; color: var(--plum-deep); }

/* RIGHT PANEL */
.rg-right-panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.rg-right-header {
  padding: 20px 28px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.rg-right-header h2 {
  margin: 0;
  font-family: Georgia, serif;
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -.04em;
  color: var(--plum-deep);
}
.rg-right-body { padding: 24px 28px; }

/* ---- ITEM CARDS ---- */
.rg-item-card {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #fff;
  overflow: hidden;
  margin-bottom: 14px;
  transition: border .2s, box-shadow .2s;
}
.rg-item-card.selected {
  border-color: var(--plum);
  box-shadow: 0 0 0 3px rgba(var(--plum-rgb),.1);
}
.rg-item-card.disabled {
  opacity: .85;
  background: var(--soft);
}
.rg-item-header {
  padding: 16px;
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.rg-checkbox {
  position: relative;
  padding: 0;
  font: inherit;
  width: 22px; height: 22px;
  border: 2px solid #d1c7d1;
  border-radius: 7px;
  flex: none;
  margin-top: 2px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: all .18s;
  background: #fff;
  color: #fff;
}
.rg-checkbox.checked { background: var(--plum); border-color: var(--plum); }
.rg-checkbox.disabled { background: #f0ecf0; border-color: #d1c7d1; cursor: not-allowed; }
.rg-item-img {
  width: 72px; height: 88px;
  border-radius: 10px;
  border: 1px solid var(--line);
  overflow: hidden;
  background: var(--soft);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.rg-item-img img { width: 100%; height: 100%; object-fit: cover; }
.rg-placeholder-icon { color: #c4b8c4; }
.rg-item-info { flex: 1; min-width: 0; }
.rg-item-title { font-size: 14px; font-weight: 700; color: var(--ink); margin: 0 0 3px; line-height: 1.3; word-break: break-word; }
.rg-item-title.muted { color: var(--muted); }
.rg-item-variant { font-size: 11px; color: var(--muted); margin: 0; }
.rg-item-props { display: flex; flex-wrap: wrap; gap: 5px; margin: 6px 0; }
.rg-prop-tag { font-size: 10px; background: var(--soft); color: #625965; padding: 2px 7px; border-radius: 5px; border: 1px solid var(--line); }
.rg-item-price { font-size: 14px; font-weight: 700; color: var(--plum-deep); margin: 6px 0 0; }
.rg-item-badges { display: flex; flex-direction: column; gap: 5px; align-items: flex-end; }

/* Badges */
.rg-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 750;
  padding: 4px 9px;
  border-radius: 99px;
  white-space: nowrap;
}
.rg-badge.amber { background: #fff7e6; color: #9a5d00; border: 1px solid #f5d9a8; }
.rg-badge.slate { background: #f2eff2; color: #625965; border: 1px solid var(--line); }
.rg-badge.red { background: #fff0f0; color: #b91c1c; border: 1px solid #fecaca; }
.rg-badge.green { background: #eef9f4; color: var(--green); border: 1px solid #b6e8d4; }

/* Alerts */
.rg-item-alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 16px;
  font-size: 12px;
  border-top: 1px solid var(--line);
}
.rg-item-alert.orange { background: #fff7ed; color: #9a5d00; }
.rg-item-alert.amber { background: #fffbeb; color: #8a5100; }
.rg-item-alert.slate { background: var(--soft); color: var(--muted); }

/* ---- ITEM FORM ---- */
.rg-item-form {
  padding: 18px 16px 20px;
  background: var(--soft);
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.rg-form-section { display: flex; flex-direction: column; gap: 10px; }
.rg-radio-group { display: flex; gap: 12px; flex-wrap: wrap; }
.rg-radio-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
  padding: 10px 14px;
  border: 2px solid var(--line);
  border-radius: 10px;
  transition: all .18s;
  flex: 1;
  min-width: 130px;
  background: #fff;
}
.rg-radio-label.active { border-color: var(--plum); background: rgba(var(--plum-rgb),.06); color: var(--plum); }
.rg-radio-label input[type="radio"] { accent-color: var(--plum); width: 16px; height: 16px; }
.rg-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.rg-select {
  width: 100%;
  height: 42px;
  padding: 0 12px;
  border: 1px solid #e7dfe7;
  border-radius: 9px;
  outline: none;
  background: #fff;
  font-size: 13px;
  font-family: inherit;
  color: var(--ink);
  transition: border .18s ease;
}
.rg-select:focus { border-color: var(--raspberry); box-shadow: 0 0 0 4px rgba(var(--focus-rgb),.09); }

/* Upload */
.rg-upload-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
.rg-upload-hint { font-size: 11px; color: var(--muted); margin: 0 0 12px; }
.rg-upload-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.rg-upload-slot {
  aspect-ratio: 1;
  border-radius: 10px;
  border: 1.5px dashed #d5c9d5;
  overflow: hidden;
  position: relative;
  background: #fff;
}
.rg-upload-slot.required { border-color: var(--raspberry); }
.rg-upload-slot.has-file { border-style: solid; border-color: var(--line); }
.rg-upload-preview { width: 100%; height: 100%; object-fit: cover; }
.rg-upload-remove {
  position: absolute;
  top: 3px; right: 3px;
  width: 26px; height: 26px;
  border-radius: 50%;
  background: rgba(0,0,0,.65);
  color: #fff;
  border: none;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.rg-upload-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  cursor: pointer;
  gap: 4px;
  font-size: 9px;
  color: var(--muted);
  font-weight: 700;
}

/* ---- CONTINUE BAR ---- */
.rg-continue-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-top: 1px solid var(--line);
  background: #fff;
  border-radius: 0 0 var(--radius) var(--radius);
  gap: 16px;
}
.rg-continue-count {
  font-size: 14px;
  color: var(--ink);
  display: flex;
  align-items: center;
  gap: 10px;
}
.rg-count-num { font-size: 20px; font-weight: 800; color: var(--plum); }

/* ---- METHOD CARDS ---- */
.rg-method-card {
  display: block;
  border: 1.5px solid var(--line);
  border-radius: 14px;
  padding: 20px;
  cursor: pointer;
  margin-bottom: 14px;
  transition: all .2s;
  background: #fff;
}
.rg-method-card.active { border-color: var(--plum); background: rgba(var(--plum-rgb),.05); }
.rg-method-card:hover:not(.active) { border-color: var(--plum-border); }
.rg-method-inner { display: flex; align-items: flex-start; gap: 14px; }
.rg-method-icon {
  width: 42px; height: 42px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  flex: none;
  transition: all .2s;
  background: var(--soft);
  color: var(--muted);
}
.rg-method-card.active .rg-method-icon { background: var(--plum); color: #fff; }
.rg-method-body { flex: 1; }
.rg-method-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.rg-method-name { font-size: 15px; font-weight: 700; color: var(--ink); }
.rg-method-check {
  width: 22px; height: 22px;
  border-radius: 50%;
  background: var(--plum);
  display: grid;
  place-items: center;
  color: #fff;
}
.rg-method-desc { font-size: 12px; color: var(--muted); line-height: 1.5; }
.rg-defective-note {
  background: #fff7ed;
  border: 1px solid #fdba74;
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 18px;
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: #9a5d00;
  align-items: flex-start;
}

/* ---- REVIEW ---- */
.rg-review-item {
  display: flex;
  gap: 14px;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}
.rg-review-item:last-child { border: 0; }
.rg-review-img {
  width: 56px; height: 68px;
  border-radius: 9px;
  object-fit: cover;
  border: 1px solid var(--line);
  flex: none;
  background: var(--soft);
  display: flex;
  align-items: center;
  justify-content: center;
}
.rg-review-img img { width: 100%; height: 100%; object-fit: cover; border-radius: 9px; }
.rg-review-info { flex: 1; min-width: 0; }
.rg-review-title { font-size: 13px; font-weight: 700; color: var(--ink); margin: 0 0 3px; }
.rg-review-meta { font-size: 11px; color: var(--muted); margin: 0; }
.rg-review-price { font-size: 13px; font-weight: 700; color: var(--plum-deep); text-align: right; }
.rg-type-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 750;
  padding: 3px 8px;
  border-radius: 99px;
  margin-top: 6px;
}
.rg-type-pill.return { background: var(--pink); color: var(--raspberry); }
.rg-type-pill.exchange { background: #fff7ed; color: #9a5d00; }

/* ---- SUMMARY BOX ---- */
.rg-summary-box {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 18px;
  margin-top: 20px;
}
.rg-summary-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.rg-summary-row:last-child { border: 0; }
.rg-summary-label { color: var(--muted); }
.rg-summary-val { font-weight: 700; color: var(--ink); }
.rg-summary-val.plum { color: var(--plum); }

/* Info boxes */
.rg-info-box {
  border-radius: 12px;
  padding: 14px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 12px;
  margin-top: 12px;
}
.rg-info-box.blue { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
.rg-info-box.plum { background: rgba(var(--plum-rgb),.06); color: var(--plum-deep); border: 1px solid rgba(var(--plum-rgb),.15); }
.rg-info-box.orange { background: #fff7ed; color: #9a5d00; border: 1px solid #fdba74; }

/* ---- ACTION BUTTONS ---- */
.rg-action-row {
  display: flex;
  gap: 12px;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}
.rg-action-row .rg-btn-ghost { flex: 1; justify-content: center; }
.rg-action-row .rg-btn-solid { flex: 2; justify-content: center; padding: 14px 18px; font-size: 14px; }

/* ---- CONFIRMATION ---- */
.rg-confirm-icon {
  width: 72px; height: 72px;
  background: rgba(var(--plum-rgb),.1);
  border-radius: 50%;
  display: grid;
  place-items: center;
  margin: 0 auto 20px;
  color: var(--plum);
}
.rg-ran-code {
  font-family: 'Courier New', monospace;
  font-size: 16px;
  font-weight: 800;
  color: var(--plum);
  letter-spacing: .04em;
}

/* ---- FOOTER ---- */
.rg-footer {
  background: var(--plum-deep);
  color: var(--on-dark);
  padding: 42px 0 27px;
  margin-top: auto;
}
.rg-footer-inner {
  max-width: 1160px;
  margin: 0 auto;
  padding: 0 24px;
}
.rg-footer-top {
  display: flex;
  justify-content: space-between;
  gap: 40px;
  padding-bottom: 36px;
}
.rg-footer-tagline { max-width: 230px; margin: 14px 0 0; font-size: 12px; line-height: 1.6; }
.rg-footer-links { display: flex; gap: 60px; }
.rg-footer-links h4 { margin: 3px 0 14px; color: #fff; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
.rg-footer-links a { display: block; margin-bottom: 10px; color: var(--on-dark); font-size: 12px; text-decoration: none; }
.rg-footer-links a:hover { color: #fff; }
.rg-footer-bottom {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding-top: 18px;
  border-top: 1px solid rgba(255,255,255,.12);
  font-size: 10px;
  color: var(--on-dark-muted);
}
.rg-footer-bottom a { color: var(--on-dark); text-decoration: none; }
.rg-footer-bottom a:hover { color: #fff; }

/* ---- MODAL ---- */
.rg-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(var(--plum-deep-rgb),.54);
  backdrop-filter: blur(5px);
}
.rg-modal {
  position: relative;
  width: min(100%, 440px);
  padding: 28px;
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 30px 90px rgba(var(--plum-deep-rgb),.28);
  animation: rgRise .22s ease both;
}
@keyframes rgRise { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }
.rg-modal-close {
  position: absolute;
  top: 8px; right: 8px;
  width: 40px; height: 40px;
  border-radius: 10px;
  border: 0; background: transparent;
  color: #8f818c; cursor: pointer;
  font-size: 22px; line-height: 1;
}
.rg-modal-icon {
  display: grid;
  place-items: center;
  width: 48px; height: 48px;
  border-radius: 14px;
  margin-bottom: 16px;
}
.rg-modal-icon.plum { background: var(--pink); color: var(--raspberry); }
.rg-modal-icon.blue { background: #eff6ff; color: #2563eb; }
.rg-modal-icon.amber { background: #fff7ed; color: #d97706; }
.rg-modal-icon.orange { background: #fff7ed; color: #ea580c; }
.rg-modal-title { margin: 0 0 8px; color: var(--plum-deep); font-family: Georgia, serif; font-size: 22px; font-weight: 500; letter-spacing: -.035em; }
.rg-modal-copy { margin: 0 0 16px; color: var(--muted); font-size: 13px; line-height: 1.6; }
.rg-modal-box {
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  margin-bottom: 18px;
}
.rg-modal-box.plum { background: rgba(var(--plum-rgb),.08); color: var(--plum); border: 1px solid rgba(var(--plum-rgb),.15); }
.rg-modal-box.blue { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
.rg-modal-box.amber { background: #fff7ed; color: #92400e; border: 1px solid #fde68a; }
.rg-modal-box.orange { background: #fff7ed; color: #9a3412; border: 1px solid #fdba74; }

/* ---- CAROUSEL ---- */
.rg-carousel {
  position: relative;
  height: 200px;
  border-radius: 10px;
  border: 1px solid var(--line);
  overflow: hidden;
  background: var(--soft);
  display: flex;
  align-items: center;
  justify-content: center;
}
.rg-carousel-img { width: 100%; height: 100%; object-fit: contain; padding: 8px; }
.rg-carousel-counter {
  position: absolute;
  top: 8px; left: 8px;
  background: rgba(0,0,0,.6);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 99px;
}
.rg-carousel-btn {
  position: absolute;
  top: 50%; transform: translateY(-50%);
  width: 38px; height: 38px;
  background: rgba(255,255,255,.9);
  border: none; border-radius: 50%;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,.15);
}
.rg-carousel-prev { left: 8px; }
.rg-carousel-next { right: 8px; }
.rg-carousel-dots {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 4px;
}
.rg-carousel-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: rgba(255,255,255,.5);
  transition: all .2s;
}
.rg-carousel-dot.active { background: #fff; width: 14px; border-radius: 3px; }
.rg-image-empty {
  height: 120px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--soft);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 12px;
}

/* ---- MOBILE HEADER ---- */
.rg-mobile-header {
  display: none;
  background: var(--plum-deep);
  border-bottom: 1px solid rgba(255,255,255,.1);
  position: sticky;
  top: 0;
  z-index: 30;
}
.rg-mobile-top {
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.rg-mobile-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}
.rg-mobile-brand-icon {
  width: 32px; height: 32px;
  background: rgba(255,255,255,.12);
  border-radius: 8px;
  display: grid;
  place-items: center;
}
.rg-mobile-progress {
  padding: 0 16px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.rg-mobile-progress-label { font-size: 11px; color: rgba(255,255,255,.7); min-width: max-content; }
.rg-mobile-progress-bar { flex: 1; height: 3px; background: rgba(255,255,255,.2); border-radius: 99px; overflow: hidden; }
.rg-mobile-progress-fill { height: 100%; background: #fff; border-radius: 99px; transition: width .3s; }
.rg-mobile-menu-btn {
  width: 40px; height: 40px;
  background: transparent;
  border: none;
  color: #fff;
  cursor: pointer;
  padding: 8px;
  border-radius: 8px;
  display: grid;
  place-items: center;
}
.rg-mobile-menu-btn:hover { background: rgba(255,255,255,.1); }
.rg-mobile-dropdown {
  background: #fff;
  border-bottom: 1px solid var(--line);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rg-mobile-dropdown a,
.rg-mobile-dropdown button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  color: var(--ink);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
  transition: background .18s;
  background: none;
  border: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
}
.rg-mobile-dropdown a:hover, .rg-mobile-dropdown button:hover { background: var(--soft); }

/* ---- SUPPORT SECTION GRID ---- */
.rg-support-grid {
  max-width: 1160px;
  margin: 0 auto;
  padding: 0 24px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 64px;
  align-items: center;
}
.rg-support-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.rg-support-card-link {
  min-height: 120px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: #fff;
  text-decoration: none;
  display: block;
  transition: transform .2s, box-shadow .2s;
}

/* Hero grid needs side padding on mobile */
.rg-hero-grid {
  max-width: 1160px;
  margin: 0 auto;
}

/* ---- RESPONSIVE ---- */

/* Prevent horizontal overflow at all sizes */
.rg-root * { box-sizing: border-box; }
/* clip (not hidden) so position: sticky keeps working for the header and action bar */
.rg-root { overflow-x: hidden; overflow-x: clip; }

@media (max-width: 900px) {
  /* Layout */
  .rg-portal-grid { grid-template-columns: 1fr; }
  .rg-left-panel { position: static; display: none; }
  .rg-left-panel.mobile-visible { display: block; }
  .rg-mobile-header { display: block; }
  .rg-header { display: none; }

  /* Hero */
  .rg-hero { padding: 44px 0 48px; }
  .rg-hero-grid { grid-template-columns: 1fr; gap: 32px; padding: 0 16px; }
  .rg-hero h1 { font-size: clamp(32px, 9vw, 52px); }
  .rg-hero-copy { font-size: 14px; max-width: 100%; }
  .rg-return-card { padding: 20px; }

  /* Proof strip */
  .rg-proof-row { grid-template-columns: 1fr; gap: 12px; padding: 16px 0; }
  .rg-proof { justify-content: flex-start; padding: 0 16px; border: 0; }

  /* Sections */
  .rg-section { padding: 52px 0; }
  .rg-section-heading { padding: 0 16px; }
  .rg-how-grid { grid-template-columns: 1fr; padding: 0 16px; }
  .rg-how-card::after { display: none; }
  .rg-how-card { min-height: unset; }

  /* Support section */
  .rg-support-grid { grid-template-columns: 1fr; gap: 36px; padding: 0 16px; }
  .rg-support-cards { grid-template-columns: 1fr 1fr; }

  /* Quick links */
  .rg-quick-links { grid-template-columns: 1fr; }

  /* Footer */
  .rg-footer-inner { padding: 0 16px; }
  .rg-footer-top { flex-direction: column; gap: 24px; }
  .rg-footer-links { flex-wrap: wrap; gap: 24px 40px; }
  .rg-footer-bottom { flex-direction: column; gap: 6px; }

  /* Utility */
  .rg-mobile-only { display: block; }
  .rg-desktop-only { display: none; }
}

@media (max-width: 600px) {
  /* Portal */
  .rg-portal { padding: 16px 12px 48px; }
  .rg-right-panel { border-radius: 14px; }
  .rg-right-body { padding: 14px; }
  .rg-right-header { padding: 14px; flex-wrap: wrap; gap: 10px; }
  .rg-right-header h2 { font-size: 16px; }

  /* Hero card */
  .rg-return-card { padding: 16px; }
  .rg-card-title { font-size: 20px; }
  .rg-steps { gap: 4px; }

  /* Item cards */
  .rg-item-header { padding: 12px; gap: 10px; }
  .rg-item-img { width: 56px; height: 68px; flex-shrink: 0; }
  .rg-item-title { font-size: 13px; }
  .rg-item-badges { flex-direction: row; align-items: center; flex-wrap: wrap; }

  /* Item form */
  .rg-item-form { padding: 14px 12px 16px; gap: 12px; }
  .rg-form-row { grid-template-columns: 1fr; gap: 10px; }
  .rg-radio-group { gap: 8px; }
  .rg-radio-label { font-size: 12px; padding: 8px 10px; min-width: 0; }
  .rg-upload-grid { grid-template-columns: repeat(3, 1fr); gap: 6px; }

  /* Continue bar */
  .rg-continue-bar { padding: 12px 14px; flex-direction: column; align-items: stretch; gap: 10px; }
  .rg-continue-count { justify-content: space-between; }
  .rg-continue-bar .rg-btn-solid { width: 100%; justify-content: center; }

  /* Method step */
  .rg-method-card { padding: 14px; }
  .rg-method-name { font-size: 14px; }

  /* Review */
  .rg-review-item { flex-wrap: wrap; gap: 10px; }
  .rg-review-price { width: 100%; text-align: left; }
  .rg-action-row { flex-direction: column; gap: 10px; }
  .rg-action-row .rg-btn-ghost,
  .rg-action-row .rg-btn-solid { flex: none; width: 100%; justify-content: center; }

  /* Summary / info */
  .rg-summary-box { padding: 14px; }
  .rg-summary-row { font-size: 12px; }

  /* Portal grid header */
  .rg-customer-grid-header { flex-direction: column; gap: 6px; align-items: flex-start; }

  /* Confirmation */
  .rg-confirm-icon { width: 56px; height: 56px; }
  .rg-ran-code { font-size: 13px; }

  /* Footer */
  .rg-footer-links { flex-direction: column; gap: 20px; }
  .rg-footer-bottom { font-size: 9px; }

  /* Announcement */
  .rg-announcement { font-size: 11px; padding: 8px 12px; }

  /* Modal */
  .rg-modal { padding: 20px; border-radius: 18px; }
  .rg-modal-title { font-size: 19px; }
}

@media (max-width: 480px) {
  /* Support cards go single column on small phones */
  .rg-support-cards { grid-template-columns: 1fr; }
}

@media (max-width: 380px) {
  .rg-item-img { width: 48px; height: 58px; }
  .rg-hero h1 { font-size: 28px; }
  .rg-portal { padding: 12px 10px 40px; }
  .rg-right-body { padding: 12px; }
  .rg-upload-grid { grid-template-columns: repeat(3, 1fr); gap: 5px; }
  .rg-badge { font-size: 9px; padding: 3px 7px; }
}

/* ---- ADDITIONS (accessibility / mobile / submission) ---- */
/* Larger invisible hit areas for small controls (>= 40px touch targets) */
.rg-checkbox::after, .rg-upload-remove::after {
  content: ""; position: absolute; inset: -9px;
}
.rg-checkbox:disabled { cursor: not-allowed; }
.rg-modal { max-height: 90vh; max-height: 90dvh; overflow-y: auto; }
.rg-modal-actions { display: flex; flex-direction: column; gap: 10px; }
.rg-modal-actions .rg-btn-ghost { justify-content: center; }
.rg-mobile-icon-link {
  display: grid; place-items: center;
  width: 40px; height: 40px; border-radius: 8px;
  color: #fff; background: rgba(255,255,255,.1);
}
.rg-icon-back {
  display: inline-grid; place-items: center;
  min-width: 40px; min-height: 40px;
  border: 1px solid var(--line); border-radius: 8px; background: #fff;
  color: var(--muted); cursor: pointer;
}
.rg-icon-back:hover { color: var(--plum); }
.rg-error-banner {
  display: flex; align-items: flex-start; gap: 8px;
  background: #fff0f0; border: 1px solid #fecaca; border-radius: 9px;
  padding: 10px 12px; margin-bottom: 12px;
  color: #b91c1c; font-size: 12px; font-weight: 600; line-height: 1.45;
}
.rg-error-banner svg { flex-shrink: 0; margin-top: 1px; }
.rg-error-banner a { color: inherit; font-weight: 800; }
.rg-field-error { margin: 6px 0 0; color: #b91c1c; font-size: 11px; font-weight: 600; }
.rg-qty-hint { margin: 5px 0 0; color: var(--muted); font-size: 10px; }
.rg-review-contact { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; font-size: 12px; }
.rg-review-contact > div { min-width: 0; overflow-wrap: anywhere; }
.rg-notice {
  display: flex; gap: 10px; align-items: flex-start; text-align: left;
  border-radius: 12px; padding: 14px; margin-top: 12px;
  font-size: 12px; line-height: 1.5;
  background: #fff7ed; color: #9a5d00; border: 1px solid #fdba74;
}
.rg-notice svg { flex-shrink: 0; margin-top: 1px; }
.rg-notice p { margin: 0; }
.rg-confirm-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 28px; }
.rg-confirm-actions .rg-btn-solid, .rg-confirm-actions .rg-btn-ghost { padding: 13px 24px; font-size: 14px; }

/* Submitting overlay */
.rg-submit-overlay {
  position: fixed; inset: 0; z-index: 60;
  display: grid; place-items: center; padding: 20px;
  background: rgba(var(--plum-deep-rgb), .55);
  backdrop-filter: blur(4px);
}
.rg-submit-card {
  width: min(100%, 380px);
  background: #fff; border-radius: 20px; padding: 28px 24px;
  text-align: center;
  box-shadow: 0 30px 90px rgba(var(--plum-deep-rgb), .28);
}
.rg-submit-card h3 { margin: 14px 0 6px; color: var(--plum-deep); font-family: Georgia, serif; font-size: 20px; font-weight: 500; }
.rg-submit-card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
.rg-submit-spinner { color: var(--plum); display: inline-grid; }
.rg-submit-bar { margin-top: 16px; height: 4px; border-radius: 99px; background: var(--step-track); overflow: hidden; }
.rg-submit-bar span { display: block; height: 100%; background: var(--plum); transition: width .25s ease; }

@media (max-width: 900px) {
  /* >= 16px prevents iOS Safari from zooming into focused inputs */
  .rg-input, .rg-select { font-size: 16px; }
}
@media (max-width: 600px) {
  .rg-right-panel { overflow: visible; }
  /* Action bar stays reachable while scrolling, but is in normal flow so it never covers content */
  .rg-continue-bar.rg-sticky-bar {
    position: sticky; bottom: 0; z-index: 5;
    border-radius: 0 0 14px 14px;
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    box-shadow: 0 -8px 20px rgba(var(--shadow-rgb), .08);
  }
  .rg-review-contact { grid-template-columns: 1fr; }
  .rg-method-header { gap: 8px; }
  .rg-confirm-actions .rg-btn-solid, .rg-confirm-actions .rg-btn-ghost { width: 100%; justify-content: center; }
  .rg-upload-remove { width: 30px; height: 30px; }
}

/* Method cards are <label>s wrapping a visually hidden radio */
.rg-method-card { position: relative; }

/* Landing sections (moved from inline styles) */
.rg-section-wrap { max-width: 1160px; margin: 0 auto; padding: 0 24px; }
.rg-support-card-link:hover { transform: translateY(-3px); box-shadow: 0 14px 30px rgba(var(--shadow-rgb), .08); }
.rg-support-title { margin: 14px 0 16px; color: var(--plum-deep); font-family: Georgia, serif; font-size: clamp(26px, 3.5vw, 42px); line-height: 1.05; letter-spacing: -.055em; font-weight: 500; }
.rg-support-copy { max-width: 440px; margin: 0 0 20px; color: var(--muted); font-size: 14px; line-height: 1.65; }
.rg-support-contacts { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 22px; }
.rg-support-contacts a { color: var(--plum); font-size: 12px; font-weight: 750; border-bottom: 1px solid rgba(var(--plum-rgb), .22); text-decoration: none; padding: 6px 0; }
.rg-faq-list { max-width: 770px; margin: 0 auto; }
.rg-faq { border-bottom: 1px solid var(--line); }
.rg-faq summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 0; color: var(--plum-deep); cursor: pointer; list-style: none; font-size: 14px; font-weight: 750; }
.rg-faq summary::-webkit-details-marker { display: none; }
.rg-faq summary span { color: var(--raspberry); font-size: 20px; font-weight: 400; transition: transform .2s; }
.rg-faq[open] summary span { transform: rotate(45deg); }
.rg-faq p { max-width: 640px; margin: -2px 40px 18px 0; color: var(--muted); font-size: 13px; line-height: 1.65; }
@media (max-width: 900px) {
  .rg-section-wrap { padding: 0; }
  .rg-faq-list { padding: 0 16px; }
  .rg-faq p { margin-right: 0; }
}
`;
