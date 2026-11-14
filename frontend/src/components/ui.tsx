import { Component, type ErrorInfo, type ReactNode } from 'react';
export function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="empty"><span className="empty-mark" aria-hidden="true">＋</span><h3>{title}</h3><p>{children}</p></div>; }
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Section({ title, detail, children, action }: { title: string; detail?: string; children: ReactNode; action?: ReactNode }) { return <section className="panel"><header className="panel-heading"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}</header>{children}</section>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Unknown({ value, suffix = '' }: { value: unknown; suffix?: string }) { return <>{typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString()}${suffix}` : <span className="unknown">Unknown</span>}</>; }
export function ReadOnlyValue({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <span className="unknown">Unknown</span>;
  if (typeof value === 'boolean') return <>{value ? 'Available' : 'Unavailable'}</>;
  if (typeof value === 'object') return <pre className="read-only">{JSON.stringify(value, null, 2)}</pre>;
  return <>{String(value)}</>;
}
export function duration(value: unknown) { if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown duration'; return `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2,'0')}`; }
export function date(value?: string | null) { if (!value || Number.isNaN(Date.parse(value))) return 'Unknown'; return new Date(value).toLocaleString(); }
export class ErrorBoundary extends Component<{children: ReactNode}, {error: string}> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Do not log application data or credentials. */ }
  render() { if (this.state.error) return <main className="fatal"><h1>Something went wrong</h1><p>The interface could not render. Your local files are unchanged.</p><p role="alert">{this.state.error}</p><button onClick={() => window.location.reload()}>Reload interface</button></main>; return this.props.children; }
}
