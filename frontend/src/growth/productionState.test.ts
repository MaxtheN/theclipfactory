import { describe, expect, it } from "vitest";
import { changedEditFields, clipInScope, editErrors, jobInScope, readiness, retryBlocker, reviewBlocker } from "./productionState";
import type { Clip, Job, Model, TeamRun, Video } from "../types";
const scope={campaignId:"campaign-a",profileId:"profile-a",sourceIds:["source-a"]};
const source:Video={id:"source-a",name:"Source",duration:60,has_audio:true};
const ollama:Model={id:"ollama:vision",name:"Vision",kind:"llm",source:"ollama",vision:true,installed:true};
const job:Job={id:"job-a",kind:"render",status:"failed",context:{video_id:"source-a",campaign_id:"campaign-a",profile_id:"profile-a",attempt:1,plan:{start:0,end:30,framing:"fit",caption_style:"standard"}}};
const base={source,system:{ffmpeg:true,ffprobe:true,model_runtime:false},models:[ollama],jobs:[],modelId:ollama.id,approved:true,sourceAttached:true,subtitles:true,stale:false};

describe("real production readiness",()=>{
  it("allows manual no-caption rendering without an LLM but explains missing speech captions",()=>{
    expect(readiness({...base,models:[]}).canRender).toBe(false);
    expect(readiness({...base,models:[],subtitles:false}).canRender).toBe(true);
    expect(readiness({...base,models:[]}).manual.join()).toMatch(/transcript/);
  });
  it("allows a ready Ollama vision model with imported transcript without MLX",()=>{
    expect(readiness({...base,source:{...source,transcript:{segments:[]}}}).canProduce).toBe(true);
    expect(readiness(base).canProduce).toBe(false);
    for(const transcript of ["", [], {}]) expect(readiness({...base,source:{...source,transcript}}).canProduce).toBe(false);
    expect(readiness({...base,models:[{...ollama,vision:false}]}).agent.join()).toMatch(/video frames/);
  });
  it("keeps source work, stale reads and missing local media tools blocked",()=>{
    expect(readiness({...base,subtitles:false,jobs:[{...job,status:"running"}]}).canRender).toBe(false);
    expect(readiness({...base,subtitles:false,stale:true}).canRender).toBe(false);
    expect(readiness({...base,subtitles:false,system:{ffmpeg:true,ffprobe:false}}).canRender).toBe(false);
  });
});
describe("scope, edits and retries",()=>{
  it("does not mix another profile's jobs or clips into this review",()=>{
    expect(jobInScope(job,scope)).toBe(true);
    expect(jobInScope({...job,context:{...job.context as object,profile_id:"profile-b"}},scope)).toBe(false);
    expect(clipInScope({id:"clip",video_id:"source-a",campaign_id:"campaign-a",profile_id:"profile-b"} as Clip,scope)).toBe(false);
    const teamJob={...job,context:{video_id:"source-a",team_run_id:"run-a"}};
    const run={id:"run-a",context:{campaign_snapshot:{campaign_id:"campaign-a",profile_id:"profile-a"}}} as TeamRun;
    expect(jobInScope(teamJob,scope,[run])).toBe(true);
    expect(jobInScope({...teamJob,context:{...teamJob.context,campaign_id:"foreign",profile_id:"profile-a"}},scope,[run])).toBe(false);
  });
  it("enforces exact cold-open limits, real numeric input and total duration",()=>{
    const edit={start:"0",end:"30",opening:"cold_open" as const,coldStart:"40",coldEnd:"42",hook:"",focusX:.5};
    expect(editErrors(edit,60)).toEqual([]);
    expect(editErrors({...edit,coldEnd:"40.4"},60).join()).toMatch(/0.5 and 10/);
    expect(editErrors({...edit,start:""},60).join()).toMatch(/main range/);
    expect(editErrors({...edit,end:"179",coldStart:"0",coldEnd:"2"},200).join()).toMatch(/together/);
    expect(editErrors({...edit,opening:"text_overlay",hook:""},60).join()).toMatch(/opening text/);
  });
  it("requires concrete media changes rather than feedback or variant labels",()=>{
    const plan={start:0,end:30,hook:"Opening"};
    expect(changedEditFields(plan,{...plan,instructions:"Make it better",changed_variable:"opening"})).toEqual([]);
    expect(changedEditFields(plan,{...plan,start:2})).toEqual(["start"]);
  });
  it("bounds retry attempts and rejects existing successors or changed settings",()=>{
    const direction={framing:"fit",caption_style:"standard"};
    expect(retryBlocker(job,[job],scope,direction)).toBeNull();
    expect(retryBlocker({...job,context:{...job.context as object,attempt:3}},[job],scope,direction)).toMatch(/Three attempts/);
    expect(retryBlocker(job,[job,{...job,id:"child",context:{retry_of_job_id:job.id}}],scope,direction)).toMatch(/already/);
    expect(retryBlocker(job,[job],scope,{...direction,framing:"fill"})).toMatch(/settings changed/);
  });
  it("keeps team critique separate from human approval and pending work",()=>{
    const clip={id:"clip",video_id:"source-a",team_run_id:"run-a",team_review_status:"unknown"} as Clip;
    expect(reviewBlocker(clip,[],false)).toMatch(/critique/);
    expect(reviewBlocker({...clip,team_review_status:"pass"},[],false)).toBeNull();
    expect(reviewBlocker({...clip,team_review_status:"pass"},[{...job,status:"running",context:{clip_id:"clip"}}],false)).toMatch(/task/);
  });
});
