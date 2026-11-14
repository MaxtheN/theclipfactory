import type { FactoryState } from '../useFactory';
import { Jobs } from '../components/Jobs';
import { Section, Unknown, ReadOnlyValue } from '../components/ui';
export function Dashboard({state,navigate}: {state: FactoryState; navigate: (tab: 'Library' | 'Factory' | 'Models' | 'Settings') => void}) {
  const {data,errors,loading} = state;
  const count = (key: 'videos'|'clips'|'models', value: number) => errors[key] || loading ? null : value;
  return <>
    <section className="hero"><div><p className="eyebrow">FROM LONG FORM TO THE RIGHT MOMENT</p><h2>Make something<br/>worth stopping for.</h2><p>Bring your footage. Find a story. Review every clip before it leaves your studio.</p><button onClick={() => navigate('Library')}>Import your first source <span aria-hidden="true">↗</span></button></div><div className="pipeline" aria-label="Production workflow">{['Source footage','Find the moment','Shape & subtitle','Review & publish'].map((step,index) => <div key={step}><span>0{index+1}</span>{step}<small>{['Local library','Model or manual','Vertical video','You decide'][index]}</small></div>)}</div></section>
    <div className="stat-grid"><div className="stat"><span>Source videos</span><strong><Unknown value={count('videos', data.videos.length)}/></strong><small>In your local library</small></div><div className="stat"><span>Rendered clips</span><strong><Unknown value={count('clips', data.clips.length)}/></strong><small>{errors.clips ? 'Unavailable' : `${data.clips.filter(c => c.approved).length} approved for publishing`}</small></div><div className="stat"><span>Installed models</span><strong><Unknown value={count('models', data.models.filter(m => m.installed === true).length)}/></strong><small>No cloud inference assumed</small></div></div>
    <div className="two-col"><Jobs state={state} compact/><Section title="Studio readiness" detail="Reported by the local service"><dl className="info-list">{(['platform','apple_silicon','memory_gb','free_disk_gb','ffmpeg','ffprobe','whisper','model_runtime','desktop'] as const).map(key => <div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd><ReadOnlyValue value={errors.system ? null : data.system?.[key]}/>{typeof data.system?.[key] === 'number' && !errors.system ? ' GB' : ''}</dd></div>)}</dl><button className="secondary" onClick={() => navigate('Models')}>Open model setup</button></Section></div>
  </>;
}
