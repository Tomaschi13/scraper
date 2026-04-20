export const DEFAULT_PORTAL_ORIGIN = "http://127.0.0.1:5077";
export const PORTAL_ORIGIN_STORAGE_KEY = "scraper.portalOrigin";
export const PORTAL_ORIGIN = DEFAULT_PORTAL_ORIGIN;

let cachedPortalOrigin = DEFAULT_PORTAL_ORIGIN;
let storageListenerRegistered = false;

function canUseChromeStorage() {
  return typeof chrome !== "undefined"
    && Boolean(chrome.storage?.local)
    && Boolean(chrome.storage?.onChanged);
}

function normalizePortalOrigin(origin) {
  if (typeof origin !== "string") {
    return DEFAULT_PORTAL_ORIGIN;
  }

  const trimmed = origin.trim();
  if (!trimmed) {
    return DEFAULT_PORTAL_ORIGIN;
  }

  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");

  try {
    const parsed = new URL(withoutTrailingSlash);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_PORTAL_ORIGIN;
    }

    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch (_error) {
    return DEFAULT_PORTAL_ORIGIN;
  }
}

function registerStorageListener() {
  if (!canUseChromeStorage() || storageListenerRegistered) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(PORTAL_ORIGIN_STORAGE_KEY in changes)) {
      return;
    }

    cachedPortalOrigin = normalizePortalOrigin(changes[PORTAL_ORIGIN_STORAGE_KEY].newValue);
  });

  storageListenerRegistered = true;
}

export async function getPortalOrigin() {
  registerStorageListener();

  if (!canUseChromeStorage()) {
    return cachedPortalOrigin;
  }

  try {
    const stored = await chrome.storage.local.get(PORTAL_ORIGIN_STORAGE_KEY);
    cachedPortalOrigin = normalizePortalOrigin(stored[PORTAL_ORIGIN_STORAGE_KEY]);
  } catch (_error) {
    cachedPortalOrigin = DEFAULT_PORTAL_ORIGIN;
  }

  return cachedPortalOrigin;
}

export async function setPortalOrigin(origin) {
  const nextOrigin = normalizePortalOrigin(origin);
  cachedPortalOrigin = nextOrigin;
  registerStorageListener();

  if (canUseChromeStorage()) {
    await chrome.storage.local.set({
      [PORTAL_ORIGIN_STORAGE_KEY]: nextOrigin
    });
  }

  return nextOrigin;
}

export async function portalUrl(path = "") {
  const origin = await getPortalOrigin();
  if (!path) {
    return origin;
  }

  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}
