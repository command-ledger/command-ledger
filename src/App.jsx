import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import { fmt, pc, safe, parseAnyCSV, computeMetrics, runScenario, parseTransactions, computeDedupeHash, aggregateTransactionsByMonth, computeRevenueConcentration, detectRecurringObligations, computeForwardRunway, checkAffordability, detectMissedObligations, projectForwardCalendar, summarizeCalendarByWeek, computeDirective, getDirectiveMetricValue, describeDirectiveOutcome, checkoutBlockReason, fmtCompact, filterTransactions, searchWorkspace, buildAlerts, buildReportCsv } from "./lib/financials.js";

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

const C = {
  bg:"#050709",surface:"#0A0D14",surfaceHigh:"#0F1320",
  border:"#161C2E",borderBright:"#243050",
  gold:"#D8DADE",goldBright:"#EDEEF1",goldDim:"#5A5D64",goldGlow:"rgba(216,218,222,0.12)",
  cream:"#F0E8D8",blue:"#4A7CF7",blueGlow:"rgba(74,124,247,0.1)",
  green:"#2ABF85",greenGlow:"rgba(42,191,133,0.1)",
  red:"#E84855",redGlow:"rgba(232,72,85,0.1)",
  amber:"#E8A020",amberGlow:"rgba(232,160,32,0.1)",
  ink:"#8898B8",inkDim:"#7A7E88",white:"#F4F7FF",
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
body{background:#050709;color:#F4F7FF;font-family:'Syne',sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden;}
::selection{background:#5A5D64;color:#F0E8D8;}
::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-track{background:#050709;}::-webkit-scrollbar-thumb{background:#161C2E;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes slideDown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
@keyframes dotPulse{0%,80%,100%{transform:scale(0.6);opacity:0.4}40%{transform:scale(1);opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes scrollLine{0%{transform:scaleY(0);transform-origin:top}50%{transform:scaleY(1);transform-origin:top}51%{transform-origin:bottom}100%{transform:scaleY(0);transform-origin:bottom}}
@keyframes gridDrift{from{background-position:0 0}to{background-position:80px 80px}}
.reveal{opacity:1;transform:none;}
@media(prefers-reduced-motion:no-preference){
  .reveal{opacity:0;transform:translateY(28px);transition:opacity 0.7s cubic-bezier(0.16,1,0.3,1),transform 0.7s cubic-bezier(0.16,1,0.3,1);}
  .reveal.in{opacity:1;transform:translateY(0);}
  .hero-grid{animation:gridDrift 44s linear infinite;}
}
.nav{position:fixed;top:0;left:0;right:0;z-index:300;height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 48px;border-bottom:1px solid transparent;transition:all 0.4s;}
.nav.scrolled{background:rgba(5,7,9,0.96);border-color:#161C2E;backdrop-filter:blur(24px);}
.nav-logo{display:flex;align-items:center;gap:12px;cursor:pointer;}
.logomark{width:36px;height:36px;border:1px solid #D8DADE;display:flex;align-items:center;justify-content:center;font-family:'Cormorant Garamond',serif;font-size:18px;color:#D8DADE;position:relative;flex-shrink:0;}
.logomark::after{content:'';position:absolute;inset:4px;border:0.5px solid #5A5D64;}
.wordmark{font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:500;color:#F0E8D8;letter-spacing:0.04em;}
.wordmark-sub{font-size:9px;color:#D8DADE;letter-spacing:0.14em;text-transform:uppercase;}
.nav-links{display:flex;align-items:center;gap:32px;list-style:none;}
.nav-links a{font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8898B8;text-decoration:none;transition:color 0.2s;cursor:pointer;}
.nav-links a:hover{color:#F0E8D8;}
.nav-cta{display:flex;align-items:center;gap:10px;}
.nav-burger{display:none;flex-direction:column;justify-content:center;gap:5px;width:36px;height:36px;background:transparent;border:1px solid transparent;cursor:pointer;padding:0;}
.nav-burger span{width:20px;height:1.5px;background:#D8DADE;transition:transform 0.25s ease,opacity 0.25s ease;}
.nav-burger.open span:nth-child(1){transform:translateY(6.5px) rotate(45deg);}
.nav-burger.open span:nth-child(2){opacity:0;}
.nav-burger.open span:nth-child(3){transform:translateY(-6.5px) rotate(-45deg);}
.nav-mobile{position:fixed;top:64px;left:0;right:0;z-index:299;background:rgba(5,7,9,0.98);backdrop-filter:blur(24px);border-bottom:1px solid #161C2E;padding:8px 24px 20px;display:flex;flex-direction:column;animation:slideDown 0.25s ease both;}
.nav-mobile a{font-size:13px;letter-spacing:0.1em;text-transform:uppercase;color:#8898B8;text-decoration:none;padding:16px 4px;border-bottom:1px solid #161C2E;cursor:pointer;}
.nav-mobile a:hover{color:#F0E8D8;}
.btn{font-family:'Syne',sans-serif;font-weight:700;cursor:pointer;border-radius:1px;transition:all 0.2s;letter-spacing:0.12em;text-transform:uppercase;border:none;}
.btn-ghost{font-size:11px;padding:8px 20px;background:transparent;border:1px solid #161C2E!important;color:#8898B8;}
.btn-ghost:hover{border-color:#D8DADE!important;color:#D8DADE;}
.btn-gold{font-size:11px;padding:8px 24px;background:#D8DADE;border:1px solid #D8DADE!important;color:#050709;}
.btn-gold:hover{background:#EDEEF1;}
.btn-lg{font-size:12px;padding:14px 40px;}
.btn-full{width:100%;padding:13px;font-size:11px;display:flex;align-items:center;justify-content:center;gap:8px;}
.btn-primary{background:#D8DADE;border:1px solid #D8DADE!important;color:#050709;}
.btn-primary:hover{background:#EDEEF1;transform:translateY(-1px);}
.btn-outline{background:transparent;border:1px solid #161C2E!important;color:#8898B8;}
.btn-outline:hover{border-color:#D8DADE!important;color:#D8DADE;}
.btn:disabled{opacity:0.45;cursor:default;transform:none!important;}
.spinner{width:16px;height:16px;border:2px solid #161C2E;border-top-color:#D8DADE;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block;flex-shrink:0;}
.hero{min-height:100vh;display:grid;grid-template-columns:1.05fr 1fr;gap:56px;align-items:center;text-align:left;padding:150px 48px 80px;position:relative;overflow:hidden;}
.hero-bg{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 70% 60% at 50% 0%,rgba(216,218,222,0.07) 0%,transparent 60%);}
.hero-grid{position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(#161C2E 1px,transparent 1px),linear-gradient(90deg,#161C2E 1px,transparent 1px);background-size:80px 80px;mask-image:radial-gradient(ellipse 80% 80% at 50% 50%,black 0%,transparent 70%);opacity:0.4;}
.hero-copy{position:relative;z-index:1;}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#D8DADE;font-weight:600;border:1px solid #5A5D64;padding:6px 16px;margin-bottom:40px;animation:fadeUp 0.8s ease both;}
.eyebrow-dot{width:5px;height:5px;border-radius:50%;background:#D8DADE;box-shadow:0 0 8px #D8DADE;animation:pulse 2s infinite;}
.hero-title{font-family:'Cormorant Garamond',serif;font-size:clamp(38px,4.6vw,64px);font-weight:300;line-height:1.04;color:#F0E8D8;letter-spacing:-0.02em;margin-bottom:24px;animation:fadeUp 0.8s 0.1s ease both;}
.hero-title em{font-style:italic;color:#D8DADE;}
.hero-sub{font-size:16px;line-height:1.75;color:#8898B8;max-width:480px;margin:0 0 40px;font-family:'Cormorant Garamond',serif;font-weight:300;animation:fadeUp 0.8s 0.2s ease both;}
.hero-cta{display:flex;gap:16px;justify-content:flex-start;flex-wrap:wrap;animation:fadeUp 0.8s 0.3s ease both;}
.hero-proof{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:28px;font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:0.05em;color:#7A7E88;animation:fadeUp 0.8s 0.35s ease both;}
.hero-proof-sep{color:#243050;}
.hero-preview{position:relative;z-index:1;background:#0A0D14;border:1px solid #243050;box-shadow:0 24px 64px -24px rgba(0,0,0,0.6);animation:fadeUp 0.8s 0.4s ease both;}
.hero-preview-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #161C2E;background:#0F1320;}
.hero-preview-live{width:auto;height:auto;border-radius:0;background:transparent;margin-left:auto;display:flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#2ABF85;flex-shrink:0;}
.hero-preview-live::before{content:'';width:5px;height:5px;border-radius:50%;background:#2ABF85;box-shadow:0 0 6px #2ABF85;animation:pulse 1.6s infinite;}
.hero-preview-bar span{width:8px;height:8px;border-radius:50%;background:#243050;}
.hero-preview-title{margin-left:8px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#7A7E88;letter-spacing:0.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.hero-preview-body{padding:24px;min-height:280px;}
.hero-preview-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;min-height:232px;border:2px dashed #161C2E;text-align:center;padding:24px;cursor:pointer;transition:border-color 0.2s;}
.hero-preview-empty:hover{border-color:#5A5D64;}
.hero-preview-cta{font-family:'Syne',sans-serif;font-size:12.5px;font-weight:600;color:#8898B8;line-height:1.6;max-width:260px;cursor:pointer;}
.hero-preview-cta b{color:#D8DADE;}
.hero-preview-or{font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#5A5D64;}
.hero-preview-try{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:#D8DADE;border:1px solid #5A5D64;padding:7px 14px;cursor:pointer;background:transparent;}
.hero-preview-err{font-size:11px;color:#E84855;}
.hero-preview-kpis{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#161C2E;border:1px solid #161C2E;margin-bottom:1px;}
.hpk{background:#0A0D14;padding:16px 18px;}
.hpk-lbl{font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#7A7E88;font-weight:600;margin-bottom:6px;}
.hpk-val{font-family:'JetBrains Mono',monospace;font-size:20px;color:#F0E8D8;}
.hero-preview-note{font-size:10.5px;color:#7A7E88;padding:12px 16px;border-top:1px solid #161C2E;font-family:'JetBrains Mono',monospace;}
.hero-preview-reset{color:#D8DADE;cursor:pointer;text-decoration:underline;}
.hero-scroll{position:absolute;bottom:40px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#7A7E88;}
.scroll-line{width:1px;height:40px;background:linear-gradient(to bottom,#D8DADE,transparent);animation:scrollLine 2s ease-in-out infinite;}
.stats-bar{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #161C2E;border-bottom:1px solid #161C2E;background:#0A0D14;}
.stat{padding:32px 40px;border-right:1px solid #161C2E;}
.stat:last-child{border-right:none;}
.stat-n{font-family:'Cormorant Garamond',serif;font-size:42px;font-weight:300;color:#D8DADE;line-height:1;margin-bottom:8px;}
.stat-l{font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#8898B8;font-weight:600;}
.sec{padding:100px 48px;}
.sec-eye{font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#D8DADE;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:12px;justify-content:center;}
.sec-eye::before,.sec-eye::after{content:'';flex:1;max-width:60px;height:1px;background:linear-gradient(to left,#5A5D64,transparent);}
.sec-title{font-family:'Cormorant Garamond',serif;font-size:clamp(36px,5vw,58px);font-weight:300;line-height:1.08;color:#F0E8D8;letter-spacing:-0.01em;margin-bottom:20px;text-align:center;}
.sec-title em{font-style:italic;color:#D8DADE;}
.sec-body{font-size:15px;line-height:1.85;color:#8898B8;max-width:560px;font-family:'Cormorant Garamond',serif;margin:0 auto;text-align:center;}
.feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#161C2E;border:1px solid #161C2E;margin-top:64px;}
.feat-card{background:#0A0D14;padding:40px 36px;transition:background 0.3s,transform 0.3s;position:relative;}
.feat-card:hover{background:#0F1320;transform:translateY(-2px);}
.feat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(to right,transparent,#5A5D64,transparent);opacity:0;transition:opacity 0.3s;}
.feat-card:hover::before{opacity:1;}
.feat-tag{display:inline-block;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#050709;background:#D8DADE;padding:3px 9px;margin-bottom:16px;}
.feat-num{font-family:'JetBrains Mono',monospace;font-size:11px;color:#5A5D64;letter-spacing:0.1em;margin-bottom:24px;}
.feat-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:500;color:#F0E8D8;margin-bottom:12px;}
.feat-desc{font-size:13px;line-height:1.75;color:#8898B8;font-family:'Cormorant Garamond',serif;}
.price-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:64px;max-width:1100px;margin-left:auto;margin-right:auto;}
.price-card{background:#0A0D14;border:1px solid #161C2E;padding:36px 32px;position:relative;overflow:hidden;transition:transform 0.3s,box-shadow 0.3s;}
.price-card:hover{transform:translateY(-4px);}
.price-card.hot{border-color:#D8DADE;transform:scale(1.03);box-shadow:0 24px 64px -24px rgba(216,218,222,0.18);z-index:1;}
.price-card.hot:hover{transform:scale(1.03) translateY(-4px);}
.price-card.hot::after{content:'6 Seats';position:absolute;top:16px;right:16px;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#050709;background:#D8DADE;padding:4px 10px;font-weight:700;font-family:'Syne',sans-serif;}
.price-tier{font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#D8DADE;font-weight:600;margin-bottom:8px;}
.price-tagline{font-family:'Cormorant Garamond',serif;font-size:13px;color:#8898B8;margin-bottom:16px;font-style:italic;}
.price-usd{font-family:'Cormorant Garamond',serif;font-size:52px;font-weight:300;color:#F0E8D8;line-height:1;}
.price-usd sup{font-size:22px;vertical-align:top;margin-top:10px;display:inline-block;}
.price-zar{font-size:12px;color:#5A5D64;margin:4px 0;font-family:'JetBrains Mono',monospace;}
.price-period{font-size:12px;color:#8898B8;margin-bottom:12px;font-family:'Cormorant Garamond',serif;}
.price-grid-two{grid-template-columns:repeat(2,1fr);max-width:760px;}
.price-note{font-size:11px;color:#7A7E88;margin-bottom:6px;font-family:'JetBrains Mono',monospace;letter-spacing:0.02em;}
.price-diag{max-width:760px;margin:28px auto 0;background:#0A0D14;border:1px solid #161C2E;padding:26px 30px;display:flex;align-items:center;justify-content:space-between;gap:28px;text-align:left;}
.price-diag-name{font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#D8DADE;font-weight:600;margin-bottom:8px;}
.price-diag-body{font-family:'Cormorant Garamond',serif;font-size:14px;color:#8898B8;line-height:1.6;}
.price-diag-note{font-size:11px;color:#7A7E88;margin-top:8px;font-family:'JetBrains Mono',monospace;}
.btn-link{background:none;border:0;padding:0;margin:0;font:inherit;color:#D8DADE;text-decoration:underline;text-underline-offset:3px;cursor:pointer;}
.btn-link:hover{color:#EDEEF1;}
.price-divider{height:1px;background:#161C2E;margin-bottom:24px;}
.price-list{list-style:none;margin-bottom:28px;}
.price-list li{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:#8898B8;margin-bottom:10px;font-family:'Cormorant Garamond',serif;line-height:1.5;}
.price-list li::before{content:'---';color:#D8DADE;flex-shrink:0;font-family:'JetBrains Mono',monospace;font-size:11px;margin-top:2px;}
.excel-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#161C2E;border:1px solid #161C2E;text-align:left;margin-bottom:64px;position:relative;}
.excel-arrow{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:40px;height:40px;border-radius:50%;background:#050709;border:1px solid #5A5D64;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:16px;color:#D8DADE;z-index:2;}
@media(max-width:720px){.excel-grid{grid-template-columns:1fr;}.excel-arrow{display:none;}}
.cta-sec{padding:120px 48px;text-align:center;position:relative;overflow:hidden;border-top:1px solid #161C2E;}
.cta-sec::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 60% 60% at 50% 50%,rgba(216,218,222,0.07) 0%,transparent 70%);}
.cta-title{font-family:'Cormorant Garamond',serif;font-size:clamp(40px,6vw,72px);font-weight:300;color:#F0E8D8;line-height:1.08;margin-bottom:20px;}
.cta-title em{font-style:italic;color:#D8DADE;}
.footer{border-top:1px solid #161C2E;padding:40px 48px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;}
.footer-copy{font-size:11px;color:#7A7E88;font-family:'JetBrains Mono',monospace;}
.footer-links{display:flex;gap:24px;list-style:none;}
.footer-links a{font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#7A7E88;text-decoration:none;transition:color 0.2s;cursor:pointer;}
.footer-links a:hover{color:#8898B8;}
.overlay{position:fixed;inset:0;z-index:500;background:rgba(5,7,9,0.94);backdrop-filter:blur(16px);display:flex;align-items:center;justify-content:center;padding:24px;animation:fadeIn 0.2s ease;}
.modal{background:#0A0D14;border:1px solid #161C2E;width:100%;max-width:500px;position:relative;overflow:hidden;animation:slideDown 0.3s ease;}
.modal::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(to right,transparent,#D8DADE,transparent);}
.modal-head{padding:22px 28px 18px;border-bottom:1px solid #161C2E;display:flex;align-items:center;justify-content:space-between;}
.modal-title{font-family:'Cormorant Garamond',serif;font-size:22px;color:#F0E8D8;}
.modal-x{background:none;border:none;color:#7A7E88;font-size:24px;cursor:pointer;line-height:1;padding:4px;transition:color 0.2s;}
.modal-x:hover{color:#F0E8D8;}
.modal-body{padding:28px;}
.plan-badge{background:#0F1320;border:1px solid #161C2E;padding:14px 18px;margin-bottom:22px;}
.plan-badge-name{font-size:10px;text-transform:uppercase;letter-spacing:0.14em;color:#D8DADE;margin-bottom:4px;font-weight:600;}
.plan-badge-price{font-family:'Cormorant Garamond',serif;font-size:26px;color:#F0E8D8;}
.plan-badge-sub{font-size:11px;color:#7A7E88;font-family:'JetBrains Mono',monospace;margin-top:2px;}
.modal-secure{font-size:11px;color:#7A7E88;text-align:center;margin-top:14px;font-family:'Cormorant Garamond',serif;}
.pay-status{text-align:center;padding:28px 0;color:#8898B8;font-size:12px;font-family:'JetBrains Mono',monospace;}
.pay-err{background:rgba(232,72,85,0.1);border:1px solid #E84855;padding:10px 14px;font-size:12px;color:#E8A0A8;margin-top:12px;border-radius:2px;}
.auth-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;position:relative;background:#050709;}
.auth-page::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 60% 50% at 50% 30%,rgba(216,218,222,0.06) 0%,transparent 60%);}
.auth-card{background:#0A0D14;border:1px solid #161C2E;width:100%;max-width:420px;position:relative;overflow:hidden;animation:slideDown 0.4s ease;z-index:1;}
.auth-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(to right,transparent,#D8DADE,transparent);}
.auth-logo-row{padding:28px 32px 0;display:flex;align-items:center;gap:12px;}
.auth-h{padding:20px 32px 0;}
.auth-title{font-family:'Cormorant Garamond',serif;font-size:28px;color:#F0E8D8;margin-bottom:6px;}
.auth-sub{font-size:13px;color:#8898B8;font-family:'Cormorant Garamond',serif;line-height:1.6;}
.auth-form{padding:28px 32px 36px;}
.a-err{background:rgba(232,72,85,0.1);border:1px solid #E84855;padding:10px 14px;font-size:12px;color:#E8A0A8;margin-bottom:16px;}
.a-ok{background:rgba(42,191,133,0.1);border:1px solid #2ABF85;padding:10px 14px;font-size:12px;color:#80C8A8;margin-bottom:16px;}
.a-div{display:flex;align-items:center;gap:12px;margin:20px 0;}
.a-div-line{flex:1;height:1px;background:#161C2E;}
.a-link{font-size:12px;color:#8898B8;text-align:center;margin-top:14px;cursor:pointer;}
.a-link span{color:#D8DADE;text-decoration:underline;}
.fl{font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:#8898B8;margin-bottom:6px;display:block;font-weight:600;}
.fi{width:100%;background:#0F1320;border:1px solid #161C2E;color:#F4F7FF;padding:10px 14px;font-size:13px;font-family:'JetBrains Mono',monospace;outline:none;transition:border-color 0.2s;margin-bottom:14px;}
.fi:focus{border-color:#D8DADE;}
.loading-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#050709;flex-direction:column;gap:16px;}
.loading-logo{font-family:'Cormorant Garamond',serif;font-size:48px;color:#D8DADE;}
.loading-text{font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#7A7E88;}
.mode-pills{display:flex;border:1px solid #161C2E;overflow:hidden;}
.mpill{padding:5px 14px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;background:transparent;border:none;color:#7A7E88;cursor:pointer;font-family:'Syne',sans-serif;transition:all 0.15s;}
.mpill.on{background:#0F1320;color:#D8DADE;}
.card{background:#0A0D14;border:1px solid #161C2E;padding:22px;position:relative;overflow:hidden;transition:border-color 0.2s;}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(to right,transparent,rgba(216,218,222,0.12),transparent);}
.card:hover{border-color:#243050;}
.card-sec{font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#D8DADE;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px;}
.card-sec::after{content:'';flex:1;height:1px;background:linear-gradient(to right,#5A5D64,transparent);max-width:80px;}
.card-lbl{font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#7A7E88;font-weight:600;margin-bottom:4px;}
.val{font-family:'Cormorant Garamond',serif;font-size:36px;font-weight:300;line-height:1;letter-spacing:-0.01em;}
.val.g{color:#D8DADE;}.val.gr{color:#2ABF85;}.val.b{color:#4A7CF7;}.val.r{color:#E84855;}.val.a{color:#E8A020;}
.delta{margin-top:8px;font-size:11px;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;gap:4px;}
.up{color:#2ABF85;}.dn{color:#E84855;}.nu{color:#7A7E88;}
.kpi4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
.kpi3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
.g21{display:grid;grid-template-columns:2fr 1fr;gap:20px;}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
.d-alert{padding:12px 16px;display:flex;align-items:flex-start;gap:10px;font-size:12px;line-height:1.5;border-left:2px solid;}
.d-alert.crit{background:rgba(232,72,85,0.1);border-color:#E84855;color:#E8A0A8;}
.d-alert.ok{background:rgba(42,191,133,0.1);border-color:#2ABF85;color:#80C8A8;}
.d-alert.warn{background:rgba(232,160,32,0.1);border-color:#E8A020;color:#C89050;}
.d-alert.info{background:rgba(74,124,247,0.1);border-color:#4A7CF7;color:#80A0E8;}
/* Post-checkout activation notice. Fixed above every screen, because the
   buyer may be on the paywall or the dashboard when it matters. */
.activation-banner{position:fixed;top:0;left:0;right:0;z-index:400;display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 16px;background:#1A1608;border-bottom:1px solid #E8A020;color:#E8D6B0;font-size:12.5px;line-height:1.5;}
.activation-banner a{color:#E8A020;}
@media(max-width:600px){.activation-banner{flex-direction:column;align-items:flex-start;}}
.trend-bar{height:4px;border-radius:1px;overflow:hidden;background:#161C2E;margin-top:8px;}
.trend-fill{height:100%;border-radius:1px;transition:width 0.8s ease;}
.alloc-row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #161C2E;}
.alloc-row:last-child{border-bottom:none;}
.alloc-icon{width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;}
.alloc-meta{flex:1;}
.alloc-name{font-size:12px;color:#F0E8D8;font-weight:600;margin-bottom:2px;}
.alloc-pct{font-size:10px;color:#8898B8;font-family:'JetBrains Mono',monospace;}
.alloc-track{height:2px;background:#161C2E;margin-top:4px;}
.alloc-fill{height:100%;transition:width 0.8s ease;}
.alloc-amt{font-family:'Cormorant Garamond',serif;font-size:18px;}
.ai-top{padding:12px 20px;border-bottom:1px solid #161C2E;display:flex;align-items:center;justify-content:space-between;}
.ai-lbl{display:flex;align-items:center;gap:8px;font-size:10px;text-transform:uppercase;letter-spacing:0.14em;color:#7A7E88;font-weight:600;}
.ai-glow{width:6px;height:6px;border-radius:50%;background:#D8DADE;box-shadow:0 0 10px #D8DADE;}
.ai-body{padding:20px;min-height:90px;}
.ai-txt{font-family:'Cormorant Garamond',serif;font-size:15px;line-height:2;color:#8898B8;font-style:italic;}
.ai-txt p{margin-bottom:14px;}.ai-txt p:last-child{margin-bottom:0;}
.ai-txt strong{color:#F0E8D8;font-style:normal;font-weight:500;}
.ai-dots{display:flex;gap:6px;align-items:center;}
.ai-dots span{width:6px;height:6px;border-radius:50%;background:#5A5D64;animation:dotPulse 1.4s ease-in-out infinite;}
.ai-dots span:nth-child(2){animation-delay:0.2s;}.ai-dots span:nth-child(3){animation-delay:0.4s;}
.ai-btn{background:transparent;border:1px solid #161C2E;color:#7A7E88;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;padding:5px 14px;cursor:pointer;font-family:'Syne',sans-serif;transition:all 0.2s;}
.ai-rec-field{padding:16px 20px;border-bottom:1px solid #161C2E;}
.ai-rec-field:last-child{border-bottom:none;}
.ai-rec-lbl{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px;}
.ai-rec-body{font-size:14px;line-height:1.75;color:#8898B8;font-family:'Cormorant Garamond',serif;}
.ai-rec-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 20px;background:#0F1320;flex-wrap:wrap;}
.ai-rec-chip{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:4px 10px;border-radius:2px;}
.ai-rec-conf{font-size:11px;color:#8898B8;font-family:'JetBrains Mono',monospace;}
.ai-btn:hover{border-color:#D8DADE;color:#D8DADE;}
.ai-btn:disabled{opacity:0.4;cursor:default;}
.di-lbl{font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#8898B8;margin-bottom:5px;display:block;}
.di{background:#0F1320;border:1px solid #161C2E;color:#F4F7FF;padding:8px 12px;font-size:12px;font-family:'JetBrains Mono',monospace;outline:none;transition:border-color 0.2s;width:100%;}
.di:focus{border-color:#D8DADE;}
.input-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;}
.input-group{display:flex;flex-direction:column;}
.drop-zone{border:2px dashed #161C2E;background:#0F1320;padding:40px 24px;text-align:center;cursor:pointer;transition:all 0.2s;border-radius:2px;}
.drop-zone:hover,.drop-zone.drag{border-color:#D8DADE;background:rgba(216,218,222,0.06);}
.drop-zone-title{font-family:'Cormorant Garamond',serif;font-size:20px;color:#F0E8D8;margin-bottom:8px;}
.drop-zone-sub{font-size:12px;color:#8898B8;line-height:1.6;}
.upload-ok{background:rgba(42,191,133,0.1);border:1px solid #2ABF85;padding:14px 18px;display:flex;align-items:center;gap:12px;}
.upload-ok-txt{font-size:13px;color:#80C8A8;font-family:'Cormorant Garamond',serif;}
.page-wrap{max-width:760px;margin:0 auto;padding:120px 48px 80px;}
.page-title{font-family:'Cormorant Garamond',serif;font-size:clamp(36px,5vw,56px);font-weight:300;color:#F0E8D8;margin-bottom:8px;}
.page-date{font-size:11px;color:#7A7E88;font-family:'JetBrains Mono',monospace;margin-bottom:48px;}
.page-h2{font-family:'Cormorant Garamond',serif;font-size:24px;color:#F0E8D8;margin:40px 0 12px;}
.page-p{font-size:14px;line-height:1.85;color:#8898B8;font-family:'Cormorant Garamond',serif;margin-bottom:16px;}
.page-back{display:inline-flex;align-items:center;gap:8px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#8898B8;cursor:pointer;margin-bottom:40px;transition:color 0.2s;}
.page-back:hover{color:#D8DADE;}
.faq-item{outline:none;}
.faq-item:focus-visible{outline:1px solid #5A5D64;outline-offset:6px;}

/* ── Severity language beyond colour: an explicit text tag rides with
   every colour cue, so meaning survives greyscale/screenshot/colour-
   blindness. Colour is styled inline per instance (reusing the same
   {color, background} pattern already used by .ai-rec-chip), this class
   only carries shape/type. ── */
.severity-tag{display:inline-flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:9.5px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;padding:3px 9px;border-radius:2px;flex-shrink:0;}



/* ── Data maturity: a single-period read must not look as confident as
   a multi-period one. Dashed border + explicit label communicate "the
   system cannot yet assess trajectory" before a founder trusts a number
   that thin. ── */
.data-thin{border:1px dashed #243050!important;}
.data-thin-tag{display:inline-flex;align-items:center;gap:7px;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#E8A020;margin-bottom:12px;}
.data-thin-tag::before{content:'';width:5px;height:5px;background:#E8A020;flex-shrink:0;}

/* ── Loading: skeleton placeholders hold the exact layout the real
   content will occupy, so nothing jumps once data arrives, and the
   founder sees "computing," never a frozen blank screen. ── */
@keyframes skeletonPulse{0%,100%{opacity:0.45}50%{opacity:0.85}}
.skel{background:#161C2E;border-radius:2px;animation:skeletonPulse 1.5s ease-in-out infinite;}


/* ── App shell: header, sidebar and section layout for the signed-in
   workspace. Rows are compact grids so a laptop screen shows the
   directive, the six vital numbers and the trend without scrolling.
   Type sizes are not reduced to get there; the order and density of
   the rows does the work. ── */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
.skip-link{position:absolute;left:12px;top:-60px;z-index:500;background:#D8DADE;color:#050709;padding:8px 14px;font-size:12px;font-weight:700;text-decoration:none;}
.skip-link:focus{top:8px;}
.app{min-height:100vh;background:#050709;display:grid;grid-template-columns:232px minmax(0,1fr);grid-template-rows:56px 1fr;}
.app :focus-visible{outline:2px solid #D8DADE;outline-offset:2px;}
.app-header{grid-column:1/-1;grid-row:1;position:sticky;top:0;z-index:200;height:56px;display:flex;align-items:center;gap:16px;padding-right:20px;background:rgba(5,7,9,0.96);backdrop-filter:blur(16px);border-bottom:1px solid #161C2E;}
.app-brand{width:232px;flex-shrink:0;align-self:stretch;display:flex;align-items:center;gap:10px;padding:0 20px;border-right:1px solid #161C2E;text-decoration:none;}
.app-brand .logomark{width:30px;height:30px;font-size:15px;}
.app-brand .wordmark{font-size:16px;line-height:1.1;}
.app-crumb{font-size:12.5px;color:#7A7E88;white-space:nowrap;}
.app-crumb b{color:#F0E8D8;font-weight:600;}
.hdr-search{position:relative;flex:1 1 320px;max-width:460px;margin-left:auto;}
.hdr-search-input{width:100%;height:36px;background:#0F1320;border:1px solid #161C2E;color:#F4F7FF;padding:0 60px 0 36px;font-family:'Syne',sans-serif;font-size:13px;border-radius:2px;}
.hdr-search-input::placeholder{color:#7A7E88;}
.hdr-search-input:focus{outline:none;border-color:#5A5D64;}
.hdr-search-input::-webkit-search-cancel-button{-webkit-appearance:none;}
.hdr-search-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:#7A7E88;display:flex;pointer-events:none;}
.hdr-kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-family:'JetBrains Mono',monospace;font-size:10.5px;color:#7A7E88;border:1px solid #243050;padding:1px 6px;border-radius:2px;pointer-events:none;}
.hdr-tools{display:flex;align-items:center;gap:10px;flex-shrink:0;}
.hdr-select{height:36px;background:#0F1320;border:1px solid #161C2E;color:#F0E8D8;font-family:'Syne',sans-serif;font-size:13px;padding:0 10px;border-radius:2px;cursor:pointer;}
.hdr-select:focus{outline:none;border-color:#5A5D64;}
.hdr-icon-btn{position:relative;width:36px;height:36px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid #161C2E;border-radius:2px;color:#8898B8;cursor:pointer;transition:color 0.15s,border-color 0.15s;}
.hdr-icon-btn:hover,.hdr-icon-btn[aria-expanded="true"]{color:#F0E8D8;border-color:#243050;}
.hdr-menu,.hdr-search-toggle{display:none;}
.hdr-badge{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#E84855;color:#fff;font-size:10.5px;font-weight:700;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;}
.hdr-dot{position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:#4A7CF7;}
.hdr-pop-wrap{position:relative;}
.hdr-account{display:flex;align-items:center;gap:10px;background:transparent;border:1px solid transparent;border-radius:2px;padding:3px 8px 3px 3px;cursor:pointer;color:#8898B8;font-family:'Syne',sans-serif;}
.hdr-account:hover,.hdr-account[aria-expanded="true"]{border-color:#161C2E;color:#F0E8D8;}
.hdr-av{border-radius:50%;background:rgba(216,218,222,0.12);border:1px solid #5A5D64;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#D8DADE;overflow:hidden;flex-shrink:0;}
.hdr-av img{width:100%;height:100%;object-fit:cover;}
.hdr-who{display:flex;flex-direction:column;align-items:flex-start;line-height:1.3;min-width:0;}
.hdr-name{font-size:13px;color:#F0E8D8;font-weight:600;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.hdr-role{font-size:11.5px;color:#7A7E88;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.hdr-chev{display:flex;color:#7A7E88;}
.hdr-pop{position:absolute;top:calc(100% + 8px);background:#0F1320;border:1px solid #243050;box-shadow:0 18px 44px -14px rgba(0,0,0,0.7);z-index:260;animation:fadeIn 0.12s ease;}
.hdr-pop-right{right:0;}
.hdr-search-pop{left:0;right:0;max-height:min(440px,70vh);overflow-y:auto;padding:4px 0;}
.alerts-pop{width:min(380px,calc(100vw - 24px));max-height:min(480px,75vh);overflow-y:auto;}
.acct-pop{min-width:230px;padding:4px 0;}
.acct-id{padding:10px 14px;border-bottom:1px solid #161C2E;margin-bottom:4px;}
.pop-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #161C2E;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#D8DADE;font-weight:600;}
.pop-head span{font-family:'JetBrains Mono',monospace;color:#7A7E88;letter-spacing:0;}
.pop-sec{padding:10px 14px 4px;font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;color:#7A7E88;font-weight:600;}
.pop-item{display:flex;align-items:center;gap:10px;width:100%;padding:9px 14px;background:none;border:none;text-align:left;color:#8898B8;font-size:13px;font-family:'Syne',sans-serif;cursor:pointer;}
.pop-item:hover,.pop-item.active{background:#0A0D14;color:#F0E8D8;}
.pop-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pop-date{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#7A7E88;flex-shrink:0;}
.pop-amt{font-family:'JetBrains Mono',monospace;font-size:12px;flex-shrink:0;}
.pop-empty{padding:14px;font-size:13px;line-height:1.6;color:#8898B8;}
.alert-item{display:flex;flex-direction:column;gap:3px;width:100%;padding:12px 14px;background:none;border:none;border-bottom:1px solid #161C2E;text-align:left;cursor:pointer;font-family:'Syne',sans-serif;}
.alert-item:last-child{border-bottom:none;}
.alert-item:hover{background:#0A0D14;}
.alert-sev{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;}
.alert-title{font-size:13px;color:#F0E8D8;font-weight:600;line-height:1.4;}
.alert-detail{font-size:12.5px;color:#8898B8;line-height:1.5;}

.app-side{grid-column:1;grid-row:2;position:sticky;top:56px;height:calc(100vh - 56px);overflow-y:auto;background:#0A0D14;border-right:1px solid #161C2E;display:flex;flex-direction:column;padding:14px 10px 16px;}
.side-backdrop{display:none;}
.nav-label{font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:#7A7E88;font-weight:600;padding:10px 12px 6px;}
.nav-list{list-style:none;margin-bottom:8px;}
.nav-item{display:flex;align-items:center;gap:12px;width:100%;padding:9px 12px;margin:1px 0;font-size:13.5px;font-weight:500;color:#8898B8;text-decoration:none;background:none;border:1px solid transparent;border-left:2px solid transparent;border-radius:2px;cursor:pointer;font-family:'Syne',sans-serif;text-align:left;transition:color 0.15s,background 0.15s;}
.nav-item svg{flex-shrink:0;color:#7A7E88;transition:color 0.15s;}
.nav-item:hover{color:#F0E8D8;background:#0F1320;}
.nav-item:hover svg{color:#D8DADE;}
.nav-item.on{color:#F0E8D8;background:rgba(216,218,222,0.07);border-color:#161C2E;border-left-color:#D8DADE;}
.nav-item.on svg{color:#D8DADE;}
.side-plan{margin-top:auto;border:1px solid #161C2E;padding:12px;}
.side-plan-name{font-size:13px;color:#F0E8D8;font-weight:600;}

.app-main{grid-column:2;grid-row:2;min-width:0;padding:20px 24px 40px;display:flex;flex-direction:column;gap:16px;outline:none;}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 20px;flex-wrap:wrap;}
.page-h1{font-family:'Cormorant Garamond',serif;font-size:30px;font-weight:400;color:#F0E8D8;line-height:1.1;}
.page-meta{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#7A7E88;margin-top:4px;}
.page-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.btn-md{font-size:11px;padding:9px 16px;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;white-space:nowrap;}
.page-actions .mpill{padding:8px 14px;font-size:10.5px;}

.row{display:grid;gap:16px;min-width:0;align-items:stretch;}
.row-21{grid-template-columns:minmax(0,2fr) minmax(0,1fr);}
.row-12{grid-template-columns:minmax(0,1fr) minmax(0,2fr);}
.row-2{grid-template-columns:repeat(2,minmax(0,1fr));}
.row-3{grid-template-columns:repeat(3,minmax(0,1fr));}
.panel{background:#0A0D14;border:1px solid #161C2E;padding:16px 18px;min-width:0;display:flex;flex-direction:column;position:relative;}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;}
.panel-title{font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#D8DADE;font-weight:600;font-family:'Syne',sans-serif;}
.panel-link{display:inline-flex;align-items:center;gap:5px;background:none;border:none;padding:2px 0;color:#8898B8;font-size:12.5px;font-family:'Syne',sans-serif;cursor:pointer;white-space:nowrap;text-decoration:none;align-self:flex-start;}
.panel-link:hover{color:#F0E8D8;}
.panel-head .panel-link{align-self:center;}
.panel-copy{font-family:'Cormorant Garamond',serif;font-size:15px;line-height:1.6;color:#8898B8;}
.narrative{font-family:'Cormorant Garamond',serif;font-size:16px;line-height:1.65;color:#F0E8D8;margin-bottom:8px;}
.big-num{font-family:'Cormorant Garamond',serif;font-size:34px;font-weight:400;color:#F0E8D8;line-height:1.1;margin-bottom:6px;}

.directive-strip{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px 22px;align-items:center;padding:14px 18px;border:1px solid var(--uc,#5A5D64);background:linear-gradient(135deg,rgba(216,218,222,0.05) 0%,rgba(5,7,9,0) 60%);position:relative;}
.directive-strip::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(to right,transparent,var(--uc,#D8DADE),transparent);}
.ds-meta{display:flex;flex-direction:column;gap:8px;align-items:flex-start;}
.ds-kicker{font-size:10.5px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;white-space:nowrap;}
.ds-text{font-family:'Cormorant Garamond',serif;font-size:21px;color:#F0E8D8;line-height:1.3;}
.ds-reason{font-family:'Cormorant Garamond',serif;font-size:15px;color:#8898B8;line-height:1.55;margin-top:2px;}
.ds-actions{display:flex;align-items:center;}
.alert-row{display:flex;flex-direction:column;gap:8px;}

.kpi-row{display:grid;grid-template-columns:minmax(0,1.5fr) repeat(5,minmax(0,1fr));gap:12px;}
.kpi-row.data-thin{padding:8px;}
.kpi{background:#0A0D14;border:1px solid #161C2E;padding:14px 16px;min-width:0;position:relative;display:flex;flex-direction:column;}
.kpi.kpi-lead{background:linear-gradient(160deg,#0F1320 0%,#0A0D14 70%);}
.kpi.kpi-lead::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--sev,#5A5D64);}
.kpi-lbl{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:20px;font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;color:#7A7E88;font-weight:600;}
.kpi-val{font-family:'Cormorant Garamond',serif;font-size:34px;font-weight:400;line-height:1.1;margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kpi.kpi-lead .kpi-val{font-size:56px;}
.kpi-unit{font-size:0.5em;color:#7A7E88;margin-left:3px;}
.kpi-sub{font-size:12px;color:#8898B8;line-height:1.5;margin-top:6px;}
.kpi.kpi-lead .kpi-sub{font-family:'Cormorant Garamond',serif;font-size:15px;}

.traj-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.traj-cell{display:flex;align-items:center;gap:12px;min-width:0;}
.traj-lbl{font-family:'Cormorant Garamond',serif;font-size:19px;color:#F0E8D8;line-height:1.2;}
.traj-note{font-family:'Cormorant Garamond',serif;font-size:14.5px;color:#8898B8;line-height:1.5;margin-top:10px;}
.traj-note:empty{display:none;}
.mini-list{list-style:none;display:flex;flex-direction:column;}
.mini-list li{display:flex;align-items:baseline;gap:10px;padding:8px 0;border-bottom:1px solid #161C2E;min-width:0;}
.mini-list li:last-child{border-bottom:none;}
.mini-list li.mini-stack{flex-direction:column;align-items:stretch;gap:3px;}
.mini-main{flex:1;min-width:0;font-size:13px;color:#F0E8D8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mini-stack .mini-main{white-space:normal;font-family:'Cormorant Garamond',serif;font-size:15px;line-height:1.35;}
.mini-date{font-family:'JetBrains Mono',monospace;font-size:11px;color:#7A7E88;flex-shrink:0;}
.mini-amt{font-family:'JetBrains Mono',monospace;font-size:12.5px;color:#D8DADE;flex-shrink:0;}
.mini-foot{margin-top:10px;padding-top:10px;border-top:1px solid #161C2E;font-size:12px;color:#8898B8;}
.bar-row-lbl{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:#8898B8;margin-bottom:5px;}
.bar-track{display:block;height:8px;background:#161C2E;border-radius:4px;overflow:hidden;}
.bar-track > *{display:block;height:100%;}
.nudge-row{display:flex;align-items:center;justify-content:space-between;gap:16px 24px;flex-wrap:wrap;padding:16px 18px;background:#0F1320;border:1px solid #161C2E;}
.nudge-row-title{font-family:'Cormorant Garamond',serif;font-size:19px;color:#F0E8D8;}
.nudge-row-sub{font-family:'Cormorant Garamond',serif;font-size:15px;color:#8898B8;line-height:1.55;margin-top:2px;max-width:640px;}

.tbl-wrap{overflow:auto;min-width:0;}
.tbl{width:100%;border-collapse:collapse;font-size:13px;}
.tbl th{text-align:left;font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:#7A7E88;font-weight:600;padding:8px 10px;border-bottom:1px solid #243050;background:#0A0D14;position:sticky;top:0;white-space:nowrap;}
.tbl td{padding:9px 10px;border-bottom:1px solid #161C2E;color:#F0E8D8;vertical-align:top;}
.tbl tfoot th,.tbl tfoot td{border-top:1px solid #243050;border-bottom:none;font-weight:600;position:static;}
.tbl tbody tr:hover td{background:#0F1320;}
.tbl .num{text-align:right;font-family:'JetBrains Mono',monospace;font-size:12.5px;white-space:nowrap;}
.tbl .mono{font-family:'JetBrains Mono',monospace;font-size:12px;color:#8898B8;white-space:nowrap;}
.tbl .muted{color:#8898B8;}
.tx-tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;}
.tx-sum{font-family:'JetBrains Mono',monospace;font-size:12px;color:#8898B8;margin-left:auto;}
.busy-line{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:12.5px;color:#8898B8;font-family:'JetBrains Mono',monospace;}
.batch-list{list-style:none;display:flex;flex-direction:column;max-height:320px;overflow-y:auto;}
.batch-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #161C2E;}
.batch-list li:last-child{border-bottom:none;}
.batch-name{font-size:13px;color:#F0E8D8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.batch-meta{font-family:'JetBrains Mono',monospace;font-size:11px;color:#7A7E88;margin-top:3px;line-height:1.5;}
.input-grid-4{grid-template-columns:repeat(4,minmax(0,1fr));}
.details-summary{cursor:pointer;font-family:'Cormorant Garamond',serif;font-size:15px;color:#8898B8;line-height:1.5;}
.details-summary:hover{color:#F0E8D8;}
.kv{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:13px;}
.kv dt{color:#8898B8;}
.kv dd{color:#F0E8D8;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12.5px;}
.kv-wide dd{text-align:left;}
.week-list{list-style:none;display:flex;flex-direction:column;gap:6px;}
.week-list li{display:grid;grid-template-columns:44px minmax(0,1fr) 88px;align-items:center;gap:10px;}
.week-list .mini-amt{text-align:right;}
.week-bar{height:10px;}
.scenario-cell{background:#0F1320;border:1px solid #161C2E;padding:12px 14px;min-width:0;}
.scenario-before{font-family:'JetBrains Mono',monospace;font-size:12px;color:#7A7E88;margin-top:6px;}
.scenario-after{font-family:'JetBrains Mono',monospace;font-size:16px;margin-top:2px;overflow-wrap:anywhere;}
.form-stack{display:flex;flex-direction:column;gap:14px;}
.faq-list{display:flex;flex-direction:column;}
.faq-d{border-bottom:1px solid #161C2E;padding:12px 0;}
.faq-d:last-child{border-bottom:none;}
.faq-d summary{cursor:pointer;font-size:14px;font-weight:600;color:#F0E8D8;line-height:1.4;}
.faq-d summary:hover{color:#D8DADE;}
.faq-d p{font-family:'Cormorant Garamond',serif;font-size:15.5px;line-height:1.7;color:#8898B8;margin-top:8px;}
.report-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:12px;border-bottom:1px solid #161C2E;}
.report-title{font-family:'Cormorant Garamond',serif;font-size:24px;color:#F0E8D8;}
.log-list{list-style:none;display:flex;flex-direction:column;gap:14px;}
.log-list li{border-left:3px solid #D8DADE;padding:2px 0 14px 14px;border-bottom:1px solid #161C2E;}
.log-list li:last-child{border-bottom:none;padding-bottom:2px;}
.log-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;}
.log-text{font-family:'Cormorant Garamond',serif;font-size:16.5px;color:#F0E8D8;line-height:1.4;}
.log-meta{font-family:'Cormorant Garamond',serif;font-size:14.5px;color:#8898B8;margin-top:4px;line-height:1.5;}

/* Six tiles across need about 1,040px of content width to hold the widest
   values at full size (56px lead, 34px others: measured, not estimated).
   Below that they wrap to two rows of three rather than shrinking. */
@media(max-width:1320px){
  .kpi-row{grid-template-columns:repeat(3,minmax(0,1fr));}
}
@media(max-width:1100px){
  .hdr-who,.hdr-chev,.hdr-kbd{display:none;}
  .row-3{grid-template-columns:repeat(2,minmax(0,1fr));}
  .input-grid-4{grid-template-columns:repeat(2,minmax(0,1fr));}
}
/* Below 960px the sidebar becomes a drawer opened from the header. */
@media(max-width:960px){
  .app{grid-template-columns:minmax(0,1fr);}
  .app-header{padding:0 12px;gap:10px;}
  .hdr-menu{display:flex;}
  .app-crumb{display:none;}
  .app-brand{width:auto;border-right:none;padding:0;align-self:center;}
  .app-brand .wordmark-sub{display:none;}
  .app-side{position:fixed;top:56px;left:0;bottom:0;width:min(280px,86vw);height:auto;z-index:240;transform:translateX(-100%);visibility:hidden;transition:transform 0.2s ease,visibility 0s linear 0.2s;box-shadow:24px 0 48px -24px rgba(0,0,0,0.8);}
  /* Visible at once on open, so the first link can take focus; hidden only after the slide-out on close. */
  .app-side.open{transform:none;visibility:visible;transition:transform 0.2s ease,visibility 0s;}
  .side-backdrop{display:block;position:fixed;top:56px;left:0;right:0;bottom:0;z-index:230;background:rgba(5,7,9,0.6);}
  .app-main{grid-column:1;padding:16px 16px 32px;}
  .row-21,.row-12,.row-2{grid-template-columns:minmax(0,1fr);}
  .directive-strip{grid-template-columns:minmax(0,1fr);}
  .ds-meta{flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap;}
}
/* Phones: search moves behind a header button and opens as a full-width row. */
@media(max-width:720px){
  .hdr-search{display:none;}
  .hdr-search.open{display:block;position:fixed;top:56px;left:0;right:0;max-width:none;padding:10px 12px;background:#050709;border-bottom:1px solid #161C2E;z-index:220;}
  .hdr-search.open .hdr-search-icon{left:23px;}
  .hdr-search-toggle{display:flex;}
  .kpi-row{grid-template-columns:repeat(2,minmax(0,1fr));}
  .kpi.kpi-lead{grid-column:1/-1;}
  .row-3{grid-template-columns:minmax(0,1fr);}
  .tx-sum{margin-left:0;}
}
@media(max-width:520px){
  .app-brand-txt{display:none;}
  .hdr-select{max-width:118px;}
  .hdr-tools{gap:8px;}
  .page-h1{font-size:26px;}
}
@media(prefers-reduced-motion:reduce){
  .app-side{transition:none;}
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

@media(max-width:960px){
  .feat-grid,.price-grid,.kpi4,.kpi3,.g3{grid-template-columns:1fr 1fr;}
  .stats-bar{grid-template-columns:1fr;}
  .g2,.g21,.input-grid{grid-template-columns:1fr;}
  .nav-links{display:none;}
  .nav-burger{display:flex;}
  /* Sign In + Get Started + the hamburger together overflow the nav at
     phone widths (confirmed via live rendering — Sign In and part of Get
     Started were clipped off the right edge at 390px). Sign In stays
     reachable one scroll down in the hero's own CTA row, so the nav row
     keeps a single primary action plus the menu toggle on mobile. */
  .nav-cta .btn-ghost{display:none;}
  .nav,.hero,.sec,.cta-sec{padding-left:24px;padding-right:24px;}
  .footer{padding:32px 24px;}
  .hero{grid-template-columns:1fr;text-align:center;padding-top:120px;}
  .hero-copy{max-width:none;}
  .hero-sub{margin:0 auto 40px;}
  .hero-cta,.hero-proof{justify-content:center;}
  .hero-preview{max-width:480px;margin:0 auto;width:100%;}
  .price-card.hot{transform:none;box-shadow:none;}
  .price-card.hot:hover{transform:translateY(-4px);}
}
@media(max-width:600px){
  .feat-grid,.price-grid,.kpi4,.kpi3,.g3{grid-template-columns:1fr;}
  .price-diag{flex-direction:column;align-items:flex-start;gap:18px;padding:22px;}
  .price-diag .btn{width:100%;}
  .hero-preview-kpis{grid-template-columns:1fr;}
}
@media(prefers-reduced-motion:reduce){
  .skel{animation:none;opacity:0.65;}
}
/* Focus indicators. Several controls are styled divs and spans that are
   made keyboard-operable via clickableProps; without a visible ring a
   keyboard user cannot tell where they are (WCAG 2.4.7). */
:focus-visible{outline:2px solid #D8DADE;outline-offset:2px;}
.drop-zone:focus-visible{outline:2px solid #D8DADE;outline-offset:-3px;}
.a-link:focus-visible,.page-back:focus-visible,.hero-preview-reset:focus-visible,.footer-links a:focus-visible,.nav-logo:focus-visible,.auth-logo-row:focus-visible{outline:2px solid #D8DADE;outline-offset:3px;}

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
// Renders the model's response as a structured executive recommendation —
// What Happened / Why / Business Impact / Risk / Action / Expected Outcome
// / Confidence — as real React text, never raw HTML. The model's output is
// untrusted content; dangerouslySetInnerHTML would execute anything it
// contained.
const RISK_CHIP_COLOR = { Critical: C.red, Elevated: C.amber, Watch: C.gold, Low: C.green };

function AIRecommendation({ rec }) {
  const riskColor = RISK_CHIP_COLOR[rec.riskLevel] || C.inkDim;
  const fields = [
    { key:"whatHappened",     lbl:"What Happened",      col:C.inkDim },
    { key:"whyItHappened",    lbl:"Why It Happened",    col:C.blue },
    { key:"businessImpact",   lbl:"Business Impact",    col:C.amber },
    { key:"recommendedAction",lbl:"Recommended Action", col:C.gold },
    { key:"expectedOutcome",  lbl:"Expected Outcome",   col:C.green },
  ];
  return (
    <div>
      {fields.map(f => rec[f.key] && (
        <div className="ai-rec-field" key={f.key}>
          <div className="ai-rec-lbl" style={{ color:f.col }}>{f.lbl}</div>
          <div className="ai-rec-body">{rec[f.key]}</div>
        </div>
      ))}
      <div className="ai-rec-footer">
        <span className="ai-rec-chip" style={{ color:riskColor, background:`${riskColor}1F` }}>{rec.riskLevel || "Unknown"} Risk</span>
        <span className="ai-rec-conf">Confidence {rec.confidenceScore ?? "—"}/100{rec.confidenceReason ? ` — ${rec.confidenceReason}` : ""}</span>
      </div>
    </div>
  );
}

// ─── METRIC CONFIDENCE ──────────────────────────────────────────
// Renders nothing for a high-confidence metric — the caveat only earns
// its place on screen when the number genuinely needs one. `#3A4A68`
// (an earlier draft's color for this exact label style) fails WCAG AA
// against this dashboard's background; C.inkDim (#7A7E88) is the value
// already verified this session and used for every other small-caps
// label in the app, so it's used here for the same reason.
function ConfidenceLine({ c }) {
  if (!c) return null;
  if (c.shown && c.level === "high") return null;
  const label = c.shown ? `${c.level} confidence` : "not enough data";
  return (
    <div style={{ fontSize:9, letterSpacing:"0.1em", textTransform:"uppercase", color:C.inkDim, fontWeight:600, marginTop:6, lineHeight:1.5 }}>
      {label} — {c.reason}
    </div>
  );
}

// ─── SEVERITY TAG ─────────────────────────────────────────────
// Every colour-coded state carries an explicit text label riding with
// it — colour alone fails accessibility and fails the instant someone
// screenshots in greyscale. Reuses the {color, background} chip pattern
// already established by .ai-rec-chip, so severity reads consistently
// everywhere it appears.
const SEVERITY_STYLE = {
  critical: { text:"Critical", color:C.red },
  warning:  { text:"Warning",  color:C.amber },
  positive: { text:"Healthy",  color:C.green },
  neutral:  { text:"Stable",   color:C.gold },
};
function SeverityTag({ level, label }) {
  const s = SEVERITY_STYLE[level] || SEVERITY_STYLE.neutral;
  return (
    <span className="severity-tag" style={{ color:s.color, background:`${s.color}1F` }}>
      {label || s.text}
    </span>
  );
}

// ─── LOADING SKELETONS ────────────────────────────────────────
// Holds the exact shape of the content about to arrive, so nothing jumps
// once real data lands — communicates "computing," never a frozen blank
// screen, while file parsing / history load / AI generation are in flight.
function SkeletonKPIRow() {
  return (
    <div className="kpi-row" aria-busy="true" aria-label="Loading your financial position">
      {[0, 1, 2, 3, 4, 5].map(i => (
        <div className="kpi" key={i} style={{ minHeight:120 }}>
          <div className="skel" style={{ width:"55%", height:9, marginBottom:16 }}/>
          <div className="skel" style={{ width:i === 0 ? "70%" : "60%", height:i === 0 ? 38 : 28, marginBottom:12 }}/>
          <div className="skel" style={{ width:"45%", height:9 }}/>
        </div>
      ))}
    </div>
  );
}

// ─── RING CHART ───────────────────────────────────────────────
function Ring({ score, size = 100, sw = 6 }) {
  const s = safe(score);
  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;
  const fill = (s / 100) * circ;
  const col  = s > 70 ? C.gold : s > 40 ? C.amber : C.red;
  return (
    <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.border} strokeWidth={sw}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={sw}
          strokeDasharray={circ} strokeDashoffset={circ - fill} strokeLinecap="butt"
          style={{ transition:"stroke-dashoffset 1s ease, stroke 0.5s" }}/>
      </svg>
      <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
        <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:24, color:C.gold, lineHeight:1 }}>{Math.round(s)}</div>
        <div style={{ fontSize:9, color:C.inkDim, fontFamily:"'JetBrains Mono',monospace" }}>/100</div>
      </div>
    </div>
  );
}

// ─── BAR CHART ────────────────────────────────────────────────
function BChart({ data }) {
  if (!data || data.length === 0) return (
    <div style={{ textAlign:"center", padding:"40px 0", color:C.inkDim, fontFamily:"'Cormorant Garamond',serif", fontSize:14 }}>
      Connect data to see your revenue trend.
    </div>
  );
  // Both series share one scale. Scaling to revenue alone drew any month
  // whose expenses beat revenue taller than the chart — the exact month that
  // most needs reading correctly.
  const maxV = Math.max(...data.map(d => Math.max(d.revenue || 0, d.expenses || 0)), 1);
  return (
    <div>
      <div style={{ display:"flex", alignItems:"flex-end", gap:6, height:140 }} role="img"
        aria-label={`Revenue and expenses by month. Latest, ${data[data.length-1].month}: revenue ${fmt(data[data.length-1].revenue)}, expenses ${fmt(data[data.length-1].expenses)}.`}>
        {data.map((d, i) => (
          <div key={i} title={`${d.month}: revenue ${fmt(d.revenue)}, expenses ${fmt(d.expenses)}`}
            style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", alignItems:"center", gap:4, height:"100%", justifyContent:"flex-end" }}>
            <div style={{ display:"flex", gap:2, alignItems:"flex-end", height:120, width:"100%", justifyContent:"center" }}>
              <div style={{ width:"46%", borderRadius:"1px 1px 0 0", minHeight:3, height:`${(d.revenue/maxV)*110}px`, background:`linear-gradient(to top,${C.blue},rgba(74,124,247,0.4))` }}/>
              <div style={{ width:"46%", borderRadius:"1px 1px 0 0", minHeight:3, height:`${(d.expenses/maxV)*110}px`, background:`linear-gradient(to top,rgba(232,72,85,0.7),rgba(232,72,85,0.2))` }}/>
            </div>
            <span style={{ fontSize:9, color:C.inkDim, fontFamily:"'JetBrains Mono',monospace", whiteSpace:"nowrap", overflow:"hidden", maxWidth:"100%" }}>{data.length > 12 && i % 2 ? "" : d.month}</span>
          </div>
        ))}
      </div>
      <div style={{ display:"flex", gap:16, marginTop:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:10, color:C.ink }}>
          <div style={{ width:8, height:8, borderRadius:1, background:C.blue }}/>Revenue
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:10, color:C.ink }}>
          <div style={{ width:8, height:8, borderRadius:1, background:C.red }}/>Expenses
        </div>
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
function DirectiveStrip({ d, children }) {
  const uc = { critical:C.red, warn:C.amber, go:C.green, stable:C.gold }[d.severity];
  // Critical calls get a heavier frame, not just a red hue — weight carries
  // severity too, so it survives greyscale.
  return (
    <section className="directive-strip" style={{ "--uc":uc, borderWidth: d.severity === "critical" ? 2 : 1 }} aria-label="This week's directive">
      <div className="ds-meta">
        <div className="ds-kicker" style={{ color:uc }}>This week's directive</div>
        <SeverityTag level={DIRECTIVE_SEVERITY_TAG[d.severity]}/>
      </div>
      <div style={{ minWidth:0 }}>
        <div className="ds-text">{d.text}</div>
        <div className="ds-reason">
          {d.reason}
          {d.wasCapped && " This is based on a single month of data — treat it as an early warning, not a confirmed crisis, until more history confirms it."}
        </div>
      </div>
      {children && <div className="ds-actions">{children}</div>}
    </section>
  );
}

// ─── DATA UPLOAD ──────────────────────────────────────────────
function DataUpload({ onDataLoaded, hasData }) {
  const [drag,    setDrag]    = useState(false);
  const [parsing, setParsing] = useState(false);
  const [err,     setErr]     = useState("");
  const [csvUrl,  setCsvUrl]  = useState("");
  const [syncing, setSyncing] = useState(false);
  const fileRef = useRef(null);

  const processCSVText = (text, source) => {
    const result = parseAnyCSV(text);
    if (!result || result.rows.length === 0) {
      setErr("No readable financial data found. Ensure the file has at minimum a Revenue column.");
      return false;
    }
    setErr("");
    onDataLoaded(result.rows, source, result.detectedFields, text);
    return true;
  };

  const handleFile = async (file) => {
    if (!file) return;
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
    if (!csvUrl.trim()) return;
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
          <div key={i} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, padding:"12px 14px" }}>
            <div style={{ fontSize:12, color:C.cream, fontWeight:600, marginBottom:2 }}>{a.name}</div>
            <div style={{ fontSize:10, color:C.inkDim, lineHeight:1.5 }}>{a.hint}</div>
          </div>
        ))}
      </div>

      <div style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, padding:"16px 18px" }}>
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
          <div style={{ width:8, height:8, borderRadius:"50%", background:C.green, flexShrink:0 }}/>
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
            <div className="plan-badge-price">${plan.usd.toLocaleString()} <span style={{ fontSize:14, color:C.inkDim }}>{plan.period}</span></div>
            <div className="plan-badge-sub">Billed monthly via PayPal. Cancel anytime.</div>
          </div>
          {replaces && !done && (
            <div className="d-alert info" style={{ marginBottom:16 }}>
              This replaces your {replaces.name} plan. Its ${replaces.usd.toLocaleString()}/month subscription is cancelled automatically once {plan.name} is active, so you are not billed for both. Charges already made are not refunded automatically.
            </div>
          )}

          {done ? (
            <div style={{ textAlign:"center", padding:"12px 0" }}>
              <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:24, color:C.cream, marginBottom:12 }}>
                {plan.name} is now active
              </div>
              <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.7, marginBottom:24 }}>
                Subscription confirmed. You will be billed ${plan.usd}/month. A receipt was sent to {userEmail}.
              </div>
              <button className="btn btn-full btn-primary" onClick={onClose}>Enter Dashboard</button>
            </div>
          ) : verifying ? (
            <div className="pay-status"><span className="spinner" style={{ display:"inline-block", marginBottom:8 }}/><br/>Confirming the price with PayPal...</div>
          ) : blockReason ? (
            <>
              <div className="pay-err">{CHECKOUT_UNAVAILABLE}</div>
              <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.7, margin:"16px 0 20px" }}>
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
              <div style={{ fontSize:14, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.7, marginBottom:24 }}>
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
                <div className="plan-badge-price">${DIAGNOSTIC.usd.toLocaleString()} <span style={{ fontSize:14, color:C.inkDim }}>once</span></div>
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
                    <span className="pop-amt" style={{ color: Number(opt.t.amount) >= 0 ? C.green : C.ink }}>{fmt(opt.t.amount)}</span>
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
const ALERT_STYLE = { critical:{ text:"Critical", color:C.red }, warning:{ text:"Warning", color:C.amber }, info:{ text:"Info", color:C.blue } };

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
      <div className="kpi-val" style={{ color:t.col || C.cream }}>
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

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      // `description` is fetched alongside the aggregates so real revenue
      // concentration can be computed from payer names — that only exists
      // at the transaction level, never in a monthly bucket.
      const cutoff = periodCutoff();
      const list = await selectAll(() => {
        let query = supabase.from("transactions").select("id, txn_date, amount, category, description")
          .order("txn_date", { ascending: true }).order("id", { ascending: true });
        if (cutoff) query = query.gte("txn_date", cutoff);
        return query;
      });
      setTxns(list);
      setHistory(aggregateTransactionsByMonth(list));
      setConcentrationData(computeRevenueConcentration(list));
      // Ascending order, so the last row is the most recent real transaction —
      // this is what the confidence model's recency check degrades against.
      setLastTxnDate(list.length > 0 ? list[list.length - 1].txn_date : null);
    } catch (e) {
      console.error("Failed to load transaction history:", e);
      setTxns([]);
      setHistory([]);
      setConcentrationData(computeRevenueConcentration([]));
      setLastTxnDate(null);
      setActionErr("Your transaction history could not be loaded. Refresh to try again.");
    }
    setHistoryLoading(false);
  }, [periodCutoff]);

  const loadBatches = useCallback(async () => {
    const { data: rows, error } = await supabase.from("upload_batches").select("*").order("uploaded_at", { ascending: false });
    if (error) { console.error("Failed to load upload history:", error); setActionErr("Your upload history could not be loaded. Refresh to try again."); return; }
    setBatches(rows || []);
  }, []);

  // Recurring-obligation detection always runs over the founder's FULL
  // transaction history, independent of the period filter — a quarterly or
  // annual obligation can't be reliably detected from a 3-month window even
  // if that's what's currently selected for display.
  const loadObligations = useCallback(async () => {
    try {
      const all = await selectAll(() => supabase.from("transactions").select("txn_date, amount, description, category")
        .order("txn_date", { ascending: true }).order("id", { ascending: true }));
      const detected = detectRecurringObligations(all);

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
        ...o, user_id: user.id,
        active: existingActiveByKey[o.normalized_key] === false ? false : o.active,
      }));
      if (rows.length > 0) {
        const { error: upsertErr } = await supabase.from("recurring_obligations").upsert(rows, { onConflict: "user_id,normalized_key" });
        if (upsertErr) throw upsertErr;
      }

      const { data: persisted, error: persistErr } = await supabase.from("recurring_obligations").select("*").order("typical_amount", { ascending: false });
      if (persistErr) throw persistErr;
      setObligations(persisted || []);
    } catch (e) {
      console.error("Failed to detect/load recurring obligations:", e);
      setObligations([]);
    }
  }, [user]);

  const setObligationActive = async (id, active) => {
    const { error } = await supabase.from("recurring_obligations").update({ active }).eq("id", id);
    if (error) { console.error("Failed to update obligation:", error); setActionErr("That obligation could not be updated. Nothing was changed — try again."); return; }
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

  const handleDataLoaded = async (parsedRows, source, cols, rawText) => {
    setData(parsedRows); setDataSource(source);
    setUploadStatus(""); setUploadErr(""); setUploadBusy(true);
    try {
      const parsed = parseTransactions(rawText);
      if (!parsed || parsed.transactions.length === 0) {
        setUploadErr("This file loaded for the current session, but no dated transactions could be added to your permanent history.");
        setUploadBusy(false);
        return;
      }
      const { transactions, mode: parserMode } = parsed;
      const dates = transactions.map(t => t.txn_date).sort();

      const { data: batch, error: batchErr } = await supabase.from("upload_batches").insert({
        user_id: user.id, filename: source, row_count: transactions.length,
        period_start: dates[0], period_end: dates[dates.length - 1], parser_mode: parserMode,
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

      setUploadStatus(`Added ${insertedCount} new transaction${insertedCount === 1 ? "" : "s"}. ${duplicateCount} already on file.`);
      await loadHistory();
      await loadBatches();
      await loadObligations();
    } catch (e) {
      console.error("Failed to save transaction history:", e);
      setUploadErr("Your file was read for this session, but saving it to your permanent history failed. The numbers are accurate for now — try re-uploading to save them.");
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
    { lastTxnDate: history.length > 0 ? lastTxnDate : null, revenueConcentration: concentrationData }
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
    ? checkAffordability({ currentCash: activeCash, avgRev, avgExp, obligations: activeObligations, monthlyCost: affordAmount, fromDate: todayStr })
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
    ? computeDirective({ margin, burnMonths, free, vel, conv, ltvcac, months: n, concentration: concentrationData })
    : null;

  // Persist a directive only when it genuinely differs from the most
  // recently stored one — never on every render or page load. Waits for
  // the initial fetch to land first, so an already-persisted directive
  // that just hasn't loaded into state yet is never duplicated.
  useEffect(() => {
    if (!currentDirective || directivesLoading || directivesError) return;
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
            outcome: describeDirectiveOutcome(d),
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
        history.length > 0 ? `${txns.length.toLocaleString()} transactions` : (dataSource || "Manual entry"),
        history.length > 0 ? periodLabel : null,
        `${capitalize(dataConfidence)} confidence`,
      ].filter(Boolean).join(" · ");

  const runwayText = cashFlowPositive ? "No burn" : (runwayConfidence.shown && burnMonths > 0) ? `${safe(burnMonths).toFixed(1)} mo` : "---";

  // KPI tiles. The first tile is chosen by severity, not fixed by position —
  // when free cash or runway turns critical, that is what leads the row.
  const tiles = {
    revenue: { key:"revenue", lbl:"Monthly revenue", val:fmtCompact(latest.revenue), title:fmt(latest.revenue),
      sub:`${vel >= 0 ? "+" : ""}${pc(vel)} vs prior month`, col:C.cream },
    margin:  { key:"margin", lbl:"Profit margin", val:pc(margin), col: margin > 0 ? C.green : C.red,
      sub:`${fmtCompact(totPro)} net in period` },
    free:    { key:"free", lbl:"True free cash", val:fmtCompact(free), title:fmt(free), col: free >= 0 ? C.gold : C.red,
      sub:"After tax and safety reserves" },
    runway:  { key:"runway", lbl:"Runway", val:runwayText, conf:runwayConfidence,
      col: cashFlowPositive || burnMonths >= 6 ? C.green : burnMonths >= 3 ? C.amber : runwayText === "---" ? C.inkDim : C.red,
      sub: cashFlowPositive ? "Revenue covers costs" : !runwayConfidence.shown ? "Add a cash balance to calculate" : burnMonths >= 6 ? "Above the 6-month threshold" : burnMonths >= 3 ? "Build toward 6 months" : "Below 3 months" },
    risk:    { key:"risk", lbl:"Risk score", val:risk.score.toFixed(0), unit:"/100",
      col: risk.label === "Low" ? C.green : risk.label === "Watch" ? C.gold : risk.label === "Elevated" ? C.amber : C.red,
      sub:`${risk.label}. Weighted from runway, margin and trend` },
    hiring:  { key:"hiring", lbl:"Hiring capacity", conf:hiringCapacityConfidence,
      val: !hiringCapacityConfidence.shown ? "---" : hiringCapacity > 0 ? fmtCompact(hiringCapacity) : "None",
      unit: hiringCapacityConfidence.shown && hiringCapacity > 0 ? "/mo" : null, title: fmt(hiringCapacity),
      col: hiringCapacity > 0 ? C.green : C.amber,
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
    ["Latest month revenue", fmt(latest.revenue)],
    ["Profit margin", pc(margin)],
    ["Net profit", fmt(totPro)],
    ["True free cash", fmt(free)],
    ["Runway", cashFlowPositive ? "No burn" : runwayConfidence.shown && burnMonths > 0 ? `${safe(burnMonths).toFixed(1)} months` : "Not enough data"],
    ["Break-even monthly revenue", breakEvenConfidence.shown && breakEven > 0 ? fmt(breakEven) : "Not enough data"],
    ["90-day revenue projection", proj90Confidence.shown && proj90 > 0 ? fmt(proj90) : "Not enough data"],
    ["Hiring capacity", hiringCapacityConfidence.shown ? (hiringCapacity > 0 ? `${fmt(hiringCapacity)}/month` : "None from profit") : "Not enough data"],
    ["Risk score", `${risk.score.toFixed(0)}/100 (${risk.label})`],
    ["Growth score", `${growth.score.toFixed(0)}/100 (${growth.label})`],
    ["Largest client share", concentrationData?.shown ? pc(concentrationData.largestPct) : "Not enough data"],
    ["Data confidence", capitalize(dataConfidence)],
    ["Reserve mode", mode === "safe" ? "Safe (30% tax, 20% safety)" : "Growth (25% tax, 10% safety)"],
  ];

  const ctx = {
    user, profile, plan, userName, onUpgrade, onBuyDiagnostic, onProfileChange, go, mode, setMode,
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
          <div className="logomark">C</div>
          <div className="app-brand-txt"><div className="wordmark">Command Ledger</div><div className="wordmark-sub">Financial Intelligence</div></div>
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
        {isThinData && <div className="data-thin-tag">Early data — trajectory not yet assessable</div>}
        <div className={`kpi-row${isThinData ? " data-thin" : ""}`}>
          <KpiTile t={hero} hero/>
          {supporting.map(t => <KpiTile key={t.key} t={t}/>)}
        </div>
        {showForwardRunway && (
          <div className="d-alert warn" style={{ marginTop:12 }}>
            {cashFlowPositive ? "No burn on average — but " : `${safe(burnMonths).toFixed(1)} months on average burn. `}
            {forwardRunway.monthsUntilCross.toFixed(1)} months against your known obligations (around {forwardRunway.crossDate}). The second is the real number.
          </div>
        )}
      </div>

      <div className="row row-21">
        <Panel title="Revenue vs expenses" action={<PanelLink to="financials" onNavigate={go}>Monthly detail</PanelLink>}>
          <BChart data={rows}/>
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
                  <li key={i}><span className="mini-date">{e.date}</span><span className="mini-main">{capitalize(e.label)}</span><span className="mini-amt">{fmt(e.amount)}</span></li>
                ))}
              </ul>
              <div className="mini-foot">{upcoming.length} payment{upcoming.length === 1 ? "" : "s"} due · {fmt(total90)} over 90 days</div>
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
                const barColor = i === 0 ? (p.pct > 60 ? C.red : p.pct > 40 ? C.amber : C.green) : C.gold;
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
            <div className="nudge-row-sub">Monthly 1:1 call, a written board report every month, and a direct advisory line. Or start with a one-time ${DIAGNOSTIC.usd.toLocaleString()} Financial Diagnostic, credited to your first Advisory month.</div>
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
    txQuery, setTxQuery, txDirection, setTxDirection, txLimit, setTxLimit, periodLabel, manual, go, m } = ctx;

  const filtered = useMemo(() => {
    let list = filterTransactions(txns, txQuery);
    if (txDirection === "in") list = list.filter(t => Number(t.amount) > 0);
    else if (txDirection === "out") list = list.filter(t => Number(t.amount) < 0);
    return list.slice().sort((a, b) => String(b.txn_date).localeCompare(String(a.txn_date)));
  }, [txns, txQuery, txDirection]);
  const totIn  = filtered.reduce((s, t) => s + Math.max(0, Number(t.amount) || 0), 0);
  const totOut = filtered.reduce((s, t) => s + Math.max(0, -(Number(t.amount) || 0)), 0);
  const shown = filtered.slice(0, txLimit);

  const manualFields = [
    { lbl:"Monthly revenue ($)",           v:manual.mRev,   s:manual.setMRev },
    { lbl:"Monthly expenses ($)",          v:manual.mExp,   s:manual.setMExp },
    { lbl:"Cash balance ($)",              v:manual.mCash,  s:manual.setMCash },
    { lbl:"Customer acquisition cost ($)", v:manual.mCac,   s:manual.setMCac },
    { lbl:"Customer lifetime value ($)",   v:manual.mLtv,   s:manual.setMLtv },
    { lbl:"Leads this month",              v:manual.mLeads, s:manual.setMLeads },
    { lbl:"Deals closed",                  v:manual.mClose, s:manual.setMClose },
  ];

  return (
    <>
      <PageHead title="Transactions" meta={history.length > 0 ? `${txns.length.toLocaleString()} transactions · ${periodLabel}` : "No uploaded history yet"}/>

      <div className="row row-21">
        <Panel title="Upload a file or sync a sheet">
          <DataUpload hasData={m.hasData} onDataLoaded={handleDataLoaded}/>
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
                      {new Date(b.uploaded_at).toLocaleDateString()} · {b.period_start} to {b.period_end} · {b.inserted_count ?? "—"} added, {b.duplicate_count ?? "—"} duplicate
                    </div>
                  </div>
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
            {filtered.length.toLocaleString()} shown · <span style={{ color:C.green }}>{fmt(totIn)} in</span> · <span>{fmt(totOut)} out</span>
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
                      <td>{t.description || "—"}</td>
                      <td className="muted">{t.category ? capitalize(t.category) : "—"}</td>
                      <td className="num" style={{ color: Number(t.amount) >= 0 ? C.green : C.cream }}>{fmt(t.amount)}</td>
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
                      <td className="num">{fmt(r.revenue)}</td>
                      <td className="num">{fmt(r.expenses)}</td>
                      <td className="num" style={{ color: net >= 0 ? C.green : C.red }}>{fmt(net)}</td>
                      <td className="num muted">{r.revenue > 0 ? pc((net / r.revenue) * 100) : "---"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr>
                <th scope="row">Total</th><td className="num">{fmt(totals.rev)}</td><td className="num">{fmt(totals.exp)}</td>
                <td className="num" style={{ color: totals.rev - totals.exp >= 0 ? C.green : C.red }}>{fmt(totals.rev - totals.exp)}</td>
                <td className="num muted">{totals.rev > 0 ? pc(((totals.rev - totals.exp) / totals.rev) * 100) : "---"}</td>
              </tr></tfoot>
            </table>
          </div>
        </Panel>

        <Panel title="Capital allocator">
          {[
            { name:"Tax vault",      pct:tr * 100, amt:taxV, col:C.red },
            { name:"Safety buffer",  pct:sr * 100, amt:safV, col:C.blue },
            { name:"True free cash", pct:totPro > 0 ? Math.max(0, (free / totPro) * 100) : 0, amt:free, col:free >= 0 ? C.gold : C.red },
          ].map((a, i) => (
            <div className="alloc-row" key={i}>
              <div className="alloc-meta">
                <div className="alloc-name">{a.name}</div>
                <div className="alloc-pct">{safe(a.pct).toFixed(0)}% of profit</div>
                <div className="alloc-track"><div className="alloc-fill" style={{ width:`${Math.min(100, safe(a.pct))}%`, background:a.col }}/></div>
              </div>
              <div className="alloc-amt" style={{ color:a.col }}>{fmt(a.amt)}</div>
            </div>
          ))}
          <p className="panel-copy" style={{ marginTop:10 }}>
            {totPro > 0 ? `${mode === "safe" ? "Safe" : "Growth"} mode reserves are taken from ${fmt(totPro)} net profit in the period.` : "A loss in the period: nothing is reserved, and free cash is the full loss."}
          </p>
        </Panel>
      </div>

      <div className="row row-3">
        <Panel title="Break-even">
          <div className="big-num">{breakEvenConfidence.shown && breakEven > 0 ? fmt(breakEven) : "---"}</div>
          <p className="panel-copy">
            {breakEvenConfidence.shown && latest.revenue > 0 && breakEven > 0
              ? latest.revenue >= breakEven ? `Monthly revenue needed to cover average costs. You are ${fmt(latest.revenue - breakEven)} above it.` : `Monthly revenue needed to cover average costs. You are ${fmt(breakEven - latest.revenue)} below it.`
              : "Enter revenue and expenses to calculate."}
          </p>
          <ConfidenceLine c={breakEvenConfidence}/>
        </Panel>

        <Panel title="Unit economics">
          <dl className="kv">
            <dt>LTV : CAC</dt><dd>{ltvcacConfidence.shown ? `${safe(ltvcac).toFixed(1)}x` : "---"}</dd>
            <dt>Acquisition cost</dt><dd>{activeCac > 0 ? fmt(activeCac) : "---"}</dd>
            <dt>Lifetime value</dt><dd>{activeLtv > 0 ? fmt(activeLtv) : "---"}</dd>
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
              <div className="traj-lbl" style={{ color: sov >= 75 ? C.gold : sov >= 50 ? C.amber : C.red }}>{sovLbl}</div>
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
                const barColor = i === 0 ? (p.pct > 60 ? C.red : p.pct > 40 ? C.amber : C.green) : C.gold;
                return (
                  <div key={p.name}>
                    <div className="bar-row-lbl"><span style={{ textTransform:"capitalize" }}>{p.name}</span><span style={{ color:barColor }}>{p.pct.toFixed(1)}%</span></div>
                    <div className="bar-track"><div style={{ width:`${Math.min(100, p.pct)}%`, background:barColor }}/></div>
                  </div>
                );
              })}
              <ConfidenceLine c={{ shown:true, level:concentrationData.confidenceLevel, reason:concentrationData.reason }}/>
              {concentrationData.aggregatorPct > 0.5 && (
                <p className="panel-copy">{concentrationData.aggregatorPct.toFixed(0)}% of revenue arrives through a payment processor (Shopify, Stripe, PayPal) and can't be attributed to a single client — excluded above.</p>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Business history">
          {founderNarrative ? (
            <>
              <p className="narrative">{founderNarrative}</p>
              {seasonalPattern && (
                <p className="panel-copy">{seasonalPattern.month} has run {Math.abs(seasonalPattern.avgDeltaPct).toFixed(0)}% {seasonalPattern.avgDeltaPct < 0 ? "below" : "above"} your average for {seasonalPattern.occurrences} years running — a repeating seasonal pattern, not a new signal.</p>
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
            <div style={{ display:"flex", alignItems:"center", gap:12, color:C.inkDim, fontSize:12, fontFamily:"'JetBrains Mono',monospace", padding:"20px" }}>
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
      <p className="panel-copy">Sent to Claude (Anthropic) only when you click Generate Brief: your computed metrics, the names of your largest payers and recurring costs, and any notes you left on past directives — never your transaction list.</p>
    </>
  );
}

// ─── SECTION: REPORTS ─────────────────────────────────────────
// A monthly summary the founder can hand to an accountant, investor or
// board: the same profit-and-loss table and metrics shown in the app,
// downloadable as CSV or printed to PDF from the browser.
function ReportsSection({ ctx }) {
  const { m, rows, reportSummary, periodLabel, todayStr, profile, userName, plan, statusLine, go } = ctx;
  if (!m.hasData) return <><PageHead title="Reports" meta={statusLine}/><EmptyData go={go}/></>;

  const monthly = rows || [];
  const totals = monthly.reduce((a, r) => ({ rev:a.rev + (r.revenue || 0), exp:a.exp + (r.expenses || 0) }), { rev:0, exp:0 });
  const downloadCsv = () => {
    const csv = buildReportCsv({ periodLabel, generatedAt: todayStr, rows: monthly, summary: reportSummary });
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
            <div className="page-meta">{profile?.business || userName} · {periodLabel} · generated {todayStr}</div>
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
                    return <tr key={i}><td>{r.month}</td><td className="num">{fmt(r.revenue)}</td><td className="num">{fmt(r.expenses)}</td><td className="num">{fmt(net)}</td><td className="num">{r.revenue > 0 ? pc((net / r.revenue) * 100) : "---"}</td></tr>;
                  })}
                </tbody>
                <tfoot><tr><th scope="row">Total</th><td className="num">{fmt(totals.rev)}</td><td className="num">{fmt(totals.exp)}</td><td className="num">{fmt(totals.rev - totals.exp)}</td><td className="num">{totals.rev > 0 ? pc(((totals.rev - totals.exp) / totals.rev) * 100) : "---"}</td></tr></tfoot>
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
  const { currentDirective, directives, directivesLoading, latestDirective, needsAcknowledgement, ackNote, setAckNote, acknowledgeDirective } = ctx;
  return (
    <>
      <PageHead title="Decision Log" meta="Every directive issued, what you did, and what happened next"/>
      {currentDirective && <DirectiveStrip d={currentDirective}/>}

      {needsAcknowledgement && (
        <Panel title="Did you act on this?" style={{ borderLeft:`3px solid ${C.gold}` }}>
          <p className="narrative" style={{ marginBottom:12 }}>
            Last directive ({new Date(latestDirective.issued_at).toLocaleDateString()}): "{latestDirective.directive_text}"
          </p>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
            {[["acted","Acted"],["partially","Partially"],["ignored","Ignored"],["disagreed","I disagreed"]].map(([val, lbl]) => (
              <button key={val} className="btn btn-primary btn-md" onClick={() => acknowledgeDirective(latestDirective.id, val)}>{lbl}</button>
            ))}
          </div>
          <label className="sr-only" htmlFor="ack-note">Note</label>
          <textarea id="ack-note" className="di" placeholder="Optional note — why you did (or didn't) act..."
            value={ackNote} onChange={e => setAckNote(e.target.value)}
            style={{ minHeight:56, resize:"vertical", fontFamily:"'Cormorant Garamond',serif", fontSize:14 }}/>
        </Panel>
      )}

      <Panel title="History">
        {directivesLoading ? (
          <div className="busy-line"><span className="spinner"/>Loading decision history...</div>
        ) : directives.length === 0 ? (
          <p className="panel-copy">No directives issued yet. Once Command Ledger issues its first call, it's logged here permanently — with whether you acted on it and what happened to the metric it targeted.</p>
        ) : (
          <ul className="log-list">
            {directives.map(d => {
              const uc = { critical:C.red, warn:C.amber, go:C.green, stable:C.gold }[d.severity] || C.gold;
              const outcome = describeDirectiveOutcome(d);
              const actionLabel = { acted:"Acted", partially:"Partially acted", ignored:"Ignored", disagreed:"Disagreed" }[d.action_taken] || "Awaiting response";
              const outcomeColor = outcome.status === "measured"
                ? (outcome.improved === true ? C.green : outcome.improved === false ? C.red : C.ink)
                : C.inkDim;
              return (
                <li key={d.id} style={{ borderLeftColor:uc }}>
                  <div className="log-top">
                    <span className="log-text">{d.directive_text}</span>
                    <span className="mini-date">{new Date(d.issued_at).toLocaleDateString()}</span>
                  </div>
                  <div className="log-meta">{actionLabel}{d.founder_note ? ` — "${d.founder_note}"` : ""}</div>
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
          <div className="big-num">{proj90Confidence.shown && safe(proj90) > 0 ? fmt(proj90) : "---"}</div>
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
                    <div className="mini-amt">{fmt(o.typical_amount)}</div>
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
                  <span className="bar-track week-bar"><span style={{ width:`${(w.total / maxWeek) * 100}%`, background: w.total > 0 ? C.gold : "transparent" }}/></span>
                  <span className="mini-amt">{w.total > 0 ? fmt(w.total) : "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="row row-12">
        <Panel title="Can I afford it?">
          <label className="di-lbl" htmlFor="afford-input">A hire, or any recurring cost, per month ($)</label>
          <div style={{ display:"flex", gap:8 }}>
            <input id="afford-input" type="number" min="0" className="di" placeholder={hiringCapacity > 0 ? `e.g. ${Math.round(hiringCapacity)}` : "e.g. 1500"}
              value={affordInput} onChange={e => { setAffordInput(e.target.value); setAffordAmount(null); }} onKeyDown={e => e.key === "Enter" && checkAfford()}/>
            <button className="btn btn-primary btn-md" onClick={checkAfford}>Check</button>
          </div>
          {affordResult && <div className={`d-alert ${affordResult.affordable ? "ok" : "crit"}`} style={{ marginTop:12 }}>{affordResult.message}</div>}
          <p className="panel-copy" style={{ marginTop:10 }}>Tested over 12 months against your cash and recurring bills on their real dates.{hiringCapacity > 0 ? ` Your average profit alone covers up to ${fmt(hiringCapacity)}/month.` : ""}</p>
        </Panel>

        <Panel title="Scenario planning" action={(scRevPct !== 0 || scExpPct !== 0 || scHire !== 0 || scCash !== 0)
          ? <button className="panel-link" onClick={() => { setScRevPct(0); setScExpPct(0); setScHire(0); setScCash(0); }}>Reset</button> : null}>
          <div className="input-grid input-grid-4">
            {[
              { id:"sc-rev",  lbl:"Revenue change (%)",         v:scRevPct, s:setScRevPct },
              { id:"sc-exp",  lbl:"Expense change (%)",         v:scExpPct, s:setScExpPct },
              { id:"sc-hire", lbl:"New hire, monthly cost ($)", v:scHire,   s:setScHire, min:0 },
              { id:"sc-cash", lbl:"One-time cash change ($)",   v:scCash,   s:setScCash },
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
              { lbl:"True free cash", before:fmt(scenario.before.free), after:fmt(scenario.after.free), better: scenario.after.free >= scenario.before.free },
              { lbl:"Cash position", before:scenarioRunway(scenario.before), after:scenarioRunway(scenario.after),
                better: scenario.after.cashFlowPositive || scenario.after.burnMonths >= scenario.before.burnMonths },
              { lbl:"Risk score", before:`${scenario.before.risk.score.toFixed(0)} - ${scenario.before.risk.label}`, after:`${scenario.after.risk.score.toFixed(0)} - ${scenario.after.risk.label}`, better: scenario.after.risk.score <= scenario.before.risk.score },
            ].map((row, i) => (
              <div key={i} className="scenario-cell">
                <div className="card-lbl">{row.lbl}</div>
                <div className="scenario-before">{row.before}</div>
                <div className="scenario-after" style={{ color: row.better ? C.green : C.red }}>→ {row.after}</div>
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
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const dirty = name.trim() !== (profile?.name || "") || business.trim() !== (profile?.business || "");

  const save = async e => {
    e.preventDefault();
    setSaving(true); setMsg(null);
    // plan, status and paypal_subscription_id are never sent: the database
    // guard would discard them anyway, and only the PayPal webhook sets them.
    const { data, error } = await supabase.from("profiles")
      .update({ name: name.trim() || null, business: business.trim() || null, updated_at: new Date().toISOString() })
      .eq("id", user.id).select().single();
    setSaving(false);
    if (error) { console.error("Profile update failed:", error); setMsg({ t:"crit", text:"Your profile could not be saved. Nothing was changed — try again." }); return; }
    onProfileChange(data);
    setMsg({ t:"ok", text:"Saved." });
  };

  const statusText = { active:"Active", suspended:"Suspended — a payment failed; PayPal will retry", canceled:"Cancelled", expired:"Expired" }[profile?.status] || "Active";

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
              <label className="di-lbl" htmlFor="set-email">Email</label>
              <input id="set-email" className="di" value={user?.email || ""} readOnly aria-readonly="true"/>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <button className="btn btn-primary btn-md" type="submit" disabled={saving || !dirty}>{saving ? "Saving..." : "Save changes"}</button>
              {msg && <span role="status" style={{ fontSize:12.5, color: msg.t === "ok" ? C.green : C.red }}>{msg.text}</span>}
            </div>
          </form>
        </Panel>

        <Panel title="Plan and billing">
          <dl className="kv">
            <dt>Plan</dt><dd>{PLANS[plan].name}</dd>
            <dt>Price</dt><dd>${PLANS[plan].usd.toLocaleString()} {PLANS[plan].period}</dd>
            <dt>Status</dt><dd>{statusText}</dd>
          </dl>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:14 }}>
            {plan === "software" && <button className="btn btn-primary btn-md" onClick={onUpgrade}>Add Command Advisory</button>}
            <a className="btn btn-outline btn-md" href="https://www.paypal.com/myaccount/autopay/" target="_blank" rel="noopener noreferrer">Manage or cancel in PayPal</a>
          </div>
          <p className="panel-copy" style={{ marginTop:12 }}>
            Subscriptions are billed and cancelled through PayPal. Upgrading cancels your current subscription automatically once the new one is active.
            {plan === "software" && " Annual billing ($990/year) is arranged by email."}
          </p>
          <button className="panel-link" style={{ marginTop:8 }} onClick={onBuyDiagnostic}>Buy a one-time ${DIAGNOSTIC.usd.toLocaleString()} Financial Diagnostic<Icon name="arrow" size={14}/></button>
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
        </Panel>
      </div>
    </>
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
          <div className="logomark">C</div>
          <div className="wordmark" style={{ fontSize:16 }}>Command Ledger</div>
        </div>
        <div className="auth-h">
          <h2 className="auth-title">{mode === "login" ? "Sign In" : "Create Account"}</h2>
          <p className="auth-sub">Access your financial command center.</p>
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
          <div className="a-div"><div className="a-div-line"/><span style={{ fontSize:10, color:C.inkDim, textTransform:"uppercase", letterSpacing:"0.1em" }}>or</span><div className="a-div-line"/></div>
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

// ─── FAQ ACCORDION ────────────────────────────────────────────
function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="faq-item"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      style={{
        borderBottom: `1px solid ${C.border}`,
        padding: "22px 0",
        cursor: "pointer",
      }}
      onClick={() => setOpen(o => !o)}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(o => !o); } }}
    >
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
      }}>
        <div style={{
          fontFamily: "'Syne', sans-serif",
          fontSize: 14,
          fontWeight: 600,
          color: open ? C.gold : C.cream,
          transition: "color 0.2s",
          lineHeight: 1.4,
        }}>{q}</div>
        <div style={{
          fontSize: 20,
          color: C.gold,
          flexShrink: 0,
          transition: "transform 0.2s",
          transform: open ? "rotate(45deg)" : "rotate(0deg)",
          fontFamily: "'JetBrains Mono', monospace",
          lineHeight: 1,
        }}>+</div>
      </div>
      {open && (
        <div style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 15,
          color: C.ink,
          lineHeight: 1.85,
          marginTop: 14,
          paddingRight: 32,
          animation: "fadeUp 0.2s ease",
        }}>{a}</div>
      )}
    </div>
  );
}

// ─── HERO LIVE PREVIEW ──────────────────────────────────────────
// A real, working instance of the actual parsing and calculation engine —
// not a mockup. A visitor can drop their own bank/QuickBooks CSV here,
// unauthenticated, and see figures computed from it before ever signing up.
// Nothing here is hardcoded: every number comes from computeMetrics() run
// against real rows, the same pure function the logged-in dashboard uses.
// "Try an example" loads a clearly-labeled synthetic CSV through that same
// pipeline — the numbers shown are still genuinely computed, never typed in.
const EXAMPLE_CSV = `Date,Description,Amount
2026-04-03,Client invoice - Acme Retainer,18500
2026-04-08,AWS hosting,-1240
2026-04-12,Payroll run,-14200
2026-04-18,Client invoice - Bolt Project,9600
2026-04-22,Facebook Ads,-4100
2026-05-02,Client invoice - Acme Retainer,18500
2026-05-09,AWS hosting,-1310
2026-05-12,Payroll run,-14200
2026-05-20,Client invoice - Bolt Project,7200
2026-05-24,Facebook Ads,-5400
2026-06-01,Client invoice - Acme Retainer,18500
2026-06-10,AWS hosting,-1290
2026-06-12,Payroll run,-15600
2026-06-19,Client invoice - Bolt Project,6100
2026-06-25,Facebook Ads,-6800`;

function HeroPreview() {
  const [rows, setRows] = useState(null);
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");

  const load = (text, name) => {
    const result = parseAnyCSV(text);
    if (!result || result.rows.length === 0) { setErr("Couldn't find revenue or expense data in that file."); return; }
    setErr(""); setRows(result.rows); setLabel(name);
  };

  const handleFile = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) { setErr("Drop a .csv file — try a bank or QuickBooks export."); return; }
    try { load(await file.text(), file.name); }
    catch { setErr("Couldn't read that file."); }
  };

  const m = rows ? computeMetrics(rows, { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 }, "safe") : null;

  return (
    <div className="hero-preview">
      <div className="hero-preview-bar">
        <span/><span/><span/>
        <div className="hero-preview-title">{rows ? label : "command-ledger.co — Command Center"}</div>
        {rows && <div className="hero-preview-live">Live</div>}
      </div>
      <div className="hero-preview-body">
        {!rows ? (
          <div className="hero-preview-empty" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}>
            <input type="file" id="hero-file" accept=".csv" style={{ display:"none" }} onChange={e => handleFile(e.target.files[0])}/>
            <label htmlFor="hero-file" className="hero-preview-cta"><b>Drop your own bank CSV here</b><br/>See your real numbers, live — nothing is uploaded, this runs entirely in your browser.</label>
            <div className="hero-preview-or">or</div>
            <button className="hero-preview-try" onClick={() => load(EXAMPLE_CSV, "Example — Acme Consulting (illustrative)")}>Try an Example</button>
            {err && <div className="hero-preview-err">{err}</div>}
          </div>
        ) : (
          <>
            <div className="hero-preview-kpis">
              <div className="hpk"><div className="hpk-lbl">Monthly Revenue</div><div className="hpk-val">{fmt(m.latest.revenue)}</div></div>
              <div className="hpk"><div className="hpk-lbl">Profit Margin</div><div className="hpk-val">{pc(m.margin)}</div></div>
              <div className="hpk"><div className="hpk-lbl">Runway</div><div className="hpk-val">{m.cashFlowPositive ? "No burn" : `${safe(m.burnMonths).toFixed(1)}mo`}</div></div>
              <div className="hpk"><div className="hpk-lbl">Risk Score</div><div className="hpk-val" style={{ color: m.risk.label==="Low"?C.green:m.risk.label==="Watch"?C.amber:C.red }}>{m.risk.score.toFixed(0)} · {m.risk.label}</div></div>
            </div>
            <div className="hero-preview-note">
              {label.startsWith("Example") ? "Illustrative example data — not a real customer." : "Computed from your file, in this browser tab only."}
              {" "}<span className="hero-preview-reset" {...clickableProps(() => { setRows(null); setLabel(""); })}>Try another file</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── MARKETING SITE ───────────────────────────────────────────
function MarketingSite({ onLogin, onPlanSelect, onTerms, onPrivacy }) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", h);
    return () => window.removeEventListener("scroll", h);
  }, []);

  useEffect(() => {
    const els = document.querySelectorAll(".reveal");
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);

  const features = [
    { num:"01", title:"AI Strategic Advisor",   desc:"Not a paragraph — a structured brief: what happened, why, the business impact, the risk level, the one action to take, and how confident to be in it. Built from your real numbers." },
    { num:"02", title:"Risk Score",             desc:"A single number weighted from your actual runway, margin, trend direction, revenue concentration, and unit economics — each only counts when there's real data behind it, so it never fakes a warning." },
    { num:"03", title:"Growth Score",           desc:"Rewards a steady, consistent growth trend over one lucky month. Three good months in a row score higher than one great month between two bad ones, at the same average rate." },
    { num:"04", title:"Burn Runway Monitor",    desc:"Real net burn — expenses against revenue, not expenses alone — so a profitable month never gets mistaken for a business about to run out of cash." },
    { num:"05", title:"True Free Cash",         desc:"After tax obligations and safety buffer, what you actually own and can deploy. Most founders confuse revenue with available cash. This ends that confusion." },
    { num:"06", title:"Break-Even Calculator",  desc:"The exact monthly revenue you need to cover all costs. Know whether you are above or below the line before the month ends." },
  ];

  return (
    <>
      <nav className={`nav${scrolled?" scrolled":""}`}>
        <div className="nav-logo" {...clickableProps(() => window.scrollTo(0, 0), { label:"Back to top" })}>
          <div className="logomark">C</div>
          <div><div className="wordmark">Command Ledger</div><div className="wordmark-sub">Financial Intelligence</div></div>
        </div>
        <ul className="nav-links">
          <li><a href="#features">Product</a></li>
          <li><a href="#trust">Why Command Ledger</a></li>
          <li><a href="#pricing">Pricing</a></li>
        </ul>
        <div className="nav-cta">
          <button
            className={`nav-burger${menuOpen ? " open" : ""}`}
            onClick={() => setMenuOpen(o => !o)}
            aria-label="Toggle navigation menu"
            aria-expanded={menuOpen}
          ><span/><span/><span/></button>
          <button className="btn btn-ghost" onClick={onLogin}>Sign In</button>
          <button className="btn btn-gold" onClick={() => onPlanSelect("software")}>Get Started</button>
        </div>
      </nav>
      {menuOpen && (
        <div className="nav-mobile">
          <a href="#features" onClick={() => setMenuOpen(false)}>Product</a>
          <a href="#trust" onClick={() => setMenuOpen(false)}>Why Command Ledger</a>
          <a href="#pricing" onClick={() => setMenuOpen(false)}>Pricing</a>
        </div>
      )}

      <section className="hero">
        <div className="hero-bg"/><div className="hero-grid"/>
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-dot"/>For Founders Past $50K/Month Who've Outgrown a Spreadsheet</div>
          <h1 className="hero-title">You are making money.<br/>You still don't know if you're safe.<br/><em>Here's exactly why.</em></h1>
          <p className="hero-sub">Real-time financial intelligence: upload one bank or QuickBooks export and see your real runway, your true margin, your Risk Score, and the one move to make this week — computed from your actual transactions. Try it on this page first: the preview runs entirely in your browser and uploads nothing.</p>
          <div className="hero-cta">
            <button className="btn btn-lg btn-primary" onClick={() => onPlanSelect("software")}>Get Started</button>
            <button className="btn btn-lg btn-outline" onClick={onLogin}>Sign In</button>
          </div>
          <div className="hero-proof">
            <span>Preview runs in your browser</span><span className="hero-proof-sep">·</span>
            <span>Your data, visible to your login only</span><span className="hero-proof-sep">·</span>
            <span>Real transactions, not guesses</span>
          </div>
        </div>
        <HeroPreview/>
        <div className="hero-scroll"><div className="scroll-line"/>Scroll</div>
      </section>

      <div className="stats-bar reveal">
        <div className="stat"><div className="stat-n">6</div><div className="stat-l">Live Financial Signals</div></div>
        <div className="stat"><div className="stat-n">1</div><div className="stat-l">Login That Can See Your Data</div></div>
        <div className="stat"><div className="stat-n">1</div><div className="stat-l">CSV To See Your Real Numbers</div></div>
      </div>

      <section className="sec" id="trust" style={{ paddingTop:64, paddingBottom:64 }}>
        <div className="sec-eye">Trust</div>
        <h2 className="sec-title" style={{ fontSize:"clamp(28px,3.6vw,40px)" }}>Only claims we can<br/><em>actually stand behind</em></h2>
        <div className="feat-grid" style={{ marginTop:48 }}>
          {[
            { num:"01", title:"Data Processing", desc:"The preview above parses your file in your browser and uploads nothing. In your account, the transactions you upload are saved to your private history so trends, obligations and outcomes can be tracked month to month; the file itself is not kept, and deleting an upload deletes every transaction it added. An AI brief, only when you request one, sends Claude (Anthropic) your computed metrics, the names of your largest payers and recurring costs, and any notes you left on past directives, never your transaction list." },
            { num:"02", title:"Access Control", desc:"Your account is protected by Postgres row-level security, scoped to your own login — verified directly against the live database, not asserted in a policy document. Only the payment webhook, using a separate privileged key, can change your subscription status." },
            { num:"03", title:"Financial Transparency", desc:"Every metric — margin, runway, Risk Score, Growth Score — is derived from a published, testable formula, not a black-box model. Runway uses net burn, not gross expenses; scores only count a signal when there's real data behind it." },
          ].map((t, i) => (
            <div className="feat-card reveal" key={i} style={{ transitionDelay:`${i*70}ms` }}>
              <div className="feat-num">// {t.num}</div>
              <h3 className="feat-title">{t.title}</h3>
              <p className="feat-desc">{t.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="sec sec-center" style={{ padding:"48px 48px", borderTop:`1px solid ${C.border}`, borderBottom:`1px solid ${C.border}` }}>
        <div className="sec-eye" style={{ marginBottom:8 }}>Who It's For</div>
        <h2 className="sec-title" style={{ fontSize:"clamp(24px,3vw,32px)", marginBottom:24 }}>Built for founders who need<br/><em>financial clarity</em></h2>
        <div style={{ display:"flex", gap:12, flexWrap:"wrap", justifyContent:"center" }}>
          {["Agencies","SaaS","Consulting","Professional Services","E-commerce"].map((tag, i) => (
            <div key={i} className="reveal" style={{ transitionDelay:`${i*50}ms`, border:`1px solid ${C.border}`, padding:"10px 20px", fontSize:12, letterSpacing:"0.08em", textTransform:"uppercase", color:C.ink, fontFamily:"'JetBrains Mono',monospace" }}>{tag}</div>
          ))}
        </div>
      </div>

      <section className="sec" id="features">
        <div className="sec-eye">The System</div>
        <h2 className="sec-title">Built for founders who are<br/><em>stuck despite the revenue</em></h2>
        <p className="sec-body">Agencies, e-commerce, and SaaS businesses all face the same problem: revenue grows but financial clarity doesn't. Command Ledger is the system that fixes that.</p>
        <div className="feat-grid">
          {features.map((f, i) => (
            <div
              className="feat-card reveal"
              key={i}
              style={{ transitionDelay:`${i*70}ms`, gridColumn: i===0 ? "span 2" : undefined }}
            >
              {i===0 && <div className="feat-tag">Core Engine</div>}
              <div className="feat-num">// {f.num}</div>
              <h3 className="feat-title">{f.title}</h3>
              <p className="feat-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="sec sec-center" id="mechanism" style={{ borderTop:`1px solid ${C.border}` }}>
        <div style={{ maxWidth:820, margin:"0 auto" }}>
          <div className="sec-eye">The Excel Test</div>
          <h2 className="sec-title">A spreadsheet shows numbers.<br/><em>This is what it means.</em></h2>
          <p className="sec-body" style={{ marginBottom:48 }}>Excel and QuickBooks store your data. Your accountant makes sure you're compliant. Neither tells you what changed and what to do about it. Here's the same numbers, both ways:</p>

          <div className="excel-grid reveal">
            <div style={{ background:C.surface, padding:"28px 32px" }}>
              <div style={{ fontSize:10, letterSpacing:"0.14em", textTransform:"uppercase", color:C.inkDim, fontWeight:600, marginBottom:16 }}>Raw Financial Data</div>
              <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:13, color:C.ink, lineHeight:2.1 }}>
                Revenue: R480,000<br/>Expenses: R390,000<br/>Profit: R90,000
              </div>
            </div>
            <div className="excel-arrow">→</div>
            <div style={{ background:C.surfaceHigh, padding:"28px 32px", borderLeft:`1px solid ${C.gold}` }}>
              <div style={{ fontSize:10, letterSpacing:"0.14em", textTransform:"uppercase", color:C.gold, fontWeight:600, marginBottom:16 }}>Command Ledger Interpretation</div>
              <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:14.5, color:C.ink, lineHeight:1.8 }}>
                Revenue increased 14%. But marketing spend increased 31%, and net margin fell from 22% to 18.8%. Cash conversion weakened.
                <br/><br/>
                <b style={{ color:C.cream }}>Recommended action:</b> reduce underperforming acquisition spend before increasing budget further.
                <br/><br/>
                <span style={{ color:C.inkDim, fontSize:13 }}>Why: the company is growing, but growth efficiency is deteriorating.</span>
              </div>
            </div>
          </div>

          <div className="sec-eye">How It Works</div>
          <h2 className="sec-title">Questions founders<br/><em>always ask</em></h2>

          <div className="reveal" style={{ display:"flex", flexDirection:"column", gap:2, marginTop:40, textAlign:"left" }}>
            {[
              {
                q: "How does the AI advisor work?",
                a: "You upload your financial file. Command Ledger reads every transaction, calculates your real margin, burn runway, true free cash, and unit economics. That data is sent to Claude — built by Anthropic — which returns a structured brief: what happened, why, the business impact, the risk level, one recommended action, and how confident to be in it. Not generic advice. Your numbers. Your directive.",
              },
              {
                q: "What file formats does it accept?",
                a: "Bank statements, QuickBooks exports, Xero exports, Wave exports, and any CSV or Excel file. The system automatically detects your column structure — whether you have named columns like Revenue and Expenses, or a raw bank statement with positive and negative amounts. It reads all of them.",
              },
              {
                q: "How much runway do I actually have?",
                a: "Cash on hand, adjusted for your safety buffer, divided by your net burn — expenses minus revenue, not expenses alone. A profitable month never gets counted as burn just because costs are high; only actually spending more than you bring in counts against your runway.",
              },
              {
                q: "Why did my profit increase but my cash decrease?",
                a: "Profit and cash are not the same thing. Profit is revenue minus expenses on paper. Cash is what's actually sitting in your account — delayed client payments, prepaid expenses, and loan repayments all move cash without touching profit. This is exactly the gap True Free Cash is built to close: what you actually own and can deploy, after tax obligations and your safety buffer, not what your P&L says you made.",
              },
              {
                q: "Can I afford to hire another employee?",
                a: "Your dashboard shows Hiring Capacity: the largest fully-loaded monthly cost your own average profit covers, sized to your business rather than an assumed salary. To test a specific role, enter its monthly cost under Committed Costs to see whether it holds for 12 months against your cash and real dated bills, or add it in Scenario Planning to see margin, runway and Risk Score recompute.",
              },
              {
                q: "Why is my Risk Score increasing?",
                a: "The score is a weighted composite of five things: your runway, your margin, whether your trend is declining, how concentrated your revenue is in one client, and your LTV:CAC ratio — each one only counts when there's real data behind it. If it moved, one of those five moved; the dashboard shows which.",
              },
              {
                q: "Is my growth actually healthy?",
                a: "Growth Score weights a steady, consistent trend over one lucky month — three good months in a row score higher than one great month sandwiched between two down months, at the same average growth rate. A rising revenue line and a rising Growth Score are not always the same thing.",
              },
              {
                q: "What happens if revenue drops 20%?",
                a: "Open Scenario Planning and set the revenue adjustment to -20% — margin, runway, and Risk Score recompute instantly against that hypothetical, using your real current numbers as the baseline. Nothing is saved; it's there to let you stress-test a decision before it happens.",
              },
              {
                q: "Can I trust the AI recommendation?",
                a: "Trust the parts you can verify: the recommendation is required to reference your real numbers, its stated Risk Level is required to match the Risk Score already computed from your data (not an independent guess), and its confidence score is capped by how much real history backs it — a single manually-entered month never gets the same confidence as six months of uploaded transactions.",
              },
              {
                q: "Should I still have an accountant?",
                a: "Yes. Command Ledger is a decision-support system, not a replacement for professional accounting, tax, legal, or audit services. Your accountant handles compliance and historical reporting. Command Ledger handles the decisions you need to make today.",
              },
              {
                q: "What if my numbers are a mess?",
                a: "That is exactly when you need this most. Upload whatever you have — even one month of bank transactions. The system will find patterns in your numbers regardless of how clean or messy the source file is. Most founders are surprised by what it finds in data they thought was unremarkable.",
              },
            ].map((item, i) => (
              <FaqItem key={i} q={item.q} a={item.a}/>
            ))}
          </div>
        </div>
      </section>

      <section className="sec" id="pricing" style={{ background:C.surfaceHigh, borderTop:`1px solid ${C.border}`, borderBottom:`1px solid ${C.border}` }}>
        <div className="sec-eye">Pricing</div>
        <h2 className="sec-title">Two ways in.<br/><em>One system.</em></h2>
        <p className="sec-body">The system runs on its own. Advisory adds the person who reads it with you — six seats, because one person delivers it.</p>
        <div className="price-grid price-grid-two">
          {[
            { key:"software", hot:false },
            { key:"advisory", hot:true  },
          ].map((p, i) => {
            const pl = PLANS[p.key];
            return (
              <div key={p.key} className={`price-card reveal${p.hot?" hot":""}`} style={{ transitionDelay:`${i*70}ms` }}>
                <div className="price-tier">{pl.name}</div>
                <div className="price-tagline">{pl.tagline}</div>
                <div className="price-usd"><sup>$</sup>{pl.usd.toLocaleString()}</div>
                <div className="price-period">{pl.period}</div>
                {pl.annualUsd && (
                  <div className="price-note">Annual ${pl.annualUsd.toLocaleString()}, two months free — arranged by email</div>
                )}
                {pl.seats && (
                  <div className="price-note">{pl.seats} seats total</div>
                )}
                <div className="price-divider"/>
                <ul className="price-list">
                  {pl.features.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
                <button
                  className={`btn btn-full${p.hot?" btn-primary":" btn-outline"}`}
                  onClick={() => onPlanSelect(p.key)}
                >
                  {p.hot ? "Request a seat" : "Get Started"}
                </button>
              </div>
            );
          })}
        </div>
        <div className="price-diag reveal">
          <div>
            <div className="price-diag-name">{DIAGNOSTIC.name} — ${DIAGNOSTIC.usd.toLocaleString()} once</div>
            <div className="price-diag-body">{DIAGNOSTIC.tagline}</div>
            <div className="price-diag-note">{DIAGNOSTIC.note}</div>
          </div>
          <button
            className="btn btn-outline"
            style={{ whiteSpace:"nowrap" }}
            onClick={() => onPlanSelect("diagnostic")}
          >
            Buy the diagnostic
          </button>
        </div>
      </section>

      <section className="cta-sec reveal">
        <div style={{ position:"relative", zIndex:1 }}>
          <div className="sec-eye">The Decision</div>
          <h2 className="cta-title">Know your numbers.<br/>Understand your risks.<br/><em>Make the next decision with evidence.</em></h2>
          <p className="sec-body" style={{ marginTop:20, marginBottom:48 }}>
            The hire you could not afford. The ad spend with no data behind it. The month you ran without knowing your runway. Command Ledger exists so those decisions never happen again.
          </p>
          <button className="btn btn-lg btn-primary" onClick={() => onPlanSelect("software")}>Get Started</button>
          <div className="hero-proof" style={{ justifyContent:"center", marginTop:24 }}>
            <span>Preview runs in your browser</span><span className="hero-proof-sep">·</span>
            <span>Your data, visible to your login only</span><span className="hero-proof-sep">·</span>
            <span>No card required to try the live preview</span>
          </div>
        </div>
      </section>

      <footer className="footer">
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:32, marginBottom:32, textAlign:"left", maxWidth:480, margin:"0 auto 32px" }}>
          <div>
            <div style={{ fontSize:10, letterSpacing:"0.14em", textTransform:"uppercase", color:C.gold, fontWeight:600, marginBottom:12 }}>Product</div>
            <ul className="footer-links" style={{ flexDirection:"column", alignItems:"flex-start", gap:10 }}>
              <li><a href="#features">AI Advisor</a></li>
              <li><a href="#features">Risk &amp; Growth Score</a></li>
              <li><a href="#pricing">Pricing</a></li>
            </ul>
          </div>
          <div>
            <div style={{ fontSize:10, letterSpacing:"0.14em", textTransform:"uppercase", color:C.gold, fontWeight:600, marginBottom:12 }}>Trust</div>
            <ul className="footer-links" style={{ flexDirection:"column", alignItems:"flex-start", gap:10 }}>
              <li><a href="#trust">Data Processing &amp; Security</a></li>
              <li><a {...clickableProps(onPrivacy)}>Privacy Policy</a></li>
              <li><a {...clickableProps(onTerms)}>Terms of Service</a></li>
            </ul>
          </div>
        </div>
        <div className="footer-copy">2026 Command Ledger - DigiBlueprint Financial Intelligence</div>
        <ul className="footer-links">
          <li><a href="mailto:commandledger@gmail.com">Contact</a></li>
        </ul>
      </footer>
    </>
  );
}

// ─── LEGAL PAGES ─────────────────────────────────────────────
function TermsPage({ onBack }) {
  return (
    <div style={{ minHeight:"100vh" }}>
      <div className="page-wrap">
        <div className="page-back" {...clickableProps(onBack, { label:"Back to previous page" })}>Back</div>
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
      </div>
    </div>
  );
}

function PrivacyPage({ onBack }) {
  return (
    <div style={{ minHeight:"100vh" }}>
      <div className="page-wrap">
        <div className="page-back" {...clickableProps(onBack, { label:"Back to previous page" })}>Back</div>
        <h1 className="page-title">Privacy Policy</h1>
        <div className="page-date">Last updated: June 2026</div>
        <h2 className="page-h2">1. What We Collect</h2>
        <p className="page-p">Name, email, and authentication details on sign-in. Financial data you upload or connect. Usage data such as features accessed and session duration.</p>
        <h2 className="page-h2">2. How We Use It</h2>
        <p className="page-p">To provide the Service, process payments, deliver AI analysis, and send account updates. We do not sell your data.</p>
        <h2 className="page-h2">3. Security</h2>
        <p className="page-p">All data encrypted in transit via SSL. Transactions you upload to your account are stored in your private history with Supabase, readable only by your login, so your metrics can track change over time; the uploaded file itself is not kept. Deleting an upload from Upload History permanently deletes every transaction it added. The free preview on the home page runs in your browser and stores nothing. User accounts are stored securely via Supabase.</p>
        <h2 className="page-h2">4. Contact</h2>
        <p className="page-p">commandledger@gmail.com</p>
      </div>
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
          <div className="logomark">C</div>
          <div><div className="wordmark" style={{ fontSize:17 }}>Command Ledger</div><div className="wordmark-sub">Financial Intelligence</div></div>
        </div>
        <div className="auth-h">
          <h2 className="auth-title">Welcome, {userName}</h2>
          <p className="auth-sub">Your account is created. Choose a plan to activate your command center --- no dashboard access until a subscription is active.</p>
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
                  background:C.surfaceHigh,
                  border:`1px solid ${p.hot ? C.gold : C.border}`,
                  padding:"18px 20px",
                  display:"flex",
                  justifyContent:"space-between",
                  alignItems:"center",
                  gap:16,
                }}>
                  <div>
                    <div style={{ fontSize:10, letterSpacing:"0.16em", textTransform:"uppercase", color:C.gold, fontWeight:600, marginBottom:4 }}>{pl.name}</div>
                    <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, color:C.cream }}>
                      ${pl.usd.toLocaleString()} <span style={{ fontSize:12, color:C.inkDim }}>{pl.period}</span>
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
            background:C.surfaceHigh,
            border:`1px solid ${C.border}`,
            padding:"18px 20px",
            display:"flex",
            justifyContent:"space-between",
            alignItems:"center",
            gap:16,
          }}>
            <div>
              <div style={{ fontSize:10, letterSpacing:"0.16em", textTransform:"uppercase", color:C.gold, fontWeight:600, marginBottom:4 }}>{DIAGNOSTIC.name}</div>
              <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, color:C.cream }}>
                ${DIAGNOSTIC.usd.toLocaleString()} <span style={{ fontSize:12, color:C.inkDim }}>once, not a subscription</span>
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
      setAppState("dashboard");
    } catch (err) {
      console.error("Profile error:", err);
      // Fallback: still show the gate, never grant free access on error
      setUser(u);
      setProfile({ id:u.id, email:u.email, name:u.user_metadata?.full_name||u.email?.split("@")[0]||"Founder", plan:null });
      setAppState("dashboard");
    }
  }, []);

  // Workspace paths (/dashboard, /reports ...) belong to the signed-in app.
  // A signed-out visitor on one is shown the marketing site at "/".
  const showMarketing = useCallback(() => {
    if (isAppPath(window.location.pathname)) window.history.replaceState(null, "", "/");
    setAppState("marketing");
  }, []);

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
        <div className="loading-logo">C</div>
        <div className="loading-text">Command Ledger</div>
        <span className="spinner" style={{ width:20, height:20, borderTopColor:C.gold }}/>
      </div>
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      {activation && user && appState === "dashboard" && (
        <div className="activation-banner" role="status">
          {activation.status === "pending" ? (
            <><span className="spinner"/>Payment approved. Activating {PLANS[activation.planKey].name} — this usually takes under a minute. Do not pay again.</>
          ) : (
            <>
              <span>
                PayPal approved your payment, but activation is taking longer than usual. Do not subscribe again — you would be charged twice.
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
        <MarketingSite onLogin={() => setAppState("login")} onPlanSelect={handlePlanSelect} onTerms={() => setAppState("terms")} onPrivacy={() => setAppState("privacy")}/>
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
      {appState==="terms"   && <TermsPage   onBack={() => setAppState("marketing")}/>}
      {appState==="privacy" && <PrivacyPage onBack={() => setAppState("marketing")}/>}
    </>
  );
}

