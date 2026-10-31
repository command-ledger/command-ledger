// Runs before each test file. The first use of Intl number formatting and
// of WebCrypto pays a one-time runtime start-up cost (loading ICU data and
// the crypto backend). On a slow or busy machine that cost reached 7
// seconds and was charged to whichever test happened to run first, failing
// trivial tests such as fmt(1250) against the per-test time limit. Paying
// it here, outside any test's timing, keeps test times about the tests.
new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(1);
new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(100000);
new Date().toLocaleDateString("en-US", { month: "short", year: "2-digit" });
await crypto.subtle.digest("SHA-256", new TextEncoder().encode("warm-up"));
