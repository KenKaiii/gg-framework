import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton } from "./modal-embed";
import { ListSkeleton } from "./Skeleton";
import {
  addLocalEndpoint,
  getLocalModels,
  removeLocalEndpoint,
  scanLocalModels,
  type LocalEndpointRow,
  type LocalModelRow,
} from "./agent";
import { toast } from "./toast";

interface Props {
  onClose: () => void;
}

function formatContext(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

// Ollama's default for most GPUs; the agent's prompt alone fills much of it.
const SMALL_CONTEXT = 8192;

/** Whether Ollama is serving a usable model at a size too small for real work. */
function smallOllamaContext(endpoints: readonly LocalEndpointRow[]): boolean {
  return endpoints.some(
    (endpoint) =>
      endpoint.kind === "ollama" &&
      endpoint.models.some(
        (model) =>
          model.supportsTools && model.contextWindowKnown && model.contextWindow <= SMALL_CONTEXT,
      ),
  );
}

/** The one figure worth showing inline. "?" = the server never reported it. */
function contextLabel(model: LocalModelRow): string {
  return model.contextWindowKnown
    ? `${formatContext(model.contextWindow)} ctx`
    : `${formatContext(model.contextWindow)} ctx?`;
}

/**
 * Everything the row can't show: which endpoint serves it, the exact context
 * length, capabilities, load state, and — for a model that can't run the agent
 * — why it's disabled.
 */
function modelTooltip(model: LocalModelRow, endpoint: LocalEndpointRow): string {
  const lines = [`${model.rawId} — ${endpoint.label}`];
  lines.push(
    endpoint.contextLength
      ? `Context: ${model.contextWindow.toLocaleString()} tokens (set by you)`
      : model.contextWindowKnown
        ? `Context: ${model.contextWindow.toLocaleString()} tokens`
        : `Context: unknown — assuming ${model.contextWindow.toLocaleString()} tokens`,
  );
  const caps: string[] = [];
  if (model.supportsTools) caps.push("tool calling");
  if (model.supportsImages) caps.push("vision");
  if (model.supportsThinking) caps.push("thinking");
  lines.push(caps.length > 0 ? `Supports: ${caps.join(", ")}` : "Supports: text only");
  if (model.loaded) lines.push("Loaded in memory");
  if (!model.supportsTools) {
    lines.push("Can't run the agent — this model has no tool calling.");
  }
  return lines.join("\n");
}

/**
 * Local models manager. Only Ollama is found automatically; LM Studio,
 * llama.cpp, vLLM, PolyStrata, a self-hosted box or an OpenAI-compatible
 * gateway are each one "Add endpoint" away.
 *
 * Read-only by design: models are **chosen in the footer model selector** like
 * every other model, so there's exactly one selection surface in the app. This
 * screen answers "is Ollama up, and what can these models do" — capabilities
 * come from the server rather than from guesses, so a model that can't call
 * tools is flagged here instead of failing on the first prompt.
 */
export function LocalModelsModal({ onClose }: Props): React.ReactElement {
  const [endpoints, setEndpoints] = useState<LocalEndpointRow[]>([]);
  const [loading, setLoading] = useState(true);
  // The saved list couldn't be read; shown instead of "No models yet".
  const [loadError, setLoadError] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [contextLength, setContextLength] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Show the last scan immediately (no probing), then refresh in the background
  // so a server started since the app booted appears without a manual scan.
  const load = useCallback((isCancelled: () => boolean): void => {
    setLoading(true);
    setLoadError(false);
    let listed = false;
    void getLocalModels()
      .then((state) => {
        if (isCancelled()) return;
        listed = true;
        setEndpoints(state.endpoints);
        setLoading(false);
        return scanLocalModels();
      })
      .then((state) => {
        if (!isCancelled() && state) setEndpoints(state.endpoints);
      })
      .catch(() => {
        if (isCancelled()) return;
        // A failed background scan keeps the list we already showed; only a
        // failed read of that list is an error worth a retry.
        if (!listed) setLoadError(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      const state = await scanLocalModels();
      setEndpoints(state.endpoints);
      const found = state.endpoints.reduce((total, e) => total + e.models.length, 0);
      toast(
        found === 0
          ? "No models found. Start your local server and scan again, or add an endpoint."
          : `Found ${found} local model${found === 1 ? "" : "s"}.`,
        found === 0 ? "warning" : "success",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setScanning(false);
    }
  }, []);

  async function add(): Promise<void> {
    if (busy) return;
    const pinText = contextLength.trim().replace(/[,_\s]/g, "");
    const pin = pinText ? Number(pinText) : undefined;
    if (pin !== undefined && !Number.isSafeInteger(pin)) {
      setAddError("Context length must be a whole number of tokens, like 131072.");
      return;
    }
    setBusy(true);
    setAddError(null);
    try {
      const state = await addLocalEndpoint(
        url,
        label.trim() || undefined,
        apiKey || undefined,
        pin,
      );
      setEndpoints(state.endpoints);
      setUrl("");
      setLabel("");
      setApiKey("");
      setContextLength("");
      setShowAdd(false);
      toast("Endpoint added.", "success");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(endpoint: LocalEndpointRow): Promise<void> {
    try {
      const state = await removeLocalEndpoint(endpoint.id);
      setEndpoints(state.endpoints);
      toast(`Removed "${endpoint.label}".`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  const totalModels = endpoints.reduce((total, e) => total + e.models.length, 0);

  return (
    <Modal title="Local models" onClose={onClose}>
      {/* The "nothing found" line belongs with the instruction that fixes it,
          above the endpoint rows — not stranded at the bottom of a scroll area
          the user has to reach to learn why the list looks empty. */}
      {!loading && loadError && (
        <div className="picker-empty" role="alert" style={{ marginBottom: "var(--space-3)" }}>
          <span style={{ color: theme.textMuted }}>Couldn't reach the agent to list models.</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => load(() => false)}>
            Try again
          </button>
        </div>
      )}
      {!loading && !loadError && totalModels === 0 && (
        <div
          className="mcp-empty"
          style={{ color: theme.textMuted, marginBottom: "var(--space-3)" }}
        >
          No models yet. Start Ollama and scan, add an endpoint for LM Studio or any other server,
          or download one from the Hugging Face tile.
        </div>
      )}

      {loading ? (
        <ListSkeleton rows={4} />
      ) : (
        <div className="mcp-list">
          {endpoints.map((endpoint) => (
            <div key={endpoint.id} style={{ marginBottom: "var(--space-5)" }}>
              <div className="mcp-item">
                <span
                  className="mcp-dot"
                  style={{ color: endpoint.reachable ? theme.success : theme.textDim }}
                  aria-hidden="true"
                >
                  {endpoint.reachable ? "\u25cf" : "\u25cb"}
                </span>
                <span className="mcp-name" style={{ color: theme.text }} title={endpoint.baseUrl}>
                  {endpoint.label}
                </span>
                <span className="mcp-meta" style={{ color: theme.textDim }}>
                  {endpoint.reachable
                    ? `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"}`
                    : (endpoint.reason ?? "not running")}
                </span>
                {endpoint.custom && (
                  <button
                    className="mcp-delete"
                    style={{ color: theme.textDim }}
                    title={`Remove "${endpoint.label}"`}
                    onClick={() => void remove(endpoint)}
                  >
                    <XIcon size={12} weight="bold" aria-hidden="true" />
                  </button>
                )}
              </div>

              {endpoint.models.map((model) => (
                // Informational row, not a control: selection happens in the
                // footer model selector. A row is too narrow for a chip per
                // capability (they overflowed the modal), so one quiet context
                // figure sits inline and the full detail is in the tooltip.
                <div
                  key={model.id}
                  className="local-model-row"
                  style={{ color: model.supportsTools ? theme.text : theme.textDim }}
                  title={modelTooltip(model, endpoint)}
                >
                  <span className="local-model-name">{model.rawId}</span>
                  <span className="local-model-meta" style={{ color: theme.textDim }}>
                    {model.supportsTools ? contextLabel(model) : "no tool calling"}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {showAdd ? (
        <>
          <div
            className="modal-label"
            style={{ color: theme.textMuted, marginTop: "var(--space-2)" }}
          >
            Endpoint URL
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
            value={url}
            placeholder="http://127.0.0.1:1234/v1"
            autoFocus
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          <div className="modal-label" style={{ color: theme.textMuted }}>
            Name (optional)
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
            value={label}
            placeholder="Workstation"
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="modal-label" style={{ color: theme.textMuted }}>
            API key (optional)
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
            value={apiKey}
            type="password"
            placeholder="Only if your server requires one"
            onChange={(e) => setApiKey(e.target.value)}
          />
          <div className="modal-label" style={{ color: theme.textMuted }}>
            Context length (optional)
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
            value={contextLength}
            aria-label="Context length"
            inputMode="numeric"
            placeholder="Tokens, e.g. 131072. Leave empty to use what the server reports"
            onChange={(e) => setContextLength(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          {addError && (
            <div className="login-status" style={{ color: theme.error }}>
              {addError}
            </div>
          )}
        </>
      ) : (
        <div className="modal-hint" style={{ color: theme.textDim, marginTop: "var(--space-6)" }}>
          {smallOllamaContext(endpoints) && (
            <>
              Ollama is running these with a small context. Raise Context length in Ollama’s
              settings, then pick the model again.{" "}
            </>
          )}
          Pick a model from the model menu in a session. No tool calling = can’t run the agent. “?”
          context = not known until the model loads.
        </div>
      )}

      <div className="modal-actions">
        <button
          className="modal-btn"
          style={{ marginRight: "auto" }}
          onClick={() => {
            setAddError(null);
            setShowAdd((current) => !current);
          }}
        >
          {showAdd ? "Cancel" : "Add endpoint"}
        </button>
        {showAdd ? (
          <button
            className="modal-btn primary"
            disabled={!url.trim() || busy}
            onClick={() => void add()}
          >
            {busy ? "Saving\u2026" : "Save"}
          </button>
        ) : (
          <>
            <ModalDismissButton onClick={onClose}>Close</ModalDismissButton>
            <button
              className="modal-btn primary"
              disabled={scanning}
              onClick={() => void scan()}
              title="Re-check every local endpoint"
            >
              <ArrowsClockwiseIcon
                size={13}
                style={{ marginRight: "var(--space-3)", verticalAlign: "-2px" }}
              />
              {scanning ? "Scanning\u2026" : "Scan"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
