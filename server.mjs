import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { bootstrapEnvironmentAdministrator, createAuth, createUserAuth } from "./lib/auth.mjs";
import { categoryForKey, categoryLabel, categorySummary, isBlockedPlatformDomain, SOURCE_CATEGORIES } from "./lib/categories.mjs";
import { assertDatabaseReady, createDatabasePool } from "./lib/db.mjs";
import { PUBLIC_DIR, loadConfig } from "./lib/config.mjs";
import { assessTrustedSourceWithOpenAI, checkClaimWithOpenAI, classifyClaimCategories } from "./lib/openai.mjs";
import { trustedSourcesPdf } from "./lib/pdf.mjs";
import { canonicalUrl, createSourceStore, selectSourcesForCategories, sourceDomain } from "./lib/store.mjs";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

// Video bucket configuration
function getBucketConfig() {
  return {
    bucket: process.env.BUCKET || null,
    region: process.env.REGION || null,
    endpoint: process.env.ENDPOINT || null,
    accessKeyId: process.env.ACCESS_KEY_ID || null,
    secretAccessKey: process.env.SECRET_ACCESS_KEY || null,
  };
}

function getVideoContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".m4v": "video/x-m4v",
    ".flv": "video/x-flv",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".3gp": "video/3gpp",
    ".m3u8": "video/mp2t",
    ".ts": "video/mp2t",
  };
  return types[ext] || "application/octet-stream";
}

function isVideoFile(key) {
  const videoExtensions = /\.(mp4|mov|webm|mkv|avi|m4v|flv|mpg|mpeg|3gp|m3u8|ts)$/i;
  return videoExtensions.test(key);
}

async function getVideoFromBucket(bucketConfig) {
  if (!bucketConfig.bucket || !bucketConfig.endpoint) {
    return null;
  }

  try {
    const bucketUrl = new URL(bucketConfig.endpoint);
    bucketUrl.pathname = `/${bucketConfig.bucket}`;
    
    const headers = {
      "Authorization": `AWS4-HMAC-SHA256 Credential=${bucketConfig.accessKeyId}`,
    };

    // Construct S3 ListObjects request
    const listUrl = new URL(`${bucketUrl}?list-type=2&max-keys=1000`);
    const response = await fetch(listUrl.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!response || !response.ok) return null;

    const text = await response.text();
    
    // Parse XML response to find first video
    const keyMatches = text.match(/<Key>([^<]+)<\/Key>/g);
    if (!keyMatches) return null;

    for (const match of keyMatches) {
      const key = match.replace(/<\/?Key>/g, "");
      if (isVideoFile(key)) {
        return key;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function streamVideoFromBucket(bucketConfig, videoKey, response) {
  try {
    const bucketUrl = new URL(bucketConfig.endpoint);
    bucketUrl.pathname = `/${bucketConfig.bucket}/${encodeURIComponent(videoKey)}`;

    const videoResponse = await fetch(bucketUrl.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(30_000),
    });

    if (!videoResponse.ok) {
      return sendError(response, 502, "Could not fetch video from storage.");
    }

    const contentType = getVideoContentType(videoKey);
    const contentLength = videoResponse.headers.get("content-length");
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      "Accept-Ranges": "bytes",
    };

    if (contentLength) {
      headers["Content-Length"] = contentLength;
    }

    response.writeHead(200, headers);

    const nodeStream = Readable.fromWeb(videoResponse.body);
    nodeStream.on("error", () => {
      if (!response.headersSent) {
        sendError(response, 502, "Video stream failed.");
      } else {
        response.destroy();
      }
    });
    nodeStream.pipe(response);
  } catch (error) {
    if (!response.headersSent) {
      sendError(response, 502, "Could not stream video.");
    } else {
      response.destroy();
    }
  }
}

const REVIEWED_USAGE_STATUSES = new Set([
  "reviewed-link-and-citation",
  "reviewed-open-license",
]);
const EVIDENCE_VERDICTS = new Set(["SUPPORTED", "CONTRADICTED", "MISLEADING", "MIXED", "INSUFFICIENT"]);
const INSUFFICIENT_EVIDENCE_ANSWER = "There is not enough reliable information in the selected sources to verify this claim.";

function publicDonationConfig(config) {
  const provider = String(config.donationProvider || "Secure payment provider").trim().slice(0, 80) || "Secure payment provider";
  const rawUrl = String(config.donationUrl || "").trim();
  if (!rawUrl) return { enabled: false, provider, url: null };
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid donation URL");
    return { enabled: true, provider, url: url.toString() };
  } catch {
    return { enabled: false, provider, url: null };
  }
}

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'");
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function sendFile(response, filePath, method) {
  const extension = path.extname(filePath).toLowerCase();
  const data = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "Cache-Control": [".html", ".js", ".css"].includes(extension) ? "no-cache" : "public, max-age=3600",
  });
  if (method !== "HEAD") response.end(data);
  else response.end();
}

function readJson(request, maxBytes = 7 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("This request is too large. Please use an image smaller than 4 MB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Please send a valid request."));
      }
    });
    request.on("error", (error) => reject(error));
  });
}

function safePathname(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isAssetRequest(pathname) {
  return path.extname(pathname).length > 0;
}

function activeSourcesFromSnapshot(snapshot) {
  return snapshot.sources.filter((source) => (
    source.active
    && REVIEWED_USAGE_STATUSES.has(source.usageStatus)
    && Boolean(source.usagePolicyUrl)
  ));
}

function automatedCheckSourcesFromSnapshot(snapshot) {
  return activeSourcesFromSnapshot(snapshot);
}

function domainsFromSources(sources) {
  return [...new Set(sources.map((source) => source.domain))].sort();
}

function sourceLabelForSelectedUrl(candidate, sources) {
  try {
    const checkedUrl = new URL(candidate);
    if (checkedUrl.protocol !== "https:") return "";
    const domain = sourceDomain(checkedUrl);
    const match = sources.find((source) => domain === source.domain || domain.endsWith("." + source.domain));
    return match?.name || "";
  } catch {
    return "";
  }
}

function publicCitations(sources, isApprovedUrl, sourceLabelForUrl) {
  const citations = [];
  const seen = new Set();
  for (const source of Array.isArray(sources) ? sources : []) {
    const url = String(source?.url || "").trim();
    if (!url || seen.has(url) || !isApprovedUrl(url)) continue;
    const suppliedTitle = String(source?.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
    citations.push({
      url,
      title: suppliedTitle && suppliedTitle !== "Approved source"
        ? suppliedTitle
        : (sourceLabelForUrl(url) || "Approved source"),
    });
    seen.add(url);
  }
  return citations;
}

function evidenceVerdict(value) {
  const verdict = String(value || "").trim().toUpperCase();
  return EVIDENCE_VERDICTS.has(verdict) ? verdict : "INSUFFICIENT";
}

function publicEvidenceResult(result, isApprovedUrl, sourceLabelForUrl) {
  const verdict = evidenceVerdict(result?.verdict);
  const citations = publicCitations(result?.sources, isApprovedUrl, sourceLabelForUrl);
  const answer = String(result?.answer || result?.explanation || "").replace(/\s+/g, " ").trim().slice(0, 520);

  // A verdict without a validated citation is not a completed fact check. The
  // same is true when the evidence search itself reports insufficient evidence.
  // In both cases, return a clear uncertainty message and no source list.
  if (verdict === "INSUFFICIENT" || !citations.length || !answer) {
    return {
      verdict: "INSUFFICIENT",
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      sources: [],
    };
  }

  return { verdict, answer, sources: citations };
}

async function publicSourceResponse(store, url) {
  const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const categoryKey = String(url.searchParams.get("category") || "").trim();
  const snapshot = await store.snapshot();
  const activeSources = activeSourcesFromSnapshot(snapshot);
  const automatedCheckSources = automatedCheckSourcesFromSnapshot(snapshot);
  const sources = activeSources.filter((source) => {
    if (categoryKey && !source.categoryKeys.includes(categoryKey)) return false;
    if (!query) return true;
    return [source.name, source.domain, source.category, source.categoryKey, ...(source.categoryKeys || []), ...(source.categoryLabels || []), source.rationale].join(" ").toLowerCase().includes(query);
  });
  const categories = categorySummary(activeSources);
  return {
    version: snapshot.version,
    updatedAt: snapshot.updatedAt,
    sourceCount: activeSources.length,
    automatedCheckSourceCount: automatedCheckSources.length,
    automatedCheckDomainCount: domainsFromSources(automatedCheckSources).length,
    categories,
    categoryCounts: categories,
    sources,
  };
}

function createRateLimiter({ maxAttempts, windowMs, maxEntries = 5_000 }) {
  const attempts = new Map();
  return (request) => {
    const key = request.socket?.remoteAddress || "unknown";
    const now = Date.now();
    if (!attempts.has(key) && attempts.size >= maxEntries) {
      for (const [trackedKey, tracked] of attempts) {
        if (tracked.resetAt <= now) attempts.delete(trackedKey);
      }
      if (attempts.size >= maxEntries) return false;
    }
    const existing = attempts.get(key);
    if (!existing || existing.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (existing.count >= maxAttempts) return false;
    existing.count += 1;
    return true;
  };
}

export function createApp(options = {}) {
  const config = options.config || loadConfig();
  const ownsPool = !options.pool;
  const pool = options.pool || createDatabasePool(config);
  const sourceStore = options.sourceStore || createSourceStore(pool);
  const adminAuth = options.auth || createAuth({
    pool,
    adminEmail: config.adminEmail || config.adminUsername,
    adminPassword: config.adminPassword,
    production: config.nodeEnv === "production",
  });
  const userAuth = options.userAuth || createUserAuth({
    pool,
    production: config.nodeEnv === "production",
  });
  const claimCategoryClassifier = options.classifyClaimCategories || classifyClaimCategories;
  const evidenceChecker = options.checkClaimWithOpenAI || checkClaimWithOpenAI;
  const sourceAssessor = options.assessTrustedSourceWithOpenAI || assessTrustedSourceWithOpenAI;
  const accountAttemptAllowed = createRateLimiter({ maxAttempts: 12, windowMs: 15 * 60 * 1000 });
  const adminAttemptAllowed = createRateLimiter({ maxAttempts: 8, windowMs: 15 * 60 * 1000 });
  const claimAttemptAllowed = createRateLimiter({ maxAttempts: 8, windowMs: 15 * 60 * 1000 });

  async function requireAdmin(request, response) {
    if (!(await adminAuth.isAuthenticated(request))) {
      sendError(response, 401, "Please sign in to continue.");
      return false;
    }
    return true;
  }

  function sourceUsageFromRequest(body, existing = null, { requireConfirmation = false } = {}) {
    const usageStatus = String(body.usageStatus || existing?.usageStatus || "").trim();
    const rawUsagePolicyUrl = String(body.usagePolicyUrl || existing?.usagePolicyUrl || "").trim();
    const usageReviewNote = String(body.usageReviewNote || existing?.usageReviewNote || "").trim().replace(/\s+/g, " ");
    const usageReviewed = body.usageReviewed === true;
    if (!REVIEWED_USAGE_STATUSES.has(usageStatus)) {
      throw new Error("Choose whether the source was reviewed for link-and-citation use or an open reuse licence.");
    }
    if (!rawUsagePolicyUrl) {
      throw new Error("Add the source's official terms or licence URL before adding it.");
    }
    const usagePolicyUrl = canonicalUrl(rawUsagePolicyUrl);
    if (usageReviewNote.length < 8 || usageReviewNote.length > 420) {
      throw new Error("Add a short source-usage note explaining the official terms or licence.");
    }
    if (requireConfirmation && !usageReviewed) {
      throw new Error("Confirm that you reviewed the source's official terms or licence before adding it.");
    }
    return {
      usageStatus,
      usagePolicyUrl,
      usageReviewNote,
      usageReviewed,
      usageReviewedAt: new Date().toISOString(),
    };
  }

  async function assessSourceAdmission(body, existing = null, { manualReviewed = false, requireManualReview = true, allowIneligiblePreview = false } = {}) {
    if (!config.apiKey) throw new Error("The source-admission AI key is not configured on this server.");
    const candidateUrl = canonicalUrl(body.url || existing?.url || "");
    const domain = sourceDomain(candidateUrl);
    if (isBlockedPlatformDomain(domain)) {
      throw new Error("Social-platform domains cannot be admitted to the automated trusted-source registry. Use an official first-party website instead.");
    }

    const candidate = {
      name: String(body.name || existing?.name || "").trim(),
      url: candidateUrl,
      domain,
      rationale: String(body.rationale || body.description || existing?.rationale || "").trim(),
    };
    if (candidate.name.length < 2) throw new Error("A source name is required.");
    if (candidate.rationale.length < 8) throw new Error("Please add a short reason for trusting this source.");
    const usage = requireManualReview
      ? sourceUsageFromRequest(body, existing, { requireConfirmation: true })
      : null;
    const assessment = await sourceAssessor({
      apiKey: config.apiKey,
      model: config.model,
      source: candidate,
      categories: SOURCE_CATEGORIES,
    });

    const review = {
      candidateUrl,
      categoryKey: assessment.categoryKey,
      eligible: assessment.eligible,
      manualReviewed,
      ...(usage || {}),
      reason: assessment.reason || "No source-admission explanation was returned.",
    };

    if (!assessment.eligible || assessment.confidence !== "high") {
      if (allowIneligiblePreview) {
        return {
          ...candidate,
          categoryKey: assessment.categoryKey,
          category: categoryLabel(assessment.categoryKey),
          admission: assessment,
          review,
        };
      }
      await sourceStore.recordAdmissionReview(review);
      throw new Error("The source was not admitted. Fact-Check requires a high-confidence official-source assessment with no material uncertainty.");
    }
    if (requireManualReview && !manualReviewed) {
      await sourceStore.recordAdmissionReview(review);
      throw new Error("Confirm that you manually reviewed the source's official ownership and scope before adding it.");
    }

    return {
      ...candidate,
      categoryKey: assessment.categoryKey,
      category: categoryLabel(assessment.categoryKey),
      ...(usage || {}),
      admission: assessment,
      review,
    };
  }

  function sourceFieldsFromRequest(body) {
    const fields = ["name", "url", "rationale", "description", "active", "usageStatus", "usagePolicyUrl", "usageReviewNote", "usageReviewedAt"];
    return Object.fromEntries(fields.filter((field) => Object.hasOwn(body, field)).map((field) => [field, body[field]]));
  }

  const app = http.createServer(async (request, response) => {
    securityHeaders(response);
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const pathname = safePathname(requestUrl.pathname);

    if (!pathname) return sendError(response, 400, "Invalid request path.");

    if (pathname === "/video" || pathname.startsWith("/video/")) {
  const bucketConfig = getBucketConfig();
  if (!bucketConfig.bucket) {
    return sendError(response, 503, "Video service is not configured.");
  }
  
  try {
    const videoKey = await getVideoFromBucket(bucketConfig);
    if (!videoKey) {
      return sendError(response, 404, "No video available.");
    }
    return streamVideoFromBucket(bucketConfig, videoKey, response);
  } catch (error) {
    return sendError(response, 502, "Video service error.");
  }
}

    try {
      if (pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
        const snapshot = await sourceStore.snapshot();
        const activeSources = activeSourcesFromSnapshot(snapshot);
        const automatedCheckSources = automatedCheckSourcesFromSnapshot(snapshot);
        const health = {
          ok: true,
          database: "postgresql",
          apiConfigured: Boolean(config.apiKey),
          activeSources: activeSources.length,
          activeDomains: domainsFromSources(activeSources).length,
          automatedCheckSources: automatedCheckSources.length,
          automatedCheckDomains: domainsFromSources(automatedCheckSources).length,
          model: config.model,
        };
        if (request.method === "HEAD") {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          return response.end();
        }
        return sendJson(response, 200, health);
      }

      if (pathname === "/api/sources" && request.method === "GET") {
        return sendJson(response, 200, await publicSourceResponse(sourceStore, requestUrl));
      }

      if (pathname === "/api/sources.pdf" && request.method === "GET") {
        const snapshot = await sourceStore.snapshot();
        const sources = activeSourcesFromSnapshot(snapshot);
        const pdf = trustedSourcesPdf({ sources, version: snapshot.version, updatedAt: snapshot.updatedAt });
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment; filename=fact-check-trusted-sources-v" + snapshot.version + ".pdf",
          "Cache-Control": "no-store",
          "Content-Length": pdf.length,
        });
        return response.end(pdf);
      }

      if (pathname === "/api/auth/status" && request.method === "GET") {
        return sendJson(response, 200, {
          user: await userAuth.currentUser(request),
          administrator: await adminAuth.currentUser(request),
        });
      }

      if (pathname === "/api/auth/signup" && request.method === "POST") {
        if (!accountAttemptAllowed(request)) return sendError(response, 429, "Too many account attempts. Please try again later.");
        const body = await readJson(request, 64 * 1024);
        const account = await userAuth.signup({
          name: String(body.name || ""),
          email: String(body.email || ""),
          password: String(body.password || ""),
        });
        return sendJson(response, 201, { user: account.user }, { "Set-Cookie": userAuth.cookie(account.token) });
      }

      if (pathname === "/api/auth/login" && request.method === "POST") {
        if (!accountAttemptAllowed(request)) return sendError(response, 429, "Too many account attempts. Please try again later.");
        const body = await readJson(request, 64 * 1024);
        const account = await userAuth.login({
          email: String(body.email || ""),
          password: String(body.password || ""),
        });
        if (!account) return sendError(response, 401, "Email or password is not correct.");
        if (account.administrator) {
          const token = await adminAuth.login(String(body.email || ""), String(body.password || ""));
          if (!token) return sendError(response, 401, "Email or password is not correct.");
          return sendJson(response, 200, { administrator: true, user: account.user }, { "Set-Cookie": adminAuth.cookie(token) });
        }
        return sendJson(response, 200, { user: account.user }, { "Set-Cookie": userAuth.cookie(account.token) });
      }

      if (pathname === "/api/auth/logout" && request.method === "POST") {
        await userAuth.logout(request);
        return sendJson(response, 200, { ok: true }, { "Set-Cookie": userAuth.expiredCookie() });
      }

      if (pathname === "/api/donation" && request.method === "GET") {
        return sendJson(response, 200, publicDonationConfig(config));
      }

      if (pathname === "/api/check" && request.method === "POST") {
        const authenticatedUser = await userAuth.currentUser(request);
        const authenticatedAdministrator = authenticatedUser ? null : await adminAuth.currentUser(request);
        if (!authenticatedUser && !authenticatedAdministrator) {
          return sendError(response, 401, "Log in to verify a claim.");
        }
        if (!claimAttemptAllowed(request)) return sendError(response, 429, "Too many verification requests from this connection. Please wait a few minutes and try again.");
        const body = await readJson(request);
        const claim = String(body.claim || "").trim();
        const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";
        if (!claim && !imageDataUrl) return sendError(response, 400, "Enter a claim or attach an image to check.");
        if (claim.length > 1800) return sendError(response, 400, "Please keep the claim under 1,800 characters.");
        if (!config.apiKey) return sendError(response, 503, "The fact-checking API key is not configured on this server.");

        const snapshot = await sourceStore.snapshot();
        const activeSources = activeSourcesFromSnapshot(snapshot);
        const automatedCheckSources = automatedCheckSourcesFromSnapshot(snapshot);
        const categories = categorySummary(activeSources);
        const selection = await claimCategoryClassifier({
          apiKey: config.apiKey,
          model: config.model,
          claim,
          imageDataUrl,
          categories,
        });
        const selected = selectSourcesForCategories(automatedCheckSources, selection.categoryKeys);
        const domains = selected.domains;
        const categorySelection = {
          categoryKeys: selection.categoryKeys,
          categories: selection.categoryKeys.map((key) => categoryForKey(key)).filter(Boolean),
          reason: selection.reason,
          selectedSourceCount: selected.sources.length,
          selectedDomainCount: domains.length,
          matchingSourceCount: selected.matchingSourceCount,
          truncated: selected.truncated,
        };
        if (!domains.length) {
          const answer = "There is not enough eligible source information in the selected category to verify this claim.";
          return sendJson(response, 200, {
            verdict: "INSUFFICIENT",
            answer,
            explanation: answer,
            sources: [],
            checkedAt: new Date().toISOString(),
            model: config.model,
            registryVersion: snapshot.version,
            categorySelection,
          });
        }
        const isApprovedUrl = (candidate) => {
          try {
            const checkedUrl = new URL(candidate);
            if (checkedUrl.protocol !== "https:") return false;
            const hostname = sourceDomain(checkedUrl);
            return domains.some((domain) => hostname === domain || hostname.endsWith("." + domain));
          } catch {
            return false;
          }
        };

        const result = await evidenceChecker({
          apiKey: config.apiKey,
          model: config.model,
          claim,
          imageDataUrl,
          domains,
          sources: selected.sources,
          isApprovedUrl,
          sourceLabelForUrl: (candidate) => sourceLabelForSelectedUrl(candidate, selected.sources),
        });
        const publicResult = publicEvidenceResult(
          result,
          isApprovedUrl,
          (candidate) => sourceLabelForSelectedUrl(candidate, selected.sources),
        );
        return sendJson(response, 200, {
          verdict: publicResult.verdict,
          answer: publicResult.answer,
          explanation: publicResult.answer,
          sources: publicResult.sources,
          checkedAt: result.checkedAt,
          model: result.model || config.model,
          registryVersion: snapshot.version,
          categorySelection,
        });
      }

      if (pathname === "/api/admin/status" && request.method === "GET") {
        const snapshot = await sourceStore.snapshot();
        const activeSources = activeSourcesFromSnapshot(snapshot);
        const automatedCheckSources = automatedCheckSourcesFromSnapshot(snapshot);
        return sendJson(response, 200, {
          authenticated: await adminAuth.isAuthenticated(request),
          configured: adminAuth.configured(),
          setupAllowed: false,
          usernameRequired: adminAuth.usernameRequired(),
          sourceCount: snapshot.sources.length,
          activeDomains: domainsFromSources(activeSources).length,
          automatedCheckSources: automatedCheckSources.length,
          automatedCheckDomains: domainsFromSources(automatedCheckSources).length,
          version: snapshot.version,
        });
      }

      if (pathname === "/api/admin/login" && request.method === "POST") {
        if (!adminAttemptAllowed(request)) return sendError(response, 429, "Too many administrator sign-in attempts. Please try again later.");
        const body = await readJson(request, 64 * 1024);
        const token = await adminAuth.login(String(body.email || body.username || ""), String(body.password || ""));
        if (!token) return sendError(response, 401, "Those administrator credentials are not correct.");
        return sendJson(response, 200, { ok: true }, { "Set-Cookie": adminAuth.cookie(token) });
      }

      if (pathname === "/api/admin/logout" && request.method === "POST") {
        await adminAuth.logout(request);
        return sendJson(response, 200, { ok: true }, { "Set-Cookie": adminAuth.expiredCookie() });
      }

      if (pathname === "/api/admin/sources") {
        if (!(await requireAdmin(request, response))) return;
        if (request.method === "GET") return sendJson(response, 200, await sourceStore.snapshot());
        if (request.method === "POST") {
          const body = await readJson(request, 128 * 1024);
          const admitted = await assessSourceAdmission(body, null, { manualReviewed: body.manualReviewed === true });
          const added = await sourceStore.addWithAdmissionReview({ ...sourceFieldsFromRequest(body), ...admitted }, admitted.review);
          return sendJson(response, 201, { ...added, admission: admitted.admission });
        }
      }

      if (pathname === "/api/admin/sources/assess" && request.method === "POST") {
        if (!(await requireAdmin(request, response))) return;
        const body = await readJson(request, 128 * 1024);
        const admitted = await assessSourceAdmission(body, null, { requireManualReview: false, allowIneligiblePreview: true });
        await sourceStore.recordAdmissionReview(admitted.review);
        return sendJson(response, 200, { assessment: admitted.admission, category: categoryForKey(admitted.categoryKey) });
      }

      if (pathname.startsWith("/api/admin/sources/")) {
        if (!(await requireAdmin(request, response))) return;
        const id = pathname.slice("/api/admin/sources/".length);
        if (!id) return sendError(response, 400, "A source ID is required.");
        if (request.method === "PATCH") {
          const body = await readJson(request, 128 * 1024);
          if (Object.hasOwn(body, "category") || Object.hasOwn(body, "categoryKey")) {
            return sendError(response, 400, "Source categories are assigned by the source-admission review.");
          }
          const sourceFields = sourceFieldsFromRequest(body);
          const needsReview = ["name", "url", "rationale", "description", "usageStatus", "usagePolicyUrl", "usageReviewNote"].some((field) => Object.hasOwn(body, field));
          if (!needsReview) return sendJson(response, 200, await sourceStore.update(id, sourceFields));
          const existing = await sourceStore.get(id);
          if (!existing) return sendError(response, 404, "Source not found.");
          const admitted = await assessSourceAdmission(body, existing, { manualReviewed: body.manualReviewed === true });
          const updated = await sourceStore.updateWithAdmissionReview(id, { ...sourceFields, ...admitted }, admitted.review);
          return sendJson(response, 200, { ...updated, admission: admitted.admission });
        }
        if (request.method === "DELETE") return sendJson(response, 200, await sourceStore.remove(id));
      }

      if (pathname.startsWith("/api/")) return sendError(response, 404, "API route not found.");

      if (request.method !== "GET" && request.method !== "HEAD") return sendError(response, 405, "Method not allowed.");
      const assetPath = isAssetRequest(pathname) ? pathname.replace(/^\/+/, "") : "index.html";
      const resolved = path.resolve(PUBLIC_DIR, assetPath);
      if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== path.join(PUBLIC_DIR, "index.html")) return sendError(response, 403, "Not allowed.");

      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return sendFile(response, resolved, request.method);
      if (!isAssetRequest(pathname)) return sendFile(response, path.join(PUBLIC_DIR, "index.html"), request.method);
      return sendError(response, 404, "File not found.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      const status = /credentials are not correct|email or password is not correct/i.test(message)
        ? 401
        : /already exists/i.test(message)
          ? 409
          : /not found/i.test(message)
            ? 404
            : /required|valid|https|between|password|keep|smaller|active domains|more than 100|category|not admitted|manual review|social-platform|licen[cs]e|terms|usage/i.test(message)
              ? 400
              : /sign in|not allowed/i.test(message)
                ? 403
                : /database|postgresql|not initialized/i.test(message)
                  ? 503
                  : 500;
      return sendError(response, status, message);
    }
  });

  if (ownsPool) app.once("close", () => { void pool.end(); });
  return app;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const config = loadConfig();
  let pool;
  try {
    pool = createDatabasePool(config);
    await assertDatabaseReady(pool);
    await bootstrapEnvironmentAdministrator({
      pool,
      email: config.adminEmail || config.adminUsername,
      password: config.adminPassword,
      rotatePassword: config.adminPasswordRotate,
    });
    const app = createApp({ config, pool });
    app.listen(config.port, () => {
      console.log("Fact-Check is running at http://localhost:" + config.port);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to start Fact-Check.");
    if (pool) await pool.end();
    process.exitCode = 1;
  }
}
