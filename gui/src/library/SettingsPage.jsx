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
import { getProviderSecretStatus, isLocalEndpoint, listProviderModels, slugify, usageStats, systemStatus, pipelineStatus, pipelineStart } from "../platform/store.js";
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
import { UsagePanel } from "./UsagePanel.jsx";
import { UsageChart } from "./UsageChart.jsx";
import { CopyButton } from "./interior/CopyButton.jsx";
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
import { profileWritingStyle, checkUpdates, openExternal, updateAvailable, installUpdate, restartApp } from '../platform/store.js'
import { notify } from './toast.js'

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
    id: "settings-connectors",
    label: "Connectors",
    title: "Connectors",
    note: "Connect services that provide models, data or an account.",
    Panel: ConnectorsPanel,
  },
  {
    id: "settings-usage",
    label: "Usage",
    title: "Token usage",
    note: "What today's writing has asked the model to do, and what it cost.",
    Panel: UsagePanel,
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
  {
    id: "settings-system",
    label: "System",
    title: "This machine",
    note: "The services Quill needs here, and what to do when one is not answering.",
    Panel: SystemPanel,
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


function DetailsDialog({ doc, labels = [], onClose, onSave }) {
  const [name, setName] = useState(doc.title);
  const [filename, setFilename] = useState(doc.filename);
  const [collections, setCollections] = useState(doc.collections);
  const [newLabel, setNewLabel] = useState("");
  const [autoFilename, setAutoFilename] = useState(
    doc.filename === `${slugify(doc.title)}.md`,
  );
  const [kind, setKind] = useState(doc.kind);
  const [status, setStatus] = useState(doc.status);
  const labelChoices = [...new Set(["Essays", "Chapters", "Notes", ...labels, ...collections])].sort((a, b) => a.localeCompare(b));
  const addLabel = () => {
    const value = newLabel.trim();
    if (!value) return;
    setCollections((current) => [...new Set([...current, value])]);
    setNewLabel("");
  };
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
            <h2 id="details-title">Name and labels</h2>
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
            <div className="field-label">Labels</div>
            <div className="collection-options">
              {labelChoices.map((collection) => (
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
            <div className="label-add">
              <input
                aria-label="New label"
                placeholder="New label"
                value={newLabel}
                onChange={(event) => setNewLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addLabel();
                  }
                }}
              />
              <button className="soft-button" type="button" onClick={addLabel}>Add</button>
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
            A clear name and labels make documents easier to find later.
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
const AVAILABLE_CONNECTORS = [
  {
    id: "drive",
    name: "Google Drive",
    icon: "google-drive",
    description: "Import and export documents without leaving the desk.",
    setup: "https://drive.google.com",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    icon: "dropbox",
    description: "Back up the library and restore older versions.",
    setup: "https://www.dropbox.com/home",
  },
  {
    id: "zotero",
    name: "Zotero",
    mark: "Z",
    color: "#cc2936",
    description: "Pull references and citations straight into the bibliography.",
    setup: "https://www.zotero.org/settings/keys",
  },
  {
    id: "orcid",
    name: "ORCID",
    mark: "iD",
    color: "#6f8f1f",
    description: "Link your author identity and publication record.",
    setup: "https://orcid.org/",
  },
]

function ConnectorsPanel({
  providers = [],
  onConnectOpenRouter,
  onDisconnectOpenRouter,
  onCreateProvider,
  onSelectProvider,
  onOpenAssistant,
}) {
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [lastChecked, setLastChecked] = useState("");
  const [puterConnected, setPuterConnected] = useState(false);
  const openrouter = providers.find((provider) => /openrouter\.ai/i.test(provider.baseUrl || ""));
  const puter = providers.find((provider) => /api\.puter\.com\/puterai\/openai\/v1/i.test(provider.baseUrl || ""));

  useEffect(() => {
    let cancelled = false;
    if (!puter) {
      setPuterConnected(false);
      return undefined;
    }
    getProviderSecretStatus(puter.id)
      .then((status) => {
        if (!cancelled) setPuterConnected(Boolean(status.hasCredential));
      })
      .catch(() => {
        if (!cancelled) setPuterConnected(false);
      });
    return () => { cancelled = true; };
  }, [puter?.id, state]);

  const setupPuter = async () => {
    setError("");
    if (puter) {
      await onSelectProvider?.(puter.id);
      onOpenAssistant?.();
      return;
    }
    const row = await onCreateProvider?.({
      id: "puter",
      label: "Puter",
      vendor: "compatible",
      protocol: "openai_chat",
      baseUrl: PUTER_BASE_URL,
      defaultModel: PUTER_DEFAULT_MODEL,
      models: PUTER_MODELS,
    });
    if (!row) return;
    await onSelectProvider?.(row.id);
    onOpenAssistant?.();
  };

  useEffect(() => {
    let cancelled = false;
    if (!openrouter) {
      setConnected(false);
      return undefined;
    }
    getProviderSecretStatus(openrouter.id)
      .then((status) => {
        if (!cancelled) setConnected(Boolean(status.hasCredential));
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => { cancelled = true; };
  }, [openrouter?.id, state]);

  const connect = async () => {
    setState("waiting");
    setError("");
    setTestResult("");
    try {
      await onConnectOpenRouter?.();
      setConnected(true);
      setLastChecked("just now");
      setState("ready");
    } catch (failure) {
      setError(failure?.message || "OpenRouter sign-in failed.");
      setState("error");
    }
  };

  const disconnect = async () => {
    if (typeof window !== "undefined" && typeof window.confirm === "function"
      && !window.confirm("Disconnect OpenRouter? The key will be removed from this machine.")) {
      return;
    }
    setState("waiting");
    setError("");
    setTestResult("");
    try {
      await onDisconnectOpenRouter?.();
      setConnected(false);
      setState("idle");
    } catch (failure) {
      setError(failure?.message || "Could not disconnect OpenRouter.");
      setState("error");
    }
  };

  const test = async () => {
    if (!openrouter) return;
    setTesting(true);
    setTestResult("");
    try {
      const status = await getProviderSecretStatus(openrouter.id);
      if (!status.hasCredential) {
        setConnected(false);
        setTestResult("No key is stored. Connect OpenRouter again.");
        return;
      }
      const models = await listProviderModels(openrouter.id);
      setConnected(true);
      setLastChecked("just now");
      setTestResult(`Connection OK · ${Array.isArray(models) ? models.length : 0} models available`);
    } catch (failure) {
      setTestResult(failure?.message || "The connection test failed.");
    } finally {
      setTesting(false);
    }
  };

  const manage = () => openExternal("https://openrouter.ai/keys");
  const summaryConnected = (connected ? 1 : 0) + (puterConnected ? 1 : 0);

  return (
    <>
      <div className="connector-summary">
        <div className="connector-summary-copy">
          <strong>{summaryConnected} connected</strong>
          <span>· {AVAILABLE_CONNECTORS.length} available</span>
        </div>
        <div className="connector-meter" aria-hidden="true">
          <i className="is-connected" data-on={summaryConnected ? "" : undefined} />
          <i className="is-idle" data-on={summaryConnected ? undefined : ""} />
        </div>
      </div>

      <div className="connectors-grid">
        <article className={`keys-card connector-card${connected ? " is-connected" : ""}`}>
          <div className="connector-head">
            <div className="connector-mark connector-mark--logo" aria-hidden="true"><Icon name="openrouter-icon" size={26} /></div>
            <div className="connector-copy">
              <div className="connector-title-row">
                <strong>OpenRouter</strong>
                <button className="connector-link" type="button" onClick={manage}>
                  Account settings <span aria-hidden="true">↗</span>
                </button>
              </div>
              <p>Use your own OpenRouter account and pay for your own model usage. No client registration and no Quill backend.</p>
            </div>
            <span className={`connector-pill ${connected ? "is-connected" : "is-idle"}`}>
              {connected ? "Connected" : "Not connected"}
            </span>
          </div>
          <div className="connector-meta">
            <span>{connected ? `Last checked: ${lastChecked || "just now"}` : "Connect to write with your own models"}</span>
            <span>Key stored in the system credential vault</span>
          </div>
          {!connected && (
            <p className="connector-note">
              OpenRouter issues keys only to a signed-in account. New here?{' '}
              <button className="link-button" type="button" onClick={() => openExternal("https://openrouter.ai/sign-up")}>
                Create an OpenRouter account
              </button>
              {' '}first, then connect.
            </p>
          )}
          <div className="connector-footer">
            <label className="connector-toggle" title={connected ? "Disconnect OpenRouter" : "Connect OpenRouter"}>
              <input
                type="checkbox"
                checked={connected}
                disabled={state === "waiting"}
                onChange={() => { if (connected) disconnect(); else connect(); }}
              />
              <span className="connector-switch" aria-hidden="true" />
              <span className="connector-toggle-label">{connected ? "Enabled" : "Disabled"}</span>
            </label>
            <div className="connector-actions">
              <button className="connector-action" type="button" onClick={manage}>
                <Icon name="settings" size={13} /> Manage access
              </button>
              <button className="connector-action" type="button" onClick={test} disabled={!connected || testing || state === "waiting"}>
                <Icon name="check" size={13} /> {testing ? "Testing…" : "Test connection"}
              </button>
            </div>
          </div>
          {!connected && (
            <button className="connector-cta" type="button" onClick={connect} disabled={state === "waiting"}>
              <Icon name="sparkle" size={14} />
              {state === "waiting" ? "Waiting for your browser…" : "Connect with OpenRouter"}
            </button>
          )}
          {error && <p className="settings-profile-error" role="alert">{error}</p>}
          {testResult && <p className={`connector-result${/OK/.test(testResult) ? " is-ok" : ""}`} role="status">{testResult}</p>}
        </article>

        <article className={`keys-card connector-card${puterConnected ? " is-connected" : ""}`}>
          <div className="connector-head">
            <div className="connector-mark" style={{ background: "#6d5dfc" }} aria-hidden="true">P</div>
            <div className="connector-copy">
              <div className="connector-title-row">
                <strong>Puter</strong>
                <button className="connector-link" type="button" onClick={() => openExternal("https://docs.puter.com/user-pays-model/")}>
                  User-pays model <span aria-hidden="true">↗</span>
                </button>
              </div>
              <p>Use 500+ models through your own Puter account. Your account covers the usage; Quill never holds a developer key.</p>
            </div>
            <span className={`connector-pill ${puterConnected ? "is-connected" : "is-idle"}`}>
              {puterConnected ? "Connected" : "Not connected"}
            </span>
          </div>
          <div className="connector-meta">
            <span>{puterConnected ? "Token stored in the system credential vault" : "Create a Puter auth token, then paste it in Assistant"}</span>
            <span>No developer key</span>
          </div>
          {!puterConnected && (
            <p className="connector-note">
              Puter's user-pays model means each reader pays for their own model usage.{' '}
              <button className="link-button" type="button" onClick={() => openExternal("https://puter.com/dashboard#account")}>
                Create a token
              </button>
              {' '}in your dashboard.
            </p>
          )}
          <div className="connector-footer">
            <span className="connector-soon">{puter ? "Provider added" : "OpenAI-compatible"}</span>
            <div className="connector-actions">
              <button className="connector-action" type="button" onClick={() => openExternal("https://puter.com/dashboard#account")}>
                <Icon name="share" size={13} /> Create token
              </button>
              <button className="connector-action" type="button" onClick={setupPuter}>
                <Icon name="sparkle" size={13} /> {puter ? "Manage in Assistant" : "Set up Puter"}
              </button>
            </div>
          </div>
        </article>

        {AVAILABLE_CONNECTORS.map((connector) => (
          <article className="keys-card connector-card" key={connector.id}>
            <div className="connector-head">
              <div
                className={`connector-mark${connector.icon ? " connector-mark--logo" : ""}`}
                style={connector.icon ? undefined : { background: connector.color }}
                aria-hidden="true"
              >
                {connector.icon ? <Icon name={connector.icon} size={26} /> : connector.mark}
              </div>
              <div className="connector-copy">
                <div className="connector-title-row">
                  <strong>{connector.name}</strong>
                </div>
                <p>{connector.description}</p>
              </div>
              <span className="connector-pill is-idle">Available</span>
            </div>
            <div className="connector-footer">
              <span className="connector-soon">Setup required</span>
              <div className="connector-actions">
                <button className="connector-action" type="button" onClick={() => openExternal(connector.setup)}>
                  <Icon name="share" size={13} /> Open {connector.name}
                </button>
              </div>
            </div>
          </article>
        ))}

      </div>
    </>
  );
}

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
  onConnectOpenRouter,
  onDisconnectOpenRouter,
  documents = [],
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
  const formRef = useRef(null);
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
  // Each panel used to inherit the previous panel's scroll offset because one
  // form is the scroll container for all of them. Switching tabs now starts at
  // the top, which is what a reader means by choosing a different section.
  useEffect(() => {
    if (formRef.current) formRef.current.scrollTop = 0;
  }, [activeTab]);
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
        <div className="settings-form" ref={formRef}>
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
              onConnectOpenRouter,
              onDisconnectOpenRouter,
              onOpenAssistant: () => setActiveTab("settings-assistant"),
              documents,
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
                  <Panel {...panelProps} active={section.id === activeTab} />
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
 * Puter exposes an OpenAI-compatible endpoint on the user-pays model: the
 * reader's own Puter account covers the model usage, so Quill never holds a
 * developer key. The auth token is created in the Puter dashboard.
 * https://docs.puter.com/user-pays-model/
 */
const PUTER_BASE_URL = "https://api.puter.com/puterai/openai/v1";
const PUTER_DEFAULT_MODEL = "gpt-5.4-nano";
// Puter's OpenAI-compatible endpoint implements chat/completions but not
// GET /models, so the picker cannot discover the full catalogue. These are
// stable starter ids from the public model list; the custom-model field in
// Assistant accepts any other id the reader finds.
const PUTER_MODELS = [
  "gpt-5.4-nano",
  "gpt-5.5",
  "claude-sonnet-5-5",
  "gemini-3-flash-preview",
  "deepseek-chat",
  "grok-4",
  "moonshotai/kimi-k3",
];

/**
 * BYOK shortcuts. Each materialises a *real* registry row (endpoint, vendor,
 * default model) when chosen -- the key typed next then files under the row a
 * run will actually use, which is what the old name-only slots never did.
 */
const PROVIDER_PRESETS = [
  { key: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { key: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  {
    key: "puter",
    label: "Puter",
    baseUrl: PUTER_BASE_URL,
    model: PUTER_DEFAULT_MODEL,
    models: PUTER_MODELS,
  },
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
  theme,
  activeProvider,
  providers,
  onSelectProvider,
  onDisconnect,
  onSelectModel,
  localTools = [],
  documents = [],
  onAdoptTool,
  onSaveProvider,
  onCreateProvider,
  onConnectOpenRouter,
}) {
  const [liveModels, setLiveModels] = useState([]);
  const [modelsState, setModelsState] = useState("idle");
  const [openRouterState, setOpenRouterState] = useState("idle");
  const [micState, setMicState] = useState("idle");
  const [modelsError, setModelsError] = useState("");
  const [modelsRevision, setModelsRevision] = useState(0);
  const [customModel, setCustomModel] = useState("");
  // A key that has just been stored makes the model list readable. Re-read it
  // once the connection turns ready; otherwise the Retry link stays on screen
  // even though the only reason the first read failed is gone.
  useEffect(() => {
    if (connectionState === "ready") setModelsRevision((value) => value + 1);
  }, [connectionState]);
  const providerId = activeProvider?.id;
  // The page's one primary action scrolls to the key field rather than opening
  // a dialog: the form is already here, and a modal would hide the provider it
  // is about to write against.
  const keyFieldRef = useRef(null);
  const localToolsRef = useRef(null);
  const focusKeyField = () => {
    keyFieldRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    keyFieldRef.current?.focus({ preventScroll: true });
  };

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
  const usageRows = usage && usage.models
    ? Object.entries(usage.models).map(([model, value]) => {
        const row = typeof value === "number" ? { total: value, prompt: 0, completion: 0, calls: value ? 1 : 0 } : (value || {});
        return {
          model,
          total: Number(row.total) || 0,
          prompt: Number(row.prompt) || 0,
          completion: Number(row.completion) || 0,
          calls: Number(row.calls) || 0,
        };
      }).sort((a, b) => b.total - a.total)
    : [];

  const requestMicrophone = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicState("unsupported");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicState("granted");
    } catch {
      setMicState("denied");
    }
  };

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
  }, [providerId, modelsRevision, activeProvider?.models?.join("\u0000")]);

  const NON_CHAT_MODEL = /whisper|orpheus|prompt-guard/i
  const modelOptions = Array.from(
    new Set(
      [
        activeProvider?.defaultModel,
        ...(liveModels.length ? liveModels : activeProvider?.models || []),
      ].filter((option) => option && (option === activeProvider?.defaultModel || !NON_CHAT_MODEL.test(option))),
    ),
  );
  const roleModelOptions = Array.from(new Set([
    activeProvider?.thinkingModel,
    activeProvider?.writingModel,
    ...modelOptions,
  ].filter(Boolean)));
  const local = isLocalEndpoint(activeProvider?.baseUrl);
  // A CLI provider authenticates through the tool's own login, so there is no
  // key to store and no secret status to wait for. Reading `providerReady`
  // alone painted the opencode card "Inactive / Not connected" even while the
  // pipeline was using it.
  const isCli = activeProvider?.protocol === "cli";
  const ready = connectionState === "ready" || isCli;
  // OpenRouter is the one provider with an OAuth path, so it gets a button
  // where its key would otherwise be pasted. The same handler backs the
  // Connectors page; keeping the entry point here means a reader who chose an
  // OpenRouter model is not sent to another tab to make it work.
  const isOpenRouter = /openrouter\.ai/i.test(activeProvider?.baseUrl || "") || /openrouter/i.test(activeProvider?.id || "");
  const isPuter = /api\.puter\.com\/puterai\/openai\/v1/i.test(activeProvider?.baseUrl || "");
  const connectOpenRouter = async () => {
    if (!onConnectOpenRouter) return;
    setOpenRouterState("waiting");
    try {
      await onConnectOpenRouter();
      setConnectionState("ready");
      setModelsRevision((value) => value + 1);
      setOpenRouterState("ready");
    } catch {
      setOpenRouterState("error");
    }
  };

  const providerMonogram = (provider) => {
    const label = provider?.label || provider?.id || "P";
    return label.slice(0, 1).toUpperCase();
  };

  return (
    <>
      <div className="keys-head">
        <div className="keys-head-copy">
          <h2 className="keys-title">{isCli ? "Provider" : "API keys"}</h2>
          <p className="keys-sub">
            {isCli
              ? "This tool runs on this machine and uses its own login."
              : "Manage your BYOK (Bring Your Own Key) vault securely."}
          </p>
        </div>
        {!isCli && (
          <button type="button" className="keys-primary" onClick={focusKeyField}>
            <Icon name="plus" size={15} />
            <span>Add API key</span>
          </button>
        )}
      </div>

      <div className="keys-banners">
        {!isCli && (
          <div className="settings-banner keys-banner" role="note">
            <span className="settings-banner-mark" aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
            <div>
              <strong>Your keys are encrypted at rest</strong>
              <div className="settings-banner-sub">API keys are stored in a secure vault and never exposed in logs.</div>
            </div>
          </div>
        )}
        <div className="settings-banner keys-banner is-violet" role="note">
          <span className="settings-banner-mark" aria-hidden="true">
            <Icon name="sparkle" size={16} />
          </span>
          <div className="keys-banner-copy">
            <strong>Local models need no key</strong>
            <div className="settings-banner-sub">Ollama and CLI tools answer from this machine, with nothing to paste.</div>
          </div>
          <button
            type="button"
            className="keys-banner-action"
            onClick={() => localToolsRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })}
          >
            Local tools
          </button>
        </div>
      </div>

      <div className="assistant-keys-grid">
        <article className="keys-card keys-provider-card">
          <div className="keys-provider-head">
            <div className="keys-provider-avatar" aria-hidden="true">{providerMonogram(activeProvider)}</div>
            <div className="keys-provider-meta">
              <div className="keys-provider-name">{activeProvider?.label || activeProvider?.id || "Provider"}</div>
              <div className="keys-provider-endpoint">{activeProvider?.baseUrl || "No endpoint configured"}</div>
            </div>
          </div>
          <div className="keys-provider-status">
            <span className={`keys-pill ${ready ? "is-active" : ""}`}>
              {ready && <Icon name="check" size={12} />}
              {ready ? (isCli ? "CLI ready" : "Active") : "Inactive"}
            </span>
            <span className="keys-meta-text">
              {isCli
                ? "Uses the tool's own login"
                : ready
                  ? "Key ready"
                  : connectionState === "error"
                    ? "Add a key"
                    : "Not connected"}
            </span>
          </div>
          {isCli ? (
            <p className="keys-hint">
              The command below is the tool's one-shot invocation. Its own login
              is the credential; no API key is stored in Quill.
            </p>
          ) : (
            <>
              <div className="keys-secret">
                <span className="keys-secret-text">
                  {apiKey
                    ? keyVisible
                      ? apiKey
                      : "•".repeat(12)
                    : "sk-••••••••••••"}
                </span>
                <button
                  type="button"
                  className="keys-iconbtn"
                  onClick={() => setKeyVisible((value) => !value)}
                  aria-label={keyVisible ? "Hide key" : "Show key"}
                >
                  <Icon name={keyVisible ? "eye-off" : "eye"} size={17} />
                </button>
                <CopyButton value={apiKey} className="keys-iconbtn" label="Copy key" />
              </div>
              <div className="keys-actions">
                <Button className="keys-btn keys-btn-solid" type="button" onClick={connect} disabled={!activeProvider}>
                  Connect provider
                </Button>
                <Button
                  className="keys-btn"
                  type="button"
                  onClick={onDisconnect}
                  disabled={!activeProvider || !ready}
                >
                  Remove key
                </Button>
              </div>
              {isOpenRouter && !ready && (
                <div className="keys-openrouter">
                  <p className="keys-hint">
                    OpenRouter issues keys only to a signed-in account. Connect once and
                    Quill stores the key it receives.
                  </p>
                  <Button
                    className="keys-btn keys-btn-solid"
                    type="button"
                    onClick={connectOpenRouter}
                    disabled={openRouterState === "waiting"}
                  >
                    {openRouterState === "waiting"
                      ? "Waiting for OpenRouter…"
                      : openRouterState === "error"
                        ? "Try OpenRouter again"
                        : "Connect to OpenRouter"}
                  </Button>
                </div>
              )}
            </>
          )}
        </article>

        <article className="keys-card keys-form-card">
          <div className="keys-card-head">
            <h3 className="keys-card-title">{isCli ? "Provider and model" : "Add or update key"}</h3>
            <p className="keys-card-sub">
              {isCli
                ? "Choose the model this CLI should run. Its own login is the credential."
                : "Configure the provider, model, endpoint and key."}
            </p>
          </div>
          <div className="keys-field">
            <label className="keys-label" htmlFor="provider">Provider</label>
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
                      models: preset.models ?? [],
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
              <SelectTrigger id="provider" className="keys-select">
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
          <div className="keys-field">
            <label className="keys-label" htmlFor="model">Model</label>
            <Select
              value={activeProvider?.defaultModel ?? ""}
              disabled={!providerId || !modelOptions.length}
              onValueChange={(value) => onSelectModel?.(value)}
            >
              <SelectTrigger id="model" className="keys-select">
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
            {modelsState === "error" && !isPuter && (
              <button className="keys-link" type="button" onClick={() => setModelsRevision((value) => value + 1)}>
                Retry
              </button>
            )}
          </div>
          <div className="keys-field">
            <label className="keys-label" htmlFor="custom-model">Use another model</label>
            <div className="keys-secret-row">
              <input
                id="custom-model"
                className="keys-input"
                type="text"
                autoComplete="off"
                spellCheck="false"
                placeholder={isPuter ? "e.g. gpt-5.5 or claude-sonnet-5-5" : "provider/model"}
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const value = customModel.trim();
                    if (value) {
                      onSelectModel?.(value);
                      setCustomModel("");
                    }
                  }
                }}
              />
              <button
                type="button"
                className="keys-btn keys-btn-solid"
                disabled={!customModel.trim()}
                onClick={() => {
                  const value = customModel.trim();
                  if (!value) return;
                  onSelectModel?.(value);
                  setCustomModel("");
                }}
              >
                Use
              </button>
            </div>
            {isPuter && (
              <p className="keys-hint">
                Puter's full catalogue is at{' '}
                <button className="link-button" type="button" onClick={() => openExternal("https://developer.puter.com/ai/models/")}>
                  developer.puter.com/ai/models
                </button>
                . Any id there works here.
              </p>
            )}
          </div>
          <div className="keys-field">
            <label className="keys-label" htmlFor="thinking-model">Thinking model</label>
            <Select
              value={activeProvider?.thinkingModel || "__same__"}
              disabled={!providerId || !modelOptions.length}
              onValueChange={(value) => onSaveProvider?.({ thinkingModel: value === "__same__" ? "" : value })}
            >
              <SelectTrigger id="thinking-model" className="keys-select">
                <SelectValue placeholder="Same as chat model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__same__">Same as chat model</SelectItem>
                {roleModelOptions.map((option) => (
                  <SelectItem key={`thinking-${option}`} value={option}>{option}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="keys-field">
            <label className="keys-label" htmlFor="writing-model">Writing model</label>
            <Select
              value={activeProvider?.writingModel || "__same__"}
              disabled={!providerId || !modelOptions.length}
              onValueChange={(value) => onSaveProvider?.({ writingModel: value === "__same__" ? "" : value })}
            >
              <SelectTrigger id="writing-model" className="keys-select">
                <SelectValue placeholder="Same as chat model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__same__">Same as chat model</SelectItem>
                {roleModelOptions.map((option) => (
                  <SelectItem key={`writing-${option}`} value={option}>{option}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="keys-hint">Leave both on “Same as chat model” to use one model for thinking and writing.</p>
          </div>
          <div className="keys-field">
            <label className="keys-label" htmlFor="endpoint">{isCli ? "Command" : "Endpoint"}</label>
            <input
              id="endpoint"
              className="keys-input"
              type={isCli ? "text" : "url"}
              value={endpointDraft}
              placeholder={isCli ? "/path/to/tool run --format json" : "https://api.example.com/v1"}
              onChange={(event) => setEndpointDraft(event.target.value)}
              onBlur={saveEndpoint}
            />
          </div>
          {!isCli && (
            <>
              <div className="keys-field">
                <label className="keys-label" htmlFor="api-key">API key</label>
                <div className="keys-secret-row">
                  <input
                    id="api-key"
                    ref={keyFieldRef}
                    className="keys-input keys-input-secret"
                    type={keyVisible ? "text" : "password"}
                    placeholder={isPuter ? "Paste your Puter auth token" : "Paste a key"}
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setConnectionState("idle");
                    }}
                  />
                  <button type="button" className="keys-iconbtn" onClick={() => setKeyVisible((value) => !value)} aria-label={keyVisible ? "Hide key" : "Show key"}>
                    <Icon name={keyVisible ? "eye-off" : "eye"} size={17} />
                  </button>
                </div>
              </div>
              <p className="keys-note">The key is written to your operating system's credential store and used for requests to the provider above.</p>
              {isPuter && (
                <p className="keys-hint">
                  Puter bills model usage to your own account.{' '}
                  <button className="link-button" type="button" onClick={() => openExternal("https://puter.com/dashboard#account")}>
                    Create an auth token
                  </button>{' '}
                  in your dashboard, then paste it here.
                </p>
              )}
            </>
          )}
        </article>
      </div>
      {/* One card for the behaviour rows, the way the reference closes its keys
          page: a titled panel whose rows are divided rather than spaced. */}
      <div className="keys-card keys-rows-card" ref={localToolsRef}>
        <div className="keys-card-head">
          <h3 className="keys-card-title">How keys are used</h3>
          <p className="keys-card-sub">Usage, local tools and anything already installed on this machine.</p>
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
            {usage?.date && Number(usage.limit) > 0
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
          {usageRows.map(({ model, total: used, prompt, completion, calls }) => {
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
                  <small>{prompt.toLocaleString()} in · {completion.toLocaleString()} out · {calls} call{calls === 1 ? "" : "s"}</small>
                </span>
                <span className="usage-price">{modelPrice(model)}</span>
              </div>
            );
          })}
          <div className="usage-mini-chart">
            <UsageChart models={usageRows} theme={theme} width={520} compact />
          </div>
        </div>
      )}
      {/* Detection is a choice, not a fixture: off stops the probe entirely
          (the same setting gates the scan in the shell) and hides the rows
          below, so a reader who never wants local agents pays for none of it. */}
      <div className="settings-row">
        <div className="settings-row-copy">
          <span className="settings-row-label">Microphone</span>
          <small>
            Voice notes use the microphone only while the mic button is active.
            Grant it now so the first recording does not stop for a permission prompt.
          </small>
        </div>
        <div className="settings-row-control">
          <span className={`settings-status${micState === "granted" ? " connected" : ""}`}>
            {micState === "granted" ? "Granted" : micState === "denied" ? "Blocked" : micState === "unsupported" ? "Unsupported" : "Ask on first use"}
          </span>
          <button className="soft-button" type="button" onClick={requestMicrophone} disabled={micState === "granted"}>
            {micState === "granted" ? "Ready" : "Allow microphone"}
          </button>
        </div>
      </div>
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
                  onClick={() => onAdoptTool?.(tool)}
                  title={adopted ? "Re-read the tool's model list" : "Use this tool"}
                >
                  {adopted ? "Refresh models" : "Use"}
                </Button>
              ) : (
                <span className="settings-status">Not routable</span>
              )}
            </div>
          </div>
        );
      })}
      </>)}
      </div>
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
              <SelectItem value="Arial">Arial</SelectItem>
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

function WritingPanel({ draft, update, documents = [] }) {
  const [profileState, setProfileState] = useState("idle");
  const [profileError, setProfileError] = useState("");
  const [updateState, setUpdateState] = useState("idle");
  const [updateInfo, setUpdateInfo] = useState(null);
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [installState, setInstallState] = useState("idle");
  const [installProgress, setInstallProgress] = useState({ downloaded: 0, total: 0 });
  const savedProfile = (() => {
    try {
      return draft.writingProfile ? JSON.parse(draft.writingProfile) : null;
    } catch {
      return null;
    }
  })();

  const studyWriting = async () => {
    const texts = documents
      .map((doc) => String(doc.content || ""))
      .filter((text) => text.trim());
    if (!texts.length) {
      setProfileError("Open or import a few documents first.");
      setProfileState("error");
      return;
    }
    setProfileState("loading");
    setProfileError("");
    try {
      const result = await profileWritingStyle({ texts });
      const data = result?.profile || {};
      update("writingProfile", JSON.stringify({
        ...data,
        prompt: result?.prompt || "",
        builtAt: new Date().toISOString(),
      }));
      setProfileState("ready");
    } catch (error) {
      const message = error?.message || "Could not build the profile.";
      setProfileError(message);
      notify(message);
      setProfileState("error");
    }
  };

  const lookForUpdates = async () => {
    setUpdateState("loading");
    setPendingUpdate(null);
    setInstallState("idle");
    setInstallProgress({ downloaded: 0, total: 0 });
    try {
      const info = await checkUpdates();
      setUpdateInfo(info);
      // The feed says a release exists; the updater says whether this build
      // can install it. Only the second turns the card into a download.
      setPendingUpdate(info?.available ? await updateAvailable() : null);
      setUpdateState("ready");
    } catch (error) {
      const message = error?.message || "Check failed.";
      setUpdateInfo({ current: "", available: false, error: message });
      notify(message);
      setUpdateState("error");
    }
  };

  const downloadUpdate = async () => {
    if (!pendingUpdate) return;
    setInstallState("downloading");
    try {
      await installUpdate(pendingUpdate, setInstallProgress);
      setInstallState("ready");
    } catch (error) {
      const message = error?.message || "The update could not be installed.";
      notify(message);
      setInstallState("error");
    }
  };

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
        id="natural-voice"
        label="Natural voice"
        description="Generate plainer academic prose: shorter sentences, active voice, concrete examples and no formulaic transitions."
        checked={draft.naturalVoice !== false}
        onChange={(value) => update("naturalVoice", value)}
      />
      <ToggleRow
        id="completions"
        label="Inline completions"
        description="Show a short ghost-text suggestion after a pause. Tab accepts it, Escape dismisses it."
        checked={draft.completions !== false}
        onChange={(value) => update("completions", value)}
      />
      <div className="settings-row">
        <div className="settings-row-copy">
          <label className="settings-row-label">Completion pause</label>
          <small>How long typing must stop before a suggestion is requested.</small>
        </div>
        <div className="settings-row-control">
          <div className="settings-choice-group" role="group" aria-label="Completion pause">
            {[600, 900, 1400].map((delay) => (
              <button
                key={delay}
                type="button"
                className={`settings-choice${Number(draft.completionDelay ?? 900) === delay ? " is-active" : ""}`}
                aria-pressed={Number(draft.completionDelay ?? 900) === delay}
                onClick={() => update("completionDelay", delay)}
              >
                {delay < 1000 ? `${delay} ms` : `${delay / 1000} s`}
              </button>
            ))}
          </div>
        </div>
      </div>
      <ToggleRow
        id="format-imports"
        label="Tidy imported formatting"
        description="Clean Word and LaTeX leftovers as a file is imported. Clean up in the editor still works either way."
        checked={draft.formatOnImport !== false}
        onChange={(value) => update("formatOnImport", value)}
      />
      <ToggleRow
        id="reduce-motion"
        label="Reduce motion"
        description="Use quieter transitions throughout the workspace. The Conclave assistant keeps animating."
        checked={draft.reduceMotion}
        onChange={(value) => update("reduceMotion", value)}
      />
      <div className="settings-profile-card">
        <div className="settings-profile-head">
          <div>
            <strong>Writing profile</strong>
            <p>Studies only the documents in this library. It refreshes automatically each week and when your library changes, and is used to steer generated prose.</p>
          </div>
          <button className="soft-button" type="button" onClick={studyWriting} disabled={profileState === "loading"}>
            {profileState === "loading" ? "Studying…" : "Refresh now"}
          </button>
        </div>
        {profileState === "error" && <p className="settings-profile-error">{profileError}</p>}
        {savedProfile ? (
          <div className="settings-profile-metrics">
            <span><strong>{Number(savedProfile.documents) || 0}</strong> documents</span>
            <span><strong>{Number(savedProfile.words || 0).toLocaleString()}</strong> words</span>
            <span><strong>{Number(savedProfile.mean_sentence_words) || 0}</strong> avg words/sentence</span>
            <span><strong>{Number(savedProfile.contractions_per_1000_words) || 0}</strong> contractions/1k</span>
            <span><strong>{savedProfile.natural_voice_score ?? 0}</strong> voice score</span>
            <button className="link-button" type="button" onClick={() => update("writingProfile", "")}>Forget profile</button>
          </div>
        ) : (
          <p className="settings-profile-empty">No profile yet. Build one to make generated text follow your own rhythm and vocabulary.</p>
        )}
      </div>
      <div className="settings-update-card">
        <div>
          <strong>Updates</strong>
          <p>Check the public release feed. Quill never installs an update without showing you the version first.</p>
          {updateInfo && (
            <p className="settings-update-result">
              {updateInfo.error
                ? updateInfo.error
                : updateInfo.available
                  ? `Quill ${updateInfo.latest} is available (you have ${updateInfo.current}).`
                  : `You are on the latest version (${updateInfo.current}).`}
              {updateInfo?.available && !pendingUpdate && updateInfo.url && (
                <> <button className="link-button" type="button" onClick={() => openExternal(updateInfo.url)}>Open release</button></>)}
            </p>
          )}
          {installState === "downloading" && (
            <p className="settings-update-result">
              Downloading… {installProgress.total
                ? `${Math.min(100, Math.round((installProgress.downloaded / installProgress.total) * 100))}%`
                : `${Math.round(installProgress.downloaded / 1024)} KB`}
            </p>
          )}
          {installState === "error" && (
            <p className="settings-update-result">The download did not finish. Try again.</p>
          )}
        </div>
        {pendingUpdate && installState !== "ready" ? (
          <button className="soft-button" type="button" onClick={downloadUpdate} disabled={installState === "downloading"}>
            {installState === "downloading" ? "Installing…" : "Download and install"}
          </button>
        ) : installState === "ready" ? (
          <button className="soft-button" type="button" onClick={restartApp}>Restart Quill</button>
        ) : (
          <button className="soft-button" type="button" onClick={lookForUpdates} disabled={updateState === "loading"}>
            {updateState === "loading" ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * System: what this installation can actually do right now.
 *
 * Quill is three things that ship separately -- the app, the Python pipeline and
 * a search backend -- so "it works on my machine" is not a property of the code.
 * This panel is the answer to a support thread: it asks the running sidecar what
 * it sees, probes the configured search instance, and reports the ledger and
 * telemetry state. Every row names its own fix, and the restart button is the
 * one action that resolves the most common failure (a sidecar left behind by a
 * previous session).
 *
 * The report is per machine and deliberately not synced: it describes this PC,
 * not the reader or the document.
 */
function SystemPanel({ active = true } = {}) {
  const [report, setReport] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [state, setState] = useState("loading");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setState("loading");
    const [next, live] = await Promise.all([systemStatus(), pipelineStatus()]);
    setReport(next);
    setPipeline(live);
    setState(next ? "ready" : "offline");
  };

  // Only the panel on screen probes. The tabs stay mounted, so an ungated
  // effect would run a live search request every time Settings opened, even
  // for a reader who came in to change a font.
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    (async () => {
      const [next, live] = await Promise.all([systemStatus(), pipelineStatus()]);
      if (cancelled) return;
      setReport(next);
      setPipeline(live);
      setState(next ? "ready" : "offline");
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const restart = async () => {
    setBusy(true);
    await pipelineStart();
    await refresh();
    setBusy(false);
  };

  const search = report?.search;
  const searchOk = Boolean(search?.reachable && search?.json);
  const serviceReady = pipeline?.state === "ready";
  const checking = state === "loading";

  return (
    <>
      <div className="settings-banner" role="note">
        <span className="settings-banner-mark" aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
        <div>
          <strong>These checks describe this computer</strong>
          <div className="settings-banner-sub">
            They do not travel with a document. On a new machine, an API key or a
            local model is the only thing a reader has to set up before writing.
          </div>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-copy">
          <span className="settings-row-label">Writing service</span>
          <small>
            {checking
              ? "Checking the local pipeline…"
              : serviceReady
                ? "Running here. Quill starts it with the app and stops it on exit."
                : "Not answering. Writing, chat and research all need it."}
          </small>
        </div>
        <div className="settings-row-control">
          <span className={`settings-status${serviceReady ? " connected" : " error"}`}>
            {checking ? "Checking" : serviceReady ? "Running" : "Not running"}
          </span>
          <button
            className="soft-button"
            type="button"
            onClick={restart}
            disabled={busy}
          >
            {busy ? "Starting…" : "Restart"}
          </button>
        </div>
      </div>
      {pipeline?.detail && <p className="system-detail">{pipeline.detail}</p>}

      <div className="settings-row">
        <div className="settings-row-copy">
          <span className="settings-row-label">Research search</span>
          <small>
            {checking
              ? "Probing the configured search instance…"
              : !report
                ? "The writing service is not running, so it cannot report the search backend yet."
                : searchOk
                  ? "SearXNG answered a live query. Research uses it before the scrapers."
                  : search?.configured
                    ? "SearXNG is not answering, so research falls back to DuckDuckGo and Bing."
                    : "Search is switched off for this install."}
          </small>
        </div>
        <div className="settings-row-control">
          <span className={`settings-status${searchOk ? " connected" : report && search?.configured ? " error" : ""}`}>
            {checking ? "Checking" : !report ? "Unknown" : searchOk ? "SearXNG" : search?.configured ? "Scrapers" : "Off"}
          </span>
          <button
            className="soft-button"
            type="button"
            onClick={refresh}
            disabled={checking}
          >
            Check again
          </button>
        </div>
      </div>
      {search && (
        <p className="system-detail">
          {searchOk
            ? `${search.results} result${search.results === 1 ? "" : "s"} from ${search.url}`
            : search.detail || search.url || "No search backend configured."}
        </p>
      )}

      <div className="settings-row">
        <div className="settings-row-copy">
          <span className="settings-row-label">Generation ledger</span>
          <small>
            Every long-form write records one metadata row here. The prompt is
            hashed, never copied.
          </small>
        </div>
        <div className="settings-row-control">
          <span className={`settings-status${report?.telemetry?.convexConfigured ? " connected" : ""}`}>
            {!report
              ? "Unknown"
              : report.telemetry?.convexConfigured
                ? "Local + Convex"
                : "Local only"}
          </span>
        </div>
      </div>
      {report?.telemetry?.ledger && (
        <p className="system-detail">{report.telemetry.ledger}</p>
      )}

      <div className="settings-row">
        <div className="settings-row-copy">
          <span className="settings-row-label">This machine</span>
          <small>
            {report?.pipeline
              ? `${report.pipeline.platform} · Python ${report.pipeline.python} · app ${report.pipeline.version}`
              : "Waiting for the writing service to report."}
          </small>
        </div>
        <div className="settings-row-control">
          <span className="settings-status">{checking ? "Checking" : state === "ready" ? "Reported" : "No report"}</span>
        </div>
      </div>
      {report?.pipeline?.workspace && (
        <p className="system-detail">{report.pipeline.workspace}</p>
      )}
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

export { DetailsDialog, PROVIDER_PRESETS, SettingsPage };
