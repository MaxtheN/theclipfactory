import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workspaceApi } from "./workspaceApi";
import type { Campaign, Observation, Profile, StrategyVersion } from "../types";

/** The selected workspace's approved Style-rules version (inherited by its campaigns). */
export function activeRulesId(w: {
  profiles: Profile[];
  profileId: string;
}): string | null {
  return w.profiles.find((p) => p.id === w.profileId)?.active_strategy_id ?? null;
}

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
  const campaign = useMemo(() => campaigns.find((c) => c.id === selected), [campaigns, selected]);
  // Read by the stable actions below without re-creating them on every change.
  const busyNow = useRef(busy);
  busyNow.current = busy;
  const loadingNow = useRef(loading);
  loadingNow.current = loading;
  const currentId = useRef(selected);
  currentId.current = selected;
  const currentProfile = useRef(profileId);
  currentProfile.current = profileId;
  // The workspace whose Style rules are currently loaded.
  const loadedProfile = useRef("");
  const load = useCallback(async (id = currentId.current, wanted = currentProfile.current) => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const [c, p] = await Promise.all([
        workspaceApi.campaigns(),
        workspaceApi.profiles(),
      ]);
      const target = c.some((v) => v.id === id) ? id : c[0]?.id || "";
      const ids = c.find((row) => row.id === target)?.profile_ids || [];
      const workspace = ids.includes(wanted) ? wanted : ids[0] || "";
      // Style rules belong to the workspace (profile); evidence stays with the campaign.
      const [v, o] = await Promise.all([
        workspace ? workspaceApi.strategies(workspace) : [],
        target ? workspaceApi.observations(target) : [],
      ]);
      if (!mounted.current || request !== generation.current) return;
      setCampaigns(c);
      setProfiles(p);
      setSelected(target);
      setVersions(v);
      setObservations(o);
      setError("");
      setProfileId(workspace);
      loadedProfile.current = workspace;
    } catch (e) {
      if (mounted.current && request === generation.current)
        setError(
          e instanceof Error ? e.message : "Unable to load this brand.",
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
  const select = useCallback(async (id: string) => {
    if (busyNow.current) return;
    setNotice("");
    await load(id).catch(() => {});
  }, [load]);
  /** Switch workspace: its own Style rules are loaded with it. */
  const chooseProfile = useCallback((id: string) => {
    setProfileId(id);
    currentProfile.current = id;
    if (id !== loadedProfile.current)
      void load(currentId.current, id).catch(() => {});
  }, [load]);
  const run = useCallback(async (
    task: () => Promise<unknown>,
    success: string,
    reloadId?: string,
  ) => {
    if (actionLock.current || loadingNow.current) return false;
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
  }, [load, refreshFactory]);
  const clearNotice = useCallback(() => setNotice(""), []);
  // One object per actual change, so screens can memoize on it.
  return useMemo(
    () => ({
      campaigns,
      profiles,
      versions,
      observations,
      campaign,
      profileId,
      setProfileId: chooseProfile,
      selected,
      select,
      loading,
      busy,
      error,
      notice,
      load,
      run,
      clearNotice,
    }),
    [campaigns, profiles, versions, observations, campaign, profileId, chooseProfile, selected, select, loading, busy, error, notice, load, run, clearNotice],
  );
}
export type Workspace = ReturnType<typeof useCampaignWorkspace>;
