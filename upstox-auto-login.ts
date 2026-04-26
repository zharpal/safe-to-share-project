// Upstox headless auto-login.
//
// Upstox's OAuth 2.0 flow requires a human to click through their login
// dialog every day. This module automates that step so the access token can
// be refreshed unattended. It launches a headless Chromium, drives the
// official login dialog (client ID → TOTP → PIN), intercepts the redirect
// back to our callback URL to grab the `?code=...` param, then exchanges
// that code for an access token using the documented token endpoint.
//
// NOTE: This uses Upstox's real UI, not undocumented endpoints. If they
// tweak the form, the selectors may need updating — we intentionally use
// multiple resilient selectors per field and log loudly on failure.

import axios from "axios";
import { chromium, type Browser, type Page } from "playwright";
import { createHmac } from "crypto";

export type UpstoxAutoLoginParams = {
  /** OAuth app API key (UUID from Upstox developer console). */
  apiKey: string;
  /** OAuth app API secret (UUID from Upstox developer console). */
  apiSecret: string;
  /** 6-digit trading-account user/client ID (what you type at upstox.com). */
  loginUserId: string;
  /** 6-digit trading PIN. */
  loginPin: string;
  /** Base32 TOTP seed from Upstox 2FA setup. */
  totpSecret: string;
  /** OAuth redirect URI that's registered against the API key. Must match exactly. */
  redirectUri: string;
};

export type UpstoxAutoLoginResult = {
  accessToken: string;
  /** Raw token response, in case the caller wants extended fields. */
  tokenResponse: Record<string, unknown>;
};

// ── TOTP generator (RFC 6238) ───────────────────────────────────────────────
// Upstox uses standard TOTP: SHA-1, 30s step, 6 digits. We implement it
// inline to avoid pulling in a TOTP library (they keep changing their
// public APIs). This is the textbook HOTP/TOTP algorithm.

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of cleaned) {
    const val = alphabet.indexOf(c);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateUpstoxTotp(
  secret: string,
  stepSec = 30,
  digits = 6
): string {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / stepSec);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

/**
 * Drive the Upstox OAuth dialog in a headless browser and exchange the
 * resulting authorization code for an access token.
 *
 * Throws with a descriptive error on any step failure.
 */
export async function upstoxAutoLogin(
  params: UpstoxAutoLoginParams
): Promise<UpstoxAutoLoginResult> {
  const { apiKey, apiSecret, loginUserId, loginPin, totpSecret, redirectUri } = params;

  if (!apiKey || !apiSecret || !loginUserId || !loginPin || !totpSecret || !redirectUri) {
    throw new Error(
      "upstoxAutoLogin: missing required parameter(s). Need apiKey, apiSecret, loginUserId, loginPin, totpSecret, redirectUri."
    );
  }

  const state = `auto-${Date.now()}`;
  const authUrl =
    `https://api.upstox.com/v2/login/authorization/dialog` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(apiKey)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  let browser: Browser | null = null;
  let capturedCode = "";
  let capturedError = "";

  try {
    browser = await chromium.launch({
      headless: true,
      // `--no-sandbox` is required when running inside most container images
      // (Railway's default nixpacks image included). Playwright needs it.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    const page: Page = await context.newPage();

    // Intercept the redirect back to our callback URL — Upstox will 302 the
    // browser to `${redirectUri}?code=...&state=...` after successful login.
    // We fulfil it with a dummy 200 so the browser doesn't error out trying
    // to actually hit our Express server from inside the headless session.
    await page.route(`${redirectUri}*`, (route) => {
      const url = new URL(route.request().url());
      capturedCode = url.searchParams.get("code") || "";
      const err = url.searchParams.get("error") || url.searchParams.get("error_description");
      if (err) capturedError = err;
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>ok</body></html>",
      });
    });

    console.log("[upstox-auto-login] navigating to authorization dialog…");
    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // ── Step 1: user ID ──────────────────────────────────────────────────────
    // Upstox presents a single text field for the 6-digit client ID. We try
    // a few selectors in order of preference so minor DOM changes don't break us.
    console.log("[upstox-auto-login] entering login user id…");
    const userIdField = page
      .locator(
        [
          'input[name="mobileNum"]',
          'input[name="userId"]',
          'input[name="username"]',
          'input[type="text"]:not([name="otp"])',
          'input[inputmode="numeric"]:not([name="otp"])',
        ].join(", ")
      )
      .first();
    await userIdField.waitFor({ state: "visible", timeout: 20000 });
    await userIdField.fill(loginUserId);

    // Click the primary "Get OTP" / "Continue" button
    const getOtpButton = page
      .locator(
        [
          'button:has-text("Get OTP")',
          'button:has-text("GET OTP")',
          'button:has-text("Continue")',
          'button[type="submit"]',
        ].join(", ")
      )
      .first();
    await getOtpButton.click();

    // ── Step 2: TOTP ────────────────────────────────────────────────────────
    console.log("[upstox-auto-login] entering TOTP…");
    const totp = generateUpstoxTotp(totpSecret);

    // Upstox commonly uses either a single 6-digit input or six single-digit
    // boxes. We try the single-input path first; if the combined value ends
    // up wrong we fall through to the multi-input path.
    const otpSingle = page
      .locator(
        [
          'input[name="otp"]',
          'input[name="otpNum"]',
          'input[autocomplete="one-time-code"]',
          'input[inputmode="numeric"][maxlength="6"]',
          'input[type="tel"][maxlength="6"]',
        ].join(", ")
      )
      .first();
    const otpMulti = page.locator(
      [
        'input[name^="otp"]',
        'input[data-testid^="otp-"]',
        'input[inputmode="numeric"][maxlength="1"]',
        'input[type="tel"][maxlength="1"]',
      ].join(", ")
    );

    let otpSingleVisible = false;
    try {
      await otpSingle.waitFor({ state: "visible", timeout: 15000 });
      otpSingleVisible = true;
    } catch { /* fall through to multi */ }

    if (otpSingleVisible) {
      await otpSingle.fill(totp);
    } else {
      const count = await otpMulti.count();
      if (count === 0) {
        throw new Error("TOTP input field not found on Upstox login page");
      }
      for (let i = 0; i < Math.min(count, totp.length); i++) {
        await otpMulti.nth(i).fill(totp[i]);
      }
    }

    // Submit TOTP — some variants auto-submit after 6 digits; others need a click.
    const totpSubmit = page.locator('button:has-text("Continue"), button:has-text("Verify"), button[type="submit"]').first();
    try {
      await totpSubmit.click({ timeout: 3000 });
    } catch { /* may have auto-submitted */ }

    // ── Step 3: PIN ─────────────────────────────────────────────────────────
    console.log("[upstox-auto-login] entering PIN…");
    const pinSingle = page
      .locator(
        [
          'input[name="pin"]',
          'input[name="pinNum"]',
          'input[placeholder*="PIN" i]',
          'input[aria-label*="PIN" i]',
          'input[type="password"]',
          'input[inputmode="numeric"][maxlength="6"]',
          'input[type="tel"][maxlength="6"]',
        ].join(", ")
      )
      .first();
    let pinMulti = page.locator(
      [
        'input[name^="pin"]',
        'input[placeholder*="PIN" i][maxlength="1"]',
        'input[aria-label*="PIN" i][maxlength="1"]',
        'input[inputmode="numeric"][maxlength="1"]',
        'input[type="tel"][maxlength="1"]',
      ].join(", ")
    );

    let pinSingleVisible = false;
    try {
      await pinSingle.waitFor({ state: "visible", timeout: 15000 });
      pinSingleVisible = true;
    } catch { /* fall through */ }

    if (pinSingleVisible) {
      await pinSingle.fill(loginPin);
    } else {
      let count = await pinMulti.count();
      if (count === 0) {
        // Some Upstox variants reuse generic numeric boxes with no pin-specific
        // attributes. At this stage we're already past TOTP, so it's safe to
        // fall back to any visible 1-digit numeric inputs.
        pinMulti = page.locator(
          [
            'input[inputmode="numeric"]:not([type="hidden"])',
            'input[type="tel"]:not([type="hidden"])',
          ].join(", ")
        );
        count = await pinMulti.count();
      }
      if (count === 0) {
        throw new Error("PIN input field not found on Upstox login page");
      }
      for (let i = 0; i < Math.min(count, loginPin.length); i++) {
        await pinMulti.nth(i).fill(loginPin[i]);
      }
    }

    const pinSubmit = page.locator('button:has-text("Continue"), button:has-text("Login"), button:has-text("Submit"), button[type="submit"]').first();
    try {
      await pinSubmit.click({ timeout: 3000 });
    } catch { /* may have auto-submitted */ }

    // ── Step 4: wait for redirect capture ───────────────────────────────────
    console.log("[upstox-auto-login] waiting for authorization code…");
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !capturedCode && !capturedError) {
      await page.waitForTimeout(250);
    }

    if (capturedError) {
      throw new Error(`Upstox login returned error: ${capturedError}`);
    }
    if (!capturedCode) {
      // Capture page state for debugging
      const currentUrl = page.url();
      throw new Error(
        `Timed out waiting for authorization code (final URL: ${currentUrl}). ` +
        `The Upstox login form may have changed, or credentials may be wrong.`
      );
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* noop */ }
    }
  }

  // ── Step 5: exchange code → access token ──────────────────────────────────
  console.log("[upstox-auto-login] exchanging authorization code for access token…");
  const tokenRes = await axios.post(
    "https://api.upstox.com/v2/login/authorization/token",
    new URLSearchParams({
      code: capturedCode,
      client_id: apiKey,
      client_secret: apiSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "Api-Version": "2.0",
      },
      timeout: 30000,
    }
  );

  const accessToken = tokenRes.data?.access_token;
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("Upstox token endpoint did not return access_token");
  }

  return { accessToken, tokenResponse: tokenRes.data };
}
