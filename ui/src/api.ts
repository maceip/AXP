import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContributionDetail,
  WorkspaceCommand,
  WorkspaceView,
} from "../../src/workspace-contract.js";

const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has("access")) {
  sessionStorage.setItem("axp-access", fragment.get("access")!);
  history.replaceState(null, "", location.pathname + location.search);
}
function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${sessionStorage.getItem("axp-access") ?? ""}`,
  };
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

export function useWorkspace(session: string | null) {
  const [workspace, setWorkspace] = useState<WorkspaceView>();
  const [detail, setDetail] = useState<ContributionDetail>();
  const [error, setError] = useState<string>();
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
      void Promise.all([
        api<WorkspaceView>("workspace", undefined, controller.signal),
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
          setWorkspace(view);
          setDetail(selected);
          setError(undefined);
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted)
            setError(
              failure instanceof Error
                ? failure.message
                : "Workspace unavailable",
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
  }, [session]);
  return {
    workspace,
    detail: detail?.contribution.id === session ? detail : undefined,
    error,
    refresh,
  };
}

/** Keep the same operation ID and timestamp when retrying an uncertain submission. */
export function useCommand(refresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const retry = useRef<{ key: string; command: WorkspaceCommand } | null>(null);
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
    try {
      await api("command", retry.current.command);
      retry.current = null;
      refresh();
      return true;
    } catch (failure) {
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
  return { send, busy, error };
}
