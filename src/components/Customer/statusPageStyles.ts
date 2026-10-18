/* Styles for the public tracking page (ReturnStatusPage). Colours come from theme.ts. */
import { CUSTOMER_THEME_CSS } from './theme';

export const STATUS_PAGE_CSS = CUSTOMER_THEME_CSS + `

/* ROOT */
.rsp-root {
    min-height: 100vh;
    background: var(--soft);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: var(--ink);
    display: flex;
    flex-direction: column;
}

/* ANNOUNCEMENT */
.rsp-announcement {
    background: var(--announce-bg);
    color: var(--announce-ink);
    text-align: center;
    font-size: 12px;
    letter-spacing: .035em;
    padding: 9px 20px;
}
.rsp-announcement strong { color: #fff; font-weight: 750; }

/* HEADER */
.rsp-header {
    position: sticky;
    top: 0;
    z-index: 30;
    background: rgba(255,255,255,.96);
    border-bottom: 1px solid var(--line);
    backdrop-filter: blur(16px);
}
.rsp-navbar {
    max-width: 1160px;
    margin: 0 auto;
    padding: 0 24px;
    height: 72px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
}
.rsp-brand {
    display: inline-flex;
    align-items: center;
    gap: 11px;
    text-decoration: none;
    min-width: max-content;
}
.rsp-brand-mark {
    display: grid;
    place-items: center;
    width: 39px; height: 39px;
    border: 1px solid rgba(var(--gold-rgb),.6);
    border-radius: 12px;
    color: #fff;
    background: linear-gradient(145deg, var(--plum-bright), var(--plum-deep));
    box-shadow: 0 7px 17px rgba(var(--shadow-rgb),.2);
}
.rsp-brand-text { display: flex; flex-direction: column; }
.rsp-brand-name { color: var(--plum); font-size: 18px; line-height: 1; letter-spacing: -.055em; font-weight: 780; }
.rsp-brand-by { margin-top: 2px; color: var(--muted); font-size: 8px; letter-spacing: .2em; font-weight: 750; text-transform: uppercase; }
.rsp-nav-actions { display: flex; align-items: center; gap: 10px; }
.rsp-btn-ghost {
    border: 1px solid var(--line);
    border-radius: 11px;
    padding: 10px 16px;
    background: transparent;
    color: var(--plum);
    font-size: 13px; font-weight: 750;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 6px;
    transition: all .18s;
}
.rsp-btn-ghost:hover { background: var(--soft); transform: translateY(-1px); }
.rsp-btn-solid {
    border: 0;
    border-radius: 11px;
    padding: 11px 18px;
    background: var(--plum);
    color: #fff;
    font-size: 13px; font-weight: 750;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 6px;
    box-shadow: 0 8px 18px rgba(var(--plum-rgb),.18);
    transition: all .18s;
    font-family: inherit;
}
.rsp-btn-solid:hover { background: var(--plum-deep); transform: translateY(-1px); }
.rsp-btn-solid:disabled { opacity: .65; cursor: not-allowed; transform: none; }

/* MOBILE HEADER */
.rsp-mobile-header {
    display: none;
    background: var(--plum-deep);
    border-bottom: 1px solid rgba(255,255,255,.1);
    position: sticky;
    top: 0;
    z-index: 30;
}
.rsp-mobile-top {
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.rsp-mobile-brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    color: #fff;
    font-size: 15px;
    font-weight: 700;
}
.rsp-mobile-brand-icon {
    width: 32px; height: 32px;
    background: rgba(255,255,255,.12);
    border-radius: 8px;
    display: grid; place-items: center;
}
.rsp-mobile-actions { display: flex; gap: 4px; align-items: center; }
.rsp-mobile-btn {
  width: 40px; height: 40px;
    display: grid; place-items: center;
    border-radius: 8px;
    background: rgba(255,255,255,.1);
    border: none; color: #fff; cursor: pointer;
    text-decoration: none;
    transition: background .18s;
}
.rsp-mobile-btn:hover { background: rgba(255,255,255,.18); }
.rsp-mobile-dropdown {
    background: #fff;
    border-bottom: 1px solid var(--line);
    padding: 12px;
    display: flex; flex-direction: column; gap: 4px;
}
.rsp-mobile-dropdown a {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    color: var(--ink);
    text-decoration: none;
    font-size: 13px; font-weight: 600;
    transition: background .18s;
}
.rsp-mobile-dropdown a:hover { background: var(--soft); }

/* HERO BANNER */
.rsp-hero {
    background:
        radial-gradient(circle at 88% 10%, rgba(var(--gold-rgb),.16), transparent 21%),
        radial-gradient(circle at 12% 85%, rgba(var(--raspberry-rgb),.15), transparent 26%),
        linear-gradient(132deg, var(--plum-deep) 0%, var(--hero-mid) 55%, var(--hero-end) 100%);
    padding: 52px 0 56px;
    position: relative;
    overflow: hidden;
    text-align: center;
}
.rsp-hero::before {
    content: "T";
    position: absolute;
    top: 0; right: 2%;
    color: rgba(255,255,255,.03);
    font-family: Georgia, serif;
    font-size: clamp(200px, 28vw, 380px);
    font-weight: 500;
    line-height: .8;
    pointer-events: none;
}
.rsp-hero-inner {
    position: relative; z-index: 1;
    max-width: 620px;
    margin: 0 auto;
    padding: 0 24px;
}
.rsp-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--gold);
    font-size: 11px;
    letter-spacing: .13em;
    font-weight: 800;
    text-transform: uppercase;
    margin-bottom: 16px;
}
.rsp-eyebrow-dot {
    width: 7px; height: 7px;
    border-radius: 99px;
    background: var(--gold);
    box-shadow: 0 0 0 5px rgba(var(--gold-rgb),.18);
    display: block;
}
.rsp-hero h1 {
    margin: 0 0 14px;
    color: #fff;
    font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(34px, 4vw, 52px);
    line-height: .97;
    letter-spacing: -.055em;
    font-weight: 500;
}
.rsp-hero h1 em { color: var(--hero-accent); font-style: normal; }
.rsp-hero-copy { color: var(--hero-copy); font-size: 14px; line-height: 1.7; margin: 0; }

/* MAIN AREA */
.rsp-main {
    max-width: 820px;
    margin: 0 auto;
    padding: 40px 24px 72px;
    flex: 1;
    width: 100%;
}

/* BACK BUTTON */
.rsp-back-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--plum);
    font-size: 13px; font-weight: 700;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 9px 14px;
    cursor: pointer;
    margin-bottom: 24px;
    transition: all .18s;
    box-shadow: 0 2px 8px rgba(var(--shadow-rgb),.06);
}
.rsp-back-btn:hover { border-color: var(--raspberry); color: var(--raspberry); transform: translateX(-2px); }

/* PANEL */
.rsp-panel {
    background: #fff;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
}

/* TAB NAV */
.rsp-tab-nav {
    display: flex;
    border-bottom: 1px solid var(--line);
}
.rsp-tab-btn {
    flex: 1;
    padding: 14px 12px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    font-size: 13px; font-weight: 650;
    color: var(--muted);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    gap: 7px;
    transition: all .18s;
    position: relative;
    font-family: inherit;
}
.rsp-tab-btn:hover { color: var(--ink); background: var(--soft); }
.rsp-tab-btn.active-returns { color: var(--plum); border-bottom-color: var(--plum); }
.rsp-tab-btn.active-giftcards { color: var(--plum); border-bottom-color: var(--plum); }
.rsp-tab-btn.active-storecredit { color: var(--plum); border-bottom-color: var(--plum); }

/* TAB BODY */
.rg-tab-body { padding: 28px; display: flex; flex-direction: column; gap: 18px; }
.rg-tab-header { text-align: center; }
.rg-tab-icon {
    width: 56px; height: 56px;
    border-radius: 16px;
    display: grid; place-items: center;
    margin: 0 auto 12px;
    color: #fff;
    box-shadow: 0 8px 20px rgba(0,0,0,.15);
}
.rg-tab-title { margin: 0 0 5px; font-size: 17px; font-weight: 700; color: var(--ink); }
.rg-tab-subtitle { margin: 0; font-size: 12px; color: var(--muted); }

/* SEARCH TYPE ROW */
.rg-search-type-row {
    display: flex;
    justify-content: center;
    gap: 4px;
    background: var(--soft);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 4px;
}
.rg-type-btn {
    flex: 1;
    padding: 8px 12px;
    border-radius: 9px;
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 12px; font-weight: 650;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 5px;
    transition: all .18s;
    font-family: inherit;
}
.rg-type-btn:hover { color: var(--ink); }
.rg-type-btn.active-plum { background: #fff; color: var(--plum); box-shadow: 0 2px 8px rgba(var(--shadow-rgb),.08); }
.rg-type-btn.active-green { background: #fff; color: var(--plum); box-shadow: 0 2px 8px rgba(0,0,0,.08); }
.rg-type-btn.active-purple { background: #fff; color: var(--plum); box-shadow: 0 2px 8px rgba(0,0,0,.08); }

/* SEARCH FORM */
.rg-search-form { display: flex; flex-direction: column; gap: 10px; }
.rg-input-wrap {
    position: relative;
}
.rg-input-wrap svg {
    position: absolute;
    left: 14px; top: 50%;
    transform: translateY(-50%);
    color: #a89ca8;
    pointer-events: none;
}
.rg-input {
    width: 100%;
    height: 48px;
    padding: 0 14px 0 42px;
    border: 1px solid #e7dfe7;
    border-radius: 10px;
    outline: none;
    background: #fff;
    font-size: 13px; color: var(--ink);
    font-family: inherit;
    transition: border .18s, box-shadow .18s;
    box-sizing: border-box;
}
.rg-input::placeholder { color: #aea5af; }
.rg-input:focus { border-color: var(--raspberry); box-shadow: 0 0 0 4px rgba(var(--focus-rgb),.09); }
.rg-btn-solid {
    border: 0;
    border-radius: 10px;
    padding: 13px 18px;
    color: #fff;
    font-size: 13px; font-weight: 750;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    transition: opacity .18s, transform .18s;
    font-family: inherit;
}
.rg-btn-solid:hover { opacity: .92; transform: translateY(-1px); }
.rg-btn-solid:disabled { opacity: .65; cursor: not-allowed; transform: none; }
.rg-spin { animation: rgSpin 1s linear infinite; }
@keyframes rgSpin { to { transform: rotate(360deg); } }

/* ERROR BOX */
.rg-error-box {
    display: flex; align-items: center; gap: 8px;
    background: #fff0f0;
    border: 1px solid #fecaca;
    border-radius: 10px;
    padding: 11px 14px;
    color: #b91c1c;
    font-size: 12px; font-weight: 600;
}

/* RESULTS */
.rg-results { display: flex; flex-direction: column; gap: 12px; }
.rg-balance-card {
    border-radius: 14px;
    padding: 20px;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.rg-balance-icon {
    width: 40px; height: 40px;
    background: rgba(255,255,255,.2);
    border-radius: 10px;
    display: grid; place-items: center;
}
.rg-results-header {
    display: flex; align-items: center; gap: 7px;
    font-size: 13px; font-weight: 700;
    color: var(--ink);
    padding-bottom: 10px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 10px;
}
.rg-result-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #fff;
    margin-bottom: 8px;
}
.rg-result-label { font-size: 10px; color: var(--muted); margin-bottom: 3px; }
.rg-result-mono { font-size: 11px; font-family: 'Courier New', monospace; color: var(--muted); }
.rg-empty-state {
    text-align: center;
    padding: 32px;
    background: var(--soft);
    border-radius: 12px;
    color: var(--muted);
    font-size: 13px;
}

/* RETURN TRACKING TAB */
.rsp-track-body { padding: 28px; display: flex; flex-direction: column; gap: 18px; }
.rsp-track-icon {
    width: 56px; height: 56px;
    border-radius: 16px;
    background: linear-gradient(145deg, var(--plum-bright), var(--plum-deep));
    display: grid; place-items: center;
    margin: 0 auto 10px;
    color: #fff;
    box-shadow: 0 8px 20px rgba(var(--plum-rgb),.22);
}
.rsp-track-title { margin: 0 0 5px; font-size: 17px; font-weight: 700; color: var(--ink); text-align: center; }
.rsp-track-subtitle { margin: 0; font-size: 12px; color: var(--muted); text-align: center; }

/* SELECTION LIST */
.rsp-selection { padding: 28px; }
.rsp-selection h2 {
    margin: 0 0 18px;
    font-family: Georgia, serif;
    font-size: 22px; font-weight: 500;
    color: var(--plum-deep);
    letter-spacing: -.04em;
}
.rsp-selection-item {
    width: 100%;
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 13px;
    background: var(--soft);
    margin-bottom: 10px;
    cursor: pointer;
    transition: all .18s;
    text-align: left;
    font-family: inherit;
    gap: 12px;
}
.rsp-selection-item:hover { border-color: var(--raspberry); background: var(--pink); transform: translateX(2px); }
.rsp-sel-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.rsp-sel-icon {
    width: 42px; height: 42px;
    border-radius: 12px;
    display: grid; place-items: center;
    flex: none;
}
.rsp-sel-ran { font-size: 13px; font-weight: 700; color: var(--ink); margin-bottom: 2px; }
.rsp-sel-order { font-size: 11px; color: var(--muted); }
.rsp-sel-exchange { color: var(--plum); font-weight: 700; }
.rsp-sel-right { display: flex; align-items: center; gap: 8px; flex: none; }

/* STATUS BADGE */
.rsp-status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 5px 11px;
    border-radius: 99px;
    font-size: 11px; font-weight: 750;
    border: 1px solid;
    white-space: nowrap;
}
.rg-status-plum { color: var(--plum); }
.rg-status-bg-plum { background: var(--pink); }
.rg-status-border-plum { border-color: rgba(var(--raspberry-rgb),.3); }
.rg-status-green { color: var(--green); }
.rg-status-bg-green { background: #eef9f4; }
.rg-status-border-green { border-color: #b6e8d4; }
.rg-status-red { color: #b91c1c; }
.rg-status-bg-red { background: #fff0f0; }
.rg-status-border-red { border-color: #fecaca; }
.rg-status-slate { color: #625965; }
.rg-status-bg-slate { background: var(--soft); }
.rg-status-border-slate { border-color: var(--line); }

/* DETAIL VIEW */
.rsp-detail { }

/* DETAIL HEADER GRADIENT */
.rsp-detail-header {
    padding: 24px 28px;
    color: #fff;
}
.rsp-detail-header-plum { background: linear-gradient(135deg, var(--plum-deep) 0%, var(--plum) 100%); }
.rsp-detail-header-green { background: linear-gradient(135deg, #14532d, #248461); }
.rsp-detail-header-red { background: linear-gradient(135deg, #7f1d1d, #dc2626); }
.rsp-detail-header-slate { background: linear-gradient(135deg, #1e293b, #475569); }
.rsp-detail-header-inner { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.rsp-detail-ran-label { font-size: 10px; opacity: .8; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 5px; }
.rsp-detail-ran { font-family: 'Courier New', monospace; font-size: 24px; font-weight: 800; letter-spacing: .03em; }
.rsp-detail-order { font-size: 12px; opacity: .75; margin-top: 4px; }

/* SECTION HEADERS */
.rsp-section-head {
    padding: 14px 22px;
    background: var(--soft);
    border-bottom: 1px solid var(--line);
    border-top: 1px solid var(--line);
    display: flex; align-items: center; justify-content: space-between;
}
.rsp-section-head h3 {
    margin: 0;
    font-size: 14px; font-weight: 700;
    color: var(--plum-deep);
    display: flex; align-items: center; gap: 8px;
}
.rsp-section-body { padding: 22px; }

/* TYPE PILL */
.rsp-type-pill {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10px; font-weight: 750;
    padding: 4px 10px;
    border-radius: 99px;
    background: var(--pink);
    color: var(--raspberry);
    border: 1px solid rgba(var(--raspberry-rgb),.2);
    margin-bottom: 16px;
}

/* AWB PILL */
.rsp-awb-pill {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10px; font-weight: 650; font-family: 'Courier New', monospace;
    padding: 4px 10px;
    border-radius: 99px;
    background: #fff;
    color: var(--ink);
    border: 1px solid var(--line);
    margin-bottom: 16px; margin-left: 6px;
}

/* TRACKING BOX */
.rsp-tracking-box {
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 20px;
}
.rsp-terminal-box {
    border-radius: 14px;
    border: 1px solid;
    padding: 20px;
    display: flex; align-items: flex-start; gap: 14px;
}
.rsp-terminal-box.rejected { background: #fff0f0; border-color: #fecaca; }
.rsp-terminal-box.closed { background: var(--soft); border-color: var(--line); }
.rsp-terminal-icon {
    width: 44px; height: 44px; flex: none;
    border-radius: 50%;
    display: grid; place-items: center;
}
.rsp-terminal-icon.red { background: #fecaca; color: #b91c1c; }
.rsp-terminal-icon.slate { background: #e2d9e1; color: #625965; }
.rsp-terminal-title { font-weight: 700; font-size: 14px; margin: 0 0 5px; }
.rsp-terminal-msg { font-size: 13px; color: var(--muted); line-height: 1.55; margin: 0; }

/* TIMELINE */
.rg-timeline-row { display: flex; gap: 14px; }
.rg-timeline-left { display: flex; flex-direction: column; align-items: center; flex: none; }
.rg-timeline-dot {
    width: 38px; height: 38px;
    border-radius: 50%;
    border: 2px solid;
    display: grid; place-items: center;
    flex: none;
    position: relative;
}
.rg-timeline-dot.complete { background: var(--green); border-color: var(--green); color: #fff; }
.rg-timeline-dot.current { background: #fff; border-color: var(--plum); color: var(--plum); }
.rg-timeline-dot.upcoming { background: #fff; border-color: var(--line); color: #c4b8c4; }
.rg-timeline-ping {
    position: absolute; inset: -4px;
    border-radius: 50%;
    border: 2px solid var(--plum);
    animation: rgPing 1.8s ease-in-out infinite;
    opacity: .3;
}
@keyframes rgPing { 0%, 100% { opacity: .3; transform: scale(1); } 50% { opacity: .1; transform: scale(1.18); } }
.rg-timeline-line {
    width: 2px;
    flex: 1;
    min-height: 28px;
    background: var(--line);
    margin: 4px 0;
}
.rg-timeline-line.complete { background: var(--green); }
.rg-timeline-body { flex: 1; min-width: 0; padding-bottom: 20px; }
.rg-timeline-body:not(.spaced) { padding-bottom: 0; }
.rg-timeline-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 8px; }
.rg-timeline-title { font-size: 14px; font-weight: 700; color: var(--ink); }
.rg-timeline-title.upcoming { color: #c4b8c4; }
.rg-timeline-badge {
    font-size: 9px; font-weight: 800;
    color: var(--plum);
    background: var(--pink);
    border: 1px solid rgba(var(--raspberry-rgb),.2);
    padding: 2px 8px;
    border-radius: 99px;
    text-transform: uppercase;
    letter-spacing: .06em;
}
.rg-timeline-desc { font-size: 12px; color: var(--muted); margin: 5px 0 0; line-height: 1.55; }
.rg-timeline-desc.upcoming { color: #c4b8c4; }
.rg-timeline-meta {
    margin-top: 8px;
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10px; font-family: 'Courier New', monospace;
    background: var(--soft); border: 1px solid var(--line);
    color: var(--muted);
    padding: 4px 10px; border-radius: 7px;
}

/* ITEMS */
.rsp-item { display: flex; gap: 14px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.rsp-item:last-child { border: 0; }
.rsp-item-img {
    width: 68px; height: 82px; flex: none;
    border-radius: 10px;
    border: 1px solid var(--line);
    overflow: hidden;
    background: var(--soft);
    display: flex; align-items: center; justify-content: center;
}
.rsp-item-img img { width: 100%; height: 100%; object-fit: cover; }
.rsp-item-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: space-between; }
.rsp-item-title { font-size: 13px; font-weight: 700; color: var(--ink); margin: 0 0 5px; }
.rsp-item-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.rsp-item-tag { font-size: 10px; padding: 2px 8px; border-radius: 5px; border: 1px solid; white-space: nowrap; }
.rsp-item-tag.sku { background: var(--soft); color: var(--muted); border-color: var(--line); }
.rsp-item-tag.reason { background: #fff7ed; color: #9a5d00; border-color: #fdba74; }
.rsp-item-note { font-size: 10px; color: var(--muted); font-style: italic; background: var(--soft); padding: 6px 9px; border-radius: 6px; border: 1px solid var(--line); }
.rsp-item-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.rsp-item-qty { font-size: 11px; color: var(--muted); background: var(--soft); padding: 4px 8px; border-radius: 6px; }
.rsp-item-price { font-size: 15px; font-weight: 800; color: var(--plum-deep); }
.rsp-items-total {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 22px;
    background: var(--pink);
    border-top: 1px solid rgba(var(--raspberry-rgb),.15);
}
.rsp-items-total-label { font-size: 13px; font-weight: 700; color: var(--plum); }
.rsp-items-total-val { font-size: 20px; font-weight: 800; color: var(--plum); }

/* REFUND METHOD BOX */
.rsp-method-box {
    background: var(--soft);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 18px;
    margin-bottom: 16px;
}
.rsp-method-label { font-size: 10px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 5px; }
.rsp-method-val {
    display: flex; align-items: center; gap: 7px;
    font-size: 15px; font-weight: 800; color: var(--plum);
}

/* CUSTOMER INFO */
.rsp-cust-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.rsp-cust-item { display: flex; gap: 10px; padding: 10px; border-radius: 10px; transition: background .18s; }
.rsp-cust-item:hover { background: var(--soft); }
.rsp-cust-icon {
    width: 34px; height: 34px; flex: none;
    border-radius: 9px;
    display: grid; place-items: center;
    font-size: 14px;
}
.rsp-cust-icon.indigo { background: var(--pink); color: var(--plum); }
.rsp-cust-icon.blue { background: #eff6ff; color: #2563eb; }
.rsp-cust-icon.green { background: #eef9f4; color: var(--green); }
.rsp-cust-icon.amber { background: #fff7ed; color: #b45309; }
.rsp-cust-label { font-size: 10px; color: var(--muted); margin-bottom: 2px; }
.rsp-cust-val { font-size: 12px; font-weight: 700; color: var(--ink); word-break: break-word; }

/* SUPPORT BOX */
.rsp-support-box {
    background: var(--pink);
    border: 1px solid rgba(var(--raspberry-rgb),.2);
    border-radius: 14px;
    padding: 20px;
    display: flex; gap: 14px; align-items: flex-start;
}
.rsp-support-icon {
    width: 42px; height: 42px; flex: none;
    background: #fff;
    border-radius: 50%;
    display: grid; place-items: center;
    color: var(--plum);
    box-shadow: 0 2px 8px rgba(var(--shadow-rgb),.1);
}
.rsp-support-title { font-size: 15px; font-weight: 700; color: var(--plum-deep); margin: 0 0 5px; }
.rsp-support-msg { font-size: 13px; color: var(--plum); margin: 0 0 14px; line-height: 1.5; }
.rsp-support-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.rsp-support-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 9px 14px;
    background: #fff;
    border: 1px solid rgba(var(--plum-rgb),.2);
    border-radius: 9px;
    color: var(--plum);
    font-size: 12px; font-weight: 700;
    text-decoration: none;
    transition: all .18s;
}
.rsp-support-btn:hover { background: var(--soft); border-color: var(--raspberry); }

/* FOOTER */
.rsp-footer { background: var(--plum-deep); color: var(--on-dark); padding: 38px 0 24px; margin-top: auto; }
.rsp-footer-inner { max-width: 1160px; margin: 0 auto; padding: 0 24px; }
.rsp-footer-top { display: flex; justify-content: space-between; gap: 40px; padding-bottom: 30px; }
.rsp-footer-tagline { max-width: 220px; margin: 12px 0 0; font-size: 12px; line-height: 1.6; }
.rsp-footer-links { display: flex; gap: 52px; }
.rsp-footer-links h4 { margin: 0 0 12px; color: #fff; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
.rsp-footer-links a { display: block; margin-bottom: 8px; color: var(--on-dark); font-size: 12px; text-decoration: none; }
.rsp-footer-links a:hover { color: #fff; }
.rsp-footer-bottom {
    display: flex; justify-content: space-between; gap: 12px;
    padding-top: 16px;
    border-top: 1px solid rgba(255,255,255,.12);
    font-size: 10px; color: var(--on-dark-muted);
}
.rsp-footer-bottom a { color: var(--on-dark); text-decoration: none; }
.rsp-footer-bottom a:hover { color: #fff; }

/* RESPONSIVE */
@media (max-width: 860px) {
    .rsp-header { display: none; }
    .rsp-mobile-header { display: block; }
    .rsp-hero { padding: 40px 0 44px; }
    .rsp-cust-grid { grid-template-columns: 1fr; }
    .rsp-footer-top { flex-direction: column; }
    .rsp-footer-links { gap: 32px; }
    .rsp-footer-bottom { flex-direction: column; }
    .rsp-support-box { flex-direction: column; }
}
@media (max-width: 600px) {
    .rsp-main { padding: 24px 16px 52px; }
    .rg-tab-body { padding: 18px; }
    .rsp-track-body { padding: 18px; }
    .rsp-selection { padding: 18px; }
    .rsp-detail-header { padding: 18px; }
    .rsp-section-body { padding: 16px; }
    .rsp-detail-ran { font-size: 18px; }
    .rsp-support-actions { flex-direction: column; }
    .rsp-support-btn { justify-content: center; }
}

/* ---- ADDITIONS (privacy lookup / balances / accessibility / mobile) ---- */
.rsp-root { overflow-x: hidden; overflow-x: clip; }
.rsp-root * { box-sizing: border-box; }
.rsp-field-label { display: block; margin: 0 0 6px; color: #403841; font-size: 11px; font-weight: 800; letter-spacing: .03em; }
.rsp-privacy-note {
  display: flex; gap: 8px; align-items: flex-start;
  margin: 0; padding: 10px 12px;
  border-radius: 10px; background: var(--pink);
  border: 1px solid rgba(var(--raspberry-rgb), .2);
  color: var(--plum-deep); font-size: 11px; line-height: 1.5;
}
.rsp-privacy-note svg { flex-shrink: 0; margin-top: 1px; color: var(--plum); }
.rsp-quick-links { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px; }
.rsp-quick-link {
  display: flex; align-items: center; gap: 9px;
  padding: 12px 14px; min-height: 48px;
  border: 1px solid var(--line); border-radius: 12px;
  text-decoration: none; color: var(--ink); font-size: 12px; font-weight: 700;
  background: #fff; transition: all .18s;
}
.rsp-quick-link:hover { border-color: var(--raspberry); background: var(--pink); }
.rsp-quick-icon { width: 28px; height: 28px; border-radius: 8px; background: var(--pink); display: grid; place-items: center; color: var(--raspberry); flex-shrink: 0; }
.rsp-quick-link small { display: block; font-weight: 500; color: var(--muted); font-size: 10px; }
.rsp-session-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  margin-bottom: 16px; padding: 10px 14px;
  background: #fff; border: 1px solid var(--line); border-radius: 12px;
  font-size: 12px; color: var(--muted);
}
.rsp-session-bar strong { color: var(--plum-deep); }
.rsp-link-btn {
  background: none; border: 0; padding: 8px 4px; min-height: 40px;
  color: var(--plum); font-weight: 750; font-size: 12px; cursor: pointer; font-family: inherit;
  text-decoration: underline; text-underline-offset: 2px;
}
.rsp-track-link {
  display: inline-flex; align-items: center; gap: 6px;
  margin-top: 10px; padding: 8px 12px; min-height: 40px;
  border-radius: 9px; border: 1px solid rgba(var(--plum-rgb), .2);
  background: #fff; color: var(--plum); font-size: 12px; font-weight: 750; text-decoration: none;
}
.rsp-track-link:hover { border-color: var(--raspberry); }
.rsp-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.rsp-info-cell { background: var(--soft); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; min-width: 0; }
.rsp-info-cell .rsp-method-label { margin-bottom: 4px; }
.rsp-info-val { font-size: 14px; font-weight: 800; color: var(--plum-deep); overflow-wrap: anywhere; }
.rsp-item-tag.rejected { background: #fff0f0; color: #b91c1c; border-color: #fecaca; }
.rsp-item-tag.action { background: var(--pink); color: var(--plum); border-color: rgba(var(--raspberry-rgb), .25); }
.rsp-item.rejected .rsp-item-title { text-decoration: line-through; color: var(--muted); }
.rsp-activity { list-style: none; margin: 0; padding: 0; }
.rsp-activity li { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px dashed var(--line); font-size: 12px; }
.rsp-activity li:last-child { border-bottom: 0; }
.rsp-activity time { color: var(--muted); white-space: nowrap; font-size: 11px; }
.rsp-sel-meta { font-size: 10px; color: var(--muted); margin-top: 2px; }
.rsp-balance-card {
  border-radius: 14px; padding: 20px; color: #fff;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: linear-gradient(135deg, var(--plum-deep), var(--plum));
}
.rsp-balance-card.gold { background: linear-gradient(135deg, var(--plum), var(--plum-bright)); }
.rsp-balance-amt { font-size: 24px; font-weight: 800; margin: 2px 0 0; }
.rsp-balance-label { font-size: 11px; opacity: .9; margin: 0; }
.rg-tab-icon.brand { background: linear-gradient(145deg, var(--plum-bright), var(--plum-deep)); }
.rsp-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 28px; color: var(--muted); font-size: 13px; }

@media (max-width: 860px) {
  .rg-input { font-size: 16px; }
}
@media (max-width: 600px) {
  .rsp-tab-btn { padding: 12px 6px; font-size: 12px; flex-direction: column; gap: 4px; min-height: 56px; }
  .rsp-quick-links { grid-template-columns: 1fr; }
  .rsp-info-grid { grid-template-columns: 1fr; }
  .rsp-selection-item { flex-direction: column; align-items: stretch; }
  .rsp-sel-right { justify-content: space-between; }
  .rsp-detail-ran { font-size: 17px; overflow-wrap: anywhere; }
  .rsp-section-head { padding: 12px 16px; }
  .rsp-items-total { padding: 12px 16px; }
  .rsp-item-img { width: 56px; height: 68px; }
  .rsp-balance-amt { font-size: 20px; }
}

`;
