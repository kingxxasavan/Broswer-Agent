/**
 * Content script — one instance per frame.
 *
 * It knows nothing about the AI. It answers four kinds of question from the
 * service worker: "what is on this page", "click element N", "type into
 * element N", and a few navigation helpers. Elements are addressed by an index
 * into the list produced by the most recent snapshot of *this frame*; the
 * service worker owns the mapping from the model's global index to
 * (frame, local index).
 */

(() => {
  if (window.__browserAgentContentLoaded) return;
  window.__browserAgentContentLoaded = true;

  const MAX_LABEL = 120;

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "label[for]",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=menuitemcheckbox]",
    "[role=menuitemradio]",
    "[role=option]",
    "[role=switch]",
    "[role=combobox]",
    "[role=searchbox]",
    "[role=textbox]",
    "[contenteditable='']",
    "[contenteditable=true]",
    "[onclick]",
    "[tabindex]",
  ].join(",");

  /** Elements from the most recent snapshot, addressed by index. */
  let currentElements = [];

  // ---------------------------------------------------------------- helpers

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function clean(str) {
    return String(str || "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  }

  function labelFor(el) {
    const direct =
      el.getAttribute("aria-label") ||
      (el.innerText && el.innerText.trim()) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      el.getAttribute("name") ||
      el.value ||
      "";
    if (direct) return clean(direct);

    // Fall back to a linked <label> or aria-labelledby target.
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target) return clean(target.innerText);
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return clean(label.innerText);
    }
    return "";
  }

  /** Collect interactive elements from a root, descending into open shadow DOM. */
  function collect(root, out, seen) {
    let matches;
    try {
      matches = root.querySelectorAll(INTERACTIVE_SELECTOR);
    } catch {
      return;
    }
    for (const el of matches) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.tabIndex === -1 && !el.matches("a[href],button,input,select,textarea,summary,[role]")) continue;
      if (el.type === "hidden") continue;
      if (!isVisible(el)) continue;
      out.push(el);
    }
    // Shadow roots are not reachable from the light-DOM querySelectorAll above.
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (el.shadowRoot) collect(el.shadowRoot, out, seen);
    }
  }

  function describe(el, index) {
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const record = {
      i: index,
      tag,
      text: labelFor(el),
      inViewport: rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0,
    };
    const role = el.getAttribute("role");
    if (role) record.role = role;
    if (tag === "input" || tag === "button") {
      const type = el.getAttribute("type");
      if (type) record.type = type.toLowerCase();
    }
    if (tag === "a" && el.href) {
      record.href = el.href;
      if (el.hasAttribute("download")) record.download = true;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      record.editable = true;
      if (el.value) record.value = clean(el.value);
      if (el.disabled) record.disabled = true;
      if (el.type === "checkbox" || el.type === "radio") record.checked = !!el.checked;
    }
    if (el.isContentEditable) record.editable = true;
    return record;
  }

  function pageText(limit) {
    const body = document.body;
    if (!body) return "";
    const text = (body.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return text.length > limit ? text.slice(0, limit) + "\n… [page text truncated]" : text;
  }

  function resolve(index) {
    const el = currentElements[index];
    if (!el) throw new Error(`No element with index ${index} in this frame — take a fresh page snapshot`);
    if (!el.isConnected) throw new Error(`Element ${index} is no longer on the page — take a fresh page snapshot`);
    return el;
  }

  function highlight(el) {
    try {
      const rect = el.getBoundingClientRect();
      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "fixed",
        left: `${rect.left - 2}px`,
        top: `${rect.top - 2}px`,
        width: `${rect.width + 4}px`,
        height: `${rect.height + 4}px`,
        border: "2px solid #d97757",
        borderRadius: "4px",
        boxShadow: "0 0 0 2px rgba(217,119,87,0.25)",
        pointerEvents: "none",
        zIndex: "2147483647",
        transition: "opacity 240ms ease-out",
      });
      document.documentElement.appendChild(box);
      setTimeout(() => {
        box.style.opacity = "0";
      }, 700);
      setTimeout(() => box.remove(), 1000);
    } catch {
      /* highlighting is cosmetic — never let it break an action */
    }
  }

  // ---------------------------------------------------------------- actions

  function realClick(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: 1,
    };
    const pointer = { ...base, pointerId: 1, isPrimary: true, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* not focusable */
    }
    el.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: 1 }));
  }

  /**
   * Set a field's value the way a user would, so frameworks that track input
   * through their own listeners (React, Vue, Angular) actually see the change.
   */
  function setFieldValue(el, text) {
    if (el.isContentEditable) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, text);
      return;
    }
    if (el.tagName.toLowerCase() === "select") {
      const option = Array.from(el.options).find(
        (o) => o.value === text || o.text.trim().toLowerCase() === text.trim().toLowerCase(),
      );
      if (!option) throw new Error(`No option matching "${text}" — options: ${Array.from(el.options).map((o) => o.text.trim()).join(" | ")}`);
      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    el.focus();
    const apply = (value) => (setter ? setter.call(el, value) : (el.value = value));
    apply("");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    apply(text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function sendKey(el, key) {
    const target = el || document.activeElement || document.body;
    const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true };
    if (key === "Enter") Object.assign(init, { keyCode: 13, which: 13 });
    if (key === "Escape") Object.assign(init, { keyCode: 27, which: 27 });
    if (key === "Tab") Object.assign(init, { keyCode: 9, which: 9 });
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keypress", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // -------------------------------------------------------------- dispatch

  const handlers = {
    ping() {
      return { pong: true };
    },

    snapshot({ maxText = 4000 } = {}) {
      const found = [];
      collect(document, found, new Set());
      currentElements = found;
      return {
        url: location.href,
        title: document.title,
        text: pageText(maxText),
        scrollY: Math.round(scrollY),
        scrollHeight: Math.round(document.documentElement.scrollHeight),
        elements: found.map(describe),
      };
    },

    click({ index }) {
      const el = resolve(index);
      highlight(el);
      realClick(el);
      return { clicked: labelFor(el) || el.tagName.toLowerCase() };
    },

    typeText({ index, text, submit }) {
      const el = resolve(index);
      highlight(el);
      el.scrollIntoView({ block: "center" });
      setFieldValue(el, text);
      if (submit) sendKey(el, "Enter");
      return { typedInto: labelFor(el) || el.tagName.toLowerCase(), submitted: !!submit };
    },

    pressKey({ key }) {
      sendKey(null, key);
      return { key };
    },

    scroll({ direction = "down", amount }) {
      const step = amount || Math.round(innerHeight * 0.85);
      if (direction === "top") scrollTo({ top: 0, behavior: "instant" });
      else if (direction === "bottom") scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      else scrollBy({ top: direction === "up" ? -step : step, behavior: "instant" });
      return { scrollY: Math.round(scrollY) };
    },

    scrollToElement({ index }) {
      const el = resolve(index);
      el.scrollIntoView({ block: "center", inline: "center" });
      highlight(el);
      return { scrollY: Math.round(scrollY) };
    },

    hrefOf({ index }) {
      const el = resolve(index);
      const href = el.href || el.getAttribute("href") || el.src || "";
      if (!href) throw new Error(`Element ${index} has no link or file URL to download`);
      return { href, suggestedName: el.getAttribute("download") || "" };
    },
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.__browserAgent !== true) return undefined;
    const handler = handlers[message.action];
    if (!handler) {
      sendResponse({ ok: false, error: `Unknown content action: ${message.action}` });
      return true;
    }
    try {
      sendResponse({ ok: true, data: handler(message.payload || {}) });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return true;
  });
})();
