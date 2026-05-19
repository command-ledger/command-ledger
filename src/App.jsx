import { useState, useEffect, useRef } from "react";

// ============================================================
// DESIGN SYSTEM
// ============================================================
const C = {
  bg:          "#050709",
  surface:     "#0A0D14",
  surfaceHigh: "#0F1320",
  border:      "#161C2E",
  borderBright:"#243050",
  gold:        "#BF9B5A",
  goldBright:  "#D4B278",
  goldDim:     "#6B5530",
  goldGlow:    "rgba(191,155,90,0.12)",
  cream:       "#F0E8D8",
  blue:        "#4A7CF7",
  blueGlow:    "rgba(74,124,247,0.1)",
  green:       "#2ABF85",
  greenGlow:   "rgba(42,191,133,0.1)",
  red:         "#E84855",
  redGlow:     "rgba(232,72,85,0.1)",
  amber:       "#E8A020",
  ink:         "#8898B8",
  inkDim:      "#3A4A68",
  white:       "#F4F7FF",
};

const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap');`;

// ============================================================
// MOCK DATA
// ============================================================
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun"];
const DATA = [
  { month:"Jan", revenue:8400,  expenses:5200, leads:42,  closures:11 },
  { month:"Feb", revenue:11200, expenses:5800, leads:58,  closures:16 },
  { month:"Mar", revenue:9800,  expenses:6100, leads:51,  closures:13 },
  { month:"Apr", revenue:14600, expenses:6400, leads:74,  closures:22 },
  { month:"May", revenue:18200, expenses:7100, leads:89,  closures:29 },
  { month:"Jun", revenue:22800, expenses:7600, leads:103, closures:38 },
];

// ============================================================
// UTILITIES
// ============================================================
const $  = (n) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n);
const $k = (n) => n>=1000?`$${(n/1000).toFixed(1)}k`:`$${n}`;
const pc = (n) => `${n.toFixed(1)}%`;

// ============================================================
// GLOBAL CSS
// ============================================================
const CSS = `
${FONTS}
*, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
html { scroll-behavior: smooth; }
body {
  background: ${C.bg};
  color: ${C.white};
  font-family: 'Syne', sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
::selection { background: ${C.goldDim}; color: ${C.cream}; }
::-webkit-scrollbar { width: 3px; }
::-webkit-scrollbar-track { background: ${C.bg}; }
::-webkit-scrollbar-thumb { background: ${C.border}; }

/* ── GRAIN OVERLAY ── */
body::before {
  content:'';
  position:fixed; inset:0; z-index:0; pointer-events:none;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
  opacity: 0.35;
}

/* ── NAV ── */
.nav {
  position:fixed; top:0; left:0; right:0; z-index:200;
  height:64px;
  display:flex; align-items:center; justify-content:space-between;
  padding:0 48px;
  border-bottom:1px solid transparent;
  transition: background 0.4s, border-color 0.4s;
}
.nav.scrolled {
  background: rgba(5,7,9,0.92);
  border-color: ${C.border};
  backdrop-filter: blur(24px);
}
.nav-logo {
  display:flex; align-items:center; gap:12px; cursor:pointer;
  text-decoration:none;
}
.nav-logomark {
  width:36px; height:36px;
  border:1px solid ${C.gold};
  display:flex; align-items:center; justify-content:center;
  font-family:'Cormorant Garamond',serif;
  font-size:18px; color:${C.gold};
  position:relative;
}
.nav-logomark::after {
  content:'';
  position:absolute; inset:4px;
  border:0.5px solid ${C.goldDim};
}
.nav-wordmark {
  font-family:'Cormorant Garamond',serif;
  font-size:20px; font-weight:500;
  color:${C.cream}; letter-spacing:0.04em;
}
.nav-links {
  display:flex; align-items:center; gap:32px;
  list-style:none;
}
.nav-links a {
  font-size:12px; letter-spacing:0.12em; text-transform:uppercase;
  color:${C.ink}; text-decoration:none;
  transition:color 0.2s;
}
.nav-links a:hover { color:${C.cream}; }
.nav-cta {
  display:flex; align-items:center; gap:12px;
}
.btn-ghost {
  font-size:11px; letter-spacing:0.14em; text-transform:uppercase;
  padding:8px 20px;
  background:transparent; border:1px solid ${C.border};
  color:${C.ink}; cursor:pointer; font-family:'Syne',sans-serif;
  transition:all 0.2s; border-radius:1px;
}
.btn-ghost:hover { border-color:${C.gold}; color:${C.gold}; }
.btn-gold {
  font-size:11px; letter-spacing:0.14em; text-transform:uppercase;
  padding:8px 24px;
  background:${C.gold}; border:1px solid ${C.gold};
  color:${C.bg}; cursor:pointer; font-family:'Syne',sans-serif;
  font-weight:700; transition:all 0.2s; border-radius:1px;
}
.btn-gold:hover { background:${C.goldBright}; border-color:${C.goldBright}; }

/* ── HERO ── */
.hero {
  min-height:100vh;
  display:flex; flex-direction:column;
  align-items:center; justify-content:center;
  text-align:center;
  padding:120px 48px 80px;
  position:relative; overflow:hidden;
}
.hero-bg {
  position:absolute; inset:0; pointer-events:none;
  background:
    radial-gradient(ellipse 70% 60% at 50% 0%, rgba(191,155,90,0.06) 0%, transparent 60%),
    radial-gradient(ellipse 50% 40% at 80% 80%, rgba(74,124,247,0.05) 0%, transparent 50%),
    radial-gradient(ellipse 30% 30% at 20% 60%, rgba(42,191,133,0.04) 0%, transparent 50%);
}
.hero-grid {
  position:absolute; inset:0; pointer-events:none; overflow:hidden;
  background-image:
    linear-gradient(${C.border} 1px, transparent 1px),
    linear-gradient(90deg, ${C.border} 1px, transparent 1px);
  background-size: 80px 80px;
  mask-image: radial-gradient(ellipse 80% 80% at 50% 50%, black 0%, transparent 70%);
  opacity:0.4;
}
.hero-eyebrow {
  display:inline-flex; align-items:center; gap:10px;
  font-size:10px; letter-spacing:0.2em; text-transform:uppercase;
  color:${C.gold}; font-weight:600;
  border:1px solid ${C.goldDim};
  padding:6px 16px; margin-bottom:40px;
  animation: fadeUp 0.8s ease both;
}
.hero-eyebrow-dot {
  width:5px; height:5px; border-radius:50%;
  background:${C.gold};
  box-shadow:0 0 8px ${C.gold};
  animation:pulse 2s infinite;
}
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
@keyframes fadeUp {
  from { opacity:0; transform:translateY(20px); }
  to   { opacity:1; transform:translateY(0); }
}
.hero-title {
  font-family:'Cormorant Garamond',serif;
  font-size:clamp(48px,8vw,96px);
  font-weight:300; line-height:1.0;
  color:${C.cream}; letter-spacing:-0.01em;
  margin-bottom:28px;
  animation: fadeUp 0.8s 0.1s ease both;
}
.hero-title em {
  font-style:italic; color:${C.gold};
}
.hero-sub {
  font-size:16px; line-height:1.7;
  color:${C.ink}; max-width:520px; margin:0 auto 48px;
  font-family:'Cormorant Garamond',serif; font-weight:300;
  animation: fadeUp 0.8s 0.2s ease both;
}
.hero-actions {
  display:flex; gap:16px; justify-content:center;
  animation: fadeUp 0.8s 0.3s ease both;
}
.btn-hero {
  font-size:12px; letter-spacing:0.14em; text-transform:uppercase;
  padding:14px 36px; font-family:'Syne',sans-serif; font-weight:700;
  cursor:pointer; border-radius:1px; transition:all 0.25s;
}
.btn-hero-primary {
  background:${C.gold}; border:1px solid ${C.gold}; color:${C.bg};
}
.btn-hero-primary:hover { background:${C.goldBright}; transform:translateY(-1px); box-shadow:0 8px 32px rgba(191,155,90,0.25); }
.btn-hero-secondary {
  background:transparent; border:1px solid ${C.border}; color:${C.ink};
}
.btn-hero-secondary:hover { border-color:${C.inkDim}; color:${C.white}; }
.hero-scroll {
  position:absolute; bottom:40px; left:50%; transform:translateX(-50%);
  display:flex; flex-direction:column; align-items:center; gap:8px;
  font-size:9px; letter-spacing:0.2em; text-transform:uppercase; color:${C.inkDim};
  animation:fadeUp 1s 0.6s ease both;
}
.hero-scroll-line {
  width:1px; height:40px;
  background:linear-gradient(to bottom, ${C.gold}, transparent);
  animation:scrollLine 2s ease-in-out infinite;
}
@keyframes scrollLine {
  0% { transform:scaleY(0); transform-origin:top; }
  50% { transform:scaleY(1); transform-origin:top; }
  51% { transform:scaleY(1); transform-origin:bottom; }
  100% { transform:scaleY(0); transform-origin:bottom; }
}

/* ── STAT STRIP ── */
.stats-strip {
  border-top:1px solid ${C.border};
  border-bottom:1px solid ${C.border};
  display:grid; grid-template-columns:repeat(4,1fr);
  background:${C.surface};
}
.stat-item {
  padding:32px 40px;
  border-right:1px solid ${C.border};
  transition:background 0.2s;
}
.stat-item:hover { background:${C.surfaceHigh}; }
.stat-item:last-child { border-right:none; }
.stat-number {
  font-family:'Cormorant Garamond',serif;
  font-size:40px; font-weight:300;
  color:${C.gold}; line-height:1;
  margin-bottom:8px;
}
.stat-label {
  font-size:10px; letter-spacing:0.16em; text-transform:uppercase;
  color:${C.ink}; font-weight:600;
}

/* ── SECTION ── */
.section { padding:100px 48px; position:relative; }
.section-center { text-align:center; }
.section-eyebrow {
  font-size:10px; letter-spacing:0.2em; text-transform:uppercase;
  color:${C.gold}; font-weight:600; margin-bottom:16px;
  display:flex; align-items:center; gap:12px;
}
.section-eyebrow.center { justify-content:center; }
.section-eyebrow::before, .section-eyebrow::after {
  content:''; flex:1; max-width:60px;
  height:1px; background:linear-gradient(to right,${C.goldDim},transparent);
}
.section-eyebrow.center::before { background:linear-gradient(to left,${C.goldDim},transparent); }
.section-title {
  font-family:'Cormorant Garamond',serif;
  font-size:clamp(36px,5vw,56px);
  font-weight:300; line-height:1.1;
  color:${C.cream}; letter-spacing:-0.01em;
  margin-bottom:20px;
}
.section-title em { font-style:italic; color:${C.gold}; }
.section-body {
  font-size:15px; line-height:1.8;
  color:${C.ink}; max-width:560px;
  font-family:'Cormorant Garamond',serif;
}
.section-body.center { margin:0 auto; text-align:center; }

/* ── FEATURES GRID ── */
.features-grid {
  display:grid; grid-template-columns:repeat(3,1fr);
  gap:1px; background:${C.border};
  border:1px solid ${C.border};
  margin-top:64px;
}
.feature-card {
  background:${C.surface};
  padding:40px 36px;
  transition:background 0.3s;
  position:relative; overflow:hidden;
}
.feature-card:hover { background:${C.surfaceHigh}; }
.feature-card::before {
  content:'';
  position:absolute; top:0; left:0; right:0; height:2px;
  background:linear-gradient(to right,transparent,${C.goldDim},transparent);
  opacity:0; transition:opacity 0.3s;
}
.feature-card:hover::before { opacity:1; }
.feature-num {
  font-family:'JetBrains Mono',monospace;
  font-size:11px; color:${C.goldDim};
  letter-spacing:0.1em; margin-bottom:24px;
}
.feature-icon {
  font-size:28px; margin-bottom:20px; display:block;
}
.feature-title {
  font-family:'Cormorant Garamond',serif;
  font-size:22px; font-weight:500;
  color:${C.cream}; margin-bottom:12px;
}
.feature-desc {
  font-size:13px; line-height:1.7;
  color:${C.ink};
  font-family:'Cormorant Garamond',serif;
}

/* ── PRICING ── */
.pricing-grid {
  display:grid; grid-template-columns:repeat(3,1fr);
  gap:24px; margin-top:64px; max-width:1100px; margin-left:auto; margin-right:auto;
}
.pricing-card {
  background:${C.surface};
  border:1px solid ${C.border};
  padding:40px 32px;
  position:relative; overflow:hidden;
  transition:transform 0.3s, border-color 0.3s;
  border-radius:1px;
}
.pricing-card:hover { transform:translateY(-4px); }
.pricing-card.featured {
  border-color:${C.gold};
  background:linear-gradient(160deg, ${C.surfaceHigh} 0%, ${C.surface} 100%);
}
.pricing-card.featured::before {
  content:'Most Popular';
  position:absolute; top:16px; right:16px;
  font-size:9px; letter-spacing:0.14em; text-transform:uppercase;
  color:${C.bg}; background:${C.gold};
  padding:4px 10px; font-weight:700; font-family:'Syne',sans-serif;
}
.pricing-tier {
  font-size:10px; letter-spacing:0.2em; text-transform:uppercase;
  color:${C.gold}; font-weight:600; margin-bottom:20px;
}
.pricing-price {
  font-family:'Cormorant Garamond',serif;
  font-size:52px; font-weight:300; color:${C.cream};
  line-height:1; margin-bottom:4px;
}
.pricing-price sup { font-size:24px; vertical-align:top; margin-top:10px; display:inline-block; }
.pricing-period {
  font-size:12px; color:${C.ink}; margin-bottom:32px;
  font-family:'Cormorant Garamond',serif;
}
.pricing-divider { height:1px; background:${C.border}; margin-bottom:28px; }
.pricing-features { list-style:none; margin-bottom:36px; }
.pricing-features li {
  display:flex; align-items:flex-start; gap:10px;
  font-size:13px; color:${C.ink}; margin-bottom:12px;
  font-family:'Cormorant Garamond',serif;
  line-height:1.5;
}
.pricing-features li::before {
  content:'—'; color:${C.gold}; flex-shrink:0;
  font-family:'JetBrains Mono',monospace; font-size:11px;
  margin-top:2px;
}
.pricing-btn {
  width:100%; padding:12px;
  font-size:11px; letter-spacing:0.14em; text-transform:uppercase;
  font-family:'Syne',sans-serif; font-weight:700;
  cursor:pointer; border-radius:1px; transition:all 0.2s;
}
.pricing-btn-ghost { background:transparent; border:1px solid ${C.border}; color:${C.ink}; }
.pricing-btn-ghost:hover { border-color:${C.gold}; color:${C.gold}; }
.pricing-btn-filled { background:${C.gold}; border:1px solid ${C.gold}; color:${C.bg}; }
.pricing-btn-filled:hover { background:${C.goldBright}; }

/* ── TESTIMONIAL ── */
.testimonial-grid {
  display:grid; grid-template-columns:repeat(3,1fr); gap:24px;
  margin-top:64px;
}
.testimonial-card {
  background:${C.surface}; border:1px solid ${C.border};
  padding:32px; border-radius:1px;
  transition:border-color 0.3s;
}
.testimonial-card:hover { border-color:${C.goldDim}; }
.testimonial-quote {
  font-family:'Cormorant Garamond',serif;
  font-size:15px; line-height:1.8;
  color:${C.ink}; margin-bottom:24px;
  font-style:italic;
}
.testimonial-quote strong { color:${C.cream}; font-style:normal; }
.testimonial-author {
  display:flex; align-items:center; gap:12px;
}
.testimonial-avatar {
  width:36px; height:36px;
  border-radius:50%; border:1px solid ${C.goldDim};
  display:flex; align-items:center; justify-content:center;
  font-family:'Cormorant Garamond',serif; font-size:14px;
  color:${C.gold}; background:${C.surfaceHigh};
  flex-shrink:0;
}
.testimonial-name {
  font-size:12px; font-weight:600; color:${C.cream};
  margin-bottom:2px;
}
.testimonial-role { font-size:11px; color:${C.inkDim}; }

/* ── CTA SECTION ── */
.cta-section {
  padding:120px 48px;
  text-align:center; position:relative; overflow:hidden;
}
.cta-section::before {
  content:'';
  position:absolute; inset:0;
  background:radial-gradient(ellipse 60% 60% at 50% 50%, rgba(191,155,90,0.07) 0%, transparent 70%);
}
.cta-title {
  font-family:'Cormorant Garamond',serif;
  font-size:clamp(40px,6vw,72px);
  font-weight:300; color:${C.cream};
  line-height:1.1; margin-bottom:20px;
}
.cta-title em { font-style:italic; color:${C.gold}; }

/* ── FOOTER ── */
.footer {
  border-top:1px solid ${C.border};
  padding:48px;
  display:flex; justify-content:space-between; align-items:center;
}
.footer-copy {
  font-size:11px; color:${C.inkDim};
  font-family:'JetBrains Mono',monospace; letter-spacing:0.06em;
}
.footer-links {
  display:flex; gap:24px; list-style:none;
}
.footer-links a {
  font-size:11px; letter-spacing:0.1em; text-transform:uppercase;
  color:${C.inkDim}; text-decoration:none; transition:color 0.2s;
}
.footer-links a:hover { color:${C.ink}; }

/* ══════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════ */
.dash-wrap {
  min-height:100vh;
  background:${C.bg};
  display:grid;
  grid-template-columns:220px 1fr;
  grid-template-rows:64px 1fr;
}
/* sidebar */
.dash-sidebar {
  grid-row:1/3;
  background:${C.surface};
  border-right:1px solid ${C.border};
  display:flex; flex-direction:column;
  padding:0;
}
.dash-sidebar-logo {
  height:64px; border-bottom:1px solid ${C.border};
  display:flex; align-items:center; gap:10px;
  padding:0 20px;
}
.dash-nav { padding:24px 0; flex:1; }
.dash-nav-section {
  font-size:9px; letter-spacing:0.2em; text-transform:uppercase;
  color:${C.inkDim}; padding:8px 20px 4px; font-weight:600;
}
.dash-nav-item {
  display:flex; align-items:center; gap:10px;
  padding:10px 20px; cursor:pointer;
  font-size:12px; letter-spacing:0.06em;
  color:${C.ink}; transition:all 0.15s;
  border-left:2px solid transparent;
  font-weight:500;
}
.dash-nav-item:hover { color:${C.cream}; background:${C.surfaceHigh}; }
.dash-nav-item.active {
  color:${C.gold}; background:${C.goldGlow};
  border-left-color:${C.gold};
}
.dash-nav-icon { font-size:14px; width:18px; text-align:center; }
.dash-sidebar-footer {
  padding:16px 20px; border-top:1px solid ${C.border};
}
.dash-user {
  display:flex; align-items:center; gap:10px;
}
.dash-avatar {
  width:32px; height:32px; border-radius:50%;
  background:${C.goldGlow}; border:1px solid ${C.goldDim};
  display:flex; align-items:center; justify-content:center;
  font-family:'Cormorant Garamond',serif; font-size:14px; color:${C.gold};
}
.dash-username { font-size:12px; color:${C.cream}; font-weight:600; }
.dash-plan { font-size:10px; color:${C.inkDim}; }

/* topbar */
.dash-topbar {
  grid-column:2; height:64px;
  border-bottom:1px solid ${C.border};
  display:flex; align-items:center; justify-content:space-between;
  padding:0 32px; background:rgba(5,7,9,0.5);
  backdrop-filter:blur(12px);
}
.dash-breadcrumb {
  font-size:11px; color:${C.inkDim}; letter-spacing:0.08em;
}
.dash-breadcrumb span { color:${C.cream}; }
.dash-topbar-right { display:flex; align-items:center; gap:16px; }
.live-badge {
  display:flex; align-items:center; gap:6px;
  font-size:10px; color:${C.green}; letter-spacing:0.1em; text-transform:uppercase;
}
.live-dot {
  width:6px; height:6px; border-radius:50%;
  background:${C.green}; box-shadow:0 0 8px ${C.green};
  animation:pulse 2s infinite;
}
.mode-pills {
  display:flex; border:1px solid ${C.border}; overflow:hidden; border-radius:1px;
}
.mode-pill {
  padding:5px 14px; font-size:10px; letter-spacing:0.1em; text-transform:uppercase;
  background:transparent; border:none; color:${C.inkDim};
  cursor:pointer; font-family:'Syne',sans-serif; transition:all 0.15s;
}
.mode-pill.active { background:${C.surfaceHigh}; color:${C.gold}; }

/* main content */
.dash-main {
  grid-column:2; padding:32px;
  overflow-y:auto;
  display:flex; flex-direction:column; gap:28px;
}
.dash-header {
  display:flex; justify-content:space-between; align-items:flex-end;
}
.dash-title {
  font-family:'Cormorant Garamond',serif;
  font-size:28px; font-weight:300; color:${C.cream};
}
.dash-date { font-size:11px; color:${C.inkDim}; font-family:'JetBrains Mono',monospace; }

/* cards */
.d-card {
  background:${C.surface};
  border:1px solid ${C.border};
  border-radius:1px;
  padding:24px;
  position:relative; overflow:hidden;
}
.d-card::before {
  content:'';
  position:absolute; top:0; left:0; right:0; height:1px;
  background:linear-gradient(to right,transparent,rgba(191,155,90,0.15),transparent);
}
.d-card-label {
  font-size:9px; letter-spacing:0.18em; text-transform:uppercase;
  color:${C.inkDim}; font-weight:600; margin-bottom:4px;
}
.d-card-section {
  font-size:10px; letter-spacing:0.14em; text-transform:uppercase;
  color:${C.gold}; font-weight:600; margin-bottom:16px;
  display:flex; align-items:center; gap:8px;
}
.d-card-section::after {
  content:''; flex:1; height:1px;
  background:linear-gradient(to right,${C.goldDim},transparent);
  max-width:80px;
}
.d-val {
  font-family:'Cormorant Garamond',serif;
  font-size:36px; font-weight:300; line-height:1;
  letter-spacing:-0.01em;
}
.d-val.gold { color:${C.gold}; }
.d-val.green { color:${C.green}; }
.d-val.blue { color:${C.blue}; }
.d-val.red { color:${C.red}; }
.d-delta {
  margin-top:8px; font-size:11px;
  font-family:'JetBrains Mono',monospace;
  display:flex; align-items:center; gap:4px;
}
.up { color:${C.green}; } .dn { color:${C.red}; } .nu { color:${C.inkDim}; }

/* kpi row */
.kpi-row { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }

/* chart */
.mini-chart {
  display:flex; align-items:flex-end; gap:5px; height:48px;
}
.mini-bar { flex:1; border-radius:1px 1px 0 0; min-height:2px; transition:opacity 0.2s; }
.mini-bar:hover { opacity:0.7; }

/* ring */
.ring-wrap { position:relative; width:100px; height:100px; flex-shrink:0; }
.ring-wrap svg { transform:rotate(-90deg); }
.ring-label {
  position:absolute; inset:0;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
}
.ring-score {
  font-family:'Cormorant Garamond',serif;
  font-size:24px; color:${C.gold}; line-height:1;
}
.ring-max { font-size:9px; color:${C.inkDim}; font-family:'JetBrains Mono',monospace; }

/* grid layouts */
.g2 { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
.g3 { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
.g21 { display:grid; grid-template-columns:2fr 1fr; gap:20px; }
.g12 { display:grid; grid-template-columns:1fr 2fr; gap:20px; }

/* allocator */
.alloc-row {
  display:flex; align-items:center; gap:14px;
  padding:12px 0; border-bottom:1px solid ${C.border};
}
.alloc-row:last-child { border-bottom:none; }
.alloc-icon {
  width:32px; height:32px; border-radius:1px;
  display:flex; align-items:center; justify-content:center; font-size:14px;
  flex-shrink:0;
}
.alloc-meta { flex:1; }
.alloc-name { font-size:12px; color:${C.cream}; font-weight:600; margin-bottom:2px; }
.alloc-pct { font-size:10px; color:${C.ink}; font-family:'JetBrains Mono',monospace; }
.alloc-bar-track { height:2px; background:${C.border}; border-radius:1px; margin-top:4px; }
.alloc-bar-fill { height:100%; border-radius:1px; transition:width 0.8s ease; }
.alloc-amt {
  font-family:'Cormorant Garamond',serif;
  font-size:18px; font-weight:300;
}

/* roadmap */
.road-track {
  height:4px; background:${C.border}; border-radius:2px;
  overflow:hidden; margin:16px 0;
}
.road-fill {
  height:100%; border-radius:2px;
  background:linear-gradient(to right,${C.blue},${C.gold});
  transition:width 1s ease;
}
.road-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:14px; }
.road-stat {
  background:${C.surfaceHigh}; border:1px solid ${C.border};
  padding:10px 12px; border-radius:1px;
}
.road-stat-l { font-size:9px; text-transform:uppercase; letter-spacing:0.1em; color:${C.inkDim}; margin-bottom:3px; }
.road-stat-v { font-family:'JetBrains Mono',monospace; font-size:13px; color:${C.gold}; }

/* alert */
.d-alert {
  padding:12px 16px; border-radius:1px;
  display:flex; align-items:flex-start; gap:10px;
  font-size:12px; line-height:1.5; border-left:2px solid;
}
.d-alert.critical { background:${C.redGlow}; border-color:${C.red}; color:#E8A0A8; }
.d-alert.success  { background:${C.greenGlow}; border-color:${C.green}; color:#80C8A8; }
.d-alert.warning  { background:rgba(232,160,32,0.08); border-color:${C.amber}; color:#C89050; }
.d-alert.info     { background:${C.blueGlow}; border-color:${C.blue}; color:#80A0E8; }

/* AI panel */
.ai-panel { overflow:hidden; }
.ai-top {
  padding:14px 20px; border-bottom:1px solid ${C.border};
  display:flex; align-items:center; justify-content:space-between;
}
.ai-label {
  display:flex; align-items:center; gap:8px;
  font-size:10px; text-transform:uppercase; letter-spacing:0.14em;
  color:${C.inkDim}; font-weight:600;
}
.ai-glow {
  width:6px; height:6px; border-radius:50%;
  background:${C.gold}; box-shadow:0 0 10px ${C.gold};
}
.ai-body { padding:20px; min-height:100px; }
.ai-text {
  font-family:'Cormorant Garamond',serif;
  font-size:14px; line-height:1.9; color:${C.ink};
  font-style:italic;
}
.ai-text p { margin-bottom:12px; }
.ai-text p:last-child { margin-bottom:0; }
.ai-text strong { color:${C.cream}; font-style:normal; font-weight:500; }
.ai-dots { display:flex; gap:6px; align-items:center; }
.ai-dots span {
  width:6px; height:6px; border-radius:50%;
  background:${C.goldDim};
  animation:dotPulse 1.4s ease-in-out infinite;
}
.ai-dots span:nth-child(2) { animation-delay:0.2s; }
.ai-dots span:nth-child(3) { animation-delay:0.4s; }
@keyframes dotPulse { 0%,80%,100%{transform:scale(0.6);opacity:0.4} 40%{transform:scale(1);opacity:1} }
.ai-refresh {
  background:transparent; border:1px solid ${C.border};
  color:${C.inkDim}; font-size:10px; letter-spacing:0.1em;
  text-transform:uppercase; padding:5px 14px;
  cursor:pointer; font-family:'Syne',sans-serif;
  transition:all 0.2s; border-radius:1px;
}
.ai-refresh:hover { border-color:${C.gold}; color:${C.gold}; }
.ai-refresh:disabled { opacity:0.4; cursor:default; }

/* bar chart */
.bar-chart { display:flex; align-items:flex-end; gap:6px; height:140px; }
.bc-group { flex:1; display:flex; flex-direction:column; align-items:center; gap:4px; height:100%; justify-content:flex-end; }
.bc-bars { display:flex; gap:2px; align-items:flex-end; justify-content:center; height:120px; width:100%; }
.bc-bar { width:46%; border-radius:1px 1px 0 0; min-height:3px; }
.bc-label { font-size:9px; color:${C.inkDim}; font-family:'JetBrains Mono',monospace; letter-spacing:0.04em; }
.chart-legend { display:flex; gap:16px; margin-top:10px; }
.legend-dot { width:8px; height:8px; border-radius:1px; }
.legend-item { display:flex; align-items:center; gap:6px; font-size:10px; color:${C.ink}; }

/* input */
.d-input-label { font-size:9px; letter-spacing:0.14em; text-transform:uppercase; color:${C.ink}; margin-bottom:5px; display:block; }
.d-input {
  background:${C.surfaceHigh}; border:1px solid ${C.border};
  color:${C.white}; padding:8px 12px; font-size:12px;
  font-family:'JetBrains Mono',monospace; border-radius:1px;
  outline:none; transition:border-color 0.2s; width:100%;
}
.d-input:focus { border-color:${C.gold}; }

/* sparkline */
.spark svg { display:block; }

/* responsive */
@media(max-width:1100px){
  .kpi-row { grid-template-columns:repeat(2,1fr); }
  .g21,.g12 { grid-template-columns:1fr; }
}
@media(max-width:900px){
  .features-grid,.pricing-grid,.testimonial-grid { grid-template-columns:1fr; }
  .stats-strip { grid-template-columns:repeat(2,1fr); }
  .g2,.g3 { grid-template-columns:1fr; }
  .dash-wrap { grid-template-columns:1fr; grid-template-rows:64px auto 1fr; }
  .dash-sidebar { display:none; }
  .dash-topbar { grid-column:1; }
  .dash-main { grid-column:1; padding:20px; }
  .nav-links { display:none; }
  .section { padding:60px 24px; }
  .hero { padding:100px 24px 60px; }
  .footer { flex-direction:column; gap:16px; text-align:center; }
}
`;

// ============================================================
// SPARKLINE
// ============================================================
function Spark({ data, color, w=72, h=28 }) {
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((v,i) => {
    const x = (i/(data.length-1))*w;
    const y = h - ((v-min)/(max-min||1))*h;
    return `${x},${y}`;
  }).join(" ");
  return <svg className="spark" width={w} height={h}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/></svg>;
}

// ============================================================
// RING
// ============================================================
function Ring({ score, size=100, sw=6 }) {
  const r=(size-sw)/2, circ=2*Math.PI*r, fill=(score/100)*circ;
  const col = score>70?C.gold:score>40?C.amber:C.red;
  return (
    <div className="ring-wrap" style={{width:size,height:size}}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{transform:"rotate(-90deg)"}}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.border} strokeWidth={sw}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={sw}
          strokeDasharray={circ} strokeDashoffset={circ-fill} strokeLinecap="butt"
          style={{transition:"stroke-dashoffset 1s ease, stroke 0.5s"}}/>
      </svg>
      <div className="ring-label">
        <div className="ring-score">{Math.round(score)}</div>
        <div className="ring-max">/100</div>
      </div>
    </div>
  );
}

// ============================================================
// BAR CHART
// ============================================================
function BarChart({ data }) {
  const maxR = Math.max(...data.map(d=>d.revenue));
  return (
    <div>
      <div className="bar-chart">
        {data.map((d,i)=>(
          <div className="bc-group" key={i}>
            <div className="bc-bars">
              <div className="bc-bar" style={{height:`${(d.revenue/maxR)*110}px`,background:`linear-gradient(to top,${C.blue},rgba(74,124,247,0.4))`}} title={$(d.revenue)}/>
              <div className="bc-bar" style={{height:`${(d.expenses/maxR)*110}px`,background:`linear-gradient(to top,rgba(232,72,85,0.7),rgba(232,72,85,0.2))`}} title={$(d.expenses)}/>
            </div>
            <span className="bc-label">{d.month}</span>
          </div>
        ))}
      </div>
      <div className="chart-legend" style={{marginTop:12}}>
        <div className="legend-item"><div className="legend-dot" style={{background:C.blue}}/> Revenue</div>
        <div className="legend-item"><div className="legend-dot" style={{background:C.red}}/> Expenses</div>
      </div>
    </div>
  );
}

// ============================================================
// MINI CHART
// ============================================================
function MiniChart({ data, color }) {
  const max = Math.max(...data);
  return (
    <div className="mini-chart">
      {data.map((v,i)=>(
        <div key={i} className="mini-bar"
          style={{height:`${Math.max(4,(v/max)*44)}px`,background:color,opacity:0.5+0.5*(v/max)}}/>
      ))}
    </div>
  );
}

// ============================================================
// MARKETING SITE
// ============================================================
function MarketingSite({ onEnterDash }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(()=>{
    const h=()=>setScrolled(window.scrollY>20);
    window.addEventListener("scroll",h);
    return ()=>window.removeEventListener("scroll",h);
  },[]);

  const features = [
    { num:"01", icon:"◈", title:"Sovereignty Index", desc:"A composite score that tells you — in one number — whether your business is in a position of strength or vulnerability. Updated every time your data changes." },
    { num:"02", icon:"◎", title:"AI Strategic Advisor", desc:"A Claude-powered intelligence layer that reads your actual numbers and writes a CFO-grade directive. Not alerts. Not warnings. A paragraph a founder reads twice." },
    { num:"03", icon:"▣", title:"Capital Allocator", desc:"Automatically splits your profit into Tax Vault, Safety Buffer, and True Free Cash. You see instantly what's yours to deploy versus what you must protect." },
    { num:"04", icon:"◐", title:"Revenue Velocity Engine", desc:"Tracks the speed and momentum of your growth — not just the number. Predicts months to any revenue target based on your actual trajectory." },
    { num:"05", icon:"◉", title:"Predictive Roadmap", desc:"A logarithmic projection that finds the intersection of your current momentum and your financial legacy. Your GPS to $100K, $500K, $1M." },
    { num:"06", icon:"⬡", title:"Lead Intelligence Layer", desc:"Connect your pipeline to your revenue. Track conversion rates, cost-per-acquisition, and LTV:CAC ratio — the only metrics that predict sustainable growth." },
  ];
  const testimonials = [
    { quote: "I thought I understood my numbers. Command Ledger showed me I had <strong>six weeks of runway</strong> and didn't know it. That realisation saved my company.", name:"Marcus O.", role:"Founder, Series A SaaS" },
    { quote: "The AI advisory brief it generates every month is <strong>better than the quarterly review</strong> I was paying my accountant for. And it's instant.", name:"Priya S.", role:"CEO, E-commerce Brand" },
    { quote: "We went from guessing whether to hire to having a <strong>clear capital deployment framework</strong>. First month we used it, we scaled ad spend 3x with confidence.", name:"Jordan T.", role:"Co-Founder, Agency" },
  ];

  return (
    <div style={{position:"relative",zIndex:1}}>
      {/* NAV */}
      <nav className={`nav${scrolled?" scrolled":""}`}>
        <a className="nav-logo" onClick={()=>window.scrollTo(0,0)}>
          <div className="nav-logomark">C</div>
          <div>
            <div className="nav-wordmark">Command Ledger</div>
          </div>
        </a>
        <ul className="nav-links">
          <li><a href="#features">System</a></li>
          <li><a href="#pricing">Pricing</a></li>
          <li><a href="#proof">Proof</a></li>
        </ul>
        <div className="nav-cta">
          <button className="btn-ghost" onClick={onEnterDash}>Client Login</button>
          <button className="btn-gold" onClick={onEnterDash}>Request Access</button>
        </div>
      </nav>

      {/* HERO */}
      <section className="hero">
        <div className="hero-bg"/>
        <div className="hero-grid"/>
        <div className="hero-eyebrow">
          <span className="hero-eyebrow-dot"/>
          AI Financial Intelligence for Founders
        </div>
        <h1 className="hero-title">
          Know exactly<br/>what your business<br/><em>can afford.</em>
        </h1>
        <p className="hero-sub">
          Command Ledger is an AI-powered financial operating system that reads your numbers in real time, allocates your capital intelligently, and tells you — with the precision of a billionaire CFO — what move to make next.
        </p>
        <div className="hero-actions">
          <button className="btn-hero btn-hero-primary" onClick={onEnterDash}>Enter the System</button>
          <button className="btn-hero btn-hero-secondary" onClick={onEnterDash}>See Live Dashboard</button>
        </div>
        <div className="hero-scroll">
          <div className="hero-scroll-line"/>
          Scroll
        </div>
      </section>

      {/* STATS STRIP */}
      <div className="stats-strip">
        {[
          { num:"$2.4M+", label:"Capital Decisions Tracked" },
          { num:"97%",    label:"Founder Adoption Rate" },
          { num:"6 Wks",  label:"Avg. Time to Clarity" },
          { num:"3×",     label:"Avg. Revenue Velocity Gain" },
        ].map((s,i)=>(
          <div className="stat-item" key={i}>
            <div className="stat-number">{s.num}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {/* FEATURES */}
      <section className="section" id="features">
        <div className="section-eyebrow center">The System</div>
        <div className="section-center">
          <h2 className="section-title">Built on six<br/><em>pillars of financial clarity</em></h2>
          <p className="section-body center">Every module is designed around a single principle: founders should never make a capital decision in the dark.</p>
        </div>
        <div className="features-grid">
          {features.map((f,i)=>(
            <div className="feature-card" key={i}>
              <div className="feature-num">{f.num}</div>
              <span className="feature-icon">{f.icon}</span>
              <div className="feature-title">{f.title}</div>
              <div className="feature-desc">{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* PRICING */}
      <section className="section section-center" id="pricing" style={{background:C.surface,borderTop:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`}}>
        <div className="section-eyebrow center">Investment</div>
        <h2 className="section-title">Choose your<br/><em>command tier</em></h2>
        <p className="section-body center">Every tier includes the full intelligence system. The difference is depth of support and strategic access.</p>
        <div className="pricing-grid">
          {[
            {
              tier:"Essentials", price:"297", period:"per month",
              features:["Full Command Ledger dashboard","AI monthly advisory brief","Capital Allocator & Roadmap","Revenue Velocity tracking","Email support"],
              btn:"Start Essentials", btnClass:"pricing-btn-ghost", featured:false,
            },
            {
              tier:"Command Pro", price:"997", period:"per month",
              features:["Everything in Essentials","Weekly AI strategic brief","Sovereignty Index alerts","Lead Intelligence layer","Priority Slack support","Quarterly strategy call"],
              btn:"Start Command Pro", btnClass:"pricing-btn-filled", featured:true,
            },
            {
              tier:"Command Elite", price:"4,000", period:"setup + $1,500/mo",
              features:["Done-for-you configuration","Custom Google Sheets integration","Monthly 1:1 advisory call","PDF Board Report generation","White-label option available","Direct founder access"],
              btn:"Apply for Elite", btnClass:"pricing-btn-ghost", featured:false,
            },
          ].map((p,i)=>(
            <div className={`pricing-card${p.featured?" featured":""}`} key={i}>
              <div className="pricing-tier">{p.tier}</div>
              <div className="pricing-price"><sup>$</sup>{p.price}</div>
              <div className="pricing-period">{p.period}</div>
              <div className="pricing-divider"/>
              <ul className="pricing-features">
                {p.features.map((f,j)=><li key={j}>{f}</li>)}
              </ul>
              <button className={`pricing-btn ${p.btnClass}`} onClick={onEnterDash}>{p.btn}</button>
            </div>
          ))}
        </div>
      </section>

      {/* TESTIMONIALS */}
      <section className="section" id="proof">
        <div className="section-eyebrow center">Proof</div>
        <div className="section-center">
          <h2 className="section-title">What founders say<br/>after seeing their <em>true numbers</em></h2>
        </div>
        <div className="testimonial-grid">
          {testimonials.map((t,i)=>(
            <div className="testimonial-card" key={i}>
              <div className="testimonial-quote" dangerouslySetInnerHTML={{__html:`"${t.quote}"`}}/>
              <div className="testimonial-author">
                <div className="testimonial-avatar">{t.name[0]}</div>
                <div>
                  <div className="testimonial-name">{t.name}</div>
                  <div className="testimonial-role">{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="cta-section" style={{borderTop:`1px solid ${C.border}`}}>
        <div style={{position:"relative",zIndex:1}}>
          <div className="section-eyebrow center">The Decision</div>
          <h2 className="cta-title">One bad capital decision<br/>costs more than<br/><em>this system.</em></h2>
          <p className="section-body center" style={{marginTop:20,marginBottom:48}}>
            The hire you couldn't afford. The ad spend with no data behind it. The month you ran without knowing your runway. Command Ledger exists so those decisions never happen again.
          </p>
          <button className="btn-hero btn-hero-primary" style={{fontSize:13,padding:"16px 48px"}} onClick={onEnterDash}>
            Enter Command Ledger
          </button>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="footer">
        <div className="footer-copy">© 2026 Command Ledger · DigiBlueprint Financial Intelligence</div>
        <ul className="footer-links">
          <li><a href="#">Privacy</a></li>
          <li><a href="#">Terms</a></li>
          <li><a href="#">Contact</a></li>
        </ul>
      </footer>
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
function Dashboard({ onExit }) {
  const [mode, setMode]           = useState("safe");
  const [activeNav, setActiveNav] = useState("overview");
  const [target, setTarget]       = useState(100000);
  const [aiText, setAiText]       = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  const tr = mode==="safe"?0.30:0.25;
  const sr = mode==="safe"?0.20:0.10;

  const latest = DATA[DATA.length-1];
  const prev   = DATA[DATA.length-2];
  const totRev = DATA.reduce((s,d)=>s+d.revenue,0);
  const totExp = DATA.reduce((s,d)=>s+d.expenses,0);
  const totPro = totRev-totExp;
  const margin = totRev>0?(totPro/totRev)*100:0;
  const vel    = prev.revenue>0?((latest.revenue-prev.revenue)/prev.revenue)*100:0;
  const totL   = DATA.reduce((s,d)=>s+d.leads,0);
  const totC   = DATA.reduce((s,d)=>s+d.closures,0);
  const conv   = totL>0?(totC/totL)*100:0;
  const sov    = Math.min(100,Math.max(0,(margin*0.6)+(Math.min(conv,100)*0.4)));
  const sovLbl = sov>=75?"Sovereign":sov>=50?"Stabilizing":sov>=30?"Defensive":"Critical";
  const taxV   = totPro*tr;
  const safV   = totPro*sr;
  const free   = totPro-taxV-safV;
  const gap    = target-latest.revenue;
  const mths   = vel>0&&latest.revenue<target?Math.log(target/latest.revenue)/Math.log(1+vel/100):null;
  const prog   = Math.min(100,(latest.revenue/target)*100);

  const getAlert=()=>{
    if(free<0) return{type:"critical",msg:"CRITICAL: True Free Cash is negative. Overhead exceeds liquidity. Cut operating costs before next cycle."};
    if(conv>30&&margin>50) return{type:"success",msg:"S-TIER SIGNAL: Both conversion and margin are elevated. This is a deployment window — increase lead acquisition volume."};
    if(sov<40) return{type:"warning",msg:"DEFENSIVE POSTURE: Sovereignty Index below threshold. Audit lead quality and operational efficiency before scaling spend."};
    return{type:"info",msg:"FOUNDATION STABLE: Core metrics within target bands. Maintain velocity and monitor runway."};
  };
  const alert=getAlert();

  const callAI=async()=>{
    setAiLoading(true); setAiText("");
    try {
      const res=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",
          max_tokens:1000,
          system:`You are the Command Ledger AI — a ruthlessly precise financial intelligence advisor for high-growth founders. You speak with the authority of a billionaire CFO. Write in 3 short punchy paragraphs. No bullet points. Bold key numbers and strategic callouts. Reference the actual data. Never use phrases like "based on the data" — just state the truth and the move.`,
          messages:[{role:"user",content:`Analyze this founder's position and give a 30-day strategic directive. Data: ${JSON.stringify({currentRevenue:latest.revenue,totalProfit:totPro,margin:margin.toFixed(1),velocity:vel.toFixed(1),conversionRate:conv.toFixed(1),sovereigntyScore:sov.toFixed(0),trueFreeCash:free,monthsToTarget:mths?.toFixed(1)??"N/A",targetRevenue:target,mode})}`}]
        })
      });
      const d=await res.json();
      const txt=d.content?.filter(b=>b.type==="text").map(b=>b.text).join("")||"Analysis unavailable.";
      setAiText(txt);
    } catch { setAiText("Advisory engine temporarily offline."); }
    setAiLoading(false);
  };
  useEffect(()=>{callAI();},[]);

  const now=new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  const navItems=[
    {id:"overview",icon:"◈",label:"Overview"},
    {id:"capital",icon:"◎",label:"Capital"},
    {id:"roadmap",icon:"▣",label:"Roadmap"},
    {id:"advisor",icon:"◉",label:"AI Advisor"},
  ];

  return (
    <div className="dash-wrap">
      {/* SIDEBAR */}
      <aside className="dash-sidebar">
        <div className="dash-sidebar-logo">
          <div className="nav-logomark">C</div>
          <div>
            <div className="nav-wordmark" style={{fontSize:16}}>Command Ledger</div>
            <div style={{fontSize:9,color:C.gold,letterSpacing:"0.12em",textTransform:"uppercase"}}>Financial Intelligence</div>
          </div>
        </div>
        <nav className="dash-nav">
          <div className="dash-nav-section">Core Modules</div>
          {navItems.map(n=>(
            <div key={n.id} className={`dash-nav-item${activeNav===n.id?" active":""}`} onClick={()=>setActiveNav(n.id)}>
              <span className="dash-nav-icon">{n.icon}</span>{n.label}
            </div>
          ))}
          <div className="dash-nav-section" style={{marginTop:16}}>Settings</div>
          <div className="dash-nav-item" onClick={onExit}>
            <span className="dash-nav-icon">←</span>Back to Site
          </div>
        </nav>
        <div className="dash-sidebar-footer">
          <div className="dash-user">
            <div className="dash-avatar">K</div>
            <div>
              <div className="dash-username">Khayelihle</div>
              <div className="dash-plan">Command Elite</div>
            </div>
          </div>
        </div>
      </aside>

      {/* TOPBAR */}
      <header className="dash-topbar">
        <div className="dash-breadcrumb">
          Command Ledger / <span>{navItems.find(n=>n.id===activeNav)?.label}</span>
        </div>
        <div className="dash-topbar-right">
          <div className="live-badge"><div className="live-dot"/>Live</div>
          <div className="mode-pills">
            <button className={`mode-pill${mode==="safe"?" active":""}`} onClick={()=>setMode("safe")}>Safe</button>
            <button className={`mode-pill${mode==="growth"?" active":""}`} onClick={()=>setMode("growth")}>Growth</button>
          </div>
        </div>
      </header>

      {/* MAIN */}
      <main className="dash-main">
        <div className="dash-header">
          <div>
            <div className="dash-title">Financial Command Center</div>
            <div style={{fontSize:12,color:C.ink,marginTop:4,fontFamily:"'Cormorant Garamond',serif"}}>Sovereignty · Capital · Momentum</div>
          </div>
          <div className="dash-date">{now}</div>
        </div>

        {/* ALERT */}
        <div className={`d-alert ${alert.type}`}>
          <span style={{fontSize:14,flexShrink:0}}>{alert.type==="critical"?"⚑":alert.type==="success"?"▲":alert.type==="warning"?"◈":"◉"}</span>
          {alert.msg}
        </div>

        {/* KPI ROW */}
        <div>
          <div className="d-card-section">Core Vitals</div>
          <div className="kpi-row">
            {[
              {label:"Current Revenue",val:$(latest.revenue),color:"gold",spark:DATA.map(d=>d.revenue),sc:C.gold,delta:`+${pc(vel)} velocity`,dt:"up"},
              {label:"Profit Margin",val:pc(margin),color:"green",spark:DATA.map(d=>(d.revenue-d.expenses)/d.revenue*100),sc:C.green,delta:`${$(totPro)} net profit`,dt:"up"},
              {label:"Conversion Rate",val:pc(conv),color:"blue",spark:DATA.map(d=>d.closures/d.leads*100),sc:C.blue,delta:`${totC} of ${totL} leads`,dt:"neutral"},
              {label:"Revenue Velocity",val:`+${pc(vel)}`,color:"gold",spark:DATA.map(d=>d.revenue),sc:C.gold,delta:"Month-on-month",dt:"up"},
            ].map((m,i)=>(
              <div className="d-card" key={i} style={{transition:"transform 0.2s,border-color 0.2s",cursor:"default"}}
                onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.borderColor=C.borderBright;}}
                onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.borderColor="";}}>
                <div className="d-card-label">{m.label}</div>
                <div className={`d-val ${m.color}`}>{m.val}</div>
                <div style={{marginTop:12,display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
                  <div className={`d-delta ${m.dt==="up"?"up":m.dt==="down"?"dn":"nu"}`}>
                    {m.dt==="up"?"↑":m.dt==="down"?"↓":"—"} {m.delta}
                  </div>
                  <Spark data={m.spark} color={m.sc}/>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CHART + SOVEREIGNTY */}
        <div className="g2">
          <div className="d-card">
            <div className="d-card-section">Revenue vs Expenses</div>
            <BarChart data={DATA}/>
          </div>
          <div className="d-card">
            <div className="d-card-section">Sovereignty Index</div>
            <div style={{display:"flex",gap:20,alignItems:"center"}}>
              <Ring score={sov}/>
              <div>
                <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:22,color:sov>=75?C.gold:sov>=50?C.amber:C.red,marginBottom:6}}>{sovLbl}</div>
                <div style={{fontSize:12,color:C.ink,lineHeight:1.7,fontFamily:"'Cormorant Garamond',serif"}}>
                  Composite of profit margin weighted 60% and conversion rate weighted 40%. A score above 75 signals aggressive scaling posture.
                </div>
                <div style={{display:"flex",gap:16,marginTop:12}}>
                  <div>
                    <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:"0.1em",color:C.inkDim}}>Margin Weight</div>
                    <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:C.gold}}>{pc(margin*0.6)}</div>
                  </div>
                  <div>
                    <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:"0.1em",color:C.inkDim}}>Conv. Weight</div>
                    <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:C.blue}}>{pc(conv*0.4)}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ROADMAP + ALLOCATOR */}
        <div className="g21">
          <div className="d-card">
            <div className="d-card-section">Scaling Roadmap</div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
              <div>
                <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:C.ink}}>Current </span>
                <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:24,color:C.gold}}>{$k(latest.revenue)}</span>
              </div>
              <div style={{textAlign:"right"}}>
                <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:C.ink}}>Target </span>
                <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:24,color:C.cream}}>{$k(target)}</span>
              </div>
            </div>
            <div className="road-track"><div className="road-fill" style={{width:`${prog}%`}}/></div>
            <div className="road-stats">
              <div className="road-stat"><div className="road-stat-l">Gap to Target</div><div className="road-stat-v">{$k(Math.max(0,gap))}</div></div>
              <div className="road-stat"><div className="road-stat-l">Months to Goal</div><div className="road-stat-v">{mths?`${mths.toFixed(1)}mo`:"—"}</div></div>
              <div className="road-stat"><div className="road-stat-l">Progress</div><div className="road-stat-v">{pc(prog)}</div></div>
            </div>
            <div style={{marginTop:20,display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <div>
                <label className="d-input-label">Monthly Target ($)</label>
                <input className="d-input" type="number" value={target} onChange={e=>setTarget(Number(e.target.value))}/>
              </div>
              <div>
                <label className="d-input-label">Google Sheet CSV URL</label>
                <input className="d-input" type="text" placeholder="Paste CSV link…"/>
              </div>
            </div>
          </div>

          <div className="d-card">
            <div className="d-card-section">Capital Allocator</div>
            {[
              {icon:"🏦",name:"Tax Vault",pct:tr*100,amt:taxV,color:C.red,bg:C.redGlow},
              {icon:"🛡",name:"Safety Buffer",pct:sr*100,amt:safV,color:C.blue,bg:C.blueGlow},
              {icon:"◈",name:"True Free Cash",pct:((free/totPro)*100),amt:free,color:free>=0?C.gold:C.red,bg:free>=0?C.goldGlow:C.redGlow},
            ].map((a,i)=>(
              <div className="alloc-row" key={i}>
                <div className="alloc-icon" style={{background:a.bg}}>{a.icon}</div>
                <div className="alloc-meta">
                  <div className="alloc-name">{a.name}</div>
                  <div className="alloc-pct">{a.pct.toFixed(0)}% of profit</div>
                  <div className="alloc-bar-track"><div className="alloc-bar-fill" style={{width:`${Math.min(100,Math.max(0,a.pct))}%`,background:a.color}}/></div>
                </div>
                <div className="alloc-amt" style={{color:a.color}}>{$(a.amt)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* AI ADVISOR */}
        <div>
          <div className="d-card-section">AI Strategic Advisor</div>
          <div className="d-card ai-panel" style={{padding:0}}>
            <div className="ai-top">
              <div className="ai-label"><div className="ai-glow"/>Command Ledger Intelligence · Powered by Claude</div>
              <button className="ai-refresh" onClick={callAI} disabled={aiLoading}>{aiLoading?"Analyzing…":"Refresh Analysis"}</button>
            </div>
            <div className="ai-body">
              {aiLoading
                ? <div style={{display:"flex",alignItems:"center",gap:12,color:C.inkDim,fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}>
                    <div className="ai-dots"><span/><span/><span/></div>
                    Analyzing your financial position
                  </div>
                : <div className="ai-text" dangerouslySetInnerHTML={{__html:
                    aiText
                      .replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>")
                      .split("\n\n").filter(Boolean)
                      .map(p=>`<p>${p}</p>`).join("")
                  }}/>
              }
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <div style={{borderTop:`1px solid ${C.border}`,paddingTop:16,display:"flex",justifyContent:"space-between",fontSize:10,color:C.inkDim,fontFamily:"'JetBrains Mono',monospace"}}>
          <span>Command Ledger · DigiBlueprint Financial Intelligence · 2026</span>
          <span>{mode==="safe"?"Conservative allocation active":"Aggressive deployment active"}</span>
        </div>
      </main>
    </div>
  );
}

// ============================================================
// ROOT
// ============================================================
export default function App() {
  const [view, setView] = useState("marketing"); // "marketing" | "dashboard"
  return (
    <>
      <style>{CSS}</style>
      {view==="marketing"
        ? <MarketingSite onEnterDash={()=>setView("dashboard")}/>
        : <Dashboard onExit={()=>setView("marketing")}/>
      }
    </>
  );
}
