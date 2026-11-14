import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Campaign, Profile } from "../types";
import { Onboarding } from "./Onboarding";
import type { Workspace } from "./useCampaignWorkspace";
import { WebsiteBrief, modelRouteText } from "./WebsiteBrief";
import type { LlmView } from "./AiModelCard";
import { workspaceApi } from "./workspaceApi";
import {
  briefFromDraft,
  editableFrom,
  websiteBriefApi,
  type BrandDraft,
  type Research,
  type ResearchEvent,
  type WebsiteBriefApi,
} from "./websiteBriefApi";

const draft: BrandDraft = {
  brand_name: "All-In",
  one_liner: "Four besties talk tech, markets and politics.",
  audience: "Founders and investors who follow tech and markets.",
  voice: {
    adjectives: ["candid", "funny", "sharp"],
    do: "Argue the point plainly.",
    dont: "Never sound like a press release.",
  },
  must_avoid: ["Investment advice"],
  key_messages: ["Smart people disagreeing in good faith"],
  topics: ["markets", "AI", "Investment advice"],
  suggested_goal: { objective: "traffic", metric: "full_episode_visits" },
  cta: { text: "Watch the full episode", link: "https://allin.com/episodes" },
  brand_kit: {
    primary_color: "#101010",
    accent_color: null,
    logo_url: "https://allin.com/logo.png",
    sources: { primary_color: "theme-color meta", logo_url: "og:image" },
  },
  social: [],
  evidence: [
    { field: "brand_name", quote: "Welcome to the All-In podcast", page_url: "https://allin.com/" },
    { field: "audience", quote: "for founders and investors", page_url: "https://allin.com/about" },
  ],
  dropped: ["one_liner"],
  pages: [
    { url: "https://allin.com/", label: "Home", title: "All-In Podcast" },
    { url: "https://allin.com/about", label: "About", title: "About" },
  ],
  source_url: "https://allin.com/",
};

const suggestedDraft: BrandDraft = {
  ...draft,
  must_avoid: [],
  cta: null,
  suggested_goal: null,
  evidence: draft.evidence,
  provenance: { brand_name: "from_site", audience: "from_site" },
  suggested: {
    must_avoid: ["Don't state allegations as fact", "No financial advice"],
    cta: { text: "Watch the full episode", link: "https://allin.com/episodes" },
    goal: { objective: "traffic", metric: "full_episode_visits", reason: "Every page points to full episodes" },
    provenance: "suggested_by_model",
  },
};

function llmView(route: "local" | "openrouter"): LlmView {
  return {
    key: { present: route === "openrouter", error: null },
    settings: {
      provider: route === "openrouter" ? "cloud" : "local",
      model: "anthropic/claude-haiku-5.5",
      cloud_agents: false,
      cloud_agent_frames: false,
      fallback_to_local: false,
    },
    routes: { brand_research: route } as LlmView["routes"],
    models: [{ id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", tier: "Fast", vision: true }],
    spend: { calls: 0, cost_usd: 0 },
  };
}

function research(status: Research["status"], events: ResearchEvent[], extra: Partial<Research> = {}): Research {
  return {
    id: "r1",
    url: "https://allin.com/",
    status,
    stage: events[events.length - 1]?.stage ?? "opening",
    progress: 30,
    events,
    draft: null,
    error: null,
    error_kind: null,
    waiting: false,
    timings: {},
    ...extra,
  };
}

const opening: ResearchEvent = { stage: "opening", label: "Opening allin.com", at: 0, host: "allin.com" };
const home: ResearchEvent = {
  stage: "reading",
  label: "Reading 'All-In Podcast'",
  at: 1,
  page: { url: "https://allin.com/", label: "Home", title: "All-In Podcast" },
};
const found: ResearchEvent = {
  stage: "found",
  label: "Found 3 pages (About, Shows)",
  at: 1.2,
  count: 3,
  labels: ["About", "Shows"],
};
const about: ResearchEvent = {
  stage: "reading",
  label: "Reading 'About'",
  at: 2,
  page: { url: "https://allin.com/about", label: "About", title: "About" },
};
const drafting: ResearchEvent = { stage: "drafting", label: "Drafting your brand brief", at: 3 };

function client(sequence: Research[]): WebsiteBriefApi & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    start: vi.fn(async (url: string) => {
      calls.push(`start ${url}`);
      return research("running", []);
    }),
    get: vi.fn(async () => {
      const value = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return value;
    }),
    cancel: vi.fn(async () => research("cancelled", [])),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebsiteBrief", () => {
  it("asks for the website plainly, with Continue disabled until there is one and a quiet skip", () => {
    const onSkip = vi.fn();
    const { container } = render(<WebsiteBrief onApply={vi.fn()} onSkip={onSkip} client={client([])} />);
    expect(screen.getByText("Before we start")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "What’s your website?" })).toBeInTheDocument();
    expect(screen.getByText("We’ll draft your brand from it. You can edit everything.")).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Continue" });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Your website" }), { target: { value: "not a site" } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    expect(screen.getByRole("alert")).toHaveTextContent("doesn’t look like a website address");
    // No illustration, no pill, no footnote, no em dashes in what the creator reads.
    expect(container.querySelector("svg.gf-wb-illustration, .gf-website-brief-kicker, .gf-wb-fineprint")).toBeNull();
    expect(container.textContent).not.toMatch(/—/);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("has no extra details panel on the website step", () => {
    const { container } = render(
      <WebsiteBrief onApply={vi.fn()} onSkip={vi.fn()} client={client([])} />,
    );
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText("How this works")).not.toBeInTheDocument();
  });

  it("describes the local route and an unknown route honestly", () => {
    expect(modelRouteText(llmView("local"), false)).toBe("Drafted by the model on this Mac.");
    expect(modelRouteText(null, true)).toBe("Drafted by the model chosen in AI model settings.");
    expect(modelRouteText(null, false)).toMatch(/Checking/);
  });

  it("shows real progress as one status line and a thin bar, then an editable draft", async () => {
    const api = client([
      research("running", [opening]),
      research("running", [opening, home, found]),
      research("running", [opening, home, found, about, drafting], { stage: "drafting", progress: 70 }),
      research("done", [opening, home, found, about, drafting], { draft, progress: 100 }),
    ]);
    const { container } = render(
      <WebsiteBrief onApply={vi.fn()} onSkip={vi.fn()} client={api} pollMs={5} />,
    );
    fireEvent.change(screen.getByPlaceholderText("yourshow.com"), { target: { value: "allin.com" } });
    fireEvent.keyDown(screen.getByPlaceholderText("yourshow.com"), { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "Reading allin.com" })).toBeInTheDocument();
    expect(api.calls).toEqual(["start allin.com"]);
    expect(await screen.findByText("Found 3 pages")).toBeInTheDocument();
    expect(await screen.findByText("Drafting your brief…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute("aria-valuenow", "70");
    expect(screen.getByRole("status")).toHaveTextContent(/^Drafting your brief…$/); // one line, not a log
    expect(container.querySelector(".gf-wb-browser, .gf-wb-scan, .gf-wb-chips, .gf-wb-steps")).toBeNull();

    expect(await screen.findByRole("heading", { name: "Your brand, drafted from your site" })).toBeInTheDocument();
    expect(screen.getByLabelText("Brand name")).toHaveValue("All-In");
    expect(screen.getByText(/couldn’t confirm your one-liner/)).toBeInTheDocument();
    expect(screen.getByText("Not confirmed. Add your own.")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/—/);
  });

  it("shows the verbatim quote and page behind a field", async () => {
    const api = client([research("done", [opening], { draft })]);
    render(<WebsiteBrief onApply={vi.fn()} onSkip={vi.fn()} client={api} pollMs={1} initialUrl="allin.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Who it’s for");
    const toggles = screen.getAllByRole("button", { name: "Source" });
    expect(toggles).toHaveLength(2);
    expect(toggles[1]).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggles[1]);
    const note = screen.getByRole("note", { name: /Where your who it’s for came from/ });
    expect(note).toHaveTextContent("“for founders and investors”");
    expect(note).toHaveTextContent("About, allin.com/about");
    expect(toggles[1]).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggles[1]);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("applies the edited draft to onboarding and the first campaign brief", async () => {
    const onApply = vi.fn();
    const api = client([research("done", [opening], { draft })]);
    render(<WebsiteBrief onApply={onApply} onSkip={vi.fn()} client={api} pollMs={1} initialUrl="allin.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const name = await screen.findByLabelText("Brand name");
    fireEvent.change(name, { target: { value: "All-In Podcast" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this brief" }));
    expect(onApply).toHaveBeenCalledOnce();
    const result = onApply.mock.calls[0][0];
    expect(result).toMatchObject({
      name: "All-In Podcast",
      audience: "Founders and investors who follow tech and markets.",
      objective: "traffic",
      metric: "full_episode_visits",
      brief: {
        key_messages: ["Smart people disagreeing in good faith"],
        must_include: ["markets", "AI"],
        must_avoid: ["Investment advice"],
        cta: "Watch the full episode",
        cta_link: "https://allin.com/episodes",
        tone: "candid, funny, sharp",
      },
    });
    expect(result.boundaries).toEqual([
      "Do: Argue the point plainly.",
      "Don't: Never sound like a press release.",
      "Avoid: Investment advice",
    ]);
    expect(result.voice).toBe("Candid, funny, sharp. Argue the point plainly.");
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        { field: "brand_name", value: "All-In Podcast", source: "edited" },
        { field: "audience", value: "Founders and investors who follow tech and markets.", source: "from_site" },
      ]),
    );
  });

  it("shows model suggestions apart, unticked, and records the ones accepted as suggested_by_model", async () => {
    const onApply = vi.fn();
    const api = client([research("done", [opening], { draft: suggestedDraft })]);
    render(<WebsiteBrief onApply={onApply} onSkip={vi.fn()} client={api} pollMs={1} initialUrl="allin.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const group = await screen.findByRole("region", { name: "Suggested" });
    expect(screen.getByRole("region", { name: "From your site" })).not.toContainElement(
      screen.getByText("No financial advice"),
    );
    expect(group).toHaveTextContent("Ideas from the model, not from your site.");
    expect(group).toHaveTextContent("Every page points to full episodes");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    boxes.forEach((box) => expect(box).not.toBeChecked());
    expect(screen.getByLabelText("Never touch")).toHaveValue("");

    fireEvent.click(screen.getByRole("checkbox", { name: /No financial advice/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Watch the full episode/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Drive full-episode visits/ }));
    expect(screen.getByLabelText("Never touch")).toHaveValue("No financial advice");
    expect(screen.getByLabelText("Call to action")).toHaveValue("Watch the full episode");
    expect(screen.getByLabelText("Goal")).toHaveValue("traffic");
    // Untick the goal: the creator's earlier choice comes back.
    fireEvent.click(screen.getByRole("checkbox", { name: /Drive full-episode visits/ }));
    expect(screen.getByLabelText("Goal")).toHaveValue("discovery");

    fireEvent.click(screen.getByRole("button", { name: "Use this brief" }));
    const result = onApply.mock.calls[0][0];
    expect(result.brief).toMatchObject({
      must_avoid: ["No financial advice"],
      cta: "Watch the full episode",
      cta_link: "https://allin.com/episodes",
    });
    expect(result.objective).toBe("discovery");
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        { field: "must_avoid", value: "No financial advice", source: "suggested_by_model" },
        { field: "cta", value: "Watch the full episode", source: "suggested_by_model" },
      ]),
    );
    expect(result.provenance.some((p: { source: string; field: string }) => p.field === "goal")).toBe(false);
    expect(result.brief.must_avoid).not.toContain("Don't state allegations as fact"); // never ticked
  });

  it("explains a failure plainly and offers to type it instead", async () => {
    const onSkip = vi.fn();
    const api = client([
      research("failed", [opening], {
        error: "allin.com asks automated readers not to open this page (robots.txt).",
        error_kind: "fetch",
      }),
    ]);
    render(<WebsiteBrief onApply={vi.fn()} onSkip={onSkip} client={api} pollMs={1} initialUrl="allin.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("robots.txt");
    fireEvent.click(screen.getByRole("button", { name: "Type it instead" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("says when it is waiting for other work on this Mac", async () => {
    const api = client([research("running", [opening, home], { waiting: true })]);
    render(<WebsiteBrief onApply={vi.fn()} onSkip={vi.fn()} client={api} pollMs={5} initialUrl="allin.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Waiting for other work on this Mac to finish…")).toHaveAttribute("role", "status");
  });

  it("cancels a running read when the creator stops", async () => {
    const onSkip = vi.fn();
    const api = client([research("running", [opening])]);
    render(<WebsiteBrief onApply={vi.fn()} onSkip={onSkip} client={api} pollMs={5} initialUrl="allin.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop and type it instead" }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("r1"));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

describe("briefFromDraft", () => {
  it("respects campaign brief limits and keeps boundaries over topics", () => {
    const edited = {
      ...editableFrom(draft),
      keyMessages: "One\n- one\nTwo\nThree\nFour\nFive\nSix",
      topics: "AI\nai\nInvestment advice\n" + "x".repeat(200),
      ctaLink: "javascript:alert(1)",
      objective: "unknown",
    };
    const result = briefFromDraft(edited, draft);
    expect(result.brief.key_messages).toEqual(["One", "Two", "Three", "Four", "Five"]);
    expect(result.brief.must_include).toEqual(["AI", "x".repeat(120)]);
    expect(result.brief.cta_link).toBeNull();
    expect(result.objective).toBe("discovery");
    expect(result.metric).toBe("");
    expect(result.brandKit?.primary_color).toBe("#101010");
  });
});

describe("onboarding step 1: your website", () => {
  it("prefills the questions and the first campaign brief, saving only at launch", async () => {
    vi.spyOn(websiteBriefApi, "start").mockResolvedValue(research("running", [opening]));
    vi.spyOn(websiteBriefApi, "get").mockResolvedValue(research("done", [opening], { draft }));
    const profile = vi
      .spyOn(workspaceApi, "profile")
      .mockResolvedValue({ id: "p1", name: "All-In" } as Profile);
    const save = vi
      .spyOn(workspaceApi, "save")
      .mockResolvedValue({ id: "c1", name: "All-In — main" } as Campaign);
    const w = {
      busy: false,
      loading: false,
      load: vi.fn().mockResolvedValue(undefined),
      setProfileId: vi.fn(),
    } as unknown as Workspace;
    render(<Onboarding w={w} onComplete={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "What’s your website?" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Continue" })).toHaveLength(1); // only the website step's
    fireEvent.change(screen.getByPlaceholderText("yourshow.com"), { target: { value: "allin.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this brief" }, { timeout: 3000 }));

    expect(await screen.findByRole("heading", { name: "Who are we making this for?" })).toBeInTheDocument();
    expect(screen.getByText(/Drafted from your website/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name your brand / podcast" })).toHaveValue("All-In");
    expect(screen.getByRole("textbox", { name: "Who are we speaking to?" })).toHaveValue(
      "Founders and investors who follow tech and markets.",
    );
    expect(profile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("radio", { name: /Drive full-episode visits/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("radio", { name: /Other/ })).toBeChecked();
    expect(screen.getByLabelText("Your creative direction")).toHaveValue(
      "Candid, funny, sharp. Argue the point plainly.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(profile.mock.calls[0][0].brand_context).toContain("Avoid: Investment advice");
    const body = save.mock.calls[0][0];
    expect(body).toMatchObject({ objective: "traffic", primary_metric: "full_episode_visits" });
    expect(body.brief).toMatchObject({
      audience: "Founders and investors who follow tech and markets.",
      key_messages: ["Smart people disagreeing in good faith"],
      must_include: ["markets", "AI"],
      must_avoid: ["Investment advice"],
      cta: "Watch the full episode",
      cta_link: "https://allin.com/episodes",
    });
  });

  it("skips straight to the typed questions", () => {
    render(
      <Onboarding
        w={{ busy: false, loading: false } as unknown as Workspace}
        onComplete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("heading", { name: "Who are we making this for?" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Name your brand / podcast" })).toHaveValue("");
  });
});
