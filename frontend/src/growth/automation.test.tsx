import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { api, post, put } from "../api";
import {
  AutomationPanel,
  parseAutomationState,
  parseLearningMemory,
  parseInstagramPosts,
} from "./AutomationPanel";
import type { Workspace } from "./useCampaignWorkspace";
import type { FactoryState } from "../useFactory";

vi.mock("../api", () => ({ api: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("./workspaceApi", () => ({ reviewPreview: false }));
const blank = {
  policies: [],
  publications: [],
  snapshots: [],
  work: [],
  experiments: [],
};
const workspace = {
  campaign: { id: "campaign" },
  profileId: "profile",
} as Workspace;
const factory = { data: { clips: [] } } as unknown as FactoryState;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith("accounts")
      ? [
          {
            id: "mine",
            profile_id: "profile",
            display_name: "My podcast",
            status: "active",
          },
          {
            id: "foreign",
            profile_id: "other",
            display_name: "Other workspace",
            status: "active",
          },
        ]
      : blank,
  );
});

it("rejects malformed saved learning state and unscoped work", () => {
  expect(() =>
    parseAutomationState({ ...blank, policies: [{ id: "bad" }] }),
  ).toThrow();
  expect(() =>
    parseAutomationState({ ...blank, work: [{ id: "bad" }] }),
  ).toThrow();
  expect(parseAutomationState(blank)).toEqual(blank);
});

it("keeps hidden learning panels idle and filters accounts to the workspace", async () => {
  const view = render(
    <AutomationPanel w={workspace} factory={factory} visible={false} />,
  );
  expect(api).not.toHaveBeenCalled();
  view.rerender(<AutomationPanel w={workspace} factory={factory} visible />);
  await screen.findByRole("option", { name: "My podcast" });
  expect(
    screen.queryByRole("option", { name: "Other workspace" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start the loop" })).toBeDisabled();
});

it("saves an exact-account policy once while a request is pending", async () => {
  let resolve: (value: unknown) => void = () => {};
  vi.mocked(post).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<AutomationPanel w={workspace} factory={factory} visible />);
  await screen.findByRole("option", { name: "My podcast" });
  fireEvent.change(screen.getByLabelText("Instagram account"), {
    target: { value: "mine" },
  });
  const start = screen.getByRole("button", { name: "Start the loop" });
  fireEvent.click(start);
  fireEvent.click(start);
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(
    "/api/automation/policies",
    expect.objectContaining({
      account_id: "mine",
      profile_id: "profile",
      auto_drafts: true,
      cadence_days: 3,
    }),
  );
  resolve({ id: "saved" });
  await waitFor(() => expect(start).toBeEnabled());
});

it("disables mutations when state cannot be refreshed", async () => {
  vi.mocked(api).mockRejectedValue(new Error("Service unavailable"));
  render(<AutomationPanel w={workspace} factory={factory} visible />);
  await screen.findByRole("alert");
  expect(
    screen.getByRole("button", { name: "Connect this workspace" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(post).not.toHaveBeenCalled();
});

const catalogAccount = "ca_me";
const catalogProfile = "profile&part=1";
const catalogWorkspace = {
  campaign: { id: "campaign" },
  profileId: catalogProfile,
} as Workspace;
const catalogFactory = {
  data: {
    clips: [
      {
        id: "approved-clip",
        campaign_id: "campaign",
        profile_id: catalogProfile,
        video_id: "source",
        name: "Reviewed original",
        hook: "Approved opening",
        approved: true,
        sha256: "a".repeat(64),
      },
    ],
  },
} as unknown as FactoryState;
const catalogPost = {
  media_id: "123456",
  published_at: "2026-11-10T12:00:00Z",
  caption_excerpt: "A grounded published moment",
  permalink: "https://www.instagram.com/reel/verified-post/",
};

function mockCatalog(reply: unknown) {
  const policy = {
    id: "learning-policy",
    campaign_id: "campaign",
    profile_id: catalogProfile,
    account_id: catalogAccount,
    cadence_days: 3,
    enabled: true,
    auto_drafts: true,
    allowed_changes: ["hook", "duration"],
  };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/automation/state")
      return { ...blank, policies: [policy] };
    if (path === "/api/automation/accounts")
      return [
        {
          id: catalogAccount,
          profile_id: catalogProfile,
          display_name: "First creator",
          status: "active",
        },
        {
          id: "ca_other",
          profile_id: catalogProfile,
          display_name: "Second creator",
          status: "active",
        },
        {
          id: "ca_foreign",
          profile_id: "another-profile",
          display_name: "Foreign profile",
          status: "active",
        },
      ];
    if (path === "/api/automation/settings")
      return { configured: true, auth_config_id: "ac_demo" };
    if (
      path ===
      `/api/automation/accounts/${catalogAccount}/posts?profile_id=${encodeURIComponent(catalogProfile)}`
    )
      return reply;
    throw new Error(`Unexpected read in chooser test: ${path}`);
  });
}

async function openPostChooser() {
  await screen.findByRole("option", { name: "First creator" });
  fireEvent.change(screen.getByLabelText("Instagram account"), {
    target: { value: catalogAccount },
  });
  fireEvent.click(screen.getByText("Find a post from your Instagram account"));
}

async function findPosts() {
  fireEvent.click(screen.getByRole("button", { name: "Find recent posts" }));
  const use = await screen.findAllByRole("button", { name: "Use this post" });
  await waitFor(() => expect(use[0]).toBeEnabled());
  return use;
}

describe("recent Instagram post chooser", () => {
  it("bounds the catalog and preserves only safe canonical post links and short text", () => {
    const result = parseInstagramPosts(
      {
        connected_account_id: catalogAccount,
        items: [
          {
            ...catalogPost,
            caption_excerpt: "x".repeat(300),
            permalink: `${catalogPost.permalink}?utm_source=tracking#fragment`,
          },
        ],
      },
      catalogAccount,
    );
    expect(result).toEqual([
      { ...catalogPost, caption_excerpt: "x".repeat(160) },
    ]);
    expect(
      parseInstagramPosts(
        {
          connected_account_id: catalogAccount,
          items: Array.from({ length: 6 }, (_, i) => ({
            ...catalogPost,
            media_id: String(i + 1),
          })),
        },
        catalogAccount,
      ),
    ).toHaveLength(6);
    for (const items of [
      Array.from({ length: 7 }, (_, i) => ({
        ...catalogPost,
        media_id: String(i + 1),
      })),
      [catalogPost, catalogPost],
      [{ ...catalogPost, media_id: "1".repeat(101) }],
    ]) {
      expect(() =>
        parseInstagramPosts(
          { connected_account_id: catalogAccount, items },
          catalogAccount,
        ),
      ).toThrow();
    }
  });

  it.each([
    "javascript:alert(1)",
    "http://instagram.com/p/post/",
    "https://user:secret@instagram.com/p/post/",
    "https://instagram.com.evil.example/p/post/",
    "https://instagram.com:8443/reel/post/",
    "https://www.instagram.com/direct/inbox/",
  ])(
    "omits an unsafe optional permalink without turning it into a navigable link: %s",
    (permalink) => {
      const result = parseInstagramPosts(
        {
          connected_account_id: catalogAccount,
          items: [{ ...catalogPost, permalink }],
        },
        catalogAccount,
      );
      expect(result[0].permalink).toBeNull();
      expect(result[0].media_id).toBe(catalogPost.media_id);
    },
  );
  it("reads the exact account/profile route and choosing a post only fills media ID and resets mapping", async () => {
    mockCatalog({ connected_account_id: catalogAccount, items: [catalogPost] });
    render(
      <AutomationPanel w={catalogWorkspace} factory={catalogFactory} visible />,
    );
    await openPostChooser();
    fireEvent.click(screen.getByText("Track an existing published clip"));
    fireEvent.change(screen.getByLabelText("Approved clip"), {
      target: { value: "approved-clip" },
    });
    fireEvent.change(screen.getByLabelText("Selected post ID"), {
      target: { value: "999999" },
    });
    fireEvent.click(screen.getByLabelText("This post uses this exact clip"));
    expect(
      screen.getByLabelText("This post uses this exact clip"),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Track this post" }),
    ).toBeEnabled();
    const [use] = await findPosts();
    expect(api).toHaveBeenCalledWith(
      `/api/automation/accounts/${catalogAccount}/posts?profile_id=profile%26part%3D1`,
    );
    fireEvent.click(use);
    expect(screen.getByLabelText("Selected post ID")).toHaveValue(
      catalogPost.media_id,
    );
    expect(screen.getByLabelText("Approved clip")).toHaveValue("approved-clip");
    expect(
      screen.getByLabelText("This post uses this exact clip"),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Track this post" }),
    ).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(api)
        .mock.calls.every(
          ([path]) =>
            !path.includes("produce") &&
            !path.includes("inference") &&
            !path.includes("/check"),
        ),
    ).toBe(true);
  });

  it("renders safe catalog text and only Instagram HTTPS permalinks", async () => {
    const unsafeCaption = '<img src="x" onerror="alert(1)">';
    mockCatalog({
      connected_account_id: catalogAccount,
      items: [
        catalogPost,
        {
          ...catalogPost,
          media_id: "654321",
          caption_excerpt: unsafeCaption,
          permalink: "https://instagram.com.evil.example/reel/false",
        },
      ],
    });
    render(
      <AutomationPanel w={catalogWorkspace} factory={catalogFactory} visible />,
    );
    await openPostChooser();
    expect(await findPosts()).toHaveLength(2);
    expect(screen.getByText(catalogPost.caption_excerpt)).toBeInTheDocument();
    expect(screen.getByText(unsafeCaption)).toBeInTheDocument();
    expect(document.querySelector("img[onerror]")).toBeNull();
    const links = screen.getAllByRole("link", { name: /View on Instagram/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", catalogPost.permalink);
    expect(links[0]).toHaveAttribute("rel", "noreferrer");
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    { connected_account_id: "ca_foreign", items: [catalogPost] },
    { connected_account_id: catalogAccount, items: {} },
    { connected_account_id: catalogAccount, items: [null] },
    {
      connected_account_id: catalogAccount,
      items: [{ ...catalogPost, media_id: "not-a-numeric-media-id" }],
    },
    {
      connected_account_id: catalogAccount,
      items: [{ ...catalogPost, published_at: "not-a-time" }],
    },
  ])(
    "rejects wrong-account or malformed catalogs without a mapping or mutation (%j)",
    async (reply) => {
      mockCatalog(reply);
      render(
        <AutomationPanel
          w={catalogWorkspace}
          factory={catalogFactory}
          visible
        />,
      );
      await openPostChooser();
      fireEvent.click(
        screen.getByRole("button", { name: "Find recent posts" }),
      );
      await screen.findByRole("alert");
      expect(
        screen.queryByRole("button", { name: "Use this post" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Selected post ID")).toHaveValue("");
      expect(
        screen.getByLabelText("This post uses this exact clip"),
      ).not.toBeChecked();
      expect(post).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("clears the catalog, media ID and confirmation when the selected account changes", async () => {
    mockCatalog({ connected_account_id: catalogAccount, items: [catalogPost] });
    render(
      <AutomationPanel w={catalogWorkspace} factory={catalogFactory} visible />,
    );
    await openPostChooser();
    const [use] = await findPosts();
    fireEvent.click(use);
    fireEvent.click(screen.getByText("Track an existing published clip"));
    fireEvent.click(screen.getByLabelText("This post uses this exact clip"));
    expect(screen.getByLabelText("Selected post ID")).toHaveValue(
      catalogPost.media_id,
    );
    fireEvent.change(screen.getByLabelText("Instagram account"), {
      target: { value: "ca_other" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Selected post ID")).toHaveValue(""),
    );
    expect(
      screen.getByLabelText("This post uses this exact clip"),
    ).not.toBeChecked();
    expect(
      screen.queryByText(catalogPost.caption_excerpt),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use this post" }),
    ).not.toBeInTheDocument();
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(([path]) => path.includes("/posts?"))
        .map(([path]) => path),
    ).toEqual([
      `/api/automation/accounts/${catalogAccount}/posts?profile_id=${encodeURIComponent(catalogProfile)}`,
    ]);
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])(
    "ignores an older refresh %s after a newer visible-session response",
    async (outcome) => {
      let resolveOld: (value: unknown) => void = () => {};
      let rejectOld: (reason: Error) => void = () => {};
      const oldState = new Promise<unknown>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      let stateReads = 0;
      vi.mocked(api).mockImplementation(async (path) => {
        if (path === "/api/automation/state") {
          stateReads++;
          if (stateReads === 1) return oldState;
          return {
            ...blank,
            health: {
              status: "resource_hold",
              message: "Current verified health",
            },
          };
        }
        if (path === "/api/automation/accounts")
          return [
            {
              id: "current-account",
              profile_id: "profile",
              display_name: "Current creator",
              status: "active",
            },
          ];
        if (path === "/api/automation/settings") return { configured: true };
        throw new Error(`Unexpected call: ${path}`);
      });
      const view = render(
        <AutomationPanel w={workspace} factory={factory} visible />,
      );
      await waitFor(() => expect(stateReads).toBe(1));
      view.rerender(
        <AutomationPanel w={workspace} factory={factory} visible={false} />,
      );
      view.rerender(
        <AutomationPanel w={workspace} factory={factory} visible />,
      );
      await screen.findByText("Current verified health");
      await screen.findByRole("option", { name: "Current creator" });
      await act(async () => {
        if (outcome === "success")
          resolveOld({
            ...blank,
            health: {
              status: "resource_hold",
              message: "Stale discarded health",
            },
          });
        else rejectOld(new Error("Stale discarded failure"));
      });
      expect(screen.getByText("Current verified health")).toBeInTheDocument();
      expect(
        screen.queryByText("Stale discarded health"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    },
  );
});

describe("closed learning loop", () => {
  const policy = {
    id: "policy",
    campaign_id: "campaign",
    profile_id: "profile",
    account_id: "mine",
    cadence_days: 3,
    enabled: true,
    auto_drafts: true,
  };
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const digest = {
    profile_id: "profile",
    baseline: {
      posts: 2,
      snapshot_ids: ["s1", "s2"],
      metrics: {
        views: { median: 150, known_posts: 2 },
        likes: { median: null, known_posts: 0 },
      },
    },
    experiments: [
      {
        id: "exp",
        variable: "hook",
        before: "Original",
        after: "Clearer point",
        status: "completed",
        trigger: "demo_override",
        real_elapsed_hours: 2.5,
        outcome: { publication_id: "pv", snapshot_id: "sv" },
        proposed_strategy_version_id: "v2",
      },
    ],
    comparisons: [
      {
        experiment_id: "exp",
        variable: "hook",
        caveat: "Observational: not causal proof of lift.",
        metrics: { views: { parent: 100, variant: 140, difference: 40 } },
      },
    ],
    pending_rule_proposals: [
      { id: "v2", campaign_id: "campaign", version: 2, experiment_id: "exp" },
    ],
    truncated: false,
  };
  function mockLoop(memory: unknown = digest) {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/automation/state")
        return {
          ...blank,
          policies: [policy],
          publications: [
            {
              id: "pub",
              policy_id: "policy",
              media_id: "123",
              next_due_at: future,
              mapping_source: "User confirms exact clip",
            },
          ],
          snapshots: [
            {
              id: "snap",
              policy_id: "policy",
              source: "Composio Instagram media insights",
              collected_at: future,
              metrics: { views: 120 },
              trigger: "demo_override",
              real_elapsed_hours: 2.5,
            },
          ],
          experiments: [
            {
              id: "exp",
              policy_id: "policy",
              campaign_id: "campaign",
              profile_id: "profile",
              variable: "hook",
              status: "completed",
              trigger: "demo_override",
              real_elapsed_hours: 2.5,
              strategy_proposal: { status: "proposed" },
            },
          ],
        };
      if (path === "/api/automation/accounts") return [];
      if (path === "/api/automation/settings") return { configured: true };
      if (path.startsWith("/api/automation/memory?")) return memory;
      throw new Error(`Unexpected call: ${path}`);
    });
  }

  it("parses only the bounded digest and keeps unknown medians unknown", () => {
    expect(parseLearningMemory(blank)).toBeNull();
    expect(parseLearningMemory(null)).toBeNull();
    const parsed = parseLearningMemory(digest)!;
    expect(parsed.baseline).toEqual([
      { name: "views", median: 150, known: 2 },
      { name: "likes", median: null, known: 0 },
    ]);
    expect(parsed.experiments[0]).toMatchObject({
      before: "“Original”",
      after: "“Clearer point”",
      demo: true,
      demoHours: 2.5,
      measured: true,
    });
    expect(parsed.pending).toEqual([
      { id: "v2", version: 2, experimentId: "exp" },
    ]);
  });

  it("offers an explicit demo measurement and labels its results", async () => {
    mockLoop();
    vi.mocked(post).mockResolvedValue({
      status: "requested",
      trigger: "demo_override",
      real_elapsed_hours: 2.5,
    });
    render(<AutomationPanel w={workspace} factory={factory} visible />);
    const button = await screen.findByRole("button", {
      name: "Measure now (demo — window not elapsed)",
    });
    await waitFor(() => expect(button).toBeEnabled());
    expect(
      screen.getAllByText(/Demo override · measured 2.5 h after posting, not 3 days/),
    ).toHaveLength(2);
    expect(
      screen.getByText("Editing rule proposed · waiting for your approval"),
    ).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/automation/publications/pub/measure-now",
      ),
    );
    expect(
      await screen.findByText(/Metrics are real provider reads/),
    ).toBeInTheDocument();
    expect(
      vi.mocked(api).mock.calls.some(([path]) =>
        path.includes("memory?profile_id=profile&campaign_id=campaign"),
      ),
    ).toBe(true);
  });

  it("shows what was learned and links a waiting rule to Editing rules", async () => {
    mockLoop();
    const onEditingRules = vi.fn();
    render(
      <AutomationPanel
        w={workspace}
        factory={factory}
        visible
        onEditingRules={onEditingRules}
      />,
    );
    const panel = await screen.findByRole("region", {
      name: "What we've learned",
    });
    await within(panel).findByText(/median of 2 tracked posts/);
    expect(within(panel).getByText("Unknown")).toBeInTheDocument();
    expect(
      within(panel).getByText("Observational comparison · hook"),
    ).toBeInTheDocument();
    expect(within(panel).getByText("100 → 140 (+40)")).toBeInTheDocument();
    expect(
      within(panel).getByText("Observational: not causal proof of lift."),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText("Demo override · 2.5 h after posting"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(panel).getByRole("button", { name: "Review in Style rules" }),
    );
    expect(onEditingRules).toHaveBeenCalledTimes(1);
  });

  it("keeps controls usable when learning memory cannot be read", async () => {
    mockLoop("not a digest");
    render(<AutomationPanel w={workspace} factory={factory} visible />);
    expect(
      await screen.findByText("Learning memory is unavailable right now."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
