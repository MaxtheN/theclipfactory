import { useRef, useState, type DragEvent } from "react";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { workspaceApi, reviewPreview } from "./workspaceApi";
import {
  Disclosure,
  Empty,
  Field,
  FieldGroup,
  Pill,
  Poster,
  PrimaryAction,
  formatTime,
} from "./parts";
import { Icon } from "./Icon";

export function Setup({
  w,
  factory,
  next,
  creating,
  onSaved,
}: {
  w: Workspace;
  factory: FactoryState;
  next: () => void;
  creating: boolean;
  onSaved: () => void;
}) {
  const campaign = creating ? undefined : w.campaign;
  const [name, setName] = useState(campaign?.name || "");
  const [audience, setAudience] = useState(campaign?.brief.audience || "");
  const [constraints, setConstraints] = useState(
    campaign?.brief.constraints.join("\n") ||
      "Preserve the speaker's meaning. Keep captions readable.",
  );
  const [goal, setGoal] = useState(
    campaign?.brief.measurement_intent || "Discovery",
  );
  const [selected, setSelected] = useState(
    campaign?.profile_ids || w.profiles.slice(0, 1).map((p) => p.id),
  );
  const [sourceIds, setSourceIds] = useState(campaign?.video_ids || []);
  const [profileName, setProfileName] = useState("");
  const [drag, setDrag] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const historical = new Set(campaign?.video_ids || []);
  const blocked =
    w.busy || w.loading || factory.loading || !!factory.errors.videos;
  async function importFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length || blocked) return;
    if (list.some((f) => !/\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(f.name))) {
      await w.run(async () => {
        throw new Error("Choose a supported video file, such as MP4 or MOV.");
      }, "");
      return;
    }
    await w.run(
      async () => {
        for (const file of list) {
          const v = await workspaceApi.upload(file);
          setSourceIds((old) => [...new Set([...old, v.id])]);
        }
      },
      reviewPreview
        ? "Source placeholders added. No file was uploaded or decoded in this preview."
        : "Footage imported. Add it to your campaign when you save.",
    );
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    setDrag(false);
    void importFiles(e.dataTransfer.files);
  }
  async function save() {
    if (!name.trim() || !selected.length || blocked) return;
    const body = {
      name: name.trim(),
      brief: {
        audience,
        constraints: constraints.split("\n").filter(Boolean),
        requested_outputs: ["Two vertical hook variants"],
        measurement_intent: goal,
      },
      profile_ids: [
        ...new Set([...(campaign?.profile_ids || []), ...selected]),
      ],
      video_ids: sourceIds,
    };
    let savedId = campaign?.id;
    const ok = await w.run(async () => {
      const c = await workspaceApi.save(body, campaign?.id);
      savedId = c.id;
      await w.load(c.id);
    }, "Campaign saved. Let's give the next edit a direction.");
    if (ok) {
      if (savedId) await w.select(savedId);
      onSaved();
      next();
    }
  }
  return (
    <div className="gf-setup-grid">
      <section className="gf-card gf-sources">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">SOURCE LIBRARY</span>
            <h2>Your footage</h2>
            <p>Select the sources for this campaign.</p>
          </div>
          <span className="gf-count">
            {sourceIds.length.toString().padStart(2, "0")}
          </span>
        </div>
        <div className="gf-source-list">
          {factory.data.videos.length === 0 && (
            <Empty title="Your next edit starts here">
              Add a local video to begin. Your originals stay intact.
            </Empty>
          )}
          {factory.data.videos.map((v, i) => (
            <label
              className={`gf-source ${sourceIds.includes(v.id) ? "selected" : ""}`}
              key={v.id}
            >
              <div className="gf-source-cover">
                {reviewPreview ? (
                  <Poster compact variant={i % 2} />
                ) : (
                  <Icon name="studio" size={30} />
                )}
              </div>
              <div className="gf-source-copy">
                <strong>{v.name}</strong>
                <span>
                  {reviewPreview
                    ? "Illustrative source"
                    : `${formatTime(v.duration)} · Local video`}
                </span>
                <Pill tone="quiet">
                  {reviewPreview ? "Sample" : "Imported"}
                </Pill>
              </div>
              <input
                aria-label={`Use ${v.name}`}
                type="checkbox"
                checked={sourceIds.includes(v.id)}
                disabled={blocked || historical.has(v.id)}
                onChange={(e) =>
                  setSourceIds((old) =>
                    e.target.checked
                      ? [...old, v.id]
                      : old.filter((id) => id !== v.id),
                  )
                }
              />
            </label>
          ))}
        </div>
        <input
          ref={upload}
          type="file"
          accept="video/*,.mp4,.mov,.mkv,.webm,.m4v,.avi"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void importFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          className={`gf-upload ${drag ? "dragging" : ""}`}
          disabled={blocked}
          onClick={() => upload.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={drop}
        >
          <span className="gf-upload-icon">
            <Icon name="upload" size={25} />
          </span>
          <strong>
            {w.busy ? "Adding your footage…" : "Drop your footage here"}
          </strong>
          <span>
            Drag a video here, or <u>browse files</u>
          </span>
          <small>
            {reviewPreview
              ? "Preview adds a placeholder; file contents stay unread"
              : "MP4, MOV and other supported video formats"}
          </small>
        </button>
        <div className="gf-source-footnote">
          <Icon name="lock" size={13} />
          {reviewPreview
            ? "Sample workspace. No access to your Mac or social accounts."
            : "Originals stay local. Nothing is published automatically."}
        </div>
      </section>
      <section className="gf-card gf-brief">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">CAMPAIGN BRIEF</span>
            <h2>Give it direction</h2>
            <p>A clear brief makes every edit more intentional.</p>
          </div>
        </div>
        <div className="gf-form-fields">
          <FieldGroup title="Campaign essentials">
            <Field label="Campaign name">
              {(id) => (
                <input
                  id={id}
                  maxLength={200}
                  placeholder="e.g. Founder stories · November"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field label="Who are we speaking to?">
              {(id) => (
                <input
                  id={id}
                  placeholder="Builders, founders and curious minds"
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                />
              )}
            </Field>
            <Field label="What are we working toward?">
              {(id) => (
                <select
                  id={id}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                >
                  {![
                    "Discovery",
                    "Full episode visits",
                    "Qualified engagement",
                    "Brand awareness",
                  ].includes(goal) && <option>{goal}</option>}
                  <option>Discovery</option>
                  <option>Full episode visits</option>
                  <option>Qualified engagement</option>
                  <option>Brand awareness</option>
                </select>
              )}
            </Field>
          </FieldGroup>
          <FieldGroup title="Profile & guardrails">
            <div className="gf-field">
              <span className="gf-label">
                Account context <span>local profiles</span>
              </span>
              <div className="gf-profile-options">
                {w.profiles.map((p) => (
                  <label
                    key={p.id}
                    className={selected.includes(p.id) ? "selected" : ""}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(p.id)}
                      disabled={blocked || campaign?.profile_ids.includes(p.id)}
                      onChange={(e) =>
                        setSelected((old) =>
                          e.target.checked
                            ? [...old, p.id]
                            : old.filter((i) => i !== p.id),
                        )
                      }
                    />
                    <Icon name="headphones" size={14} />
                    {p.name}
                    {selected.includes(p.id) && <Icon name="check" size={13} />}
                  </label>
                ))}
              </div>
            </div>
            <Disclosure title="Add an account profile" icon="plus">
              <Field label="Profile name">
                {(id) => (
                  <input
                    id={id}
                    placeholder="e.g. Founder stories"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                  />
                )}
              </Field>
              <button
                className="gf-button secondary compact"
                disabled={!profileName.trim() || blocked}
                onClick={() =>
                  void w.run(async () => {
                    const p = await workspaceApi.profile({
                      name: profileName.trim(),
                      audience,
                      objective: "discovery",
                      primary_metric: null,
                      brand_context: "",
                      creative_preferences: constraints,
                    });
                    setSelected((old) => [...old, p.id]);
                    setProfileName("");
                  }, "Local profile created. No social account was connected.")
                }
              >
                Create profile
                <Icon name="plus" size={14} />
              </button>
            </Disclosure>
            <Disclosure title="Brand guardrails" icon="lock">
              <Field label="What should every edit respect?">
                {(id) => (
                  <textarea
                    id={id}
                    value={constraints}
                    onChange={(e) => setConstraints(e.target.value)}
                    rows={3}
                  />
                )}
              </Field>
            </Disclosure>
          </FieldGroup>
        </div>
        <div className="gf-card-action">
          <span>
            {sourceIds.length
              ? `${sourceIds.length} source${sourceIds.length === 1 ? "" : "s"}. One clear direction.`
              : "You can save the brief before adding footage."}
          </span>
          <PrimaryAction
            label={w.busy ? "Saving…" : "Save & find direction"}
            hoverLabel="Let’s make this one count"
            disabled={blocked || !name.trim() || !selected.length}
            onClick={() => void save()}
          />
        </div>
      </section>
    </div>
  );
}
