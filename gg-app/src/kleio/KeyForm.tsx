// A provider key, as one unit: its label with a "Get a key" link, a line on
// where to find one, then the field and Save, which shows "Checking…" while
// the host tries the key with the provider. Errors come back in plain words,
// under the field. Used by Settings → Setup and the Apps page.

import { useId, useState } from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "../agent";
import {
  errorText,
  KleioApiError,
  setSetupKey,
  type SetupKeyName,
  type SetupStatus,
} from "./kleioApi";

export const KEY_PROVIDERS: Record<SetupKeyName, { name: string; url: string; hint: string }> = {
  composio: {
    name: "Composio",
    url: "https://dashboard.composio.dev",
    hint: "In Composio, open Settings, then API Keys, and create a key.",
  },
  typesafe: {
    name: "Typesafe",
    url: "https://console.typesafe.ai",
    hint: "Typesafe is in early access, so new accounts may have to wait.",
  },
};

/** What went wrong saving or removing a key, in words. */
export function setupKeyError(name: SetupKeyName, e: unknown): string {
  const provider = KEY_PROVIDERS[name].name;
  if (e instanceof KleioApiError) {
    if (e.status === 404) return "Your host needs the latest Kleio first.";
    switch (e.message) {
      case "bad_key":
        return `${provider} didn't accept that key. Check you copied all of it.`;
      case "forbidden":
        return "Only an admin device can change keys.";
      case "set_by_env":
        return "This key is set on the host itself, so it can't be changed here.";
      case "unreachable":
        return `Couldn't reach ${provider} to check the key. Try again.`;
      case "rejected":
        return e.detail
          ? `${provider} couldn't check the key: ${e.detail}`
          : `${provider} couldn't check the key.`;
      case "too_large":
        return "That's too long to be a key. Check what you pasted.";
      case "bad_request":
        return "That doesn't look like a key. Check what you pasted.";
    }
  }
  return errorText(e);
}

/** Opens the provider's page for making a key, in the browser. */
export function GetKeyButton({ url }: { url: string }): React.ReactElement {
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openUrl(url)}>
      <ArrowSquareOutIcon size={14} weight="bold" aria-hidden="true" />
      Get a key
    </button>
  );
}

/**
 * The key unit. `save` throws when the key isn't taken, and `describeError`
 * puts why in words under the field. The field clears once a key is saved.
 */
export function KeyField({
  label,
  placeholder,
  url,
  hint,
  save,
  describeError,
}: {
  label: string;
  /** Shown in the empty field, e.g. "OpenAI API key (sk-…)". */
  placeholder: string;
  /** Where "Get a key" goes. */
  url: string;
  /** Where to find a key, or what to know before adding one. */
  hint: React.ReactNode;
  save: (key: string) => Promise<void>;
  describeError: (e: unknown) => string;
}): React.ReactElement {
  const id = useId();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await save(key.trim());
      setKey("");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="key-field">
      <div className="key-field-head">
        <label className="key-field-label" htmlFor={`${id}-key`}>
          {label}
        </label>
        <GetKeyButton url={url} />
      </div>
      <p className="key-field-hint" id={`${id}-hint`}>
        {hint}
      </p>
      <form
        className="modal-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim() && !busy) void submit();
        }}
      >
        <input
          id={`${id}-key`}
          className="modal-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={key}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
          onChange={(e) => setKey(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Save"}
        </button>
      </form>
      {error && (
        <p className="settings-desc is-error" role="alert" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** A key the host keeps for a setup step (Composio, Typesafe). */
export function KeyForm({
  name,
  onSaved,
}: {
  name: SetupKeyName;
  onSaved: (status: SetupStatus) => void;
}): React.ReactElement {
  const { name: provider, url, hint } = KEY_PROVIDERS[name];
  return (
    <KeyField
      label={`${provider} API key`}
      placeholder={`${provider} API key`}
      url={url}
      hint={hint}
      save={async (key) => onSaved(await setSetupKey(name, key))}
      describeError={(e) => setupKeyError(name, e)}
    />
  );
}
