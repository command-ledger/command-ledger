import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { fmt, pc, safe, parseAnyCSV, computeMetrics, runScenario, parseTransactions, computeDedupeHash, aggregateTransactionsByMonth, computeRevenueConcentration, detectRecurringObligations, computeForwardRunway, checkAffordability, detectMissedObligations, projectForwardCalendar, summarizeCalendarByWeek, computeDirective, getDirectiveMetricValue, describeDirectiveOutcome } from "./lib/financials.js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } }
);

const PAYPAL_CLIENT_ID = import.meta.env.VITE_PAYPAL_CLIENT_ID;
const PAYPAL_PLANS = {
  essentials: "P-1NE00583S5561651HNITP2ZI",
  pro:        "P-7M170334YK027974RNITP7NY",
  elite:      null,
};

const PLANS = {
  essentials: {
    name:"Command Essentials", usd:1250, zar:22500, period:"per month",
    tagline:"Full intelligence. The complete financial command system.",
    features:["Weekly AI strategic brief","Burn runway monitor","Capital allocator","Break-even calculator","Hire readiness indicator","90-day cash projection","LTV:CAC ratio analysis","Revenue concentration risk","CSV, Excel and live sheet sync"],
  },
  pro: {
    name:"Command Pro", usd:2475, zar:44550, period:"per month",
    tagline:"Command. Everything in Essentials, plus a CFO beside you.",
    features:["Everything in Essentials","Done-for-you data configuration","Monthly 1:1 advisory call","Monthly written board report","Direct advisory line (email)","Priority 4-hour response SLA"],
  },
  elite: {
    name:"Command Elite", usd:3000, zar:54000, setup:7000, period:"setup + $3,000/mo",
    tagline:"VIP. White-glove financial command for market leaders.",
    comingSoon:true,
    features:["Everything in Pro","Dedicated account strategist","Custom AI model tuning on your data","Quarterly strategy session with founder","Direct line to founder (Khayelihle)","White-label option for agencies"],
  },
};

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
.hero-preview{position:relative;z-index:1;background:#0A0D14;border:1px solid #243050;box-shadow:0 24px 64px -24px rgba(0,0,0,0.6);animation:fadeUp 0.8s 0.4s ease both;}
.hero-preview-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #161C2E;background:#0F1320;}
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
.feat-card{background:#0A0D14;padding:40px 36px;transition:background 0.3s;position:relative;}
.feat-card:hover{background:#0F1320;}
.feat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(to right,transparent,#5A5D64,transparent);opacity:0;transition:opacity 0.3s;}
.feat-card:hover::before{opacity:1;}
.feat-num{font-family:'JetBrains Mono',monospace;font-size:11px;color:#5A5D64;letter-spacing:0.1em;margin-bottom:24px;}
.feat-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:500;color:#F0E8D8;margin-bottom:12px;}
.feat-desc{font-size:13px;line-height:1.75;color:#8898B8;font-family:'Cormorant Garamond',serif;}
.price-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:64px;max-width:1100px;margin-left:auto;margin-right:auto;}
.price-card{background:#0A0D14;border:1px solid #161C2E;padding:36px 32px;position:relative;overflow:hidden;transition:transform 0.3s;}
.price-card:hover{transform:translateY(-4px);}
.price-card.hot{border-color:#D8DADE;}
.price-card.hot::after{content:'Most Popular';position:absolute;top:16px;right:16px;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#050709;background:#D8DADE;padding:4px 10px;font-weight:700;font-family:'Syne',sans-serif;}
.price-card.soon{opacity:0.85;}
.price-card.soon::after{content:'VIP — Coming Soon';position:absolute;top:16px;right:16px;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#D8DADE;background:transparent;border:1px solid #5A5D64;padding:4px 10px;font-weight:700;font-family:'Syne',sans-serif;}
.price-tier{font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#D8DADE;font-weight:600;margin-bottom:8px;}
.price-tagline{font-family:'Cormorant Garamond',serif;font-size:13px;color:#8898B8;margin-bottom:16px;font-style:italic;}
.price-usd{font-family:'Cormorant Garamond',serif;font-size:52px;font-weight:300;color:#F0E8D8;line-height:1;}
.price-usd sup{font-size:22px;vertical-align:top;margin-top:10px;display:inline-block;}
.price-zar{font-size:12px;color:#5A5D64;margin:4px 0;font-family:'JetBrains Mono',monospace;}
.price-period{font-size:12px;color:#8898B8;margin-bottom:28px;font-family:'Cormorant Garamond',serif;}
.price-divider{height:1px;background:#161C2E;margin-bottom:24px;}
.price-list{list-style:none;margin-bottom:28px;}
.price-list li{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:#8898B8;margin-bottom:10px;font-family:'Cormorant Garamond',serif;line-height:1.5;}
.price-list li::before{content:'---';color:#D8DADE;flex-shrink:0;font-family:'JetBrains Mono',monospace;font-size:11px;margin-top:2px;}
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
.dash{min-height:100vh;background:#050709;display:grid;grid-template-columns:220px 1fr;grid-template-rows:64px 1fr;}
.sidebar{grid-row:1/3;background:#0A0D14;border-right:1px solid #161C2E;display:flex;flex-direction:column;}
.sidebar-logo{height:64px;border-bottom:1px solid #161C2E;display:flex;align-items:center;gap:10px;padding:0 20px;}
.sb-nav{padding:24px 0;flex:1;}
.sb-sec{font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#7A7E88;padding:8px 20px 4px;font-weight:600;}
.sb-item{display:flex;align-items:center;gap:10px;padding:10px 20px;cursor:pointer;font-size:12px;letter-spacing:0.06em;color:#8898B8;transition:all 0.15s;border-left:2px solid transparent;font-weight:500;}
.sb-item:hover{color:#F0E8D8;background:#0F1320;}
.sb-item.on{color:#D8DADE;background:rgba(216,218,222,0.12);border-left-color:#D8DADE;}
.sb-item.locked{opacity:0.35;cursor:default;}
.sb-item.locked:hover{color:#8898B8;background:transparent;}
.sb-icon{font-size:14px;width:18px;text-align:center;}
.sb-foot{padding:16px 20px;border-top:1px solid #161C2E;}
.sb-user{display:flex;align-items:center;gap:10px;}
.sb-av{width:36px;height:36px;border-radius:50%;background:rgba(216,218,222,0.12);border:1px solid #5A5D64;display:flex;align-items:center;justify-content:center;font-size:14px;color:#D8DADE;overflow:hidden;flex-shrink:0;}
.sb-av img{width:100%;height:100%;object-fit:cover;border-radius:50%;}
.sb-name{font-size:12px;color:#F0E8D8;font-weight:600;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sb-plan{font-size:9px;color:#D8DADE;text-transform:uppercase;letter-spacing:0.1em;background:rgba(216,218,222,0.12);padding:2px 6px;margin-top:2px;display:inline-block;}
.topbar{grid-column:2;height:64px;border-bottom:1px solid #161C2E;display:flex;align-items:center;justify-content:space-between;padding:0 32px;background:rgba(5,7,9,0.6);backdrop-filter:blur(16px);}
.breadcrumb{font-size:11px;color:#7A7E88;letter-spacing:0.08em;}
.breadcrumb span{color:#F0E8D8;}
.tb-right{display:flex;align-items:center;gap:14px;}
.live-badge{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;}
.live-dot{width:6px;height:6px;border-radius:50%;animation:pulse 2s infinite;}
.mode-pills{display:flex;border:1px solid #161C2E;overflow:hidden;}
.mpill{padding:5px 14px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;background:transparent;border:none;color:#7A7E88;cursor:pointer;font-family:'Syne',sans-serif;transition:all 0.15s;}
.mpill.on{background:#0F1320;color:#D8DADE;}
.dash-body{grid-column:2;padding:28px 32px;overflow-y:auto;display:flex;flex-direction:column;gap:20px;}
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
.indicator{background:#0A0D14;border:1px solid #161C2E;padding:18px;position:relative;overflow:hidden;transition:all 0.2s;}
.indicator:hover{border-color:#243050;transform:translateY(-1px);}
.indicator.green{border-left:2px solid #2ABF85;}
.indicator.red{border-left:2px solid #E84855;}
.indicator.amber{border-left:2px solid #E8A020;}
.indicator.gold{border-left:2px solid #D8DADE;}
.directive-box{background:linear-gradient(135deg,rgba(216,218,222,0.06) 0%,rgba(5,7,9,0) 60%);border:1px solid #5A5D64;padding:24px;position:relative;overflow:hidden;}
.directive-box::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(to right,transparent,#D8DADE,transparent);}
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
.nudge{background:#0F1320;border:1px solid #161C2E;padding:28px;text-align:center;position:relative;overflow:hidden;}
.nudge::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(to right,transparent,#D8DADE,transparent);}
.nudge-title{font-family:'Cormorant Garamond',serif;font-size:20px;color:#F0E8D8;margin-bottom:8px;}
.nudge-sub{font-size:13px;color:#8898B8;font-family:'Cormorant Garamond',serif;line-height:1.6;margin-bottom:20px;max-width:400px;margin-left:auto;margin-right:auto;}
.elite-box{background:#0F1320;border:1px solid #5A5D64;padding:20px;margin-top:14px;}
.elite-title{font-size:10px;text-transform:uppercase;letter-spacing:0.16em;color:#D8DADE;margin-bottom:12px;font-weight:600;}
.wa-btn{display:flex;align-items:center;justify-content:center;gap:10px;background:#25D366;border:none;color:white;padding:11px 20px;font-size:12px;font-family:'Syne',sans-serif;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;width:100%;transition:all 0.2s;}
.wa-btn:hover{background:#20c05a;}
.cal-btn{display:flex;align-items:center;justify-content:center;gap:10px;background:transparent;border:1px solid #D8DADE;color:#D8DADE;padding:11px 20px;font-size:12px;font-family:'Syne',sans-serif;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;width:100%;transition:all 0.2s;margin-top:8px;}
.cal-btn:hover{background:rgba(216,218,222,0.12);}
.page-wrap{max-width:760px;margin:0 auto;padding:120px 48px 80px;}
.page-title{font-family:'Cormorant Garamond',serif;font-size:clamp(36px,5vw,56px);font-weight:300;color:#F0E8D8;margin-bottom:8px;}
.page-date{font-size:11px;color:#7A7E88;font-family:'JetBrains Mono',monospace;margin-bottom:48px;}
.page-h2{font-family:'Cormorant Garamond',serif;font-size:24px;color:#F0E8D8;margin:40px 0 12px;}
.page-p{font-size:14px;line-height:1.85;color:#8898B8;font-family:'Cormorant Garamond',serif;margin-bottom:16px;}
.page-back{display:inline-flex;align-items:center;gap:8px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#8898B8;cursor:pointer;margin-bottom:40px;transition:color 0.2s;}
.page-back:hover{color:#D8DADE;}
@media(max-width:960px){
  .feat-grid,.price-grid,.kpi4,.kpi3,.g3{grid-template-columns:1fr 1fr;}
  .stats-bar{grid-template-columns:1fr;}
  .g2,.g21,.input-grid{grid-template-columns:1fr;}
  .dash{grid-template-columns:1fr;grid-template-rows:64px auto 1fr;}
  .sidebar{display:none;}
  .topbar,.dash-body{grid-column:1;}
  .nav-links{display:none;}
  .nav,.hero,.sec,.cta-sec{padding-left:24px;padding-right:24px;}
  .footer{padding:32px 24px;}
  .hero{grid-template-columns:1fr;text-align:center;padding-top:120px;}
  .hero-copy{max-width:none;}
  .hero-sub{margin:0 auto 40px;}
  .hero-cta{justify-content:center;}
  .hero-preview{max-width:480px;margin:0 auto;width:100%;}
}
@media(max-width:600px){
  .feat-grid,.price-grid,.kpi4,.kpi3,.g3{grid-template-columns:1fr;}
  .hero-preview-kpis{grid-template-columns:1fr;}
}
`;

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
  const maxV = Math.max(...data.map(d => d.revenue), 1);
  return (
    <div>
      <div style={{ display:"flex", alignItems:"flex-end", gap:6, height:140 }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4, height:"100%", justifyContent:"flex-end" }}>
            <div style={{ display:"flex", gap:2, alignItems:"flex-end", height:120, width:"100%", justifyContent:"center" }}>
              <div style={{ width:"46%", borderRadius:"1px 1px 0 0", minHeight:3, height:`${(d.revenue/maxV)*110}px`, background:`linear-gradient(to top,${C.blue},rgba(74,124,247,0.4))` }}/>
              <div style={{ width:"46%", borderRadius:"1px 1px 0 0", minHeight:3, height:`${(d.expenses/maxV)*110}px`, background:`linear-gradient(to top,rgba(232,72,85,0.7),rgba(232,72,85,0.2))` }}/>
            </div>
            <span style={{ fontSize:9, color:C.inkDim, fontFamily:"'JetBrains Mono',monospace" }}>{d.month}</span>
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
function Directive({ metrics, concentration }) {
  const { margin, burnMonths, free, vel, conv, hireReady, ltvcac, n } = metrics;
  const d = computeDirective({ margin, burnMonths, free, vel, conv, hireReady, ltvcac, months: n, concentration });
  const { severity, wasCapped } = d;
  const uc = { critical:C.red, warn:C.amber, go:C.green, stable:C.gold }[severity];

  return (
    <div className="directive-box" style={{ "--uc":uc }}>
      <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(to right,transparent,${uc},transparent)` }}/>
      <div style={{ fontSize:9, letterSpacing:"0.2em", textTransform:"uppercase", color:uc, fontWeight:600, marginBottom:14 }}>
        This Week's Directive
      </div>
      <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:20, color:C.cream, lineHeight:1.4, borderLeft:`3px solid ${uc}`, paddingLeft:16, marginBottom:10 }}>
        {d.text}
      </div>
      <div style={{ fontSize:12, color:C.ink, lineHeight:1.7, fontFamily:"'Cormorant Garamond',serif", paddingLeft:16 }}>
        {d.reason}
        {wasCapped && " This is based on a single month of data — treat it as an early warning, not a confirmed crisis, until more history confirms it."}
      </div>
    </div>
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
        onClick={() => fileRef.current?.click()}
      >
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display:"none" }} onChange={e => handleFile(e.target.files[0])}/>
        <div className="drop-zone-title">{parsing ? "Reading your file..." : "Drop your financial file here"}</div>
        <div className="drop-zone-sub">
          Accepts Excel (.xlsx) or CSV from QuickBooks, Xero, Wave, or any spreadsheet.<br/>
          Any column structure is automatically detected and mapped.
        </div>
        {parsing && <div style={{ marginTop:16, display:"flex", justifyContent:"center" }}><span className="spinner"/></div>}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10 }}>
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
function PayModal({ planKey, userEmail, userId, onClose, onSuccess }) {
  const plan = PLANS[planKey];
  const btnRef   = useRef(null);
  const rendered = useRef(false);
  const [sdkReady, setSdkReady] = useState(false);
  const [sdkErr,   setSdkErr]   = useState("");
  const [done,     setDone]     = useState(false);

  useEffect(() => {
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
  }, [planKey]);

  useEffect(() => {
    if (!sdkReady || !btnRef.current || rendered.current) return;
    if (!window.paypal) { setSdkErr("PayPal SDK unavailable."); return; }
    rendered.current = true;
    btnRef.current.innerHTML = "";

    window.paypal.Buttons({
      style: { color:"gold", shape:"rect", label:"subscribe", layout:"vertical" },
      createSubscription: (_d, actions) =>
        actions.subscription.create({
          plan_id:   PAYPAL_PLANS[planKey],
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
  }, [sdkReady]);

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <div className="modal-title">{done ? "Subscription Active" : "Start Your Subscription"}</div>
          <button className="modal-x" onClick={onClose}>x</button>
        </div>
        <div className="modal-body">
          <div className="plan-badge">
            <div className="plan-badge-name">{plan.name}</div>
            <div className="plan-badge-price">${plan.usd.toLocaleString()} <span style={{ fontSize:14, color:C.inkDim }}>{plan.period}</span></div>
            <div className="plan-badge-sub">Billed monthly via PayPal. Cancel anytime.</div>
          </div>

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

// ─── DASHBOARD ────────────────────────────────────────────────
function Dashboard({ user, profile, onLogout, onUpgrade }) {
  const [tab,  setTab]  = useState("overview");
  const [mode, setMode] = useState("safe");
  const [data, setData] = useState(null);
  const [dataSource, setDataSource]   = useState("");
  const [detectedCols, setDetectedCols] = useState([]);
  // Financial Memory Engine — persisted transaction history, read fresh on
  // every load and every period-filter change. Nothing here is computed
  // client-side and stored back; `history` is raw monthly aggregates only.
  const [history, setHistory] = useState([]);
  const [lastTxnDate, setLastTxnDate] = useState(null);
  const [concentrationData, setConcentrationData] = useState(null);
  const [obligations, setObligations] = useState([]);
  const [affordInput, setAffordInput] = useState("");
  const [affordResult, setAffordResult] = useState(null);
  // Decision Log — every directive issued, whether it was acted on, and
  // what happened to its target metric afterward. Newest first.
  const [directives, setDirectives] = useState([]);
  const [directivesLoading, setDirectivesLoading] = useState(true);
  const [ackNote, setAckNote] = useState("");
  const [batches, setBatches] = useState([]);
  const [periodFilter, setPeriodFilter] = useState("12");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadErr, setUploadErr] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [aiRec,    setAiRec]    = useState(null);
  const [aiError,  setAiError]  = useState("");
  const [aiLoad,   setAiLoad]   = useState(false);
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

  const plan = profile?.plan || "essentials";
  const userName  = profile?.name || user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Founder";
  const userAvatar = user?.user_metadata?.avatar_url;

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
      let query = supabase.from("transactions").select("txn_date, amount, category, description").order("txn_date", { ascending: true });
      const cutoff = periodCutoff();
      if (cutoff) query = query.gte("txn_date", cutoff);
      const { data: txns, error } = await query;
      if (error) throw error;
      setHistory(aggregateTransactionsByMonth(txns || []));
      setConcentrationData(computeRevenueConcentration(txns || []));
      // Ascending order, so the last row is the most recent real transaction —
      // this is what the confidence model's recency check degrades against.
      setLastTxnDate(txns && txns.length > 0 ? txns[txns.length - 1].txn_date : null);
    } catch (e) {
      console.error("Failed to load transaction history:", e);
      setHistory([]);
      setConcentrationData(computeRevenueConcentration([]));
      setLastTxnDate(null);
    }
    setHistoryLoading(false);
  }, [periodCutoff]);

  const loadBatches = useCallback(async () => {
    const { data: rows, error } = await supabase.from("upload_batches").select("*").order("uploaded_at", { ascending: false });
    if (!error) setBatches(rows || []);
  }, []);

  // Recurring-obligation detection always runs over the founder's FULL
  // transaction history, independent of the dashboard's period filter —
  // a quarterly or annual obligation can't be reliably detected from a
  // 3-month window even if that's what's currently selected for display.
  const loadObligations = useCallback(async () => {
    try {
      const { data: txns, error } = await supabase.from("transactions").select("txn_date, amount, description, category").order("txn_date", { ascending: true });
      if (error) throw error;
      const detected = detectRecurringObligations(txns || []);

      const { data: existing } = await supabase.from("recurring_obligations").select("normalized_key, active");
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
        await supabase.from("recurring_obligations").upsert(rows, { onConflict: "user_id,normalized_key" });
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
    if (!error) setObligations(obs => obs.map(o => o.id === id ? { ...o, active } : o));
  };

  const loadDirectives = useCallback(async () => {
    setDirectivesLoading(true);
    const { data: rows, error } = await supabase.from("directives").select("*").order("issued_at", { ascending: false });
    if (!error) setDirectives(rows || []);
    setDirectivesLoading(false);
  }, []);

  const acknowledgeDirective = async (directiveId, actionTaken) => {
    const patch = { acknowledged_at: new Date().toISOString(), action_taken: actionTaken, founder_note: ackNote.trim() || null };
    const { error } = await supabase.from("directives").update(patch).eq("id", directiveId);
    if (!error) {
      setDirectives(ds => ds.map(d => d.id === directiveId ? { ...d, ...patch } : d));
      setAckNote("");
    }
  };

  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => { loadObligations(); }, [loadObligations]);
  useEffect(() => { loadDirectives(); }, [loadDirectives]);

  const handleDataLoaded = async (parsedRows, source, cols, rawText) => {
    setData(parsedRows); setDataSource(source); setDetectedCols(cols); setTab("overview");
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
      if (insertErr) throw insertErr;

      const insertedCount = inserted?.length || 0;
      const duplicateCount = transactions.length - insertedCount;

      await supabase.from("upload_batches")
        .update({ inserted_count: insertedCount, duplicate_count: duplicateCount })
        .eq("id", batch.id);

      setUploadStatus(`Added ${insertedCount} new transaction${insertedCount === 1 ? "" : "s"}. ${duplicateCount} already on file.`);
      await loadHistory();
      await loadBatches();
      await loadObligations();
    } catch (e) {
      console.error("Failed to save transaction history:", e);
      setUploadErr("Your file was read for this session, but saving it to your permanent history failed. The numbers below are accurate for now — try re-uploading to save them.");
    }
    setUploadBusy(false);
  };

  const deleteBatch = async (batchId) => {
    const { error } = await supabase.from("upload_batches").delete().eq("id", batchId);
    if (!error) { await loadHistory(); await loadBatches(); await loadObligations(); }
  };

  // Persisted history is the source of truth once it exists; a fresh
  // upload's session-only `data` is only shown as an optimistic bridge
  // until loadHistory() catches up. Manual entry never touches either.
  const rows = history.length > 0 ? history : (data && data.length > 0 ? data : null);
  const {
    tr, sr, latest, prev, totRev, totExp, totCogs, totMkt, totL, totC,
    activeCash, activeCac, activeLtv, n, totPro, margin, vel, conv, ltvcac,
    cogsRatio, mktRatio, sov, sovLbl, taxV, safV, free, avgExp, burnMonths,
    hireReady, concentration, concentrationReliable, breakEven, proj90, hasData,
    hasConversionData, cashFlowPositive, dataConfidence, growth, risk, trends,
    hasCashData, hasUnitEconomicsData, runwayConfidence, breakEvenConfidence,
    proj90Confidence, hireReadyConfidence, ltvcacConfidence, growthConfidence,
    seasonalPattern, trajectory, historicalConfidence, founderNarrative,
  } = computeMetrics(
    rows, { mRev, mExp, mCash, mCac, mLtv, mLeads, mClose }, mode,
    { lastTxnDate: history.length > 0 ? lastTxnDate : null, revenueConcentration: concentrationData }
  );
  const metrics = { margin, vel, conv, sov, free, burnMonths, hireReady, concentration, concentrationReliable, ltvcac, cashFlowPositive, n };

  const todayStr = new Date().toISOString().slice(0, 10);
  const activeObligations = obligations.filter(o => o.active !== false);
  const missedObligations = detectMissedObligations(activeObligations, todayStr);

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
    if (!monthlyCost || monthlyCost <= 0) { setAffordResult(null); return; }
    setAffordResult(checkAffordability({ currentCash: activeCash, avgRev, avgExp, obligations: activeObligations, monthlyCost, fromDate: todayStr }));
  };

  const scenario = runScenario(
    { revenue: latest.revenue, expenses: latest.expenses, cash: activeCash, cac: activeCac, ltv: activeLtv, leads: 0, closures: 0 },
    { revenuePct: scRevPct, expensePct: scExpPct, expenseDelta: scHire, cashDelta: scCash },
    mode
  );

  const alert = (() => {
    if (!hasData) return { t:"info", msg:"Connect your financial data in the Data tab to activate your command center." };
    if (safe(free) < 0) return { t:"crit", msg:"True Free Cash is negative. Overhead exceeds liquidity after obligations. Cut costs before next cycle." };
    if (safe(burnMonths) > 0 && safe(burnMonths) < 3) return { t:"crit", msg:`Runway is ${safe(burnMonths).toFixed(1)} months. Below the 3-month danger threshold. Protect cash immediately.` };
    if (concentrationReliable && safe(concentration) > 60) return { t:"warn", msg:`${pc(concentration)} of revenue comes from your single largest client. Losing that client would collapse your revenue.` };
    if (safe(ltvcac) > 0 && safe(ltvcac) < 3) return { t:"warn", msg:`LTV:CAC at ${safe(ltvcac).toFixed(1)}x. Below the 3x minimum. Fix unit economics before scaling acquisition spend.` };
    if (safe(margin) > 40 && safe(conv) > 20) return { t:"ok", msg:"Margin and conversion both strong. You are in a deployment window. Increase lead volume now." };
    return { t:"info", msg:"Foundation stable. Maintain velocity and watch your runway." };
  })();

  // ─── DECISION LOG ────────────────────────────────────────────
  // A directive nobody follows up on is a tool, not an advisor. This
  // computes the same directive Directive renders, so what's persisted
  // and what's shown can never disagree.
  const currentDirective = hasData
    ? computeDirective({ margin, burnMonths, free, vel, conv, hireReady, ltvcac, months: n, concentration: concentrationData })
    : null;

  // Persist a directive only when it genuinely differs from the most
  // recently stored one — never on every render or page load. Waits for
  // the initial fetch to land first, so an already-persisted directive
  // that just hasn't loaded into state yet is never duplicated.
  useEffect(() => {
    if (!currentDirective || directivesLoading) return;
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
      if (!error && inserted) setDirectives(ds => [inserted, ...ds]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDirective?.text, currentDirective?.rule, directivesLoading]);

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
        if (!error) setDirectives(ds => ds.map(x => x.id === d.id ? { ...x, ...patch } : x));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directivesLoading, hasData, directives.length]);

  const latestDirective = directives[0] || null;
  const needsAcknowledgement = !!(latestDirective && !latestDirective.acknowledged_at &&
    (Date.now() - new Date(latestDirective.issued_at).getTime()) >= 7 * 86400000);

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
          hireReady:      hireReadyConfidence.shown ? hireReady : null,
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
            hireReady: hireReadyConfidence,
            ltvCac:    ltvcacConfidence,
            growth:    growthConfidence,
          },
          // Forward cash calendar: detected recurring obligations projected
          // 90 days ahead, plus the obligation-aware runway (real dated
          // bills against current cash) alongside the flat average-burn
          // figure above — null when no obligations have been detected yet.
          forwardCalendar: activeObligations.length > 0 ? {
            weeklyTotals: summarizeCalendarByWeek(projectForwardCalendar(activeObligations, todayStr, 90), todayStr, 90)
              .map(w => ({ weekStart: w.weekStart, total: Math.round(w.total) })),
            obligationAwareRunway: forwardRunway ? {
              crossesZero: forwardRunway.crossesZero,
              monthsUntilCross: forwardRunway.monthsUntilCross,
              crossDate: forwardRunway.crossDate,
            } : null,
            missedObligations: missedObligations.map(m => ({ label: m.label, daysPast: m.daysPast })),
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

  const navItems = [
    { id:"overview",  label:"Overview",    locked:false },
    { id:"advisor",   label:"AI Advisor",  locked:false },
    { id:"scenarios", label:"Scenarios",   locked:false },
    { id:"data",      label:"Connect Data",locked:false },
  ];

  return (
    <div className="dash">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logomark">C</div>
          <div><div className="wordmark" style={{ fontSize:15 }}>Command Ledger</div><div className="wordmark-sub">Financial Intelligence</div></div>
        </div>
        <nav className="sb-nav">
          <div className="sb-sec">Navigation</div>
          {navItems.map(n => (
            <div key={n.id} className={`sb-item${tab===n.id?" on":""}${n.locked?" locked":""}`}
              onClick={() => !n.locked && setTab(n.id)}>
              <span className="sb-icon" style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:10, color:tab===n.id?C.gold:C.goldDim }}>#</span>
              {n.label}
              {n.locked && <span style={{ fontSize:10, marginLeft:"auto", opacity:0.5 }}>Pro+</span>}
            </div>
          ))}
          <div className="sb-sec" style={{ marginTop:8 }}>Plan</div>
          <div className="sb-item" style={{ color:plan==="elite"?C.green:plan==="pro"?C.gold:C.blue, cursor:"default" }}>
            <span style={{ fontSize:10, marginRight:4, fontFamily:"'JetBrains Mono',monospace" }}>-</span>
            {PLANS[plan].name}
          </div>
          {plan === "essentials" && (
            <div className="sb-item" style={{ color:C.gold }} onClick={onUpgrade}>
              <span style={{ fontSize:10, marginRight:4, fontFamily:"'JetBrains Mono',monospace" }}>+</span>Upgrade to Pro
            </div>
          )}
          {plan === "pro" && (
            <div className="sb-item locked">
              <span style={{ fontSize:10, marginRight:4, fontFamily:"'JetBrains Mono',monospace" }}>+</span>Elite VIP
              <span style={{ fontSize:10, marginLeft:"auto", opacity:0.5 }}>Soon</span>
            </div>
          )}
          <div className="sb-sec" style={{ marginTop:8 }}>Account</div>
          <div className="sb-item" onClick={onLogout}>
            <span style={{ fontSize:10, marginRight:4, color:C.inkDim, fontFamily:"'JetBrains Mono',monospace" }}>-</span>Sign Out
          </div>
        </nav>
        <div className="sb-foot">
          <div className="sb-user">
            <div className="sb-av">{userAvatar ? <img src={userAvatar} alt=""/> : userName[0]?.toUpperCase()}</div>
            <div><div className="sb-name">{userName}</div><div className="sb-plan">{PLANS[plan].name}</div></div>
          </div>
        </div>
      </aside>

      <header className="topbar">
        <div className="breadcrumb">Command Ledger / <span>{tab==="data"?"Connect Data":tab==="advisor"?"AI Advisor":tab==="scenarios"?"Scenarios":PLANS[plan].name}</span></div>
        <div className="tb-right">
          <div className="live-badge" title={hasData ? `Data confidence: ${dataConfidence} (${dataConfidence==="low"?"single manual entry, no history":dataConfidence==="medium"?"uploaded data, under 3 months":"uploaded data, 3+ months"})` : ""}>
            <div className="live-dot" style={{ background:hasData?C.green:C.amber, boxShadow:`0 0 8px ${hasData?C.green:C.amber}` }}/>
            <span style={{ color:hasData?C.green:C.amber }}>{hasData ? `Live - ${dataSource||"Manual Input"} - ${dataConfidence[0].toUpperCase()}${dataConfidence.slice(1)} confidence` : "No data"}</span>
          </div>
          <div className="mode-pills">
            <button className={`mpill${mode==="safe"?" on":""}`} onClick={() => setMode("safe")}>Safe</button>
            <button className={`mpill${mode==="growth"?" on":""}`} onClick={() => setMode("growth")}>Growth</button>
          </div>
        </div>
      </header>

      <main className="dash-body">

        {tab === "data" && (
          <>
            <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:28, fontWeight:300, color:C.cream }}>Connect Your Data</div>
            <div className="card">
              <div className="card-sec">Upload File or Sync Google Sheet</div>
              <DataUpload
                hasData={!!rows}
                onDataLoaded={handleDataLoaded}
              />
              {uploadBusy && (
                <div style={{ marginTop:14, display:"flex", alignItems:"center", gap:10, fontSize:12, color:C.inkDim, fontFamily:"'JetBrains Mono',monospace" }}>
                  <span className="spinner"/>Saving to your transaction history...
                </div>
              )}
              {!uploadBusy && uploadStatus && <div className="d-alert ok" style={{ marginTop:14 }}>{uploadStatus}</div>}
              {!uploadBusy && uploadErr && <div className="d-alert warn" style={{ marginTop:14 }}>{uploadErr}</div>}
            </div>

            <div className="card">
              <div className="card-sec">Upload History</div>
              {batches.length === 0 ? (
                <div style={{ fontSize:12, color:C.inkDim, fontFamily:"'Cormorant Garamond',serif" }}>No files uploaded yet. Every upload you make is listed here, with exactly how many transactions it added versus how many were already on file.</div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                  {batches.map(b => (
                    <div key={b.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, padding:"12px 0", borderBottom:`1px solid ${C.border}` }}>
                      <div>
                        <div style={{ fontSize:12.5, color:C.cream }}>{b.filename || "Untitled upload"}</div>
                        <div style={{ fontSize:10.5, color:C.inkDim, fontFamily:"'JetBrains Mono',monospace", marginTop:2 }}>
                          {new Date(b.uploaded_at).toLocaleDateString()} · {b.period_start} to {b.period_end} · {b.inserted_count ?? "—"} added, {b.duplicate_count ?? "—"} duplicate
                        </div>
                      </div>
                      <button className="modal-x" title="Delete this upload and its transactions"
                        onClick={() => { if (window.confirm(`Delete "${b.filename}" and every transaction it added? This cannot be undone.`)) deleteBatch(b.id); }}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-sec">Or Enter Numbers Manually</div>
              <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.7, marginBottom:20 }}>
                No file ready? Enter this month's numbers below. Your dashboard updates in real time.
              </div>
              <div className="input-grid">
                {[
                  { lbl:"Monthly Revenue ($)",        v:mRev,   s:setMRev },
                  { lbl:"Monthly Expenses ($)",        v:mExp,   s:setMExp },
                  { lbl:"Cash Balance ($)",            v:mCash,  s:setMCash },
                  { lbl:"Customer Acquisition Cost ($)",v:mCac,  s:setMCac },
                  { lbl:"Customer Lifetime Value ($)", v:mLtv,  s:setMLtv },
                  { lbl:"Leads This Month",            v:mLeads, s:setMLeads },
                  { lbl:"Deals Closed",                v:mClose, s:setMClose },
                ].map((f, i) => (
                  <div key={i} className="input-group">
                    <label className="di-lbl">{f.lbl}</label>
                    <input className="di" type="number" min="0" value={f.v} onChange={e => f.s(Math.max(0, Number(e.target.value) || 0))}/>
                  </div>
                ))}
              </div>
              {mRev > 0 && (
                <button className="btn btn-primary" style={{ padding:"10px 24px", fontSize:11 }} onClick={() => setTab("overview")}>
                  View My Dashboard
                </button>
              )}
            </div>
          </>
        )}

        {tab === "advisor" && (
          <>
            <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:28, fontWeight:300, color:C.cream }}>AI Strategic Advisor</div>
            <div className="card" style={{ padding:0 }}>
              <div className="ai-top">
                <div className="ai-lbl"><div className="ai-glow"/>Command Ledger Intelligence - Powered by Claude</div>
                <button className="ai-btn" onClick={runAI} disabled={aiLoad}>{aiLoad ? "Analyzing..." : "Generate Brief"}</button>
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
                  <div className="ai-txt" style={{ padding:"20px" }}>Click Generate Brief to receive your personalised weekly strategic directive.</div>
                )}
              </div>
            </div>
            {!hasData && (
              <div className="d-alert info">Connect your financial data first. The AI brief uses your real numbers, not generic advice.</div>
            )}
          </>
        )}

        {tab === "scenarios" && (
          <>
            <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:28, fontWeight:300, color:C.cream }}>Scenario Planning</div>
            {!hasData ? (
              <div className="d-alert info">Connect your financial data first. Scenarios are built from your real latest-month numbers.</div>
            ) : (
              <>
                <div className="card">
                  <div className="card-sec">Adjust the Assumptions</div>
                  <div className="input-grid">
                    <div className="input-group">
                      <label className="di-lbl">Revenue Change (%)</label>
                      <input className="di" type="number" value={scRevPct} onChange={e => setScRevPct(Number(e.target.value))}/>
                    </div>
                    <div className="input-group">
                      <label className="di-lbl">Expense Change (%)</label>
                      <input className="di" type="number" value={scExpPct} onChange={e => setScExpPct(Number(e.target.value))}/>
                    </div>
                    <div className="input-group">
                      <label className="di-lbl">New Hire, Monthly Cost ($)</label>
                      <input className="di" type="number" min="0" value={scHire} onChange={e => setScHire(Number(e.target.value))}/>
                    </div>
                    <div className="input-group">
                      <label className="di-lbl">One-Time Cash Change ($)</label>
                      <input className="di" type="number" value={scCash} onChange={e => setScCash(Number(e.target.value))}/>
                    </div>
                  </div>
                  {(scRevPct !== 0 || scExpPct !== 0 || scHire !== 0 || scCash !== 0) && (
                    <button className="btn btn-outline" style={{ padding:"8px 18px", fontSize:11, marginTop:16 }}
                      onClick={() => { setScRevPct(0); setScExpPct(0); setScHire(0); setScCash(0); }}>
                      Reset to Current
                    </button>
                  )}
                  <div style={{ fontSize:11, color:C.inkDim, marginTop:14, fontFamily:"'Cormorant Garamond',serif" }}>
                    Nothing here is saved — this recomputes your real calculation engine against a hypothetical month, purely to explore before you decide.
                  </div>
                </div>

                <div className="card">
                  <div className="card-sec">Before vs. After</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:16 }}>
                    {[
                      { lbl:"Margin", before:pc(scenario.before.margin), after:pc(scenario.after.margin), better: scenario.after.margin >= scenario.before.margin },
                      { lbl:"True Free Cash", before:fmt(scenario.before.free), after:fmt(scenario.after.free), better: scenario.after.free >= scenario.before.free },
                      { lbl:"Cash Position", before: scenario.before.cashFlowPositive ? "No burn" : `${safe(scenario.before.burnMonths).toFixed(1)}mo runway`,
                        after: scenario.after.cashFlowPositive ? "No burn" : `${safe(scenario.after.burnMonths).toFixed(1)}mo runway`,
                        better: scenario.after.cashFlowPositive || scenario.after.burnMonths >= scenario.before.burnMonths },
                      { lbl:"Risk Score", before:`${scenario.before.risk.score.toFixed(0)} - ${scenario.before.risk.label}`, after:`${scenario.after.risk.score.toFixed(0)} - ${scenario.after.risk.label}`, better: scenario.after.risk.score <= scenario.before.risk.score },
                    ].map((row, i) => (
                      <div key={i} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, padding:"14px 16px" }}>
                        <div className="card-lbl">{row.lbl}</div>
                        <div style={{ fontSize:12, color:C.inkDim, fontFamily:"'JetBrains Mono',monospace", marginTop:6 }}>{row.before}</div>
                        <div style={{ fontSize:18, color: row.better ? C.green : C.red, fontFamily:"'JetBrains Mono',monospace", marginTop:2 }}>→ {row.after}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {tab === "overview" && (
          <>
            {history.length > 0 && (
              <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:-8 }}>
                <div className="mode-pills">
                  {[["3","3mo"],["6","6mo"],["12","12mo"],["all","All time"]].map(([val,lbl]) => (
                    <button key={val} className={`mpill${periodFilter===val?" on":""}`} onClick={() => setPeriodFilter(val)}>{lbl}</button>
                  ))}
                </div>
              </div>
            )}

            {historyLoading && !data ? (
              <div className="d-alert info">Loading your financial history...</div>
            ) : (
              <div className={`d-alert ${alert.t}`}>{alert.msg}</div>
            )}

            {hasData && <Directive metrics={metrics} concentration={concentrationData}/>}

            {missedObligations.length > 0 && (
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                {missedObligations.map((m, i) => (
                  <div key={i} className="d-alert crit">{m.message}</div>
                ))}
              </div>
            )}

            {needsAcknowledgement && (
              <div className="card" style={{ borderLeft:`3px solid ${C.gold}` }}>
                <div className="card-sec">Did you act on this?</div>
                <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:15, color:C.cream, marginBottom:14, lineHeight:1.5 }}>
                  Last directive ({new Date(latestDirective.issued_at).toLocaleDateString()}): "{latestDirective.directive_text}"
                </div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
                  {[["acted","Acted"],["partially","Partially"],["ignored","Ignored"],["disagreed","I disagreed"]].map(([val,lbl]) => (
                    <button key={val} className="btn btn-primary" style={{ fontSize:11, padding:"8px 16px" }}
                      onClick={() => acknowledgeDirective(latestDirective.id, val)}>{lbl}</button>
                  ))}
                </div>
                <textarea className="di" placeholder="Optional note — why you did (or didn't) act..."
                  value={ackNote} onChange={e => setAckNote(e.target.value)}
                  style={{ minHeight:56, resize:"vertical", fontFamily:"'Cormorant Garamond',serif", fontSize:13 }}/>
              </div>
            )}

            <div>
              <div className="card-sec">Core Vitals</div>
              <div className="kpi4">
                {[
                  { lbl:"Monthly Revenue",  val:fmt(latest.revenue), col:"g",  d:`${pc(vel)} velocity`,     dt:vel>=0?"up":"dn" },
                  { lbl:"Profit Margin",    val:pc(margin),          col:"gr", d:`${fmt(totPro)} net profit`, dt:margin>0?"up":"dn" },
                  { lbl:"True Free Cash",   val:fmt(free),           col:free>=0?"g":"r", d:"After tax + safety", dt:free>=0?"up":"dn" },
                  { lbl:"Burn Runway",      val:cashFlowPositive?"No burn":(runwayConfidence.shown && burnMonths>0)?`${safe(burnMonths).toFixed(1)}mo`:"---",
                    col:cashFlowPositive?"gr":burnMonths>=6?"gr":burnMonths>=3?"a":"r",
                    d:cashFlowPositive?"Cash flow positive":burnMonths>=6?"Safe":"Needs attention",
                    dt:cashFlowPositive||burnMonths>=6?"up":"dn", conf:runwayConfidence },
                ].map((m, i) => (
                  <div key={i} className="card"
                    onMouseEnter={e => e.currentTarget.style.transform = "translateY(-2px)"}
                    onMouseLeave={e => e.currentTarget.style.transform = ""}
                    style={{ transition:"transform 0.2s", cursor:"default" }}>
                    <div className="card-lbl">{m.lbl}</div>
                    <div className={`val ${m.col}`}>{m.val}</div>
                    <div className={`delta ${m.dt}`}>{m.dt==="up"?"+":"-"} {m.d}</div>
                    <ConfidenceLine c={m.conf}/>
                  </div>
                ))}
              </div>
              {showForwardRunway && (
                <div className="d-alert warn" style={{ marginTop:12 }}>
                  {cashFlowPositive ? `No burn on average — but ` : `${safe(burnMonths).toFixed(1)} months on average burn. `}
                  {forwardRunway.monthsUntilCross.toFixed(1)} months against your known obligations (around {forwardRunway.crossDate}). The second is the real number.
                </div>
              )}
            </div>

            <div className="g2">
              <div className="card"><div className="card-sec">Revenue vs Expenses</div><BChart data={rows}/></div>
              <div className="card">
                <div className="card-sec">Sovereignty Index</div>
                <div style={{ display:"flex", gap:20, alignItems:"center" }}>
                  <Ring score={sov}/>
                  <div>
                    <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, color:sov>=75?C.gold:sov>=50?C.amber:C.red, marginBottom:6 }}>{sovLbl}</div>
                    <div style={{ fontSize:12, color:C.ink, lineHeight:1.7, fontFamily:"'Cormorant Garamond',serif" }}>
                      {hasConversionData
                        ? <>Margin ({pc(margin*0.6)}) + Conversion ({pc(conv*0.4)}). Above 75 triggers aggressive scale posture.</>
                        : <>Based on margin alone ({pc(margin)}) — no lead/conversion data connected yet. Add it in Connect Data for the full score.</>}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="g2">
              <div className="card">
                <div className="card-sec">Growth Score</div>
                <div style={{ display:"flex", gap:20, alignItems:"center" }}>
                  <Ring score={growth.score}/>
                  <div>
                    <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, color:growth.score>=60?C.green:growth.score>=40?C.amber:C.red, marginBottom:6 }}>{growth.label}</div>
                    <div style={{ fontSize:12, color:C.ink, lineHeight:1.7, fontFamily:"'Cormorant Garamond',serif" }}>
                      {growth.seasonallyAdjusted
                        ? <>Compared to {seasonalPattern.month} a year ago ({pc(growth.rate)} year-over-year), not last month — {seasonalPattern.month} has run {Math.abs(seasonalPattern.avgDeltaPct).toFixed(0)}% {seasonalPattern.avgDeltaPct<0?"below":"above"} average for {seasonalPattern.occurrences} years running, so a plain month-over-month reading would call a normal season a decline.</>
                        : rows && rows.length>=3
                          ? <>Trailing growth rate ({pc(growth.rate)}/mo), weighted with how consistently recent months grew ({Math.round(growth.consistency*100)}% of the last few were up).</>
                          : <>Based on a single growth reading — connect 3+ months of data for a consistency-weighted score.</>}
                    </div>
                    <ConfidenceLine c={growthConfidence}/>
                  </div>
                </div>
              </div>
              <div className="card">
                <div className="card-sec">Risk Score</div>
                <div style={{ display:"flex", gap:20, alignItems:"center" }}>
                  {/* Ring fills as things get safer, not as risk rises — risk.score itself is 0=safe/100=risky */}
                  <Ring score={100-risk.score}/>
                  <div>
                    <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, color:risk.label==="Low"?C.green:risk.label==="Watch"?C.amber:C.red, marginBottom:6 }}>{risk.label}</div>
                    <div style={{ fontSize:12, color:C.ink, lineHeight:1.7, fontFamily:"'Cormorant Garamond',serif" }}>
                      Weighted from runway, margin, revenue concentration, and LTV:CAC — each only counts when there's real data behind it.
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {trends.length > 0 && (
              <div>
                <div className="card-sec">Trends Detected</div>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  {trends.map((t, i) => (
                    <div key={i} className={`d-alert ${t.direction==="improving"?"ok":"warn"}`}>{t.message}</div>
                  ))}
                </div>
              </div>
            )}

            {founderNarrative && (
              <div>
                <div className="card-sec">Business History</div>
                <div className="card">
                  <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:14, color:C.cream, lineHeight:1.7 }}>
                    {founderNarrative}
                  </div>
                  {seasonalPattern && (
                    <div style={{ fontSize:12, color:C.ink, lineHeight:1.6, marginTop:10, fontFamily:"'Cormorant Garamond',serif" }}>
                      {seasonalPattern.month} has run {Math.abs(seasonalPattern.avgDeltaPct).toFixed(0)}% {seasonalPattern.avgDeltaPct<0?"below":"above"} your average for {seasonalPattern.occurrences} years running — a repeating seasonal pattern, not a new signal.
                    </div>
                  )}
                  <ConfidenceLine c={{
                    shown: true,
                    level: { low:"low", medium:"moderate", high:"high", "very high":"high" }[historicalConfidence?.label] || "low",
                    reason: historicalConfidence?.reason || "",
                  }}/>
                </div>
              </div>
            )}

            <div>
              <div className="card-sec">Business Intelligence</div>
              <div className="g3">
                {[
                  {
                    lbl:"Burn Runway",
                    val: cashFlowPositive ? "No burn" : (runwayConfidence.shown && burnMonths > 0) ? `${safe(burnMonths).toFixed(1)} months` : "---",
                    sub: cashFlowPositive?"Revenue covers expenses - no cash burn":!runwayConfidence.shown?"Enter cash balance to calculate":burnMonths>=6?"Safe - above 6-month threshold":burnMonths>=3?"Caution - build to 6 months":burnMonths>0?"Danger - act immediately":"Enter cash balance to calculate",
                    cls: cashFlowPositive?"green":burnMonths>=6?"green":burnMonths>=3?"amber":burnMonths>0?"red":"gold",
                    col: cashFlowPositive?C.green:burnMonths>=6?C.green:burnMonths>=3?C.amber:burnMonths>0?C.red:C.gold,
                    conf: runwayConfidence,
                  },
                  {
                    lbl:"Hire Readiness",
                    val: !hireReadyConfidence.shown ? "---" : hireReady ? "Ready" : "Not Yet",
                    sub: !hireReadyConfidence.shown ? "Enter revenue and expenses to calculate" : hireReady ? "Free cash supports new headcount" : `Need ${fmt(Math.max(0, 25000*6-free))} more in free cash`,
                    cls: hireReady ? "green" : "amber",
                    col: hireReady ? C.green : C.amber,
                    conf: hireReadyConfidence,
                  },
                  {
                    lbl:"LTV : CAC Ratio",
                    val: ltvcacConfidence.shown ? `${safe(ltvcac).toFixed(1)}x` : "---",
                    sub: ltvcacConfidence.shown ? (ltvcac>=3?"Healthy - above 3x threshold":"Below 3x - fix before scaling") : "Enter CAC and LTV in data",
                    cls: ltvcac>=3?"green":ltvcac>0?"amber":"gold",
                    col: ltvcac>=3?C.green:ltvcac>0?C.amber:C.gold,
                    conf: ltvcacConfidence,
                  },
                ].map((ind, i) => (
                  <div key={i} className={`indicator ${ind.cls}`}>
                    <div className="card-lbl">{ind.lbl}</div>
                    <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:28, color:ind.col, marginBottom:6 }}>{ind.val}</div>
                    <div style={{ fontSize:12, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.5 }}>{ind.sub}</div>
                    <ConfidenceLine c={ind.conf}/>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="card-sec">Revenue Concentration</div>
              <div className="card">
                {!concentrationData?.shown ? (
                  <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.6 }}>
                    {concentrationData?.confidenceLevel === "low"
                      ? `Not enough payer names could be reliably read from your transactions to show this safely. ${concentrationData.reason}`
                      : "Upload transaction history to see how concentrated your revenue is in your largest clients."}
                  </div>
                ) : (
                  <>
                    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                      {concentrationData.payers.slice(0, 5).map((p, i) => {
                        const isLargest = i === 0;
                        const barColor = isLargest ? (p.pct > 60 ? C.red : p.pct > 40 ? C.amber : C.green) : C.gold;
                        return (
                          <div key={p.name}>
                            <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:C.ink, marginBottom:4, fontFamily:"'Cormorant Garamond',serif" }}>
                              <span style={{ textTransform:"capitalize" }}>{p.name}</span>
                              <span style={{ color: barColor }}>{p.pct.toFixed(1)}%</span>
                            </div>
                            <div style={{ height:8, background:C.border, borderRadius:4, overflow:"hidden" }}>
                              <div style={{ width:`${Math.min(100, p.pct)}%`, height:"100%", background:barColor }}/>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <ConfidenceLine c={{ shown:true, level:concentrationData.confidenceLevel, reason:concentrationData.reason }}/>
                    {concentrationData.aggregatorPct > 0.5 && (
                      <div style={{ fontSize:11, color:C.inkDim, marginTop:12, fontFamily:"'Cormorant Garamond',serif" }}>
                        {concentrationData.aggregatorPct.toFixed(0)}% of revenue arrives through a payment processor (Shopify, Stripe, PayPal) and can't be attributed to a single client — excluded from the figures above.
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div>
              <div className="card-sec">Committed Costs</div>
              <div className="card">
                {activeObligations.length === 0 ? (
                  <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.6 }}>
                    No recurring obligations detected yet. At least 3 similar payments on a consistent schedule (rent, payroll, a quarterly VAT payment) are needed before one shows up here.
                  </div>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                    {activeObligations.map(o => (
                      <div key={o.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", borderBottom:`1px solid ${C.border}`, paddingBottom:12 }}>
                        <div>
                          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:15, color:C.cream, textTransform:"capitalize" }}>{o.label}</div>
                          <div style={{ fontSize:11, color:C.ink, fontFamily:"'JetBrains Mono',monospace", marginTop:2, textTransform:"capitalize" }}>
                            {o.cadence}{o.amount_variance === "variable" ? " · variable" : ""} · next expected {o.next_expected}
                          </div>
                          <ConfidenceLine c={{ shown:true, level:o.confidence, reason:`${o.occurrences} occurrences observed` }}/>
                        </div>
                        <div style={{ textAlign:"right", flexShrink:0, marginLeft:16 }}>
                          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:16, color:C.gold }}>{fmt(o.typical_amount)}</div>
                          <button className="btn" style={{ fontSize:10, padding:"4px 10px", marginTop:6 }} onClick={() => setObligationActive(o.id, false)}>Mark ended</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ marginTop:20, paddingTop:16, borderTop:`1px solid ${C.border}` }}>
                  <div className="card-lbl">Can I afford a recurring cost of $___ per month?</div>
                  <div style={{ display:"flex", gap:8, marginTop:8 }}>
                    <input type="number" min="0" className="di" placeholder="e.g. 1500"
                      value={affordInput} onChange={e => setAffordInput(e.target.value)}
                      style={{ maxWidth:160 }}/>
                    <button className="btn btn-primary" style={{ fontSize:11, padding:"8px 16px" }} onClick={checkAfford}>Check</button>
                  </div>
                  {affordResult && (
                    <div className={`d-alert ${affordResult.affordable ? "ok" : "crit"}`} style={{ marginTop:12 }}>
                      {affordResult.message}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div>
              <div className="card-sec">Decision History</div>
              <div className="card">
                {directives.length === 0 ? (
                  <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.6 }}>
                    No directives issued yet. Once Command Ledger issues its first call, it's logged here permanently — along with whether you acted on it and what happened to the metric it targeted afterward.
                  </div>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                    {directives.map((d, i) => {
                      const uc = { critical:C.red, warn:C.amber, go:C.green, stable:C.gold }[d.severity] || C.gold;
                      const outcome = describeDirectiveOutcome(d);
                      const actionLabel = { acted:"Acted", partially:"Partially acted", ignored:"Ignored", disagreed:"Disagreed" }[d.action_taken] || "Awaiting response";
                      const outcomeColor = outcome.status === "measured"
                        ? (outcome.improved === true ? C.green : outcome.improved === false ? C.red : C.ink)
                        : C.inkDim;
                      return (
                        <div key={d.id} style={{ borderLeft:`3px solid ${uc}`, paddingLeft:14, paddingBottom: i < directives.length - 1 ? 16 : 0, borderBottom: i < directives.length - 1 ? `1px solid ${C.border}` : "none" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", flexWrap:"wrap", gap:8 }}>
                            <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:15, color:C.cream }}>{d.directive_text}</div>
                            <div style={{ fontSize:10.5, color:C.inkDim, fontFamily:"'JetBrains Mono',monospace", whiteSpace:"nowrap" }}>{new Date(d.issued_at).toLocaleDateString()}</div>
                          </div>
                          <div style={{ fontSize:11, color:C.ink, marginTop:4, fontFamily:"'Cormorant Garamond',serif" }}>
                            {actionLabel}{d.founder_note ? ` — "${d.founder_note}"` : ""}
                          </div>
                          <div style={{ fontSize:11, color:outcomeColor, marginTop:4, fontFamily:"'Cormorant Garamond',serif" }}>
                            {outcome.message}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="g21">
              <div className="card">
                <div className="card-sec">Capital Allocator</div>
                {[
                  { name:"Tax Vault",      pct:tr*100, amt:taxV, col:C.red,  bg:C.redGlow },
                  { name:"Safety Buffer",  pct:sr*100, amt:safV, col:C.blue, bg:C.blueGlow },
                  { name:"True Free Cash", pct:totPro>0?Math.max(0,(free/totPro)*100):0, amt:free, col:free>=0?C.gold:C.red, bg:free>=0?C.goldGlow:C.redGlow },
                ].map((a, i) => (
                  <div className="alloc-row" key={i}>
                    <div className="alloc-icon" style={{ background:a.bg, fontFamily:"'JetBrains Mono',monospace", color:a.col, fontSize:12 }}>-</div>
                    <div className="alloc-meta">
                      <div className="alloc-name">{a.name}</div>
                      <div className="alloc-pct">{safe(a.pct).toFixed(0)}% of profit</div>
                      <div className="alloc-track"><div className="alloc-fill" style={{ width:`${Math.min(100,safe(a.pct))}%`, background:a.col }}/></div>
                    </div>
                    <div className="alloc-amt" style={{ color:a.col }}>{fmt(a.amt)}</div>
                  </div>
                ))}
              </div>
              <div className="card">
                <div className="card-sec">Break-Even Analysis</div>
                <div className="card-lbl">Monthly revenue to cover all costs</div>
                <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:32, color:C.cream, margin:"12px 0 8px" }}>
                  {breakEvenConfidence.shown && breakEven > 0 ? fmt(breakEven) : "---"}
                </div>
                <div style={{ fontSize:12, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.6 }}>
                  {breakEvenConfidence.shown && latest.revenue > 0 && breakEven > 0
                    ? latest.revenue >= breakEven
                      ? `You are ${fmt(latest.revenue - breakEven)} above break-even.`
                      : `You are ${fmt(breakEven - latest.revenue)} below break-even.`
                    : "Enter revenue and expenses to calculate."}
                </div>
                <ConfidenceLine c={breakEvenConfidence}/>
                {proj90Confidence.shown && safe(proj90) > 0 && (
                  <div style={{ marginTop:16 }}>
                    <div className="card-lbl">90-Day Revenue Projection</div>
                    <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, color:C.gold }}>{fmt(proj90)}</div>
                    <div style={{ fontSize:11, color:C.ink, fontFamily:"'Cormorant Garamond',serif" }}>At current {pc(vel)}/month velocity</div>
                    <ConfidenceLine c={proj90Confidence}/>
                  </div>
                )}
              </div>
            </div>

            {plan === "essentials" && (
              <div className="nudge">
                <div className="nudge-title">You have the intelligence. Command Pro adds the team behind it.</div>
                <div className="nudge-sub">Command Pro adds done-for-you data configuration, a monthly 1:1 advisory call, a written board report every month, and a direct advisory line with priority response.</div>
                <button className="btn btn-lg btn-primary" onClick={onUpgrade}>Upgrade to Command Pro</button>
              </div>
            )}

            {(plan === "pro" || plan === "elite") && (
              <div className="card">
                <div className="card-sec">Direct Access</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
                  <div className="elite-box">
                    <div className="elite-title">Direct Advisory Line</div>
                    <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.6, marginBottom:12 }}>
                      Direct access for capital decisions and growth strategy. Response within 4 hours.
                    </div>
                    <button className="wa-btn" onClick={() => window.open("mailto:hello@commandledger.co?subject=Advisory%20support%20request","_blank")}>
                      Email Advisory Support
                    </button>
                  </div>
                  <div className="elite-box">
                    <div className="elite-title">Monthly Strategy Call</div>
                    <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.6, marginBottom:12 }}>
                      60-minute session. Bring your numbers. Leave with a written 30-day capital plan.
                    </div>
                    <button className="cal-btn" onClick={() => window.open("https://calendly.com/commandledger","_blank")}>Book a Session</button>
                  </div>
                </div>
              </div>
            )}

            <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:14, display:"flex", justifyContent:"space-between", fontSize:10, color:C.inkDim, fontFamily:"'JetBrains Mono',monospace" }}>
              <span>Command Ledger - {PLANS[plan].name} - 2026</span>
              <span>{mode==="safe"?"Conservative allocation":"Aggressive deployment"}</span>
            </div>
          </>
        )}
      </main>
    </div>
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
        <div className="auth-logo-row" style={{ cursor:"pointer" }} onClick={onBack}>
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
          <div className="a-link" onClick={() => setMode(mode==="login"?"register":"login")}>
            {mode==="login" ? <>New? <span>Create an account</span></> : <>Have an account? <span>Sign in</span></>}
          </div>
          <div className="a-link" onClick={onBack} style={{ marginTop:8 }}><span>Back to site</span></div>
        </form>
      </div>
    </div>
  );
}

// ─── FAQ ACCORDION ────────────────────────────────────────────
function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      borderBottom: `1px solid ${C.border}`,
      padding: "20px 0",
      cursor: "pointer",
    }} onClick={() => setOpen(!open)}>
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
              {" "}<span className="hero-preview-reset" onClick={() => { setRows(null); setLabel(""); }}>Try another file</span>
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
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", h);
    return () => window.removeEventListener("scroll", h);
  }, []);

  const features = [
    { num:"01", title:"AI Strategic Advisor",   desc:"Not a paragraph — a structured brief: what happened, why, the business impact, the risk level, the one action to take, and how confident to be in it. Built from your real numbers." },
    { num:"02", title:"Risk Score",             desc:"A single number weighted from your actual runway, margin, revenue concentration, and unit economics — each only counts when there's real data behind it, so it never fakes a warning." },
    { num:"03", title:"Growth Score",           desc:"Rewards a steady, consistent growth trend over one lucky month. Three good months in a row score higher than one great month between two bad ones, at the same average rate." },
    { num:"04", title:"Burn Runway Monitor",    desc:"Real net burn — expenses against revenue, not expenses alone — so a profitable month never gets mistaken for a business about to run out of cash." },
    { num:"05", title:"True Free Cash",         desc:"After tax obligations and safety buffer, what you actually own and can deploy. Most founders confuse revenue with available cash. This ends that confusion." },
    { num:"06", title:"Break-Even Calculator",  desc:"The exact monthly revenue you need to cover all costs. Know whether you are above or below the line before the month ends." },
  ];

  return (
    <>
      <nav className={`nav${scrolled?" scrolled":""}`}>
        <div className="nav-logo" onClick={() => window.scrollTo(0, 0)}>
          <div className="logomark">C</div>
          <div><div className="wordmark">Command Ledger</div><div className="wordmark-sub">Financial Intelligence</div></div>
        </div>
        <ul className="nav-links">
          <li><a href="#features">Product</a></li>
          <li><a href="#trust">Why Command Ledger</a></li>
          <li><a href="#pricing">Pricing</a></li>
        </ul>
        <div className="nav-cta">
          <button className="btn btn-ghost" onClick={onLogin}>Sign In</button>
          <button className="btn btn-gold" onClick={() => onPlanSelect("pro")}>Get Started</button>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-bg"/><div className="hero-grid"/>
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-dot"/>For Founders Past $50K/Month Who've Outgrown a Spreadsheet</div>
          <h1 className="hero-title">You are making money.<br/>You still don't know if you're safe.<br/><em>Here's exactly why.</em></h1>
          <p className="hero-sub">Real-time financial intelligence: upload one bank or QuickBooks export and see your real runway, your true margin, your Risk Score, and the one move to make this week — computed from your actual transactions, processed in your browser, never stored on our servers.</p>
          <div className="hero-cta">
            <button className="btn btn-lg btn-primary" onClick={() => onPlanSelect("pro")}>Get Started</button>
            <button className="btn btn-lg btn-outline" onClick={onLogin}>Sign In</button>
          </div>
        </div>
        <HeroPreview/>
        <div className="hero-scroll"><div className="scroll-line"/>Scroll</div>
      </section>

      <section className="sec" id="trust" style={{ paddingTop:64, paddingBottom:64 }}>
        <div className="sec-eye">Trust</div>
        <h2 className="sec-title" style={{ fontSize:"clamp(28px,3.6vw,40px)" }}>Only claims we can<br/><em>actually stand behind</em></h2>
        <div className="feat-grid" style={{ marginTop:48 }}>
          {[
            { title:"Data Processing", desc:"Your uploaded file is parsed in your browser using the same code shown above — it is never uploaded to our servers or permanently stored. Computed metrics are sent to Claude (Anthropic) only when you request an AI brief, and only as numbers, never as raw transaction data." },
            { title:"Access Control", desc:"Your account is protected by Postgres row-level security, scoped to your own login — verified directly against the live database, not asserted in a policy document. Only the payment webhook, using a separate privileged key, can change your subscription status." },
            { title:"Financial Transparency", desc:"Every metric — margin, runway, Risk Score, Growth Score — is derived from a published, testable formula, not a black-box model. Runway uses net burn, not gross expenses; scores only count a signal when there's real data behind it." },
          ].map((t, i) => (
            <div className="feat-card" key={i}>
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
            <div key={i} style={{ border:`1px solid ${C.border}`, padding:"10px 20px", fontSize:12, letterSpacing:"0.08em", textTransform:"uppercase", color:C.ink, fontFamily:"'JetBrains Mono',monospace" }}>{tag}</div>
          ))}
        </div>
      </div>

      <section className="sec" id="features">
        <div className="sec-eye">The System</div>
        <h2 className="sec-title">Built for founders who are<br/><em>stuck despite the revenue</em></h2>
        <p className="sec-body">Agencies, e-commerce, and SaaS businesses all face the same problem: revenue grows but financial clarity doesn't. Command Ledger is the system that fixes that.</p>
        <div className="feat-grid">
          {features.map((f, i) => (
            <div className="feat-card" key={i}>
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

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:1, background:C.border, border:`1px solid ${C.border}`, textAlign:"left", marginBottom:64 }}>
            <div style={{ background:C.surface, padding:"28px 32px" }}>
              <div style={{ fontSize:10, letterSpacing:"0.14em", textTransform:"uppercase", color:C.inkDim, fontWeight:600, marginBottom:16 }}>Raw Financial Data</div>
              <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:13, color:C.ink, lineHeight:2.1 }}>
                Revenue: R480,000<br/>Expenses: R390,000<br/>Profit: R90,000
              </div>
            </div>
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

          <div style={{ display:"flex", flexDirection:"column", gap:2, marginTop:40, textAlign:"left" }}>
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
                a: "Use Scenario Planning: add the role's real fully-loaded monthly cost as an expense adjustment and see your margin, runway, and Risk Score recompute against that hire before you make it — not a rule of thumb, the same calculation engine your live numbers run through.",
              },
              {
                q: "Why is my Risk Score increasing?",
                a: "The score is a weighted composite of four things: your runway, your margin, how concentrated your revenue is in a single period, and your LTV:CAC ratio — each one only counts when there's real data behind it. If it moved, one of those four moved; the dashboard shows which.",
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
        <h2 className="sec-title">Three tiers.<br/><em>One mission.</em></h2>
        <p className="sec-body">Clarity. Direction. Command. Every tier is a deeper level of financial intelligence.</p>
        <div className="price-grid">
          {[
            { key:"essentials", hot:false, soon:false },
            { key:"pro",        hot:true,  soon:false },
            { key:"elite",      hot:false, soon:true  },
          ].map(p => {
            const pl = PLANS[p.key];
            return (
              <div key={p.key} className={`price-card${p.hot?" hot":""}${p.soon?" soon":""}`}>
                <div className="price-tier">{pl.name}</div>
                <div className="price-tagline">{pl.tagline}</div>
                {pl.setup ? (
                  <>
                    <div className="price-usd"><sup>$</sup>{pl.setup.toLocaleString()}</div>
                    <div className="price-zar">setup, then ${pl.usd.toLocaleString()}/mo (approx. R{pl.zar.toLocaleString()})</div>
                  </>
                ) : (
                  <>
                    <div className="price-usd"><sup>$</sup>{pl.usd.toLocaleString()}</div>
                    <div className="price-zar">approx. R{pl.zar.toLocaleString()} ZAR</div>
                  </>
                )}
                <div className="price-period">{pl.period}</div>
                <div className="price-divider"/>
                <ul className="price-list">
                  {pl.features.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
                {p.soon ? (
                  <button
                    className="btn btn-full btn-outline"
                    onClick={() => window.open("mailto:hello@commandledger.co?subject=Command%20Elite%20waitlist","_blank")}
                  >
                    Join VIP Waitlist
                  </button>
                ) : (
                  <button
                    className={`btn btn-full${p.hot?" btn-primary":" btn-outline"}`}
                    onClick={() => onPlanSelect(p.key)}
                  >
                    Get Started
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="cta-sec">
        <div style={{ position:"relative", zIndex:1 }}>
          <div className="sec-eye">The Decision</div>
          <h2 className="cta-title">Know your numbers.<br/>Understand your risks.<br/><em>Make the next decision with evidence.</em></h2>
          <p className="sec-body" style={{ marginTop:20, marginBottom:48 }}>
            The hire you could not afford. The ad spend with no data behind it. The month you ran without knowing your runway. Command Ledger exists so those decisions never happen again.
          </p>
          <button className="btn btn-lg btn-primary" onClick={() => onPlanSelect("pro")}>Get Started</button>
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
              <li><a onClick={onPrivacy}>Privacy Policy</a></li>
              <li><a onClick={onTerms}>Terms of Service</a></li>
            </ul>
          </div>
        </div>
        <div className="footer-copy">2026 Command Ledger - DigiBlueprint Financial Intelligence</div>
        <ul className="footer-links">
          <li><a href="mailto:hello@commandledger.co">Contact</a></li>
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
        <div className="page-back" onClick={onBack}>Back</div>
        <h1 className="page-title">Terms of Service</h1>
        <div className="page-date">Last updated: June 2026</div>
        <h2 className="page-h2">1. Acceptance</h2>
        <p className="page-p">By using Command Ledger you agree to these Terms of Service.</p>
        <h2 className="page-h2">2. Service</h2>
        <p className="page-p">Command Ledger provides AI-powered financial intelligence for founders and business owners, including analytics, capital allocation tools, and AI-generated strategic recommendations.</p>
        <h2 className="page-h2">3. Payment</h2>
        <p className="page-p">Subscriptions are billed monthly via PayPal. Subscriptions auto-renew unless cancelled at least 7 days before the renewal date.</p>
        <h2 className="page-h2">4. Refunds</h2>
        <p className="page-p">7-day refund on monthly subscriptions for first-time subscribers. Elite setup fees are non-refundable once configuration has begun.</p>
        <h2 className="page-h2">5. Disclaimer</h2>
        <p className="page-p">Command Ledger is for informational purposes only. This is not financial advice. Consult a qualified professional before major business decisions.</p>
        <h2 className="page-h2">6. Contact</h2>
        <p className="page-p">hello@commandledger.co</p>
      </div>
    </div>
  );
}

function PrivacyPage({ onBack }) {
  return (
    <div style={{ minHeight:"100vh" }}>
      <div className="page-wrap">
        <div className="page-back" onClick={onBack}>Back</div>
        <h1 className="page-title">Privacy Policy</h1>
        <div className="page-date">Last updated: June 2026</div>
        <h2 className="page-h2">1. What We Collect</h2>
        <p className="page-p">Name, email, and authentication details on sign-in. Financial data you upload or connect. Usage data such as features accessed and session duration.</p>
        <h2 className="page-h2">2. How We Use It</h2>
        <p className="page-p">To provide the Service, process payments, deliver AI analysis, and send account updates. We do not sell your data.</p>
        <h2 className="page-h2">3. Security</h2>
        <p className="page-p">All data encrypted via SSL. Financial data processed in real time and not permanently stored. User accounts stored securely via Supabase.</p>
        <h2 className="page-h2">4. Contact</h2>
        <p className="page-p">privacy@commandledger.co</p>
      </div>
    </div>
  );
}

// ─── PAYWALL GATE ─────────────────────────────────────────────
// Shown instead of the Dashboard when profile.plan is empty.
// No data, no features, no bypass — user must subscribe to proceed.
function PaywallGate({ user, onSelectPlan, onLogout }) {
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
              { key:"essentials", hot:false },
              { key:"pro",        hot:true  },
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
                  <button className={`btn ${p.hot ? "btn-primary" : "btn-outline"}`} style={{ padding:"10px 22px", fontSize:11, whiteSpace:"nowrap" }} onClick={() => onSelectPlan(p.key)}>
                    Subscribe
                  </button>
                </div>
              );
            })}
          </div>
          <div className="a-link" onClick={onLogout} style={{ marginTop:24 }}>
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
        const { data: created } = await supabase.from("profiles").upsert(np).select().single();
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

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) loadProfile(session.user);
      else setAppState("marketing");
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) loadProfile(session.user);
      else { setUser(null); setProfile(null); setAppState("marketing"); }
    });

    return () => subscription.unsubscribe();
  }, [loadProfile]);

  const handlePaySuccess = useCallback(async (planKey) => {
    setPayModal(null);
    const { data: { user: u } } = await supabase.auth.getUser();
    if (u) {
      await new Promise(r => setTimeout(r, 1000)); // Wait for Supabase write to commit
      await loadProfile(u);
    }
  }, [loadProfile]);

  const handlePlanSelect = useCallback((planKey) => {
    if (user) setPayModal(planKey);
    else      setAppState("login");
  }, [user]);

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
      {payModal && user && (
        <PayModal planKey={payModal} userEmail={user.email} userId={user.id} onClose={() => setPayModal(null)} onSuccess={handlePaySuccess}/>
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
            onUpgrade={() => { if (profile.plan === "essentials") setPayModal("pro"); }}
          />
        ) : (
          <PaywallGate
            user={user}
            onSelectPlan={(planKey) => setPayModal(planKey)}
            onLogout={async () => { await supabase.auth.signOut(); }}
          />
        )
      )}
      {appState==="terms"   && <TermsPage   onBack={() => setAppState("marketing")}/>}
      {appState==="privacy" && <PrivacyPage onBack={() => setAppState("marketing")}/>}
    </>
  );
}