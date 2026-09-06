import { useState } from "react";
import { api, downloadContent } from "./api.js";

/** Attachments are inert text/downloads. Never navigate the browser to a provider URI. */
export function StoredContent({
  session,
  uri,
  label,
}: {
  session: string;
  uri: string;
  label: string;
}) {
  const [preview, setPreview] = useState<{
    text: string | null;
    bytes: number;
    truncated: boolean;
  }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const digest = /^axp-blob:\/[^/]+\/([a-f0-9]{64})$/.exec(uri)?.[1];
  const run = async (download: boolean) => {
    if (!digest) return;
    setBusy(true);
    setError(undefined);
    try {
      if (download) await downloadContent(session, digest);
      else
        setPreview(
          await api(
            `content?session=${encodeURIComponent(session)}&digest=${digest}`,
          ),
        );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Content unavailable",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stored-content">
      <div className="toolbar-actions">
        <strong>{label}</strong>
        {digest ? (
          <>
            <button
              type="button"
              className="button small"
              disabled={busy}
              onClick={() => {
                void run(false);
              }}
            >
              {preview ? "Refresh preview" : "View content"}
            </button>
            <button
              type="button"
              className="button small"
              disabled={busy}
              onClick={() => {
                void run(true);
              }}
            >
              Download content
            </button>
          </>
        ) : (
          <span>Available in the session export.</span>
        )}
      </div>
      {preview && (
        <>
          {preview.text === null ? (
            <p>
              Binary attachment · {preview.bytes.toLocaleString()} bytes.
              Download to inspect.
            </p>
          ) : (
            <pre>{preview.text}</pre>
          )}
          {preview.truncated && (
            <p>
              Preview shows the first 64 KB of {preview.bytes.toLocaleString()}{" "}
              bytes. Download the complete content before reviewing it.
            </p>
          )}
        </>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
