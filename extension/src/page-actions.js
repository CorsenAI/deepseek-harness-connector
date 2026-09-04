// The page interface: one self-contained function injected into an attached tab.
//
// `chrome.scripting.executeScript({ func })` serialises the function's source and runs it in the
// page, so `runPageAction` must reference nothing from this module's scope. Everything it needs —
// the redaction patterns from `redact.js`, the action kind, the arguments — arrives as
// JSON-serialisable arguments. That is what keeps the tested redaction rules and the applied
// redaction rules the same rules, with no second copy to drift.
//
// It returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }` and never throws
// across the boundary, because a rejected injection would be indistinguishable from a page that
// refused an action.

import { ACTION } from "./protocol.js";

/**
 * Action kinds this file actually implements.
 *
 * The extension declares exactly these in its handshake, so the broker refuses anything else and
 * the plugin never offers the model a tool the page cannot perform. Adding a kind here without
 * implementing it below would turn a clear refusal into a silent failure.
 */
export const IMPLEMENTED_ACTIONS = Object.freeze([
  ACTION.SNAPSHOT,
  ACTION.READ_TEXT,
  ACTION.CURRENT_URL,
  ACTION.CLICK,
  ACTION.TYPE,
]);

/**
 * Perform one action inside the page.
 *
 * @param {string} kind The action kind.
 * @param {object} args The action arguments, already bounded by the caller.
 * @param {object} config The redaction configuration from `redactionConfig()`.
 * @returns {{ok: true, data: object}|{ok: false, error: {code: string, message: string}}} The outcome.
 */
export function runPageAction(kind, args, config) {
  // ---- bounds -------------------------------------------------------------
  // Every limit below exists so a hostile or merely enormous page cannot make this function run
  // long or return an unbounded payload.
  const MAX_VISITED_NODES = 6000;
  const MAX_INTERACTIVE = 400;
  const MAX_NAME_CHARS = 160;
  const MAX_VALUE_CHARS = 200;
  const DEFAULT_TEXT_CHARS = 40000;
  const HARD_TEXT_CHARS = 200000;
  const MAX_TYPE_CHARS = 10000;

  const MASK = config.mask;

  /**
   * A per-page registry of element references.
   *
   * References are minted per snapshot and carry that snapshot's generation, so a reference from an
   * earlier snapshot is refused rather than resolved against whatever element now sits at that
   * index. Silently acting on a reused index is how an agent clicks the wrong control.
   */
  const state = (() => {
    const key = "__corsenDshConnectorPageState";
    const existing = globalThis[key];
    if (existing && typeof existing === "object") return existing;
    const created = { generation: 0, refs: new Map() };
    globalThis[key] = created;
    return created;
  })();

  /**
   * @param {string} code The typed failure code.
   * @param {string} message Human-readable detail.
   * @returns {{ok: false, error: {code: string, message: string}}} The failure.
   */
  const fail = (code, message) => ({ ok: false, error: { code, message } });

  /**
   * @param {object} data The payload.
   * @returns {{ok: true, data: object}} The success.
   */
  const done = (data) => ({ ok: true, data });

  /**
   * @param {string} name A query-parameter name.
   * @returns {boolean} Whether its value is a credential.
   */
  function isSecretParam(name) {
    const lowered = String(name ?? "").toLowerCase();
    return config.secretParamFragments.some((fragment) => lowered.includes(fragment));
  }

  /**
   * Remove credentials from a URL, in the page, before it can leave.
   * @param {string} raw The URL.
   * @returns {string} A URL safe to report.
   */
  function scrubUrl(raw) {
    const value = String(raw ?? "");
    if (value === "") return "";
    let url;
    try {
      url = new URL(value);
    } catch {
      const match = value.match(/^([a-z][a-z0-9+.-]*):/i);
      return match ? `${match[1]}:[unparseable URL]` : "[unparseable URL]";
    }
    const reportable = [
      "http:", "https:", "ftp:", "ws:", "wss:", "file:", "about:", "chrome:", "chrome-extension:",
      "edge:", "view-source:",
    ];
    if (!reportable.includes(url.protocol.toLowerCase())) return `${url.protocol}[opaque URL]`;
    url.username = "";
    url.password = "";
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
   * The visible label associated with one form control.
   * @param {Element} element The control.
   * @returns {string} The label text, or an empty string.
   */
  function labelFor(element) {
    const id = element.getAttribute("id");
    if (id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (explicit) return (explicit.textContent ?? "").trim();
    }
    const wrapping = element.closest("label");
    return wrapping ? (wrapping.textContent ?? "").trim() : "";
  }

  /**
   * Whether a control's value must be masked.
   *
   * The same order as the tested rules: input type, then the browser's own `autocomplete`
   * declaration, then name-like attributes, then the visible label.
   * @param {Element} element The control.
   * @returns {boolean} Whether the value must never be reported.
   */
  function isSecret(element) {
    const type = String(element.getAttribute("type") ?? "").toLowerCase();
    if (config.secretInputTypes.includes(type)) return true;

    const autocomplete = String(element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
    if (config.secretAutocomplete.some((token) => autocomplete.includes(token))) return true;

    const haystack = [
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      labelFor(element),
    ].map((value) => String(value ?? "").toLowerCase().replace(/\s+/g, "-")).join(" ");
    if (config.secretFieldFragments.some((fragment) => haystack.includes(fragment))) return true;

    const pattern = String(element.getAttribute("pattern") ?? "");
    const inputMode = String(element.getAttribute("inputmode") ?? "").toLowerCase();
    return /^\s*(\\d|\[0-9\])\{[1-8]\}\s*$/.test(pattern) && inputMode === "numeric";
  }

  /**
   * @param {Element} element The element.
   * @returns {boolean} Whether the user could see it.
   */
  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return Number(style.opacity) !== 0;
  }

  /**
   * @param {Element} element The element.
   * @returns {boolean} Whether an action could reach it.
   */
  function isInteractive(element) {
    const tag = element.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea", "summary", "option"].includes(tag)) return true;
    if (element.hasAttribute("contenteditable")) return true;
    const role = String(element.getAttribute("role") ?? "").toLowerCase();
    if ([
      "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
      "switch", "combobox", "textbox", "searchbox", "option", "slider", "spinbutton",
    ].includes(role)) return true;
    const tabIndex = element.getAttribute("tabindex");
    return tabIndex !== null && tabIndex !== "-1";
  }

  /**
   * The name a person would use for one element.
   * @param {Element} element The element.
   * @returns {string} A short accessible name.
   */
  function accessibleName(element) {
    const aria = element.getAttribute("aria-label");
    if (aria && aria.trim() !== "") return aria.trim().slice(0, MAX_NAME_CHARS);

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node) => node !== null)
        .map((node) => (node.textContent ?? "").trim());
      if (parts.length > 0) return parts.join(" ").slice(0, MAX_NAME_CHARS);
    }

    const label = labelFor(element);
    if (label !== "") return label.slice(0, MAX_NAME_CHARS);

    for (const attribute of ["placeholder", "title", "alt", "value"]) {
      // `value` is a name only for a button; for a text field it is content, and content that may
      // be secret, so it is never used as a name there.
      if (attribute === "value") {
        const type = String(element.getAttribute("type") ?? "").toLowerCase();
        if (!["button", "submit", "reset"].includes(type)) continue;
      }
      const candidate = element.getAttribute(attribute);
      if (candidate && candidate.trim() !== "") return candidate.trim().slice(0, MAX_NAME_CHARS);
    }

    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text !== "") return text.slice(0, MAX_NAME_CHARS);
    return element.tagName.toLowerCase();
  }

  /**
   * @param {Element} element The element.
   * @returns {string} A short role name for the model.
   */
  function roleOf(element) {
    const explicit = element.getAttribute("role");
    if (explicit && explicit.trim() !== "") return explicit.trim().toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") {
      const type = String(element.getAttribute("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return tag;
  }

  /**
   * Walk the document once and describe its interactive elements.
   *
   * The walk is iterative and node-capped rather than recursive, so a pathological DOM cannot blow
   * the stack or run unbounded. Order is document order, which makes two snapshots of an unchanged
   * page identical.
   * @returns {{elements: object[], truncated: boolean}} The inventory.
   */
  function inventory() {
    state.generation += 1;
    state.refs = new Map();
    const generation = state.generation;

    const elements = [];
    let visited = 0;
    let truncated = false;
    const walker = document.createTreeWalker(document.body ?? document, NodeFilter.SHOW_ELEMENT);

    while (walker.nextNode()) {
      visited += 1;
      if (visited > MAX_VISITED_NODES) { truncated = true; break; }
      const element = walker.currentNode;
      if (!isInteractive(element) || !isVisible(element)) continue;
      if (elements.length >= MAX_INTERACTIVE) { truncated = true; break; }

      const ref = `e${elements.length + 1}@${generation}`;
      state.refs.set(ref, element);

      const entry = { ref, role: roleOf(element), name: accessibleName(element) };
      const tag = element.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const secret = isSecret(element);
        const raw = String(element.value ?? "");
        entry.value = secret
          ? MASK
          : (raw.length > MAX_VALUE_CHARS ? `${raw.slice(0, MAX_VALUE_CHARS)}...` : raw);
        if (secret) entry.masked = true;
        if (element.disabled === true) entry.disabled = true;
        if (element.getAttribute("aria-required") === "true" || element.required === true) entry.required = true;
        if (tag === "input") {
          const type = String(element.getAttribute("type") ?? "text").toLowerCase();
          if (type === "checkbox" || type === "radio") entry.checked = element.checked === true;
        }
      }
      if (element.getAttribute("aria-expanded") !== null) {
        entry.expanded = element.getAttribute("aria-expanded") === "true";
      }
      elements.push(entry);
    }
    return { elements, truncated };
  }

  /**
   * Resolve one element reference minted by the current snapshot.
   * @param {unknown} ref The reference.
   * @returns {{ok: true, element: Element}|{ok: false, error: {code: string, message: string}}} The element.
   */
  function resolve(ref) {
    const value = String(ref ?? "");
    const generation = Number(value.split("@")[1] ?? "-1");
    if (generation !== state.generation) {
      return fail("STALE_REF", `${value} is from an earlier snapshot; take a fresh browser_snapshot`);
    }
    const element = state.refs.get(value);
    if (!element) return fail("STALE_REF", `${value} is not a reference from the latest snapshot`);
    if (!element.isConnected) {
      return fail("STALE_REF", `${value} no longer exists on the page; take a fresh browser_snapshot`);
    }
    return { ok: true, element };
  }

  /**
   * Visible text, bounded.
   * @param {number} requested The caller's cap, if any.
   * @returns {{text: string, truncated: boolean}} The bounded text.
   */
  function visibleText(requested) {
    const cap = Math.min(
      HARD_TEXT_CHARS,
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_TEXT_CHARS,
    );
    const source = document.body ?? document.documentElement;
    const raw = source ? String(source.innerText ?? source.textContent ?? "") : "";
    const collapsed = raw.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return collapsed.length > cap
      ? { text: collapsed.slice(0, cap), truncated: true }
      : { text: collapsed, truncated: false };
  }

  /** @returns {{url: string, title: string}} The page's identity, already scrubbed. */
  function identity() {
    return {
      url: scrubUrl(location.href),
      title: String(document.title ?? "").slice(0, MAX_NAME_CHARS),
    };
  }

  // ---- actions ------------------------------------------------------------

  try {
    if (kind === "snapshot") {
      const { elements, truncated: capped } = inventory();
      const { text, truncated: textTruncated } = visibleText(args.maxChars);
      return done({ ...identity(), text, elements, truncated: capped || textTruncated });
    }

    if (kind === "read_text") {
      const { text, truncated } = visibleText(args.maxChars);
      return done({ ...identity(), text, truncated });
    }

    if (kind === "current_url") {
      return done(identity());
    }

    if (kind === "click") {
      const found = resolve(args.ref);
      if (!found.ok) return found;
      const element = found.element;
      if (element.disabled === true) {
        return fail("ACTION_FAILED", `${accessibleName(element)} is disabled and cannot be clicked`);
      }
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const name = accessibleName(element);
      // A pointer sequence rather than a bare `click()`: many controls listen for pointerdown or
      // mousedown and never see a synthetic click alone.
      for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
        element.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, {
          bubbles: true, cancelable: true, composed: true,
        }));
      }
      if (typeof element.click === "function") element.click();
      else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
      return done({ clicked: name, ...identity() });
    }

    if (kind === "type") {
      const found = resolve(args.ref);
      if (!found.ok) return found;
      const element = found.element;
      if (element.disabled === true || element.readOnly === true) {
        return fail("ACTION_FAILED", `${accessibleName(element)} does not accept input`);
      }
      const text = String(args.text ?? "");
      if (text.length > MAX_TYPE_CHARS) {
        return fail("ACTION_FAILED", `the text is longer than the ${MAX_TYPE_CHARS} character limit`);
      }
      element.scrollIntoView({ block: "center", inline: "nearest" });
      if (typeof element.focus === "function") element.focus();

      const editable = element.hasAttribute("contenteditable");
      if (editable) {
        if (args.replace === true) element.textContent = "";
        element.textContent = `${element.textContent ?? ""}${text}`;
      } else {
        // React and Vue track the value through the property descriptor, so assigning `.value`
        // directly is ignored on re-render. Going through the prototype setter and then dispatching
        // `input` is what makes a controlled component see the change.
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        const next = args.replace === true ? text : `${String(element.value ?? "")}${text}`;
        if (setter) setter.call(element, next);
        else element.value = next;
      }
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

      if (args.submit === true) {
        for (const type of ["keydown", "keypress", "keyup"]) {
          element.dispatchEvent(new KeyboardEvent(type, {
            key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true, composed: true,
          }));
        }
      }
      // The typed text is never echoed back: it may be exactly the value a caller should not have
      // sent, and repeating it would put it in the session log a second time.
      return done({ typed: accessibleName(element), ...identity() });
    }

    return fail("UNSUPPORTED_ACTION", `the extension does not implement ${String(kind)}`);
  } catch (cause) {
    // A throw here would reach the service worker as an injection failure indistinguishable from a
    // page that refused the action, so it is reported as a typed failure instead.
    return fail("ACTION_FAILED", `the page could not perform ${String(kind)}: ${String(cause?.message ?? cause)}`);
  }
}
