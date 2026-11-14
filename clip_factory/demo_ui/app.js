const $ = (id) => document.getElementById(id);
const profileId = new URLSearchParams(location.search).get('profile_id');
const endpoint = profileId ? `/api/demo-loop/${encodeURIComponent(profileId)}/simulate` : '/api/demo';
const stageTitles = ['Inspect the quality rubric', 'Observe the measurement window', 'Choose the next experiment', 'Hand off the next creative plan'];
let data = null, cursor = 0, selected = 0, timer = null, request = null;
const fmt = (value, rate = false) => value == null ? 'Unknown' : rate ? `${(value * 100).toFixed(1)}%` : Math.round(value).toLocaleString();
function pause() { clearInterval(timer); timer = null; $('play').textContent = 'Play'; }
function text(id, value) { $(id).textContent = value; }
function row(parent, values, cls='') { const r=document.createElement('div'); r.className=cls; for(const value of values){const el=document.createElement('span');el.textContent=value;r.append(el);}parent.append(r); }
function render() {
  if(!data) return;
  const round=Math.floor(cursor/4), phase=cursor%4, loop=data.loops[round], pair=loop.pairs[selected];
  text('loop-label', `Loop ${loop.number} of ${data.loops.length} · synthetic day ${loop.synthetic_day}`);
  text('stage-title', stageTitles[phase]);
  $('progress').setAttribute('aria-valuenow', String(cursor+1));$('progress').setAttribute('aria-valuemax',String(data.loops.length*4));$('progress').firstElementChild.style.width=`${100*(cursor+1)/(data.loops.length*4)}%`;
  [...document.querySelectorAll('.stages li')].forEach((el,i)=>el.classList.toggle('active',i===phase));
  $('previous').disabled=cursor===0; $('next').disabled=cursor===data.loops.length*4-1;
  $('clips').replaceChildren();loop.pairs.forEach((p,i)=>{const b=document.createElement('button');b.type='button';b.textContent=`Reel ${i+1} · ${p.before.topic}`;b.setAttribute('aria-pressed',String(selected===i));b.onclick=()=>{selected=i;render();};$('clips').append(b);});
  const narration=[
    'The production rubric exposes its weights. Here, a long hook is a visible weakness; the proposed hook changes only that one field.',
    data.scenario==='sparse'?'The synthetic measurement window has not elapsed. Missing outcomes stay unknown; the system must wait.':'Synthetic Instagram observations are now available. The quality score and audience outcome are separate evidence sources.',
    'The real backend comparator checks the declared metric, known counts, minimum sample and complete window. It may favor either plan, abstain, or find no clear difference.',
    'A simulated reviewer may accept a next plan. This is not a rendered video, a real human approval, an automatic publication, or proof of improvement.'
  ];text('narration',narration[phase]);
  text('before-hook',pair.before.hook);text('after-hook',pair.after.hook);text('before-score',pair.quality_before.score);text('after-score',pair.quality_after.score);
  $('rubric').replaceChildren();row($('rubric'),['Dimension · weight','Current','Proposed'],'rubric-row head');pair.quality_before.dimensions.forEach((dim,i)=>row($('rubric'),[`${dim.label} · ${Math.round(dim.weight*100)}%`,`${dim.points} pts`,`${pair.quality_after.dimensions[i].points} pts`],'rubric-row'));
  text('source',pair.before.synthetic_transcript);text('plan-diff',JSON.stringify({changed_variable:'hook',before:pair.before.plan,after:pair.after.plan},null,2));
  $('metrics-pending').hidden=phase>=1;$('metrics').hidden=phase<1;$('decision').hidden=phase<2;$('next-plan').hidden=phase<3;
  const ev=pair.evaluation, rate=data.metric!=='views';text('metric-before',fmt(ev.before_value,rate));text('metric-after',fmt(ev.after_value,rate));text('metric-label',`${data.metric.replaceAll('_',' ')} · declared 3-day window · minimum 100 views per reel`);
  $('counts').replaceChildren();for(const key of ['views','likes','comments','shares','saves','completions','link_clicks']){const tr=document.createElement('tr');for(const value of [key.replaceAll('_',' '),fmt(pair.observations[0].metrics[key]),fmt(pair.observations[1].metrics[key])]){const cell=document.createElement('td');cell.textContent=value;tr.append(cell);}$('counts').append(tr);}
  const titles={insufficient_evidence:'Wait for sufficient evidence',no_clear_difference:'Keep testing: no clear difference',favors_variant:'Evidence favors the proposed plan',favors_parent:'Evidence favors the current plan'};
  text('decision-title',titles[ev.status]||ev.status);text('decision-reason',(ev.reasons||[]).join(' ')||'Use this as a bounded next test, not proof of causality.');
  text('next-title',pair.next_action==='simulate_reviewer_accepts_plan'?'A revised plan, ready for a real render.':pair.next_action==='wait'?'Wait. Keep the approved direction.':'Keep the current plan. Explore another test.');
  text('next-detail',`Next hook: “${pair.next_plan.hook}” Source, duration, framing and captions remain fixed. Quality proxy change for the proposal: ${pair.quality_difference>0?'+':''}${pair.quality_difference} points.`);
  text('lineage',JSON.stringify({group_id:pair.id,evidence:pair.proposal.evidence_ids,proposal_id:pair.proposal.id,parent_clip_id:pair.before.id,proposed_clip_id:pair.after.id,evaluation:ev,next_action:pair.next_action,simulated_reviewer:pair.simulated_reviewer,render:pair.render},null,2));
  const replay=data.strategist_replay,last=replay.steps.at(-1);text('strategist-summary',`${replay.steps.length} synthetic posts replayed. ${last.beliefs.length} candidate beliefs tracked. Model calls: zero. All proposals remain inside temporary simulation state.`);text('strategist',JSON.stringify({banner:replay.banner,last_step:last,model:replay.model,caveat:replay.caveat},null,2));text('assumptions',JSON.stringify(data.synthetic_truth,null,2));text('version',data.schema);
}
async function load(event) {
  event?.preventDefault();pause();request?.abort();request=new AbortController();$('error').hidden=true;
  for(const b of document.querySelectorAll('button')) b.disabled=true;
  try{const reply=await fetch(endpoint,{credentials:'same-origin',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seed:Number($('seed').value),rounds:3,scenario:$('scenario').value,metric:$('metric').value}),signal:request.signal});if(!reply.ok)throw new Error('The rehearsal could not be generated. Check the seed and try again.');data=await reply.json();cursor=0;selected=0;render();}
  catch(error){if(error.name!=='AbortError'){text('error',error.message);$('error').hidden=false;}}
  finally{for(const b of document.querySelectorAll('button')) b.disabled=false;if(data)render();}
}
$('controls').addEventListener('submit',load);$('scenario').addEventListener('change',load);$('metric').addEventListener('change',load);
$('previous').onclick=()=>{pause();cursor=Math.max(0,cursor-1);render();};$('next').onclick=()=>{pause();cursor=Math.min(data.loops.length*4-1,cursor+1);render();};$('play').onclick=()=>{if(timer){pause();return;}if(cursor===data.loops.length*4-1)cursor=0;timer=setInterval(()=>{if(cursor>=data.loops.length*4-1){pause();return;}cursor++;render();},2400);$('play').textContent='Pause';render();};
load();
