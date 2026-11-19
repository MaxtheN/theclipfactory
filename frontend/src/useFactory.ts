import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { setPlatformOs } from "./platform";
import type { Data, Resource } from "./types";
const initial: Data = {
  system: null,
  settings: null,
  models: [],
  jobs: [],
  videos: [],
  clips: [],
  instagram: null,
  analytics: null,
  factory: null,
};
const paths: Record<Resource, string> = {
  system: "/api/system",
  settings: "/api/settings",
  models: "/api/models",
  jobs: "/api/jobs",
  videos: "/api/videos",
  clips: "/api/clips",
  instagram: "/api/instagram/status",
  analytics: "/api/analytics",
  factory: "/api/factory",
};
const polling: Resource[] = [
  "factory",
  "jobs",
  "videos",
  "clips",
  "models",
  "instagram",
  "analytics",
];
export function useFactory() {
  const [data, setData] = useState<Data>(initial);
  const [errors, setErrors] = useState<Partial<Record<Resource, string>>>({});
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const inflight = useRef(new Set<Resource>());
  const actionLock = useRef(false);
  const refresh = useCallback(
    async (resources: Resource[] = Object.keys(paths) as Resource[]) => {
      await Promise.all(
        resources.map(async (key) => {
          if (inflight.current.has(key)) return;
          inflight.current.add(key);
          try {
            const value = await api<unknown>(paths[key]);
            const list = ["models", "jobs", "videos", "clips"].includes(key);
            if (
              list
                ? !Array.isArray(value) ||
                  value.some(
                    (row) =>
                      !row ||
                      typeof row !== "object" ||
                      typeof row.id !== "string",
                  )
                : !value || typeof value !== "object" || Array.isArray(value)
            )
              throw new Error(`Invalid ${key} response from local service.`);
            if (mounted.current) {
              // Wording, shortcuts and setup steps follow the OS the local service reports.
              if (key === "system") setPlatformOs((value as { os?: unknown }).os);
              setData((old) => ({ ...old, [key]: value }));
              setErrors((old) => {
                const next = { ...old };
                delete next[key];
                return next;
              });
            }
          } catch (error) {
            if (mounted.current)
              setErrors((old) => ({
                ...old,
                [key]:
                  error instanceof Error ? error.message : "Request failed.",
              }));
          } finally {
            inflight.current.delete(key);
          }
        }),
      );
      if (mounted.current) setLoading(false);
    },
    [],
  );
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh(polling);
    }, 4000);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);
  const run = useCallback(
    async (task: () => Promise<unknown>, message: string): Promise<boolean> => {
      if (actionLock.current) return false;
      actionLock.current = true;
      setBusy(true);
      setActionError("");
      setNotice("");
      try {
        await task();
        if (mounted.current) setNotice(message);
        return true;
      } catch (error) {
        if (mounted.current)
          setActionError(
            error instanceof Error ? error.message : "Action failed.",
          );
        return false;
      } finally {
        await refresh();
        actionLock.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [refresh],
  );
  return {
    data,
    errors,
    loading,
    notice,
    actionError,
    busy,
    refresh,
    run,
    dismiss: () => {
      setNotice("");
      setActionError("");
    },
  };
}
export type FactoryState = ReturnType<typeof useFactory>;
