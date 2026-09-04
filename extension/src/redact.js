// Redaction rules applied before page data crosses the extension trust boundary.
//
// Everything here is pure and free of DOM access, so each rule is unit-tested without a browser.
// The injected page code receives the result of `redactionConfig()` as a plain JSON argument and
// applies these patterns in the page, which is what makes "redacted before it leaves the page"
// true rather than aspirational.
//
// This is conservative, not perfect. A field the page gives no signal about cannot be detected, and
// `store/DATA-DISCLOSURES.md` says so plainly rather than claiming complete secret detection.

/** What a masked value is replaced with. Fixed width so it never leaks the original length. */
export const MASK = "••••••••";

/**
 * Query-parameter names whose value is treated as a credential.
 *
 * Matched as a substring against the lowercased parameter name, so `x-api-key` and `access_token`
 * are both caught without enumerating every vendor spelling.
 */
export const SECRET_PARAM_FRAGMENTS = Object.freeze([
  "access_token",
  "id_token",
  "refresh_token",
  "api_key",
  "apikey",
  "auth",
  "bearer",
  "credential",
  "jwt",
  "otp",
  "passwd",
  "password",
  "private_key",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
  "code",
  "key",
]);

/**
 * `autocomplete` values whose field is always masked.
 *
 * These are the browser's own declarations of what a field holds, so they are the most reliable
 * signal available and are checked before any name heuristic.
 */
export const SECRET_AUTOCOMPLETE = Object.freeze([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-name",
  "cc-given-name",
  "cc-family-name",
  "cc-type",
]);

/**
 * Fragments in a field's name, id, or label that mark it as secret-bearing.
 *
 * Deliberately broad: a false positive costs the model one masked field, while a false negative
 * puts a credential into a model request.
 */
export const SECRET_FIELD_FRAGMENTS = Object.freeze([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "api-key",
  "api_key",
  "otp",
  "one-time",
  "onetime",
  "totp",
  "mfa",
  "2fa",
  "verification-code",
  "verificationcode",
  "security-code",
  "securitycode",
  "cvv",
  "cvc",
  "csc",
  "card-number",
  "cardnumber",
  "creditcard",
  "credit-card",
  "iban",
  "routing",
  "ssn",
  "social-security",
  "pin",
]);

/** Input `type` values whose value is never read. */
export const SECRET_INPUT_TYPES = Object.freeze(["password", "hidden"]);

/** Scheme prefix of a URL this module could not parse. */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Schemes whose payload is a hierarchical URL that can be scrubbed field by field.
 *
 * Every other scheme carries an opaque payload — `javascript:` a program, `data:` an inline
 * document, `blob:` an object reference — which cannot be scrubbed and may embed anything,
 * including credentials. Those are reported as the scheme alone. `new URL()` accepts them happily,
 * so the check has to be an allowlist rather than a parse attempt.
 */
const REPORTABLE_SCHEMES = Object.freeze([
  "http:",
  "https:",
  "ftp:",
  "ws:",
  "wss:",
  "file:",
  "about:",
  "chrome:",
  "chrome-extension:",
  "edge:",
  "view-source:",
]);

/** A page-declared pattern for a short numeric code, such as a one-time code field. */
const SHORT_NUMERIC_PATTERN = /^\s*(\\d|\[0-9\])\{[1-8]\}\s*$/;

/**
 * Whether one query-parameter name looks like a credential.
 * @param {string} name The parameter name.
 * @returns {boolean} Whether its value must be masked.
 */
export function isSecretParam(name) {
  const lowered = String(name ?? "").toLowerCase();
  return SECRET_PARAM_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/**
 * Remove credentials from a URL before it is reported.
 *
 * Three things are scrubbed: userinfo in the authority, secret-looking query parameters, and a
 * fragment that carries its own parameters, which is how implicit OAuth flows return tokens.
 * @param {string} raw The URL as the page reports it.
 * @returns {string} A URL safe to send onward.
 */
export function scrubUrl(raw) {
  const value = String(raw ?? "");
  if (value === "") return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    // Not a parseable absolute URL (a `javascript:` form, say). Report the scheme only rather than
    // guessing at the rest, which could itself carry a credential.
    const scheme = value.match(SCHEME_PATTERN);
    return scheme ? `${scheme[1]}:[unparseable URL]` : "[unparseable URL]";
  }

  if (!REPORTABLE_SCHEMES.includes(url.protocol.toLowerCase())) {
    return `${url.protocol}[opaque URL]`;
  }

  if (url.username !== "" || url.password !== "") {
    url.username = "";
    url.password = "";
  }
  for (const name of [...url.searchParams.keys()]) {
    if (isSecretParam(name)) url.searchParams.set(name, MASK);
  }
  if (url.hash.includes("=")) {
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    let changed = false;
    for (const name of [...fragment.keys()]) {
      if (isSecretParam(name)) { fragment.set(name, MASK); changed = true; }
    }
    if (changed) url.hash = `#${fragment.toString()}`;
  }
  return url.toString();
}

/**
 * Whether a form field's value must be masked.
 *
 * The checks run cheapest and most reliable first: the input type, then the browser's own
 * `autocomplete` declaration, then name-like attributes, then the visible label.
 * @param {{type?: string, autocomplete?: string, name?: string, id?: string, label?: string, placeholder?: string, inputMode?: string, pattern?: string}} field The field's descriptive attributes.
 * @returns {boolean} Whether the value must never be reported.
 */
export function isSecretField(field) {
  const type = String(field?.type ?? "").toLowerCase();
  if (SECRET_INPUT_TYPES.includes(type)) return true;

  const autocomplete = String(field?.autocomplete ?? "").toLowerCase();
  if (SECRET_AUTOCOMPLETE.some((token) => autocomplete.split(/\s+/).includes(token))) return true;

  const haystack = [field?.name, field?.id, field?.label, field?.placeholder]
    .map((value) => String(value ?? "").toLowerCase().replace(/\s+/g, "-"))
    .join(" ");
  if (SECRET_FIELD_FRAGMENTS.some((fragment) => haystack.includes(fragment))) return true;

  // A short numeric-only field that a page asks for digit-by-digit is almost always a one-time
  // code. The pattern is the page's own declaration of the expected shape.
  if (SHORT_NUMERIC_PATTERN.test(String(field?.pattern ?? ""))
    && String(field?.inputMode ?? "").toLowerCase() === "numeric") {
    return true;
  }
  return false;
}

/**
 * Reduce a value to what is safe to report.
 * @param {string} value The field's current value.
 * @param {boolean} secret Whether {@link isSecretField} classified it as secret.
 * @param {number} maxChars Cap for a non-secret value.
 * @returns {string} The reportable value.
 */
export function safeValue(value, secret, maxChars = 200) {
  if (secret) return MASK;
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

/**
 * Bound one text payload and say whether anything was dropped.
 * @param {string} text The text.
 * @param {number} maxChars The cap.
 * @returns {{text: string, truncated: boolean}} The bounded text.
 */
export function boundText(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

/**
 * The plain JSON configuration handed to the injected page code.
 *
 * Passing patterns as data rather than duplicating them in the injected function is what keeps the
 * tested rules and the applied rules the same rules.
 * @returns {object} A JSON-serializable redaction configuration.
 */
export function redactionConfig() {
  return {
    mask: MASK,
    secretParamFragments: [...SECRET_PARAM_FRAGMENTS],
    secretAutocomplete: [...SECRET_AUTOCOMPLETE],
    secretFieldFragments: [...SECRET_FIELD_FRAGMENTS],
    secretInputTypes: [...SECRET_INPUT_TYPES],
  };
}
