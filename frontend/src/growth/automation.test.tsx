import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, post } from "../api";
import { AutomationPanel, parseAutomationState } from "./AutomationPanel";
import type { Workspace } from "./useCampaignWorkspace";
import type { FactoryState } from "../useFactory";

vi.mock("../api", () => ({ api: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("./workspaceApi", () => ({ reviewPreview: false }));
const blank = { policies: [], publications: [], snapshots: [], work: [], experiments: [] };
const workspace = { campaign: { id: "campaign" }, profileId: "profile" } as Workspace;
const factory = { data: { clips: [] } } as unknown as FactoryState;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api).mockImplementation(async path => path.endsWith("accounts") ? [
    { id: "mine", profile_id: "profile", display_name: "My podcast", status: "active" },
    { id: "foreign", profile_id: "other", display_name: "Other workspace", status: "active" },
  ] : blank);
});

it("rejects malformed saved learning state and unscoped work", () => {
  expect(() => parseAutomationState({ ...blank, policies: [{ id: "bad" }] })).toThrow();
  expect(() => parseAutomationState({ ...blank, work: [{ id: "bad" }] })).toThrow();
  expect(parseAutomationState(blank)).toEqual(blank);
});

it("keeps hidden learning panels idle and filters accounts to the workspace", async () => {
  const view = render(<AutomationPanel w={workspace} factory={factory} visible={false} />);
  expect(api).not.toHaveBeenCalled();
  view.rerender(<AutomationPanel w={workspace} factory={factory} visible />);
  await screen.findByRole("option", { name: "My podcast" });
  expect(screen.queryByRole("option", { name: "Other workspace" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start the loop" })).toBeDisabled();
});

it("saves an exact-account policy once while a request is pending", async () => {
  let resolve: (value: unknown) => void = () => {};
  vi.mocked(post).mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<AutomationPanel w={workspace} factory={factory} visible />);
  await screen.findByRole("option", { name: "My podcast" });
  fireEvent.change(screen.getByLabelText("Instagram account"), { target: { value: "mine" } });
  const start = screen.getByRole("button", { name: "Start the loop" });
  fireEvent.click(start); fireEvent.click(start);
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith("/api/automation/policies", expect.objectContaining({ account_id: "mine", profile_id: "profile", auto_drafts: true, cadence_days: 3 }));
  resolve({ id: "saved" });
  await waitFor(() => expect(start).toBeEnabled());
});

it("disables mutations when state cannot be refreshed", async () => {
  vi.mocked(api).mockRejectedValue(new Error("Service unavailable"));
  render(<AutomationPanel w={workspace} factory={factory} visible />);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Connect this workspace" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(post).not.toHaveBeenCalled();
});
