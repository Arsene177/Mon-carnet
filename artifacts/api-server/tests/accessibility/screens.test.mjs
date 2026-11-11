// Accessibility check of every screen: axe-core with the WCAG 2.0, 2.1 and 2.2 A/AA rules, plus
// the reflow rule (no sideways scrolling at 320 px wide, which is what 400% zoom looks like).
//
// Needs the built web app (pnpm --filter @workspace/medichain run build), the built API server,
// a Chromium for Playwright, and the local Supabase stack like the other tests (tests/supabase-test-env.mjs):
//   pnpm --filter @workspace/api-server run test:accessibility
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, createReadStream, statSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { DATABASE_URL, insertStaff, serverEnv } from "../supabase-test-env.mjs";
const serverDir = fileURLToPath(new URL("../..", import.meta.url));
const webDir = path.resolve(serverDir, "../medichain/dist/public");
if (!existsSync(path.join(webDir, "index.html"))) {
  throw new Error("Build the web app first: pnpm --filter @workspace/medichain run build");
}
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const API_PORT = 5900 + Math.floor(Math.random() * 300);
const WEB_PORT = API_PORT + 400;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const PASSWORD = "Correct-horse-9";
const patientEmail = `patient-a11y-${Date.now()}@test.cm`;
const TERMS = "2026-11-draft-1";
const RULES = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const SCREENS = {
  patient: { home: "/patient", tabs: ["overview", "profile", "records", "access-control", "emergency-info", "inbox"] },
  doctor: { home: "/doctor", tabs: ["patients", "record-entry", "profile", "inbox"] },
  admin: { home: "/admin", tabs: ["system-overview", "doctor-approvals", "user-search", "password-recovery", "directories-&-notices", "analytics", "profile", "inbox"] },
};

const sql = new pg.Pool({ connectionString: DATABASE_URL });
let apiServer;
let webServer;
let browser;
const tokens = {};

function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function api(method, route, { token, body } = {}) {
  const response = await fetch(`${BASE}/api${route}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

/** Doctors and administrators, inserted as an administrator would approve them, with two-step sign-in on. */
async function createStaff(role, name, { mfa = true } = {}) {
  const email = `${role.toLowerCase()}-a11y-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.cm`;
  await insertStaff(sql, { email, password: PASSWORD, role, name, terms: TERMS });
  let { token } = await api("POST", "/auth/login", { body: { email, password: PASSWORD } });
  if (!mfa) return token;
  const setup = await api("POST", "/auth/mfa/setup", { token, body: { password: PASSWORD } });
  ({ token } = await api("POST", "/auth/mfa/enable", { token, body: { code: totp(setup.secret) } }));
  return token;
}

/** Serves the built web app and forwards /api to the API server, like the production router. */
function startWebServer() {
  const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  return new Promise((resolve) => {
    webServer = http.createServer((req, res) => {
      if (req.url.startsWith("/api")) {
        const upstream = http.request({ host: "127.0.0.1", port: API_PORT, path: req.url, method: req.method, headers: req.headers }, (answer) => {
          res.writeHead(answer.statusCode, answer.headers);
          answer.pipe(res);
        });
        // Requests still in flight while the servers shut down get a plain 502.
        upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(upstream);
        return;
      }
      let file = path.join(webDir, decodeURIComponent(req.url.split("?")[0]));
      if (!file.startsWith(webDir) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(webDir, "index.html");
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    }).listen(WEB_PORT, "127.0.0.1", resolve);
  });
}

async function openPage({ token = null, width, language }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language === "fr" ? "fr-FR" : "en-US" });
  await context.addInitScript(([storedToken, lang]) => {
    // Skip the first-visit guided tour, which would cover the screen.
    for (let id = 0; id < 5000; id++) localStorage.setItem(`medichain:onboarding:v1:${id}`, "complete");
    localStorage.setItem("moncarnet_language", lang);
    if (storedToken) {
      localStorage.setItem("medichain_token", storedToken);
      localStorage.setItem("medichain_last_activity", String(Date.now()));
    }
  }, [token, language]);
  return context.newPage();
}

/** Problems on the current screen, as readable lines. */
async function problems(page, label) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async (tags) => window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] }), RULES);
  const found = result.violations.map((violation) =>
    `${label}: ${violation.id} (${violation.impact}) ${violation.help}\n      ${violation.nodes.slice(0, 3).map((node) => `${node.target.join(" ")} — ${(node.failureSummary ?? "").split("\n")[1]?.trim() ?? ""}`).join("\n      ")}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) found.push(`${label}: content is ${overflow}px wider than the screen (reflow, WCAG 1.4.10)`);
  return found;
}

async function checkWorkspace(role, width, language) {
  const page = await openPage({ token: tokens[role], width, language });
  const { home, tabs } = SCREENS[role];
  await page.goto(BASE + home);
  const found = [];
  for (const tab of tabs) {
    const nav = page.getByTestId(`nav-${tab}`);
    await nav.waitFor({ state: "attached", timeout: 10_000 });
    await nav.evaluate((element) => element.click());
    found.push(...await problems(page, `${role} ${tab} (${width}px, ${language})`));
  }
  await page.context().close();
  return found;
}

before(async () => {
  apiServer = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: serverDir,
    env: serverEnv(API_PORT),
    stdio: ["ignore", "ignore", "inherit"],
  });
  await startWebServer();
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${BASE}/api/healthz`)).ok) break; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const patient = await api("POST", "/auth/register", {
    body: { name: "Awa Ngono", email: patientEmail, password: PASSWORD, role: "PATIENT", sex: "FEMALE", dateOfBirth: "1990-04-12", contactInfo: "+237690000000", acceptedTermsVersion: TERMS, healthDataConsent: true },
  });
  tokens.patient = patient.token;
  await api("PUT", "/patient/emergency-info", { token: tokens.patient, body: { bloodGroup: "O+", weightKg: 62, heightCm: 165, allergies: "Pénicilline", emergencyContact: "Paul Ngono +237 699 00 00 00" } });
  tokens.doctor = await createStaff("DOCTOR", "Jean Mbarga");
  tokens.admin = await createStaff("ADMIN", "Nadia Admin");
  const profile = await api("GET", "/patient/profile", { token: tokens.patient });
  await api("POST", "/doctor/patient-access", { token: tokens.doctor, body: { patientDisplayId: profile.patientDisplayId } });
  browser = await chromium.launch();
});

describe("the signed-in session in the browser", () => {
  test("renews the access token before it expires, and signing out ends the session on the server", async () => {
    const page = await openPage({ width: 1280, language: "en" });
    await page.goto(BASE + "/login");
    await page.getByTestId("input-email").fill(patientEmail);
    await page.getByTestId("input-password").fill(PASSWORD);
    await page.getByTestId("button-auth-submit").click();
    await page.getByTestId("nav-profile").waitFor({ state: "attached", timeout: 15_000 });
    const first = await page.evaluate(() => localStorage.getItem("medichain_token"));
    assert.ok(first && await page.evaluate(() => localStorage.getItem("medichain_refresh_token")), "access and refresh tokens are kept");
    // Pretend the access token expires in a minute: the next request renews it first.
    await page.evaluate(() => localStorage.setItem("medichain_token_expires_at", String(Date.now() + 60_000)));
    const renewed = page.waitForResponse((response) => response.url().endsWith("/api/auth/refresh") && response.status() === 200);
    await page.getByTestId("nav-profile").evaluate((element) => element.click());
    await renewed;
    // The renewed session expires in about an hour again. (Within the same second, Supabase can
    // return the same access token, so the expiry is what shows the renewal.)
    await page.waitForFunction(() => Number(localStorage.getItem("medichain_token_expires_at")) > Date.now() + 30 * 60_000);
    const second = await page.evaluate(() => localStorage.getItem("medichain_token"));
    const meStatus = async (token) => (await fetch(`${BASE}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status;
    assert.equal(await meStatus(second), 200);
    // Signing out ends the session on the server, not only in this browser.
    const signedOut = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-out"));
    await page.getByTestId("button-signout-top").evaluate((element) => element.click());
    assert.equal((await signedOut).status(), 204);
    assert.equal(await meStatus(second), 401);
    await page.context().close();
  });
});

after(async () => {
  await browser?.close();
  webServer?.close();
  apiServer?.kill();
  await sql.end();
});

describe("accessibility (WCAG 2.2 AA rules checked by axe-core, and reflow)", () => {
  for (const [width, language] of [[1280, "fr"], [1280, "en"], [320, "fr"]]) {
    test(`sign-in, sign-up and legal pages at ${width}px in ${language}`, async () => {
      const page = await openPage({ width, language });
      const found = [];
      for (const route of ["/login", "/register", "/privacy", "/terms"]) {
        await page.goto(BASE + route);
        found.push(...await problems(page, `${route} (${width}px, ${language})`));
      }
      await page.context().close();
      assert.deepEqual(found, [], `\n${found.join("\n")}`);
    });
    test(`two-step sign-in setup, with its QR code, at ${width}px in ${language}`, async () => {
      // A doctor without two-step sign-in can only set it up. The QR code library loads on demand.
      const page = await openPage({ token: await createStaff("DOCTOR", "Ngo Setup", { mfa: false }), width, language });
      await page.goto(BASE + "/doctor");
      await page.getByTestId("input-mfa-password").fill(PASSWORD);
      await page.getByTestId("button-mfa-start").click();
      const qr = page.locator(".mfa-qr img");
      await qr.waitFor({ timeout: 10_000 });
      assert.match(await qr.getAttribute("src"), /^data:image\/png;base64,/);
      const found = await problems(page, `two-step setup (${width}px, ${language})`);
      await page.context().close();
      assert.deepEqual(found, [], `\n${found.join("\n")}`);
    });
    for (const role of Object.keys(SCREENS)) {
      test(`${role} screens at ${width}px in ${language}`, async () => {
        const found = await checkWorkspace(role, width, language);
        assert.deepEqual(found, [], `\n${found.join("\n")}`);
      });
    }
  }
});
