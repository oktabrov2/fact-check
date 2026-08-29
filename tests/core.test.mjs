import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { bootstrapEnvironmentAdministrator, createAuth, createUserAuth } from "../lib/auth.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { checkClaimWithOpenAI } from "../lib/openai.mjs";
import { trustedSourcesPdf } from "../lib/pdf.mjs";
import { seedTrustedSources } from "../lib/seed.mjs";
import { createSourceStore, selectSourcesForCategories } from "../lib/store.mjs";
import { createApp } from "../server.mjs";

const TEST_ADMIN_EMAIL = "factcheck-admin@example.test";
const TEST_ADMIN_PASSWORD = "a-long-admin-test-password";

async function testDatabase({ seed = false } = {}) {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool, { advisoryLock: false });
  if (seed) await seedTrustedSources(pool);
  return pool;
}

test("PostgreSQL source registry preserves the trusted-domain boundary", async () => {
  const pool = await testDatabase();
  try {
    const store = createSourceStore(pool);
    await store.add({
      name: "WHO",
      url: "https://www.who.int/",
      category: "Authority",
      rationale: "Global health authority.",
      usageStatus: "reviewed-link-and-citation",
      usagePolicyUrl: "https://www.who.int/about/policies",
      usageReviewNote: "Official terms were reviewed for direct linking and citation.",
    });
    assert.deepEqual(await store.activeDomains(), ["who.int"]);
    assert.equal(await store.isApprovedUrl("https://news.who.int/updates"), true);
    assert.equal(await store.isApprovedUrl("http://who.int/updates"), false);
    assert.equal(await store.isApprovedUrl("ftp://who.int/updates"), false);
    assert.equal(await store.isApprovedUrl("https://who.int.evil.example"), false);
    const added = await store.add({ name: "CDC", url: "https://www.cdc.gov/", category: "Authority", rationale: "Public health authority." });
    assert.equal(added.source.active, true);
    assert.equal(await store.isApprovedUrl("https://www.cdc.gov/updates"), false);
    assert.equal((await store.publicSources()).length, 2);
    await assert.rejects(
      () => store.add({ name: "Duplicate WHO", url: "https://www.who.int/", category: "Authority", rationale: "Duplicate source." }),
      /already in the registry/i,
    );
    await assert.rejects(
      () => store.add({ name: "Telegram channel", url: "https://t.me/example", categoryKey: "government-and-law", rationale: "A platform account is not a first-party source domain." }),
      /social-platform/i,
    );
  } finally {
    await pool.end();
  }
});

test("PostgreSQL migration seeds the reviewed 110-source public registry once", async () => {
  const pool = await testDatabase();
  try {
    const firstSeed = await seedTrustedSources(pool);
    const secondSeed = await seedTrustedSources(pool);
    const snapshot = await createSourceStore(pool).snapshot();
    assert.equal(firstSeed.seeded, 110);
    assert.equal(firstSeed.secondaryCategories, 15);
    assert.equal(secondSeed.skipped, true);
    assert.equal(snapshot.sources.length, 110);
    assert.equal(snapshot.version, 11);
    assert.equal((await createSourceStore(pool).activeDomains()).length, 110);
    assert.equal(snapshot.sources.find((source) => source.id === "src-222").categoryKey, "economy-and-finance");
    assert.ok(snapshot.sources.some((source) => source.categoryKey === "weather-and-emergencies"));
    const reviewedSource = snapshot.sources.find((source) => source.id === "src-215");
    assert.deepEqual(
      { usageStatus: reviewedSource?.usageStatus, usagePolicyUrl: reviewedSource?.usagePolicyUrl },
      {
        usageStatus: "reviewed-link-and-citation",
        usagePolicyUrl: "https://data.gov/privacy-policy/",
      },
    );
    const automatedCheckSources = snapshot.sources.filter((source) => (
      ["reviewed-link-and-citation", "reviewed-open-license"].includes(source.usageStatus)
      && source.usagePolicyUrl
    ));
    assert.equal(automatedCheckSources.length, 110);
    const categoriesWithoutReviewedSource = [...new Set(snapshot.sources.flatMap((source) => source.categoryKeys))]
      .filter((categoryKey) => !automatedCheckSources.some((source) => source.categoryKeys.includes(categoryKey)));
    assert.deepEqual(categoriesWithoutReviewedSource, []);
    assert.deepEqual(
      {
        usageStatus: snapshot.sources.find((source) => source.id === "src-028")?.usageStatus,
        usagePolicyUrl: snapshot.sources.find((source) => source.id === "src-029")?.usagePolicyUrl,
      },
      {
        usageStatus: "reviewed-link-and-citation",
        usagePolicyUrl: "https://www.weather.gov/disclaimer",
      },
    );
    assert.equal(snapshot.sources.some((source) => source.usageStatus === "legacy-review-pending"), false);
    assert.deepEqual(
      {
        categoryKey: snapshot.sources.find((source) => source.id === "src-236")?.categoryKey,
        categoryKeys: snapshot.sources.find((source) => source.id === "src-236")?.categoryKeys,
        categoryKeyForNews: snapshot.sources.find((source) => source.id === "src-280")?.categoryKey,
      },
      {
        categoryKey: "companies-and-products",
        categoryKeys: ["companies-and-products", "games-and-interactive-entertainment"],
        categoryKeyForNews: "news-and-current-affairs",
      },
    );
  } finally {
    await pool.end();
  }
});

test("generated trusted-source PDF has a valid PDF header", () => {
  const pdf = trustedSourcesPdf({
    version: 7,
    updatedAt: "2026-07-27T00:00:00.000Z",
    sources: [{ name: "WHO", url: "https://www.who.int/", category: "Authority", rationale: "Global health authority.", usageStatus: "reviewed-link-and-citation", usagePolicyUrl: "https://www.who.int/about/policies" }],
  });
  assert.equal(pdf.subarray(0, 8).toString("latin1"), "%PDF-1.4");
  assert.ok(pdf.toString("latin1").includes("Fact-Check"));
  assert.ok(pdf.toString("latin1").includes("Published source terms"));
});

test("evidence searches require a structured final answer and omit citations for insufficient evidence", async () => {
  const originalFetch = globalThis.fetch;
  const citation = {
    type: "url_citation",
    url_citation: { url: "https://www.nhc.noaa.gov/archive/2026/al09/", title: "AL092026 advisory archive" },
  };
  const declaredSources = [{
    url: "https://www.nhc.noaa.gov/archive/2026/al09/",
    title: "AL092026 advisory archive",
    summary: "The archive shows no advisory issued for the claimed landfall window.",
    publishedAt: "2026-08-27",
  }];
  const responseFor = (verdict, answer, sources) => ({
    ok: true,
    json: async () => ({
      output_text: JSON.stringify({ verdict, answer, sources }),
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ verdict, answer, sources }), annotations: [citation] }] }],
    }),
  });
  const queuedResponses = [
    responseFor("CONTRADICTED", "No. The official record does not report the claimed landfall.", declaredSources),
    responseFor("INSUFFICIENT", "There is not enough reliable information in the selected sources to verify this claim.", []),
  ];
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return queuedResponses.shift();
  };

  const arguments_ = {
    apiKey: "test-key",
    model: "test-model",
    claim: "Did a hurricane make landfall in the United States yesterday?",
    domains: ["nhc.noaa.gov"],
    sources: [{ name: "US National Hurricane Center", url: "https://www.nhc.noaa.gov/", domain: "nhc.noaa.gov", category: "Weather and emergencies" }],
    isApprovedUrl: (url) => url.startsWith("https://www.nhc.noaa.gov/"),
    sourceLabelForUrl: () => "US National Hurricane Center",
  };

  try {
    const contradicted = await checkClaimWithOpenAI(arguments_);
    assert.equal(requestBody.text.format.name, "claim_evidence_verdict");
    assert.equal(requestBody.text.format.strict, true);
    assert.deepEqual(requestBody.text.format.schema.required, ["verdict", "answer", "sources"]);
    assert.equal(contradicted.verdict, "CONTRADICTED");
    assert.equal(contradicted.answer, "No. The official record does not report the claimed landfall.");
    assert.deepEqual(contradicted.sources, [{
      url: "https://www.nhc.noaa.gov/archive/2026/al09/",
      title: "AL092026 advisory archive",
      summary: "The archive shows no advisory issued for the claimed landfall window.",
      publishedAt: "2026-08-27",
    }]);

    const insufficient = await checkClaimWithOpenAI(arguments_);
    assert.equal(insufficient.verdict, "INSUFFICIENT");
    assert.equal(insufficient.answer, "There is not enough reliable information in the selected sources to verify this claim.");
    assert.deepEqual(insufficient.sources, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("category selection keeps each evidence search inside selected source categories", async () => {
  const pool = await testDatabase({ seed: true });
  try {
    const snapshot = await createSourceStore(pool).snapshot();
    const selection = selectSourcesForCategories(snapshot.sources, ["economy-and-finance", "government-and-law"]);
    assert.ok(selection.domains.includes("data.gov"));
    assert.ok(selection.sources.length > 0);
    assert.ok(selection.sources.every((source) => source.categoryKeys.some((key) => ["economy-and-finance", "government-and-law"].includes(key))));
    assert.ok(selection.domains.length <= 100);
  } finally {
    await pool.end();
  }
});

test("secondary source categories include Rockstar in games without duplicating its domain", async () => {
  const pool = await testDatabase({ seed: true });
  try {
    const snapshot = await createSourceStore(pool).snapshot();
    const games = selectSourcesForCategories(snapshot.sources, ["games-and-interactive-entertainment"]);
    assert.ok(games.domains.includes("rockstargames.com"));
    assert.equal(games.sources.filter((source) => source.id === "src-236").length, 1);

    const combined = selectSourcesForCategories(snapshot.sources, ["companies-and-products", "games-and-interactive-entertainment"]);
    assert.equal(combined.sources.filter((source) => source.id === "src-236").length, 1);
    assert.equal(combined.domains.filter((domain) => domain === "rockstargames.com").length, 1);
  } finally {
    await pool.end();
  }
});

test("domain limits keep representation from every selected category", () => {
  const source = (id, categoryKey) => ({
    id,
    name: id,
    domain: id + ".example",
    categoryKey,
    active: true,
  });
  const selection = selectSourcesForCategories([
    source("finance-a", "economy-and-finance"),
    source("finance-b", "economy-and-finance"),
    source("law-a", "government-and-law"),
    source("law-b", "government-and-law"),
    source("weather-a", "weather-and-emergencies"),
  ], ["economy-and-finance", "government-and-law", "weather-and-emergencies"], 3);

  assert.equal(selection.domains.length, 3);
  assert.deepEqual(new Set(selection.sources.map((item) => item.categoryKey)), new Set([
    "economy-and-finance", "government-and-law", "weather-and-emergencies",
  ]));
  assert.equal(selection.truncated, true);
});

test("environment-backed administrator sessions are stored in PostgreSQL", async () => {
  const pool = await testDatabase();
  try {
    const bootstrap = await bootstrapEnvironmentAdministrator({ pool, email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
    assert.equal(bootstrap.created, true);
    const auth = createAuth({ pool, adminEmail: TEST_ADMIN_EMAIL, adminPassword: TEST_ADMIN_PASSWORD });
    assert.equal(auth.usernameRequired(), true);
    assert.equal(await auth.login("wrong-user@example.test", TEST_ADMIN_PASSWORD), null);
    const token = await auth.login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    assert.ok(token);
    const persisted = await pool.query("SELECT email, role, password_hash FROM app_users WHERE email = $1", [TEST_ADMIN_EMAIL]);
    assert.equal(persisted.rows[0].role, "admin");
    assert.notEqual(persisted.rows[0].password_hash, TEST_ADMIN_PASSWORD);
    const restartedAuth = createAuth({ pool, adminEmail: TEST_ADMIN_EMAIL, adminPassword: TEST_ADMIN_PASSWORD });
    assert.equal(await restartedAuth.isAuthenticated({ headers: { cookie: "fact_check_admin=" + token } }), true);
    await restartedAuth.logout({ headers: { cookie: "fact_check_admin=" + token } });
    assert.equal(await auth.isAuthenticated({ headers: { cookie: "fact_check_admin=" + token } }), false);
  } finally {
    await pool.end();
  }
});

test("PostgreSQL user accounts use a separate session and never expose password data", async () => {
  const pool = await testDatabase();
  try {
    const auth = createUserAuth({ pool });
    const created = await auth.signup({ name: "Amina Karimova", email: "Amina@Example.com", password: "a-long-user-test-password" });
    assert.equal(created.user.email, "amina@example.com");
    assert.equal(Object.hasOwn(created.user, "password_hash"), false);
    assert.equal(Object.hasOwn(created.user, "password_salt"), false);
    const restartedAuth = createUserAuth({ pool });
    assert.equal((await restartedAuth.currentUser({ headers: { cookie: "fact_check_user=" + created.token } })).name, "Amina Karimova");
    assert.equal(await auth.login({ email: "amina@example.com", password: "wrong-password" }), null);
    assert.ok(await auth.login({ email: "amina@example.com", password: "a-long-user-test-password" }));
    await assert.rejects(
      () => auth.signup({ name: "Amina Karimova", email: "amina@example.com", password: "a-different-long-password" }),
      /already exists/i,
    );
  } finally {
    await pool.end();
  }
});

test("public user sessions cannot access administrator routes", async () => {
  const pool = await testDatabase({ seed: true });
  await bootstrapEnvironmentAdministrator({ pool, email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
  const auth = createAuth({ pool, adminEmail: TEST_ADMIN_EMAIL, adminPassword: TEST_ADMIN_PASSWORD });
  const userAuth = createUserAuth({ pool });
  const app = createApp({
    pool,
    config: {
      apiKey: "",
      adminEmail: TEST_ADMIN_EMAIL,
      adminPassword: TEST_ADMIN_PASSWORD,
      donationProvider: "Stripe",
      donationUrl: "https://donate.example/fact-check",
      model: "test-model",
      nodeEnv: "test",
      port: 0,
    },
    auth,
    userAuth,
  });

  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = app.address().port;
  const baseUrl = "http://127.0.0.1:" + port;

  try {
    const sourceResponse = await fetch(baseUrl + "/api/sources");
    const sourceData = await sourceResponse.json();
    assert.equal(sourceData.sourceCount, 110);
    assert.equal(sourceData.automatedCheckSourceCount, 110);
    assert.equal(sourceData.automatedCheckDomainCount, 110);
    assert.equal(sourceData.categoryCounts.length, 14);
    const gamesResponse = await fetch(baseUrl + "/api/sources?category=games-and-interactive-entertainment");
    const gamesData = await gamesResponse.json();
    assert.equal(gamesResponse.status, 200);
    assert.equal(gamesData.sources.length, 15);
    assert.deepEqual(gamesData.sources.find((source) => source.id === "src-236")?.categoryKeys, ["companies-and-products", "games-and-interactive-entertainment"]);

    const healthResponse = await fetch(baseUrl + "/api/health");
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(
      (await healthResponse.json()).automatedCheckSources,
      110,
    );
    const healthHeadResponse = await fetch(baseUrl + "/api/health", { method: "HEAD" });
    assert.equal(healthHeadResponse.status, 200);
    assert.equal(healthHeadResponse.headers.get("content-type"), "application/json; charset=utf-8");

    const donation = await fetch(baseUrl + "/api/donation");
    assert.equal(donation.status, 200);
    assert.deepEqual(await donation.json(), {
      enabled: true,
      provider: "Stripe",
      url: "https://donate.example/fact-check",
    });

    const signup = await fetch(baseUrl + "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Amina Karimova", email: "amina@example.com", password: "a-long-user-test-password" }),
    });
    assert.equal(signup.status, 201);
    const userCookie = signup.headers.get("set-cookie").split(";")[0];
    const account = await signup.json();
    assert.equal(account.user.email, "amina@example.com");

    const status = await fetch(baseUrl + "/api/auth/status", { headers: { Cookie: userCookie } });
    assert.equal(status.status, 200);
    const statusPayload = await status.json();
    assert.equal(statusPayload.user.name, "Amina Karimova");
    assert.equal(statusPayload.administrator, null);

    const blocked = await fetch(baseUrl + "/api/admin/sources", { headers: { Cookie: userCookie } });
    assert.equal(blocked.status, 401);

    const loginAsAdministrator = await fetch(baseUrl + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }),
    });
    const administratorLoginPayload = await loginAsAdministrator.json();
    assert.equal(loginAsAdministrator.status, 200, JSON.stringify(administratorLoginPayload));
    assert.equal(administratorLoginPayload.administrator, true);
    assert.equal(administratorLoginPayload.user.email, TEST_ADMIN_EMAIL);
    const redirectedAdminCookie = loginAsAdministrator.headers.get("set-cookie").split(";")[0];
    const administratorStatus = await fetch(baseUrl + "/api/auth/status", { headers: { Cookie: redirectedAdminCookie } });
    assert.equal((await administratorStatus.json()).administrator.email, TEST_ADMIN_EMAIL);
    const redirectedAllowed = await fetch(baseUrl + "/api/admin/sources", { headers: { Cookie: redirectedAdminCookie } });
    assert.equal(redirectedAllowed.status, 200);
    const administratorCheck = await fetch(baseUrl + "/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: redirectedAdminCookie },
      body: JSON.stringify({ claim: "Can an administrator access the protected verification route?" }),
    });
    assert.equal(administratorCheck.status, 503);

    const adminLogin = await fetch(baseUrl + "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }),
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];
    const allowed = await fetch(baseUrl + "/api/admin/sources", { headers: { Cookie: adminCookie } });
    assert.equal(allowed.status, 200);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await pool.end();
  }
});

test("unauthenticated verification stops before parsing a request or calling AI", async () => {
  const pool = await testDatabase({ seed: true });
  const events = [];
  const app = createApp({
    pool,
    config: {
      apiKey: "test-key",
      adminEmail: TEST_ADMIN_EMAIL,
      adminPassword: TEST_ADMIN_PASSWORD,
      model: "test-model",
      nodeEnv: "test",
      port: 0,
    },
    classifyClaimCategories: async () => {
      events.push("classify");
      return { categoryKeys: ["government-and-law"], reason: "Should never run." };
    },
    checkClaimWithOpenAI: async () => {
      events.push("check");
      return { verdict: "INSUFFICIENT", explanation: "Should never run.", sources: [], checkedAt: "2026-07-28T00:00:00.000Z", model: "test-model" };
    },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = app.address().port;
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid JSON",
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "Log in to verify a claim.");
    assert.deepEqual(events, []);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await pool.end();
  }
});

test("claim checks classify categories before a separate restricted evidence request", async () => {
  const pool = await testDatabase({ seed: true });
  const events = [];
  let evidenceArguments;
  const userAuth = createUserAuth({ pool });
  const signedIn = await userAuth.signup({
    name: "Amina Karimova",
    email: "amina@example.com",
    password: "a-long-user-test-password",
  });
  const app = createApp({
    pool,
    userAuth,
    config: {
      apiKey: "test-key",
      adminEmail: TEST_ADMIN_EMAIL,
      adminPassword: TEST_ADMIN_PASSWORD,
      model: "test-model",
      nodeEnv: "test",
      port: 0,
    },
    classifyClaimCategories: async (arguments_) => {
      events.push("classify");
      assert.equal(arguments_.claim, "O'zbekistonda naqd pul ishlatish mumkin emasmi?");
      return {
        categoryKeys: ["economy-and-finance", "government-and-law"],
        reason: "The claim concerns national payment rules and financial regulation.",
      };
    },
    checkClaimWithOpenAI: async (arguments_) => {
      events.push("check");
      evidenceArguments = arguments_;
      assert.equal(arguments_.isApprovedUrl("https://data.gov/dataset/example"), true);
      assert.equal(arguments_.isApprovedUrl("https://cbu.uz/en/"), false);
      assert.equal(arguments_.isApprovedUrl("http://data.gov/dataset/example"), false);
      return {
        verdict: "SUPPORTED",
        explanation: "Selected official sources confirm the relevant rule.",
        sources: [
          { url: "https://data.gov/dataset/example", title: "Data.gov open-data record", summary: "The dataset record describes how cash payments remain a permitted method under national payment rules.", publishedAt: "2026-06-15", excerpt: "This must not leave the server." },
          { url: "https://cbu.uz/en/", title: "Central Bank of Uzbekistan", summary: "Unreviewed source; must not surface.", publishedAt: null, excerpt: "This unreviewed source must not leave the server." },
        ],
        checkedAt: "2026-07-27T00:00:00.000Z",
        model: "test-model",
      };
    },
  });

  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = app.address().port;
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fact_check_user=" + signedIn.token },
      body: JSON.stringify({ claim: "O'zbekistonda naqd pul ishlatish mumkin emasmi?" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(events, ["classify", "check"]);
    assert.deepEqual(body.categorySelection.categoryKeys, ["economy-and-finance", "government-and-law"]);
    assert.ok(evidenceArguments.domains.includes("data.gov"));
    assert.equal(evidenceArguments.domains.includes("cbu.uz"), false);
    assert.ok(evidenceArguments.sources.every((source) => ["economy-and-finance", "government-and-law"].includes(source.categoryKey)));
    assert.ok(evidenceArguments.sources.every((source) => source.usageStatus !== "legacy-review-pending" && source.usagePolicyUrl));
    assert.equal(body.answer, "Selected official sources confirm the relevant rule.");
    assert.equal(body.explanation, "Selected official sources confirm the relevant rule.");
    assert.deepEqual(body.sources, [{
      url: "https://data.gov/dataset/example",
      title: "Data.gov open-data record",
      summary: "The dataset record describes how cash payments remain a permitted method under national payment rules.",
      publishedAt: "2026-06-15",
      category: "Government and law",
      firstParty: true,
    }]);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await pool.end();
  }
});

test("claim checks stop with insufficient evidence when a selected category has no completed source-use review", async () => {
  const pool = await testDatabase({ seed: true });
  await pool.query(
    "UPDATE trusted_sources SET usage_status = 'legacy-review-pending', usage_policy_url = NULL, usage_review_note = NULL, usage_reviewed_at = NULL WHERE category_key = 'international-institutions'",
  );
  const events = [];
  const userAuth = createUserAuth({ pool });
  const signedIn = await userAuth.signup({
    name: "Amina Karimova",
    email: "amina@example.com",
    password: "a-long-user-test-password",
  });
  const app = createApp({
    pool,
    userAuth,
    config: {
      apiKey: "test-key",
      adminEmail: TEST_ADMIN_EMAIL,
      adminPassword: TEST_ADMIN_PASSWORD,
      model: "test-model",
      nodeEnv: "test",
      port: 0,
    },
    classifyClaimCategories: async () => {
      events.push("classify");
      return { categoryKeys: ["international-institutions"], reason: "The claim concerns an intergovernmental institution." };
    },
    checkClaimWithOpenAI: async () => {
      events.push("check");
      throw new Error("Evidence search must not run without a completed source-use review.");
    },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = app.address().port;
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fact_check_user=" + signedIn.token },
      body: JSON.stringify({ claim: "Did an intergovernmental institution publish this report?" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(events, ["classify"]);
    assert.equal(body.verdict, "INSUFFICIENT");
    assert.match(body.answer, /not enough eligible source information/i);
    assert.match(body.explanation, /not enough eligible source information/i);
    assert.equal(body.categorySelection.selectedSourceCount, 0);
    assert.equal(body.categorySelection.selectedDomainCount, 0);
    assert.deepEqual(body.sources, []);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await pool.end();
  }
});

test("U.S. hurricane claims hide citations when selected evidence is insufficient", async () => {
  const pool = await testDatabase({ seed: true });
  const events = [];
  let evidenceArguments;
  const userAuth = createUserAuth({ pool });
  const signedIn = await userAuth.signup({
    name: "Amina Karimova",
    email: "amina@example.com",
    password: "a-long-user-test-password",
  });
  const app = createApp({
    pool,
    userAuth,
    config: {
      apiKey: "test-key",
      adminEmail: TEST_ADMIN_EMAIL,
      adminPassword: TEST_ADMIN_PASSWORD,
      model: "test-model",
      nodeEnv: "test",
      port: 0,
    },
    classifyClaimCategories: async () => {
      events.push("classify");
      return { categoryKeys: ["weather-and-emergencies"], reason: "The claim concerns a hurricane landfall." };
    },
    checkClaimWithOpenAI: async (arguments_) => {
      events.push("check");
      evidenceArguments = arguments_;
      assert.equal(arguments_.isApprovedUrl("https://www.nhc.noaa.gov/archive/"), true);
      assert.equal(arguments_.isApprovedUrl("https://www.weather.gov/"), true);
      assert.equal(arguments_.isApprovedUrl("https://www.noaa.gov/"), true);
      assert.equal(arguments_.isApprovedUrl("https://www.usgs.gov/"), true);
      assert.equal(arguments_.isApprovedUrl("https://www.jma.go.jp/jma/indexe.html"), true);
      return {
        verdict: "INSUFFICIENT",
        explanation: "The selected sources do not provide enough evidence.",
        sources: [{ url: "https://www.nhc.noaa.gov/archive/", title: "NHC archive" }],
        checkedAt: "2026-08-02T00:00:00.000Z",
        model: "test-model",
      };
    },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = app.address().port;
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fact_check_user=" + signedIn.token },
      body: JSON.stringify({ claim: "Did a hurricane make landfall in the United States yesterday?" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(events, ["classify", "check"]);
    assert.equal(body.categorySelection.selectedSourceCount, 5);
    assert.equal(body.categorySelection.selectedDomainCount, 5);
    assert.deepEqual(new Set(evidenceArguments.domains), new Set([
      "nhc.noaa.gov", "weather.gov", "usgs.gov", "jma.go.jp", "noaa.gov",
    ]));
    assert.equal(body.verdict, "INSUFFICIENT");
    assert.equal(body.answer, "There is not enough reliable information in the selected sources to verify this claim.");
    assert.deepEqual(body.sources, []);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await pool.end();
  }
});

test("authenticated claim checks are rate-limited before paid AI work", async () => {
  const pool = await testDatabase({ seed: true });
  const userAuth = createUserAuth({ pool });
  const signedIn = await userAuth.signup({
    name: "Amina Karimova",
    email: "amina@example.com",
    password: "a-long-user-test-password",
  });
  const app = createApp({
    pool,
    userAuth,
    config: {
      apiKey: "test-key",
      adminEmail: TEST_ADMIN_EMAIL,
      adminPassword: TEST_ADMIN_PASSWORD,
      model: "test-model",
      nodeEnv: "test",
      port: 0,
    },
    classifyClaimCategories: async () => ({
      categoryKeys: ["government-and-law"],
      reason: "Government information is relevant.",
    }),
    checkClaimWithOpenAI: async () => ({
      verdict: "INSUFFICIENT",
      explanation: "The selected sources do not provide enough evidence.",
      sources: [],
      checkedAt: "2026-07-27T00:00:00.000Z",
      model: "test-model",
    }),
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = app.address().port;

  try {
    const statuses = [];
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await fetch("http://127.0.0.1:" + port + "/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "fact_check_user=" + signedIn.token },
        body: JSON.stringify({ claim: "Is this public notice accurate?" }),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 429]);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await pool.end();
  }
});

test("administrator source admission assigns the AI-reviewed category and records an audit entry", async () => {
  const pool = await testDatabase({ seed: true });
  await bootstrapEnvironmentAdministrator({ pool, email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
  const auth = createAuth({ pool, adminEmail: TEST_ADMIN_EMAIL, adminPassword: TEST_ADMIN_PASSWORD });
  const app = createApp({
    pool,
    auth,
    config: {
      apiKey: "test-key",
      adminEmail: TEST_ADMIN_EMAIL,
      adminPassword: TEST_ADMIN_PASSWORD,
      model: "test-model",
      nodeEnv: "test",
      port: 0,
    },
    assessTrustedSourceWithOpenAI: async ({ source }) => ({
      eligible: source.name !== "Unclear source",
      categoryKey: "economy-and-finance",
      confidence: source.name === "Unclear source" ? "low" : "high",
      reason: source.name === "Unclear source"
        ? "Official ownership cannot be confirmed from this domain."
        : "The first-party site is an official central-bank authority.",
      sources: [],
      model: "test-model",
    }),
  });

  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = app.address().port;
  try {
    const login = await fetch("http://127.0.0.1:" + port + "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const preview = await fetch("http://127.0.0.1:" + port + "/api/admin/sources/assess", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Unclear source",
        url: "https://unclear.example/",
        rationale: "The ownership of this candidate is not yet clear.",
      }),
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).assessment.eligible, false);
    const missingUsageReview = await fetch("http://127.0.0.1:" + port + "/api/admin/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "No source-use review",
        url: "https://terms-missing.example/",
        rationale: "Official authority submitted without a terms or licence record.",
        manualReviewed: true,
      }),
    });
    assert.equal(missingUsageReview.status, 400);
    assert.match((await missingUsageReview.json()).error, /source was reviewed|source-use review/i);
    const added = await fetch("http://127.0.0.1:" + port + "/api/admin/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Example Central Bank",
        url: "https://centralbank.example/",
        rationale: "Official central-bank source for monetary policy and payment rules.",
        categoryKey: "public-health",
        usageStatus: "reviewed-link-and-citation",
        usagePolicyUrl: "https://centralbank.example/terms",
        usageReviewNote: "The official terms were reviewed for direct linking and citation.",
        usageReviewed: true,
        manualReviewed: true,
      }),
    });
    assert.equal(added.status, 201);
    const body = await added.json();
    assert.equal(body.source.categoryKey, "economy-and-finance");
    assert.equal(body.source.category, "Economy and finance");
    const review = await pool.query("SELECT source_id, usage_status, usage_policy_url, usage_reviewed FROM source_admission_reviews WHERE candidate_domain = 'centralbank.example'");
    assert.equal(review.rows.length, 1);
    assert.equal(review.rows[0].source_id, body.source.id);
    assert.equal(review.rows[0].usage_status, "reviewed-link-and-citation");
    assert.equal(review.rows[0].usage_policy_url, "https://centralbank.example/terms");
    assert.equal(review.rows[0].usage_reviewed, true);
    const unlinkedPreview = await pool.query("SELECT source_id, eligible FROM source_admission_reviews WHERE candidate_domain = 'unclear.example'");
    assert.equal(unlinkedPreview.rows.length, 1);
    assert.equal(unlinkedPreview.rows[0].source_id, null);
    assert.equal(unlinkedPreview.rows[0].eligible, false);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await pool.end();
  }
});
