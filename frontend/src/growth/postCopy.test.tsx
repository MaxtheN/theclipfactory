import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PostClip } from "./PostClip";
import { publishApi, type PostTargets, type QualityReport } from "./publishApi";
import { postCopyApi, type PostCopy } from "./referencesApi";

const SHA = "b".repeat(64);
const pass: QualityReport = {
  clip_id: "c1", sha256: SHA, verdict: "pass", reasons: [], checks: [],
  rubric: { hook_clarity: null, standalone_context: 5, caption_legibility: 5, technical: 5 },
};
const targets: PostTargets = {
  accounts: [{ id: "acct-1", display_name: "brand", platform: "instagram", platform_label: "Instagram", publishing_permitted: true }],
  cloud_configured: true, signed_in: true, publishing_enabled: true, attempts: [],
  default_caption: "Default caption",
};
const copy = (over: Partial<PostCopy> = {}): PostCopy => ({
  caption: "Most founders hire too early.\n\nGet the checklist — link in bio.\n\n#founders", hashtags: ["founders"],
  source: "template", label: "Template (no model): hook, quote, CTA", model_id: null,
  fallback_reason: "Not generated yet: template shown.", checks: [], generated_at: "now", ...over,
});
const clip = { id: "c1", approved: true, sha256: SHA, hook: "Hook", caption: "" };

beforeEach(() => {
  vi.spyOn(publishApi, "quality").mockResolvedValue(pass);
  vi.spyOn(publishApi, "targets").mockResolvedValue(targets);
});
afterEach(() => vi.restoreAllMocks());

describe("Post copy in Post to Instagram", () => {
  it("prefills the caption with saved copy and labels a template fallback", async () => {
    vi.spyOn(postCopyApi, "get").mockResolvedValue({ clip_id: "c1", post_copy: copy(), job: null });
    render(<PostClip clip={clip} />);
    const field = await screen.findByLabelText("Caption");
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toContain("link in bio"));
    expect(screen.getByText(/Template \(no model\)/)).toBeTruthy();
  });

  it("keeps the person's own edits and regenerates only on request", async () => {
    vi.spyOn(postCopyApi, "get")
      .mockResolvedValueOnce({ clip_id: "c1", post_copy: copy(), job: null })
      .mockResolvedValueOnce({ clip_id: "c1", post_copy: copy({ caption: "Model copy", source: "model", label: "Written by the local model", model_id: "ollama:qwen3-vl:4b-instruct", fallback_reason: null }), job: { id: "j", status: "completed", message: "", error: null } });
    const regen = vi.spyOn(postCopyApi, "regenerate").mockResolvedValue({ clip_id: "c1", post_copy: copy(), job: { id: "j", status: "queued", message: "Queued", error: null } });
    render(<PostClip clip={clip} pollMs={1} />);
    const field = await screen.findByLabelText("Caption") as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toContain("link in bio"));
    fireEvent.change(field, { target: { value: "My own words" } });
    expect(field.value).toBe("My own words");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate caption" }));
    await waitFor(() => expect(field.value).toBe("Model copy"));
    expect(regen).toHaveBeenCalledWith("c1", "model");
    expect(screen.getByText("Written by the local model")).toBeTruthy();
  });
});
