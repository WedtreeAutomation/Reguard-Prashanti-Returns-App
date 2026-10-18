/**
 * Colour tokens for the public customer pages (CustomerPage + ReturnStatusPage).
 *
 * Every maroon/brand colour used by the `rg-*` / `rsp-*` styles lives here, so
 * the brand palette (#560835) can be applied by editing this one block.
 * Semantic colours (success green, warning amber, error red, info blue) and
 * neutral greys are intentionally not part of the brand palette.
 *
 * The variables are scoped to the page roots (not `:root`) so they never leak
 * into the staff dashboard.
 */
export const CUSTOMER_THEME_CSS = `
.rg-root, .rsp-root {
  /* ---- neutrals ---- */
  --ink: #231b2b;
  --muted: #766c77;
  --line: #e8dfe7;
  --soft: #f8f5f7;
  --panel: #ffffff;

  /* ---- BRAND: Prashanti / Re-Guard #560835 scale ---- */
  --plum: #560835;               /* primary brand colour: buttons, links, active states */
  --plum-rgb: 86, 8, 53;       /* same as --plum, for rgba() tints */
  --plum-deep: #2e041c;          /* darkest brand shade: hero/footer/header bg, headings */
  --plum-deep-rgb: 46, 4, 28;
  --plum-bright: #8a2a5e;        /* lighter brand shade: logo-mark / icon gradients */
  --hero-mid: #3b0524;           /* hero gradient stops (between plum-deep and plum) */
  --hero-end: #560835;
  --raspberry: #a14476;          /* secondary accent: current step, required markers */
  --raspberry-rgb: 161, 68, 118;
  --focus-rgb: 138, 42, 94;     /* focus ring tint */
  --pink: #fbf2f7;               /* very light brand tint backgrounds */
  --plum-border: #ebc2d8;        /* hover borders */
  --plum-line: #ecd6e2;          /* decorative connector lines */
  --step-idle: #f1e4eb;          /* step indicator (not yet reached) */
  --step-idle-ink: #8a6b7c;
  --step-track: #f3e8ee;
  --shadow-rgb: 86, 8, 53;      /* brand-tinted shadows */
  --announce-bg: #2e041c;        /* announcement strip */
  --announce-ink: #eee4eb;
  --on-dark: #e3c9d7;            /* text on dark brand backgrounds */
  --on-dark-muted: #c79fb5;
  --hero-copy: #ead6e1;
  --hero-accent: #e9cfa3;

  /* ---- gold accent (part of the existing look) ---- */
  --gold: #d6b074;
  --gold-rgb: 214, 176, 116;
  --gold-light: #e5c996;

  /* ---- semantic ---- */
  --green: #248461;

  --shadow: 0 24px 70px rgba(var(--shadow-rgb), .10);
  --radius: 18px;
}

/* Shared utilities for both public pages */
.rg-sr-only {
  position: absolute !important;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0);
  white-space: nowrap; border: 0;
}
.rg-root a:focus-visible, .rg-root button:focus-visible, .rg-root summary:focus-visible,
.rg-root .rg-upload-empty:focus-within, .rg-root .rg-method-card:focus-within,
.rsp-root a:focus-visible, .rsp-root button:focus-visible {
  outline: 3px solid rgba(var(--focus-rgb), .45);
  outline-offset: 2px;
}
@keyframes rgSpin { to { transform: rotate(360deg); } }
.rg-spin { animation: rgSpin 1s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .rg-root *, .rsp-root * { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;
