import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiModelCard, AiModelHint, type LlmView } from "./AiModelCard";

const KEY = "sk-or-v1-abcdefabcdefabcdefabcdef";

function view(present: boolean, extra: Partial<LlmView["settings"]> = {}): LlmView {
  const settings = {
    provider: "cloud" as const,
    model: "anthropic/claude-haiku-5.5",
    cloud_agents: false,
    cloud_agent_frames: false,
    fallback_to_local: false,
    ...extra,
  };
  const cloud = present && settings.provider === "cloud";
  return {
    key: { present, error: null },
    settings,
    routes: {
      brand_research: cloud ? "openrouter" : "local",
      post_copy: cloud ? "openrouter" : "local",
      reference_pattern: cloud ? "openrouter" : "local",
      strategist_hypothesis: cloud ? "openrouter" : "local",
      learning_analyst: cloud && settings.cloud_agents ? "openrouter" : "local",
      agents: cloud && settings.cloud_agents ? "openrouter" : "local",
    },
    models: [
      { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", tier: "Fast", vision: true },
      { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", tier: "Quality", vision: true },
    ],
    spend: { calls: 3, cost_usd: 0.0042 },
  };
}

function serve(...replies: LlmView[]) {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
    const next = replies.length > 1 ? replies.shift()! : replies[0];
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AiModelCard", () => {
  it("shows local when no key is saved and saves a pasted key to Keychain", async () => {
    const calls = serve(view(false), view(true));
    render(<AiModelCard />);
    expect(await screen.findByText("No OpenRouter key saved.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Local/ }) as HTMLInputElement).checked).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add key" }));
    await user.type(screen.getByLabelText("OpenRouter key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("Key saved in Keychain ✓")).toBeTruthy();
    const put = calls.find(c => c.method === "PUT")!;
    expect(put.url).toBe("/api/llm-provider/key");
    expect(JSON.parse(put.body)).toEqual({ api_key: KEY });
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
  });

  it("states the data boundary on the clip-agent toggle and saves it", async () => {
    const calls = serve(view(true), view(true, { cloud_agents: true }));
    render(<AiModelCard />);
    const toggle = await screen.findByRole("checkbox", { name: /Use cloud model for clip agents too/ });
    expect(screen.getByText(/Sends transcript text and frame descriptions to OpenRouter\/Anthropic/)).toBeTruthy();
    expect(screen.getByText(/Cloud spend so far: \$0.0042 over 3 calls/)).toBeTruthy();
    await userEvent.setup().click(toggle);
    await waitFor(() => expect(calls.at(-1)!.body).toBe(JSON.stringify({ cloud_agents: true })));
    expect(await screen.findByRole("checkbox", { name: /Also send still frames/ })).toBeTruthy();
  });
});

describe("AiModelHint", () => {
  it("offers the cloud model when the local model is held and no key exists", async () => {
    serve(view(false));
    render(<AiModelHint kind="held" onRetry={() => undefined} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Use cloud model instead" }));
    expect(screen.getByLabelText("OpenRouter key")).toBeTruthy();
  });

  it("offers local or fixing the key when the key was rejected", async () => {
    const calls = serve(view(true), view(true, { provider: "local" }));
    const onRetry = vi.fn();
    render(<AiModelHint kind="cloud_key" onRetry={onRetry} />);
    expect(await screen.findByRole("button", { name: "Fix key" })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Use local model" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalled());
    expect(calls.at(-1)!.body).toBe(JSON.stringify({ provider: "local" }));
  });

  it("stays silent for other failures", () => {
    const calls = serve(view(false));
    const { container } = render(<AiModelHint kind="fetch" onRetry={() => undefined} />);
    expect(container.innerHTML).toBe("");
    expect(calls).toEqual([]);
  });
});
