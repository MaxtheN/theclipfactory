import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebsiteBrief } from "./WebsiteBrief";
import {
  briefFromDraft,
  editableFrom,
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

function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes("reduce"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  // @ts-expect-error reset the jsdom default
  delete window.matchMedia;
});

describe("WebsiteBrief", () => {
  it("offers the website read and a skip", () => {
    const onSkip = vi.fn();
    render(<WebsiteBrief onApply={vi.fn()} onSkip={onSkip} client={client([])} />);
    expect(screen.getByRole("heading", { name: /Got a website\? We’ll draft your brand/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read my website" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your website address");
    fireEvent.click(screen.getByRole("button", { name: "Skip — I’ll type it" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("drives the animation from real stage events and ends in an editable draft", async () => {
    setReducedMotion(false);
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
    expect(container.querySelector(".gf-website-brief")).toHaveAttribute("data-motion", "full");
    expect(screen.getByTestId("wb-scan")).toBeInTheDocument();
    expect(await screen.findByText("Found 3 pages")).toBeInTheDocument();
    const chips = screen.getByRole("list", { name: "Pages" });
    expect(chips).toHaveTextContent("Home");
    expect(chips).toHaveTextContent("About");
    expect(await screen.findByText("Drafting your brief…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute("aria-valuenow", "70");
    expect(screen.getByRole("status")).toHaveTextContent("Drafting your brief…");

    expect(await screen.findByRole("heading", { name: /Here’s your brand/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Brand name")).toHaveValue("All-In");
    expect(screen.getByText(/couldn’t confirm your one-liner/)).toBeInTheDocument();
    expect(screen.getByText("Not confirmed — add your own")).toBeInTheDocument();
  });

  it("shows the verbatim quote and page behind a field", async () => {
    const api = client([research("done", [opening], { draft })]);
    render(<WebsiteBrief onApply={vi.fn()} onSkip={vi.fn()} client={api} pollMs={1} initialUrl="allin.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Read my website" }));
    await screen.findByLabelText("Who it’s for");
    const toggles = screen.getAllByRole("button", { name: "from your site" });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[1]);
    const note = screen.getByRole("note", { name: /Where your who it’s for came from/ });
    expect(note).toHaveTextContent("“for founders and investors”");
    expect(note).toHaveTextContent("About · allin.com/about");
    expect(toggles[1]).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close source" }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("applies the edited draft to onboarding and the first campaign brief", async () => {
    const onApply = vi.fn();
    const api = client([research("done", [opening], { draft })]);
    render(<WebsiteBrief onApply={onApply} onSkip={vi.fn()} client={api} pollMs={1} initialUrl="allin.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Read my website" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Read my website" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("robots.txt");
    fireEvent.click(screen.getByRole("button", { name: "Type it instead" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("uses a still illustration when reduced motion is preferred", async () => {
    setReducedMotion(true);
    const api = client([research("running", [opening, home], { waiting: true })]);
    const { container } = render(
      <WebsiteBrief onApply={vi.fn()} onSkip={vi.fn()} client={api} pollMs={5} initialUrl="allin.com" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Read my website" }));
    expect(await screen.findByText("Waiting for other work on this Mac to finish…")).toBeInTheDocument();
    expect(container.querySelector(".gf-website-brief")).toHaveAttribute("data-motion", "reduced");
    expect(screen.queryByTestId("wb-scan")).not.toBeInTheDocument();
  });

  it("cancels a running read when the creator stops", async () => {
    const onSkip = vi.fn();
    const api = client([research("running", [opening])]);
    render(<WebsiteBrief onApply={vi.fn()} onSkip={onSkip} client={api} pollMs={5} initialUrl="allin.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Read my website" }));
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
