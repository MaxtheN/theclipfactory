import { useRef, useState } from 'react';
import { api, endpoint, post, remove } from '../api';
import type { FactoryState } from '../useFactory';
import { Empty, Badge, Section, duration, ReadOnlyValue } from '../components/ui';
export function Transcript({ value }: {value: unknown}) {
  if (value === undefined || value === null || value === '') return <p className="muted">No transcript yet. Queue transcription to create one locally.</p>;
  if (typeof value === 'string') return <p className="transcript">{value}</p>;
  if (typeof value === 'object' && !Array.isArray(value) && 'text' in value && typeof value.text === 'string') return <p className="transcript">{value.text}</p>;
  return <ReadOnlyValue value={value}/>;
}
export function Library({state,onEdit}: {state: FactoryState; onEdit: () => void}) {
  const [selected,setSelected] = useState('');
  const [dragging,setDragging] = useState(false);
  const [uploadError,setUploadError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const video = state.data.videos.find(v => v.id === selected) || state.data.videos[0];
  async function upload(files: FileList | File[]) {
    const all = Array.from(files);
    setUploadError('');
    if (!all.length) return;
    if (all.some(file => !file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name))) { setUploadError('Choose video files (MP4, MOV, M4V, WebM, MKV, or AVI).'); return; }
    await state.run(async () => { for (const file of all) { const form = new FormData(); form.append('file',file); await api('/api/videos',{method:'POST',body:form}); } }, `${all.length} source file${all.length === 1 ? '' : 's'} imported.`);
    if (input.current) input.current.value = '';
  }
  return <>
    <section className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!state.busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!state.busy) void upload(event.dataTransfer.files); }} aria-label="Video upload drop area" aria-busy={state.busy}>
      <span className="upload-symbol" aria-hidden="true">↥</span><div><h2>Bring your footage into the studio</h2><p>Drop video files here, or choose from your machine. Originals stay local.</p><small>MP4, MOV, M4V, WebM, MKV, AVI · Multiple files supported</small></div><button disabled={state.busy} onClick={() => input.current?.click()}>{state.busy ? 'Working…' : 'Choose video files'}</button><input ref={input} type="file" multiple accept="video/*,.mkv,.avi" className="visually-hidden" aria-label="Upload video files" disabled={state.busy} onChange={event => { if (event.target.files) void upload(event.target.files); }}/>
    </section>{uploadError && <p role="alert" className="error-text">{uploadError}</p>}
    {!state.data.videos.length ? <Empty title="Your library starts here">Import a video to preview the source, generate a transcript, and create your first clip.</Empty> : <div className="library-layout"><Section title="Source library" detail={`${state.data.videos.length} local sources`}><div className="source-list">{state.data.videos.map(item => <button key={item.id} className={`source-item ${video?.id === item.id ? 'selected' : ''}`} aria-pressed={video?.id === item.id} onClick={() => setSelected(item.id)}><span className="source-thumbnail" aria-hidden="true">▷</span><span><strong>{item.name}</strong><small>{duration(item.duration)} · {typeof item.size === 'number' ? `${(item.size/1024/1024).toFixed(1)} MB` : 'Unknown size'}</small></span><Badge>{item.status || 'Unknown'}</Badge></button>)}</div></Section>
      {video && <Section title={video.name} detail="Original source"><video key={video.id} controls preload="metadata" src={endpoint('videos',video.id,'media')} className="source-player" aria-label={`Preview ${video.name}`}/><div className="row metadata"><span>{duration(video.duration)}</span><span>{typeof video.width === 'number' && typeof video.height === 'number' ? `${video.width} × ${video.height}` : 'Unknown resolution'}</span></div><div className="actions"><button disabled={state.busy} onClick={() => void state.run(() => post(endpoint('videos',video.id,'transcribe')), 'Transcription queued. Watch the production queue for progress.')}>Transcribe locally</button><button className="secondary" onClick={onEdit}>Open clip editor</button><button className="danger-button" disabled={state.busy} onClick={() => { if (window.confirm(`Delete source “${video.name}”? This cannot be undone.`)) void state.run(() => remove(endpoint('videos',video.id)), 'Source deleted.'); }}>Delete source</button></div><h3>Transcript</h3><Transcript value={video.transcript}/></Section>}
    </div>}
  </>;
}
