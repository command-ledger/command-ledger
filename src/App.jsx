import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import { fmt, pc, safe, parseAnyCSV, computeMetrics, runScenario, parseTransactions, computeDedupeHash, aggregateTransactionsByMonth, computeRevenueConcentration, detectRecurringObligations, computeForwardRunway, checkAffordability, detectMissedObligations, projectForwardCalendar, summarizeCalendarByWeek, computeDirective, getDirectiveMetricValue, describeDirectiveOutcome, checkoutBlockReason, computeConfidence, fmtCompact, filterTransactions, searchWorkspace, buildAlerts, buildReportCsv, SUPPORTED_CURRENCIES, isSupportedCurrency, currencySymbol, currencyName, partitionByCurrency } from "./lib/financials.js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } }
);

const PAYPAL_CLIENT_ID = import.meta.env.VITE_PAYPAL_CLIENT_ID;
// PayPal plan ids are not held in the browser. They live in
// supabase/functions/_shared/paypal-plans.ts, shared by the webhook that grants
// access and by plan-pricing, which reads each plan's live terms from PayPal
// before checkout is allowed to open. See checkoutBlockReason().

const PLANS = {
  software: {
    name:"Command Ledger", usd:99, annualUsd:990, interval:"MONTH", period:"per month",
    tagline:"The system. Your numbers, read correctly, every week.",
    features:[
      "On-demand AI strategic brief",
      "Runway to a date, not a month count",
      "Recurring commitment detection",
      "Revenue concentration by client",
      "Break-even and 90-day cash projection",
      "Hire affordability, checked against committed costs",
      "Confidence scoring on every metric",
      "Decision log with outcome tracking",
      "CSV, Excel and live sheet sync",
    ],
  },
  advisory: {
    name:"Command Advisory", usd:3000, interval:"MONTH", period:"per month", seats:6,
    tagline:"The system, plus the person who reads it with you.",
    features:[
      "Everything in Command Ledger",
      "Done-for-you data configuration",
      "Monthly 1:1 advisory call",
      "Monthly written board report",
      "Direct advisory line (email)",
      "Priority 4-hour response",
    ],
  },
};

// Bought through DiagnosticModal. The price shown here is display only: the
// charge is set on the server by the diagnostic-order Edge Function, from
// supabase/functions/_shared/one-time-products.ts, and the modal refuses to
// show PayPal unless the server's amount equals this one.
const DIAGNOSTIC = {
  name:"Financial Diagnostic", usd:750,
  tagline:"One-time. Send twelve months of exports, receive the full analysis and a written findings memo.",
  note:"Credited in full against your first month of Command Advisory.",
};

// Profiles created under the old pricing still hold these values, and the
// webhook may still write them for a renewing legacy subscription. Resolving
// them here keeps PLANS[plan] from being undefined and crashing the dashboard.
const LEGACY_PLAN_KEYS = { essentials:"software", pro:"advisory", elite:"advisory" };
const resolvePlanKey = (key) => (key && PLANS[key]) ? key : (LEGACY_PLAN_KEYS[key] || "software");
const planOf = (key) => PLANS[resolvePlanKey(key)];

// Colour tokens for inline styles. Each is a CSS variable defined once in
// :root (see CSS below), so inline styles and the stylesheet share one
// source of truth, sampled from the brand mark. See DESIGN.md.
const C = {
  bg:"var(--bg)", panel:"var(--panel)", panel2:"var(--panel-2)", panel3:"var(--panel-3)",
  line:"var(--line)", lineStrong:"var(--line-strong)",
  text:"var(--text)", text2:"var(--text-2)", text3:"var(--text-3)",
  platinum:"var(--platinum)", platinumHi:"var(--platinum-hi)", silver:"var(--silver)", pewter:"var(--pewter)",
  positive:"var(--positive)", warning:"var(--warning)", danger:"var(--danger)",
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Syne:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');

/* ── Design tokens: the single source of truth (DESIGN.md). Every colour
   is sampled from the brand mark, assets/Logo.png: its near-black field
   and its brushed-silver ramp. The three financial colours carry meaning
   only, and are never decoration. Components read these variables; no
   component hardcodes a colour of its own. ── */
:root{
  --bg:#0D0D0F;
  --panel:#151517;
  --panel-2:#1C1C1F;
  --panel-3:#232327;
  --line:#2A2A2E;
  --line-strong:#3F3F41;
  --text:#EDEDEE;
  --text-2:#AAAAAC;
  --text-3:#8C8C8D;
  --platinum:#DEDEDE;
  --platinum-hi:#F4F4F5;
  --silver:#AAAAAC;
  --pewter:#626264;
  --on-platinum:#0D0D0F;
  --metal:linear-gradient(180deg,#FFFFFF 0%,#EDEDEE 50%,#C4C4C6 100%);
  --positive:#28A879;
  --warning:#D4A34F;
  --danger:#E05252;
  --f-display:'Cormorant Garamond',Georgia,'Times New Roman',serif;
  --f-ui:'Syne',system-ui,-apple-system,'Segoe UI',sans-serif;
  --f-num:'JetBrains Mono',ui-monospace,Consolas,monospace;
  --radius:3px;
  --wrap:1200px;
  --gutter:32px;
  --section:clamp(72px,9vw,128px);
}

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%;}
body{background:var(--bg);color:var(--text);font-family:var(--f-ui);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden;}
::selection{background:var(--pewter);color:var(--text);}
::-webkit-scrollbar{width:8px;height:8px;}
::-webkit-scrollbar-track{background:var(--bg);}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px;}
img{max-width:100%;display:block;}
button,input,select,textarea{font-family:inherit;}
a{color:inherit;}
.tnum{font-variant-numeric:lining-nums tabular-nums;}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes dotPulse{0%,80%,100%{transform:scale(0.6);opacity:0.4}40%{transform:scale(1);opacity:1}}
@keyframes skeletonPulse{0%,100%{opacity:0.45}50%{opacity:0.85}}
@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto;}
  *,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;}
}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
.skip-link{position:absolute;left:12px;top:-60px;z-index:500;background:var(--platinum);color:var(--on-platinum);padding:8px 14px;font-size:13px;font-weight:700;text-decoration:none;}
.skip-link:focus{top:8px;}
:focus-visible{outline:2px solid var(--platinum);outline-offset:2px;}

/* ── Brand. The logo is shown whole, at its own square proportions. Its
   field is the same near-black as the page, and lighten blending lets its
   darker vignette take on whatever surface holds it, so the square never
   reads as a box; the mark itself is untouched. ── */
.brand-mark{mix-blend-mode:lighten;flex-shrink:0;}
.brand-plate{display:block;border:1px solid var(--line-strong);border-radius:6px;overflow:hidden;background:var(--bg);flex-shrink:0;}
.brand-plate .brand-mark{mix-blend-mode:normal;}
.brand-lockup{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--text);min-width:0;}
.brand-name{font-family:var(--f-display);font-weight:500;font-size:19px;letter-spacing:0.16em;text-transform:uppercase;line-height:1;white-space:nowrap;}
/* The signature: the logo's own device, a tracked caption set between
   hairline rules, used as the kicker for every major section. */
.ledger-rule{display:flex;align-items:center;justify-content:center;gap:16px;font-size:12px;font-weight:600;letter-spacing:0.3em;text-transform:uppercase;color:var(--text-2);}
.ledger-rule::before,.ledger-rule::after{content:'';height:1px;width:48px;background:var(--line-strong);flex-shrink:0;}
.ledger-rule.start{justify-content:flex-start;}
.ledger-rule.start::before{display:none;}
/* Brushed silver, as on the monogram. Used once per page at most. */
.metal-text{font-style:italic;background:var(--metal);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-box-decoration-break:clone;box-decoration-break:clone;}

/* ── Buttons and form controls ── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;font-size:14px;font-weight:600;letter-spacing:0.01em;line-height:1.2;border-radius:var(--radius);border:1px solid transparent;cursor:pointer;text-decoration:none;white-space:nowrap;transition:background 0.15s,border-color 0.15s,color 0.15s;}
.btn-primary,.btn-gold{background:var(--platinum);border-color:var(--platinum);color:var(--on-platinum);}
.btn-primary:hover,.btn-gold:hover{background:var(--platinum-hi);border-color:var(--platinum-hi);}
.btn-outline{background:transparent;border-color:var(--line-strong);color:var(--text);}
.btn-outline:hover{border-color:var(--text-2);}
.btn-ghost{background:transparent;color:var(--text-2);}
.btn-ghost:hover{color:var(--text);}
.btn-lg{padding:14px 26px;font-size:15px;}
.btn-md{padding:9px 16px;font-size:13px;}
.btn-full{width:100%;}
.btn:disabled{opacity:0.45;cursor:default;}
.btn-link{background:none;border:0;padding:0;font:inherit;color:var(--text);text-decoration:underline;text-underline-offset:3px;cursor:pointer;}
.spinner{width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--platinum);border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block;flex-shrink:0;}
.di-lbl,.fl{display:block;font-size:12.5px;font-weight:600;color:var(--text-2);margin-bottom:6px;}
.di,.fi{width:100%;background:var(--panel-2);border:1px solid var(--line);color:var(--text);padding:10px 12px;font-size:14px;border-radius:var(--radius);outline:none;transition:border-color 0.15s;}
.di:focus,.fi:focus{border-color:var(--text-2);}
.fi{margin-bottom:14px;}
.input-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;}
.input-group{display:flex;flex-direction:column;}

/* ── Marketing site ── */
.mk-wrap{width:100%;max-width:var(--wrap);margin:0 auto;padding:0 var(--gutter);}
.mk-nav{position:sticky;top:0;z-index:300;height:76px;border-bottom:1px solid transparent;transition:background 0.2s,border-color 0.2s;}
.mk-nav.solid{background:rgba(13,13,15,0.94);backdrop-filter:blur(14px);border-bottom-color:var(--line);}
.mk-nav-in{height:100%;display:flex;align-items:center;gap:28px;}
.mk-nav-links{display:flex;align-items:center;gap:28px;list-style:none;margin-left:auto;}
.mk-nav-links a{font-size:14.5px;font-weight:500;color:var(--text-2);text-decoration:none;transition:color 0.15s;}
.mk-nav-links a:hover{color:var(--text);}
.mk-nav-actions{display:flex;align-items:center;gap:8px;}
.mk-burger{display:none;width:40px;height:40px;align-items:center;justify-content:center;background:transparent;border:1px solid var(--line);border-radius:var(--radius);color:var(--text);cursor:pointer;}
.mk-menu{position:fixed;top:76px;left:0;right:0;z-index:299;background:var(--bg);border-bottom:1px solid var(--line);padding:8px var(--gutter) 24px;animation:fadeIn 0.15s ease;}
.mk-menu a{display:block;padding:14px 0;border-bottom:1px solid var(--line);font-size:16px;color:var(--text);text-decoration:none;}
.mk-menu-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px;}

.mk-hero{padding:48px 0 var(--section);border-bottom:1px solid var(--line);}
.mk-hero-grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:64px;align-items:center;}
.mk-h1{font-family:var(--f-display);font-weight:400;font-size:clamp(46px,5.4vw,76px);line-height:1.02;letter-spacing:-0.015em;color:var(--text);margin:26px 0 24px;}
.mk-lead{font-size:clamp(17px,1.35vw,19px);line-height:1.6;color:var(--text-2);max-width:520px;}
.mk-cta-row{display:flex;flex-wrap:wrap;gap:12px;margin-top:34px;}
.mk-trust{display:flex;flex-wrap:wrap;gap:10px 22px;margin-top:30px;font-size:14px;color:var(--text-3);}
.mk-trust span{display:inline-flex;align-items:center;gap:9px;}
.mk-trust span::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--silver);flex-shrink:0;}

.mk-demo{background:var(--panel);border:1px solid var(--line-strong);border-radius:6px;box-shadow:0 30px 80px -40px rgba(0,0,0,0.9);overflow:hidden;animation:rise 0.6s 0.1s ease both;}
.mk-demo-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--bg);}
.mk-demo-title{font-size:13.5px;font-weight:600;color:var(--text);}
.mk-demo-tag{margin-left:auto;font-family:var(--f-num);font-size:11.5px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-2);border:1px solid var(--line-strong);padding:3px 8px;border-radius:2px;white-space:nowrap;max-width:60%;overflow:hidden;text-overflow:ellipsis;}
.mk-demo-body{padding:16px;display:flex;flex-direction:column;gap:12px;}
.mk-demo-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
.mk-demo-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-top:1px solid var(--line);font-size:13px;color:var(--text-3);}
.mk-demo-foot label{color:var(--text);text-decoration:underline;text-underline-offset:3px;cursor:pointer;font-weight:600;}
.mk-demo-err{color:color-mix(in srgb,var(--danger) 55%,var(--text));font-size:13px;}

.mk-section{padding:var(--section) 0;border-bottom:1px solid var(--line);}
.mk-head{max-width:760px;margin-bottom:56px;}
.mk-head.center{margin-left:auto;margin-right:auto;text-align:center;}
.mk-h2{font-family:var(--f-display);font-weight:400;font-size:clamp(34px,3.6vw,48px);line-height:1.08;letter-spacing:-0.01em;margin-top:20px;color:var(--text);}
.mk-sub{font-size:18px;line-height:1.6;color:var(--text-2);margin-top:18px;}
.mk-head.center .mk-sub{margin-left:auto;margin-right:auto;max-width:620px;}
.mk-h3{font-size:22px;font-weight:600;line-height:1.3;letter-spacing:-0.005em;color:var(--text);}
.mk-p{font-size:16px;line-height:1.65;color:var(--text-2);}
.mk-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px;}
.mk-tag{font-family:var(--f-num);font-size:12px;color:var(--text-2);border:1px solid var(--line);border-radius:2px;padding:4px 10px;}

.mk-outcomes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--line-strong);}
.mk-outcome{padding:36px 36px 4px 0;}
.mk-outcome + .mk-outcome{padding-left:36px;border-left:1px solid var(--line);}
.mk-index{font-family:var(--f-num);font-size:13px;color:var(--text-3);margin-bottom:16px;display:block;}

.mk-caps{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:20px;}
.mk-cap{grid-column:span 6;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:32px;display:flex;flex-direction:column;gap:14px;min-width:0;}
.mk-cap.wide{grid-column:span 7;}
.mk-cap.narrow{grid-column:span 5;}
.mk-cap.full{grid-column:1/-1;}
.mk-cap-figures{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:8px;}
.mk-cap-note{font-size:13px;color:var(--text-3);margin-top:auto;padding-top:8px;}
.mk-supporting{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin-top:20px;border-top:1px solid var(--line);}
.mk-supporting > div{padding:28px 24px 0 0;}
.mk-supporting > div + div{padding-left:24px;border-left:1px solid var(--line);}
.mk-supporting h4{font-size:17px;font-weight:600;color:var(--text);margin-bottom:8px;}
.mk-supporting p{font-size:15px;line-height:1.6;color:var(--text-2);}

.mk-brief{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0;border:1px solid var(--line);border-radius:4px;overflow:hidden;margin-top:8px;}
.mk-brief > div{padding:16px 18px;border-bottom:1px solid var(--line);}
.mk-brief > div:nth-child(odd){border-right:1px solid var(--line);}
.mk-brief dt{font-family:var(--f-num);font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px;}
.mk-brief dd{font-size:15px;line-height:1.55;color:var(--text);}
.mk-brief .full{grid-column:1/-1;border-right:none!important;}

.mk-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--line-strong);}
.mk-step{padding:36px 36px 0 0;}
.mk-step + .mk-step{padding-left:36px;border-left:1px solid var(--line);}
.mk-step-n{font-family:var(--f-display);font-size:64px;line-height:1;color:var(--pewter);margin-bottom:22px;}

.mk-example{display:grid;grid-template-columns:minmax(0,1fr) 56px minmax(0,1fr);align-items:stretch;gap:0;}
.mk-example-col{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:28px;min-width:0;}
.mk-example-label{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px;font-size:12px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-3);}
.mk-arrow{display:flex;align-items:center;justify-content:center;color:var(--text-3);}
.mk-ledger{width:100%;border-collapse:collapse;font-family:var(--f-num);font-size:13px;}
.mk-ledger td{padding:7px 0;border-bottom:1px solid var(--line);color:var(--text-2);vertical-align:top;}
.mk-ledger td:first-child{color:var(--text-3);padding-right:14px;white-space:nowrap;}
.mk-ledger td:last-child{text-align:right;padding-left:14px;white-space:nowrap;font-variant-numeric:tabular-nums;}
.mk-insights{list-style:none;display:flex;flex-direction:column;}
.mk-insights li{padding:14px 0;border-bottom:1px solid var(--line);}
.mk-insights li:first-child{padding-top:0;}
.mk-insights b{display:block;font-family:var(--f-display);font-size:24px;font-weight:500;color:var(--text);line-height:1.2;margin-bottom:4px;font-variant-numeric:lining-nums tabular-nums;}
.mk-insights span{font-size:15px;line-height:1.55;color:var(--text-2);}
.mk-verdict{margin-top:18px;padding:16px 18px;border:1px solid var(--line-strong);border-left:3px solid var(--warning);border-radius:3px;}
.mk-verdict-k{font-family:var(--f-num);font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:var(--warning);margin-bottom:6px;}
.mk-verdict-t{font-family:var(--f-display);font-size:22px;color:var(--text);line-height:1.3;}

.mk-prices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;align-items:stretch;}
.mk-price{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:32px;display:flex;flex-direction:column;position:relative;}
.mk-price.featured{border-color:var(--line-strong);background:var(--panel-2);}
.mk-price.featured::before{content:'';position:absolute;top:-1px;left:-1px;right:-1px;height:2px;background:var(--metal);border-radius:6px 6px 0 0;}
.mk-price-name{font-size:14px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--text);}
.mk-price-for{font-size:15px;line-height:1.55;color:var(--text-2);margin-top:10px;min-height:48px;}
.mk-price-fig{font-family:var(--f-display);font-size:56px;line-height:1;color:var(--text);margin-top:26px;font-variant-numeric:lining-nums;}
.mk-price-fig small{font-family:var(--f-ui);font-size:15px;color:var(--text-3);margin-left:6px;}
.mk-price-alt{font-size:14px;color:var(--text-3);margin-top:8px;min-height:22px;}
.mk-price-list{list-style:none;margin:26px 0 30px;padding-top:22px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:11px;}
.mk-price-list li{display:flex;gap:12px;font-size:15px;line-height:1.5;color:var(--text-2);}
.mk-price-list li::before{content:'';width:6px;height:6px;margin-top:8px;border:1px solid var(--silver);transform:rotate(45deg);flex-shrink:0;}
.mk-price .btn{margin-top:auto;}

.mk-faq{max-width:860px;margin:0 auto;border-top:1px solid var(--line-strong);}
.mk-faq details{border-bottom:1px solid var(--line);}
.mk-faq summary{list-style:none;display:flex;justify-content:space-between;align-items:center;gap:20px;padding:22px 0;cursor:pointer;font-size:18px;font-weight:600;color:var(--text);}
.mk-faq summary::-webkit-details-marker{display:none;}
.mk-faq summary::after{content:'+';font-family:var(--f-num);font-size:20px;color:var(--text-2);transition:transform 0.2s;flex-shrink:0;}
.mk-faq details[open] summary::after{transform:rotate(45deg);}
.mk-faq details p{font-size:16px;line-height:1.7;color:var(--text-2);padding:0 48px 24px 0;max-width:760px;}

.mk-final{padding:var(--section) 0;text-align:center;}
.mk-final .brand-plate{margin:0 auto 32px;}
.mk-final-h{font-family:var(--f-display);font-weight:400;font-size:clamp(34px,4vw,54px);line-height:1.12;max-width:900px;margin:0 auto 36px;}

.mk-footer{border-top:1px solid var(--line);padding:56px 0 40px;}
.mk-footer-grid{display:grid;grid-template-columns:minmax(0,2fr) repeat(3,minmax(0,1fr));gap:32px;}
.mk-footer h5{font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-3);margin-bottom:16px;}
.mk-footer ul{list-style:none;display:flex;flex-direction:column;gap:10px;}
.mk-footer a,.mk-footer button{font-size:15px;color:var(--text-2);text-decoration:none;background:none;border:none;padding:0;cursor:pointer;text-align:left;}
.mk-footer a:hover,.mk-footer button:hover{color:var(--text);}
.mk-footer-note{font-size:14px;color:var(--text-3);margin-top:14px;max-width:320px;line-height:1.6;}
.mk-footer-base{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-top:48px;padding-top:24px;border-top:1px solid var(--line);font-size:13px;color:var(--text-3);}

/* ── Sign in, paywall, loading, legal ── */
.auth-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 20px;background:var(--bg);}
.auth-card{background:var(--panel);border:1px solid var(--line);border-radius:6px;width:100%;max-width:440px;animation:rise 0.3s ease both;}
.auth-logo-row{display:flex;justify-content:center;padding:28px 32px 0;}
.auth-h{padding:8px 32px 0;text-align:center;}
.auth-title{font-family:var(--f-display);font-size:32px;font-weight:500;color:var(--text);line-height:1.15;}
.auth-sub{font-size:15px;color:var(--text-2);line-height:1.6;margin-top:6px;}
.auth-form{padding:26px 32px 32px;}
.a-err,.a-ok{padding:10px 14px;font-size:14px;margin-bottom:16px;border-radius:var(--radius);border:1px solid;}
.a-err{background:color-mix(in srgb,var(--danger) 10%,transparent);border-color:var(--danger);color:color-mix(in srgb,var(--danger) 45%,var(--text));}
.a-ok{background:color-mix(in srgb,var(--positive) 10%,transparent);border-color:var(--positive);color:color-mix(in srgb,var(--positive) 45%,var(--text));}
.a-div{display:flex;align-items:center;gap:12px;margin:20px 0;color:var(--text-3);font-size:12px;text-transform:uppercase;letter-spacing:0.1em;}
.a-div-line{flex:1;height:1px;background:var(--line);}
.a-link{font-size:14px;color:var(--text-2);text-align:center;margin-top:14px;cursor:pointer;}
.a-link span{color:var(--text);text-decoration:underline;text-underline-offset:3px;}
.loading-screen{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;background:var(--bg);}
.page-top{border-bottom:1px solid var(--line);}
.page-top .mk-wrap{height:76px;display:flex;align-items:center;justify-content:space-between;}
.page-wrap{max-width:760px;margin:0 auto;padding:64px var(--gutter) 96px;}
.page-title{font-family:var(--f-display);font-weight:400;font-size:clamp(36px,4.4vw,52px);line-height:1.1;color:var(--text);margin-bottom:10px;}
.page-date{font-family:var(--f-num);font-size:13px;color:var(--text-3);margin-bottom:44px;}
.page-h2{font-size:20px;font-weight:600;color:var(--text);margin:36px 0 10px;}
.page-p{font-size:16px;line-height:1.75;color:var(--text-2);margin-bottom:14px;}
.page-back{display:inline-flex;align-items:center;gap:8px;font-size:14px;color:var(--text-2);cursor:pointer;}
.page-back:hover{color:var(--text);}

/* ── Modals ── */
.overlay{position:fixed;inset:0;z-index:500;background:rgba(13,13,15,0.9);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px;animation:fadeIn 0.2s ease;}
.modal{background:var(--panel);border:1px solid var(--line-strong);border-radius:6px;width:100%;max-width:500px;max-height:calc(100vh - 48px);overflow-y:auto;animation:rise 0.25s ease both;}
.modal-head{padding:20px 26px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px;}
.modal-title{font-family:var(--f-display);font-size:24px;font-weight:500;color:var(--text);}
.modal-x{background:none;border:none;color:var(--text-3);font-size:24px;line-height:1;padding:4px 8px;cursor:pointer;border-radius:var(--radius);}
.modal-x:hover{color:var(--text);}
.modal-body{padding:26px;}
.plan-badge{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius);padding:14px 18px;margin-bottom:20px;}
.plan-badge-name{font-size:12.5px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-2);margin-bottom:4px;}
.plan-badge-price{font-family:var(--f-display);font-size:30px;color:var(--text);font-variant-numeric:lining-nums;}
.plan-badge-sub{font-size:13px;color:var(--text-3);margin-top:2px;}
.modal-secure{font-size:13px;color:var(--text-3);text-align:center;margin-top:14px;}
.pay-status{text-align:center;padding:28px 0;color:var(--text-2);font-size:14px;}
.pay-err{background:color-mix(in srgb,var(--danger) 10%,transparent);border:1px solid var(--danger);border-radius:var(--radius);padding:10px 14px;font-size:14px;color:color-mix(in srgb,var(--danger) 45%,var(--text));margin-top:12px;}

/* ── Application components ── */
.card{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:22px;position:relative;}
.card-lbl{font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px;}
.val{font-family:var(--f-display);font-size:36px;font-weight:400;line-height:1;font-variant-numeric:lining-nums tabular-nums;}
.kpi4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;}
.kpi3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
.g21{display:grid;grid-template-columns:2fr 1fr;gap:20px;}
.g3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;}
.d-alert{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;font-size:14px;line-height:1.55;border-left:3px solid;border-radius:0 var(--radius) var(--radius) 0;}
.d-alert.crit{background:color-mix(in srgb,var(--danger) 9%,transparent);border-color:var(--danger);color:color-mix(in srgb,var(--danger) 40%,var(--text));}
.d-alert.ok{background:color-mix(in srgb,var(--positive) 9%,transparent);border-color:var(--positive);color:color-mix(in srgb,var(--positive) 40%,var(--text));}
.d-alert.warn{background:color-mix(in srgb,var(--warning) 9%,transparent);border-color:var(--warning);color:color-mix(in srgb,var(--warning) 40%,var(--text));}
.d-alert.info{background:var(--panel-2);border-color:var(--silver);color:var(--text-2);}
.activation-banner{position:fixed;top:0;left:0;right:0;z-index:400;display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 16px;background:var(--panel-2);border-bottom:1px solid var(--warning);color:var(--text);font-size:14px;line-height:1.5;}
.activation-banner a{color:var(--text);}
.severity-tag{display:inline-flex;align-items:center;gap:6px;font-family:var(--f-num);font-size:11.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:3px 9px;border-radius:2px;flex-shrink:0;}
.mode-pills{display:flex;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;}
.mpill{padding:8px 14px;font-size:12.5px;font-weight:600;background:transparent;border:none;color:var(--text-3);cursor:pointer;transition:background 0.15s,color 0.15s;}
.mpill.on{background:var(--panel-3);color:var(--text);}
.alloc-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);}
.alloc-row:last-child{border-bottom:none;}
.alloc-meta{flex:1;min-width:0;}
.alloc-name{font-size:14px;font-weight:600;color:var(--text);}
.alloc-pct{font-size:12.5px;color:var(--text-3);margin-top:2px;}
.alloc-track{height:3px;background:var(--line);margin-top:6px;border-radius:2px;overflow:hidden;}
.alloc-fill{height:100%;transition:width 0.8s ease;}
.alloc-amt{font-family:var(--f-num);font-size:15px;font-variant-numeric:tabular-nums;}
.ai-top{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.ai-lbl{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;color:var(--text-2);}
.ai-glow{width:7px;height:7px;border-radius:50%;background:var(--platinum);}
.ai-body{padding:20px;min-height:90px;}
.ai-txt{font-size:15px;line-height:1.7;color:var(--text-2);}
.ai-dots{display:flex;gap:6px;align-items:center;}
.ai-dots span{width:6px;height:6px;border-radius:50%;background:var(--pewter);animation:dotPulse 1.4s ease-in-out infinite;}
.ai-dots span:nth-child(2){animation-delay:0.2s;}
.ai-dots span:nth-child(3){animation-delay:0.4s;}
.ai-btn{background:var(--platinum);border:1px solid var(--platinum);color:var(--on-platinum);font-size:13px;font-weight:600;padding:8px 16px;border-radius:var(--radius);cursor:pointer;}
.ai-btn:hover{background:var(--platinum-hi);}
.ai-btn:disabled{opacity:0.45;cursor:default;}
/* The advisor brief reads as a memo: a fixed label column, then prose. */
.ai-rec-field{display:grid;grid-template-columns:200px minmax(0,1fr);gap:20px;padding:18px 22px;border-bottom:1px solid var(--line);}
.ai-rec-lbl{font-family:var(--f-num);font-size:12px;letter-spacing:0.08em;text-transform:uppercase;padding-top:3px;}
.ai-rec-body{font-size:15.5px;line-height:1.7;color:var(--text);}
.ai-rec-field.action .ai-rec-body{font-family:var(--f-display);font-size:22px;line-height:1.35;}
.ai-rec-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 22px;background:var(--panel-2);flex-wrap:wrap;}
.ai-rec-chip{font-family:var(--f-num);font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:4px 10px;border-radius:2px;}
.ai-rec-conf{display:flex;align-items:center;gap:12px;font-size:13.5px;color:var(--text-2);flex-wrap:wrap;}
.ai-conf-meter{width:120px;height:4px;background:var(--line);border-radius:2px;overflow:hidden;}
.ai-conf-meter span{display:block;height:100%;background:var(--platinum);}
.drop-zone{border:1px dashed var(--line-strong);border-radius:4px;background:var(--panel-2);padding:36px 24px;text-align:center;cursor:pointer;transition:border-color 0.15s,background 0.15s;}
.drop-zone:hover,.drop-zone.drag{border-color:var(--text-2);background:var(--panel-3);}
.drop-zone-title{font-family:var(--f-display);font-size:24px;color:var(--text);margin-bottom:8px;}
.drop-zone-sub{font-size:14px;color:var(--text-2);line-height:1.6;}
.upload-ok{display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid var(--positive);border-radius:var(--radius);background:color-mix(in srgb,var(--positive) 8%,transparent);}
.upload-ok-txt{font-size:14px;color:var(--text);}
.data-thin{border:1px dashed var(--line-strong)!important;}
.data-thin-tag{display:inline-flex;align-items:center;gap:8px;font-family:var(--f-num);font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--warning);margin-bottom:10px;}
.data-thin-tag::before{content:'';width:6px;height:6px;background:var(--warning);flex-shrink:0;}
.skel{background:var(--panel-3);border-radius:2px;animation:skeletonPulse 1.5s ease-in-out infinite;}

/* ── Application shell: header, sidebar, sections. Rows are compact grids
   so a laptop screen shows the directive, the six vital numbers and the
   cash chart without scrolling; type is never shrunk to get there. ── */
.app{min-height:100vh;background:var(--bg);display:grid;grid-template-columns:240px minmax(0,1fr);grid-template-rows:60px 1fr;}
.app-header{grid-column:1/-1;grid-row:1;position:sticky;top:0;z-index:200;height:60px;display:flex;align-items:center;gap:16px;padding-right:20px;background:rgba(13,13,15,0.96);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);}
.app-brand{width:240px;flex-shrink:0;align-self:stretch;display:flex;align-items:center;gap:10px;padding:0 18px;border-right:1px solid var(--line);text-decoration:none;color:var(--text);}
.app-brand .brand-name{font-size:15px;letter-spacing:0.14em;}
.app-crumb{font-size:13px;color:var(--text-3);white-space:nowrap;}
.app-crumb b{color:var(--text);font-weight:600;}
.hdr-search{position:relative;flex:1 1 320px;max-width:460px;margin-left:auto;}
.hdr-search-input{width:100%;height:38px;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius);color:var(--text);padding:0 64px 0 36px;font-size:14px;}
.hdr-search-input::placeholder{color:var(--text-3);}
.hdr-search-input:focus{outline:none;border-color:var(--text-2);}
.hdr-search-input::-webkit-search-cancel-button{-webkit-appearance:none;}
.hdr-search-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--text-3);display:flex;pointer-events:none;}
.hdr-kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-family:var(--f-num);font-size:11.5px;color:var(--text-3);border:1px solid var(--line-strong);padding:1px 6px;border-radius:2px;pointer-events:none;}
.hdr-tools{display:flex;align-items:center;gap:10px;flex-shrink:0;}
.hdr-select{height:38px;background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius);color:var(--text);font-size:14px;padding:0 10px;cursor:pointer;}
.hdr-select:focus{outline:none;border-color:var(--text-2);}
.hdr-icon-btn{position:relative;width:38px;height:38px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--line);border-radius:var(--radius);color:var(--text-2);cursor:pointer;transition:color 0.15s,border-color 0.15s;}
.hdr-icon-btn:hover,.hdr-icon-btn[aria-expanded="true"]{color:var(--text);border-color:var(--line-strong);}
.hdr-menu,.hdr-search-toggle{display:none;}
.hdr-badge{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--danger);color:#fff;font-family:var(--f-num);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;}
.hdr-dot{position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:var(--silver);}
.hdr-pop-wrap{position:relative;}
.hdr-account{display:flex;align-items:center;gap:10px;background:transparent;border:1px solid transparent;border-radius:var(--radius);padding:3px 8px 3px 3px;cursor:pointer;color:var(--text-2);}
.hdr-account:hover,.hdr-account[aria-expanded="true"]{border-color:var(--line);color:var(--text);}
.hdr-av{border-radius:50%;background:var(--panel-3);border:1px solid var(--line-strong);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--text);overflow:hidden;flex-shrink:0;}
.hdr-av img{width:100%;height:100%;object-fit:cover;}
.hdr-who{display:flex;flex-direction:column;align-items:flex-start;line-height:1.3;min-width:0;}
.hdr-name{font-size:13.5px;font-weight:600;color:var(--text);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.hdr-role{font-size:12px;color:var(--text-3);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.hdr-chev{display:flex;color:var(--text-3);}
.hdr-pop{position:absolute;top:calc(100% + 8px);background:var(--panel-2);border:1px solid var(--line-strong);border-radius:4px;box-shadow:0 18px 44px -14px rgba(0,0,0,0.75);z-index:260;animation:fadeIn 0.12s ease;}
.hdr-pop-right{right:0;}
.hdr-search-pop{left:0;right:0;max-height:min(440px,70vh);overflow-y:auto;padding:4px 0;}
.alerts-pop{width:min(390px,calc(100vw - 24px));max-height:min(480px,75vh);overflow-y:auto;}
.acct-pop{min-width:240px;padding:4px 0;}
.acct-id{padding:10px 14px;border-bottom:1px solid var(--line);margin-bottom:4px;}
.pop-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line);font-size:13px;font-weight:700;color:var(--text);}
.pop-head span{font-family:var(--f-num);color:var(--text-3);font-weight:400;}
.pop-sec{padding:10px 14px 4px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3);}
.pop-item{display:flex;align-items:center;gap:10px;width:100%;padding:9px 14px;background:none;border:none;text-align:left;color:var(--text-2);font-size:14px;cursor:pointer;}
.pop-item:hover,.pop-item.active{background:var(--panel-3);color:var(--text);}
.pop-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pop-date{font-family:var(--f-num);font-size:12px;color:var(--text-3);flex-shrink:0;}
.pop-amt{font-family:var(--f-num);font-size:12.5px;flex-shrink:0;font-variant-numeric:tabular-nums;}
.pop-empty{padding:14px;font-size:14px;line-height:1.6;color:var(--text-2);}
.alert-item{display:flex;flex-direction:column;gap:3px;width:100%;padding:12px 14px;background:none;border:none;border-bottom:1px solid var(--line);text-align:left;cursor:pointer;}
.alert-item:last-child{border-bottom:none;}
.alert-item:hover{background:var(--panel-3);}
.alert-sev{font-family:var(--f-num);font-size:11.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;}
.alert-title{font-size:14px;font-weight:600;color:var(--text);line-height:1.4;}
.alert-detail{font-size:13px;color:var(--text-2);line-height:1.5;}

.app-side{grid-column:1;grid-row:2;position:sticky;top:60px;height:calc(100vh - 60px);overflow-y:auto;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:14px 10px 16px;}
.side-backdrop{display:none;}
.nav-label{font-size:12px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-3);padding:10px 12px 6px;}
.nav-list{list-style:none;margin-bottom:8px;}
.nav-item{display:flex;align-items:center;gap:12px;width:100%;padding:9px 12px;margin:1px 0;font-size:14px;font-weight:500;color:var(--text-2);text-decoration:none;background:none;border:1px solid transparent;border-left:2px solid transparent;border-radius:var(--radius);cursor:pointer;text-align:left;transition:color 0.15s,background 0.15s;}
.nav-item svg{flex-shrink:0;color:var(--text-3);transition:color 0.15s;}
.nav-item:hover{color:var(--text);background:var(--panel-2);}
.nav-item:hover svg{color:var(--text-2);}
.nav-item.on{color:var(--text);background:var(--panel-2);border-color:var(--line);border-left-color:var(--platinum);}
.nav-item.on svg{color:var(--platinum);}
.side-plan{margin-top:auto;border:1px solid var(--line);border-radius:4px;padding:12px;}
.side-plan-name{font-size:14px;font-weight:600;color:var(--text);}

.app-main{grid-column:2;grid-row:2;min-width:0;padding:22px 26px 44px;display:flex;flex-direction:column;gap:16px;outline:none;}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 20px;flex-wrap:wrap;}
.page-h1{font-family:var(--f-display);font-size:clamp(30px,2.6vw,38px);font-weight:500;color:var(--text);line-height:1.1;}
.page-meta{font-family:var(--f-num);font-size:12.5px;color:var(--text-3);margin-top:4px;}
.page-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.row{display:grid;gap:16px;min-width:0;align-items:stretch;}
.row-21{grid-template-columns:minmax(0,2fr) minmax(0,1fr);}
.row-12{grid-template-columns:minmax(0,1fr) minmax(0,2fr);}
.row-2{grid-template-columns:repeat(2,minmax(0,1fr));}
.row-3{grid-template-columns:repeat(3,minmax(0,1fr));}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:18px 20px;min-width:0;display:flex;flex-direction:column;position:relative;}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;}
.panel-title{font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-2);}
.panel-link{display:inline-flex;align-items:center;gap:5px;background:none;border:none;padding:2px 0;color:var(--text-2);font-size:13px;cursor:pointer;white-space:nowrap;text-decoration:none;align-self:flex-start;}
.panel-link:hover{color:var(--text);}
.panel-head .panel-link{align-self:center;}
.panel-copy{font-size:14.5px;line-height:1.6;color:var(--text-2);}
.narrative{font-family:var(--f-display);font-size:19px;line-height:1.55;color:var(--text);margin-bottom:8px;}
.big-num{font-family:var(--f-display);font-size:36px;font-weight:500;color:var(--text);line-height:1.1;margin-bottom:6px;font-variant-numeric:lining-nums tabular-nums;}

.directive-strip{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px 22px;align-items:center;padding:16px 20px;border:1px solid var(--uc,var(--line-strong));border-radius:4px;background:var(--panel);position:relative;}
.directive-strip::before{content:'';position:absolute;top:-1px;left:-1px;bottom:-1px;width:3px;background:var(--uc,var(--platinum));border-radius:4px 0 0 4px;}
.ds-meta{display:flex;flex-direction:column;gap:8px;align-items:flex-start;}
.ds-kicker{font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;white-space:nowrap;}
.ds-text{font-family:var(--f-display);font-size:23px;font-weight:500;color:var(--text);line-height:1.3;}
.ds-reason{font-size:14.5px;color:var(--text-2);line-height:1.6;margin-top:4px;}
.ds-actions{display:flex;align-items:center;}
.directive-strip.compact{grid-template-columns:minmax(0,1fr);gap:8px;padding:14px 16px;}
.directive-strip.compact .ds-meta{flex-direction:row;align-items:center;gap:10px;}
.directive-strip.compact .ds-text{font-size:21px;}
.alert-row{display:flex;flex-direction:column;gap:8px;}

.kpi-row{display:grid;grid-template-columns:minmax(0,1.5fr) repeat(5,minmax(0,1fr));gap:12px;}
.kpi-row.data-thin{padding:8px;}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:14px 16px;min-width:0;position:relative;display:flex;flex-direction:column;}
.kpi.kpi-lead{background:var(--panel-2);border-color:var(--line-strong);}
.kpi.kpi-lead::before{content:'';position:absolute;top:-1px;left:-1px;right:-1px;height:2px;background:var(--sev,var(--platinum));border-radius:4px 4px 0 0;}
.kpi-lbl{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:22px;font-size:13px;font-weight:600;color:var(--text-2);}
.kpi-val{font-family:var(--f-display);font-size:34px;font-weight:500;line-height:1.1;margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:lining-nums tabular-nums;}
.kpi.kpi-lead .kpi-val{font-size:56px;}
.kpi-unit{font-size:0.45em;color:var(--text-3);margin-left:4px;}
.kpi-sub{font-size:13px;color:var(--text-2);line-height:1.5;margin-top:6px;}
.kpi.kpi-lead .kpi-sub{font-size:14px;}

.chart-legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:12px;font-size:13px;color:var(--text-2);}
.chart-legend span{display:inline-flex;align-items:center;gap:7px;}
.chart-legend i{width:10px;height:10px;border-radius:2px;display:inline-block;}
.chart-summary{display:flex;flex-wrap:wrap;gap:6px 22px;margin-bottom:12px;font-size:13px;color:var(--text-3);}
.chart-summary b{font-family:var(--f-num);font-weight:500;color:var(--text);margin-left:6px;font-variant-numeric:tabular-nums;}

.traj-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.traj-cell{display:flex;align-items:center;gap:12px;min-width:0;}
.traj-lbl{font-family:var(--f-display);font-size:21px;font-weight:500;color:var(--text);line-height:1.2;}
.traj-note{font-size:14px;color:var(--text-2);line-height:1.55;margin-top:12px;}
.traj-note:empty{display:none;}
.mini-list{list-style:none;display:flex;flex-direction:column;}
.mini-list li{display:flex;align-items:baseline;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);min-width:0;}
.mini-list li:last-child{border-bottom:none;}
.mini-list li.mini-stack{flex-direction:column;align-items:stretch;gap:3px;}
.mini-main{flex:1;min-width:0;font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mini-stack .mini-main{white-space:normal;font-family:var(--f-display);font-size:17px;line-height:1.35;}
.mini-date{font-family:var(--f-num);font-size:12px;color:var(--text-3);flex-shrink:0;}
.mini-amt{font-family:var(--f-num);font-size:13px;color:var(--text);flex-shrink:0;font-variant-numeric:tabular-nums;}
.mini-foot{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:13px;color:var(--text-2);}
.bar-row-lbl{display:flex;justify-content:space-between;gap:10px;font-size:14px;color:var(--text-2);margin-bottom:5px;}
.bar-row-lbl span:last-child{font-family:var(--f-num);font-size:13px;}
.bar-track{display:block;height:8px;background:var(--line);border-radius:4px;overflow:hidden;}
.bar-track > *{display:block;height:100%;}
.nudge-row{display:flex;align-items:center;justify-content:space-between;gap:16px 24px;flex-wrap:wrap;padding:18px 20px;background:var(--panel);border:1px solid var(--line);border-radius:4px;}
.nudge-row-title{font-family:var(--f-display);font-size:21px;font-weight:500;color:var(--text);}
.nudge-row-sub{font-size:14.5px;color:var(--text-2);line-height:1.6;margin-top:4px;max-width:660px;}

.tbl-wrap{overflow:auto;min-width:0;}
.tbl{width:100%;border-collapse:collapse;font-size:14px;}
.tbl th{text-align:left;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-3);padding:9px 12px;border-bottom:1px solid var(--line-strong);background:var(--panel);position:sticky;top:0;white-space:nowrap;}
.tbl td{padding:10px 12px;border-bottom:1px solid var(--line);color:var(--text);vertical-align:top;}
.tbl tfoot th,.tbl tfoot td{border-top:1px solid var(--line-strong);border-bottom:none;font-weight:600;position:static;}
.tbl tbody tr:hover td{background:var(--panel-2);}
.tbl .num{text-align:right;font-family:var(--f-num);font-size:13.5px;white-space:nowrap;font-variant-numeric:tabular-nums;}
.tbl .mono{font-family:var(--f-num);font-size:13px;color:var(--text-2);white-space:nowrap;}
.tbl .muted{color:var(--text-2);}
.tx-tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;}
.tx-sum{font-family:var(--f-num);font-size:13px;color:var(--text-2);margin-left:auto;}
.busy-line{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:14px;color:var(--text-2);}
.batch-list{list-style:none;display:flex;flex-direction:column;max-height:340px;overflow-y:auto;}
.batch-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line);}
.batch-list li:last-child{border-bottom:none;}
.batch-name{font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.batch-meta{font-family:var(--f-num);font-size:12px;color:var(--text-3);margin-top:3px;line-height:1.5;}
.input-grid-4{grid-template-columns:repeat(4,minmax(0,1fr));}
.details-summary{cursor:pointer;font-size:14.5px;color:var(--text-2);line-height:1.5;}
.details-summary:hover{color:var(--text);}
.kv{display:grid;grid-template-columns:auto 1fr;gap:9px 16px;font-size:14px;}
.kv dt{color:var(--text-2);}
.kv dd{color:var(--text);text-align:right;font-family:var(--f-num);font-size:13.5px;font-variant-numeric:tabular-nums;}
.kv-wide dd{text-align:left;}
.week-list{list-style:none;display:flex;flex-direction:column;gap:7px;}
.week-list li{display:grid;grid-template-columns:48px minmax(0,1fr) 92px;align-items:center;gap:10px;}
.week-list .mini-amt{text-align:right;}
.week-bar{height:10px;}
.scenario-cell{background:var(--panel-2);border:1px solid var(--line);border-radius:3px;padding:12px 14px;min-width:0;}
.scenario-before{font-family:var(--f-num);font-size:13px;color:var(--text-3);margin-top:6px;}
.scenario-after{font-family:var(--f-num);font-size:17px;margin-top:2px;overflow-wrap:anywhere;}
.form-stack{display:flex;flex-direction:column;gap:14px;}
.faq-list{display:flex;flex-direction:column;}
.faq-d{border-bottom:1px solid var(--line);padding:13px 0;}
.faq-d:last-child{border-bottom:none;}
.faq-d summary{cursor:pointer;font-size:15px;font-weight:600;color:var(--text);line-height:1.45;}
.faq-d summary:hover{color:var(--platinum-hi);}
.faq-d p{font-size:15px;line-height:1.7;color:var(--text-2);margin-top:8px;}
.report-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:12px;border-bottom:1px solid var(--line);}
.report-title{font-family:var(--f-display);font-size:28px;font-weight:500;color:var(--text);}
.log-list{list-style:none;display:flex;flex-direction:column;gap:14px;}
.log-list li{border-left:3px solid var(--platinum);padding:2px 0 14px 14px;border-bottom:1px solid var(--line);}
.log-list li:last-child{border-bottom:none;padding-bottom:2px;}
.log-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;}
.log-text{font-family:var(--f-display);font-size:19px;font-weight:500;color:var(--text);line-height:1.4;}
.log-meta{font-size:14px;color:var(--text-2);margin-top:4px;line-height:1.55;}

/* ── Responsive ── */
/* Six KPI tiles across need about 1,040px of content width to hold the
   widest values at full size (measured, not estimated). Below that they
   wrap to two rows of three rather than shrinking. */
@media(max-width:1320px){
  .kpi-row{grid-template-columns:repeat(3,minmax(0,1fr));}
}
@media(max-width:1100px){
  .hdr-who,.hdr-chev,.hdr-kbd{display:none;}
  .row-3{grid-template-columns:repeat(2,minmax(0,1fr));}
  .input-grid-4{grid-template-columns:repeat(2,minmax(0,1fr));}
  .mk-hero-grid{grid-template-columns:minmax(0,1fr);gap:48px;}
  .mk-lead{max-width:640px;}
  .mk-cap.wide,.mk-cap.narrow,.mk-cap{grid-column:1/-1;}
  .mk-supporting{grid-template-columns:repeat(2,minmax(0,1fr));}
  .mk-supporting > div:nth-child(3){padding-left:0;border-left:none;}
  .mk-prices{grid-template-columns:minmax(0,1fr);max-width:560px;margin:0 auto;}
  .mk-price-for{min-height:0;}
  .mk-footer-grid{grid-template-columns:repeat(3,minmax(0,1fr));}
  .mk-footer-brand{grid-column:1/-1;}
}
/* Below 960px the sidebar becomes a drawer opened from the header. */
@media(max-width:960px){
  .g2,.g21,.input-grid{grid-template-columns:1fr;}
  .kpi4,.kpi3,.g3{grid-template-columns:1fr 1fr;}
  .app{grid-template-columns:minmax(0,1fr);}
  .app-header{padding:0 12px;gap:10px;}
  .hdr-menu{display:flex;}
  .app-crumb{display:none;}
  .app-brand{width:auto;border-right:none;padding:0;align-self:center;}
  .app-side{position:fixed;top:60px;left:0;bottom:0;width:min(290px,86vw);height:auto;z-index:240;transform:translateX(-100%);visibility:hidden;transition:transform 0.2s ease,visibility 0s linear 0.2s;box-shadow:24px 0 48px -24px rgba(0,0,0,0.8);}
  /* Visible at once on open, so the first link can take focus; hidden only after the slide-out on close. */
  .app-side.open{transform:none;visibility:visible;transition:transform 0.2s ease,visibility 0s;}
  .side-backdrop{display:block;position:fixed;top:60px;left:0;right:0;bottom:0;z-index:230;background:rgba(13,13,15,0.6);}
  .app-main{grid-column:1;padding:16px 16px 32px;}
  .row-21,.row-12,.row-2{grid-template-columns:minmax(0,1fr);}
  .directive-strip{grid-template-columns:minmax(0,1fr);}
  .ds-meta{flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap;}
  .ai-rec-field{grid-template-columns:minmax(0,1fr);gap:6px;}
  .mk-nav-links,.mk-nav-actions .btn-ghost{display:none;}
  .mk-burger{display:flex;}
  .mk-outcomes,.mk-steps{grid-template-columns:minmax(0,1fr);}
  .mk-outcome,.mk-step{padding:28px 0 4px!important;border-left:none!important;}
  .mk-outcome + .mk-outcome,.mk-step + .mk-step{border-top:1px solid var(--line);}
  .mk-example{grid-template-columns:minmax(0,1fr);gap:12px;}
  .mk-arrow{transform:rotate(90deg);height:32px;}
  .mk-brief{grid-template-columns:minmax(0,1fr);}
  .mk-brief > div{border-right:none!important;}
}
/* Phones: search moves behind a header button and opens as a full-width row. */
@media(max-width:720px){
  .hdr-search{display:none;}
  .hdr-search.open{display:block;position:fixed;top:60px;left:0;right:0;max-width:none;padding:10px 12px;background:var(--bg);border-bottom:1px solid var(--line);z-index:220;}
  .hdr-search.open .hdr-search-icon{left:23px;}
  .hdr-search-toggle{display:flex;}
  .kpi-row{grid-template-columns:repeat(2,minmax(0,1fr));}
  .kpi.kpi-lead{grid-column:1/-1;}
  .row-3{grid-template-columns:minmax(0,1fr);}
  .tx-sum{margin-left:0;}
  .di,.fi,.hdr-search-input,.hdr-select{font-size:16px;}
  .mk-supporting{grid-template-columns:minmax(0,1fr);}
  .mk-supporting > div{padding:22px 0 0!important;border-left:none!important;}
  .mk-faq details p{padding-right:0;}
  .mk-footer-grid{grid-template-columns:repeat(2,minmax(0,1fr));}
}
@media(max-width:600px){
  .kpi4,.kpi3,.g3{grid-template-columns:1fr;}
}
@media(max-width:520px){
  :root{--gutter:20px;}
  .app-brand .brand-name{display:none;}
  .hdr-select{max-width:118px;}
  .hdr-tools{gap:8px;}
  .page-h1{font-size:28px;}
  .mk-nav-in .brand-name{font-size:16px;letter-spacing:0.12em;}
  .mk-nav-actions .btn-primary{display:none;}
  .ledger-rule.start::after{display:none;}
  .mk-cta-row .btn{flex:1 1 100%;}
  .mk-cap,.mk-example-col,.mk-price{padding:24px 20px;}
  .mk-demo-kpis,.mk-cap-figures{grid-template-columns:minmax(0,1fr);}
}

/* Printing the Reports page prints only the report, black on white. */
@media print{
  body{background:#fff!important;}
  body *{visibility:hidden;}
  .print-area,.print-area *{visibility:visible;}
  .print-area{position:absolute;left:0;top:0;width:100%;border:none!important;background:#fff!important;padding:0!important;}
  .print-area .row{grid-template-columns:1fr!important;}
  .print-area *{color:#000!important;background:#fff!important;border-color:#bbb!important;}
  .app-header,.app-side,.activation-banner{display:none!important;}
}

`;

// ─── KEYBOARD-OPERABLE NON-BUTTON CONTROLS ──────────────────────
// Several controls are styled divs/spans rather than <button> elements.
// A bare onClick on a div is mouse-only: it is not focusable and Enter or
// Space never reaches it, so keyboard and screen-reader users cannot use
// the control at all (WCAG 2.1.1, Level A). Spread these props onto any
// non-button element that carries an onClick so it becomes focusable and
// responds to Enter and Space exactly as the click does.
function clickableProps(fn, { label, disabled = false } = {}) {
  if (disabled) return { "aria-disabled": true };
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: fn,
    onKeyDown: e => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        fn(e);
      }
    },
  };
}

// ─── AI ADVISOR RECOMMENDATION ──────────────────────────────────
// Renders the model's response as a memo: What Happened, Why, Business
// Impact, Recommended Action, Expected Outcome, then Risk and Confidence,
// as real React text, never raw HTML. The model's output is untrusted
// content; dangerouslySetInnerHTML would execute anything it contained.
// Red appears only when the risk level itself calls for it.
const RISK_CHIP_COLOR = { Critical: C.danger, Elevated: C.warning, Watch: C.platinum, Low: C.positive };

function AIRecommendation({ rec }) {
  const riskColor = RISK_CHIP_COLOR[rec.riskLevel] || C.text3;
  const score = Number(rec.confidenceScore);
  const fields = [
    { key:"whatHappened",      lbl:"What happened" },
    { key:"whyItHappened",     lbl:"Why it happened" },
    { key:"businessImpact",    lbl:"Business impact" },
    { key:"recommendedAction", lbl:"Recommended action", action:true },
    { key:"expectedOutcome",   lbl:"Expected outcome" },
  ];
  return (
    <div>
      {fields.map(f => rec[f.key] && (
        <div className={`ai-rec-field${f.action ? " action" : ""}`} key={f.key}>
          <div className="ai-rec-lbl" style={{ color: f.action ? C.platinum : C.text3 }}>{f.lbl}</div>
          <div className="ai-rec-body">{rec[f.key]}</div>
        </div>
      ))}
      <div className="ai-rec-footer">
        <span className="ai-rec-chip" style={{ color:riskColor, background:`color-mix(in srgb, ${riskColor} 14%, transparent)` }}>{rec.riskLevel || "Unknown"} risk</span>
        <span className="ai-rec-conf">
          Confidence {Number.isFinite(score) ? `${score}/100` : "not stated"}
          {Number.isFinite(score) && <span className="ai-conf-meter" aria-hidden="true"><span style={{ width:`${Math.max(0, Math.min(100, score))}%` }}/></span>}
          {rec.confidenceReason && <span>{rec.confidenceReason}</span>}
        </span>
      </div>
    </div>
  );
}

// ─── METRIC CONFIDENCE ──────────────────────────────────────────
// Renders nothing for a high-confidence metric: the caveat only earns its
// place on screen when the number genuinely needs one. Set at 12px in the
// muted text token, which keeps AA contrast on every panel.
function ConfidenceLine({ c }) {
  if (!c) return null;
  if (c.shown && c.level === "high") return null;
  const label = c.shown ? `${capitalize(c.level)} confidence` : "Not enough data";
  return (
    <div style={{ fontSize:12, color:C.text3, marginTop:6, lineHeight:1.5 }}>
      <span style={{ fontWeight:600, color:C.text2 }}>{label}:</span> {c.reason}
    </div>
  );
}

// ─── SEVERITY TAG ─────────────────────────────────────────────
// Every colour-coded state carries an explicit text label riding with it:
// colour alone fails accessibility and fails the instant someone
// screenshots in greyscale.
const SEVERITY_STYLE = {
  critical: { text:"Critical", color:C.danger },
  warning:  { text:"Warning",  color:C.warning },
  positive: { text:"Healthy",  color:C.positive },
  neutral:  { text:"Stable",   color:C.platinum },
};
function SeverityTag({ level, label }) {
  const s = SEVERITY_STYLE[level] || SEVERITY_STYLE.neutral;
  return (
    <span className="severity-tag" style={{ color:s.color, background:`color-mix(in srgb, ${s.color} 14%, transparent)` }}>
      {label || s.text}
    </span>
  );
}

// ─── LOADING SKELETONS ────────────────────────────────────────
// Holds the exact shape of the content about to arrive, so nothing jumps
// once real data lands.
function SkeletonKPIRow() {
  return (
    <div className="kpi-row" aria-busy="true" aria-label="Loading your financial position">
      {[0, 1, 2, 3, 4, 5].map(i => (
        <div className="kpi" key={i} style={{ minHeight:120 }}>
          <div className="skel" style={{ width:"55%", height:10, marginBottom:16 }}/>
          <div className="skel" style={{ width:i === 0 ? "70%" : "60%", height:i === 0 ? 44 : 30, marginBottom:12 }}/>
          <div className="skel" style={{ width:"45%", height:10 }}/>
        </div>
      ))}
    </div>
  );
}

// ─── RING CHART ───────────────────────────────────────────────
// Colours go through style, not SVG attributes: presentation attributes
// cannot read CSS variables.
function Ring({ score, size = 100, sw = 6 }) {
  const s = safe(score);
  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;
  const fill = (s / 100) * circ;
  const col  = s > 70 ? C.platinum : s > 40 ? C.warning : C.danger;
  return (
    <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform:"rotate(-90deg)" }} aria-hidden="true">
        <circle cx={size/2} cy={size/2} r={r} fill="none" strokeWidth={sw} style={{ stroke:C.line }}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" strokeWidth={sw}
          strokeDasharray={circ} strokeDashoffset={circ - fill} strokeLinecap="butt"
          style={{ stroke:col, transition:"stroke-dashoffset 1s ease, stroke 0.5s" }}/>
      </svg>
      <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
        <div style={{ fontFamily:"var(--f-display)", fontSize:size > 80 ? 26 : 22, fontWeight:500, color:C.text, lineHeight:1, fontVariantNumeric:"lining-nums" }}>{Math.round(s)}</div>
        <div style={{ fontSize:11, color:C.text3, fontFamily:"var(--f-num)" }}>/100</div>
      </div>
    </div>
  );
}

// ─── CASH IN AND CASH OUT ─────────────────────────────────────
// Money received against money spent, per month, from actual transactions
// in the business currency. Both series share one scale, so a month whose costs beat its
// income is drawn taller, not clipped. History only: projections live
// under Forecasts, never mixed into this chart.
function BChart({ data, compact = false, currency }) {
  if (!data || data.length === 0) return (
    <div className="panel-copy" style={{ textAlign:"center", padding:"36px 0" }}>Connect data to see money in and out.</div>
  );
  const maxV = Math.max(...data.map(d => Math.max(d.revenue || 0, d.expenses || 0)), 1);
  const H = compact ? 100 : 150;
  const totIn = data.reduce((s, d) => s + (d.revenue || 0), 0);
  const totOut = data.reduce((s, d) => s + (d.expenses || 0), 0);
  const net = totIn - totOut;
  const last = data[data.length - 1];
  return (
    <div>
      {!compact && (
        <div className="chart-summary">
          <span>In<b>{fmt(totIn, currency)}</b></span>
          <span>Out<b>{fmt(totOut, currency)}</b></span>
          <span>Net<b style={{ color: net >= 0 ? C.positive : C.danger }}>{fmt(net, currency)}</b></span>
          <span>Peak month<b>{fmt(maxV, currency)}</b></span>
        </div>
      )}
      <div style={{ display:"flex", alignItems:"flex-end", gap: data.length > 18 ? 3 : 8, height:H + 24 }} role="img"
        aria-label={`Money in and out by month, ${data[0].month} to ${last.month}. Total in ${fmt(totIn, currency)}, total out ${fmt(totOut, currency)}. Latest month, ${last.month}: in ${fmt(last.revenue, currency)}, out ${fmt(last.expenses, currency)}.`}>
        {data.map((d, i) => (
          <div key={i} title={`${d.month}: in ${fmt(d.revenue, currency)}, out ${fmt(d.expenses, currency)}, net ${fmt((d.revenue || 0) - (d.expenses || 0), currency)}`}
            style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", alignItems:"center", gap:6, height:"100%", justifyContent:"flex-end" }}>
            <div style={{ display:"flex", gap:3, alignItems:"flex-end", height:H, width:"100%", justifyContent:"center" }}>
              <div style={{ width:"42%", maxWidth:24, minHeight:2, height:`${(d.revenue / maxV) * H}px`, background:C.platinum, borderRadius:"2px 2px 0 0" }}/>
              <div style={{ width:"42%", maxWidth:24, minHeight:2, height:`${(d.expenses / maxV) * H}px`, background:C.pewter, borderRadius:"2px 2px 0 0" }}/>
            </div>
            <span style={{ fontSize:12, color:C.text3, fontFamily:"var(--f-num)", whiteSpace:"nowrap", overflow:"hidden", maxWidth:"100%" }}>{data.length > 12 && i % 2 ? "" : d.month}</span>
          </div>
        ))}
      </div>
      <div className="chart-legend">
        <span><i style={{ background:C.platinum }}/>Money in</span>
        <span><i style={{ background:C.pewter }}/>Money out</span>
        {!compact && <span style={{ marginLeft:"auto", color:C.text3 }}>Actual history from your transactions{currency ? `, ${currency}` : ""}</span>}
      </div>
    </div>
  );
}

// ─── DECISION DIRECTIVE ───────────────────────────────────────
// The actual decision logic lives in computeDirective() (financials.js) —
// shared with Dashboard's persistence path so what's rendered here and
// what's written to the `directives` table can never drift apart.
const DIRECTIVE_SEVERITY_TAG = { critical:"critical", warn:"warning", go:"positive", stable:"neutral" };

// A single horizontal banner: severity and label on the left, the call and
// its reason in the middle, an action on the right. The decision logic lives
// in computeDirective() (financials.js) — the Dashboard computes it once and
// both this banner and the persisted decision log read the same object.
function DirectiveStrip({ d, children, compact = false }) {
  const uc = { critical:C.danger, warn:C.warning, go:C.positive, stable:C.platinum }[d.severity];
  // Critical calls get a heavier frame, not just a red hue — weight carries
  // severity too, so it survives greyscale.
  return (
    <section className={`directive-strip${compact ? " compact" : ""}`} style={{ "--uc":uc, borderWidth: d.severity === "critical" ? 2 : 1 }} aria-label="This week's directive">
      <div className="ds-meta">
        <div className="ds-kicker" style={{ color:uc }}>This week's directive</div>
        <SeverityTag level={DIRECTIVE_SEVERITY_TAG[d.severity]}/>
      </div>
      <div style={{ minWidth:0 }}>
        <div className="ds-text">{d.text}</div>
        {!compact && <div className="ds-reason">
          {d.reason}
          {d.wasCapped && " This is based on a single month of data. Treat it as an early warning, not a confirmed crisis, until more history confirms it."}
        </div>}
      </div>
      {children && <div className="ds-actions">{children}</div>}
    </section>
  );
}

// ─── CURRENCY ─────────────────────────────────────────────────
// A business keeps its books in one currency. Nothing here converts: a
// transaction in another currency is stored as it arrived and left out of
// the figures, and the founder is told so.
function CurrencySelect({ id, value, onChange, compact = false, ariaLabel, style }) {
  const known = SUPPORTED_CURRENCIES.some(c => c.code === value);
  return (
    <select id={id} className="di" value={value || ""} aria-label={ariaLabel} onChange={e => onChange(e.target.value)}
      style={compact ? { width:92, flex:"0 0 auto", ...style } : { maxWidth:320, ...style }}>
      {!value && <option value="" disabled>Choose a currency</option>}
      {SUPPORTED_CURRENCIES.map(c => <option key={c.code} value={c.code}>{compact ? c.code : `${c.name} (${c.code})`}</option>)}
      {value && !known && <option value={value}>{value}</option>}
    </select>
  );
}

function CurrencyPrompt({ onSave }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true); setErr("");
    const ok = await onSave(code);
    setBusy(false);
    if (!ok) setErr("Your business currency could not be saved. Nothing was changed, so try again.");
  };
  return (
    <Panel title="Choose your business currency">
      <p className="panel-copy">Every figure is shown in the currency your business keeps its books in. Command Ledger never converts between currencies, so choose this before you upload.</p>
      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop:12 }}>
        <CurrencySelect id="base-currency" ariaLabel="Business currency" value={code} onChange={setCode}/>
        <button className="btn btn-primary btn-md" disabled={!code || busy} onClick={save}>{busy ? "Saving..." : "Save"}</button>
      </div>
      {err && <div className="d-alert crit" role="alert" style={{ marginTop:12 }}>{err}</div>}
    </Panel>
  );
}

function CurrencyNotice({ cur, excluded, onReview }) {
  if (!cur || !excluded || excluded.length === 0) return null;
  const total = excluded.reduce((sum, e) => sum + e.count, 0);
  const detail = excluded.map(e => `${e.count.toLocaleString()} in ${e.currency === "unlabelled" ? "no stated currency" : e.currency}`).join(", ");
  return (
    <div className="d-alert warn" role="status" style={{ justifyContent:"space-between", alignItems:"center", flexWrap:"wrap" }}>
      <span>{total.toLocaleString()} transaction{total === 1 ? " is" : "s are"} not included in your figures ({detail}). Your business currency is {cur}, and Command Ledger does not convert between currencies.</span>
      {onReview && <button className="panel-link" onClick={onReview}>Review uploads<Icon name="arrow" size={14}/></button>}
    </div>
  );
}

// A form label with the business currency's symbol: "Cash balance (R)".
const withSymbol = (label, cur) => cur ? `${label} (${currencySymbol(cur)})` : label;

// ─── DATA UPLOAD ──────────────────────────────────────────────
function DataUpload({ onDataLoaded, hasData, currency }) {
  const [drag,    setDrag]    = useState(false);
  const [parsing, setParsing] = useState(false);
  const [err,     setErr]     = useState("");
  const [csvUrl,  setCsvUrl]  = useState("");
  const [syncing, setSyncing] = useState(false);
  // The currency this file's amounts are in. It starts as the business
  // currency; with none chosen yet, the founder must pick, and that choice
  // becomes the business currency.
  const [fileCur, setFileCur] = useState(currency || "");
  useEffect(() => { if (currency) setFileCur(c => c || currency); }, [currency]);
  const fileRef = useRef(null);

  const processCSVText = (text, source) => {
    const result = parseAnyCSV(text, { currency: fileCur });
    if (!result || result.rows.length === 0) {
      setErr(`No readable financial data in ${fileCur} found. Ensure the file has at minimum a Revenue or Amount column.`);
      return false;
    }
    setErr("");
    onDataLoaded(result.rows, source, result.detectedFields, text, fileCur);
    return true;
  };
  const needCurrency = () => {
    if (fileCur) return false;
    setErr("Choose the currency this file is in first.");
    return true;
  };

  const handleFile = async (file) => {
    if (!file || needCurrency()) return;
    setErr(""); setParsing(true);
    const ext = file.name.split(".").pop().toLowerCase();
    try {
      if (ext === "csv") {
        const text = await file.text();
        processCSVText(text, file.name);
      } else if (["xlsx","xls"].includes(ext)) {
        const XLSX = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb  = XLSX.read(buf, { type:"array" });
        const ws  = wb.Sheets[wb.SheetNames[0]];
        const csv = XLSX.utils.sheet_to_csv(ws);
        processCSVText(csv, file.name);
      } else {
        setErr("Only CSV and Excel (.xlsx, .xls) files are accepted.");
      }
    } catch (e) {
      setErr("Could not read this file. Check it is not password-protected.");
    }
    setParsing(false);
  };

  const syncSheet = async () => {
    if (!csvUrl.trim() || needCurrency()) return;
    setSyncing(true); setErr("");
    try {
      const url = csvUrl + (csvUrl.includes("?") ? "&" : "?") + "nocache=" + Date.now();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const text = await res.text();
      processCSVText(text, "Google Sheets");
    } catch (e) {
      setErr("Sync failed. Ensure the sheet is published as CSV (File > Share > Publish to web > CSV).");
    }
    setSyncing(false);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div className="input-group" style={{ marginBottom:0 }}>
        <label className="di-lbl" htmlFor="file-currency">Amounts in this file are in</label>
        <CurrencySelect id="file-currency" value={fileCur} onChange={v => { setFileCur(v); setErr(""); }}/>
        <p className="panel-copy" style={{ marginTop:6 }}>
          {currency
            ? (fileCur && fileCur !== currency
                ? `Your business currency is ${currency}. Transactions in ${fileCur} are stored, but not added to your figures, because Command Ledger never converts between currencies.`
                : "Rows marked with another currency, such as $ or USD, keep that currency and are not added to your figures.")
            : "This also sets your business currency, the one every figure is shown in. You can change it later in Settings."}
        </p>
      </div>
      <div
        className={`drop-zone${drag ? " drag" : ""}`}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
        {...clickableProps(() => fileRef.current?.click(), { label:"Choose a financial file to upload" })}
      >
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display:"none" }} onChange={e => handleFile(e.target.files[0])}/>
        <div className="drop-zone-title">{parsing ? "Reading your file..." : "Drop your financial file here"}</div>
        <div className="drop-zone-sub">
          Accepts Excel (.xlsx) or CSV from QuickBooks, Xero, Wave, or any spreadsheet.<br/>
          Any column structure is automatically detected and mapped.
        </div>
        {parsing && <div style={{ marginTop:16, display:"flex", justifyContent:"center" }}><span className="spinner"/></div>}
      </div>

      <div className="g3" style={{ gap:10 }}>
        {[
          { name:"QuickBooks", hint:"Reports > Export to Excel or CSV" },
          { name:"Xero",       hint:"Reports > Export as CSV" },
          { name:"Wave",       hint:"Reports > Download CSV" },
        ].map((a, i) => (
          <div key={i} style={{ background:C.panel2, border:`1px solid ${C.line}`, padding:"12px 14px" }}>
            <div style={{ fontSize:12, color:C.text, fontWeight:600, marginBottom:2 }}>{a.name}</div>
            <div style={{ fontSize:10, color:C.text3, lineHeight:1.5 }}>{a.hint}</div>
          </div>
        ))}
      </div>

      <div style={{ background:C.panel2, border:`1px solid ${C.line}`, padding:"16px 18px" }}>
        <div className="di-lbl" style={{ marginBottom:10 }}>Live Google Sheets Sync</div>
        <div style={{ display:"flex", gap:8 }}>
          <input className="di" placeholder="Paste your published CSV link..." value={csvUrl} onChange={e => setCsvUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && syncSheet()}/>
          <button className="btn btn-gold" style={{ padding:"8px 18px", whiteSpace:"nowrap", fontSize:11 }} onClick={syncSheet} disabled={syncing || !csvUrl.trim()}>
            {syncing ? <span className="spinner"/> : "Sync"}
          </button>
        </div>
      </div>

      {err && <div className="d-alert crit">{err}</div>}
      {hasData && (
        <div className="upload-ok">
          <div style={{ width:8, height:8, borderRadius:"50%", background:C.positive, flexShrink:0 }}/>
          <div className="upload-ok-txt">Data connected. Your dashboard is reading your real numbers.</div>
        </div>
      )}
    </div>
  );
}

// ─── PAY MODAL ────────────────────────────────────────────────
// A customer sees the same neutral message whatever blocked checkout. The
// specific reason is logged for us; it is not something to make a buyer
// doubt the product over.
const CHECKOUT_UNAVAILABLE = "Online checkout for this plan is not open right now. Nothing has been charged.";

function PayModal({ planKey, currentPlanKey, userEmail, userId, onClose, onSuccess }) {
  const plan = planOf(planKey);
  const resolvedKey = resolvePlanKey(planKey);
  // An existing subscriber buying a different plan: paypal-webhook cancels
  // the old subscription once this one is active, and the buyer is told so
  // before paying.
  const replaces = currentPlanKey && resolvePlanKey(currentPlanKey) !== resolvedKey ? planOf(currentPlanKey) : null;
  // What PayPal will actually bill for this plan, read live by the plan-pricing
  // Edge Function. Checkout stays closed until that arrives and every charge,
  // starting with the first, agrees with the price on this page. A visible
  // refusal is the cheap outcome; a wrong charge is not.
  const [verified,  setVerified]  = useState(null);
  const [verifying, setVerifying] = useState(true);
  const blockReason = verifying ? null : checkoutBlockReason(plan, verified);
  const canCheckout = !verifying && !blockReason;
  const btnRef   = useRef(null);
  const rendered = useRef(false);
  const [sdkReady, setSdkReady] = useState(false);
  const [sdkErr,   setSdkErr]   = useState("");
  const [done,     setDone]     = useState(false);
  const dialogRef = useRef(null);

  // onClose is passed as an inline arrow, so its identity changes on every
  // parent render. Hold it in a ref so the effect below can mount exactly
  // once and still call the current handler.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Escape closes the checkout dialog and focus moves into it on open, so a
  // keyboard user is not left operating the page behind the overlay. This runs
  // on mount only: re-focusing on every render would pull focus out of the
  // PayPal field mid-entry. Focus is deliberately not trapped inside, because
  // PayPal renders its button into a cross-origin iframe and cycling Tab
  // across that boundary is unreliable.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = e => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setVerifying(true);
    supabase.functions.invoke("plan-pricing", { body: { planKey: resolvedKey } })
      .then(({ data, error }) => { if (!cancelled) setVerified(error ? null : data); })
      .catch(() => { if (!cancelled) setVerified(null); })
      .finally(() => { if (!cancelled) setVerifying(false); });
    return () => { cancelled = true; };
  }, [resolvedKey]);

  useEffect(() => {
    if (blockReason) console.warn("Checkout blocked:", blockReason, verified);
  }, [blockReason, verified]);

  useEffect(() => {
    if (!canCheckout) return;
    rendered.current = false;
    const old = document.getElementById("pp-sdk");
    if (old) old.remove();
    window.paypal = undefined;

    const s = document.createElement("script");
    s.id  = "pp-sdk";
    s.src = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&vault=true&intent=subscription&currency=USD`;
    s.setAttribute("data-sdk-integration-source", "button-factory");
    s.onload  = () => setSdkReady(true);
    s.onerror = () => setSdkErr("PayPal failed to load. Check your internet connection.");
    document.head.appendChild(s);
  }, [planKey, canCheckout]);

  useEffect(() => {
    if (!canCheckout) return;
    if (!sdkReady || !btnRef.current || rendered.current) return;
    if (!window.paypal) { setSdkErr("PayPal SDK unavailable."); return; }
    rendered.current = true;
    btnRef.current.innerHTML = "";

    window.paypal.Buttons({
      style: { color:"gold", shape:"rect", label:"subscribe", layout:"vertical" },
      createSubscription: (_d, actions) =>
        actions.subscription.create({
          plan_id:   verified.planId,
          custom_id: userId,
        }),
      onApprove: async () => {
        // Plan upgrade is handled server-side by the paypal-webhook Edge Function.
        // The browser only updates the UI — it no longer writes to the database.
        setDone(true);
        onSuccess(planKey);
      },
      onError: err => {
        console.error("PayPal error:", err);
        setSdkErr("Payment failed. Please try again.");
      },
    }).render(btnRef.current).catch(e => {
      setSdkErr(`PayPal could not render. Ensure your Plan IDs match your PayPal environment. Error: ${e.message}`);
    });
  }, [sdkReady, canCheckout]);

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pay-modal-title" tabIndex={-1} ref={dialogRef}>
        <div className="modal-head">
          <div className="modal-title" id="pay-modal-title">{done ? "Subscription Active" : "Start Your Subscription"}</div>
          <button className="modal-x" onClick={onClose} aria-label="Close">x</button>
        </div>
        <div className="modal-body">
          <div className="plan-badge">
            <div className="plan-badge-name">{plan.name}</div>
            <div className="plan-badge-price">US${plan.usd.toLocaleString()} <span style={{ fontSize:14, color:C.text3 }}>{plan.period}</span></div>
            <div className="plan-badge-sub">Billed monthly via PayPal. Cancel anytime.</div>
          </div>
          {replaces && !done && (
            <div className="d-alert info" style={{ marginBottom:16 }}>
              This replaces your {replaces.name} plan. Its US${replaces.usd.toLocaleString()}/month subscription is cancelled automatically once {plan.name} is active, so you are not billed for both. Charges already made are not refunded automatically.
            </div>
          )}

          {done ? (
            <div style={{ textAlign:"center", padding:"12px 0" }}>
              <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:24, color:C.text, marginBottom:12 }}>
                {plan.name} is now active
              </div>
              <div style={{ fontSize:13, color:C.text2, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.7, marginBottom:24 }}>
                Subscription confirmed. You will be billed US${plan.usd}/month. A receipt was sent to {userEmail}.
              </div>
              <button className="btn btn-full btn-primary" onClick={onClose}>Enter Dashboard</button>
            </div>
          ) : verifying ? (
            <div className="pay-status"><span className="spinner" style={{ display:"inline-block", marginBottom:8 }}/><br/>Confirming the price with PayPal...</div>
          ) : blockReason ? (
            <>
              <div className="pay-err">{CHECKOUT_UNAVAILABLE}</div>
              <div style={{ fontSize:13, color:C.text2, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.7, margin:"16px 0 20px" }}>
                Email us and we will set your subscription up directly.
              </div>
              <button
                className="btn btn-full btn-primary"
                onClick={() => window.open(`mailto:commandledger@gmail.com?subject=${encodeURIComponent(plan.name + " subscription")}`,"_blank")}
              >
                Email to subscribe
              </button>
            </>
          ) : (
            <>
              {!sdkReady && !sdkErr && (
                <div className="pay-status"><span className="spinner" style={{ display:"inline-block", marginBottom:8 }}/><br/>Loading PayPal...</div>
              )}
              {sdkErr && <div className="pay-err">{sdkErr}</div>}
              <div ref={btnRef} style={{ minHeight: sdkReady ? 50 : 0 }}/>
              {sdkReady && !sdkErr && (
                <div className="modal-secure">256-bit SSL. PayPal protected. Cancel anytime.</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── FINANCIAL DIAGNOSTIC CHECKOUT ────────────────────────────
// A one-time PayPal order, not a subscription. The order is created on the
// server at the server's price, and captured on the server, which checks the
// amount, currency and payer before recording it (diagnostic-order).
//
// Every outcome tells the buyer plainly whether money moved. The one that must
// never happen is telling a buyer "not charged" when they were: they pay again
// and are charged twice. So a capture that cannot be confirmed says "do not pay
// again", never "failed".
const DIAGNOSTIC_OUTCOME = {
  completed: {
    title: "Payment received",
    body: "Next, email your last twelve months of bank or accounting exports. You will receive the full analysis and a written findings memo.",
    action: "Email your exports",
  },
  pending: {
    title: "Payment processing",
    body: "PayPal is still clearing your payment. You will receive a PayPal receipt when it completes. You do not need to pay again.",
    action: "Email us",
  },
  review: {
    title: "Payment received, confirming",
    body: "We received your payment and need to confirm its details before starting. We will email you. Please do not pay again.",
    action: "Email us",
  },
  uncertain: {
    title: "We could not confirm your payment",
    body: "Your payment may have gone through. Please do not pay again. Email us and we will check it for you.",
    action: "Email us",
  },
};

function DiagnosticModal({ onClose }) {
  // phase: creating | ready | capturing | unavailable | failed | completed | pending | review | uncertain
  const [phase, setPhase] = useState("creating");
  const [order, setOrder] = useState(null);
  const [sdkReady, setSdkReady] = useState(false);
  const btnRef    = useRef(null);
  const rendered  = useRef(false);
  const dialogRef = useRef(null);
  const phaseRef  = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Closing while a capture is in flight would hide its result, and a buyer who
  // sees nothing assumes it failed. Every close path waits it out.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const requestClose = () => { if (phaseRef.current !== "capturing") onCloseRef.current(); };

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = e => { if (e.key === "Escape") requestClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The server creates the order and sets its amount. PayPal is shown only if
  // that amount is the one this page advertises.
  useEffect(() => {
    let cancelled = false;
    supabase.functions.invoke("diagnostic-order", { body: { action: "create" } })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data?.orderId && data.amountUsd === DIAGNOSTIC.usd && data.currency === "USD") {
          setOrder(data);
          setPhase("ready");
        } else {
          console.warn("Diagnostic checkout unavailable:", error || data);
          setPhase("unavailable");
        }
      })
      .catch(err => { if (!cancelled) { console.warn("Diagnostic checkout unavailable:", err); setPhase("unavailable"); } });
    return () => { cancelled = true; };
  }, []);

  // Loaded under its own namespace so it cannot clobber the subscription SDK
  // that PayModal loads as window.paypal with intent=subscription.
  useEffect(() => {
    if (phase !== "ready" || sdkReady) return;
    if (window.paypalOrders) { setSdkReady(true); return; }
    document.getElementById("pp-sdk-orders")?.remove();
    const s = document.createElement("script");
    s.id  = "pp-sdk-orders";
    s.src = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&intent=capture&currency=USD`;
    s.setAttribute("data-namespace", "paypalOrders");
    s.onload  = () => setSdkReady(true);
    s.onerror = () => setPhase("unavailable");
    document.head.appendChild(s);
  }, [phase, sdkReady]);

  useEffect(() => {
    if (phase !== "ready" || !sdkReady || !order || !btnRef.current || rendered.current) return;
    if (!window.paypalOrders) { setPhase("unavailable"); return; }
    rendered.current = true;
    btnRef.current.innerHTML = "";

    window.paypalOrders.Buttons({
      style: { color:"gold", shape:"rect", label:"pay", layout:"vertical" },
      // The order already exists, created on the server at the server's price.
      createOrder: () => order.orderId,
      onApprove: async (_data, actions) => {
        setPhase("capturing");
        try {
          const { data, error } = await supabase.functions.invoke("diagnostic-order", {
            body: { action: "capture", orderId: order.orderId },
          });
          if (error) throw error;
          if (data?.state === "not_captured") {
            // A declined card: PayPal lets the buyer choose another funding
            // source on the same order. Nothing was charged.
            if (data.issue === "INSTRUMENT_DECLINED") { setPhase("ready"); return actions.restart(); }
            setPhase("failed");
            return;
          }
          setPhase(DIAGNOSTIC_OUTCOME[data?.state] ? data.state : "uncertain");
        } catch (err) {
          console.error("Diagnostic capture could not be confirmed:", err);
          setPhase("uncertain");
        }
      },
      // Capture happens only in onApprove, on the server. A PayPal error before
      // then means this app never captured anything.
      onError: err => { console.error("PayPal error:", err); setPhase("failed"); },
    }).render(btnRef.current).catch(err => {
      console.error("PayPal buttons could not render:", err);
      setPhase("unavailable");
    });
  }, [phase, sdkReady, order]);

  const outcome = DIAGNOSTIC_OUTCOME[phase];
  const emailSubject = phase === "completed" ? "Financial Diagnostic exports" : "Financial Diagnostic payment";

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && requestClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="diag-modal-title" tabIndex={-1} ref={dialogRef}>
        <div className="modal-head">
          <div className="modal-title" id="diag-modal-title">{outcome ? outcome.title : DIAGNOSTIC.name}</div>
          <button className="modal-x" onClick={requestClose} aria-label="Close" disabled={phase === "capturing"}>x</button>
        </div>
        <div className="modal-body">
          {outcome ? (
            <div style={{ textAlign:"center", padding:"12px 0" }} role="status">
              <div style={{ fontSize:14, color:C.text2, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.7, marginBottom:24 }}>
                {outcome.body}
              </div>
              <button
                className="btn btn-full btn-primary"
                onClick={() => window.open(`mailto:commandledger@gmail.com?subject=${encodeURIComponent(emailSubject)}`,"_blank")}
              >
                {outcome.action}
              </button>
              {phase === "completed" && (
                <div className="price-diag-note" style={{ marginTop:14 }}>{DIAGNOSTIC.note}</div>
              )}
            </div>
          ) : (
            <>
              <div className="plan-badge">
                <div className="plan-badge-name">{DIAGNOSTIC.name}</div>
                <div className="plan-badge-price">US${DIAGNOSTIC.usd.toLocaleString()} <span style={{ fontSize:14, color:C.text3 }}>once</span></div>
                <div className="plan-badge-sub">{DIAGNOSTIC.tagline}</div>
              </div>

              {phase === "creating" && (
                <div className="pay-status"><span className="spinner" style={{ display:"inline-block", marginBottom:8 }}/><br/>Preparing your order...</div>
              )}
              {(phase === "unavailable" || phase === "failed") && (
                <>
                  <div className="pay-err" role="alert">
                    {phase === "failed"
                      ? "The payment did not go through. Nothing was charged."
                      : "Online payment is not available right now. Nothing has been charged."}
                  </div>
                  <button
                    className="btn btn-full btn-primary"
                    style={{ marginTop:16 }}
                    onClick={() => window.open("mailto:commandledger@gmail.com?subject=Financial%20Diagnostic","_blank")}
                  >
                    Email to arrange payment
                  </button>
                </>
              )}
              {phase === "capturing" && (
                <div className="pay-status" role="status"><span className="spinner" style={{ display:"inline-block", marginBottom:8 }}/><br/>Confirming your payment. Please keep this window open.</div>
              )}
              {/* Stays mounted while capturing: a declined card restarts on
                  these same buttons, which would be gone if unmounted. */}
              <div ref={btnRef} hidden={phase !== "ready"} style={{ minHeight: phase === "ready" && sdkReady ? 50 : 0 }}/>
              {phase === "ready" && sdkReady && (
                <div className="modal-secure">Paid once through PayPal. Not a subscription.</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── APP SHELL: SECTIONS AND ROUTING ──────────────────────────
// Each workspace section has its own path, so the browser's back/forward
// buttons, refresh and "open in new tab" all land where the founder was.
// There is no router dependency: the path is read on load, written with
// pushState on navigation, and re-read on popstate. Vercel rewrites every
// path to index.html, so any of these URLs boots the app. A signed-out
// visitor on one of them is sent back to "/" (see leaveAppPaths in App).
const SECTIONS = [
  { id:"dashboard",    label:"Dashboard",      path:"/dashboard",    icon:"grid",    group:"workspace" },
  { id:"transactions", label:"Transactions",   path:"/transactions", icon:"swap",    group:"workspace" },
  { id:"financials",   label:"Financials",     path:"/financials",   icon:"bars",    group:"workspace" },
  { id:"advisor",      label:"AI Advisor",     path:"/advisor",      icon:"spark",   group:"workspace" },
  { id:"reports",      label:"Reports",        path:"/reports",      icon:"doc",     group:"workspace" },
  { id:"decisions",    label:"Decision Log",   path:"/decisions",    icon:"check",   group:"workspace" },
  { id:"forecasts",    label:"Forecasts",      path:"/forecasts",    icon:"trend",   group:"workspace" },
  { id:"settings",     label:"Settings",       path:"/settings",     icon:"sliders", group:"account" },
  { id:"help",         label:"Help & Support", path:"/help",         icon:"help",    group:"account" },
];
const sectionById = id => SECTIONS.find(s => s.id === id) || SECTIONS[0];
const sectionFromPath = path => (SECTIONS.find(s => s.path === path) || SECTIONS[0]).id;
const isAppPath = path => SECTIONS.some(s => s.path === path);

// Public pages with their own address, so search engines can index them and
// payment providers can link to them. Everything else a signed-out visitor
// sees lives at "/".
const LEGAL_PATHS = { "/terms": "terms", "/privacy": "privacy" };
const PAGE_TITLES = { terms: "Terms of Service | Command Ledger", privacy: "Privacy Policy | Command Ledger" };
const SITE_ORIGIN = "https://www.commandledger.com";

// Words the header search maps to each section, so "runway" or "export"
// finds the page that answers it.
const SECTION_KEYWORDS = {
  dashboard:    ["overview", "home", "directive", "kpi", "summary"],
  transactions: ["upload", "import", "csv", "excel", "bank", "sheet", "data", "manual", "history", "delete"],
  financials:   ["profit", "loss", "p&l", "margin", "break-even", "breakeven", "ltv", "cac", "unit economics", "concentration", "client", "payer", "sovereignty", "allocator", "tax", "reserve"],
  advisor:      ["ai", "brief", "claude", "recommendation", "advice"],
  reports:      ["report", "export", "download", "pdf", "print", "board"],
  decisions:    ["directive", "decision", "outcome", "acted"],
  forecasts:    ["runway", "projection", "forecast", "obligation", "recurring", "rent", "payroll", "afford", "hire", "hiring", "scenario", "what-if", "cash", "bills"],
  settings:     ["profile", "name", "business", "plan", "billing", "subscription", "cancel", "paypal", "mode", "safe", "growth"],
  help:         ["support", "contact", "email", "faq", "question", "how"],
};
const SEARCH_DESTINATIONS = SECTIONS.map(s => ({ id:s.id, label:s.label, keywords:SECTION_KEYWORDS[s.id] || [] }));

const PERIOD_OPTIONS = [["3","Last 3 months","3 mo"],["6","Last 6 months","6 mo"],["12","Last 12 months","12 mo"],["all","All time","All"]];
const periodLabelOf = v => (PERIOD_OPTIONS.find(p => p[0] === v) || PERIOD_OPTIONS[2])[1];

function useSection() {
  const [section, setSection] = useState(() => sectionFromPath(window.location.pathname));
  useEffect(() => {
    // Normalise the address bar to the section actually shown ("/" -> "/dashboard").
    const shown = sectionById(sectionFromPath(window.location.pathname));
    if (window.location.pathname !== shown.path) window.history.replaceState(null, "", shown.path);
    const onPop = () => setSection(sectionFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((id) => {
    const s = sectionById(id);
    if (window.location.pathname !== s.path) window.history.pushState(null, "", s.path);
    setSection(s.id);
    window.scrollTo(0, 0);
  }, []);
  return [section, navigate];
}

// Closes a popover on an outside click or Escape.
function useDismiss(open, onClose, ref) {
  useEffect(() => {
    if (!open) return;
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, onClose, ref]);
}

// PostgREST returns at most 1,000 rows per request (the hosted default), and
// says nothing when it stops there. Reading history in one request meant a
// business with more than 1,000 transactions in the period got only its
// OLDEST 1,000 — ascending order — so the latest months, and every metric
// built on them, were silently missing. This reads every page.
async function selectAll(buildQuery, pageSize = 1000, maxPages = 100) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) return out;
  }
  throw new Error(`More than ${pageSize * maxPages} rows; refusing to load a partial history.`);
}

// ─── ICONS ────────────────────────────────────────────────────
// Inline line icons, drawn with currentColor so they follow the text colour
// of whatever holds them. Always decorative: the label beside them carries
// the meaning.
const ICONS = {
  grid:     <><rect x="3.5" y="3.5" width="7" height="7"/><rect x="13.5" y="3.5" width="7" height="7"/><rect x="3.5" y="13.5" width="7" height="7"/><rect x="13.5" y="13.5" width="7" height="7"/></>,
  swap:     <path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"/>,
  bars:     <path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/>,
  spark:    <path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/>,
  doc:      <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"/>,
  check:    <path d="M9 4h6v3H9zM7 5.5H5V21h14V5.5h-2M9 14l2 2 4-4"/>,
  trend:    <path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>,
  sliders:  <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4"/>,
  help:     <><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.2 1-1.2 1.8v.6M12 17h.01"/></>,
  logout:   <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H10"/>,
  search:   <><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></>,
  bell:     <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>,
  menu:     <path d="M4 6h16M4 12h16M4 18h16"/>,
  close:    <path d="M6 6l12 12M18 6L6 18"/>,
  chevron:  <path d="M6 9l6 6 6-6"/>,
  upload:   <path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>,
  arrow:    <path d="M5 12h14M13 6l6 6-6 6"/>,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>,
  print:    <path d="M7 9V3h10v6M7 17H4v-8h16v8h-3M7 14h10v7H7z"/>,
};
function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{ICONS[name]}</svg>
  );
}

// ─── HEADER: SEARCH ───────────────────────────────────────────
// Searches the founder's own transactions (description, category, date,
// amount) and the app's pages, via searchWorkspace() in financials.js.
// Choosing a transaction opens the Transactions page filtered to it.
const SHORTCUT_LABEL = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘K" : "Ctrl K";

function HeaderSearch({ transactions, onNavigate, onShowTransactions, mobileOpen, onMobileClose, inputRef }) {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef(null);
  const results = useMemo(() => searchWorkspace(q, { transactions, destinations:SEARCH_DESTINATIONS, limit:5 }), [q, transactions]);
  const options = useMemo(() => {
    const list = results.destinations.map(d => ({ key:`p-${d.id}`, type:"page", d }));
    results.transactions.forEach((t, i) => list.push({ key:`t-${t.id ?? i}`, type:"txn", t }));
    if (results.transactionTotal > results.transactions.length) list.push({ key:"all", type:"all" });
    return list;
  }, [results]);
  const showPop = focused && q.trim().length > 0;
  useEffect(() => { setActive(0); }, [q]);

  const close = useCallback(() => { setFocused(false); onMobileClose(); }, [onMobileClose]);
  useDismiss(showPop || mobileOpen, close, wrapRef);

  const choose = opt => {
    if (!opt) return;
    if (opt.type === "page") onNavigate(opt.d.id);
    else if (opt.type === "txn") onShowTransactions(opt.t.description || q);
    else onShowTransactions(q.trim());
    setQ("");
    inputRef.current?.blur();
    close();
  };
  const onKeyDown = e => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, options.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(options[active]); }
    else if (e.key === "Escape") { setQ(""); inputRef.current?.blur(); close(); }
  };
  const optionId = opt => `hs-${opt.key}`;
  let section = null;

  return (
    <div className={`hdr-search${mobileOpen ? " open" : ""}`} ref={wrapRef} role="search">
      <span className="hdr-search-icon"><Icon name="search" size={16}/></span>
      <input
        ref={inputRef}
        className="hdr-search-input"
        type="search"
        placeholder="Search transactions, metrics, pages"
        aria-label="Search transactions and pages"
        role="combobox"
        aria-expanded={showPop}
        aria-controls="hdr-search-list"
        aria-autocomplete="list"
        aria-activedescendant={showPop && options[active] ? optionId(options[active]) : undefined}
        value={q}
        onChange={e => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={e => { if (!wrapRef.current?.contains(e.relatedTarget)) setFocused(false); }}
        onKeyDown={onKeyDown}
      />
      {!q && <kbd className="hdr-kbd" aria-hidden="true">{SHORTCUT_LABEL}</kbd>}
      {showPop && (
        <div className="hdr-pop hdr-search-pop" id="hdr-search-list" role="listbox" aria-label="Search results">
          {options.length === 0 && (
            <div className="pop-empty">No pages or transactions in the selected period match "{q.trim()}".</div>
          )}
          {options.map((opt, i) => {
            const heading = opt.type === "page" ? "Pages" : "Transactions";
            const showHeading = heading !== section;
            section = heading;
            return (
              <div key={opt.key}>
                {showHeading && <div className="pop-sec" aria-hidden="true">{heading}</div>}
                <div id={optionId(opt)} role="option" aria-selected={i === active}
                  className={`pop-item${i === active ? " active" : ""}`}
                  onMouseDown={e => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(opt)}>
                  {opt.type === "page" && <><Icon name={sectionById(opt.d.id).icon} size={16}/><span className="pop-main">{opt.d.label}</span></>}
                  {opt.type === "txn" && <>
                    <span className="pop-date">{opt.t.txn_date}</span>
                    <span className="pop-main">{opt.t.description || "No description"}</span>
                    <span className="pop-amt" style={{ color: Number(opt.t.amount) >= 0 ? C.positive : C.text2 }}>{fmt(opt.t.amount, opt.t.currency)}</span>
                  </>}
                  {opt.type === "all" && <span className="pop-main">Show all {results.transactionTotal} matching transactions</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── HEADER: ALERTS ───────────────────────────────────────────
// Live conditions from buildAlerts(): each disappears once it is resolved,
// so there is nothing to mark as read. The badge counts critical and
// warning alerts; informational ones show as a dot.
const ALERT_STYLE = { critical:{ text:"Critical", color:C.danger }, warning:{ text:"Warning", color:C.warning }, info:{ text:"Info", color:C.silver } };

function AlertsMenu({ alerts, onNavigate }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  useDismiss(open, closeMenu, ref);
  const urgent = alerts.filter(a => a.severity !== "info").length;
  const label = alerts.length === 0 ? "Alerts, none" : `Alerts, ${alerts.length}${urgent ? `, ${urgent} need attention` : ""}`;
  return (
    <div className="hdr-pop-wrap" ref={ref}>
      <button className="hdr-icon-btn" aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(o => !o)}>
        <Icon name="bell"/>
        {urgent > 0 ? <span className="hdr-badge" aria-hidden="true">{urgent}</span>
          : alerts.length > 0 ? <span className="hdr-dot" aria-hidden="true"/> : null}
      </button>
      {open && (
        <div className="hdr-pop hdr-pop-right alerts-pop" role="dialog" aria-label="Alerts">
          <div className="pop-head">Alerts<span>{alerts.length}</span></div>
          {alerts.length === 0 ? (
            <div className="pop-empty">Nothing needs your attention. Alerts appear here when a recurring bill is missed, a directive turns critical, or your data goes stale.</div>
          ) : alerts.map(a => (
            <button key={a.id} className="alert-item" onClick={() => { setOpen(false); onNavigate(a.section); }}>
              <span className="alert-sev" style={{ color:ALERT_STYLE[a.severity].color }}>{ALERT_STYLE[a.severity].text}</span>
              <span className="alert-title">{a.title}</span>
              <span className="alert-detail">{a.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── HEADER: ACCOUNT MENU ─────────────────────────────────────
function Avatar({ src, name, size = 32 }) {
  return (
    <span className="hdr-av" style={{ width:size, height:size }}>
      {src ? <img src={src} alt=""/> : (name?.[0] || "?").toUpperCase()}
    </span>
  );
}

function AccountMenu({ name, role, avatar, email, canUpgrade, onNavigate, onUpgrade, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  useDismiss(open, closeMenu, ref);
  const go = fn => () => { setOpen(false); fn(); };
  return (
    <div className="hdr-pop-wrap" ref={ref}>
      <button className="hdr-account" aria-label={`Account menu for ${name}`} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(o => !o)}>
        <Avatar src={avatar} name={name}/>
        <span className="hdr-who">
          <span className="hdr-name">{name}</span>
          <span className="hdr-role">{role}</span>
        </span>
        <span className="hdr-chev"><Icon name="chevron" size={16}/></span>
      </button>
      {open && (
        <div className="hdr-pop hdr-pop-right acct-pop" role="menu" aria-label="Account">
          <div className="acct-id">
            <div className="hdr-name">{name}</div>
            <div className="hdr-role">{email}</div>
          </div>
          <button role="menuitem" className="pop-item" onClick={go(() => onNavigate("settings"))}><Icon name="sliders" size={16}/><span className="pop-main">Settings</span></button>
          <button role="menuitem" className="pop-item" onClick={go(() => onNavigate("help"))}><Icon name="help" size={16}/><span className="pop-main">Help & Support</span></button>
          {canUpgrade && <button role="menuitem" className="pop-item" onClick={go(onUpgrade)}><Icon name="spark" size={16}/><span className="pop-main">Add Command Advisory</span></button>}
          <button role="menuitem" className="pop-item" onClick={go(onLogout)}><Icon name="logout" size={16}/><span className="pop-main">Log out</span></button>
        </div>
      )}
    </div>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────
// Persistent on desktop; below 960px the same element becomes a drawer
// opened from the header's menu button.
function NavLink({ s, active, onNavigate, linkRef }) {
  return (
    <a ref={linkRef} href={s.path} className={`nav-item${active ? " on" : ""}`} aria-current={active ? "page" : undefined}
      onClick={e => {
        // Let modified clicks open a new tab as links normally do.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onNavigate(s.id);
      }}>
      <Icon name={s.icon}/><span>{s.label}</span>
    </a>
  );
}

function AppSidebar({ section, onNavigate, onLogout, open, onClose, planName, canUpgrade, onUpgrade, firstLinkRef }) {
  return (
    <>
      {open && <div className="side-backdrop" onClick={onClose} aria-hidden="true"/>}
      <nav id="app-nav" className={`app-side${open ? " open" : ""}`} aria-label="Main">
        <div className="nav-label" id="nav-workspace">Workspace</div>
        <ul className="nav-list" aria-labelledby="nav-workspace">
          {SECTIONS.filter(s => s.group === "workspace").map((s, i) => (
            <li key={s.id}><NavLink s={s} active={section === s.id} onNavigate={onNavigate} linkRef={i === 0 ? firstLinkRef : undefined}/></li>
          ))}
        </ul>
        <div className="nav-label" id="nav-account">Account</div>
        <ul className="nav-list" aria-labelledby="nav-account">
          {SECTIONS.filter(s => s.group === "account").map(s => (
            <li key={s.id}><NavLink s={s} active={section === s.id} onNavigate={onNavigate}/></li>
          ))}
          <li><button className="nav-item" onClick={onLogout}><Icon name="logout"/><span>Log Out</span></button></li>
        </ul>
        <div className="side-plan">
          <div className="card-lbl" style={{ marginBottom:4 }}>Plan</div>
          <div className="side-plan-name">{planName}</div>
          {canUpgrade && <button className="panel-link" style={{ marginTop:8 }} onClick={onUpgrade}>Add Command Advisory<Icon name="arrow" size={14}/></button>}
        </div>
      </nav>
    </>
  );
}

// ─── SHARED LAYOUT PIECES ─────────────────────────────────────
function Panel({ title, action, children, className = "", style, id }) {
  return (
    <section className={`panel ${className}`} style={style} id={id} aria-label={typeof title === "string" ? title : undefined}>
      {(title || action) && (
        <div className="panel-head">
          {title && <h2 className="panel-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function PanelLink({ to, onNavigate, children }) {
  return <button className="panel-link" onClick={() => onNavigate(to)}>{children}<Icon name="arrow" size={14}/></button>;
}

function PageHead({ title, meta, children }) {
  return (
    <div className="page-head">
      <div style={{ minWidth:0 }}>
        <h1 className="page-h1">{title}</h1>
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

function ReserveModeToggle({ mode, setMode }) {
  return (
    <div className="mode-pills" role="group" aria-label="Reserve mode"
      title="Safe holds back 30% for tax and 20% as a safety buffer; Growth holds back 25% and 10%.">
      <button className={`mpill${mode === "safe" ? " on" : ""}`} aria-pressed={mode === "safe"} onClick={() => setMode("safe")}>Safe</button>
      <button className={`mpill${mode === "growth" ? " on" : ""}`} aria-pressed={mode === "growth"} onClick={() => setMode("growth")}>Growth</button>
    </div>
  );
}

function KpiTile({ t, hero = false }) {
  const sev = t.sev ? SEVERITY_STYLE[t.sev] : null;
  return (
    <div className={`kpi${hero ? " kpi-lead" : ""}`} style={sev ? { "--sev":sev.color } : undefined} title={t.title}>
      <div className="kpi-lbl"><span>{t.lbl}</span>{t.sev && <SeverityTag level={t.sev} label={t.sevLabel}/>}</div>
      <div className="kpi-val" style={{ color:t.col || C.text }}>
        {t.val}{t.unit && <span className="kpi-unit">{t.unit}</span>}
      </div>
      {t.sub && <div className="kpi-sub">{t.sub}</div>}
      <ConfidenceLine c={t.conf}/>
    </div>
  );
}

const capitalize = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const CADENCE_LABEL = { weekly:"Weekly", biweekly:"Every 2 weeks", semimonthly:"Twice a month", monthly:"Monthly", quarterly:"Quarterly", annual:"Annual" };

// ─── DASHBOARD (the signed-in workspace) ──────────────────────
// Holds all data loading and every derived metric once, then renders the
// section the URL names. Sections receive one `ctx` object rather than
// re-deriving anything, so a number shown on two pages can never disagree.
function Dashboard({ user, profile, onLogout, onUpgrade, onBuyDiagnostic, onProfileChange }) {
  const [section, navigate] = useSection();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const searchRef = useRef(null);
  const menuBtnRef = useRef(null);
  const firstNavRef = useRef(null);

  // Reserve mode is a per-device preference, so it lives in localStorage;
  // the page works the same if storage is unavailable.
  const [mode, setModeState] = useState(() => {
    try { return window.localStorage.getItem("cl.reserveMode") === "growth" ? "growth" : "safe"; } catch { return "safe"; }
  });
  const setMode = m => { setModeState(m); try { window.localStorage.setItem("cl.reserveMode", m); } catch { /* storage unavailable */ } };

  const [data, setData] = useState(null);
  const [dataSource, setDataSource]   = useState("");
  // Financial Memory Engine — persisted transaction history, read fresh on
  // every load and every period-filter change. Nothing here is computed
  // client-side and stored back; `history` is raw monthly aggregates only.
  const [txns, setTxns] = useState([]);
  const [history, setHistory] = useState([]);
  const [lastTxnDate, setLastTxnDate] = useState(null);
  const [concentrationData, setConcentrationData] = useState(null);
  const [obligations, setObligations] = useState([]);
  const [affordInput, setAffordInput] = useState("");
  // The amount last checked. The answer is recomputed from it on every
  // render, so it can never go stale when the cash balance or period changes.
  const [affordAmount, setAffordAmount] = useState(null);
  // Decision Log — every directive issued, whether it was acted on, and
  // what happened to its target metric afterward. Newest first.
  const [directives, setDirectives] = useState([]);
  const [directivesLoading, setDirectivesLoading] = useState(true);
  const [ackNote, setAckNote] = useState("");
  // A failed load leaves `directives` empty, which the persistence effect
  // below would read as "nothing issued yet" and insert a duplicate of the
  // directive already on file. It holds off while this is set.
  const [directivesError, setDirectivesError] = useState(false);
  // One place for a save/delete that failed, so a click that did nothing
  // says so instead of looking like it worked.
  const [actionErr, setActionErr] = useState("");
  const [batches, setBatches] = useState([]);
  const [periodFilter, setPeriodFilter] = useState("12");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadErr, setUploadErr] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [aiRec,    setAiRec]    = useState(null);
  const [aiError,  setAiError]  = useState("");
  const [aiLoad,   setAiLoad]   = useState(false);
  // Transactions page filters; the header search sets txQuery.
  const [txQuery, setTxQuery] = useState("");
  const [txDirection, setTxDirection] = useState("all");
  const [txLimit, setTxLimit] = useState(100);
  // Manual input state
  const [mRev,  setMRev]  = useState(0);
  const [mExp,  setMExp]  = useState(0);
  const [mCash, setMCash] = useState(0);
  const [mCac,  setMCac]  = useState(0);
  const [mLtv,  setMLtv]  = useState(0);
  const [mLeads, setMLeads] = useState(0);
  const [mClose, setMClose] = useState(0);
  // Scenario planning adjustments — percentages/deltas applied to the
  // current latest-month figures, not saved anywhere; purely exploratory.
  const [scRevPct, setScRevPct] = useState(0);
  const [scExpPct, setScExpPct] = useState(0);
  const [scHire,   setScHire]   = useState(0);
  const [scCash,   setScCash]   = useState(0);

  const plan = resolvePlanKey(profile?.plan);
  // The business currency. Every metric is computed from transactions in it
  // and shown in it; null until the founder chooses one.
  const cur = isSupportedCurrency(profile?.base_currency) ? profile.base_currency : null;
  const [excludedByCurrency, setExcludedByCurrency] = useState([]);
  const userName  = profile?.name || user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Founder";
  const userAvatar = user?.user_metadata?.avatar_url;

  // ── Shell behaviour ──
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const go = useCallback(id => { setDrawerOpen(false); setMobileSearchOpen(false); navigate(id); }, [navigate]);
  const showTransactions = useCallback(q => { setTxQuery(q); setTxLimit(100); go("transactions"); }, [go]);
  const closeMobileSearch = useCallback(() => setMobileSearchOpen(false), []);
  const logout = () => { window.history.replaceState(null, "", "/"); onLogout(); };

  // The drawer: Escape closes it and returns focus to the menu button, the
  // first link takes focus when it opens, and the page behind stops scrolling.
  useEffect(() => {
    if (!drawerOpen) return;
    firstNavRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = e => { if (e.key === "Escape") { setDrawerOpen(false); menuBtnRef.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); };
  }, [drawerOpen]);

  // Ctrl/Cmd+K focuses search from anywhere in the workspace.
  useEffect(() => {
    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMobileSearchOpen(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (mobileSearchOpen) searchRef.current?.focus(); }, [mobileSearchOpen]);

  // ── Data loading ──
  const periodCutoff = useCallback(() => {
    if (periodFilter === "all") return null;
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - Number(periodFilter));
    return d.toISOString().slice(0, 10);
  }, [periodFilter]);

  // `baseArg` lets an upload that has just set the business currency load
  // with it before the profile change reaches this closure.
  const loadHistory = useCallback(async (baseArg) => {
    const base = baseArg || cur;
    setHistoryLoading(true);
    try {
      // `description` is fetched alongside the aggregates so real revenue
      // concentration can be computed from payer names — that only exists
      // at the transaction level, never in a monthly bucket.
      const cutoff = periodCutoff();
      const list = await selectAll(() => {
        let query = supabase.from("transactions").select("id, txn_date, amount, category, description, currency")
          .order("txn_date", { ascending: true }).order("id", { ascending: true });
        if (cutoff) query = query.gte("txn_date", cutoff);
        return query;
      });
      // Every figure comes from transactions in the business currency only.
      // The rest stay listed under Transactions and are counted in a notice;
      // they are never added in, and never converted.
      const { included, excluded } = partitionByCurrency(list, base);
      setTxns(list);
      setExcludedByCurrency(excluded);
      setHistory(aggregateTransactionsByMonth(included));
      setConcentrationData(computeRevenueConcentration(included));
      // Ascending order, so the last row is the most recent real transaction —
      // this is what the confidence model's recency check degrades against.
      setLastTxnDate(included.length > 0 ? included[included.length - 1].txn_date : null);
    } catch (e) {
      console.error("Failed to load transaction history:", e);
      setTxns([]);
      setExcludedByCurrency([]);
      setHistory([]);
      setConcentrationData(computeRevenueConcentration([]));
      setLastTxnDate(null);
      setActionErr("Your transaction history could not be loaded. Refresh to try again.");
    }
    setHistoryLoading(false);
  }, [periodCutoff, cur]);

  const loadBatches = useCallback(async () => {
    const { data: rows, error } = await supabase.from("upload_batches").select("*").order("uploaded_at", { ascending: false });
    if (error) { console.error("Failed to load upload history:", error); setActionErr("Your upload history could not be loaded. Refresh to try again."); return; }
    setBatches(rows || []);
  }, []);

  // Recurring-obligation detection always runs over the founder's FULL
  // transaction history, independent of the period filter — a quarterly or
  // annual obligation can't be reliably detected from a 3-month window even
  // if that's what's currently selected for display.
  const loadObligations = useCallback(async (baseArg) => {
    const base = baseArg || cur;
    if (!base) { setObligations([]); return; }
    try {
      const all = await selectAll(() => supabase.from("transactions").select("txn_date, amount, description, category, currency")
        .order("txn_date", { ascending: true }).order("id", { ascending: true }));
      // Bills are detected from the business currency only, so a payment
      // stream is never averaged across two currencies.
      const detected = detectRecurringObligations(all.filter(t => t.currency === base));

      // If this read fails, every obligation the founder marked as ended
      // would look unseen and be upserted back to active — so it must throw.
      const { data: existing, error: existingErr } = await supabase.from("recurring_obligations").select("normalized_key, active");
      if (existingErr) throw existingErr;
      const existingActiveByKey = {};
      (existing || []).forEach(e => { existingActiveByKey[e.normalized_key] = e.active; });

      // A founder's manual "mark inactive" (an obligation that's ended) is
      // permanent — a fresh detection pass never resurrects it. Only the
      // detector's own "gone quiet too long" call is allowed to flip
      // active:true -> false automatically.
      const rows = detected.map(o => ({
        ...o, user_id: user.id, currency: base,
        active: existingActiveByKey[o.normalized_key] === false ? false : o.active,
      }));
      if (rows.length > 0) {
        const { error: upsertErr } = await supabase.from("recurring_obligations").upsert(rows, { onConflict: "user_id,normalized_key" });
        if (upsertErr) throw upsertErr;
      }

      const { data: persisted, error: persistErr } = await supabase.from("recurring_obligations").select("*").order("typical_amount", { ascending: false });
      if (persistErr) throw persistErr;
      setObligations((persisted || []).filter(o => o.currency === base));
    } catch (e) {
      console.error("Failed to detect/load recurring obligations:", e);
      setObligations([]);
    }
  }, [user, cur]);

  const setObligationActive = async (id, active) => {
    const { error } = await supabase.from("recurring_obligations").update({ active }).eq("id", id);
    if (error) { console.error("Failed to update obligation:", error); setActionErr("That obligation could not be updated. Nothing was changed, so try again."); return; }
    setObligations(obs => obs.map(o => o.id === id ? { ...o, active } : o));
  };

  const loadDirectives = useCallback(async () => {
    setDirectivesLoading(true);
    const { data: rows, error } = await supabase.from("directives").select("*").order("issued_at", { ascending: false });
    if (error) console.error("Failed to load decision history:", error);
    else setDirectives(rows || []);
    setDirectivesError(!!error);
    setDirectivesLoading(false);
  }, []);

  const acknowledgeDirective = async (directiveId, actionTaken) => {
    const patch = { acknowledged_at: new Date().toISOString(), action_taken: actionTaken, founder_note: ackNote.trim() || null };
    const { error } = await supabase.from("directives").update(patch).eq("id", directiveId);
    if (error) { console.error("Failed to record directive response:", error); setActionErr("Your response could not be saved. Try again."); return; }
    setDirectives(ds => ds.map(d => d.id === directiveId ? { ...d, ...patch } : d));
    setAckNote("");
  };

  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => { loadObligations(); }, [loadObligations]);
  useEffect(() => { loadDirectives(); }, [loadDirectives]);

  // Saves the business currency. Returns whether it was saved.
  const saveBaseCurrency = async code => {
    if (!isSupportedCurrency(code)) return false;
    const { data: saved, error } = await supabase.from("profiles")
      .update({ base_currency: code, updated_at: new Date().toISOString() })
      .eq("id", user.id).select().single();
    if (error) { console.error("Failed to save business currency:", error); return false; }
    onProfileChange(saved);
    return true;
  };

  // Corrects the currency an upload was labelled with. Amounts are never
  // changed; only the label on the upload and the transactions it added.
  const relabelBatch = async (batchId, code) => {
    const { error } = await supabase.rpc("relabel_upload_currency", { p_batch_id: batchId, p_currency: code });
    if (error) { console.error("Failed to change upload currency:", error); setActionErr("That upload's currency could not be changed. Nothing was changed, so try again."); return; }
    await loadHistory(); await loadBatches(); await loadObligations();
  };

  const handleDataLoaded = async (parsedRows, source, cols, rawText, fileCurrency) => {
    setUploadStatus(""); setUploadErr(""); setUploadBusy(true);
    const fileCur = fileCurrency || cur;
    if (!fileCur) {
      setUploadErr("Choose the currency this file is in, then upload it again.");
      setUploadBusy(false);
      return;
    }
    let base = cur;
    if (!base) {
      if (!(await saveBaseCurrency(fileCur))) {
        setUploadErr("Your business currency could not be saved, so the file was not uploaded. Try again.");
        setUploadBusy(false);
        return;
      }
      base = fileCur;
    }
    // The session-only figures may be shown only when they are in the
    // business currency; a file in another currency is stored, not shown.
    if (fileCur === base) { setData(parsedRows); setDataSource(source); }
    try {
      const parsed = parseTransactions(rawText, { currency: fileCur });
      if (!parsed || parsed.transactions.length === 0) {
        setUploadErr("This file loaded for the current session, but no dated transactions could be added to your permanent history.");
        setUploadBusy(false);
        return;
      }
      const { transactions, mode: parserMode } = parsed;
      const dates = transactions.map(t => t.txn_date).sort();

      const { data: batch, error: batchErr } = await supabase.from("upload_batches").insert({
        user_id: user.id, filename: source, row_count: transactions.length,
        period_start: dates[0], period_end: dates[dates.length - 1], parser_mode: parserMode, currency: fileCur,
      }).select().single();
      if (batchErr) throw batchErr;

      const hashed = await Promise.all(transactions.map(async t => ({
        ...t, user_id: user.id, source_batch_id: batch.id, dedupe_hash: await computeDedupeHash(t),
      })));

      const { data: inserted, error: insertErr } = await supabase
        .from("transactions")
        .upsert(hashed, { onConflict: "user_id,dedupe_hash", ignoreDuplicates: true })
        .select("id");
      if (insertErr) {
        // Don't leave an upload in the history that added nothing.
        const { error: cleanupErr } = await supabase.from("upload_batches").delete().eq("id", batch.id);
        if (cleanupErr) console.error("Failed to remove empty upload record:", cleanupErr);
        throw insertErr;
      }

      const insertedCount = inserted?.length || 0;
      const duplicateCount = transactions.length - insertedCount;

      const { error: countErr } = await supabase.from("upload_batches")
        .update({ inserted_count: insertedCount, duplicate_count: duplicateCount })
        .eq("id", batch.id);
      if (countErr) console.error("Failed to record upload counts:", countErr);

      const otherCurrency = transactions.filter(t => t.currency !== base).length;
      setUploadStatus([
        `Added ${insertedCount} new transaction${insertedCount === 1 ? "" : "s"}. ${duplicateCount} already on file.`,
        otherCurrency > 0 ? `${otherCurrency} ${otherCurrency === 1 ? "is" : "are"} in a currency other than ${base}, so ${otherCurrency === 1 ? "it is" : "they are"} stored but not added to your figures.` : "",
        parsed.unreadable > 0 ? `${parsed.unreadable} amount${parsed.unreadable === 1 ? "" : "s"} could not be read as a number and ${parsed.unreadable === 1 ? "was" : "were"} skipped.` : "",
      ].filter(Boolean).join(" "));
      await loadHistory(base);
      await loadBatches();
      await loadObligations(base);
    } catch (e) {
      console.error("Failed to save transaction history:", e);
      setUploadErr("Your file was read for this session, but saving it to your permanent history failed. The numbers are accurate for now; upload the file again to save them.");
    }
    setUploadBusy(false);
  };

  const deleteBatch = async (batchId) => {
    const { error } = await supabase.from("upload_batches").delete().eq("id", batchId);
    if (error) { console.error("Failed to delete upload:", error); setActionErr("That upload could not be deleted. Its transactions are still in your history."); return; }
    await loadHistory(); await loadBatches(); await loadObligations();
  };

  // ── Metrics ──
  // Persisted history is the source of truth once it exists; a fresh
  // upload's session-only `data` is only shown as an optimistic bridge
  // until loadHistory() catches up. Manual entry never touches either.
  const rows = history.length > 0 ? history : (data && data.length > 0 ? data : null);
  const m = computeMetrics(
    rows, { mRev, mExp, mCash, mCac, mLtv, mLeads, mClose }, mode,
    { lastTxnDate: history.length > 0 ? lastTxnDate : null, revenueConcentration: concentrationData, currency: cur }
  );
  const {
    tr, sr, latest, totRev, totExp, totCogs, activeCash, activeCac, activeLtv, n, totPro, margin, vel, conv, ltvcac,
    cogsRatio, mktRatio, sov, sovLbl, taxV, safV, free, avgRev, avgExp, burnMonths, hiringCapacity,
    concentration, concentrationReliable, breakEven, proj90, hasData, hasConversionData, cashFlowPositive,
    dataConfidence, growth, risk, trends, hasCashData, runwayConfidence, breakEvenConfidence, proj90Confidence,
    hiringCapacityConfidence, ltvcacConfidence, growthConfidence, seasonalPattern, historicalConfidence, founderNarrative,
  } = m;
  const metrics = { margin, vel, conv, sov, free, burnMonths, concentration, concentrationReliable, ltvcac, cashFlowPositive, n };

  const todayStr = new Date().toISOString().slice(0, 10);
  const activeObligations = obligations.filter(o => o.active !== false);
  const missedObligations = detectMissedObligations(activeObligations, todayStr);
  const upcoming = projectForwardCalendar(activeObligations, todayStr, 90);

  // Obligation-aware runway: real, dated obligations against current cash,
  // instead of a single flat average-burn rate — only meaningful once
  // there's a cash balance and at least one detected obligation to
  // project against.
  const forwardRunway = (hasCashData && activeObligations.length > 0)
    ? computeForwardRunway({ currentCash: activeCash, avgRev, avgExp, obligations: activeObligations, fromDate: todayStr, horizonDays: 365 })
    : null;
  // Surfaced only when it tells the founder something average burn
  // doesn't — a lumpy bill landing soon that a flat monthly rate, smoothing
  // everything evenly, would never reveal in time.
  const showForwardRunway = !!(forwardRunway?.crossesZero && (
    cashFlowPositive || Math.abs(forwardRunway.monthsUntilCross - burnMonths) >= 0.5
  ));

  const checkAfford = () => {
    const monthlyCost = Number(affordInput);
    setAffordAmount(monthlyCost > 0 ? monthlyCost : null);
  };
  const affordResult = affordAmount
    ? checkAffordability({ currentCash: activeCash, avgRev, avgExp, obligations: activeObligations, monthlyCost: affordAmount, fromDate: todayStr, currency: cur })
    : null;

  const scenario = runScenario(
    { revenue: latest.revenue, expenses: latest.expenses, cash: activeCash, cac: activeCac, ltv: activeLtv, leads: 0, closures: 0 },
    { revenuePct: scRevPct, expensePct: scExpPct, expenseDelta: scHire, cashDelta: scCash },
    mode
  );
  // A scenario with no cash balance has no runway to state; printing its
  // burnMonths showed a negative number of months.
  const scenarioRunway = s => s.cashFlowPositive ? "No burn" : s.runwayConfidence.shown ? `${safe(s.burnMonths).toFixed(1)}mo runway` : "--- (no cash entered)";

  // ── Decision log ──
  // A directive nobody follows up on is a tool, not an advisor. This is the
  // same directive the strip renders, so what's persisted and what's shown
  // can never disagree.
  const currentDirective = hasData
    ? computeDirective({ margin, burnMonths, free, vel, conv, ltvcac, months: n, concentration: concentrationData, currency: cur })
    : null;

  // Persist a directive only when it genuinely differs from the most
  // recently stored one — never on every render or page load. Waits for
  // the initial fetch to land first, so an already-persisted directive
  // that just hasn't loaded into state yet is never duplicated.
  useEffect(() => {
    // With no business currency there is nothing to label its figures with.
    if (!currentDirective || !cur || directivesLoading || directivesError) return;
    const latestStored = directives[0];
    const isNew = !latestStored || latestStored.directive_text !== currentDirective.text || latestStored.trigger_rule !== currentDirective.rule;
    if (!isNew) return;
    (async () => {
      const value = getDirectiveMetricValue(currentDirective.targetMetric, metrics, concentrationData);
      const { data: inserted, error } = await supabase.from("directives").insert({
        user_id: user.id,
        directive_text: currentDirective.text,
        reason_text: currentDirective.reason,
        severity: currentDirective.severity,
        trigger_rule: currentDirective.rule,
        target_metric: currentDirective.targetMetric,
        metric_at_issue: value,
        snapshot: metrics,
        currency: cur,
      }).select().single();
      if (error) console.error("Failed to record directive:", error);
      else if (inserted) setDirectives(ds => [inserted, ...ds]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDirective?.text, currentDirective?.rule, directivesLoading, directivesError]);

  // Outcome measurement: 60 days after issue, recompute the target
  // metric's current value from the event store and record it — never
  // earlier, and never guessed. "Pending" is the honest answer before then.
  useEffect(() => {
    if (directivesLoading || !hasData) return;
    const now = Date.now();
    const due = directives.filter(d =>
      (d.outcome_metric === null || d.outcome_metric === undefined) &&
      (now - new Date(d.issued_at).getTime()) >= 60 * 86400000
    );
    if (due.length === 0) return;
    (async () => {
      for (const d of due) {
        // A money figure issued in one currency cannot be compared with
        // today's figure in another; that outcome stays unmeasured.
        if (d.target_metric === "free" && d.currency && d.currency !== cur) continue;
        const value = getDirectiveMetricValue(d.target_metric, metrics, concentrationData);
        if (value === null) continue;
        const patch = { outcome_metric: value, outcome_at: new Date().toISOString() };
        const { error } = await supabase.from("directives").update(patch).eq("id", d.id);
        if (error) console.error("Failed to record directive outcome:", error);
        else setDirectives(ds => ds.map(x => x.id === d.id ? { ...x, ...patch } : x));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directivesLoading, hasData, directives.length]);

  const latestDirective = directives[0] || null;
  const needsAcknowledgement = !!(latestDirective && !latestDirective.acknowledged_at &&
    (Date.now() - new Date(latestDirective.issued_at).getTime()) >= 7 * 86400000);

  const alerts = buildAlerts({
    hasData: hasData || historyLoading, missedObligations, currentDirective, needsAcknowledgement, latestDirective,
    lastTxnDate: history.length > 0 ? lastTxnDate : null, today: todayStr, showForwardRunway, forwardRunway, directives,
    currency: cur,
  });

  // ── AI advisor ──
  const runAI = async () => {
    setAiLoad(true); setAiRec(null); setAiError("");
    // Aggregate expense categories from uploaded bank data if available
    const totPayroll  = rows ? rows.reduce((s,d) => s + (d.payroll   || 0), 0) : 0;
    const totRent     = rows ? rows.reduce((s,d) => s + (d.rent      || 0), 0) : 0;
    const totMktCat   = rows ? rows.reduce((s,d) => s + (d.marketing || 0), 0) : 0;
    const totSoftware = rows ? rows.reduce((s,d) => s + (d.software  || 0), 0) : 0;
    try {
      const { data: result, error } = await supabase.functions.invoke("analyze-finances", {
        body: {
          // Every amount below is in this currency. The advisor is told so
          // and writes its figures in it.
          currency:       cur,
          monthlyRevenue: latest.revenue,
          totalRevenue:   totRev,
          totalExpenses:  totExp,
          netProfit:      totPro,
          profitMargin:   margin.toFixed(1),
          velocity:       vel.toFixed(1),
          conversionRate: conv.toFixed(1),
          sovereigntyScore: sov.toFixed(0),
          trueFreeCash:   free,
          // null out any metric whose required inputs aren't present —
          // the model must never be handed a fabricated number to narrate.
          burnRunway:     (!cashFlowPositive && !runwayConfidence.shown) ? null : burnMonths.toFixed(1),
          cashFlowPositive,
          ltvCacRatio:    ltvcacConfidence.shown ? ltvcac.toFixed(2) : null,
          cogsRatio:      cogsRatio.toFixed(1),
          marketingRatio: mktRatio.toFixed(1),
          hiringCapacity: hiringCapacityConfidence.shown ? Math.round(hiringCapacity) : null,
          // Real payer-based concentration — null when extraction confidence
          // is low, so the model never narrates a percentage the parser
          // itself isn't confident in.
          revenueConcentration: concentrationData?.shown ? {
            confidenceLevel: concentrationData.confidenceLevel,
            largestPct:      concentrationData.largestPct.toFixed(1),
            top3Pct:         concentrationData.top3Pct.toFixed(1),
            hhi:             concentrationData.hhi.toFixed(2),
            distinctPayers:  concentrationData.distinctPayers,
            severity:        concentrationData.severity,
            aggregatorPct:   concentrationData.aggregatorPct.toFixed(1),
            topPayers:       concentrationData.payers.slice(0, 5).map(p => ({ name: p.name, pct: p.pct.toFixed(1) })),
          } : { reason: concentrationData?.reason || "no persisted transaction history yet" },
          breakEven:      breakEvenConfidence.shown ? breakEven.toFixed(0) : null,
          proj90:         proj90Confidence.shown ? proj90.toFixed(0) : null,
          plan,
          mode,
          dataMonths:     n,
          dataConfidence,
          growthScore:  growth.score.toFixed(0),
          growthLabel:  growth.label,
          growthSeasonallyAdjusted: growth.seasonallyAdjusted,
          riskScore:    risk.score.toFixed(0),
          riskLabel:    risk.label,
          trends,
          // Seasonal context: null unless the latest month is a real,
          // repeating pattern (13+ months of history) — when present, the
          // model must not read this month's dip/spike as a new problem.
          seasonalPattern: seasonalPattern ? {
            month: seasonalPattern.month,
            avgDeltaPct: seasonalPattern.avgDeltaPct.toFixed(1),
            occurrences: seasonalPattern.occurrences,
          } : null,
          founderNarrative: founderNarrative || null,
          confidence: {
            runway:    runwayConfidence,
            breakEven: breakEvenConfidence,
            proj90:    proj90Confidence,
            hiringCapacity: hiringCapacityConfidence,
            ltvCac:    ltvcacConfidence,
            growth:    growthConfidence,
          },
          // Forward cash calendar: detected recurring obligations projected
          // 90 days ahead, plus the obligation-aware runway (real dated
          // bills against current cash) alongside the flat average-burn
          // figure above — null when no obligations have been detected yet.
          forwardCalendar: activeObligations.length > 0 ? {
            weeklyTotals: summarizeCalendarByWeek(upcoming, todayStr, 90)
              .map(w => ({ weekStart: w.weekStart, total: Math.round(w.total) })),
            obligationAwareRunway: forwardRunway ? {
              crossesZero: forwardRunway.crossesZero,
              monthsUntilCross: forwardRunway.monthsUntilCross,
              crossDate: forwardRunway.crossDate,
            } : null,
            missedObligations: missedObligations.map(o => ({ label: o.label, daysPast: o.daysPast })),
            committedCosts: activeObligations.slice(0, 10).map(o => ({
              label: o.label, cadence: o.cadence, typicalAmount: o.typical_amount,
              nextExpected: o.next_expected, confidence: o.confidence,
            })),
          } : null,
          // Decision history: the last 3 directives with what the founder
          // did about them and what happened to the metric afterward. A
          // disagreement's note is included verbatim — the founder's
          // reasoning may be correct, and the model should account for it.
          directiveHistory: directives.slice(0, 3).map(d => ({
            text: d.directive_text, severity: d.severity, issuedAt: d.issued_at,
            actionTaken: d.action_taken || "awaiting_response",
            founderNote: d.founder_note || null,
            outcome: describeDirectiveOutcome(d, d.currency || cur),
          })),
          // Expense breakdown from bank statement parser
          payroll:   totPayroll  || null,
          rent:      totRent     || null,
          marketing: totMktCat   || null,
          software:  totSoftware || null,
          cogs:      totCogs     || null,
        },
      });
      if (error) throw error;
      if (result?.recommendation) setAiRec(result.recommendation);
      else setAiError(result?.error || "Analysis complete but no response returned.");
    } catch (e) {
      console.error("AI error:", e);
      // supabase-js throws a FunctionsHttpError/FunctionsRelayError whose
      // .context is the raw Response from the Edge Function — read the real
      // JSON error body it sent instead of showing a generic guess.
      let detail = "";
      try {
        if (e?.context?.json) detail = (await e.context.json())?.error || "";
      } catch { /* body wasn't JSON or already consumed */ }
      if (!detail && e?.message && e.message !== "Edge Function returned a non-2xx status code") {
        detail = e.message;
      }
      setAiError(detail || "Advisory engine unreachable. Check your connection and try again.");
    }
    setAiLoad(false);
  };

  // ── Presentation helpers shared by sections ──
  const periodLabel = periodLabelOf(periodFilter);
  const statusLine = !hasData
    ? (historyLoading ? "Loading your history" : "No data connected")
    : [
        history.length > 0 ? `${(txns.length - excludedByCurrency.reduce((sum, e) => sum + e.count, 0)).toLocaleString()} transactions` : (dataSource || "Manual entry"),
        history.length > 0 ? periodLabel : null,
        `${capitalize(dataConfidence)} confidence`,
      ].filter(Boolean).join(" · ");

  const runwayText = cashFlowPositive ? "No burn" : (runwayConfidence.shown && burnMonths > 0) ? `${safe(burnMonths).toFixed(1)} mo` : "---";

  // KPI tiles. The first tile is chosen by severity, not fixed by position —
  // when free cash or runway turns critical, that is what leads the row.
  const tiles = {
    revenue: { key:"revenue", lbl:"Monthly revenue", val:fmtCompact(latest.revenue, cur), title:fmt(latest.revenue, cur),
      sub:`${vel >= 0 ? "+" : ""}${pc(vel)} vs prior month`, col:C.text },
    margin:  { key:"margin", lbl:"Profit margin", val:pc(margin), col: margin > 0 ? C.positive : C.danger,
      sub:`${fmtCompact(totPro, cur)} net in period` },
    free:    { key:"free", lbl:"True free cash", val:fmtCompact(free, cur), title:fmt(free, cur), col: free >= 0 ? C.platinum : C.danger,
      sub:"After tax and safety reserves" },
    runway:  { key:"runway", lbl:"Runway", val:runwayText, conf:runwayConfidence,
      col: cashFlowPositive || burnMonths >= 6 ? C.positive : burnMonths >= 3 ? C.warning : runwayText === "---" ? C.text3 : C.danger,
      sub: cashFlowPositive ? "Revenue covers costs" : !runwayConfidence.shown ? "Add a cash balance to calculate" : burnMonths >= 6 ? "Above the 6-month threshold" : burnMonths >= 3 ? "Build toward 6 months" : "Below 3 months" },
    risk:    { key:"risk", lbl:"Risk score", val:risk.score.toFixed(0), unit:"/100",
      col: risk.label === "Low" ? C.positive : risk.label === "Watch" ? C.platinum : risk.label === "Elevated" ? C.warning : C.danger,
      sub:`${risk.label}. Weighted from runway, margin and trend` },
    hiring:  { key:"hiring", lbl:"Hiring capacity", conf:hiringCapacityConfidence,
      val: !hiringCapacityConfidence.shown ? "---" : hiringCapacity > 0 ? fmtCompact(hiringCapacity, cur) : "None",
      unit: hiringCapacityConfidence.shown && hiringCapacity > 0 ? "/mo" : null, title: fmt(hiringCapacity, cur),
      col: hiringCapacity > 0 ? C.positive : C.warning,
      sub: hiringCapacity > 0 ? "Fully-loaded cost profit covers" : "Costs exceed revenue on average" },
  };
  const hero = safe(free) < 0
    ? { ...tiles.free, sev:"critical", sub:"Overhead exceeds liquidity after reserves. Act on this first." }
    : (!cashFlowPositive && runwayConfidence.shown && safe(burnMonths) > 0 && safe(burnMonths) < 3)
      ? { ...tiles.runway, sev:"critical", sub:"Below the 3-month danger line. Protect cash now." }
      : (!cashFlowPositive && runwayConfidence.shown && safe(burnMonths) > 0 && safe(burnMonths) < 6)
        ? { ...tiles.runway, sev:"warning", sub:"Below the 6-month safety line. Build it back." }
        : { ...tiles.revenue, sev:"positive", sub:`${vel >= 0 ? "+" : ""}${pc(vel)} vs prior month. Stable enough to grow, not defend.` };
  const supporting = ["revenue","margin","free","runway","risk","hiring"].filter(k => k !== hero.key).map(k => tiles[k]);

  const reportSummary = [
    ["Latest month revenue", fmt(latest.revenue, cur)],
    ["Profit margin", pc(margin)],
    ["Net profit", fmt(totPro, cur)],
    ["True free cash", fmt(free, cur)],
    ["Runway", cashFlowPositive ? "No burn" : runwayConfidence.shown && burnMonths > 0 ? `${safe(burnMonths).toFixed(1)} months` : "Not enough data"],
    ["Break-even monthly revenue", breakEvenConfidence.shown && breakEven > 0 ? fmt(breakEven, cur) : "Not enough data"],
    ["90-day revenue projection", proj90Confidence.shown && proj90 > 0 ? fmt(proj90, cur) : "Not enough data"],
    ["Hiring capacity", hiringCapacityConfidence.shown ? (hiringCapacity > 0 ? `${fmt(hiringCapacity, cur)}/month` : "None from profit") : "Not enough data"],
    ["Risk score", `${risk.score.toFixed(0)}/100 (${risk.label})`],
    ["Growth score", `${growth.score.toFixed(0)}/100 (${growth.label})`],
    ["Largest client share", concentrationData?.shown ? pc(concentrationData.largestPct) : "Not enough data"],
    ["Data confidence", capitalize(dataConfidence)],
    ["Reserve mode", mode === "safe" ? "Safe (30% tax, 20% safety)" : "Growth (25% tax, 10% safety)"],
  ];

  const ctx = {
    user, profile, plan, userName, onUpgrade, onBuyDiagnostic, onProfileChange, go, mode, setMode,
    cur, excludedByCurrency, saveBaseCurrency, relabelBatch,
    rows, txns, history, historyLoading, batches, dataSource, statusLine, periodLabel, todayStr,
    m, metrics, hero, supporting, tiles, runwayText, concentrationData, obligations, activeObligations, missedObligations, upcoming,
    forwardRunway, showForwardRunway, currentDirective, directives, directivesLoading, latestDirective, needsAcknowledgement,
    ackNote, setAckNote, acknowledgeDirective, setObligationActive,
    affordInput, setAffordInput, setAffordAmount, affordResult, checkAfford,
    scenario, scenarioRunway, scRevPct, setScRevPct, scExpPct, setScExpPct, scHire, setScHire, scCash, setScCash,
    manual: { mRev, setMRev, mExp, setMExp, mCash, setMCash, mCac, setMCac, mLtv, setMLtv, mLeads, setMLeads, mClose, setMClose },
    handleDataLoaded, uploadBusy, uploadStatus, uploadErr, deleteBatch,
    txQuery, setTxQuery, txDirection, setTxDirection, txLimit, setTxLimit,
    aiRec, aiError, aiLoad, runAI, reportSummary,
    tr, sr, taxV, safV, hasConversionData, sov, sovLbl, activeCac, activeLtv, cogsRatio, mktRatio,
    seasonalPattern, historicalConfidence, founderNarrative, growth, growthConfidence, risk, trends,
  };

  const current = sectionById(section);
  const groupLabel = current.group === "account" ? "Account" : "Workspace";

  return (
    <div className="app">
      <a className="skip-link" href="#app-main">Skip to content</a>
      <header className="app-header">
        <button ref={menuBtnRef} className="hdr-icon-btn hdr-menu" aria-label={drawerOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={drawerOpen} aria-controls="app-nav" onClick={() => setDrawerOpen(o => !o)}>
          <Icon name={drawerOpen ? "close" : "menu"}/>
        </button>
        <a className="app-brand" href="/dashboard" onClick={e => { e.preventDefault(); go("dashboard"); }} aria-label="Command Ledger dashboard">
          <BrandMark size={34} alt=""/>
          <span className="brand-name app-brand-txt">Command Ledger</span>
        </a>
        <div className="app-crumb" aria-label="Breadcrumb">{groupLabel} <span aria-hidden="true">/</span> <b>{current.label}</b></div>
        <HeaderSearch transactions={txns} onNavigate={go} onShowTransactions={showTransactions}
          mobileOpen={mobileSearchOpen} onMobileClose={closeMobileSearch} inputRef={searchRef}/>
        <div className="hdr-tools">
          <button className="hdr-icon-btn hdr-search-toggle" aria-label="Search" onClick={() => setMobileSearchOpen(true)}><Icon name="search"/></button>
          <label className="hdr-period">
            <span className="sr-only">Reporting period</span>
            <select className="hdr-select" value={periodFilter} onChange={e => setPeriodFilter(e.target.value)}
              title="Reporting period for uploaded history">
              {PERIOD_OPTIONS.map(([v, long, short]) => <option key={v} value={v} data-short={short}>{long}</option>)}
            </select>
          </label>
          <AlertsMenu alerts={alerts} onNavigate={go}/>
          <AccountMenu name={userName} role={`Owner · ${PLANS[plan].name}`} avatar={userAvatar} email={user?.email}
            canUpgrade={plan === "software"} onNavigate={go} onUpgrade={onUpgrade} onLogout={logout}/>
        </div>
      </header>

      <AppSidebar section={section} onNavigate={go} onLogout={logout} open={drawerOpen} onClose={closeDrawer}
        planName={PLANS[plan].name} canUpgrade={plan === "software"} onUpgrade={onUpgrade} firstLinkRef={firstNavRef}/>

      <main id="app-main" className="app-main" tabIndex={-1}>
        {actionErr && (
          <div className="d-alert crit" role="alert" style={{ justifyContent:"space-between", alignItems:"center" }}>
            <span>{actionErr}</span>
            <button className="modal-x" aria-label="Dismiss" onClick={() => setActionErr("")}>×</button>
          </div>
        )}
        {!cur && <CurrencyPrompt onSave={saveBaseCurrency}/>}
        <CurrencyNotice cur={cur} excluded={excludedByCurrency} onReview={section === "transactions" ? null : () => go("transactions")}/>
        {section === "dashboard"    && <DashboardHome ctx={ctx}/>}
        {section === "transactions" && <TransactionsSection ctx={ctx}/>}
        {section === "financials"   && <FinancialsSection ctx={ctx}/>}
        {section === "advisor"      && <AdvisorSection ctx={ctx}/>}
        {section === "reports"      && <ReportsSection ctx={ctx}/>}
        {section === "decisions"    && <DecisionLogSection ctx={ctx}/>}
        {section === "forecasts"    && <ForecastsSection ctx={ctx}/>}
        {section === "settings"     && <SettingsSection ctx={ctx}/>}
        {section === "help"         && <HelpSection ctx={ctx}/>}
      </main>
    </div>
  );
}

// ─── SECTION: DASHBOARD ───────────────────────────────────────
// Compact horizontal rows, most decision-relevant first: the directive, the
// six vital numbers, then trend and what is coming. Detail lives on the
// section pages each panel links to.
function DashboardHome({ ctx }) {
  const { cur } = ctx;
  const { m, hero, supporting, go, mode, setMode, statusLine, historyLoading, rows, concentrationData,
    currentDirective, needsAcknowledgement, missedObligations, showForwardRunway, forwardRunway, upcoming,
    directives, plan, onUpgrade, onBuyDiagnostic, growth, growthConfidence, risk, trends, seasonalPattern } = ctx;
  const { hasData, dataConfidence, cashFlowPositive, burnMonths } = m;

  if (!hasData) {
    return (
      <>
        <PageHead title="Dashboard" meta={statusLine}/>
        {historyLoading ? <SkeletonKPIRow/> : (
          <Panel title="Connect your financial data">
            <p className="panel-copy">Upload a bank, QuickBooks, Xero or Wave export and every number on this page is computed from your real transactions. No file ready? Enter this month's figures by hand instead.</p>
            <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:14 }}>
              <button className="btn btn-primary btn-md" onClick={() => go("transactions")}><Icon name="upload" size={16}/>Upload a file</button>
              <button className="btn btn-outline btn-md" onClick={() => go("transactions")}>Enter numbers manually</button>
            </div>
          </Panel>
        )}
      </>
    );
  }

  const isThinData = dataConfidence === "low";
  const recentDirectives = directives.slice(0, 3);
  const actionLabel = d => ({ acted:"Acted", partially:"Partially acted", ignored:"Ignored", disagreed:"Disagreed" }[d.action_taken] || "Awaiting response");
  const total90 = upcoming.reduce((s, e) => s + e.amount, 0);

  return (
    <>
      <PageHead title="Dashboard" meta={statusLine}>
        <ReserveModeToggle mode={mode} setMode={setMode}/>
        <button className="btn btn-outline btn-md" onClick={() => go("transactions")}><Icon name="upload" size={16}/>Upload data</button>
      </PageHead>

      {currentDirective && (
        <DirectiveStrip d={currentDirective}>
          {needsAcknowledgement
            ? <button className="btn btn-primary btn-md" onClick={() => go("decisions")}>Respond to last directive</button>
            : <PanelLink to="decisions" onNavigate={go}>Decision log</PanelLink>}
        </DirectiveStrip>
      )}

      {missedObligations.length > 0 && (
        <div className="alert-row" role="status">
          {missedObligations.slice(0, 3).map((o, i) => <div key={i} className="d-alert crit">{o.message}</div>)}
        </div>
      )}

      <div>
        {isThinData && <div className="data-thin-tag">Early data: trajectory not yet assessable</div>}
        <div className={`kpi-row${isThinData ? " data-thin" : ""}`}>
          <KpiTile t={hero} hero/>
          {supporting.map(t => <KpiTile key={t.key} t={t}/>)}
        </div>
        {showForwardRunway && (
          <div className="d-alert warn" style={{ marginTop:12 }}>
            {cashFlowPositive ? "No burn on average, but " : `${safe(burnMonths).toFixed(1)} months on average burn. `}
            {forwardRunway.monthsUntilCross.toFixed(1)} months against your known obligations (around {forwardRunway.crossDate}). The second is the real number.
          </div>
        )}
      </div>

      <div className="row row-21">
        <Panel title="Cash in and cash out" action={<PanelLink to="financials" onNavigate={go}>Monthly detail</PanelLink>}>
          <BChart data={rows} currency={cur}/>
        </Panel>
        <Panel title="Trajectory" action={<PanelLink to="financials" onNavigate={go}>History</PanelLink>}>
          <div className="traj-pair">
            <div className="traj-cell">
              <Ring score={growth.score} size={76} sw={5}/>
              <div><div className="card-lbl">Growth</div><div className="traj-lbl">{growth.label}</div></div>
            </div>
            <div className="traj-cell">
              <Ring score={100 - risk.score} size={76} sw={5}/>
              <div><div className="card-lbl">Safety</div><div className="traj-lbl">{risk.label} risk</div></div>
            </div>
          </div>
          <div className="traj-note">
            {growth.seasonallyAdjusted && seasonalPattern
              ? `Growth compares ${seasonalPattern.month} with a year ago, because ${seasonalPattern.month} is seasonal for you.`
              : trends.length > 0 ? null : "No multi-month trend detected in this period."}
          </div>
          {trends.slice(0, 2).map((t, i) => (
            <div key={i} className={`d-alert ${t.direction === "improving" ? "ok" : "warn"}`} style={{ marginTop:8 }}>{t.message}</div>
          ))}
          <ConfidenceLine c={growthConfidence}/>
        </Panel>
      </div>

      <div className="row row-3">
        <Panel title="Committed costs · 90 days" action={<PanelLink to="forecasts" onNavigate={go}>Forecasts</PanelLink>}>
          {upcoming.length === 0 ? (
            <p className="panel-copy">No recurring obligations detected yet. Three similar payments on a steady schedule (rent, payroll, a quarterly tax payment) are needed before one shows here.</p>
          ) : (
            <>
              <ul className="mini-list">
                {upcoming.slice(0, 4).map((e, i) => (
                  <li key={i}><span className="mini-date">{e.date}</span><span className="mini-main">{capitalize(e.label)}</span><span className="mini-amt">{fmt(e.amount, cur)}</span></li>
                ))}
              </ul>
              <div className="mini-foot">{upcoming.length} payment{upcoming.length === 1 ? "" : "s"} due · {fmt(total90, cur)} over 90 days</div>
            </>
          )}
        </Panel>

        <Panel title="Revenue concentration" action={<PanelLink to="financials" onNavigate={go}>All clients</PanelLink>}>
          {!concentrationData?.shown ? (
            <p className="panel-copy">
              {concentrationData?.confidenceLevel === "low"
                ? `Not enough payer names could be read reliably to show this safely. ${concentrationData.reason}`
                : "Upload transaction history to see how concentrated your revenue is in your largest clients."}
            </p>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {concentrationData.payers.slice(0, 3).map((p, i) => {
                const barColor = i === 0 ? (p.pct > 60 ? C.danger : p.pct > 40 ? C.warning : C.positive) : C.platinum;
                return (
                  <div key={p.name}>
                    <div className="bar-row-lbl"><span style={{ textTransform:"capitalize" }}>{p.name}</span><span style={{ color:barColor }}>{p.pct.toFixed(1)}%</span></div>
                    <div className="bar-track"><div style={{ width:`${Math.min(100, p.pct)}%`, background:barColor }}/></div>
                  </div>
                );
              })}
              <ConfidenceLine c={{ shown:true, level:concentrationData.confidenceLevel, reason:concentrationData.reason }}/>
            </div>
          )}
        </Panel>

        <Panel title="Decision log" action={<PanelLink to="decisions" onNavigate={go}>Full log</PanelLink>}>
          {recentDirectives.length === 0 ? (
            <p className="panel-copy">No directives issued yet. Each one is logged here with whether you acted on it and what happened to its metric afterward.</p>
          ) : (
            <ul className="mini-list">
              {recentDirectives.map(d => (
                <li key={d.id} className="mini-stack">
                  <span className="mini-main">{d.directive_text}</span>
                  <span className="mini-date">{new Date(d.issued_at).toLocaleDateString()} · {actionLabel(d)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {plan === "software" && (
        <div className="nudge-row">
          <div>
            <div className="nudge-row-title">Command Advisory adds the person who reads these numbers with you.</div>
            <div className="nudge-row-sub">Monthly 1:1 call, a written board report every month, and a direct advisory line. Or start with a one-time US${DIAGNOSTIC.usd.toLocaleString()} Financial Diagnostic, credited to your first Advisory month.</div>
          </div>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
            <button className="btn btn-primary btn-md" onClick={onUpgrade}>Add Command Advisory</button>
            <button className="btn btn-outline btn-md" onClick={onBuyDiagnostic}>Buy the diagnostic</button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── SECTION: TRANSACTIONS ────────────────────────────────────
function TransactionsSection({ ctx }) {
  const { txns, history, historyLoading, batches, handleDataLoaded, uploadBusy, uploadStatus, uploadErr, deleteBatch,
    txQuery, setTxQuery, txDirection, setTxDirection, txLimit, setTxLimit, periodLabel, manual, go, m, cur, relabelBatch } = ctx;

  const filtered = useMemo(() => {
    let list = filterTransactions(txns, txQuery);
    if (txDirection === "in") list = list.filter(t => Number(t.amount) > 0);
    else if (txDirection === "out") list = list.filter(t => Number(t.amount) < 0);
    return list.slice().sort((a, b) => String(b.txn_date).localeCompare(String(a.txn_date)));
  }, [txns, txQuery, txDirection]);
  // Totals add the business currency only; other rows are listed, not summed.
  const inBase = filtered.filter(t => t.currency === cur);
  const otherCount = filtered.length - inBase.length;
  const totIn  = inBase.reduce((s, t) => s + Math.max(0, Number(t.amount) || 0), 0);
  const totOut = inBase.reduce((s, t) => s + Math.max(0, -(Number(t.amount) || 0)), 0);
  const shown = filtered.slice(0, txLimit);

  const manualFields = [
    { lbl:withSymbol("Monthly revenue", cur),           v:manual.mRev,   s:manual.setMRev },
    { lbl:withSymbol("Monthly expenses", cur),          v:manual.mExp,   s:manual.setMExp },
    { lbl:withSymbol("Cash balance", cur),              v:manual.mCash,  s:manual.setMCash },
    { lbl:withSymbol("Customer acquisition cost", cur), v:manual.mCac,   s:manual.setMCac },
    { lbl:withSymbol("Customer lifetime value", cur),   v:manual.mLtv,   s:manual.setMLtv },
    { lbl:"Leads this month",              v:manual.mLeads, s:manual.setMLeads },
    { lbl:"Deals closed",                  v:manual.mClose, s:manual.setMClose },
  ];

  return (
    <>
      <PageHead title="Transactions" meta={history.length > 0 ? `${txns.length.toLocaleString()} transactions · ${periodLabel}` : "No uploaded history yet"}/>

      <div className="row row-21">
        <Panel title="Upload a file or sync a sheet">
          <DataUpload hasData={m.hasData} onDataLoaded={handleDataLoaded} currency={cur}/>
          {uploadBusy && (
            <div className="busy-line"><span className="spinner"/>Saving to your transaction history...</div>
          )}
          {!uploadBusy && uploadStatus && (
            <div className="d-alert ok" style={{ marginTop:12, justifyContent:"space-between", alignItems:"center" }}>
              <span>{uploadStatus}</span>
              <button className="panel-link" onClick={() => go("dashboard")}>View dashboard<Icon name="arrow" size={14}/></button>
            </div>
          )}
          {!uploadBusy && uploadErr && <div className="d-alert warn" style={{ marginTop:12 }}>{uploadErr}</div>}
        </Panel>

        <Panel title="Upload history">
          {batches.length === 0 ? (
            <p className="panel-copy">No files uploaded yet. Each upload is listed here with how many transactions it added and how many were already on file. Deleting an upload deletes every transaction it added.</p>
          ) : (
            <ul className="batch-list">
              {batches.map(b => (
                <li key={b.id}>
                  <div style={{ minWidth:0 }}>
                    <div className="batch-name">{b.filename || "Untitled upload"}</div>
                    <div className="batch-meta">
                      {new Date(b.uploaded_at).toLocaleDateString()} · {b.period_start} to {b.period_end} · {b.inserted_count ?? "pending"} added, {b.duplicate_count ?? "pending"} duplicate
                      {b.currency !== cur && cur ? " · not in your figures" : ""}
                    </div>
                  </div>
                  <CurrencySelect compact ariaLabel={`Currency of ${b.filename || "this upload"}`} value={b.currency}
                    onChange={code => {
                      if (code !== b.currency && window.confirm(`Label every transaction "${b.filename || "this upload"}" added as ${code}? Amounts stay exactly as they are; only the currency label changes.`)) relabelBatch(b.id, code);
                    }}/>
                  <button className="modal-x" title="Delete this upload and its transactions" aria-label={`Delete upload ${b.filename || "Untitled upload"}`}
                    onClick={() => { if (window.confirm(`Delete "${b.filename}" and every transaction it added? This cannot be undone.`)) deleteBatch(b.id); }}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="All transactions">
        <div className="tx-tools">
          <input className="di" type="search" placeholder="Filter by description, category, date or amount" aria-label="Filter transactions"
            value={txQuery} onChange={e => { setTxQuery(e.target.value); setTxLimit(100); }} style={{ flex:"1 1 260px" }}/>
          <select className="di" aria-label="Money in or out" value={txDirection} onChange={e => { setTxDirection(e.target.value); setTxLimit(100); }} style={{ flex:"0 0 150px" }}>
            <option value="all">In and out</option>
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </select>
          <div className="tx-sum">
            {filtered.length.toLocaleString()} shown · <span style={{ color:C.positive }}>{fmt(totIn, cur)} in</span> · <span>{fmt(totOut, cur)} out</span>
            {otherCount > 0 && <> · {otherCount.toLocaleString()} in other currencies, not totalled</>}
          </div>
        </div>
        {historyLoading ? (
          <div className="busy-line"><span className="spinner"/>Loading transactions...</div>
        ) : filtered.length === 0 ? (
          <p className="panel-copy" style={{ marginTop:12 }}>
            {txns.length === 0 ? `No uploaded transactions in ${periodLabel.toLowerCase()}. Change the period in the header, or upload a file above.` : "No transactions match this filter."}
          </p>
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Category</th><th scope="col" className="num">Amount</th></tr></thead>
                <tbody>
                  {shown.map((t, i) => (
                    <tr key={t.id ?? i}>
                      <td className="mono">{t.txn_date}</td>
                      <td>{t.description || <span className="muted">No description</span>}</td>
                      <td className="muted">{t.category ? capitalize(t.category) : "Uncategorised"}{t.currency !== cur ? ` · ${t.currency}, not in your figures` : ""}</td>
                      <td className="num" style={{ color: t.currency !== cur ? C.text3 : Number(t.amount) >= 0 ? C.positive : C.text }}>{fmt(t.amount, t.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length > shown.length && (
              <button className="btn btn-outline btn-md" style={{ marginTop:12, alignSelf:"flex-start" }} onClick={() => setTxLimit(l => l + 100)}>
                Show 100 more ({(filtered.length - shown.length).toLocaleString()} remaining)
              </button>
            )}
          </>
        )}
      </Panel>

      <Panel title="Enter numbers manually">
        <details open={!m.hasData}>
          <summary className="details-summary">No file ready? Enter this month's figures. They are used for this session only and are not saved.</summary>
          <div className="input-grid input-grid-4" style={{ marginTop:14 }}>
            {manualFields.map((f, i) => (
              <div key={i} className="input-group">
                <label className="di-lbl" htmlFor={`manual-${i}`}>{f.lbl}</label>
                <input id={`manual-${i}`} className="di" type="number" min="0" value={f.v} onChange={e => f.s(Math.max(0, Number(e.target.value) || 0))}/>
              </div>
            ))}
          </div>
          {manual.mRev > 0 && <button className="btn btn-primary btn-md" onClick={() => go("dashboard")}>View my dashboard</button>}
        </details>
      </Panel>
    </>
  );
}

// ─── SECTION: FINANCIALS ──────────────────────────────────────
function FinancialsSection({ ctx }) {
  const { cur } = ctx;
  const { m, rows, mode, setMode, tr, sr, taxV, safV, concentrationData, statusLine, hasConversionData, sov, sovLbl,
    activeCac, activeLtv, cogsRatio, mktRatio, founderNarrative, seasonalPattern, historicalConfidence, go } = ctx;
  const { hasData, latest, totPro, free, margin, conv, ltvcac, ltvcacConfidence, breakEven, breakEvenConfidence } = m;
  if (!hasData) return <><PageHead title="Financials" meta={statusLine}/><EmptyData go={go}/></>;

  const monthly = (rows || []).slice().reverse();
  const totals = (rows || []).reduce((a, r) => ({ rev:a.rev + (r.revenue || 0), exp:a.exp + (r.expenses || 0) }), { rev:0, exp:0 });

  return (
    <>
      <PageHead title="Financials" meta={statusLine}>
        <ReserveModeToggle mode={mode} setMode={setMode}/>
      </PageHead>

      <div className="row row-21">
        <Panel title="Profit and loss by month">
          <div className="tbl-wrap" style={{ maxHeight:340 }}>
            <table className="tbl">
              <thead><tr><th scope="col">Month</th><th scope="col" className="num">Revenue</th><th scope="col" className="num">Expenses</th><th scope="col" className="num">Net</th><th scope="col" className="num">Margin</th></tr></thead>
              <tbody>
                {monthly.map((r, i) => {
                  const net = (r.revenue || 0) - (r.expenses || 0);
                  return (
                    <tr key={i}>
                      <td>{r.month}</td>
                      <td className="num">{fmt(r.revenue, cur)}</td>
                      <td className="num">{fmt(r.expenses, cur)}</td>
                      <td className="num" style={{ color: net >= 0 ? C.positive : C.danger }}>{fmt(net, cur)}</td>
                      <td className="num muted">{r.revenue > 0 ? pc((net / r.revenue) * 100) : "---"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr>
                <th scope="row">Total</th><td className="num">{fmt(totals.rev, cur)}</td><td className="num">{fmt(totals.exp, cur)}</td>
                <td className="num" style={{ color: totals.rev - totals.exp >= 0 ? C.positive : C.danger }}>{fmt(totals.rev - totals.exp, cur)}</td>
                <td className="num muted">{totals.rev > 0 ? pc(((totals.rev - totals.exp) / totals.rev) * 100) : "---"}</td>
              </tr></tfoot>
            </table>
          </div>
        </Panel>

        <Panel title="Capital allocator">
          {[
            { name:"Tax vault",      pct:tr * 100, amt:taxV, col:C.danger },
            { name:"Safety buffer",  pct:sr * 100, amt:safV, col:C.silver },
            { name:"True free cash", pct:totPro > 0 ? Math.max(0, (free / totPro) * 100) : 0, amt:free, col:free >= 0 ? C.platinum : C.danger },
          ].map((a, i) => (
            <div className="alloc-row" key={i}>
              <div className="alloc-meta">
                <div className="alloc-name">{a.name}</div>
                <div className="alloc-pct">{safe(a.pct).toFixed(0)}% of profit</div>
                <div className="alloc-track"><div className="alloc-fill" style={{ width:`${Math.min(100, safe(a.pct))}%`, background:a.col }}/></div>
              </div>
              <div className="alloc-amt" style={{ color:a.col }}>{fmt(a.amt, cur)}</div>
            </div>
          ))}
          <p className="panel-copy" style={{ marginTop:10 }}>
            {totPro > 0 ? `${mode === "safe" ? "Safe" : "Growth"} mode reserves are taken from ${fmt(totPro, cur)} net profit in the period.` : "A loss in the period: nothing is reserved, and free cash is the full loss."}
          </p>
        </Panel>
      </div>

      <div className="row row-3">
        <Panel title="Break-even">
          <div className="big-num">{breakEvenConfidence.shown && breakEven > 0 ? fmt(breakEven, cur) : "---"}</div>
          <p className="panel-copy">
            {breakEvenConfidence.shown && latest.revenue > 0 && breakEven > 0
              ? latest.revenue >= breakEven ? `Monthly revenue needed to cover average costs. You are ${fmt(latest.revenue - breakEven, cur)} above it.` : `Monthly revenue needed to cover average costs. You are ${fmt(breakEven - latest.revenue, cur)} below it.`
              : "Enter revenue and expenses to calculate."}
          </p>
          <ConfidenceLine c={breakEvenConfidence}/>
        </Panel>

        <Panel title="Unit economics">
          <dl className="kv">
            <dt>LTV : CAC</dt><dd>{ltvcacConfidence.shown ? `${safe(ltvcac).toFixed(1)}x` : "---"}</dd>
            <dt>Acquisition cost</dt><dd>{activeCac > 0 ? fmt(activeCac, cur) : "---"}</dd>
            <dt>Lifetime value</dt><dd>{activeLtv > 0 ? fmt(activeLtv, cur) : "---"}</dd>
            <dt>Lead conversion</dt><dd>{hasConversionData ? pc(conv) : "---"}</dd>
            <dt>COGS / revenue</dt><dd>{pc(cogsRatio)}</dd>
            <dt>Marketing / revenue</dt><dd>{pc(mktRatio)}</dd>
          </dl>
          <ConfidenceLine c={ltvcacConfidence}/>
        </Panel>

        <Panel title="Sovereignty index">
          <div style={{ display:"flex", gap:16, alignItems:"center" }}>
            <Ring score={sov} size={84} sw={5}/>
            <div>
              <div className="traj-lbl" style={{ color: sov >= 75 ? C.platinum : sov >= 50 ? C.warning : C.danger }}>{sovLbl}</div>
              <p className="panel-copy">
                {hasConversionData
                  ? <>Margin ({pc(margin * 0.6)}) plus conversion ({pc(conv * 0.4)}). Above 75 supports an aggressive scale posture.</>
                  : <>Based on margin alone ({pc(margin)}); no lead or conversion data yet.</>}
              </p>
            </div>
          </div>
        </Panel>
      </div>

      <div className="row row-2">
        <Panel title="Revenue concentration">
          {!concentrationData?.shown ? (
            <p className="panel-copy">
              {concentrationData?.confidenceLevel === "low"
                ? `Not enough payer names could be read reliably to show this safely. ${concentrationData.reason}`
                : "Upload transaction history to see how concentrated your revenue is in your largest clients."}
            </p>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {concentrationData.payers.slice(0, 5).map((p, i) => {
                const barColor = i === 0 ? (p.pct > 60 ? C.danger : p.pct > 40 ? C.warning : C.positive) : C.platinum;
                return (
                  <div key={p.name}>
                    <div className="bar-row-lbl"><span style={{ textTransform:"capitalize" }}>{p.name}</span><span style={{ color:barColor }}>{p.pct.toFixed(1)}%</span></div>
                    <div className="bar-track"><div style={{ width:`${Math.min(100, p.pct)}%`, background:barColor }}/></div>
                  </div>
                );
              })}
              <ConfidenceLine c={{ shown:true, level:concentrationData.confidenceLevel, reason:concentrationData.reason }}/>
              {concentrationData.aggregatorPct > 0.5 && (
                <p className="panel-copy">{concentrationData.aggregatorPct.toFixed(0)}% of revenue arrives through a payment processor (Shopify, Stripe, PayPal) and cannot be attributed to a single client, so it is excluded above.</p>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Business history">
          {founderNarrative ? (
            <>
              <p className="narrative">{founderNarrative}</p>
              {seasonalPattern && (
                <p className="panel-copy">{seasonalPattern.month} has run {Math.abs(seasonalPattern.avgDeltaPct).toFixed(0)}% {seasonalPattern.avgDeltaPct < 0 ? "below" : "above"} your average for {seasonalPattern.occurrences} years running. That is a repeating seasonal pattern, not a new signal.</p>
              )}
              <ConfidenceLine c={{
                shown: true,
                level: { low:"low", medium:"moderate", high:"high", "very high":"high" }[historicalConfidence?.label] || "low",
                reason: historicalConfidence?.reason || "",
              }}/>
            </>
          ) : (
            <p className="panel-copy">Builds once you have two or more months of uploaded transaction history.</p>
          )}
        </Panel>
      </div>
    </>
  );
}

function EmptyData({ go }) {
  return (
    <Panel title="No data yet">
      <p className="panel-copy">This page is computed from your transactions. Upload an export or enter this month's figures to fill it in.</p>
      <button className="btn btn-primary btn-md" style={{ marginTop:12, alignSelf:"flex-start" }} onClick={() => go("transactions")}><Icon name="upload" size={16}/>Go to Transactions</button>
    </Panel>
  );
}

// ─── SECTION: AI ADVISOR ──────────────────────────────────────
function AdvisorSection({ ctx }) {
  const { aiRec, aiError, aiLoad, runAI, m, go } = ctx;
  return (
    <>
      <PageHead title="AI Advisor" meta="A structured brief from your real numbers, generated on request"/>
      <div className="card" style={{ padding:0 }}>
        <div className="ai-top">
          <div className="ai-lbl"><div className="ai-glow"/>Command Ledger Intelligence - Powered by Claude</div>
          <button className="ai-btn" onClick={runAI} disabled={aiLoad || !m.hasData}>{aiLoad ? "Analyzing..." : "Generate Brief"}</button>
        </div>
        <div className="ai-body" style={{ padding: aiRec ? 0 : undefined }}>
          {aiLoad ? (
            <div style={{ display:"flex", alignItems:"center", gap:12, color:C.text3, fontSize:12, fontFamily:"'JetBrains Mono',monospace", padding:"20px" }}>
              <div className="ai-dots"><span/><span/><span/></div>Analyzing your financial position...
            </div>
          ) : aiRec ? (
            <AIRecommendation rec={aiRec}/>
          ) : aiError ? (
            <div className="ai-txt" style={{ padding:"20px" }}>{aiError}</div>
          ) : (
            <div className="ai-txt" style={{ padding:"20px" }}>Click Generate Brief to receive a structured recommendation: what happened, why, the business impact, the risk, the one action to take, and how confident to be in it.</div>
          )}
        </div>
      </div>
      {!m.hasData && (
        <div className="d-alert info" style={{ justifyContent:"space-between", alignItems:"center" }}>
          <span>Connect your financial data first. The brief uses your real numbers, not generic advice.</span>
          <button className="panel-link" onClick={() => go("transactions")}>Transactions<Icon name="arrow" size={14}/></button>
        </div>
      )}
      <p className="panel-copy">Sent to Claude (Anthropic) only when you click Generate Brief: your computed metrics, the names of your largest payers and recurring costs, and any notes you left on past directives. Never your transaction list.</p>
    </>
  );
}

// ─── SECTION: REPORTS ─────────────────────────────────────────
// A monthly summary the founder can hand to an accountant, investor or
// board: the same profit-and-loss table and metrics shown in the app,
// downloadable as CSV or printed to PDF from the browser.
function ReportsSection({ ctx }) {
  const { cur } = ctx;
  const { m, rows, reportSummary, periodLabel, todayStr, profile, userName, plan, statusLine, go } = ctx;
  if (!m.hasData) return <><PageHead title="Reports" meta={statusLine}/><EmptyData go={go}/></>;

  const monthly = rows || [];
  const totals = monthly.reduce((a, r) => ({ rev:a.rev + (r.revenue || 0), exp:a.exp + (r.expenses || 0) }), { rev:0, exp:0 });
  const downloadCsv = () => {
    const csv = buildReportCsv({ periodLabel, generatedAt: todayStr, rows: monthly, summary: reportSummary, currency: cur });
    const url = URL.createObjectURL(new Blob([csv], { type:"text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `command-ledger-summary-${todayStr}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <PageHead title="Reports" meta="Monthly financial summary">
        <button className="btn btn-outline btn-md" onClick={downloadCsv}><Icon name="download" size={16}/>Download CSV</button>
        <button className="btn btn-primary btn-md" onClick={() => window.print()}><Icon name="print" size={16}/>Print or save PDF</button>
      </PageHead>

      <div className="panel print-area">
        <div className="report-head">
          <div>
            <div className="report-title">Financial summary</div>
            <div className="page-meta">{profile?.business || userName} · {periodLabel} · {currencyName(cur)} · generated {todayStr}</div>
          </div>
          <div className="page-meta">Command Ledger</div>
        </div>
        <div className="row row-12" style={{ marginTop:16 }}>
          <div>
            <h2 className="panel-title" style={{ marginBottom:10 }}>Key metrics</h2>
            <dl className="kv kv-wide">
              {reportSummary.map(([k, v]) => <div key={k} style={{ display:"contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          </div>
          <div style={{ minWidth:0 }}>
            <h2 className="panel-title" style={{ marginBottom:10 }}>Profit and loss by month</h2>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th scope="col">Month</th><th scope="col" className="num">Revenue</th><th scope="col" className="num">Expenses</th><th scope="col" className="num">Net</th><th scope="col" className="num">Margin</th></tr></thead>
                <tbody>
                  {monthly.map((r, i) => {
                    const net = (r.revenue || 0) - (r.expenses || 0);
                    return <tr key={i}><td>{r.month}</td><td className="num">{fmt(r.revenue, cur)}</td><td className="num">{fmt(r.expenses, cur)}</td><td className="num">{fmt(net, cur)}</td><td className="num">{r.revenue > 0 ? pc((net / r.revenue) * 100) : "---"}</td></tr>;
                  })}
                </tbody>
                <tfoot><tr><th scope="row">Total</th><td className="num">{fmt(totals.rev, cur)}</td><td className="num">{fmt(totals.exp, cur)}</td><td className="num">{fmt(totals.rev - totals.exp, cur)}</td><td className="num">{totals.rev > 0 ? pc(((totals.rev - totals.exp) / totals.rev) * 100) : "---"}</td></tr></tfoot>
              </table>
            </div>
          </div>
        </div>
        <p className="panel-copy" style={{ marginTop:14 }}>Figures are computed from the transactions on file for this period. A metric shown as "Not enough data" lacks the inputs to be stated honestly; it is not zero.</p>
      </div>

      {plan === "advisory" && (
        <p className="panel-copy">Your written monthly board report is prepared by your advisor and delivered by email; this page is the self-serve summary.</p>
      )}
    </>
  );
}

// ─── SECTION: DECISION LOG ────────────────────────────────────
function DecisionLogSection({ ctx }) {
  const { cur } = ctx;
  const { currentDirective, directives, directivesLoading, latestDirective, needsAcknowledgement, ackNote, setAckNote, acknowledgeDirective } = ctx;
  return (
    <>
      <PageHead title="Decision Log" meta="Every directive issued, what you did, and what happened next"/>
      {currentDirective && <DirectiveStrip d={currentDirective}/>}

      {needsAcknowledgement && (
        <Panel title="Did you act on this?" style={{ borderLeft:`3px solid ${C.platinum}` }}>
          <p className="narrative" style={{ marginBottom:12 }}>
            Last directive ({new Date(latestDirective.issued_at).toLocaleDateString()}): "{latestDirective.directive_text}"
          </p>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
            {[["acted","Acted"],["partially","Partially"],["ignored","Ignored"],["disagreed","I disagreed"]].map(([val, lbl]) => (
              <button key={val} className="btn btn-primary btn-md" onClick={() => acknowledgeDirective(latestDirective.id, val)}>{lbl}</button>
            ))}
          </div>
          <label className="sr-only" htmlFor="ack-note">Note</label>
          <textarea id="ack-note" className="di" placeholder="Optional note: why you did or did not act"
            value={ackNote} onChange={e => setAckNote(e.target.value)}
            style={{ minHeight:56, resize:"vertical", fontFamily:"'Cormorant Garamond',serif", fontSize:14 }}/>
        </Panel>
      )}

      <Panel title="History">
        {directivesLoading ? (
          <div className="busy-line"><span className="spinner"/>Loading decision history...</div>
        ) : directives.length === 0 ? (
          <p className="panel-copy">No directives issued yet. Once Command Ledger issues its first call, it is logged here permanently, with whether you acted on it and what happened to the metric it targeted.</p>
        ) : (
          <ul className="log-list">
            {directives.map(d => {
              const uc = { critical:C.danger, warn:C.warning, go:C.positive, stable:C.platinum }[d.severity] || C.platinum;
              const outcome = describeDirectiveOutcome(d, d.currency || cur);
              const actionLabel = { acted:"Acted", partially:"Partially acted", ignored:"Ignored", disagreed:"Disagreed" }[d.action_taken] || "Awaiting response";
              const outcomeColor = outcome.status === "measured"
                ? (outcome.improved === true ? C.positive : outcome.improved === false ? C.danger : C.text2)
                : C.text3;
              return (
                <li key={d.id} style={{ borderLeftColor:uc }}>
                  <div className="log-top">
                    <span className="log-text">{d.directive_text}</span>
                    <span className="mini-date">{new Date(d.issued_at).toLocaleDateString()}</span>
                  </div>
                  <div className="log-meta">{actionLabel}{d.founder_note ? `: "${d.founder_note}"` : ""}</div>
                  <div className="log-meta" style={{ color:outcomeColor }}>{outcome.message}</div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}

// ─── SECTION: FORECASTS ───────────────────────────────────────
function ForecastsSection({ ctx }) {
  const { cur } = ctx;
  const { m, statusLine, go, runwayText, forwardRunway, activeObligations, upcoming, todayStr, setObligationActive,
    affordInput, setAffordInput, setAffordAmount, affordResult, checkAfford, scenario, scenarioRunway,
    scRevPct, setScRevPct, scExpPct, setScExpPct, scHire, setScHire, scCash, setScCash } = ctx;
  const { hasData, proj90, proj90Confidence, vel, runwayConfidence, hiringCapacity } = m;
  if (!hasData) return <><PageHead title="Forecasts" meta={statusLine}/><EmptyData go={go}/></>;

  const weeks = summarizeCalendarByWeek(upcoming, todayStr, 91);
  const maxWeek = Math.max(1, ...weeks.map(w => w.total));

  return (
    <>
      <PageHead title="Forecasts" meta="Projections, committed costs and what-if scenarios"/>

      <div className="row row-3">
        <Panel title="90-day revenue projection">
          <div className="big-num">{proj90Confidence.shown && safe(proj90) > 0 ? fmt(proj90, cur) : "---"}</div>
          <p className="panel-copy">Monthly revenue in three months at your trailing growth rate ({pc(vel)} last month), capped at ±50% a month.</p>
          <ConfidenceLine c={proj90Confidence}/>
        </Panel>
        <Panel title="Runway on average burn">
          <div className="big-num">{runwayText}</div>
          <p className="panel-copy">Cash divided by average monthly net burn, less the reserve mode's safety share.</p>
          <ConfidenceLine c={runwayConfidence}/>
        </Panel>
        <Panel title="Runway against known bills">
          <div className="big-num">{!forwardRunway ? "---" : forwardRunway.crossesZero ? `${forwardRunway.monthsUntilCross} mo` : "12+ mo"}</div>
          <p className="panel-copy">
            {!forwardRunway ? "Needs a cash balance and at least one detected recurring obligation."
              : forwardRunway.crossesZero ? `Cash reaches zero around ${forwardRunway.crossDate}, counting recurring bills on their real dates.`
              : "Cash holds for the next 12 months against your recurring bills on their real dates."}
          </p>
        </Panel>
      </div>

      <div className="row row-21">
        <Panel title="Committed costs">
          {activeObligations.length === 0 ? (
            <p className="panel-copy">No recurring obligations detected yet. Three similar payments on a steady schedule (rent, payroll, a quarterly tax payment) are needed before one shows here.</p>
          ) : (
            <ul className="batch-list">
              {activeObligations.map(o => (
                <li key={o.id}>
                  <div style={{ minWidth:0 }}>
                    <div className="batch-name" style={{ textTransform:"capitalize" }}>{o.label}</div>
                    <div className="batch-meta">{CADENCE_LABEL[o.cadence] || capitalize(o.cadence)}{o.amount_variance === "variable" ? " · variable amount" : ""} · next {o.next_expected}</div>
                    <ConfidenceLine c={{ shown:true, level:o.confidence, reason:`${o.occurrences} occurrences observed` }}/>
                  </div>
                  <div style={{ textAlign:"right", flexShrink:0 }}>
                    <div className="mini-amt">{fmt(o.typical_amount, cur)}</div>
                    <button className="panel-link" style={{ marginTop:4 }} onClick={() => setObligationActive(o.id, false)}>Mark ended</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Next 13 weeks">
          {upcoming.length === 0 ? (
            <p className="panel-copy">The week-by-week calendar fills in once recurring obligations are detected.</p>
          ) : (
            <ul className="week-list" aria-label="Committed costs by week">
              {weeks.map(w => (
                <li key={w.weekStart}>
                  <span className="mini-date">{w.weekStart.slice(5)}</span>
                  <span className="bar-track week-bar"><span style={{ width:`${(w.total / maxWeek) * 100}%`, background: w.total > 0 ? C.platinum : "transparent" }}/></span>
                  <span className="mini-amt">{w.total > 0 ? fmt(w.total, cur) : "None"}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="row row-12">
        <Panel title="Can I afford it?">
          <label className="di-lbl" htmlFor="afford-input">{withSymbol("A hire, or any recurring cost, per month", cur)}</label>
          <div style={{ display:"flex", gap:8 }}>
            <input id="afford-input" type="number" min="0" className="di" placeholder={hiringCapacity > 0 ? `e.g. ${Math.round(hiringCapacity)}` : "e.g. 1500"}
              value={affordInput} onChange={e => { setAffordInput(e.target.value); setAffordAmount(null); }} onKeyDown={e => e.key === "Enter" && checkAfford()}/>
            <button className="btn btn-primary btn-md" onClick={checkAfford}>Check</button>
          </div>
          {affordResult && <div className={`d-alert ${affordResult.affordable ? "ok" : "crit"}`} style={{ marginTop:12 }}>{affordResult.message}</div>}
          <p className="panel-copy" style={{ marginTop:10 }}>Tested over 12 months against your cash and recurring bills on their real dates.{hiringCapacity > 0 ? ` Your average profit alone covers up to ${fmt(hiringCapacity, cur)}/month.` : ""}</p>
        </Panel>

        <Panel title="Scenario planning" action={(scRevPct !== 0 || scExpPct !== 0 || scHire !== 0 || scCash !== 0)
          ? <button className="panel-link" onClick={() => { setScRevPct(0); setScExpPct(0); setScHire(0); setScCash(0); }}>Reset</button> : null}>
          <div className="input-grid input-grid-4">
            {[
              { id:"sc-rev",  lbl:"Revenue change (%)",         v:scRevPct, s:setScRevPct },
              { id:"sc-exp",  lbl:"Expense change (%)",         v:scExpPct, s:setScExpPct },
              { id:"sc-hire", lbl:withSymbol("New hire, monthly cost", cur), v:scHire,   s:setScHire, min:0 },
              { id:"sc-cash", lbl:withSymbol("One-time cash change", cur),   v:scCash,   s:setScCash },
            ].map(f => (
              <div key={f.id} className="input-group">
                <label className="di-lbl" htmlFor={f.id}>{f.lbl}</label>
                <input id={f.id} className="di" type="number" min={f.min} value={f.v} onChange={e => f.s(Number(e.target.value))}/>
              </div>
            ))}
          </div>
          <div className="kpi4" style={{ gap:12 }}>
            {[
              { lbl:"Margin", before:pc(scenario.before.margin), after:pc(scenario.after.margin), better: scenario.after.margin >= scenario.before.margin },
              { lbl:"True free cash", before:fmt(scenario.before.free, cur), after:fmt(scenario.after.free, cur), better: scenario.after.free >= scenario.before.free },
              { lbl:"Cash position", before:scenarioRunway(scenario.before), after:scenarioRunway(scenario.after),
                better: scenario.after.cashFlowPositive || scenario.after.burnMonths >= scenario.before.burnMonths },
              { lbl:"Risk score", before:`${scenario.before.risk.score.toFixed(0)} - ${scenario.before.risk.label}`, after:`${scenario.after.risk.score.toFixed(0)} - ${scenario.after.risk.label}`, better: scenario.after.risk.score <= scenario.before.risk.score },
            ].map((row, i) => (
              <div key={i} className="scenario-cell">
                <div className="card-lbl">{row.lbl}</div>
                <div className="scenario-before">{row.before}</div>
                <div className="scenario-after" style={{ color: row.better ? C.positive : C.danger }}>→ {row.after}</div>
              </div>
            ))}
          </div>
          <p className="panel-copy" style={{ marginTop:10 }}>Nothing here is saved. It reruns your real calculation engine on a hypothetical month.</p>
        </Panel>
      </div>
    </>
  );
}

// ─── SECTION: SETTINGS ────────────────────────────────────────
function SettingsSection({ ctx }) {
  const { user, profile, plan, mode, setMode, onUpgrade, onBuyDiagnostic, onProfileChange, go } = ctx;
  const [name, setName] = useState(profile?.name || "");
  const [business, setBusiness] = useState(profile?.business || "");
  const [baseCur, setBaseCur] = useState(profile?.base_currency || "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const currencyChanged = !!baseCur && baseCur !== (profile?.base_currency || "");
  const dirty = name.trim() !== (profile?.name || "") || business.trim() !== (profile?.business || "") || currencyChanged;

  const save = async e => {
    e.preventDefault();
    // Changing the currency converts nothing. Say what happens to the
    // transactions already on file before it is saved.
    if (currencyChanged && profile?.base_currency && !window.confirm(
      `Change your business currency from ${profile.base_currency} to ${baseCur}? Nothing is converted. Transactions in ${profile.base_currency} will be left out of your figures until you change the currency of their upload under Transactions.`)) return;
    setSaving(true); setMsg(null);
    // plan, status and paypal_subscription_id are never sent: the database
    // guard would discard them anyway, and only the PayPal webhook sets them.
    const { data, error } = await supabase.from("profiles")
      .update({ name: name.trim() || null, business: business.trim() || null, ...(currencyChanged ? { base_currency: baseCur } : {}), updated_at: new Date().toISOString() })
      .eq("id", user.id).select().single();
    setSaving(false);
    if (error) { console.error("Profile update failed:", error); setMsg({ t:"crit", text:"Your profile could not be saved. Nothing was changed, so try again." }); return; }
    onProfileChange(data);
    setMsg({ t:"ok", text:"Saved." });
  };

  const statusText = { active:"Active", suspended:"Suspended: a payment failed and PayPal will retry", canceled:"Cancelled", expired:"Expired" }[profile?.status] || "Active";

  return (
    <>
      <PageHead title="Settings" meta={user?.email}/>
      <div className="row row-2">
        <Panel title="Profile">
          <form onSubmit={save} className="form-stack">
            <div className="input-group">
              <label className="di-lbl" htmlFor="set-name">Name</label>
              <input id="set-name" className="di" value={name} maxLength={120} onChange={e => setName(e.target.value)}/>
            </div>
            <div className="input-group">
              <label className="di-lbl" htmlFor="set-business">Business name</label>
              <input id="set-business" className="di" value={business} maxLength={160} onChange={e => setBusiness(e.target.value)} placeholder="Shown on your reports"/>
            </div>
            <div className="input-group">
              <label className="di-lbl" htmlFor="set-currency">Business currency</label>
              <CurrencySelect id="set-currency" value={baseCur} onChange={setBaseCur}/>
            </div>
            <div className="input-group">
              <label className="di-lbl" htmlFor="set-email">Email</label>
              <input id="set-email" className="di" value={user?.email || ""} readOnly aria-readonly="true"/>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <button className="btn btn-primary btn-md" type="submit" disabled={saving || !dirty}>{saving ? "Saving..." : "Save changes"}</button>
              {msg && <span role="status" style={{ fontSize:12.5, color: msg.t === "ok" ? C.positive : C.danger }}>{msg.text}</span>}
            </div>
          </form>
        </Panel>

        <Panel title="Plan and billing">
          <dl className="kv">
            <dt>Plan</dt><dd>{PLANS[plan].name}</dd>
            <dt>Price</dt><dd>US${PLANS[plan].usd.toLocaleString()} {PLANS[plan].period}</dd>
            <dt>Status</dt><dd>{statusText}</dd>
          </dl>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:14 }}>
            {plan === "software" && <button className="btn btn-primary btn-md" onClick={onUpgrade}>Add Command Advisory</button>}
            <a className="btn btn-outline btn-md" href="https://www.paypal.com/myaccount/autopay/" target="_blank" rel="noopener noreferrer">Manage or cancel in PayPal</a>
          </div>
          <p className="panel-copy" style={{ marginTop:12 }}>
            Subscriptions are billed and cancelled through PayPal. Upgrading cancels your current subscription automatically once the new one is active.
            {plan === "software" && " Annual billing (US$990/year) is arranged by email."}
          </p>
          <button className="panel-link" style={{ marginTop:8 }} onClick={onBuyDiagnostic}>Buy a one-time US${DIAGNOSTIC.usd.toLocaleString()} Financial Diagnostic<Icon name="arrow" size={14}/></button>
        </Panel>
      </div>

      <div className="row row-2">
        <Panel title="Reserve mode">
          <div style={{ marginBottom:12 }}><ReserveModeToggle mode={mode} setMode={setMode}/></div>
          <p className="panel-copy">
            Safe mode holds back 30% of profit for tax and 20% as a safety buffer; Growth mode holds back 25% and 10%. It changes True Free Cash, runway and hiring capacity everywhere. Saved on this device.
          </p>
        </Panel>
        <Panel title="Your data">
          <p className="panel-copy">
            Transactions you upload are stored in your private history, readable only by your login. The uploaded file itself is not kept. Deleting an upload removes every transaction it added.
          </p>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:12 }}>
            <button className="btn btn-outline btn-md" onClick={() => go("transactions")}>Manage uploads</button>
            <a className="btn btn-outline btn-md" href="mailto:commandledger@gmail.com?subject=Delete%20my%20account">Request account deletion</a>
          </div>
          <p className="panel-copy" style={{ marginTop:10 }}>Account deletion is carried out by our team on request. It removes your login and every transaction stored under it, and it cannot be undone.</p>
        </Panel>
      </div>

      <div className="row row-2">
        <PasswordPanel user={user}/>
        <Panel title="Email">
          <p className="panel-copy">
            Command Ledger sends only account email: sign-in confirmations and password resets from our authentication provider. Payment receipts come from PayPal. There is no marketing email to opt out of, so there are no preferences to set here.
          </p>
          <dl className="kv" style={{ marginTop:14 }}>
            <dt>Account email</dt><dd>{user?.email}</dd>
          </dl>
        </Panel>
      </div>
    </>
  );
}

// Password change for email-and-password accounts, through Supabase Auth's
// own updateUser on the signed-in session. Accounts that sign in with
// Google have no Command Ledger password to change, and are told so rather
// than shown a form that cannot work.
function PasswordPanel({ user }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const providers = user?.app_metadata?.providers || (user?.app_metadata?.provider ? [user.app_metadata.provider] : []);
  const hasPassword = providers.includes("email");
  const strong = pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);

  const submit = async e => {
    e.preventDefault();
    setMsg(null);
    if (!strong) { setMsg({ t:"crit", text:"Use at least 8 characters, with both letters and numbers." }); return; }
    if (pw !== pw2) { setMsg({ t:"crit", text:"The two passwords do not match." }); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { console.error("Password update failed:", error); setMsg({ t:"crit", text: error.message || "Your password could not be changed. Try again." }); return; }
    setPw(""); setPw2("");
    setMsg({ t:"ok", text:"Password changed." });
  };

  if (!hasPassword) {
    return (
      <Panel title="Password">
        <p className="panel-copy">You sign in with {providers.length ? providers.map(capitalize).join(" or ") : "an external provider"}, so there is no Command Ledger password to change. Manage your password with that provider.</p>
      </Panel>
    );
  }
  return (
    <Panel title="Password">
      <form onSubmit={submit} className="form-stack">
        <div className="input-group">
          <label className="di-lbl" htmlFor="pw-new">New password</label>
          <input id="pw-new" className="di" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} minLength={8} required/>
        </div>
        <div className="input-group">
          <label className="di-lbl" htmlFor="pw-confirm">Confirm new password</label>
          <input id="pw-confirm" className="di" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} minLength={8} required/>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <button className="btn btn-primary btn-md" type="submit" disabled={busy || !pw || !pw2}>{busy ? "Saving..." : "Change password"}</button>
          {msg && <span role="status" style={{ fontSize:13.5, color: msg.t === "ok" ? C.positive : C.danger }}>{msg.text}</span>}
        </div>
        <p className="panel-copy" style={{ fontSize:13.5 }}>At least 8 characters, with both letters and numbers.</p>
      </form>
    </Panel>
  );
}

// ─── SECTION: HELP & SUPPORT ──────────────────────────────────
const HELP_FAQ = [
  ["How is runway calculated?", "Your cash balance divided by average monthly net burn (expenses minus revenue), less the reserve mode's safety share. If revenue covers costs, there is no burn and runway shows \"No burn\". Forecasts also shows runway against your recurring bills on their real dates, which catches a large bill landing soon."],
  ["What is True Free Cash?", "Net profit for the selected period, after the reserve mode's tax and safety shares. A loss reserves nothing, so free cash is the full loss."],
  ["What is Hiring Capacity?", "The largest fully-loaded monthly cost (salary, payroll tax, benefits) your average monthly profit covers after the safety share. It scales with your business. To test a specific salary against your cash and bills, use Can I afford it? under Forecasts."],
  ["Why do some numbers show ---?", "A metric whose inputs are missing is shown as ---, never as zero, because a zero would be a claim. Add the missing input (for example a cash balance) and it appears."],
  ["What do the confidence labels mean?", "Each metric is graded on how many months of data stand behind it and how recent your latest transaction is. Under three months is low confidence; data older than 45 days lowers it a level."],
  ["What does the period selector change?", "Which uploaded transactions feed the metrics and tables: the last 3, 6 or 12 months, or all time. Recurring obligations are always detected from your full history."],
];

function HelpSection({ ctx }) {
  const { plan } = ctx;
  return (
    <>
      <PageHead title="Help & Support" meta="How the numbers work, and how to reach us"/>
      <div className="row row-12">
        <Panel title="Contact">
          <p className="panel-copy">Questions about your numbers, your data or your subscription:</p>
          <a className="btn btn-primary btn-md" style={{ marginTop:12, alignSelf:"flex-start" }} href="mailto:commandledger@gmail.com?subject=Command%20Ledger%20support">Email support</a>
          {plan === "advisory" && (
            <>
              <p className="panel-copy" style={{ marginTop:16 }}>Command Advisory: direct line for capital decisions, priority 4-hour response, and your monthly 60-minute strategy call.</p>
              <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:12 }}>
                <a className="btn btn-outline btn-md" href="mailto:commandledger@gmail.com?subject=Advisory%20support%20request">Email the advisory line</a>
                <a className="btn btn-outline btn-md" href="https://calendly.com/commandledger" target="_blank" rel="noopener noreferrer">Book a session</a>
              </div>
            </>
          )}
        </Panel>
        <Panel title="How the numbers work">
          <div className="faq-list">
            {HELP_FAQ.map(([q, a]) => (
              <details key={q} className="faq-d">
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}

// ─── LOGIN PAGE ───────────────────────────────────────────────
function LoginPage({ onBack }) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [mode,     setMode]     = useState("login");
  const [loading,  setLoading]  = useState(false);
  const [err,      setErr]      = useState("");
  const [msg,      setMsg]      = useState("");

  const isStrongPassword = (pw) => pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErr(""); setMsg(""); setLoading(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        if (!isStrongPassword(password)) {
          setErr("Password must be at least 8 characters and include both letters and numbers.");
          setLoading(false);
          return;
        }
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMsg("Account created. Check your email to verify, then sign in.");
        setMode("login");
      }
    } catch (x) { setErr(x.message || "Authentication failed."); }
    finally { setLoading(false); }
  };

  const handleGoogle = async () => {
    setErr(""); setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) { setErr(error.message); setLoading(false); }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo-row" style={{ cursor:"pointer" }} {...clickableProps(onBack, { label:"Back to Command Ledger home" })}>
          <BrandMark size={150} framed alt="Command Ledger"/>
        </div>
        <div className="auth-h">
          <h1 className="auth-title">{mode === "login" ? "Sign in" : "Create your account"}</h1>
          <p className="auth-sub">{mode === "login" ? "Welcome back to your financial command centre." : "Start with your own exports. No bank login required."}</p>
        </div>
        <form className="auth-form" onSubmit={handleSubmit}>
          {err && <div className="a-err">{err}</div>}
          {msg && <div className="a-ok">{msg}</div>}
          <label className="fl">Email Address</label>
          <input className="fi" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" disabled={loading}/>
          <label className="fl">Password</label>
          <input className="fi" type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="8+ characters" disabled={loading}/>
          <button className="btn btn-gold btn-full" style={{ marginTop:12 }} type="submit" disabled={loading}>
            {loading ? <span className="spinner"/> : mode === "login" ? "Sign In" : "Create Account"}
          </button>
          <div className="a-div"><div className="a-div-line"/><span style={{ fontSize:10, color:C.text3, textTransform:"uppercase", letterSpacing:"0.1em" }}>or</span><div className="a-div-line"/></div>
          <button className="btn btn-full" type="button" onClick={handleGoogle} disabled={loading}
            style={{ background:"#fff", border:"1px solid #dadce0", color:"#3c4043", borderRadius:4, fontSize:15, padding:"13px 32px", letterSpacing:"0.01em", textTransform:"none", fontWeight:500, display:"flex", alignItems:"center", justifyContent:"center", gap:12 }}>
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path d="M17.64 9.2c0-.63-.06-1.25-.16-1.84H9v3.47h4.84c-.21 1.12-.84 2.07-1.79 2.7v2.25h2.91c1.7-1.56 2.68-3.86 2.68-6.58z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.47-.8 5.96-2.2l-2.91-2.25c-.8.54-1.84.87-3.05.87-2.34 0-4.33-1.57-5.03-3.68H.95v2.33A8.99 8.99 0 0 0 9 18z" fill="#34A853"/>
              <path d="M3.97 10.74c-.18-.54-.28-1.12-.28-1.74s.1-1.2.28-1.74V4.93H.95A8.99 8.99 0 0 0 0 9c0 1.46.35 2.85.95 4.07l3.02-2.33z" fill="#FBBC05"/>
              <path d="M9 3.58c1.32 0 2.5.45 3.44 1.35L15 2.3C13.47.89 11.43 0 9 0 5.48 0 2.43 2.01.95 4.93l3.02 2.33c.7-2.11 2.69-3.68 5.03-3.68z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
          <div className="a-link" {...clickableProps(() => setMode(mode==="login"?"register":"login"))}>
            {mode==="login" ? <>New? <span>Create an account</span></> : <>Have an account? <span>Sign in</span></>}
          </div>
          <div className="a-link" {...clickableProps(onBack)} style={{ marginTop:8 }}><span>Back to site</span></div>
        </form>
      </div>
    </div>
  );
}

// ─── BRAND MARK ───────────────────────────────────────────────
// assets/Logo.png is the brand mark. public/brand holds the same image
// scaled down, never cropped, recoloured or redrawn; this picks the
// smallest copy that stays sharp at the requested size.
// Large instances are framed: the logo's own lighting, a soft glow behind
// the monogram, reads as a faint square at large sizes, so a hairline
// plate makes that square deliberate instead of hiding or altering it.
function BrandMark({ size = 40, alt = "Command Ledger", framed = false }) {
  const src = size > 256 ? "/brand/logo-640.png" : size > 96 ? "/brand/icon-512.png" : "/brand/icon-192.png";
  const img = <img className="brand-mark" src={src} width={size} height={size} alt={alt} decoding="async"/>;
  return framed ? <span className="brand-plate" style={{ width:size + 2, height:size + 2 }}>{img}</span> : img;
}

function BrandLockup({ size = 52, onClick, href = "/" }) {
  return (
    <a className="brand-lockup" href={href} onClick={onClick} aria-label="Command Ledger home">
      <BrandMark size={size} alt="" framed/>
      <span className="brand-name">Command Ledger</span>
    </a>
  );
}

// ─── SAMPLE BUSINESS ──────────────────────────────────────────
// Three months of a fictional consultancy, used on the public site. No
// figure from it is typed in: everything shown is computed from this CSV
// by the same functions the signed-in app runs, and every place it
// appears is labelled as sample data.
const EXAMPLE_CSV = `Date,Description,Amount
2026-04-03,Acme Corp retainer,18500
2026-04-08,AWS hosting,-1240
2026-04-12,Payroll run,-14200
2026-04-18,Bolt Studio project,9600
2026-04-22,Facebook Ads,-4100
2026-05-02,Acme Corp retainer,18500
2026-05-09,AWS hosting,-1310
2026-05-12,Payroll run,-14200
2026-05-20,Bolt Studio project,7200
2026-05-24,Facebook Ads,-5400
2026-06-01,Acme Corp retainer,18500
2026-06-10,AWS hosting,-1290
2026-06-12,Payroll run,-15600
2026-06-19,Bolt Studio project,6100
2026-06-25,Facebook Ads,-6800`;

const NO_MANUAL = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
const titleCase = s => String(s || "").replace(/\b\w/g, c => c.toUpperCase());

const SAMPLE = (() => {
  const rows = parseAnyCSV(EXAMPLE_CSV).rows;
  const metrics = computeMetrics(rows, NO_MANUAL, "safe");
  const txns = parseTransactions(EXAMPLE_CSV).transactions;
  const concentration = computeRevenueConcentration(txns);
  const obligations = detectRecurringObligations(txns, { asOf: "2026-06-30" });
  const directive = computeDirective({ margin: metrics.margin, burnMonths: metrics.burnMonths, free: metrics.free, vel: metrics.vel,
    conv: metrics.conv, ltvcac: metrics.ltvcac, months: metrics.n, concentration });
  const first = rows[0], last = rows[rows.length - 1];
  const marginOf = r => r.revenue > 0 ? ((r.revenue - r.expenses) / r.revenue) * 100 : 0;
  const change = (a, b) => a > 0 ? ((b - a) / a) * 100 : 0;
  // What June's margin would be with ad spend back at April's level.
  const juneAdsAtApril = last.revenue > 0 ? ((last.revenue - (last.expenses - (last.marketing - first.marketing))) / last.revenue) * 100 : 0;
  return {
    rows, metrics, txns, concentration, obligations, directive, first, last,
    marginFirst: marginOf(first), marginLast: marginOf(last),
    revenueChange: change(first.revenue, last.revenue), costChange: change(first.expenses, last.expenses),
    adsChange: change(first.marketing, last.marketing), juneAdsAtApril,
    committed: obligations.reduce((s, o) => s + o.typical_amount, 0),
    topClient: concentration?.shown ? titleCase(concentration.payers[0].name) : null,
    topClientPct: concentration?.shown ? concentration.payers[0].pct : null,
    confidence: computeConfidence(metrics.n, null),
  };
})();

const riskTone = label => label === "Low" ? C.positive : label === "Watch" ? C.text : label === "Elevated" ? C.warning : C.danger;

// ─── HERO PRODUCT PREVIEW ─────────────────────────────────────
// The app's own dashboard components, fed by the real engine. It opens on
// the sample business; a visitor can drop their own CSV, which is computed
// in this browser tab and never uploaded.
function HeroDemo() {
  const [own, setOwn] = useState(null);
  const [err, setErr] = useState("");
  const handleFile = async file => {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) { setErr("Choose a .csv export from your bank or accounting software."); return; }
    try {
      const parsed = parseAnyCSV(await file.text());
      if (!parsed || parsed.rows.length === 0) { setErr("No revenue or expense columns were found in that file."); return; }
      setErr(""); setOwn({ rows: parsed.rows, label: file.name, currency: parsed.currency });
    } catch { setErr("That file could not be read."); }
  };
  const rows = own ? own.rows : SAMPLE.rows;
  // The sample is in US dollars. A visitor's file is shown in the currency
  // it declares, or as bare numbers when it declares none.
  const demoCur = own ? own.currency : "USD";
  const m = own ? computeMetrics(rows, NO_MANUAL, "safe", { currency: demoCur }) : SAMPLE.metrics;
  const tiles = [
    { key:"free", lbl:"True free cash", val:fmtCompact(m.free, demoCur), title:fmt(m.free, demoCur), col: m.free >= 0 ? C.text : C.danger, sub:"After tax and safety reserves" },
    { key:"margin", lbl:"Profit margin", val:pc(m.margin), col: m.margin > 0 ? C.positive : C.danger, sub:`${fmtCompact(m.totPro, demoCur)} net over ${m.n} month${m.n === 1 ? "" : "s"}` },
    { key:"runway", lbl:"Runway", val: m.cashFlowPositive ? "No burn" : (m.runwayConfidence.shown && m.burnMonths > 0) ? `${safe(m.burnMonths).toFixed(1)} mo` : "---",
      col: m.cashFlowPositive ? C.positive : C.text, sub: m.cashFlowPositive ? "Revenue covers costs" : "Needs a cash balance" },
    { key:"risk", lbl:"Risk score", val: m.risk.score.toFixed(0), unit:"/100", col: riskTone(m.risk.label), sub: m.risk.label },
  ];
  return (
    <div className="mk-demo" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}>
      <div className="mk-demo-bar">
        <BrandMark size={22} alt=""/>
        <span className="mk-demo-title">Dashboard</span>
        <span className="mk-demo-tag">{own ? own.label : "Sample data"}</span>
      </div>
      <div className="mk-demo-body">
        {!own && <DirectiveStrip d={SAMPLE.directive} compact/>}
        <div className="mk-demo-kpis">{tiles.map(t => <KpiTile key={t.key} t={t}/>)}</div>
        <div className="panel" style={{ padding:"14px 16px" }}>
          <div className="panel-head" style={{ marginBottom:10 }}>
            <h3 className="panel-title">Cash in and cash out</h3>
            <span className="page-meta" style={{ marginTop:0 }}>{demoCur ? `Monthly, ${demoCur}` : "Monthly"}</span>
          </div>
          <BChart data={rows} currency={demoCur} compact/>
        </div>
      </div>
      <div className="mk-demo-foot">
        <span>{own ? "Computed from your file in this browser tab. Nothing was uploaded." : "Computed live by the Command Ledger engine from three months of sample transactions."}</span>
        <span>
          <input type="file" id="mk-demo-file" accept=".csv" className="sr-only" onChange={e => handleFile(e.target.files[0])}/>
          {own ? <button className="btn-link" onClick={() => setOwn(null)}>Back to the sample</button>
            : <label htmlFor="mk-demo-file">Try it with your own CSV</label>}
        </span>
        {err && <span className="mk-demo-err" role="alert">{err}</span>}
      </div>
    </div>
  );
}

// ─── MARKETING SITE ───────────────────────────────────────────
const MK_LINKS = [["#product", "Product"], ["#how", "How it works"], ["#pricing", "Pricing"]];

const MK_FAQ = [
  ["What is Command Ledger?",
    "Financial intelligence software for founders. You upload your bank or accounting exports and Command Ledger shows your true free cash, runway, profitability, committed costs and risk, with one recommended move each week. It supports your decisions. It does not replace your accountant, and it does not give tax or legal advice."],
  ["Who should use it?",
    "Founders and owners of businesses with steady revenue who have outgrown a spreadsheet. Agencies, consultancies, SaaS and e-commerce businesses are typical. It is most useful once you have three or more months of transactions to analyse."],
  ["What financial data can I upload?",
    "CSV or Excel files (.csv, .xlsx, .xls) exported from your bank, QuickBooks, Xero or Wave, or any spreadsheet with dates and amounts. You can also sync a Google Sheet published as CSV. Columns are detected automatically, and uploading an overlapping file again does not create duplicates."],
  ["How does Command Ledger calculate financial metrics?",
    "Every metric comes from a published formula applied to your transactions. Runway is your cash divided by average monthly net burn. True free cash is profit after a reserve for tax and a safety buffer. Each figure shows how confident it is, based on how much recent data stands behind it, and a figure without enough data is shown as missing rather than as zero."],
  ["Is my financial information secure?",
    "Data is encrypted in transit. Your transactions are stored in a private history that only your login can read, enforced by the database itself. The uploaded file is not kept, and deleting an upload deletes every transaction it added. An AI brief, sent only when you request one, includes your computed metrics and the names of your largest payers and recurring costs, never your transaction list. Card payments are handled entirely by PayPal."],
  ["Does Command Ledger connect directly to my bank?",
    "No. Command Ledger never asks for your bank login. It works from the exports you choose to upload and the sheet you choose to sync."],
  ["What happens when I cancel?",
    "You can cancel at any time from your PayPal account, and your access ends when PayPal confirms the cancellation. First-time monthly subscribers can request a refund within 7 days, and annual subscriptions can be refunded pro rata within 30 days. Your uploaded history stays in your account until you delete it or ask us to delete your account."],
  ["How does Command Advisory work?",
    "Advisory includes everything in Command Ledger, plus done-for-you data configuration, a monthly one-to-one call, a written board report every month and a direct advisory line with priority four-hour response. There are six seats in total. You can start with the $750 Financial Diagnostic, which is credited in full against your first Advisory month."],
];

function MarketingSite({ onLogin, onPlanSelect, onTerms, onPrivacy }) {
  const [solid, setSolid] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = e => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const s = SAMPLE;
  const m = s.metrics;
  const toTop = e => { e.preventDefault(); window.scrollTo(0, 0); };

  return (
    <div className="mk">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className={`mk-nav${solid || menuOpen ? " solid" : ""}`}>
        <div className="mk-wrap mk-nav-in">
          <BrandLockup onClick={toTop}/>
          <nav aria-label="Main">
            <ul className="mk-nav-links">
              {MK_LINKS.map(([href, label]) => <li key={href}><a href={href}>{label}</a></li>)}
            </ul>
          </nav>
          <div className="mk-nav-actions">
            <button className="btn btn-ghost" onClick={onLogin}>Sign in</button>
            <button className="btn btn-primary" onClick={() => onPlanSelect("software")}>Get started</button>
            <button className="mk-burger" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} aria-controls="mk-menu" onClick={() => setMenuOpen(o => !o)}>
              <Icon name={menuOpen ? "close" : "menu"}/>
            </button>
          </div>
        </div>
      </header>
      {menuOpen && (
        <div className="mk-menu" id="mk-menu">
          {MK_LINKS.map(([href, label]) => <a key={href} href={href} onClick={() => setMenuOpen(false)}>{label}</a>)}
          <div className="mk-menu-actions">
            <button className="btn btn-outline" onClick={() => { setMenuOpen(false); onLogin(); }}>Sign in</button>
            <button className="btn btn-primary" onClick={() => { setMenuOpen(false); onPlanSelect("software"); }}>Get started</button>
          </div>
        </div>
      )}

      <main id="main">
        <section className="mk-hero">
          <div className="mk-wrap mk-hero-grid">
            <div>
              <div className="ledger-rule start">Financial intelligence for founders</div>
              <h1 className="mk-h1">Know what your business <span className="metal-text">can afford.</span></h1>
              <p className="mk-lead">Command Ledger turns your business finances into clear intelligence, helping you understand your cash, commitments, profitability and next move.</p>
              <div className="mk-cta-row">
                <button className="btn btn-lg btn-primary" onClick={() => onPlanSelect("software")}>Get started</button>
                <a className="btn btn-lg btn-outline" href="#example">See a sample analysis</a>
              </div>
              <div className="mk-trust">
                <span>Works from your own bank and accounting exports</span>
                <span>No bank login required</span>
                <span>Your data is visible only to your account</span>
              </div>
            </div>
            <HeroDemo/>
          </div>
        </section>

        <section className="mk-section" id="product">
          <div className="mk-wrap">
            <div className="mk-head">
              <div className="ledger-rule start">What it does</div>
              <h2 className="mk-h2">One honest view of where your business stands.</h2>
            </div>
            <div className="mk-outcomes">
              {[
                ["01", "Financial clarity", "See the cash you can actually deploy, what you keep from each dollar of revenue, and how many months you have if things change.", ["True free cash", "Profit margin", "Burn runway"]],
                ["02", "Financial control", "Know every recurring commitment before it lands. Payroll, rent, software and tax are detected in your own history and projected forward.", ["Recurring obligations", "Forward cash"]],
                ["03", "Better decisions", "Test a hire or a new cost against your real numbers, see how dependent you are on one client, and get one clear move each week.", ["Affordability", "Concentration", "Weekly directive"]],
              ].map(([n, title, body, tags]) => (
                <div className="mk-outcome" key={n}>
                  <span className="mk-index">{n}</span>
                  <h3 className="mk-h3">{title}</h3>
                  <p className="mk-p" style={{ marginTop:10 }}>{body}</p>
                  <div className="mk-tags">{tags.map(t => <span className="mk-tag" key={t}>{t}</span>)}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mk-section" id="capabilities">
          <div className="mk-wrap">
            <div className="mk-head">
              <div className="ledger-rule start">Capabilities</div>
              <h2 className="mk-h2">Built around the questions founders actually ask.</h2>
            </div>
            <div className="mk-caps">
              <article className="mk-cap wide">
                <h3 className="mk-h3">True free cash and runway</h3>
                <p className="mk-p">Revenue is not money you can spend. Command Ledger sets aside tax and a safety buffer first and shows what remains, then measures runway against net burn rather than gross spending, so a profitable month is never mistaken for a crisis.</p>
                <div className="mk-cap-figures">
                  <KpiTile t={{ lbl:"True free cash", val:fmt(m.free, "USD"), col:C.text, sub:"Three months, after reserves" }}/>
                  <KpiTile t={{ lbl:"Break-even revenue", val:fmt(m.breakEven, "USD"), col:C.text, sub:`Monthly. June revenue: ${fmt(s.last.revenue, "USD")}` }}/>
                </div>
                <p className="mk-cap-note">Sample data. Safe mode reserves 30% of profit for tax and 20% as a safety buffer.</p>
              </article>
              <article className="mk-cap narrow">
                <h3 className="mk-h3">Recurring obligations</h3>
                <p className="mk-p">Payroll, rent and subscriptions are found in your history, scheduled on their real paydays and projected ninety days ahead.</p>
                <ul className="mini-list" aria-label="Obligations detected in the sample">
                  {s.obligations.map(o => (
                    <li key={o.normalized_key}>
                      <span className="mini-main">{o.label}</span>
                      <span className="mini-date">next {o.next_expected}</span>
                      <span className="mini-amt">{fmt(o.typical_amount, "USD")}</span>
                    </li>
                  ))}
                </ul>
                <p className="mk-cap-note">Detected from the sample file: {fmt(s.committed, "USD")} a month committed.</p>
              </article>
              <article className="mk-cap full">
                <div style={{ display:"flex", justifyContent:"space-between", gap:16, flexWrap:"wrap", alignItems:"baseline" }}>
                  <h3 className="mk-h3">AI Financial Advisor</h3>
                  <span className="mk-tag">Illustrative brief, written from the sample data</span>
                </div>
                <p className="mk-p" style={{ maxWidth:820 }}>On request, Command Ledger sends your computed metrics to Claude, by Anthropic, and returns a structured brief. It is built to narrate the risk score already computed from your data rather than invent its own, its confidence is tied to how much history you have, and a single month of data can never be rated critical.</p>
                <dl className="mk-brief">
                  <div><dt>What happened</dt><dd>Revenue fell {Math.abs(s.revenueChange).toFixed(0)}% from April to June while costs rose {s.costChange.toFixed(0)}%. Margin fell from {pc(s.marginFirst)} to {pc(s.marginLast)}.</dd></div>
                  <div><dt>Why it happened</dt><dd>Ad spend rose from {fmt(s.first.marketing, "USD")} to {fmt(s.last.marketing, "USD")} a month and payroll from {fmt(s.first.payroll, "USD")} to {fmt(s.last.payroll, "USD")}, while revenue declined.</dd></div>
                  <div><dt>Business impact</dt><dd>In June the business kept {fmt(s.last.revenue - s.last.expenses, "USD")} of {fmt(s.last.revenue, "USD")} in revenue{s.topClient ? `, and ${pc(s.topClientPct)} of revenue came from ${s.topClient}` : ""}.</dd></div>
                  <div><dt>Recommended action</dt><dd>{s.directive.text}</dd></div>
                  <div><dt>Expected outcome</dt><dd>With ad spend back at April's level, June's margin would have been {pc(s.juneAdsAtApril)} instead of {pc(s.marginLast)}.</dd></div>
                  <div><dt>Risk and confidence</dt><dd>{m.risk.label} risk ({m.risk.score.toFixed(0)}/100). Confidence {s.confidence.level}, {s.confidence.reason}.</dd></div>
                </dl>
              </article>
            </div>
            <div className="mk-supporting">
              {[
                ["Profitability", "Margin and net profit by month, with the trend behind them, not a single snapshot."],
                ["Break-even revenue", "The monthly revenue that covers your average costs, and how far above or below it you are."],
                ["Revenue concentration", "The share of revenue from each client, read from payer names, so dependency shows before it hurts."],
                ["Decision log", "Every recommendation is logged with what you did and what happened to its metric afterwards."],
              ].map(([t, d]) => <div key={t}><h4>{t}</h4><p>{d}</p></div>)}
            </div>
          </div>
        </section>

        <section className="mk-section" id="how">
          <div className="mk-wrap">
            <div className="mk-head">
              <div className="ledger-rule start">How it works</div>
              <h2 className="mk-h2">Three steps from export to decision.</h2>
            </div>
            <div className="mk-steps">
              {[
                ["1", "Upload your exports", "Drop a CSV or Excel file from your bank, QuickBooks, Xero or Wave, or sync a published Google Sheet. No bank login is ever required."],
                ["2", "Command Ledger organises it", "Transactions are de-duplicated, categorised and grouped by client and supplier, and recurring obligations are detected and scheduled."],
                ["3", "Review and act", "See your position, the confidence behind every figure and one recommended move. Ask the AI Advisor for a full brief whenever you want one."],
              ].map(([n, t, d]) => (
                <div className="mk-step" key={n}>
                  <div className="mk-step-n">{n}</div>
                  <h3 className="mk-h3">{t}</h3>
                  <p className="mk-p" style={{ marginTop:10 }}>{d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mk-section" id="example">
          <div className="mk-wrap">
            <div className="mk-head">
              <div className="ledger-rule start">Sample analysis</div>
              <h2 className="mk-h2">From raw transactions to a decision.</h2>
              <p className="mk-sub">The same three months, before and after Command Ledger reads them. Every figure on the right is computed from the list on the left.</p>
            </div>
            <div className="mk-example">
              <div className="mk-example-col">
                <div className="mk-example-label"><span>Raw transactions</span><span className="mk-tag">Sample data</span></div>
                <table className="mk-ledger">
                  <caption className="sr-only">Sample transactions, April to June 2026</caption>
                  <tbody>
                    {s.txns.map((t, i) => (
                      <tr key={i}><td>{t.txn_date}</td><td>{t.description}</td><td style={{ color: t.amount > 0 ? C.positive : C.text2 }}>{fmt(t.amount, "USD")}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mk-arrow" aria-hidden="true"><Icon name="arrow" size={22}/></div>
              <div className="mk-example-col">
                <div className="mk-example-label"><span>What Command Ledger finds</span><span className="mk-tag">Computed</span></div>
                <ul className="mk-insights">
                  <li><b>{pc(s.marginFirst)} to {pc(s.marginLast)}</b><span>Profit margin from April to June. Costs rose {s.costChange.toFixed(0)}% while revenue fell {Math.abs(s.revenueChange).toFixed(0)}%.</span></li>
                  {s.topClient && <li><b>{pc(s.topClientPct)}</b><span>of revenue comes from one client, {s.topClient}. Losing it would remove most of the income.</span></li>}
                  <li><b>{fmt(s.committed, "USD")} a month</b><span>is committed to payroll, advertising and hosting, each detected as a monthly obligation with its next due date.</span></li>
                  <li><b>{s.adsChange > 0 ? "+" : ""}{s.adsChange.toFixed(0)}% ad spend</b><span>in three months, while revenue declined over the same period.</span></li>
                </ul>
                <div className="mk-verdict">
                  <div className="mk-verdict-k">This week's directive</div>
                  <div className="mk-verdict-t">{s.directive.text}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mk-section" id="pricing">
          <div className="mk-wrap">
            <div className="mk-head center">
              <div className="ledger-rule">Pricing</div>
              <h2 className="mk-h2">Software, an advisor, or one rigorous review.</h2>
            </div>
            <div className="mk-prices">
              {[
                { key:"software", name:PLANS.software.name, forWho:"For founders who want the system and will read the numbers themselves.",
                  fig:`US$${PLANS.software.usd}`, per:"per month", alt:`or US$${PLANS.software.annualUsd.toLocaleString()} a year, arranged by email`,
                  list:PLANS.software.features, cta:"Get started", featured:false },
                { key:"advisory", name:PLANS.advisory.name, forWho:"For founders who want an advisor reading the numbers with them every month.",
                  fig:`US$${PLANS.advisory.usd.toLocaleString()}`, per:"per month", alt:`${PLANS.advisory.seats} seats in total`,
                  list:PLANS.advisory.features, cta:"Request a seat", featured:true },
                { key:"diagnostic", name:DIAGNOSTIC.name, forWho:"For founders who want one rigorous review before committing to anything ongoing.",
                  fig:`US$${DIAGNOSTIC.usd}`, per:"once", alt:"Credited in full against your first Advisory month",
                  list:["Send twelve months of bank or accounting exports", "Receive the full analysis and a written findings memo", "A one-time payment, not a subscription"], cta:"Buy the diagnostic", featured:false },
              ].map(p => (
                <article key={p.key} className={`mk-price${p.featured ? " featured" : ""}`}>
                  <h3 className="mk-price-name">{p.name}</h3>
                  <p className="mk-price-for">{p.forWho}</p>
                  <div className="mk-price-fig">{p.fig}<small>{p.per}</small></div>
                  <div className="mk-price-alt">{p.alt}</div>
                  <ul className="mk-price-list">{p.list.map(f => <li key={f}>{f}</li>)}</ul>
                  <button className={`btn btn-lg btn-full ${p.featured ? "btn-primary" : "btn-outline"}`} onClick={() => onPlanSelect(p.key)}>{p.cta}</button>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mk-section" id="faq">
          <div className="mk-wrap">
            <div className="mk-head center">
              <div className="ledger-rule">Questions</div>
              <h2 className="mk-h2">What founders ask before they start.</h2>
            </div>
            <div className="mk-faq">
              {MK_FAQ.map(([q, a]) => (
                <details key={q}>
                  <summary>{q}</summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="mk-final">
          <div className="mk-wrap">
            <BrandMark size={220} framed alt="Command Ledger, Financial Systems"/>
            <h2 className="mk-final-h">Know your numbers. Understand your risks. Make your next decision with evidence.</h2>
            <button className="btn btn-lg btn-primary" onClick={() => onPlanSelect("software")}>Get started</button>
          </div>
        </section>
      </main>

      <footer className="mk-footer">
        <div className="mk-wrap">
          <div className="mk-footer-grid">
            <div className="mk-footer-brand">
              <BrandLockup size={40} onClick={toTop}/>
              <p className="mk-footer-note">Financial intelligence for founders, computed from your own transactions.</p>
            </div>
            <div>
              <h5>Product</h5>
              <ul>
                <li><a href="#product">Product</a></li>
                <li><a href="#how">How it works</a></li>
                <li><a href="#example">Sample analysis</a></li>
                <li><a href="#pricing">Pricing</a></li>
              </ul>
            </div>
            <div>
              <h5>Company</h5>
              <ul>
                <li><a href="mailto:commandledger@gmail.com">Contact</a></li>
                <li><a href="mailto:commandledger@gmail.com?subject=Command%20Ledger%20support">Support</a></li>
                <li><button onClick={onLogin}>Sign in</button></li>
              </ul>
            </div>
            <div>
              <h5>Legal</h5>
              <ul>
                <li><a href="/privacy" onClick={e => { e.preventDefault(); onPrivacy(); }}>Privacy policy</a></li>
                <li><a href="/terms" onClick={e => { e.preventDefault(); onTerms(); }}>Terms of service</a></li>
              </ul>
            </div>
          </div>
          <div className="mk-footer-base">
            <span>© 2026 Command Ledger. DigiBlueprint Financial Intelligence.</span>
            <span>Information, not financial advice. Consult a qualified professional before major decisions.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── LEGAL PAGES ─────────────────────────────────────────────
function LegalTop({ onBack }) {
  return (
    <header className="page-top">
      <div className="mk-wrap">
        <BrandLockup onClick={e => { e.preventDefault(); onBack(); }}/>
        <button className="page-back btn-link" style={{ textDecoration:"none" }} onClick={onBack}>Back to the site</button>
      </div>
    </header>
  );
}

function TermsPage({ onBack }) {
  return (
    <div style={{ minHeight:"100vh" }}>
      <LegalTop onBack={onBack}/>
      <main className="page-wrap">
        <h1 className="page-title">Terms of Service</h1>
        <div className="page-date">Last updated: June 2026</div>
        <h2 className="page-h2">1. Acceptance</h2>
        <p className="page-p">By using Command Ledger you agree to these Terms of Service.</p>
        <h2 className="page-h2">2. Service</h2>
        <p className="page-p">Command Ledger provides AI-powered financial intelligence for founders and business owners, including analytics, capital allocation tools, and AI-generated strategic recommendations.</p>
        <h2 className="page-h2">3. Payment</h2>
        <p className="page-p">Subscriptions are billed via PayPal, monthly or annually depending on the term selected, and auto-renew unless cancelled at least 7 days before the renewal date. The Financial Diagnostic is a one-time charge, not a subscription.</p>
        <h2 className="page-h2">4. Refunds</h2>
        <p className="page-p">7-day refund on monthly subscriptions for first-time subscribers. Annual subscriptions may be refunded pro rata within 30 days. The Financial Diagnostic is non-refundable once analysis has begun; where it is credited against a first month of Command Advisory, that credit is forfeited if the subscription is refunded.</p>
        <h2 className="page-h2">5. Disclaimer</h2>
        <p className="page-p">Command Ledger is for informational purposes only. This is not financial advice. Consult a qualified professional before major business decisions.</p>
        <h2 className="page-h2">6. Contact</h2>
        <p className="page-p">commandledger@gmail.com</p>
      </main>
    </div>
  );
}

function PrivacyPage({ onBack }) {
  return (
    <div style={{ minHeight:"100vh" }}>
      <LegalTop onBack={onBack}/>
      <main className="page-wrap">
        <h1 className="page-title">Privacy Policy</h1>
        <div className="page-date">Last updated: November 2026</div>
        <h2 className="page-h2">1. What We Collect</h2>
        <p className="page-p">Name, email, and authentication details on sign-in. Financial data you upload. Usage data such as features accessed and session duration.</p>
        <h2 className="page-h2">2. How We Use It</h2>
        <p className="page-p">To provide the Service, process payments, deliver AI analysis, and send account updates. We do not sell your data.</p>
        <h2 className="page-h2">3. Security</h2>
        <p className="page-p">All data encrypted in transit via SSL. Transactions you upload to your account are stored in your private history with Supabase, readable only by your login, so your metrics can track change over time; the uploaded file itself is not kept. Deleting an upload from Upload History permanently deletes every transaction it added. The free preview on the home page runs in your browser and stores nothing. User accounts are stored securely via Supabase.</p>
        <h2 className="page-h2">4. Contact</h2>
        <p className="page-p">commandledger@gmail.com</p>
      </main>
    </div>
  );
}

// ─── PAYWALL GATE ─────────────────────────────────────────────
// Shown instead of the Dashboard when profile.plan is empty.
// No data, no features, no bypass — user must subscribe to proceed.
function PaywallGate({ user, activating, onSelectPlan, onLogout }) {
  const userName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Founder";
  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth:680 }}>
        <div className="auth-logo-row">
          <BrandMark size={130} framed alt="Command Ledger"/>
        </div>
        <div className="auth-h">
          <h1 className="auth-title">Welcome, {userName}</h1>
          <p className="auth-sub">Your account is ready. Choose a plan to open your command centre; the dashboard opens once a subscription is active.</p>
        </div>
        <div className="auth-form">
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {[
              { key:"software", hot:false },
              { key:"advisory", hot:true  },
            ].map(p => {
              const pl = PLANS[p.key];
              return (
                <div key={p.key} style={{
                  background:C.panel2,
                  border:`1px solid ${p.hot ? C.platinum : C.line}`,
                  padding:"18px 20px",
                  display:"flex",
                  justifyContent:"space-between",
                  alignItems:"center",
                  gap:16,
                }}>
                  <div>
                    <div style={{ fontSize:10, letterSpacing:"0.16em", textTransform:"uppercase", color:C.platinum, fontWeight:600, marginBottom:4 }}>{pl.name}</div>
                    <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, color:C.text }}>
                      US${pl.usd.toLocaleString()} <span style={{ fontSize:12, color:C.text3 }}>{pl.period}</span>
                    </div>
                  </div>
                  <button className={`btn ${p.hot ? "btn-primary" : "btn-outline"}`} style={{ padding:"10px 22px", fontSize:11, whiteSpace:"nowrap" }} onClick={() => onSelectPlan(p.key)}
                    disabled={activating} title={activating ? "A payment is being activated for this account" : undefined}>
                    Subscribe
                  </button>
                </div>
              );
            })}
          </div>
          <div style={{
            marginTop:14,
            background:C.panel2,
            border:`1px solid ${C.line}`,
            padding:"18px 20px",
            display:"flex",
            justifyContent:"space-between",
            alignItems:"center",
            gap:16,
          }}>
            <div>
              <div style={{ fontSize:10, letterSpacing:"0.16em", textTransform:"uppercase", color:C.platinum, fontWeight:600, marginBottom:4 }}>{DIAGNOSTIC.name}</div>
              <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, color:C.text }}>
                US${DIAGNOSTIC.usd.toLocaleString()} <span style={{ fontSize:12, color:C.text3 }}>once, not a subscription</span>
              </div>
            </div>
            <button className="btn btn-outline" style={{ padding:"10px 22px", fontSize:11, whiteSpace:"nowrap" }} onClick={() => onSelectPlan("diagnostic")}>
              Buy once
            </button>
          </div>
          <div className="a-link" {...clickableProps(onLogout)} style={{ marginTop:24 }}>
            <span>Sign out</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────
export default function App() {
  const [appState, setAppState] = useState("loading");
  const [user,     setUser]     = useState(null);
  const [profile,  setProfile]  = useState(null);
  const [payModal, setPayModal] = useState(null);

  const loadProfile = useCallback(async (u) => {
    try {
      let { data, error } = await supabase.from("profiles").select("*").eq("id", u.id).single();
      if (error && error.code === "PGRST116") {
        const np = {
          id:    u.id,
          email: u.email,
          name:  u.user_metadata?.full_name || u.email?.split("@")[0] || "Founder",
          plan:  null,
          updated_at: new Date().toISOString(),
        };
        const { data: created, error: createErr } = await supabase.from("profiles").upsert(np).select().single();
        // This error used to be discarded. The upsert was being rejected for a
        // column the table did not have, the fallback below hid it, and no
        // profile row was ever created — silently, for every new user. The
        // fallback is still safe (plan is null, so it can never grant access),
        // but the failure must be visible.
        if (createErr) console.error("Profile create failed:", createErr);
        data = created || np;
      } else if (error) {
        throw error;
      }
      setUser(u);
      setProfile(data);
      if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
      setAppState(LEGAL_PATHS[window.location.pathname] || "dashboard");
    } catch (err) {
      console.error("Profile error:", err);
      // Fallback: still show the gate, never grant free access on error
      setUser(u);
      setProfile({ id:u.id, email:u.email, name:u.user_metadata?.full_name||u.email?.split("@")[0]||"Founder", plan:null });
      setAppState(LEGAL_PATHS[window.location.pathname] || "dashboard");
    }
  }, []);

  // Workspace paths (/dashboard, /reports ...) belong to the signed-in app.
  // A signed-out visitor on one is shown the marketing site at "/". The
  // legal pages keep their own address.
  const showMarketing = useCallback(() => {
    const legal = LEGAL_PATHS[window.location.pathname];
    if (legal) { setAppState(legal); return; }
    if (isAppPath(window.location.pathname)) window.history.replaceState(null, "", "/");
    setAppState("marketing");
  }, []);

  const openLegal = useCallback(page => {
    if (window.location.pathname !== `/${page}`) window.history.pushState(null, "", `/${page}`);
    setAppState(page);
    window.scrollTo(0, 0);
  }, []);
  const closeLegal = useCallback(() => {
    window.history.pushState(null, "", user ? "/dashboard" : "/");
    setAppState(user ? "dashboard" : "marketing");
    window.scrollTo(0, 0);
  }, [user]);
  // Back and forward between the site and a legal page. Inside the
  // workspace, useSection handles its own paths.
  useEffect(() => {
    const onPop = () => {
      const legal = LEGAL_PATHS[window.location.pathname];
      if (legal) setAppState(legal);
      else setAppState(s => (s === "terms" || s === "privacy") ? (user ? "dashboard" : "marketing") : s);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [user]);

  // Search engines read each public page's title and canonical address after
  // rendering. index.html cannot know the path, so they are set here; the
  // workspace paths are kept out of search by vercel.json.
  const defaultTitle = useRef(document.title);
  useEffect(() => {
    const legal = appState === "terms" || appState === "privacy";
    document.title = legal ? PAGE_TITLES[appState] : defaultTitle.current;
    let link = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "canonical";
      document.head.appendChild(link);
    }
    link.href = `${SITE_ORIGIN}${legal ? `/${appState}` : "/"}`;
  }, [appState]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) loadProfile(session.user);
      else showMarketing();
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) loadProfile(session.user);
      else { setUser(null); setProfile(null); showMarketing(); }
    });

    return () => subscription.unsubscribe();
  }, [loadProfile, showMarketing]);

  // Access is granted by the PayPal webhook, which can land seconds or minutes
  // after the buyer approves. Reloading the profile once, a second later, used
  // to drop most buyers straight back on the paywall with their Subscribe
  // buttons live — a paying customer invited to pay again. Instead the profile
  // is polled until the plan they bought appears, checkout stays closed while
  // that happens, and if it is slow they are told plainly not to pay again.
  const [activation, setActivation] = useState(null); // null | { planKey, status: "pending" | "delayed" }
  const activationRun = useRef(0);

  const pollActivation = useCallback(async (planKey) => {
    const run = ++activationRun.current;
    setActivation({ planKey, status: "pending" });
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) { setActivation(null); return; }
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (activationRun.current !== run) return;
      const { data, error } = await supabase.from("profiles").select("*").eq("id", u.id).single();
      if (error) { console.error("Activation check failed:", error); continue; }
      if (resolvePlanKey(data.plan) === planKey && data.plan) {
        setProfile(data);
        setActivation(null);
        return;
      }
    }
    if (activationRun.current === run) setActivation({ planKey, status: "delayed" });
  }, []);

  const handlePaySuccess = useCallback((planKey) => {
    setPayModal(null);
    pollActivation(resolvePlanKey(planKey));
  }, [pollActivation]);

  // Signing out abandons any activation check in flight.
  useEffect(() => { if (!user) { activationRun.current++; setActivation(null); } }, [user]);

  const handlePlanSelect = useCallback((planKey) => {
    if (user) setPayModal(planKey);
    else      setAppState("login");
  }, [user]);

  // While a payment is activating, no new subscription checkout opens.
  const openSubscription = useCallback((planKey) => {
    if (activation && planKey !== "diagnostic") return;
    setPayModal(planKey);
  }, [activation]);

  if (appState === "loading") return (
    <>
      <style>{CSS}</style>
      <div className="loading-screen">
        <BrandMark size={200} framed alt="Command Ledger"/>
        <span className="spinner" style={{ width:20, height:20 }} aria-label="Loading"/>
      </div>
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      {activation && user && appState === "dashboard" && (
        <div className="activation-banner" role="status">
          {activation.status === "pending" ? (
            <><span className="spinner"/>Payment approved. Activating {PLANS[activation.planKey].name}. This usually takes under a minute. Do not pay again.</>
          ) : (
            <>
              <span>
                PayPal approved your payment, but activation is taking longer than usual. Do not subscribe again, or you would be charged twice.
                Use Check again in a few minutes; if it has not activated within an hour, email <a href="mailto:commandledger@gmail.com?subject=Subscription%20activation">commandledger@gmail.com</a>.
              </span>
              <button className="btn btn-outline" style={{ padding:"6px 14px", fontSize:11, whiteSpace:"nowrap" }} onClick={() => pollActivation(activation.planKey)}>Check again</button>
            </>
          )}
        </div>
      )}
      {payModal === "diagnostic" && user && (
        <DiagnosticModal onClose={() => setPayModal(null)}/>
      )}
      {payModal && payModal !== "diagnostic" && user && (
        <PayModal planKey={payModal} currentPlanKey={profile?.plan || null} userEmail={user.email} userId={user.id} onClose={() => setPayModal(null)} onSuccess={handlePaySuccess}/>
      )}
      {appState==="marketing" && (
        <MarketingSite onLogin={() => setAppState("login")} onPlanSelect={handlePlanSelect} onTerms={() => openLegal("terms")} onPrivacy={() => openLegal("privacy")}/>
      )}
      {appState==="login" && (
        <LoginPage onBack={() => setAppState("marketing")}/>
      )}
      {appState==="dashboard" && user && profile && (
        profile.plan ? (
          <Dashboard
            user={user}
            profile={profile}
            onLogout={async () => { await supabase.auth.signOut(); }}
            onUpgrade={() => { if (resolvePlanKey(profile.plan) === "software") openSubscription("advisory"); }}
            onBuyDiagnostic={() => setPayModal("diagnostic")}
            onProfileChange={setProfile}
          />
        ) : (
          <PaywallGate
            user={user}
            activating={!!activation}
            onSelectPlan={openSubscription}
            onLogout={async () => { await supabase.auth.signOut(); }}
          />
        )
      )}
      {appState==="terms"   && <TermsPage   onBack={closeLegal}/>}
      {appState==="privacy" && <PrivacyPage onBack={closeLegal}/>}
    </>
  );
}


