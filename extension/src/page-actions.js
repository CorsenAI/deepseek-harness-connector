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
// refused an action. It is async so that `wait` can observe the page settle; Chrome awaits the
// returned promise.
//
// ONE visibility policy governs every byte of page data that leaves this function: the element
// inventory, the visible text, `find`, accessible names, labels, and the guard before an action.
// `isVisible()` below is that policy, and `subtreeMayBeVisible()` is its O(1) pruning companion.
// Content the user cannot see — under an `opacity: 0`, `display: none`, or
// `content-visibility: hidden` ancestor, inside a closed `<details>`, marked `aria-hidden`, or
// `visibility: hidden` without a re-shown descendant — must never reach a model request, whatever
// the field looks like. Ported from Corsen AI Hermes Connector v0.2.4
// (`extension/src/page-actions.js`, `VIS` and the filtered text walker).

import { ACTION } from "./protocol.js";

/**
 * Actions performed inside the page by `runPageAction`.
 */
export const PAGE_ACTIONS = Object.freeze([
  ACTION.SNAPSHOT,
  ACTION.READ_TEXT,
  ACTION.CURRENT_URL,
  ACTION.CLICK,
  ACTION.TYPE,
  ACTION.KEY,
  ACTION.SCROLL,
  ACTION.HOVER,
  ACTION.SELECT_OPTION,
  ACTION.DRAG,
  ACTION.FIND,
  ACTION.WAIT,
]);

/**
 * Actions performed by the service worker with `chrome.tabs`, never injected. They change which
 * page a scope is looking at, or which tabs it owns.
 */
export const TAB_ACTIONS = Object.freeze([
  ACTION.NAVIGATE,
  ACTION.BACK,
  ACTION.FORWARD,
  ACTION.RELOAD,
  ACTION.OPEN_TAB,
  ACTION.LIST_TABS,
  ACTION.SWITCH_TAB,
  ACTION.CLOSE_TAB,
]);

/**
 * Every action kind this extension actually performs, in the page or in the worker.
 *
 * The extension declares exactly these in its handshake, so the broker refuses anything else and
 * the plugin never offers the model a tool the browser cannot perform. Adding a kind here without
 * implementing it would turn a clear refusal into a silent failure.
 */
export const IMPLEMENTED_ACTIONS = Object.freeze([...PAGE_ACTIONS, ...TAB_ACTIONS]);

/**
 * Perform one action inside the page.
 *
 * @param {string} kind The action kind.
 * @param {object} args The action arguments, already bounded by the caller.
 * @param {object} config The redaction configuration from `redactionConfig()`.
 * @returns {Promise<{ok: true, data: object}|{ok: false, error: {code: string, message: string}}>} The outcome.
 */
export async function runPageAction(kind, args, config) {
  // ---- bounds -------------------------------------------------------------
  // Every limit below exists so a hostile or merely enormous page cannot make this function run
  // long or return an unbounded payload.
  const MAX_VISITED_NODES = 6000;
  const MAX_TEXT_NODES = 24000;
  const MAX_INTERACTIVE = 400;
  const MAX_NAME_CHARS = 160;
  const MAX_VALUE_CHARS = 200;
  const DEFAULT_TEXT_CHARS = 40000;
  const HARD_TEXT_CHARS = 200000;
  const MAX_TYPE_CHARS = 10000;
  const MAX_SCROLL_PX = 20000;
  const MAX_OPTIONS_LISTED = 50;
  // A role is an ARIA token, never prose. Without this cap a single element carrying a two-megabyte
  // `role` attribute produced a two-megabyte result that still reported `truncated: false`.
  const MAX_ROLE_CHARS = 40;
  // How much of one attribute is read when classifying a control as secret. Long enough for any
  // real name, id, placeholder, or label; short enough that a padded attribute cannot make
  // classification expensive.
  const MAX_ATTR_SCAN_CHARS = 4096;
  const MAX_URL_CHARS = 2048;
  // How long one action may spend walking the document before it stops and says it was cut short.
  // Node counts alone cannot bound this: a visibility query costs whatever the browser's layout
  // costs, which on a pathological document is not a function of how many nodes were visited.
  const MAX_WALK_MS = 5000;
  // How often the clock is consulted, in nodes. Reading it per node would itself be a cost.
  const CLOCK_EVERY_NODES = 256;
  // The last line of defence on payload size: whatever the per-field caps allow, one action never
  // returns more than this. Reported honestly as `truncated`, never silently.
  const MAX_RESULT_BYTES = 512 * 1024;
  const DEFAULT_WAIT_MS = 5000;
  const MAX_WAIT_MS = 15000;
  // The quiet window after the last DOM mutation before the page counts as settled. Half a second
  // is the same heuristic browser automation uses for "network idle": short enough not to stall a
  // static page, long enough that a script's follow-up change lands inside it and extends the wait.
  const SETTLE_QUIET_MS = 500;

  const MASK = config.mask;

  /** When this action must stop walking the document, whatever it has found by then. */
  const walkDeadline = (typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()) + MAX_WALK_MS;

  /**
   * @returns {boolean} Whether this action has run out of wall-clock time to walk the document.
   */
  function outOfTime() {
    const now = typeof performance === "object" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    return now > walkDeadline;
  }

  /** Elements whose contents are never page content: code, styling, metadata, inert templates. */
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);

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
   * Shrink a payload that exceeds {@link MAX_RESULT_BYTES}, in a fixed order, and say so.
   *
   * Per-field caps bound each value, but their product is not bounded: four hundred controls each
   * listing fifty options is megabytes of legitimate-looking output. Options go first because they
   * are the largest and least essential part, then the page text, then the tail of the inventory.
   * @param {Record<string, unknown>} data The payload.
   * @returns {Record<string, unknown>} The payload, within the cap.
   */
  function boundPayload(data) {
    const size = (value) => JSON.stringify(value)?.length ?? 0;
    if (size(data) <= MAX_RESULT_BYTES) return data;
    const out = /** @type {Record<string, unknown>} */ ({ ...data, truncated: true });

    /** @returns {Record<string, unknown>[]|null} The inventory, when the payload carries one. */
    const entries = () => (Array.isArray(out["elements"])
      ? /** @type {Record<string, unknown>[]} */ (out["elements"])
      : null);

    const listed = entries();
    if (listed) {
      out["elements"] = listed.map((entry) => {
        const copy = { ...entry };
        delete copy["options"];
        return copy;
      });
    }
    const text = out["text"];
    if (size(out) > MAX_RESULT_BYTES && typeof text === "string") {
      const excess = size(out) - MAX_RESULT_BYTES;
      out["text"] = text.slice(0, Math.max(0, text.length - excess));
    }
    for (let remaining = entries(); size(out) > MAX_RESULT_BYTES && remaining && remaining.length > 0; remaining = entries()) {
      out["elements"] = remaining.slice(0, Math.floor(remaining.length / 2));
    }
    return out;
  }

  /**
   * @param {object} data The payload.
   * @returns {{ok: true, data: object}} The success.
   */
  const done = (data) => ({ ok: true, data: boundPayload(/** @type {Record<string, unknown>} */ (data)) });

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

  // ---- the visibility policy ------------------------------------------------

  /**
   * Whether anything under this element could be visible: the O(1) prune.
   *
   * These states hide an entire subtree and cannot be undone by a descendant, so the walkers refuse
   * the node and never descend. `visibility: hidden` is deliberately NOT here: a descendant may set
   * `visibility: visible` and reappear, so that case is decided per element by {@link isVisible}.
   * @param {Element} element The candidate.
   * @returns {boolean} Whether the subtree is worth walking at all.
   */
  function subtreeMayBeVisible(element) {
    if (SKIP_TAGS.has(element.tagName)) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    const parent = element.parentElement;
    if (parent && parent.tagName === "DETAILS" && !(/** @type {HTMLDetailsElement} */ (parent)).open
      && element.tagName !== "SUMMARY") return false;
    let style;
    try {
      style = getComputedStyle(element);
    } catch {
      return false;
    }
    if (style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    if (style.contentVisibility === "hidden") return false;
    return true;
  }

  /**
   * The one authoritative answer to "could the user see this element".
   *
   * `Element.checkVisibility()` is preferred because it walks ancestors for every property asked
   * for, and knows what a closed `<details>` and `content-visibility: hidden` mean without this
   * code enumerating them. `contentVisibilityAuto` is left off on purpose: `content-visibility:
   * auto` is a rendering optimisation for off-screen content, not an author's intent to hide it,
   * and treating it as hidden would drop real page content below the fold. The manual walk is the
   * fallback for a runtime without the native check, and repeats the ancestor-driven rules; it
   * checks `visibility` on the element alone because that property inherits, so the element's own
   * computed value already reflects a hidden ancestor and a re-shown descendant alike.
   * @param {unknown} candidate The element.
   * @returns {boolean} Whether it is visible under the policy.
   */
  function isVisible(candidate) {
    if (!(candidate instanceof Element) || !candidate.isConnected) return false;
    const element = candidate;
    if (element.closest('[aria-hidden="true"]')) return false;
    if (typeof element.checkVisibility === "function") {
      try {
        return element.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: false,
          // Older spellings of the same options, for Chrome versions that predate the renames.
          checkOpacity: true,
          checkVisibilityCSS: true,
        });
      } catch {
        // Fall through to the manual walk below.
      }
    }
    if (element.getClientRects().length === 0) return false;
    if (getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = node.parentElement) {
      if (!subtreeMayBeVisible(node)) return false;
    }
    return true;
  }

  /**
   * Walk the visible text under a root, in document order, under a node budget.
   *
   * Hidden subtrees are pruned at the element that hides them, so a page with a hundred thousand
   * hidden nodes costs a hundred thousand rejections at most, never a hundred thousand ancestor
   * walks. Each accepted text node's parent still passes {@link isVisible}, which is what catches
   * `visibility: hidden` and every ancestor-driven case the prune does not.
   * @param {Node} root Where to start.
   * @param {(text: string, parent: Element) => boolean} onText Called per visible text node; return false to stop.
   * @param {number} budget The most nodes to consider.
   * @returns {boolean} Whether the budget ran out before the walk finished.
   */
  function walkVisibleText(root, onText, budget, exclude = null) {
    // A control classified as secret holds its data as text too: a textarea's content is a text
    // node, and a select's option labels are text nodes. Masking the control's `value` while the
    // walk collects the same characters would move the secret from one field of the result to
    // another, which is what the snapshot text and read_text were doing.
    if (root instanceof Element) {
      const holder = root.closest("textarea, select");
      if (holder && isSecret(holder)) return false;
    }
    let remaining = budget;
    let exhausted = false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        remaining -= 1;
        // Accepting on exhaustion, rather than rejecting, is what makes the budget real: a
        // rejection leaves nextNode() scanning every remaining sibling before it returns null, so
        // a thirty-thousand-node page cost thirty thousand filter calls against a budget of
        // twenty-four thousand. An acceptance returns at once and the loop below stops.
        if (remaining < 0) { exhausted = true; return NodeFilter.FILTER_ACCEPT; }
        if ((remaining % CLOCK_EVERY_NODES) === 0 && outOfTime()) { exhausted = true; return NodeFilter.FILTER_ACCEPT; }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = /** @type {Element} */ (node);
          if (exclude !== null && element === exclude) return NodeFilter.FILTER_REJECT;
          if (isSecretValueHolder(element)) return NodeFilter.FILTER_REJECT;
          // An element carries no text of its own: descend into it, or refuse its whole subtree.
          return subtreeMayBeVisible(element)
            ? NodeFilter.FILTER_SKIP
            : NodeFilter.FILTER_REJECT;
        }
        const value = node.nodeValue;
        if (!value || value.trim() === "") return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      if (exhausted) break;
      const parent = /** @type {Element} */ (node.parentElement);
      if (!onText(/** @type {string} */ (node.nodeValue), parent)) break;
    }
    return exhausted;
  }

  /**
   * The visible text inside one element, collapsed, for names and labels.
   *
   * `textContent` would include a hidden child, so a visible button whose label wraps a
   * `display: none` span would leak that span's text through its own name.
   * @param {Element} element The element.
   * @param {number} maxChars The cap.
   * @returns {string} The visible text, whitespace-collapsed.
   */
  function visibleTextOf(element, maxChars, exclude = null) {
    const parts = [];
    let length = 0;
    walkVisibleText(element, (text) => {
      const piece = text.replace(/\s+/g, " ").trim();
      if (piece === "") return true;
      parts.push(piece);
      length += piece.length + 1;
      return length < maxChars;
    }, MAX_TEXT_NODES, exclude);
    return parts.join(" ").slice(0, maxChars);
  }

  // ---- naming and classification -------------------------------------------

  /**
   * The visible label associated with one form control.
   * @param {Element} element The control.
   * @returns {string} The label text, or an empty string.
   */
  function labelFor(element) {
    const id = element.getAttribute("id");
    if (id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (explicit) return visibleTextOf(explicit, MAX_NAME_CHARS, element);
    }
    const wrapping = element.closest("label");
    return wrapping ? visibleTextOf(wrapping, MAX_NAME_CHARS, element) : "";
  }

  /**
   * Whether a control's value must be masked.
   *
   * The same order as the tested rules: input type, then the browser's own `autocomplete`
   * declaration, then name-like attributes, then the visible label.
   * @param {Element} element The control.
   * @returns {boolean} Whether the value must never be reported.
   */
  /** One verdict per element per action, so a control is classified once however often it is seen. */
  const secretVerdicts = new WeakMap();
  /** Elements whose classification is running, to break the label/control cycle described below. */
  const secretPending = new Set();

  /**
   * @param {string|null} value An attribute value.
   * @returns {string} It, normalised and bounded, ready for fragment matching.
   */
  function fragmentKey(value) {
    return String(value ?? "").slice(0, MAX_ATTR_SCAN_CHARS).toLowerCase().replace(/\s+/g, "-");
  }

  /**
   * Whether a control declares itself secret through its own attributes.
   *
   * Kept apart from the label lookup so that classification never needs the page's text, which is
   * what makes {@link isSecret} safe to call from inside the text walk.
   * @param {Element} element The control.
   * @returns {boolean} Whether its attributes say the value is secret.
   */
  function secretByAttributes(element) {
    const type = String(element.getAttribute("type") ?? "").toLowerCase();
    if (config.secretInputTypes.includes(type)) return true;

    const autocomplete = String(element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
    if (config.secretAutocomplete.some((token) => autocomplete.includes(token))) return true;

    const haystack = [
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
    ].map(fragmentKey).join(" ");
    if (config.secretFieldFragments.some((fragment) => haystack.includes(fragment))) return true;

    const pattern = String(element.getAttribute("pattern") ?? "");
    const inputMode = String(element.getAttribute("inputmode") ?? "").toLowerCase();
    return /^\s*(\\d|\[0-9\])\{[1-8]\}\s*$/.test(pattern) && inputMode === "numeric";
  }

  /**
   * Whether a control's value must be masked.
   *
   * The same order as the tested rules: input type, then the browser's own `autocomplete`
   * declaration, then name-like attributes, then the visible label.
   *
   * Reading the label means reading page text, and reading page text asks whether the text sits
   * inside a secret control, which asks this question again. The pending set answers a re-entrant
   * question with the attribute-only verdict, so the pair terminates on any document.
   * @param {Element} element The control.
   * @returns {boolean} Whether the value must never be reported.
   */
  function isSecret(element) {
    const cached = secretVerdicts.get(element);
    if (cached !== undefined) return cached;
    if (secretPending.has(element)) return secretByAttributes(element);

    secretPending.add(element);
    try {
      const verdict = secretByAttributes(element)
        || config.secretFieldFragments.some((fragment) => fragmentKey(labelFor(element)).includes(fragment));
      secretVerdicts.set(element, verdict);
      return verdict;
    } finally {
      secretPending.delete(element);
    }
  }

  /**
   * Whether an element holds a secret value as text as well as in its `value` property.
   * @param {Element} element The element.
   * @returns {boolean} Whether its subtree must never be read.
   */
  function isSecretValueHolder(element) {
    const tag = element.tagName;
    if (tag !== "TEXTAREA" && tag !== "SELECT") return false;
    return isSecret(element);
  }

  /**
   * @param {Element} element The element.
   * @returns {boolean} Whether an action could reach it.
   */
  function isInteractive(element) {
    const tag = element.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea", "summary", "option"].includes(tag)) return true;
    if (element.hasAttribute("contenteditable")) return true;
    if (element.hasAttribute("draggable") && element.getAttribute("draggable") !== "false") return true;
    // An element that declares it accepts drops is a drop target the model may need to address.
    if (element.hasAttribute("ondrop") || element.hasAttribute("ondragover")) return true;
    const role = String(element.getAttribute("role") ?? "").toLowerCase();
    if ([
      "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
      "switch", "combobox", "textbox", "searchbox", "option", "slider", "spinbutton", "listbox",
    ].includes(role)) return true;
    const tabIndex = element.getAttribute("tabindex");
    return tabIndex !== null && tabIndex !== "-1";
  }

  /**
   * The name a person would use for one element.
   *
   * Every text-derived branch reads visible text only, so a hidden descendant cannot name a
   * visible control. `aria-label` is taken as written: it is the author's name for the control,
   * not page content.
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
        .map((node) => visibleTextOf(/** @type {Element} */ (node), MAX_NAME_CHARS))
        .filter((text) => text !== "");
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

    const text = visibleTextOf(element, MAX_NAME_CHARS);
    if (text !== "") return text;
    return element.tagName.toLowerCase();
  }

  /**
   * @param {Element} element The element.
   * @returns {string} A short role name for the model.
   */
  function roleOf(element) {
    const explicit = element.getAttribute("role");
    if (explicit && explicit.trim() !== "") return explicit.trim().toLowerCase().slice(0, MAX_ROLE_CHARS);
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

  // ---- the inventory --------------------------------------------------------

  /**
   * Walk the document once and describe its interactive elements.
   *
   * The walk is iterative and node-capped rather than recursive, so a pathological DOM cannot blow
   * the stack or run unbounded. Hidden subtrees are pruned by the filter, so a hidden node costs one
   * rejection and its descendants cost nothing. Order is document order, which makes two snapshots
   * of an unchanged page identical.
   * @returns {{elements: object[], truncated: boolean}} The inventory.
   */
  function inventory() {
    state.generation += 1;
    state.refs = new Map();
    const generation = state.generation;

    const elements = [];
    let visited = 0;
    let truncated = false;
    let budgetSpent = false;
    const root = document.body ?? document.documentElement;
    if (!root) return { elements, truncated };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        visited += 1;
        // Accept, do not reject, once the budget is spent: see the note in walkVisibleText. The
        // loop below stops on the flag, so the walk costs the budget and not the document.
        if (visited > MAX_VISITED_NODES) { truncated = true; budgetSpent = true; return NodeFilter.FILTER_ACCEPT; }
        if ((visited % CLOCK_EVERY_NODES) === 0 && outOfTime()) {
          truncated = true; budgetSpent = true; return NodeFilter.FILTER_ACCEPT;
        }
        return subtreeMayBeVisible(/** @type {Element} */ (node))
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    while (walker.nextNode()) {
      if (budgetSpent) break;
      // A SHOW_ELEMENT walker yields only elements; the cast records what the filter guarantees.
      const element = /** @type {Element} */ (walker.currentNode);
      if (!isInteractive(element) || !isVisible(element)) continue;
      if (elements.length >= MAX_INTERACTIVE) { truncated = true; break; }

      const ref = `e${elements.length + 1}@${generation}`;
      state.refs.set(ref, element);

      const entry = { ref, role: roleOf(element), name: accessibleName(element) };
      const tag = element.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const control = /** @type {HTMLInputElement} */ (element);
        const secret = isSecret(element);
        const raw = String(control.value ?? "");
        entry.value = secret
          ? MASK
          : (raw.length > MAX_VALUE_CHARS ? `${raw.slice(0, MAX_VALUE_CHARS)}...` : raw);
        if (secret) entry.masked = true;
        if (control.disabled === true) entry.disabled = true;
        if (element.getAttribute("aria-required") === "true" || control.required === true) entry.required = true;
        if (tag === "input") {
          const type = String(element.getAttribute("type") ?? "text").toLowerCase();
          if (type === "checkbox" || type === "radio") entry.checked = control.checked === true;
        }
        if (tag === "select") {
          const select = /** @type {HTMLSelectElement} */ (element);
          // A masked select would otherwise report its card numbers here in full: the option list
          // is the same data as the value, in another shape.
          entry.options = [...select.options].slice(0, MAX_OPTIONS_LISTED).map((option) => (secret
            ? { value: MASK, label: MASK, selected: option.selected === true }
            : {
              value: String(option.value).slice(0, MAX_VALUE_CHARS),
              label: String(option.label || option.textContent || "").trim().slice(0, MAX_NAME_CHARS),
              selected: option.selected === true,
            }));
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
   *
   * A reference is refused when its snapshot is stale, when the element left the document, and
   * when the element is no longer visible: acting on a control the user cannot see is acting on a
   * page the model has not been shown. Returns the element or the reason as two nullable fields
   * rather than a tagged union, because the caller narrows on `element` alone.
   * @param {unknown} ref The reference.
   * @returns {{element: HTMLElement|null, error: {code: string, message: string}|null}} The element, or why not.
   */
  function resolve(ref) {
    const value = String(ref ?? "");
    const generation = Number(value.split("@")[1] ?? "-1");
    const stale = (message) => ({ element: null, error: { code: "STALE_REF", message } });
    if (generation !== state.generation) {
      return stale(`${value} is from an earlier snapshot; take a fresh browser_snapshot`);
    }
    const element = /** @type {HTMLElement|undefined} */ (state.refs.get(value));
    if (!element) return stale(`${value} is not a reference from the latest snapshot`);
    if (!element.isConnected) {
      return stale(`${value} no longer exists on the page; take a fresh browser_snapshot`);
    }
    if (!isVisible(element)) {
      return stale(`${value} is no longer visible on the page; take a fresh browser_snapshot`);
    }
    return { element, error: null };
  }

  /**
   * Visible text, bounded, from a walk that applies the visibility policy to every text node.
   *
   * Not `innerText`: it reports text under an `opacity: 0` or `content-visibility: hidden`
   * ancestor and inside a closed `<details>`, all of which the user cannot see. A line break is
   * emitted when the text moves to a different parent element, which keeps headings, paragraphs,
   * and list items apart without a layout query per node.
   * @param {number} requested The caller's cap, if any.
   * @returns {{text: string, truncated: boolean}} The bounded text.
   */
  function visibleText(requested) {
    const cap = Math.min(
      HARD_TEXT_CHARS,
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_TEXT_CHARS,
    );
    const root = document.body ?? document.documentElement;
    if (!root) return { text: "", truncated: false };

    const parts = [];
    let length = 0;
    let previousParent = null;
    let capped = false;
    const exhausted = walkVisibleText(root, (text, parent) => {
      const piece = text.replace(/\s+/g, " ").trim();
      if (piece === "") return true;
      parts.push(previousParent !== null && parent !== previousParent ? `\n${piece}` : ` ${piece}`);
      previousParent = parent;
      length += piece.length + 1;
      if (length >= cap) { capped = true; return false; }
      return true;
    }, MAX_TEXT_NODES);

    const text = parts.join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text.length > cap
      ? { text: text.slice(0, cap), truncated: true }
      : { text, truncated: capped || exhausted };
  }

  /** @returns {{url: string, title: string}} The page's identity, already scrubbed. */
  function identity() {
    return {
      url: scrubUrl(location.href).slice(0, MAX_URL_CHARS),
      title: String(document.title ?? "").slice(0, MAX_NAME_CHARS),
    };
  }

  // ---- interaction helpers ---------------------------------------------------

  /**
   * Dispatch a pointer-and-mouse sequence on one element.
   * @param {Element} element The target.
   * @param {string[]} types Event types in order; pointer types become PointerEvents.
   * @returns {boolean} Whether every event ran to completion without being cancelled.
   */
  function pointerSequence(element, types) {
    let uncancelled = true;
    for (const type of types) {
      const Constructor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      uncancelled = element.dispatchEvent(new Constructor(type, {
        bubbles: true, cancelable: true, composed: true, view: window,
      })) && uncancelled;
    }
    return uncancelled;
  }

  /**
   * Submit the form an element belongs to, the way the browser would on Enter.
   *
   * `requestSubmit` runs validation and the submit handlers; a synthetic Enter alone submits
   * nothing, so without this a "submit" that reports success would have done nothing.
   *
   * It also runs constraint validation, and a form with an empty required field is refused: no
   * submit event is dispatched and nothing is sent. Returning `true` regardless, as this did,
   * told the model a form had been submitted while the page had received nothing. The submit event
   * is therefore observed rather than assumed. Note what the observation means: the browser
   * dispatched the form's submit event. It does not mean a server accepted anything.
   * @param {HTMLElement} element The control.
   * @returns {{submitted: boolean, reason: string|null}} What actually happened.
   */
  function submitFormOf(element) {
    const form = /** @type {HTMLInputElement} */ (element).form;
    if (!form) return { submitted: false, reason: "the control is not inside a form" };
    let dispatched = false;
    const record = () => { dispatched = true; };
    form.addEventListener("submit", record, { capture: true });
    try {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      // The legacy path skips validation and dispatches no event, but it does submit.
      else { form.submit(); return { submitted: true, reason: null }; }
    } finally {
      form.removeEventListener("submit", record, { capture: true });
    }
    if (dispatched) return { submitted: true, reason: null };
    const invalid = typeof form.checkValidity === "function" && !form.checkValidity();
    return {
      submitted: false,
      reason: invalid
        ? "the browser refused the submission because the form is not valid"
        : "the page cancelled the submission",
    };
  }

  /** Keys accepted by `key`, with the `code` and legacy `keyCode` listeners still check. */
  const NAMED_KEYS = {
    Enter: ["Enter", 13], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8],
    Delete: ["Delete", 46], ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40],
    ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39], Home: ["Home", 36], End: ["End", 35],
    PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], " ": ["Space", 32], Space: ["Space", 32],
  };

  /**
   * Wait until the page has loaded and its DOM has been quiet for a moment, or until the deadline.
   * @param {number} deadlineMs Longest wait.
   * @returns {Promise<{settled: boolean, waitedMs: number}>} Whether it settled in time.
   */
  function waitForSettle(deadlineMs) {
    return new Promise((resolveWait) => {
      const started = Date.now();
      let lastMutation = Date.now();
      const observer = new MutationObserver(() => { lastMutation = Date.now(); });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const tick = () => {
        const now = Date.now();
        const loaded = document.readyState === "complete";
        if (loaded && now - lastMutation >= SETTLE_QUIET_MS) {
          observer.disconnect();
          resolveWait({ settled: true, waitedMs: now - started });
          return;
        }
        if (now - started >= deadlineMs) {
          observer.disconnect();
          resolveWait({ settled: false, waitedMs: now - started });
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
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
      const { element, error } = resolve(args.ref);
      if (!element) return fail(error.code, error.message);
      if (/** @type {HTMLButtonElement} */ (element).disabled === true) {
        return fail("ACTION_FAILED", `${accessibleName(element)} is disabled and cannot be clicked`);
      }
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const name = accessibleName(element);
      // A pointer sequence rather than a bare `click()`: many controls listen for pointerdown or
      // mousedown and never see a synthetic click alone.
      pointerSequence(element, ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup"]);
      if (typeof element.click === "function") element.click();
      else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
      return done({ clicked: name, ...identity() });
    }

    if (kind === "type") {
      const { element, error } = resolve(args.ref);
      if (!element) return fail(error.code, error.message);
      const control = /** @type {HTMLInputElement} */ (element);
      if (control.disabled === true || control.readOnly === true) {
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
        const next = args.replace === true ? text : `${String(control.value ?? "")}${text}`;
        if (setter) setter.call(element, next);
        else control.value = next;
      }
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

      let submitted = false;
      /** @type {string|null} */
      let submitFailed = null;
      if (args.submit === true) {
        let uncancelled = true;
        for (const type of ["keydown", "keypress", "keyup"]) {
          uncancelled = element.dispatchEvent(new KeyboardEvent(type, {
            key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true, composed: true,
          })) && uncancelled;
        }
        // Implicit submission, as the browser does for Enter in a form field — unless a handler
        // prevented the keydown, in which case the page has taken over and submitting would be a
        // second, unrequested action.
        if (uncancelled && !editable && !(element instanceof HTMLTextAreaElement)) {
          const outcome = submitFormOf(element);
          submitted = outcome.submitted;
          submitFailed = outcome.reason;
        } else if (!uncancelled) {
          submitFailed = "the page handled the Enter key itself, so no form submission was attempted";
        } else {
          submitFailed = "this control does not submit its form on Enter";
        }
      }
      // The typed text is never echoed back: it may be exactly the value a caller should not have
      // sent, and repeating it would put it in the session log a second time. The typing and the
      // submission are reported separately: the text really was entered even when the browser then
      // refused to submit the form, and calling the whole action a failure would be as wrong as
      // calling it a success.
      const typedResult = /** @type {Record<string, unknown>} */ ({ typed: accessibleName(element), submitted, ...identity() });
      if (submitFailed !== null) typedResult["submitFailed"] = submitFailed;
      return done(typedResult);
    }

    if (kind === "key") {
      const raw = String(args.key ?? "").trim();
      if (raw === "") return fail("ACTION_FAILED", "key is required, for example Enter, Escape, Tab, ArrowDown, or Control+a");
      const parts = raw.split("+");
      const keyName = parts.pop();
      const modifiers = new Set(parts.map((part) => part.toLowerCase()));
      const named = NAMED_KEYS[keyName];
      const single = keyName.length === 1;
      if (!named && !single) {
        return fail("ACTION_FAILED", `${keyName} is not a supported key; use a single character or one of ${Object.keys(NAMED_KEYS).filter((name) => name !== " ").join(", ")}`);
      }
      let target = document.activeElement;
      if (args.ref !== undefined) {
        const { element, error } = resolve(args.ref);
        if (!element) return fail(error.code, error.message);
        element.scrollIntoView({ block: "center", inline: "nearest" });
        if (typeof element.focus === "function") element.focus();
        target = element;
      }
      if (!target || target === document.body) target = document.body ?? document.documentElement;
      const init = {
        key: named ? keyName : keyName, code: named ? named[0] : `Key${keyName.toUpperCase()}`,
        keyCode: named ? named[1] : keyName.toUpperCase().charCodeAt(0),
        ctrlKey: modifiers.has("control") || modifiers.has("ctrl"),
        shiftKey: modifiers.has("shift"), altKey: modifiers.has("alt"),
        metaKey: modifiers.has("meta") || modifiers.has("command") || modifiers.has("cmd"),
        bubbles: true, cancelable: true, composed: true,
      };
      let uncancelled = true;
      for (const type of ["keydown", "keypress", "keyup"]) {
        uncancelled = target.dispatchEvent(new KeyboardEvent(type, init)) && uncancelled;
      }
      let submitted = false;
      /** @type {string|null} */
      let keySubmitFailed = null;
      if (keyName === "Enter" && modifiers.size === 0 && uncancelled && target instanceof HTMLInputElement) {
        const outcome = submitFormOf(target);
        submitted = outcome.submitted;
        keySubmitFailed = outcome.reason;
      }
      const keyResult = /** @type {Record<string, unknown>} */ ({ key: raw, target: accessibleName(target), submitted, ...identity() });
      if (keySubmitFailed !== null) keyResult["submitFailed"] = keySubmitFailed;
      return done(keyResult);
    }

    if (kind === "scroll") {
      if (args.ref !== undefined) {
        const { element, error } = resolve(args.ref);
        if (!element) return fail(error.code, error.message);
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      } else if (args.to === "top") {
        window.scrollTo({ top: 0, behavior: "instant" });
      } else if (args.to === "bottom") {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      } else {
        const dy = Number(args.dy);
        if (!Number.isFinite(dy)) return fail("ACTION_FAILED", "scroll needs a ref, to: top|bottom, or a numeric dy");
        window.scrollBy({ top: Math.max(-MAX_SCROLL_PX, Math.min(MAX_SCROLL_PX, dy)), behavior: "instant" });
      }
      return done({
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        ...identity(),
      });
    }

    if (kind === "hover") {
      const { element, error } = resolve(args.ref);
      if (!element) return fail(error.code, error.message);
      element.scrollIntoView({ block: "center", inline: "nearest" });
      pointerSequence(element, ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]);
      return done({ hovered: accessibleName(element), ...identity() });
    }

    if (kind === "select_option") {
      const { element, error } = resolve(args.ref);
      if (!element) return fail(error.code, error.message);
      if (!(element instanceof HTMLSelectElement)) {
        return fail("ACTION_FAILED", `${accessibleName(element)} is not a select control`);
      }
      if (element.disabled) return fail("ACTION_FAILED", `${accessibleName(element)} is disabled`);
      const wantValue = args.value === undefined ? null : String(args.value);
      const wantLabel = args.label === undefined ? null : String(args.label).trim();
      const options = [...element.options];
      const match = options.find((option) => wantValue !== null && option.value === wantValue)
        ?? options.find((option) => wantLabel !== null && (option.label || option.textContent || "").trim() === wantLabel)
        ?? options.find((option) => wantLabel !== null && (option.label || option.textContent || "").trim().toLowerCase() === wantLabel.toLowerCase());
      if (!match) {
        // The failure message is a result like any other: listing a masked select's options here
        // would hand over exactly what the inventory refused to report.
        const available = isSecret(element)
          ? `${options.length} masked option(s)`
          : options.slice(0, MAX_OPTIONS_LISTED)
            .map((option) => `${(option.label || option.textContent || "").trim()} (${option.value})`).join(", ");
        return fail("ACTION_FAILED", `no option matches ${wantValue ?? wantLabel ?? "(nothing given)"}; available: ${available}`);
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (setter) setter.call(element, match.value); else element.value = match.value;
      match.selected = true;
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return done({
        selected: { value: match.value, label: (match.label || match.textContent || "").trim() },
        control: accessibleName(element),
        ...identity(),
      });
    }

    if (kind === "drag") {
      const source = resolve(args.from);
      if (!source.element) return fail(source.error.code, source.error.message);
      const target = resolve(args.to);
      if (!target.element) return fail(target.error.code, target.error.message);
      const from = source.element;
      const to = target.element;
      from.scrollIntoView({ block: "center", inline: "nearest" });
      // Both models of dragging are driven, because a page implements one or the other: pointer
      // events for libraries that track the pointer, and the HTML5 drag-and-drop sequence with one
      // shared DataTransfer for pages that use dragstart/drop.
      pointerSequence(from, ["pointerover", "pointerdown", "mousedown"]);
      pointerSequence(to, ["pointermove", "mousemove", "pointerover", "mouseover"]);
      const transfer = new DataTransfer();
      const dragEvent = (type, element) => element.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, composed: true, dataTransfer: transfer,
      }));
      dragEvent("dragstart", from);
      dragEvent("dragenter", to);
      dragEvent("dragover", to);
      dragEvent("drop", to);
      dragEvent("dragend", from);
      pointerSequence(to, ["pointerup", "mouseup"]);
      return done({ dragged: accessibleName(from), droppedOn: accessibleName(to), ...identity() });
    }

    if (kind === "find") {
      const needle = String(args.text ?? "").trim();
      if (needle === "") return fail("ACTION_FAILED", "text to find is required");
      const lowered = needle.toLowerCase();
      const root = document.body ?? document.documentElement;
      let count = 0;
      /** @type {{text: string, parent: Element}|null} */
      let first = null;
      // The same visible-text walk as the snapshot, so `find` can never locate — and scroll the
      // user to — text the snapshot would not have shown.
      if (root) {
        walkVisibleText(root, (text, parent) => {
          if (!text.toLowerCase().includes(lowered)) return true;
          count += 1;
          if (!first) first = { text, parent };
          return true;
        }, MAX_TEXT_NODES);
      }
      if (!first) return done({ found: false, count: 0, ...identity() });
      first.parent.scrollIntoView({ block: "center", inline: "nearest" });
      const content = first.text;
      const at = content.toLowerCase().indexOf(lowered);
      const snippet = content.slice(Math.max(0, at - 60), Math.min(content.length, at + needle.length + 60)).replace(/\s+/g, " ").trim();
      return done({ found: true, count, snippet, ...identity() });
    }

    if (kind === "wait") {
      const requested = Number(args.ms);
      const deadline = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_WAIT_MS, requested) : DEFAULT_WAIT_MS;
      const outcome = await waitForSettle(deadline);
      return done({ readyState: document.readyState, ...outcome, ...identity() });
    }

    return fail("UNSUPPORTED_ACTION", `the extension does not implement ${String(kind)} in the page`);
  } catch (cause) {
    // A throw here would reach the service worker as an injection failure indistinguishable from a
    // page that refused the action, so it is reported as a typed failure instead.
    return fail("ACTION_FAILED", `the page could not perform ${String(kind)}: ${String(cause?.message ?? cause)}`);
  }
}
