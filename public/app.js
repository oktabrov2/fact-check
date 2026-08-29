const app = document.querySelector("#app");
const nav = document.querySelector("#primary-nav");
const navToggle = document.querySelector(".nav-toggle");
const toastRegion = document.querySelector("#toast-region");

const state = {
  sourceData: null,
  sourcePromise: null,
  editingSourceId: null,
  currentUser: null,
  adminUser: null,
  donation: null,
  donationPromise: null,
};

const LEGACY_CATEGORY_METADATA = {
  "international-institutions": { label: "International institutions", description: "Intergovernmental bodies and multilateral public authorities." },
  "government-and-law": { label: "Government and law", description: "Official government services, legislation, and public notices." },
  "economy-and-finance": { label: "Economy and finance", description: "Central banks, financial regulators, and official statistics." },
  "public-health": { label: "Public health", description: "Health authorities, medicine regulators, and disease surveillance." },
  "weather-and-emergencies": { label: "Weather and emergencies", description: "Official weather, disaster, and emergency-alert authorities." },
  "science-and-environment": { label: "Science and environment", description: "Public science agencies and environmental authorities." },
  "elections-and-civic-information": { label: "Elections and civic information", description: "Election commissions and official civic-information bodies." },
  "cyber-and-digital-safety": { label: "Cyber and digital safety", description: "National cyber agencies and public digital-safety guidance." },
  "companies-and-products": { label: "Companies and products", description: "Official company newsrooms, product announcements, and service notices." },
  "games-and-interactive-entertainment": { label: "Games and interactive entertainment", description: "Official game publishers, platforms, ratings bodies, and award programmes." },
  "sports-and-entertainment": { label: "Sports and entertainment", description: "Official sports bodies, studios, film and music organisations, and award programmes." },
  "news-and-current-affairs": { label: "News and current affairs", description: "Established newsrooms and public-interest reporting for time-sensitive claims." },
  "fact-checking-and-verification": { label: "Fact-checking and verification", description: "Established verification organisations with transparent methods." },
  "public-interest-journalism": { label: "Public-interest journalism", description: "Selected public-service and international newsrooms." },
};

const LEGACY_CATEGORY_KEYS = {
  "international authority": "international-institutions",
  "official public authority": "government-and-law",
  "fact-checking / verification": "fact-checking-and-verification",
  "news / public-interest journalism": "public-interest-journalism",
};

document.querySelector("#year").textContent = new Date().getFullYear();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function formatDate(value, options = {}) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: options.short ? "medium" : "long",
    timeStyle: options.time ? "short" : undefined,
  }).format(date);
}

function titleFor(pathname) {
  const titles = {
    "/": "Fact-Check — Evidence, not noise",
    "/check": "Verify a claim — Fact-Check",
    "/sources": "Source Library — Fact-Check",
    "/method": "The Process — Fact-Check",
    "/about": "Why it matters — Fact-Check",
    "/contact": "Contact Fact-Check",
    "/privacy": "Privacy — Fact-Check",
    "/accessibility": "Accessibility — Fact-Check",
    "/login": "Log in — Fact-Check",
    "/signup": "Sign up — Fact-Check",
    "/account": "Your profile — Fact-Check",
    "/donate": "Support Fact-Check",
    "/admin": "Fact-Check Admin",
    "/video": "Video — Fact-Check",
  };
  return titles[pathname] || "Fact-Check";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error || "Something went wrong. Please try again.";
    if (message === "API route not found.") {
      throw new Error("This page is connected to an older Fact-Check server. Restart the server to apply the current platform update, then try again.");
    }
    throw new Error(message);
  }
  return payload;
}

function toast(message, kind = "") {
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.textContent = message;
  toastRegion.append(item);
  window.setTimeout(() => item.remove(), 4600);
}

function closeMenu() {
  nav.classList.remove("open");
  navToggle.classList.remove("open");
  navToggle.setAttribute("aria-expanded", "false");
}

function navigate(pathname) {
  if (window.location.pathname + window.location.search !== pathname) window.history.pushState({}, "", pathname);
  closeMenu();
  render();
}

function signedInProfile() {
  return state.currentUser || state.adminUser;
}

function isSignedIn() {
  return Boolean(signedInProfile());
}

function postLoginDestination() {
  const next = new URLSearchParams(window.location.search).get("next") || "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/account";
}

function profileInitials(user) {
  return String(user?.name || "Fact Check")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "FC";
}

function observeReveals() {
  const items = app.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  items.forEach((item) => observer.observe(item));
}

function renderAccountNav() {
  const accountNav = document.querySelector("#account-nav");
  if (!accountNav) return;

  const pathname = window.location.pathname.replace(/\/$/, "") || "/";
  const isVideoPage = pathname === "/video";

  if (isVideoPage && !isSignedIn()) {
    accountNav.innerHTML = "";
    return;
  }

  if (isSignedIn()) {
    const adminPanel = state.adminUser
      ? `<a class="nav-utility-admin" href="/admin" data-route>Admin panel</a>`
      : "";
    accountNav.innerHTML = `<a class="nav-utility-account" href="/account" data-route>Profile</a>${adminPanel}<button class="nav-utility-logout" id="user-logout" type="button">Log out</button>`;
    document.querySelector("#user-logout")?.addEventListener("click", async () => {
      try {
        const requests = [];
        if (state.currentUser) requests.push(api("/api/auth/logout", { method: "POST", body: "{}" }));
        if (state.adminUser) requests.push(api("/api/admin/logout", { method: "POST", body: "{}" }));
        await Promise.all(requests);
        state.currentUser = null;
        state.adminUser = null;
        renderAccountNav();
        if (["/account", "/admin"].includes(window.location.pathname)) navigate("/");
        toast("You have been logged out.");
      } catch (error) {
        toast(error.message, "error");
      }
    });
    return;
  }
  accountNav.innerHTML = `<a class="nav-utility-login" href="/login" data-route>Log in</a><a class="nav-utility-signup" href="/signup" data-route>Sign up</a>`;
}

async function refreshCurrentUser() {
  try {
    const response = await api("/api/auth/status");
    state.currentUser = response.user || null;
    state.adminUser = response.administrator || null;
  } catch {
    state.currentUser = null;
    state.adminUser = null;
  }
  const pathname = window.location.pathname.replace(/\/$/, "") || "/";
  if (isSignedIn() && (pathname === "/login" || pathname === "/signup")) {
    navigate(postLoginDestination());
    return signedInProfile();
  }
  updateNav();
  return signedInProfile();
}

async function loadDonationConfig(force = false) {
  if (state.donation && !force) return state.donation;
  if (state.donationPromise && !force) return state.donationPromise;
  state.donationPromise = api("/api/donation")
    .then((donation) => {
      state.donation = {
        enabled: donation.enabled === true,
        provider: String(donation.provider || "Secure payment provider"),
        url: donation.url || null,
      };
      state.donationPromise = null;
      return state.donation;
    })
    .catch(() => {
      state.donation = { enabled: false, provider: "Secure payment provider", url: null };
      state.donationPromise = null;
      return state.donation;
    });
  return state.donationPromise;
}

function requireVerificationSession() {
  if (isSignedIn()) return true;
  toast("Log in to verify a claim.", "error");
  navigate("/login?next=" + encodeURIComponent(window.location.pathname + window.location.search));
  return false;
}

function updateNav() {
  renderAccountNav();
  const current = window.location.pathname;
  document.querySelectorAll(".primary-nav a[data-route]").forEach((link) => {
    const active = link.getAttribute("href") === current;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function pageHead(eyebrow, heading, lead) {
  return `
    <section class="page page-hero reveal">
      <span class="eyebrow">${escapeHtml(eyebrow)}</span>
      <h1>${heading}</h1>
      <p class="lead">${escapeHtml(lead)}</p>
    </section>`;
}

function renderHome() {
  app.innerHTML = `
    <section class="page hero">
      <div class="hero-copy reveal">
        <span class="eyebrow">Evidence-led media literacy</span>
        <h1>Check the evidence. <em>Think before you share.</em></h1>
        <p class="lead">Fact-Check turns uncertainty into an evidence trail. It routes each question to the relevant trusted-source categories, then checks only those approved domains and links directly to what they support.</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="/check" data-route>Check a claim <span aria-hidden="true">→</span></a>
          <a class="btn btn-secondary" href="/sources" data-route>Explore sources</a>
        </div>
        <div class="trust-strip">
          <div class="trust-avatars" aria-hidden="true"><span>WHO</span><span>UN</span><span>NHC</span><span>CBU</span></div>
          <span>Every result begins with a visible category boundary — never an open-web guess.</span>
        </div>
      </div>
      <aside class="hero-preview reveal" aria-label="Preview of a Fact-Check result card">
        <div class="hero-preview-card">
          <div class="hero-preview-head">
            <span class="hero-preview-verdict">
              <span aria-hidden="true"></span>Evidence supports the claim
            </span>
            <span class="hero-preview-meta">Checked just now</span>
          </div>
          <div class="hero-preview-trace">
            <span class="hero-preview-trace-label">Evidence boundary</span>
            <span class="hero-preview-trace-value">Weather and emergencies · Government and law</span>
          </div>
          <p class="hero-preview-answer">Yes. The National Hurricane Center's public advisory archive confirms a Category 2 landfall on the Gulf Coast on Aug 28.</p>
          <a class="hero-preview-citation" href="#" data-route tabindex="-1">
            <span class="hero-preview-citation-body">
              <strong>US National Hurricane Center</strong>
              <small>nhc.noaa.gov/archive/2026/al09/</small>
            </span>
            <span class="hero-preview-citation-tags">
              <span class="hero-preview-citation-tag hero-preview-tag-first">First-party</span>
              <span class="hero-preview-citation-tag hero-preview-tag-date">Aug 28</span>
            </span>
          </a>
        </div>
      </aside>
    </section>

    <section class="section section-tint"><div class="page">
      <div class="stat-grid reveal">
        <article class="stat-card"><strong data-source-count>110</strong><span>listed sources to inspect</span></article>
        <article class="stat-card"><strong>5</strong><span>careful evidence outcomes</span></article>
      </div>
    </div></section>

    <section class="section"><div class="page">
      <div class="section-head reveal"><span class="eyebrow">The trusted-source registry</span><h2>A public source boundary, <em>not an open-web guess.</em></h2><p>Every Fact-Check result is limited to the active sources in our public registry. See who is included, why they are included, and open the original reporting yourself.</p></div>
      <div class="source-summary reveal"><span id="home-registry-summary">Loading the trusted-source registry...</span><span class="mini-label" id="home-registry-version">Registry version -</span></div>
      <div id="home-registry-grid" class="source-grid" aria-live="polite"><div class="center-loader glass-card"><span class="spinner"></span><span>Loading source groups...</span></div></div>
      <div class="inline-actions reveal"><a class="btn btn-primary" id="home-sources-link" href="/sources" data-route>View all trusted sources <span aria-hidden="true">→</span></a><a class="btn btn-secondary" href="/api/sources.pdf">Download the current list (PDF)</a></div>
    </div></section>

    <section class="section"><div class="page">
      <div class="section-head reveal"><span class="eyebrow">Verification is a habit</span><h2>Move from “is it true?” to “what is the evidence?”</h2><p>Fact-Check makes the source boundary visible so people can pause, inspect the context, and decide what deserves their trust.</p></div>
      <div class="feature-grid">
        <article class="feature-card glass-card reveal"><span class="feature-number">01 / A clear boundary</span><div class="feature-icon" aria-hidden="true">⌕</div><h3>Routes before it searches</h3><p>Fact-Check selects only the source categories relevant to a question before it requests evidence. It does not quietly pull in random websites or social posts.</p></article>
        <article class="feature-card glass-card reveal"><span class="feature-number">02 / Every answer is inspectable</span><div class="feature-icon" aria-hidden="true">↗</div><h3>Keeps the evidence visible</h3><p>Each result links to the sources used, so users can read the reporting, date, and context for themselves.</p></article>
        <article class="feature-card glass-card reveal"><span class="feature-number">03 / Uncertainty is allowed</span><div class="feature-icon" aria-hidden="true">≈</div><h3>Keeps critical thinking human</h3><p>No supporting source is not the same as “false.” Fact-Check marks results that need more evidence, context, or human review.</p></article>
      </div>
    </div></section>

    <section class="section section-tint"><div class="page how-grid">
      <div class="reveal"><span class="eyebrow">How a check happens</span><h2>A small workflow with a clear responsibility.</h2><p class="lead">AI can help organize evidence. It should not make a hidden decision about what people should believe.</p><div class="steps">
        <article class="step"><span class="step-index">01</span><div><h3>You submit a claim or image context</h3><p>Share what you saw and include the date, place, or original caption when you know it.</p></div></article>
        <article class="step"><span class="step-index">02</span><div><h3>Relevant categories are selected first</h3><p>A dedicated routing request chooses the smallest useful set of source categories; it does not search for evidence or produce an answer.</p></div></article>
        <article class="step"><span class="step-index">03</span><div><h3>A separate request checks selected domains</h3><p>The evidence search receives only those category links. You can open the returned sources and inspect the context yourself.</p></div></article>
      </div></div>
      <div class="method-visual glass-card reveal"><div class="pipeline"><div class="pipeline-node"><strong>Claim / image context</strong><span>Your question</span></div><div class="pipeline-node is-highlight"><strong>Selected-source filter</strong><span>Visible boundary</span></div><div class="pipeline-node"><strong>Evidence comparison</strong><span>AI-assisted</span></div><div class="pipeline-node is-highlight"><strong>Linked result</strong><span>Your judgment remains</span></div></div></div>
    </div></section>

    <section class="section"><div class="page"><div class="callout reveal"><span class="callout-icon" aria-hidden="true">!</span><div><h3>Fact-Check is not a universal truth machine.</h3><p>It reports what selected sources do or do not support at the time of a check. People can inspect the sources, question a conclusion, and take high-stakes claims to qualified human experts.</p></div></div></div></section>

    <section class="page"><div class="cta-panel reveal"><span class="eyebrow">Start with the evidence</span><h2>Make checking before sharing a normal habit.</h2><p>Use the checker for a current claim, an image, or a story you are unsure about. Every result stays within the public source registry and points you back to the original evidence.</p><div class="inline-actions"><a class="btn btn-primary" href="/check" data-route>Check a claim <span aria-hidden="true">→</span></a><a class="btn btn-secondary" href="/method" data-route>Read the method</a></div></div></section>`;
  hydrateSourceCount();
  hydrateRegistryOverview();
}

function renderVideo() {
  app.innerHTML = `
    <section class="page video-page">
      <div class="page-hero reveal">
        <span class="eyebrow">Fact-Check video</span>
        <h1>Watch the video.</h1>
        <p class="lead">Streaming from the Fact-Check video service.</p>
      </div>

      <section class="page">
        <div class="video-card glass-card reveal">
          <video
            class="video-player"
            src="/video-stream"
            controls
            playsinline
            preload="metadata"
          >
            Your browser does not support HTML5 video.
          </video>
        </div>
      </section>
    </section>
  `;

  observeReveals();
}

function renderCheck() {
  app.innerHTML = `
    <section class="page check-hero reveal">
      <span class="eyebrow">Evidence workspace</span>
      <h1>Verify a claim. <em>Trace the evidence.</em></h1>
      <p class="lead">Ask about a hurricane report, a game release, an election result — the answer comes back with linked evidence, not just a summary.</p>
    </section>

    <section class="page check-workspace">
      <form class="checker-card checker-card-hero reveal" id="checker-form">
        <div class="checker-toolbar">
          <span class="checker-kicker">Two-step verification</span>
          <div class="checker-registry-meta" aria-label="Trusted-source registry summary">
            <span><b data-source-count>110</b> trusted sources</span>
            <span aria-hidden="true" class="checker-registry-dot">·</span>
            <span><b>14</b> categories</span>
          </div>
        </div>
        <div class="claim-input-wrap">
          <textarea id="claim" name="claim" maxlength="1800" aria-label="Claim to verify"></textarea>
          <div class="claim-typewriter" id="claim-rotator" aria-hidden="true"><span class="claim-typewriter-slot" id="claim-rotator-slot"></span><span class="claim-typewriter-caret" aria-hidden="true"></span></div>
          <span class="claim-counter" id="claim-counter" aria-hidden="true">0 / 1,800</span>
        </div>
        <div class="checker-footer">
          <div class="checker-footer-left">
            <label class="upload-label">＋ Attach an image<input id="claim-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" /></label>
            <span class="file-status" id="file-status">Optional · PNG, JPG, WEBP or GIF · up to 4 MB</span>
          </div>
          <button class="btn btn-primary btn-large" id="check-submit" type="submit">Verify with trusted sources <span aria-hidden="true">→</span></button>
        </div>
      </form>
    </section>

    <section class="page check-flow">
      <ol class="check-flow-grid">
        <li class="check-flow-step glass-card reveal">
          <span class="check-flow-num">01</span>
          <h3>Route</h3>
          <p>A first pass picks the smallest set of relevant trusted-source categories for your claim — no web search yet.</p>
        </li>
        <li class="check-flow-step glass-card reveal">
          <span class="check-flow-num">02</span>
          <h3>Check</h3>
          <p>A separate search runs only inside those approved domains. Every citation is validated server-side before it can appear.</p>
        </li>
        <li class="check-flow-step glass-card reveal">
          <span class="check-flow-num">03</span>
          <h3>Result</h3>
          <p>A concise verdict, the direct answer, and the exact article links, dates, and categories the evidence came from.</p>
        </li>
      </ol>
    </section>

    <section class="page result-wrap" id="check-result" aria-live="polite"></section>`;
  bindChecker();
  hydrateSourceCount();
}

function renderCitationCard(source) {
  const title = escapeHtml(source.title || "Selected source");
  const url = escapeAttr(source.url);
  const displayUrl = escapeHtml(source.url);
  const summary = String(source.summary || "").trim();
  const publishedAt = source.publishedAt ? formatDate(source.publishedAt, { short: true }) : "";
  const badges = [];
  if (source.firstParty) badges.push(`<span class="citation-badge citation-badge-first">First-party official</span>`);
  if (source.category) badges.push(`<span class="citation-badge citation-badge-category">${escapeHtml(source.category)}</span>`);
  if (publishedAt) badges.push(`<span class="citation-badge citation-badge-date">Published ${escapeHtml(publishedAt)}</span>`);
  return `
    <a class="citation citation-detailed" href="${url}" target="_blank" rel="noreferrer">
      <div class="citation-body">
        <div class="citation-head">
          <strong>${title}</strong>
          <span class="citation-arrow" aria-hidden="true">↗</span>
        </div>
        <small class="citation-url">${displayUrl}</small>
        ${summary ? `<p class="citation-summary">${escapeHtml(summary)}</p>` : ""}
        ${badges.length ? `<div class="citation-badges">${badges.join("")}</div>` : ""}
      </div>
    </a>`;
}

function verdictLabel(verdict) {
  return ({ SUPPORTED: "Evidence supports the claim", CONTRADICTED: "Evidence contradicts the claim", MISLEADING: "Evidence indicates misleading framing", MIXED: "Evidence is mixed", INSUFFICIENT: "Not enough evidence to verify" }[verdict] || "Not enough evidence to verify");
}

function verdictHeading(verdict) {
  return ({ SUPPORTED: "Answer: supported by the evidence", CONTRADICTED: "Answer: contradicted by the evidence", MISLEADING: "Answer: misleading or missing key context", MIXED: "Answer: evidence is mixed", INSUFFICIENT: "Answer: not enough evidence" }[verdict] || "Answer: not enough evidence");
}

function renderCheckResult(result) {
  const verdict = String(result.verdict || "INSUFFICIENT").toLowerCase();
  const citations = (result.sources || []).map(renderCitationCard).join("");
  const answer = result.answer || result.explanation || "There is not enough reliable information in the selected sources to verify this claim.";
  const hasEvidence = verdict !== "insufficient" && Boolean(citations);
  const selection = result.categorySelection || {};
  const categoryNames = (selection.categories || []).map((category) => category.label || category.key).filter(Boolean);
  const routing = categoryNames.length
    ? `<section class="selection-trace"><div class="selection-trace-head"><span class="mini-label">Evidence boundary</span><span>${escapeHtml(String(selection.selectedDomainCount || 0))} trusted domains</span></div><div class="selection-steps"><div><b>01</b><span><strong>Categories selected</strong><small>${escapeHtml(categoryNames.join(" · "))}</small></span></div><div><b>02</b><span><strong>Evidence search completed</strong><small>${escapeHtml(String(selection.selectedSourceCount || 0))} listed sources were eligible for this check</small></span></div></div>${selection.reason ? `<p class="selection-reason">${escapeHtml(selection.reason)}</p>` : ""}${selection.truncated ? `<p class="selection-reason">The matching set exceeded the search cap, so Fact-Check used the first 100 approved domains in the selected categories.</p>` : ""}</section>`
    : "";
  return `<article class="result-card glass-card reveal visible"><div class="result-head"><div><span class="verdict verdict-${verdict}">${escapeHtml(verdictLabel(result.verdict))}</span><h2>${escapeHtml(verdictHeading(result.verdict))}</h2></div><div class="checked-time">Checked ${escapeHtml(formatDate(result.checkedAt, { time: true }))}</div></div>${routing}<section class="final-answer"><span class="mini-label">Final answer</span><p class="result-text">${escapeHtml(answer)}</p></section>${hasEvidence ? `<h3 class="result-sources-title">Evidence used for this answer</h3><div class="citation-list">${citations}</div>` : ""}</article>`;
}

function bindChecker() {
  const form = document.querySelector("#checker-form");
  const fileInput = document.querySelector("#claim-image");
  const fileStatus = document.querySelector("#file-status");
  const resultContainer = document.querySelector("#check-result");
  const claimField = document.querySelector("#claim");
  const rotator = document.querySelector("#claim-rotator");
  const rotatorSlot = document.querySelector("#claim-rotator-slot");
  const counter = document.querySelector("#claim-counter");
  let imageDataUrl = "";

  const rotatorExamples = [
    "Did a hurricane make landfall in the United States yesterday?",
    "Has GTA VI been officially released?",
    "Has the national election result been officially announced?",
    "Does the WHO recommend this treatment for adults?",
    "Is cash still accepted for payments in Uzbekistan?",
    "Did Rockstar Games post an official update on their Newswire this week?",
    "Is there an active earthquake alert for this region right now?",
    "Did this team officially win their national championship this year?",
  ];
  let rotatorIndex = 0;
  let charIndex = 0;
  let phase = "typing";
  let rotatorTimer = null;
  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const rotatorShouldShow = () => !claimField.value && document.activeElement !== claimField;

  const applyRotatorVisibility = () => {
    if (!rotator) return;
    rotator.classList.toggle("hidden", !rotatorShouldShow());
  };

  const clearRotatorTimer = () => {
    if (!rotatorTimer) return;
    window.clearTimeout(rotatorTimer);
    rotatorTimer = null;
  };

  const runTypewriter = () => {
    rotatorTimer = null;
    if (!rotatorSlot || !rotatorShouldShow()) return;
    const target = rotatorExamples[rotatorIndex];
    if (phase === "typing") {
      charIndex = Math.min(charIndex + 1, target.length);
      rotatorSlot.textContent = target.slice(0, charIndex);
      if (charIndex >= target.length) {
        phase = "holding";
        rotatorTimer = window.setTimeout(runTypewriter, 2000);
      } else {
        rotatorTimer = window.setTimeout(runTypewriter, 42 + Math.random() * 38);
      }
    } else if (phase === "holding") {
      phase = "deleting";
      rotatorTimer = window.setTimeout(runTypewriter, 30);
    } else if (phase === "deleting") {
      charIndex = Math.max(charIndex - 1, 0);
      rotatorSlot.textContent = target.slice(0, charIndex);
      if (charIndex <= 0) {
        rotatorIndex = (rotatorIndex + 1) % rotatorExamples.length;
        phase = "typing";
        rotatorTimer = window.setTimeout(runTypewriter, 320);
      } else {
        rotatorTimer = window.setTimeout(runTypewriter, 22 + Math.random() * 14);
      }
    }
  };

  const startRotator = () => {
    if (!rotatorSlot || rotatorTimer) return;
    if (prefersReducedMotion) {
      rotatorSlot.textContent = rotatorExamples[rotatorIndex];
      return;
    }
    runTypewriter();
  };
  const stopRotator = () => { clearRotatorTimer(); };

  if (rotatorSlot) rotatorSlot.textContent = "";
  applyRotatorVisibility();
  startRotator();

  const updateCounter = () => {
    if (!counter) return;
    const length = claimField.value.length;
    counter.textContent = `${length.toLocaleString()} / 1,800`;
    counter.classList.toggle("visible", length > 0);
    counter.classList.toggle("near-limit", length > 1620);
  };
  updateCounter();

  claimField.addEventListener("focus", () => { applyRotatorVisibility(); stopRotator(); });
  claimField.addEventListener("blur", () => { applyRotatorVisibility(); if (rotatorShouldShow()) startRotator(); });
  claimField.addEventListener("input", () => { applyRotatorVisibility(); updateCounter(); });

  fileInput.addEventListener("change", () => {
    const [file] = fileInput.files || [];
    imageDataUrl = "";
    if (!file) { fileStatus.textContent = "Optional · PNG, JPG, WEBP or GIF · up to 4 MB"; return; }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 4 * 1024 * 1024) {
      fileInput.value = "";
      fileStatus.textContent = "Please choose a supported image under 4 MB.";
      toast("That image is not supported or is larger than 4 MB.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { imageDataUrl = String(reader.result || ""); fileStatus.textContent = `${file.name} · ready to check`; };
    reader.readAsDataURL(file);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireVerificationSession()) return;
    const claim = document.querySelector("#claim").value.trim();
    if (!claim && !imageDataUrl) { toast("Enter a claim or attach an image first.", "error"); return; }
    const button = document.querySelector("#check-submit");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> Verifying`;
    resultContainer.innerHTML = `<div class="center-loader glass-card"><span class="spinner"></span><span id="check-progress">Step 1 of 2: selecting the relevant trusted-source categories…</span></div>`;
    const progressTimer = window.setTimeout(() => {
      const progress = document.querySelector("#check-progress");
      if (progress) progress.textContent = "Step 2 of 2: searching only the chosen trusted domains…";
    }, 1400);
    try {
      const result = await api("/api/check", { method: "POST", body: JSON.stringify({ claim, imageDataUrl }) });
      resultContainer.innerHTML = renderCheckResult(result);
      observeReveals();
      resultContainer.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      resultContainer.innerHTML = `<div class="warning">${escapeHtml(error.message)}</div>`;
      toast(error.message, "error");
    } finally {
      window.clearTimeout(progressTimer);
      button.disabled = false;
      button.innerHTML = `Verify with trusted sources <span aria-hidden="true">→</span>`;
    }
  });
}

async function loadSourceData(force = false) {
  if (state.sourceData && !force) return state.sourceData;
  if (state.sourcePromise && !force) return state.sourcePromise;
  state.sourcePromise = api("/api/sources").then((data) => {
    state.sourceData = normaliseSourceData(data);
    state.sourcePromise = null;
    return state.sourceData;
  }).catch((error) => { state.sourcePromise = null; throw error; });
  return state.sourcePromise;
}

function sourceCategoryKey(source) {
  const explicit = String(source?.categoryKey || "").trim();
  if (explicit && LEGACY_CATEGORY_METADATA[explicit]) return explicit;
  const legacy = LEGACY_CATEGORY_KEYS[String(source?.category || "").trim().toLowerCase()];
  return legacy || "government-and-law";
}

function sourceCategoryKeys(source) {
  const primary = sourceCategoryKey(source);
  const supplied = Array.isArray(source?.categoryKeys) ? source.categoryKeys : [];
  const keys = [primary, ...supplied.map((key) => String(key || "").trim()).filter(Boolean)];
  return [...new Set(keys)].filter((key) => LEGACY_CATEGORY_METADATA[key]);
}

function normaliseSourceData(payload) {
  const sourceRows = Array.isArray(payload?.sources) ? payload.sources : [];
  const suppliedCategories = Array.isArray(payload?.categories)
    ? payload.categories.filter((item) => item && typeof item === "object" && item.key)
    : [];
  const categoryDetails = new Map(suppliedCategories.map((item) => [String(item.key), item]));
  const sources = sourceRows.map((source) => {
    const categoryKey = sourceCategoryKey(source);
    const categoryKeys = sourceCategoryKeys(source);
    const fallback = LEGACY_CATEGORY_METADATA[categoryKey] || LEGACY_CATEGORY_METADATA["government-and-law"];
    const categoryLabels = categoryKeys.map((key) => (
      categoryDetails.get(key)?.label
      || LEGACY_CATEGORY_METADATA[key]?.label
      || key
    ));
    return { ...source, categoryKey, categoryKeys, categoryLabels, category: source.category || fallback.label };
  });
  const counts = new Map();
  for (const source of sources) {
    for (const key of source.categoryKeys) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const categories = [...counts.entries()].map(([key, count]) => {
    const supplied = categoryDetails.get(key) || {};
    const fallback = LEGACY_CATEGORY_METADATA[key] || LEGACY_CATEGORY_METADATA["government-and-law"];
    return {
      key,
      label: supplied.label || fallback.label,
      description: supplied.description || fallback.description,
      count,
    };
  }).sort((left, right) => left.label.localeCompare(right.label));
  const automatedCheckSources = sources.filter((source) => (
    ["reviewed-link-and-citation", "reviewed-open-license"].includes(source.usageStatus)
    && source.usagePolicyUrl
  ));

  return {
    ...payload,
    sourceCount: Number(payload?.sourceCount) || sources.length,
    automatedCheckSourceCount: Number(payload?.automatedCheckSourceCount) || automatedCheckSources.length,
    automatedCheckDomainCount: Number(payload?.automatedCheckDomainCount) || new Set(automatedCheckSources.map((source) => source.domain)).size,
    sources,
    categories,
  };
}

async function hydrateSourceCount() {
  try {
    const data = await loadSourceData();
    document.querySelectorAll("[data-source-count]").forEach((element) => { element.textContent = data.sourceCount; });
  } catch { /* Decorative counter: source directory remains available after a retry. */ }
}

function registryCounts(data) {
  if (Array.isArray(data.categories) && data.categories.every((item) => item && item.key)) return data.categories;
  const counts = new Map();
  (data.sources || []).forEach((source) => {
    sourceCategoryKeys(source).forEach((key) => counts.set(key, (counts.get(key) || 0) + 1));
  });
  return [...counts.entries()].map(([key, count]) => ({ key, label: key, description: "A reviewed part of the public Fact-Check source registry.", count }));
}

function homeRegistryCard(item) {
  return '<article class="source-card glass-card reveal visible"><span class="source-tag">' + escapeHtml(String(item.count)) + ' sources</span><h3>' + escapeHtml(item.label || item.key) + '</h3><p>' + escapeHtml(item.description || "A reviewed part of the public Fact-Check source registry.") + '</p><a class="source-link" href="/sources?category=' + encodeURIComponent(item.key || "") + '" data-route>Explore this category &rarr;</a></article>';
}

async function hydrateRegistryOverview() {
  const grid = document.querySelector("#home-registry-grid");
  const summary = document.querySelector("#home-registry-summary");
  const version = document.querySelector("#home-registry-version");
  const sourceLink = document.querySelector("#home-sources-link");
  if (!grid || !summary || !version || !sourceLink) return;
  try {
    const data = await loadSourceData();
    const counts = registryCounts(data);
    summary.textContent = data.sourceCount + " public registry entries · " + data.automatedCheckSourceCount + " eligible for automatic checks";
    version.textContent = "Registry v" + data.version;
    sourceLink.innerHTML = "View all " + data.sourceCount + " sources <span aria-hidden=\"true\">→</span>";
    grid.innerHTML = counts.map(homeRegistryCard).join("");
  } catch {
    grid.innerHTML = '<div class="empty-state glass-card">The source overview is unavailable right now. You can still open the full public source directory.</div>';
    summary.textContent = "Public source registry";
  }
}

function sourceUsageMarkup(source) {
  if (!source.usagePolicyUrl || source.usageStatus === "legacy-review-pending") {
    return `<span class="source-terms-pending">Use review pending · not used for automatic checks</span>`;
  }
  const label = source.usageStatus === "reviewed-open-license"
    ? "Published reuse terms"
    : "Published source terms";
  return `<a class="source-terms-link" href="${escapeAttr(source.usagePolicyUrl)}" target="_blank" rel="noreferrer">${label} ↗</a>`;
}

function sourceCard(source) {
  const categories = (source.categoryLabels || [source.category]).map((label) => `<span class="source-tag">${escapeHtml(label)}</span>`).join("");
  return `<article class="source-card glass-card"><a class="source-card-cover-link" href="${escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeAttr(source.name)} official source in a new tab"></a><div class="source-tags">${categories}</div><h3>${escapeHtml(source.name)}</h3><p>${escapeHtml(source.rationale)}</p><div class="source-card-links"><a class="source-link" href="${escapeAttr(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.domain)} ↗</a>${sourceUsageMarkup(source)}</div></article>`;
}

function shuffleSources(sources) {
  const shuffled = [...sources];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function renderSources() {
  app.innerHTML = `${pageHead("Source Library", "A visible evidence boundary. <em>Organized by purpose.</em>", "Browse the public source registry. Every listed entry has a completed source-use review and is eligible for automatic evidence search when its category is selected.")}
    <section class="page">
      <div class="source-library-policy glass-card reveal"><span class="mini-label">Source-use safeguard</span><p>Automatic checks use only first-party domains with a completed source-use review and an official terms or licence link. Fact-Check links to original material and returns short original-language summaries; it does not republish source text, images, logos, or database copies. A completed review is not a blanket licence for every item on a domain.</p></div>
      <div class="directory-tools reveal"><input id="source-search" type="search" placeholder="Search a source, category, or authority" aria-label="Search trusted sources" /><select id="source-category" aria-label="Filter sources by category"><option value="">All categories</option></select><a class="btn btn-secondary" href="/api/sources.pdf">↓ Download PDF list</a></div>
      <div class="source-summary reveal"><span id="source-summary">Loading trusted sources…</span><span class="mini-label" id="source-version">Registry version —</span></div>
      <div id="source-category-chips" class="source-category-chips" aria-label="Source category filters"></div>
      <p class="source-category-note">Sources can belong to more than one evidence category, so category totals can overlap while the public-entry total remains unique.</p>
      <div id="source-grid" class="source-grid" aria-live="polite"><div class="center-loader glass-card"><span class="spinner"></span><span>Loading the registry…</span></div></div>
    </section>`;
  bindSources();
}

async function bindSources() {
  const grid = document.querySelector("#source-grid");
  const search = document.querySelector("#source-search");
  const category = document.querySelector("#source-category");
  const summary = document.querySelector("#source-summary");
  const version = document.querySelector("#source-version");
  const chips = document.querySelector("#source-category-chips");
  try {
    const data = await loadSourceData();
    const randomizedSources = shuffleSources(data.sources);
    const requestedCategory = new URLSearchParams(window.location.search).get("category") || "";
    const validCategory = data.categories.some((item) => item.key === requestedCategory) ? requestedCategory : "";
    category.innerHTML = `<option value="">All categories</option>${data.categories.map((item) => `<option value="${escapeAttr(item.key)}">${escapeHtml(item.label)} (${escapeHtml(item.count)})</option>`).join("")}`;
    category.value = validCategory;
    chips.innerHTML = `<button class="category-chip" type="button" data-category-key="">All <span>${escapeHtml(data.sourceCount)}</span></button>${data.categories.map((item) => `<button class="category-chip" type="button" data-category-key="${escapeAttr(item.key)}">${escapeHtml(item.label)} <span>${escapeHtml(item.count)}</span></button>`).join("")}`;
    version.textContent = `Registry v${data.version}`;
    const update = () => {
      const term = search.value.trim().toLowerCase();
      const categoryValue = category.value;
      const items = randomizedSources.filter((source) => {
        const matchesCategory = !categoryValue || source.categoryKeys.includes(categoryValue);
        const text = `${source.name} ${source.domain} ${source.category} ${source.categoryKey} ${source.categoryKeys.join(" ")} ${source.categoryLabels.join(" ")} ${source.rationale}`.toLowerCase();
        return matchesCategory && (!term || text.includes(term));
      });
      summary.textContent = `${items.length} of ${data.sourceCount} public entries · ${data.automatedCheckSourceCount} eligible for automatic checks after completed source-use review · Updated ${formatDate(data.updatedAt, { short: true })}`;
      grid.innerHTML = items.length ? items.map(sourceCard).join("") : `<div class="empty-state glass-card">No selected source matches that search.</div>`;
      chips.querySelectorAll("[data-category-key]").forEach((chip) => {
        const active = chip.dataset.categoryKey === categoryValue;
        chip.classList.toggle("active", active);
        chip.setAttribute("aria-pressed", String(active));
      });
      observeReveals();
    };
    search.addEventListener("input", update);
    category.addEventListener("change", () => {
      const url = new URL(window.location.href);
      if (category.value) url.searchParams.set("category", category.value);
      else url.searchParams.delete("category");
      window.history.replaceState({}, "", url.pathname + url.search);
      update();
    });
    chips.addEventListener("click", (event) => {
      const button = event.target.closest("[data-category-key]");
      if (!button) return;
      category.value = button.dataset.categoryKey || "";
      category.dispatchEvent(new Event("change"));
    });
    update();
  } catch (error) {
    grid.innerHTML = `<div class="warning">${escapeHtml(error.message)}</div>`;
  }
}

function renderMethod() {
  renderMethodV2();
}

function renderAbout() {
  renderAboutV2();
}
function renderMethodV2() {
  app.innerHTML = `${pageHead("The Process", "Two AI steps. <em>One enforced boundary.</em>", "Fact-Check separates source routing from evidence searching so the system cannot answer first and justify itself later.")}
    <section class="page method-grid">
      <div><article class="method-card glass-card reveal"><span class="eyebrow">Step 01 · Category routing</span><h2>Decide where to look before looking.</h2><p>The first request receives the claim and the fixed registry taxonomy. It selects the smallest relevant set of categories — for example, weather and emergencies plus government and law for a report of a hurricane in the United States.</p><p>That routing request has no web-search tool and is not allowed to produce a fact-check verdict.</p></article><article class="method-card glass-card reveal"><span class="eyebrow">Step 02 · Evidence search</span><h2>Search only the reviewed domain set.</h2><p>A new request receives only sources in the selected categories that have a completed source-use review, plus a server-enforced allowed-domain filter. Returned citations are checked against the same selected domains before they are shown.</p><p>The result keeps links and titles only, with a short paraphrased explanation rather than search-provider excerpts. Each evidence search is capped at 100 approved domains. If no reviewed source is available for a category, the result is marked insufficient instead of widening the search.</p></article></div>
      <aside class="quote-card glass-card reveal"><blockquote>“A fast answer is not enough. A trustworthy answer shows where it came from and where its limits are.”</blockquote><cite>Fact-Check evidence standard</cite></aside>
    </section>
    <section class="section section-tint"><div class="page"><div class="section-head reveal"><span class="eyebrow">Built-in safeguards</span><h2>Designed to be inspectable at every step.</h2></div><div class="principles glass-card reveal"><article class="principle"><span>01 / CATEGORY CONTROL</span><h3>Categories are fixed, not invented on the fly.</h3><p>The model can select only categories defined by the platform. It cannot create a vague “general web” category to escape the source boundary.</p></article><article class="principle"><span>02 / DOMAIN CONTROL</span><h3>The second request receives only selected trusted domains.</h3><p>The boundary is applied at the API request level, then citations are validated again on the server before the result is displayed.</p></article><article class="principle"><span>03 / SOURCE ADMISSION</span><h3>New sources require AI analysis and manual confirmation.</h3><p>Administrators submit a first-party HTTPS domain. A high-confidence source assessment and human confirmation are required before it can become active.</p></article><article class="principle"><span>04 / CLEAR LIMITS</span><h3>Uncertainty remains a valid result.</h3><p>If selected sources do not provide enough evidence, Fact-Check says so. It does not treat an empty search as proof that a claim is false.</p></article></div></div></section>
    <section class="page"><div class="callout reveal"><span class="callout-icon" aria-hidden="true">!</span><div><h3>High-stakes claims need more than a single result.</h3><p>For urgent health, safety, legal, financial, or emergency decisions, use the original authorities and qualified experts directly. Fact-Check is an evidence-navigation platform, not a substitute for professional advice.</p></div></div></section>`;
}

function renderAboutV2() {
  app.innerHTML = `${pageHead("Why it matters", "Media literacy needs <em>practical tools.</em>", "AI can make misleading content more convincing and easier to spread. Fact-Check gives people a concrete way to pause, identify relevant authorities, and inspect the evidence before they share.")}
    <section class="page about-grid"><article class="about-card glass-card reveal"><span class="eyebrow">Independent youth-led platform</span><h2>Make verification a normal part of receiving information.</h2><p>Fact-Check is designed as a real, transparent platform for media and information literacy. Instead of presenting a black-box “true” or “false” label, it reveals the category boundary, the linked evidence, and the limits of the result.</p><p>It responds to AI-amplified misinformation by making source-aware verification usable in everyday questions, not only in specialist newsrooms.</p></article><article class="about-card glass-card reveal"><span class="eyebrow">Participation with standards</span><h3>Access should be simple. Evidence standards should stay high.</h3><p>Anyone can inspect the public source library and download its current directory. Signing in is required before a claim or image is sent to the protected verification workflow. At the same time, source admission is deliberately strict: broad social-platform domains cannot enter an automated allowed-domain boundary.</p><h3>Trust deserves questions.</h3><p>People can inspect citations, question a result, and suggest first-party public authorities for review. That keeps the platform accountable to the communities it is meant to serve.</p></article></section>
    <section class="section section-tint"><div class="page"><div class="section-head reveal"><span class="eyebrow">Long-term contribution</span><h2>Grow a culture of checking before sharing.</h2></div><div class="feature-grid"><article class="feature-card glass-card reveal"><span class="feature-number">NOW</span><div class="feature-icon" aria-hidden="true">⌕</div><h3>Make the evidence boundary visible</h3><p>Provide a transparent, categorized registry and concise linked results that are easy to inspect.</p></article><article class="feature-card glass-card reveal"><span class="feature-number">NEXT</span><div class="feature-icon" aria-hidden="true">◌</div><h3>Improve local relevance responsibly</h3><p>Expand first-party public authorities through strict review, especially for the languages and communities using the platform.</p></article><article class="feature-card glass-card reveal"><span class="feature-number">LATER</span><div class="feature-icon" aria-hidden="true">↗</div><h3>Measure evidence quality</h3><p>Continuously evaluate citation quality, source freshness, accessibility, and false-verdict risk as the platform grows.</p></article></div></div></section>`;
}

function renderContact() {
  app.innerHTML = `${pageHead("Contact", "Let’s build more <em>informed habits.</em>", "Questions, source suggestions, project feedback, or collaboration ideas are welcome. Fact-Check grows stronger when its source policy is transparent and open to thoughtful challenge.")}
    <section class="page contact-grid"><article class="contact-card glass-card reveal"><span class="eyebrow">Project contact</span><h2>Get in touch.</h2><p class="muted">For research collaboration, source-registry suggestions, or feedback on the project:</p><div class="contact-list"><a class="contact-link" href="mailto:oktabrovumrbek2023@gmail.com"><span aria-hidden="true">@</span><div><strong>Email</strong><small>oktabrovumrbek2023@gmail.com</small></div></a><a class="contact-link" href="https://oktabrov.sbs/" target="_blank" rel="noreferrer"><span aria-hidden="true">↗</span><div><strong>Portfolio</strong><small>oktabrov.sbs</small></div></a><a class="contact-link" href="https://www.linkedin.com/in/umrbek-oktyabrov-abaa56355" target="_blank" rel="noreferrer"><span aria-hidden="true">in</span><div><strong>LinkedIn</strong><small>Umrbek Oktyabrov</small></div></a></div></article><article class="contact-card glass-card reveal"><span class="eyebrow">Suggest a source</span><h3>What makes a good source suggestion?</h3><div class="principles"><article class="principle"><span>PRIMARY WHERE POSSIBLE</span><p>For a hurricane, an official weather agency is stronger evidence than a social-media summary.</p></article><article class="principle"><span>TRANSPARENT METHODS</span><p>Newsrooms and fact-checkers should publish corrections, methodology, ownership, and source links.</p></article><article class="principle"><span>DIVERSE &amp; RELEVANT</span><p>The registry should include local and multilingual sources that represent the people using the tool.</p></article></div><a class="btn btn-primary" href="mailto:oktabrovumrbek2023@gmail.com?subject=Fact-Check%20source%20suggestion">Suggest a source <span aria-hidden="true">→</span></a></article></section>`;
}

function renderPrivacy() {
  app.innerHTML = `${pageHead("Privacy", "Your claim deserves <em>careful handling.</em>", "Fact-Check is designed to minimize personal data while making the evidence boundary visible.")}
    <section class="page about-grid"><article class="about-card glass-card reveal"><span class="eyebrow">What the platform processes</span><h2>A check is sent only to complete that check.</h2><p>When you submit a claim or image, Fact-Check sends it to the configured AI service to route the claim and search the selected trusted-source domains. The application uses a no-store request setting and does not create a claim-history table in its PostgreSQL database.</p><p>Your hosting provider and the AI provider may process technical request data under their own policies. Do not submit passwords, financial account details, personal documents, or other sensitive information.</p></article><article class="about-card glass-card reveal"><span class="eyebrow">Accounts and contact</span><h3>Account data is deliberately limited.</h3><p>Accounts contain a name, email address, and a salted password hash. Administrator credentials remain in the server environment and are never shown in the browser.</p><h3>Questions or removal requests</h3><p>For privacy questions or an account-data request, contact <a href="mailto:oktabrovumrbek2023@gmail.com">oktabrovumrbek2023@gmail.com</a>. This page should be reviewed and adapted to the law that applies before a public production launch.</p></article></section>
    <section class="page"><div class="callout reveal"><span class="callout-icon" aria-hidden="true">!</span><div><h3>Verification is public; personal data should not be.</h3><p>Use the public source library to inspect the evidence boundary. Keep sensitive personal information out of claim text and uploads.</p></div></div></section>`;
}

function renderAccessibility() {
  app.innerHTML = `${pageHead("Accessibility", "Evidence should be <em>available to everyone.</em>", "Fact-Check aims to make source-aware verification usable across devices, input methods, and access needs.")}
    <section class="page about-grid"><article class="about-card glass-card reveal"><span class="eyebrow">Current commitments</span><h2>Designed for clear access.</h2><ul class="policy-list"><li>Keyboard-accessible navigation, forms, account controls, and source filters.</li><li>Semantic headings, labels, descriptive controls, and live feedback for important actions.</li><li>Readable contrast, responsive layouts, and a reduced-motion preference.</li><li>A public source directory and downloadable PDF list for offline reference.</li></ul></article><article class="about-card glass-card reveal"><span class="eyebrow">Help us improve</span><h3>Tell us when a barrier appears.</h3><p>If a task is difficult to complete with a screen reader, keyboard, magnification, translation tool, or another assistive technology, please tell us what happened and which page you were using.</p><a class="btn btn-primary" href="mailto:oktabrovumrbek2023@gmail.com?subject=Fact-Check%20accessibility%20feedback">Send accessibility feedback <span aria-hidden="true">→</span></a></article></section>
    <section class="page"><div class="callout reveal"><span class="callout-icon" aria-hidden="true">?</span><div><h3>Need the source list in another format?</h3><p>The current registry can be downloaded as a PDF. Contact the project team if you need help accessing it or want to suggest a more inclusive format.</p></div></div></section>`;
}

function adminLoginMarkup({ setupAllowed, configured, usernameRequired }) {
  const setup = setupAllowed;
  const usernameInput = !setup && usernameRequired
    ? `<div><label class="form-label" for="admin-username">Administrator email address</label><input id="admin-username" type="email" autocomplete="username" required /></div>`
    : "";
  const introduction = setup
    ? "This first-time setup is available only on this computer. Use a long, unique password."
    : configured
      ? "This is separate from a regular account. Use the administrator email and password configured on the server."
      : "Set ADMIN_EMAIL and ADMIN_PASSWORD in environment.env, then run database setup before accessing this administrator area.";
  const credentialInputs = setup || configured
    ? `${usernameInput}<div><label class="form-label" for="admin-password">Password</label><input id="admin-password" type="password" autocomplete="current-password" minlength="8" required /></div><span class="form-help">${setup ? "At least 8 characters." : "Administrator credentials are never displayed in the browser."}</span><button class="btn btn-primary" type="submit">${setup ? "Secure this admin area" : "Sign in"} <span aria-hidden="true">→</span></button>`
    : `<div class="warning">For security, remote first-time setup is disabled. Add ADMIN_EMAIL and a strong ADMIN_PASSWORD to environment.env, then run database setup.</div>`;
  return `<section class="page"><form class="login-box auth-box glass-card reveal visible" id="admin-auth-form"><a class="brand" href="/" data-route><span class="brand-mark" aria-hidden="true"><i></i></span><span>Fact<span>-Check</span></span></a><span class="eyebrow">Administrator area</span><h1>${setup ? "Create the first admin password" : "Administrator sign in"}</h1><p class="lead">${introduction}</p><div class="auth-form">${credentialInputs}</div></form></section>`;
}

async function renderAdmin() {
  app.innerHTML = `<section class="page"><div class="center-loader glass-card"><span class="spinner"></span><span>Loading the administrator area…</span></div></section>`;
  try {
    const status = await api("/api/admin/status");
    if (!status.authenticated) {
      app.innerHTML = adminLoginMarkup(status);
      bindAdminAuth(status);
      observeReveals();
      return;
    }
    const snapshot = await api("/api/admin/sources");
    app.innerHTML = adminDashboardMarkupV2(status, snapshot);
    bindAdminDashboardV2(status, snapshot);
    observeReveals();
  } catch (error) {
    app.innerHTML = `<section class="page"><div class="warning">${escapeHtml(error.message)}</div></section>`;
  }
}

function adminDashboardMarkupV2(status, snapshot) {
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  const editing = state.editingSourceId ? sourceById.get(state.editingSourceId) : null;
  const activeCount = snapshot.sources.filter((source) => source.active).length;
  const rows = snapshot.sources.map((source) => {
    const usageLabel = source.usageStatus === "reviewed-open-license"
      ? "Published reuse terms"
      : source.usageStatus === "reviewed-link-and-citation"
        ? "Terms reviewed"
        : "Terms review pending";
    const termsLink = source.usagePolicyUrl
      ? `<br /><a class="admin-terms-link" href="${escapeAttr(source.usagePolicyUrl)}" target="_blank" rel="noreferrer">Terms / licence ↗</a>`
      : "";
    return `<tr class="${source.active ? "" : "inactive"}"><td><strong>${escapeHtml(source.name)}</strong><br /><a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.domain)}</a>${termsLink}</td><td><span class="source-tag">${escapeHtml(source.category)}</span></td><td><span class="source-tag">${source.active ? "Active" : "Paused"}</span><span class="admin-usage-status ${source.usageStatus === "legacy-review-pending" ? "is-pending" : ""}">${usageLabel}</span></td><td><div class="table-actions"><button class="icon-btn" type="button" title="Edit source" data-admin-action="edit" data-source-id="${escapeAttr(source.id)}">✎</button><button class="icon-btn" type="button" title="${source.active ? "Pause" : "Activate"} source" data-admin-action="toggle" data-source-id="${escapeAttr(source.id)}">${source.active ? "Ⅱ" : "▶"}</button><button class="icon-btn danger" type="button" title="Remove source" data-admin-action="delete" data-source-id="${escapeAttr(source.id)}">×</button></div></td></tr>`;
  }).join("");
  const categoryText = editing?.category || "Waiting for source analysis";
  const usageStatus = editing?.usageStatus === "reviewed-open-license"
    ? "reviewed-open-license"
    : "reviewed-link-and-citation";
  return `<section class="page"><div class="admin-shell"><aside class="admin-sidebar glass-card"><strong>Source registry</strong><p>Categories determine which sources are eligible for each individual evidence search.</p><div class="admin-metric"><b>${activeCount}</b><span>active sources</span></div><div class="admin-metric"><b>${status.activeDomains}</b><span>registered domains</span></div><div class="admin-metric"><b>100</b><span>maximum domains per check</span></div><div class="admin-metric"><b>v${snapshot.version}</b><span>registry version</span></div><a class="btn btn-secondary btn-small" href="/api/sources.pdf">Download PDF</a></aside><section class="admin-panel glass-card"><div class="admin-panel-head"><div><span class="eyebrow">Administrator workspace</span><h2>Manage the source boundary</h2><p>Each new or edited source needs a high-confidence source assessment, manual ownership confirmation, and a recorded official terms or licence review.</p></div><button class="btn btn-secondary btn-small" id="admin-logout" type="button">Sign out</button></div><form class="admin-form" id="source-form"><input type="hidden" id="source-id" value="${escapeAttr(editing?.id || "")}" /><div><label class="form-label" for="source-name">Source name</label><input id="source-name" value="${escapeAttr(editing?.name || "")}" required maxlength="120" /></div><div><label class="form-label" for="source-url">Official first-party link</label><input id="source-url" type="url" value="${escapeAttr(editing?.url || "https://")}" required maxlength="2048" /><span class="form-help">HTTPS only. Social-platform domains cannot be admitted to automated checks.</span></div><div><label class="form-label" for="source-active">Search status</label><select id="source-active"><option value="true" ${editing?.active !== false ? "selected" : ""}>Active — eligible when its category is selected</option><option value="false" ${editing?.active === false ? "selected" : ""}>Paused — visible to administrators only</option></select></div><div class="source-analysis-card"><span class="mini-label">AI category assignment</span><strong id="source-category-result">${escapeHtml(categoryText)}</strong><span id="source-analysis-status">Analyze the source to receive a category and confidence check.</span><button class="text-action" id="assess-source" type="button">Analyze official source →</button></div><div class="full"><label class="form-label" for="source-rationale">Why does this domain belong in the registry?</label><textarea id="source-rationale" required maxlength="360" placeholder="State the official institution, authority, and evidence scope.">${escapeHtml(editing?.rationale || "")}</textarea></div><div><label class="form-label" for="source-usage-status">Source-use review</label><select id="source-usage-status"><option value="reviewed-link-and-citation" ${usageStatus === "reviewed-link-and-citation" ? "selected" : ""}>Reviewed for linking and citation only</option><option value="reviewed-open-license" ${usageStatus === "reviewed-open-license" ? "selected" : ""}>Published open reuse licence</option></select><span class="form-help">An open licence never includes logos, marks, or material the source excludes.</span></div><div><label class="form-label" for="source-usage-policy-url">Official terms or licence URL</label><input id="source-usage-policy-url" type="url" value="${escapeAttr(editing?.usagePolicyUrl || "https://")}" required maxlength="2048" /><span class="form-help">Use the source's own policy or licence page — not a third-party summary.</span></div><div class="full"><label class="form-label" for="source-usage-note">Usage-review note</label><textarea id="source-usage-note" required maxlength="420" placeholder="For example: Official licence permits reuse with attribution; logos, marks, and third-party material are excluded.">${escapeHtml(editing?.usageReviewNote || "")}</textarea></div><label class="source-review-check full"><input id="source-usage-review" type="checkbox" required /><span>I reviewed the official terms or licence above. Fact-Check will link to the original material and will not copy excluded content, logos, or branding.</span></label><label class="source-review-check full"><input id="source-manual-review" type="checkbox" required /><span>I manually confirmed the official ownership and scope of this domain. I understand that a low-confidence or uncertain assessment will not be admitted.</span></label><div class="full inline-actions"><button class="btn btn-primary" type="submit">${editing ? "Re-review and save source" : "Review and add source"} <span aria-hidden="true">→</span></button>${editing ? `<button class="btn btn-secondary" id="cancel-edit" type="button">Cancel edit</button>` : ""}</div></form><div class="admin-panel-head"><div><h3>Registry entries</h3><p>${snapshot.sources.length} entries · Updated ${formatDate(snapshot.updatedAt, { time: true })}</p></div><input id="admin-search" type="search" placeholder="Filter sources" aria-label="Filter all sources" /></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Source</th><th>Category</th><th>Status</th><th>Actions</th></tr></thead><tbody id="admin-source-rows">${rows}</tbody></table></div></section></div></section>`;
}

function bindAdminDashboardV2(status, snapshot) {
  const sidebarIntro = document.querySelector(".admin-sidebar p");
  if (sidebarIntro) {
    sidebarIntro.textContent = "Only active sources with a completed source-use review are eligible for automatic evidence search.";
  }
  const activeOption = document.querySelector("#source-active option[value='true']");
  if (activeOption) activeOption.textContent = "Active — public listing; automatic checks require completed review";
  const usageConfirmation = document.querySelector("#source-usage-review")?.closest("label")?.querySelector("span");
  if (usageConfirmation) {
    usageConfirmation.textContent = "I reviewed the official terms or licence above for the intended automated evidence-search and link/citation use. Fact-Check will not copy excluded content, logos, or branding.";
  }
  const automaticCheckSources = Number(status.automatedCheckSources) || 0;
  const automaticCheckDomains = Number(status.automatedCheckDomains) || 0;
  const metrics = document.querySelector(".admin-sidebar");
  if (metrics) {
    const reviewMetric = document.createElement("div");
    reviewMetric.className = "admin-metric";
    reviewMetric.innerHTML = `<b>${escapeHtml(automaticCheckSources)}</b><span>reviewed sources · ${escapeHtml(automaticCheckDomains)} domains</span>`;
    metrics.insertBefore(reviewMetric, metrics.querySelector("a"));
  }
  const form = document.querySelector("#source-form");
  const sourceMap = new Map(snapshot.sources.map((source) => [source.id, source]));
  const analysisButton = document.querySelector("#assess-source");
  const analysisStatus = document.querySelector("#source-analysis-status");
  const categoryResult = document.querySelector("#source-category-result");
  const formPayload = () => ({
    name: document.querySelector("#source-name").value,
    url: document.querySelector("#source-url").value,
    rationale: document.querySelector("#source-rationale").value,
    active: document.querySelector("#source-active").value === "true",
    usageStatus: document.querySelector("#source-usage-status").value,
    usagePolicyUrl: document.querySelector("#source-usage-policy-url").value,
    usageReviewNote: document.querySelector("#source-usage-note").value,
    usageReviewed: document.querySelector("#source-usage-review").checked,
    manualReviewed: document.querySelector("#source-manual-review").checked,
  });

  document.querySelector("#admin-logout").addEventListener("click", async () => {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
    state.editingSourceId = null;
    toast("Signed out.");
    render();
  });
  document.querySelector("#cancel-edit")?.addEventListener("click", () => { state.editingSourceId = null; renderAdmin(); });

  analysisButton.addEventListener("click", async () => {
    const analysisInputs = ["#source-name", "#source-url", "#source-rationale"].map((selector) => document.querySelector(selector));
    if (analysisInputs.some((input) => !input.reportValidity())) return;
    analysisButton.disabled = true;
    analysisStatus.textContent = "Checking first-party ownership, reliability, and category…";
    try {
      const response = await api("/api/admin/sources/assess", { method: "POST", body: JSON.stringify(formPayload()) });
      const assessment = response.assessment;
      categoryResult.textContent = response.category?.label || assessment.categoryKey;
      analysisStatus.textContent = assessment.eligible && assessment.confidence === "high"
        ? "High-confidence eligible assessment: " + assessment.reason
        : "Not eligible for admission: " + assessment.reason;
      analysisStatus.classList.toggle("is-approved", assessment.eligible && assessment.confidence === "high");
      analysisStatus.classList.toggle("is-rejected", !assessment.eligible || assessment.confidence !== "high");
    } catch (error) {
      analysisStatus.textContent = error.message;
      analysisStatus.classList.remove("is-approved");
      analysisStatus.classList.add("is-rejected");
      toast(error.message, "error");
    } finally {
      analysisButton.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = document.querySelector("#source-id").value;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> Reviewing source`;
    try {
      await api(id ? `/api/admin/sources/${encodeURIComponent(id)}` : "/api/admin/sources", { method: id ? "PATCH" : "POST", body: JSON.stringify(formPayload()) });
      state.sourceData = null;
      state.editingSourceId = null;
      toast(id ? "Source re-reviewed and saved." : "Source admitted to the registry.", "success");
      renderAdmin();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.innerHTML = editingLabel(id);
    }
  });

  document.querySelectorAll("[data-admin-action]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.sourceId;
    const source = sourceMap.get(id);
    if (!source) return;
    const action = button.dataset.adminAction;
    if (action === "edit") { state.editingSourceId = id; renderAdmin(); return; }
    if (action === "delete" && !window.confirm(`Remove ${source.name} from the registry?`)) return;
    button.disabled = true;
    try {
      if (action === "delete") await api(`/api/admin/sources/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
      if (action === "toggle") await api(`/api/admin/sources/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ active: !source.active }) });
      state.sourceData = null;
      toast(action === "delete" ? "Source removed." : source.active ? "Source paused." : "Source activated.", "success");
      renderAdmin();
    } catch (error) { toast(error.message, "error"); button.disabled = false; }
  }));
  document.querySelector("#admin-search").addEventListener("input", (event) => {
    const term = event.target.value.trim().toLowerCase();
    document.querySelectorAll("#admin-source-rows tr").forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(term); });
  });
}

function editingLabel(id) {
  return id ? `Re-review and save source <span aria-hidden="true">→</span>` : `Review and add source <span aria-hidden="true">→</span>`;
}

function bindAdminAuth(status) {
  const form = document.querySelector("#admin-auth-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.querySelector("#admin-password").value;
    const email = document.querySelector("#admin-username")?.value || "";
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await api(status.setupAllowed ? "/api/admin/setup" : "/api/admin/login", { method: "POST", body: JSON.stringify({ email, password }) });
      await refreshCurrentUser();
      toast(status.setupAllowed ? "Admin password created." : "Signed in.", "success");
      render();
    } catch (error) {
      toast(error.message, "error");
    } finally { button.disabled = false; }
  });
}

function renderLogin() {
  if (isSignedIn()) {
    navigate(postLoginDestination());
    return;
  }
  app.innerHTML = `<section class="page page-narrow"><form class="login-box auth-box glass-card reveal visible" id="user-login-form"><span class="eyebrow">Account sign in</span><h1>Log in to verify with care.</h1><p class="lead">A Fact-Check account is required before a claim or image is sent for verification. Browsing the source library remains public.</p><div class="auth-form"><div><label class="form-label" for="login-email">Email address</label><input id="login-email" name="email" type="email" autocomplete="email" required maxlength="254" /></div><div><label class="form-label" for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required /></div><button class="btn btn-primary" type="submit">Log in <span aria-hidden="true">→</span></button></div><p class="auth-switch">Need an account? <a href="/signup${escapeAttr(window.location.search)}" data-route>Create one</a></p><p class="auth-admin">Administrator account? Enter its email above, or <a href="/admin" data-route>sign in directly</a>.</p></form></section>`;
  bindUserLogin();
}

function bindUserLogin() {
  const form = document.querySelector("#user-login-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Logging in...";
    try {
      const response = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: document.querySelector("#login-email").value,
          password: document.querySelector("#login-password").value,
        }),
      });
      if (response.administrator) {
        state.currentUser = null;
        state.adminUser = response.user || null;
        toast("Administrator sign-in successful.", "success");
        navigate(postLoginDestination());
        return;
      }
      state.currentUser = response.user;
      state.adminUser = null;
      toast("Welcome back.", "success");
      navigate(postLoginDestination());
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.innerHTML = `Log in <span aria-hidden="true">→</span>`;
    }
  });
}

function renderSignup() {
  if (isSignedIn()) {
    navigate(postLoginDestination());
    return;
  }
  app.innerHTML = `<section class="page page-narrow"><form class="login-box auth-box glass-card reveal visible" id="user-signup-form"><span class="eyebrow">Create your account</span><h1>Make checking before sharing a habit.</h1><p class="lead">Create a Fact-Check account in a few seconds. Your account never gives access to the administrator area.</p><div class="auth-form"><div><label class="form-label" for="signup-name">Your name</label><input id="signup-name" name="name" type="text" autocomplete="name" required minlength="2" maxlength="80" /></div><div><label class="form-label" for="signup-email">Email address</label><input id="signup-email" name="email" type="email" autocomplete="email" required maxlength="254" /></div><div><label class="form-label" for="signup-password">Password</label><input id="signup-password" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="256" /><span class="form-help">Use at least 12 characters.</span></div><div><label class="form-label" for="signup-confirm-password">Confirm password</label><input id="signup-confirm-password" type="password" autocomplete="new-password" required /></div><button class="btn btn-primary" type="submit">Create account <span aria-hidden="true">→</span></button></div><p class="auth-switch">Already have an account? <a href="/login${escapeAttr(window.location.search)}" data-route>Log in</a></p></form></section>`;
  bindUserSignup();
}

function bindUserSignup() {
  const form = document.querySelector("#user-signup-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.querySelector("#signup-password").value;
    const confirmation = document.querySelector("#signup-confirm-password").value;
    if (password !== confirmation) {
      toast("The password confirmation does not match.", "error");
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Creating account...";
    try {
      const response = await api("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          name: document.querySelector("#signup-name").value,
          email: document.querySelector("#signup-email").value,
          password,
        }),
      });
      state.currentUser = response.user;
      state.adminUser = null;
      toast("Your account is ready.", "success");
      navigate(postLoginDestination());
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.innerHTML = `Create account <span aria-hidden="true">→</span>`;
    }
  });
}

function donationActionMarkup(donation, { compact = false } = {}) {
  if (donation.enabled && donation.url) {
    return `<a class="btn ${compact ? "btn-secondary" : "btn-primary"}" href="${escapeAttr(donation.url)}" target="_blank" rel="noreferrer">Support through ${escapeHtml(donation.provider)} <span aria-hidden="true">↗</span></a>`;
  }
  return `<a class="btn ${compact ? "btn-secondary" : "btn-primary"}" href="/donate" data-route>Learn how to support <span aria-hidden="true">→</span></a>`;
}

async function renderAccount() {
  app.innerHTML = `<section class="page"><div class="center-loader glass-card"><span class="spinner"></span><span>Loading your profile...</span></div></section>`;
  try {
    const [profile, donation] = await Promise.all([refreshCurrentUser(), loadDonationConfig()]);
    if (!profile) {
      app.innerHTML = `<section class="page page-narrow"><div class="login-box auth-box glass-card reveal visible"><span class="eyebrow">Your profile</span><h1>Log in to continue.</h1><p class="lead">A Fact-Check account is required to verify claims and view your profile.</p><div class="inline-actions"><a class="btn btn-primary" href="/login?next=%2Faccount" data-route>Log in <span aria-hidden="true">→</span></a><a class="btn btn-secondary" href="/signup?next=%2Faccount" data-route>Create account</a></div></div></section>`;
      observeReveals();
      return;
    }

    const administrator = Boolean(state.adminUser);
    const user = profile;
    const accountType = administrator ? "Administrator profile" : "Member profile";
    const accessCopy = administrator
      ? "Your administrator session is active. You can manage the source registry from the protected control panel."
      : "Your account is ready to use the verification workspace. Source browsing remains public, while claim checks require sign-in.";
    const adminPanel = administrator
      ? `<a class="btn btn-secondary" href="/admin" data-route>Open admin panel <span aria-hidden="true">→</span></a>`
      : "";
    const donationStatus = donation.enabled
      ? `Contributions are securely processed by ${escapeHtml(donation.provider)} on its hosted payment page.`
      : "Donations are being prepared. The donation page explains the secure provider setup required before any payment is accepted.";

    app.innerHTML = `<section class="page profile-page"><article class="profile-hero glass-card reveal visible"><div class="profile-identity"><div class="profile-avatar" aria-hidden="true">${escapeHtml(profileInitials(user))}</div><div><span class="eyebrow">${accountType}</span><h1>${escapeHtml(user.name)}</h1><p class="account-email">${escapeHtml(user.email)}</p><p class="profile-member">Member since ${escapeHtml(formatDate(user.createdAt, { short: true }))}</p></div></div><div class="profile-session"><span class="status-pill">● Signed in</span><span>${administrator ? "Registry manager" : "Verification member"}</span></div></article><section class="profile-grid"><article class="profile-panel glass-card reveal"><span class="mini-label">Account access</span><h2>Your verification space is ready.</h2><p>${accessCopy}</p><div class="profile-actions"><a class="btn btn-primary" href="/check" data-route>Verify a claim <span aria-hidden="true">→</span></a><a class="btn btn-secondary" href="/sources" data-route>Browse sources</a>${adminPanel}</div></article><article class="profile-panel glass-card reveal"><span class="mini-label">Account details</span><h2>Clear, private, in your control.</h2><dl class="profile-details"><div><dt>Email address</dt><dd>${escapeHtml(user.email)}</dd></div><div><dt>Account role</dt><dd>${administrator ? "Administrator" : "Member"}</dd></div><div><dt>Verification access</dt><dd>Enabled</dd></div></dl></article><article class="profile-panel profile-support glass-card reveal"><span class="mini-label">Support Fact-Check</span><h2>Help keep evidence access open.</h2><p>${donationStatus}</p><div class="profile-actions">${donationActionMarkup(donation)}<a class="text-action" href="/donate" data-route>See support details →</a></div></article><article class="profile-panel glass-card reveal"><span class="mini-label">What stays public</span><h2>Source transparency, without open access to checks.</h2><p>The public source library and method stay open to everyone. Your profile gives you access to the protected verification workspace and its account safeguards.</p><a class="text-action" href="/method" data-route>Read the verification method →</a></article></section></section>`;
    observeReveals();
  } catch (error) {
    app.innerHTML = `<section class="page"><div class="warning">${escapeHtml(error.message)}</div></section>`;
  }
}

async function renderDonate() {
  app.innerHTML = `<section class="page"><div class="center-loader glass-card"><span class="spinner"></span><span>Loading support options...</span></div></section>`;
  const donation = await loadDonationConfig();
  const provider = escapeHtml(donation.provider);
  const paymentAction = donation.enabled && donation.url
    ? `<a class="btn btn-primary" href="${escapeAttr(donation.url)}" target="_blank" rel="noreferrer">Continue to ${provider} <span aria-hidden="true">↗</span></a>`
    : `<a class="btn btn-primary" href="mailto:oktabrovumrbek2023@gmail.com?subject=Supporting%20Fact-Check">Contact us about supporting <span aria-hidden="true">→</span></a>`;
  const readiness = donation.enabled
    ? `A hosted ${provider} payment page is available. Fact-Check does not collect, process, or store payment-card details.`
    : `A live payment link has not been configured yet. Before accepting contributions, connect an approved provider and add its HTTPS payment link to the private server configuration.`;
  app.innerHTML = `${pageHead("Support Fact-Check", "Keep evidence tools <em>accessible.</em>", "Your support can help maintain a transparent source registry, improve media-literacy access, and keep verification focused on evidence rather than advertising.")}<section class="page donation-layout"><article class="donation-hero glass-card reveal"><span class="status-pill">Independent support</span><h2>Contribute through a secure hosted checkout.</h2><p>${readiness}</p><div class="donation-actions">${paymentAction}<a class="btn btn-secondary" href="/sources" data-route>See the public source library</a></div><p class="donation-fineprint">Contributions are voluntary. They do not influence fact-check outcomes, source admission, or the visibility of any claim.</p></article><aside class="donation-sidebar"><article class="donation-note glass-card reveal"><span class="mini-label">Where support goes</span><h3>Trust infrastructure</h3><p>Source-governance reviews, accessibility improvements, and the ongoing cost of secure evidence checks.</p></article><article class="donation-note glass-card reveal"><span class="mini-label">Payment privacy</span><h3>Your card details stay with ${provider}.</h3><p>Fact-Check uses a hosted provider page instead of embedding card fields in this website.</p></article><article class="donation-note glass-card reveal"><span class="mini-label">Transparency</span><h3>Support never buys a verdict.</h3><p>Verification remains bound to the same public source rules for everyone.</p></article></aside></section><section class="page donation-next reveal"><div class="callout"><span class="callout-icon" aria-hidden="true">i</span><div><h3>Want to support another way?</h3><p>Contact the project team to discuss a partnership, in-kind support, or an institutional contribution.</p></div><a class="text-action" href="/contact" data-route>Contact Fact-Check →</a></div></section>`;
  observeReveals();
}

function renderNotFound() {
  app.innerHTML = `<section class="page page-narrow"><div class="login-box glass-card reveal visible"><span class="eyebrow">404</span><h1>That page is not in the evidence file.</h1><p class="lead">Return home or explore the trusted source directory.</p><div class="inline-actions"><a class="btn btn-primary" href="/" data-route>Back home</a><a class="btn btn-secondary" href="/sources" data-route>Trusted sources</a></div></div></section>`;
}

function render() {
  const pathname = window.location.pathname.replace(/\/$/, "") || "/";
  document.title = titleFor(pathname);
  const renderers = { "/": renderHome, "/check": renderCheck, "/video": renderVideo, "/sources": renderSources, "/method": renderMethodV2, "/about": renderAboutV2, "/contact": renderContact, "/privacy": renderPrivacy, "/accessibility": renderAccessibility, "/login": renderLogin, "/signup": renderSignup, "/account": renderAccount, "/donate": renderDonate, "/admin": renderAdmin };
  (renderers[pathname] || renderNotFound)();
  updateNav();
  observeReveals();
  window.requestAnimationFrame(() => app.focus({ preventScroll: true }));
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target) return;
  const href = link.getAttribute("href");
  if (!href || !href.startsWith("/")) return;
  event.preventDefault();
  navigate(href);
});

navToggle.addEventListener("click", () => {
  const isOpen = nav.classList.toggle("open");
  navToggle.classList.toggle("open", isOpen);
  navToggle.setAttribute("aria-expanded", String(isOpen));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && nav.classList.contains("open")) {
    closeMenu();
    navToggle.focus();
  }
});

window.addEventListener("popstate", render);
render();
void refreshCurrentUser();
