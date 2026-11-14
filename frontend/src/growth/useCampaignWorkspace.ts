import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceApi } from "./workspaceApi";
import type { Campaign, Observation, Profile, StrategyVersion } from "../types";

function preference(key: string) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}
export function useCampaignWorkspace(refreshFactory: () => Promise<void>) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [selected, setSelected] = useState(() => preference("growth-campaign"));
  const [profileId, setProfileId] = useState(() =>
    preference("growth-profile"),
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true),
    generation = useRef(0),
    actionLock = useRef(false);
  const campaign = campaigns.find((c) => c.id === selected);
  const currentId = useRef(selected);
  currentId.current = selected;
  const load = useCallback(async (id = currentId.current) => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const [c, p] = await Promise.all([
        workspaceApi.campaigns(),
        workspaceApi.profiles(),
      ]);
      const target = c.some((v) => v.id === id) ? id : c[0]?.id || "";
      const [v, o] = target
        ? await Promise.all([
            workspaceApi.strategies(target),
            workspaceApi.observations(target),
          ])
        : [[], []];
      if (!mounted.current || request !== generation.current) return;
      setCampaigns(c);
      setProfiles(p);
      setSelected(target);
      setVersions(v);
      setObservations(o);
      setError("");
      const ids = c.find((row) => row.id === target)?.profile_ids || [];
      setProfileId((old) => (ids.includes(old) ? old : ids[0] || ""));
    } catch (e) {
      if (mounted.current && request === generation.current)
        setError(
          e instanceof Error ? e.message : "Unable to load this workspace.",
        );
      throw e;
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load().catch(() => {});
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    try {
      localStorage.setItem("growth-campaign", selected);
      localStorage.setItem("growth-profile", profileId);
    } catch {
      /* optional preferences */
    }
  }, [selected, profileId]);
  async function select(id: string) {
    if (busy) return;
    setNotice("");
    await load(id).catch(() => {});
  }
  async function run(
    task: () => Promise<unknown>,
    success: string,
    reloadId?: string,
  ) {
    if (actionLock.current || loading) return false;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      await Promise.all([load(reloadId), refreshFactory()]);
      if (mounted.current) setNotice(success);
      return true;
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : "The operation failed. Your draft is still here.",
        );
      return false;
    } finally {
      actionLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return {
    campaigns,
    profiles,
    versions,
    observations,
    campaign,
    profileId,
    setProfileId,
    selected,
    select,
    loading,
    busy,
    error,
    notice,
    load,
    run,
    clearNotice: () => setNotice(""),
  };
}
export type Workspace = ReturnType<typeof useCampaignWorkspace>;
