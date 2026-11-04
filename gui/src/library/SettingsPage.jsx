/**
 * Settings and document details.
 *
 * Extracted verbatim from `main.jsx`, which was one 1,733-line file holding the
 * whole application: shell, library, editor, chat, settings and boot. Nothing
 * about these two surfaces needed to live in the same file as the app's state, and
 * keeping them there meant every change to a settings control was a change to the
 * file that mounts `createRoot`.
 *
 * No behaviour changed in the move. The one thing worth knowing is that
 * `SettingsPage` is a page and `DetailsDialog` is a dialog, and they are here
 * together because they were neighbours, not because they are alike -- see each
 * one's comment for why that difference is deliberate.
 */

import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon.jsx";
import { ModalLayer } from "../ModalLayer.jsx";
import { isLocalEndpoint, listProviderModels, slugify, usageStats } from "../platform/store.js";
import { resolveTheme } from "./themes.js";

// The three appearance choices from the Paper reference. "System" is the OS
// preference; the other two are explicit. Each note is one short line, the way
// the reference writes them.
const COLOR_MODES = [
  { id: "system", label: "System preference", note: "Use your system's settings." },
  { id: "light", label: "Light mode", note: "Light and bright for readability." },
  { id: "dark", label: "Dark mode", note: "Reduced glare and blue light." },
];
import BackgroundPicker from "./BackgroundPicker.jsx";
import ThemePicker from "./ThemePicker.jsx";
import { Button } from './ui/button.jsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.jsx";
import { RadioGroup, RadioGroupItem } from './ui/radio-group.jsx'
import { Switch } from './ui/switch.jsx'

/**
 * The sections, and the only list of them.
 *
 * One array drives the tab bar, the panel ids, each panel's heading and its note,
 * and which component renders its body -- so a section cannot appear in the tab
 * bar without a panel behind it, and cannot appear in neither.
 *
 * It used to hold only `{ id, label }` for a rail of `<a href="#id">` links into
 * one long scroll, and the panels were written out separately below. `styles.css`
 * styled `.settings-nav` as a sticky rail and the sections' `scroll-margin-top`
 * was dead CSS with it. Every claim about a section lived in one of two places and
 * neither could check the other.
 *
 * `Panel` is a component reference rather than an inline render function, so each
 * panel's JSX stays in a function of its own instead of inside a closure in this
 * array. Function declarations hoist, which is what lets the array name them.
 */
const SETTINGS_SECTIONS = [
  {
    id: "settings-assistant",
    label: "Assistant",
    title: "Bring your own provider",
    note: "Use your own key for assistant actions.",
    Panel: AssistantPanel,
  },
  {
    id: "settings-appearance",
    label: "Appearance",
    title: "Appearance",
    note: "Keep the writing surface comfortable while you change the mood of the workspace.",
    Panel: AppearancePanel,
  },
  {
    id: "settings-writing",
    label: "Writing",
    title: "Writing preferences",
    note: "Small defaults that make a long session feel less noisy.",
    Panel: WritingPanel,
  },
];

/**
 * The two library densities, with the copy their cards show.
 *
 * The choice is between `168px` columns with `32px` of gap and `134px` with
 * `24px`, and a reader picking between them is picking a number they cannot see.
 * So each card draws its own grid -- the same sheet tokens the real tiles are
 * made of, at the two real measures -- and the sentence under it says what
 * changes rather than repeating the name.
 */
const DENSITIES = [
  {
    id: "comfortable",
    label: "Comfortable",
    note: "Larger covers with room to breathe.",
  },
  {
    id: "compact",
    label: "Compact",
    note: "More documents on one screen.",
  },
];


/**
 * How long the save toast says so, and how long it then takes to go.
 *
 * `TOAST_FADE` is the `opacity` transition on `.settings-toast`, so the two have
 * to agree: the text is dropped after the fade, not before it, or the pill
 * empties in one frame and the fade has nothing left to fade. It is 180ms because
 * that is the budget `tests/motion.test.mjs` holds every CSS transition in the
 * app to, and a confirmation does not need to be slower than the change it is
 * confirming.
 */
const TOAST_HOLD = 2400;
const TOAST_FADE = 180;


function DetailsDialog({ doc, onClose, onSave }) {
  const [name, setName] = useState(doc.title);
  const [filename, setFilename] = useState(doc.filename);
  const [collections, setCollections] = useState(doc.collections);
  const [autoFilename, setAutoFilename] = useState(
    doc.filename === `${slugify(doc.title)}.md`,
  );
  const [kind, setKind] = useState(doc.kind);
  const [status, setStatus] = useState(doc.status);
  const nameRef = useRef(null);
  // ModalLayer traps focus and owns Escape. This only adds the select-all the
  // rename is inviting, and waits for the trap to have moved focus in first.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      nameRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const submit = (event) => {
    event.preventDefault();
    onSave({
      title: name.trim() || "Untitled document",
      filename: filename.trim() || `${slugify(name)}.md`,
      collections: collections.length ? collections : ["Notes"],
      kind,
      status,
    });
  };
  return (
    <ModalLayer onClose={onClose}>
      <section
        className="dialog details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="details-title"
      >
        <header className="dialog-head">
          <div>
            <div className="eyebrow">Document settings</div>
            <h2 id="details-title">Name and collections</h2>
          </div>
          <button
            className="dialog-close"
            type="button"
            aria-label="Close document details"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <form onSubmit={submit} className="dialog-form">
          <label className="field-label" htmlFor="detail-name">
            Document name
          </label>
          <input
            ref={nameRef}
            id="detail-name"
            value={name}
            onChange={(event) => {
              const value = event.target.value;
              setName(value);
              if (autoFilename) setFilename(`${slugify(value)}.md`);
            }}
          />
          <label className="field-label" htmlFor="detail-filename">
            File name
          </label>
          <input
            id="detail-filename"
            value={filename}
            onChange={(event) => {
              setFilename(event.target.value);
              setAutoFilename(false);
            }}
          />
          <div className="field-group">
            <div className="field-label">Collections</div>
            <div className="collection-options">
              {["Essays", "Chapters", "Notes"].map((collection) => (
                <label key={collection} className="collection-option">
                  <input
                    type="checkbox"
                    checked={collections.includes(collection)}
                    onChange={(event) =>
                      setCollections((current) =>
                        event.target.checked
                          ? [...new Set([...current, collection])]
                          : current.filter((item) => item !== collection),
                      )
                    }
                  />
                  <span>{collection}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="dialog-grid">
            <div>
              <label className="field-label" htmlFor="detail-kind">
                Kind
              </label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger id="detail-kind" className="dialog-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Essay">Essay</SelectItem>
                  <SelectItem value="Chapter">Chapter</SelectItem>
                  <SelectItem value="Notes">Notes</SelectItem>
                  <SelectItem value="Draft">Draft</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="field-label" htmlFor="detail-status">
                Status
              </label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="detail-status" className="dialog-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Drafts">Drafts</SelectItem>
                  <SelectItem value="Revising">Revising</SelectItem>
                  <SelectItem value="Published">Published</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="dialog-note">
            A clear name and collection make documents easier to find later.
          </p>
          <div className="dialog-actions">
            <Button className="soft-button" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button className="soft-button primary" type="submit">
              Save changes
            </Button>
          </div>
        </form>
      </section>
    </ModalLayer>
  );
}

/**
 * Settings, as a page.
 *
 * This used to render through `ModalLayer`, which gave it a scrim, a focus trap
 * and `aria-modal` -- the machinery of a dialog sitting on top of the library.
 * That was wrong twice over. Settings has nine controls and a wallpaper picker;
 * a dialog that size is a full-height scroll region inside a grey border, with
 * the library dimmed behind it and unreachable. Nobody wants to leave the
 * library to change the reading font, and a dialog that fills the window is a
 * page wearing a costume.
 *
 * So it takes the whole window and scrolls on its own. Back and Escape both
 * return to wherever it was opened from, and there is no scrim to click because
 * there is nothing behind it to dismiss.
 */
function SettingsPage({
  settings,
  theme,
  customThemes,
  onCustomThemesChange,
  onApplyTheme,
  sessionApiKey,
  providerReady,
  activeProvider,
  providers,
  onClose,
  onPersist,
  onConnect,
  onDisconnect,
  onSelectProvider,
  onSelectModel,
  localTools,
  onAdoptTool,
  onSaveProvider,
  onCreateProvider,
}) {
  const [draft, setDraft] = useState(settings);
  const [apiKey, setApiKey] = useState(sessionApiKey);
  const [keyVisible, setKeyVisible] = useState(false);
  const [connectionState, setConnectionState] = useState(
    providerReady ? "ready" : "idle",
  );
  // Focus follows the page, not the first field.
  //
  // A dialog autofocusing its first control is a courtesy: the reader asked for
  // a dialog and a dialog is where the keyboard goes. A page is a destination,
  // and focusing a select the moment it opens means the first Tab jumps to
  // *Model* while the reader is still looking at the heading.
  const pageRef = useRef(null);
  // One section at a time, Assistant first because it is the only one with
  // something broken about it worth finding quickly.
  //
  // The panels stay *mounted* and are hidden with `hidden` rather than being
  // unmounted. A theme the reader is halfway through editing lives in
  // Appearance, and unmounting on every tab switch would throw those draft
  // colours away on the way to check a writing preference and back. `hidden` is
  // also what the tabs pattern asks for -- an inactive panel is not displayed --
  // and it takes that panel's controls out of the tab order without any code.
  const [activeTab, setActiveTab] = useState(SETTINGS_SECTIONS[0].id);
  const tabRefs = useRef({});
  // The confirmation that something was written, and the ref that says whether
  // the persist effect below has run yet.
  //
  // Settings save themselves and there is no status line and no Save button --
  // both were removed deliberately, because a permanent line spends the bottom
  // of the page repeating what the reader can already see happened. What was
  // left was a page that changes with no acknowledgement at all. This is the
  // acknowledgement: it appears on a real write and leaves again.
  //
  // `settled` is separate from `savedAt` only so the pill can fade *with its
  // text in it*; see the effect for the rest.
  const [savedAt, setSavedAt] = useState(0);
  const [settled, setSettled] = useState(true);
  const written = useRef(false);

  useEffect(() => {
    const opener = document.activeElement;
    pageRef.current?.focus();
    return () => {
      // Hand the keyboard back to the button that opened Settings, so leaving
      // does not dump the caret at the top of the document.
      if (opener instanceof HTMLElement && document.contains(opener))
        opener.focus();
    };
  }, []);

  // Escape goes back. A dialog gets this from `ModalLayer`'s focus trap; a page
  // has no trap, so it listens for itself -- and stops propagation so the
  // app-level shortcuts behind it stay inert while it is open.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const update = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));

  /**
   * Arrow keys across the tab bar, per the tabs pattern.
   *
   * Left and Right move one tab and wrap, Home and End jump to the ends, and the
   * tab that receives the keypress is the one that gets selected -- automatic
   * activation, because these three panels are cheap and a reader who has
   * arrowed onto "Writing" means Writing. `aria-orientation` is left at its
   * default of `horizontal`, which is what makes Left/Right the right pair.
   *
   * The focus call is not implied by the selection. React re-renders the roving
   * `tabIndex`, but nothing in that moves the caret, so without this the ring
   * would sit on the new tab's label while the document held the old one.
   */
  const onTabKeys = (event) => {
    const last = SETTINGS_SECTIONS.length - 1;
    const from = SETTINGS_SECTIONS.findIndex(
      (section) => section.id === activeTab,
    );
    const target = {
      ArrowRight: from === last ? 0 : from + 1,
      ArrowLeft: from === 0 ? last : from - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const id = SETTINGS_SECTIONS[target].id;
    setActiveTab(id);
    tabRefs.current[id]?.focus();
  };

  const connect = async () => {
    // The endpoint is saved on its own blur -- which fires before this button
    // is even clicked -- so a URL edit never needs a key press to stick.
    if (!apiKey.trim()) {
      setConnectionState("error");
      return;
    }
    // The one deliberate click in this dialog. A key is typed a character at a
    // time, and this is the action that writes it to the OS credential store, so
    // it does not belong on a keystroke -- which is why it is the one thing here
    // that is not auto-saved.
    //
    // The row waits for the write to report back instead of assuming success: a
    // key that failed to store is the one case this row exists to show.
    setConnectionState("idle");
    const ready = await onConnect(draft, apiKey.trim());
    setConnectionState(ready ? "ready" : "error");
  };

  /**
   * Every other setting saves itself.
   *
   * Debounced, because the alternative is a write per keystroke: the wallpaper
   * alone is a 2.5 MB data URL and `set_settings` marshals the whole settings
   * row. 350ms is short enough that the dialog reads as already-saved and long
   * enough that dragging a slider is one write rather than sixty.
   *
   * `apiKey` is not part of `draft`, and `connectionState` is deliberately not in
   * it either -- a half-typed key must not mark the provider ready just because
   * something else moved.
   */
  useEffect(() => {
    // The first run of this effect is the page arriving, not the reader changing
    // something. Persisting then would announce settings that were already
    // stored before the page opened, which is a lie the reader can disprove by
    // watching the toast appear on load.
    if (!written.current) {
      written.current = true;
      return undefined;
    }
    const timer = setTimeout(() => {
      onPersist(draft);
      // Here rather than in `update` because this is where the write is issued.
      // On a keystroke the toast would be reporting a change that was still
      // sitting in a debounce window and might never be written at all.
      //
      // `onPersist` returns nothing -- it hands `store.setSettings` a promise and
      // does not wait on it -- so "the write was issued" is the strongest claim
      // this can honestly make. It is not a success report from the store.
      setSavedAt(Date.now());
    }, 350);
    return () => clearTimeout(timer);
  }, [draft, onPersist]);

  // The pill's own life: shown immediately, faded out at TOAST_HOLD, unmounted
  // once the fade has finished. Two timers rather than one because they are two
  // different jobs -- the class goes off while the text is still in the pill, and
  // the text goes when there is nothing left to fade.
  useEffect(() => {
    if (!savedAt) return undefined;
    setSettled(false);
    const fade = setTimeout(() => setSettled(true), TOAST_HOLD);
    const drop = setTimeout(() => setSavedAt(0), TOAST_HOLD + TOAST_FADE);
    return () => {
      clearTimeout(fade);
      clearTimeout(drop);
    };
  }, [savedAt]);

  // The sidebar's Settings button and Escape land here. There is nothing to
  // undo: the settings were saved when they changed, so leaving is just leaving.
  // No back chevron, because the library is still on screen beside this page and
  // a "go back" affordance would imply an arrival this route no longer has.
  return (
    <div className="settings-layer">
      <section
        className="settings-page"
        ref={pageRef}
        tabIndex={-1}
        aria-labelledby="settings-title"
      >
        <header className="settings-page-head">
          <div className="settings-page-title">
            <h1 id="settings-title">Settings</h1>
          </div>
        </header>
        <div className="settings-tabbar">
          {/* The whole tab bar, derived from the one list. `aria-controls` points
              at the panel id, the panel points back with `aria-labelledby`, and
              only the selected tab is `tabIndex={0}` -- the roving tabindex is
              what makes Tab enter the strip once and then Arrow move within it,
              rather than three separate stops before the panels. */}
          <div
            className="settings-tabs"
            role="tablist"
            aria-label="Settings sections"
            onKeyDown={onTabKeys}
          >
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section.id}
                ref={(node) => {
                  tabRefs.current[section.id] = node;
                }}
                id={`${section.id}-tab`}
                type="button"
                role="tab"
                className={`settings-tab ${
                  section.id === activeTab ? "active" : ""
                }`}
                aria-selected={section.id === activeTab}
                aria-controls={section.id}
                tabIndex={section.id === activeTab ? 0 : -1}
                onClick={() => setActiveTab(section.id)}
              >
                {section.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-form">
          {/* One object, spread into whichever panel is showing. Each panel takes
              the state it uses and ignores the rest, which reads better here than
              three hand-written prop lists that have to be kept in step with the
              state above. */}
          {(() => {
            const panelProps = {
              draft,
              update,
              // The panels are module-scope components, so they cannot reach
              // `setDraft` -- only what this object hands them. `BackgroundPicker`
              // changes several settings in one patch rather than one key, so it
              // needs the whole-object merge `update` cannot express.
              applyPatch: (changes) =>
                setDraft((current) => ({ ...current, ...changes })),
              theme,
              customThemes,
              onApplyTheme,
              onCustomThemesChange,
              apiKey,
              setApiKey,
              keyVisible,
              setKeyVisible,
              connectionState,
              setConnectionState,
              connect,
              activeProvider,
              providers,
              onSelectProvider,
              onDisconnect,
              onSelectModel,
              localTools,
              onAdoptTool,
              onSaveProvider,
              onCreateProvider,
            };
            return SETTINGS_SECTIONS.map((section) => {
              const Panel = section.Panel;
              return (
                <section
                  key={section.id}
                  id={section.id}
                  className="settings-section"
                  role="tabpanel"
                  aria-labelledby={`${section.id}-tab`}
                  hidden={section.id !== activeTab}
                >
                  <div className="settings-section-head">
                    <h3>{section.title}</h3>
                    <p>{section.note}</p>
                  </div>
                  <Panel {...panelProps} />
                </section>
              );
            });
          })()}
        </div>
        {/* Always mounted, and empty until a write happens.
            A live region has to be in the document *before* its content changes
            to be announced at all; one that mounts together with its own text
            is silent on several screen readers. It carries no text, no tab stop
            and no focus -- it reports, it is not a control -- so it can never
            take the caret away from a control the reader is still on.
            `role="status"` already implies `polite`; it is spelled out because
            the requirement is that this be announced and not interrupt. */}
        <p
          className={`settings-toast${savedAt && !settled ? " on" : ""}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {savedAt > 0 && (
            <>
              <Icon name="check" size={13} />
              Saved
            </>
          )}
        </p>
      </section>
    </div>
  );
}

/**
 * Assistant: the provider, the model it will ask for, and the key.
 *
 * Rows rather than the two-column `dialog-grid` this used, which put a label
 * above its field and read as a form to fill in. The reference layout is name
 * and explanation on the left, control on the right, and it is the right one
 * here for a reason beyond looking like the reference: these four are one
 * thought -- which provider, asked for what, authenticated how -- and stacked
 * cells break them into four unrelated questions.
 */
/**
 * BYOK shortcuts. Each materialises a *real* registry row (endpoint, vendor,
 * default model) when chosen -- the key typed next then files under the row a
 * run will actually use, which is what the old name-only slots never did.
 */
const PROVIDER_PRESETS = [
  { key: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { key: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  { key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { key: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest" },
];

// Provider list price, USD per million tokens (input / output). The on_demand
// tier this app's Groq account runs on bills $0 -- the figure is what the
// model costs off the free tier, so a reader can compare before leaving it.
// A model without an entry shows an em dash rather than a guessed number.
const MODEL_PRICING = {
  "openai/gpt-oss-120b": "$0.15 / $0.60",
  "openai/gpt-oss-20b": "$0.10 / $0.50",
};
const modelPrice = (model) => MODEL_PRICING[model] ?? "—";

function AssistantPanel({
  draft,
  update,
  apiKey,
  setApiKey,
  keyVisible,
  setKeyVisible,
  connectionState,
  setConnectionState,
  connect,
  activeProvider,
  providers,
  onSelectProvider,
  onDisconnect,
  onSelectModel,
  localTools = [],
  onAdoptTool,
  onSaveProvider,
  onCreateProvider,
}) {
  const [liveModels, setLiveModels] = useState([]);
  const [modelsState, setModelsState] = useState("idle");
  const [modelsError, setModelsError] = useState("");
  const [modelsRevision, setModelsRevision] = useState(0);
  const providerId = activeProvider?.id;

  const [endpointDraft, setEndpointDraft] = useState(activeProvider?.baseUrl ?? "");
  useEffect(() => {
    setEndpointDraft(activeProvider?.baseUrl ?? "");
  }, [activeProvider?.baseUrl]);

  const saveEndpoint = async () => {
    const next = endpointDraft.trim();
    if (!activeProvider || !next || next === activeProvider.baseUrl) return;
    const updated = await onSaveProvider?.({ baseUrl: next });
    if (updated) setEndpointDraft(updated.baseUrl ?? next);
  };

  const [usage, setUsage] = useState(null);
  useEffect(() => {
    let cancelled = false;
    usageStats()
      .then((data) => {
        if (!cancelled && data && typeof data === "object") setUsage(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const usageRows =
    usage && usage.models
      ? Object.entries(usage.models).sort((a, b) => Number(b[1]) - Number(a[1]))
      : [];

  useEffect(() => {
    if (!providerId) {
      setLiveModels([]);
      setModelsState("idle");
      setModelsError("");
      return undefined;
    }
    let cancelled = false;
    setLiveModels([]);
    setModelsState("loading");
    setModelsError("");
    listProviderModels(providerId)
      .then((models) => {
        if (cancelled) return;
        setLiveModels(Array.isArray(models) ? models : []);
        setModelsState("idle");
      })
      .catch((error) => {
        if (cancelled) return;
        setLiveModels([]);
        setModelsState("error");
        setModelsError(error?.message || "Could not read the model list.");
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, modelsRevision]);

  const NON_CHAT_MODEL = /whisper|orpheus|prompt-guard/i
  const modelOptions = Array.from(
    new Set(
      [
        activeProvider?.defaultModel,
        ...(liveModels.length ? liveModels : activeProvider?.models || []),
      ].filter((option) => option && (option === activeProvider?.defaultModel || !NON_CHAT_MODEL.test(option))),
    ),
  );
  const local = isLocalEndpoint(activeProvider?.baseUrl);

  const providerMonogram = (provider) => {
    const label = provider?.label || provider?.id || "P";
    return label.slice(0, 1).toUpperCase();
  };

  return (
    <>
      <div className="settings-banner assistant-keys-banner" role="note">
        <span className="settings-banner-mark assistant-keys-mark" aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
        <div>
          <strong>Your keys are encrypted at rest.</strong>
          <div className="settings-banner-sub">Stored in your operating system's credential store and never shown in logs.</div>
        </div>
      </div>

      <div className="assistant-keys-header">
        <div>
          <h2 className="assistant-keys-title">API keys</h2>
          <p className="assistant-keys-sub">Bring your own keys and keep them in one place.</p>
        </div>
        <span className={`assistant-keys-status ${connectionState === "ready" ? "is-connected" : ""}`}>
          {connectionState === "ready" ? "Key ready" : connectionState === "error" ? "Add a key" : "Not connected"}
        </span>
      </div>

      <div className="assistant-keys-grid">
        <article className="assistant-key-card">
          <div className="assistant-key-card-head">
            <div className="assistant-key-avatar" aria-hidden="true">{providerMonogram(activeProvider)}</div>
            <div className="assistant-key-meta">
              <div className="assistant-key-name">{activeProvider?.label || activeProvider?.id || "Provider"}</div>
              <div className="assistant-key-sub">{activeProvider?.baseUrl || "No endpoint configured"}</div>
            </div>
          </div>
          <div className="assistant-key-tags">
            <span className={`assistant-key-pill ${connectionState === "ready" ? "is-active" : ""}`}>
              {connectionState === "ready" ? "Active" : "Inactive"}
            </span>
          </div>
          <div className="assistant-key-secret">
            <span className="assistant-key-secret-text">{apiKey && connectionState === "ready" ? "••••••••••••••" : apiKey ? "••••••••••••••" : "sk-••••••••••••"}</span>
            <button type="button" className="assistant-key-iconbtn" aria-label="Copy key">
              <Icon name="copy" size={18} />
            </button>
          </div>
          <div className="assistant-key-actions">
            <Button className="assistant-key-btn" type="button" onClick={connect} disabled={!activeProvider}>
              Connect provider
            </Button>
            <Button
              className="soft-button"
              type="button"
              onClick={onDisconnect}
              disabled={!activeProvider || connectionState !== "ready"}
            >
              Remove key
            </Button>
            <Button
              className="assistant-key-iconbtn assistant-key-remove"
              type="button"
              onClick={onDisconnect}
              disabled={!activeProvider || connectionState !== "ready"}
              aria-label="Remove key"
            >
              <Icon name="trash" size={18} />
            </Button>
          </div>
        </article>

        <article className="assistant-key-card assistant-key-card-form">
          <div className="assistant-key-card-head">
            <div>
              <div className="assistant-key-card-title">Add or update key</div>
              <div className="assistant-key-card-sub">Configure provider, model, endpoint and key.</div>
            </div>
          </div>
          <div className="assistant-key-field">
            <label className="assistant-key-label" htmlFor="provider">Provider</label>
            <Select
              value={activeProvider?.id ?? ""}
              onValueChange={async (value) => {
                if (value.startsWith("preset:")) {
                  const preset = PROVIDER_PRESETS.find((p) => p.key === value.slice(7));
                  if (!preset) return;
                  const sameEndpoint = (p) =>
                    String(p.baseUrl || "").replace(/\/+$/, "") === preset.baseUrl.replace(/\/+$/, "");
                  const existing = providers.find(sameEndpoint);
                  const row =
                    existing ??
                    (await onCreateProvider?.({
                      id: slugify(preset.label),
                      label: preset.label,
                      vendor: "compatible",
                      protocol: "openai_chat",
                      baseUrl: preset.baseUrl,
                      defaultModel: preset.model,
                      models: [],
                    }));
                  if (!row) return;
                  update("provider", row.id);
                  setEndpointDraft(preset.baseUrl);
                  setApiKey("");
                  setConnectionState("idle");
                  const ready = await onSelectProvider(row.id);
                  setConnectionState(ready ? "ready" : "idle");
                  return;
                }
                update("provider", value);
                setApiKey("");
                setConnectionState("idle");
                const ready = await onSelectProvider(value);
                setConnectionState(ready ? "ready" : "idle");
              }}
            >
              <SelectTrigger id="provider" className="assistant-key-select">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label || provider.id}
                  </SelectItem>
                ))}
                {PROVIDER_PRESETS.map((preset) => (
                  <SelectItem key={preset.key} value={`preset:${preset.key}`}>
                    {preset.label}…
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="assistant-key-field">
            <label className="assistant-key-label" htmlFor="model">Model</label>
            <Select
              value={activeProvider?.defaultModel ?? ""}
              disabled={!providerId || !modelOptions.length}
              onValueChange={(value) => onSelectModel?.(value)}
            >
              <SelectTrigger id="model" className="assistant-key-select">
                <SelectValue placeholder={modelsState === "loading" ? "Reading…" : "Select model"} />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modelsState === "error" && (
              <button className="assistant-key-link" type="button" onClick={() => setModelsRevision((value) => value + 1)}>
                Retry
              </button>
            )}
          </div>
          <div className="assistant-key-field">
            <label className="assistant-key-label" htmlFor="endpoint">Endpoint</label>
            <input
              id="endpoint"
              className="assistant-key-input"
              type="url"
              value={endpointDraft}
              placeholder="https://api.example.com/v1"
              onChange={(event) => setEndpointDraft(event.target.value)}
              onBlur={saveEndpoint}
            />
          </div>
          <div className="assistant-key-field">
            <label className="assistant-key-label" htmlFor="api-key">API key</label>
            <div className="assistant-key-secret-row">
              <input
                id="api-key"
                className="assistant-key-input assistant-key-input-secret"
                type={keyVisible ? "text" : "password"}
                placeholder="Paste a key"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setConnectionState("idle");
                }}
              />
              <button type="button" className="assistant-key-iconbtn" onClick={() => setKeyVisible((value) => !value)} aria-label={keyVisible ? "Hide key" : "Show key"}>
                <Icon name={keyVisible ? "eye-off" : "eye"} size={18} />
              </button>
            </div>
          </div>
          <p className="assistant-key-note">The key is written to your operating system's credential store and used for requests to the provider above.</p>
        </article>
      </div>
      {/* Usage, in the shape of the reference table: the model, a segmented
          spend bar against the daily cap, the raw numbers, and the provider's
          list price. The bar is the number a reader can act on; the rest is
          context for it. Price is the list rate per million (input/output) --
          the on_demand tier bills $0. */}
      <div className="settings-row">
        <div className="settings-row-copy">
          <span className="settings-row-label">Usage</span>
          <small>
            {usage
              ? `Tokens used today (${usage.date}), per model, against ${Number(usage.limit).toLocaleString()}.`
              : "Tokens used today against the daily limit."}
          </small>
        </div>
        <div className="settings-row-control">
          <span className={`settings-status${usageRows.length ? " connected" : ""}`}>
            {usageRows.length ? "Today" : "None yet"}
          </span>
        </div>
      </div>
      {usageRows.length > 0 && (
        <div className="usage-table" aria-label="Token usage today">
          {usageRows.map(([model, tokens]) => {
            const used = Number(tokens) || 0;
            const limit = Math.max(1, Number(usage?.limit) || 1);
            const pct = Math.min(100, Math.round((used / limit) * 100));
            return (
              <div className="usage-row" key={model}>
                <span className="usage-model" title={model}>{model}</span>
                <span className="usage-bar" aria-hidden="true">
                  <i data-level={pct > 75 ? "high" : "low"} style={{ width: `${Math.max(pct, 2)}%` }} />
                </span>
                <span className="usage-tokens">
                  {used.toLocaleString()} <em>/ {limit.toLocaleString()}</em>
                </span>
                <span className="usage-price">{modelPrice(model)}</span>
              </div>
            );
          })}
        </div>
      )}
      {/* Detection is a choice, not a fixture: off stops the probe entirely
          (the same setting gates the scan in the shell) and hides the rows
          below, so a reader who never wants local agents pays for none of it. */}
      <div className="settings-row">
        <div className="settings-row-copy">
          <span className="settings-row-label">Local tools</span>
          <small>Scan this machine for CLIs and local servers (Ollama, opencode, Codex, …).</small>
        </div>
        <div className="settings-row-control">
          <Switch
            checked={draft.localTools !== false}
            onCheckedChange={(value) => update("localTools", value)}
          />
        </div>
      </div>
      {draft.localTools !== false && (<>
      {/*
        What is already installed, reported rather than offered as a menu of
        things to install.

        Both kinds are adoptable now, through different transports. A server
        (Ollama, LM Studio) has an endpoint, so adopting it gives the picker
        its model list. A CLI like `codex` or `opencode` has no endpoint but
        has an `exec` -- its one-shot invocation -- and the sidecar's `cli`
        protocol runs a turn through it directly, so adopting it creates a
        provider that answers from the CLI's own login and needs no key.
      */}
      <div className="settings-row">
        <div className="settings-row-copy">
          <span className="settings-row-label">On this machine</span>
          <small>
            {local.length
              ? "Found in your PATH and on the usual local ports."
              : "A local model server needs no key, so it can answer with nothing else set up."}
          </small>
        </div>
        <div className="settings-row-control">
          <span className="settings-status">
            {localTools.length
              ? `${localTools.length} found`
              : "None found"}
          </span>
        </div>
      </div>
      {localTools.map((tool) => {
        // A CLI provider carries no baseUrl; it is routable through `exec`.
        const adopted =
          activeProvider?.id === tool.id && !!(tool.baseUrl || tool.exec);
        const routable = !!(tool.models.length || tool.exec);
        return (
          <div className="settings-row" key={tool.id}>
            <div className="settings-row-copy">
              <span className="settings-row-label">{tool.label}</span>
              <small>
                {[
                  tool.models.length
                    ? `${tool.models.length} ${tool.models.length === 1 ? "model" : "models"}`
                    : tool.exec
                      ? "Answers turns through the CLI itself — no key needed"
                      : "CLI only — nothing to route a turn to",
                  tool.version && `v${tool.version}`,
                  tool.command || (tool.models.length ? "running" : ""),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </div>
            <div className="settings-row-control">
              {routable ? (
                <Button
                  className="soft-button"
                  type="button"
                  disabled={adopted}
                  onClick={() => onAdoptTool?.(tool)}
                >
                  {adopted ? "In use" : "Use"}
                </Button>
              ) : (
                <span className="settings-status">Not routable</span>
              )}
            </div>
          </div>
        );
      })}
      </>)}
    </>
  );
}

/**
 * Appearance: theme, then the reading font, then the density cards.
 *
 * The theme and the density are cards and the font is a row, which is not a
 * compromise between two layouts. A card needs to be looked at -- a swatch, a
 * drawn grid -- and it needs the width to be looked at; a row needs to be
 * scanned, and it reads without a heading per control. So each control gets the
 * shape its content argues for.
 *
 * There was a fourth control here, a Graphics row reporting whether the
 * assistant's canvas effects could run. It was never a setting: nothing wrote
 * to it, and the only honest answer it could give was the same one on every
 * machine. A capability the reader cannot change belongs on the surface that
 * needs it, or nowhere -- and the chat send button already falls back to its
 * plain self without being told.
 */
function AppearancePanel({
  draft,
  update,
  applyPatch,
  theme,
  customThemes,
  onApplyTheme,
  onCustomThemesChange,
}) {
  // `null` means the mode follows the theme, so the card for the theme's own
  // mode is the one that reads as selected.
  const pickedMode = draft.colorMode ?? theme.mode;
  const chooseMode = (id) => {
    update("colorMode", id);
    if (id === "system") {
      onApplyTheme({ colorMode: id });
      return;
    }
    const wantDark = id === "dark";
    if ((theme.mode === "dark") !== wantDark) {
      const target = wantDark ? "night" : "light";
      update("theme", target);
      onApplyTheme({ colorMode: id, theme: target });
      return;
    }
    onApplyTheme({ colorMode: id });
  };

  return (
    <>
      <div className="settings-block">
        <span className="field-label" id="mode-label">
          Appearance
        </span>
        <div className="mode-cards" role="radiogroup" aria-labelledby="mode-label">
          {COLOR_MODES.map((choice) => {
            const selected =
              choice.id === "system"
                ? draft.colorMode === "system"
                : draft.colorMode !== "system" && pickedMode === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`mode-card${selected ? " is-selected" : ""}${choice.id === "dark" ? " is-dark" : ""}`}
                onClick={() => chooseMode(choice.id)}
              >
                <span className="mode-card-text">
                  <span className="mode-card-name">{choice.label}</span>
                  <span className="mode-card-note">{choice.note}</span>
                </span>
                <span className="mode-card-state">
                  {selected && <Icon name="check" size={12} />}
                  {selected ? "Selected" : "Select"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {/* Full width and first: it is the one control here that cannot be judged
          from a list of words. */}
      <div className="settings-block">
        {/* `aria-labelledby` rather than `htmlFor`, and that is not a downgrade:
            a `<label for>` may only point at a labelable element, and the control
            here is a `role="radiogroup"` div. The association still exists, it is
            just spelled the way a group has to be named. */}
        <span className="field-label" id="theme-label">
          Theme
        </span>
        <ThemePicker
          theme={theme}
          customThemes={customThemes}
          onApply={(id) => {
            // Picking a theme is an explicit choice of its mode too, so the
            // mode cards and the theme never disagree about what is showing.
            const mode = resolveTheme(id, customThemes).mode;
            update("theme", id);
            update("colorMode", mode);
            onApplyTheme({ theme: id, colorMode: mode });
          }}
          onCustomThemesChange={onCustomThemesChange}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-copy">
          <label className="settings-row-label" htmlFor="font">
            Reading font
          </label>
          <small>Set in the editor and the library alike.</small>
        </div>
        <div className="settings-row-control">
          <Select
            value={draft.font}
            onValueChange={(value) => update("font", value)}
          >
            <SelectTrigger id="font" className="dialog-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Funnel Display">Funnel Display</SelectItem>
              <SelectItem value="Inter">Inter</SelectItem>
              <SelectItem value="Georgia">Georgia</SelectItem>
              <SelectItem value="DM Mono">DM Mono</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="settings-block">
        <span className="field-label" id="density-label">
          Library density
        </span>
        {/* Radix's own group, so the two cards are announced as one control with a
            value rather than as two buttons -- the same reason the theme cards
            below are a group and not a list. */}
        <RadioGroup
          id="density"
          className="choice-cards density-cards"
          aria-labelledby="density-label"
          value={draft.density}
          onValueChange={(value) => update("density", value)}
        >
          {DENSITIES.map((density) => (
            <RadioGroupItem
              key={density.id}
              value={density.id}
              indicator={false}
              className="choice-card"
            >
              <DensityThumb density={density.id} />
              <span className="choice-card-name">{density.label}</span>
              <span className="choice-card-note">{density.note}</span>
              <ChoiceBadge />
            </RadioGroupItem>
          ))}
        </RadioGroup>
      </div>
      <BackgroundPicker
        settings={draft}
        onChange={applyPatch}
        onPreview={onApplyTheme}
        themeTokens={theme.tokens}
        themeMode={theme.mode}
      />
    </>
  );
}

/**
 * One density, drawn rather than named.
 *
 * Two rows of tiles at the two measures the library grid actually uses. The
 * `comfortable` row is taller with wider gutters and fewer tiles per row; the
 * `compact` row is shorter, tighter and fits one more. The tiles are the same
 * `--sheet-*` tokens the real grid is made of, so the picture cannot drift away
 * from the thing it is depicting.
 */
function DensityThumb({ density }) {
  const perRow = density === "comfortable" ? 3 : 4;
  return (
    <span className={`density-thumb ${density}`} aria-hidden="true">
      {[0, 1].map((row) => (
        <span className="density-thumb-row" key={row}>
          {Array.from({ length: perRow }, (_, tile) => (
            <span className="density-thumb-tile" key={tile} />
          ))}
        </span>
      ))}
    </span>
  );
}

/**
 * The corner badge, shown only on the selected card.
 *
 * Hidden in CSS against Radix's `data-state` rather than computed here: the group
 * already owns that state, and a second copy of it in React is a second thing to
 * keep in step. `aria-hidden` because the card is a radio and already announces
 * itself as checked -- a badge is the sighted reader's half of that.
 */
function ChoiceBadge() {
  return (
    <span className="choice-card-badge" aria-hidden="true">
      <Icon name="check" size={12} />
    </span>
  );
}

function WritingPanel({ draft, update }) {
  return (
    <>
      <ToggleRow
        id="autosave"
        label="Autosave edits"
        description="Save document changes automatically after you stop typing."
        checked={draft.autosave}
        onChange={(value) => update("autosave", value)}
      />
      <ToggleRow
        id="spellcheck"
        label="Spellcheck"
        description="Use the browser spellchecker in the editor."
        checked={draft.spellcheck}
        onChange={(value) => update("spellcheck", value)}
      />
      <ToggleRow
        id="word-count"
        label="Show word count"
        description="Keep document counts visible in the editor status bar."
        checked={draft.wordCount}
        onChange={(value) => update("wordCount", value)}
      />
      <ToggleRow
        id="reduce-motion"
        label="Reduce motion"
        description="Use quieter transitions throughout the workspace. The Conclave assistant keeps animating."
        checked={draft.reduceMotion}
        onChange={(value) => update("reduceMotion", value)}
      />
    </>
  );
}

/**
 * One writing preference: name and explanation on the left, the control on the
 * right.
 *
 * The control is the app's own `Switch` rather than a bare checkbox, which is the
 * same choice the reference makes and the reason it is a `<button
 * role="switch">`: a checkbox that says "on" or "off" as a small box in the
 * corner of a settings page is the weakest control in the app for a setting a
 * reader is most likely to flip and least likely to notice they did. Radix's
 * switch is still a labelable button, so the `<label htmlFor>` above keeps
 * binding to it and clicking the name still works.
 */
function ToggleRow({ id, label, description, checked, onChange }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <label className="settings-row-label" htmlFor={id}>
          {label}
        </label>
        <small>{description}</small>
      </div>
      <div className="settings-row-control">
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </div>
    </div>
  );
}

export { DetailsDialog, SettingsPage };
