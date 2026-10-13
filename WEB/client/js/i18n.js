import { api } from "./api.js";
import en from "./locales/en.js";
import tr from "./locales/tr.js";

// UI translations. English is the source of truth; a key missing from another
// language falls back to English, then to the key itself.
export const LANGS = { en: "English", tr: "Türkçe" };
const DICTS = { en, tr };
const STORAGE_KEY = "tm-lang";

let lang = "en";

function stored() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

// Priority: saved on the account > this browser's last choice > browser language.
export function initLang(user) {
  const browser = (navigator.language || "en").slice(0, 2).toLowerCase();
  const pick = [user?.language, stored(), browser].find((l) => l in DICTS);
  lang = pick || "en";
  document.documentElement.lang = lang;
}

// Server errors arrive in English; translate the known ones, pass the rest through.
export function tErr(message) {
  const m = String(message ?? "");
  return DICTS[lang]?.[`err:${m}`] ?? m;
}

export function getLang() {
  return lang;
}

// BCP-47 locale for Intl / toLocaleString.
export function locale() {
  return lang === "tr" ? "tr-TR" : "en-GB";
}

// t("key", { name: "Ada" }) replaces {name} in the translated string.
export function t(key, vars) {
  const s = DICTS[lang]?.[key] ?? en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

// Object whose values are translated on read: labels("status", ["TODO"]).TODO
export function labels(prefix, keys) {
  const out = {};
  for (const k of keys) Object.defineProperty(out, k, { enumerable: true, get: () => t(`${prefix}.${k}`) });
  return out;
}

export async function setLang(next, { signedIn = false } = {}) {
  if (!(next in DICTS)) return;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
  if (signedIn) await api.patch("/me/language", { language: next }).catch(() => {});
  location.reload();
}

export function langSwitcherHtml(id = "lang-select") {
  return `<select id="${id}" class="lang-select" aria-label="${t("common.language")}" title="${t("common.language")}">${
    Object.entries(LANGS).map(([k, name]) => `<option value="${k}"${k === lang ? " selected" : ""}>${name}</option>`).join("")
  }</select>`;
}

export function bindLangSwitcher(root, { signedIn = false, id = "lang-select" } = {}) {
  const sel = root.querySelector(`#${id}`);
  if (sel) sel.addEventListener("change", () => setLang(sel.value, { signedIn }));
}
