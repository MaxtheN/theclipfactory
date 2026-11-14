import { describe,expect,it } from "vitest";
import { applyLearningEdit,nextProductionMode,performanceRecommendations,campaignGoalBody } from "./learningState";
import type { Direction,Observation,TeamTask } from "../types";
const direction:Direction={angles:["One idea"],moment_selection:"Self-contained point",hooks:["Old opening","Other opening"],pacing:"Keep source context",duration_seconds:30,framing:"fit",caption_style:"standard",editing_preferences:"Readable captions",measurement_questions:[],next_experiments:[],evidence_refs:[],limitations:"Untested",confidence:"low"};
describe("evidence changes actual production direction",()=>{
  it("makes a concrete new opening without mutating saved direction",()=>{
    const next=applyLearningEdit(direction,{kind:"opening",value:"A more direct opening"});
    expect(next.hooks).toEqual(["A more direct opening","Other opening"]);
    expect(direction.hooks[0]).toBe("Old opening");expect(nextProductionMode(direction,next)).toBe("manual");
  });
  it("routes descriptive selection rules to the agent that can interpret them",()=>{
    const next=applyLearningEdit(direction,{kind:"selection",value:"Find a contrary claim with an immediate payoff."});
    expect(nextProductionMode(direction,next)).toBe("agent");
    expect(nextProductionMode(direction,applyLearningEdit(direction,{kind:"duration",value:24}))).toBe("manual");
    expect(()=>applyLearningEdit(direction,{kind:"duration",value:181})).toThrow(/duration/);
  });
  it("builds a campaign's own goal: discovery needs no metric, other goals need one",()=>{
    expect(campaignGoalBody("traffic"," full_episode_visits ")).toEqual({objective:"traffic",primary_metric:"full_episode_visits"});
    expect(campaignGoalBody("discovery","ignored")).toEqual({objective:"discovery",primary_metric:null});
    expect(()=>campaignGoalBody("traffic","")).toThrow(/metric/);
    expect(()=>campaignGoalBody("invented","x")).toThrow(/objective/);
  });
  it("retains cited recommendations and separates preferences from known audience observations",()=>{
    const task={id:"t",role:"performance_analyst",status:"completed",output:{recommendations:[{recommendation:"Try a direct opening",limitation:"Observational only",evidence_refs:["event:o-a","feedback:f-a","event:unknown","event:o-null","observation:o-a"]}]}} as unknown as TeamTask;
    const rows=performanceRecommendations(task,[{id:"o-a",value:12},{id:"o-null",value:null}] as Observation[]);
    expect(rows[0].observationIds).toEqual(["o-a"]);
    expect(rows[0].otherEvidenceRefs).toEqual(["feedback:f-a","event:unknown","event:o-null","observation:o-a"]);
    expect(performanceRecommendations({...task,status:"skipped"},[])).toEqual([]);
  });
});
