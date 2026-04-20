import {
  DEFAULT_PORTAL_ORIGIN,
  getPortalOrigin
} from "../shared/portal-config.js";

/**
 * Extension login page script.
 *
 * This page is opened as a full Chrome tab by the service worker when the
 * extension detects it has no valid auth token. On successful login:
 *  1. The token is stored in chrome.storage.local.
 *  2. A message is sent to the service worker so it can resume operation.
 *  3. This tab closes itself.
 */

const AUTH_STORAGE_KEY = "scraper.auth";

const form = document.getElementById("loginForm");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const submitBtn = document.getElementById("submitBtn");
const errorMsg = document.getElementById("errorMsg");
const successMsg = document.getElementById("successMsg");
const portalOriginLink = document.getElementById("portalOriginLink");

let currentPortalOrigin = DEFAULT_PORTAL_ORIGIN;

async function syncPortalOriginDisplay() {
  try {
    currentPortalOrigin = await getPortalOrigin();
  } catch (_error) {
    currentPortalOrigin = DEFAULT_PORTAL_ORIGIN;
  }

  portalOriginLink.href = currentPortalOrigin;
  portalOriginLink.textContent = currentPortalOrigin;
}

void syncPortalOriginDisplay();

function showError(message) {
  errorMsg.textContent = message;
  errorMsg.hidden = false;
  successMsg.hidden = true;
}

function showSuccess(message) {
  successMsg.textContent = message;
  successMsg.hidden = false;
  errorMsg.hidden = true;
}

function hideMessages() {
  errorMsg.hidden = true;
  successMsg.hidden = true;
}

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.textContent = loading ? "Signing in…" : "Sign In";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessages();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showError("Please enter your email and password.");
    return;
  }

  setLoading(true);

  try {
    const portalOrigin = currentPortalOrigin || await getPortalOrigin();
    const response = await fetch(`${portalOrigin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    let body;
    try {
      body = await response.json();
    } catch (_) {
      body = {};
    }

    if (!response.ok) {
      showError(body.error || "Login failed. Please check your credentials.");
      setLoading(false);
      return;
    }

    const { token, user } = body;

    if (!token) {
      showError("Server returned an unexpected response. Please try again.");
      setLoading(false);
      return;
    }

    // 1. Persist token in extension storage.
    await chrome.storage.local.set({
      [AUTH_STORAGE_KEY]: {
        token,
        email: user.email,
        role: user.role,
        storedAt: new Date().toISOString()
      }
    });

    // 2. Notify the service worker that auth is complete.
    chrome.runtime.sendMessage({ type: "AUTH_COMPLETE", token, user });

    showSuccess(`Signed in as ${user.email}. Closing…`);

    // 3. Close this tab after a brief delay so the user sees the success message.
    setTimeout(() => {
      window.close();
    }, 1200);
  } catch (error) {
    if (error.message.includes("Failed to fetch") || error.message.includes("NetworkError")) {
      showError(
        "Could not reach the portal. " +
        `Make sure the server is running at ${currentPortalOrigin}.`
      );
    } else {
      showError(`Login error: ${error.message}`);
    }
    setLoading(false);
  }
});
