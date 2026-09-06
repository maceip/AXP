import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContributionDetail,
  WorkspaceCommand,
  WorkspaceView,
} from "../../src/workspace-contract.js";

const fragment = new URLSearchParams(location.hash.slice(1));
function stored(key: string, value?: string): string | null {
  try {
    if (value !== undefined) sessionStorage.setItem(key, value);
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
const access = fragment.get("access") ?? stored("axp-access") ?? "";
if (fragment.has("access")) {
  stored("axp-access", fragment.get("access")!);
  history.replaceState(null, "", location.pathname + location.search);
}
function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
  };
}
export function useDraft(key: string) {
  const [value, setValue] = useState(() => stored(`axp-draft:${key}`) ?? "");
  const setDraft = useCallback(
    (next: string) => {
      setValue(next);
      stored(`axp-draft:${key}`, next);
    },
    [key],
  );
  return [value, setDraft] as const;
}
export async function downloadContent(session: string, digest: string) {
  const response = await fetch(
    `/api/download?session=${encodeURIComponent(session)}&digest=${digest}`,
    {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error((await response.json()).error ?? "Download failed");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `axp-${digest}.bin`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    headers: {
      ...headers(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error ?? `Workspace request failed (${response.status})`,
    );
  return data as T;
}

export function useWorkspace(session: string | null, offset = 0, query = "") {
  const [workspace, setWorkspace] = useState<WorkspaceView>();
  const [detail, setDetail] = useState<ContributionDetail>();
  const [error, setError] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const reload = useRef<() => void>(() => {});
  const refresh = useCallback(() => reload.current(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        refresh();
      }, 180);
    };
    const stream = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch("/api/events", {
            headers: headers(),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) return;
          refresh();
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n\n")) !== -1) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              if (frame.includes("event: offline"))
                setError("The repository host disconnected. Reconnecting…");
              if (frame.includes("event: changed")) changed();
            }
          }
        } catch {
          /* The snapshot poll reports connectivity; reconnect keeps this stream live. */
        }
        await new Promise<void>((resolve) => {
          const abort = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 2000);
          if (controller.signal.aborted) abort();
          else
            controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
    };
    void stream();
    const poll = setInterval(refresh, 5000);
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    let running = false,
      dirty = false;
    const load = () => {
      if (running) {
        dirty = true;
        return;
      }
      if (controller.signal.aborted) return;
      running = true;
      void Promise.allSettled([
        api<WorkspaceView>(
          `workspace?offset=${offset}&query=${encodeURIComponent(query)}`,
          undefined,
          controller.signal,
        ),
        session
          ? api<ContributionDetail>(
              `contribution?session=${encodeURIComponent(session)}`,
              undefined,
              controller.signal,
            )
          : Promise.resolve(undefined),
      ])
        .then(([view, selected]) => {
          if (controller.signal.aborted) return;
          if (view.status === "fulfilled") {
            setWorkspace(view.value);
            setError(undefined);
          } else
            setError(
              view.reason instanceof Error
                ? view.reason.message
                : "Workspace unavailable",
            );
          if (selected.status === "fulfilled") {
            setDetail(selected.value);
            setDetailError(undefined);
          } else
            setDetailError(
              selected.reason instanceof Error
                ? selected.reason.message
                : "Contribution unavailable",
            );
        })
        .finally(() => {
          running = false;
          if (dirty) {
            dirty = false;
            load();
          }
        });
    };
    reload.current = load;
    load();
    return () => controller.abort();
  }, [session, offset, query]);
  return {
    workspace,
    detail: detail?.contribution.id === session ? detail : undefined,
    error,
    detailError,
    refresh,
  };
}

/** Keep the same operation ID and timestamp when retrying an uncertain submission. */
export function useCommand(refresh: () => void, retryKey?: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<WorkspaceCommand | null>(() => {
    try {
      return retryKey
        ? (JSON.parse(
            stored(`axp-pending:${retryKey}`) ?? "null",
          ) as WorkspaceCommand | null)
        : null;
    } catch {
      return null;
    }
  });
  const retry = useRef<{ key: string; command: WorkspaceCommand } | null>(
    pending
      ? {
          key: JSON.stringify({
            session: pending.session,
            action: pending.action,
          }),
          command: pending,
        }
      : null,
  );
  const acknowledge = useCallback(
    (operationId?: string) => {
      const id = operationId ?? retry.current?.command.operationId;
      if (retry.current?.command.operationId === id) {
        retry.current = null;
        setPending(null);
      }
      if (retryKey) {
        try {
          const saved = JSON.parse(
            stored(`axp-pending:${retryKey}`) ?? "null",
          ) as WorkspaceCommand | null;
          // A response from a previous mount must not erase a newer pending edit.
          if (saved?.operationId === id)
            stored(`axp-pending:${retryKey}`, "null");
        } catch {
          /* Unavailable storage does not prevent an in-memory acknowledgement. */
        }
      }
    },
    [retryKey],
  );
  const sending = useRef(false);
  const send = async (
    session: string,
    action: WorkspaceCommand["action"],
  ): Promise<boolean> => {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    const key = JSON.stringify({ session, action });
    if (retry.current?.key !== key)
      retry.current = {
        key,
        command: {
          session,
          action,
          operationId: crypto.randomUUID(),
          startedAt: new Date().toISOString(),
        },
      };
    const attempt = retry.current;
    setPending(attempt.command);
    if (retryKey)
      stored(`axp-pending:${retryKey}`, JSON.stringify(attempt.command));
    try {
      await api("command", attempt.command);
      acknowledge(attempt.command.operationId);
      refresh();
      return true;
    } catch (failure) {
      if (retry.current === attempt)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not save this change",
        );
      refresh();
      return false;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return { send, busy, error, pending, acknowledge };
}
