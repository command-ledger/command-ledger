import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } }
);

const PAYPAL_CLIENT_ID = import.meta.env.VITE_PAYPAL_CLIENT_ID;
// PRICES CHANGED -> these must be replaced with NEW PayPal Plan IDs
// matching the new $1,250/mo and $2,475/mo subscription prices.
// Elite has no checkout (VIP / Coming Soon - waitlist only), so no ID needed.
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
    features:["Everything in Essentials","Done-for-you data configuration","Monthly 1:1 advisory call","PDF board report delivered monthly","Direct WhatsApp advisory line","Priority 4-hour response SLA"],
  },
  elite: {
    name:"Command Elite", usd:3000, zar:54000, setup:7000, period:"setup + $3,000/mo",
    tagline:"VIP. White-glove financial command for market leaders.",
    comingSoon:true,
    features:["Everything in Pro","Dedicated account strategist","Custom AI model tuning on your data","Quarterly strategy session with founder","Direct line to founder (Khayelihle)","White-label option for agencies"],
  },
};

const fmt  = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(n)||0);
const pc   = n => `${(Number(n)||0).toFixed(1)}%`;
const safe = n => { const v=Number(n); return isNaN(v)||!isFinite(v)?0:v; };

const C = {
  bg:"#050709",surface:"#0A0D14",surfaceHigh:"#0F1320",
  border:"#161C2E",borderBright:"#243050",
  gold:"#BF9B5A",goldBright:"#D4B278",goldDim:"#6B5530",goldGlow:"rgba(191,155,90,0.12)",
  cream:"#F0E8D8",blue:"#4A7CF7",blueGlow:"rgba(74,124,247,0.1)",
  green:"#2ABF85",greenGlow:"rgba(42,191,133,0.1)",
  red:"#E84855",redGlow:"rgba(232,72,85,0.1)",
  amber:"#E8A020",amberGlow:"rgba(232,160,32,0.1)",
  ink:"#8898B8",inkDim:"#3A4A68",white:"#F4F7FF",
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
body{background:#050709;color:#F4F7FF;font-family:'Syne',sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden;}
::selection{background:#6B5530;color:#F0E8D8;}
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
.logomark{width:36px;height:36px;border:1px solid #BF9B5A;display:flex;align-items:center;justify-content:center;font-family:'Cormorant Garamond',serif;font-size:18px;color:#BF9B5A;position:relative;flex-shrink:0;}
.logomark::after{content:'';position:absolute;inset:4px;border:0.5px solid #6B5530;}
.wordmark{font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:500;color:#F0E8D8;letter-spacing:0.04em;}
.wordmark-sub{font-size:9px;color:#BF9B5A;letter-spacing:0.14em;text-transform:uppercase;}
.nav-links{display:flex;align-items:center;gap:32px;list-style:none;}
.nav-links a{font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#8898B8;text-decoration:none;transition:color 0.2s;cursor:pointer;}
.nav-links a:hover{color:#F0E8D8;}
.nav-cta{display:flex;align-items:center;gap:10px;}
.btn{font-family:'Syne',sans-serif;font-weight:700;cursor:pointer;border-radius:1px;transition:all 0.2s;letter-spacing:0.12em;text-transform:uppercase;border:none;}
.btn-ghost{font-size:11px;padding:8px 20px;background:transparent;border:1px solid #161C2E!important;color:#8898B8;}
.btn-ghost:hover{border-color:#BF9B5A!important;color:#BF9B5A;}
.btn-gold{font-size:11px;padding:8px 24px;background:#BF9B5A;border:1px solid #BF9B5A!important;color:#050709;}
.btn-gold:hover{background:#D4B278;}
.btn-lg{font-size:12px;padding:14px 40px;}
.btn-full{width:100%;padding:13px;font-size:11px;display:flex;align-items:center;justify-content:center;gap:8px;}
.btn-primary{background:#BF9B5A;border:1px solid #BF9B5A!important;color:#050709;}
.btn-primary:hover{background:#D4B278;transform:translateY(-1px);}
.btn-outline{background:transparent;border:1px solid #161C2E!important;color:#8898B8;}
.btn-outline:hover{border-color:#BF9B5A!important;color:#BF9B5A;}
.btn:disabled{opacity:0.45;cursor:default;transform:none!important;}
.spinner{width:16px;height:16px;border:2px solid #161C2E;border-top-color:#BF9B5A;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block;flex-shrink:0;}
.hero{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:120px 48px 80px;position:relative;overflow:hidden;}
.hero-bg{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 70% 60% at 50% 0%,rgba(191,155,90,0.07) 0%,transparent 60%);}
.hero-grid{position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(#161C2E 1px,transparent 1px),linear-gradient(90deg,#161C2E 1px,transparent 1px);background-size:80px 80px;mask-image:radial-gradient(ellipse 80% 80% at 50% 50%,black 0%,transparent 70%);opacity:0.4;}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#BF9B5A;font-weight:600;border:1px solid #6B5530;padding:6px 16px;margin-bottom:40px;animation:fadeUp 0.8s ease both;}
.eyebrow-dot{width:5px;height:5px;border-radius:50%;background:#BF9B5A;box-shadow:0 0 8px #BF9B5A;animation:pulse 2s infinite;}
.hero-title{font-family:'Cormorant Garamond',serif;font-size:clamp(52px,8vw,100px);font-weight:300;line-height:0.98;color:#F0E8D8;letter-spacing:-0.02em;margin-bottom:28px;animation:fadeUp 0.8s 0.1s ease both;}
.hero-title em{font-style:italic;color:#BF9B5A;}
.hero-sub{font-size:17px;line-height:1.75;color:#8898B8;max-width:540px;margin:0 auto 48px;font-family:'Cormorant Garamond',serif;font-weight:300;animation:fadeUp 0.8s 0.2s ease both;}
.hero-cta{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;animation:fadeUp 0.8s 0.3s ease both;}
.hero-scroll{position:absolute;bottom:40px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#3A4A68;}
.scroll-line{width:1px;height:40px;background:linear-gradient(to bottom,#BF9B5A,transparent);animation:scrollLine 2s ease-in-out infinite;}
.stats-bar{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid #161C2E;border-bottom:1px solid #161C2E;background:#0A0D14;}
.stat{padding:32px 40px;border-right:1px solid #161C2E;}
.stat:last-child{border-right:none;}
.stat-n{font-family:'Cormorant Garamond',serif;font-size:42px;font-weight:300;color:#BF9B5A;line-height:1;margin-bottom:8px;}
.stat-l{font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#8898B8;font-weight:600;}
.sec{padding:100px 48px;}
.sec-eye{font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#BF9B5A;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:12px;justify-content:center;}
.sec-eye::before,.sec-eye::after{content:'';flex:1;max-width:60px;height:1px;background:linear-gradient(to left,#6B5530,transparent);}
.sec-title{font-family:'Cormorant Garamond',serif;font-size:clamp(36px,5vw,58px);font-weight:300;line-height:1.08;color:#F0E8D8;letter-spacing:-0.01em;margin-bottom:20px;text-align:center;}
.sec-title em{font-style:italic;color:#BF9B5A;}
.sec-body{font-size:15px;line-height:1.85;color:#8898B8;max-width:560px;font-family:'Cormorant Garamond',serif;margin:0 auto;text-align:center;}
.feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#161C2E;border:1px solid #161C2E;margin-top:64px;}
.feat-card{background:#0A0D14;padding:40px 36px;transition:background 0.3s;position:relative;}
.feat-card:hover{background:#0F1320;}
.feat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(to right,transparent,#6B5530,transparent);opacity:0;transition:opacity 0.3s;}
.feat-card:hover::before{opacity:1;}
.feat-num{font-family:'JetBrains Mono',monospace;font-size:11px;color:#6B5530;letter-spacing:0.1em;margin-bottom:24px;}
.feat-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:500;color:#F0E8D8;margin-bottom:12px;}
.feat-desc{font-size:13px;line-height:1.75;color:#8898B8;font-family:'Cormorant Garamond',serif;}
.price-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:64px;max-width:1100px;margin-left:auto;margin-right:auto;}
.price-card{background:#0A0D14;border:1px solid #161C2E;padding:36px 32px;position:relative;overflow:hidden;transition:transform 0.3s;}
.price-card:hover{transform:translateY(-4px);}
.price-card.hot{border-color:#BF9B5A;}
.price-card.hot::after{content:'Most Popular';position:absolute;top:16px;right:16px;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#050709;background:#BF9B5A;padding:4px 10px;font-weight:700;font-family:'Syne',sans-serif;}
.price-card.soon{opacity:0.85;}
.price-card.soon::after{content:'VIP — Coming Soon';position:absolute;top:16px;right:16px;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#BF9B5A;background:transparent;border:1px solid #6B5530;padding:4px 10px;font-weight:700;font-family:'Syne',sans-serif;}
.price-tier{font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#BF9B5A;font-weight:600;margin-bottom:8px;}
.price-tagline{font-family:'Cormorant Garamond',serif;font-size:13px;color:#8898B8;margin-bottom:16px;font-style:italic;}
.price-usd{font-family:'Cormorant Garamond',serif;font-size:52px;font-weight:300;color:#F0E8D8;line-height:1;}
.price-usd sup{font-size:22px;vertical-align:top;margin-top:10px;display:inline-block;}
.price-zar{font-size:12px;color:#6B5530;margin:4px 0;font-family:'JetBrains Mono',monospace;}
.price-period{font-size:12px;color:#8898B8;margin-bottom:28px;font-family:'Cormorant Garamond',serif;}
.price-divider{height:1px;background:#161C2E;margin-bottom:24px;}
.price-list{list-style:none;margin-bottom:28px;}
.price-list li{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:#8898B8;margin-bottom:10px;font-family:'Cormorant Garamond',serif;line-height:1.5;}
.price-list li::before{content:'---';color:#BF9B5A;flex-shrink:0;font-family:'JetBrains Mono',monospace;font-size:11px;margin-top:2px;}
.testi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:64px;}
.testi-card{background:#0A0D14;border:1px solid #161C2E;padding:32px;transition:border-color 0.3s;}
.testi-card:hover{border-color:#6B5530;}
.testi-q{font-family:'Cormorant Garamond',serif;font-size:15px;line-height:1.85;color:#8898B8;margin-bottom:24px;font-style:italic;}
.testi-q strong{color:#F0E8D8;font-style:normal;}
.testi-author{display:flex;align-items:center;gap:12px;}
.testi-av{width:36px;height:36px;border-radius:50%;border:1px solid #6B5530;display:flex;align-items:center;justify-content:center;font-family:'Cormorant Garamond',serif;font-size:14px;color:#BF9B5A;background:#0F1320;flex-shrink:0;}
.testi-name{font-size:12px;font-weight:600;color:#F0E8D8;margin-bottom:2px;}
.testi-role{font-size:11px;color:#3A4A68;}
.cta-sec{padding:120px 48px;text-align:center;position:relative;overflow:hidden;border-top:1px solid #161C2E;}
.cta-sec::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 60% 60% at 50% 50%,rgba(191,155,90,0.07) 0%,transparent 70%);}
.cta-title{font-family:'Cormorant Garamond',serif;font-size:clamp(40px,6vw,72px);font-weight:300;color:#F0E8D8;line-height:1.08;margin-bottom:20px;}
.cta-title em{font-style:italic;color:#BF9B5A;}
.footer{border-top:1px solid #161C2E;padding:40px 48px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px;}
.footer-copy{font-size:11px;color:#3A4A68;font-family:'JetBrains Mono',monospace;}
.footer-links{display:flex;gap:24px;list-style:none;}
.footer-links a{font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#3A4A68;text-decoration:none;transition:color 0.2s;cursor:pointer;}
.footer-links a:hover{color:#8898B8;}
.overlay{position:fixed;inset:0;z-index:500;background:rgba(5,7,9,0.94);backdrop-filter:blur(16px);display:flex;align-items:center;justify-content:center;padding:24px;animation:fadeIn 0.2s ease;}
.modal{background:#0A0D14;border:1px solid #161C2E;width:100%;max-width:500px;position:relative;overflow:hidden;animation:slideDown 0.3s ease;}
.modal::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(to right,transparent,#BF9B5A,transparent);}
.modal-head{padding:22px 28px 18px;border-bottom:1px solid #161C2E;display:flex;align-items:center;justify-content:space-between;}
.modal-title{font-family:'Cormorant Garamond',serif;font-size:22px;color:#F0E8D8;}
.modal-x{background:none;border:none;color:#3A4A68;font-size:24px;cursor:pointer;line-height:1;padding:4px;transition:color 0.2s;}
.modal-x:hover{color:#F0E8D8;}
.modal-body{padding:28px;}
.plan-badge{background:#0F1320;border:1px solid #161C2E;padding:14px 18px;margin-bottom:22px;}
.plan-badge-name{font-size:10px;text-transform:uppercase;letter-spacing:0.14em;color:#BF9B5A;margin-bottom:4px;font-weight:600;}
.plan-badge-price{font-family:'Cormorant Garamond',serif;font-size:26px;color:#F0E8D8;}
.plan-badge-sub{font-size:11px;color:#3A4A68;font-family:'JetBrains Mono',monospace;margin-top:2px;}
.modal-secure{font-size:11px;color:#3A4A68;text-align:center;margin-top:14px;font-family:'Cormorant Garamond',serif;}
.pay-status{text-align:center;padding:28px 0;color:#8898B8;font-size:12px;font-family:'JetBrains Mono',monospace;}
.pay-err{background:rgba(232,72,85,0.1);border:1px solid #E84855;padding:10px 14px;font-size:12px;color:#E8A0A8;margin-top:12px;border-radius:2px;}
.auth-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;position:relative;background:#050709;}
.auth-page::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 60% 50% at 50% 30%,rgba(191,155,90,0.06) 0%,transparent 60%);}
.auth-card{background:#0A0D14;border:1px solid #161C2E;width:100%;max-width:420px;position:relative;overflow:hidden;animation:slideDown 0.4s ease;z-index:1;}
.auth-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(to right,transparent,#BF9B5A,transparent);}
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
.a-link span{color:#BF9B5A;text-decoration:underline;}
.fl{font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:#8898B8;margin-bottom:6px;display:block;font-weight:600;}
.fi{width:100%;background:#0F1320;border:1px solid #161C2E;color:#F4F7FF;padding:10px 14px;font-size:13px;font-family:'JetBrains Mono',monospace;outline:none;transition:border-color 0.2s;margin-bottom:14px;}
.fi:focus{border-color:#BF9B5A;}
.loading-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#050709;flex-direction:column;gap:16px;}
.loading-logo{font-family:'Cormorant Garamond',serif;font-size:48px;color:#BF9B5A;}
.loading-text{font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#3A4A68;}
.dash{min-height:100vh;background:#050709;display:grid;grid-template-columns:220px 1fr;grid-template-rows:64px 1fr;}
.sidebar{grid-row:1/3;background:#0A0D14;border-right:1px solid #161C2E;display:flex;flex-direction:column;}
.sidebar-logo{height:64px;border-bottom:1px solid #161C2E;display:flex;align-items:center;gap:10px;padding:0 20px;}
.sb-nav{padding:24px 0;flex:1;}
.sb-sec{font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#3A4A68;padding:8px 20px 4px;font-weight:600;}
.sb-item{display:flex;align-items:center;gap:10px;padding:10px 20px;cursor:pointer;font-size:12px;letter-spacing:0.06em;color:#8898B8;transition:all 0.15s;border-left:2px solid transparent;font-weight:500;}
.sb-item:hover{color:#F0E8D8;background:#0F1320;}
.sb-item.on{color:#BF9B5A;background:rgba(191,155,90,0.12);border-left-color:#BF9B5A;}
.sb-item.locked{opacity:0.35;cursor:default;}
.sb-item.locked:hover{color:#8898B8;background:transparent;}
.sb-icon{font-size:14px;width:18px;text-align:center;}
.sb-foot{padding:16px 20px;border-top:1px solid #161C2E;}
.sb-user{display:flex;align-items:center;gap:10px;}
.sb-av{width:36px;height:36px;border-radius:50%;background:rgba(191,155,90,0.12);border:1px solid #6B5530;display:flex;align-items:center;justify-content:center;font-size:14px;color:#BF9B5A;overflow:hidden;flex-shrink:0;}
.sb-av img{width:100%;height:100%;object-fit:cover;border-radius:50%;}
.sb-name{font-size:12px;color:#F0E8D8;font-weight:600;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sb-plan{font-size:9px;color:#BF9B5A;text-transform:uppercase;letter-spacing:0.1em;background:rgba(191,155,90,0.12);padding:2px 6px;margin-top:2px;display:inline-block;}
.topbar{grid-column:2;height:64px;border-bottom:1px solid #161C2E;display:flex;align-items:center;justify-content:space-between;padding:0 32px;background:rgba(5,7,9,0.6);backdrop-filter:blur(16px);}
.breadcrumb{font-size:11px;color:#3A4A68;letter-spacing:0.08em;}
.breadcrumb span{color:#F0E8D8;}
.tb-right{display:flex;align-items:center;gap:14px;}
.live-badge{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;}
.live-dot{width:6px;height:6px;border-radius:50%;animation:pulse 2s infinite;}
.mode-pills{display:flex;border:1px solid #161C2E;overflow:hidden;}
.mpill{padding:5px 14px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;background:transparent;border:none;color:#3A4A68;cursor:pointer;font-family:'Syne',sans-serif;transition:all 0.15s;}
.mpill.on{background:#0F1320;color:#BF9B5A;}
.dash-body{grid-column:2;padding:28px 32px;overflow-y:auto;display:flex;flex-direction:column;gap:20px;}
.card{background:#0A0D14;border:1px solid #161C2E;padding:22px;position:relative;overflow:hidden;transition:border-color 0.2s;}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(to right,transparent,rgba(191,155,90,0.12),transparent);}
.card:hover{border-color:#243050;}
.card-sec{font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#BF9B5A;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px;}
.card-sec::after{content:'';flex:1;height:1px;background:linear-gradient(to right,#6B5530,transparent);max-width:80px;}
.card-lbl{font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#3A4A68;font-weight:600;margin-bottom:4px;}
.val{font-family:'Cormorant Garamond',serif;font-size:36px;font-weight:300;line-height:1;letter-spacing:-0.01em;}
.val.g{color:#BF9B5A;}.val.gr{color:#2ABF85;}.val.b{color:#4A7CF7;}.val.r{color:#E84855;}.val.a{color:#E8A020;}
.delta{margin-top:8px;font-size:11px;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;gap:4px;}
.up{color:#2ABF85;}.dn{color:#E84855;}.nu{color:#3A4A68;}
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
.indicator.gold{border-left:2px solid #BF9B5A;}
.directive-box{background:linear-gradient(135deg,rgba(191,155,90,0.06) 0%,rgba(5,7,9,0) 60%);border:1px solid #6B5530;padding:24px;position:relative;overflow:hidden;}
.directive-box::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(to right,transparent,#BF9B5A,transparent);}
.ai-top{padding:12px 20px;border-bottom:1px solid #161C2E;display:flex;align-items:center;justify-content:space-between;}
.ai-lbl{display:flex;align-items:center;gap:8px;font-size:10px;text-transform:uppercase;letter-spacing:0.14em;color:#3A4A68;font-weight:600;}
.ai-glow{width:6px;height:6px;border-radius:50%;background:#BF9B5A;box-shadow:0 0 10px #BF9B5A;}
.ai-body{padding:20px;min-height:90px;}
.ai-txt{font-family:'Cormorant Garamond',serif;font-size:15px;line-height:2;color:#8898B8;font-style:italic;}
.ai-txt p{margin-bottom:14px;}.ai-txt p:last-child{margin-bottom:0;}
.ai-txt strong{color:#F0E8D8;font-style:normal;font-weight:500;}
.ai-dots{display:flex;gap:6px;align-items:center;}
.ai-dots span{width:6px;height:6px;border-radius:50%;background:#6B5530;animation:dotPulse 1.4s ease-in-out infinite;}
.ai-dots span:nth-child(2){animation-delay:0.2s;}.ai-dots span:nth-child(3){animation-delay:0.4s;}
.ai-btn{background:transparent;border:1px solid #161C2E;color:#3A4A68;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;padding:5px 14px;cursor:pointer;font-family:'Syne',sans-serif;transition:all 0.2s;}
.ai-btn:hover{border-color:#BF9B5A;color:#BF9B5A;}
.ai-btn:disabled{opacity:0.4;cursor:default;}
.di-lbl{font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#8898B8;margin-bottom:5px;display:block;}
.di{background:#0F1320;border:1px solid #161C2E;color:#F4F7FF;padding:8px 12px;font-size:12px;font-family:'JetBrains Mono',monospace;outline:none;transition:border-color 0.2s;width:100%;}
.di:focus{border-color:#BF9B5A;}
.input-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;}
.input-group{display:flex;flex-direction:column;}
.drop-zone{border:2px dashed #161C2E;background:#0F1320;padding:40px 24px;text-align:center;cursor:pointer;transition:all 0.2s;border-radius:2px;}
.drop-zone:hover,.drop-zone.drag{border-color:#BF9B5A;background:rgba(191,155,90,0.06);}
.drop-zone-title{font-family:'Cormorant Garamond',serif;font-size:20px;color:#F0E8D8;margin-bottom:8px;}
.drop-zone-sub{font-size:12px;color:#8898B8;line-height:1.6;}
.upload-ok{background:rgba(42,191,133,0.1);border:1px solid #2ABF85;padding:14px 18px;display:flex;align-items:center;gap:12px;}
.upload-ok-txt{font-size:13px;color:#80C8A8;font-family:'Cormorant Garamond',serif;}
.nudge{background:#0F1320;border:1px solid #161C2E;padding:28px;text-align:center;position:relative;overflow:hidden;}
.nudge::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(to right,transparent,#BF9B5A,transparent);}
.nudge-title{font-family:'Cormorant Garamond',serif;font-size:20px;color:#F0E8D8;margin-bottom:8px;}
.nudge-sub{font-size:13px;color:#8898B8;font-family:'Cormorant Garamond',serif;line-height:1.6;margin-bottom:20px;max-width:400px;margin-left:auto;margin-right:auto;}
.elite-box{background:#0F1320;border:1px solid #6B5530;padding:20px;margin-top:14px;}
.elite-title{font-size:10px;text-transform:uppercase;letter-spacing:0.16em;color:#BF9B5A;margin-bottom:12px;font-weight:600;}
.wa-btn{display:flex;align-items:center;justify-content:center;gap:10px;background:#25D366;border:none;color:white;padding:11px 20px;font-size:12px;font-family:'Syne',sans-serif;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;width:100%;transition:all 0.2s;}
.wa-btn:hover{background:#20c05a;}
.cal-btn{display:flex;align-items:center;justify-content:center;gap:10px;background:transparent;border:1px solid #BF9B5A;color:#BF9B5A;padding:11px 20px;font-size:12px;font-family:'Syne',sans-serif;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;width:100%;transition:all 0.2s;margin-top:8px;}
.cal-btn:hover{background:rgba(191,155,90,0.12);}
.page-wrap{max-width:760px;margin:0 auto;padding:120px 48px 80px;}
.page-title{font-family:'Cormorant Garamond',serif;font-size:clamp(36px,5vw,56px);font-weight:300;color:#F0E8D8;margin-bottom:8px;}
.page-date{font-size:11px;color:#3A4A68;font-family:'JetBrains Mono',monospace;margin-bottom:48px;}
.page-h2{font-family:'Cormorant Garamond',serif;font-size:24px;color:#F0E8D8;margin:40px 0 12px;}
.page-p{font-size:14px;line-height:1.85;color:#8898B8;font-family:'Cormorant Garamond',serif;margin-bottom:16px;}
.page-back{display:inline-flex;align-items:center;gap:8px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#8898B8;cursor:pointer;margin-bottom:40px;transition:color 0.2s;}
.page-back:hover{color:#BF9B5A;}
@media(max-width:960px){
  .feat-grid,.price-grid,.testi-grid,.kpi4,.kpi3,.g3{grid-template-columns:1fr 1fr;}
  .stats-bar{grid-template-columns:repeat(2,1fr);}
  .g2,.g21,.input-grid{grid-template-columns:1fr;}
  .dash{grid-template-columns:1fr;grid-template-rows:64px auto 1fr;}
  .sidebar{display:none;}
  .topbar,.dash-body{grid-column:1;}
  .nav-links{display:none;}
  .nav,.hero,.sec,.cta-sec{padding-left:24px;padding-right:24px;}
  .footer{padding:32px 24px;}
}
@media(max-width:600px){
  .feat-grid,.price-grid,.testi-grid,.kpi4,.kpi3,.g3{grid-template-columns:1fr;}
  .stats-bar{grid-template-columns:1fr 1fr;}
}
`;

// ─── SMART COLUMN MAPPER ─────────────────────────────────────
const COL_PATTERNS = {
  revenue:  ["revenue","income","sales","total sales","gross sales","total income","turnover","receipts","invoiced","earnings"],
  expenses: ["expenses","expense","costs","total costs","total expenses","outgoings","expenditure","spend","overheads","payments","disbursements"],
  cogs:     ["cogs","cost of goods","cost of sales","direct costs","product cost","cost of revenue"],
  payroll:  ["payroll","salaries","wages","staff costs","personnel","labor","labour"],
  marketing:["marketing","advertising","ad spend","ads","promotion","marketing spend","paid media"],
  cash:     ["cash","cash balance","bank balance","liquid","cash on hand","balance","closing balance"],
  cac:      ["cac","customer acquisition cost","acquisition cost","cost per customer","cost per acquisition"],
  ltv:      ["ltv","lifetime value","customer lifetime value","clv","customer value"],
  leads:    ["leads","prospects","enquiries","inquiries","new leads","pipeline entries","opportunities"],
  closures: ["closures","closed","deals closed","won","conversions","new customers","new clients","signed"],
  refunds:  ["refunds","returns","chargebacks","reversals","credit notes"],
  month:    ["month","period","date","time period","week","quarter","month/year"],
};

const matchColumn = (header) => {
  const h = header.toLowerCase().trim().replace(/[_-]/g," ");
  for (const [field, patterns] of Object.entries(COL_PATTERNS)) {
    if (patterns.some(p => h.includes(p) || p.includes(h))) return field;
  }
  return null;
};

const parseAnyCSV = (text) => {
  const rows = text.trim().split(/\r?\n/).map(r => {
    const cols = []; let cur = ""; let inQ = false;
    for (const ch of r) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  }).filter(r => r.some(c => c.length > 0));

  if (rows.length < 2) return null;
  const headers = rows[0];
  const mapping = {};
  headers.forEach((h, i) => {
    const f = matchColumn(h);
    if (f && !(f in mapping)) mapping[f] = i;
  });

  const getNum = (row, field) => {
    if (!(field in mapping)) return 0;
    const v = row[mapping[field]];
    const n = Number(String(v || "0").replace(/[$,\s%R]/g, "").replace(/\((.+)\)/, "-$1"));
    return isNaN(n) ? 0 : Math.abs(n);
  };
  const getStr = (row, field, fb) => {
    if (!(field in mapping)) return fb;
    return String(row[mapping[field]] || fb).trim().substring(0, 20);
  };

  const data = rows.slice(1).map((row, i) => {
    let rev = getNum(row, "revenue");
    let exp = getNum(row, "expenses");
    const cogs = getNum(row, "cogs");
    const pay  = getNum(row, "payroll");
    const mkt  = getNum(row, "marketing");
    if (exp === 0 && (cogs + pay + mkt) > 0) exp = cogs + pay + mkt;
    return {
      month:    getStr(row, "month", `Period ${i + 1}`),
      revenue:  rev,
      expenses: exp,
      cogs,
      payroll:  pay,
      marketing:mkt,
      cash:     getNum(row, "cash"),
      leads:    getNum(row, "leads"),
      closures: getNum(row, "closures"),
      refunds:  getNum(row, "refunds"),
      cac:      getNum(row, "cac"),
      ltv:      getNum(row, "ltv"),
    };
  }).filter(r => r.revenue > 0 || r.expenses > 0);

  return { rows: data, detectedFields: Object.keys(mapping) };
};

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
function Directive({ metrics }) {
  const { margin, burnMonths, free, concentration, vel, conv, hireReady, ltvcac } = metrics;

  const getDirective = () => {
    if (safe(free) < 0) return {
      text: "Cut all non-essential spend before end of this week.",
      reason: `Your True Free Cash is ${fmt(free)}. After tax obligations and safety buffer, you owe more than you earn. Every day of inaction erodes your position further.`,
      severity: "critical",
    };
    if (safe(burnMonths) > 0 && safe(burnMonths) < 3) return {
      text: "Protect your runway. You have less than 3 months.",
      reason: `At current burn rate you have ${safe(burnMonths).toFixed(1)} months before the business runs dry. Suspend all non-revenue-generating spend immediately.`,
      severity: "critical",
    };
    if (safe(concentration) > 60) return {
      text: "Diversify your revenue before growing it.",
      reason: `${pc(concentration)} of revenue is over-concentrated. One client exit or contract loss exposes the entire business. This is not visible until it is catastrophic.`,
      severity: "warn",
    };
    if (safe(ltvcac) > 0 && safe(ltvcac) < 3) return {
      text: "Fix unit economics before increasing acquisition spend.",
      reason: `LTV:CAC at ${safe(ltvcac).toFixed(1)}x means every new customer acquired costs more than it sustainably returns. Spending more on acquisition accelerates the loss.`,
      severity: "warn",
    };
    if (safe(conv) > 0 && safe(conv) < 10) return {
      text: "Fix the sales funnel before generating more leads.",
      reason: `Converting ${pc(conv)} of leads signals a broken process or a mismatched offer. More leads through a broken funnel wastes budget and time.`,
      severity: "warn",
    };
    if (safe(margin) > 40 && safe(conv) > 20) return {
      text: "Scale lead acquisition now. Your funnel is ready.",
      reason: `Margin at ${pc(margin)} and conversion at ${pc(conv)} are both above threshold. This is a deployment window. Increase lead volume 30% --- the economics support it.`,
      severity: "go",
    };
    if (hireReady) return {
      text: "You can afford the next hire. Move within 30 days.",
      reason: `True Free Cash supports additional headcount for 6+ months. The opportunity cost of not hiring now exceeds the cost of hiring.`,
      severity: "go",
    };
    if (safe(vel) < 5 && safe(vel) >= 0) return {
      text: "Revenue growth has stalled. Find the constraint this week.",
      reason: `Velocity at ${pc(vel)}/month signals a blockage --- pipeline, conversion, or retention. Diagnose before spending more on growth.`,
      severity: "warn",
    };
    return {
      text: "Maintain trajectory. Increase lead volume by 20%.",
      reason: `Fundamentals are stable. The highest-ROI move at this position is controlled growth through the same funnel that is already converting.`,
      severity: "stable",
    };
  };

  const d = getDirective();
  const uc = { critical:C.red, warn:C.amber, go:C.green, stable:C.gold }[d.severity];

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
    onDataLoaded(result.rows, source, result.detectedFields);
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
        if (!window.XLSX) {
          await new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
            s.onload = res; s.onerror = rej;
            document.head.appendChild(s);
          });
        }
        const buf = await file.arrayBuffer();
        const wb  = window.XLSX.read(buf, { type:"array" });
        const ws  = wb.Sheets[wb.SheetNames[0]];
        const csv = window.XLSX.utils.sheet_to_csv(ws);
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
function PayModal({ planKey, userEmail, userID, onClose, onSuccess }) {
  const plan = PLANS[planKey];
  const btnRef   = useRef(null);
  const rendered = useRef(false);
  const [sdkReady, setSdkReady] = useState(false);
  const [sdkErr,   setSdkErr]   = useState("");
  const [done,     setDone]     = useState(false);

  useEffect(() => {
    rendered.current = false;
    // Remove previous SDK to force fresh load
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
          plan_id: PAYPAL_PLANS[planKey],
          custom_id: userId 
        }),
      onApprove: async (data) => {
        // Securely handled by your backend webhook now. 
        // The browser no longer writes directly to the database.
        setDone(true);
        onSuccess(planKey);
      },
      onError: err => {
        console.error("PayPal error:", err);
        setSdkErr("Payment failed. Please try again.");
      },
    }).render(btnRef.current).catch(e => {
      setSdkErr(`PayPal could not render. Ensure your Plan IDs match your PayPal environment (sandbox vs live). Error: ${e.message}`);
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
  const [aiText,   setAiText]   = useState("");
  const [aiLoad,   setAiLoad]   = useState(false);
  // Manual input state
  const [mRev,  setMRev]  = useState(0);
  const [mExp,  setMExp]  = useState(0);
  const [mCash, setMCash] = useState(0);
  const [mCac,  setMCac]  = useState(0);
  const [mLtv,  setMLtv]  = useState(0);
  const [mLeads, setMLeads] = useState(0);
  const [mClose, setMClose] = useState(0);

  const plan = profile?.plan || "essentials";
  const userName  = profile?.name || user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Founder";
  const userAvatar = user?.user_metadata?.avatar_url;
  const tr = mode === "safe" ? 0.30 : 0.25;
  const sr = mode === "safe" ? 0.20 : 0.10;

  const rows     = data && data.length > 0 ? data : null;
  const latest   = rows ? rows[rows.length - 1] : { revenue:mRev, expenses:mExp };
  const prev     = rows && rows.length > 1 ? rows[rows.length - 2] : latest;
  const totRev   = rows ? rows.reduce((s,d) => s + d.revenue, 0)  : mRev;
  const totExp   = rows ? rows.reduce((s,d) => s + d.expenses, 0) : mExp;
  const totCogs  = rows ? rows.reduce((s,d) => s + (d.cogs||0), 0) : 0;
  const totMkt   = rows ? rows.reduce((s,d) => s + (d.marketing||0), 0) : 0;
  const totL     = rows ? rows.reduce((s,d) => s + (d.leads||0), 0) : mLeads;
  const totC     = rows ? rows.reduce((s,d) => s + (d.closures||0), 0) : mClose;
  const activeCash = rows ? (latest.cash || mCash) : mCash;
  const activeCac  = rows ? (latest.cac  || mCac)  : mCac;
  const activeLtv  = rows ? (latest.ltv  || mLtv)  : mLtv;

  const n = rows?.length || 1;
  const totPro   = totRev - totExp;
  const margin   = totRev > 0 ? (totPro / totRev) * 100 : 0;
  const vel      = prev.revenue > 0 ? ((latest.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  const conv     = totL > 0 ? (totC / totL) * 100 : 0;
  const ltvcac   = activeCac > 0 ? activeLtv / activeCac : 0;
  const cogsRatio = totRev > 0 ? (totCogs / totRev) * 100 : 0;
  const mktRatio  = totRev > 0 ? (totMkt  / totRev) * 100 : 0;
  const sov       = Math.min(100, Math.max(0, (margin * 0.6) + (Math.min(conv, 100) * 0.4)));
  const sovLbl    = sov >= 75 ? "Sovereign" : sov >= 50 ? "Stabilizing" : sov >= 30 ? "Defensive" : "Critical";
  const taxV      = totPro * tr;
  const safV      = totPro * sr;
  const free      = totPro - taxV - safV;
  const avgExp    = totExp / n;
  const burnMonths = avgExp > 0 ? (activeCash + safV) / avgExp : 0;
  const hireReady  = free > 25000 * 6;
  const maxRev     = rows ? Math.max(...rows.map(d => d.revenue), 1) : latest.revenue;
  const concentration = totRev > 0 ? (maxRev / totRev) * 100 : 0;
  const breakEven  = totExp > 0 && margin > 0 ? totExp / (margin / 100) : 0;
  const proj90     = latest.revenue * Math.pow(1 + vel / 100, 3);
  const hasData    = rows !== null || mRev > 0;
  const metrics    = { margin, vel, conv, sov, free, burnMonths, hireReady, concentration, ltvcac };

  const alert = (() => {
    if (!hasData) return { t:"info", msg:"Connect your financial data in the Data tab to activate your command center." };
    if (safe(free) < 0) return { t:"crit", msg:"True Free Cash is negative. Overhead exceeds liquidity after obligations. Cut costs before next cycle." };
    if (safe(burnMonths) > 0 && safe(burnMonths) < 3) return { t:"crit", msg:`Runway is ${safe(burnMonths).toFixed(1)} months. Below the 3-month danger threshold. Protect cash immediately.` };
    if (safe(concentration) > 60) return { t:"warn", msg:`Revenue concentration at ${pc(concentration)} is high. One client loss could collapse cash flow.` };
    if (safe(ltvcac) > 0 && safe(ltvcac) < 3) return { t:"warn", msg:`LTV:CAC at ${safe(ltvcac).toFixed(1)}x. Below the 3x minimum. Fix unit economics before scaling acquisition spend.` };
    if (safe(margin) > 40 && safe(conv) > 20) return { t:"ok", msg:"Margin and conversion both strong. You are in a deployment window. Increase lead volume now." };
    return { t:"info", msg:"Foundation stable. Maintain velocity and watch your runway." };
  })();

  const runAI = async () => {
    setAiLoad(true); setAiText("");
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
          burnRunway:     burnMonths.toFixed(1),
          ltvCacRatio:    ltvcac.toFixed(2),
          cogsRatio:      cogsRatio.toFixed(1),
          marketingRatio: mktRatio.toFixed(1),
          hireReady,
          concentration:  concentration.toFixed(1),
          breakEven:      breakEven.toFixed(0),
          proj90:         proj90.toFixed(0),
          plan,
          mode,
          dataMonths:     n,
        },
      });
      if (error) throw error;
      setAiText(result?.analysis || result?.text || "Analysis complete but no response returned.");
    } catch (e) {
      console.error("AI error:", e);
      setAiText("Advisory engine offline. Ensure your Supabase Edge Function is deployed and ANTHROPIC_API_KEY is set in Supabase project secrets.");
    }
    setAiLoad(false);
  };

  const navItems = [
    { id:"overview", label:"Overview",    locked:false },
    { id:"advisor",  label:"AI Advisor",  locked:false },
    { id:"data",     label:"Connect Data",locked:false },
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
        <div className="breadcrumb">Command Ledger / <span>{tab==="data"?"Connect Data":tab==="advisor"?"AI Advisor":PLANS[plan].name}</span></div>
        <div className="tb-right">
          <div className="live-badge">
            <div className="live-dot" style={{ background:hasData?C.green:C.amber, boxShadow:`0 0 8px ${hasData?C.green:C.amber}` }}/>
            <span style={{ color:hasData?C.green:C.amber }}>{hasData ? `Live - ${dataSource||"Manual Input"}` : "No data"}</span>
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
                onDataLoaded={(r, src, cols) => { setData(r); setDataSource(src); setDetectedCols(cols); setTab("overview"); }}
              />
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
                    <input className="di" type="number" value={f.v} onChange={e => f.s(Number(e.target.value))}/>
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
              <div className="ai-body">
                {aiLoad ? (
                  <div style={{ display:"flex", alignItems:"center", gap:12, color:C.inkDim, fontSize:12, fontFamily:"'JetBrains Mono',monospace" }}>
                    <div className="ai-dots"><span/><span/><span/></div>Analyzing your financial position...
                  </div>
                ) : (
                  <div className="ai-txt" dangerouslySetInnerHTML={{ __html:
                    (aiText || "Click Generate Brief to receive your personalised weekly strategic directive.")
                      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                      .split("\n\n").filter(Boolean).map(p => `<p>${p}</p>`).join("")
                  }}/>
                )}
              </div>
            </div>
            {!hasData && (
              <div className="d-alert info">Connect your financial data first. The AI brief uses your real numbers, not generic advice.</div>
            )}
          </>
        )}

        {tab === "overview" && (
          <>
            <div className={`d-alert ${alert.t}`}>{alert.msg}</div>

            {hasData && <Directive metrics={metrics}/>}

            <div>
              <div className="card-sec">Core Vitals</div>
              <div className="kpi4">
                {[
                  { lbl:"Monthly Revenue",  val:fmt(latest.revenue), col:"g",  d:`${pc(vel)} velocity`,     dt:vel>=0?"up":"dn" },
                  { lbl:"Profit Margin",    val:pc(margin),          col:"gr", d:`${fmt(totPro)} net profit`, dt:margin>0?"up":"dn" },
                  { lbl:"True Free Cash",   val:fmt(free),           col:free>=0?"g":"r", d:"After tax + safety", dt:free>=0?"up":"dn" },
                  { lbl:"Burn Runway",      val:burnMonths>0?`${safe(burnMonths).toFixed(1)}mo`:"---",
                    col:burnMonths>=6?"gr":burnMonths>=3?"a":"r",
                    d:burnMonths>=6?"Safe":"Needs attention",
                    dt:burnMonths>=6?"up":"dn" },
                ].map((m, i) => (
                  <div key={i} className="card"
                    onMouseEnter={e => e.currentTarget.style.transform = "translateY(-2px)"}
                    onMouseLeave={e => e.currentTarget.style.transform = ""}
                    style={{ transition:"transform 0.2s", cursor:"default" }}>
                    <div className="card-lbl">{m.lbl}</div>
                    <div className={`val ${m.col}`}>{m.val}</div>
                    <div className={`delta ${m.dt}`}>{m.dt==="up"?"+":"-"} {m.d}</div>
                  </div>
                ))}
              </div>
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
                      Margin ({pc(margin*0.6)}) + Conversion ({pc(conv*0.4)}). Above 75 triggers aggressive scale posture.
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="card-sec">Business Intelligence</div>
              <div className="g3">
                {[
                  {
                    lbl:"Burn Runway",
                    val: burnMonths > 0 ? `${safe(burnMonths).toFixed(1)} months` : "---",
                    sub: burnMonths>=6?"Safe - above 6-month threshold":burnMonths>=3?"Caution - build to 6 months":burnMonths>0?"Danger - act immediately":"Enter cash balance to calculate",
                    cls: burnMonths>=6?"green":burnMonths>=3?"amber":burnMonths>0?"red":"gold",
                    col: burnMonths>=6?C.green:burnMonths>=3?C.amber:burnMonths>0?C.red:C.gold,
                  },
                  {
                    lbl:"Hire Readiness",
                    val: hireReady ? "Ready" : "Not Yet",
                    sub: hireReady ? "Free cash supports new headcount" : `Need ${fmt(Math.max(0, 25000*6-free))} more in free cash`,
                    cls: hireReady ? "green" : "amber",
                    col: hireReady ? C.green : C.amber,
                  },
                  {
                    lbl:"LTV : CAC Ratio",
                    val: ltvcac > 0 ? `${safe(ltvcac).toFixed(1)}x` : "---",
                    sub: ltvcac>=3?"Healthy - above 3x threshold":ltvcac>0?"Below 3x - fix before scaling":"Enter CAC and LTV in data",
                    cls: ltvcac>=3?"green":ltvcac>0?"amber":"gold",
                    col: ltvcac>=3?C.green:ltvcac>0?C.amber:C.gold,
                  },
                ].map((ind, i) => (
                  <div key={i} className={`indicator ${ind.cls}`}>
                    <div className="card-lbl">{ind.lbl}</div>
                    <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:28, color:ind.col, marginBottom:6 }}>{ind.val}</div>
                    <div style={{ fontSize:12, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.5 }}>{ind.sub}</div>
                  </div>
                ))}
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
                  {breakEven > 0 ? fmt(breakEven) : "---"}
                </div>
                <div style={{ fontSize:12, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.6 }}>
                  {latest.revenue > 0 && breakEven > 0
                    ? latest.revenue >= breakEven
                      ? `You are ${fmt(latest.revenue - breakEven)} above break-even.`
                      : `You are ${fmt(breakEven - latest.revenue)} below break-even.`
                    : "Enter revenue and expenses to calculate."}
                </div>
                {safe(proj90) > 0 && (
                  <div style={{ marginTop:16 }}>
                    <div className="card-lbl">90-Day Revenue Projection</div>
                    <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:22, color:C.gold }}>{fmt(proj90)}</div>
                    <div style={{ fontSize:11, color:C.ink, fontFamily:"'Cormorant Garamond',serif" }}>At current {pc(vel)}/month velocity</div>
                  </div>
                )}
              </div>
            </div>

            {plan === "essentials" && (
              <div className="nudge">
                <div className="nudge-title">You have the intelligence. Command Pro adds the team behind it.</div>
                <div className="nudge-sub">Command Pro adds done-for-you data configuration, a monthly 1:1 advisory call, a PDF board report delivered every month, and a direct WhatsApp line with priority response.</div>
                <button className="btn btn-lg btn-primary" onClick={onUpgrade}>Upgrade to Command Pro</button>
              </div>
            )}

            {(plan === "pro" || plan === "elite") && (
              <div className="card">
                <div className="card-sec">Direct Access</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
                  <div className="elite-box">
                    <div className="elite-title">WhatsApp Advisory Line</div>
                    <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.6, marginBottom:12 }}>
                      Direct access for capital decisions and growth strategy. Response within 4 hours.
                    </div>
                    <button className="wa-btn" onClick={() => window.open("https://wa.me/27810068255?text=Hi%2C+I+need+advisory+support+for+my+Command+Ledger+account","_blank")}>
                      Open WhatsApp
                    </button>
                  </div>
                  <div className="elite-box">
                    <div className="elite-title">Monthly Strategy Call</div>
                    <div style={{ fontSize:13, color:C.ink, fontFamily:"'Cormorant Garamond',serif", lineHeight:1.6, marginBottom:12 }}>
                      60-minute session. Bring your numbers. Leave with a written 30-day capital plan.
                    </div>
                    <button className="cal-btn" onClick={() => window.open("https://calendly.com/commandledger/new-meeting","_blank")}>Book a Session</button>
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErr(""); setMsg(""); setLoading(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
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

// ─── MARKETING SITE ───────────────────────────────────────────
function MarketingSite({ onLogin, onPlanSelect, onTerms, onPrivacy }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", h);
    return () => window.removeEventListener("scroll", h);
  }, []);

  const features = [
    { num:"01", title:"Burn Runway Monitor",     desc:"Exactly how many months before the business dies at current spend. Not an estimate. A live calculation updated every time your numbers change." },
    { num:"02", title:"True Free Cash",           desc:"After tax obligations and safety buffer, what you actually own and can deploy. Most founders confuse revenue with available cash. This ends that confusion." },
    { num:"03", title:"This Week's Directive",    desc:"Not a report. One sentence telling you the single most important financial move to make this week --- built from your real numbers, not a template." },
    { num:"04", title:"Break-Even Calculator",    desc:"The exact monthly revenue you need to cover all costs. Know whether you are above or below the line before the month ends." },
    { num:"05", title:"LTV:CAC Intelligence",     desc:"Are you spending more to acquire customers than they return? This ratio tells you before you waste six months of marketing budget." },
    { num:"06", title:"Revenue Concentration Risk", desc:"If more than 40% of revenue comes from one source, you have a hidden vulnerability. This surfaces it before it becomes a crisis." },
  ];

  const testis = [
    { q:"I was making R800K a month and still running out of cash. Command Ledger showed me <strong>exactly where it was going</strong> in the first week.", name:"Sipho M.", role:"Founder, Logistics" },
    { q:"The Hire Readiness indicator told me I could not afford the hire I was about to make. <strong>That saved my runway.</strong>", name:"Amara K.", role:"Agency Owner" },
    { q:"I connected my QuickBooks export and within 5 minutes had <strong>more clarity than two years of accountant meetings.</strong>", name:"James T.", role:"E-commerce Founder" },
  ];

  return (
    <>
      <nav className={`nav${scrolled?" scrolled":""}`}>
        <div className="nav-logo" onClick={() => window.scrollTo(0, 0)}>
          <div className="logomark">C</div>
          <div><div className="wordmark">Command Ledger</div><div className="wordmark-sub">Financial Intelligence</div></div>
        </div>
        <ul className="nav-links">
          <li><a href="#features">System</a></li>
          <li><a href="#pricing">Pricing</a></li>
          <li><a href="#proof">Proof</a></li>
        </ul>
        <div className="nav-cta">
          <button className="btn btn-ghost" onClick={onLogin}>Sign In</button>
          <button className="btn btn-gold" onClick={() => onPlanSelect("pro")}>Start Free Trial</button>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-bg"/><div className="hero-grid"/>
        <div className="eyebrow"><span className="eyebrow-dot"/>Financial Intelligence for Founders Doing $50K+ Monthly</div>
        <h1 className="hero-title">You are making money.<br/>You are still broke.<br/><em>We fix that.</em></h1>
        <p className="hero-sub">Command Ledger reads your real financial data --- from any spreadsheet, QuickBooks, Xero, or Wave export --- and tells you exactly where the money is leaking, what to cut, and the one move to make this week.</p>
        <div className="hero-cta">
          <button className="btn btn-lg btn-primary" onClick={() => onPlanSelect("pro")}>Start Free Trial</button>
          <button className="btn btn-lg btn-outline" onClick={onLogin}>Sign In</button>
        </div>
        <div className="hero-scroll"><div className="scroll-line"/>Scroll</div>
      </section>

      <div className="stats-bar">
        {[
          { n:"$50K+", l:"Monthly Revenue, Target Clients" },
          { n:"3",     l:"Niches We Solve For" },
          { n:"5 Min", l:"Time to First Insight" },
          { n:"0",     l:"Hardcoded or Fake Data" },
        ].map((s, i) => (
          <div className="stat" key={i}><div className="stat-n">{s.n}</div><div className="stat-l">{s.l}</div></div>
        ))}
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
                    onClick={() => window.open("https://wa.me/27810068255?text=I'm+interested+in+Command+Elite+VIP+--+please+notify+me+when+it+launches","_blank")}
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

      <section className="sec" id="proof">
        <div className="sec-eye">Proof</div>
        <h2 className="sec-title">What founders say after<br/><em>seeing their real numbers</em></h2>
        <div className="testi-grid">
          {testis.map((t, i) => (
            <div className="testi-card" key={i}>
              <div className="testi-q" dangerouslySetInnerHTML={{ __html:`"${t.q}"` }}/>
              <div className="testi-author">
                <div className="testi-av">{t.name[0]}</div>
                <div><div className="testi-name">{t.name}</div><div className="testi-role">{t.role}</div></div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="cta-sec">
        <div style={{ position:"relative", zIndex:1 }}>
          <div className="sec-eye">The Decision</div>
          <h2 className="cta-title">One bad capital decision<br/>costs more than<br/><em>this system.</em></h2>
          <p className="sec-body" style={{ marginTop:20, marginBottom:48 }}>
            The hire you could not afford. The ad spend with no data behind it. The month you ran without knowing your runway. Command Ledger exists so those decisions never happen again.
          </p>
          <button className="btn btn-lg btn-primary" onClick={() => onPlanSelect("pro")}>Start Free Trial</button>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-copy">2026 Command Ledger - DigiBlueprint Financial Intelligence</div>
        <ul className="footer-links">
          <li><a onClick={onPrivacy}>Privacy Policy</a></li>
          <li><a onClick={onTerms}>Terms of Service</a></li>
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
          plan:  "essentials",
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
      // Fallback: show dashboard with essentials so auth never breaks
      setUser(u);
      setProfile({ id:u.id, email:u.email, name:u.user_metadata?.full_name||u.email?.split("@")[0]||"Founder", plan:"essentials" });
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
        <Dashboard
          user={user}
          profile={profile}
          onLogout={async () => { await supabase.auth.signOut(); }}
          onUpgrade={() => { if (profile.plan === "essentials") setPayModal("pro"); }}
        />
      )}
      {appState==="terms"   && <TermsPage   onBack={() => setAppState("marketing")}/>}
      {appState==="privacy" && <PrivacyPage onBack={() => setAppState("marketing")}/>}
    </>
  );
}